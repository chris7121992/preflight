'use strict';
// WPC coded surface bulletin parser (CODSUS analysis, CODSRP 12/24 h progs) and route-relative interpretation.
const geo = require('./geo');

const KEYWORDS = ['HIGHS', 'LOWS', 'COLD', 'WARM', 'STNRY', 'OCFNT', 'TROF', 'DRYLN', 'DRYLINE', 'SQLN', 'SQUALL', 'OCCLUDED'];

function decodePoint(tok) {
  if (!/^\d{4,7}$/.test(tok)) return null;
  let lat, lon;
  if (tok.length >= 6) { // high-resolution: tenths of degrees
    lat = parseInt(tok.slice(0, 3), 10) / 10;
    lon = parseInt(tok.slice(3), 10) / 10;
  } else {
    lat = parseInt(tok.slice(0, 2), 10);
    lon = parseInt(tok.slice(2), 10);
  }
  return { lat, lon: -lon }; // bulletin longitudes are degrees west
}

// Parse a bulletin body into sections: [{ label, valid: Date|null, hours, highs, lows, fronts }]
function parseCoded(text, issuedRef = new Date()) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let cur = null;
  let last = null;
  // CODSUS analysis uses "VALID MMDDHHZ"; CODSRP progs use "VALID DDHHMMZ".
  const validToDate = (str, isProg) => {
    const s = str.replace(/Z$/, '');
    if (s.length !== 6) return null;
    const a = parseInt(s.slice(0, 2), 10), b = parseInt(s.slice(2, 4), 10), c = parseInt(s.slice(4, 6), 10);
    const y = issuedRef.getUTCFullYear(), m = issuedRef.getUTCMonth();
    let d = isProg ? new Date(Date.UTC(y, m, a, b, c)) : new Date(Date.UTC(y, a - 1, b, c));
    if (d - issuedRef > 20 * 86400e3) d = isProg ? new Date(Date.UTC(y, m - 1, a, b, c)) : new Date(Date.UTC(y - 1, a - 1, b, c));
    if (issuedRef - d > 20 * 86400e3) d = isProg ? new Date(Date.UTC(y, m + 1, a, b, c)) : new Date(Date.UTC(y + 1, a - 1, b, c));
    return d;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const vm = line.match(/^(?:(\d+)HR PROG )?VALID (\d{6}Z?)/);
    if (vm) {
      cur = { label: vm[1] ? `${vm[1]}h prog` : 'Analysis', hours: vm[1] ? parseInt(vm[1], 10) : 0, valid: validToDate(vm[2], !!vm[1]), highs: [], lows: [], fronts: [] };
      sections.push(cur);
      last = null;
      continue;
    }
    if (!cur) continue;
    const toks = line.split(/\s+/);
    if (KEYWORDS.includes(toks[0])) {
      const kind = toks[0] === 'DRYLINE' ? 'DRYLN' : toks[0] === 'OCCLUDED' ? 'OCFNT' : toks[0];
      if (kind === 'HIGHS' || kind === 'LOWS') {
        last = { kind, list: kind === 'HIGHS' ? cur.highs : cur.lows, pending: null };
        pushCenters(last, toks.slice(1));
      } else {
        const f = { type: kind, strength: null, points: [] };
        pushFront(f, toks.slice(1));
        cur.fronts.push(f);
        last = { kind: 'FRONT', front: f };
      }
    } else if (last && /^\d/.test(toks[0])) {
      if (last.kind === 'FRONT') pushFront(last.front, toks);
      else pushCenters(last, toks);
    } else {
      last = null;
    }
  }
  // The global bulletin repeats some features; drop exact duplicates.
  for (const sec of sections) {
    const seen = new Set();
    sec.fronts = sec.fronts.filter((f) => {
      const k = f.type + JSON.stringify(f.points);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    for (const key of ['highs', 'lows']) {
      const s2 = new Set();
      sec[key] = sec[key].filter((c) => { const k = `${c.pressure}${c.lat}${c.lon}`; if (s2.has(k)) return false; s2.add(k); return true; });
    }
  }
  return sections;
}
function pushCenters(state, toks) {
  for (const t of toks) {
    if (!/^\d+$/.test(t)) continue;
    if (state.pending == null) state.pending = parseInt(t, 10);
    else {
      const p = decodePoint(t);
      if (p) state.list.push({ pressure: state.pending, ...p });
      state.pending = null;
    }
  }
}
function pushFront(f, toks) {
  for (const t of toks) {
    if (/^(WK|MDT|STG)$/.test(t)) { f.strength = t; continue; }
    const p = decodePoint(t);
    if (p) f.points.push(p);
  }
}

const FAMILY = { COLD: ['COLD', 'OCFNT'], WARM: ['WARM', 'STNRY'], STNRY: ['STNRY', 'WARM', 'COLD'], OCFNT: ['OCFNT', 'COLD'], TROF: ['TROF'], DRYLN: ['DRYLN'], SQLN: ['SQLN', 'COLD', 'TROF'] };

function shiftPoint(p, dxNm, dyNm) {
  return { lat: p.lat + dyNm / 60, lon: p.lon + dxNm / (60 * Math.cos(geo.rad(p.lat))) };
}

// Estimate motion (kt, direction toward) of a front near reference point using the 12h prog.
function frontMotion(front, refPt, analysis, prog) {
  if (!prog || !analysis.valid || !prog.valid) return null;
  const hrs = (prog.valid - analysis.valid) / 3600e3;
  if (!(hrs > 0)) return null;
  const near = geo.distPointToPolylineNm(refPt, front.points);
  // Point on the analysed front nearest to the reference point
  const a = front.points[Math.max(0, near.idx)], b = front.points[Math.min(front.points.length - 1, near.idx + 1)];
  const P = front.points.length > 1 ? geo.interpolate(a, b, near.t || 0) : a;
  let best = null;
  for (const g of prog.fronts) {
    if (!(FAMILY[front.type] || [front.type]).includes(g.type) || g.points.length < 1) continue;
    const r = geo.distPointToPolylineNm(P, g.points);
    if (r.d < 700 && (!best || r.d < best.d)) {
      const ga = g.points[Math.max(0, r.idx)], gb = g.points[Math.min(g.points.length - 1, r.idx + 1)];
      best = { d: r.d, Q: g.points.length > 1 ? geo.interpolate(ga, gb, r.t || 0) : ga, type: g.type };
    }
  }
  if (!best) return null;
  const speed = best.d / hrs;
  const dir = geo.bearing(P, best.Q);
  const pp = geo.project(best.Q, P);
  return { speedKt: Math.round(speed), towardDeg: Math.round(dir), towardCompass: geo.compass(dir), vx: pp.x / hrs, vy: pp.y / hrs, becomes: best.type !== front.type ? best.type : null, hours: hrs };
}

function centerMotion(c, kind, analysis, prog) {
  if (!prog || !analysis.valid || !prog.valid) return null;
  const hrs = (prog.valid - analysis.valid) / 3600e3;
  const list = kind === 'H' ? prog.highs : prog.lows;
  let best = null;
  for (const q of list) {
    const d = geo.distNm(c, q);
    if (d < 600 && (!best || d < best.d)) best = { d, q };
  }
  if (!best) return null;
  return { speedKt: Math.round(best.d / hrs), towardCompass: geo.compass(geo.bearing(c, best.q)), pressureTrend: best.q.pressure - c.pressure, hours: hrs };
}

const FRONT_NAMES = { COLD: 'cold front', WARM: 'warm front', STNRY: 'stationary front', OCFNT: 'occluded front', TROF: 'surface trough', DRYLN: 'dry line', SQLN: 'squall line' };

const FRONT_WX = {
  COLD: 'Expect a relatively narrow band (typically 25-75 nm) of cumuliform cloud, showers and possible thunderstorms along and just ahead of the front, a sharp wind shift (usually to the W/NW), gusty winds, low-level wind shear and turbulence in the frontal zone, then rising pressure, falling temperature/dew point and generally improving ceilings and visibility behind it. Fast-moving cold fronts (over ~25 kt) and those running into warm, moist air are the most likely to produce squall lines, which can develop 50-300 nm ahead of the surface front. Clouds behind the front can carry rime icing where temperatures are below freezing.',
  WARM: 'Expect a broad area of stratiform cloud and steady precipitation extending well ahead of the surface front (up to 300-600 nm), with ceilings lowering and visibilities dropping in rain, drizzle, mist and fog as the front approaches. In cold season, the cold air wedge ahead of the front is the classic setup for freezing rain and ice pellets beneath the warm layer. If the overrunning warm air is unstable, thunderstorms can be embedded and hidden in the stratus. Fronts move slowly (typically 10-20 kt), so the weather lingers.',
  STNRY: 'A stationary front behaves much like a slow warm front: overrunning stratiform cloud, persistent low ceilings, drizzle/rain and fog on the cold side, and the potential for embedded convection when the warm air is unstable. Because it is not moving, the weather can persist for many hours or days, and waves forming along it can quickly spin up lows.',
  OCFNT: 'Occluded fronts combine warm-front and cold-front weather: widespread cloud and precipitation, embedded convection, icing in the layered cloud, and the most severe weather typically near the triple point where the warm, cold and occluded fronts meet.',
  TROF: 'A surface trough marks a line of relatively low pressure and a wind shift. It can focus showers, low ceilings or thunderstorms, especially with daytime heating, but is usually weaker than a true front.',
  DRYLN: 'A dry line separates moist air (east) from dry air (west). It is a common focus for severe thunderstorm initiation in the afternoon, particularly in spring.',
  SQLN: 'A squall line is a line of active thunderstorms. Expect severe turbulence, hail, heavy rain, gust fronts and wind shear. Do not attempt to penetrate; circumnavigate with wide margins.',
};

/**
 * Interpret the surface analysis relative to the planned flight.
 * samples: route samples [{lat,lon,s,t(ms epoch)}] with time at each sample.
 */
function interpretRoute(sections, samples, opts = {}) {
  const analysis = sections.find((s) => s.hours === 0) || sections[0];
  const progs = sections.filter((s) => s.hours > 0).sort((a, b) => a.hours - b.hours);
  const prog12 = progs[0] || null;
  if (!analysis) return { available: false };
  const routeLine = samples;
  const corridor = opts.corridorNm || 400;
  const dep = samples[0], dest = samples[samples.length - 1];
  const t0 = analysis.valid ? analysis.valid.getTime() : Date.now();

  const fronts = [];
  for (const f of analysis.fronts) {
    if (!f.points.length) continue;
    // Closest approach of analysed front to the route
    let nearest = { d: Infinity };
    for (const smp of routeLine) {
      const r = geo.distPointToPolylineNm(smp, f.points);
      if (r.d < nearest.d) nearest = { d: r.d, smp };
    }
    if (nearest.d > corridor) continue;
    const motion = frontMotion(f, nearest.smp, analysis, prog12);
    // Time-aware encounter: shift the front with its motion to each sample time
    let enc = { d: Infinity };
    for (const smp of routeLine) {
      const dtH = ((smp.t || Date.now()) - t0) / 3600e3;
      const pts = motion ? f.points.map((p) => shiftPoint(p, motion.vx * dtH, motion.vy * dtH)) : f.points;
      const r = geo.distPointToPolylineNm(smp, pts);
      if (r.d < enc.d) enc = { d: r.d, smp };
    }
    // Position of airports relative to the front at departure and arrival times
    const sideAt = (smp) => {
      const dtH = ((smp.t || Date.now()) - t0) / 3600e3;
      const pts = motion ? f.points.map((p) => shiftPoint(p, motion.vx * dtH, motion.vy * dtH)) : f.points;
      const r = geo.distPointToPolylineNm(smp, pts);
      return Math.round(r.d);
    };
    const crossesRoute = enc.d <= 30;
    const now = Date.now();
    const depPass = frontPassage(f, motion, dep, t0, Math.min(now, dep.t || now), (dest.t || now) + 3 * 3600e3);
    const destPass = frontPassage(f, motion, dest, t0, Math.min(now, dep.t || now), (dest.t || now) + 3 * 3600e3);
    fronts.push({
      type: f.type,
      name: FRONT_NAMES[f.type] || f.type,
      strength: f.strength,
      points: f.points,
      nearestNowNm: Math.round(nearest.d),
      nearestNowAtNm: Math.round(nearest.smp.s),
      motion,
      encounter: { distNm: Math.round(enc.d), alongRouteNm: Math.round(enc.smp.s), time: enc.smp.t ? new Date(enc.smp.t).toISOString() : null, lat: enc.smp.lat, lon: enc.smp.lon },
      crossesRoute,
      distFromDepAtEtdNm: sideAt(dep),
      distFromDestAtEtaNm: sideAt(dest),
      depPassage: depPass && depPass.passes ? new Date(depPass.firstWithin).toISOString() : null,
      destPassage: destPass && destPass.passes ? new Date(destPass.firstWithin).toISOString() : null,
      expectedWeather: FRONT_WX[f.type] || '',
    });
  }
  fronts.sort((a, b) => a.encounter.distNm - b.encounter.distNm);

  const centers = [];
  for (const [kind, list] of [['H', analysis.highs], ['L', analysis.lows]]) {
    for (const c of list) {
      const r = geo.distPointToPolylineNm(c, routeLine);
      if (r.d > 600) continue;
      const smp = routeLine[Math.min(routeLine.length - 1, Math.max(0, r.idx))];
      const bear = geo.bearing(smp, c);
      centers.push({ kind, pressure: c.pressure, lat: c.lat, lon: c.lon, distNm: Math.round(r.d), alongRouteNm: Math.round(smp.s), bearingFromRoute: geo.compass(bear), motion: centerMotion(c, kind, analysis, prog12) });
    }
  }
  centers.sort((a, b) => a.distNm - b.distNm);

  return {
    available: true,
    analysisValid: analysis.valid ? analysis.valid.toISOString() : null,
    progs: progs.map((p) => ({ label: p.label, valid: p.valid ? p.valid.toISOString() : null, fronts: p.fronts, highs: p.highs, lows: p.lows })),
    analysisFronts: analysis.fronts,
    analysisHighs: analysis.highs,
    analysisLows: analysis.lows,
    fronts,
    centers,
  };
}

// Times (ms) between tStart and tEnd when a moving front is within `withinNm` of a fixed point.
function frontPassage(front, motion, point, t0, tStart, tEnd, withinNm = 20) {
  if (!motion) return null;
  let first = null, minD = Infinity, minT = null;
  for (let t = tStart; t <= tEnd; t += 15 * 60e3) {
    const dtH = (t - t0) / 3600e3;
    const pts = front.points.map((p) => shiftPoint(p, motion.vx * dtH, motion.vy * dtH));
    const d = geo.distPointToPolylineNm(point, pts).d;
    if (d < minD) { minD = d; minT = t; }
    if (d <= withinNm && first == null) first = t;
  }
  return { passes: first != null, firstWithin: first, closestNm: Math.round(minD), closestAt: minT };
}

module.exports = { frontPassage, shiftPoint, parseCoded, interpretRoute, decodePoint, FRONT_NAMES, FRONT_WX };
