'use strict';
// Shared API handlers used by both the Cloud Function and the local dev server.
const { parseFlightPlan } = require('./lib/parse');
const { buildBriefing } = require('./lib/brief');

const CHART_HOSTS = ['www.wpc.ncep.noaa.gov', 'aviationweather.gov'];

async function brief(body) {
  const text = body.fileText || body.routeText || '';
  let plan;
  try {
    plan = parseFlightPlan(text, body.filename || '');
  } catch (e) {
    return { status: 400, json: { error: e.message } };
  }
  return { status: 200, json: await buildBriefing(plan, body) };
}

async function chart(u) {
  let url;
  try { url = new URL(u || ''); } catch { return { status: 400, json: { error: 'Bad URL' } }; }
  if (!CHART_HOSTS.includes(url.hostname) || url.protocol !== 'https:') return { status: 400, json: { error: 'Host not allowed' } };
  const r = await fetch(url, { headers: { 'User-Agent': 'preflight-wx-briefing/1.0' } });
  if (!r.ok) return { status: 502, json: { error: `Upstream ${r.status}` } };
  return { status: 200, type: r.headers.get('content-type') || 'image/gif', body: Buffer.from(await r.arrayBuffer()) };
}

// Relay for browser use: fetches an allowlisted feed URL and returns it with CORS headers.
const RELAY_HOSTS = ['aviationweather.gov', 'tgftp.nws.noaa.gov', 'api.weather.gov'];
async function relay(u) {
  let url;
  try { url = new URL(u || ''); } catch { return { status: 400, json: { error: 'Bad URL' } }; }
  if (!RELAY_HOSTS.includes(url.hostname) || url.protocol !== 'https:') return { status: 400, json: { error: 'Host not allowed' } };
  const r = await fetch(url, { headers: { 'User-Agent': 'preflight-wx-briefing/1.0', Accept: url.hostname === 'api.weather.gov' ? 'application/geo+json' : '*/*' } });
  return { status: r.status, type: r.headers.get('content-type') || 'text/plain', body: Buffer.from(await r.arrayBuffer()) };
}

module.exports = { brief, chart, relay };
