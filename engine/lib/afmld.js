'use strict';
// Landing distance (flaps 35, actual distance over 50 ft, level dry runway) for the Citation XLS+ from the AFM
// Section IV tables in afmld.json, by weight, temperature, pressure altitude and wind along the runway, with
// VREF and VAPP. The numbers were read by machine from scanned pages and are still being double checked, so
// the figures are advisory and the AFM governs. 0 marks a cell the AFM leaves blank.
const T = require('./afmld.json');

function bracket(list, x) {
  if (x <= list[0]) return [0, 0, 0];
  if (x >= list[list.length - 1]) return [list.length - 1, list.length - 1, 0];
  const j = list.findIndex((v) => v >= x);
  if (list[j] === x) return [j, j, 0]; // on a printed value: use it alone
  return [j - 1, j, (x - list[j - 1]) / (list[j] - list[j - 1])];
}
const mix = (a, b, f) => (a == null || b == null ? null : a + (b - a) * f);
function inRow(row, headKt) {
  const [i0, i1, f] = bracket(T.wind, headKt);
  return mix(row[1][i0] || null, row[1][i1] || null, f);
}
function inTable(rows, tempC, headKt) {
  if (!rows) return null;
  const temps = rows.map((r) => r[0]);
  if (tempC > temps[temps.length - 1]) return null;
  const [i0, i1, f] = bracket(temps, tempC);
  return mix(inRow(rows[i0], headKt), inRow(rows[i1], headKt), f);
}
function inAlt(block, weightLb, tempC, headKt) {
  if (!block) return null;
  const ws = Object.keys(block).map(Number).sort((a, b) => a - b);
  const [i0, i1, f] = bracket(ws, weightLb);
  return mix(inTable(block[ws[i0]], tempC, headKt), inTable(block[ws[i1]], tempC, headKt), f);
}
function speeds(weightLb) {
  const ws = Object.keys(T.speeds).map(Number).sort((a, b) => a - b);
  const [i0, i1, f] = bracket(ws, weightLb);
  return { vref: Math.round(mix(T.speeds[ws[i0]][0], T.speeds[ws[i1]][0], f)), vapp: Math.round(mix(T.speeds[ws[i0]][1], T.speeds[ws[i1]][1], f)) };
}
// headKt is the headwind along the runway (negative for a tailwind, 10 kt at most); over 30 kt is taken as 30
function landing({ weightLb, tempC, elevFt, headKt = 0 }) {
  const sp = speeds(weightLb);
  if (headKt < -10) return { ft: null, ...sp };
  const alts = Object.keys(T.alt).map(Number).sort((a, b) => a - b);
  if (elevFt > alts[alts.length - 1]) return { ft: null, ...sp };
  const [i0, i1, f] = bracket(alts, Math.max(0, elevFt));
  const h = Math.min(30, headKt);
  const v = mix(inAlt(T.alt[alts[i0]], weightLb, tempC, h), inAlt(T.alt[alts[i1]], weightLb, tempC, h), f);
  return { ft: v == null ? null : Math.ceil(v / 10) * 10, ...sp };
}
module.exports = { landing, SOURCE: T.source };
