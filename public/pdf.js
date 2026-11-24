'use strict';
// Two-page flight weather brief as a PDF (jsPDF + AutoTable, vector text and a vector surface sketch).
(function () {
  const W = 612, H = 792, M = 26; // US Letter, points
  const C = { ink: [22, 32, 43], muted: [93, 107, 122], line: [214, 220, 228], navy: [14, 31, 56], accent: [31, 95, 191],
    go: [29, 122, 69], caution: [178, 106, 0], nogo: [179, 38, 30], info: [58, 110, 165], ok: [29, 122, 69],
    VFR: [29, 122, 69], MVFR: [43, 98, 196], IFR: [192, 57, 43], LIFR: [165, 42, 157] };
  const FRONT = { COLD: [37, 99, 235], WARM: [220, 38, 38], OCFNT: [147, 51, 234], STNRY: [220, 38, 38], TROF: [146, 64, 14], DRYLN: [161, 98, 7], SQLN: [17, 17, 17] };

  // Helvetica in jsPDF covers WinAnsi only: replace symbols it cannot draw.
  const t = (s) => String(s ?? '').replace(/→/g, '->').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/–/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/✓/g, 'OK').replace(/✗/g, 'X').replace(/·/g, '-').replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ—]/g, '');
  const z = (iso) => { if (!iso) return '-'; const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`; };
  const hm = (min) => `${Math.floor(min / 60)}:${String(Math.abs(min) % 60).padStart(2, '0')}`;
  const clip = (s, n) => { s = t(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '...' : s; };

  function build(b, k) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const fs = (n) => doc.setFontSize(n * k);
    const p = b.plan, d = b.decision;
    let y, overflow = false;
    const room = (h) => { if (y + h > H - 38) { overflow = true; return false; } return true; };

    function header(pageLabel) {
      doc.setFillColor(...C.navy); doc.rect(0, 0, W, 50, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text(t(`${p.dep} -> ${p.dest}${p.alternate ? `  (alt ${p.alternate})` : ''}`), M, 21);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6);
      doc.text(t(`${b.aircraft.name} - Part ${p.rules} - FL${Math.round(p.cruiseAlt / 100)} - ${p.tas} KTAS - ${p.distanceNm} nm`), M, 33);
      doc.text(t(`ETD ${z(p.etd)} - ETA ${z(p.eta)} - ETE ${hm(p.eteMin)}`), M, 43);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      doc.text('PREFLIGHT WEATHER BRIEF', W - M, 20, { align: 'right' });
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
      doc.text(t(`Generated ${z(b.generatedAt)}${b.dataAsOf ? ` - data ${z(b.dataAsOf)}` : ''} - ${pageLabel}`), W - M, 32, { align: 'right' });
      doc.text('ADVISORY ONLY', W - M, 43, { align: 'right' });
      doc.setTextColor(...C.ink);
    }
    function footer() {
      doc.setDrawColor(...C.line); doc.line(M, H - 30, W - M, H - 30);
      doc.setTextColor(...C.muted); fs(6);
      doc.text(doc.splitTextToSize(t(b.disclaimer), W - 2 * M), M, H - 22);
      doc.setTextColor(...C.ink);
    }
    function section(title) {
      if (!room(30 * k)) return false;
      y += 4 * k;
      doc.setFont('helvetica', 'bold'); fs(9); doc.setTextColor(...C.accent);
      doc.text(t(title.toUpperCase()), M, y);
      doc.setDrawColor(...C.accent); doc.setLineWidth(0.6); doc.line(M, y + 2.5, W - M, y + 2.5);
      doc.setTextColor(...C.ink); doc.setFont('helvetica', 'normal');
      y += 11 * k;
      return true;
    }
    function para(text, { size = 7.4, bold = false, color = C.ink, width = W - 2 * M, x = M, gap = 3 } = {}) {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); fs(size); doc.setTextColor(...color);
      const lines = doc.splitTextToSize(t(text), width);
      if (!room(lines.length * size * k * 1.22)) return;
      doc.text(lines, x, y);
      y += lines.length * size * k * 1.22 + gap * k;
      doc.setTextColor(...C.ink);
    }
    const table = (opts) => {
      doc.autoTable(Object.assign({
        startY: y, margin: { left: M, right: M }, theme: 'grid',
        styles: { font: 'helvetica', fontSize: 6.8 * k, cellPadding: 2.2 * k, lineColor: C.line, lineWidth: 0.4, textColor: C.ink, overflow: 'linebreak' },
        headStyles: { fillColor: [235, 240, 247], textColor: C.ink, fontStyle: 'bold' },
      }, opts));
      y = doc.lastAutoTable.finalY + 6 * k;
    };

    // ------------------------------------------------------------------ page 1
    header('page 1 of 2');
    y = 62;
    const vcol = d.verdict === 'GO' ? C.go : d.verdict === 'NO-GO' ? C.nogo : C.caution;
    const reasons = d.reasoning.slice(0, 4).map((r) => '- ' + clip(r, 330));
    doc.setFont('helvetica', 'normal'); fs(7.2);
    const rl = doc.splitTextToSize(t(reasons.join('\n')), W - 2 * M - 150);
    const boxH = Math.max(46, rl.length * 7.2 * k * 1.22 + 26);
    doc.setFillColor(...vcol); doc.rect(M, y, 130, boxH, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); fs(d.verdict.length > 10 ? 13 : 18);
    doc.text(t(d.verdict), M + 65, y + boxH / 2 + 2, { align: 'center' });
    doc.setDrawColor(...vcol); doc.setLineWidth(1.2); doc.rect(M + 130, y, W - 2 * M - 130, boxH);
    doc.setTextColor(...C.ink); doc.setFont('helvetica', 'bold'); fs(8.2);
    doc.text(doc.splitTextToSize(t(d.headline), W - 2 * M - 145), M + 138, y + 11);
    doc.setFont('helvetica', 'normal'); fs(7.2); doc.text(rl, M + 138, y + 23);
    y += boxH + 10;

    // Surface sketch (left) + key numbers (right)
    const mapW = 300, mapH = 196, mx = M, my = y;
    drawSketch(doc, b, mx, my, mapW, mapH, k);
    const r = b.range || {};
    const alt = b.routing && b.routing.altitude;
    const rec = b.routing && b.routing.route && b.routing.route.recommendation;
    const dest = b.stations.find((s) => s.role === 'destination');
    const rows = [
      ['Route', clip(p.route.map((w) => w.id).join(' '), 70)],
      ['Distance / ETE', `${p.distanceNm} nm / ${hm(p.eteMin)}`],
      ['Avg wind component', `${r.avgWindComponentKt != null ? (r.avgWindComponentKt > 0 ? '+' : '') + r.avgWindComponentKt + ' kt' : '-'}`],
      ['ESAD (route + alt)', `${r.equivalentStillAirNm ?? '-'} nm of ~${r.stillAirRangeNm ?? '-'} nm`],
      [`Alternate (${dest && dest.altTest ? dest.altTest.rule : p.rules === '135' ? '135.223' : '91.169'})`, dest ? (dest.alternateRequired ? 'REQUIRED' : dest.alternateAdvised ? 'advised by models' : 'not required') + (dest.altTest ? ` (needs ${dest.altTest.ceilNeed} ft / ${dest.altTest.visNeed} SM)` : '') : '-'],
      ['Best altitude (wx/wind/fuel)', alt ? `FL${alt.best}` : '-'],
      ['Route option', rec ? (rec.keepFiled ? 'Keep filed route' : clip(rec.best.name, 60)) : '-'],
      ['Flow aloft (Collins)', b.surface && b.surface.collins ? `${({ sw: 'SW - supports lows', nw: 'NW - clearing', w: 'flat W - little support' })[b.surface.collins.flow] || '-'}${b.surface.collins.lapse != null ? `; lapse ${b.surface.collins.lapse} C/1000 ft` : ''}` : '-'],
      ['Better weather', b.surface && b.surface.collins && b.surface.collins.betterWeather ? `to the ${b.surface.collins.betterWeather}` : '-'],
      ['Data', `${b.dataAsOf ? z(b.dataAsOf) : 'live'}${b.errors.length ? ` - gaps: ${clip(b.errors.map((e) => e.source).join(', '), 60)}` : ' - all sources OK'}`],
    ];
    doc.autoTable({ startY: my, margin: { left: mx + mapW + 10, right: M }, theme: 'plain', body: rows.map((x) => x.map(t)),
      styles: { font: 'helvetica', fontSize: 6.9 * k, cellPadding: { top: 2, bottom: 2, left: 3, right: 3 }, textColor: C.ink },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 92, textColor: C.muted } },
      didDrawCell: (h) => { if (h.column.index === 0) { doc.setDrawColor(...C.line); doc.line(h.cell.x, h.cell.y + h.cell.height, W - M, h.cell.y + h.cell.height); } } });
    y = Math.max(my + mapH, doc.lastAutoTable.finalY) + 8;

    section('Terminals');
    const mByStation = {};
    for (const s of (b.models && b.models.stations) || []) mByStation[s.id] = s;
    table({
      head: [['Airport', 'Window', 'Now (METAR)', 'Planning (TAF)', 'Runway / wind', 'Alternate rules', 'Models']],
      body: b.stations.map((s) => {
        const j = s.judged || {};
        const rw = s.runway && !s.runway.none ? `${s.runway.id} ${s.runway.head >= 0 ? 'hw' : 'tw'} ${Math.abs(s.runway.head)} xw ${s.runway.crossG} kt` : '-';
        const altRule = s.altTest ? `${s.altTest.rule}: ${s.alternateRequired ? 'alternate REQUIRED' : s.alternateAdvised ? 'alternate advised by models' : 'no alternate needed'} (>= ${s.altTest.ceilNeed} ft & ${s.altTest.visNeed} SM${s.altTest.auto ? ', FAA charts Cat ' + s.altTest.cat : s.altTest.estimate ? ', estimate' : ''})` : s.altMins ? `${s.altMins.rule}: ${s.altMins.none ? 'no usable approach' : `${s.altMins.ok ? 'meets' : 'BELOW'} ${s.altMins.ceil}-${s.altMins.vis}${s.altMins.auto ? ' (FAA charts Cat ' + s.altMins.cat + ')' : s.altMins.estimate ? ' (estimate)' : ''}`}` : '-';
        const ms = mByStation[s.id];
        return [`${s.id}\n${s.role}`, `${z(s.window[0])}-${z(s.window[1])}`, s.metar ? `${s.metar.category} ${s.metar.wind.dir != null ? String(s.metar.wind.dir).padStart(3, '0') : 'VRB'}/${s.metar.wind.spd}${s.metar.wind.gst ? 'G' + s.metar.wind.gst : ''} ${s.metar.temp}/${s.metar.dewp}` : 'none', j.category ? `${j.category} ${j.ceiling != null ? j.ceiling + ' ft' : 'no ceiling'} / ${j.vis ?? '-'} SM (${s.judgedFrom})` : '-', rw, altRule, ms && ms.models && ms.models.length ? `${ms.consensus}${ms.spread >= 2 ? ' (low agreement)' : ''}` : '-'].map(t);
      }),
      columnStyles: { 0: { cellWidth: 42, fontStyle: 'bold' }, 1: { cellWidth: 52 }, 5: { cellWidth: 120 } },
    });

    section('Factors');
    const fs2 = b.factors.filter((f) => f.level === 'nogo' || f.level === 'caution');
    const rest = b.factors.filter((f) => f.level === 'info' && /Routing|Alternate|Forecast/.test(f.category));
    const fl = fs2.concat(rest).slice(0, 14);
    table({
      head: [['', 'Factor', 'Detail']],
      body: fl.length ? fl.map((f) => [f.level === 'nogo' ? 'NO-GO' : f.level.toUpperCase(), t(f.title), clip(f.detail, 230)]) : [['OK', 'No limiting or cautionary factors', '']],
      columnStyles: { 0: { cellWidth: 40, fontStyle: 'bold' }, 1: { cellWidth: 170, fontStyle: 'bold' } },
      didParseCell: (h) => { if (h.section === 'body' && h.column.index === 0) { const lv = String(h.cell.raw).toLowerCase().replace('-', ''); h.cell.styles.textColor = C[lv] || C.ink; } },
      pageBreak: 'avoid',
    });
    footer();

    // ------------------------------------------------------------------ page 2
    doc.addPage(); header('page 2 of 2'); y = 64;
    section('Surface analysis - Collins method (Flying the Weather Map)');
    const narr = (b.surface && b.surface.narrative) || [];
    const last = narr.find((x) => /What it means/.test(x.heading));
    if (last) para(last.text, { size: 7.4, bold: true, gap: 4 });
    for (const x of narr.filter((x) => x !== last).slice(0, 7)) {
      if (!room(20 * k)) break;
      doc.setFont('helvetica', 'bold'); fs(7.2); doc.text(t(x.heading), M, y); y += 8.5 * k;
      para(clip(x.text, Math.round((/lows|Upper/.test(x.heading) ? 620 : 380) * k)), { size: 6.9, color: [40, 50, 62], gap: 3 });
    }

    if (b.routing) {
      section('Route and altitude options');
      para(b.routing.route.recommendation.text, { size: 7.2, gap: 3 });
      const pr = b.routing.procedures;
      if (pr && (pr.sid || pr.star || pr.approach)) para(`Recommended route: ${pr.route.string}.${pr.sid ? ' SID ' + pr.sid.text + '.' : ''}${pr.star ? ' STAR ' + pr.star.text + '.' : ''}${pr.approach ? ' Expect ' + pr.approach.text : ''}`, { size: 7.2, gap: 3 });
      para(b.routing.altitude.text, { size: 7.2, gap: 4 });
      const rowsA = b.routing.altitude.rows;
      table({
        head: [['', ...rowsA.map((x) => `FL${x.fl}${x.fl === b.routing.altitude.best ? ' *' : ''}`)]],
        body: [
          ['ETE', ...rowsA.map((x) => hm(x.eteMin))],
          ['Wind comp (kt)', ...rowsA.map((x) => (x.windComponent == null ? '-' : (x.windComponent > 0 ? '+' : '') + x.windComponent))],
          ['ISA dev (C)', ...rowsA.map((x) => (x.isaDev == null ? '-' : (x.isaDev > 0 ? '+' : '') + x.isaDev))],
          ['Fuel est. (lb)', ...rowsA.map((x) => x.fuelLb.toLocaleString('en-US'))],
          ['Advisories', ...rowsA.map((x) => (x.hits.length ? String(x.hits.length) : '-'))],
        ],
        styles: { fontSize: 6.6 * k, cellPadding: 1.8 * k, halign: 'center', lineColor: C.line, lineWidth: 0.4 },
        columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 70 } },
      });
    }

    if (b.models && b.models.stations && b.models.stations.some((s) => s.models.length)) {
      section('Model guidance at the terminals (HRRR / NBM / GFS / ECMWF)');
      const names = ['HRRR', 'NBM', 'GFS', 'ECMWF'];
      const cell = (m) => (m ? `${m.category}${m.ceilingEst != null ? ` base ${m.ceilingEst}` : ''}${m.vis != null ? ` ${m.vis}SM` : ''}${m.wx ? ` ${m.wx}` : ''}${m.gustMax ? ` G${m.gustMax}` : ''}${m.capeMax ? ` CAPE ${m.capeMax}` : ''}` : '-');
      const body = b.models.stations.map((s) => [`${s.id} ${s.role}`, ...names.map((n) => cell(s.models.find((m) => m.model === n)))].map(t));
      table({ head: [['Airport', ...names]], body, styles: { fontSize: 6.4 * k, cellPadding: 1.8 * k, lineColor: C.line, lineWidth: 0.4 }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 80 } },
        didParseCell: (h) => { const c = String(h.cell.raw).split(' ')[0]; if (h.section === 'body' && h.column.index > 0 && C[c]) h.cell.styles.textColor = C[c]; } });
    }

    if (b.winds && b.winds.length) {
      section('Winds and temperatures at cruise (GFS)');
      table({ head: [['Along', ...b.winds.map((w) => `${w.alongNm} nm`)]], body: [
        ['Wind', ...b.winds.map((w) => `${String(w.dir).padStart(3, '0')}/${w.spd}`)],
        ['Comp / ISA', ...b.winds.map((w) => `${w.component > 0 ? '+' : ''}${w.component} / ${w.isaDev > 0 ? '+' : ''}${w.isaDev}`)],
      ], styles: { fontSize: 6.3 * k, cellPadding: 1.6 * k, halign: 'center', lineColor: C.line, lineWidth: 0.4 }, columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 60 } } });
    }

    if (section('Reports and forecasts')) {
      doc.setFont('courier', 'normal');
      for (const s of b.stations) {
        for (const raw of [s.metar && s.metar.raw, s.taf].filter(Boolean)) {
          fs(6.2);
          const lines = doc.splitTextToSize(t(raw), W - 2 * M);
          if (!room(lines.length * 6.2 * k * 1.18)) break;
          doc.text(lines, M, y); y += lines.length * 6.2 * k * 1.18 + 2;
        }
      }
    }
    doc.setFont('helvetica', 'normal');
    footer();
    doc.__overflow = overflow;
    return doc;
  }

  // Vector sketch of fronts, pressure centers, advisories and the route.
  function drawSketch(doc, b, x0, y0, w, h, k) {
    const pts = b.plan.route;
    let minLat = Math.min(...pts.map((p) => p.lat)), maxLat = Math.max(...pts.map((p) => p.lat));
    let minLon = Math.min(...pts.map((p) => p.lon)), maxLon = Math.max(...pts.map((p) => p.lon));
    const padLat = Math.max(2.5, (maxLat - minLat) * 0.25), padLon = Math.max(3.5, (maxLon - minLon) * 0.25);
    minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;
    const cosm = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    // keep aspect ratio
    const spanX = (maxLon - minLon) * cosm, spanY = maxLat - minLat;
    if (spanX / spanY > w / h) { const need = (spanX * h) / w; const c = (minLat + maxLat) / 2; minLat = c - need / 2; maxLat = c + need / 2; }
    else { const need = (spanY * w) / h / cosm; const c = (minLon + maxLon) / 2; minLon = c - need / 2; maxLon = c + need / 2; }
    const X = (lon) => x0 + ((lon - minLon) / (maxLon - minLon)) * w;
    const Y = (lat) => y0 + h - ((lat - minLat) / (maxLat - minLat)) * h;
    const inside = (p) => p.lat >= minLat - 3 && p.lat <= maxLat + 3 && p.lon >= minLon - 3 && p.lon <= maxLon + 3;
    doc.setFillColor(245, 247, 250); doc.rect(x0, y0, w, h, 'F');
    let clipped = false;
    try { doc.saveGraphicsState(); doc.rect(x0, y0, w, h, null); doc.clip(); doc.discardPath(); clipped = true; } catch (e) { /* older jsPDF */ }
    // graticule
    doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.3);
    for (let la = Math.ceil(minLat / 5) * 5; la <= maxLat; la += 5) doc.line(x0, Y(la), x0 + w, Y(la));
    for (let lo = Math.ceil(minLon / 5) * 5; lo <= maxLon; lo += 5) doc.line(X(lo), y0, X(lo), y0 + h);
    // advisories
    for (const hz of b.hazards || []) {
      const c = hz.coords || []; if (c.length < 3) continue;
      doc.setDrawColor(...(/CONVECTIVE|TS/.test(hz.hazard || '') ? [220, 38, 38] : /ICE/.test(hz.hazard || '') ? [37, 99, 235] : [217, 119, 6]));
      doc.setLineWidth(0.6); doc.setLineDashPattern([2, 2], 0);
      for (let i = 0; i < c.length; i++) { const a = c[i], bb = c[(i + 1) % c.length]; doc.line(X(a.lon), Y(a.lat), X(bb.lon), Y(bb.lat)); }
      doc.setLineDashPattern([], 0);
    }
    // fronts
    const sf = b.surface || {};
    for (const f of sf.analysisFronts || []) {
      const ps = (f.points || []).filter(inside);
      if (ps.length < 2) continue;
      doc.setDrawColor(...(FRONT[f.type] || [80, 80, 80])); doc.setLineWidth(f.type === 'TROF' ? 0.8 : 1.6);
      if (f.type === 'TROF') doc.setLineDashPattern([4, 3], 0); else if (f.type === 'STNRY') doc.setLineDashPattern([6, 4], 0);
      for (let i = 1; i < ps.length; i++) doc.line(X(ps[i - 1].lon), Y(ps[i - 1].lat), X(ps[i].lon), Y(ps[i].lat));
      doc.setLineDashPattern([], 0);
      // simple motion-side symbols every few points
      if (/COLD|WARM|OCFNT/.test(f.type) && f.motion && f.motion.speedKt >= 3) {
        for (let i = 1; i < ps.length; i += 2) {
          const ax = X(ps[i - 1].lon), ay = Y(ps[i - 1].lat), bx = X(ps[i].lon), by = Y(ps[i].lat);
          const mx = (ax + bx) / 2, my = (ay + by) / 2; const len = Math.hypot(bx - ax, by - ay) || 1;
          let nx = -(by - ay) / len, ny = (bx - ax) / len;
          const mvx = Math.sin(f.motion.towardDeg * Math.PI / 180), mvy = -Math.cos(f.motion.towardDeg * Math.PI / 180);
          if (nx * mvx + ny * mvy < 0) { nx = -nx; ny = -ny; }
          doc.setFillColor(...(FRONT[f.type] || [80, 80, 80]));
          if (f.type === 'WARM') doc.circle(mx + nx * 1.2, my + ny * 1.2, 2.4, 'F');
          else doc.triangle(mx - (bx - ax) / len * 3, my - (by - ay) / len * 3, mx + (bx - ax) / len * 3, my + (by - ay) / len * 3, mx + nx * 4.5, my + ny * 4.5, 'F');
        }
      }
    }
    // pressure centers
    doc.setFont('helvetica', 'bold');
    for (const [list, col, ch] of [[sf.analysisHighs || [], [37, 99, 235], 'H'], [sf.analysisLows || [], [220, 38, 38], 'L']]) {
      for (const c of list) {
        if (!inside(c)) continue;
        doc.setTextColor(...col); doc.setFontSize(12 * k); doc.text(ch, X(c.lon), Y(c.lat), { align: 'center' });
        doc.setFontSize(5.5 * k); doc.setTextColor(30, 30, 30); doc.text(String(c.pressure), X(c.lon), Y(c.lat) + 6, { align: 'center' });
      }
    }
    // recommended route
    const rec = b.routing && b.routing.route && b.routing.route.recommendation;
    if (rec && !rec.keepFiled && rec.best && rec.best.points) {
      doc.setDrawColor(22, 163, 74); doc.setLineWidth(1.4); doc.setLineDashPattern([5, 3], 0);
      const rp = rec.best.points; for (let i = 1; i < rp.length; i++) doc.line(X(rp[i - 1].lon), Y(rp[i - 1].lat), X(rp[i].lon), Y(rp[i].lat));
      doc.setLineDashPattern([], 0);
    }
    // filed route
    doc.setDrawColor(17, 17, 17); doc.setLineWidth(1.6);
    for (let i = 1; i < pts.length; i++) doc.line(X(pts[i - 1].lon), Y(pts[i - 1].lat), X(pts[i].lon), Y(pts[i].lat));
    doc.setFillColor(255, 255, 255);
    for (const pt of [pts[0], pts[pts.length - 1]]) { doc.circle(X(pt.lon), Y(pt.lat), 2.6, 'FD'); }
    doc.setFontSize(6.5 * k); doc.setTextColor(17, 17, 17);
    doc.text(pts[0].id, X(pts[0].lon) + 4, Y(pts[0].lat) - 3); doc.text(pts[pts.length - 1].id, X(pts[pts.length - 1].lon) + 4, Y(pts[pts.length - 1].lat) - 3);
    if (clipped) doc.restoreGraphicsState();
    doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.rect(x0, y0, w, h);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(5.6 * k); doc.setTextColor(...C.muted);
    doc.text(t(`WPC surface analysis ${z(sf.analysisValid)} - fronts, H/L, advisories on route (dashed)${rec && !rec.keepFiled ? ', suggested re-route (green dashed)' : ''}`), x0 + 3, y0 + h - 3);
    doc.setTextColor(...C.ink);
  }

  async function download(b) {
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('PDF library did not load. Check your connection and reload.');
    let doc;
    for (const k of [1, 0.94, 0.88, 0.82, 0.76]) {
      doc = build(b, k);
      if (doc.getNumberOfPages() <= 2 && !doc.__overflow) break;
    }
    while (doc.getNumberOfPages() > 2) doc.deletePage(doc.getNumberOfPages());
    const day = new Date(b.plan.etd).toISOString().slice(0, 10);
    doc.save(`Brief_${b.plan.dep}-${b.plan.dest}_${day}_${z(b.plan.etd).replace('/', '')}.pdf`);
  }
  window.BriefPDF = { download, build };
})();
