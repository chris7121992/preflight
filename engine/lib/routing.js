'use strict';
const perf = require('./perf');
// Weather-based route and altitude options. Candidate routes are lateral offsets of the direct course
// (two turn points at 30% and 70% of the way); each is scored for exposure to the same advisories and
// reports the briefing uses, plus the time a longer route costs. Altitudes are compared on the filed route
// for wind, temperature and turbulence/icing advisories. Suggestions only: ATC, preferred routes and
// airspace decide what can actually be filed.

const geo = require('./geo');
const { shiftPoint } = require('./fronts');

const offset = (p, brg, d) => shiftPoint(p, d * Math.sin(geo.rad(brg)), d * Math.cos(geo.rad(brg)));
const toPoly = (coords) => (coords || []).map((c) => ({ lat: Number(c.lat), lon: Number(c.lon) })).filter((c) => isFinite(c.lat) && isFinite(c.lon));
const ftH = (v) => (v == null || v === '' ? null : v === 'SFC' ? 0 : v === 'FZL' ? 'FZL' : isFinite(Number(v)) ? (Number(v) < 1000 ? Number(v) * 100 : Number(v)) : null);
function movePoly(poly, dirFrom, spd, hours) {
  if (!spd || !isFinite(dirFrom) || !hours) return poly;
  const to = (dirFrom + 180) % 360, d = spd * hours;
  return poly.map((p) => shiftPoint(p, d * Math.sin(geo.rad(to)), d * Math.cos(geo.rad(to))));
}

// Build the list of area hazards once; each has a test(sample) -> boolean and a weight per nm of exposure.
function hazardSet({ sigmets, isigmets, gairmets, cwas, pireps, tsMetars }) {
  const now = Date.now();
  const areas = [];
  for (const s of sigmets || []) {
    const poly = toPoly(s.coords); if (poly.length < 3) continue;
    const conv = /CONVECTIVE/i.test(s.hazard);
    const from = s.validTimeFrom * 1000, to = s.validTimeTo * 1000 + (conv ? 2 * 3600e3 : 0);
    const base = conv ? 0 : s.altitudeLow1 || 0, top = conv ? (s.altitudeHi1 || 45000) : s.altitudeHi1 || 60000;
    areas.push({ label: `${conv ? 'Convective SIGMET' : 'SIGMET'} ${s.seriesId || ''} ${conv ? '' : s.hazard}`.replace(/\s+/g, ' ').trim(), kind: conv ? 'conv' : /ICE/i.test(s.hazard) ? 'ice' : /TURB/i.test(s.hazard) ? 'turb' : 'other', w: conv ? 10 : 9, buffer: conv ? 20 : 0, from, to, base, top, conv,
      polyAt: s.movementSpd ? (t) => movePoly(poly, s.movementDir, s.movementSpd, Math.max(0, Math.min(3, (t - now) / 3600e3))) : () => poly });
  }
  for (const s of isigmets || []) {
    const poly = toPoly(s.coords); if (poly.length < 3) continue;
    const ts = /TS/.test(s.hazard);
    areas.push({ label: `Intl SIGMET ${s.seriesId || ''} ${s.hazard}`, kind: ts ? 'conv' : 'other', w: 8, buffer: ts ? 20 : 0, from: s.validTimeFrom * 1000, to: s.validTimeTo * 1000, base: s.base || 0, top: s.top || 60000, conv: ts, polyAt: () => poly });
  }
  for (const c of cwas || []) {
    const poly = toPoly(c.coords); if (poly.length < 3) continue;
    const ts = c.hazard === 'TS';
    areas.push({ label: `CWA ${c.cwsu} ${c.hazard}`, kind: ts ? 'conv' : 'other', w: ts ? 6 : 3, buffer: ts ? 20 : 0, from: c.validTimeFrom * 1000, to: c.validTimeTo * 1000, base: c.base || 0, top: c.top || 60000, conv: ts, polyAt: () => poly });
  }
  for (const g of gairmets || []) {
    const poly = toPoly(g.coords); if (poly.length < 3 || g.geometryType === 'LINE') continue;
    if (!/ICE|TURB/.test(g.hazard)) continue;
    const vt = Date.parse(g.validTime);
    let base = ftH(g.base), top = ftH(g.top);
    if (base === 'FZL') base = 0; if (top === 'FZL') top = 18000;
    areas.push({ label: `G-AIRMET ${g.hazard}`, kind: g.hazard === 'ICE' ? 'ice' : 'turb', w: g.hazard === 'ICE' ? 1.5 : 1, buffer: 0, from: vt - 90 * 60e3, to: vt + 90 * 60e3, base: base ?? 0, top: top ?? 60000, polyAt: () => poly, gairmet: true });
  }
  const points = [];
  for (const p of pireps || []) {
    if (!isFinite(p.lat) || !isFinite(p.lon)) continue;
    const turb = [p.tbInt1, p.tbInt2].filter(Boolean).join('/'), ice = [p.icgInt1, p.icgInt2].filter(Boolean).join('/');
    const sev = /SEV|EXTM|EXTRM/.test(turb + ice), mod = /MOD/.test(turb + ice);
    if (!sev && !mod) continue;
    points.push({ label: `PIREP ${sev ? 'severe' : 'moderate'} ${/SEV|MOD/.test(turb) ? 'turbulence' : 'icing'} ${p.fltLvl ? 'FL' + String(p.fltLvl).padStart(3, '0') : ''}`.trim(), lat: p.lat, lon: p.lon, alt: (p.fltLvl || 0) * 100, w: sev ? 50 : 8, radius: 30, altBand: 4000 });
  }
  for (const m of tsMetars || []) points.push({ label: `Thunderstorm at ${m.icaoId || m.id}`, lat: m.lat, lon: m.lon, alt: null, w: 40, radius: 20, low: true });
  return { areas, points };
}

function exposure(S, hz, stepNm = 10) {
  let score = 0;
  const hits = new Map();
  for (const a of hz.areas) {
    let nm = 0;
    for (const smp of S) {
      if (smp.t < a.from - 3600e3 || smp.t > a.to + 3600e3) continue;
      if (!a.conv && (smp.alt < a.base - 1000 || smp.alt > a.top + 1000)) continue;
      if (a.conv && smp.phase === 'cruise' && a.top < smp.alt - 2000) continue; // overflying tops with margin
      const poly = a.polyAt(smp.t);
      if (geo.distPointToPolygonNm(smp, poly) <= a.buffer) nm += stepNm;
    }
    if (nm) { score += nm * a.w; hits.set(a.label, (hits.get(a.label) || 0) + nm); }
  }
  for (const p of hz.points) {
    const near = S.find((smp) => geo.distNm(smp, p) <= p.radius && (p.alt == null ? smp.alt < 25000 : Math.abs(smp.alt - p.alt) <= p.altBand));
    if (near) { score += p.w; hits.set(p.label, 0); }
  }
  return { score: Math.round(score), hits: [...hits.entries()].map(([label, nm]) => (nm ? `${label} (${nm} nm)` : label)) };
}

function nearestNavaid(p, navaids) {
  let best = null;
  for (const n of navaids || []) {
    if (!/VOR|TACAN/.test(n.type || '') || !isFinite(n.lat)) continue;
    const d = geo.distNm(p, n);
    if (d <= 45 && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best;
}

// Adds model-forecast turbulence (cruise part of a profile) to an exposure result
function withTurb(ex, samples, turb) {
  if (!turb) return ex;
  const ts = turb(samples.filter((s) => s.phase === 'cruise'));
  const add = Math.round(ts.modNm * 1.2 + ts.sevNm * 8);
  return { score: ex.score + add, hits: ts.modNm + ts.sevNm ? [...ex.hits, `model-forecast ${ts.sevNm ? 'severe' : 'moderate'} turbulence (${ts.modNm + ts.sevNm} nm)`] : ex.hits, turb: ts };
}

function routeOptions({ route, opts, buildProfile, hazards: hzIn, navaids, windComp, turb }) {
  const hz = hazardSet(hzIn);
  const dep = route[0], dest = route[route.length - 1];
  const direct = geo.distNm(dep, dest);
  const crs = geo.bearing(dep, dest);
  const filedProf = buildProfile(route, opts, windComp);
  const filed = withTurb(exposure(filedProf.samples, hz), filedProf.samples, turb);
  const base = { name: 'Filed route', offsetNm: 0, distanceNm: Math.round(filedProf.totalNm), eteMin: Math.round((filedProf.eta - opts.etd) / 60e3), ...filed, points: route.map((w) => ({ lat: w.lat, lon: w.lon, id: w.id })) };
  const cands = [base];
  const maxOff = Math.min(200, direct * 0.35);
  for (const off of [-180, -120, -60, 0, 60, 120, 180]) {
    if (Math.abs(off) > maxOff) continue;
    const side = off < 0 ? (crs + 270) % 360 : (crs + 90) % 360;
    const p1 = offset(geo.interpolate(dep, dest, 0.3), side, Math.abs(off));
    const p2 = offset(geo.interpolate(dep, dest, 0.7), side, Math.abs(off));
    const pts = off === 0 ? [dep, dest] : [dep, p1, p2, dest];
    const prof = buildProfile(pts.map((p) => ({ ...p })), opts, windComp);
    const ex = withTurb(exposure(prof.samples, hz), prof.samples, turb);
    const nav = off === 0 ? [] : [nearestNavaid(p1, navaids), nearestNavaid(p2, navaids)];
    const label = off === 0 ? 'Direct' : `${Math.abs(off)} nm ${off < 0 ? 'left' : 'right'} of course (${geo.compass(side)} side)`;
    cands.push({ name: label, offsetNm: off, distanceNm: Math.round(prof.totalNm), eteMin: Math.round((prof.eta - opts.etd) / 60e3), ...ex,
      via: nav.filter(Boolean).map((n) => n.id),
      routeString: off === 0 ? `${dep.id} DCT ${dest.id}` : `${dep.id} DCT ${nav[0] ? nav[0].id : `${p1.lat.toFixed(1)}N/${Math.abs(p1.lon).toFixed(1)}W`} DCT ${nav[1] ? nav[1].id : `${p2.lat.toFixed(1)}N/${Math.abs(p2.lon).toFixed(1)}W`} DCT ${dest.id}`,
      points: pts.map((p) => ({ lat: p.lat, lon: p.lon, id: p.id || null })) });
  }
  for (const c of cands) c.total = c.score + Math.max(0, c.eteMin - base.eteMin) * 3;
  const ranked = cands.slice().sort((a, b) => a.total - b.total);
  const best = ranked[0];
  let recommendation;
  if (base.score === 0) recommendation = { keepFiled: true, text: `No SIGMET, Convective SIGMET, CWA, G-AIRMET icing/turbulence or significant PIREP lies on the filed route at its altitudes and times${turb ? ', and the models show no moderate turbulence at the cruise level' : ''}, so there is no weather reason to change it.` };
  else if (best !== base && best.score <= base.score * 0.6 && base.score - best.score >= 15) recommendation = { keepFiled: false, best, text: `Consider ${best.name}${best.via && best.via.length ? ` (roughly ${best.routeString})` : ''}. It cuts weather exposure from ${base.score} to ${best.score} points${best.hits.length ? ` (remaining: ${best.hits.join('; ')})` : ' (clear of the listed hazards)'} for ${best.eteMin - base.eteMin >= 0 ? '+' : ''}${best.eteMin - base.eteMin} min and ${best.distanceNm - base.distanceNm >= 0 ? '+' : ''}${best.distanceNm - base.distanceNm} nm. The filed route meets: ${base.hits.join('; ')}.` };
  else recommendation = { keepFiled: true, text: `The filed route meets ${base.hits.join('; ')}, but none of the lateral options within ${Math.round(maxOff)} nm avoids it meaningfully, so a re-route does not help much here. Manage it with altitude, timing or tactical deviations.` };
  return { candidates: cands.map(({ points, ...c }) => ({ ...c, points })), recommendation };
}

// Compare cruise levels on the filed route: wind component, ISA deviation and advisory exposure.
function altitudeOptions({ route, opts, buildProfile, hazards: hzIn, windAt, turb }) {
  const hz = hazardSet(hzIn);
  const rows = [];
  for (const fl of [310, 330, 350, 370, 390, 410, 430, 450]) {
    const o = { ...opts, cruiseAlt: fl * 100 };
    const wc = windAt ? windAt(fl * 100) : null;
    const prof = buildProfile(route, o, wc ? wc.comp : null);
    const ex = withTurb(exposure(prof.samples.filter((s) => s.phase === 'cruise'), hz), prof.samples, turb);
    if (ex.turb) ex.score += Math.round(ex.turb.lightNm * 0.1);
    const eteMin = Math.round((prof.eta - opts.etd) / 60e3);
    // Trip fuel from the XLS+ Flight Planning Guide tables (climb, high speed cruise, normal descent; ISA)
    const tp = perf.trip({ distNm: prof.totalNm, altFt: fl * 100, towLb: opts.towLb || 18500, windKt: wc && wc.avg != null ? wc.avg : 0, tasKt: opts.tas });
    rows.push({ fl, eteMin, fuelLb: Math.round(tp.lb / 10) * 10, cruiseFlow: tp.cruiseFlow, windComponent: wc ? wc.avg : null, isaDev: wc ? wc.isa : null, score: ex.score, hits: ex.hits, turb: ex.turb || null });
  }
  const minEte = Math.min(...rows.map((r) => r.eteMin));
  const minFuel = Math.min(...rows.map((r) => r.fuelLb));
  for (const r of rows) r.total = r.score + (r.eteMin - minEte) * 2 + (r.fuelLb - minFuel) / 50 + (r.fl >= 430 && r.isaDev != null && r.isaDev >= 10 ? 15 : 0);
  const best = rows.slice().sort((a, b) => a.total - b.total)[0];
  const planned = rows.find((r) => r.fl === Math.round(opts.cruiseAlt / 1000) * 10) || null;
  let text;
  if (planned && (best.fl === planned.fl || best.total >= planned.total - 5)) text = `FL${planned.fl} is as good as any level here${planned.hits.length ? `, though it meets ${planned.hits.join('; ')}` : ''}.`;
  else text = `FL${best.fl} looks better than FL${planned ? planned.fl : Math.round(opts.cruiseAlt / 100)}: ${best.windComponent != null ? `${best.windComponent >= 0 ? '+' : ''}${best.windComponent} kt average wind component, ` : ''}${best.hits.length ? `meets ${best.hits.join('; ')}` : 'no advisories at that level'}, ETE ${Math.floor(best.eteMin / 60)}:${String(best.eteMin % 60).padStart(2, '0')}, about ${best.fuelLb.toLocaleString('en-US')} lb burn${planned ? ` (FL${planned.fl}: ${Math.floor(planned.eteMin / 60)}:${String(planned.eteMin % 60).padStart(2, '0')}, ${planned.fuelLb.toLocaleString('en-US')} lb${planned.hits.length ? `, meets ${planned.hits.join('; ')}` : ''})` : ''}. Check that weight and temperature allow it (the XLS+ may not reach FL430-450 at heavy weights or warm temperatures).`;
  return { rows, best: best.fl, text };
}

module.exports = { routeOptions, altitudeOptions, hazardSet, exposure, withTurb };
