'use strict';
// Takeoff field length, V1, VR and V2 for the Citation XLS+ from the AFM Section IV tables in afmto.json
// (dry runway, anti-ice off and on, flaps 7 and 15), by weight, temperature, pressure altitude and wind along the
// runway. The numbers were read by machine from scanned pages and are still being double checked, so the
// figures are advisory and the AFM governs. A negative distance in the data marks a shaded cell of the AFM
// table; 0 marks a cell the AFM leaves blank (beyond a limit).
const T = require('./afmto.json');

function bracket(list, x) {
  if (x <= list[0]) return [0, 0, 0];
  if (x >= list[list.length - 1]) return [list.length - 1, list.length - 1, 0];
  const j = list.findIndex((v) => v >= x);
  if (list[j] === x) return [j, j, 0]; // on a printed value: use it alone
  return [j - 1, j, (x - list[j - 1]) / (list[j] - list[j - 1])];
}
// blend two results; null if either is missing
function mix(a, b, f) {
  if (!a || !b) return null;
  if (f === 0) return a;
  const l = (x, y) => (x == null || y == null ? null : x + (y - x) * f);
  return { ft: l(a.ft, b.ft), v1: l(a.v1, b.v1), vr: l(a.vr, b.vr), v2: l(a.v2, b.v2), shaded: a.shaded || b.shaded };
}
// one printed row [temp, [5 distances], [5 V1], VR, V2] at a headwind (negative for a tailwind)
function inRow(row, headKt) {
  const [i0, i1, f] = bracket(T.wind, headKt);
  const at = (i) => (row[1][i] ? { ft: Math.abs(row[1][i]), v1: row[2][i], vr: row[3], v2: row[4], shaded: row[1][i] < 0 } : null);
  return mix(at(i0), at(i1), f);
}
function inTable(rows, tempC, headKt) {
  const temps = rows.map((r) => r[0]);
  if (tempC > temps[temps.length - 1]) return null; // warmer than the last printed row: beyond the limit
  const [i0, i1, f] = bracket(temps, tempC); // colder than the first row is held at that row
  return mix(inRow(rows[i0], headKt), inRow(rows[i1], headKt), f);
}
function inAlt(block, weightLb, tempC, headKt) {
  if (!block) return null;
  const ws = Object.keys(block).map(Number).sort((a, b) => a - b);
  const [i0, i1, f] = bracket(ws, weightLb); // lighter than the lightest table is held at that table
  return mix(inTable(block[ws[i0]], tempC, headKt), inTable(block[ws[i1]], tempC, headKt), f);
}
function lookup(flaps, { weightLb, tempC, elevFt, headKt, antiIce, wet }) {
  const cfg = T.cfg[`${flaps}${wet ? 'w' : ''}${antiIce ? 'ai' : ''}`];
  if (!cfg) return null;
  const alts = Object.keys(cfg).map(Number).sort((a, b) => a - b);
  if (elevFt > alts[alts.length - 1]) return null;
  const [i0, i1, f] = bracket(alts, Math.max(0, elevFt));
  const r = mix(inAlt(cfg[alts[i0]], weightLb, tempC, headKt), inAlt(cfg[alts[i1]], weightLb, tempC, headKt), f);
  if (!r || r.ft == null) return null;
  const rd = (x) => (x == null ? null : Math.round(x));
  return { ft: Math.ceil(r.ft / 10) * 10, v1: rd(r.v1), vr: rd(r.vr), v2: rd(r.v2), shaded: !!r.shaded, flaps };
}
const MAX_TAILWIND = 10, MAX_WEIGHT = 20200;
// Flaps 15 where the table gives an unshaded figure, otherwise flaps 7. antiIce uses the anti-ice on tables
// (printed to 10°C); wet uses the wet runway tables. headKt is the headwind along the
// runway (negative for a tailwind); more than 30 kt of headwind is taken as 30.
function takeoff({ weightLb, tempC, elevFt, headKt = 0, antiIce = false, wet = false }) {
  if (headKt < -MAX_TAILWIND) return { ft: null, reason: `a tailwind of more than ${MAX_TAILWIND} kt, the limit` };
  if (weightLb > MAX_WEIGHT) return { ft: null, reason: `above the ${MAX_WEIGHT.toLocaleString('en-US')} lb maximum in the tables` };
  const q = { weightLb, tempC, elevFt, headKt: Math.min(30, headKt), antiIce, wet };
  const a = lookup(15, q), b = lookup(7, q);
  const pick = a && !a.shaded ? a : b && !b.shaded ? b : a || b;
  if (!pick) return { ft: null, reason: 'beyond the limits of the AFM takeoff tables at this weight, temperature and elevation' };
  return pick;
}
module.exports = { takeoff, hasAntiIce: !!T.cfg['15ai'], hasWet: !!T.cfg['15w'], SOURCE: T.source };
