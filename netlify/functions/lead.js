/**
 * netlify/functions/lead.js
 *
 * Lead capture endpoint for Website Jobs Score.
 * Forwards to CRM_WEBHOOK_URL env var (Zapier/Make/HubSpot).
 *
 * ENV VARS:
 *   CRM_WEBHOOK_URL     — webhook to forward lead data to
 *   HUBSPOT_PORTAL_ID   — HubSpot portal ID (optional)
 *   HUBSPOT_FORM_GUID   — HubSpot form GUID (optional)
 */

'use strict';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function sanitise(v, max = 200) {
  if (!v || typeof v !== 'string') return '';
  return v.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, max);
}

function isValidEmail(e) {
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,10}$/.test(e);
}

async function safeFetch(url, options, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); }
  catch { return null; }
  finally { clearTimeout(t); }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ success: false, message: 'POST only.' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: 'Invalid request.' }) }; }

  // Honeypot
  if (body.website2) return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: "Thank you — we'll be in touch soon." }) };

  const name  = sanitise(body.name,  100);
  const email = sanitise(body.email, 200).toLowerCase();
  const phone = sanitise(body.phone, 30);

  if (!name || name.length < 2)   return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: 'Please enter your name.' }) };
  if (!isValidEmail(email))       return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: 'Please enter a valid email address.' }) };

  const scan = body.scanPayload || {};
  const lead = {
    timestamp:     new Date().toISOString(),
    name, email,
    phone:         phone || null,
    websiteUrl:    sanitise(scan.websiteUrl || scan.url, 2000),
    domain:        sanitise(scan.domain, 200),
    trade:         sanitise(scan.trade, 100),
    totalScore:    typeof scan.totalScore === 'number' ? scan.totalScore : null,
    scanMode:      scan.scanMode || null,
    categoryScores: scan.categoryScores || null,
    issues:        Array.isArray(scan.issues)        ? scan.issues.slice(0, 10)       : [],
    priorityFixes: Array.isArray(scan.priorityFixes) ? scan.priorityFixes.slice(0, 5) : [],
    screenshotUrl: sanitise(scan.screenshotUrl, 2000) || null,
    source:        'website-jobs-scanner-v2',
  };

  const webhookUrl = process.env.CRM_WEBHOOK_URL; // env: CRM_WEBHOOK_URL
  if (webhookUrl) {
    try {
      await safeFetch(webhookUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(lead) }, 8000);
      console.log('[lead] forwarded to webhook:', lead.domain);
    } catch (e) {
      console.error('[lead] webhook error:', e.message);
    }
  }

  // HubSpot (uncomment to enable)
  /*
  const portalId = process.env.HUBSPOT_PORTAL_ID; // env: HUBSPOT_PORTAL_ID
  const formGuid = process.env.HUBSPOT_FORM_GUID; // env: HUBSPOT_FORM_GUID
  if (portalId && formGuid) {
    await safeFetch(
      `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formGuid}`,
      { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
          fields: [
            { name:'firstname', value: name.split(' ')[0] },
            { name:'lastname',  value: name.split(' ').slice(1).join(' ') },
            { name:'email',     value: email },
            { name:'phone',     value: phone },
            { name:'website',   value: lead.websiteUrl },
            { name:'message',   value: `Trade: ${lead.trade} | Score: ${lead.totalScore}/100` },
          ]
        })
      }, 8000
    );
  }
  */

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: "Thank you — we'll review your site and be in touch within 1 working day." }) };
};
