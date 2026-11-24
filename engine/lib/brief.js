'use strict';
// Builds the full briefing: resolves the route, pulls live data, runs the hazard screens and
// the go/no-go logic for the Citation XLS+, and writes the surface analysis narrative.
const geo = require('./geo');
const wx = require('./wx');
const fronts = require('./fronts');
const dec = require('./decode');
const { CE56X } = require('./aircraft');
const collins = require('./collins');
const nwp = require('./nwp');
const routing = require('./routing');
const minimums = require('./minimums');
const notam = require('./notam');

const fmtZ = (ms) => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
};
const isAirportId = (id) => /^[A-Z]{4}$/.test(id) || /^[A-Z0-9]{3,4}$/.test(id);

// ---------------------------------------------------------------- route resolution
async function resolveRoute(plan, errors) {
  const wps = plan.waypoints.map((w) => ({ ...w }));
  const missing = wps.filter((w) => !isFinite(w.lat) || !isFinite(w.lon));
  if (missing.length) {
    const ids = [...new Set(missing.map((w) => w.id))];
    const found = new Map();
    const ap = await wx.safe('airport lookup', () => wx.awc.airport(ids.filter((i) => i.length >= 3)), errors);
    for (const a of ap || []) for (const k of [a.icaoId, a.faaId, a.iataId, ...(a.aliases || [])]) if (k && !found.has(k)) found.set(k, { lat: a.lat, lon: a.lon, type: 'AIRPORT' });
    const rest = ids.filter((i) => !found.has(i));
    if (rest.length) {
      const nv = await wx.safe('navaid lookup', () => wx.awc.navaid(rest.filter((i) => i.length <= 3)), errors);
      for (const n of nv || []) found.set(n.id, { lat: n.lat, lon: n.lon, type: n.type || 'NAVAID' });
      const fx = await wx.safe('fix lookup', () => wx.awc.fix(rest.filter((i) => i.length === 5 && !found.has(i))), errors);
      for (const f of fx || []) found.set(f.id, { lat: f.lat, lon: f.lon, type: 'FIX' });
    }
    for (const w of wps) if (!isFinite(w.lat) && found.has(w.id)) Object.assign(w, found.get(w.id));
  }
  const unresolved = wps.filter((w) => !isFinite(w.lat));
  if (unresolved.length) errors.push({ source: 'route', error: `Could not locate: ${unresolved.map((w) => w.id).join(', ')} (skipped)` });
  return wps.filter((w) => isFinite(w.lat) && isFinite(w.lon));
}

// ---------------------------------------------------------------- timing profile
function buildProfile(route, opts, windsByS) {
  const total = geo.routeLength(route);
  const cruise = opts.cruiseAlt;
  const climbNm = Math.min(total * 0.45, (cruise / 1000) * 2.6);
  const descNm = Math.min(total * 0.45, (cruise / 1000) * 3.0);
  const samples = geo.sampleRoute(route, 10);
  let t = opts.etd;
  let prev = null;
  for (const smp of samples) {
    if (prev) {
      const ds = smp.s - prev.s;
      const inCruise = prev.s >= climbNm && prev.s <= total - descNm;
      const comp = windsByS ? windsByS(prev.s, Math.round(geo.bearing(prev, smp))) : 0;
      const gs = Math.max(150, (inCruise ? opts.tas : CE56X.climbDescentAvgKt) + (inCruise ? comp : comp * 0.5));
      t += (ds / gs) * 3600e3;
    }
    smp.t = t;
    smp.alt = smp.s < climbNm ? (cruise * smp.s) / climbNm : smp.s > total - descNm ? (cruise * (total - smp.s)) / descNm : cruise;
    smp.phase = smp.s < climbNm ? 'climb' : smp.s > total - descNm ? 'descent' : 'cruise';
    prev = smp;
  }
  return { samples, totalNm: total, climbNm, descNm, eta: samples[samples.length - 1].t };
}

function bboxOf(points, padDeg = 1.5) {
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  return { minLat: Math.min(...lats) - padDeg, maxLat: Math.max(...lats) + padDeg, minLon: Math.min(...lons) - padDeg, maxLon: Math.max(...lons) + padDeg };
}

// ---------------------------------------------------------------- winds aloft
function windsModel(wa, cruiseFt) {
  if (!wa) return null;
  const lvl = wa.level;
  const pts = wa.data.map((d, i) => {
    const h = d.hourly || {};
    return { i, lat: d.latitude, lon: d.longitude, time: (h.time || []).map((x) => Date.parse(x + 'Z')), h };
  });
  const at = (pi, ms, key) => {
    const p = pts[pi];
    if (!p || !p.time.length) return null;
    let k = 0, best = Infinity;
    p.time.forEach((tm, j) => { const d = Math.abs(tm - ms); if (d < best) { best = d; k = j; } });
    const arr = p.h[key];
    return arr ? arr[k] : null;
  };
  return { lvl, pts, at, cruiseFt };
}

// ---------------------------------------------------------------- polygon helpers
const toPoly = (coords) => (coords || []).map((c) => ({ lat: Number(c.lat), lon: Number(c.lon) })).filter((c) => isFinite(c.lat) && isFinite(c.lon));
const ftFromHundreds = (v) => {
  if (v == null || v === '') return null;
  if (v === 'SFC') return 0;
  if (v === 'FZL') return 'FZL';
  const n = Number(v);
  return isFinite(n) ? (n < 1000 ? n * 100 : n) : null;
};
function shiftPoly(poly, dirFrom, spdKt, hours) {
  if (!spdKt || !isFinite(dirFrom) || !hours) return poly;
  const toward = (dirFrom + 180) % 360; // AWC movement direction is "moving from"
  const d = spdKt * hours;
  const dx = d * Math.sin(geo.rad(toward)), dy = d * Math.cos(geo.rad(toward));
  return poly.map((p) => fronts.shiftPoint(p, dx, dy));
}

// Check samples against an area; returns the first/closest offending sample.
function routeHits(samples, poly, { base = 0, top = 99999, bufferNm = 0, tFrom = -Infinity, tTo = Infinity, slackMs = 3600e3, moveFn = null } = {}) {
  let hit = null;
  for (const smp of samples) {
    if (smp.t < tFrom - slackMs || smp.t > tTo + slackMs) continue;
    if (smp.alt < base - 1000 || smp.alt > top + 1000) continue;
    const pp = moveFn ? moveFn(smp.t) : poly;
    if (pp.length < 3) continue;
    const d = geo.distPointToPolygonNm(smp, pp);
    if (d <= bufferNm && (!hit || d < hit.d)) hit = { d, smp };
  }
  return hit;
}

// ---------------------------------------------------------------- crosswind
function bestRunway(airport, wind, opts) {
  if (!airport || !Array.isArray(airport.runways) || !wind) return null;
  const minLen = opts.minRunwayFt || CE56X.minRunwayFt;
  const ends = [];
  for (const r of airport.runways) {
    const len = parseInt(String(r.dimension || '').split('x')[0], 10) || 0;
    if (/^[GTDW]/.test(r.surface || '') || /H/.test(r.id || '')) continue;
    const ids = String(r.id || '').split('/');
    let hdg = Number(r.alignment);
    if (!isFinite(hdg)) hdg = (parseInt(ids[0], 10) || 0) * 10;
    ends.push({ id: ids[0], hdg, len });
    ends.push({ id: ids[1] || '', hdg: (hdg + 180) % 360, len });
  }
  if (!ends.length) return null;
  const evalEnd = (e) => {
    if (wind.vrb || wind.dir == null) {
      const v = Math.max(wind.spd || 0, wind.gst || 0);
      return { ...e, head: wind.spd <= 6 ? 0 : -v, cross: v, crossG: v };
    }
    const ang = geo.rad(geo.angleDiff(wind.dir, e.hdg));
    const head = wind.spd * Math.cos(ang);
    const cross = Math.abs(wind.spd * Math.sin(ang));
    const crossG = wind.gst ? Math.abs(wind.gst * Math.sin(ang)) : cross;
    return { ...e, head: Math.round(head), cross: Math.round(cross), crossG: Math.round(crossG) };
  };
  const evaluated = ends.map(evalEnd);
  const usable = evaluated.filter((e) => e.len >= minLen && e.head >= -(opts.maxTailwindKt || CE56X.maxTailwindKt));
  const pool = usable.length ? usable : evaluated.filter((e) => e.len >= (CE56X.absoluteMinRunwayFt));
  if (!pool.length) return { none: true, longestFt: Math.max(...ends.map((e) => e.len)) };
  pool.sort((a, b) => a.crossG - b.crossG || b.head - a.head);
  return { ...pool[0], longestFt: Math.max(...ends.map((e) => e.len)), shortList: !usable.length };
}

// ---------------------------------------------------------------- main
const num = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));

async function buildBriefing(plan, input) {
  const errors = [];
  const opts = {
    cruiseAlt: Math.min(CE56X.maxAltitudeFt, Math.max(3000, Number(input.cruiseAlt) || plan.cruiseAlt || 41000)),
    tas: Number(input.tas) || CE56X.cruiseKtas,
    etd: input.etd ? Date.parse(input.etd) : Date.now() + 3600e3,
    rules: input.rules === '135' ? '135' : '91',
    maxXwind: Number(input.maxXwind) || CE56X.maxDemoCrosswindKt,
    maxTailwindKt: Number(input.maxTailwind) || CE56X.maxTailwindKt,
    minCeiling: Number(input.minCeiling) || 200,
    minVis: Number(input.minVis) || 0.5,
    minRunwayFt: Number(input.minRunway) || CE56X.minRunwayFt,
    alternate: (input.alternate || '').toUpperCase().trim() || null,
    // Approach figures for the 135.223 / alternate-minimums tests. Defaults are generic Category C estimates;
    // the pilot should enter the values from the charts for the procedures actually planned.
    destCircHaa: num(input.destCircHaa),
    destCircNa: !!input.destCircNa,
    destHat: num(input.destHat),
    destVisMin: num(input.destVisMin),
    altNavFacilities: input.altNavFacilities === '2' ? 2 : input.altNavFacilities === '1' ? 1 : input.altNavFacilities === 'std' ? 'std' : 'auto',
    altHat: num(input.altHat),
    altVisMin: num(input.altVisMin),
    approachCat: ['A', 'B', 'C', 'D'].includes(input.approachCat) ? input.approachCat : 'C',
    altGps: !!input.altGps,
    highMinsPic: !!input.highMinsPic,
    notamText: typeof input.notamText === 'string' ? input.notamText.slice(0, 2e6) : '',
  };
  if (opts.highMinsPic) { opts.minCeiling += 100; opts.minVis += 0.5; }
  if (!isFinite(opts.etd)) opts.etd = Date.now() + 3600e3;

  const route = await resolveRoute(plan, errors);
  if (route.length < 2) throw new Error('Could not resolve at least two route points.');
  const dep = route[0], dest = route[route.length - 1];
  const airports = [dep.id, dest.id, opts.alternate].filter(Boolean);

  // Static route sampling (for picking winds points) before timing
  const pre = geo.sampleRoute(route, 10);
  const nWind = Math.min(10, Math.max(3, Math.round(geo.routeLength(route) / 120)));
  const windPts = Array.from({ length: nWind }, (_, i) => pre[Math.round((i * (pre.length - 1)) / (nWind - 1))]);
  const bbox = bboxOf(route, 1.5);

  // ---- parallel live fetches
  const [metars, tafs, apts, pireps, sigmets, isigmets, gairmets, cwas, codsus, codsrp, wa, enrouteMetars, notams, regionalMetars] = await Promise.all([
    wx.safe('METAR', () => wx.awc.metar(airports), errors),
    wx.safe('TAF', () => wx.awc.taf(airports), errors),
    wx.safe('Airport data', () => wx.awc.airport(airports), errors),
    wx.safe('PIREPs', () => wx.awc.pirepBbox(bbox, 2), errors),
    wx.safe('SIGMETs (domestic)', () => wx.awc.airsigmet(), errors),
    wx.safe('SIGMETs (international)', () => wx.awc.isigmet(), errors),
    wx.safe('G-AIRMETs', () => wx.awc.gairmet(), errors),
    wx.safe('CWAs', () => wx.awc.cwa(), errors),
    wx.safe('WPC surface analysis (CODSUS)', () => wx.wpc.codsus(), errors),
    wx.safe('WPC surface progs (CODSRP)', () => wx.wpc.codsrp(), errors),
    wx.safe('Winds aloft (GFS via Open-Meteo)', () => wx.windsAloft(windPts, opts.cruiseAlt), errors),
    wx.safe('En-route METARs', () => wx.awc.metarBbox(bboxOf(route, 0.6)), errors),
    wx.safe('NOTAMs (FAA API)', () => wx.notams(airports), errors),
    wx.safe('Regional METARs', () => wx.awc.metarBbox(bboxOf(route, 6)), errors),
  ]);

  // ---- winds model and timing
  const wm = windsModel(wa, opts.cruiseAlt);
  const windComp = wm
    ? (s, trk) => {
        const idx = windPts.reduce((bi, p, i) => (Math.abs(p.s - s) < Math.abs(windPts[bi].s - s) ? i : bi), 0);
        const t = opts.etd + (s / opts.tas) * 3600e3;
        const ws = wm.at(idx, t, `wind_speed_${wm.lvl}hPa`), wd = wm.at(idx, t, `wind_direction_${wm.lvl}hPa`);
        if (ws == null || wd == null) return 0;
        return -ws * Math.cos(geo.rad(geo.angleDiff(wd, trk))); // positive = tailwind
      }
    : null;
  const prof = buildProfile(route, opts, windComp);
  const S = prof.samples;
  const etaMs = prof.eta;
  const eteMin = Math.round((etaMs - opts.etd) / 60e3);

  const winds = [];
  if (wm) {
    windPts.forEach((p, i) => {
      const smp = S.reduce((a, b) => (Math.abs(b.s - p.s) < Math.abs(a.s - p.s) ? b : a));
      const t = smp.t;
      const g = (k) => wm.at(i, t, k);
      const trk = geo.bearing(S[Math.max(0, S.indexOf(smp) - 1)], S[Math.min(S.length - 1, S.indexOf(smp) + 1)]);
      const wd = g(`wind_direction_${wm.lvl}hPa`), wsp = g(`wind_speed_${wm.lvl}hPa`), tmp = g(`temperature_${wm.lvl}hPa`);
      const hPa = wm.lvl;
      const isaT = 15 - 1.98 * Math.min(36089, opts.cruiseAlt) / 1000;
      winds.push({
        alongNm: Math.round(p.s), lat: p.lat, lon: p.lon, time: new Date(t).toISOString(), levelHpa: hPa,
        dir: wd != null ? Math.round(wd) : null, spd: wsp != null ? Math.round(wsp) : null, temp: tmp != null ? Math.round(tmp) : null,
        isaDev: tmp != null ? Math.round(tmp - Math.max(-56.5, isaT)) : null,
        component: wd != null && wsp != null ? Math.round(-wsp * Math.cos(geo.rad(geo.angleDiff(wd, trk)))) : null,
        freezingLevelFt: g('freezing_level_height') != null ? Math.round(g('freezing_level_height') * 3.28084 / 100) * 100 : null,
        shear300: (() => {
          const a = g(`wind_speed_${wm.lvl}hPa`), b = g('wind_speed_300hPa');
          return a != null && b != null && wm.lvl !== 300 ? Math.round(Math.abs(a - b)) : null;
        })(),
      });
    });
  }

  // Upper-air summary at each winds point (850/700/500 mb): Collins' upper-support and stability checks, model icing screen
  const upper = wm ? windPts.map((p, i) => {
    const smp = S.reduce((a, b) => (Math.abs(b.s - p.s) < Math.abs(a.s - p.s) ? b : a));
    const g = (k) => wm.at(i, smp.t, k);
    return { lat: p.lat, lon: p.lon, s: p.s, d500: g('wind_direction_500hPa'), s500: g('wind_speed_500hPa'), t500: g('temperature_500hPa'), d700: g('wind_direction_700hPa'), s700: g('wind_speed_700hPa'), t700: g('temperature_700hPa'), d850: g('wind_direction_850hPa'), s850: g('wind_speed_850hPa'), t850: g('temperature_850hPa'), rh850: g('relative_humidity_850hPa'), rh700: g('relative_humidity_700hPa'), rh500: g('relative_humidity_500hPa') };
  }) : [];
  // Wind component and ISA deviation at any flight level, for the altitude comparison
  const windAt = wm ? (ft) => {
    const avail = (wa.levels || []).filter((l) => wm.pts.some((p) => p.h[`wind_speed_${l}hPa`]));
    if (!avail.length) return null;
    const want = wx.altToHpa(ft);
    const l = avail.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    const comp = (s, trk) => {
      const idx = windPts.reduce((bi, p, i) => (Math.abs(p.s - s) < Math.abs(windPts[bi].s - s) ? i : bi), 0);
      const t = opts.etd + (s / opts.tas) * 3600e3;
      const ws = wm.at(idx, t, `wind_speed_${l}hPa`), wd = wm.at(idx, t, `wind_direction_${l}hPa`);
      return ws == null || wd == null ? 0 : -ws * Math.cos(geo.rad(geo.angleDiff(wd, trk)));
    };
    const cs = [], isa = [];
    windPts.forEach((p, i) => {
      const t = opts.etd + (p.s / opts.tas) * 3600e3;
      const trk = geo.bearing(S[Math.max(0, S.findIndex((x) => x.s >= p.s) - 1)] || dep, S[Math.min(S.length - 1, S.findIndex((x) => x.s >= p.s) + 1)] || dest);
      const ws = wm.at(i, t, `wind_speed_${l}hPa`), wd = wm.at(i, t, `wind_direction_${l}hPa`), tt = wm.at(i, t, `temperature_${l}hPa`);
      if (ws != null && wd != null) cs.push(-ws * Math.cos(geo.rad(geo.angleDiff(wd, trk))));
      if (tt != null) isa.push(tt - Math.max(-56.5, 15 - 1.98 * Math.min(36089, ft) / 1000));
    });
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    return { comp, avg: avg(cs), isa: avg(isa), level: l };
  } : null;

  // ---- factors
  const factors = [];
  const add = (level, category, title, detail, where) => factors.push({ level, category, title, detail, where: where || null });
  // level: 'nogo' | 'caution' | 'info' | 'ok'

  const byId = (arr, id) => (arr || []).find((x) => x.icaoId === id || x.faaId === id || x.iataId === id || (x.aliases || []).includes(id));
  const aptInfo = {};
  for (const id of airports) aptInfo[id] = byId(apts, id) || null;

  // Which station actually reports weather for each airport? Identifiers change (e.g. KPBI became KDJT),
  // so try the airport's other identifiers, then the nearest reporting station within 30 nm.
  let metarsAll = metars || [], tafsAll = tafs || [];
  const reporting = {};
  const hasWx = (sid) => metarsAll.some((m) => m.icaoId === sid) || tafsAll.some((t) => t.icaoId === sid);
  const aliasIds = [];
  for (const id of airports) {
    const a = aptInfo[id];
    if (!hasWx(id) && a) for (const al of [a.icaoId, ...(a.aliases || [])]) if (al && al !== id && /^[A-Z0-9]{3,4}$/.test(al)) aliasIds.push(al);
  }
  if (aliasIds.length) {
    const [m2, t2] = await Promise.all([wx.safe('METAR', () => wx.awc.metar(aliasIds), errors), wx.safe('TAF', () => wx.awc.taf(aliasIds), errors)]);
    metarsAll = metarsAll.concat(m2 || []);
    tafsAll = tafsAll.concat(t2 || []);
  }
  for (const id of airports) {
    const a = aptInfo[id];
    const cands = [id, ...(a ? [a.icaoId, ...(a.aliases || [])] : [])].filter(Boolean);
    const mId = cands.find((c) => metarsAll.some((m) => m.icaoId === c));
    const tId = cands.find((c) => tafsAll.some((t) => t.icaoId === c));
    reporting[id] = { metarId: mId || null, tafId: tId || null, nearby: false };
    if ((!mId || !tId) && a && isFinite(a.lat)) {
      const box = { minLat: a.lat - 0.6, maxLat: a.lat + 0.6, minLon: a.lon - 0.8, maxLon: a.lon + 0.8 };
      const [nm, nt] = await Promise.all([
        !mId ? wx.safe('METAR', () => wx.awc.metarBbox(box), errors) : null,
        !tId && wx.awc.tafBbox ? wx.safe('TAF', () => wx.awc.tafBbox(box), errors) : null,
      ]);
      const near = (list) => (list || []).map((x) => ({ x, d: geo.distNm(a, x) })).filter((o) => o.d <= 30 && isFinite(o.d)).sort((p, q) => p.d - q.d)[0];
      const bm = near(nm), bt = near(nt);
      if (bm) { metarsAll.push(bm.x); reporting[id].metarId = bm.x.icaoId; reporting[id].nearby = true; reporting[id].metarDist = Math.round(bm.d); }
      if (bt) { tafsAll.push(bt.x); reporting[id].tafId = bt.x.icaoId; reporting[id].nearby = true; reporting[id].tafDist = Math.round(bt.d); }
    }
  }

  // NOTAMs from the pilot's briefing (pasted text or a ForeFlight briefing PDF read in the browser)
  const pastedNotams = opts.notamText.trim() ? notam.parse(opts.notamText) : null;
  const notamsBy = pastedNotams ? notam.byAirport(pastedNotams, airports.map((id) => ({ id, ids: [id, ...(aptInfo[id] ? [aptInfo[id].icaoId, aptInfo[id].faaId, ...(aptInfo[id].aliases || [])] : [])] }))) : {};
  // What is in force at an airport during a time window
  const notamState = (id, t0, t1) => {
    const act = (notamsBy[id] || []).filter((n) => notam.activeIn(n, t0, t1));
    const items = act.flatMap((n) => n.items.map((it) => ({ ...it, notam: n })));
    return {
      active: act,
      closedRwy: items.filter((it) => it.kind === 'RWY' && it.status === 'closed'),
      otherRwy: items.filter((it) => it.kind === 'RWY' && (it.status === 'restricted' || it.status === 'affected')),
      twy: items.filter((it) => it.kind !== 'RWY' && (it.status === 'closed' || it.status === 'restricted')),
      navOut: act.filter((n) => n.nav && n.nav.part === 'aid' && n.nav.rwy),
    };
  };
  // Approaches that NOTAMs take away: any approach to a closed runway, and ILS/LOC approaches whose aid is out
  const approachSkip = (ns) => (o) => ns.closedRwy.some((it) => notam.sameRunway(it.name, o.rwy)) || (!o.rnav && ns.navOut.some((n) => notam.sameRunway(n.nav.rwy, o.rwy) && new RegExp(`\\b${n.nav.aid === 'GP' || n.nav.aid === 'GS' ? 'ILS' : n.nav.aid}\\b`).test(o.proc + ' ' + o.line)));

  // Published approach minimums (FAA d-TPP) for the destination and alternate
  const mins = {};
  for (const id of [dest.id, opts.alternate].filter(Boolean)) {
    const a = aptInfo[id];
    mins[id] = await wx.safe('Approach minimums (FAA d-TPP)', () => wx.minimums([id, ...(a ? [a.icaoId, a.faaId, ...(a.aliases || [])] : [])]), errors);
  }
  const procTxt = (o) => `${o.proc} ${o.line}: ${o.alt} ft MSL (${o.hat} ft above), ${o.vis} SM`;

  // Station analysis (departure at ETD, destination & alternate at ETA)
  const stations = [];
  const analyzeStation = (id, role, tMs) => {
    const rep = reporting[id] || {};
    const metarList = metarsAll.filter((m) => m.icaoId === (rep.metarId || id)).sort((a, b) => b.obsTime - a.obsTime);
    const metar = metarList[0] || null;
    const taf = tafsAll.filter((t) => t.icaoId === (rep.tafId || id)).sort((a, b) => b.issueTime > a.issueTime ? 1 : -1)[0] || null;
    const repNote = [rep.metarId && rep.metarId !== id ? `METAR from ${rep.metarId}${rep.metarDist != null ? ` (${rep.metarDist} nm away)` : ''}` : '', rep.tafId && rep.tafId !== id ? `TAF from ${rep.tafId}${rep.tafDist != null ? ` (${rep.tafDist} nm away)` : ''}` : ''].filter(Boolean).join(', ');
    if (repNote) {
      if (rep.nearby) add(role === 'departure' ? 'info' : 'caution', 'Data', `${id}: using a nearby station's weather`, `${id} has no report of its own, so this uses ${repNote}. Nearby observations can differ from the field (terrain, sea breeze, fog). ${role === 'alternate' ? 'An alternate generally needs its own TAF to be legal under 91.169/135.221; confirm before filing it.' : 'Get the ATIS/AWOS before relying on it.'}`, id);
      else add('info', 'Data', `${id} reports weather as ${rep.metarId || rep.tafId}`, `The airport's weather is published under another identifier (${repNote}). ForeFlight or older databases may still use ${id}.`, id);
    }
    const win = role === 'departure' ? [tMs - 30 * 60e3, tMs + 60 * 60e3] : [tMs - 3600e3, tMs + 3600e3];
    const periods = dec.tafWindow(taf, win[0], win[1]);
    const prevailing = periods.filter((p) => !p.temporary);
    const worstAll = dec.worstOf(periods);
    const worstPrev = dec.worstOf(prevailing.length ? prevailing : periods);
    const hoursAhead = (tMs - Date.now()) / 3600e3;
    const useMetar = !taf || hoursAhead < 1;
    let cur = null;
    if (metar) {
      const ceil = dec.ceilingOf(metar.clouds, metar.vertVis);
      const vis = dec.parseVis(metar.visib);
      cur = { raw: metar.rawOb, ceiling: ceil, vis, wind: dec.windOf(metar), temp: metar.temp, dewp: metar.dewp, flags: dec.wxFlags(metar.wxString), category: dec.flightCategory(ceil, vis), obsTime: new Date(metar.obsTime * 1000).toISOString(), altim: metar.altim };
    }
    const apt = aptInfo[id];
    const station = { id, role, reportingAs: repNote || null, name: (apt && apt.name) || (metar && metar.name) || id, timeOfInterest: new Date(tMs).toISOString(), window: win.map((x) => new Date(x).toISOString()), metar: cur, taf: taf ? taf.rawTAF : null, tafPeriods: periods, forecast: taf ? { prevailing: worstPrev, worst: worstAll } : null, runway: null, elev: apt ? apt.elev : metar ? metar.elev : null };

    // Conditions to judge: forecast window (or METAR if close in / no TAF)
    const cond = taf && periods.length && !useMetar ? worstPrev : cur ? { ceiling: cur.ceiling, vis: cur.vis, flags: cur.flags, spd: cur.wind.spd, gust: cur.wind.gst, category: cur.category } : null;
    const worst = taf && periods.length && !useMetar ? worstAll : cond;
    station.judged = cond;
    station.judgedFrom = taf && periods.length && !useMetar ? 'TAF' : cur ? 'METAR' : 'none';
    if (!cond) {
      const span = `${fmtZ(win[0])}-${fmtZ(win[1])}`;
      if (role === 'destination') {
        station.alternateRequired = true;
        if (opts.rules === '135') add('nogo', 'Data', `${id}: no weather report or forecast`, `No METAR or TAF for ${id} covering ${span}. Part 135.213/135.219 require weather reports/forecasts for the destination; this flight cannot be dispatched IFR to ${id} as planned. Check whether the feed is temporarily out (call the FBO/ATIS) or plan to a reporting airport.`, id);
        else add(opts.alternate ? 'caution' : 'nogo', 'Data', `${id}: no weather report or forecast`, `No METAR or TAF for ${id} covering ${span} (the station may be out of service or the feed delayed). Under 91.169 an alternate is required when no forecast is available${opts.alternate ? `, which you have (${opts.alternate}). Get the ATIS/FBO observation before departure and fuel for the alternate.` : '. Add one before departing.'}`, id);
      } else if (role === 'departure') add('caution', 'Data', `${id}: no current report`, `No METAR/TAF for ${id}. Get the ATIS or a local observation before departure.`, id);
      else add('nogo', 'Alternate', `${id}: no forecast for the alternate`, `An airport without a TAF cannot be used as an IFR alternate. Choose another.`, id);
      stations.push(station);
      return station;
    }
    if (taf && !periods.length && hoursAhead > 1) add('caution', 'Data', `${id}: TAF does not cover ${fmtZ(tMs)}`, `The current TAF ends before the time of interest. Re-check when the next TAF is issued.`, id);

    // Wind / runway
    const windSrc = taf && periods.length && !useMetar
      ? (() => { let w = null; for (const p of periods) if (!w || (p.wind.gst || p.wind.spd) > (w.gst || w.spd)) w = p.wind; return w; })()
      : cur && cur.wind;
    const ns = notamState(id, win[0], win[1]);
    const openApt = apt && ns.closedRwy.length ? { ...apt, runways: (apt.runways || []).filter((r) => !ns.closedRwy.some((it) => notam.sameRunway(it.name, r.id))) } : apt;
    const rw = bestRunway(openApt, windSrc, opts);
    if (pastedNotams) {
      station.notams = { count: (notamsBy[id] || []).length, closedRunways: ns.closedRwy.map((it) => it.name), closedTaxiways: [...new Set(ns.twy.map((it) => it.name))] };
      const tx = (n) => `${n.number || ''} ${n.summary}`.trim();
      if (ns.closedRwy.length) add(apt && openApt.runways.length === 0 ? 'nogo' : 'caution', 'NOTAM', `${id}: runway ${[...new Set(ns.closedRwy.map((it) => it.name))].join(', ')} closed by NOTAM`, `${apt && openApt.runways.length === 0 ? 'Every runway in the database is closed in this window. ' : 'Closed runways are left out of the runway, crosswind and approach-minimums checks. '}${ns.closedRwy.map((it) => tx(it.notam)).join(' | ')}`, id);
      if (ns.otherRwy.length) add('caution', 'NOTAM', `${id}: runway ${[...new Set(ns.otherRwy.map((it) => it.name))].join(', ')} restricted or work in progress`, ns.otherRwy.map((it) => tx(it.notam)).join(' | '), id);
      if (ns.navOut.length) add('caution', 'NOTAM', `${id}: approach aid out of service`, `${ns.navOut.map((n) => tx(n)).join(' | ')}. Approaches that need these aids are left out of the automatic minimums.`, id);
      if (ns.twy.length) add('info', 'NOTAM', `${id}: ${[...new Set(ns.twy.map((it) => it.name))].length} taxiway or apron closure(s)`, `Closed or partly closed: ${[...new Set(ns.twy.map((it) => it.name))].join(', ')}. See the closure diagram.`, id);
    }
    station.runway = rw;
    station.windUsed = windSrc;
    if (rw && rw.none) add('nogo', 'Runway', `${id}: no runway meets ${CE56X.absoluteMinRunwayFt} ft`, `Longest hard-surface runway in the database is ${rw.longestFt} ft.`, id);
    else if (rw) {
      if (rw.shortList) add('caution', 'Runway', `${id}: best wind runway shorter than ${opts.minRunwayFt} ft`, `Runway ${rw.id} (${rw.len} ft) is the best aligned option. Confirm landing/takeoff distance with current weight, temperature and runway condition (and 135 factoring if applicable).`, id);
      if (rw.crossG > opts.maxXwind) add('nogo', 'Crosswind', `${id}: crosswind ${rw.crossG} kt exceeds ${opts.maxXwind} kt`, `Best runway ${rw.id} (${Math.round(rw.hdg)}°T): headwind ${rw.head} kt, crosswind ${rw.cross} kt steady / ${rw.crossG} kt gust, against the XLS+ maximum demonstrated crosswind of ${CE56X.maxDemoCrosswindKt} kt (limit set to ${opts.maxXwind} kt).`, id);
      else if (rw.crossG > opts.maxXwind * 0.75) add('caution', 'Crosswind', `${id}: crosswind ${rw.crossG} kt (gust) near limit`, `Runway ${rw.id}: crosswind ${rw.cross} kt steady / ${rw.crossG} kt gust against a ${opts.maxXwind} kt limit. Expect mechanical turbulence and gust-factor additives on Vref.`, id);
      if (rw.head < -opts.maxTailwindKt) add('nogo', 'Tailwind', `${id}: tailwind ${-rw.head} kt on best runway`, `Exceeds the ${opts.maxTailwindKt} kt tailwind limit.`, id);
    }
    if ((windSrc && windSrc.gst && windSrc.gst - windSrc.spd >= 15)) add('caution', 'Wind', `${id}: gust spread ${windSrc.gst - windSrc.spd} kt`, `Large gust factor (${windSrc.spd}G${windSrc.gst} kt) indicates low-level turbulence and possible wind shear on approach. Add half the gust factor to Vref per SOP.`, id);
    if (worst && worst.llws) add('caution', 'Wind shear', `${id}: low-level wind shear forecast`, `TAF WS group: ${worst.llws.hgt} ft AGL, ${worst.llws.dir}° at ${worst.llws.spd} kt.`, id);

    // Ceiling/visibility vs minimums
    const fc = cond;
    const belowMins = (c) => (c.ceiling != null && c.ceiling < opts.minCeiling) || (c.vis != null && c.vis < opts.minVis);
    if (role === 'destination') {
      if (belowMins(fc)) add('nogo', 'Ceiling/Vis', `${id}: forecast below approach minimums at ETA`, `${station.judgedFrom} for ${fmtZ(win[0])}-${fmtZ(win[1])} shows ceiling ${fc.ceiling ?? 'none'} ft / visibility ${fc.vis ?? '?'} SM, below the planning minimums of ${opts.minCeiling} ft / ${opts.minVis} SM.${opts.rules === '135' ? ' 14 CFR 135.219 prohibits departing for a destination forecast below authorized IFR landing minimums at ETA.' : ' Part 91 does not prohibit the departure, but there is no reasonable expectation of landing.'}`, id);
      else if (worst && belowMins(worst)) add('caution', 'Ceiling/Vis', `${id}: TEMPO/PROB conditions below minimums`, `Temporary groups in the ETA window drop to ceiling ${worst.ceiling ?? 'none'} ft / ${worst.vis ?? '?'} SM. Carry extra fuel for holding and a solid alternate.`, id);
      // Alternate required?  Part 91: 91.169 (1-2-3).  Part 135: 135.223(b).
      const c = fc;
      let altTest;
      const rec = mins[id];
      const manualDest = opts.destCircNa || opts.destCircHaa != null || opts.destHat != null || opts.destVisMin != null;
      const auto = opts.rules === '135' && !manualDest ? minimums.destinationTest(rec, { cat: opts.approachCat, runway: rw && rw.id, skip: approachSkip(ns) }) : null;
      if (opts.rules === '135' && auto) {
        altTest = { rule: '135.223(b)', ceilNeed: auto.ceilNeed, visNeed: auto.visNeed, basis: auto.basis, visBasis: auto.visBasis, auto: true, source: auto.source, cat: opts.approachCat, approach: auto.approach, circling: auto.circling, chart: rec.chartBase + (auto.circling || auto.approach).pdf };
      } else if (opts.rules === '135') {
        const circ = opts.destCircHaa != null ? opts.destCircHaa : 600, hat = opts.destHat != null ? opts.destHat : 200, vmin = opts.destVisMin != null ? opts.destVisMin : 0.5;
        const ceilNeed = opts.destCircNa ? Math.max(hat + 1500, 2000) : circ + 1500;
        const visNeed = Math.max(3, vmin + 2);
        altTest = { rule: '135.223(b)', ceilNeed, visNeed, estimate: !manualDest, manual: manualDest, basis: opts.destCircNa ? `circling not authorized: 1,500 ft above the lowest published minimum (HAT ${hat} ft) or 2,000 ft above the airport, whichever is higher` : `1,500 ft above the lowest circling MDA (HAA ${circ} ft${manualDest ? ' entered' : ', a generic estimate'})`, visBasis: `3 SM, or 2 SM more than the lowest visibility minimum (${vmin} SM), whichever is greater` };
      } else altTest = { rule: '91.169(b)', ceilNeed: 2000, visNeed: 3, basis: '2,000 ft', visBasis: '3 SM' };
      const fails = (w) => w && ((w.ceiling != null && w.ceiling < altTest.ceilNeed) || (w.vis != null && w.vis < altTest.visNeed));
      altTest.prevailing = { ceiling: c.ceiling, vis: c.vis, ok: !fails(c) };
      altTest.worst = worst ? { ceiling: worst.ceiling, vis: worst.vis, ok: !fails(worst) } : null;
      station.alternateRequired = !!(fails(c) || fails(worst));
      altTest.required = station.alternateRequired;
      station.altTest = altTest;
      const wxTxt = `Forecast for ${fmtZ(win[0])}-${fmtZ(win[1])}: ${c.ceiling != null ? `ceiling ${c.ceiling} ft` : 'no ceiling'}, visibility ${c.vis ?? '?'} SM${worst && (worst.ceiling !== c.ceiling || worst.vis !== c.vis) ? ` (TEMPO/PROB down to ${worst.ceiling != null ? worst.ceiling + ' ft' : 'no ceiling'} / ${worst.vis ?? '?'} SM)` : ''}.`;
      const needTxt = `${altTest.rule} needs a ceiling of at least ${altTest.ceilNeed.toLocaleString('en-US')} ft (${altTest.basis}) and visibility of at least ${altTest.visNeed} SM (${altTest.visBasis}) from 1 hour before to 1 hour after ETA.`;
      if (station.alternateRequired && !opts.alternate) add('nogo', 'Alternate', `${id}: alternate required (${altTest.rule}) but none filed`, `${wxTxt} ${needTxt} Add an alternate${opts.rules === '135' ? ', and carry fuel to the destination, then the alternate, then 45 minutes at normal cruise (135.223(a))' : ''}.`, id);
      else if (station.alternateRequired) add('info', 'Alternate', `${id}: alternate required (${altTest.rule})`, `${wxTxt} ${needTxt} You have filed ${opts.alternate}${opts.rules === '135' ? '; fuel must cover destination, alternate and 45 minutes at normal cruise (135.223(a))' : ''}.`, id);
      else add('ok', 'Alternate', `${id}: no alternate required (${altTest.rule})`, `${wxTxt} ${needTxt}${altTest.estimate ? ' No published minimums were found for this airport, so the circling HAA is a 600 ft estimate; enter the chart value for an exact test.' : ''}`, id);
      if (altTest.auto) add('info', 'Alternate', `${id}: minimums read from the FAA charts (${altTest.source})`, `Category ${opts.approachCat}. Lowest circling: ${altTest.circling ? procTxt(altTest.circling) : 'none published'}. Approach used for visibility: ${procTxt(altTest.approach)}. Read automatically from the published charts; check them against the current chart and NOTAMs before relying on them.`, id);
      else if (altTest.estimate) add('caution', 'Alternate', `${id}: approach minimums not found, using an estimate`, `No FAA chart minimums are on file for ${id}, so the 135.223(b) test uses a 600 ft circling HAA and ½ SM. Enter the chart values in the Part 135 section.`, id);
      if (fc.flags && fc.flags.freezingPrecip) add('nogo', 'Icing', `${id}: freezing precipitation forecast at ETA`, `Freezing rain/drizzle is outside the XLS+ ice protection certification (Appendix C) and contaminates the runway. Delay or divert.`, id);
      if (worst && worst.flags && worst.flags.freezingPrecip && !(fc.flags && fc.flags.freezingPrecip)) add('caution', 'Icing', `${id}: freezing precipitation possible (TEMPO/PROB)`, `Have a non-freezing alternate and fuel to reach it.`, id);
    }
    if (role === 'departure') {
      if (fc.flags && fc.flags.freezingPrecip) add('nogo', 'Icing', `${id}: freezing precipitation at departure`, `Takeoff in freezing rain/drizzle is generally beyond holdover-time guidance and the airframe's certification. Delay.`, id);
      if (belowMins(fc)) add(opts.rules === '135' ? 'caution' : 'caution', 'Ceiling/Vis', `${id}: departure below landing minimums`, `Ceiling ${fc.ceiling ?? 'none'} ft / ${fc.vis ?? '?'} SM. ${opts.rules === '135' ? '135.217 requires a takeoff alternate within one hour flying time.' : 'Plan a takeoff alternate within about one hour in case of an engine or system return.'} Confirm takeoff minimums for the departure runway.`, id);
      if (cur && cur.temp != null && cur.temp <= 5 && Object.keys(cur.flags).some((k) => ['snow', 'freezingPrecip', 'icePellets'].includes(k))) add('caution', 'Icing', `${id}: frozen precipitation at departure`, `Ground de-icing/anti-icing likely required; check holdover times and runway condition codes (RwyCC).`, id);
    }
    if (role === 'alternate') {
      // Alternate weather minimums. Part 135: 135.221(b) -> OpSpec C055 (standard derived minimums);
      // Part 91: 91.169(c) standard 600-2 (precision) / 800-2 (non-precision).
      const fcA = fc;
      let am;
      const rec = mins[id];
      const manualAlt = opts.altHat != null || opts.altVisMin != null;
      const pub = rec ? minimums.publishedAlternate(rec.alternateMinimums, opts.approachCat) : null;
      const auto = opts.rules === '135' && opts.altNavFacilities !== 'std' && !manualAlt ? minimums.alternateMinimums(rec, { cat: opts.approachCat, runway: rw && rw.id, gps: opts.altGps, facilities: opts.altNavFacilities === 'auto' ? null : opts.altNavFacilities, skip: approachSkip(ns) }) : null;
      if (auto && auto.none) {
        add('nogo', 'Alternate', `${id}: no approach usable for alternate planning`, `${auto.reason} (${auto.source})`, id);
        am = { rule: 'OpSpec C055 (135.221)', ceil: 99999, vis: 99, basis: auto.reason, none: true, source: auto.source };
      } else if (auto) {
        am = { rule: 'OpSpec C055 (135.221)', ceil: auto.ceil, vis: auto.vis, basis: auto.basis, auto: true, facilities: auto.facilities, source: auto.source, cat: opts.approachCat, approach: auto.approach, chart: rec.chartBase + auto.approach.pdf };
      } else if (opts.rules === '135' && opts.altNavFacilities !== 'std') {
        const two = opts.altNavFacilities === 2, hat = opts.altHat != null ? opts.altHat : 200, vmin = opts.altVisMin != null ? opts.altVisMin : 0.5;
        const add1 = two ? [200, 0.5] : [400, 1];
        const tag = manualAlt ? 'entered' : 'a generic estimate';
        am = { rule: 'OpSpec C055 (135.221)', ceil: hat + add1[0], vis: vmin + add1[1], estimate: !manualAlt, manual: manualAlt, basis: two ? `two operational navigation facilities to different suitable runways: +200 ft and +½ SM to the higher of the two approaches (HAT ${hat} ft, ${vmin} SM ${tag})` : `one operational navigation facility: +400 ft to the HAT/HAA and +1 SM to the landing visibility (HAT ${hat} ft, ${vmin} SM ${tag})` };
      } else {
        am = { rule: opts.rules === '135' ? '135.221 / 91.169(c)' : '91.169(c)', ceil: 600, vis: 2, ceilNp: 800, basis: '600-2 with a precision approach, 800-2 non-precision' };
        if (pub && pub.nonstandard) { am.ceil = Math.max(am.ceil, pub.nonstandard.ceil); am.ceilNp = Math.max(am.ceilNp, pub.nonstandard.ceil); am.vis = Math.max(am.vis, pub.nonstandard.vis); am.basis += `; raised to the FAA nonstandard alternate minimums published here for Cat ${opts.approachCat} (${pub.nonstandard.ceil}-${pub.nonstandard.vis}), which may apply to only some of the approaches`; am.source = `FAA d-TPP cycle ${rec.cycle}`; }
      }
      if (pub) am.published = pub.text;
      if (pub && pub.na) add('caution', 'Alternate', `${id}: FAA alternate minimums entry contains "NA"`, `Some approaches at ${id} are not authorized for alternate use, or only under conditions. FAA entry: ${pub.text}`, id);
      else if (pub && pub.nonstandard) add('info', 'Alternate', `${id}: FAA publishes nonstandard alternate minimums`, `${opts.rules === '135' && am.auto ? 'These replace 600-2/800-2 for operators without derived minimums; your C055 figures above are derived from the approach minimums instead. ' : ''}FAA entry: ${pub.text}`, id);
      if (am.auto) add('info', 'Alternate', `${id}: alternate minimums derived from the FAA charts (${am.source})`, `Category ${opts.approachCat}, ${am.basis}. ${opts.altGps ? 'GPS approaches are included (LNAV or circling lines only).' : 'GPS approaches are not used; turn that on in the Part 135 section if your OpSpec allows it.'} Read automatically from the published charts; check them against the current chart, NOTAMs and your own C055.`, id);
      else if (am.estimate) add('caution', 'Alternate', `${id}: approach minimums not found, using an estimate`, `No FAA chart minimums are on file for ${id}, so the alternate minimums assume a 200 ft / ½ SM approach. Enter the chart values in the Part 135 section.`, id);
      const okA = (w, ce) => (w.ceiling == null || w.ceiling >= ce) && (w.vis == null || w.vis >= am.vis);
      station.altMins = { ...am, forecast: { ceiling: fcA.ceiling, vis: fcA.vis }, ok: okA(fcA, am.ceil) };
      const fTxt = `Forecast at the alternate ETA: ${fcA.ceiling != null ? `ceiling ${fcA.ceiling} ft` : 'no ceiling'} / ${fcA.vis ?? '?'} SM.`;
      if (!am.none && !okA(fcA, am.ceil)) add('nogo', 'Alternate', `${id}: below alternate minimums (${am.rule})`, `${fTxt} Required ${am.ceil} ft / ${am.vis} SM (${am.basis}). It cannot be listed as an alternate; choose another.`, id);
      else if (am.none) { /* reported above */ }
      else if (am.ceilNp && !okA(fcA, am.ceilNp)) add('caution', 'Alternate', `${id}: meets alternate minimums only with a precision approach`, `${fTxt} Meets 600-2 but not 800-2. Verify the alternate has an operating precision approach and no "NA" alternate note.`, id);
      else add('ok', 'Alternate', `${id}: meets alternate minimums (${am.rule})`, `${fTxt} Required ${am.ceil} ft / ${am.vis} SM (${am.basis}).${opts.rules === '135' ? ' Confirm against your own OpSpec C055 and the alternate\'s approach notes.' : ''}`, id);
      if (!am.none && worst && !okA(worst, am.ceil)) add('caution', 'Alternate', `${id}: TEMPO/PROB below alternate minimums`, `Temporary conditions drop to ${worst.ceiling ?? 'none'} ft / ${worst.vis ?? '?'} SM. Many operators do not accept an alternate whose TEMPO is below minimums; check your SOPs.`, id);
    }
    // Weather flags common to all
    const flagsAll = Object.assign({}, cur ? cur.flags : {}, worst ? worst.flags : {});
    if (flagsAll.thunder) add(role === 'alternate' ? 'caution' : (fc.flags && fc.flags.thunder ? 'nogo' : 'caution'), 'Convection', `${id}: thunderstorms ${fc.flags && fc.flags.thunder ? 'in the prevailing forecast' : 'possible'} near ${fmtZ(tMs)}`, fc.flags && fc.flags.thunder ? 'Thunderstorms forecast as prevailing conditions in the arrival/departure window. Do not plan to take off or land with a thunderstorm on or near the field: wind shear, microbursts, hail and heavy rain. Change the time or the airport.' : 'TEMPO/PROB or current thunderstorm activity. Plan extra fuel, a convection-free alternate, and use radar to stay 20 nm from strong cells.', id);
    if (flagsAll.severeTs || flagsAll.funnel) add('nogo', 'Convection', `${id}: severe convective weather`, `Hail, heavy thunderstorm or funnel cloud reported/forecast.`, id);
    if (flagsAll.ash) add('nogo', 'Volcanic ash', `${id}: volcanic ash`, 'Do not operate in volcanic ash.', id);
    if (cur && cur.temp != null && station.elev != null && cur.temp >= 30 && station.elev * 3.28 > 4000) add('caution', 'Performance', `${id}: hot/high`, `Temperature ${cur.temp}°C at ${Math.round(station.elev * 3.28)} ft elevation. Check WAT limits and climb gradient.`, id);
    stations.push(station);
    return station;
  };
  analyzeStation(dep.id, 'departure', opts.etd);
  analyzeStation(dest.id, 'destination', etaMs);
  if (opts.alternate) {
    const altAp = aptInfo[opts.alternate];
    const altDist = altAp ? geo.distNm(dest, altAp) : null;
    analyzeStation(opts.alternate, 'alternate', etaMs + ((altDist || 100) / 330) * 3600e3);
  }

  // ---- en-route hazards
  const hazards = [];
  const nowMs = Date.now();
  const alt = opts.cruiseAlt;

  for (const s of sigmets || []) {
    const poly = toPoly(s.coords);
    if (poly.length < 3) continue;
    const from = s.validTimeFrom * 1000, to = s.validTimeTo * 1000;
    const conv = /CONVECTIVE/i.test(s.hazard);
    const base = s.altitudeLow1 || 0, top = s.altitudeHi1 || (conv ? 45000 : 60000);
    const move = s.movementSpd ? (t) => shiftPoly(poly, s.movementDir, s.movementSpd, Math.max(0, Math.min(3, (t - nowMs) / 3600e3))) : null;
    const hit = routeHits(S, poly, { base: conv ? 0 : base, top: conv ? 99999 : top, bufferNm: conv ? 20 : 0, tFrom: from, tTo: to + (conv ? 2 * 3600e3 : 0), moveFn: move });
    if (!hit) continue;
    const label = `${s.airSigmetType || 'SIGMET'} ${s.seriesId || ''} ${s.hazard}`.trim();
    const hz = { kind: 'SIGMET', label, hazard: s.hazard, severity: s.severity, raw: s.rawAirSigmet, coords: poly, base, top, alongNm: Math.round(hit.smp.s), at: new Date(hit.smp.t).toISOString(), distNm: Math.round(hit.d) };
    hazards.push(hz);
    const where = `${Math.round(hit.smp.s)} nm from ${dep.id} (${hit.smp.phase}, ~${altTxt(hit.smp.alt)}) at ~${fmtZ(hit.smp.t)}`;
    if (conv) {
      const tops = top || 0;
      const nearTerminal = hit.smp.s < prof.climbNm || hit.smp.s > prof.totalNm - prof.descNm;
      if (nearTerminal) add('nogo', 'Convection', `Convective SIGMET ${s.seriesId} affects the ${hit.smp.s < prof.climbNm ? 'departure climb' : 'arrival/descent'}`, `Area of thunderstorms (tops ${tops ? 'FL' + Math.round(tops / 100) : 'unknown'}) within 20 nm of the route at ${where}. You cannot top these on climb/descent. Delay, or re-route the terminal portion around the area.`, label);
      else if (tops >= alt - 2000) add('caution', 'Convection', `Convective SIGMET ${s.seriesId} on route, tops ${tops ? 'FL' + Math.round(tops / 100) : '?'}`, `Tops are at or above planned FL${Math.round(alt / 100)} at ${where}. Plan a lateral deviation (20 nm from severe cells, upwind side preferred), and confirm the reroute fuel.`, label);
      else add('caution', 'Convection', `Convective SIGMET ${s.seriesId} below cruise`, `Tops FL${Math.round(tops / 100)} are below planned FL${Math.round(alt / 100)} at ${where}. Expect to overfly with at least 1,000 ft per 10 kt of wind (Rule of thumb: 5,000 ft minimum above tops); watch for overshooting tops and turbulence.`, label);
    } else if (/ICE/i.test(s.hazard)) add('nogo', 'Icing', `SIGMET ${s.seriesId}: severe icing ${base ? 'FL' + Math.round(base / 100) : 'SFC'}-FL${Math.round(top / 100)}`, `Route passes through the area at ${where}. Severe icing exceeds certification even with FIKI. Change altitude or route to avoid the layer entirely.`, label);
    else if (/TURB/i.test(s.hazard)) add('nogo', 'Turbulence', `SIGMET ${s.seriesId}: severe turbulence FL${Math.round(base / 100)}-FL${Math.round(top / 100)}`, `Route passes through the area at ${where}. Re-plan altitude/route.`, label);
    else if (/ASH|VA/i.test(s.hazard)) add('nogo', 'Volcanic ash', `SIGMET ${s.seriesId}: volcanic ash`, `On route at ${where}.`, label);
    else add('caution', 'SIGMET', label, `On route at ${where}.`, label);
  }

  for (const s of isigmets || []) {
    const poly = toPoly(s.coords);
    if (poly.length < 3) continue;
    const hit = routeHits(S, poly, { base: s.base || 0, top: s.top || 60000, tFrom: s.validTimeFrom * 1000, tTo: s.validTimeTo * 1000, bufferNm: /TS/.test(s.hazard) ? 20 : 0 });
    if (!hit) continue;
    const label = `Intl SIGMET ${s.firId || ''} ${s.seriesId || ''} ${s.hazard}`;
    hazards.push({ kind: 'ISIGMET', label, hazard: s.hazard, raw: s.rawSigmet, coords: poly, base: s.base, top: s.top, alongNm: Math.round(hit.smp.s), at: new Date(hit.smp.t).toISOString() });
    add(/VA|ICE|TURB/.test(s.hazard) ? 'nogo' : 'caution', s.hazard === 'VA' ? 'Volcanic ash' : 'SIGMET', label, `Intersects the route ${Math.round(hit.smp.s)} nm from ${dep.id} around ${fmtZ(hit.smp.t)}.`, label);
  }

  // G-AIRMETs: use the snapshot closest to the time at each sample
  const gByHazard = new Map();
  for (const g of gairmets || []) {
    const poly = toPoly(g.coords);
    if (poly.length < 3 || g.geometryType === 'LINE') continue;
    const vt = Date.parse(g.validTime);
    let base = ftFromHundreds(g.base), top = ftFromHundreds(g.top);
    if (base === 'FZL') base = 0;
    if (top === 'FZL') top = 18000;
    const hit = routeHits(S, poly, { base: base ?? 0, top: top ?? 60000, tFrom: vt - 90 * 60e3, tTo: vt + 90 * 60e3, slackMs: 0 });
    if (!hit) continue;
    const key = g.hazard + (g.severity || '');
    const prev = gByHazard.get(key);
    if (!prev || hit.d < prev.hit.d) gByHazard.set(key, { g, hit, poly, base, top });
  }
  for (const [, { g, hit, poly, base, top }] of gByHazard) {
    const label = `G-AIRMET ${g.hazard}${g.severity ? ' ' + g.severity : ''}`;
    const band = `${base ? 'FL' + String(Math.round(base / 100)).padStart(3, '0') : 'SFC'}-${top ? 'FL' + String(Math.round(top / 100)).padStart(3, '0') : '?'}`;
    hazards.push({ kind: 'G-AIRMET', label, hazard: g.hazard, coords: poly, base, top, alongNm: Math.round(hit.smp.s), at: new Date(hit.smp.t).toISOString(), validTime: g.validTime });
    const where = `${Math.round(hit.smp.s)} nm from ${dep.id} during ${hit.smp.phase} (~${altTxt(hit.smp.alt)}) near ${fmtZ(hit.smp.t)}`;
    if (g.hazard === 'ICE') add('caution', 'Icing', `${label} ${band} along route`, `Moderate icing forecast ${band}; route intersects it ${where}. The XLS+ is FIKI-approved, so this is manageable: run engine/wing anti-ice per AFM, minimize time in the layer with continuous climbs/descents, and watch for SLD signs (ice aft of protected surfaces) which require immediate exit.`, label);
    else if (/TURB/.test(g.hazard)) add('caution', 'Turbulence', `${label} ${band}`, `Moderate turbulence forecast ${band}; route intersects it ${where}. Brief passengers, keep belts on, consider an altitude change (ask ATC/PIREPs for smoother levels).`, label);
    else if (g.hazard === 'LLWS') add('caution', 'Wind shear', label, `Low-level wind shear forecast below 2,000 ft AGL ${where}.`, label);
    else if (g.hazard === 'SFC_WND') add('caution', 'Wind', label, `Sustained surface winds over 30 kt forecast ${where}.`, label);
    else if (g.hazard === 'IFR' || g.hazard === 'MT_OBSC') add('info', 'IFR', label, `Widespread IFR/obscuration ${where}. Relevant mainly for the terminal areas and any off-airport emergency.`, label);
  }

  for (const c of cwas || []) {
    const poly = toPoly(c.coords);
    if (poly.length < 3) continue;
    const hit = routeHits(S, poly, { base: c.base || 0, top: c.top || 60000, tFrom: c.validTimeFrom * 1000, tTo: c.validTimeTo * 1000, bufferNm: c.hazard === 'TS' ? 20 : 0 });
    if (!hit) continue;
    const label = `CWA ${c.cwsu} ${c.seriesId} ${c.hazard}`;
    hazards.push({ kind: 'CWA', label, hazard: c.hazard, raw: c.rawText, coords: poly, base: c.base, top: c.top, alongNm: Math.round(hit.smp.s), at: new Date(hit.smp.t).toISOString() });
    add('caution', c.hazard === 'TS' ? 'Convection' : 'CWA', `${label}${c.top ? ' tops FL' + Math.round(c.top / 100) : ''}`, `Center Weather Advisory intersects the route ${Math.round(hit.smp.s)} nm from ${dep.id} around ${fmtZ(hit.smp.t)}: ${String(c.rawText || '').split('\n').slice(3).join(' ').trim()}`, label);
  }

  // PIREPs near route and altitude
  const pirepsNear = [];
  for (const p of pireps || []) {
    if (!isFinite(p.lat) || !isFinite(p.lon)) continue;
    const near = geo.distPointToPolylineNm(p, route);
    if (near.d > 60) continue;
    const smp = S.reduce((a, b) => (geo.distNm(b, p) < geo.distNm(a, p) ? b : a));
    const pAlt = (p.fltLvl || 0) * 100;
    const nearTerminalNm = Math.min(geo.distNm(p, route[0]), geo.distNm(p, route[route.length - 1]));
    const relevant = Math.abs(pAlt - smp.alt) <= 4000 || (pAlt <= opts.cruiseAlt + 2000 && (smp.phase !== 'cruise' || nearTerminalNm <= 130));
    const ice = [p.icgInt1, p.icgInt2].filter(Boolean).join('/');
    const turb = [p.tbInt1, p.tbInt2].filter(Boolean).join('/');
    const urgent = /UUA|Urgent/i.test(p.pirepType || '') || /\bUUA\b/.test(p.rawOb || '');
    const entry = { raw: p.rawOb, lat: p.lat, lon: p.lon, alt: pAlt, ac: p.acType, ice, turb, urgent, distNm: Math.round(near.d), alongNm: Math.round(smp.s), relevant, ageMin: Math.round((nowMs - p.obsTime * 1000) / 60e3) };
    pirepsNear.push(entry);
    if (!relevant) continue;
    if (/SEV|EXTM|EXTRM/.test(turb)) add('nogo', 'Turbulence', `PIREP: severe turbulence ${altTxt(pAlt)} near route`, `${p.acType || 'Aircraft'} reported ${turb} turbulence ${entry.ageMin} min ago, ${entry.distNm} nm from the route at ${entry.alongNm} nm. ${p.rawOb}`, p.rawOb);
    else if (/MOD/.test(turb)) add('caution', 'Turbulence', `PIREP: ${turb} turbulence ${altTxt(pAlt)}`, `${p.acType || 'Aircraft'}, ${entry.ageMin} min ago, ${entry.distNm} nm off route at ${entry.alongNm} nm. ${typeNote(p.acType)}${p.rawOb}`, p.rawOb);
    if (/SEV/.test(ice)) add('nogo', 'Icing', `PIREP: severe icing ${altTxt(pAlt)}`, `${p.acType || 'Aircraft'}, ${entry.ageMin} min ago, ${entry.distNm} nm off route. ${p.rawOb}`, p.rawOb);
    else if (/MOD/.test(ice)) add('caution', 'Icing', `PIREP: ${ice} icing ${altTxt(pAlt)}`, `${p.acType || 'Aircraft'}, ${entry.ageMin} min ago, ${entry.distNm} nm off route at ${entry.alongNm} nm (your altitude there ~${Math.round(smp.alt)} ft, ${smp.phase}). ${p.rawOb}`, p.rawOb);
  }
  pirepsNear.sort((a, b) => a.alongNm - b.alongNm);

  // En-route METAR summary
  const enroute = [];
  for (const m of enrouteMetars || []) {
    const near = geo.distPointToPolylineNm(m, route);
    if (near.d > 35 || airports.includes(m.icaoId)) continue;
    const smp = S.reduce((a, b) => (geo.distNm(b, m) < geo.distNm(a, m) ? b : a));
    enroute.push({ id: m.icaoId, raw: m.rawOb, cat: m.fltCat || dec.flightCategory(dec.ceilingOf(m.clouds), dec.parseVis(m.visib)), alongNm: Math.round(smp.s), lat: m.lat, lon: m.lon, flags: dec.wxFlags(m.wxString), temp: m.temp });
  }
  enroute.sort((a, b) => a.alongNm - b.alongNm);
  const tsEnroute = enroute.filter((m) => m.flags.thunder);
  if (tsEnroute.length) add('caution', 'Convection', `Thunderstorms observed at ${tsEnroute.length} station(s) near route`, tsEnroute.slice(0, 6).map((m) => `${m.id} (${m.alongNm} nm): ${m.raw}`).join(' | '), 'METAR');

  // Winds / range
  let avgComp = null;
  if (winds.length) {
    const comps = winds.map((w) => w.component).filter((x) => x != null);
    avgComp = comps.length ? Math.round(comps.reduce((a, b) => a + b, 0) / comps.length) : null;
    const maxW = winds.reduce((a, b) => ((b.spd || 0) > (a.spd || 0) ? b : a));
    if (maxW.spd >= 120) add('caution', 'Turbulence', `Jet stream core ${maxW.spd} kt near cruise level`, `GFS shows ${maxW.dir}°/${maxW.spd} kt at ${maxW.levelHpa} hPa near ${maxW.alongNm} nm. Strong jets carry clear-air turbulence risk, especially on the cold (poleward) side and where the jet curves; check the GTG and PIREPs.`, 'winds');
    const shear = winds.filter((w) => w.shear300 != null && w.shear300 >= 40);
    if (shear.length) add('caution', 'Turbulence', `Vertical wind shear near cruise`, `Wind speed changes by ${shear[0].shear300} kt between FL${Math.round(opts.cruiseAlt / 100)} and 300 hPa (~FL300) near ${shear[0].alongNm} nm, a CAT indicator.`, 'winds');
    const warm = winds.filter((w) => w.isaDev != null && w.isaDev >= 15);
    if (warm.length && opts.cruiseAlt >= 41000) add('info', 'Performance', `Warm upper air (ISA+${warm[0].isaDev})`, `High ISA deviation reduces climb performance and may limit the initial cruise altitude to below FL${Math.round(opts.cruiseAlt / 100)} at heavy weights.`, 'winds');
  }
  const gsCruise = opts.tas + (avgComp || 0);
  const altLeg = opts.alternate && aptInfo[opts.alternate] ? geo.distNm(dest, aptInfo[opts.alternate]) : 0;
  const esadNm = Math.round((prof.totalNm + altLeg) * (opts.tas / Math.max(200, gsCruise)));
  const rangeCheck = { routeNm: Math.round(prof.totalNm), alternateLegNm: Math.round(altLeg), avgWindComponentKt: avgComp, equivalentStillAirNm: esadNm, stillAirRangeNm: CE56X.stillAirRangeNm };
  if (esadNm > CE56X.stillAirRangeNm) add('nogo', 'Fuel/Range', `Equivalent still-air distance ${esadNm} nm exceeds range`, `Route ${Math.round(prof.totalNm)} nm + alternate ${Math.round(altLeg)} nm with an average ${avgComp ?? 0} kt wind component gives ${esadNm} ESAD nm, beyond the ~${CE56X.stillAirRangeNm} nm NBAA-IFR range. Plan a fuel stop.`, 'range');
  else if (esadNm > CE56X.stillAirRangeNm * 0.85) add('caution', 'Fuel/Range', `Range is tight (${esadNm} ESAD nm)`, `Within 15% of the XLS+'s ~${CE56X.stillAirRangeNm} nm NBAA range. Run a full fuel plan with payload, alternate and 45-minute reserve, and add holding fuel for any forecast delays.`, 'range');

  // ---- surface analysis interpretation
  let surface = { available: false };
  if (codsus) {
    const ref = new Date();
    const sections = [...fronts.parseCoded(codsus, ref), ...(codsrp ? fronts.parseCoded(codsrp, ref) : [])];
    surface = fronts.interpretRoute(sections, S, { corridorNm: 400 });
    if (surface.available) {
      const c = collins.analyze(surface, { S, dep, dest, prof, stations, opts, upper, regional: regionalMetars || enrouteMetars || [] });
      surface.method = 'Richard L. Collins, Flying the Weather Map';
      surface.narrative = c.paras;
      surface.collins = c.summary;
      for (const f of c.factors) add(f.level, f.category, f.title, f.detail, f.where);
    }
    for (const f of surface.fronts || []) {
      if (!f.crossesRoute) continue;
      const when = f.encounter.time ? fmtZ(Date.parse(f.encounter.time)) : '?';
      const smp = S.reduce((a, b) => (Math.abs(b.s - f.encounter.alongRouteNm) < Math.abs(a.s - f.encounter.alongRouteNm) ? b : a));
      const terminal = smp.phase !== 'cruise';
      const lvl = (f.type === 'COLD' || f.type === 'OCFNT' || f.type === 'SQLN') && terminal ? 'caution' : f.type === 'TROF' ? 'info' : 'caution';
      add(lvl, 'Surface analysis', `${cap(f.name)} crosses the route at ~${f.encounter.alongRouteNm} nm (${smp.phase}) around ${when}`, `${f.motion ? `Moving toward the ${f.motion.towardCompass} at about ${f.motion.speedKt} kt. ` : 'Movement not resolved from the progs. '}${terminal ? 'The crossing happens while climbing/descending, when you are lowest and least able to top frontal weather.' : `Crossing occurs at cruise (FL${Math.round(smp.alt / 100)}), above most frontal stratus but not above embedded convection.`}`, 'surface');
    }
    for (const f of surface.fronts || []) {
      if (f.destPassage) add('caution', 'Surface analysis', `${cap(f.name)} reaches ${dest.id} around ${fmtZ(Date.parse(f.destPassage))}`, `Frontal passage at the destination ${Date.parse(f.destPassage) < etaMs ? 'before' : 'after'} ETA ${fmtZ(etaMs)}. ${Math.abs(Date.parse(f.destPassage) - etaMs) < 2 * 3600e3 ? 'Within two hours of arrival: expect a wind shift, gusts and possibly convection or low ceilings during the approach. Compare TAF timing with the front motion.' : ''}`, dest.id);
      if (f.depPassage) add('info', 'Surface analysis', `${cap(f.name)} near ${dep.id} around ${fmtZ(Date.parse(f.depPassage))}`, `Expect the wind shift and frontal weather at the departure field around then (ETD ${fmtZ(opts.etd)}).`, dep.id);
    }
  }

  // ---- NWP model guidance (HRRR / NBM / GFS / ECMWF) at the terminals
  const nwpStations = stations.map((st) => {
    const a = aptInfo[st.id] || (st.id === dep.id ? dep : st.id === dest.id ? dest : null);
    if (!a || !isFinite(a.lat)) return null;
    return { id: st.id, role: st.role, lat: a.lat, lon: a.lon, from: Date.parse(st.window[0]), to: Date.parse(st.window[1]), tafCategory: st.judgedFrom === 'TAF' && st.judged ? st.judged.category : null, tafFlags: st.forecast && st.forecast.worst ? st.forecast.worst.flags : null };
  }).filter(Boolean);
  const nwpRaw = nwpStations.length ? await wx.safe('Model guidance (HRRR/NBM/GFS/ECMWF)', () => wx.nwpPoints(nwpStations), errors) : null;
  const models = { available: !!nwpRaw, source: 'NOAA HRRR, NBM and GFS and ECMWF IFS, decoded from GRIB2 by Open-Meteo', stations: nwp.analyze(nwpRaw, nwpStations, add) };
  const ice = nwp.icingLayers(upper);
  models.icingLayers = ice;
  if (ice.length) {
    const near = ice.filter((x) => x.alongNm <= prof.climbNm + 60 || x.alongNm >= prof.totalNm - prof.descNm - 60);
    if (near.length && !hazards.some((h) => h.kind === 'G-AIRMET' && h.hazard === 'ICE')) add('caution', 'Icing', 'GFS shows an icing-potential layer in the climb or descent', `Saturated air (RH ≥ 85%) at 0 to -18°C: ${near.slice(0, 4).map((x) => `~${x.ft.toLocaleString('en-US')} ft at ${x.alongNm} nm (${x.T}°C, ${x.RH}%)`).join('; ')}. No G-AIRMET covers it, but the model says the cloud there is in the icing temperature range. Plan anti-ice use and a continuous climb/descent through it.`, 'models');
  }

  // ---- route and altitude options based on the weather
  const hzInputs = { sigmets, isigmets, gairmets, cwas, pireps, tsMetars: tsEnroute };
  const navaidsAll = await wx.allNavaids().catch(() => null);
  const routeOpts = routing.routeOptions({ route, opts, buildProfile, hazards: hzInputs, navaids: navaidsAll, windComp });
  const altOpts = routing.altitudeOptions({ route, opts, buildProfile, hazards: hzInputs, windAt });
  if (!routeOpts.recommendation.keepFiled) add('info', 'Routing', `Weather re-route option: ${routeOpts.recommendation.best.name}`, routeOpts.recommendation.text, 'routing');
  if (altOpts.best !== Math.round(opts.cruiseAlt / 1000) * 10 && !/as good as any/.test(altOpts.text)) add('info', 'Routing', `Altitude option: FL${altOpts.best}`, altOpts.text, 'routing');

  // NOTAMs
  const notamAirports = airports.map((id) => { const a = aptInfo[id]; const st = stations.find((x) => x.id === id); return { id, ids: a ? [a.icaoId, a.faaId, ...(a.aliases || [])].filter(Boolean) : [], name: a ? a.name : id, lat: a ? a.lat : null, lon: a ? a.lon : null, runways: a ? a.runways : [], role: st ? st.role : 'en route', window: st ? st.window : null }; }).filter((a) => stations.some((x) => x.id === a.id));
  const notamInfo = pastedNotams
    ? { available: true, source: 'briefing', total: pastedNotams.length, airports: notamAirports, byAirport: Object.fromEntries(notamAirports.map((a) => [a.id, (notamsBy[a.id] || []).map((n) => ({ number: n.number, text: n.summary || n.raw, subject: n.subject, start: n.start, end: n.end, perm: n.perm, items: n.items, nav: n.nav || null, active: a.window ? notam.activeIn(n, Date.parse(a.window[0]), Date.parse(a.window[1])) : true }))])) }
    : notams
      ? { available: true, source: 'faa', airports: notamAirports, byAirport: Object.fromEntries(Object.entries(notams).map(([id, list]) => [id, list.map((x) => { const pn = notam.parseOne(`${id} 0/000 ${id} ${x.text}`); return { number: x.number, text: x.text, subject: pn.subject, start: Date.parse(x.start) || null, end: Date.parse(x.end) || null, items: pn.items, nav: pn.nav || null, active: true }; })])) }
      : { available: false, airports: notamAirports, note: 'Upload your ForeFlight briefing PDF or paste NOTAM text in the form to check closures and draw the closure diagram.', links: airports.map((id) => ({ id, url: `https://notams.aim.faa.gov/notamSearch/nsapp.html#/results?designators=${id}` })) };
  if (!pastedNotams && notams) {
    for (const [id, list] of Object.entries(notams)) {
      const closed = list.filter((n) => /\bRWY\b.*\bCLSD\b|\bAD AP CLSD\b/.test(n.text || ''));
      if (closed.length) add('caution', 'NOTAM', `${id}: ${closed.length} closure NOTAM(s)`, closed.slice(0, 4).map((n) => n.text).join(' | '), id);
      const ils = list.filter((n) => /\b(ILS|LOC|GP|GS)\b.*\b(U\/S|OTS)\b/.test(n.text || ''));
      if (ils.length) add('caution', 'NOTAM', `${id}: approach aid out of service`, ils.slice(0, 4).map((n) => n.text).join(' | '), id);
    }
  }

  // Data age (snapshot mode on the free Firebase plan)
  let dataAsOf = null;
  const meta = await wx.snapMeta().catch(() => null);
  if (meta) {
    dataAsOf = meta.generatedAt;
    const ageMin = Math.round((Date.now() - Date.parse(meta.generatedAt)) / 60e3);
    if (ageMin > 45) add('nogo', 'Data', `Weather data is ${ageMin} minutes old`, `The refresh job last ran at ${fmtZ(Date.parse(meta.generatedAt))}. Observations, PIREPs and advisories may have changed. Check that the GitHub refresh job is running, or get current weather from another source before relying on this.`, 'data');
    else if (ageMin > 20) add('caution', 'Data', `Weather data is ${ageMin} minutes old`, `Last refresh ${fmtZ(Date.parse(meta.generatedAt))}. Newer METARs, PIREPs or advisories may exist.`, 'data');
  }

  const decision = decide(factors, errors, { dep, dest, opts, etaMs });
  const missingCritical = errors.filter((e) => /METAR|TAF|SIGMET|G-AIRMET/.test(e.source));
  return {
    generatedAt: new Date().toISOString(),
    dataAsOf,
    disclaimer: 'Advisory only. This is not an official FAA/NWS weather briefing and does not satisfy 14 CFR 91.103. Obtain a standard briefing (1800wxbrief.com / Leidos or an approved provider) and comply with the AFM and your operator\'s OpSpecs/SOPs. The pilot in command is the final authority.',
    aircraft: { ...CE56X },
    plan: { name: plan.name, source: plan.source, route: route.map((w) => ({ id: w.id, type: w.type, lat: w.lat, lon: w.lon })), dep: dep.id, dest: dest.id, alternate: opts.alternate, cruiseAlt: opts.cruiseAlt, tas: opts.tas, etd: new Date(opts.etd).toISOString(), eta: new Date(etaMs).toISOString(), eteMin, distanceNm: Math.round(prof.totalNm), rules: opts.rules, limits: { maxXwind: opts.maxXwind, maxTailwind: opts.maxTailwindKt, minCeiling: opts.minCeiling, minVis: opts.minVis, minRunwayFt: opts.minRunwayFt } },
    profile: S.filter((_, i) => i % 3 === 0 || i === S.length - 1).map((s) => ({ lat: s.lat, lon: s.lon, s: Math.round(s.s), t: new Date(s.t).toISOString(), alt: Math.round(s.alt), phase: s.phase })),
    decision,
    factors: sortFactors(factors),
    stations,
    hazards,
    pireps: pirepsNear,
    enroute,
    winds,
    windsSource: wa ? wa.source : null,
    range: rangeCheck,
    surface,
    models,
    routing: { route: routeOpts, altitude: altOpts },
    charts: wx.wpc.charts(),
    notams: notamInfo,
    sources: sourceList(errors),
    errors,
    dataGaps: missingCritical.length > 0,
  };
}

// Turbulence felt depends on aircraft size relative to the XLS+ (~20,000 lb).
function typeNote(ac) {
  const t = String(ac || '').toUpperCase();
  if (/^(A3[0-9]|A2[0-9]|B7[0-9]|B3[0-9]|A21|A20|B38|B39|B73|B75|B76|B77|B78|MD|E19|E29|BCS|A22)/.test(t)) return 'Reported by a much heavier airliner, so expect it to feel stronger in the XLS+. ';
  if (/^(C1[0-9]{2}|C2[0-9]{2}|PA|P46|SR2|BE[0-9]|M20|DA4|C82|PC12|TBM|C25A|C25B|C510|E50|E55P|SF50)/.test(t)) return 'Reported by a lighter aircraft, so it may feel somewhat lighter in the XLS+. ';
  return '';
}
function altTxt(a) { return !a ? 'altitude unknown' : a >= 18000 ? 'FL' + Math.round(a / 100) : a.toLocaleString('en-US') + ' ft'; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
const LEVEL_ORDER = { nogo: 0, caution: 1, info: 2, ok: 3 };
function sortFactors(f) { return f.slice().sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]); }

function decide(factors, errors, { dep, dest, opts, etaMs }) {
  const nogo = factors.filter((f) => f.level === 'nogo');
  const caution = factors.filter((f) => f.level === 'caution');
  const critGaps = errors.filter((e) => /^(METAR|TAF|SIGMETs \(domestic\)|G-AIRMETs)$/.test(e.source));
  let verdict, headline;
  if (nogo.length) {
    verdict = 'NO-GO';
    headline = `NO-GO as planned: ${nogo.length} limiting factor${nogo.length > 1 ? 's' : ''}. ${nogo[0].title}.`;
  } else if (critGaps.length) {
    verdict = 'INCOMPLETE';
    headline = `Cannot complete the assessment: ${critGaps.map((e) => e.source).join(', ')} unavailable. Do not rely on this result.`;
  } else if (caution.length >= 4 || caution.some((c) => ['Convection', 'Icing', 'Data', 'Crosswind', 'Ceiling/Vis', 'Alternate', 'Tailwind', 'Fuel/Range'].includes(c.category))) {
    verdict = 'GO WITH CAUTION';
    headline = `Go with caution: no hard limits exceeded, but ${caution.length} hazard${caution.length > 1 ? 's' : ''} need a plan.`;
  } else if (caution.length) {
    verdict = 'GO';
    headline = `GO: conditions are within the XLS+ and ${opts.rules === '135' ? 'Part 135' : 'Part 91'} planning limits, with ${caution.length} item${caution.length > 1 ? 's' : ''} to brief.`;
  } else {
    verdict = 'GO';
    headline = 'GO: no limiting or cautionary weather found along the route or at the terminals.';
  }
  const reasoning = [];
  reasoning.push(`Flight ${dep.id} to ${dest.id}, ETA ${fmtZ(etaMs)}, operating under Part ${opts.rules}.`);
  if (nogo.length) reasoning.push(`Limiting: ${nogo.map((f) => f.title).join('; ')}. Any one of these is enough to stop the flight as planned; each lists what would need to change.`);
  if (caution.length) reasoning.push(`Manageable with a plan: ${caution.map((f) => f.title).join('; ')}.`);
  if (!nogo.length && !caution.length) reasoning.push('Terminal forecasts are above alternate-required thresholds, no SIGMET/G-AIRMET/CWA crosses the route at your altitude, and no significant PIREPs were found.');
  if (errors.length) reasoning.push(`Data gaps: ${errors.map((e) => e.source).join(', ')}. Verify those items through another source.`);
  return { verdict, headline, reasoning, counts: { nogo: nogo.length, caution: caution.length } };
}

function sourceList(errors) {
  const failed = new Set(errors.map((e) => e.source));
  return [
    ['METAR', 'aviationweather.gov Data API'],
    ['TAF', 'aviationweather.gov Data API'],
    ['PIREPs', 'aviationweather.gov Data API'],
    ['SIGMETs (domestic)', 'aviationweather.gov Data API (incl. Convective SIGMETs)'],
    ['SIGMETs (international)', 'aviationweather.gov Data API'],
    ['G-AIRMETs', 'aviationweather.gov Data API'],
    ['CWAs', 'aviationweather.gov Data API (Center Weather Advisories)'],
    ['WPC surface analysis (CODSUS)', 'NWS WPC coded surface fronts (tgftp.nws.noaa.gov)'],
    ['WPC surface progs (CODSRP)', 'NWS WPC 12/24 h coded surface progs'],
    ['Winds aloft (GFS via Open-Meteo)', 'NOAA GFS via Open-Meteo (AWC FB tables were retired in 2026)'],
    ['En-route METARs', 'aviationweather.gov Data API'],
    ['Regional METARs', 'aviationweather.gov Data API (for Collins-method contrast, moisture and upstream checks)'],
    ['Model guidance (HRRR/NBM/GFS/ECMWF)', 'NOAA HRRR/NBM/GFS and ECMWF IFS point forecasts, decoded from GRIB2 by Open-Meteo'],
    ['Approach minimums (FAA d-TPP)', 'FAA digital Terminal Procedures: landing minimums and Alternate Minimums pages, rebuilt each 28-day chart cycle'],
    ['NOTAMs (FAA API)', 'FAA NOTAM API (optional credentials)'],
  ].map(([name, desc]) => ({ name, desc, ok: !failed.has(name) }));
}

module.exports = { buildBriefing, bestRunway, buildProfile, resolveRoute };
