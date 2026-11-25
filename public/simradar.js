'use strict';
// Simulated radar for the flight. Two parts:
//  1. HRRR simulated reflectivity (NOAA HRRR, map tiles by the Iowa Environmental Mesonet) stepped through the
//     flight with the aircraft's position. HRRR tiles reach 18 hours past the latest run.
//  2. A strip along the route: each model's estimated reflectivity at the time the aircraft passes each point
//     (from the engine, b.simRadar), which works for any departure time.
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const IEM = 'https://mesonet.agron.iastate.edu';
  const BASE = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
  const radarUrl = (min) => `${IEM}/cache/tile.py/1.0.0/hrrr::REFD-F${String(min).padStart(4, '0')}-0/{z}/{x}/{y}.png`;
  const z = (iso) => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`; };
  const SCALE = [[50, [180, 30, 170], '50+'], [45, [230, 60, 40], '45'], [40, [245, 160, 40], '40'], [35, [245, 222, 60], '35'], [25, [56, 168, 56], '25'], [15, [142, 219, 142], '15']];
  const color = (dbz) => { if (dbz == null) return null; const s = SCALE.find((x) => dbz >= x[0]); return s ? s[1] : null; };

  let metaP = null, metaAt = 0;
  function hrrrRun() {
    if (!metaP || Date.now() - metaAt > 10 * 60e3) {
      metaAt = Date.now();
      metaP = fetch(`${IEM}/data/gis/images/4326/hrrr/refd_0000.json`).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.model_init_utc ? Date.parse(j.model_init_utc) : null)).catch(() => null);
    }
    return metaP;
  }
  // Frames of the flight with the HRRR forecast minute that matches each (null when outside the run)
  async function plan(b) {
    const sr = b.simRadar;
    if (!sr || !sr.frames || !sr.frames.length) return { init: null, frames: [] };
    const init = await hrrrRun();
    const frames = sr.frames.map((f) => { const m = init == null ? null : Math.round((Date.parse(f.t) - init) / 9e5) * 15; return { ...f, min: m != null && m >= 0 && m <= 1080 ? m : null }; });
    return { init, frames };
  }

  function strip(b) {
    const sr = b.simRadar;
    if (!sr || !sr.available) return `<p>${esc(sr ? sr.text : '')}</p>`;
    const cell = (c) => { if (!c) return '<td class="num">–</td>'; const col = color(c.dbz); return `<td class="num"${col ? ` style="background:rgb(${col.join(',')});color:${c.dbz >= 45 ? '#fff' : '#111'};font-weight:700"` : ''} title="${c.rate} mm/h">${c.dbz >= 15 ? c.dbz : '·'}${c.thunder ? ' TS' : ''}</td>`; };
    return `<h3>On the route as you pass (estimated dBZ)</h3><p>${esc(sr.text)}</p>
      <div class="table-wrap"><table class="simstrip"><tr><th>Along</th>${sr.rows.map((r) => `<th class="num">${r.alongNm} nm<div class="hint">${esc(z(r.t).slice(3))}</div></th>`).join('')}</tr>
      ${sr.models.map((m) => `<tr><td><b>${esc(m)}</b></td>${sr.rows.map((r) => cell(r.cells[m])).join('')}</tr>`).join('')}</table></div>
      <div class="legend-row">${[...SCALE].reverse().map((s) => `<span><i class="sw" style="background:rgb(${s[1].join(',')})"></i>${s[2]}</span>`).join('')}<span>dBZ</span></div>
      <p class="hint">${esc(sr.method)} A dot means no echo; TS means the model has a thunderstorm there.</p>`;
  }

  let map = null;
  async function render(b, el) {
    if (map) { try { map.remove(); } catch (e) { /* gone */ } map = null; }
    el.innerHTML = `<div id="simMapWrap"><p class="hint">Loading the HRRR simulated radar…</p></div>${strip(b)}`;
    const wrap = el.querySelector('#simMapWrap');
    const { init, frames } = await plan(b);
    if (!el.isConnected || !wrap.isConnected) return;
    const ok = frames.filter((f) => f.min != null);
    if (!ok.length || !window.L) {
      wrap.innerHTML = `<p class="hint">${init == null ? 'The HRRR simulated radar could not be loaded.' : `The HRRR simulated radar map reaches 18 hours past its latest run (to ${esc(z(new Date(init + 18 * 3600e3).toISOString()))}). Your flight is outside that, so use the route strip below, which draws on the longer-range models. The map will appear when you run the brief closer to departure.`}</p>`;
      return;
    }
    wrap.innerHTML = `<div class="timebar"><input type="range" id="simTime" min="0" max="${frames.length - 1}" value="0" aria-label="Time during flight"><span id="simLabel"></span></div><div id="simMap" class="simmap"></div>
      <p class="hint">HRRR simulated reflectivity from the ${esc(z(new Date(init).toISOString()))} run, shown for the time the aircraft (blue dot) is at each position. Drag the slider to fly the route. A model forecast, not observed radar. HRRR covers the continental US and nearby waters; outside that area the map is blank and the strip below applies. The map shows navaids and jet airways; zoom in for the FAA enroute chart, or pick another chart with the layers button.</p>`;
    map = L.map(wrap.querySelector('#simMap'), { zoomSnap: 0.25, scrollWheelZoom: false, maxZoom: 10 });
    if (window.AvMap) L.control.layers(window.AvMap.bases(map), {}, { collapsed: true }).addTo(map);
    else L.tileLayer(BASE, { attribution: 'Tiles © Esri', maxZoom: 10 }).addTo(map);
    const pts = b.plan.route.map((w) => [w.lat, w.lon]);
    L.polyline(pts, { color: '#111', weight: 2.5 }).addTo(map);
    // the route's own fixes, named
    b.plan.route.forEach((w, i) => { if (w.id && (i === 0 || i === b.plan.route.length - 1 || b.plan.route.length <= 14 || i % Math.ceil(b.plan.route.length / 12) === 0)) L.marker([w.lat, w.lon], { icon: L.divIcon({ className: 'avlbl fix', html: esc(w.id), iconSize: null }), interactive: false, keyboard: false }).addTo(map); });
    map.fitBounds(pts, { padding: [40, 40] });
    map.attributionControl.addAttribution('HRRR reflectivity © NOAA, Iowa Environmental Mesonet');
    const plane = L.circleMarker(pts[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#1f5fbf', fillOpacity: 1 }).addTo(map);
    let layer = null, shown = null;
    const label = wrap.querySelector('#simLabel'), slider = wrap.querySelector('#simTime');
    const show = (i) => {
      const f = frames[i];
      plane.setLatLng([f.lat, f.lon]);
      label.textContent = `${z(f.t)} · ${f.alongNm} nm${f.min == null ? ' · beyond the HRRR run' : ''}`;
      if (f.min === shown) return;
      const old = layer; shown = f.min; layer = null;
      if (f.min != null) layer = L.tileLayer(radarUrl(f.min), { opacity: 0.7, maxZoom: 10 }).addTo(map);
      if (old) setTimeout(() => map && map.removeLayer(old), 400);
    };
    slider.addEventListener('input', () => show(+slider.value));
    show(0);
  }

  // ---- raster panels for the PDF: base map, HRRR reflectivity, route and aircraft position
  const img = (url) => new Promise((res) => { const im = new Image(); im.crossOrigin = 'anonymous'; const to = setTimeout(() => res(null), 9000); im.onload = () => { clearTimeout(to); res(im); }; im.onerror = () => { clearTimeout(to); res(null); }; im.src = url; });
  const mx = (lon, zoom) => ((lon + 180) / 360) * 256 * 2 ** zoom;
  const my = (lat, zoom) => { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** zoom; };
  async function panel(b, f, wPx, hPx) {
    const pts = b.plan.route;
    const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
    const box = { s: Math.min(...lats), n: Math.max(...lats), w: Math.min(...lons), e: Math.max(...lons) };
    let zoom = 8;
    while (zoom > 2 && (mx(box.e, zoom) - mx(box.w, zoom) > wPx * 0.72 || my(box.s, zoom) - my(box.n, zoom) > hPx * 0.66)) zoom--;
    const x0 = (mx(box.w, zoom) + mx(box.e, zoom)) / 2 - wPx / 2, y0 = (my(box.n, zoom) + my(box.s, zoom)) / 2 - hPx / 2;
    const cv = document.createElement('canvas'); cv.width = wPx; cv.height = hPx;
    const g = cv.getContext('2d');
    g.fillStyle = '#eef1f4'; g.fillRect(0, 0, wPx, hPx);
    const tiles = [];
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + wPx) / 256); tx++) for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + hPx) / 256); ty++) if (ty >= 0 && ty < 2 ** zoom) tiles.push([tx, ty]);
    const wrapX = (tx) => ((tx % 2 ** zoom) + 2 ** zoom) % 2 ** zoom;
    const draw = async (tpl, alpha) => {
      const ims = await Promise.all(tiles.map(([tx, ty]) => img(tpl.replace('{z}', zoom).replace('{x}', wrapX(tx)).replace('{y}', ty))));
      g.globalAlpha = alpha;
      let n = 0;
      ims.forEach((im, i) => { if (im) { n++; g.drawImage(im, tiles[i][0] * 256 - x0, tiles[i][1] * 256 - y0, 256, 256); } });
      g.globalAlpha = 1;
      return n;
    };
    await draw(BASE, 1);
    const got = await draw(radarUrl(f.min), 0.75);
    if (!got) return null;
    const X = (lon) => mx(lon, zoom) - x0, Y = (lat) => my(lat, zoom) - y0;
    // navaids and jet airways over the echoes, as on the on-screen map
    try { if (window.AvMap) await window.AvMap.drawCanvas(g, X, Y, wPx, hPx, 'high'); } catch (e) { /* plain panel */ }
    g.lineWidth = 3; g.strokeStyle = '#111'; g.lineJoin = 'round'; g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(X(p.lon), Y(p.lat)) : g.moveTo(X(p.lon), Y(p.lat)))); g.stroke();
    g.font = 'bold 15px Helvetica, Arial, sans-serif'; g.fillStyle = '#111';
    for (const p of [pts[0], pts[pts.length - 1]]) { g.beginPath(); g.arc(X(p.lon), Y(p.lat), 4.5, 0, 7); g.fillStyle = '#fff'; g.fill(); g.stroke(); g.fillStyle = '#111'; g.fillText(p.id, X(p.lon) + 8, Y(p.lat) - 7); }
    g.beginPath(); g.arc(X(f.lon), Y(f.lat), 8, 0, 7); g.fillStyle = '#1f5fbf'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#fff'; g.stroke();
    try { return cv.toDataURL('image/jpeg', 0.82); } catch (e) { return null; }
  }
  // Up to three panels: departure, mid-flight and arrival
  async function panels(b) {
    try {
      const { init, frames } = await plan(b);
      const ok = frames.filter((f) => f.min != null);
      if (!ok.length) return { init, frames: frames.length, list: [] };
      const pick = [...new Set([frames[0], frames[Math.floor((frames.length - 1) / 2)], frames[frames.length - 1]])].filter((f) => f.min != null);
      const names = new Map([[frames[0], 'Departure'], [frames[Math.floor((frames.length - 1) / 2)], 'Mid-flight'], [frames[frames.length - 1], 'Arrival']]);
      const list = (await Promise.all(pick.map(async (f) => ({ label: `${names.get(f)} ${z(f.t)}, aircraft at ${f.alongNm} nm`, data: await panel(b, f, 828, 540) })))).filter((p) => p.data);
      return { init, frames: frames.length, list };
    } catch (e) { return { init: null, frames: 0, list: [] }; }
  }

  window.SimRadar = { render, panels, color, SCALE };
})();
