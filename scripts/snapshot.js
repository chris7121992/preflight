#!/usr/bin/env node
'use strict';
// Builds the weather snapshot served from Firebase Hosting (public/data/).
// Run by the GitHub Action every ~10 minutes; also runnable locally: node scripts/snapshot.js
// Output shapes match the aviationweather.gov JSON API so the briefing engine can use them unchanged.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'data');
const AWC = 'https://aviationweather.gov';
const UA = 'preflight-wx-briefing/1.0 (snapshot job)';
const STATIC_MAX_AGE_H = 24 * 7; // airports/navaids refresh weekly

async function fetchBuf(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${last.message}`);
}
const fetchText = async (url) => {
  const b = await fetchBuf(url);
  return (url.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8');
};

// ---------------------------------------------------------------- tiny XML/CSV helpers
const unesc = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function blocks(xml, name) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function val(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unesc(m[1]).trim() : null;
}
const num = (v) => (v == null || v === '' ? null : isFinite(Number(v)) ? Number(v) : null);
function sky(xml) {
  const out = [];
  const re = /<sky_condition\s+([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const cover = (m[1].match(/sky_cover="([^"]*)"/) || [])[1];
    const base = (m[1].match(/cloud_base_ft_agl="([^"]*)"/) || [])[1];
    if (cover) out.push({ cover, base: base != null ? Number(base) : null });
  }
  return out;
}
function csvRows(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const secs = (iso) => (iso ? Math.round(Date.parse(iso) / 1000) : null);
const wdir = (v) => (v === 'VRB' ? 'VRB' : num(v));

// ---------------------------------------------------------------- converters
function metarsFromXml(xml) {
  return blocks(xml, 'METAR').map((b) => ({
    icaoId: val(b, 'station_id'),
    obsTime: secs(val(b, 'observation_time')),
    rawOb: val(b, 'raw_text'),
    lat: num(val(b, 'latitude')), lon: num(val(b, 'longitude')),
    temp: num(val(b, 'temp_c')), dewp: num(val(b, 'dewpoint_c')),
    wdir: wdir(val(b, 'wind_dir_degrees')), wspd: num(val(b, 'wind_speed_kt')), wgst: num(val(b, 'wind_gust_kt')),
    visib: val(b, 'visibility_statute_mi'),
    altim: num(val(b, 'altim_in_hg')),
    slp: num(val(b, 'sea_level_pressure_mb')),
    wxString: val(b, 'wx_string'),
    clouds: sky(b), vertVis: num(val(b, 'vert_vis_ft')),
    fltCat: val(b, 'flight_category'),
    elev: num(val(b, 'elevation_m')),
  })).filter((m) => m.icaoId && m.lat != null);
}

function tafsFromXml(xml) {
  return blocks(xml, 'TAF').map((b) => {
    const fcsts = blocks(b, 'forecast').map((f) => ({
      timeFrom: secs(val(f, 'fcst_time_from')), timeTo: secs(val(f, 'fcst_time_to')),
      timeBec: secs(val(f, 'time_becoming')),
      fcstChange: val(f, 'change_indicator'), probability: num(val(f, 'probability')),
      wdir: wdir(val(f, 'wind_dir_degrees')), wspd: num(val(f, 'wind_speed_kt')), wgst: num(val(f, 'wind_gust_kt')),
      wshearHgt: num(val(f, 'wind_shear_hgt_ft_agl')), wshearDir: num(val(f, 'wind_shear_dir_degrees')), wshearSpd: num(val(f, 'wind_shear_speed_kt')),
      visib: val(f, 'visibility_statute_mi'), vertVis: num(val(f, 'vert_vis_ft')),
      wxString: val(f, 'wx_string'), clouds: sky(f),
    })).sort((a, c) => a.timeFrom - c.timeFrom);
    return {
      icaoId: val(b, 'station_id'), rawTAF: val(b, 'raw_text'),
      issueTime: val(b, 'issue_time'), validTimeFrom: secs(val(b, 'valid_time_from')), validTimeTo: secs(val(b, 'valid_time_to')),
      lat: num(val(b, 'latitude')), lon: num(val(b, 'longitude')), fcsts,
    };
  }).filter((t) => t.icaoId);
}

function pirepsFromCsv(text) {
  const rows = csvRows(text);
  const hdr = rows.findIndex((r) => r[0] === 'receipt_time');
  if (hdr < 0) return [];
  const H = rows[hdr];
  const idx = (name, n = 0) => { let k = -1; for (let i = 0; i < n + 1; i++) k = H.indexOf(name, k + 1); return k; };
  const I = {
    obs: idx('observation_time'), ac: idx('aircraft_ref'), lat: idx('latitude'), lon: idx('longitude'), alt: idx('altitude_ft_msl'),
    tbInt1: idx('turbulence_intensity'), tbInt2: idx('turbulence_intensity', 1), icInt1: idx('icing_intensity'), icInt2: idx('icing_intensity', 1),
    icType1: idx('icing_type'), type: idx('report_type'), raw: idx('raw_text'),
  };
  const out = [];
  for (const r of rows.slice(hdr + 1)) {
    if (r.length < H.length - 1) continue;
    const lat = num(r[I.lat]), lon = num(r[I.lon]);
    if (lat == null || lon == null) continue;
    const alt = num(r[I.alt]);
    out.push({
      obsTime: secs(r[I.obs]), acType: r[I.ac] || null, lat, lon, fltLvl: alt != null ? Math.round(alt / 100) : null,
      tbInt1: r[I.tbInt1] || '', tbInt2: r[I.tbInt2] || '', icgInt1: r[I.icInt1] || '', icgInt2: r[I.icInt2] || '', icgType1: r[I.icType1] || '',
      pirepType: r[I.type] || 'PIREP', rawOb: r[I.raw] || '',
    });
  }
  return out;
}

// OurAirports (public domain) -> airports with runways (true headings) and navaids, for runway wind and route lookups.
function airportsFromOurAirports(apText, rwText) {
  const ap = csvRows(apText), rw = csvRows(rwText);
  const AH = ap[0], RH = rw[0];
  const a = (r, k) => r[AH.indexOf(k)], w = (r, k) => r[RH.indexOf(k)];
  const byIdent = new Map();
  for (const r of ap.slice(1)) {
    const type = a(r, 'type');
    if (!['large_airport', 'medium_airport', 'small_airport'].includes(type)) continue;
    const ident = a(r, 'ident');
    const kw = (a(r, 'keywords') || '').split(/[,\s]+/).filter((k) => /^[A-Z][A-Z0-9]{2,3}$/.test(k));
    const aliases = [...new Set([ident, a(r, 'icao_code'), a(r, 'gps_code'), a(r, 'local_code'), ...kw].filter(Boolean))];
    byIdent.set(ident, {
      aliases,
      icaoId: a(r, 'icao_code') || a(r, 'gps_code') || ident, faaId: a(r, 'local_code') || null, iataId: a(r, 'iata_code') || null,
      name: a(r, 'name'), lat: num(a(r, 'latitude_deg')), lon: num(a(r, 'longitude_deg')), elev: num(a(r, 'elevation_ft')) != null ? Math.round(num(a(r, 'elevation_ft')) * 0.3048) : null,
      runways: [],
    });
  }
  for (const r of rw.slice(1)) {
    const apt = byIdent.get(w(r, 'airport_ident'));
    if (!apt || w(r, 'closed') === '1') continue;
    const len = num(w(r, 'length_ft'));
    if (!len || len < 3000) continue;
    const surf = (w(r, 'surface') || '').toUpperCase();
    const hard = /ASP|CON|PEM|BIT|TAR|ASPH|CONC/.test(surf);
    const le = w(r, 'le_ident'), he = w(r, 'he_ident');
    let hdg = num(w(r, 'le_heading_degT'));
    if (hdg == null) hdg = (parseInt(le, 10) || 0) * 10;
    apt.runways.push({ id: `${le}/${he}`, dimension: `${len}x${num(w(r, 'width_ft')) || 0}`, surface: hard ? 'A' : 'G', alignment: Math.round(hdg) });
  }
  return [...byIdent.values()].filter((x) => x.runways.length && x.lat != null);
}
function navaidsFromOurAirports(text) {
  const rows = csvRows(text);
  const H = rows[0];
  const g = (r, k) => r[H.indexOf(k)];
  return rows.slice(1).filter((r) => ['VOR', 'VORTAC', 'VOR-DME', 'TACAN', 'NDB', 'NDB-DME', 'DME'].includes(g(r, 'type')))
    .map((r) => ({ id: g(r, 'ident'), type: g(r, 'type'), name: g(r, 'name'), lat: num(g(r, 'latitude_deg')), lon: num(g(r, 'longitude_deg')), country: g(r, 'iso_country') }))
    .filter((n) => n.lat != null);
}

// ---------------------------------------------------------------- winds aloft grid
const WIND_LEVELS = [850, 700, 500, 400, 300, 250, 200, 150];
async function windsGrid() {
  const pts = [];
  for (let lat = 20; lat <= 55; lat += 5) for (let lon = -130; lon <= -60; lon += 5) pts.push({ lat, lon });
  const vars = WIND_LEVELS.flatMap((l) => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `temperature_${l}hPa`]).concat('freezing_level_height');
  const url = `https://api.open-meteo.com/v1/gfs?latitude=${pts.map((p) => p.lat).join(',')}&longitude=${pts.map((p) => p.lon).join(',')}&hourly=${vars.join(',')}&wind_speed_unit=kn&forecast_hours=30&timezone=GMT`;
  const raw = JSON.parse((await fetchBuf(url)).toString('utf8'));
  const arr = Array.isArray(raw) ? raw : [raw];
  if (arr[0] && arr[0].error) throw new Error(arr[0].reason);
  const times = arr[0].hourly.time.map((t) => Date.parse(t + 'Z'));
  const round = (a) => (a || []).map((v) => (v == null ? null : Math.round(v)));
  return {
    generatedAt: new Date().toISOString(), step: 5, levels: WIND_LEVELS, times,
    points: arr.map((d) => {
      const h = d.hourly, o = { lat: Math.round(d.latitude), lon: Math.round(d.longitude) };
      for (const k of vars) o[k] = round(h[k]);
      return o;
    }),
  };
}

// ---------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const meta = { generatedAt: new Date().toISOString(), sources: {} };
  const write = (name, data) => {
    fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const job = async (key, fn) => {
    try {
      const n = await fn();
      meta.sources[key] = { ok: true, at: new Date().toISOString(), count: n };
    } catch (e) {
      meta.sources[key] = { ok: false, at: new Date().toISOString(), error: String(e.message || e) };
      console.error(`[${key}] ${e.message}`);
    }
  };

  await Promise.all([
    job('metars', async () => { const d = metarsFromXml(await fetchText(`${AWC}/data/cache/metars.cache.xml.gz`)); write('metars.json', d); return d.length; }),
    job('tafs', async () => { const d = tafsFromXml(await fetchText(`${AWC}/data/cache/tafs.cache.xml.gz`)); write('tafs.json', d); return d.length; }),
    job('pireps', async () => { const d = pirepsFromCsv(await fetchText(`${AWC}/data/cache/aircraftreports.cache.csv.gz`)); write('pireps.json', d); return d.length; }),
    job('airsigmet', async () => { const d = JSON.parse(await fetchText(`${AWC}/api/data/airsigmet?format=json`)); write('airsigmet.json', d); return d.length; }),
    job('isigmet', async () => { const d = JSON.parse(await fetchText(`${AWC}/api/data/isigmet?format=json`)); write('isigmet.json', d); return d.length; }),
    job('gairmet', async () => { const d = JSON.parse(await fetchText(`${AWC}/api/data/gairmet?format=json`)); write('gairmet.json', d); return d.length; }),
    job('cwa', async () => { const d = JSON.parse(await fetchText(`${AWC}/api/data/cwa?format=json`)); write('cwa.json', d); return d.length; }),
    job('codsus', async () => { const t = await fetchText('https://tgftp.nws.noaa.gov/data/raw/as/asus01.kwbc.cod.sus.txt'); write('codsus.txt', t); return t.length; }),
    job('codsrp', async () => { const t = await fetchText('https://tgftp.nws.noaa.gov/data/raw/fs/fsus02.kwbc.cod.srp.txt'); write('codsrp.txt', t); return t.length; }),
  ]);

  // In CI the checkout is fresh, so reuse the slow-changing files already published on the site.
  if (process.env.SITE_URL) {
    for (const f of ['winds.json', 'airports.json', 'navaids.json']) {
      const dest = path.join(OUT, f);
      if (fs.existsSync(dest)) continue;
      try {
        const b = await fetchBuf(`${process.env.SITE_URL}/data/${f}`, 1);
        fs.writeFileSync(dest, b);
        if (f !== 'winds.json') {
          // keep the weekly refresh cycle: date the copy by the published meta, if known
          const m = JSON.parse((await fetchBuf(`${process.env.SITE_URL}/data/meta.json`, 1)).toString('utf8'));
          const at = m.sources && m.sources.airports && Date.parse(m.sources.airports.at);
          if (at) fs.utimesSync(dest, new Date(at), new Date(at));
        }
      } catch { /* first run, or site unreachable: fetch fresh below */ }
    }
  }

  // Static reference data: refresh weekly or when missing
  const apFile = path.join(OUT, 'airports.json');
  const stale = !fs.existsSync(apFile) || Date.now() - fs.statSync(apFile).mtimeMs > STATIC_MAX_AGE_H * 3600e3 || process.argv.includes('--refresh-static');
  if (stale) {
    await job('airports', async () => {
      const OA = 'https://davidmegginson.github.io/ourairports-data';
      const [ap, rw, nv] = await Promise.all([fetchText(`${OA}/airports.csv`), fetchText(`${OA}/runways.csv`), fetchText(`${OA}/navaids.csv`)]);
      const airports = airportsFromOurAirports(ap, rw);
      write('airports.json', airports);
      write('navaids.json', navaidsFromOurAirports(nv));
      return airports.length;
    });
  } else {
    meta.sources.airports = { ok: true, at: new Date(fs.statSync(apFile).mtimeMs).toISOString(), cached: true };
    if (!fs.existsSync(path.join(OUT, 'navaids.json'))) meta.sources.airports.note = 'navaids missing';
  }

  // Winds aloft grid (GFS via Open-Meteo), used when the browser can't reach Open-Meteo directly.
  // GFS updates every 6 h, so refresh this every 3 h to stay well inside Open-Meteo's free limits.
  const wFile = path.join(OUT, 'winds.json');
  const wPrev = fs.existsSync(wFile) ? JSON.parse(fs.readFileSync(wFile, 'utf8')) : null;
  if (!wPrev || Date.now() - Date.parse(wPrev.generatedAt) > 3 * 3600e3 || process.argv.includes('--refresh-winds')) {
    await job('winds', async () => { const g = await windsGrid(); write('winds.json', g); return g.points.length; });
  } else meta.sources.winds = { ok: true, at: wPrev.generatedAt, cached: true };

  write('meta.json', meta);
  const failed = Object.entries(meta.sources).filter(([, v]) => !v.ok).map(([k]) => k);
  console.log(`Snapshot ${meta.generatedAt}: ${Object.entries(meta.sources).map(([k, v]) => `${k}=${v.ok ? v.count ?? 'ok' : 'FAIL'}`).join(' ')}`);
  // Fail the job only if the core feeds are all down, so a partial outage still refreshes what it can.
  if (['metars', 'tafs', 'airsigmet', 'gairmet'].every((k) => failed.includes(k))) process.exit(1);
}

if (require.main === module) main();
module.exports = { windsGrid, metarsFromXml, tafsFromXml, pirepsFromCsv, airportsFromOurAirports, navaidsFromOurAirports, csvRows };
