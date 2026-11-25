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
  // Observed radar mosaic (NEXRAD) for a past time, in 5-minute steps, from the same service
  const obsUrl = (stamp) => `${IEM}/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${stamp}/{z}/{x}/{y}.png`;
  const stamp5 = (ms) => { const d = new Date(Math.floor(ms / 3e5) * 3e5), p2 = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`; };
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
    // Each frame gets a radar picture: the observed mosaic when its time has already passed, the HRRR forecast
    // when the latest run reaches it, and none beyond that (the route is then coloured from the model strip).
    const now = Date.now();
    const frames = sr.frames.map((f) => {
      const t = Date.parse(f.t), m = init == null ? null : Math.round((t - init) / 9e5) * 15;
      const past = t <= now - 10 * 60e3 && t > now - 20 * 864e5;
      const min = !past && m != null && m >= 0 && m <= 1080 ? m : null;
      return { ...f, min, obs: past ? stamp5(t) : null, url: past ? obsUrl(stamp5(t)) : min != null ? radarUrl(min) : null, key: past ? 'o' + stamp5(t) : min != null ? 'f' + min : null };
    });
    return { init, frames };
  }

  const CONUS = { s: 24, n: 50, w: -125, e: -66.5 };
  // The whole HRRR run from now on, every 30 minutes, for the continental US view. The aircraft is placed on a
  // frame when the flight is in progress at that time.
  function conusFrames(init, flight) {
    if (init == null) return [];
    const out = [], now = Date.now();
    for (let m = Math.max(0, Math.ceil((now - init) / 18e5) * 30); m <= 1080; m += 30) {
      const t = init + m * 60e3;
      const near = flight.length ? flight.reduce((a, f) => (Math.abs(Date.parse(f.t) - t) < Math.abs(Date.parse(a.t) - t) ? f : a)) : null;
      const on = near && Math.abs(Date.parse(near.t) - t) <= 10 * 60e3;
      out.push({ t: new Date(t).toISOString(), min: m, url: radarUrl(m), key: 'f' + m, conus: true, ahead: Math.round((t - now) / 36e5 * 2) / 2, lat: on ? near.lat : null, lon: on ? near.lon : null, alongNm: on ? near.alongNm : null });
    }
    return out;
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

  // An older cached copy of the page may not include the aviation map script, so it is fetched here when missing
  const needAv = () => (window.AvMap ? Promise.resolve() : new Promise((res) => { const s = document.createElement('script'); s.src = 'avmap.js?v=' + Date.now(); s.onload = res; s.onerror = res; document.head.appendChild(s); setTimeout(res, 6000); }));
  let map = null;
  async function render(b, el) {
    if (map) { try { map.remove(); } catch (e) { /* gone */ } map = null; }
    el.innerHTML = `<div id="simMapWrap"><p class="hint">Loading the HRRR simulated radar…</p></div>${strip(b)}`;
    const wrap = el.querySelector('#simMapWrap');
    const { init, frames } = await plan(b);
    await needAv();
    if (!el.isConnected || !wrap.isConnected) return;
    const ok = frames.filter((f) => f.url);
    const nObs = ok.filter((f) => f.obs).length, nFc = ok.length - nObs;
    // The map is always drawn (route, fixes and aviation chart); the radar layer joins it when HRRR covers the flight
    if (!frames.length || !window.L) {
      wrap.innerHTML = `<p class="hint">${init == null ? 'The HRRR simulated radar could not be loaded.' : `The HRRR simulated radar map reaches 18 hours past its latest run (to ${esc(z(new Date(init + 18 * 3600e3).toISOString()))}). Your flight is outside that, so use the route strip below, which draws on the longer-range models. The map will appear when you run the brief closer to departure.`}</p>`;
      return;
    }
    const cFrames = conusFrames(init, frames);
    wrap.innerHTML = `${cFrames.length ? `<div class="simmode" id="simMode"><button type="button" data-m="flight">Along the flight</button><button type="button" data-m="conus">Continental US forecast</button><button type="button" id="simPlay" aria-label="Play the frames">▶ Play</button></div>` : ''}<div class="timebar"><input type="range" id="simTime" min="0" max="${frames.length - 1}" value="0" aria-label="Time during flight"><span id="simLabel"></span></div><div id="simMap" class="simmap"></div>
      <p class="hint">${[
        nObs ? `${nFc ? 'The part of the flight that is already in the past' : 'This flight time is already in the past, so the map'} shows the radar that was observed (NEXRAD mosaic) at the time the aircraft (blue dot) would be at each position.` : '',
        nFc ? `HRRR simulated reflectivity from the ${esc(z(new Date(init).toISOString()))} run${nObs ? ' covers the rest' : ', shown for the time the aircraft (blue dot) is at each position'}. A model forecast, not observed radar.` : '',
        !ok.length ? (init == null ? 'The HRRR simulated radar could not be loaded.' : `The HRRR simulated radar reaches ${esc(z(new Date(init + 18 * 3600e3).toISOString()))} and your flight is later than that.`) + ' The coloured dots on the route are the strongest model echo at each point when you pass (from the strip below); run the brief again within 18 hours of departure for the full radar picture.' : ok.length < frames.length ? 'Where the slider says no radar, the flight is beyond the HRRR run.' : '',
        ok.length ? 'Drag the slider to fly the route. Radar covers the continental US and nearby waters; outside that the map is blank and the strip below applies.' : '',
      ].filter(Boolean).join(' ')} <b id="simModeNote"></b> The map shows navaids and jet airways; zoom in for the FAA enroute chart, or pick another chart with the layers button.</p>`;
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
    let cur = frames;
    const show = (i) => {
      const f = cur[Math.min(i, cur.length - 1)];
      if (f.lat != null) plane.setLatLng([f.lat, f.lon]);
      plane.setStyle({ opacity: f.lat != null ? 1 : 0, fillOpacity: f.lat != null ? 1 : 0 });
      label.textContent = f.conus ? `${z(f.t)} · HRRR forecast, ${f.ahead <= 0 ? 'now' : '+' + f.ahead + ' h'}${f.alongNm != null ? ` · aircraft at ${f.alongNm} nm` : ''}` : `${z(f.t)} · ${f.alongNm} nm · ${f.obs ? 'observed radar' : f.min != null ? 'HRRR forecast' : 'no radar (beyond the HRRR run)'}`;
      if (f.key === shown) return;
      const old = layer; shown = f.key; layer = null;
      if (f.url) layer = L.tileLayer(f.url, { opacity: 0.7, maxZoom: 10, maxNativeZoom: 9, zIndex: 5 }).addTo(map);
      if (old) setTimeout(() => map && map.removeLayer(old), 400);
    };
    // With no radar picture at all, colour the route from the model strip so the map still shows where echoes are expected
    const sr = b.simRadar;
    if (!ok.length && sr && sr.available) for (const r of sr.rows) { const c = color(r.max); L.circleMarker([r.lat, r.lon], { radius: c ? 9 : 4, color: '#111', weight: 1, fillColor: c ? `rgb(${c.join(',')})` : '#fff', fillOpacity: 0.95 }).addTo(map).bindTooltip(`${r.alongNm} nm · ${z(r.t)} · ${r.max >= 15 ? r.max + ' dBZ (strongest model)' : 'no echo'}`); }
    slider.addEventListener('input', () => show(+slider.value));
    // Two views: the flight (radar at the time the aircraft is at each position) and the whole continental US
    // through the HRRR run, to see where every cell is forecast to be
    let timer = null;
    const playBtn = wrap.querySelector('#simPlay');
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } if (playBtn) playBtn.textContent = '▶ Play'; };
    const setMode = (m) => {
      stop();
      cur = m === 'conus' ? cFrames : frames;
      wrap.querySelectorAll('#simMode button[data-m]').forEach((bt) => bt.classList.toggle('on', bt.dataset.m === m));
      slider.max = cur.length - 1;
      // in the US view start at departure time when the forecast reaches it
      const dep = Date.parse(frames[0].t), at = m === 'conus' ? Math.max(0, cur.findIndex((f) => Date.parse(f.t) >= dep)) : 0;
      slider.value = at;
      if (m === 'conus') map.fitBounds([[CONUS.s, CONUS.w], [CONUS.n, CONUS.e]], { padding: [4, 4] }); else map.fitBounds(pts, { padding: [40, 40] });
      const note = wrap.querySelector('#simModeNote');
      if (note) note.textContent = m === 'conus' ? `Continental US: HRRR simulated reflectivity from the ${z(new Date(init).toISOString())} run, every 30 minutes from now to ${z(new Date(init + 18 * 3600e3).toISOString())}. Drag the slider or press Play to watch where the cells are forecast to form and move. A model forecast: read it for the pattern and timing, not the exact cell.` : '';
      show(at);
    };
    wrap.querySelectorAll('#simMode button[data-m]').forEach((bt) => bt.addEventListener('click', () => setMode(bt.dataset.m)));
    if (playBtn) playBtn.addEventListener('click', () => {
      if (timer) return stop();
      playBtn.textContent = '❚❚ Pause';
      timer = setInterval(() => { if (!map || !slider.isConnected) return stop(); slider.value = (+slider.value + 1) % cur.length; show(+slider.value); }, 900);
    });
    // open on the flight when it has radar frames, otherwise on the continental US forecast
    if (cFrames.length) setMode(ok.length ? 'flight' : 'conus'); else show(0);
  }

  // ---- raster panels for the PDF: base map, HRRR reflectivity, route and aircraft position
  const img = (url) => new Promise((res) => { const im = new Image(); im.crossOrigin = 'anonymous'; const to = setTimeout(() => res(null), 15000); im.onload = () => { clearTimeout(to); res(im); }; im.onerror = () => { clearTimeout(to); res(null); }; im.src = url; });
  const mx = (lon, zoom) => ((lon + 180) / 360) * 256 * 2 ** zoom;
  const my = (lat, zoom) => { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** zoom; };
  async function panel(b, f, wPx, hPx, wide) {
    const pts = b.plan.route;
    const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
    const box = wide || { s: Math.min(...lats), n: Math.max(...lats), w: Math.min(...lons), e: Math.max(...lons) };
    const fit = wide ? [1, 1] : [0.72, 0.66];
    let zoom = 8;
    while (zoom > 2 && (mx(box.e, zoom) - mx(box.w, zoom) > wPx * fit[0] || my(box.s, zoom) - my(box.n, zoom) > hPx * fit[1])) zoom--;
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
    const got = await draw(f.url, 0.75);
    if (!got) return null;
    const X = (lon) => mx(lon, zoom) - x0, Y = (lat) => my(lat, zoom) - y0;
    // navaids and jet airways over the echoes, as on the on-screen map
    try { if (window.AvMap && !wide) await window.AvMap.drawCanvas(g, X, Y, wPx, hPx, 'high'); } catch (e) { /* plain panel */ }
    g.lineWidth = 3; g.strokeStyle = '#111'; g.lineJoin = 'round'; g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(X(p.lon), Y(p.lat)) : g.moveTo(X(p.lon), Y(p.lat)))); g.stroke();
    g.font = 'bold 15px Helvetica, Arial, sans-serif'; g.fillStyle = '#111';
    for (const p of [pts[0], pts[pts.length - 1]]) { g.beginPath(); g.arc(X(p.lon), Y(p.lat), 4.5, 0, 7); g.fillStyle = '#fff'; g.fill(); g.stroke(); g.fillStyle = '#111'; g.fillText(p.id, X(p.lon) + 8, Y(p.lat) - 7); }
    if (f.lat != null) { g.beginPath(); g.arc(X(f.lon), Y(f.lat), 8, 0, 7); g.fillStyle = '#1f5fbf'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#fff'; g.stroke(); }
    try { return cv.toDataURL('image/jpeg', 0.82); } catch (e) { return null; }
  }
  // Up to three panels: departure, mid-flight and arrival
  async function panels(b) {
    try {
      const { init, frames } = await plan(b);
      const ok = frames.filter((f) => f.url);
      // Continental US: the HRRR forecast at departure, mid-flight and arrival when the run reaches them, otherwise now, +6 h and +12 h
      const cf = conusFrames(init, frames);
      let conus = [];
      if (cf.length) {
        const fl = [frames[0], frames[Math.floor((frames.length - 1) / 2)], frames[frames.length - 1]].map((f, i) => { const t = Date.parse(f.t), c = cf.reduce((a, x) => (Math.abs(Date.parse(x.t) - t) < Math.abs(Date.parse(a.t) - t) ? x : a)); return Math.abs(Date.parse(c.t) - t) <= 20 * 60e3 ? { c, name: ['Departure', 'Mid-flight', 'Arrival'][i] } : null; }).filter(Boolean);
        const pickC = fl.length >= 2 ? fl : [0, 12, 24].filter((i) => cf[i]).map((i) => ({ c: cf[i], name: i ? `+${i / 2} h` : 'Now' }));
        // one at a time: the tile service draws these on request and is slow when asked for many at once
        for (const x of pickC) { let data = await panel(b, x.c, 828, 470, CONUS); if (!data) data = await panel(b, x.c, 828, 470, CONUS); if (data) conus.push({ label: `${x.name} ${z(x.c.t)}`, data }); }
      }
      if (!ok.length) return { init, frames: frames.length, list: [], conus };
      const pick = [...new Set([frames[0], frames[Math.floor((frames.length - 1) / 2)], frames[frames.length - 1]])].filter((f) => f.url);
      const names = new Map([[frames[0], 'Departure'], [frames[Math.floor((frames.length - 1) / 2)], 'Mid-flight'], [frames[frames.length - 1], 'Arrival']]);
      const list = (await Promise.all(pick.map(async (f) => ({ label: `${names.get(f)} ${z(f.t)}, aircraft at ${f.alongNm} nm${f.obs ? ' (observed)' : ''}`, data: await panel(b, f, 828, 540) })))).filter((p) => p.data);
      const obs = pick.filter((f) => f.obs).length;
      return { init, frames: frames.length, list, conus, source: obs === pick.length ? 'Observed radar (NEXRAD mosaic), because the flight time is already in the past, shown for the time the aircraft (blue dot) is at each position.' : obs ? `Observed radar (NEXRAD mosaic) for the panels marked observed and HRRR simulated reflectivity from the ${z(new Date(init).toISOString())} run for the others, each for the time the aircraft (blue dot) is at that position.` : null };
    } catch (e) { return { init: null, frames: 0, list: [] }; }
  }

  window.SimRadar = { render, panels, color, SCALE };
})();
