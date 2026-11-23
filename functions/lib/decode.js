'use strict';
// Helpers for decoding AWC JSON METAR/TAF/PIREP fields.

function parseVis(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/SM$/i, '');
  if (/\+$/.test(s)) return parseFloat(s);
  s = s.replace(/^[PM]/, '');
  const m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return +m[1] + +m[2] / +m[3];
  const f = s.match(/^(\d+)\/(\d+)$/);
  if (f) return +f[1] / +f[2];
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function ceilingOf(clouds, vertVis) {
  let ceil = null;
  for (const c of clouds || []) {
    if (['BKN', 'OVC', 'OVX', 'VV'].includes(c.cover) && c.base != null) ceil = ceil == null ? c.base : Math.min(ceil, c.base);
  }
  if (vertVis != null && vertVis !== '') {
    let vv = Number(vertVis);
    if (vv < 50) vv *= 100; // some feeds give hundreds of feet
    ceil = ceil == null ? vv : Math.min(ceil, vv);
  }
  return ceil;
}

function flightCategory(ceil, vis) {
  if ((ceil != null && ceil < 500) || (vis != null && vis < 1)) return 'LIFR';
  if ((ceil != null && ceil < 1000) || (vis != null && vis < 3)) return 'IFR';
  if ((ceil != null && ceil <= 3000) || (vis != null && vis <= 5)) return 'MVFR';
  return 'VFR';
}

const WX_FLAGS = [
  { re: /\bFZ(RA|DZ)\b|\bFZ(RA|DZ)/, key: 'freezingPrecip', label: 'freezing rain/drizzle' },
  { re: /\bPL\b|PL\b/, key: 'icePellets', label: 'ice pellets' },
  { re: /TS/, key: 'thunder', label: 'thunderstorm' },
  { re: /\+TS|TSGR|GR\b/, key: 'severeTs', label: 'heavy thunderstorm / hail' },
  { re: /\+SN|\bSN\b|SHSN|BLSN/, key: 'snow', label: 'snow' },
  { re: /\bFG\b|FZFG/, key: 'fog', label: 'fog' },
  { re: /FC|\+FC/, key: 'funnel', label: 'funnel cloud / tornado' },
  { re: /\bSQ\b/, key: 'squall', label: 'squalls' },
  { re: /\bVA\b/, key: 'ash', label: 'volcanic ash' },
  { re: /\bGS\b/, key: 'hail', label: 'small hail' },
];

function wxFlags(wx) {
  const s = String(wx || '');
  const out = {};
  for (const f of WX_FLAGS) if (f.re.test(s)) out[f.key] = f.label;
  return out;
}

function windOf(o) {
  const dir = o.wdir === 'VRB' || o.wdir == null ? null : Number(o.wdir);
  return { dir, vrb: o.wdir === 'VRB', spd: Number(o.wspd) || 0, gst: Number(o.wgst) || null };
}

// TAF periods overlapping a window [from,to] (ms). Returns prevailing + temporary groups.
function tafWindow(taf, from, to) {
  if (!taf || !Array.isArray(taf.fcsts)) return [];
  const out = [];
  for (const f of taf.fcsts) {
    const a = f.timeFrom * 1000, b = f.timeTo * 1000;
    if (b <= from || a >= to) continue;
    const vis = parseVis(f.visib);
    const ceil = ceilingOf(f.clouds, f.vertVis);
    out.push({
      change: f.fcstChange || 'INIT',
      probability: f.probability || null,
      from: new Date(a).toISOString(),
      to: new Date(b).toISOString(),
      ceiling: ceil,
      vis,
      wx: f.wxString || '',
      wind: windOf(f),
      llws: f.wshearHgt != null ? { hgt: f.wshearHgt * (f.wshearHgt < 50 ? 100 : 1), dir: f.wshearDir, spd: f.wshearSpd } : null,
      category: flightCategory(ceil, vis),
      temporary: ['TEMPO', 'PROB'].includes(f.fcstChange) || !!f.probability,
    });
  }
  return out;
}

function worstOf(periods) {
  let ceil = null, vis = null, gust = 0, spd = 0, flags = {}, llws = null;
  for (const p of periods) {
    if (p.ceiling != null) ceil = ceil == null ? p.ceiling : Math.min(ceil, p.ceiling);
    if (p.vis != null) vis = vis == null ? p.vis : Math.min(vis, p.vis);
    spd = Math.max(spd, p.wind.spd || 0);
    gust = Math.max(gust, p.wind.gst || 0);
    Object.assign(flags, wxFlags(p.wx));
    if (p.llws) llws = p.llws;
  }
  return { ceiling: ceil, vis, spd, gust, flags, llws, category: flightCategory(ceil, vis) };
}

module.exports = { parseVis, ceilingOf, flightCategory, wxFlags, windOf, tafWindow, worstOf };
