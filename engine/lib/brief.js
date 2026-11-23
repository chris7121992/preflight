'use strict';
// Builds the full briefing: resolves the route, pulls live data, runs the hazard screens and
// the go/no-go logic for the Citation XLS+, and writes the surface analysis narrative.
const geo = require('./geo');
const wx = require('./wx');
const fronts = require('./fronts');
const dec = require('./decode');
const { CE56X } = require('./aircraft');

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
    for (const a of ap || []) for (const k of [a.icaoId, a.faaId, a.iataId]) if (k) found.set(k, { lat: a.lat, lon: a.lon, type: 'AIRPORT' });
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
  };
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
  const [metars, tafs, apts, pireps, sigmets, isigmets, gairmets, cwas, codsus, codsrp, wa, enrouteMetars, notams] = await Promise.all([
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

  // ---- factors
  const factors = [];
  const add = (level, category, title, detail, where) => factors.push({ level, category, title, detail, where: where || null });
  // level: 'nogo' | 'caution' | 'info' | 'ok'

  const byId = (arr, id) => (arr || []).find((x) => x.icaoId === id || x.faaId === id || x.iataId === id);
  const aptInfo = {};
  for (const id of airports) aptInfo[id] = byId(apts, id) || null;

  // Station analysis (departure at ETD, destination & alternate at ETA)
  const stations = [];
  const analyzeStation = (id, role, tMs) => {
    const metarList = (metars || []).filter((m) => m.icaoId === id).sort((a, b) => b.obsTime - a.obsTime);
    const metar = metarList[0] || null;
    const taf = (tafs || []).filter((t) => t.icaoId === id).sort((a, b) => b.issueTime > a.issueTime ? 1 : -1)[0] || null;
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
    const station = { id, role, name: (apt && apt.name) || (metar && metar.name) || id, timeOfInterest: new Date(tMs).toISOString(), window: win.map((x) => new Date(x).toISOString()), metar: cur, taf: taf ? taf.rawTAF : null, tafPeriods: periods, forecast: taf ? { prevailing: worstPrev, worst: worstAll } : null, runway: null, elev: apt ? apt.elev : metar ? metar.elev : null };

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
    const rw = bestRunway(apt, windSrc, opts);
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
      // Alternate required?
      const c = fc;
      const altReq = opts.rules === '135' ? (c.ceiling != null && c.ceiling < 2500) || (c.vis != null && c.vis < 3) : (c.ceiling != null && c.ceiling < 2000) || (c.vis != null && c.vis < 3);
      const altReqWorst = worst && (opts.rules === '135' ? (worst.ceiling != null && worst.ceiling < 2500) || (worst.vis != null && worst.vis < 3) : (worst.ceiling != null && worst.ceiling < 2000) || (worst.vis != null && worst.vis < 3));
      station.alternateRequired = !!(altReq || altReqWorst);
      if (station.alternateRequired && !opts.alternate) add('nogo', 'Alternate', `${id}: alternate required but none filed`, opts.rules === '135' ? `Forecast at ETA ±1 h does not meet the 135.223 exemption (approximated here as ceiling ≥ 2,500 ft and visibility ≥ 3 SM; the exact test is 1,500 ft above the lowest circling MDA and 3 SM or 2 SM above the lowest visibility minimum). Add an alternate.` : `Forecast for ETA ±1 h is below 2,000 ft ceiling or 3 SM visibility, so 14 CFR 91.169 (the 1-2-3 rule) requires an alternate. Add one.`, id);
      if (fc.flags && fc.flags.freezingPrecip) add('nogo', 'Icing', `${id}: freezing precipitation forecast at ETA`, `Freezing rain/drizzle is outside the XLS+ ice protection certification (Appendix C) and contaminates the runway. Delay or divert.`, id);
      if (worst && worst.flags && worst.flags.freezingPrecip && !(fc.flags && fc.flags.freezingPrecip)) add('caution', 'Icing', `${id}: freezing precipitation possible (TEMPO/PROB)`, `Have a non-freezing alternate and fuel to reach it.`, id);
    }
    if (role === 'departure') {
      if (fc.flags && fc.flags.freezingPrecip) add('nogo', 'Icing', `${id}: freezing precipitation at departure`, `Takeoff in freezing rain/drizzle is generally beyond holdover-time guidance and the airframe's certification. Delay.`, id);
      if (belowMins(fc)) add(opts.rules === '135' ? 'caution' : 'caution', 'Ceiling/Vis', `${id}: departure below landing minimums`, `Ceiling ${fc.ceiling ?? 'none'} ft / ${fc.vis ?? '?'} SM. ${opts.rules === '135' ? '135.217 requires a takeoff alternate within one hour flying time.' : 'Plan a takeoff alternate within about one hour in case of an engine or system return.'} Confirm takeoff minimums for the departure runway.`, id);
      if (cur && cur.temp != null && cur.temp <= 5 && Object.keys(cur.flags).some((k) => ['snow', 'freezingPrecip', 'icePellets'].includes(k))) add('caution', 'Icing', `${id}: frozen precipitation at departure`, `Ground de-icing/anti-icing likely required; check holdover times and runway condition codes (RwyCC).`, id);
    }
    if (role === 'alternate') {
      const okPrecision = (c) => (c.ceiling == null || c.ceiling >= 600) && (c.vis == null || c.vis >= 2);
      const okNonPrecision = (c) => (c.ceiling == null || c.ceiling >= 800) && (c.vis == null || c.vis >= 2);
      if (!okPrecision(fc)) add('nogo', 'Alternate', `${id}: below standard alternate minimums`, `Forecast at ETA: ceiling ${fc.ceiling ?? 'none'} ft / ${fc.vis ?? '?'} SM, below 600-2 (precision) and 800-2 (non-precision). Choose another alternate.`, id);
      else if (!okNonPrecision(fc)) add('caution', 'Alternate', `${id}: meets alternate minimums only with a precision approach`, `Forecast ${fc.ceiling} ft / ${fc.vis} SM meets 600-2 but not 800-2. Verify the alternate has an operating precision approach and no "NA" alternate note.`, id);
      else add('ok', 'Alternate', `${id}: meets standard alternate minimums`, `Forecast at ETA meets 800-2.`, id);
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
    else if (/MOD/.test(turb)) add('caution', 'Turbulence', `PIREP: ${turb} turbulence ${altTxt(pAlt)}`, `${p.acType || 'Aircraft'}, ${entry.ageMin} min ago, ${entry.distNm} nm off route at ${entry.alongNm} nm. Consider type: a heavier jet's MOD is worse for an XLS+. ${p.rawOb}`, p.rawOb);
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
    if (surface.available) surface.narrative = surfaceNarrative(surface, { S, dep, dest, prof, stations, opts });
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

  // NOTAMs
  const notamInfo = notams
    ? { available: true, byAirport: notams }
    : { available: false, note: 'Set FAA_CLIENT_ID and FAA_CLIENT_SECRET (free at api.faa.gov) to pull NOTAMs automatically.', links: airports.map((id) => ({ id, url: `https://notams.aim.faa.gov/notamSearch/nsapp.html#/results?designators=${id}` })) };
  if (notams) {
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
    range: rangeCheck,
    surface,
    charts: wx.wpc.charts(),
    notams: notamInfo,
    sources: sourceList(errors),
    errors,
    dataGaps: missingCritical.length > 0,
  };
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

function surfaceNarrative(sf, { S, dep, dest, prof, stations, opts }) {
  const paras = [];
  const aValid = sf.analysisValid ? fmtZ(Date.parse(sf.analysisValid)) : 'latest';
  const depSt = stations.find((s) => s.role === 'departure');
  const destSt = stations.find((s) => s.role === 'destination');
  // Pressure systems
  const highs = sf.centers.filter((c) => c.kind === 'H'), lows = sf.centers.filter((c) => c.kind === 'L');
  const sys = [];
  for (const c of [...lows.slice(0, 3), ...highs.slice(0, 3)]) {
    const mv = c.motion ? ` It is forecast to move ${c.motion.towardCompass} at ~${c.motion.speedKt} kt and ${c.motion.pressureTrend > 0 ? 'fill/weaken' : c.motion.pressureTrend < 0 ? 'deepen' : 'hold steady'} (${c.motion.pressureTrend > 0 ? '+' : ''}${c.motion.pressureTrend} mb in ${Math.round(c.motion.hours)} h)${c.kind === 'H' && c.motion.pressureTrend < 0 ? ', i.e. the high is weakening' : c.kind === 'H' && c.motion.pressureTrend > 0 ? ', i.e. the high is strengthening' : ''}.` : '';
    sys.push(c.kind === 'L'
      ? `A ${c.pressure} mb low lies ${c.distNm} nm ${c.bearingFromRoute} of the route (abeam ~${c.alongRouteNm} nm). Around a low the flow is counterclockwise and converging, so air is lifted: expect more cloud, lower ceilings and precipitation the closer the route passes, with the worst weather usually north and east of the center and along its fronts.${mv}`
      : `A ${c.pressure} mb high lies ${c.distNm} nm ${c.bearingFromRoute} of the route (abeam ~${c.alongRouteNm} nm). Highs bring sinking, diverging air and generally good flying weather, but the subsidence inversion can trap haze, smoke and low stratus or fog overnight, and light winds near the center favor radiation fog.${mv}`);
  }
  paras.push({ heading: 'Synoptic overview', text: `WPC surface analysis valid ${aValid}. ${sys.length ? sys.join(' ') : 'No significant pressure centers within 600 nm of the route.'}` });

  // Fronts
  const relevantFr = sf.fronts.filter((f) => f.crossesRoute || f.depPassage || f.destPassage || f.encounter.distNm <= 150).slice(0, 5);
  const distantFr = sf.fronts.filter((f) => !relevantFr.includes(f));
  if (!sf.fronts.length) paras.push({ heading: 'Fronts', text: 'No fronts or troughs are analysed within 400 nm of the route. Weather will be driven by the air mass itself (stability, moisture) rather than frontal lift; check the terminal forecasts and convective outlooks for air-mass storms.' });
  const motionTxt = (f) => (!f.motion ? 'Its movement could not be matched on the 12-hour prog, so treat it as slow-moving or changing character.' : f.motion.speedKt < 5 ? 'Comparing the analysis with the 12-hour prog, it is nearly stationary.' : `Comparing the analysis with the 12-hour prog, it is moving toward the ${f.motion.towardCompass} at about ${f.motion.speedKt} kt${f.motion.becomes ? ` and is forecast to become a ${fronts.FRONT_NAMES[f.motion.becomes] || f.motion.becomes}` : ''}.`);
  for (const f of relevantFr) {
    const mv = motionTxt(f);
    const speedNote = f.type === 'COLD' && f.motion && f.motion.speedKt >= 5 ? (f.motion.speedKt >= 25 ? ' That is a fast cold front: expect a sharper, more convective band with gusty winds, and possible prefrontal squall lines.' : ' That is a slow cold front: the cloud and precipitation band tends to be wider and more stratiform, with longer-lasting IFR along it.') : '';
    const timing = f.crossesRoute
      ? `Projecting that motion to your flight times, the route meets the front about ${f.encounter.alongRouteNm} nm from ${dep.id} around ${fmtZ(Date.parse(f.encounter.time))}.`
      : `Projected to your flight times, it stays at least ${f.encounter.distNm} nm from the route (closest near ${f.encounter.alongRouteNm} nm).`;
    const pass = [f.depPassage ? `It reaches ${dep.id} around ${fmtZ(Date.parse(f.depPassage))} (ETD ${fmtZ(opts.etd)}).` : '', f.destPassage ? `It reaches ${dest.id} around ${fmtZ(Date.parse(f.destPassage))} (ETA ${fmtZ(prof.eta)}).` : ''].filter(Boolean).join(' ');
    const coldSfc = [depSt, destSt].some((s) => s && s.metar && s.metar.temp != null && s.metar.temp <= 3);
    const icingCue = (f.type === 'WARM' || f.type === 'STNRY' || f.type === 'OCFNT') && coldSfc ? ' Surface temperatures near freezing at a terminal raise the risk of freezing rain or ice pellets on the cold side of this boundary; review the freezing level and any icing PIREPs.' : '';
    paras.push({ heading: `${cap(f.name)}${f.strength ? ` (${f.strength})` : ''}: ${f.crossesRoute ? 'crosses route' : f.encounter.distNm + ' nm from route'}`, text: `Currently ${f.nearestNowNm} nm from the route at its closest (near ${f.nearestNowAtNm} nm along). ${mv}${speedNote} ${timing} ${pass} ${f.expectedWeather}${icingCue}` });
  }
  if (distantFr.length) paras.push({ heading: 'Other boundaries within 400 nm', text: distantFr.map((f) => `${cap(f.name)} ${f.nearestNowNm} nm from the route${f.motion && f.motion.speedKt >= 5 ? `, moving ${f.motion.towardCompass} at ${f.motion.speedKt} kt` : ', nearly stationary'}, projected to stay ${f.encounter.distNm}+ nm away.`).join(' ') + ' These should not directly affect the flight, but watch them if the departure slips or you divert toward them.' });

  // Terminal air-mass read
  const terms = [];
  for (const st of [depSt, destSt]) {
    if (!st || !st.metar) continue;
    const m = st.metar;
    const spread = m.temp != null && m.dewp != null ? Math.round(m.temp - m.dewp) : null;
    let t = `${st.id} (${st.role}) currently ${m.category}: wind ${m.wind.vrb ? 'variable' : m.wind.dir != null ? String(m.wind.dir).padStart(3, '0') + '°' : 'calm'} at ${m.wind.spd} kt${m.wind.gst ? ' gusting ' + m.wind.gst : ''}, temperature ${m.temp}°C, dew point ${m.dewp}°C.`;
    if (spread != null && spread <= 3) t += ` The ${spread}°C spread means the air is near saturation; fog or low stratus can form quickly, especially after sunset or with light winds.`;
    if (m.wind.dir != null && m.wind.dir >= 270 || (m.wind.dir != null && m.wind.dir <= 20)) t += ' Northwest-to-north flow typically indicates the cold, post-frontal (or high-pressure) side.';
    else if (m.wind.dir != null && m.wind.dir >= 140 && m.wind.dir <= 230) t += ' Southerly flow typically indicates the warm sector ahead of a cold front, with more moisture and instability.';
    terms.push(t);
  }
  if (terms.length) paras.push({ heading: 'Terminal air masses', text: terms.join(' ') });

  // Bottom line
  const crossing = sf.fronts.filter((f) => f.crossesRoute);
  const destPass = sf.fronts.filter((f) => f.destPassage);
  let bl;
  if (!crossing.length && !destPass.length) bl = `The surface pattern is benign for this flight: no frontal boundary is projected to cross the route or reach ${dest.id} during the flight window. The main surface-analysis risks are air-mass effects near the terminals.`;
  else bl = `The surface chart's main message for this flight: ${crossing.map((f) => `the ${f.name} crossing at ~${f.encounter.alongRouteNm} nm`).concat(destPass.map((f) => `the ${f.name} reaching ${dest.id}`)).join(', ')}. At FL${Math.round(opts.cruiseAlt / 100)} you will be above most frontal stratus, so the critical phases are the climb out of ${dep.id} and the descent into ${dest.id}: make sure the terminal TAF timing agrees with the front's projected arrival, and plan the alternate on the far side of the front from the weather.`;
  paras.push({ heading: 'What it means for this flight', text: bl });
  return paras;
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
    ['NOTAMs (FAA API)', 'FAA NOTAM API (optional credentials)'],
  ].map(([name, desc]) => ({ name, desc, ok: !failed.has(name) }));
}

module.exports = { buildBriefing, bestRunway, buildProfile, resolveRoute };
