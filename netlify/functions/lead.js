'use strict';

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const WORKSPACE_ID = '36e3a296-adbb-4a87-9623-f11e37f0bd92'; // Pnut Den

function sanitise(v, max = 200) {
  if (!v || typeof v !== 'string') return '';
  return v.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, max);
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,10}$/.test(e);
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('Missing SUPABASE_URL');
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

  return createClient(url, key);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ success: false, message: 'POST only' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ success: false, message: 'Invalid JSON body' }),
    };
  }

  if (body.website2) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: 'OK' }),
    };
  }

  const name = sanitise(body.name, 100);
  const email = sanitise(body.email, 200).toLowerCase();
  const phone = sanitise(body.phone, 30);
  const message = sanitise(body.message || '', 1000);

  if (!name || name.length < 2) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ success: false, message: 'Please enter your name.' }),
    };
  }

  if (!isValidEmail(email)) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ success: false, message: 'Please enter a valid email address.' }),
    };
  }

  try {
    const supabase = getSupabase();

    const payload = {
      workspace_id: WORKSPACE_ID,
      name,
      email,
      phone,
      message: message || null,
      status: 'new',
      source: 'website',
    };

    console.log('Lead insert payload:', payload);

    const { data, error } = await supabase
      .from('client_leads')
      .insert([payload])
      .select();

    if (error) {
      console.error('Supabase insert error:', error);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({
          success: false,
          message: 'Supabase insert failed',
          details: error.message,
          hint: error.hint || null,
          code: error.code || null,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: "Thank you — we'll review your site and be in touch within 1 working day.",
        inserted: data,
      }),
    };
  } catch (err) {
    console.error('Lead function crash:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        success: false,
        message: 'Function crashed',
        details: err.message || 'Unknown error',
      }),
    };
  }
};
