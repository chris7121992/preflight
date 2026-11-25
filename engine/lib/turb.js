'use strict';
// Turbulence along the route by flight level, from the global models' winds and temperatures aloft.
//
// Method (the approach behind the Graphical Turbulence Guidance: several diagnostics, each expressed as an
// eddy dissipation rate, then combined, and repeated for several models):
//   - vertical wind shear and the Richardson number (static stability over shear squared) in each layer,
//   - the Ellrod indices: shear times the horizontal deformation of the wind, with convergence added,
//   - a mountain wave term where a strong 700 hPa wind crosses high terrain,
// computed on a lattice of points that follows the course and reaches 150 nm either side, at the time the
// aircraft would pass. Models: GFS, ECMWF IFS, ICON and ECMWF's machine-learning model AIFS (Open-Meteo).
// The layers are thick (the pressure levels the models publish), so the numbers are best at ranking levels
// and routes against each other. They are not the official GTG product.

const geo = require('./geo');
const { shiftPoint } = require('./fronts');

const LEVELS = [700, 500, 400, 300, 250, 200, 150];
const LEVEL_FL = { 700: 100, 500: 180, 400: 240, 300: 300, 250: 340, 200: 390, 150: 450 };
const LAYER_FL = LEVELS.slice(0, -1).map((l, k) => (LEVEL_FL[l] + LEVEL_FL[LEVELS[k + 1]]) / 2);
const MODELS = { gfs_seamless: 'GFS', ecmwf_ifs025: 'ECMWF', icon_seamless: 'ICON', ecmwf_aifs025_single: 'AIFS' };
// Three tracks keep the request small enough for the free data service (its limits count points x variables x models)
const OFFSETS = [-150, 0, 150];
const VARS = LEVELS.flatMap((l) => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `temperature_${l}hPa`]);
// EDR (m^2/3 s^-1) thresholds for a light business jet: felt as light, moderate and severe
const CAT = { light: 0.12, moderate: 0.2, severe: 0.34 };
const catOf = (e) => (e == null ? null : e >= CAT.severe ? 'severe' : e >= CAT.moderate ? 'moderate' : e >= CAT.light ? 'light' : 'smooth');
const R_NM = 3440.065, KT = 0.514444, G = 9.80665, RD = 287.05;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const offset = (p, brg, d) => shiftPoint(p, d * Math.sin(geo.rad(brg)), d * Math.cos(geo.rad(brg)));

// Piecewise log-linear map from a diagnostic to EDR. anchors: [[value, edr], ...] with rising values.
function mapEdr(x, anchors) {
  if (x == null || !isFinite(x)) return null;
  if (x <= anchors[0][0]) return anchors[0][1] * Math.max(0.3, x / anchors[0][0]);
  for (let i = 1; i < anchors.length; i++) {
    if (x <= anchors[i][0]) { const f = (Math.log(x) - Math.log(anchors[i - 1][0])) / (Math.log(anchors[i][0]) - Math.log(anchors[i - 1][0])); return anchors[i - 1][1] + f * (anchors[i][1] - anchors[i - 1][1]); }
  }
  return anchors[anchors.length - 1][1];
}
const A_SHEAR = [[1, 0.04], [2, 0.08], [3.5, 0.13], [5, 0.19], [7, 0.26], [9, 0.36], [13, 0.5]]; // kt per 1,000 ft over the layer
const A_TI = [[0.5, 0.03], [2, 0.08], [4, 0.14], [8, 0.22], [12, 0.32], [20, 0.45]]; // Ellrod index, 1e-7 s^-2
const A_INVRI = [[0.05, 0.03], [0.125, 0.07], [0.25, 0.11], [0.5, 0.16], [1, 0.24], [2, 0.36], [4, 0.5]]; // 1 / Richardson number

// Points to request: rows along the course, five tracks across it
function lattice(dep, dest) {
  const D = geo.distNm(dep, dest);
  const nA = clamp(Math.round(D / 150) + 1, 4, 7);
  const points = [];
  for (let i = 0; i < nA; i++) {
    const f = i / (nA - 1), base = geo.interpolate(dep, dest, f);
    const brg = geo.bearing(geo.interpolate(dep, dest, Math.max(0, f - 0.02)), geo.interpolate(dep, dest, Math.min(1, f + 0.02)));
    OFFSETS.forEach((off, j) => { const p = offset(base, (brg + 90) % 360, off); points.push({ lat: p.lat, lon: p.lon, i, j, a: D * f, brg }); });
  }
  // terrain is sampled more densely along each track (20 per track) for the mountain wave term
  const terrain = [];
  OFFSETS.forEach((off, j) => { for (let q = 0; q < 20; q++) { const f = q / 19, base = geo.interpolate(dep, dest, f); const brg = geo.bearing(geo.interpolate(dep, dest, Math.max(0, f - 0.02)), geo.interpolate(dep, dest, Math.min(1, f + 0.02))); const p = offset(base, (brg + 90) % 360, off); terrain.push({ lat: p.lat, lon: p.lon, j, a: D * f }); } });
  return { dep: { lat: dep.lat, lon: dep.lon }, dest: { lat: dest.lat, lon: dest.lon }, D, nA, points, terrain };
}

// Where a position sits on the lattice: distance along the course and across it (right is positive)
function locate(lat, p) {
  const d = geo.distNm(lat.dep, p) / R_NM;
  if (d < 1e-6) return { a: 0, c: 0 };
  const th = geo.rad(geo.bearing(lat.dep, p) - geo.bearing(lat.dep, lat.dest));
  const xt = Math.asin(clamp(Math.sin(d) * Math.sin(th), -1, 1));
  const at = Math.acos(clamp(Math.cos(d) / Math.cos(xt), -1, 1)) * (Math.cos(th) < 0 ? -1 : 1);
  return { a: at * R_NM, c: xt * R_NM };
}

// raw: { models: [...], data: [one per lattice point], elevation: [one per terrain point] | null }
function analyze({ lat, raw, etd, eteMs }) {
  if (!raw || !raw.data || raw.data.length < lat.points.length) return null;
  const nA = lat.nA, nC = OFFSETS.length, nK = LEVELS.length - 1;
  const ds = (lat.D / (nA - 1)) * 1852, dc = (OFFSETS[1] - OFFSETS[0]) * 1852;
  // highest terrain near each lattice point, m
  const relief = lat.points.map((p) => {
    let mx = raw.data[p.i * nC + p.j] && isFinite(raw.data[p.i * nC + p.j].elevation) ? raw.data[p.i * nC + p.j].elevation : 0;
    if (raw.elevation) lat.terrain.forEach((t, q) => { if (Math.abs(t.j - p.j) <= 1 && Math.abs(t.a - p.a) <= (lat.D / (nA - 1)) * 0.75 && raw.elevation[q] > mx) mx = raw.elevation[q]; });
    return mx;
  });
  const perModel = [];
  for (const model of raw.models) {
    const cell = (i, j) => {
      const h = raw.data[i * nC + j] && raw.data[i * nC + j].hourly;
      if (!h || !h.time) return null;
      const t = etd + (i / (nA - 1)) * eteMs;
      let ti = 0, best = Infinity;
      h.time.forEach((s, q) => { const d = Math.abs(Date.parse(s + 'Z') - t); if (d < best) { best = d; ti = q; } });
      if (best > 2 * 3600e3) return null;
      const brg = geo.rad(lat.points[i * nC + j].brg), lv = [];
      for (const L of LEVELS) {
        const ws = (h[`wind_speed_${L}hPa_${model}`] || h[`wind_speed_${L}hPa`] || [])[ti], wd = (h[`wind_direction_${L}hPa_${model}`] || h[`wind_direction_${L}hPa`] || [])[ti], T = (h[`temperature_${L}hPa_${model}`] || h[`temperature_${L}hPa`] || [])[ti];
        if (ws == null || wd == null || T == null) return null;
        const u = -ws * KT * Math.sin(geo.rad(wd)), v = -ws * KT * Math.cos(geo.rad(wd)), Tk = T + 273.15;
        // wind turned into components along and across the course, so the lattice axes can be used for gradients
        lv.push({ ua: u * Math.sin(brg) + v * Math.cos(brg), uc: u * Math.cos(brg) - v * Math.sin(brg), T: Tk, th: Tk * Math.pow(1000 / L, 0.2857), kt: ws });
      }
      return lv;
    };
    const st = [];
    let ok = 0;
    for (let i = 0; i < nA; i++) { st.push([]); for (let j = 0; j < nC; j++) { const c = cell(i, j); st[i].push(c); if (c) ok++; } }
    if (ok < nA * nC * 0.8) continue;
    const edr = [], drv = [], jet = [];
    for (let k = 0; k < nK; k++) {
      const lay = st.map((row) => row.map((lv) => {
        if (!lv) return null;
        const a = lv[k], b = lv[k + 1];
        const dz = (RD / G) * ((a.T + b.T) / 2) * Math.log(LEVELS[k] / LEVELS[k + 1]);
        const vws = Math.hypot(b.ua - a.ua, b.uc - a.uc) / dz;
        const n2 = (G / ((a.th + b.th) / 2)) * ((b.th - a.th) / dz);
        return { dz, vws, n2, ua: (a.ua + b.ua) / 2, uc: (a.uc + b.uc) / 2, kt: (a.kt + b.kt) / 2 };
      }));
      const d = (f, i, j, di, dj, h) => {
        const p = lay[clamp(i + di, 0, nA - 1)][clamp(j + dj, 0, nC - 1)], m = lay[clamp(i - di, 0, nA - 1)][clamp(j - dj, 0, nC - 1)];
        const span = (clamp(i + di, 0, nA - 1) - clamp(i - di, 0, nA - 1)) + (clamp(j + dj, 0, nC - 1) - clamp(j - dj, 0, nC - 1));
        return p && m && span ? (p[f] - m[f]) / (span * h) : 0;
      };
      edr.push([]); drv.push([]); jet.push([]);
      for (let i = 0; i < nA; i++) {
        edr[k].push([]); drv[k].push([]); jet[k].push([]);
        for (let j = 0; j < nC; j++) {
          const c = lay[i][j];
          if (!c) { edr[k][i].push(null); drv[k][i].push(null); jet[k][i].push(null); continue; }
          const dst = d('ua', i, j, 1, 0, ds) - d('uc', i, j, 0, 1, dc), dsh = d('uc', i, j, 1, 0, ds) + d('ua', i, j, 0, 1, dc), div = d('ua', i, j, 1, 0, ds) + d('uc', i, j, 0, 1, dc);
          const def = Math.hypot(dst, dsh);
          const ti = Math.max(c.vws * def, c.vws * (def - div)) * 1e7;
          const shearKt = (c.vws / KT) * 304.8; // kt per 1,000 ft
          const ri = c.n2 / Math.max(c.vws * c.vws, 1e-10);
          const eS = mapEdr(shearKt, A_SHEAR), eT = mapEdr(ti, A_TI), eR = ri <= 0.25 ? 0.5 : mapEdr(1 / ri, A_INVRI);
          let e = (eS + eT + eR) / 3, why = eT >= eS && eT >= eR ? 'deformation' : 'shear';
          // mountain wave: strong flow at 700 hPa over high ground
          const w700 = st[i][j][0].kt, mw = clamp((w700 - 20) / 30, 0, 1) * clamp((relief[i * nC + j] - 1200) / 1800, 0, 1);
          if (mw > 0) { const e2 = Math.max(e * (1 + 0.6 * mw), 0.08 + 0.22 * mw); if (e2 > e * 1.15) why = 'mountain wave'; e = e2; }
          // thick layers and a coarse lattice cannot justify the top of the scale: the part above moderate is damped
          if (e > CAT.moderate) e = CAT.moderate + (e - CAT.moderate) * 0.6;
          edr[k][i].push(Math.min(0.5, e)); drv[k][i].push(why); jet[k][i].push(c.kt);
        }
      }
    }
    perModel.push({ model: MODELS[model] || model, edr, drv, jet });
  }
  if (!perModel.length) return null;

  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  // value of one model's field at lattice coordinates (bilinear) and flight level (linear between layer centres)
  const field = (F, a, c, fl) => {
    const x = clamp((a / lat.D) * (nA - 1), 0, nA - 1), y = clamp((c - OFFSETS[0]) / (OFFSETS[1] - OFFSETS[0]), 0, nC - 1);
    const i0 = Math.min(nA - 2, Math.floor(x)), j0 = Math.min(nC - 2, Math.floor(y)), fx = x - i0, fy = y - j0;
    const z = clamp(fl, LAYER_FL[0], LAYER_FL[nK - 1]);
    let k0 = 0; while (k0 < nK - 2 && LAYER_FL[k0 + 1] <= z) k0++;
    const fz = (z - LAYER_FL[k0]) / (LAYER_FL[k0 + 1] - LAYER_FL[k0]);
    const at = (k) => { const q = [F[k][i0][j0], F[k][i0 + 1][j0], F[k][i0][j0 + 1], F[k][i0 + 1][j0 + 1]]; if (q.some((v) => v == null)) return null; return q[0] * (1 - fx) * (1 - fy) + q[1] * fx * (1 - fy) + q[2] * (1 - fx) * fy + q[3] * fx * fy; };
    const lo = at(k0), hi = at(k0 + 1);
    return lo == null || hi == null ? null : lo + fz * (hi - lo);
  };
  const driverAt = (a, c, fl) => {
    const i = Math.round(clamp((a / lat.D) * (nA - 1), 0, nA - 1)), j = Math.round(clamp((c - OFFSETS[0]) / (OFFSETS[1] - OFFSETS[0]), 0, nC - 1));
    let k = 0; LAYER_FL.forEach((f, q) => { if (Math.abs(f - fl) < Math.abs(LAYER_FL[k] - fl)) k = q; });
    const cnt = {}; for (const m of perModel) { const w = m.drv[k][i][j]; if (w) cnt[w] = (cnt[w] || 0) + 1; }
    return Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x])[0] || null;
  };
  // Forecast at a position and altitude: middle of the models, the roughest model, and what drives it
  function at(p, altFt) {
    if (altFt == null || altFt < 8000) return null;
    const { a, c } = locate(lat, p), fl = altFt / 100;
    const vals = perModel.map((m) => field(m.edr, a, c, fl)).filter((v) => v != null);
    if (!vals.length) return null;
    return { edr: median(vals), max: Math.max(...vals), min: Math.min(...vals), a, c, fl };
  }
  // Exposure over a list of profile samples ({lat, lon, alt, s})
  function along(samples) {
    let lightNm = 0, modNm = 0, sevNm = 0, peak = 0, worst = 0, peakAt = null, sum = 0, n = 0;
    samples.forEach((s, q) => {
      const r = at(s, s.alt);
      if (!r) return;
      const step = q ? Math.abs(s.s - samples[q - 1].s) : samples[1] ? Math.abs(samples[1].s - s.s) : 10;
      if (r.edr >= CAT.severe) sevNm += step; else if (r.edr >= CAT.moderate) modNm += step; else if (r.edr >= CAT.light) lightNm += step;
      if (r.edr > peak) { peak = r.edr; peakAt = { s: Math.round(s.s), alt: s.alt, driver: driverAt(r.a, r.c, r.fl) }; }
      worst = Math.max(worst, r.max); sum += r.edr * step; n += step;
    });
    return { peak: +peak.toFixed(2), worst: +worst.toFixed(2), mean: n ? +(sum / n).toFixed(3) : null, cat: catOf(peak), lightNm: Math.round(lightNm), modNm: Math.round(modNm), sevNm: Math.round(sevNm), peakAt, score: Math.round(lightNm * 0.1 + modNm * 1.2 + sevNm * 8) };
  }
  const jetAt = (p, fl) => { const { a, c } = locate(lat, p); const v = perModel.map((m) => field(m.jet, a, c, fl)).filter((x) => x != null); return v.length ? median(v) : null; };
  return { models: perModel.map((m) => m.model), at, along, driverAt, jetAt, reliefMaxFt: Math.round((Math.max(...relief) * 3.28084) / 100) * 100 };
}

const FLS = [450, 430, 410, 390, 370, 350, 330, 310, 270, 210, 140];
const catWord = { smooth: 'smooth', light: 'light', moderate: 'moderate', severe: 'severe' };

// The picture for the briefing: a table of flight level against distance on the filed route, the levels and
// routes compared, and a recommendation.
function report({ T, samples, plannedFl, altRows, routes, fmtZ }) {
  const total = samples[samples.length - 1].s, nCol = Math.min(12, Math.max(6, Math.round(total / 90)));
  const cols = [];
  for (let q = 0; q < nCol; q++) { const s = (total * (q + 0.5)) / nCol; cols.push(samples.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a))); }
  const grid = [...new Set([...FLS, plannedFl])].sort((a, b) => b - a).map((fl) => ({ fl, cells: cols.map((c) => { const r = T.at(c, fl * 100); return r ? { edr: +r.edr.toFixed(2), max: +r.max.toFixed(2), cat: catOf(+r.edr.toFixed(2)), driver: r.edr >= CAT.light ? T.driverAt(r.a, r.c, fl) : null } : null; }) }));
  const levels = altRows.map((r) => ({ fl: r.fl, ...r.turb })).filter((r) => r.peak != null);
  const planned = levels.find((r) => r.fl === plannedFl) || null;
  const best = levels.slice().sort((a, b) => a.score - b.score || a.mean - b.mean || Math.abs(a.fl - plannedFl) - Math.abs(b.fl - plannedFl))[0] || null;
  const desc = (r) => `${catWord[r.cat]} (peak EDR ${r.peak.toFixed(2)}${r.modNm + r.sevNm ? `, moderate or worse for ${r.modNm + r.sevNm} nm` : r.lightNm ? `, light for ${r.lightNm} nm` : ''})`;
  const parts = [];
  let level = 'ok';
  if (planned) {
    parts.push(`At FL${planned.fl} the cruise is forecast ${desc(planned)}${planned.peakAt && planned.cat !== 'smooth' ? `, worst near ${planned.peakAt.s} nm from ${planned.peakAt.driver || 'shear'}` : ''}.`);
    if (planned.cat === 'severe' || planned.cat === 'moderate') level = 'caution';
    if (planned.worst >= CAT.moderate && planned.cat !== 'moderate' && planned.cat !== 'severe') parts.push(`The roughest model reaches EDR ${planned.worst.toFixed(2)}, so the models do not fully agree.`);
  }
  const better = planned && best && best.fl !== planned.fl && (planned.score - best.score >= 8 || (planned.cat !== 'smooth' && best.cat === 'smooth'));
  if (better) parts.push(`FL${best.fl} is the smoothest cruise level on the filed route: ${desc(best)}.`);
  else if (planned) parts.push(planned.cat === 'smooth' ? 'No other level is meaningfully smoother.' : 'No other cruise level is meaningfully smoother on this route.');
  // routes at the planned level and at their own smoothest level
  const filed = routes.find((r) => r.offsetNm === 0 && r.filed) || routes[0];
  const bestRoute = routes.slice().sort((a, b) => a.best.score - b.best.score || a.extraMin - b.extraMin)[0];
  const routeBetter = bestRoute && filed && bestRoute !== filed && filed.best.score - bestRoute.best.score >= 25 && bestRoute.best.score <= filed.best.score * 0.5;
  if (routeBetter) parts.push(`A lateral change helps more: ${bestRoute.name} at FL${bestRoute.best.fl} is ${desc(bestRoute.best)} for ${bestRoute.extraMin >= 0 ? '+' : ''}${bestRoute.extraMin} min.`);
  else if (planned && planned.cat !== 'smooth') parts.push('None of the lateral options is clearly smoother, so altitude is the better tool here.');
  const jet = cols.map((c) => ({ s: Math.round(c.s), kt: T.jetAt(c, plannedFl) })).filter((x) => x.kt != null).sort((a, b) => b.kt - a.kt)[0];
  if (jet) parts.push(`Strongest wind at FL${plannedFl} is about ${Math.round(jet.kt)} kt near ${jet.s} nm.`);
  return {
    available: true, models: T.models, thresholds: CAT, plannedFl, level,
    cols: cols.map((c) => ({ alongNm: Math.round(c.s), t: fmtZ ? fmtZ(c.t) : null })), grid, levels,
    routes: routes.map((r) => ({ name: r.name, offsetNm: r.offsetNm, filed: !!r.filed, extraMin: r.extraMin, atPlanned: r.atPlanned, best: r.best })),
    best: { fl: better ? best.fl : planned ? planned.fl : best ? best.fl : null, route: routeBetter ? bestRoute.name : 'Filed route', changeLevel: !!better, changeRoute: !!routeBetter },
    text: parts.join(' '),
    method: `Clear-air and mountain wave turbulence estimated from ${T.models.join(', ')} winds and temperatures at the time of passage: vertical wind shear, Richardson number and the Ellrod deformation indices in each layer, with a mountain wave term over high ground, each expressed as an eddy dissipation rate (EDR) and averaged, then the middle of the models taken. Light is EDR ${CAT.light} or more, moderate ${CAT.moderate}, severe ${CAT.severe} for an aircraft of this size. The layers are 4,000 to 6,000 ft thick, so thin shear layers are smoothed out: use it to compare levels and routes, and check the official GTG, SIGMETs, G-AIRMET Tango and PIREPs for intensity. Convective turbulence is not in these numbers; see the simulated radar.`,
  };
}

module.exports = { lattice, analyze, report, mapEdr, catOf, locate, CAT, LEVELS, VARS, MODELS, OFFSETS, FLS };
