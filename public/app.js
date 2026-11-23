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

$('planForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const routeText = $('routeText').value.trim();
  if (!fileText && !routeText) return status('Upload a flight plan or type a route first.', true);
  const etdLocal = $('etd').value;
  const body = {
    fileText, filename: fileName, routeText: fileText ? '' : routeText,
    alternate: $('alternate').value.trim(), cruiseAlt: $('cruiseAlt').value, tas: $('tas').value,
    etd: etdLocal ? new Date(etdLocal).toISOString() : null, rules: $('rules').value,
    maxXwind: $('maxXwind').value, maxTailwind: $('maxTailwind').value, minCeiling: $('minCeiling').value, minVis: $('minVis').value, minRunway: $('minRunway').value,
  };
  $('go').disabled = true;
  status('Pulling live METARs, TAFs, PIREPs, SIGMETs, G-AIRMETs, CWAs, WPC fronts and GFS winds…');
  try {
    const r = await fetch('/api/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Briefing failed');
    $('status').hidden = true;
    render(data);
  } catch (err) {
    status(err.message, true);
  } finally {
    $('go').disabled = false;
  }
});

function status(msg, err) {
  const s = $('status');
  s.hidden = false;
  s.className = 'status' + (err ? ' err' : '');
  s.textContent = msg;
}

function render(b) {
  $('results').hidden = false;
  $('printBtn').hidden = false;
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
  $('results').scrollIntoView({ behavior: 'smooth' });
}

function renderVerdict(b) {
  const d = b.decision, p = b.plan;
  const cls = d.verdict === 'GO' ? 'v-go' : d.verdict === 'NO-GO' ? 'v-nogo' : 'v-caution';
  $('verdict').className = `card verdict ${cls}`;
  $('verdict').innerHTML = `
    <div class="vhead"><span class="vword">${esc(d.verdict)}</span><span>${esc(d.headline)}</span></div>
    <div class="meta">
      <span><b>${esc(p.dep)} → ${esc(p.dest)}</b>${p.alternate ? ` (alt ${esc(p.alternate)})` : ''}</span>
      <span>Route <b>${esc(p.route.map((w) => w.id).join(' '))}</b></span>
      <span><b>${p.distanceNm} nm</b> · FL${Math.round(p.cruiseAlt / 100)} · ${p.tas} KTAS</span>
      <span>ETD <b>${z(p.etd)}</b> (${local(p.etd)}) · ETA <b>${z(p.eta)}</b> (${local(p.eta)}) · ETE ${Math.floor(p.eteMin / 60)}:${String(p.eteMin % 60).padStart(2, '0')}</span>
      <span>Part ${esc(p.rules)} · ${esc(b.aircraft.name)}</span>
      <span>Generated ${z(b.generatedAt)}</span>
    </div>
    <ul class="reason">${d.reasoning.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
}

function renderFactors(b) {
  const f = b.factors;
  $('factors').innerHTML = f.length
    ? f.map((x) => `<div class="factor ${x.level}"><div class="t"><span class="pill ${x.level}">${LEVEL[x.level]}</span>${esc(x.title)}</div><div class="d">${esc(x.detail)}</div></div>`).join('')
    : '<p>No significant factors found.</p>';
}

const FRONT_COLOR = { COLD: '#1f5fd6', WARM: '#d62b1f', STNRY: '#8a5cd6', OCFNT: '#a03cc8', TROF: '#d68a1f', DRYLN: '#8b5a2b', SQLN: '#d6331f' };
function renderMap(b) {
  if (!window.L) { $('map').innerHTML = '<p class="hint">Map library failed to load.</p>'; return; }
  if (!map) {
    map = L.map('map', { worldCopyJump: true });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors', maxZoom: 12 }).addTo(map);
  }
  if (layers) layers.remove();
  layers = L.layerGroup().addTo(map);
  const route = b.plan.route.map((w) => [w.lat, w.lon]);
  // Hazard polygons
  for (const h of b.hazards) {
    const color = /CONVECTIVE|TS/.test(h.hazard) ? '#d6331f' : /ICE/.test(h.hazard) ? '#1f9bd6' : /TURB/.test(h.hazard) ? '#d68a1f' : '#7a7a7a';
    L.polygon(h.coords.map((c) => [c.lat, c.lon]), { color, weight: 1.5, fillOpacity: 0.12 }).bindPopup(`<b>${esc(h.label)}</b><br>${h.base != null ? `Base ${h.base}` : ''} ${h.top ? `Top ${h.top}` : ''}<br>Route at ${h.alongNm} nm ~${z(h.at)}${h.raw ? `<pre style="white-space:pre-wrap;max-width:320px">${esc(h.raw)}</pre>` : ''}`).addTo(layers);
  }
  // Fronts (current analysis)
  const sf = b.surface || {};
  for (const f of sf.analysisFronts || []) {
    if (f.points.length < 2) continue;
    L.polyline(f.points.map((p) => [p.lat, p.lon]), { color: FRONT_COLOR[f.type] || '#555', weight: f.type === 'TROF' ? 2 : 3.5, dashArray: f.type === 'TROF' ? '6 6' : f.type === 'STNRY' ? '12 6' : null, opacity: 0.85 }).bindTooltip(`${f.type} (analysis ${z(sf.analysisValid)})`).addTo(layers);
  }
  // 12h prog fronts, faded
  const prog = (sf.progs || [])[0];
  if (prog) for (const f of prog.fronts) {
    if (f.points.length < 2) continue;
    L.polyline(f.points.map((p) => [p.lat, p.lon]), { color: FRONT_COLOR[f.type] || '#555', weight: 2, dashArray: '2 6', opacity: 0.6 }).bindTooltip(`${f.type} (${prog.label}, ${z(prog.valid)})`).addTo(layers);
  }
  for (const [list, kind] of [[sf.analysisHighs || [], 'H'], [sf.analysisLows || [], 'L']]) {
    for (const c of list) {
      L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: `<div style="font:800 18px system-ui;color:${kind === 'H' ? '#1f5fd6' : '#d62b1f'};text-shadow:0 0 3px #fff">${kind}<div style="font:600 10px system-ui;color:#333">${c.pressure}</div></div>`, iconSize: [30, 30], iconAnchor: [10, 12] }) }).addTo(layers);
    }
  }
  // Route
  L.polyline(route, { color: '#111', weight: 3 }).addTo(layers);
  for (const w of b.plan.route) L.circleMarker([w.lat, w.lon], { radius: 4, color: '#111', fillColor: '#fff', fillOpacity: 1, weight: 2 }).bindTooltip(w.id, { permanent: b.plan.route.length <= 12, direction: 'right', className: '' }).addTo(layers);
  // METARs
  const CAT = { VFR: '#1d7a45', MVFR: '#2b62c4', IFR: '#c0392b', LIFR: '#a52a9d' };
  for (const m of b.enroute) L.circleMarker([m.lat, m.lon], { radius: 5, color: CAT[m.cat] || '#888', fillColor: CAT[m.cat] || '#888', fillOpacity: 0.85, weight: 1 }).bindPopup(`<code>${esc(m.raw)}</code>`).addTo(layers);
  // PIREPs
  for (const p of b.pireps) {
    const sev = /SEV/.test(p.turb + p.ice) ? '#b3261e' : /MOD/.test(p.turb + p.ice) ? '#d68a1f' : '#6b7a8a';
    L.circleMarker([p.lat, p.lon], { radius: 4, color: sev, fillColor: sev, fillOpacity: 1, weight: 1 }).bindPopup(`<b>PIREP</b> ${esc(p.ac || '')} ${altStr(p.alt)}<br><code>${esc(p.raw)}</code>`).addTo(layers);
  }
  map.fitBounds(L.latLngBounds(route).pad(0.25));
  setTimeout(() => map.invalidateSize(), 100);
  $('legend').innerHTML = [['COLD', 'Cold front'], ['WARM', 'Warm front'], ['OCFNT', 'Occluded'], ['STNRY', 'Stationary'], ['TROF', 'Trough']].map(([k, n]) => `<span><i style="background:${FRONT_COLOR[k]}"></i>${n}</span>`).join('') + '<span>Dotted = 12 h prog · dots = METAR category / PIREPs · shaded = advisories on route</span>';
}

function renderSurface(b) {
  const sf = b.surface;
  if (!sf || !sf.available) { $('surface').innerHTML = '<p>WPC coded surface analysis was unavailable. Review the charts below directly.</p>'; }
  else {
    const fr = sf.fronts.slice(0, 8);
    $('surface').innerHTML = `<div class="sfc">${(sf.narrative || []).map((p) => `<h3>${esc(p.heading)}</h3><p>${esc(p.text)}</p>`).join('')}</div>
      ${fr.length ? `<h3>Fronts within 400 nm</h3><div class="table-wrap"><table><tr><th>Feature</th><th>Now from route</th><th>Motion</th><th>During flight</th><th>${esc(b.plan.dep)} passage</th><th>${esc(b.plan.dest)} passage</th></tr>
      ${fr.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${f.nearestNowNm} nm</td><td>${f.motion ? (f.motion.speedKt < 5 ? 'Nearly stationary' : `${f.motion.towardCompass} ${f.motion.speedKt} kt`) : '—'}</td><td>${f.crossesRoute ? `<b>Crosses at ${f.encounter.alongRouteNm} nm, ~${z(f.encounter.time)}</b>` : `≥ ${f.encounter.distNm} nm away`}</td><td>${f.depPassage ? z(f.depPassage) : '—'}</td><td>${f.destPassage ? z(f.destPassage) : '—'}</td></tr>`).join('')}</table></div>` : ''}
      <p class="hint">Fronts and pressure centers decoded from the WPC coded surface analysis (valid ${z(sf.analysisValid)}) and 12/24 h progs; motion is the displacement between analysis and 12 h prog, projected to your flight times.</p>`;
  }
  $('charts').innerHTML = b.charts.map((c) => `<figure><img loading="lazy" src="/api/chart?u=${encodeURIComponent(c.url)}" alt="${esc(c.label)}" onerror="this.closest('figure').remove()"><figcaption>${esc(c.label)}</figcaption></figure>`).join('');
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
      ${s.alternateRequired != null ? `<div>Alternate required: <b>${s.alternateRequired ? 'Yes' : 'No'}</b></div>` : ''}
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
  <p class="hint">Average wind component ${r.avgWindComponentKt > 0 ? '+' : ''}${r.avgWindComponentKt ?? 0} kt. Route ${r.routeNm} nm + alternate ${r.alternateLegNm} nm = ${r.equivalentStillAirNm} equivalent still-air nm vs ~${r.stillAirRangeNm} nm XLS+ NBAA-IFR range. Source: NOAA GFS via Open-Meteo, nearest pressure level to cruise altitude.</p>`;
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

function renderNotams(b) {
  const n = b.notams;
  if (!n.available) {
    $('notams').innerHTML = `<p>${esc(n.note)}</p><p>${n.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.id)} NOTAMs (FAA)</a>`).join(' · ')}</p>`;
    return;
  }
  $('notams').innerHTML = Object.entries(n.byAirport).map(([id, list]) => `<h3>${esc(id)} (${list.length})</h3>${list.slice(0, 30).map((x) => `<div class="raw">${esc(x.text)}</div>`).join('')}`).join('');
}

function renderSources(b) {
  $('sources').innerHTML = b.sources.map((s) => `<div class="src"><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '✓' : '✗'}</span><span><b>${esc(s.name)}</b> · ${esc(s.desc)}</span></div>`).join('')
    + (b.errors.length ? `<h3>Issues</h3>${b.errors.map((e) => `<div class="hint">${esc(e.source)}: ${esc(e.error)}</div>`).join('')}` : '')
    + `<p class="hint">${esc(b.disclaimer)}</p>`;
}
