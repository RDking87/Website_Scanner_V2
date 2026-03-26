/**
 * netlify/functions/scan.js — Website Jobs Score v4
 * SELF-CONTAINED. No external require(). No variables for PSI fields.
 *
 * ENV VARS (Netlify → Site config → Environment variables):
 *   PAGESPEED_API_KEY    ← exact name, no spaces
 *   SCREENSHOT_API_KEY   ← optional (Microlink)
 *   CRM_WEBHOOK_URL      ← optional
 */

'use strict';

var PSI_TIMEOUT        = 9500;
var SCREENSHOT_TIMEOUT = 8000;
var HOMEPAGE_TIMEOUT   = 6000;

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json'
};

// ─── SAFE FETCH ───────────────────────────────────────────────────────────────
async function safeFetch(url, opts, ms) {
  opts = opts || {};
  ms   = ms   || 8000;
  var ctrl  = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, ms);
  try {
    var r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    return { ok: r.ok, res: r, status: r.status, err: null };
  } catch (e) {
    return { ok: false, res: null, status: null, err: e.name === 'AbortError' ? 'Timed out after ' + ms + 'ms' : (e.message || 'Network error') };
  } finally {
    clearTimeout(timer);
  }
}

// ─── URL VALIDATION ───────────────────────────────────────────────────────────
function normaliseUrl(raw) {
  if (!raw) return { valid: false, error: 'URL is required.' };
  var s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  var p;
  try { p = new URL(s); } catch (e) { return { valid: false, error: 'Invalid URL.' }; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return { valid: false, error: 'URL must use http or https.' };
  var h = p.hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1') return { valid: false, error: 'URL must be a public website.' };
  if (!h.includes('.')) return { valid: false, error: 'Please enter a full domain (e.g. yoursite.co.uk).' };
  return { valid: true, url: p.href, domain: h.replace(/^www\./, '') };
}

// ─── PAGESPEED ────────────────────────────────────────────────────────────────
async function fetchPageSpeed(url) {
  var key = process.env.PAGESPEED_API_KEY || '';
  console.log('[PSI] key present:', !!key, 'key length:', key.length);

  if (!key) {
    console.log('[PSI] SKIPPED — PAGESPEED_API_KEY not set');
    return { ok: false, fallback: true, reason: 'no_api_key', performanceScore: null };
  }

  var apiUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
    + '?url=' + encodeURIComponent(url)
    + '&strategy=mobile'
    + '&key=' + key
    + '&category=performance'
    + '&fields=lighthouseResult/categories/performance/score'
    + ',lighthouseResult/audits/largest-contentful-paint/displayValue'
    + ',lighthouseResult/audits/cumulative-layout-shift/displayValue'
    + ',lighthouseResult/audits/first-contentful-paint/displayValue'
    + ',lighthouseResult/audits/total-blocking-time/displayValue'
    + ',loadingExperience/overall_category';

  console.log('[PSI] Calling API, timeout:', PSI_TIMEOUT + 'ms');
  var t0 = Date.now();
  var result = await safeFetch(apiUrl, {}, PSI_TIMEOUT);
  console.log('[PSI] Response in', (Date.now() - t0) + 'ms | ok:', result.ok, '| status:', result.status, '| err:', result.err);

  if (!result.ok || !result.res) {
    return { ok: false, fallback: true, reason: result.err || ('HTTP ' + result.status), performanceScore: null };
  }

  var data;
  try { data = await result.res.json(); }
  catch (e) { return { ok: false, fallback: true, reason: 'JSON parse failed', performanceScore: null }; }

  if (data.error) {
    console.error('[PSI] API error:', data.error.code, data.error.message);
    return { ok: false, fallback: true, reason: 'API error ' + data.error.code, performanceScore: null };
  }

  var cats  = (data.lighthouseResult && data.lighthouseResult.categories) || {};
  var audit = (data.lighthouseResult && data.lighthouseResult.audits)     || {};
  var perf  = Math.min(Math.max(Math.round(((cats.performance && cats.performance.score) || 0) * 100), 0), 100);

  console.log('[PSI] Performance score:', perf);

  return {
    ok:               true,
    fallback:         false,
    performanceScore: perf,
    mobileStrategy:   (data.loadingExperience && data.loadingExperience.overall_category) || null,
    lcp: (audit['largest-contentful-paint']  && audit['largest-contentful-paint'].displayValue)  || null,
    cls: (audit['cumulative-layout-shift']   && audit['cumulative-layout-shift'].displayValue)   || null,
    fcp: (audit['first-contentful-paint']    && audit['first-contentful-paint'].displayValue)    || null,
    tbt: (audit['total-blocking-time']       && audit['total-blocking-time'].displayValue)       || null
  };
}

// ─── SCREENSHOT ───────────────────────────────────────────────────────────────
async function fetchScreenshot(url) {
  var base    = process.env.SCREENSHOT_API_BASE || 'https://api.microlink.io';
  var headers = {};
  if (process.env.SCREENSHOT_API_KEY) headers['x-api-key'] = process.env.SCREENSHOT_API_KEY;
  var apiUrl  = base + '?url=' + encodeURIComponent(url) + '&screenshot=true&meta=true';

  var result = await safeFetch(apiUrl, { headers: headers }, SCREENSHOT_TIMEOUT);
  if (!result.ok || !result.res) {
    console.warn('[Screenshot] Failed:', result.err);
    return { ok: false, fallback: true, screenshotUrl: null, title: null };
  }
  var d;
  try { d = await result.res.json(); }
  catch (e) { return { ok: false, fallback: true, screenshotUrl: null, title: null }; }

  if (d.status !== 'success') {
    console.warn('[Screenshot] Non-success:', d.status);
    return { ok: false, fallback: true, screenshotUrl: null, title: null };
  }
  console.log('[Screenshot] Got screenshot:', !!(d.data && d.data.screenshot && d.data.screenshot.url));
  return {
    ok:            true,
    fallback:      false,
    screenshotUrl: (d.data && d.data.screenshot && d.data.screenshot.url) || null,
    title:         (d.data && d.data.title) || null
  };
}

// ─── HOMEPAGE ANALYSIS ────────────────────────────────────────────────────────
var CTA_S   = ['call now','call us now','get a free quote','request a callback','free quote','book now','get a quote','instant quote','free estimate','call today','ring us'];
var CTA_W   = ['contact us','get in touch','speak to us','message us','enquire now','get started','request a call'];
var TRUST_S = ['checkatrade','trustpilot','google reviews','which trusted trader','mybuilder','rated people','gas safe','niceic','napit','fmb','nhbc'];
var TRUST_M = ['verified','accredited','certified','registered','insured','fully insured','guarantee','guaranteed','years experience','approved'];
var TRUST_W = ['review','reviews','testimonial','testimonials','rated','stars','rating','gallery','portfolio','before and after'];
var LOCAL_S = ['service area','areas we cover','areas covered','we cover','covering','local to','serving'];
var LOCAL_W = ['local','nearby','near you','based in','located in','north','south','east','west','greater'];

function countSig(text, html, s, m, w) {
  var found = {}, weight = 0;
  var i;
  for (i = 0; i < (s || []).length; i++) { if (text.indexOf(s[i]) >= 0 || html.indexOf(s[i]) >= 0) { found[s[i]] = 'strong'; weight += 3; } }
  for (i = 0; i < (m || []).length; i++) { if (text.indexOf(m[i]) >= 0 || html.indexOf(m[i]) >= 0) { found[m[i]] = 'medium'; weight += 2; } }
  for (i = 0; i < (w || []).length; i++) { if (text.indexOf(w[i]) >= 0 || html.indexOf(w[i]) >= 0) { found[w[i]] = 'weak';   weight += 1; } }
  return { found: found, weight: weight, count: Object.keys(found).length };
}

async function fetchHomepage(url) {
  var result = await safeFetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (compatible; SiteScanner/1.0)',
      'Accept':          'text/html',
      'Accept-Language': 'en-GB'
    },
    redirect: 'follow'
  }, HOMEPAGE_TIMEOUT);

  if (!result.ok || !result.res) {
    console.warn('[Homepage] Failed:', result.err);
    return { ok: false, error: result.err };
  }

  var ct = result.res.headers.get('content-type') || '';
  if (ct.indexOf('text/html') < 0 && ct.indexOf('xhtml') < 0) {
    console.warn('[Homepage] Non-HTML:', ct);
    return { ok: false, error: 'Non-HTML: ' + ct };
  }

  var html = '';
  try {
    var buf = await result.res.arrayBuffer();
    html = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf).slice(0, 1200000));
  } catch (e) { return { ok: false, error: 'Body read error' }; }

  if (html.length < 200) return { ok: false, error: 'Page too short' };

  var lh   = html.toLowerCase();
  var text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi,   ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  var telLinks = (html.match(/href=["']tel:[^"']+["']/gi) || []).length;
  var cta      = countSig(text, lh, CTA_S,   null,    CTA_W);
  var trust    = countSig(text, lh, TRUST_S, TRUST_M, TRUST_W);
  var local    = countSig(text, lh, LOCAL_S, null,    LOCAL_W);

  console.log('[Homepage] OK | tel:', telLinks, '| cta:', cta.weight, '| trust:', trust.weight, '| local:', local.weight);

  return {
    ok:          true,
    finalUrl:    result.res.url || url,
    telLinks:    telLinks,
    hasTelLink:  telLinks > 0,
    hasPostcode: /[A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2}/i.test(html),
    hasMap:      lh.indexOf('maps.google') >= 0 || lh.indexOf('google.com/maps') >= 0,
    hasSchema:   lh.indexOf('"localbusiness"') >= 0,
    cta:         cta,
    trust:       trust,
    local:       local,
    wordCount:   text.split(/\s+/).filter(function(w) { return w.length > 2; }).length
  };
}

// ─── SCORING ──────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(Math.max(Math.round(v), lo), hi); }

function buildScore(psi, hp) {
  var cats = {};

  var ss = 10, sr = [];
  if (!psi.fallback && psi.performanceScore != null) {
    var p = psi.performanceScore;
    ss = p >= 90 ? 20 : p >= 75 ? 16 : p >= 50 ? 10 : p >= 30 ? 5 : 2;
    sr.push('PageSpeed mobile score: ' + p + '/100');
    if (psi.lcp) sr.push('LCP: ' + psi.lcp);
  } else {
    sr.push('Speed unavailable: ' + (psi.reason || 'unknown'));
  }
  cats.speed = { score: clamp(ss, 0, 20), reasons: sr };

  var ms = 10, mr = [];
  if (!psi.fallback && psi.performanceScore != null) {
    var mp = psi.performanceScore;
    var fast = psi.mobileStrategy === 'FAST';
    ms = (fast && mp >= 75) ? 19 : (fast && mp >= 50) ? 15 : mp >= 60 ? 12 : mp >= 50 ? 10 : 4;
    mr.push(psi.mobileStrategy ? 'Mobile category: ' + psi.mobileStrategy : 'Mobile data available');
  } else {
    mr.push('Mobile data unavailable');
  }
  cats.mobileClarity = { score: clamp(ms, 0, 20), reasons: mr };

  var cs = 0, cr = [];
  if (hp.ok) {
    if      (hp.telLinks >= 2) { cs += 6; cr.push(hp.telLinks + ' clickable tel: links'); }
    else if (hp.hasTelLink)    { cs += 4; cr.push('Clickable tel: link found'); }
    else                       {          cr.push('No clickable phone link found'); }
    var cw = hp.cta.weight;
    if      (cw >= 9) { cs += 14; cr.push('Strong CTAs: ' + Object.keys(hp.cta.found).slice(0, 3).join(', ')); }
    else if (cw >= 5) { cs += 10; cr.push('Moderate CTAs: ' + Object.keys(hp.cta.found).slice(0, 3).join(', ')); }
    else if (cw >= 2) { cs += 6;  cr.push('Weak CTA signals'); }
    else if (cw >= 1) { cs += 2;  cr.push('Very few CTAs'); }
    else              {           cr.push('No CTA phrases found'); }
  } else { cs = 8; cr.push('Homepage unavailable'); }
  cats.ctaStrength = { score: clamp(cs, 0, 20), reasons: cr };

  var ts = 0, tr = [];
  if (hp.ok) {
    var tw = hp.trust.weight;
    ts = tw >= 12 ? 20 : tw >= 8 ? 16 : tw >= 4 ? 10 : tw >= 1 ? 5 : 1;
    tr.push('Trust weight: ' + tw + ' (' + hp.trust.count + ' signals)');
    var sf = [], keys = Object.keys(hp.trust.found);
    for (var i = 0; i < keys.length; i++) { if (hp.trust.found[keys[i]] === 'strong') sf.push(keys[i]); }
    if (sf.length) tr.push('Strong: ' + sf.slice(0, 3).join(', '));
  } else { ts = 8; tr.push('Homepage unavailable'); }
  cats.trustSignals = { score: clamp(ts, 0, 20), reasons: tr };

  var ls = 0, lr = [];
  if (hp.ok) {
    if (hp.hasSchema)   { ls += 4; lr.push('LocalBusiness schema found'); }
    if (hp.hasPostcode) { ls += 4; lr.push('UK postcode detected'); }
    if (hp.hasMap)      { ls += 3; lr.push('Google Map found'); }
    var lw = hp.local.weight;
    ls += lw >= 8 ? 9 : lw >= 4 ? 6 : lw >= 1 ? 3 : 0;
    lr.push('Local weight: ' + lw);
  } else { ls = 8; lr.push('Homepage unavailable'); }
  cats.localRelevance = { score: clamp(ls, 0, 20), reasons: lr };

  var vals = Object.values(cats);
  var total = 0;
  for (var j = 0; j < vals.length; j++) total += vals[j].score;
  total = clamp(total, 0, 100);

  return { cats: cats, total: total };
}

// ─── ISSUES + FIXES ───────────────────────────────────────────────────────────
function buildIssues(cats, hp) {
  var entries = Object.entries(cats).sort(function(a, b) { return a[1].score - b[1].score; });
  var out = [], fixes = [];
  var i;

  for (i = 0; i < entries.length && out.length < 5; i++) {
    var k = entries[i][0], v = entries[i][1];
    if (v.score > 12) continue;
    if (k === 'speed')          out.push(v.score <= 5 ? 'Site loads very slowly — most mobile visitors will leave before it finishes' : 'Page speed is below average and may be costing you enquiries');
    if (k === 'mobileClarity')  out.push('Your mobile experience may not be clear enough for phone users');
    if (k === 'ctaStrength')    out.push(hp.ok && !hp.hasTelLink ? 'No clickable phone number — critical gap for mobile visitors' : 'Limited call-to-action signals on your homepage');
    if (k === 'trustSignals')   out.push(v.score <= 5 ? 'Almost no social proof visible — visitors have no reason to trust you' : 'Trust signals need to be more prominent');
    if (k === 'localRelevance') out.push('Your service area is not clearly communicated for local search');
  }
  if (!out.length) out.push('Site has reasonable foundations — focus on conversion optimisation');

  var fc = [
    { k: 'ctaStrength',    t: 12, f: 'Add a prominent clickable phone number and "Get a Free Quote" button above the fold' },
    { k: 'trustSignals',   t: 12, f: 'Add review counts, star ratings, and an accreditation logo near the top of the page' },
    { k: 'localRelevance', t: 12, f: 'Add a service area section listing towns and postcodes you cover, with a Google Map' },
    { k: 'speed',          t: 10, f: 'Compress images and enable browser caching to improve load speed' },
    { k: 'mobileClarity',  t: 10, f: 'Make all contact buttons large and easy to tap on a mobile screen' }
  ];
  for (i = 0; i < fc.length && fixes.length < 3; i++) {
    if ((cats[fc[i].k] ? cats[fc[i].k].score : 21) <= fc[i].t) fixes.push(fc[i].f);
  }

  var fb = [
    'Ensure key info is visible without scrolling on mobile',
    'Add a photo gallery of completed work',
    'Include your address and Google Business Profile link in the footer'
  ];
  for (i = 0; i < fb.length && fixes.length < 3; i++) {
    if (fixes.indexOf(fb[i]) < 0) fixes.push(fb[i]);
  }

  return { issues: out.slice(0, 5), fixes: fixes.slice(0, 3) };
}

// ─── MISSED ENQUIRIES ─────────────────────────────────────────────────────────
function buildMissed(total, trade, goal) {
  var r = total < 30 ? 0.75 : total < 45 ? 0.60 : total < 60 ? 0.45 : total < 75 ? 0.28 : 0.12;
  var multipliers = { plumber: 1.1, electrician: 1.05, roofer: 1.15, hvac: 1.1 };
  var m = multipliers[trade] || 1.0;
  var adj = Math.min(r * m, 0.9);
  if (goal > 0) {
    var mid = Math.round(goal * adj);
    var lo  = Math.max(1, Math.round(mid * 0.7));
    var hi  = Math.round(mid * 1.3);
    return { min: lo, max: hi, label: lo + '–' + hi + ' jobs per month', basis: 'goal' };
  }
  var pct = Math.round(adj * 100);
  var plo = Math.max(pct - 10, 5);
  var phi = Math.min(pct + 10, 90);
  return { min: plo, max: phi, label: plo + '–' + phi + '% of potential enquiries', basis: 'band' };
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────
function buildSummary(total, trade) {
  var t = trade || 'your trade';
  if (total >= 75) return { rating: 'Good',       headline: 'Your site is performing well for a trades business',  body: 'Your ' + t + ' site has strong foundations.' };
  if (total >= 50) return { rating: 'Fair',       headline: 'Your site has real room to win more jobs',            body: 'Your ' + t + ' site is working but likely losing a significant share of enquiries.' };
  return              { rating: 'Needs Work', headline: 'Your site may be costing you significant work',       body: 'Your ' + t + ' site has several barriers preventing customers from contacting you.' };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ success: false, message: 'POST only.' }) };

  var body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: 'Invalid JSON.' }) }; }

  var rawUrl = ((body.url   || '') + '').trim();
  var trade  = ((body.trade || '') + '').trim().slice(0, 100);
  var goal   = parseInt(body.monthlyJobsGoal, 10) || 0;

  if (!rawUrl) return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: 'URL is required.' }) };
  if (!trade)  return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: 'Trade is required.' }) };

  var norm = normaliseUrl(rawUrl);
  if (!norm.valid) return { statusCode: 400, headers: CORS, body: JSON.stringify({ success: false, message: norm.error }) };

  var url    = norm.url;
  var domain = norm.domain;

  console.log('========== SCAN START:', domain, '==========');
  console.log('ENV: PAGESPEED_API_KEY set =', !!process.env.PAGESPEED_API_KEY, '| Node =', process.version);

  var results = await Promise.all([
    fetchPageSpeed(url),
    fetchScreenshot(url),
    fetchHomepage(url)
  ]);

  var psi  = results[0];
  var shot = results[1];
  var hp   = results[2];

  console.log('PSI fallback:', psi.fallback, '| Shot fallback:', shot.fallback, '| HP ok:', hp.ok);

  if (psi.fallback && shot.fallback && !hp.ok) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ success: false, message: 'Could not analyse this site. Please try again.' }) };
  }

  var scored   = buildScore(psi, hp);
  var issFixed = buildIssues(scored.cats, hp);
  var mi       = buildMissed(scored.total, trade, goal);
  var sum      = buildSummary(scored.total, trade);
  var mode     = (psi.fallback || shot.fallback || !hp.ok) ? 'partial_live' : 'live';

  console.log('Score:', scored.total + '/100 | Mode:', mode);
  console.log('========== SCAN END:', domain, '==========');

  return {
    statusCode: 200,
    headers:    CORS,
    body: JSON.stringify({
      success:    true,
      scanMode:   mode,
      disclaimer: 'Automated first-pass scan based on live site signals.',
      timestamp:  new Date().toISOString(),
      websiteUrl: url,
      domain:     domain,
      trade:      trade,
      monthlyJobsGoal: goal || null,
      totalScore: scored.total,
      categoryScores: {
        speed:          { score: scored.cats.speed.score,          max: 20, reasons: scored.cats.speed.reasons },
        mobileClarity:  { score: scored.cats.mobileClarity.score,  max: 20, reasons: scored.cats.mobileClarity.reasons },
        ctaStrength:    { score: scored.cats.ctaStrength.score,    max: 20, reasons: scored.cats.ctaStrength.reasons },
        trustSignals:   { score: scored.cats.trustSignals.score,   max: 20, reasons: scored.cats.trustSignals.reasons },
        localRelevance: { score: scored.cats.localRelevance.score, max: 20, reasons: scored.cats.localRelevance.reasons }
      },
      summary:         sum,
      missedEnquiries: mi,
      issues:          issFixed.issues,
      priorityFixes:   issFixed.fixes,
      screenshotUrl:   shot.screenshotUrl || null,
      siteTitle:       shot.title         || null,
      fallbackFlags: {
        pageSpeedFailed:     psi.fallback,
        screenshotFailed:    shot.fallback,
        homepageFetchFailed: !hp.ok
      },
      rawSignals: {
        pagespeed: {
          performanceScore: psi.performanceScore,
          mobileStrategy:   psi.mobileStrategy,
          reason:           psi.reason || null,
          lcp: psi.lcp, cls: psi.cls, fcp: psi.fcp, tbt: psi.tbt
        },
        homepage: hp.ok ? {
          hasTelLink:  hp.hasTelLink,
          telLinks:    hp.telLinks,
          hasPostcode: hp.hasPostcode,
          hasMap:      hp.hasMap,
          ctaWeight:   hp.cta.weight,
          ctaFound:    Object.keys(hp.cta.found),
          trustWeight: hp.trust.weight,
          trustFound:  Object.keys(hp.trust.found),
          localWeight: hp.local.weight,
          localFound:  Object.keys(hp.local.found),
          wordCount:   hp.wordCount,
          finalUrl:    hp.finalUrl
        } : { error: hp.error }
      }
    })
  };
};
