'use strict';
// Flight risk score from everything in a finished briefing. Advisory: it does not change the go / no-go
// verdict, which comes from the limits and rules.
//
// Method
//  1. Each hazard gets a severity from 0 to 1 on an S-curve of its margin to a limit, so a crosswind at 90% of
//     the limit counts far more than twice one at 45%.
//  2. Hazards combine as 1 - product(1 - weight x severity) (a "noisy OR"), not by adding points: the score
//     saturates toward 100 instead of running past it, and one severe hazard is not diluted by benign ones.
//  3. Pairs that make each other worse (a wet runway with a tailwind, a low ceiling at night, weak destination
//     and alternate together ...) add a compounding term sized by the geometric mean of the two severities,
//     so it only matters when both are present.
//  4. What drives the score is found by removing each hazard in turn and scoring again.
// The weights are judgement, set so that one ordinary hazard on its own (a low ceiling with room above minimums,
// moderate icing, a wet runway) stays "low", a few together reach "moderate", "high" needs something close to a
// limit or hazards compounding, and a no-go item is "severe".
// Bands: under 20 low, under 45 moderate, under 70 high, 70 and over severe.

// Research behind the weights. Each entry: what the study found and which weighting follows from it. The studies
// give the order and rough size of the factors; the absolute scale of the score is still judgement.
const SOURCES = [
  { ref: 'Flight Safety Foundation ALAR Task Force, "Killers in Aviation", Flight Safety Digest, Nov 1998 - Feb 1999 (287 fatal approach-and-landing accidents 1980-1996; 76 accidents and serious incidents 1984-1997)', url: 'https://flightsafety.org/fsd/fsd_nov-feb99.pdf',
    found: 'The accident rate at night is close to three times the daylight rate. A nonprecision approach carries about five times the risk of a precision approach. Of the 76 occurrences, about 59% were in instrument conditions, about half in precipitation and about a third with adverse winds.',
    used: 'Night counts on its own and compounds with low weather. Low ceiling and visibility are scored against the approach minimums rather than as a hazard at any height, because the studies tie the risk to the approach flown and to what accompanies the weather, not to instrument conditions alone.' },
  { ref: 'van Es, Tritschler and Tauss, "Development of a Landing Overrun Risk Index", NLR-TP-2009-280 (2009), with van Es, "Running out of runway", NLR-TP-2005-498 (2005)', url: 'https://reports.nlr.nl/bitstreams/20b1b956-3081-40c8-a0ff-652be7ba05d5/download',
    found: 'Landing overrun risk ratios: snow, ice or slush on the runway 14, wet or flooded runway 10, tailwind over 10 kt 5, nonprecision approach 5. The risk falls once about 1,600 m of runway remains to stop in.',
    used: 'Order of the runway weights: contaminated above wet above tailwind. The tailwind curve is steep toward 10 kt. A wet runway counts modestly on a long runway and heavily when the runway margin is short.' },
  { ref: 'Flight Safety Foundation, "Reducing the Risk of Runway Excursions", Runway Safety Initiative (May 2009; excursion accidents 1995-2008)', url: 'https://skybrary.aero/sites/default/files/bookshelf/900.pdf',
    found: '"Multiple risk factors create a synergistic effect (i.e., two risk factors more than double the risk)", naming abnormal winds with contaminated runways. Runway excursions were about 29% of the accidents studied.',
    used: 'The compounding term between pairs, with the strongest pairs being a wet or contaminated runway with a tailwind, a crosswind or a short margin.' },
  { ref: 'Evans, "An Examination of Aviation Accidents Associated with Turbulence, Wind Shear and Thunderstorm", NASA/CR-2013-217989 (864 NTSB accidents 1987-2008)', url: 'https://ntrs.nasa.gov/api/citations/20130013459/downloads/20130013459.pdf',
    found: 'Thunderstorm accidents were the most lethal (72% fatal). Low-altitude wind shear was the most frequent category but 14% fatal. Clear air turbulence was 7% fatal.',
    used: 'Convection carries the largest en-route weight, wind shear a middle one and turbulence the smallest.' },
  { ref: 'Huang, Xie and Mendonca, "Factorial Validity of the Flight Risk Assessment Tool in General Aviation Operations", Journal of Aviation Technology and Engineering 9(1), 2020', url: 'https://docs.lib.purdue.edu/jate/vol9/iss1/4/',
    found: 'The item groups of a FRAT fit the data from 1,832 flights, but the value given to each item was not tested.',
    used: 'A caution: no published study validates the point values of a flight risk score, this one included.' },
];
const JUDGEMENT = 'Still judgement, with no study behind the number: the scale that turns these factors into a 0 to 100 score and its bands, the curve midpoints, and the weights for icing, fuel margin, NOTAMs, crew experience, deferred equipment and data gaps. Most of the studies cover airline and commercial transport accidents, not business jets alone.';

const sig = (x) => 1 / (1 + Math.exp(-x));
const clamp = (x) => Math.max(0, Math.min(1, x));

// Sun elevation in degrees (good to about a degree), for night
function sunElevation(lat, lon, ms) {
  const d = ms / 86400000 - 10957.5; // days from J2000
  const g = ((357.529 + 0.98560028 * d) * Math.PI) / 180;
  const q = 280.459 + 0.98564736 * d;
  const L = ((q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI) / 180;
  const e = ((23.439 - 0.00000036 * d) * Math.PI) / 180;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon) * Math.PI) / 180 - ra, la = (lat * Math.PI) / 180;
  return (Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) * 180) / Math.PI;
}

const ROLE = { departure: 'Departure', destination: 'Arrival', alternate: 'Alternate' };
// how much a terminal's conditions count by role
const ROLE_W = { departure: 0.75, destination: 1, alternate: 0.5 };
// en-route and whole-flight items taken from the briefing's findings: [weight, phase]
const CATS = {
  Convection: [0.55, 'En route'], Icing: [0.32, 'En route'], Turbulence: [0.22, 'En route'], SIGMET: [0.35, 'En route'], 'Wind shear': [0.4, null],
  'Volcanic ash': [0.75, 'En route'], 'Surface analysis': [0.15, 'En route'], 'Fuel/Range': [0.55, 'Flight'], NOTAM: [0.22, null], Data: [0.25, 'Flight'],
  Alternate: [0.3, 'Alternate'], Routing: [0.15, 'En route'], Crew: [0.2, 'Flight'], Wind: [0.2, null], MEL: [0.4, 'Flight'],
};
// findings that only raise the floor of a hazard measured directly at a terminal
const FLOOR = { 'Ceiling/Vis': 'lowwx', Crosswind: 'xwind', Tailwind: 'tailwind', Runway: 'runway', Performance: 'runway' };
const LEVEL_S = { nogo: 0.97, caution: 0.45 };

// several pairs often fire together on one bad-weather arrival, so each is held to this share of its listed strength
const PAIR_SCALE = 0.6;
// pairs that compound: [type a, type b, strength, same terminal only, label]
const PAIRS = [
  ['runway', 'wet', 0.6, true, 'short runway margin on a wet runway'],
  ['runway', 'tailwind', 0.5, true, 'short runway margin with a tailwind'],
  ['wet', 'tailwind', 0.5, true, 'tailwind on a wet runway'],
  ['xwind', 'wet', 0.5, true, 'crosswind on a wet runway'],
  ['xwind', 'gust', 0.3, true, 'gusty crosswind'],
  ['lowwx', 'night', 0.4, true, 'low weather at night'],
  ['lowwx', 'xwind', 0.35, true, 'low weather with a crosswind'],
  ['lowwx', 'gust', 0.25, true, 'low weather with gusts'],
  ['lowwx', 'storm', 0.4, true, 'low weather with thunderstorms'],
  ['lowwx', 'icing', 0.35, false, 'approach in low weather with icing'],
  ['runway', 'antiice', 0.3, true, 'short runway margin with anti-ice on'],
  ['runway', 'night', 0.2, true, 'short runway margin at night'],
  ['llws', 'gust', 0.3, true, 'wind shear with gusts'],
  ['destwx', 'altwx', 0.6, false, 'destination and alternate both marginal'],
  ['destwx', 'fuel', 0.6, false, 'marginal destination with little fuel to spare'],
  ['Convection', 'Turbulence', 0.3, false, 'convection with turbulence'],
  ['Convection', 'fuel', 0.4, false, 'deviations around weather with little fuel to spare'],
  ['Icing', 'Turbulence', 0.2, false, 'icing with turbulence'],
  ['Data', 'destwx', 0.35, false, 'marginal destination judged on incomplete data'],
  ['sic', 'destwx', 0.35, false, 'new SIC with a demanding arrival'],
  ['sic', 'xwind', 0.3, false, 'new SIC with a strong crosswind'],
  ['night', 'Icing', 0.15, false, 'icing at night'],
];

function assess(b) {
  const H = []; // { key, type, where, phase, label, s, w }
  const put = (type, where, phase, label, s, w) => {
    s = clamp(s);
    if (s < 0.03) return;
    const key = `${type}|${where || ''}`, old = H.find((h) => h.key === key);
    if (old) { if (s * w > old.s * old.w) Object.assign(old, { s, w, label }); } else H.push({ key, type, where: where || null, phase, label, s, w });
  };
  const plan = b.plan || {}, lim = plan.limits || {};
  const route = plan.route || [], ends = { departure: route[0], destination: route[route.length - 1] };
  const n = (x) => Math.round(x).toLocaleString('en-US');

  for (const st of b.stations || []) {
    const rw = ROLE_W[st.role] || 0.5, ph = ROLE[st.role] || 'Terminal', id = st.id, j = st.judged || {}, f = j.flags || {};
    // ceiling and visibility are measured against the approach minimums, not against a fixed height: a low
    // ceiling with room above minimums is routine IFR and scores little; half severity comes 100 ft or 1/4 SM
    // above minimums, and it is steep from there down. A departure counts half (takeoff needs less than landing).
    const minC = lim.minCeiling != null ? lim.minCeiling : 200, minV = lim.minVis != null ? lim.minVis : 0.5;
    const sc = j.ceiling != null ? sig((minC + 100 - j.ceiling) / 80) : 0, sv = j.vis != null ? sig((minV + 0.25 - j.vis) / 0.2) : 0;
    if (Math.max(sc, sv) > 0) put('lowwx', id, ph, `${id}: ${j.ceiling != null ? `ceiling ${n(j.ceiling)} ft` : 'no ceiling'}, visibility ${j.vis != null ? j.vis : '?'} SM (minimums ${n(minC)} ft, ${minV} SM)`, Math.max(sc, sv), 0.4 * (st.role === 'departure' ? 0.5 : rw));
    const r = st.runway && !st.runway.none ? st.runway : null;
    if (r) {
      const xl = lim.maxXwind || 25;
      if (r.crossG != null) put('xwind', id, ph, `${id}: crosswind ${r.crossG} kt on runway ${r.id}`, sig((r.crossG - 0.65 * xl) / (0.11 * xl)), 0.45 * rw);
      if (r.head != null && r.head < 0) put('tailwind', id, ph, `${id}: tailwind ${-r.head} kt on runway ${r.id}`, sig((-r.head - 7) / 2), 0.4 * rw);
      if (r.requiredFt && r.marginFt != null) {
        const m = r.marginFt / r.requiredFt;
        put('runway', id, ph, `${id}: runway ${r.id} ${r.marginFt >= 0 ? `${n(r.marginFt)} ft longer than` : `${n(-r.marginFt)} ft shorter than`} required`, sig((0.1 - m) / 0.06), 0.55 * rw); // the required figure already holds the landing factor
      }
    }
    if (j.gust && j.spd != null && j.gust - j.spd > 0) put('gust', id, ph, `${id}: gusts ${j.gust} kt (${j.gust - j.spd} kt over the steady wind)`, sig((j.gust - j.spd - 10) / 3.5), 0.25 * rw);
    const wetS = f.freezingPrecip ? 0.95 : f.snow ? 0.85 : f.heavyRain || f.thunder ? 0.7 : f.rain || f.showers || f.drizzle ? 0.5 : st.field && st.field.wet && st.field.wet.expected ? 0.5 : 0;
    if (wetS) put('wet', id, ph, `${id}: ${f.freezingPrecip ? 'freezing precipitation' : f.snow ? 'snow' : 'precipitation'} expected, runway likely ${f.snow || f.freezingPrecip ? 'contaminated' : 'wet'}`, wetS, (f.freezingPrecip || f.snow ? 0.45 : 0.3) * rw);
    if (f.thunder) put('storm', id, ph, `${id}: thunderstorms in the forecast`, 0.9, 0.55 * rw);
    if (j.llws) put('llws', id, ph, `${id}: low-level wind shear forecast`, 0.7, 0.3 * rw);
    if (st.field && st.field.antiIce) put('antiice', id, ph, `${id}: takeoff with anti-ice on`, 0.4, 0.12);
    if (st.field && st.field.afm && st.field.afm.shaded) put('runway', id, ph, `${id}: AFM takeoff table shaded at this weight`, 0.6, 0.5);
    const at = ends[st.role], t = Date.parse(st.timeOfInterest || '');
    if (at && isFinite(at.lat) && isFinite(t)) {
      const el = sunElevation(at.lat, at.lon, t);
      if (el < 0) put('night', id, ph, `${id}: ${el < -6 ? 'night' : 'twilight'} ${st.role === 'departure' ? 'departure' : 'arrival'}`, el < -6 ? 0.6 : 0.3, 0.2);
    }
  }
  // findings: en-route and whole-flight items, and floors for the terminal hazards above
  const byCat = {};
  for (const fa of b.factors || []) {
    const s = LEVEL_S[fa.level];
    if (!s) continue;
    if (FLOOR[fa.category]) {
      const st = (b.stations || []).find((x) => x.id === fa.where);
      // a limit broken counts in full; a caution about one counts as a caution
      put(FLOOR[fa.category], fa.where || '', st ? ROLE[st.role] : 'Flight', fa.title, s, (fa.level === 'nogo' ? (fa.category === 'Ceiling/Vis' ? 0.7 : 0.55) : 0.3) * (st ? ROLE_W[st.role] || 0.5 : 1));
      continue;
    }
    (byCat[fa.category] = byCat[fa.category] || []).push(fa);
  }
  for (const [cat, list] of Object.entries(byCat)) {
    const [w, phase] = CATS[cat] || [0.2, 'Flight'];
    // several findings of one kind count more than one, with diminishing effect
    const worst = Math.max(...list.map((x) => LEVEL_S[x.level])), raw = 1 - (1 - worst) * Math.pow(0.9, list.length - 1), s = worst < 0.9 ? Math.min(0.7, raw) : raw; // cautions alone stop at 0.7
    const top = list.find((x) => LEVEL_S[x.level] === worst);
    put(cat, '', phase || 'Flight', list.length > 1 ? `${top.title} (and ${list.length - 1} more ${cat.toLowerCase()} item${list.length > 2 ? 's' : ''})` : top.title, s, w);
  }
  // fuel margin when a planned figure is known
  const fu = b.fuel || {};
  if (fu.plannedLb != null && fu.minimumLb) put('fuel', '', 'Flight', `Fuel: ${n(fu.plannedLb - fu.minimumLb)} lb over the minimum`, sig((300 - (fu.plannedLb - fu.minimumLb)) / 180), 0.55);
  // a fuel finding and the fuel margin are one hazard
  const fuelCat = H.find((h) => h.type === 'Fuel/Range');
  if (fuelCat) { H.splice(H.indexOf(fuelCat), 1); put('fuel', '', 'Flight', fuelCat.label, fuelCat.s, 0.55); }
  if (b.dataGaps) put('Data', '', 'Flight', 'Some weather sources did not load', 0.5, 0.25);
  if (plan.crew && plan.crew.sicLow) put('sic', '', 'Flight', 'SIC has under 100 hours in type', 0.5, 0.14);

  // roles for the cross-terminal pairs
  const stOf = (role) => (b.stations || []).find((x) => x.role === role);
  const sevAt = (st, types) => (st ? Math.max(0, ...H.filter((h) => h.where === st.id && types.includes(h.type)).map((h) => h.s)) : 0);
  const virt = { destwx: sevAt(stOf('destination'), ['lowwx', 'storm', 'xwind', 'runway']), altwx: sevAt(stOf('alternate'), ['lowwx', 'storm']) };
  const sevType = (type, where) => {
    if (type in virt) return virt[type];
    return Math.max(0, ...H.filter((h) => h.type === type && (where == null || h.where === where)).map((h) => h.s));
  };
  const fuelDup = () => false;
  const pairs = [];
  for (const [a, c, k, same, label] of PAIRS) {
    const wheres = same ? [...new Set(H.filter((h) => h.type === a && h.where).map((h) => h.where))] : [null];
    for (const wh of wheres) {
      const sa = sevType(a, wh), sb = sevType(c, wh);
      if (sa > 0.15 && sb > 0.15) pairs.push({ a, c, where: wh, label: wh ? `${wh}: ${label}` : label.replace(/^./, (x) => x.toUpperCase()), s: Math.sqrt(sa * sb), w: k * PAIR_SCALE });
    }
  }
  const score = (skipKey) => {
    let keep = 1;
    for (const h of H) if (h.key !== skipKey && !fuelDup(h)) keep *= 1 - h.w * h.s;
    const out = skipKey ? H.find((h) => h.key === skipKey) : null;
    for (const p of pairs) {
      // a pair goes when either of its hazards is removed
      if (out && (p.a === out.type || p.c === out.type || (['destwx', 'altwx'].includes(p.a) || ['destwx', 'altwx'].includes(p.c))) && (p.where == null || p.where === out.where)) {
        const sa = sevTypeWithout(p.a, p.where, out), sb = sevTypeWithout(p.c, p.where, out);
        if (sa > 0.15 && sb > 0.15) keep *= 1 - p.w * Math.sqrt(sa * sb);
        continue;
      }
      keep *= 1 - p.w * p.s;
    }
    return 100 * (1 - keep);
  };
  function sevTypeWithout(type, where, out) {
    const rest = H.filter((h) => h !== out);
    if (type === 'destwx' || type === 'altwx') {
      const st = stOf(type === 'destwx' ? 'destination' : 'alternate'), types = type === 'destwx' ? ['lowwx', 'storm', 'xwind', 'runway'] : ['lowwx', 'storm'];
      return st ? Math.max(0, ...rest.filter((h) => h.where === st.id && types.includes(h.type)).map((h) => h.s)) : 0;
    }
    return Math.max(0, ...rest.filter((h) => h.type === type && (where == null || h.where === where)).map((h) => h.s));
  }
  let total = score(null);
  const nogo = b.decision && b.decision.verdict === 'NO-GO';
  if (nogo) total = Math.max(total, 70); // a limit is exceeded: always in the top band
  const alone = (h) => 100 * h.w * h.s;
  const drivers = H.filter((h) => !fuelDup(h)).map((h) => ({ label: h.label, phase: h.phase, where: h.where, type: h.type, severity: Math.round(h.s * 100), alone: Math.round(alone(h)), effect: Math.round((score(null) - score(h.key)) * 10) / 10 }))
    .filter((d) => d.effect >= 0.5).sort((x, y) => y.effect - x.effect);
  const base = 100 * (1 - H.filter((h) => !fuelDup(h)).reduce((k, h) => k * (1 - h.w * h.s), 1));
  const compounding = pairs.map((p) => ({ label: p.label, strength: Math.round(p.w * p.s * 100) })).filter((p) => p.strength >= 1).sort((x, y) => y.strength - x.strength);
  // by phase of flight
  const phases = ['Departure', 'En route', 'Arrival', 'Alternate', 'Flight'].map((name) => {
    const hs = H.filter((h) => h.phase === name && !fuelDup(h));
    return { name, score: Math.round(100 * (1 - hs.reduce((k, h) => k * (1 - h.w * h.s), 1))), items: hs.length };
  }).filter((p) => p.items);
  const rounded = Math.round(total);
  const level = rounded < 20 ? 'low' : rounded < 45 ? 'moderate' : rounded < 70 ? 'high' : 'severe';
  const top = drivers[0];
  return {
    score: rounded, level, baseScore: Math.round(base), compoundingAdds: Math.max(0, Math.round(score(null) - base)),
    drivers: drivers.slice(0, 8), compounding: compounding.slice(0, 5), phases,
    summary: `Risk ${rounded} of 100, ${level}${top ? `. Largest driver: ${top.label}${compounding.length ? `. Compounding: ${compounding[0].label.replace(/^[A-Z](?=[a-z])/, (x) => x.toLowerCase())}` : ''}` : ': nothing in the briefing raises it'}.`,
    reduce: top && top.effect >= 3 ? `Removing "${top.label}" would bring the score to about ${Math.round(Math.max(nogo && top.type !== 'x' ? 0 : 0, score(H.find((h) => h.label === top.label).key)))}.` : null,
    sources: SOURCES, judgement: JUDGEMENT,
    method: 'Each hazard is scored on an S-curve of its margin to a limit, hazards are combined as 1 minus the product of (1 minus weight times severity), and pairs that make each other worse add a compounding term. Advisory: the verdict comes from the limits and rules, not from this score.',
  };
}

module.exports = { assess, sunElevation };
