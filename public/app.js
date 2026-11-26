'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const z = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
};
const local = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const LEVEL = { nogo: 'No-go', caution: 'Caution', info: 'Info', ok: 'OK' };

let fileText = null, fileName = '', map = null, layers = null;

// Default ETD: next whole hour + 1
(function initEtd() {
  const d = new Date(Date.now() + 3600e3);
  d.setMinutes(0, 0, 0);
  const off = d.getTimezoneOffset() * 60e3;
  $('etd').value = new Date(d - off).toISOString().slice(0, 16);
})();

function setFile(f) {
  if (!f) return;
  fileName = f.name;
  const r = new FileReader();
  r.onload = () => { fileText = r.result; $('dropText').innerHTML = `<strong>${esc(f.name)}</strong> loaded. Click to replace.`; $('routeText').value = ''; };
  r.readAsText(f);
}
$('file').addEventListener('change', (e) => setFile(e.target.files[0]));

// NOTAMs: a ForeFlight briefing PDF (read in the browser, never uploaded) or pasted text
let notamFromFile = '', briefingFlight = null;
async function setNotamFile(f) {
  if (!f) return;
  const t = $('notamDropText');
  t.innerHTML = `Reading <strong>${esc(f.name)}</strong>…`;
  try {
    const text = /\.pdf$/i.test(f.name) || f.type === 'application/pdf' ? await window.NotamGuide.readPdf(f) : await f.text();
    const n = window.PreflightEngine.parseNotams(text);
    notamFromFile = text;
    // A ForeFlight briefing also carries the flight itself: fill the form from it
    const fl = window.PreflightEngine.parseBriefing(text);
    briefingFlight = fl;
    let flightNote = '';
    if (fl && fl.waypoints.length >= 2) {
      fileText = null; fileName = '';
      $('dropText').innerHTML = '<strong>Drop a ForeFlight export</strong><br>.fpl (Garmin), .kml or .gpx, or click to choose';
      $('routeText').value = fl.routeText;
      if (fl.etd) { const d = new Date(fl.etd); $('etd').value = new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16); }
      if (fl.cruiseAlt) $('cruiseAlt').value = fl.cruiseAlt;
      if (fl.tas) $('tas').value = fl.tas;
      if (fl.alternate) $('alternate').value = fl.alternate;
      flightNote = `<br>Flight filled in: ${esc(fl.dep)} to ${esc(fl.dest)}${fl.callsign ? ` as ${esc(fl.callsign)}` : ''}${fl.etd ? `, ETD ${esc(fl.etd.slice(11, 16))}Z ${esc(fl.etd.slice(5, 10))}` : ''}${fl.cruiseAlt ? `, FL${fl.cruiseAlt / 100}` : ''}${fl.alternate ? `, alternate ${esc(fl.alternate)}` : ''}.${fl.filedRoute ? `<br>Filed route: <code>${esc(fl.filedRoute)}</code>` : ''}`;
    }
    t.innerHTML = `<strong>${esc(f.name)}</strong>: ${n.length ? `${n.length} NOTAMs found` : 'no NOTAMs found'}. Click to replace.${flightNote}${!n.length && !flightNote ? ' Try pasting the NOTAM text instead.' : ''}`;
  } catch (e) { notamFromFile = ''; t.innerHTML = `Could not read <strong>${esc(f.name)}</strong> (${esc(e.message)}). Try pasting the NOTAM text instead.`; }
}
$('notamFile').addEventListener('change', (e) => setNotamFile(e.target.files[0]));

// ForeFlight Runway Analysis: read in the browser, its figures put in boxes the pilot can check or correct
let raParsed = null, raSource = '';
const RA_IDS = ['raTkRwy', 'raTkDist', 'raTkMtow', 'raLdRwy', 'raLdDist'];
function raClear() { raParsed = null; raSource = ''; RA_IDS.forEach((i) => { $(i).value = ''; }); $('raLdFactor').value = 'actual'; $('raLdWet').checked = false; }
async function setRaFile(f) {
  if (!f) return;
  const t = $('raDropText');
  t.innerHTML = `Reading <strong>${esc(f.name)}</strong>…`;
  try {
    const text = /\.pdf$/i.test(f.name) || f.type === 'application/pdf' ? await window.NotamGuide.readPdf(f) : await f.text();
    const ra = window.PreflightEngine.parseRunwayAnalysis(text);
    $('raFields').open = true;
    if (!ra) { t.innerHTML = `<strong>${esc(f.name)}</strong>: no takeoff or landing distances could be read from this file. Enter the figures in the boxes below. Click to try another file.`; return; }
    raClear(); raParsed = ra; raSource = f.name;
    const n = (x) => Number(x).toLocaleString('en-US'), k = ra.takeoff, l = ra.landing;
    if (k) { $('raTkRwy').value = k.runway || ''; $('raTkDist').value = k.distFt || ''; $('raTkMtow').value = k.mtowLb || ''; }
    if (l) { $('raLdRwy').value = l.runway || ''; $('raLdDist').value = l.distFt || ''; $('raLdFactor').value = l.factor || 'actual'; $('raLdWet').checked = !!l.wet; }
    const bits = [
      k ? `Takeoff${k.airport ? ' ' + esc(k.airport) : ''}${k.runway ? ' runway ' + esc(k.runway) : ''}: ${k.distFt ? n(k.distFt) + ' ft required' : 'no distance found'}${k.mtowLb ? ', maximum ' + n(k.mtowLb) + ' lb' : ''}${k.v1 ? `, V1 ${k.v1}` : ''}${k.vr ? ` VR ${k.vr}` : ''}${k.v2 ? ` V2 ${k.v2}` : ''}` : 'No takeoff figures found',
      l ? `Landing${l.airport ? ' ' + esc(l.airport) : ''}${l.runway ? ' runway ' + esc(l.runway) : ''}: ${n(l.distFt)} ft ${l.factor === 'actual' ? 'unfactored' : 'with the ' + l.factor + '% factor'}${l.wet ? ', wet' : ''}${l.vref ? `, VREF ${l.vref}` : ''}` : 'No landing figures found',
    ];
    t.innerHTML = `<strong>${esc(f.name)}</strong> read. Click to replace.<br>${bits.join('<br>')}<br>Check these against the analysis and correct the boxes below if needed.`;
  } catch (e) { t.innerHTML = `Could not read <strong>${esc(f.name)}</strong> (${esc(e.message)}). Enter the figures in the boxes below instead.`; $('raFields').open = true; }
}
function raBody() {
  const v = (i) => $(i).value.trim(), p = raParsed || {}, k = p.takeoff || {}, l = p.landing || {};
  if (!RA_IDS.some((i) => i !== 'raTkRwy' && i !== 'raLdRwy' && v(i))) return null;
  // speeds and the airport come along only while the boxes still hold what was read from the file
  const tkSame = raParsed && String(k.distFt || '') === v('raTkDist'), ldSame = raParsed && String(l.distFt || '') === v('raLdDist');
  return {
    source: raParsed ? raSource : 'entered by hand',
    takeoff: { distFt: v('raTkDist'), mtowLb: v('raTkMtow'), runway: v('raTkRwy'), ...(tkSame ? { airport: k.airport, wet: k.wet, v1: k.v1, vr: k.vr, v2: k.v2, flaps: k.flaps, limit: k.limit } : {}) },
    landing: { distFt: v('raLdDist'), factor: $('raLdFactor').value, wet: $('raLdWet').checked, runway: v('raLdRwy'), ...(ldSame ? { airport: l.airport, vref: l.vref } : {}) },
  };
}
$('raFile').addEventListener('change', (e) => setRaFile(e.target.files[0]));
$('raClear').addEventListener('click', (e) => { e.preventDefault(); raClear(); $('raDropText').innerHTML = '<strong>Drop your Runway Analysis PDF</strong><br>its takeoff and landing figures replace the Flight Planning Guide tables'; });
const rDrop = $('raDrop');
['dragenter', 'dragover'].forEach((ev) => rDrop.addEventListener(ev, (e) => { e.preventDefault(); rDrop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => rDrop.addEventListener(ev, (e) => { e.preventDefault(); rDrop.classList.remove('over'); }));
rDrop.addEventListener('drop', (e) => setRaFile(e.dataTransfer.files[0]));
const nDrop = $('notamDrop');
['dragenter', 'dragover'].forEach((ev) => nDrop.addEventListener(ev, (e) => { e.preventDefault(); nDrop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => nDrop.addEventListener(ev, (e) => { e.preventDefault(); nDrop.classList.remove('over'); }));
nDrop.addEventListener('drop', (e) => setNotamFile(e.dataTransfer.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));
$('routeText').addEventListener('input', () => { if ($('routeText').value.trim()) { fileText = null; $('dropText').innerHTML = '<strong>Drop a ForeFlight export</strong> (.fpl Garmin, .kml or .gpx) or click to choose'; } });
$('sample').addEventListener('click', async (e) => {
  e.preventDefault();
  const r = await fetch('/samples/KTEB-KPBI.fpl').catch(() => null);
  if (r && r.ok) { fileText = await r.text(); fileName = 'KTEB-KPBI.fpl'; $('dropText').innerHTML = '<strong>KTEB-KPBI.fpl</strong> sample loaded.'; $('alternate').value = 'KFLL'; }
  else { $('routeText').value = 'KTEB SBJ SAWED ORL KPBI'; $('alternate').value = 'KFLL'; }
});
$('printBtn').addEventListener('click', () => window.print());
let lastBrief = null;
$('pdfBtn').addEventListener('click', async () => {
  if (!lastBrief) return;
  const btn = $('pdfBtn'); btn.disabled = true;
  try { await window.BriefPDF.download(lastBrief); } catch (e) { status('Could not make the PDF: ' + e.message, true); } finally { btn.disabled = false; }
});

// Where an alternate-rule figure came from: FAA chart (with a link), the pilot's entry, or an estimate
const srcTag = (x) => (x.auto ? ` <span class="chip">Cat ${esc(x.cat)}, ${esc(x.source)}</span>${x.chart ? ` <a href="${esc(x.chart)}" target="_blank" rel="noopener">chart</a>` : ''}` : x.manual ? ' <span class="chip">your figures</span>' : x.estimate ? ' <span class="chip">estimate</span>' : '');

// Show how old the weather snapshot is
async function freshness() {
  const cfg = window.PREFLIGHT_CONFIG || {};
  if (!cfg.snapshot) return;
  try {
    const m = await (await fetch(`${cfg.snapshot}/meta.json?t=${Date.now()}`)).json();
    const age = Math.round((Date.now() - Date.parse(m.generatedAt)) / 60e3);
    const c = $('freshness');
    c.hidden = false;
    c.className = 'chip' + (age > 45 ? ' old' : age > 20 ? ' stale' : '');
    c.textContent = `Weather data ${age} min old`;
    c.title = `Snapshot generated ${m.generatedAt}`;
  } catch (e) { /* ignore */ }
}
freshness(); setInterval(freshness, 60e3);
const syncRules = () => { $('d135').open = $('rules').value === '135' || $('d135').open; };
$('rules').addEventListener('change', syncRules);

$('planForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const routeText = $('routeText').value.trim();
  if (!fileText && !routeText) return status('Upload a flight plan or type a route first.', true);
  const etdLocal = $('etd').value;
  const body = {
    fileText, filename: fileName, routeText: fileText ? '' : routeText,
    // the briefing's fuel plan applies only while the form still holds the briefing's flight
    ffFuel: briefingFlight && briefingFlight.fuel && !fileText && routeText.trim().toUpperCase().startsWith(briefingFlight.dep) && routeText.trim().toUpperCase().endsWith(briefingFlight.dest) ? briefingFlight.fuel : null,
    ra: raBody(),
    alternate: $('alternate').value.trim(), cruiseAlt: $('cruiseAlt').value, tas: $('tas').value,
    etd: etdLocal ? new Date(etdLocal).toISOString() : null, rules: $('rules').value,
    destCircHaa: $('destCircHaa').value, destCircNa: $('destCircNa').checked, destHat: $('destHat').value, destVisMin: $('destVisMin').value,
    altNavFacilities: $('altNavFacilities').value, altHat: $('altHat').value, altVisMin: $('altVisMin').value, highMinsPic: $('highMinsPic').checked, eod80: !!($('eod80') && $('eod80').checked), sicLow: !!($('sicLow') && $('sicLow').checked), notamText: [notamFromFile, $('notamText').value].filter(Boolean).join('\n\n'), approachCat: $('approachCat').value, altGps: $('altGps').checked,
    mel: melSelected(),
    maxXwind: $('maxXwind').value, maxTailwind: $('maxTailwind').value, minCeiling: $('minCeiling').value, minVis: $('minVis').value, minRunway: $('minRunway').value,
  };
  $('go').disabled = true;
  status('Loading METARs, TAFs, PIREPs, SIGMETs, G-AIRMETs, CWAs, WPC fronts, GFS winds and HRRR/NBM/GFS/ECMWF guidance…', false, true);
  try {
    // The briefing engine runs in the browser; feeds without CORS go through the configured relay.
    if (!window.PreflightEngine) throw new Error('Briefing engine failed to load. Reload the page.');
    const cfg = window.PREFLIGHT_CONFIG || {};
    window.PreflightEngine.configure({ snapshot: cfg.snapshot || null, relay: cfg.relay || null });
    const data = await window.PreflightEngine.run(body);
    $('status').hidden = true;
    render(data);
  } catch (err) {
    status(err.message, true);
  } finally {
    $('go').disabled = false;
  }
});

function status(msg, err, busy) {
  const s = $('status');
  s.hidden = false;
  s.className = 'status' + (err ? ' err' : '');
  s.innerHTML = (busy ? '<span class="spin"></span>' : '') + esc(msg);
}

// A phone can hold an older copy of the page while loading this newer script, so cards added since are
// created here when the page does not have them, and one card failing never stops the rest.
const LATER_CARDS = [['audioCard', 'audio', 'Audio briefing', 'Audio', 'mapCard'], ['riskCard', 'risk', 'Risk analysis', 'Risk', 'audioCard'], ['melCard', 'mel', 'Deferred equipment (MEL)', 'MEL', 'audioCard'], ['fuelCard', 'fuel', 'Fuel recommendation', 'Fuel', 'modelsCard'], ['simCard', 'simradar', 'Simulated radar for the flight', 'Sim radar', 'terminalsCard'], ['turbCard', 'turb', 'Turbulence by route and altitude', 'Turbulence', 'fuelCard']];
function ensureCards() {
  for (const [cardId, bodyId, title, tab, beforeId] of LATER_CARDS) {
    if ($(bodyId)) continue;
    const card = document.createElement('div');
    card.className = 'card'; card.id = cardId;
    card.innerHTML = `<h2>${esc(title)}</h2><div id="${bodyId}"></div>`;
    const before = $(beforeId);
    if (before && before.parentNode) before.parentNode.insertBefore(card, before); else $('results').appendChild(card);
    const tabs = $('tabs');
    if (tabs) { const a = document.createElement('a'); a.href = '#' + cardId; a.textContent = tab; tabs.appendChild(a); }
  }
}
function loadScriptOnce(src) {
  return new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(el); });
}
function renderRisk(b) {
  const el = $('risk'), k = b.risk;
  if (!el) return;
  if (!k) { el.innerHTML = '<p class="hint">The risk analysis could not be built for this briefing.</p>'; return; }
  const cls = k.level === 'low' ? 'go' : k.level === 'moderate' ? 'info' : k.level === 'high' ? 'caution' : 'nogo';
  const bar = (v, c) => `<span class="rbar"><span class="rfill ${c}" style="width:${Math.max(2, Math.min(100, v))}%"></span></span>`;
  el.innerHTML = `
    <div class="rhead"><span class="rscore ${cls}">${k.score}</span><div><div class="rlevel">${esc(k.level.toUpperCase())} <span class="hint">of 100</span></div>
      <div class="rmeter"><span class="rmark" style="left:${Math.min(100, k.score)}%"></span></div>
      <div class="hint">${k.compoundingAdds ? `Hazards on their own: ${k.baseScore}. Compounding between them adds ${k.compoundingAdds}.` : 'No hazards are compounding each other.'}${k.reduce ? ' ' + esc(k.reduce) : ''}</div></div></div>
    ${k.phases.length ? `<div class="rphases">${k.phases.map((p) => `<div class="rphase"><div class="k">${esc(p.name === 'Flight' ? 'Whole flight' : p.name)}</div>${bar(p.score, p.score < 20 ? 'go' : p.score < 45 ? 'info' : p.score < 70 ? 'caution' : 'nogo')}<div class="v">${p.score}</div></div>`).join('')}</div>` : ''}
    ${k.drivers.length ? `<h3>What drives the score</h3><table class="rtable"><tr><th>Hazard</th><th>Phase</th><th>Severity</th><th>Points</th></tr>${k.drivers.map((d) => `<tr><td>${esc(d.label)}</td><td>${esc(d.phase === 'Flight' ? 'Whole flight' : d.phase)}</td><td>${bar(d.severity, d.severity < 30 ? 'go' : d.severity < 60 ? 'caution' : 'nogo')}</td><td>${d.effect}</td></tr>`).join('')}</table>` : '<p class="hint">Nothing in the briefing raises the score.</p>'}
    ${k.compounding.length ? `<h3>Compounding</h3><ul class="rlist">${k.compounding.map((c) => `<li>${esc(c.label)} <span class="hint">(${c.strength})</span></li>`).join('')}</ul>` : ''}
    <p class="hint">Points are how far the score falls if that hazard is removed. ${esc(k.method)} It is recalculated from the current weather, NOTAMs, performance, fuel and crew inputs each time the briefing runs.</p>
    ${k.sources ? `<details><summary>Research behind the weights</summary>${k.sources.map((x) => `<p class="hint"><b>${esc(x.ref)}</b> (<a href="${esc(x.url)}" target="_blank" rel="noopener">source</a>)<br>Found: ${esc(x.found)}<br>Used for: ${esc(x.used)}</p>`).join('')}<p class="hint">${esc(k.judgement || '')}</p></details>` : ''}`;
}
// Deferred equipment (MEL): a picker on the flight form, kept on this device between flights, and a card in the results
function melSelected() { try { return JSON.parse(localStorage.getItem('mel') || '[]').filter((x) => typeof x === 'string'); } catch (e) { return []; } }
function melSave(ids) { try { localStorage.setItem('mel', JSON.stringify(ids)); } catch (e) { /* private mode */ } }
(function melPicker() {
  const go = $('go');
  if (!go || $('melBox') || !window.PreflightEngine || !window.PreflightEngine.melList) return;
  let all = [];
  try { all = window.PreflightEngine.melList(); } catch (e) { return; }
  const byId = new Map(all.map((i) => [i.id, i]));
  const box = document.createElement('details');
  box.id = 'melBox';
  box.innerHTML = `<summary>Deferred equipment (MEL)<span id="melCount"></span></summary>
    <p class="hint">Pick anything deferred on the aircraft. Each item's provisos from the FAA master MEL (560XL, Revision 9) are checked against the flight: icing, night, IMC, RVSM, altitude, precipitation, fuel and time limits. Your approved MEL governs.</p>
    <div id="melChosen" class="melchosen"></div>
    <input type="search" id="melSearch" placeholder="Search: anti-ice, autopilot, 30-20, radar, pressurization…" autocomplete="off" spellcheck="false">
    <div id="melResults" class="melresults"></div>`;
  go.parentNode.insertBefore(box, go);
  const words = (i) => (i.limits.length ? `<span class="mellim">${esc(i.limits.join(', '))}</span>` : '');
  const draw = () => {
    const sel = melSelected().filter((id) => byId.has(id));
    $('melCount').textContent = sel.length ? `: ${sel.length} selected` : '';
    $('melChosen').innerHTML = sel.map((id) => { const i = byId.get(id); return `<div class="melitem on"><button type="button" data-rm="${esc(id)}" aria-label="Remove ${esc(i.short)}">×</button><div><b>${esc(i.short)}</b> <span class="hint">${esc(id)} · category ${esc(i.cat)}</span> ${words(i)}<div class="hint">${esc(i.remarks || 'No provisos in the master MEL.')}</div></div></div>`; }).join('');
    const q = $('melSearch').value.trim().toLowerCase();
    let hits = [];
    if (q.length >= 2) {
      const terms = q.split(/\s+/);
      hits = all.filter((i) => !sel.includes(i.id) && terms.every((t) => (i.id + ' ' + i.item + ' ' + i.section + ' ' + i.limits.join(' ')).toLowerCase().includes(t))).slice(0, 40);
    }
    $('melResults').innerHTML = q.length < 2 ? '' : hits.length ? hits.map((i) => `<button type="button" class="melitem" data-add="${esc(i.id)}"><div><b>${esc(i.item)}</b> <span class="hint">${esc(i.id)} · ${esc(i.section)} · category ${esc(i.cat)}</span> ${words(i)}<div class="hint">${esc((i.remarks || 'No provisos in the master MEL.').slice(0, 220))}${i.remarks.length > 220 ? '…' : ''}</div></div></button>`).join('') : '<p class="hint">Nothing in the master MEL matches. Items with no relief are not listed: without relief the equipment must work.</p>';
  };
  box.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]'), rm = e.target.closest('[data-rm]');
    if (add) { melSave([...melSelected(), add.dataset.add]); $('melSearch').value = ''; draw(); }
    if (rm) { melSave(melSelected().filter((x) => x !== rm.dataset.rm)); draw(); }
  });
  $('melSearch').addEventListener('input', draw);
  $('melSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  if (melSelected().length) box.open = true;
  draw();
})();
function renderMel(b) {
  const el = $('mel'), card = $('melCard'), m = b.mel;
  if (!el) return;
  const tab = [...document.querySelectorAll('#tabs a')].find((a) => a.getAttribute('href') === '#melCard');
  if (card) card.hidden = !m;
  if (tab) tab.hidden = !m;
  if (!m) { el.innerHTML = ''; return; }
  const cls = m.blocked ? 'nogo' : m.conditional ? 'caution' : 'ok';
  el.innerHTML = `<p><span class="pill ${cls}">${m.blocked ? 'No-go' : m.conditional ? 'Conditions' : 'No limit'}</span>${esc(m.summary)}</p>
    ${m.items.map((i) => `<div class="factor ${i.limits.some((l) => l.level === 'nogo') ? 'nogo' : i.limits.some((l) => l.level === 'caution') ? 'caution' : 'ok'}">
      <div><b>${esc(i.short)}</b> <span class="hint">MMEL ${esc(i.id)} · ${esc(i.section)} · category ${esc(i.cat)}${i.repair ? ', repair ' + esc(i.repair) : ''}${i.installed !== '-' ? ` · ${esc(i.installed)} installed, ${esc(i.required)} required` : ''}</span></div>
      ${i.via ? `<div class="d">Counted as inoperative because item ${esc(i.via)} is deferred.</div>` : ''}
      ${i.limits.length ? `<ul class="rlist">${i.limits.map((l) => `<li><span class="pill ${l.level}">${l.level === 'nogo' ? 'No-go' : l.level === 'caution' ? 'Caution' : 'OK'}</span>${esc(l.text)}</li>`).join('')}</ul>` : '<div class="d">No operating limit on this flight.</div>'}
      ${i.procedures.length ? `<div class="d">Requires the ${esc(i.procedures.join(' and the '))} in your MEL.</div>` : ''}
      <details><summary>Master MEL remarks</summary><p class="hint">${esc(i.remarks || 'None.')}</p></details></div>`).join('')}
    <p class="hint">${esc(m.source)}. ${esc(m.note)} Change the list under "Deferred equipment (MEL)" on the flight form.</p>`;
}
function renderAudio(b) {
  const el = $('audio');
  if (!el) return;
  const go = () => { try { window.AudioBrief.render(b, el); } catch (e) { el.textContent = 'The audio briefing could not be built: ' + e.message; } };
  if (window.AudioBrief) go();
  else loadScriptOnce('audio.js?v=' + Date.now()).then(go).catch((e) => { el.textContent = 'The audio briefing could not be loaded: ' + e.message; });
}
function renderSimRadar(b) {
  const el = $('simradar');
  if (!el) return;
  const go = () => { try { window.SimRadar.render(b, el); } catch (e) { el.textContent = 'Simulated radar could not be shown: ' + e.message; } };
  if (window.SimRadar) go();
  else loadScriptOnce('simradar.js?v=' + Date.now()).then(go).catch((e) => { el.textContent = 'Simulated radar could not be shown: ' + e.message; });
}

// Turbulence: flight level against distance on the filed route, the cruise levels and the route options compared
const TURB_COL = { light: '#f5de3c', moderate: '#f5a028', severe: '#e63c28' };
function renderTurb(b) {
  const el = $('turb');
  if (!el) return;
  const T = b.turbulence;
  if (!T || !T.available) { el.innerHTML = `<p>${esc(T ? T.text : 'No turbulence analysis in this briefing.')}</p>`; return; }
  const cell = (c) => (c ? `<td class="num" title="roughest model ${c.max.toFixed(2)}${c.driver ? ', ' + esc(c.driver) : ''}"${TURB_COL[c.cat] ? ` style="background:${TURB_COL[c.cat]};color:${c.cat === 'severe' ? '#fff' : '#111'};font-weight:700"` : ''}>${c.edr.toFixed(2)}</td>` : '<td class="num">–</td>');
  const word = (r) => `<span class="pill ${r.cat === 'smooth' ? 'ok' : r.cat === 'light' ? 'info' : 'caution'}">${esc(r.cat)}</span>`;
  const nm = (r) => (r.modNm + r.sevNm ? `${r.modNm + r.sevNm} nm moderate${r.sevNm ? ' or severe' : ''}${r.lightNm ? `, ${r.lightNm} nm light` : ''}` : r.lightNm ? `${r.lightNm} nm light` : 'none');
  el.innerHTML = `<p><b>${esc(T.text)}</b></p>
    <h3>Filed route: flight level against distance (EDR, middle of ${esc(T.models.join(', '))})</h3>
    <div class="table-wrap"><table class="simstrip"><tr><th>Level</th>${T.cols.map((c) => `<th class="num">${c.alongNm} nm${c.t ? `<div class="hint">${esc(String(c.t).slice(3))}</div>` : ''}</th>`).join('')}</tr>
    ${T.grid.map((r) => `<tr${r.fl === T.plannedFl ? ' class="plannedrow"' : ''}><td><b>FL${r.fl}</b>${r.fl === T.plannedFl ? ' ◂' : ''}</td>${r.cells.map(cell).join('')}</tr>`).join('')}</table></div>
    <div class="legend-row"><span><i class="sw" style="background:${TURB_COL.light}"></i>Light (${T.thresholds.light}+)</span><span><i class="sw" style="background:${TURB_COL.moderate}"></i>Moderate (${T.thresholds.moderate}+)</span><span><i class="sw" style="background:${TURB_COL.severe}"></i>Severe (${T.thresholds.severe}+)</span><span>◂ planned level; hover a cell for the roughest model and the cause</span></div>
    <h3>Cruise levels on the filed route</h3>
    <div class="table-wrap"><table><tr><th>Level</th><th>Ride</th><th class="num">Peak EDR</th><th class="num">Roughest model</th><th>Exposure in cruise</th><th>Main cause at the peak</th></tr>
    ${T.levels.slice().sort((x, y) => y.fl - x.fl).map((r) => `<tr><td><b>FL${r.fl}</b>${r.fl === T.plannedFl ? ' (planned)' : ''}${r.fl === T.best.fl && T.best.changeLevel ? ' <span class="pill ok">smoothest</span>' : ''}</td><td>${word(r)}</td><td class="num">${r.peak.toFixed(2)}</td><td class="num">${r.worst.toFixed(2)}</td><td>${esc(nm(r))}</td><td>${r.cat === 'smooth' || !r.peakAt ? '' : esc(`${r.peakAt.driver || 'shear'} near ${r.peakAt.s} nm`)}</td></tr>`).join('')}</table></div>
    <h3>Route options</h3>
    <div class="table-wrap"><table><tr><th>Route</th><th>At FL${T.plannedFl}</th><th>Smoothest level</th><th class="num">Time</th></tr>
    ${T.routes.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.name === T.best.route && T.best.changeRoute ? ' <span class="pill ok">smoothest</span>' : ''}</td><td>${word(r.atPlanned)} ${r.atPlanned.peak.toFixed(2)}, ${esc(nm(r.atPlanned))}</td><td>FL${r.best.fl}: ${word(r.best)} ${r.best.peak.toFixed(2)}, ${esc(nm(r.best))}</td><td class="num">${r.filed ? '' : (r.extraMin >= 0 ? '+' : '') + r.extraMin + ' min'}</td></tr>`).join('')}</table></div>
    <p class="hint">${esc(T.method)}</p>`;
}

// Part 135 landing limits at a destination or alternate: the 60% rule and the 80% eligible on-demand allowance
function p135Html(s, b) {
  const p = s.field && s.field.part135;
  if (!p || !p.runway || b.plan.rules !== '135') return '';
  const n = (x) => x.toLocaleString('en-US');
  return p.options.map((o) => {
    const used = p.uses === o.key;
    return `<div class="rule"><span class="pill ${o.suitable ? 'ok' : used ? 'nogo' : 'info'}">${o.key}% ${o.suitable ? 'ok' : 'short'}</span><span><b>${esc(o.rule)}</b>${used ? ' (applied)' : ''}: land within ${esc(o.label)}. Needs ${n(o.dryFt)} ft${p.raWet ? ' (the analysis figure is already for a wet runway)' : ' dry'}${p.raWet ? '' : p.wet ? `, ${n(o.wetFt)} ft wet (+15%${o.key === '80' ? ', reference only: your Destination Airport Analysis sets the wet margin' : ', 135.385(d)'})` : ''}; runway ${esc(p.runway)} is ${n(p.runwayFt)} ft${p.longestFt > p.runwayFt ? `, longest ${n(p.longestFt)} ft` : ''} (${o.marginFt >= 0 ? n(o.marginFt) + ' ft to spare' : n(-o.marginFt) + ' ft short'}${p.wet ? ' on the wet figure' : ''}).${o.key === '80' && !p.eod ? ' Available only to an eligible on-demand operator with an approved Destination Airport Analysis and OpSpec authorization.' : ''}</span></div>`;
  }).join('') + (p.eod && p.picMust && p.picMust.length ? `<div class="hint">PIC must make this landing if the SIC has under 100 h in type (135.4): ${esc(p.picMust.join('; '))}.</div>` : '');
}

function render(b) {
  $('results').hidden = false;
  $('printBtn').hidden = false;
  $('pdfBtn').hidden = false;
  lastBrief = b;
  ensureCards();
  const failed = [];
  for (const fn of [renderVerdict, renderFactors, renderMap, renderSurface, renderTerminals, renderWinds, renderHazards, renderFuel, renderTurb, renderSimRadar, renderRisk, renderMel, renderAudio, renderPireps, renderEnroute, renderNotams, renderSources, renderRouting, renderModels]) {
    try { fn(b); } catch (e) { failed.push(fn.name.replace(/^render/, '')); if (window.console) console.error(fn.name, e); }
  }
  if (failed.length) status(`Briefing ready, but these sections could not be shown: ${failed.join(', ')}. Reload the page to get the latest version.`, true);
  $('results').scrollIntoView({ behavior: 'smooth' });
}

function renderVerdict(b) {
  const d = b.decision, p = b.plan, r = b.range || {};
  const cls = d.verdict === 'GO' ? 'v-go' : d.verdict === 'NO-GO' ? 'v-nogo' : 'v-caution';
  const dest = b.stations.find((s) => s.role === 'destination');
  const alt = b.routing && b.routing.altitude, rec = b.routing && b.routing.route && b.routing.route.recommendation;
  const stat = (k, v, s) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  $('verdict').className = `card verdict ${cls}`;
  $('verdict').innerHTML = `
    <div class="vhead"><span class="vword">${esc(d.verdict)}</span><span class="vline">${esc(d.headline)}</span></div>
    <div class="stats">
      ${stat('Route', `${esc(p.dep)} → ${esc(p.dest)}`, p.alternate ? `alternate ${esc(p.alternate)}` : 'no alternate filed')}
      ${stat('Distance / ETE', `${p.distanceNm} nm · ${Math.floor(p.eteMin / 60)}:${String(p.eteMin % 60).padStart(2, '0')}`, `FL${Math.round(p.cruiseAlt / 100)} · ${p.tas} KTAS`)}
      ${stat('ETD → ETA', `${z(p.etd)} → ${z(p.eta)}`, `${esc(local(p.etd))} → ${esc(local(p.eta))} local`)}
      ${stat('Wind / range', `${r.avgWindComponentKt != null ? (r.avgWindComponentKt > 0 ? '+' : '') + r.avgWindComponentKt + ' kt' : '—'}`, `${r.equivalentStillAirNm ?? '—'} of ~${r.stillAirRangeNm ?? '—'} ESAD nm`)}
      ${dest && dest.altTest ? stat(`Alternate (${dest.altTest.rule})`, dest.alternateRequired ? 'Required' : dest.alternateAdvised ? 'Advised (models)' : 'Not required', `${dest.altTest.basedOn ? 'from ' + dest.altTest.basedOn.replace(/ \(.*/, '') + ', ' : ''}needs ${dest.altTest.ceilNeed.toLocaleString()} ft / ${dest.altTest.visNeed} SM`) : ''}
      ${alt ? stat('Best altitude', `FL${alt.best}`, 'weather, wind and fuel') : ''}
      ${rec ? stat('Route option', rec.keepFiled ? 'Keep filed' : 'Re-route', rec.keepFiled ? '' : esc(rec.best.name)) : ''}
    </div>
    <div class="meta">
      <span>Route <b>${esc(p.route.map((w) => w.id).join(' '))}</b></span>
      <span>Part ${esc(p.rules)} · ${esc(b.aircraft.name)}</span>
      <span>Generated ${z(b.generatedAt)}${b.dataAsOf ? ` · weather data as of <b>${z(b.dataAsOf)}</b> (${Math.round((Date.now() - Date.parse(b.dataAsOf)) / 60e3)} min old)` : ''}</span>
    </div>
    <ul class="reason">${d.reasoning.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

function renderFactors(b) {
  const f = b.factors;
  const groups = [['nogo', 'Limiting'], ['caution', 'Needs a plan'], ['info', 'For awareness'], ['ok', 'Checked and OK']];
  $('factors').innerHTML = f.length
    ? groups.map(([lv, title]) => { const list = f.filter((x) => x.level === lv); return list.length ? `<div class="fgroup">${title} (${list.length})</div>` + list.map((x) => `<div class="factor ${x.level}"><div class="t"><span class="pill ${x.level}">${LEVEL[x.level]}</span>${esc(x.title)}</div><div class="d">${esc(x.detail)}</div></div>`).join('') : ''; }).join('')
    : '<p>No significant factors found.</p>';
}

function renderMap(b) {
  if (window.SurfaceMap) window.SurfaceMap.render(b).catch((e) => console.error(e));
}

function renderSurface(b) {
  const sf = b.surface;
  if (!sf || !sf.available) { $('surface').innerHTML = '<p>WPC coded surface analysis was unavailable. Review the charts below directly.</p>'; }
  else {
    const fr = sf.fronts.slice(0, 8);
    const cs = sf.reading;
    const method = sf.method ? `<p class="hint">Read in this order: find the lows first, check upper-level support, treat fronts as sloping zones, read the surface winds for the low's track, then check upstream.${cs ? ` Flow aloft: ${cs.flow === 'sw' ? 'southwesterly (supports lows)' : cs.flow === 'nw' ? 'northwesterly (clearing)' : cs.flow === 'w' ? 'flat westerly (little support)' : cs.flow ? 'closed low nearby' : 'n/a'}${cs.w500 ? ` ${String(cs.w500.dir).padStart(3, '0')}°/${cs.w500.spd} kt at 500 mb` : ''}${cs.lapse != null ? `; lapse rate ${cs.lapse}°C per 1,000 ft (2.0 is the line between stable and unstable)` : ''}${cs.betterWeather ? `; better weather to the ${cs.betterWeather}` : ''}.` : ''}</p>` : '';
    $('surface').innerHTML = `${method}<div class="sfc">${(sf.narrative || []).map((p) => `<h3>${esc(p.heading)}</h3><p>${esc(p.text)}</p>`).join('')}</div>
      ${fr.length ? `<h3>Fronts within 400 nm</h3><div class="table-wrap"><table><tr><th>Feature</th><th>Now from route</th><th>Motion</th><th>During flight</th><th>${esc(b.plan.dep)} passage</th><th>${esc(b.plan.dest)} passage</th></tr>
      ${fr.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${f.nearestNowNm} nm</td><td>${f.motion ? (f.motion.speedKt < 5 ? 'Nearly stationary' : `${f.motion.towardCompass} ${f.motion.speedKt} kt`) : '—'}</td><td>${f.crossesRoute ? `<b>Crosses at ${f.encounter.alongRouteNm} nm, ~${z(f.encounter.time)}</b>` : `≥ ${f.encounter.distNm} nm away`}</td><td>${f.depPassage ? z(f.depPassage) : '—'}</td><td>${f.destPassage ? z(f.destPassage) : '—'}</td></tr>`).join('')}</table></div>` : ''}
      <p class="hint">Fronts and pressure centers decoded from the WPC coded surface analysis (valid ${z(sf.analysisValid)}) and 12/24 h progs; motion is the displacement between analysis and 12 h prog, projected to your flight times.</p>`;
  }
  $('charts').innerHTML = b.charts.map((c) => `<figure><img loading="lazy" src="${esc(c.url)}" referrerpolicy="no-referrer" alt="${esc(c.label)}" onerror="this.closest('figure').remove()"><figcaption>${esc(c.label)}</figcaption></figure>`).join('');
  $('charts').querySelectorAll('img').forEach((img) => img.addEventListener('click', () => {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${img.src}">`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
  }));
}

function windStr(w) {
  if (!w) return '—';
  return `${w.vrb ? 'VRB' : w.dir != null ? String(w.dir).padStart(3, '0') : '—'}/${w.spd}${w.gst ? 'G' + w.gst : ''} kt`;
}
function renderTerminals(b) {
  $('terminals').innerHTML = b.stations.map((s) => {
    const rw = s.runway;
    const j = s.judged;
    return `<div class="term">
      <h3>${esc(s.id)} · ${esc(s.role)} <span class="hint">${esc(s.name)}</span></h3>
      <div class="hint">Window ${z(s.window[0])}–${z(s.window[1])}, judged from ${esc(s.judgedFrom)}</div>
      ${s.metar ? `<div class="raw"><span class="pill ${s.metar.category}">${s.metar.category}</span>${esc(s.metar.raw)}</div>` : '<div class="raw">No METAR</div>'}
      ${s.taf ? `<div class="raw">${esc(s.taf)}</div>` : '<div class="raw">No TAF</div>'}
      ${j ? `<div>Planning conditions: ceiling <b>${j.ceiling ?? 'none'}</b> ft, visibility <b>${j.vis ?? '—'}</b> SM, <span class="pill ${j.category}">${j.category}</span>${s.forecast && s.forecast.worst && s.forecast.worst.category !== j.category ? ` worst TEMPO/PROB <span class="pill ${s.forecast.worst.category}">${s.forecast.worst.category}</span>` : ''}</div>` : ''}
      ${s.altTest ? `<div class="rule"><span class="pill ${s.alternateRequired || s.alternateAdvised ? 'caution' : 'ok'}">${s.alternateRequired ? 'Alt req' : s.alternateAdvised ? 'Alt advised' : 'No alt'}</span><span><b>${esc(s.altTest.rule)}</b>: needs ≥ ${s.altTest.ceilNeed.toLocaleString()} ft and ${s.altTest.visNeed} SM from ETA−1 h to ETA+1 h (${esc(s.altTest.basis)}). Forecast ${s.altTest.prevailing.ceiling != null ? s.altTest.prevailing.ceiling + ' ft' : 'no ceiling'} / ${s.altTest.prevailing.vis ?? '—'} SM${s.altTest.worst && !s.altTest.worst.ok ? `, TEMPO/PROB ${s.altTest.worst.ceiling ?? 'no ceiling'} / ${s.altTest.worst.vis ?? '—'} SM` : ''} (${esc(s.altTest.basedOn || '')}).${s.altTest.models && s.altTest.models.length ? ` Models: ${s.altTest.models.map((m) => `${esc(m.model)} ${m.ceiling != null ? m.ceiling + ' ft' : 'no low ceiling'}/${m.vis ?? '—'} SM${m.ok ? '' : ' ✗'}`).join(', ')}.` : ''}${srcTag(s.altTest)}</span></div>` : ''}
      ${s.altMins ? `<div class="rule"><span class="pill ${s.altMins.ok ? 'ok' : 'nogo'}">${s.altMins.ok ? 'Legal alt' : 'Below'}</span><span><b>${esc(s.altMins.rule)}</b>: ${s.altMins.none ? esc(s.altMins.basis) : `alternate minimums ${s.altMins.ceil} ft / ${s.altMins.vis} SM (${esc(s.altMins.basis)}).`}${srcTag(s.altMins)}${s.altMins.published ? `<br><span class="hint">FAA alternate minimums entry: ${esc(s.altMins.published)}</span>` : ''}</span></div>` : ''}
      ${rw && !rw.none ? `<div>Wind used ${windStr(s.windUsed)} → best runway <b>${esc(rw.id)}</b> (${rw.len.toLocaleString('en-US')} ft${rw.requiredFt ? `, ${rw.requiredFt.toLocaleString('en-US')} ft needed for ${s.field.kind}` : ''}): <span class="${rw.head < 0 ? 'head' : ''}">${rw.head >= 0 ? 'head' : 'tail'} ${Math.abs(rw.head)} kt</span>, crosswind ${rw.cross}${rw.crossG !== rw.cross ? ` (gust ${rw.crossG})` : ''} kt</div>
      ${p135Html(s, b)}
      ${s.field ? `<div class="hint">${esc(s.field.basis)}${s.field.kind === 'landing' && s.field.actualFt ? `. Actual ${s.field.actualFt.toLocaleString('en-US')} ft, with the 60% factor ${s.field.factoredFt.toLocaleString('en-US')} ft${s.field.part135 ? `, with the 80% eligible on-demand factor ${s.field.part135.options[1].dryFt.toLocaleString('en-US')} ft` : ''}, VREF ${s.field.vref} kt${s.field.vapp ? `, VAPP ${s.field.vapp} kt` : ''}${s.field.wet ? `. Wet runway (AFM advisory data, with thrust reversers): ${s.field.wet.vrefFt.toLocaleString('en-US')} ft at VREF, ${s.field.wet.plus10Ft.toLocaleString('en-US')} ft at VREF + 10 kt` : ''}` : s.field.ra && s.field.ra.distFt ? '' : s.field.actualFt ? `: ${s.field.actualFt.toLocaleString('en-US')} ft` : ': ' + esc(s.field.reason || 'not available')}. ${s.field.ra && s.field.ra.distFt ? `From your ForeFlight Runway Analysis${s.field.ra.fpgFt ? ` (the Flight Planning Guide gives ${s.field.ra.fpgFt.toLocaleString('en-US')} ft dry, zero wind)` : ''}${s.field.kind === 'takeoff' && s.field.ra.v1 ? `; V1 ${s.field.ra.v1}${s.field.ra.vr ? `, VR ${s.field.ra.vr}` : ''}${s.field.ra.v2 ? `, V2 ${s.field.ra.v2}` : ''} kt` : ''}${s.field.kind === 'takeoff' && s.field.ra.mtowLb ? `; maximum allowable takeoff weight ${s.field.ra.mtowLb.toLocaleString('en-US')} lb` : ''}.` : s.field.afm ? (s.field.kind === 'takeoff' ? 'Zero wind figures agree with the XLS+ Flight Planning Guide.' : 'Zero wind figure and VREF from the XLS+ Flight Planning Guide.') : 'From the XLS+ Flight Planning Guide.'}</div>` : ''}` : ''}
      ${s.tafPeriods && s.tafPeriods.length ? `<div class="table-wrap"><table><tr><th>Group</th><th>Valid</th><th>Wind</th><th>Vis</th><th>Ceiling</th><th>Wx</th></tr>${s.tafPeriods.map((p) => `<tr><td>${esc(p.change)}${p.probability ? ' ' + p.probability : ''}</td><td>${z(p.from)}–${z(p.to)}</td><td>${windStr(p.wind)}</td><td>${p.vis ?? '—'}</td><td>${p.ceiling ?? '—'}</td><td>${esc(p.wx)}</td></tr>`).join('')}</table></div>` : ''}
    </div>`;
  }).join('');
}

function renderWinds(b) {
  if (!b.winds.length) { $('winds').innerHTML = '<p>Winds aloft unavailable (GFS via Open-Meteo did not respond). Groundspeed uses TAS only.</p>'; return; }
  const r = b.range;
  $('winds').innerHTML = `<div class="table-wrap"><table><tr><th>Along route</th><th>Time</th><th>Level</th><th>Wind</th><th>Component</th><th>Temp</th><th>ISA dev</th><th>Freezing level</th></tr>
    ${b.winds.map((w) => `<tr><td class="num">${w.alongNm} nm</td><td>${z(w.time)}</td><td>${w.levelHpa} hPa</td><td class="num">${String(w.dir).padStart(3, '0')}°/${w.spd} kt</td><td class="num ${w.component < 0 ? 'head' : 'tail'}">${w.component > 0 ? '+' : ''}${w.component} kt</td><td class="num">${w.temp}°C</td><td class="num">${w.isaDev > 0 ? '+' : ''}${w.isaDev}</td><td class="num">${w.freezingLevelFt ? w.freezingLevelFt.toLocaleString() + ' ft' : '—'}</td></tr>`).join('')}
  </table></div>
  <p class="hint">Average wind component ${r.avgWindComponentKt > 0 ? '+' : ''}${r.avgWindComponentKt ?? 0} kt. Route ${r.routeNm} nm + alternate ${r.alternateLegNm} nm = ${r.equivalentStillAirNm} equivalent still-air nm vs ~${r.stillAirRangeNm} nm XLS+ NBAA-IFR range. Source: ${esc(b.windsSource || 'NOAA GFS via Open-Meteo')}, nearest pressure level to cruise altitude.</p>`;
}

function renderHazards(b) {
  const h = b.hazards;
  $('hazards').innerHTML = h.length
    ? h.sort((a, c) => a.alongNm - c.alongNm).map((x) => `<div class="factor"><div class="t">${esc(x.label)} <span class="hint">at ${x.alongNm} nm, ~${z(x.at)}${x.base != null || x.top ? ` · ${x.base ?? 'SFC'}–${x.top ?? '?'} ft` : ''}</span></div>${x.raw ? `<div class="raw">${esc(x.raw)}</div>` : ''}</div>`).join('')
    : '<p>No SIGMETs, Convective SIGMETs, G-AIRMETs or CWAs intersect the route at your planned altitudes and times.</p>';
}

function renderPireps(b) {
  const p = b.pireps;
  $('pireps').innerHTML = p.length
    ? `<div class="table-wrap"><table><tr><th>At</th><th>Alt</th><th>Type</th><th>Turb</th><th>Ice</th><th>Report</th></tr>${p.slice(0, 40).map((x) => `<tr${x.relevant ? '' : ' style="opacity:.55"'}><td class="num">${x.alongNm} nm</td><td class="num">${altStr(x.alt)}</td><td>${esc(x.ac || '')}</td><td>${esc(x.turb)}</td><td>${esc(x.ice)}</td><td><code>${esc(x.raw)}</code></td></tr>`).join('')}</table></div><p class="hint">Faded rows are away from your vertical profile: more than 4,000 ft from your cruise level, or not on the climb/descent path near the terminals.</p>`
    : '<p>No PIREPs within 60 nm of the route in the last 2 hours.</p>';
}

const altStr = (a) => (!a ? '—' : a >= 18000 ? 'FL' + Math.round(a / 100) : a.toLocaleString() + ' ft');

function renderEnroute(b) {
  const e = b.enroute;
  $('enroute').innerHTML = e.length
    ? `<div class="table-wrap"><table><tr><th>At</th><th>Cat</th><th>Observation</th></tr>${e.slice(0, 60).map((m) => `<tr><td class="num">${m.alongNm} nm</td><td><span class="pill ${m.cat}">${esc(m.cat)}</span></td><td><code>${esc(m.raw)}</code></td></tr>`).join('')}</table></div>`
    : '<p>No en-route METARs within 35 nm.</p>';
}

function renderFuel(b) {
  const f = b.fuel;
  if (!f) { $('fuel').innerHTML = '<p>Fuel recommendation unavailable.</p>'; return; }
  const n = (x) => (x == null ? '—' : x.toLocaleString('en-US'));
  const st = (k, v) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
  const row = (l, cls) => `<tr><td><b>${esc(l.label)}</b>${cls ? ` <span class="chip">${cls}</span>` : ''}</td><td class="num">${n(l.lb)}</td><td>${esc(l.why)}</td></tr>`;
  $('fuel').innerHTML = `<div class="rec ${f.level === 'info' ? '' : 'change'}"><b>${f.plannedLb != null ? (f.level === 'nogo' ? 'Planned fuel is below the minimum' : f.level === 'caution' ? `Recommend ${n(f.recommendedLb)} lb block fuel` : 'Planned fuel covers the recommendation') : `Recommend about ${n(f.recommendedLb)} lb block fuel`}</b>${esc(f.text)}</div>
    <div class="stats">${st('Minimum', n(f.minimumLb) + ' lb')}${st('Recommended', n(f.recommendedLb) + ' lb')}${f.plannedLb != null ? st('Planned (ForeFlight)', n(f.plannedLb) + ' lb') + st('Landing fuel as planned', n(f.landingLb) + ' lb') : ''}</div>
    <div class="table-wrap"><table><tr><th>Item</th><th>lb</th><th>Basis</th></tr>${f.lines.map((l) => row(l, l.advisory ? 'advised' : '')).join('')}${f.extras.map((l) => row(l, 'contingency')).join('')}</table></div>
    ${f.notes.length ? `<p>${f.notes.map(esc).join(' ')}</p>` : ''}
    <p class="hint">Based on: ${esc(f.basis)}. Limits used: ${n(f.limits.usableFuelLb)} lb usable fuel, ${n(f.limits.maxTakeoffLb)} lb maximum takeoff, ${n(f.limits.maxLandingLb)} lb maximum landing. Advisory only: the AFM, your weight and balance and your OpSpecs govern.</p>`;
}

function renderNotams(b) { window.NotamGuide.render(b, $('notams')); }

function renderSources(b) {
  $('sources').innerHTML = b.sources.map((s) => `<div class="src"><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '✓' : '✗'}</span><span><b>${esc(s.name)}</b> · ${esc(s.desc)}</span></div>`).join('')
    + (b.errors.length ? `<h3>Issues</h3>${b.errors.map((e) => `<div class="hint">${esc(e.source)}: ${esc(e.error)}</div>`).join('')}` : '')
    + `<p class="hint">${esc(b.disclaimer)}</p>`;
}

function renderRouting(b) {
  const r = b.routing;
  if (!r) { $('routing').innerHTML = '<p>Route options unavailable.</p>'; return; }
  const rec = r.route.recommendation, alt = r.altitude;
  const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  const pr = r.procedures;
  const procRow = (label, x, kind) => (x ? `<tr><td><b>${label}</b></td><td><code>${esc(x.pick.code)}</code>${x.pick.rnav ? ' <span class="chip">RNAV</span>' : ''}</td><td>${esc(x.text.replace(/^[^:]*: /, ''))}${x.options.length > 1 ? `<div class="hint">Other ${kind}s: ${x.options.slice(1).map((o) => `${esc(o.code)} (${o.extraNm ? '+' + o.extraNm + ' nm' : 'same distance'}${o.wx.hits.length ? ', crosses weather' : ''})`).join(', ')}</div>` : ''}</td></tr>` : '');
  const procHtml = pr && (pr.sid || pr.star || pr.approach) ? `
    <div class="rec"><b>Recommended route with procedures</b>Built on the ${esc(pr.base)}${pr.depRunway ? `, departing runway ${esc(pr.depRunway)}` : ''}${pr.destRunway ? `, landing runway ${esc(pr.destRunway)}` : ''} (the runways the wind favors${b.notams && b.notams.source === 'briefing' ? ' and NOTAMs leave open' : ''}).<div class="raw">${esc(pr.route.string)}</div></div>
    <div class="table-wrap"><table>
      ${procRow('SID', pr.sid, 'SID')}${procRow('STAR', pr.star, 'STAR')}
      ${pr.approach ? `<tr><td><b>Approach</b></td><td><code>${esc(pr.approach.pick.proc)}</code></td><td>${esc(pr.approach.text.replace(/^[^:]*: /, ''))} ${pr.approach.chart ? `<a href="${esc(pr.approach.chart)}" target="_blank" rel="noopener">chart</a>` : ''}</td></tr>` : ''}
    </table></div>
    ${pr.notes.length ? `<p class="hint">${esc(pr.notes.join(' '))}</p>` : ''}
    <p class="hint">ATC assigns the actual SID, STAR and approach. Check each chart for altitude, speed and equipment restrictions.</p>` : pr && pr.notes.length ? `<p class="hint">${esc(pr.notes.join(' '))}</p>` : '';
  $('routing').innerHTML = `${procHtml}
    <div class="rec ${rec.keepFiled ? '' : 'change'}"><b>${rec.keepFiled ? 'Keep the filed route' : `Consider ${esc(rec.best.name)}`}</b>${esc(rec.text)}${!rec.keepFiled && rec.best.routeString ? `<div class="raw">${esc(rec.best.routeString)}</div>` : ''}</div>
    <h3>Lateral options</h3>
    <div class="table-wrap"><table><tr><th>Option</th><th>Distance</th><th>ETE</th><th>Weather exposure</th><th>Meets</th></tr>
    ${r.route.candidates.map((c) => `<tr class="${!rec.keepFiled && c === rec.best || (!rec.keepFiled && rec.best && c.name === rec.best.name) ? 'best' : ''}"><td>${esc(c.name)}${c.routeString ? `<div class="hint"><code>${esc(c.routeString)}</code></div>` : ''}</td><td class="num">${c.distanceNm} nm</td><td class="num">${hm(c.eteMin)}</td><td class="num">${c.score}</td><td>${c.hits.length ? esc(c.hits.join('; ')) : '—'}</td></tr>`).join('')}
    </table></div>
    <h3>Altitude options on the filed route</h3>
    <p>${esc(alt.text)}</p>
    <div class="table-wrap"><table><tr><th>Level</th><th>ETE</th><th>Wind comp</th><th>ISA dev</th><th>Fuel (est.)</th><th>Advisories at level</th></tr>
    ${alt.rows.map((x) => `<tr class="${x.fl === alt.best ? 'best' : ''}"><td>FL${x.fl}</td><td class="num">${hm(x.eteMin)}</td><td class="num ${x.windComponent < 0 ? 'head' : 'tail'}">${x.windComponent == null ? '—' : (x.windComponent > 0 ? '+' : '') + x.windComponent + ' kt'}</td><td class="num">${x.isaDev == null ? '—' : (x.isaDev > 0 ? '+' : '') + x.isaDev + '°C'}</td><td class="num">${x.fuelLb.toLocaleString()} lb</td><td>${x.hits.length ? esc(x.hits.join('; ')) : '—'}</td></tr>`).join('')}
    </table></div>
    <p class="hint">Exposure counts nm inside SIGMETs, Convective SIGMETs (20 nm buffer), CWAs and G-AIRMET icing/turbulence at your altitude and time, plus severe/moderate PIREPs and thunderstorm METARs near the path. Trip fuel is from the XLS+ Flight Planning Guide tables (climb, high speed cruise, normal descent) at ISA, with the winds at each level. Options are offsets of the direct course; file through ATC-preferred routes and check airspace.</p>`;
}

function renderModels(b) {
  const m = b.models;
  if (!m || !m.available) { $('models').innerHTML = '<p>Model guidance did not load (Open-Meteo did not respond). The rest of the briefing is unaffected.</p>'; return; }
  const catPill = (c) => `<span class="pill ${esc(c)}">${esc(c)}</span>`;
  $('models').innerHTML = m.stations.map((s) => `
    <h3>${esc(s.id)} · ${esc(s.role)} <span class="hint">${z(s.window[0])}–${z(s.window[1])}${s.consensus ? ` · consensus ${s.consensus}${s.spread >= 2 ? ', low agreement' : ''}` : ''}</span></h3>
    ${s.models.length ? `<div class="table-wrap"><table><tr><th>Model</th><th>Category</th><th>Est. cloud base</th><th>Visibility</th><th>Weather</th><th>Wind (max)</th><th>CAPE / LI</th><th>Freezing level</th><th>Temp / dew pt</th></tr>
      ${s.models.map((x) => `<tr><td><b>${esc(x.model)}</b></td><td>${catPill(x.category)}</td><td class="num">${x.ceilingEst != null ? x.ceilingEst.toLocaleString() + ' ft' : '—'}</td><td class="num">${x.vis != null ? x.vis + ' SM' : '—'}</td><td>${esc(x.wx || '—')}</td><td class="num">${x.windMax ?? '—'}${x.gustMax ? 'G' + x.gustMax : ''} kt</td><td class="num">${x.capeMax ?? '—'} / ${x.liMin != null ? Math.round(x.liMin) : '—'}</td><td class="num">${x.frzFt != null ? x.frzFt.toLocaleString() + ' ft' : '—'}</td><td class="num">${x.temp}° / ${x.dewp ?? '—'}°</td></tr>`).join('')}
    </table></div>` : '<p class="hint">No model data for this location (HRRR and NBM cover the CONUS only).</p>'}`).join('')
    + (m.icingLayers && m.icingLayers.length ? `<h3>Icing-potential layers on the route (GFS)</h3><p>${m.icingLayers.slice(0, 10).map((x) => `~${x.ft.toLocaleString()} ft at ${x.alongNm} nm (${x.T}°C, RH ${x.RH}%)`).join(' · ')}</p>` : '')
    + `<p class="hint">${esc(m.source)}. Cloud base is estimated from the model temperature/dew point spread where the model has low cloud, so treat it as a trend, not a ceiling. The brief flags where two or more models are worse than the TAF.</p>`;
}
