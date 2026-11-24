'use strict';
// Fuel recommendation for the flight. With a ForeFlight briefing the trip, taxi and reserve figures are ForeFlight's
// own (from the aircraft performance profile); without one they are rough planning estimates. On top of the legal
// minimum the weather found in the brief adds contingency fuel, each item with its reason.
// Limits are representative XLS+ figures for screening; the AFM and the weight and balance govern.
const LIMITS = { usableFuelLb: 6740, maxRampLb: 20400, maxTakeoffLb: 20200, maxLandingLb: 18700 };
const HOLD_FLOW = 1100; // lb/h, holding at about 10,000 ft
const LOW_FLOW = 1700; // lb/h, climb and cruise to an alternate in the low flight levels
const r10 = (x) => Math.round(x / 10) * 10;

function recommend({ rules = '91', distNm, eteMin, cruiseFlow, estTripLb, windHeadKt = null, ff = null, alternate = {}, flags = {} }) {
  const fromFF = !!(ff && ff.flight);
  const lines = [], notes = [];
  const flow = fromFF && ff.eteMin ? (ff.flight / ff.eteMin) * 60 : cruiseFlow || 1450;
  const cite = rules === '135' ? '135.223' : '91.167';
  const taxi = fromFF && ff.taxi != null ? ff.taxi : 200;
  lines.push({ key: 'taxi', label: 'Taxi', lb: taxi, why: fromFF ? 'ForeFlight' : 'Allowance' });
  // ForeFlight's flight fuel counts the taxi burn when block less flight fuel equals its landing fuel
  const inclTaxi = fromFF && ff.block != null && ff.landing != null && Math.abs(ff.block - ff.flight - ff.landing) < 5;
  let trip = fromFF ? ff.flight - (inclTaxi ? taxi : 0) : estTripLb;
  lines.push({ key: 'trip', label: 'Trip', lb: trip, why: fromFF ? `ForeFlight flight fuel${inclTaxi ? ' less taxi' : ''}${ff.eteMin ? ` for ${Math.floor(ff.eteMin / 60)}:${String(ff.eteMin % 60).padStart(2, '0')}` : ''}` : 'Rough estimate from cruise fuel flow and time, not AFM data' });
  // Winds now compared with the winds the plan was built on
  if (fromFF && ff.headKt != null && windHeadKt != null && ff.eteMin && distNm) {
    const d = windHeadKt - ff.headKt, gs = distNm / (ff.eteMin / 60);
    if (d >= 10 && gs - d > 150) {
      const extraMin = (distNm / (gs - d) - distNm / gs) * 60, lb = r10((extraMin / 60) * flow);
      if (lb >= 50) lines.push({ key: 'wind', label: 'Stronger headwind', lb, why: `Current winds give about ${Math.round(windHeadKt)} kt average headwind against ${ff.headKt} kt in the plan: about ${Math.round(extraMin)} min more` });
    } else if (d <= -10) notes.push(`Current winds are about ${Math.round(-d)} kt more favorable than the plan's ${ff.headKt} kt headwind; the trip figure is left as planned.`);
  }
  // Alternate
  const altNeeded = !!(alternate.required || alternate.filed);
  if (altNeeded || alternate.advised) {
    const nm = alternate.distNm || 150;
    const est = r10(((nm / 330) * 60 + 12) / 60 * LOW_FLOW);
    const lb = fromFF && ff.alternate > 0 && alternate.filed ? ff.alternate : est;
    lines.push({ key: 'alternate', label: `Alternate${alternate.id ? ' ' + alternate.id : ''}`, lb, advisory: !altNeeded,
      why: fromFF && ff.alternate > 0 && alternate.filed ? 'ForeFlight alternate fuel' : `${alternate.id ? `${Math.round(nm)} nm from the destination` : 'No alternate chosen yet: 150 nm assumed'}, rough estimate${alternate.required ? ` (alternate required, ${cite})` : alternate.advised ? ' (alternate advised by the models, not required)' : ''}` });
    if (fromFF && alternate.required && !(ff.alternate > 0)) notes.push('The briefing carries no alternate fuel, but an alternate is required on the current forecast.');
  }
  const reserve = fromFF && ff.reserve ? ff.reserve : r10(flow * 0.75);
  lines.push({ key: 'reserve', label: 'Reserve (45 min)', lb: reserve, why: fromFF && ff.reserve ? `ForeFlight reserve (${cite} needs 45 min at normal cruise)` : `45 min at about ${r10(flow)} lb/h (${cite}), rough estimate` });
  const minimum = lines.filter((l) => !l.advisory).reduce((a, l) => a + l.lb, 0);
  // Contingency for what the brief found
  const extras = [];
  if (flags.convection) extras.push({ key: 'deviation', label: 'Weather deviations', lb: r10((12 / 60) * flow), why: `${flags.convection}: about 12 min of cruise for deviations` });
  if (flags.hold) extras.push({ key: 'hold', label: 'Holding at destination', lb: r10((flags.holdMin || 20) / 60 * HOLD_FLOW), why: `${flags.hold}: ${flags.holdMin || 20} min of holding at about ${HOLD_FLOW} lb/h` });
  if (flags.icing) extras.push({ key: 'antiice', label: 'Anti-ice on', lb: r10(Math.max(50, trip * 0.03)), why: `${flags.icing}: about 3% of trip fuel for engine and wing anti-ice` });
  const adv = lines.filter((l) => l.advisory);
  const recommended = minimum + extras.reduce((a, l) => a + l.lb, 0) + adv.reduce((a, l) => a + l.lb, 0);
  const out = { basis: fromFF ? 'ForeFlight briefing figures, adjusted for the current forecast' : 'Rough planning estimates (no ForeFlight briefing loaded)', fromFF, lines, extras, minimumLb: minimum, recommendedLb: recommended, plannedLb: fromFF ? ff.block || null : null, limits: LIMITS, notes, level: 'info' };
  if (recommended > LIMITS.usableFuelLb) { out.level = 'caution'; notes.push(`The recommended load is above the ${LIMITS.usableFuelLb.toLocaleString('en-US')} lb usable capacity: plan a fuel stop or a closer alternate.`); }
  if (out.plannedLb != null) {
    out.marginLb = out.plannedLb - recommended;
    out.legalMarginLb = out.plannedLb - minimum;
    out.landingLb = out.plannedLb - taxi - trip - (lines.find((l) => l.key === 'wind') || { lb: 0 }).lb;
    if (out.legalMarginLb < 0) out.level = 'nogo';
    else if (out.marginLb < 0) out.level = 'caution';
    const cap = LIMITS.usableFuelLb - out.plannedLb;
    const wt = ff.tow != null ? LIMITS.maxTakeoffLb - ff.tow : null;
    out.roomLb = Math.max(0, Math.min(cap, wt == null ? cap : wt));
    if (ff.tow != null && ff.tow > LIMITS.maxTakeoffLb) notes.push(`ForeFlight shows a takeoff weight of ${ff.tow.toLocaleString('en-US')} lb, above the ${LIMITS.maxTakeoffLb.toLocaleString('en-US')} lb maximum takeoff weight this tool holds for the XLS+. Check it against your AFM and weight and balance before adding fuel.`);
    else if (out.marginLb < 0 && out.roomLb < -out.marginLb) notes.push(`Only about ${r10(out.roomLb).toLocaleString('en-US')} lb can be added before the ${cap <= (wt == null ? cap : wt) ? 'tanks are full' : 'maximum takeoff weight'}, so the full recommendation needs less payload, a fuel stop or a closer alternate.`);
    if (ff.elw != null && out.marginLb < 0 && ff.elw - out.marginLb > LIMITS.maxLandingLb) notes.push('Adding the recommended fuel would put the landing weight above the maximum landing weight if it is not burned.');
    out.text = out.legalMarginLb < 0
      ? `Planned block fuel ${out.plannedLb.toLocaleString('en-US')} lb is ${(-out.legalMarginLb).toLocaleString('en-US')} lb short of the minimum (${minimum.toLocaleString('en-US')} lb) on the current forecast.`
      : out.marginLb < 0
        ? `Planned block fuel ${out.plannedLb.toLocaleString('en-US')} lb meets the minimum (${minimum.toLocaleString('en-US')} lb). Recommend ${recommended.toLocaleString('en-US')} lb, ${(-out.marginLb).toLocaleString('en-US')} lb more, for ${[...adv, ...extras].map((e) => e.label.toLowerCase()).join(', ')}.`
        : `Planned block fuel ${out.plannedLb.toLocaleString('en-US')} lb covers the recommended ${recommended.toLocaleString('en-US')} lb with ${out.marginLb.toLocaleString('en-US')} lb to spare${extras.length || adv.length ? `, including ${[...adv, ...extras].map((e) => e.label.toLowerCase()).join(', ')}` : ''}.`;
  } else {
    out.text = `Recommend about ${recommended.toLocaleString('en-US')} lb block fuel (minimum about ${minimum.toLocaleString('en-US')} lb${extras.length || adv.length ? `, plus ${[...adv, ...extras].map((e) => e.label.toLowerCase()).join(', ')}` : ''}). These are rough estimates: upload the ForeFlight briefing to use its fuel plan.`;
  }
  return out;
}

module.exports = { recommend, LIMITS };
