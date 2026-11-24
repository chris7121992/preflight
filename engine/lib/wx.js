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
const idMatch = (x, set) => set.has(x.icaoId) || (x.faaId && set.has(x.faaId)) || (x.iataId && set.has(x.iataId)) || (x.aliases || []).some((a) => set.has(a));
const snapAwc = {
  metar: (ids) => snapSource('metars', async () => (await snap('metars.json')).filter((m) => ids.includes(m.icaoId))),
  metarBbox: (b) => snapSource('metars', async () => (await snap('metars.json')).filter((m) => inBox(m, b))),
  taf: (ids) => snapSource('tafs', async () => (await snap('tafs.json')).filter((t) => ids.includes(t.icaoId))),
  tafBbox: (b) => snapSource('tafs', async () => (await snap('tafs.json')).filter((t) => inBox(t, b))),
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
  tafBbox: (b) => get(`${AWC}/taf?bbox=${bboxStr(b)}&format=json`),
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
// Bilinear interpolation of the snapshot's 5-degree GFS grid into the same shape as Open-Meteo's point response.
async function windsFromGrid(points, levels) {
  const g = await snap('winds.json');
  const idx = new Map(g.points.map((p, i) => [`${p.lat},${p.lon}`, i]));
  const keys = levels.flatMap((l) => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `temperature_${l}hPa`]).concat('freezing_level_height')
    .filter((k) => k in g.points[0]);
  const rad = Math.PI / 180;
  return points.map((p) => {
    const la0 = Math.floor(p.lat / g.step) * g.step, lo0 = Math.floor(p.lon / g.step) * g.step;
    const corners = [[la0, lo0], [la0, lo0 + g.step], [la0 + g.step, lo0], [la0 + g.step, lo0 + g.step]];
    const fy = (p.lat - la0) / g.step, fx = (p.lon - lo0) / g.step;
    const w = [(1 - fy) * (1 - fx), (1 - fy) * fx, fy * (1 - fx), fy * fx];
    const cs = corners.map(([a, b]) => g.points[idx.get(`${a},${b}`)]);
    if (cs.some((c) => !c)) {
      // outside the grid: nearest point
      const n = g.points.reduce((best, q) => (Math.hypot(q.lat - p.lat, q.lon - p.lon) < Math.hypot(best.lat - p.lat, best.lon - p.lon) ? q : best));
      cs.fill(n); w.fill(0.25);
    }
    const hourly = { time: g.times.map((t) => new Date(t).toISOString().slice(0, 16)) };
    for (const k of keys) {
      if (k.startsWith('wind_direction')) continue;
      hourly[k] = g.times.map((_, ti) => cs.reduce((acc, c, ci) => (acc == null || c[k][ti] == null ? null : acc + w[ci] * c[k][ti]), 0));
    }
    // average wind as vectors so directions blend correctly
    for (const l of levels) {
      const sk = `wind_speed_${l}hPa`, dk = `wind_direction_${l}hPa`;
      if (!(sk in g.points[0])) continue;
      hourly[dk] = []; hourly[sk] = [];
      g.times.forEach((_, ti) => {
        let u = 0, v = 0;
        cs.forEach((c, ci) => { const s = c[sk][ti], d = c[dk][ti]; if (s != null && d != null) { u += w[ci] * s * Math.sin(d * rad); v += w[ci] * s * Math.cos(d * rad); } });
        hourly[sk].push(Math.hypot(u, v));
        hourly[dk].push((Math.atan2(u, v) / rad + 360) % 360);
      });
    }
    return { latitude: p.lat, longitude: p.lon, hourly, source: 'grid' };
  });
}

async function windsAloft(points, cruiseFt) {
  const lvl = nearestLevel(cruiseFt);
  const levels = [...new Set([lvl, 150, 200, 250, 300, 500, 700, 850])];
  const vars = levels.flatMap((l) => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `temperature_${l}hPa`]).concat([850, 700, 500].map((l) => `relative_humidity_${l}hPa`));
  const url = `https://api.open-meteo.com/v1/gfs?latitude=${points.map((p) => p.lat.toFixed(2)).join(',')}&longitude=${points.map((p) => p.lon.toFixed(2)).join(',')}&hourly=${vars.join(',')},freezing_level_height&wind_speed_unit=kn&forecast_days=3&timezone=GMT`;
  try {
    const raw = await get(url, { ttlMs: 900e3 });
    const arr = Array.isArray(raw) ? raw : [raw];
    if (arr[0] && arr[0].error) throw new Error(arr[0].reason || 'Open-Meteo error');
    return { level: lvl, levels, data: arr, source: 'GFS point forecast (Open-Meteo)' };
  } catch (e) {
    if (!config.snapshot) throw e;
    const grid = await windsFromGrid(points, levels);
    const nearest = (l) => [850, 700, 500, 400, 300, 250, 200, 150].reduce((a, b) => (Math.abs(b - l) < Math.abs(a - l) ? b : a));
    // grid has a fixed level set: map the requested cruise level to the nearest available one
    const lvlG = nearest(lvl);
    return { level: lvlG, levels, data: grid, source: `GFS 5° grid from the refresh job (live request failed: ${e.message})` };
  }
}

// NWP point guidance (HRRR, NBM, GFS, ECMWF IFS) decoded from the models' GRIB2 output by Open-Meteo.
const NWP_MODELS = ['ncep_hrrr_conus', 'ncep_nbm_conus', 'gfs_seamless', 'ecmwf_ifs025'];
const NWP_VARS = ['temperature_2m', 'dew_point_2m', 'visibility', 'cloud_cover_low', 'precipitation', 'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'cape', 'lifted_index', 'freezing_level_height'];
async function nwpPoints(points) {
  // reach far enough ahead to cover the latest time of interest (HRRR stops at 48 h; NBM, GFS and ECMWF go on)
  const last = Math.max(...points.map((p) => p.to || 0), Date.now());
  const days = Math.min(10, Math.max(3, Math.ceil((last - new Date().setUTCHours(0, 0, 0, 0)) / 864e5) + 1));
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${points.map((p) => p.lat.toFixed(3)).join(',')}&longitude=${points.map((p) => p.lon.toFixed(3)).join(',')}&hourly=${NWP_VARS.join(',')}&models=${NWP_MODELS.join(',')}&wind_speed_unit=kn&forecast_days=${days}&timezone=GMT`;
  const raw = await get(url, { ttlMs: 900e3 });
  const arr = Array.isArray(raw) ? raw : [raw];
  if (arr[0] && arr[0].error) throw new Error(arr[0].reason || 'Open-Meteo error');
  return { models: NWP_MODELS, vars: NWP_VARS, data: arr };
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

// Per-airport static files built by the scripts: 'minimums' (FAA approach minimums) and 'procedures' (SIDs/STARs).
async function staticRec(kind, ids) {
  const base = config[kind] || (config.snapshot ? config.snapshot.replace(/\/data\/?$/, `/${kind}`) : null);
  if (!base) return null;
  let have = null;
  if (typeof base === 'string') {
    if (!cache.has(`${kind}:index`)) cache.set(`${kind}:index`, fetch(`${base}/index.json`).then((r) => (r.ok ? r.json() : null)).then((j) => (j && Array.isArray(j.airports) ? new Set(j.airports) : null)).catch(() => null));
    have = await cache.get(`${kind}:index`);
  }
  for (const id of [...new Set(ids.filter(Boolean))]) {
    if (!/^[A-Z0-9]{3,4}$/.test(id) || (have && !have.has(id))) continue;
    const key = `${kind}:${id}`;
    if (cache.has(key)) { const v = cache.get(key); if (v) return v; continue; }
    let rec = null;
    try {
      if (typeof base === 'function') rec = await base(id);
      else {
        const r = await fetch(`${base}/${id}.json`);
        if (r.ok && /json/.test(r.headers.get('content-type') || '')) rec = await r.json();
      }
    } catch (e) { rec = null; }
    cache.set(key, rec);
    if (rec) return rec;
  }
  return null;
}
const minimums = (ids) => staticRec('minimums', ids);
const procedures = (ids) => staticRec('procedures', ids.flatMap((id) => (/^K[A-Z]{3}$/.test(id || '') ? [id.slice(1), id] : [id])));

// Every US fix and navaid (FAA NASR, built by scripts/procedures.js), one file per first letter
async function usNav(ids) {
  const base = config.nav || (config.snapshot ? config.snapshot.replace(/\/data\/?$/, '/nav') : null);
  if (!base) return [];
  const want = [...new Set(ids.filter((i) => /^[A-Z0-9]{2,5}$/.test(i)))];
  const out = [];
  await Promise.all([...new Set(want.map((i) => i[0]))].map(async (L) => {
    const key = `nav:${L}`;
    if (!cache.has(key)) cache.set(key, (typeof base === 'function' ? Promise.resolve(base(L)) : fetch(`${base}/${L}.json`).then((r) => (r.ok ? r.json() : null))).catch(() => null));
    const shard = await cache.get(key);
    if (!shard) return;
    for (const id of want) if (id[0] === L && shard[id]) for (const p of shard[id]) out.push({ id, lat: p[0], lon: p[1], type: p[2] === 'N' ? 'NAVAID' : 'FIX' });
  }));
  return out;
}

async function airways() {
  const base = config.nav || (config.snapshot ? config.snapshot.replace(/\/data\/?$/, '/nav') : null);
  if (!base) return null;
  if (!cache.has('nav:airways')) cache.set('nav:airways', (typeof base === 'function' ? Promise.resolve(base('airways')) : fetch(`${base}/airways.json`).then((r) => (r.ok ? r.json() : null))).catch(() => null));
  return cache.get('nav:airways');
}

async function allNavaids() { return config.snapshot ? snap('navaids.json') : null; }

module.exports = { usNav, airways, minimums, procedures, allNavaids, configure, snapMeta, RELAY_HOSTS, get, safe, awc, wpc, nws, windsAloft, nwpPoints, NWP_MODELS, nearestLevel, altToHpa, notams };
