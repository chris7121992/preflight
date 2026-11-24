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
let notamFromFile = '';
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
    alternate: $('alternate').value.trim(), cruiseAlt: $('cruiseAlt').value, tas: $('tas').value,
    etd: etdLocal ? new Date(etdLocal).toISOString() : null, rules: $('rules').value,
    destCircHaa: $('destCircHaa').value, destCircNa: $('destCircNa').checked, destHat: $('destHat').value, destVisMin: $('destVisMin').value,
    altNavFacilities: $('altNavFacilities').value, altHat: $('altHat').value, altVisMin: $('altVisMin').value, highMinsPic: $('highMinsPic').checked, notamText: [notamFromFile, $('notamText').value].filter(Boolean).join('\n\n'), approachCat: $('approachCat').value, altGps: $('altGps').checked,
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

function render(b) {
  $('results').hidden = false;
  $('printBtn').hidden = false;
  $('pdfBtn').hidden = false;
  lastBrief = b;
  renderVerdict(b);
  renderFactors(b);
  renderMap(b);
  renderSurface(b);
  renderTerminals(b);
  renderWinds(b);
  renderHazards(b);
  renderPireps(b);
  renderEnroute(b);
  renderNotams(b);
  renderSources(b);
  renderRouting(b);
  renderModels(b);
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
    const cs = sf.collins;
    const method = sf.method ? `<p class="hint">Read the way Richard L. Collins teaches in <i>Flying the Weather Map</i>: find the lows first, check upper-level support, treat fronts as sloping zones, read the surface winds for the low's track, then check upstream.${cs ? ` Flow aloft: ${cs.flow === 'sw' ? 'southwesterly (supports lows)' : cs.flow === 'nw' ? 'northwesterly (clearing)' : cs.flow === 'w' ? 'flat westerly (little support)' : cs.flow ? 'closed low nearby' : 'n/a'}${cs.w500 ? ` ${String(cs.w500.dir).padStart(3, '0')}°/${cs.w500.spd} kt at 500 mb` : ''}${cs.lapse != null ? `; lapse rate ${cs.lapse}°C per 1,000 ft (2.0 is Collins' line)` : ''}${cs.betterWeather ? `; better weather to the ${cs.betterWeather}` : ''}.` : ''}</p>` : '';
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
      ${rw && !rw.none ? `<div>Wind used ${windStr(s.windUsed)} → best runway <b>${esc(rw.id)}</b> (${rw.len} ft): <span class="${rw.head < 0 ? 'head' : ''}">${rw.head >= 0 ? 'head' : 'tail'} ${Math.abs(rw.head)} kt</span>, crosswind ${rw.cross}${rw.crossG !== rw.cross ? ` (gust ${rw.crossG})` : ''} kt</div>` : ''}
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
    <p class="hint">Exposure counts nm inside SIGMETs, Convective SIGMETs (20 nm buffer), CWAs and G-AIRMET icing/turbulence at your altitude and time, plus severe/moderate PIREPs and thunderstorm METARs near the path. Fuel is a rough XLS+ planning estimate. Options are offsets of the direct course; file through ATC-preferred routes and check airspace.</p>`;
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
