'use strict';
// Aviation-style base maps shared by every map in the tool.
//  - A vector layer drawn here: navaids and jet/RNAV or Victor/T airways (FAA NASR data, public/nav/chart.json),
//    which works at any zoom and under the weather overlays.
//  - The FAA's own charts (IFR enroute high and low, VFR sectional) as map tiles from FAA Aeronautical
//    Information Services, which appear when zoomed in far enough to read them. United States only.
(function () {
  const FAA = 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';
  const GRAY = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
  const RELIEF = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}';
  const COL = { high: '#3b6fb5', low: '#5a6b7d', nav: '#1d4e9e' };
  const KEY = 'avbase';
  let dataP = null;
  const data = () => dataP || (dataP = fetch('nav/chart.json').then((r) => (r.ok ? r.json() : null)).catch(() => null));
  const pairs = (a) => { const o = []; for (let i = 0; i < a.length; i += 2) o.push([a[i], a[i + 1]]); return o; };

  // Navaids and airways as a vector layer; labels are drawn for what is in view once zoomed in enough to fit them
  function vector(kind) {
    const g = L.layerGroup(), labels = L.layerGroup(), geo = L.layerGroup();
    let d = null, built = false, map = null;
    const redraw = () => {
      labels.clearLayers();
      if (!d || !map) return;
      // zoomed out to a continent the airways and navaids are only clutter, so they wait until the view is closer
      if (map.getZoom() < 4.6) { if (g.hasLayer(geo)) g.removeLayer(geo); } else if (!g.hasLayer(geo)) g.addLayer(geo);
      const z = map.getZoom(), b = map.getBounds().pad(0.05);
      if (z < 5.5) return;
      const taken = [];
      const free = (ll, w) => { const p = map.latLngToContainerPoint(ll); if (taken.some((q) => Math.abs(q.x - p.x) < w && Math.abs(q.y - p.y) < 16)) return false; taken.push(p); return true; };
      let n = 0;
      for (const v of d.nav) { if (n > 140) break; if (b.contains([v[1], v[2]]) && free([v[1], v[2]], 34)) { L.marker([v[1], v[2]], { icon: L.divIcon({ className: 'avlbl nav', html: v[0], iconSize: null }), interactive: false, keyboard: false }).addTo(labels); n++; } }
      if (z < 6.5) return;
      n = 0;
      for (const [name, pts] of d[kind]) {
        if (n > 90) break;
        const i = Math.floor(pts.length / 4) * 2 - 2, mid = [(pts[i] + pts[i + 2]) / 2, (pts[i + 1] + pts[i + 3]) / 2];
        if (b.contains(mid) && free(mid, 40)) { L.marker(mid, { icon: L.divIcon({ className: 'avlbl awy', html: name, iconSize: null }), interactive: false, keyboard: false }).addTo(labels); n++; }
      }
    };
    g.on('add', async (e) => {
      map = e.target._map || g._map;
      d = d || (await data());
      if (!d || !g._map) return;
      map = g._map;
      if (!built) {
        built = true;
        const rend = L.canvas({ padding: 0.4 });
        for (const [, pts] of d[kind]) L.polyline(pairs(pts), { renderer: rend, color: COL[kind], weight: kind === 'high' ? 0.9 : 0.7, opacity: 0.5, interactive: false }).addTo(geo);
        for (const v of d.nav) L.circleMarker([v[1], v[2]], { renderer: rend, radius: 2.3, color: COL.nav, weight: 1, opacity: 0.8, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(geo);
        labels.addTo(g);
      }
      map.on('moveend', redraw); redraw();
    });
    g.on('remove', () => { if (map) map.off('moveend', redraw); });
    return g;
  }
  const faa = (svc, minZoom, maxNative) => L.tileLayer(`${FAA}${svc}/MapServer/tile/{z}/{y}/{x}`, { minZoom, maxNativeZoom: maxNative, maxZoom: 13, attribution: 'Charts © FAA Aeronautical Information Services', crossOrigin: 'anonymous' });
  const gray = () => L.tileLayer(GRAY, { attribution: 'Tiles © Esri', maxZoom: 13 });

  // Base layers for a layer control. The saved choice (or IFR high) is added to the map.
  function bases(map) {
    const out = {
      'Aviation: IFR high': L.layerGroup([gray(), faa('IFR_High', 7, 9), vector('high')]),
      'Aviation: IFR low': L.layerGroup([gray(), faa('IFR_AreaLow', 7, 12), vector('low')]),
      'Aviation: VFR sectional': L.layerGroup([gray(), faa('VFR_Sectional', 8, 12), vector('low')]),
      'Light': gray(),
      'Terrain': L.tileLayer(RELIEF, { attribution: 'Tiles © Esri', maxZoom: 13 }),
    };
    let pick = 'Aviation: IFR high';
    try { const s = localStorage.getItem(KEY); if (s && out[s]) pick = s; } catch (e) { /* no storage */ }
    out[pick].addTo(map);
    map.on('baselayerchange', (e) => { try { localStorage.setItem(KEY, e.name); } catch (err) { /* no storage */ } });
    return out;
  }

  // The same navaids and airways on a canvas (for the PDF panels). X and Y turn longitude and latitude into pixels.
  async function drawCanvas(g, X, Y, w, h, kind = 'high') {
    const d = await data();
    if (!d) return false;
    const inside = (x, y) => x > -40 && x < w + 40 && y > -40 && y < h + 40;
    g.save(); g.lineWidth = 1; g.strokeStyle = COL[kind]; g.globalAlpha = 0.6;
    for (const [, pts] of d[kind]) {
      g.beginPath(); let on = false;
      for (let i = 0; i < pts.length; i += 2) { const x = X(pts[i + 1]), y = Y(pts[i]); if (on) g.lineTo(x, y); else g.moveTo(x, y); on = true; }
      g.stroke();
    }
    g.globalAlpha = 1; g.font = 'bold 10px Helvetica, Arial, sans-serif'; g.textBaseline = 'middle';
    const taken = [];
    for (const v of d.nav) {
      const x = X(v[2]), y = Y(v[1]);
      if (!inside(x, y)) continue;
      g.beginPath(); g.arc(x, y, 2.6, 0, 7); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 1.1; g.strokeStyle = COL.nav; g.stroke();
      if (taken.some((q) => Math.abs(q[0] - x) < 38 && Math.abs(q[1] - y) < 13)) continue;
      taken.push([x, y]);
      g.lineWidth = 2.5; g.strokeStyle = 'rgba(255,255,255,.85)'; g.strokeText(v[0], x + 5, y); g.fillStyle = COL.nav; g.fillText(v[0], x + 5, y);
    }
    g.restore();
    return true;
  }

  window.AvMap = { bases, drawCanvas, data };
})();
