'use strict';
// Chooses a SID, a STAR and an instrument approach to go with the recommended route, from the FAA procedure
// data built by scripts/procedures.js and the approach minimums built by scripts/minimums.js.
const geo = require('./geo');
const routing = require('./routing');

const normRwy = (r) => String(r || '').toUpperCase().replace(/^0+/, '');
const P = (p) => ({ id: p[0], lat: p[1], lon: p[2] });
const serves = (body, rwy) => !rwy || body.rwys.includes('ALL') || body.rwys.some((r) => normRwy(r) === normRwy(rwy));
const len = (pts) => { let d = 0; for (let i = 1; i < pts.length; i++) d += geo.distNm(pts[i - 1], pts[i]); return d; };
const join = (a, b) => (a.length && b.length && a[a.length - 1].id === b[0].id ? a.concat(b.slice(1)) : a.concat(b));

// Every way to fly a procedure from/to this runway: each body that serves it, alone or with each transition.
function variants(kind, rec, rwy) {
  const out = [];
  for (const proc of (rec && rec[kind]) || []) {
    for (const body of proc.bodies.filter((b) => serves(b, rwy))) {
      const bp = body.pts.map(P);
      const base = { proc, rwySpecific: !body.rwys.includes('ALL') };
      // SID: body then transition. STAR: transition then body.
      const edge = kind === 'sids' ? bp[bp.length - 1] : bp[0];
      out.push({ ...base, transition: null, pts: bp, code: proc.code });
      for (const t of proc.transitions) {
        const tp = t.pts.map(P);
        const touches = kind === 'sids' ? tp[0].id === edge.id : tp[tp.length - 1].id === edge.id;
        if (!touches) continue;
        out.push({ ...base, transition: t, pts: kind === 'sids' ? join(bp, tp) : join(tp, bp), code: t.code });
      }
    }
  }
  return out;
}

// Rank the variants against the en-route part of the trip. `route` is the list of points from departure to
// destination; `hz` the hazard set from routing.hazardSet; times and altitudes are rough climb/descent figures.
function choose(kind, rec, { airport, runway, route, hz, opts, etaMs }) {
  const sid = kind === 'sids';
  let vs = variants(kind, rec, runway);
  let anyRunway = false;
  if (!vs.length && runway) { vs = variants(kind, rec, null); anyRunway = true; }
  if (!vs.length) return null;
  const ids = new Set(route.map((w) => w.id).filter(Boolean));
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + geo.distNm(route[i - 1], route[i]));
  const total = cum[cum.length - 1];
  const scored = vs.map((v) => {
    const pts = v.pts;
    const end = sid ? pts[pts.length - 1] : pts[0];
    const path = sid ? [airport, ...pts] : [...pts, airport];
    const pl = len(path);
    // Where the procedure meets the rest of the route. A fix the route already contains wins; otherwise it is
    // the first waypoint farther out than the procedure reaches (SID) or the last one before it begins (STAR),
    // so the en-route waypoints in between are kept.
    const reach = geo.distNm(airport, end);
    let k = route.findIndex((w) => w.id && w.id === end.id);
    if (k >= 0) k = sid ? Math.min(route.length - 1, k + 1) : Math.max(0, k - 1);
    else if (sid) { k = route.findIndex((w, i) => i > 0 && geo.distNm(airport, w) > reach + 5); if (k < 0) k = route.length - 1; }
    else { k = -1; for (let i = route.length - 2; i >= 0; i--) if (geo.distNm(airport, route[i]) > reach + 5) { k = i; break; } if (k < 0) k = 0; }
    const best = { k, rest: sid ? geo.distNm(end, route[k]) + (total - cum[k]) : cum[k] + geo.distNm(route[k], end) };
    const tripNm = pl + best.rest;
    const extraNm = Math.max(0, Math.round(tripNm - total));
    // weather on the procedure itself
    const samples = [];
    let d = 0;
    for (let i = 0; i < path.length; i++) {
      if (i) d += geo.distNm(path[i - 1], path[i]);
      const along = sid ? d : pl - d;
      samples.push({ lat: path[i].lat, lon: path[i].lon, alt: Math.min(opts.cruiseAlt, along * (sid ? 500 : 320)), t: sid ? opts.etd + (d / 250) * 3600e3 : etaMs - (along / 280) * 3600e3, phase: sid ? 'climb' : 'descent' });
    }
    const dense = [];
    for (let i = 1; i < samples.length; i++) { const a = samples[i - 1], b = samples[i], n = Math.max(1, Math.ceil(geo.distNm(a, b) / 10)); for (let j = 0; j < n; j++) { const f = j / n; dense.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, alt: a.alt + (b.alt - a.alt) * f, t: a.t + (b.t - a.t) * f, phase: a.phase }); } }
    dense.push(samples[samples.length - 1]);
    const ex = hz ? routing.exposure(dense, hz) : { score: 0, hits: [] };
    const filed = pts.filter((p) => ids.has(p.id)).length;
    const endFiled = ids.has(end.id);
    // stay near the route the pilot filed: a procedure that starts far off it changes the whole trip
    const offRoute = Math.round(geo.distPointToPolylineNm(end, route).d);
    const score = ex.score + (extraNm / 7) * 3 + offRoute * 0.4 - (endFiled ? 400 : filed ? 150 : 0) - (v.rwySpecific && !anyRunway ? 2 : 0);
    return { code: v.code, name: v.proc.name, procCode: v.proc.code, rnav: v.proc.rnav, transition: v.transition ? v.transition.name : null, fix: end.id, points: pts, lengthNm: Math.round(pl), extraNm, offRouteNm: offRoute, wx: ex, onFiledRoute: endFiled, joinIndex: best.k, score };
  });
  scored.sort((a, b) => a.score - b.score || a.lengthNm - b.lengthNm);
  // one entry per procedure for the list of alternatives
  const seen = new Set(), ranked = [];
  for (const s of scored) { if (seen.has(s.procCode)) continue; seen.add(s.procCode); ranked.push(s); }
  return { pick: ranked[0], options: ranked.slice(0, 4), anyRunway, runway: runway || null };
}

// The approach to expect: the lowest-minimums approach to the landing runway that NOTAMs leave available.
function approach(minimumsLib, rec, { cat, runway, skip, forecast }) {
  if (!rec) return null;
  const { straight, circling } = minimumsLib.options(rec, cat, skip);
  if (!straight.length && !circling.length) return null;
  const rw = runway ? String(runway).split('/').map(normRwy) : [];
  const mine = straight.filter((o) => rw.includes(o.rwy));
  const meets = (o) => !forecast || ((forecast.ceiling == null || forecast.ceiling >= o.hat) && (forecast.vis == null || forecast.vis >= o.vis));
  const pool = mine.length ? mine : straight.length ? straight : circling;
  // one line per chart: its lowest minimums
  const byProc = new Map();
  for (const o of pool) if (!byProc.has(o.proc)) byProc.set(o.proc, o);
  const list = [...byProc.values()];
  const pick = list.find(meets) || list[0];
  const visual = forecast && (forecast.ceiling == null || forecast.ceiling >= 3000) && (forecast.vis == null || forecast.vis >= 5);
  return {
    pick, backups: list.filter((o) => o !== pick).slice(0, 2), forRunway: mine.length > 0, runway: runway || null, visual: !!visual,
    aboveMinimums: meets(pick), circling: !mine.length && circling[0] ? circling[0] : null, chart: rec.chartBase ? rec.chartBase + pick.pdf : null, source: `FAA d-TPP cycle ${rec.cycle}`,
  };
}

// Put the pieces together: departure, SID, the en-route points between the two join points, STAR, destination.
function assemble({ route, sid, star }) {
  const dep = route[0], dest = route[route.length - 1];
  const tok = (p) => p.id || `${Math.abs(p.lat).toFixed(2)}${p.lat >= 0 ? 'N' : 'S'}/${Math.abs(p.lon).toFixed(2)}${p.lon >= 0 ? 'E' : 'W'}`;
  const from = sid ? Math.max(1, sid.pick.joinIndex) : 1;
  const to = star ? Math.min(route.length - 2, star.pick.joinIndex) : route.length - 2;
  let mid = from <= to ? route.slice(from, to + 1) : [];
  const procIds = new Set([...(sid ? sid.pick.points : []), ...(star ? star.pick.points : [])].map((p) => p.id));
  mid = mid.filter((p) => !p.id || !procIds.has(p.id));
  const points = [dep, ...(sid ? sid.pick.points : []), ...mid, ...(star ? star.pick.points : []), dest];
  const parts = [dep.id];
  if (sid) parts.push(sid.pick.code);
  for (const p of mid) parts.push(tok(p));
  if (star) parts.push(star.pick.code);
  parts.push(dest.id);
  return { string: parts.join(' '), points: points.map((p) => ({ id: p.id || null, lat: p.lat, lon: p.lon })), distanceNm: Math.round(len(points)) };
}

module.exports = { choose, approach, assemble, variants };
