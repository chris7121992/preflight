'use strict';
// Deferred equipment, from the FAA Master Minimum Equipment List for the Model 560XL. Each deferred item's
// provisos are turned into checks against the planned flight. The MMEL is not an MEL: the operator's own
// approved MEL (or 91.213(d) without one) governs, and its (O) and (M) procedures must still be done.
const M = require('./mmel.json');

// the serial ranges in an item's name are not needed in a heading: every listed item applies to the XLS+ / Gen2
for (const i of M.items) i.short = i.item.replace(/:?\s*\(?Units?\s?-?\d{4}[^):]*\)?/g, '').replace(/\s+/g, ' ').replace(/[:\s]+$/, '').trim() || i.item;
const BY_ID = new Map(M.items.map((i) => [i.id, i]));
const SOURCE = `FAA ${M.title}, Revision ${M.revision}, ${M.date}`;
// repair intervals by category (MMEL definitions)
const REPAIR = { A: 'within the interval in the remarks', B: 'within 3 calendar days', C: 'within 10 calendar days', D: 'within 120 calendar days' };

function list() {
  return M.items.map((i) => ({ id: i.id, ata: i.ata, section: M.sections[i.ata] || '', item: i.item, short: i.short, cat: i.cat, installed: i.n[0], required: i.n[1], remarks: i.rem, limits: limitWords(i.t || {}) }));
}

// short words for the picker: what a deferral restricts
function limitWords(t) {
  const w = [];
  if (t.noIcing) w.push('no icing');
  if (t.noIcingNight) w.push('no icing at night');
  if (t.dayOnly) w.push('day only');
  if (t.vmcOnly) w.push('no IMC');
  if (t.noRvsm) w.push('no RVSM');
  if (t.maxFl) w.push(t.maxFl < 180 ? `max ${(t.maxFl * 100).toLocaleString('en-US')} ft` : `max FL${t.maxFl}`);
  if (t.noPrecip) w.push('no precipitation at the airports');
  if (t.maxHours) w.push(`max ${t.maxHours} h`);
  if (t.fuelPct) w.push(`fuel +${t.fuelPct}%`);
  if (t.noPax) w.push('no cabin occupants');
  if (t.noPaxNight) w.push('no cabin occupants at night');
  if (t.maxKias) w.push(`VMO ${t.maxKias} KIAS`);
  if (t.radar) w.push('no thunderstorm areas (Part 135)');
  if (t.perf) w.push('performance');
  return w;
}

// items a deferral makes "considered inoperative" as well (the remarks refer to them): first variant that applies
function withReferred(ids) {
  const out = [], seen = new Set();
  const push = (it, via) => { if (it && !seen.has(it.id)) { seen.add(it.id); out.push({ it, via }); for (const r of it.refs || []) { const t = M.items.find((x) => x.id === r || x.id.startsWith(r + '-')); if (t && !seen.has(t.id) && !ids.some((s) => s === r || s.startsWith(r + '-'))) push(t, it); } } };
  for (const id of ids) push(BY_ID.get(id), null);
  return out;
}

/**
 * ctx: { ids, add, factors, stations, cruiseAlt, rules, eteMin, night: [{id, role, night, nearNight}], icingLayers }
 * Adds findings in the 'MEL' category and returns the summary shown in the briefing.
 */
function apply(ctx) {
  const ids = (ctx.ids || []).filter((id) => BY_ID.has(id));
  if (!ids.length) return null;
  const add = ctx.add, fl = Math.round(ctx.cruiseAlt / 100), stations = ctx.stations || [];
  const rows = [];
  const precipOf = (f) => !!(f && (f.rain || f.heavyRain || f.snow || f.drizzle || f.showers || f.freezingPrecip || f.thunder || f.icePellets));
  const moistOf = (c) => !!(c && (precipOf(c.flags) || (c.flags && c.flags.fog) || (c.vis != null && c.vis < 1) || (c.ceiling != null && c.ceiling < 1000)));
  const icingFinds = (ctx.factors || []).filter((f) => f.category === 'Icing' && (f.level === 'nogo' || f.level === 'caution'));
  const convFinds = (ctx.factors || []).filter((f) => f.category === 'Convection' && (f.level === 'nogo' || f.level === 'caution'));
  const nights = (ctx.night || []).filter((x) => x.night), nearNights = (ctx.night || []).filter((x) => !x.night && x.nearNight);
  const where = (st) => `${st.id} (${st.role})`;
  const altWord = (m) => (m < 180 ? `${(m * 100).toLocaleString('en-US')} ft` : `FL${m}`);

  for (const row of withReferred(ids)) {
    const via = row.via, full = row.it.item, it = { ...row.it, item: row.it.short }, t = it.t || {}, lims = [];
    const why = via ? ` It is treated as inoperative because ${via.short} (${via.id}) is deferred.` : '';
    const nogo = (title, detail) => { add('nogo', 'MEL', title, `${detail}${why} MMEL ${it.id}: "${it.rem}"`, 'mel'); lims.push({ level: 'nogo', text: title }); };
    const caution = (title, detail) => { add('caution', 'MEL', title, `${detail}${why} MMEL ${it.id}: "${it.rem}"`, 'mel'); lims.push({ level: 'caution', text: title }); };
    const ok = (text) => lims.push({ level: 'ok', text });

    if (t.noIcing || (t.noIcingNight && (nights.length || nearNights.length))) {
      const cold = stations.filter((s) => { const c = s.judged, temp = s.field && s.field.tempC != null ? s.field.tempC : s.metar && s.metar.temp; return temp != null && temp <= 10 && moistOf(c); });
      const nightTxt = t.noIcingNight ? ' at night' : '';
      if (icingFinds.length) nogo(`${it.item} inoperative: icing is forecast${nightTxt}`, `With this item deferred the aircraft may not be operated in known, forecast or AFM-defined icing conditions${nightTxt}, and this briefing has ${icingFinds.length} icing finding${icingFinds.length > 1 ? 's' : ''}: ${icingFinds.slice(0, 3).map((f) => f.title).join('; ')}.`);
      else if (cold.length) nogo(`${it.item} inoperative: icing conditions at ${cold.map((s) => s.id).join(', ')}`, `Visible moisture at +10°C or colder is icing conditions by the AFM definition, and that is expected at ${cold.map(where).join(', ')}. With this item deferred the aircraft may not be operated in known, forecast or AFM-defined icing conditions${nightTxt}.`);
      else if (ctx.icingLayers && ctx.icingLayers.length) caution(`${it.item} inoperative: stay out of icing conditions${nightTxt}`, `No icing advisory touches the route, but the models show saturated air below freezing in places. With this item deferred the flight may not enter known, forecast or AFM-defined icing conditions${nightTxt}: that includes any cloud or visible moisture at +10°C or colder in the climb, cruise and descent.`);
      else caution(`${it.item} inoperative: stay out of icing conditions${nightTxt}`, `No icing is forecast on this flight. With this item deferred the flight may not enter known, forecast or AFM-defined icing conditions${nightTxt}: that includes any cloud or visible moisture at +10°C or colder in the climb, cruise and descent.`);
    }
    if (t.dayOnly) {
      if (nights.length) nogo(`${it.item} inoperative: day only, and it is night at ${nights.map((x) => x.id).join(' and ')}`, `With this item deferred the aircraft may not be operated at night. It is night at ${nights.map((x) => `${x.id} at the ${x.role === 'departure' ? 'departure time' : 'arrival time'}`).join(' and ')}.`);
      else if (nearNights.length) caution(`${it.item} inoperative: day only, and night is close at ${nearNights.map((x) => x.id).join(' and ')}`, `With this item deferred the aircraft may not be operated at night. The flight is planned in daylight, but night falls within 45 minutes of the planned time at ${nearNights.map((x) => x.id).join(' and ')}: a delay puts the flight outside the deferral.`);
      else ok('Day only: the flight is planned in daylight');
    }
    if (t.vmcOnly) {
      const imc = stations.filter((s) => s.judged && ((s.judged.ceiling != null && s.judged.ceiling < 1000) || (s.judged.vis != null && s.judged.vis < 3)));
      const mvfr = stations.filter((s) => !imc.includes(s) && s.judged && ((s.judged.ceiling != null && s.judged.ceiling < 3000) || (s.judged.vis != null && s.judged.vis < 5)));
      if (imc.length) nogo(`${it.item} inoperative: no flight in IMC, and ${imc.map((s) => s.id).join(', ')} is below VFR`, `With this item deferred the aircraft may not be operated in instrument meteorological conditions. Instrument conditions are expected at ${imc.map(where).join(', ')}.`);
      else caution(`${it.item} inoperative: the whole flight must stay in visual conditions`, `With this item deferred the aircraft may not be operated in instrument meteorological conditions${mvfr.length ? `, and ${mvfr.map(where).join(', ')} ${mvfr.length > 1 ? 'are' : 'is'} marginal VFR` : ''}. The terminal forecasts are above VFR minimums, but the tool cannot rule out cloud along the climb, cruise and descent.`);
    }
    if (t.noRvsm) {
      if (fl >= 290 && fl <= 410) nogo(`${it.item} inoperative: no RVSM, and FL${fl} is planned`, `With this item deferred the aircraft may not be operated in RVSM airspace (FL290 to FL410). Plan FL280 or below, and check the fuel and range at that altitude.`);
      else ok(`No RVSM: FL${fl} is outside RVSM airspace`);
    }
    if (t.maxFl) {
      if (fl > t.maxFl) nogo(`${it.item} inoperative: limited to ${altWord(t.maxFl)}, and ${altWord(fl)} is planned`, `With this item deferred the aircraft must stay at ${altWord(t.maxFl)} or below${t.unpress ? ' (the cabin is unpressurized, so the cabin altitude is the aircraft altitude; crew oxygen is used as the operating rule requires)' : ''}. Replan the altitude, and check the fuel and range at it.`);
      else ok(`Limited to ${altWord(t.maxFl)}: ${altWord(fl)} is planned`);
    }
    if (t.noPrecip) {
      const now = stations.filter((s) => s.judged && precipOf(s.judged.flags));
      const maybe = stations.filter((s) => !now.includes(s) && s.forecast && s.forecast.worst && precipOf(s.forecast.worst.flags));
      if (now.length) nogo(`${it.item} inoperative: precipitation is expected at ${now.map((s) => s.id).join(', ')}`, `With this item deferred the aircraft may not be operated in precipitation within 5 NM of the departure, destination or a required alternate. Precipitation is forecast at ${now.map(where).join(', ')}.`);
      else if (maybe.length) caution(`${it.item} inoperative: precipitation is possible at ${maybe.map((s) => s.id).join(', ')}`, `With this item deferred the aircraft may not be operated in precipitation within 5 NM of the departure, destination or a required alternate. The forecast carries a temporary or probable period of precipitation at ${maybe.map(where).join(', ')}.`);
      else ok('No precipitation within 5 NM of the airports: none is forecast');
    }
    if (t.radar) {
      if (convFinds.length) (ctx.rules === '135' ? nogo : caution)(`${it.item} inoperative: thunderstorms are forecast on this flight`, `${ctx.rules === '135' ? 'Under Part 135 a large transport category aircraft needs working airborne weather radar when thunderstorms or other hazardous weather that radar can detect may reasonably be expected along the route (135.175).' : 'Radar relief applies only where the operating rule does not require it. Under Part 91 it is not required, but there is no onboard means to avoid cells.'} This briefing has ${convFinds.length} convection finding${convFinds.length > 1 ? 's' : ''}: ${convFinds.slice(0, 3).map((f) => f.title).join('; ')}.`);
      else ok('Weather radar: no thunderstorms are forecast on this flight');
    }
    if (t.maxHours) {
      if (ctx.eteMin > t.maxHours * 60) nogo(`${it.item} inoperative: flights are limited to ${t.maxHours} hours, and this one is ${Math.floor(ctx.eteMin / 60)} h ${ctx.eteMin % 60} min`, `With this item deferred the flight may not exceed ${t.maxHours} hours and must stay within 1 hour of a suitable airport.`);
      else ok(`Limited to ${t.maxHours} hours: ${Math.floor(ctx.eteMin / 60)} h ${ctx.eteMin % 60} min is planned`);
    }
    if (t.fuelPct) caution(`${it.item} inoperative: carry ${t.fuelPct}% more route fuel`, `With this item deferred the fuel required for the route is increased by ${t.fuelPct}%${ctx.tripFuelLb ? ` (about ${Math.round(ctx.tripFuelLb * t.fuelPct / 1000) * 10} lb on this flight)` : ''}, both tanks are fuelled over the wing to a known, balanced quantity, and fuel use is tracked. The fuel figures in this briefing do not include that increase.`);
    if (t.noPax) caution(`${it.item} inoperative: no cabin occupants may be carried`, 'This relief applies only to flights with nobody in the cabin.');
    if (t.noPaxNight && (nights.length || nearNights.length)) caution(`${it.item} inoperative: no cabin occupants at night`, `With this item deferred the aircraft may not be operated at night with cabin occupants, and ${nights.length ? 'part of this flight is at night' : 'night is close to the planned times'}.`);
    if (t.maxKias) caution(`${it.item} inoperative: VMO ${t.maxKias} KIAS / MMO 0.70${t.noSteep ? ', no steep approaches' : ''}`, `With this item deferred the aircraft is limited to ${t.maxKias} KIAS / Mach 0.70. Cruise at Mach 0.70 is slower than normal cruise: check the planned true airspeed, time and fuel.`);
    if (t.apuReq) caution(`${it.item} inoperative: the APU generator must run for the whole flight`, 'One engine generator may be inoperative only with the APU generator in use throughout the flight.');
    if (t.perf && /thrust reverser/i.test(it.item)) {
      const wet = stations.filter((s) => s.role !== 'departure' && s.judged && precipOf(s.judged.flags));
      const tight = stations.filter((s) => s.runway && s.runway.marginFt != null && s.runway.len && s.runway.marginFt < s.runway.len * 0.15);
      if (wet.length || tight.length) caution(`${it.item} inoperative: ${wet.length ? `wet runway expected at ${wet.map((s) => s.id).join(', ')}` : `little runway to spare at ${tight.map((s) => s.id).join(', ')}`}`, `AFM landing distances take no credit for reverse thrust, so the figures in this briefing stand, but the extra stopping help on a wet or short runway is reduced or one-sided. Review the AFM single-engine reversing procedure.`);
      else ok('Thrust reverser: dry runways with margin are expected');
    }
    if (t.apchNote) ok('Approach, departure and en-route procedures must not require this equipment');
    const procs = [/\(O\)/.test(it.rem) ? '(O) operations procedure' : null, /\(M\)/.test(it.rem) ? '(M) maintenance procedure' : null].filter(Boolean);
    rows.push({ id: it.id, item: full, short: it.short, section: M.sections[it.ata] || '', cat: it.cat, repair: it.fix ? `within ${it.fix} (see remarks)` : REPAIR[it.cat] || null, installed: it.n[0], required: it.n[1], procedures: procs, remarks: it.rem, via: via ? via.id : null, limits: lims });
  }
  const bad = rows.filter((r) => r.limits.some((l) => l.level === 'nogo')).length, warn = rows.filter((r) => !r.limits.some((l) => l.level === 'nogo') && r.limits.some((l) => l.level === 'caution')).length;
  const plain = rows.filter((r) => !r.limits.some((l) => l.level !== 'ok'));
  if (plain.length) add('info', 'MEL', `${plain.length} deferred item${plain.length > 1 ? 's' : ''} with no limit on this flight`, `${plain.map((r) => `${r.short} (${r.id}${r.procedures.length ? ', ' + r.procedures.join(' and ') : ''})`).join('; ')}. Follow the provisos in your approved MEL.`, 'mel');
  const summary = bad ? `${bad} deferred item${bad > 1 ? 's' : ''} cannot be dispatched on this flight as planned.` : warn ? `${warn} deferred item${warn > 1 ? 's put' : ' puts'} a condition on this flight.` : `${rows.length} deferred item${rows.length > 1 ? 's' : ''}, none limiting this flight.`;
  return { source: SOURCE, note: 'From the FAA master MEL, which is not itself an MEL. Your approved MEL, its (O) and (M) procedures and the repair intervals govern; without an approved MEL, 91.213(d) applies.', items: rows, summary, blocked: bad, conditional: warn };
}

module.exports = { list, apply, SOURCE, has: (id) => BY_ID.has(id) };
