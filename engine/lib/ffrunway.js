'use strict';
// Reads the takeoff and landing figures out of the text of a ForeFlight Runway Analysis (PDF or pasted text).
// The layout of that report varies with the aircraft and the options chosen, so this looks for labelled
// numbers rather than fixed positions, and everything it finds is shown to the pilot to check or correct.

const int = (s) => parseInt(String(s).replace(/[, ]/g, ''), 10);
const FT = '(\\d{1,2}[, ]?\\d{3})\\s*(?:ft|feet|\')';
const GAP = '(?:[^0-9\\n]{0,30}(?:1\\.\\d\\d|[68]0 ?%))?[^0-9\\n]{0,24}';
const LB = '(\\d{2}[, ]?\\d{3})\\s*(?:lbs?|pounds)?';

function first(text, res, ok) {
  for (const re of res) {
    const m = re.exec(text);
    if (m) { const v = int(m[1]); if (!ok || ok(v)) return v; }
  }
  return null;
}
const distOk = (v) => v >= 1500 && v <= 16000;
const wtOk = (v) => v >= 10000 && v <= 21000;
const spdOk = (v) => v >= 80 && v <= 170;

function common(t) {
  const o = {};
  const ap = /\b(?:airport|departure|destination|arrival|origin)\b[^A-Z0-9\n]{0,12}\b([A-Z][A-Z0-9]{3})\b/.exec(t) || /\b([KPCM][A-Z]{3})\b(?=[^\n]{0,40}\b(?:RWY|Rwy|Runway)\b)/.exec(t) || /\b(K[A-Z]{3})\b/.exec(t);
  if (ap) o.airport = ap[1];
  const rw = /\b(?:RWY|Rwy|Runway)\b[ :#]{0,3}(\d{2}[LRC]?)\b/.exec(t);
  if (rw) o.runway = rw[1];
  const cond = /\b(?:runway |rwy )?(?:condition|surface|contamination)\b[^A-Za-z\n]{0,6}(dry|wet|contaminated|standing water|slush|snow|ice)/i.exec(t);
  if (cond) { o.condition = cond[1].toLowerCase(); o.wet = o.condition !== 'dry'; }
  else if (/\bwet\b/i.test(t) && !/\bdry\b/i.test(t)) { o.condition = 'wet'; o.wet = true; }
  const wt = first(t, [new RegExp(`\\b(?:planned|actual|takeoff|take-off|landing|gross)? ?(?:weight|TOW|LDW|ELW)\\b[^0-9\\n]{0,12}${LB}`, 'i')], wtOk);
  if (wt) o.weightLb = wt;
  const fl = /\bflaps?\b[^0-9\n]{0,10}(\d{1,2})\b/i.exec(t);
  if (fl) o.flaps = +fl[1];
  return o;
}

function takeoffOf(t) {
  const o = common(t);
  o.distFt = first(t, [
    new RegExp(`\\b(?:take-?off field length|TOFL|balanced field(?: length)?|field length(?: required)?|take-?off (?:distance|run)(?: required)?|TODR|TORR|ASDR|accelerate[- ]stop(?: distance)?|required (?:runway|distance|field)(?: length)?|distance required|runway required)\\b[^0-9\\n]{0,24}${FT}`, 'i'),
    new RegExp(`\\b(?:take-?off field length|TOFL|balanced field(?: length)?|field length(?: required)?|take-?off distance(?: required)?|required (?:runway|distance)|distance required|runway required)\\b[^0-9\\n]{0,24}(\\d{1,2}[, ]?\\d{3})\\b`, 'i'),
  ], distOk);
  o.mtowLb = first(t, [new RegExp(`\\b(?:max(?:imum)?\\.? ?(?:allowable|permissible|performance)? ?(?:take-?off|TO) ?(?:weight|wt)|MTOW|RTOW|PLTOW|max(?:imum)? allowable(?: weight)?|limit(?:ing)? weight)\\b[^0-9\\n]{0,24}${LB}`, 'i')], wtOk);
  const lim = /\blimit(?:ed|ing)?(?: by| factor)?\b[ :]{0,3}(field length|runway|climb|obstacle|structural|brake energy|tire speed)/i.exec(t);
  if (lim) o.limit = lim[1].toLowerCase();
  for (const [k, re] of [['v1', /\bV ?1\b[^0-9\n]{0,8}(\d{2,3})\b/i], ['vr', /\bV ?R\b[^0-9\n]{0,8}(\d{2,3})\b/], ['v2', /\bV ?2\b[^0-9\n]{0,8}(\d{2,3})\b/i]]) {
    const v = first(t, [re], spdOk); if (v) o[k] = v;
  }
  return o;
}

function landingOf(t) {
  const o = common(t);
  const lab = '(?:landing (?:distance|field length)(?: required)?|LDR|LFL|required (?:runway|distance|landing distance|field)(?: length)?|distance required|runway required)';
  const fact = first(t, [new RegExp(`\\bfactored\\b${GAP}${FT}`, 'i')], distOk);
  const unf = first(t, [new RegExp(`\\b(?:unfactored|actual|AFM)\\b${GAP}${FT}`, 'i')], distOk);
  const any = first(t, [new RegExp(`\\b${lab}\\b${GAP}${FT}`, 'i'), new RegExp(`\\b${lab}\\b[^0-9\\n]{0,24}(\\d{1,2}[, ]?\\d{3})\\b`, 'i')], distOk);
  // which factor a factored figure carries: 60% (x1.67), 80% (x1.25), or their wet equivalents
  const fx = /\b(?:1\.67|60 ?%|1\.92)\b/.test(t) ? '60' : /\b(?:1\.25|80 ?%|1\.44)\b/.test(t) ? '80' : null;
  if (unf) { o.distFt = unf; o.factor = 'actual'; if (fact) o.factoredFt = fact; }
  else if (fact) { o.distFt = fact; o.factor = fx || '60'; }
  else if (any) { o.distFt = any; o.factor = fx && /factor/i.test(t) ? fx : 'actual'; }
  if (fx && /\b(?:1\.92|1\.44)\b/.test(t)) o.wet = true;
  const vref = first(t, [/\bV ?REF\b[^0-9\n]{0,8}(\d{2,3})\b/i], spdOk); if (vref) o.vref = vref;
  const vapp = first(t, [/\bV ?APP\b[^0-9\n]{0,8}(\d{2,3})\b/i], spdOk); if (vapp) o.vapp = vapp;
  o.mlwLb = first(t, [new RegExp(`\\b(?:max(?:imum)?\\.? ?(?:allowable|permissible|performance)? ?(?:landing|LDG) ?(?:weight|wt)|MLW|max(?:imum)? allowable(?: weight)?)\\b[^0-9\\n]{0,24}${LB}`, 'i')], wtOk);
  return o;
}

function parseRunwayAnalysis(text) {
  const t = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  if (!t.trim()) return null;
  // Split into the takeoff part and the landing part at their headings; a file may hold one or both.
  const heads = [];
  const re = /^.{0,30}\b(take-?off|departure|landing|arrival|destination)\b.{0,40}$/gim;
  let m;
  while ((m = re.exec(t))) {
    const kind = /take|depart/i.test(m[1]) ? 'takeoff' : 'landing';
    // a heading, not a data row such as "Landing Distance 3,400 ft"
    if (/\d{1,2}[, ]?\d{3}\s*(?:ft|lb|')/i.test(m[0]) || /\b(distance|weight|length|speed|flaps)\b/i.test(m[0])) continue;
    if (!heads.length || heads[heads.length - 1].kind !== kind) heads.push({ kind, at: m.index });
  }
  let tk = '', ld = '';
  if (heads.length) heads.forEach((h, i) => { const part = t.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : t.length); if (h.kind === 'takeoff') tk += part + '\n'; else ld += part + '\n'; });
  else { const i = t.search(/\blanding\b/i), j = t.search(/\btake-?off\b/i); if (j >= 0 && i > j) { tk = t.slice(j, i); ld = t.slice(i); } else if (i >= 0 && j > i) { ld = t.slice(i, j); tk = t.slice(j); } else if (j >= 0) tk = t; else if (i >= 0) ld = t; }
  const out = { takeoff: tk ? takeoffOf(tk) : null, landing: ld ? landingOf(ld) : null };
  if (out.takeoff && out.takeoff.distFt == null && out.takeoff.mtowLb == null) out.takeoff = null;
  if (out.landing && out.landing.distFt == null) out.landing = null;
  return out.takeoff || out.landing ? out : null;
}

// Cleans the figures sent with a briefing request (parsed or typed in by hand).
function clean(ra) {
  if (!ra || typeof ra !== 'object') return null;
  const num = (v, ok) => { const n = Number(v); return isFinite(n) && n > 0 && ok(n) ? Math.round(n) : null; };
  const rwy = (v) => { const m = /^(\d{1,2})([LRC]?)$/.exec(String(v || '').toUpperCase().replace(/^RWY ?/, '').trim()); return m ? m[1].padStart(2, '0') + m[2] : null; };
  const apt = (v) => (/^[A-Z][A-Z0-9]{2,3}$/.test(String(v || '').toUpperCase().trim()) ? String(v).toUpperCase().trim() : null);
  const out = { source: typeof ra.source === 'string' ? ra.source.slice(0, 80) : null, takeoff: null, landing: null };
  const t = ra.takeoff || {}, l = ra.landing || {};
  const td = num(t.distFt, distOk), tm = num(t.mtowLb, wtOk);
  if (td || tm) out.takeoff = { distFt: td, mtowLb: tm, runway: rwy(t.runway), airport: apt(t.airport), wet: !!t.wet, v1: num(t.v1, spdOk), vr: num(t.vr, spdOk), v2: num(t.v2, spdOk), flaps: num(t.flaps, (x) => x <= 40), limit: typeof t.limit === 'string' ? t.limit.slice(0, 30) : null };
  const ld = num(l.distFt, distOk);
  if (ld) out.landing = { distFt: ld, factor: ['60', '80'].includes(String(l.factor)) ? String(l.factor) : 'actual', runway: rwy(l.runway), airport: apt(l.airport), wet: !!l.wet, vref: num(l.vref, spdOk) };
  return out.takeoff || out.landing ? out : null;
}

module.exports = { parseRunwayAnalysis, clean };
