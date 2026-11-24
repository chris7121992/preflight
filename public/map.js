'use strict';
// Surface analysis map: WPC fronts with standard symbols, analysed isobars from station pressure,
// H/L centers with motion, station plots (wind barbs, temp/dew point, flight category), radar,
// advisories, PIREPs and the route with a time slider that projects fronts to your flight time.
(function () {
  const COLORS = { COLD: '#1d4ed8', WARM: '#dc2626', OCFNT: '#9333ea', STNRY_C: '#1d4ed8', STNRY_W: '#dc2626', TROF: '#d97706', DRYLN: '#92400e', SQLN: '#dc2626' };
  const CAT = { VFR: '#16a34a', MVFR: '#2563eb', IFR: '#dc2626', LIFR: '#c026d3' };
  const R = Math.PI / 180;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const z = (ms) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`; };

  let map, groups = {}, state = {}, stationsCache = null, ctl = null;

  // ------------------------------------------------------------------ geometry helpers
  const shift = (p, dxNm, dyNm) => ({ lat: p.lat + dyNm / 60, lon: p.lon + dxNm / (60 * Math.cos(p.lat * R)) });
  const hav = (a, b) => {
    const dLat = (b.lat - a.lat) * R, dLon = (b.lon - a.lon) * R;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLon / 2) ** 2;
    return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  // ------------------------------------------------------------------ frontal symbols
  function frontLatLngs(f, dtH) {
    return f.points.map((p) => (f.motion && dtH ? shift(p, f.motion.vx * dtH, f.motion.vy * dtH) : p)).map((p) => [p.lat, p.lon]);
  }
  function drawFront(layer, f, latlngs, opts = {}) {
    if (latlngs.length < 2) return;
    const faded = opts.faded;
    const type = f.type;
    const tip = `${{ COLD: 'Cold front', WARM: 'Warm front', OCFNT: 'Occluded front', STNRY: 'Stationary front', TROF: 'Trough', DRYLN: 'Dry line', SQLN: 'Squall line' }[type] || type}${f.motion && f.motion.speedKt >= 5 ? ` moving ${Math.round(f.motion.speedKt)} kt toward ${Math.round(f.motion.towardDeg)}°` : f.motion ? ', nearly stationary' : ''}${opts.label ? ` · ${opts.label}` : ''}`;
    const base = { weight: type === 'TROF' || type === 'DRYLN' ? 2.5 : 3.5, opacity: faded ? 0.55 : 1, interactive: true };
    if (type === 'STNRY') {
      L.polyline(latlngs, { ...base, color: COLORS.STNRY_W }).bindTooltip(tip, { sticky: true }).addTo(layer);
      L.polyline(latlngs, { ...base, color: COLORS.STNRY_C, dashArray: '14 14' }).addTo(layer);
    } else {
      L.polyline(latlngs, { ...base, color: COLORS[type] || '#555', dashArray: type === 'TROF' ? '10 7' : type === 'DRYLN' ? '4 6' : null }).bindTooltip(tip, { sticky: true }).addTo(layer);
    }
    if (type === 'TROF' || type === 'DRYLN') return;
    // Symbols in pixel space, placed on the side the front is moving toward
    const pts = latlngs.map((ll) => map.latLngToLayerPoint(ll));
    let side = 1;
    if (f.motion && (f.motion.vx || f.motion.vy)) {
      const i = Math.floor((pts.length - 1) / 2);
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
      side = Math.sign(-dy * f.motion.vx + dx * -f.motion.vy) || 1;
    }
    const spacing = 34, size = 8;
    let carry = spacing / 2, k = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!len) continue;
      const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
      let s = carry;
      while (s < len) {
        const c = L.point(a.x + dx * s, a.y + dy * s);
        let kind, color, sd = side;
        if (type === 'COLD' || type === 'SQLN') { kind = 'tri'; color = COLORS.COLD; }
        else if (type === 'WARM') { kind = 'semi'; color = COLORS.WARM; }
        else if (type === 'OCFNT') { kind = k % 2 ? 'semi' : 'tri'; color = COLORS.OCFNT; }
        else if (type === 'STNRY') { kind = k % 2 ? 'semi' : 'tri'; color = k % 2 ? COLORS.STNRY_W : COLORS.STNRY_C; sd = k % 2 ? -side : side; }
        const nx = -dy * sd, ny = dx * sd;
        let poly;
        if (kind === 'tri') poly = [L.point(c.x - dx * size, c.y - dy * size), L.point(c.x + dx * size, c.y + dy * size), L.point(c.x + nx * size * 1.3, c.y + ny * size * 1.3)];
        else { poly = []; for (let t = 0; t <= 10; t++) { const th = Math.PI * t / 10; poly.push(L.point(c.x - dx * size * Math.cos(th) + nx * size * Math.sin(th), c.y - dy * size * Math.cos(th) + ny * size * Math.sin(th))); } }
        L.polygon(poly.map((p) => map.layerPointToLatLng(p)), { stroke: false, fillColor: color, fillOpacity: faded ? 0.55 : 1, interactive: false }).addTo(layer);
        s += spacing; k++;
      }
      carry = s - len;
    }
  }

  function centerIcon(c, kind, faded) {
    const color = kind === 'H' ? COLORS.COLD : COLORS.WARM;
    const arrow = c.motion && c.motion.speedKt >= 5
      ? `<svg width="44" height="44" style="position:absolute;left:-7px;top:-7px;overflow:visible"><g transform="rotate(${c.motion.towardDeg} 22 22)"><line x1="22" y1="22" x2="22" y2="-6" stroke="${color}" stroke-width="2"/><path d="M17,-2 L22,-10 L27,-2 Z" fill="${color}"/></g></svg>` : '';
    return L.divIcon({
      className: 'hl-icon', iconSize: [30, 30], iconAnchor: [15, 15],
      html: `<div style="position:relative;width:30px;height:30px;opacity:${faded ? 0.6 : 1}">${arrow}<div class="hl" style="color:${color}">${kind}</div><div class="hlp">${c.pressure}</div></div>`,
    });
  }

  // ------------------------------------------------------------------ isobars
  function stationPressure(m) {
    if (m.slp && m.slp > 940 && m.slp < 1070) return m.slp;
    if (m.altim && (m.elev == null || m.elev < 300)) {
      const mb = m.altim > 100 ? m.altim : m.altim * 33.8639;
      if (mb > 940 && mb < 1070) return mb;
    }
    return null;
  }
  function buildIsobars(stations, box) {
    const obs = stations.map((m) => ({ lat: m.lat, lon: m.lon, p: stationPressure(m) })).filter((o) => o.p != null && o.lat >= box.s - 3 && o.lat <= box.n + 3 && o.lon >= box.w - 3 && o.lon <= box.e + 3);
    if (obs.length < 30) return null;
    const res = 0.5;
    const ny = Math.round((box.n - box.s) / res) + 1, nx = Math.round((box.e - box.w) / res) + 1;
    // bin stations for fast neighbour search
    const bins = new Map();
    for (const o of obs) { const k = `${Math.floor(o.lat)},${Math.floor(o.lon)}`; (bins.get(k) || bins.set(k, []).get(k)).push(o); }
    let grid = [];
    for (let j = 0; j < ny; j++) {
      const row = [];
      for (let i = 0; i < nx; i++) {
        const lat = box.s + j * res, lon = box.w + i * res;
        let wsum = 0, psum = 0, nearest = Infinity;
        for (let a = -3; a <= 3; a++) for (let b = -4; b <= 4; b++) {
          for (const o of bins.get(`${Math.floor(lat) + a},${Math.floor(lon) + b}`) || []) {
            const d2 = (o.lat - lat) ** 2 + ((o.lon - lon) * Math.cos(lat * R)) ** 2;
            nearest = Math.min(nearest, d2);
            const w = 1 / (d2 + 0.05) ** 1.5;
            wsum += w; psum += w * o.p;
          }
        }
        row.push(nearest <= 2.2 * 2.2 && wsum ? psum / wsum : null);
      }
      grid.push(row);
    }
    // two passes of 3x3 smoothing
    for (let pass = 0; pass < 2; pass++) {
      grid = grid.map((row, j) => row.map((v, i) => {
        if (v == null) return null;
        let s = 0, n = 0;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const q = grid[j + a] && grid[j + a][i + b]; if (q != null) { s += q; n++; } }
        return s / n;
      }));
    }
    // marching squares
    const lines = new Map();
    let lo = Infinity, hi = -Infinity;
    for (const row of grid) for (const v of row) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let lev = Math.ceil(lo / 4) * 4; lev <= hi; lev += 4) {
      const segs = [];
      for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const v = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
        if (v.some((x) => x == null)) continue;
        const c = [[box.s + j * res, box.w + i * res], [box.s + j * res, box.w + (i + 1) * res], [box.s + (j + 1) * res, box.w + (i + 1) * res], [box.s + (j + 1) * res, box.w + i * res]];
        const cross = [];
        for (let e = 0; e < 4; e++) {
          const a = v[e], b = v[(e + 1) % 4];
          if ((a < lev) !== (b < lev)) { const t = (lev - a) / (b - a); cross.push([c[e][0] + t * (c[(e + 1) % 4][0] - c[e][0]), c[e][1] + t * (c[(e + 1) % 4][1] - c[e][1])]); }
        }
        if (cross.length === 2) segs.push(cross);
        else if (cross.length === 4) { segs.push([cross[0], cross[1]]); segs.push([cross[2], cross[3]]); }
      }
      if (segs.length) lines.set(lev, segs);
    }
    return lines;
  }
  // join segments into polylines so lines can be labelled and drawn smoothly
  function joinSegments(segs) {
    const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    const ends = new Map();
    segs.forEach((s, i) => { for (const e of [0, 1]) { const k = key(s[e]); (ends.get(k) || ends.set(k, []).get(k)).push([i, e]); } });
    const used = new Set(), out = [];
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      const line = [segs[i][0], segs[i][1]];
      for (const dir of [1, 0]) {
        for (;;) {
          const tipPt = dir ? line[line.length - 1] : line[0];
          const nxt = (ends.get(key(tipPt)) || []).find(([si]) => !used.has(si));
          if (!nxt) break;
          used.add(nxt[0]);
          const other = segs[nxt[0]][1 - nxt[1]];
          if (dir) line.push(other); else line.unshift(other);
        }
      }
      out.push(line);
    }
    return out;
  }

  // ------------------------------------------------------------------ station plots
  function barbSvg(dir, spd) {
    if (dir == null || spd == null || spd < 3) return `<circle cx="30" cy="30" r="9" fill="none" stroke="#111" stroke-width="1"/>`;
    let s = Math.round(spd / 5) * 5;
    const parts = [];
    let y = -28;
    const flags = [];
    while (s >= 50) { flags.push('P'); s -= 50; }
    while (s >= 10) { flags.push('F'); s -= 10; }
    if (s >= 5) flags.push('H');
    for (const f of flags) {
      if (f === 'P') { parts.push(`<path d="M0,${y} L10,${y + 3} L0,${y + 7} Z" fill="#111"/>`); y += 8; }
      else if (f === 'F') { parts.push(`<line x1="0" y1="${y}" x2="11" y2="${y - 5}" stroke="#111" stroke-width="1.4"/>`); y += 4; }
      else { if (y === -28) y += 4; parts.push(`<line x1="0" y1="${y}" x2="6" y2="${y - 2.7}" stroke="#111" stroke-width="1.4"/>`); }
    }
    return `<g transform="translate(30 30) rotate(${dir})"><line x1="0" y1="-5" x2="0" y2="-28" stroke="#111" stroke-width="1.4"/>${parts.join('')}</g>`;
  }
  function stationIcon(m) {
    const cat = m.fltCat || 'VFR';
    const wdir = typeof m.wdir === 'number' ? m.wdir : null;
    const svg = `<svg width="60" height="60" viewBox="0 0 60 60" style="overflow:visible">${barbSvg(wdir, m.wspd)}<circle cx="30" cy="30" r="4.5" fill="${CAT[cat] || '#888'}" stroke="#111" stroke-width="0.8"/>
      ${m.temp != null ? `<text x="20" y="25" text-anchor="end" class="st-t">${Math.round(m.temp)}</text>` : ''}
      ${m.dewp != null ? `<text x="20" y="42" text-anchor="end" class="st-d">${Math.round(m.dewp)}</text>` : ''}
      ${m.slp ? `<text x="40" y="25" class="st-p">${String(Math.round(m.slp * 10) % 1000).padStart(3, '0')}</text>` : ''}
      ${m.wxString ? `<text x="20" y="34" text-anchor="end" class="st-w">${esc(m.wxString.split(' ')[0])}</text>` : ''}</svg>`;
    return L.divIcon({ className: 'st-icon', html: svg, iconSize: [60, 60], iconAnchor: [30, 30] });
  }
  function drawStations() {
    const layer = groups.stations;
    layer.clearLayers();
    if (!stationsCache || !map.hasLayer(layer)) return;
    const b = map.getBounds().pad(0.05);
    const taken = [];
    const minPx = map.getZoom() >= 7 ? 46 : 54;
    // larger airports first so they win the thinning
    const list = stationsCache.filter((m) => b.contains([m.lat, m.lon])).sort((a, c) => (c.slp ? 1 : 0) - (a.slp ? 1 : 0));
    for (const m of list) {
      const p = map.latLngToContainerPoint([m.lat, m.lon]);
      if (taken.some((q) => Math.abs(q.x - p.x) < minPx && Math.abs(q.y - p.y) < minPx)) continue;
      taken.push(p);
      L.marker([m.lat, m.lon], { icon: stationIcon(m), keyboard: false }).bindPopup(`<b>${esc(m.icaoId)}</b> <span class="pill ${esc(m.fltCat || '')}">${esc(m.fltCat || '')}</span><br><code>${esc(m.rawOb)}</code>`).addTo(layer);
      if (taken.length > 220) break;
    }
  }

  // ------------------------------------------------------------------ time handling
  function interpRoute(profile, t) {
    if (!profile.length) return null;
    const ts = profile.map((p) => Date.parse(p.t));
    if (t <= ts[0]) return profile[0];
    if (t >= ts[ts.length - 1]) return profile[profile.length - 1];
    for (let i = 1; i < ts.length; i++) if (t <= ts[i]) {
      const f = (t - ts[i - 1]) / (ts[i] - ts[i - 1]), a = profile[i - 1], c = profile[i];
      return { lat: a.lat + f * (c.lat - a.lat), lon: a.lon + f * (c.lon - a.lon), alt: a.alt + f * (c.alt - a.alt), s: a.s + f * (c.s - a.s), phase: c.phase };
    }
    return profile[profile.length - 1];
  }

  function drawSynoptic() {
    const b = state.b, sf = (b && b.surface) || {};
    const layer = groups.fronts, cl = groups.centers;
    layer.clearLayers(); cl.clearLayers();
    const mode = state.mode;
    if (mode === 'analysis' || mode === 'flight') {
      const t0 = sf.analysisValid ? Date.parse(sf.analysisValid) : Date.now();
      const dtH = mode === 'flight' ? (state.t - t0) / 3600e3 : 0;
      const label = mode === 'flight' ? `projected to ${z(state.t)}` : `analysis ${z(t0)}`;
      for (const f of sf.analysisFronts || []) drawFront(layer, f, frontLatLngs(f, dtH), { label });
      for (const [list, kind] of [[sf.analysisHighs || [], 'H'], [sf.analysisLows || [], 'L']]) for (const c of list) {
        let p = c;
        if (mode === 'flight' && c.motion && c.motion.speedKt) { const d = c.motion.speedKt * dtH; p = shift(c, d * Math.sin(c.motion.towardDeg * R), d * Math.cos(c.motion.towardDeg * R)); }
        L.marker([p.lat, p.lon], { icon: centerIcon(c, kind), keyboard: false }).bindTooltip(`${kind === 'H' ? 'High' : 'Low'} ${c.pressure} mb${c.motion ? ` · moving ${c.motion.towardCompass} ${c.motion.speedKt} kt, ${c.motion.pressureTrend > 0 ? '+' : ''}${c.motion.pressureTrend} mb/12 h` : ''}`).addTo(cl);
      }
    } else {
      const prog = (sf.progs || []).find((p) => p.label === mode);
      if (prog) {
        for (const f of prog.fronts) drawFront(layer, { ...f, motion: null }, f.points.map((p) => [p.lat, p.lon]), { label: `${prog.label} valid ${z(Date.parse(prog.valid))}` });
        for (const [list, kind] of [[prog.highs, 'H'], [prog.lows, 'L']]) for (const c of list) L.marker([c.lat, c.lon], { icon: centerIcon(c, kind) }).bindTooltip(`${kind === 'H' ? 'High' : 'Low'} ${c.pressure} mb (${prog.label})`).addTo(cl);
      }
    }
    // aircraft at the selected time
    groups.aircraft.clearLayers();
    if (mode === 'flight') {
      const p = interpRoute(b.profile, state.t);
      if (p) L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'ac-icon', html: `<div class="ac">✈</div><div class="ac-l">${p.alt >= 18000 ? 'FL' + Math.round(p.alt / 100) : Math.round(p.alt).toLocaleString() + ' ft'} · ${z(state.t)}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000 }).addTo(groups.aircraft);
    }
    const cap = document.getElementById('mapCaption');
    if (cap) {
      cap.textContent = mode === 'analysis' ? `WPC surface analysis valid ${z(Date.parse(sf.analysisValid))}. Isobars every 4 mb, analysed from current station pressure.`
        : mode === 'flight' ? `Fronts and pressure centers projected to ${z(state.t)} from their analysis-to-12 h prog motion; aircraft position from your profile.`
          : `WPC ${mode} fronts and pressure centers.`;
    }
  }

  // ------------------------------------------------------------------ main render
  async function render(b) {
    state.b = b;
    const host = document.getElementById('map');
    if (!window.L) { host.innerHTML = '<p class="hint">Map library failed to load.</p>'; return; }
    if (!map) {
      map = L.map('map', { worldCopyJump: true, zoomSnap: 0.5, preferCanvas: false });
      const light = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri', maxZoom: 13 });
      const terrain = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri', maxZoom: 13 });
      light.addTo(map);
      const radar = L.tileLayer('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png', { opacity: 0.55, attribution: 'NEXRAD © Iowa Environmental Mesonet', maxZoom: 13 });
      for (const k of ['isobars', 'fronts', 'centers', 'stations', 'hazards', 'pireps', 'route', 'aircraft']) groups[k] = L.layerGroup();
      ['isobars', 'fronts', 'centers', 'stations', 'hazards', 'route', 'aircraft'].forEach((k) => groups[k].addTo(map));
      ctl = L.control.layers({ 'Light': light, 'Terrain': terrain }, {
        'Radar (NEXRAD, live)': radar, 'Isobars (4 mb)': groups.isobars, 'Fronts': groups.fronts, 'Highs / lows': groups.centers,
        'Station plots': groups.stations, 'SIGMET / G-AIRMET / CWA on route': groups.hazards, 'PIREPs near route': groups.pireps,
      }, { collapsed: true }).addTo(map);
      map.on('zoomend', () => { drawSynoptic(); drawStations(); });
      map.on('moveend', drawStations);
      map.on('overlayadd', (e) => { if (e.layer === groups.stations) drawStations(); });
      addLegend();
      bindTimeBar();
    }
    // Route
    groups.route.clearLayers();
    const route = b.plan.route.map((w) => [w.lat, w.lon]);
    L.polyline(route, { color: '#fff', weight: 7, opacity: 0.9 }).addTo(groups.route);
    L.polyline(route, { color: '#111', weight: 3.5 }).addTo(groups.route);
    for (const w of b.plan.route) L.circleMarker([w.lat, w.lon], { radius: 4.5, color: '#111', fillColor: '#fff', fillOpacity: 1, weight: 2 }).bindTooltip(w.id, { permanent: b.plan.route.length <= 10, direction: 'right', className: 'wp-label' }).addTo(groups.route);
    const rec = b.routing && b.routing.route && b.routing.route.recommendation;
    if (rec && !rec.keepFiled && rec.best && rec.best.points) {
      L.polyline(rec.best.points.map((p) => [p.lat, p.lon]), { color: '#16a34a', weight: 3.5, dashArray: '9 7' }).bindTooltip(`Suggested re-route: ${rec.best.name}`, { sticky: true }).addTo(groups.route);
    }
    const pr = b.routing && b.routing.procedures;
    for (const [x, kind, end] of pr ? [[pr.sid, 'SID', b.plan.route[0]], [pr.star, 'STAR', b.plan.route[b.plan.route.length - 1]]] : []) {
      if (!x) continue;
      const pts = kind === 'SID' ? [end, ...x.pick.points] : [...x.pick.points, end];
      L.polyline(pts.map((p) => [p.lat, p.lon]), { color: '#0d9488', weight: 3 }).bindTooltip(`${kind} ${x.pick.code}`, { sticky: true }).addTo(groups.route);
      for (const p of x.pick.points) L.circleMarker([p.lat, p.lon], { radius: 3, color: '#0d9488', fillColor: '#fff', fillOpacity: 1, weight: 1.5 }).bindTooltip(p.id, { direction: 'right', className: 'wp-label' }).addTo(groups.route);
    }
    for (const f of (b.surface && b.surface.fronts) || []) if (f.crossesRoute && f.encounter) {
      L.circleMarker([f.encounter.lat, f.encounter.lon], { radius: 8, color: '#b45309', weight: 3, fill: false }).bindTooltip(`Meets ${f.name} ~${z(Date.parse(f.encounter.time))} (${f.encounter.alongRouteNm} nm)`).addTo(groups.route);
    }
    // Hazards
    groups.hazards.clearLayers();
    for (const h of b.hazards) {
      const color = /CONVECTIVE|TS/.test(h.hazard) ? '#dc2626' : /ICE/.test(h.hazard) ? '#0284c7' : /TURB/.test(h.hazard) ? '#d97706' : '#6b7280';
      L.polygon(h.coords.map((c) => [c.lat, c.lon]), { color, weight: 1.5, fillOpacity: 0.12, dashArray: h.kind === 'G-AIRMET' ? '5 4' : null }).bindPopup(`<b>${esc(h.label)}</b><br>Route at ${h.alongNm} nm ~${z(Date.parse(h.at))}${h.raw ? `<pre style="white-space:pre-wrap;max-width:320px">${esc(h.raw)}</pre>` : ''}`).addTo(groups.hazards);
    }
    // PIREPs
    groups.pireps.clearLayers();
    for (const p of b.pireps) {
      const sev = /SEV/.test(p.turb + p.ice) ? '#b91c1c' : /MOD/.test(p.turb + p.ice) ? '#d97706' : '#64748b';
      L.circleMarker([p.lat, p.lon], { radius: 4, color: sev, fillColor: sev, fillOpacity: 1, weight: 1 }).bindPopup(`<b>PIREP</b> ${esc(p.ac || '')}<br><code>${esc(p.raw)}</code>`).addTo(groups.pireps);
    }
    map.fitBounds(L.latLngBounds(route).pad(0.45));
    setTimeout(() => map.invalidateSize(), 50);

    // Time bar
    const sf = b.surface || {};
    const tEtd = Date.parse(b.plan.etd), tEta = Date.parse(b.plan.eta);
    state.tStart = tEtd; state.tEnd = tEta; state.t = tEtd; state.mode = 'analysis';
    const bar = document.getElementById('mapModes');
    bar.innerHTML = [['analysis', `Analysis ${sf.analysisValid ? z(Date.parse(sf.analysisValid)) : ''}`], ['flight', 'During your flight'], ...((sf.progs || []).map((p) => [p.label, `${p.label} (${z(Date.parse(p.valid))})`]))]
      .map(([k, l]) => `<button type="button" data-mode="${esc(k)}" class="${k === 'analysis' ? 'on' : ''}">${esc(l)}</button>`).join('');
    const slider = document.getElementById('mapTime');
    slider.min = 0; slider.max = 100; slider.value = 0;
    document.getElementById('mapTimeWrap').hidden = true;

    // Isobars and station plots from the snapshot's national METARs
    groups.isobars.clearLayers();
    try {
      if (!stationsCache) {
        const cfg = window.PREFLIGHT_CONFIG || {};
        if (cfg.snapshot) stationsCache = await (await fetch(`${cfg.snapshot}/metars.json?t=${Math.floor(Date.now() / 60e3)}`)).json();
        else stationsCache = b.enroute.map((e) => ({ icaoId: e.id, rawOb: e.raw, lat: e.lat, lon: e.lon, fltCat: e.cat }));
      }
      const bb = map.getBounds();
      const box = { s: Math.max(10, Math.floor(bb.getSouth()) - 4), n: Math.min(72, Math.ceil(bb.getNorth()) + 4), w: Math.max(-170, Math.floor(bb.getWest()) - 6), e: Math.min(-50, Math.ceil(bb.getEast()) + 6) };
      const lines = buildIsobars(stationsCache, box);
      if (lines) for (const [lev, segs] of lines) {
        const polys = joinSegments(segs);
        const strong = lev % 8 === 0;
        L.polyline(polys, { color: '#475569', weight: strong ? 1.4 : 1, opacity: 0.75, interactive: false, smoothFactor: 1.5 }).addTo(groups.isobars);
        polys.filter((pl) => pl.length > 14).forEach((pl) => {
          const mid = pl[Math.floor(pl.length / 2)];
          L.marker(mid, { icon: L.divIcon({ className: 'iso-l', html: `<span>${lev}</span>`, iconSize: [34, 14], iconAnchor: [17, 7] }), interactive: false, keyboard: false }).addTo(groups.isobars);
        });
      }
    } catch (e) { console.warn('isobars', e); }
    drawSynoptic();
    drawStations();
  }

  function bindTimeBar() {
    document.getElementById('mapModes').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      state.mode = btn.dataset.mode;
      document.querySelectorAll('#mapModes button').forEach((x) => x.classList.toggle('on', x === btn));
      document.getElementById('mapTimeWrap').hidden = state.mode !== 'flight';
      // Isobars and station plots are current observations: show them only for the analysis/flight views
      const obs = state.mode === 'analysis' || state.mode === 'flight';
      for (const k of ['isobars', 'stations']) if (!obs && map.hasLayer(groups[k])) { map.removeLayer(groups[k]); groups[k]._autoHidden = true; } else if (obs && groups[k]._autoHidden) { groups[k].addTo(map); groups[k]._autoHidden = false; }
      drawSynoptic(); drawStations();
    });
    const slider = document.getElementById('mapTime');
    slider.addEventListener('input', () => {
      state.t = state.tStart + (state.tEnd - state.tStart) * (slider.value / 100);
      document.getElementById('mapTimeLabel').textContent = z(state.t);
      drawSynoptic();
    });
  }

  function addLegend() {
    const lg = L.control({ position: 'bottomleft' });
    lg.onAdd = () => {
      const d = L.DomUtil.create('div', 'map-legend');
      const tri = (c) => `<svg width="34" height="14"><line x1="0" y1="11" x2="34" y2="11" stroke="${c}" stroke-width="3"/><path d="M6,11 L14,11 L10,3 Z M20,11 L28,11 L24,3 Z" fill="${c}"/></svg>`;
      const semi = (c) => `<svg width="34" height="14"><line x1="0" y1="11" x2="34" y2="11" stroke="${c}" stroke-width="3"/><path d="M5,11 A5,5 0 0 1 15,11 Z M19,11 A5,5 0 0 1 29,11 Z" fill="${c}"/></svg>`;
      d.innerHTML = `<div>${tri(COLORS.COLD)} Cold</div><div>${semi(COLORS.WARM)} Warm</div>
        <div><svg width="34" height="14"><line x1="0" y1="11" x2="34" y2="11" stroke="${COLORS.OCFNT}" stroke-width="3"/><path d="M5,11 L13,11 L9,3 Z M19,11 A5,5 0 0 1 29,11 Z" fill="${COLORS.OCFNT}"/></svg> Occluded</div>
        <div><svg width="34" height="16"><line x1="0" y1="8" x2="34" y2="8" stroke="${COLORS.STNRY_W}" stroke-width="3"/><line x1="0" y1="8" x2="17" y2="8" stroke="${COLORS.STNRY_C}" stroke-width="3"/><path d="M4,8 L12,8 L8,1 Z" fill="${COLORS.STNRY_C}"/><path d="M20,8 A5,5 0 0 0 30,8 Z" fill="${COLORS.STNRY_W}"/></svg> Stationary</div>
        <div><svg width="34" height="14"><line x1="0" y1="8" x2="34" y2="8" stroke="${COLORS.TROF}" stroke-width="2.5" stroke-dasharray="8 5"/></svg> Trough</div>
        <div><svg width="34" height="14"><line x1="0" y1="8" x2="34" y2="8" stroke="#475569" stroke-width="1.2"/></svg> Isobar (mb)</div>
        <div class="lg-cats"><i style="background:${CAT.VFR}"></i>VFR <i style="background:${CAT.MVFR}"></i>MVFR <i style="background:${CAT.IFR}"></i>IFR <i style="background:${CAT.LIFR}"></i>LIFR</div>`;
      L.DomEvent.disableClickPropagation(d);
      return d;
    };
    lg.addTo(map);
  }

  window.SurfaceMap = { render };
})();
