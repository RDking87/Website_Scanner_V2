"use strict";

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const PACKAGES = {
  rebuild: { label: 'Website Rebuild', amount: 150, envKey: 'STRIPE_PRICE_REBUILD_DEPOSIT' },
  system: { label: 'Website + Conversion System', amount: 300, envKey: 'STRIPE_PRICE_SYSTEM_DEPOSIT' },
  growth: { label: 'Growth System', amount: 0, envKey: '' },
};

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing SUPABASE_URL');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}

function sanitise(value, max = 500) {
  if (value == null) return '';
  return String(value).trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(value || '').trim());
}

function slugPackage(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (key in PACKAGES) return key;
  if (key.includes('rebuild')) return 'rebuild';
  if (key.includes('system')) return 'system';
  if (key.includes('growth')) return 'growth';
  return 'rebuild';
}

function businessNameFromUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./i, '');
    return host.split('.')[0].split(/[-_]/g).filter(Boolean).map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
  } catch {
    return null;
  }
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
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const name = sanitise(body.name, 120);
  const email = sanitise(body.email, 200).toLowerCase();
  const websiteUrl = sanitise(body.websiteUrl || body.website || body.url || body.scanPayload?.websiteUrl || body.scanPayload?.url || '', 300);
  const phone = sanitise(body.phone, 40) || null;
  const notes = sanitise(body.notes, 3000) || null;
  const qualifier = sanitise(body.qualifier || '', 120) || null;
  const packageKey = slugPackage(body.packageKey || body.package || body.packageLabel);
  const pkg = PACKAGES[packageKey];

  if (!name || !validEmail(email)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Name and valid email are required' }) };
  }
  if (!websiteUrl) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Website URL is required' }) };
  }
  if (packageKey === 'growth') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Growth applications should use the application form' }) };
  }

  try {
    const supabase = getSupabase();
    const baseUrl = process.env.SITE_URL || process.env.URL || process.env.APP_BASE_URL || 'https://tradeconvert.co.uk';

    let prospectId = sanitise(body.prospect_id || body.prospectId, 80) || null;
    let prospect = null;

    if (prospectId) {
      const { data } = await supabase.from('tradeconvert_prospects').select('*').eq('id', prospectId).maybeSingle();
      prospect = data || null;
    }

    if (!prospect) {
      const { data } = await supabase
        .from('tradeconvert_prospects')
        .select('*')
        .eq('email', email)
        .eq('website_url', websiteUrl)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      prospect = data || null;
    }

    const payload = {
      name,
      email,
      phone,
      website_url: websiteUrl,
      business_name: sanitise(body.business_name || body.businessName, 200) || businessNameFromUrl(websiteUrl),
      trade: sanitise(body.trade || body.scanPayload?.trade || '', 120) || null,
      source: 'website_start_now',
      latest_source: 'website_start_now',
      latest_intent: sanitise(body.intent || 'start_now', 80) || 'start_now',
      last_submitted_at: new Date().toISOString(),
      status: prospect?.status || 'new',
      payment_status: 'pending',
      selected_package: packageKey,
      deposit_amount: pkg.amount,
      notes,
      qualifier,
      scan_payload: body.scanPayload && typeof body.scanPayload === 'object' ? body.scanPayload : null,
      next_action: 'Awaiting deposit outcome',
    };

    let saved;
    if (prospect?.id) {
      const { data, error } = await supabase
        .from('tradeconvert_prospects')
        .update(payload)
        .eq('id', prospect.id)
        .select()
        .single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase
        .from('tradeconvert_prospects')
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      saved = data;
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      await insertProspectEvent(supabase, {
        prospect_id: saved.id,
        event_type: 'checkout_started',
        source: 'website_start_now',
        intent: 'start_now',
        title: `Deposit path started (${packageKey})`,
        payload: { package_key: packageKey, mode: 'mock_success' },
      });
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          url: `${baseUrl}/?payment=success&prospect_id=${saved.id}`,
          prospect_id: saved.id,
          _dev_note: 'STRIPE_SECRET_KEY not set. Returning mock success URL.',
        }),
      };
    }

    const priceId = process.env[pkg.envKey];
    if (!priceId) {
      throw new Error(`Missing ${pkg.envKey} environment variable`);
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const successUrl = `${baseUrl}/?payment=success&prospect_id=${saved.id}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/?payment=cancelled&prospect_id=${saved.id}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      metadata: {
        prospect_id: saved.id,
        package_key: packageKey,
        package_label: pkg.label,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    const { error: sessionUpdateError } = await supabase
      .from('tradeconvert_prospects')
      .update({ stripe_session_id: session.id })
      .eq('id', saved.id);
    if (sessionUpdateError) console.warn('Could not persist stripe_session_id:', sessionUpdateError.message);

    await insertProspectEvent(supabase, {
      prospect_id: saved.id,
      event_type: 'checkout_started',
      source: 'website_start_now',
      intent: 'start_now',
      title: `Deposit path started (${packageKey})`,
      payload: { package_key: packageKey, stripe_session_id: session.id },
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ url: session.url, prospect_id: saved.id, session_id: session.id }),
    };
  } catch (err) {
    console.error('create-checkout-session failed:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message || 'Checkout failed' }),
    };
  }
};
