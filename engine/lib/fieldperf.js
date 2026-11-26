'use strict';
// Takeoff field length and landing distance for the Citation XLS+ from the Flight Planning Guide tables in
// fieldperf.json (dry, level, paved runway; zero wind; anti-ice off for takeoff). Looked up by weight, outside
// air temperature and field elevation, with straight-line interpolation between the printed values.
const T = require('./fieldperf.json');

const lerp = (x, x0, x1, y0, y1) => (x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
// pair of bracketing indexes in a sorted list and the fraction between them (held at the ends)
function bracket(list, x) {
  if (x <= list[0]) return [0, 0, 0];
  if (x >= list[list.length - 1]) return [list.length - 1, list.length - 1, 0];
  const j = list.findIndex((v) => v >= x);
  return [j - 1, j, (x - list[j - 1]) / (list[j] - list[j - 1])];
}
// One weight column of an elevation block at a temperature. Above the column's temperature limit there is no
// figure; between the last printed row and the limit the guide's "field length at temperature limit" is used.
function inColumn(block, c, tempC) {
  const lim = block.limitC ? block.limitC[c] : null;
  if (lim != null && tempC > lim) return null;
  const pts = block.temps.map((t, i) => [t, block.rows[i][c]]).filter((p) => p[1] != null && (lim == null || p[0] <= lim));
  if (lim != null && block.limitFt && (!pts.length || pts[pts.length - 1][0] < lim)) pts.push([lim, block.limitFt[c]]);
  if (!pts.length) return null;
  const [i0, i1, f] = bracket(pts.map((p) => p[0]), tempC);
  return lerp(f, 0, 1, pts[i0][1], pts[i1][1]);
}
// One elevation block at a temperature and weight; null above a limit
function inBlock(table, block, weightLb, tempC) {
  const ws = table.weights.slice().reverse(); // ascending
  const [w0, w1, wf] = bracket(ws, weightLb);
  const a = inColumn(block, table.weights.indexOf(ws[w0]), tempC), b = inColumn(block, table.weights.indexOf(ws[w1]), tempC);
  if (a == null || b == null) return null;
  return lerp(wf, 0, 1, a, b);
}
function lookup(table, weightLb, tempC, elevFt) {
  const elevs = Object.keys(table.elev).map(Number).sort((a, b) => a - b);
  const top = elevs[elevs.length - 1];
  if (elevFt > top + 500) return { ft: null, reason: `the guide's tables stop at ${top.toLocaleString('en-US')} ft elevation` };
  const maxW = table.weights[0];
  if (weightLb > maxW) return { ft: null, reason: `above the ${maxW.toLocaleString('en-US')} lb maximum in the tables` };
  const [e0, e1, ef] = bracket(elevs, Math.max(0, elevFt));
  const a = inBlock(table, table.elev[elevs[e0]], weightLb, tempC), b = inBlock(table, table.elev[elevs[e1]], weightLb, tempC);
  if (a == null || b == null) return { ft: null, reason: 'above the weight and temperature limit for this elevation' };
  // colder than the coldest printed row is held at that row (slightly long, never short)
  return { ft: Math.ceil(lerp(ef, 0, 1, a, b) / 10) * 10 };
}

// Takeoff field length: 15 degrees of flap, or 7 degrees where 15 is climb limited
function takeoff({ weightLb, tempC, elevFt }) {
  const f15 = lookup(T.takeoff15, weightLb, tempC, elevFt);
  if (f15.ft != null) return { ...f15, flaps: 15 };
  const f7 = lookup(T.takeoff7, weightLb, tempC, elevFt);
  if (f7.ft != null) return { ...f7, flaps: 7 };
  return { ft: null, flaps: null, reason: f15.reason };
}
// Actual landing distance over 50 ft with full flap, and VREF
function landing({ weightLb, tempC, elevFt }) {
  const r = lookup(T.landing, weightLb, tempC, elevFt);
  const ws = T.landing.weights.slice().reverse(), vr = T.landing.vref.slice().reverse();
  const [w0, w1, wf] = bracket(ws, weightLb);
  return { ...r, vref: Math.round(lerp(wf, 0, 1, vr[w0], vr[w1])) };
}
// Landing distance on a wet runway from the dry distance: AFM Section IV advisory data for wet runways
// (Figure 4-550-2, with thrust reversers; not FAA approved). Columns: dry, wet at VREF, wet at VREF + 10 kt.
const WET = (() => {
  const head = [[1600, 1900, 2200], [1800, 2100, 2450], [2000, 2350, 2700], [2200, 2600, 2950], [2400, 2850, 3250], [2600, 3100, 3500], [2800, 3300, 3750], [3000, 3550, 4000], [3200, 3750, 4250], [3400, 4000, 4500], [3600, 4200, 4750], [3800, 4450, 5000], [4000, 4650, 5250], [4200, 4900, 5500], [4400, 5150, 5750], [4600, 5400, 6000], [4800, 5650, 6250]];
  // from 5000 ft dry the table rises 200 ft per 200 ft in both columns, to 9800 ft dry
  for (let d = 5000; d <= 9800; d += 200) head.push([d, 5850 + (d - 5000), 6450 + (d - 5000)]);
  return head;
})();
function wetLanding(dryFt) {
  if (dryFt == null || !isFinite(dryFt)) return null;
  if (dryFt > WET[WET.length - 1][0]) return null;
  const [i0, i1, fr] = bracket(WET.map((r) => r[0]), dryFt);
  const up = (x) => Math.ceil(x / 10) * 10;
  return { vrefFt: up(lerp(fr, 0, 1, WET[i0][1], WET[i1][1])), plus10Ft: up(lerp(fr, 0, 1, WET[i0][2], WET[i1][2])), source: 'AFM Section IV wet runway advisory data, Figure 4-550-2, with thrust reversers' };
}
// Standard temperature at an elevation, for when no temperature is known
const isaC = (elevFt) => 15 - 1.98 * (elevFt / 1000);

module.exports = { takeoff, landing, wetLanding, isaC, SOURCE: T.source };
