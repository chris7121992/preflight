'use strict';
// Live data fetchers. All sources are public and keyless except the optional FAA NOTAM API.
const AWC = 'https://aviationweather.gov/api/data';
const UA = 'preflight-wx-briefing/1.0 (advisory weather briefing tool)';
const cache = new Map();
const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

// In the browser, feeds that don't send CORS headers go through a relay (Cloudflare Worker or the local dev server).
const RELAY_HOSTS = new Set(['aviationweather.gov', 'tgftp.nws.noaa.gov', 'api.weather.gov']);
const config = { relay: null };
function configure(o = {}) { Object.assign(config, o); }
function routeUrl(url) {
  if (!config.relay) return url;
  const host = new URL(url).hostname;
  return RELAY_HOSTS.has(host) ? `${config.relay}${config.relay.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}` : url;
}

async function get(url, { type = 'json', ttlMs = 120e3, headers = {}, timeoutMs = 20e3 } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const h = IS_BROWSER ? { ...headers } : { 'User-Agent': UA, Accept: type === 'json' ? 'application/json' : '*/*', ...headers };
    if (IS_BROWSER) delete h.Accept; // keep requests "simple" so no CORS preflight is needed
    const res = await fetch(routeUrl(url), { headers: h, signal: ctl.signal });
    if (res.status === 204) return type === 'json' ? [] : '';
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
    const data = type === 'json' ? await res.json() : await res.text();
    cache.set(url, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Wrap a fetch so one failing source never sinks the whole briefing.
async function safe(name, fn, errors) {
  try {
    return await fn();
  } catch (e) {
    errors.push({ source: name, error: String(e.message || e) });
    return null;
  }
}

// ---------------------------------------------------------------- snapshot mode (static files on Firebase Hosting)
const snapCache = new Map();
async function snap(name, type = 'json') {
  const hit = snapCache.get(name);
  if (hit && Date.now() - hit.at < 120e3) return hit.data;
  const r = await fetch(`${config.snapshot}/${name}?t=${Math.floor(Date.now() / 60e3)}`);
  if (!r.ok) throw new Error(`snapshot ${name}: ${r.status}`);
  const data = type === 'json' ? await r.json() : await r.text();
  snapCache.set(name, { at: Date.now(), data });
  return data;
}
async function snapMeta() {
  if (!config.snapshot) return null;
  return snap('meta.json');
}
async function snapSource(key, fn) {
  const meta = await snapMeta();
  const s = meta && meta.sources && meta.sources[key];
  if (s && !s.ok) throw new Error(`refresh job could not fetch ${key} (${s.error || 'unknown error'})`);
  return fn();
}
const inBox = (p, b) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon;
const idMatch = (x, set) => set.has(x.icaoId) || (x.faaId && set.has(x.faaId)) || (x.iataId && set.has(x.iataId));
const snapAwc = {
  metar: (ids) => snapSource('metars', async () => (await snap('metars.json')).filter((m) => ids.includes(m.icaoId))),
  metarBbox: (b) => snapSource('metars', async () => (await snap('metars.json')).filter((m) => inBox(m, b))),
  taf: (ids) => snapSource('tafs', async () => (await snap('tafs.json')).filter((t) => ids.includes(t.icaoId))),
  airport: async (ids) => { const set = new Set(ids); return (await snap('airports.json')).filter((a) => idMatch(a, set)); },
  navaid: async (ids) => { const all = await snap('navaids.json'); return ids.map((id) => all.filter((n) => n.id === id).sort((a, b) => (b.country === 'US') - (a.country === 'US'))[0]).filter(Boolean); },
  fix: async () => [],
  pirepBbox: (b, ageH = 2) => snapSource('pireps', async () => (await snap('pireps.json')).filter((p) => inBox(p, b) && Date.now() / 1000 - p.obsTime <= ageH * 3600)),
  airsigmet: () => snapSource('airsigmet', () => snap('airsigmet.json')),
  isigmet: () => snapSource('isigmet', () => snap('isigmet.json')),
  gairmet: () => snapSource('gairmet', () => snap('gairmet.json')),
  cwa: () => snapSource('cwa', () => snap('cwa.json')),
};
const snapWpc = {
  codsus: () => snapSource('codsus', () => snap('codsus.txt', 'text')),
  codsrp: () => snapSource('codsrp', () => snap('codsrp.txt', 'text')),
};

const bboxStr = (b) => `${b.minLat.toFixed(2)},${b.minLon.toFixed(2)},${b.maxLat.toFixed(2)},${b.maxLon.toFixed(2)}`;

const liveAwc = {
  metar: (ids) => get(`${AWC}/metar?ids=${ids.join(',')}&format=json&hours=3`),
  metarBbox: (b) => get(`${AWC}/metar?bbox=${bboxStr(b)}&format=json`),
  taf: (ids) => get(`${AWC}/taf?ids=${ids.join(',')}&format=json`),
  airport: (ids) => get(`${AWC}/airport?ids=${ids.join(',')}&format=json`, { ttlMs: 864e5 }),
  navaid: (ids) => get(`${AWC}/navaid?ids=${ids.join(',')}&format=json`, { ttlMs: 864e5 }),
  fix: (ids) => get(`${AWC}/fix?ids=${ids.join(',')}&format=json`, { ttlMs: 864e5 }),
  pirepBbox: (b, ageH = 2) => get(`${AWC}/pirep?bbox=${bboxStr(b)}&age=${ageH}&format=json`),
  airsigmet: () => get(`${AWC}/airsigmet?format=json`),
  isigmet: () => get(`${AWC}/isigmet?format=json`),
  gairmet: () => get(`${AWC}/gairmet?format=json`),
  cwa: () => get(`${AWC}/cwa?format=json`),
  afd: (wfo) => get(`${AWC}/fcstdisc?cwa=K${wfo}&type=afd`, { type: 'text', ttlMs: 600e3 }),
};

const liveWpc = {
  codsus: () => get('https://tgftp.nws.noaa.gov/data/raw/as/asus01.kwbc.cod.sus.txt', { type: 'text', ttlMs: 600e3 }),
  codsrp: () => get('https://tgftp.nws.noaa.gov/data/raw/fs/fsus02.kwbc.cod.srp.txt', { type: 'text', ttlMs: 600e3 }),
  charts: () => ([
    { label: 'Current surface analysis (WPC via AWC)', url: 'https://aviationweather.gov/data/products/progs/F000_wpc_sfc.gif' },
    { label: 'Fronts & NDFD weather, forecast panel 1', url: 'https://www.wpc.ncep.noaa.gov/basicwx/91fndfd.gif' },
    { label: 'Fronts & NDFD weather, forecast panel 2', url: 'https://www.wpc.ncep.noaa.gov/basicwx/92fndfd.gif' },
    { label: 'Fronts & NDFD weather, forecast panel 3', url: 'https://www.wpc.ncep.noaa.gov/basicwx/93fndfd.gif' },
    { label: 'Fronts & NDFD weather, forecast panel 4', url: 'https://www.wpc.ncep.noaa.gov/basicwx/94fndfd.gif' },
    { label: 'Fronts & NDFD weather, forecast panel 5', url: 'https://www.wpc.ncep.noaa.gov/basicwx/95fndfd.gif' },
    { label: 'Fronts & NDFD weather, forecast panel 6', url: 'https://www.wpc.ncep.noaa.gov/basicwx/96fndfd.gif' },
  ]),
};

// Pick live API calls (server / relay) or the snapshot files, per call, based on configure().
const awc = new Proxy({}, { get: (_, k) => (config.snapshot ? snapAwc : liveAwc)[k] });
const wpc = new Proxy({}, { get: (_, k) => (k === 'charts' ? liveWpc.charts : (config.snapshot ? snapWpc : liveWpc)[k]) });

const nws = {
  wfoFor: async (lat, lon) => {
    const d = await get(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { ttlMs: 864e5, headers: { Accept: 'application/geo+json' } });
    return d && d.properties ? d.properties.cwa : null;
  },
};

// GFS winds/temps aloft via Open-Meteo (the AWC wind/temp tables were discontinued in 2026).
const PRESSURE_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150];
function altToHpa(ft) {
  // ISA: troposphere to 36,089 ft, then isothermal
  const h = ft * 0.3048;
  const p = h <= 11000 ? 1013.25 * Math.pow(1 - 2.25577e-5 * h, 5.25588) : 226.32 * Math.exp(-(h - 11000) / 6341.62);
  return p;
}
function nearestLevel(ft) {
  const p = altToHpa(ft);
  return PRESSURE_LEVELS.reduce((a, b) => (Math.abs(b - p) < Math.abs(a - p) ? b : a));
}
async function windsAloft(points, cruiseFt) {
  const lvl = nearestLevel(cruiseFt);
  const levels = [...new Set([lvl, 300, 500, 700, 850])];
  const vars = levels.flatMap((l) => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `temperature_${l}hPa`, `geopotential_height_${l}hPa`]);
  const url = `https://api.open-meteo.com/v1/gfs?latitude=${points.map((p) => p.lat.toFixed(2)).join(',')}&longitude=${points.map((p) => p.lon.toFixed(2)).join(',')}&hourly=${vars.join(',')},freezing_level_height&wind_speed_unit=kn&forecast_days=3&timezone=GMT`;
  const raw = await get(url, { ttlMs: 900e3 });
  const arr = Array.isArray(raw) ? raw : [raw];
  if (arr[0] && arr[0].error) throw new Error(arr[0].reason || 'Open-Meteo error');
  return { level: lvl, levels, data: arr };
}

// Optional: FAA NOTAM API (requires free credentials from api.faa.gov).
async function notams(ids) {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const id = env.FAA_CLIENT_ID, secret = env.FAA_CLIENT_SECRET;
  if (!id || !secret) return null;
  const out = {};
  for (const icao of ids) {
    const d = await get(`https://external-api.faa.gov/notamapi/v1/notams?icaoLocation=${icao}&pageSize=100`, { headers: { client_id: id, client_secret: secret }, ttlMs: 600e3 });
    out[icao] = (d.items || []).map((it) => {
      const n = it.properties && it.properties.coreNOTAMData && it.properties.coreNOTAMData.notam;
      return n ? { number: n.number, text: n.text, start: n.effectiveStart, end: n.effectiveEnd, classification: n.classification } : null;
    }).filter(Boolean);
  }
  return out;
}

module.exports = { configure, snapMeta, RELAY_HOSTS, get, safe, awc, wpc, nws, windsAloft, nearestLevel, altToHpa, notams };
