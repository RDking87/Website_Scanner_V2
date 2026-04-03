"use strict";

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function sanitise(value, max = 400) {
  if (value == null) return '';
  return String(value).trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(value || '').trim());
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing SUPABASE_URL');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}

function mapSource(intent) {
  const map = {
    unlock: 'website_scanner',
    start_now: 'website_start_now',
    growth_application: 'growth_application',
    contact: 'contact_form',
    booking_request: 'booking_request',
  };
  return map[String(intent || '').toLowerCase()] || 'website_enquiry';
}

function packageSlug(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (['rebuild', 'website rebuild'].includes(value)) return 'rebuild';
  if (['system', 'website + conversion system', 'website and conversion system'].includes(value)) return 'system';
  if (['growth', 'growth system'].includes(value)) return 'growth';
  return value.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || null;
}

function deriveWebsite(body) {
  return sanitise(
    body.websiteUrl || body.website || body.url || body.scanPayload?.websiteUrl || body.scanPayload?.url || '',
    300
  );
}

function deriveTrade(body) {
  return sanitise(body.trade || body.scanPayload?.trade || '', 120) || null;
}

function deriveBusinessName(body, websiteUrl) {
  const explicit = sanitise(body.business_name || body.businessName || '', 200);
  if (explicit) return explicit;
  if (!websiteUrl) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`).hostname.replace(/^www\./i, '');
    const root = host.split('.')[0] || host;
    return root
      .split(/[-_]/g)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
      .slice(0, 200) || null;
  } catch {
    return null;
  }
}

function buildNotes(body) {
  const parts = [];
  const freeText = sanitise(body.notes || body.message || body.goal || '', 3000);
  if (freeText) parts.push(freeText);
  const qualifier = sanitise(body.qualifier || '', 120);
  if (qualifier) parts.push(`Qualifier: ${qualifier}`);
  const monthlyVolume = sanitise(body.monthlyVolume || body.monthly_volume || body.monthlyJobsGoal || '', 120);
  if (monthlyVolume) parts.push(`Monthly volume: ${monthlyVolume}`);
  const toolType = sanitise(body.toolType || body.tool_type || '', 120);
  if (toolType) parts.push(`Requested system: ${toolType}`);
  return parts.join('\n\n') || null;
}

function dedupeMatch(body) {
  const email = sanitise(body.email, 200).toLowerCase();
  const website = deriveWebsite(body).toLowerCase();
  return { email, website };
}

function buildScanPayload(body) {
  if (body.scanPayload && typeof body.scanPayload === 'object' && !Array.isArray(body.scanPayload)) {
    return body.scanPayload;
  }

  const scan = {};
  const maybeUrl = sanitise(body.url || body.website || body.websiteUrl || '', 300);
  const maybeTrade = sanitise(body.trade || '', 120);
  const maybeJobs = sanitise(body.monthlyJobsGoal || body.monthlyVolume || body.monthly_volume || '', 120);
  const maybeScore = body.scoreSnapshot && typeof body.scoreSnapshot === 'object' ? body.scoreSnapshot : null;

  if (maybeUrl) scan.url = maybeUrl;
  if (maybeTrade) scan.trade = maybeTrade;
  if (maybeJobs) scan.monthlyJobsGoal = maybeJobs;
  if (maybeScore) scan.scoreSnapshot = maybeScore;

  return Object.keys(scan).length ? scan : null;
}

function buildExtraData(body) {
  const extra = {
    intent: sanitise(body.intent, 80) || null,
    qualifier: sanitise(body.qualifier || '', 120) || null,
    monthly_volume: sanitise(body.monthlyVolume || body.monthly_volume || body.monthlyJobsGoal || '', 120) || null,
    package_interest: packageSlug(body.package || body.packageKey || body.packageLabel || ''),
    application_type: sanitise(body.applicationType || '', 120) || null,
    tool_type: sanitise(body.toolType || body.tool_type || '', 120) || null,
    current_site_status: sanitise(body.currentSiteStatus || '', 240) || null,
    budget_range: sanitise(body.budgetRange || '', 120) || null,
    readiness: sanitise(body.readiness || '', 120) || null,
    selected_option: sanitise(body.selectedOption || body.selected_option || '', 160) || null,
    score_snapshot: body.scoreSnapshot && typeof body.scoreSnapshot === 'object' ? body.scoreSnapshot : null,
    raw_submission: body,
  };

  Object.keys(extra).forEach((key) => {
    if (
      extra[key] == null ||
      extra[key] === '' ||
      (typeof extra[key] === 'object' && !Array.isArray(extra[key]) && Object.keys(extra[key]).length === 0)
    ) {
      delete extra[key];
    }
  });

  return Object.keys(extra).length ? extra : null;
}

function eventTitle(intent, packageKey) {
  const map = {
    unlock: 'Scanner reveal submitted',
    start_now: packageKey ? `Start now submitted (${packageKey})` : 'Start now submitted',
    growth_application: 'Growth application submitted',
    contact: 'Contact enquiry submitted',
    booking_request: 'Booking request submitted',
  };
  return map[String(intent || '').toLowerCase()] || 'Website enquiry submitted';
}

async function insertProspectEvent(supabase, eventRow) {
  try {
    const { error } = await supabase.from('tradeconvert_prospect_events').insert(eventRow);
    if (error) throw error;
  } catch (err) {
    console.warn('tradeconvert_prospect_events insert failed:', err.message || err);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ success: false, message: 'POST only' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: 'Invalid JSON body' }) };
  }

  if (body.website2) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'OK' }) };
  }

  const name = sanitise(body.name, 120);
  const email = sanitise(body.email, 200).toLowerCase();
  const phone = sanitise(body.phone, 40) || null;
  const intent = sanitise(body.intent, 80) || 'unlock';
  const websiteUrl = deriveWebsite(body) || null;

  if (name.length < 2) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: 'Please enter your name.' }) };
  }
  if (!validEmail(email)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: 'Please enter a valid email address.' }) };
  }

  try {
    const supabase = getSupabase();
    const source = mapSource(intent);
    const selectedPackage = packageSlug(body.package || body.packageKey || body.packageLabel || '');
    const notes = buildNotes(body);
    const businessName = deriveBusinessName(body, websiteUrl);
    const { email: matchEmail, website: matchWebsite } = dedupeMatch(body);
    const scanPayload = buildScanPayload(body);
    const extraData = buildExtraData(body);

    let existing = null;
    const { data: existingRows, error: fetchError } = await supabase
      .from('tradeconvert_prospects')
      .select('id, status, payment_status, selected_package, created_at, website_url, extra_data, notes')
      .eq('email', matchEmail)
      .order('created_at', { ascending: false })
      .limit(5);

    if (fetchError) throw fetchError;
    existing = (existingRows || []).find(row => !matchWebsite || String(row.website_url || '').toLowerCase() === matchWebsite) || existingRows?.[0] || null;

    const mergedExtraData = {
      ...(existing?.extra_data && typeof existing.extra_data === 'object' ? existing.extra_data : {}),
      ...(extraData || {}),
    };

    const payload = {
      name,
      email,
      phone,
      website_url: websiteUrl,
      business_name: businessName,
      trade: deriveTrade(body),
      source,
      latest_source: source,
      latest_intent: intent,
      last_submitted_at: new Date().toISOString(),
      status: existing?.status || 'new',
      payment_status: existing?.payment_status || 'unpaid',
      selected_package: selectedPackage || existing?.selected_package || null,
      notes: notes || existing?.notes || null,
      scan_payload: scanPayload,
      extra_data: Object.keys(mergedExtraData).length ? mergedExtraData : null,
      next_action: existing?.status && existing.status !== 'new' ? undefined : 'Review and contact',
    };

    let result;
    let eventAction = 'created';
    if (existing?.id) {
      const { data, error } = await supabase
        .from('tradeconvert_prospects')
        .update(Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)))
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      result = data;
      eventAction = 'updated';
    } else {
      const { data, error } = await supabase
        .from('tradeconvert_prospects')
        .insert({
          ...Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)),
          next_action: 'Review and contact'
        })
        .select()
        .single();
      if (error) throw error;
      result = data;
    }

    await insertProspectEvent(supabase, {
      prospect_id: result.id,
      event_type: 'submission',
      source,
      intent,
      title: eventTitle(intent, selectedPackage),
      payload: {
        action: eventAction,
        selected_package: selectedPackage,
        notes,
        scan_payload: scanPayload,
        extra_data: extraData,
      },
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: 'Thank you — your details have been saved.',
        prospect_id: result.id,
      }),
    };
  } catch (err) {
    console.error('lead.js failed:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ success: false, message: 'Lead capture failed', details: err.message || 'Unknown error' }),
    };
  }
};
