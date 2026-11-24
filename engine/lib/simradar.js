'use strict';
// Simulated radar for the flight: what the models put on the route at the time the aircraft is there.
// Reflectivity is estimated from each model's hourly precipitation rate (Marshall-Palmer, Z = 200 R^1.6; the
// convective relation Z = 300 R^1.4 when the model has thunderstorms or strong instability). Hourly means smooth
// out individual cells, so real echoes inside model showers run stronger than these figures.
const { MODEL_NAMES } = require('./nwp');

function dbzOf(rate, convective) {
  if (rate == null) return null;
  if (rate < 0.05) return 0;
  const z = convective ? 300 * Math.pow(rate, 1.4) : 200 * Math.pow(rate, 1.6);
  return Math.max(5, Math.min(70, Math.round(10 * Math.log10(z))));
}
const level = (dbz) => (dbz == null ? null : dbz >= 50 ? 'extreme' : dbz >= 40 ? 'heavy' : dbz >= 30 ? 'moderate' : dbz >= 15 ? 'light' : 'none');

// Up to `n` points evenly spaced along the profile samples, each with the time the aircraft passes
function routePoints(samples, n = 12) {
  if (!samples || samples.length < 2) return [];
  const out = [], step = (samples.length - 1) / (Math.min(n, samples.length) - 1);
  for (let i = 0; i < Math.min(n, samples.length); i++) {
    const s = samples[Math.round(i * step)];
    out.push({ lat: s.lat, lon: s.lon, s: s.s, t: s.t, alt: s.alt, phase: s.phase, from: s.t - 30 * 60e3, to: s.t + 30 * 60e3 });
  }
  return out;
}

// Aircraft position every 15 minutes from departure to arrival (for the radar frames)
function frames(samples, stepMin = 15) {
  if (!samples || samples.length < 2) return [];
  const t0 = samples[0].t, t1 = samples[samples.length - 1].t, out = [];
  const at = (t) => {
    let i = samples.findIndex((s) => s.t >= t);
    if (i <= 0) return samples[i === 0 ? 0 : samples.length - 1];
    const a = samples[i - 1], b = samples[i], f = (t - a.t) / Math.max(1, b.t - a.t);
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, s: a.s + (b.s - a.s) * f };
  };
  const step = stepMin * 60e3;
  for (let t = Math.round(t0 / step) * step; t <= Math.round(t1 / step) * step; t += step) {
    const p = at(Math.min(t1, Math.max(t0, t)));
    out.push({ t: new Date(t).toISOString(), lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3), alongNm: Math.round(p.s) });
  }
  return out;
}

// hourlyAt(i) returns the Open-Meteo hourly block for route point i
function analyze(points, models, hourlyAt, add, fmtZ) {
  const names = models.map((m) => MODEL_NAMES[m] || m);
  const rows = points.map((p, i) => {
    const h = hourlyAt(i), cells = {};
    models.forEach((m, mi) => {
      if (!h || !h.time) return;
      let best = -1, bd = Infinity;
      h.time.forEach((t, k) => { const d = Math.abs(Date.parse(t + 'Z') - p.t); if (d < bd) { bd = d; best = k; } });
      if (best < 0 || bd > 90 * 60e3) return;
      // precipitation is the sum over the hour ending at the stamp: take the larger of the two hours around passage
      const pr = h[`precipitation_${m}`] || [], r = [pr[best], pr[best + 1]].filter((x) => x != null);
      if (!r.length) return;
      const code = (h[`weather_code_${m}`] || [])[best], cape = (h[`cape_${m}`] || [])[best];
      const conv = (code != null && code >= 95) || (cape != null && cape >= 1000);
      const rate = Math.max(...r);
      let dbz = dbzOf(rate, conv);
      if (code != null && code >= 95) dbz = Math.max(dbz, 45);
      cells[names[mi]] = { dbz, rate: Math.round(rate * 10) / 10, thunder: code != null && code >= 95 };
    });
    const vals = Object.values(cells).map((c) => c.dbz);
    return { alongNm: Math.round(p.s), t: new Date(p.t).toISOString(), lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3), phase: p.phase, alt: p.alt, cells, max: vals.length ? Math.max(...vals) : null, n: vals.length };
  });
  const have = rows.filter((r) => r.n);
  const out = { available: have.length > 0, models: names.filter((n) => rows.some((r) => r.cells[n])), rows, maxDbz: have.length ? Math.max(...have.map((r) => r.max)) : null, method: 'Estimated from each model\'s hourly precipitation rate. Hourly averages smooth out individual cells, so echoes inside model showers can be stronger.' };
  if (!out.available) { out.text = 'No model precipitation data was available for the route.'; return out; }
  const agree = (thr) => have.filter((r) => Object.values(r.cells).filter((c) => c.dbz >= thr).length >= 2);
  const any = (thr) => have.filter((r) => r.max >= thr);
  const span = (list) => (list.length > 1 ? `${list[0].alongNm} to ${list[list.length - 1].alongNm} nm` : `${list[0].alongNm} nm`);
  const who = (list, thr) => [...new Set(list.flatMap((r) => Object.entries(r.cells).filter(([, c]) => c.dbz >= thr).map(([n]) => n)))].join(', ');
  const heavy = agree(40), mod = any(30), light = any(15), ts = have.filter((r) => Object.values(r.cells).some((c) => c.thunder));
  if (heavy.length) {
    out.text = `Models put heavy precipitation (40 dBZ or more) on the route at ${span(heavy)} as you pass (${who(heavy, 40)}).`;
    add('caution', 'Convection', `Simulated radar: heavy echoes on the route at ${span(heavy)}`, `${who(heavy, 40)} show an estimated ${Math.max(...heavy.map((r) => r.max))} dBZ near ${fmtZ(Date.parse(heavy[0].t))}${ts.length ? ', with thunderstorms in the model weather' : ''}. Plan a deviation or a different time, and check the live radar before departure. ${out.method}`);
  } else if (mod.length) {
    out.text = `Models put moderate precipitation (30 dBZ or more) on the route at ${span(mod)} as you pass (${who(mod, 30)}).`;
    add(any(40).length || ts.length ? 'caution' : 'info', 'Convection', `Simulated radar: moderate echoes on the route at ${span(mod)}`, `${who(mod, 30)} show up to an estimated ${Math.max(...mod.map((r) => r.max))} dBZ near ${fmtZ(Date.parse(mod[0].t))}${ts.length ? ', with thunderstorms in the model weather' : ''}. ${out.method}`);
  } else if (light.length) out.text = `Models show only light precipitation on the route (${span(light)}) at the time you pass.`;
  else out.text = 'No model puts precipitation on the route at the time you pass.';
  return out;
}

module.exports = { dbzOf, level, routePoints, frames, analyze };
