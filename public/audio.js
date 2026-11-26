/* Audio briefing: a spoken synopsis, an AWARES departure brief and a takeoff brief, built from the briefing
   and read aloud by the browser's own speech engine (nothing is sent anywhere). The same text is shown to read. */
(function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n = (x) => Number(x).toLocaleString('en-US');
  const zt = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`; };
  const st = (b, role) => (b.stations || []).find((s) => s.role === role);
  const apt = (s) => (s ? `${s.name ? s.name.replace(/ (International|Regional|Municipal|Executive|County)? ?Airport$/i, '').trim() + ', ' : ''}${s.id}` : '');
  const windTxt = (w) => (!w ? 'wind not reported' : w.vrb || w.dir == null ? `wind variable at ${w.spd} kt${w.gst ? ` gusting ${w.gst}` : ''}` : w.spd === 0 ? 'wind calm' : `wind ${String(w.dir).padStart(3, '0')} at ${w.spd} kt${w.gst ? ` gusting ${w.gst}` : ''}`);
  const visTxt = (v) => (v == null ? '' : v >= 6 ? 'visibility 6 miles or better' : `visibility ${v} ${v === 1 ? 'mile' : 'miles'}`);
  const ceilTxt = (c) => (c == null ? 'no ceiling' : `ceiling ${n(c)} ft`);
  const wxFlags = (f) => { f = f || {}; const o = []; if (f.thunder) o.push('thunderstorms'); if (f.freezingPrecip) o.push('freezing precipitation'); if (f.snow) o.push('snow'); if (f.heavyRain) o.push('heavy rain'); else if (f.rain || f.showers || f.drizzle) o.push('rain'); if (f.fog) o.push('fog'); return o.join(', '); };
  const cond = (j) => (j ? [j.category, ceilTxt(j.ceiling), visTxt(j.vis), wxFlags(j.flags)].filter(Boolean).join(', ') : 'no forecast available');
  const rwyTxt = (s) => { const r = s && s.runway; if (!r || r.none) return ''; return `runway ${r.id}, ${n(r.len)} ft, ${r.head >= 0 ? `headwind ${r.head}` : `tailwind ${-r.head}`} kt, crosswind ${r.crossG} kt`; };
  const facts = (b, lv, cat) => (b.factors || []).filter((f) => f.level === lv && (!cat || cat.test(f.category)));
  const moist = (s) => { const f = (s && s.judged && s.judged.flags) || {}; const j = (s && s.judged) || {}; return !!(f.rain || f.snow || f.drizzle || f.showers || f.fog || f.freezingPrecip || f.thunder || (j.vis != null && j.vis < 1) || (j.ceiling != null && j.ceiling < 1000)); };

  function synopsis(b) {
    const p = b.plan, d = b.decision, dep = st(b, 'departure'), dst = st(b, 'destination'), alt = st(b, 'alternate'), L = [];
    L.push(`${d.verdict === 'GO' ? 'The briefing result is go.' : d.verdict === 'NO-GO' ? 'The briefing result is no-go.' : 'The briefing result is go with cautions.'} ${d.counts ? `${d.counts.nogo || 0} limiting and ${d.counts.caution || 0} cautionary items.` : ''}`);
    L.push(`Flight from ${apt(dep) || p.dep} to ${apt(dst) || p.dest}, departing ${zt(p.etd)}, ${p.eteMin} minutes en route at FL${Math.round(p.cruiseAlt / 100)}, ${p.rules === '135' ? 'Part 135' : 'Part 91'}.`);
    if (dep) L.push(`Departure, ${dep.id}: ${cond(dep.judged)}, ${windTxt(dep.windUsed)}. ${rwyTxt(dep) ? `Expect ${rwyTxt(dep)}.` : ''}${dep.field && dep.field.requiredFt ? ` Takeoff needs ${n(dep.field.requiredFt)} ft.` : ''}`);
    const hz = (b.hazards || []).length, t = b.turbulence, w = b.range;
    L.push(`En route: ${hz ? `${hz} advisor${hz === 1 ? 'y' : 'ies'} on the route` : 'no SIGMETs or AIRMETs on the route at your altitude'}.${w && w.avgWindComponentKt != null ? ` Average ${w.avgWindComponentKt < 0 ? `headwind ${-w.avgWindComponentKt}` : `tailwind ${w.avgWindComponentKt}`} kt.` : ''}${t && t.available && t.text ? ' Turbulence: ' + t.text.split('. ')[0].replace(/\(peak EDR [\d.]+\)/, '').trim() + '.' : ''}`);
    if (b.simRadar && b.simRadar.text) L.push(`Radar outlook: ${b.simRadar.text}`);
    if (dst) L.push(`Destination, ${dst.id}, around ${zt(p.eta)}: ${cond(dst.judged)}, ${windTxt(dst.windUsed)}. ${rwyTxt(dst) ? `Expect ${rwyTxt(dst)}.` : ''}${dst.field && dst.field.requiredFt ? ` Landing needs ${n(dst.field.requiredFt)} ft.` : ''}${dst.alternateRequired ? ' An alternate is required.' : ''}`);
    if (alt) L.push(`Alternate, ${alt.id}: ${cond(alt.judged)}.${alt.altMins ? (alt.altMins.ok ? ' It meets alternate minimums.' : ' It is below alternate minimums.') : ''}`);
    if (b.fuel && b.fuel.recommendedLb) L.push(`Fuel: about ${n(b.fuel.recommendedLb)} lb recommended${b.fuel.plannedLb ? `, ${n(b.fuel.plannedLb)} lb planned` : ''}.`);
    const ng = facts(b, 'nogo'), ca = facts(b, 'caution');
    if (ng.length) L.push(`Limiting items: ${ng.slice(0, 4).map((f) => f.title).join('. ')}.`);
    if (ca.length) L.push(`Cautions: ${ca.slice(0, 5).map((f) => f.title).join('. ')}${ca.length > 5 ? `, and ${ca.length - 5} more` : ''}.`);
    if (b.dataGaps) L.push('Some data sources were unavailable, so check those items another way.');
    L.push('This is advisory only. Get an official briefing and check the AFM before flight.');
    return L;
  }

  // AWARES: Aircraft, Weather, Airport, Route, Emergencies, Special considerations
  function awares(b) {
    const p = b.plan, dep = st(b, 'departure'), dst = st(b, 'destination'), alt = st(b, 'alternate'), f = dep && dep.field, L = [];
    const a = [];
    if (b.fuel && b.fuel.recommendedLb) a.push(`fuel ${n(b.fuel.plannedLb || b.fuel.recommendedLb)} lb ${b.fuel.plannedLb ? 'planned' : 'recommended'}`);
    if (f) a.push(`takeoff weight ${n(f.weightLb)} lb${f.assumedWeight ? ' assumed' : ''}`);
    if (f && f.requiredFt) a.push(`takeoff distance ${n(f.requiredFt)} ft with flaps ${f.flaps ?? 15}`);
    L.push(`A, aircraft. ${a.length ? a.join(', ').replace(/^./, (c) => c.toUpperCase()) + '. ' : ''}Review aircraft status, open write-ups and any M E L items.${dep && dep.judged && dep.metar && dep.metar.temp != null && dep.metar.temp <= 10 && moist(dep) ? ' Temperature is 10 degrees or below with visible moisture: plan engine anti-ice on, and use the anti-ice on takeoff data.' : ''}`);
    L.push(`W, weather. Departure ${dep ? dep.id + ': ' + cond(dep.judged) + ', ' + windTxt(dep.windUsed) : 'not available'}. ${b.turbulence && b.turbulence.text ? b.turbulence.text.split('. ')[0].replace(/\(peak EDR [\d.]+\)/, '').trim() + '. ' : ''}${(b.hazards || []).length ? `${b.hazards.length} advisories on the route. ` : ''}Destination ${dst ? dst.id + ': ' + cond(dst.judged) : 'not available'}.${alt ? ` Alternate ${alt.id}: ${cond(alt.judged)}.` : ''}`);
    const nt = facts(b, 'caution', /NOTAM/).concat(facts(b, 'nogo', /NOTAM/)).filter((x) => dep && x.where === dep.id);
    const r = dep && dep.runway && !dep.runway.none ? dep.runway : null;
    L.push(`A, airport. ${dep ? apt(dep) : p.dep}, elevation ${dep && dep.elev != null ? n(Math.round(dep.elev * 3.28084)) : 'unknown'} ft. ${r ? `Expect ${rwyTxt(dep)}${r.marginFt != null ? `, ${n(Math.abs(r.marginFt))} ft ${r.marginFt >= 0 ? 'more than' : 'short of'} the takeoff distance` : ''}. ` : ''}${nt.length ? nt.slice(0, 3).map((x) => x.title.replace(/^\w+: /, '')).join('. ') + '. ' : dep && dep.notams ? 'No runway closures in the NOTAMs loaded. ' : 'NOTAMs were not loaded: check them. '}Brief the taxi route and hot spots from the airport diagram.`);
    const pr = b.routing && b.routing.procedures, sid = pr && pr.sid && pr.sid.pick, star = pr && pr.star && pr.star.pick;
    L.push(`R, route. ${sid ? `${sid.name} departure${sid.code ? ', ' + sid.code.split('.')[0] : ''}. ` : 'No departure procedure is in the plan: brief the clearance as received. '}${pr && pr.route && pr.route.string ? `Route ${pr.route.string}. ` : ''}Cruise FL${Math.round(p.cruiseAlt / 100)}, ${p.distanceNm} nautical miles, ${p.eteMin} minutes.${star ? ` Arrival ${star.name}.` : ''} Confirm the initial altitude, heading and departure frequency from the clearance.`);
    const dj = dep && dep.judged, low = dj && ((dj.ceiling != null && dj.ceiling < 500) || (dj.vis != null && dj.vis < 1.5));
    L.push(`E, emergencies. Before V 1, any serious malfunction is an abort. At or after V 1, continue, fly V 2 to the level-off altitude, then handle it as an in-flight emergency. ${low ? `Departure weather is low, so a return may not be possible: name a takeoff alternate within one hour.` : `Departure weather allows a return${r ? ` to runway ${r.id}` : ''}.`} State the minimum safe altitude and the engine-out procedure for this runway from the chart.`);
    const sp = facts(b, 'nogo').concat(facts(b, 'caution')).filter((x) => !/NOTAM/.test(x.category)).slice(0, 5).map((x) => x.title);
    L.push(`S, special considerations. ${sp.length ? sp.join('. ') + '.' : 'No cautions were raised for this flight.'}${r && r.crossG >= 15 ? ` Crosswind ${r.crossG} kt on departure.` : ''} Questions or concerns?`);
    return L;
  }

  // Takeoff brief, in the order of the standard briefing in the pilot client guide
  function takeoff(b) {
    const p = b.plan, dep = st(b, 'departure'), f = dep && dep.field, r = dep && dep.runway && !dep.runway.none ? dep.runway : null, ra = f && f.ra, L = [];
    const ai = dep && dep.metar && dep.metar.temp != null && dep.metar.temp <= 10 && moist(dep);
    const sp = f && f.speeds ? f.speeds : ra && ra.v1 ? { v1: ra.v1, vr: ra.vr, v2: ra.v2 } : null;
    L.push(`Takeoff brief for ${dep ? apt(dep) : p.dep}${r ? `, runway ${r.id}` : ''}.`);
    L.push(`This will be a static takeoff with flaps ${f && f.flaps != null ? f.flaps : 15}${ai ? ', engine anti-ice on' : ', anti-ice off unless conditions change'}. For a rolling takeoff add 500 ft to the takeoff distance.`);
    if (f && f.requiredFt) L.push(`Takeoff distance required is ${n(f.requiredFt)} ft at ${n(f.weightLb)} lb${r ? `. Runway ${r.id} is ${n(r.len)} ft, ${n(Math.abs(r.len - f.requiredFt))} ft ${r.len >= f.requiredFt ? 'to spare' : 'short'}` : ''}.`);
    L.push(sp ? `Speeds: V 1 ${sp.v1}${sp.vr ? `, rotate ${sp.vr}` : ''}${sp.v2 ? `, V 2 ${sp.v2}` : ''}.` : 'Speeds: state V 1, V R and V 2 from the takeoff data.');
    if (f && f.afm && f.speeds) L.push(ai ? 'The distance and speeds are from the anti-ice off tables: use the anti-ice on data for this takeoff.' : 'Confirm the speeds against your takeoff data.');
    if (dep) L.push(`${windTxt(dep.windUsed).replace(/^./, (c) => c.toUpperCase())}${r ? `, giving ${r.head >= 0 ? `a headwind of ${r.head}` : `a tailwind of ${-r.head}`} and a crosswind of ${r.crossG} kt` : ''}.`);
    L.push('I will set the thrust levers to the takeoff detent, and you verify takeoff power.');
    L.push('Call airspeed alive, 80 knots cross-check, V 1, rotate, positive rate, and V 2 plus 10.');
    L.push('Monitor the engine instruments and CAS messages, and cross-check both airspeed indicators at 80 knots.');
    L.push('For a serious malfunction before V 1, call abort, and I will execute the abort.');
    L.push('At or after V 1 we continue. Once safely airborne, tell me the malfunction and we handle it as an in-flight emergency.');
    L.push('For a thrust reverser deployment, I fly the aircraft and you do the emergency stow.');
    L.push('For an engine failure or fire, do not identify the engine. Only say whether it is a failure or a fire.');
    const dj = dep && dep.judged;
    L.push(`We fly V 2 to the level-off altitude or the minimum safe altitude, whichever is higher: state both from the performance data and the chart. ${dj && ((dj.ceiling != null && dj.ceiling < 500) || (dj.vis != null && dj.vis < 1.5)) ? 'The weather here is low, so plan the takeoff alternate.' : `Weather here is ${cond(dj)}, so plan to return${r ? ` to runway ${r.id}` : ''}: state the approach.`}`);
    const pr = b.routing && b.routing.procedures, sid = pr && pr.sid && pr.sid.pick;
    L.push(`Departure instructions: ${sid ? `the ${sid.name} departure, ` : ''}${pr && pr.route && pr.route.string ? `then ${pr.route.string}` : 'as cleared'}, climbing to FL${Math.round(p.cruiseAlt / 100)}. State the initial altitude and heading from the clearance.`);
    L.push('State how the navaids and the F M S are set. Any questions?');
    return L;
  }

  // What the speech engine should say for a line of display text
  let IDS = new Set();
  const PH = { L: 'left', R: 'right', C: 'center' };
  function spoken(s) {
    return String(s)
      .replace(/\bFL(\d{3})\b/g, (m, d) => 'flight level ' + d.split('').join(' '))
      .replace(/\brunway (\d{1,2})([LRC])?\b/gi, (m, d, x) => 'runway ' + d.padStart(2, '0').split('').join(' ') + (x ? ' ' + PH[x] : ''))
      .replace(/\b(\d{4})Z\b/g, (m, d) => d.split('').join(' ') + ' Zulu')
      .replace(/\bwind (\d{3}) at\b/g, (m, d) => 'wind ' + d.split('').join(' ') + ' at')
      .replace(/\b[A-Z][A-Z0-9]{3}\b/g, (id) => (IDS.has(id) ? id.split('').join(' ') : id))
      .replace(/\b([A-Z]{2,5}\d[A-Z]?)\.([A-Z]{3,5})\b/g, '$1 $2')
      .replace(/\bkt\b/g, 'knots').replace(/\bft\b/g, 'feet').replace(/\blb\b/g, 'pounds').replace(/\bSM\b/g, 'miles').replace(/\bnm\b/gi, 'nautical miles')
      .replace(/\bVFR\b/g, 'V F R').replace(/\bMVFR\b/g, 'marginal V F R').replace(/\bLIFR\b/g, 'low I F R').replace(/\bIFR\b/g, 'I F R')
      .replace(/\bNOTAMs?\b/g, (m) => (m.endsWith('s') ? 'no-tams' : 'no-tam')).replace(/\bSIGMETs?\b/g, 'sig-mets').replace(/\bAIRMETs?\b/g, 'air-mets').replace(/\bPIREPs?\b/g, 'pilot reports')
      .replace(/\bEDR\b/g, 'E D R').replace(/\bCAS\b/g, 'C A S').replace(/\bETA\b/g, 'E T A').replace(/\bSIC\b/g, 'S I C').replace(/\bPIC\b/g, 'P I C')
      .replace(/(\d),(\d{3})/g, '$1$2').replace(/[()]/g, ', ').replace(/\s+/g, ' ');
  }

  const SY = window.speechSynthesis;
  let queue = [], playing = null, onState = () => {};
  function stop() { queue = []; playing = null; if (SY) SY.cancel(); onState(); }
  function voice() {
    if (!SY) return null;
    const vs = SY.getVoices().filter((v) => /^en/i.test(v.lang));
    let want = null; try { want = localStorage.getItem('audioVoice'); } catch (e) { /* no storage */ }
    return vs.find((v) => v.name === want) || vs.find((v) => /en-US/i.test(v.lang) && v.default) || vs.find((v) => /en-US/i.test(v.lang)) || vs[0] || null;
  }
  function next(rate) {
    if (!queue.length) { playing = null; onState(); return; }
    const u = new SpeechSynthesisUtterance(spoken(queue.shift()));
    const v = voice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = rate; u.onend = () => { if (playing) next(rate); }; u.onerror = () => { if (playing) next(rate); };
    SY.speak(u);
  }
  function play(key, lines, rate) {
    if (!SY) return;
    SY.cancel(); queue = lines.slice(); playing = key; onState();
    // one sentence per utterance: some browsers cut long utterances short
    queue = queue.flatMap((l) => l.replace(/([a-z0-9)][.?!])\s+(?=[A-Z])/g, '$1\u0001').split('\u0001')).map((x) => x.trim()).filter(Boolean);
    setTimeout(() => next(rate), 60);
  }

  function render(b, el) {
    if (!el) return;
    stop();
    IDS = new Set((b.stations || []).map((x) => x.id).concat([b.plan.dep, b.plan.dest, b.plan.alternate]).filter(Boolean));
    const S = [['syn', 'Synopsis', synopsis], ['awares', 'AWARES brief', awares], ['to', 'Takeoff brief', takeoff]].map(([k, t, fn]) => { let lines; try { lines = fn(b); } catch (e) { lines = ['This brief could not be built: ' + e.message]; } return { k, t, lines }; });
    let rate = 1; try { rate = Number(localStorage.getItem('audioRate')) || 1; } catch (e) { /* no storage */ }
    el.innerHTML = `${SY ? '' : '<p class="hint">This browser cannot read text aloud. The briefs are below to read.</p>'}
      <div class="audio-bar">${S.map((s) => `<button type="button" class="btn small" data-play="${s.k}">▶ ${esc(s.t)}</button>`).join('')}
        <button type="button" class="btn small ghost" data-act="pause" hidden>Pause</button><button type="button" class="btn small ghost" data-act="stop" hidden>Stop</button>
        <label class="audio-opt">Speed <select data-opt="rate">${[0.85, 1, 1.15, 1.3].map((r) => `<option value="${r}"${r === rate ? ' selected' : ''}>${r}×</option>`).join('')}</select></label>
        <label class="audio-opt"${SY ? '' : ' hidden'}>Voice <select data-opt="voice"></select></label></div>
      ${S.map((s, i) => `<details class="audio-text"${i === 0 ? ' open' : ''}><summary>${esc(s.t)}: text</summary>${s.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</details>`).join('')}
      <p class="hint">AWARES is read here as Aircraft, Weather, Airport, Route, Emergencies, Special considerations. The takeoff brief follows the standard briefing in the XLS+ pilot client guide; items the tool cannot know (level-off altitude, minimum safe altitude, navaid setup, clearance) are left for you to state. Read aloud by your device, advisory only.</p>`;
    const q = (s) => el.querySelector(s), pauseB = q('[data-act=pause]'), stopB = q('[data-act=stop]');
    onState = () => { el.querySelectorAll('[data-play]').forEach((x) => x.classList.toggle('on', x.dataset.play === playing)); pauseB.hidden = stopB.hidden = !playing; pauseB.textContent = 'Pause'; };
    el.querySelectorAll('[data-play]').forEach((x) => x.addEventListener('click', () => { const s = S.find((y) => y.k === x.dataset.play); if (playing === s.k) stop(); else play(s.k, s.lines, Number(q('[data-opt=rate]').value) || 1); }));
    stopB.addEventListener('click', stop);
    pauseB.addEventListener('click', () => { if (!SY) return; if (SY.paused) { SY.resume(); pauseB.textContent = 'Pause'; } else { SY.pause(); pauseB.textContent = 'Resume'; } });
    q('[data-opt=rate]').addEventListener('change', (e) => { try { localStorage.setItem('audioRate', e.target.value); } catch (er) { /* no storage */ } });
    const vsel = q('[data-opt=voice]');
    const fill = () => { if (!SY) return; const vs = SY.getVoices().filter((v) => /^en/i.test(v.lang)); const cur = voice(); vsel.innerHTML = vs.map((v) => `<option${cur && v.name === cur.name ? ' selected' : ''}>${esc(v.name)}</option>`).join(''); vsel.parentNode.hidden = vs.length < 2; };
    fill(); if (SY) SY.onvoiceschanged = fill;
    vsel.addEventListener('change', () => { try { localStorage.setItem('audioVoice', vsel.value); } catch (er) { /* no storage */ } });
  }
  window.addEventListener('pagehide', () => { if (SY) SY.cancel(); });
  window.AudioBrief = { render, synopsis, awares, takeoff, spoken, stop };
})();
