/* NOTAM closure guide: reads NOTAM text out of a ForeFlight briefing PDF and draws runway and taxiway
   closures on an airport diagram built from OpenStreetMap aerodrome geometry. */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const COLORS = { closed: '#d92d20', restricted: '#d92d20', affected: '#e8910c' };
  const maps = [];

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the PDF reader')); document.head.appendChild(s); });
  }

  // Text of a PDF with its line breaks rebuilt from the position of each text run
  async function readPdf(file) {
    if (!window.pdfjsLib) { await loadScript(PDFJS + 'pdf.min.js'); window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; }
    const doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = it.transform[5], x = it.transform[4];
        let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
        if (!row) rows.push((row = { y, items: [] }));
        row.items.push({ x, s: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      // keep paragraph gaps as blank lines: ICAO-format NOTAMs end at one
      const lines = [];
      rows.forEach((r, k) => { if (k && rows[k - 1].y - r.y > 20) lines.push(''); lines.push(r.items.sort((a, b) => a.x - b.x).map((q) => q.s).join(' ')); });
      pages.push(lines.join('\n'));
    }
    return pages.join('\n\n');
  }

  // ---------------------------------------------------------------- geometry
  // One Overpass request covers every airport in the brief; results are kept in the browser for a week.
  const cache = new Map();
  const LS = 'adgeom2:';
  function cached(id) {
    if (cache.has(id)) return cache.get(id);
    try { const v = JSON.parse(localStorage.getItem(LS + id) || 'null'); if (v && Date.now() - v.t < 7 * 864e5) { cache.set(id, v.els); return v.els; } } catch (e) { /* no storage */ }
    return null;
  }
  const KIND = { r: 'runway', t: 'taxiway', l: 'taxilane', p: 'apron' };
  const key = (g) => `${g.lat.toFixed(6)},${g.lon.toFixed(6)}`;
  // Ways that touch share a point, so the point itself serves as the node id
  const way = (aeroway, r, geometry) => ({ tags: { aeroway, ref: r || '' }, geometry, nodes: geometry.map(key) });
  function keep(a, els, store) {
    if (!els.some((e) => e.tags.aeroway === 'runway')) return false;
    cache.set(a.id, els);
    if (store) { try { localStorage.setItem(LS + a.id, JSON.stringify({ t: Date.now(), els })); } catch (e) { /* storage full */ } }
    return true;
  }
  let layoutIndex = null;
  async function loadGeometry(airports, onStep) {
    let need = airports.filter((a) => a.lat != null && !cached(a.id));
    if (!need.length) return;
    // 1. layouts stored with the site (built from OpenStreetMap by scripts/layouts.js)
    if (!layoutIndex) layoutIndex = fetch('layout/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => new Set((j && j.airports) || [])).catch(() => new Set());
    const have = await layoutIndex;
    await Promise.all(need.map(async (a) => {
      const id = [a.id, ...(a.ids || [])].find((x) => have.has(x));
      if (!id) return;
      try {
        const j = await (await fetch(`layout/${id}.json`)).json();
        keep(a, j.ways.map((w) => { const g = []; for (let i = 0; i < w.g.length; i += 2) g.push({ lat: w.g[i], lon: w.g[i + 1] }); return way(KIND[w.a], w.r, g); }), false);
      } catch (e) { /* fall through to the live query */ }
    }));
    need = need.filter((a) => !cached(a.id));
    if (onStep) onStep(need);
    if (!need.length) return;
    // 2. anything else straight from OpenStreetMap
    const q = `[out:json][timeout:25];(${need.map((a) => `way["aeroway"~"^(runway|taxiway|taxilane|apron)$"](around:3800,${a.lat},${a.lon});`).join('')});out tags geom;`;
    for (let round = 0; round < 2; round++) {
      for (const url of OVERPASS) {
        try {
          const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 28000);
          const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
          clearTimeout(to);
          if (!r.ok) continue;
          const j = await r.json();
          if (!j || !Array.isArray(j.elements)) continue;
          const els = j.elements.filter((e) => e.geometry && e.geometry.length > 1 && e.tags && e.tags.runway !== 'displaced_threshold');
          for (const a of need) keep(a, els.filter((e) => dist(mid(e.geometry), a) < 4500).map((e) => way(e.tags.aeroway, e.tags.ref, e.geometry.map((g) => ({ lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6) })))), true);
          return;
        } catch (e) { /* try the next mirror */ }
      }
    }
  }

  // OpenStreetMap runways sometimes carry no number; name them from the airport database by direction
  function nameRunways(els, a) {
    const db = (a.runways || []).map((r) => ({ id: String(r.id), hdg: Number(r.alignment) || (parseInt(r.id, 10) || 0) * 10 }));
    const known = new Set(db.flatMap((r) => rwyEnds(r.id)));
    const k = Math.cos((a.lat * Math.PI) / 180);
    const todo = els.filter((e) => e.tags.aeroway === 'runway' && !rwyEnds(ref(e)).some((x) => known.has(x)));
    for (const e of todo) {
      const g = e.geometry, brg = ((Math.atan2((g[g.length - 1].lon - g[0].lon) * k, g[g.length - 1].lat - g[0].lat) * 180) / Math.PI + 360) % 360;
      const cands = db.filter((r) => { const d = Math.abs(((brg - r.hdg + 540) % 180) - 90); return d > 78; }).filter((r) => !els.some((o) => o !== e && o.tags.aeroway === 'runway' && sameRwy(ref(o), r.id)));
      if (cands.length === 1) e.tags.ref = cands[0].id;
      else if (cands.length > 1) {
        // parallels: order the candidates left to right looking along the first end's heading
        const h = (cands[0].hdg * Math.PI) / 180, m = mid(g);
        const off = (m.lon - a.lon) * 111320 * k * Math.cos(h) - (m.lat - a.lat) * 111320 * Math.sin(h);
        const peers = todo.filter((o) => { const og = o.geometry, ob = ((Math.atan2((og[og.length - 1].lon - og[0].lon) * k, og[og.length - 1].lat - og[0].lat) * 180) / Math.PI + 360) % 360; return Math.abs(((ob - cands[0].hdg + 540) % 180) - 90) > 78; })
          .map((o) => { const mm = mid(o.geometry); return { o, off: (mm.lon - a.lon) * 111320 * k * Math.cos(h) - (mm.lat - a.lat) * 111320 * Math.sin(h) }; }).sort((x, y) => x.off - y.off);
        const order = [...cands].sort((x, y) => 'LCR'.indexOf((/[LCR]/.exec(rwyEnds(x.id)[0]) || ['C'])[0]) - 'LCR'.indexOf((/[LCR]/.exec(rwyEnds(y.id)[0]) || ['C'])[0]));
        const i = peers.findIndex((x) => x.o === e);
        void off;
        if (order[i]) e.tags.ref = order[i].id;
      }
    }
    return els;
  }

  const mid = (g) => g[Math.floor(g.length / 2)];
  const rwyEnds = (s) => String(s || '').toUpperCase().split('/').map((x) => x.trim().replace(/^0/, ''));
  const sameRwy = (a, b) => rwyEnds(a).some((x) => x && rwyEnds(b).includes(x));
  const dist = (p, q) => { const k = Math.cos((p.lat * Math.PI) / 180); return Math.hypot((p.lat - q.lat) * 111320, (p.lon - q.lon) * 111320 * k); };
  const ref = (e) => String((e.tags && e.tags.ref) || '').toUpperCase().trim();

  // Runways drawn from the airport database when OpenStreetMap has nothing (straight lines, no taxiways)
  function schematic(a) {
    return (a.runways || []).map((r) => {
      const len = (parseInt(String(r.dimension || '').split('x')[0], 10) || 5000) * 0.3048, h = ((Number(r.alignment) || (parseInt(r.id, 10) || 0) * 10) * Math.PI) / 180;
      const dLat = (Math.cos(h) * len) / 2 / 111320, dLon = (Math.sin(h) * len) / 2 / (111320 * Math.cos((a.lat * Math.PI) / 180));
      return { type: 'way', id: 'r' + r.id, tags: { aeroway: 'runway', ref: r.id }, nodes: ['a' + r.id, 'b' + r.id], geometry: [{ lat: a.lat - dLat, lon: a.lon - dLon }, { lat: a.lat + dLat, lon: a.lon + dLon }] };
    });
  }

  // Part of taxiway `name` between two limits, as lists of points; null when the limits cannot be placed
  function between(els, name, limits) {
    const ways = els.filter((e) => /taxiway|taxilane/.test(e.tags.aeroway) && ref(e) === name);
    if (!ways.length) return null;
    const pos = new Map(), adj = new Map();
    for (const w of ways) w.nodes.forEach((n, i) => {
      pos.set(n, w.geometry[i]);
      if (!adj.has(n)) adj.set(n, new Set());
      if (i) { adj.get(n).add(w.nodes[i - 1]); adj.get(w.nodes[i - 1]).add(n); }
    });
    const junction = (lim) => {
      if (!lim || lim.kind === 'TEXT') return [];
      const others = els.filter((e) => (lim.kind === 'RWY' ? e.tags.aeroway === 'runway' && sameRwy(ref(e), lim.name) : /taxiway|taxilane/.test(e.tags.aeroway) && ref(e) === lim.name));
      if (!others.length) return [];
      if (lim.kind === 'RWY' && lim.end) {
        // the named threshold: the end of the runway line whose number is given
        const o = others[0], ends = rwyEnds(ref(o)), g = o.geometry, num = parseInt(lim.name, 10) * 10;
        const brg = (Math.atan2((g[g.length - 1].lon - g[0].lon) * Math.cos((g[0].lat * Math.PI) / 180), g[g.length - 1].lat - g[0].lat) * 180) / Math.PI;
        const d = Math.abs(((brg - num + 540) % 360) - 180);
        const thr = d < 90 ? g[0] : g[g.length - 1];
        void ends;
        const near = [...pos.entries()].map(([n, p]) => [n, dist(p, thr)]).sort((x, y) => x[1] - y[1])[0];
        return near && near[1] < 400 ? [near[0]] : [];
      }
      const shared = new Set();
      for (const o of others) for (const n of o.nodes) if (pos.has(n)) shared.add(n);
      if (shared.size) return [...shared];
      let best = null;
      for (const [n, p] of pos) for (const o of others) for (const g of o.geometry) { const d = dist(p, g); if (!best || d < best[1]) best = [n, d]; }
      return best && best[1] < 60 ? [best[0]] : [];
    };
    const A = junction(limits[0]), B = junction(limits[1]);
    if (!A.length || !B.length) return null;
    let bestPath = null;
    for (const s of A) {
      const prev = new Map([[s, null]]), queue = [s];
      while (queue.length) { const n = queue.shift(); for (const m of adj.get(n) || []) if (!prev.has(m)) { prev.set(m, n); queue.push(m); } }
      for (const t of B) {
        if (!prev.has(t) || t === s) continue;
        const path = []; for (let n = t; n != null; n = prev.get(n)) path.push(n);
        if (!bestPath || path.length < bestPath.length) bestPath = path;
      }
    }
    return bestPath ? [bestPath.map((n) => [pos.get(n).lat, pos.get(n).lon])] : null;
  }

  function label(text, cls) { return L.divIcon({ className: 'adlabel ' + (cls || ''), html: esc(text), iconSize: null }); }
  const fmtT = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(5, 16) + 'Z' : '');
  const when = (n) => (n.start ? `${fmtT(n.start)} to ${n.perm ? 'permanent' : n.end ? fmtT(n.end) : 'further notice'}` : 'time not stated');

  // What to draw for one airport: shapes with their closure state. Shared by the on-screen map and the PDF brief.
  function model(a, list) {
    const act = list.filter((n) => n.active);
    const items = act.flatMap((n) => (n.items || []).map((it) => ({ ...it, n })));
    const shown = items.filter((it) => it.status !== 'minor');
    let els = cached(a.id);
    const osm = !!els;
    els = osm ? nameRunways(els.map((e) => ({ ...e, tags: { ...e.tags } })), a) : schematic(a);
    const m = { osm, shown, aprons: [], twys: [], segs: [], xs: [], rwys: [], labels: [], bounds: [] };
    for (const e of els.filter((x) => x.tags.aeroway === 'apron')) m.aprons.push(e.geometry.map((g) => [g.lat, g.lon]));
    const twys = els.filter((x) => /taxiway|taxilane/.test(x.tags.aeroway));
    // Closed sections between two limits, and closures at an intersection
    for (const it of shown.filter((x) => x.kind === 'TWY' && x.status === 'restricted')) {
      if (it.between) {
        const seg = between(els, it.name, it.between);
        if (seg) { m.segs.push({ ll: seg, it }); it.placed = true; }
      } else if (it.at) {
        const mine = twys.filter((e) => ref(e) === it.name), other = els.filter((e) => (it.at.kind === 'RWY' ? e.tags.aeroway === 'runway' && sameRwy(ref(e), it.at.name) : ref(e) === it.at.name && /taxi/.test(e.tags.aeroway)));
        let best = null;
        for (const w of mine) for (const g of w.geometry) for (const o of other) for (const h of o.geometry) { const d = dist(g, h); if (!best || d < best.d) best = { d, g }; }
        if (best && best.d < 80) { m.xs.push({ lat: best.g.lat, lon: best.g.lon, it }); it.placed = true; }
      }
    }
    // Taxiways (a partly closed one is dotted only when its closed section could not be placed)
    const labelled = new Map();
    for (const e of twys) {
      const name = ref(e), its = shown.filter((it) => it.kind !== 'RWY' && it.name === name);
      const whole = its.filter((it) => it.status === 'closed'), part = its.filter((it) => it.status !== 'closed' && !it.placed);
      const state = whole.length ? 'closed' : part.length ? (part.some((p) => p.status === 'affected') && !part.some((p) => p.status === 'restricted') ? 'dotAffected' : 'dotClosed') : '';
      m.twys.push({ ll: e.geometry.map((g) => [g.lat, g.lon]), state, lane: e.tags.aeroway === 'taxilane', its });
      if (name) { const len = e.geometry.length; const cur = labelled.get(name); if (!cur || len > cur.len) labelled.set(name, { len, at: mid(e.geometry), hit: its.length ? (whole.length ? 'closed' : 'part') : '' }); }
    }
    for (const e of els.filter((x) => x.tags.aeroway === 'runway')) {
      const its = shown.filter((it) => it.kind === 'RWY' && sameRwy(it.name, ref(e)));
      const closed = its.some((it) => it.status === 'closed');
      const ll = e.geometry.map((g) => [g.lat, g.lon]);
      ll.forEach((p) => m.bounds.push(p));
      const r = { ll, closed, its, marks: [], ends: [] };
      if (closed) for (const f of [0.2, 0.5, 0.8]) { const i = Math.min(ll.length - 2, Math.floor(f * (ll.length - 1))), t = f * (ll.length - 1) - i; r.marks.push([ll[i][0] + (ll[i + 1][0] - ll[i][0]) * t, ll[i][1] + (ll[i + 1][1] - ll[i][1]) * t]); }
      // end numbers: the lower number sits at the end the runway line points away from
      const ends = rwyEnds(ref(e));
      if (ends.length === 2 && ends[0]) {
        const g = e.geometry, brg = (Math.atan2((g[g.length - 1].lon - g[0].lon) * Math.cos((g[0].lat * Math.PI) / 180), g[g.length - 1].lat - g[0].lat) * 180) / Math.PI;
        const first = Math.abs(((brg - parseInt(ends[0], 10) * 10 + 540) % 360) - 180) < 90 ? 0 : 1;
        r.ends.push({ at: [g[0].lat, g[0].lon], text: ends[first] }, { at: [g[g.length - 1].lat, g[g.length - 1].lon], text: ends[1 - first] });
      }
      m.rwys.push(r);
    }
    for (const [name, v] of labelled) m.labels.push({ name, at: [v.at.lat, v.at.lon], hit: v.hit });
    m.missing = [...new Set(shown.filter((it) => it.kind === 'TWY' && !twys.some((e) => ref(e) === it.name)).map((x) => x.name))];
    m.unplaced = [...new Set(shown.filter((it) => it.kind === 'TWY' && it.status === 'restricted' && !it.placed && twys.some((e) => ref(e) === it.name)).map((x) => x.name))];
    return m;
  }

  function drawAirport(a, list, box) {
    const mapEl = box.querySelector('.admap'), note = box.querySelector('.adnote');
    if (a.lat == null || !window.L) { mapEl.remove(); return; }
    const m = model(a, list), osm = m.osm;
    if (mapEl._ad) { try { mapEl._ad.remove(); } catch (e) { /* gone */ } }
    const map = (mapEl._ad = L.map(mapEl, { zoomSnap: 0.25, attributionControl: true, scrollWheelZoom: false }));
    maps.push(map);
    map.attributionControl.setPrefix(false).addAttribution(osm ? 'Layout © OpenStreetMap contributors' : 'Runways from OurAirports');
    const tip = (its) => its.map((it) => `<b>${esc(it.n.number || '')}</b> ${esc(it.n.text)}<br><span class="hint">${esc(when(it.n))}</span>`).join('<hr>');
    for (const ll of m.aprons) L.polygon(ll, { className: 'ad-apron', weight: 1, interactive: false }).addTo(map);
    for (const t of m.twys) {
      const style = t.state === 'closed' ? { color: COLORS.closed, weight: 5 } : t.state ? { color: t.state === 'dotAffected' ? COLORS.affected : COLORS.closed, weight: 4, dashArray: '2 7', opacity: 0.9 } : { className: 'ad-twy', weight: t.lane ? 1.5 : 3 };
      const line = L.polyline(t.ll, style).addTo(map);
      if (t.its.length) line.bindPopup(tip(t.its), { maxWidth: 340 });
    }
    for (const sg of m.segs) L.polyline(sg.ll, { color: COLORS.closed, weight: 7, lineCap: 'butt' }).addTo(map).bindPopup(tip([sg.it]), { maxWidth: 340 });
    for (const x of m.xs) L.marker([x.lat, x.lon], { icon: label('✕', 'xmark dark') }).addTo(map).bindPopup(tip([x.it]), { maxWidth: 340 });
    for (const r of m.rwys) {
      const line = L.polyline(r.ll, r.closed || r.its.length ? { color: r.closed ? COLORS.closed : COLORS.affected, weight: 9, lineCap: 'butt' } : { className: 'ad-rwy', weight: 9, lineCap: 'butt' }).addTo(map);
      if (r.its.length) line.bindPopup(tip(r.its), { maxWidth: 340 });
      for (const p of r.marks) L.marker(p, { icon: label('✕', 'xmark'), interactive: false }).addTo(map);
      for (const e of r.ends) L.marker(e.at, { icon: label(e.text, 'rwyno' + (r.closed ? ' bad' : '')), interactive: false }).addTo(map);
    }
    for (const v of m.labels) L.marker(v.at, { icon: label(v.name, 'twyno ' + (v.hit === 'closed' ? 'bad' : v.hit === 'part' ? 'warn' : '')), interactive: false }).addTo(map);
    if (m.bounds.length) map.fitBounds(m.bounds, { padding: [28, 28] }); else map.setView([a.lat, a.lon], 14);
    note.innerHTML = [
      osm ? '' : box.dataset.loading ? 'Loading the taxiway layout…' : 'The taxiway layout could not be loaded, so only the runways are drawn.',
      osm && m.missing.length ? `Not on the map (no taxiway with that name in OpenStreetMap): ${esc(m.missing.join(', '))}.` : '',
      m.unplaced.length ? `Dotted red marks a taxiway that is partly closed where the exact section could not be placed: ${esc(m.unplaced.join(', '))}.` : '',
    ].filter(Boolean).join(' ');
  }

  // For the PDF brief: one drawing model per airport that has NOTAMs, once the layouts are loaded
  async function diagrams(b) {
    const n = b.notams;
    if (!n || !n.available) return [];
    const withNotams = n.airports.filter((a) => (n.byAirport[a.id] || []).length);
    try { await Promise.race([loadGeometry(withNotams), new Promise((r) => setTimeout(r, 12000))]); } catch (e) { /* runways only */ }
    return withNotams.filter((a) => a.lat != null).map((a) => {
      const list = n.byAirport[a.id];
      const navs = list.filter((x) => x.active && x.nav).map((x) => x.nav.aid + (x.nav.rwy ? ' ' + x.nav.rwy : ''));
      try { return { id: a.id, name: a.name, role: a.role, navs: [...new Set(navs)], ...model(a, list) }; } catch (e) { return null; }
    }).filter(Boolean);
  }

  function listHtml(list) {
    const row = (n, it) => `<tr class="${n.active ? '' : 'off'}"><td><span class="pill ${it ? (it.status === 'closed' || it.status === 'restricted' ? 'nogo' : it.status === 'affected' ? 'caution' : 'info') : 'caution'}">${it ? esc(it.status === 'restricted' ? 'part closed' : it.status === 'minor' ? 'note' : it.status) : 'out'}</span></td><td><b>${it ? esc((it.kind === 'RWY' ? 'RWY ' : it.kind === 'TWY' ? 'TWY ' : '') + it.name) : esc(n.nav.aid + (n.nav.rwy ? ' ' + n.nav.rwy : ''))}</b></td><td>${esc(n.text)}<div class="hint">${esc(n.number || '')} · ${esc(when(n))}${n.active ? '' : ' · not in force at your time'}</div></td></tr>`;
    const rank = { closed: 0, restricted: 1, affected: 2, minor: 3 };
    const rows = [];
    for (const n of list) { if (n.nav) rows.push({ k: 2.5, kind: 'N', h: row(n, null), a: n.active }); for (const it of n.items || []) rows.push({ k: rank[it.status], kind: it.kind, h: row(n, it), a: n.active }); }
    rows.sort((x, y) => (y.a - x.a) || (x.k - y.k) || (x.kind === 'RWY' ? -1 : 1));
    const main = rows.filter((r) => r.k < 3), minor = rows.filter((r) => r.k >= 3);
    return `${main.length ? `<div class="table-wrap"><table class="adlist">${main.map((r) => r.h).join('')}</table></div>` : '<p>No runway, taxiway or apron closures in these NOTAMs.</p>'}${minor.length ? `<details><summary>${minor.length} lighting, sign and marking NOTAM(s)</summary><div class="table-wrap"><table class="adlist">${minor.map((r) => r.h).join('')}</table></div></details>` : ''}`;
  }

  function render(b, el) {
    while (maps.length) { try { maps.pop().remove(); } catch (e) { /* already gone */ } }
    const n = b.notams;
    if (!n || !n.available) {
      el.innerHTML = `<p>${esc(n ? n.note : '')}</p>${n && n.links ? `<p>${n.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.id)} NOTAMs (FAA)</a>`).join(' · ')}</p>` : ''}`;
      return;
    }
    el.innerHTML = `<p class="hint">${n.source === 'briefing' ? `${n.total} NOTAMs read from your briefing.` : ''} Red is closed, dotted red is partly closed, amber is work in progress or a surface problem. Tap a marked runway or taxiway for the NOTAM. Closures are judged at your time at each airport.</p><div class="legend-row"><span><i class="sw" style="background:${COLORS.closed}"></i>Closed</span><span><i class="sw dot"></i>Partly closed</span><span><i class="sw" style="background:${COLORS.affected}"></i>Work in progress</span></div>`
      + n.airports.map((a, i) => {
        const list = n.byAirport[a.id] || [];
        const act = list.filter((x) => x.active);
        const cr = [...new Set(act.flatMap((x) => (x.items || []).filter((it) => it.kind === 'RWY' && it.status === 'closed').map((it) => it.name)))];
        const ct = [...new Set(act.flatMap((x) => (x.items || []).filter((it) => it.kind !== 'RWY' && (it.status === 'closed' || it.status === 'restricted')).map((it) => it.name)))];
        return `<div class="adbox" data-i="${i}"><h3>${esc(a.id)} <span class="muted">${esc(a.name)} · ${esc(a.role)}</span></h3>
          <p>${list.length ? `${cr.length ? `<span class="pill nogo">RWY ${esc(cr.join(', '))} closed</span> ` : '<span class="pill ok">No runway closed</span> '}${ct.length ? `<span class="pill caution">${ct.length} taxiway/apron closure${ct.length > 1 ? 's' : ''}</span>` : ''}` : 'No NOTAMs for this airport were found in the text.'}</p>
          ${list.length ? '<div class="admap"></div><p class="hint adnote"></p>' : ''}${list.length ? listHtml(list) : ''}</div>`;
      }).join('');
    const draw = () => n.airports.forEach((a, i) => {
      const box = el.querySelector(`.adbox[data-i="${i}"]`), list = n.byAirport[a.id] || [];
      if (!box || !list.length || !box.querySelector('.admap')) return;
      try { drawAirport(a, list, box); } catch (e) { const m = box.querySelector('.adnote'); if (m) m.textContent = 'The diagram could not be drawn: ' + e.message; }
    });
    // Runways first, then the full layout once OpenStreetMap answers
    const withNotams = n.airports.filter((a) => (n.byAirport[a.id] || []).length);
    const pending = withNotams.some((a) => a.lat != null && !cached(a.id));
    el.querySelectorAll('.adbox').forEach((bx) => { if (pending) bx.dataset.loading = '1'; });
    draw();
    const setLoading = (left) => el.querySelectorAll('.adbox').forEach((bx) => { const a = n.airports[+bx.dataset.i]; if (left.some((x) => x.id === a.id)) bx.dataset.loading = '1'; else delete bx.dataset.loading; });
    if (pending) loadGeometry(withNotams, (left) => { if (el.isConnected) { setLoading(left); draw(); } }).finally(() => { if (!el.isConnected) return; el.querySelectorAll('.adbox').forEach((bx) => delete bx.dataset.loading); draw(); });
  }

  window.NotamGuide = { readPdf, render, diagrams };
})();
