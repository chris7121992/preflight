'use strict';
// Flight weather brief as a PDF (two pages, plus a simulated radar page) (jsPDF + AutoTable, vector text and a vector surface sketch).
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

  function build(b, k, extra) {
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
    const radar = (extra && extra.radar) || { list: [] }, sr = b.simRadar;
    const tb = b.turbulence && b.turbulence.available ? b.turbulence : null;
    const pages = extra && extra.conusPage ? 4 : radar.list.length || (sr && sr.available) || b.fuel || tb ? 3 : 2; // page 3 also carries the Part 135 landing limits
    header(`page 1 of ${pages}`);
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
      ['Fuel', b.fuel ? `recommend ${b.fuel.recommendedLb.toLocaleString('en-US')} lb${b.fuel.plannedLb != null ? ` (planned ${b.fuel.plannedLb.toLocaleString('en-US')})` : ' (from the planning guide)'}` : '-'],
      ['Best altitude (wx/wind/fuel)', alt ? `FL${alt.best}` : '-'],
      ['Route option', rec ? (rec.keepFiled ? 'Keep filed route' : clip(rec.best.name, 60)) : '-'],
      ['Flow aloft', b.surface && b.surface.reading ? `${({ sw: 'SW - supports lows', nw: 'NW - clearing', w: 'flat W - little support' })[b.surface.reading.flow] || '-'}${b.surface.reading.lapse != null ? `; lapse ${b.surface.reading.lapse} C/1000 ft` : ''}` : '-'],
      ['Better weather', b.surface && b.surface.reading && b.surface.reading.betterWeather ? `to the ${b.surface.reading.betterWeather}` : '-'],
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
      head: [['Airport', 'Window', 'Now (METAR)', 'Planning (TAF)', 'Runway / wind / length', 'Alternate rules', 'Models']],
      body: b.stations.map((s) => {
        const j = s.judged || {};
        const rw = s.runway && !s.runway.none ? `${s.runway.id} ${s.runway.head >= 0 ? 'hw' : 'tw'} ${Math.abs(s.runway.head)} xw ${s.runway.crossG} kt${s.runway.requiredFt ? `\n${s.runway.len.toLocaleString('en-US')} ft, needs ${s.runway.requiredFt.toLocaleString('en-US')}` : ''}` : '-';
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
    doc.addPage(); header(`page 2 of ${pages}`); y = 64;
    section('Surface analysis');
    const narr = (b.surface && b.surface.narrative) || [];
    const diagrams = (extra && extra.diagrams) || [];
    const last = narr.find((x) => /What it means/.test(x.heading));
    if (last) {
      // "What it means for this flight" leads the section, in a tinted box
      doc.setFont('helvetica', 'normal'); fs(7.4);
      const wl = doc.splitTextToSize(t(last.text), W - 2 * M - 14);
      const bh = wl.length * 7.4 * k * 1.22 + 17 * k;
      doc.setFillColor(238, 244, 253); doc.rect(M, y - 6 * k, W - 2 * M, bh, 'F');
      doc.setFillColor(...C.accent); doc.rect(M, y - 6 * k, 2.5, bh, 'F');
      doc.setFont('helvetica', 'bold'); fs(8); doc.setTextColor(...C.navy); doc.text(t(last.heading), M + 8, y + 2 * k);
      doc.setFont('helvetica', 'normal'); fs(7.4); doc.setTextColor(...C.ink); doc.text(wl, M + 8, y + 12 * k);
      y += bh + 4 * k;
    }
    const short = diagrams.length ? 0.8 : 1; // leave room for the airport diagrams
    for (const x of narr.filter((x) => x !== last).slice(0, 7)) {
      if (!room(20 * k)) break;
      doc.setFont('helvetica', 'bold'); fs(7.2); doc.text(t(x.heading), M, y); y += 8.5 * k;
      para(clip(x.text, Math.round((/lows|Upper/.test(x.heading) ? 620 : 380) * k * short)), { size: 6.9, color: [40, 50, 62], gap: 3 });
    }

    if (diagrams.length) {
      const n = Math.min(3, diagrams.length), gap = 10, dw = (W - 2 * M - gap * (n - 1)) / Math.max(2, n), dh = (n === 3 ? 128 : 150) * k;
      if (room(dh + 60 * k) && section('NOTAMs - red closed, dotted partly closed, amber work in progress; tags at runway ends show what is out there')) {
        const y0 = y; let yMax = y;
        diagrams.slice(0, n).forEach((d, i) => {
          const x = M + i * (dw + gap);
          const useChart = !d.osm && d.chart;
          if (useChart) {
            const sc = Math.min((dw - 4) / d.chart.w, (dh - 4) / d.chart.h), iw = d.chart.w * sc, ih = d.chart.h * sc;
            doc.setFillColor(255, 255, 255); doc.rect(x, y0, dw, dh, 'F');
            try { doc.addImage(d.chart.data, 'JPEG', x + (dw - iw) / 2, y0 + (dh - ih) / 2, iw, ih); } catch (e) { /* fall back to the sketch below */ }
            doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.rect(x, y0, dw, dh);
            doc.setFont('helvetica', 'bold'); doc.setFontSize(7 * k); doc.setTextColor(...C.ink); doc.text(t(`${d.id}  ${d.role || ''}`), x + 4, y0 + 9 * k);
          } else drawAirport(doc, d, x, y0, dw, dh, k);
          let yy = y0 + dh + 8 * k;
          const act = d.shown;
          const uniq = (a) => [...new Set(a)];
          const cr = uniq(act.filter((it) => it.kind === 'RWY' && it.status === 'closed').map((it) => it.name));
          const ar = uniq(act.filter((it) => it.kind === 'RWY' && it.status !== 'closed').map((it) => it.name)).filter((r) => !cr.includes(r));
          const ct = uniq(act.filter((it) => it.kind !== 'RWY' && it.status === 'closed').map((it) => it.name));
          const pt = uniq(act.filter((it) => it.kind !== 'RWY' && it.status === 'restricted').map((it) => it.name)).filter((r) => !ct.includes(r));
          const wt = uniq(act.filter((it) => it.kind !== 'RWY' && it.status === 'affected').map((it) => it.name)).filter((r) => !ct.includes(r) && !pt.includes(r));
          const lines = [
            [cr.length ? `RWY ${cr.join(', ')} CLOSED` : 'No runway closed', cr.length ? C.nogo : C.ok, true],
            ar.length ? [`RWY ${ar.join(', ')} restricted or work in progress`, C.caution] : null,
            ct.length ? [`TWY closed: ${ct.join(', ')}`, C.nogo] : null,
            pt.length ? [`TWY partly closed: ${pt.join(', ')}`, C.nogo] : null,
            wt.length ? [`TWY work in progress: ${wt.join(', ')}`, C.caution] : null,
            ...noteLines(d),
            d.osm ? null : useChart ? ['Taxi diagram from your ForeFlight briefing; closures are listed, not drawn', C.muted] : ['Runways only: no taxiway layout on file', C.muted],
          ].filter(Boolean);
          for (const [txt, col, bold] of lines) {
            doc.setFont('helvetica', bold ? 'bold' : 'normal'); fs(6.4); doc.setTextColor(...col);
            const ls = doc.splitTextToSize(t(txt), dw).slice(0, 3);
            doc.text(ls, x, yy); yy += ls.length * 6.4 * k * 1.2 + 1;
          }
          yMax = Math.max(yMax, yy);
        });
        doc.setTextColor(...C.ink);
        y = yMax + 3 * k;
      }
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
          ['Trip fuel (lb)', ...rowsA.map((x) => x.fuelLb.toLocaleString('en-US'))],
          ['Advisories', ...rowsA.map((x) => (x.hits.length ? String(x.hits.length) : '-'))],
        ],
        styles: { fontSize: 6.6 * k, cellPadding: 1.8 * k, halign: 'center', lineColor: C.line, lineWidth: 0.4 },
        columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 70 } },
      });
    }

    if (b.models && b.models.stations && b.models.stations.some((s) => s.models.length)) {
      section('NWP model forecasts at each airport (HRRR / NBM / GFS / ECMWF)');
      const names = ['HRRR', 'NBM', 'GFS', 'ECMWF'];
      const cell = (m) => (m ? `${m.category}\n${m.ceilingEst != null ? `base ${m.ceilingEst} ft` : 'no low cloud'}${m.vis != null ? `, ${m.vis} SM` : ''}${m.windMax != null || m.gustMax ? `\nwind ${m.windMax ?? '-'}${m.gustMax ? ' G' + m.gustMax : ''} kt` : ''}${m.wx ? `\n${m.wx}` : ''}${m.capeMax >= 500 ? `\nCAPE ${m.capeMax}` : ''}` : '-');
      const body = b.models.stations.filter((s) => s.models.length).map((s) => {
        const st = b.stations.find((x) => x.id === s.id && x.role === s.role) || {};
        return [`${s.id}\n${s.role}\n${z(s.window[0])}-${z(s.window[1])}`, ...names.map((n) => cell(s.models.find((m) => m.model === n))), `${s.consensus || '-'}${s.spread >= 2 ? '\nlow agreement' : ''}${st.judgedFrom ? `\njudged on ${/^models/.test(st.judgedFrom) ? 'models' : st.judgedFrom}` : ''}`].map(t);
      });
      table({ head: [['Airport / window', ...names, 'Middle of models']], body, styles: { fontSize: 6.3 * k, cellPadding: 1.8 * k, lineColor: C.line, lineWidth: 0.4 }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 78 }, 5: { cellWidth: 74 } },
        didParseCell: (h) => { const c = String(h.cell.raw).split(/[ \n]/)[0]; if (h.section === 'body' && h.column.index > 0 && C[c]) h.cell.styles.textColor = C[c]; } });
      para('Model cloud bases are estimates and models are not an official forecast. Where the TAF covers the time, the TAF decides and the models are a cross-check.', { size: 6, color: C.muted, gap: 2 });
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

    // ------------------------------------------------------------------ page 3: simulated radar
    if (pages >= 3) {
      doc.addPage(); header(`page 3 of ${pages}`); y = 64;
      if (b.fuel) {
        const f = b.fuel, n = (x) => (x == null ? '-' : x.toLocaleString('en-US'));
        section('Fuel recommendation');
        para(f.text, { size: 7.8, bold: true, gap: 4, color: f.level === 'nogo' ? C.nogo : f.level === 'caution' ? C.caution : C.ink });
        table({
          head: [['Item', 'lb', 'Basis']],
          body: [...f.lines.map((l) => [l.label + (l.advisory ? ' (advised)' : ''), n(l.lb), l.why]), ['Minimum', n(f.minimumLb), 'Taxi, trip, required alternate and reserve'],
            ...f.extras.map((l) => [l.label + ' (contingency)', n(l.lb), l.why]), ['Recommended block fuel', n(f.recommendedLb), f.plannedLb != null ? `Planned ${n(f.plannedLb)} lb: ${f.marginLb >= 0 ? n(f.marginLb) + ' lb to spare' : n(-f.marginLb) + ' lb more recommended'}; landing fuel as planned ${n(f.landingLb)} lb` : 'From the XLS+ Flight Planning Guide at ISA']].map((r) => r.map(t)),
          columnStyles: { 0: { cellWidth: 130, fontStyle: 'bold' }, 1: { cellWidth: 44, halign: 'right' } },
          didParseCell: (h) => { if (h.section === 'body' && /^(Minimum|Recommended)/.test(String(h.row.raw[0]))) { h.cell.styles.fillColor = [238, 244, 253]; h.cell.styles.fontStyle = 'bold'; } },
        });
        para(`${f.notes.join(' ')} Based on: ${f.basis}. Limits used: ${n(f.limits.usableFuelLb)} lb usable fuel, ${n(f.limits.maxTakeoffLb)} lb maximum takeoff, ${n(f.limits.maxLandingLb)} lb maximum landing. The AFM, weight and balance and OpSpecs govern.`, { size: 6.4, color: C.muted, gap: 4 });
      }
      const lim = p.rules === '135' ? (b.stations || []).filter((st) => st.field && st.field.part135 && st.field.part135.runway) : [];
      if (lim.length) {
        const nn = (x) => x.toLocaleString('en-US');
        section('Part 135 landing limits (135.385, 135.387)');
        table({
          head: [['Airport', 'Runway', 'AFM distance', '60% rule needs', '80% eligible on-demand needs', 'Applied']],
          body: lim.map((st) => { const q = st.field.part135, [a, e] = q.options; const cell = (o) => `${nn(o.dryFt)} ft${q.wet ? ` (wet ${nn(o.wetFt)})` : ''} - ${o.suitable ? 'met' : 'NOT met'}`; return [`${st.id} ${st.role}`, `${q.runway} ${nn(q.runwayFt)} ft`, `${nn(st.field.actualFt)} ft`, cell(a), cell(e), q.eod ? '80%' : '60%']; }),
          columnStyles: { 0: { fontStyle: 'bold' } },
          didParseCell: (h) => { if (h.section === 'body' && /NOT met/.test(String(h.cell.raw))) h.cell.styles.textColor = lim[h.row.index].field.part135.uses === (h.column.index === 3 ? '60' : '80') ? C.nogo : C.muted; },
        });
        para(`60%: 135.385(b) and 135.387(a); when the runway may be wet it must be 115% of that figure (135.385(d)). 80%: 135.385(f) and 135.387(b), for an eligible on-demand operation (135.4) with an approved Destination Airport Analysis (135.23(r)) and OpSpec authorization; its wet margin comes from that analysis, so the wet figure shown is a reference. Distances from the XLS+ Flight Planning Guide, dry and zero wind; the AFM governs.`, { size: 6.2, color: C.muted, gap: 4 });
      }
      if (tb) {
        section(`Turbulence by flight level on the filed route (EDR, middle of ${tb.models.join(', ')})`);
        para(tb.text, { size: 7.4, bold: true, gap: 4, color: tb.level === 'caution' ? C.caution : C.ink });
        const TC = { light: [245, 222, 60], moderate: [245, 160, 40], severe: [230, 60, 40] };
        const rows = tb.grid.filter((r) => r.fl >= 270);
        table({
          head: [['Level', ...tb.cols.map((c) => `${c.alongNm} nm`)]],
          body: rows.map((r) => [`FL${r.fl}${r.fl === tb.plannedFl ? ' <' : ''}`, ...r.cells.map((c) => (c ? c.edr.toFixed(2) : '-'))]),
          styles: { fontSize: 6.2 * k, cellPadding: 1.7 * k, halign: 'center', lineColor: C.line, lineWidth: 0.4 },
          columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 44 } },
          didParseCell: (h) => { if (h.section !== 'body' || h.column.index === 0) return; const c = rows[h.row.index].cells[h.column.index - 1]; if (c && TC[c.cat]) { h.cell.styles.fillColor = TC[c.cat]; h.cell.styles.fontStyle = 'bold'; h.cell.styles.textColor = c.cat === 'severe' ? [255, 255, 255] : [17, 17, 17]; } },
        });
        para(`Yellow light (EDR ${tb.thresholds.light}+), orange moderate (${tb.thresholds.moderate}+), red severe (${tb.thresholds.severe}+); < marks the planned level. From model shear, Richardson number, Ellrod deformation and mountain wave terms over thick layers: use it to compare levels, and check GTG, SIGMETs, G-AIRMET Tango and PIREPs for intensity. Convective turbulence is not included.`, { size: 6.2, color: C.muted, gap: 4 });
      }
      if (radar.list.length || (sr && sr.available)) {
      section(radar.source ? 'Radar for the flight' : 'Simulated radar for the flight (model forecast, not observed radar)');
      const rsrc = radar.source || (radar.init ? `HRRR simulated reflectivity from the ${z(new Date(radar.init).toISOString())} run, shown for the time the aircraft (blue dot) is at each position.` : '');
      if (radar.list.length) {
        const three = !!b.fuel, gap = 8, pw = three ? (W - 2 * M - gap * 2) / 3 : (W - 2 * M - gap) / 2, ph = pw * (540 / 828);
        radar.list.slice(0, 3).forEach((pn, i) => {
          const x = three ? M + i * (pw + gap) : M + (i % 2) * (pw + gap), yy = three ? y : y + Math.floor(i / 2) * (ph + 16);
          try { doc.addImage(pn.data, 'JPEG', x, yy, pw, ph); } catch (e) { /* skip panel */ }
          doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.rect(x, yy, pw, ph);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(three ? 6.2 : 7); doc.setTextColor(...C.ink); doc.text(t(pn.label), x, yy + ph + 9);
        });
        // legend and notes beside the last panel
        const lx = M + pw + gap + 6, ly = y + ph + 16 + 8;
        if (radar.list.length === 3 && !three) {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...C.ink);
          doc.text(doc.splitTextToSize(t(`${rsrc} Black line: filed route. HRRR covers the continental US and nearby waters; outside it the map is blank and the strip below applies. Tiles: Iowa Environmental Mesonet; base map: Esri.`), pw - 12), lx, ly);
          doc.text(doc.splitTextToSize(t('This is a model forecast of radar echoes. Storms rarely form exactly where and when a model puts them: read it for the pattern (lines, coverage, timing) and use live radar on the day.'), pw - 12), lx, ly + 58);
        }
        y += (three ? 1 : Math.ceil(Math.min(3, radar.list.length) / 2)) * (ph + 16) + 4;
        if (three) para(`${rsrc} HRRR covers the continental US and nearby waters; outside it the map is blank and the strip below applies. ${radar.source ? '' : 'A model forecast, not observed radar: read it for the pattern and use live radar on the day.'} Tiles: Iowa Environmental Mesonet; base map: Esri.`, { size: 6.4, color: C.muted });
        else if (radar.list.length !== 3) para(`${rsrc} ${radar.source ? '' : 'A model forecast, not observed radar.'}`, { size: 6.8, color: C.muted });
      } else {
        para(radar.init ? `The HRRR simulated radar map reaches 18 hours past its latest run (to ${z(new Date(radar.init + 18 * 3600e3).toISOString())}). This flight is outside that, so the strip below, from the longer-range models, stands in for it.` : 'The HRRR simulated radar map could not be loaded, so only the route strip is shown.', { size: 7.2 });
      }
      if (sr && sr.available) {
        section('On the route as you pass - estimated dBZ by model');
        para(sr.text, { size: 7.6, bold: true, gap: 4 });
        const col = (window.SimRadar && window.SimRadar.color) || (() => null);
        table({
          head: [['Along', ...sr.rows.map((r) => `${r.alongNm} nm\n${z(r.t).slice(3)}`)]],
          body: sr.models.map((m) => [m, ...sr.rows.map((r) => { const c = r.cells[m]; return c ? `${c.dbz >= 15 ? c.dbz : '-'}${c.thunder ? ' TS' : ''}` : ''; })]),
          styles: { fontSize: 6.4 * k, cellPadding: 2.2 * k, halign: 'center', lineColor: C.line, lineWidth: 0.4 },
          columnStyles: { 0: { halign: 'left', fontStyle: 'bold', cellWidth: 44 } },
          didParseCell: (h) => { if (h.section !== 'body' || h.column.index === 0) return; const c = col(parseInt(h.cell.raw, 10)); if (c) { h.cell.styles.fillColor = c; h.cell.styles.fontStyle = 'bold'; h.cell.styles.textColor = parseInt(h.cell.raw, 10) >= 45 ? [255, 255, 255] : [17, 17, 17]; } },
        });
        para(`Scale: 15 light, 25 light to moderate, 35 moderate, 40 heavy, 45 very heavy, 50+ extreme. A dash means no echo; TS means the model has a thunderstorm there. ${sr.method}`, { size: 6.2, color: C.muted });
      }
      }
      // Continental US simulated radar, when the page has room for it
      const cus = radar.conus || [];
      if (cus.length) {
        const gap = 8, pw = (W - 2 * M - gap * 2) / 3, ph = pw * (470 / 828);
        if (pages === 4) {
          // no room beside the rest of page 3: the continental US pictures get a page of their own, larger
          footer(); doc.addPage(); header('page 4 of 4'); y = 64;
          section('Simulated radar, continental US (HRRR forecast): where cells are forecast');
          const bw = 336, bh = bw * (470 / 828), bx = (W - bw) / 2;
          cus.slice(0, 3).forEach((pn) => {
            try { doc.addImage(pn.data, 'JPEG', bx, y, bw, bh); } catch (e) { /* skip panel */ }
            doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.rect(bx, y, bw, bh);
            doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...C.ink); doc.text(t(pn.label), bx, y + bh + 9);
            y += bh + 16;
          });
          doc.setFont('helvetica', 'normal');
          para(`HRRR simulated reflectivity${radar.init ? ` from the ${z(new Date(radar.init).toISOString())} run` : ''} over the continental US, with the route in black and the aircraft (blue dot) where the flight is in progress. A model forecast, not observed radar: storms rarely form exactly where and when a model puts them, so read it for the pattern, coverage and timing. Tiles: Iowa Environmental Mesonet; base map: Esri.`, { size: 6.6, color: C.muted });
        } else if (y + ph + 44 > H - 38) doc.__conusSkipped = true;
        else {
          section('Simulated radar, continental US (HRRR forecast): where cells are forecast');
          cus.slice(0, 3).forEach((pn, i) => {
            const x = M + i * (pw + gap);
            try { doc.addImage(pn.data, 'JPEG', x, y, pw, ph); } catch (e) { /* skip panel */ }
            doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.rect(x, y, pw, ph);
            doc.setFont('helvetica', 'bold'); doc.setFontSize(6.2); doc.setTextColor(...C.ink); doc.text(t(pn.label), x, y + ph + 8);
          });
          y += ph + 14;
          doc.setFont('helvetica', 'normal');
        }
      }
      footer();
    }
    doc.__overflow = overflow;
    doc.__pages = pages;
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

  // Lines under an airport diagram for the NOTAMs that are not closures: by runway end, obstacles, and the rest by kind
  function noteLines(d) {
    const out = [], notes = d.notes || [], uniq = (a) => [...new Set(a)];
    const ends = new Map();
    for (const x of notes.filter((q) => q.rwy && !q.rwy.includes('/') && !q.der)) { if (!ends.has(x.rwy)) ends.set(x.rwy, { codes: [], caution: false }); const e = ends.get(x.rwy); if (!e.codes.includes(x.code)) e.codes.push(x.code); if (x.level === 'caution') e.caution = true; }
    const word = { PAPI: 'PAPI', ALS: 'approach lights', ILS: 'ILS', LOC: 'LOC', GS: 'glideslope', WIND: 'windcone', IAP: 'approach NOTAM', LGT: 'lights', REIL: 'REIL', RVR: 'RVR', THR: 'threshold', DIST: 'declared distances', FICON: 'surface condition', MARK: 'markings', WIP: 'work in progress' };
    if (ends.size) out.push([[...ends.entries()].map(([r, e]) => `RWY ${r}: ${e.codes.map((c) => word[c] || c).join(', ')}`).join('; '), [...ends.values()].some((e) => e.caution) ? C.caution : C.ink]);
    const der = uniq(notes.filter((q) => q.der).map((q) => q.rwy));
    const obst = (d.obst || []).filter((o) => o.code === 'OBST').sort((a, b) => a.distNm - b.distNm);
    const brg = (o) => { if (d.lat == null) return ''; const b = (Math.atan2((o.lon - d.lon) * Math.cos((d.lat * Math.PI) / 180), o.lat - d.lat) * 180) / Math.PI; return ' ' + ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((b + 360) % 360) / 45) % 8]; };
    if (obst.length || der.length) out.push([[obst.length ? `Obstacles within 3 NM: ${obst.slice(0, 4).map((o) => `${o.what} ${o.ft != null ? o.ft + ' ft' : ''} ${o.distNm} NM${brg(o)}${o.unlit ? ' unlit' : ''}`.replace(/ +/g, ' ')).join(', ')}${obst.length > 4 ? ` and ${obst.length - 4} more` : ''}` : '', der.length ? `takeoff obstacle notes RWY ${der.join(', ')}` : ''].filter(Boolean).join('; ').replace(/^t/, 'T'), [154, 52, 18]]);
    const cnt = (codes) => uniq(notes.filter((x) => codes.includes(x.code)).map((x) => x.n)).length;
    const twn = uniq(notes.filter((x) => x.twy).map((x) => x.twy));
    const rest = [[cnt(['SID', 'STAR']), 'SID/STAR'], [cnt(['ODP']), 'ODP'], [cnt(['UAS', 'AIRSPACE']), 'airspace'], [cnt(['TWR', 'WX', 'FUEL', 'ARFF', 'SVC', 'COM']), 'service'], [uniq(notes.filter((x) => !x.rwy && ['VOR', 'VORTAC', 'VOR/DME', 'NDB', 'DME', 'TACAN', 'NAV', 'ILS', 'LOC', 'GS', 'LDA'].includes(x.code)).map((x) => x.n)).length, 'navaid'], [cnt(['AP CLSD', 'AD', 'ABN']), 'airport'], [notes.filter((x) => x.code === 'OBST' && !(d.obst || []).some((o) => o.n === x.n)).length, 'obstacle beyond 3 NM']].filter((q) => q[0]).map((q) => `${q[0]} ${q[1]}`);
    if (rest.length || twn.length) out.push([[rest.length ? `Also in force: ${rest.join(', ')} NOTAM(s)` : '', twn.length ? `signs, markings or lights on TWY ${twn.join(', ')}` : ''].filter(Boolean).join('; ').replace(/^s/, 'S'), C.muted]);
    return out;
  }

  // Airport closure diagram: aprons, taxiways and runways as vectors, closures in red
  function drawAirport(doc, d, x0, y0, w, h, k) {
    const RED = [200, 30, 30], AMB = [217, 119, 6];
    let pts = d.bounds.length ? d.bounds : d.twys.flatMap((t) => t.ll);
    if (!pts.length) return;
    let minLat = Math.min(...pts.map((p) => p[0])), maxLat = Math.max(...pts.map((p) => p[0])), minLon = Math.min(...pts.map((p) => p[1])), maxLon = Math.max(...pts.map((p) => p[1]));
    const cosm = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180), pad = 14;
    const sc = Math.min((w - 2 * pad) / Math.max(1e-6, (maxLon - minLon) * cosm), (h - 2 * pad) / Math.max(1e-6, maxLat - minLat));
    const cx = (minLon + maxLon) / 2, cy = (minLat + maxLat) / 2;
    const X = (lon) => x0 + w / 2 + (lon - cx) * cosm * sc, Y = (lat) => y0 + h / 2 - (lat - cy) * sc;
    const path = (ll) => { for (let i = 1; i < ll.length; i++) doc.line(X(ll[i - 1][1]), Y(ll[i - 1][0]), X(ll[i][1]), Y(ll[i][0])); };
    const cross = (p, r, col) => { doc.setDrawColor(...col); doc.setLineWidth(1); const x = X(p[1]), y = Y(p[0]); doc.line(x - r, y - r, x + r, y + r); doc.line(x - r, y + r, x + r, y - r); };
    doc.setFillColor(248, 249, 251); doc.rect(x0, y0, w, h, 'F');
    let clipped = false;
    try { doc.saveGraphicsState(); doc.rect(x0, y0, w, h, null); doc.clip(); doc.discardPath(); clipped = true; } catch (e) { /* older jsPDF */ }
    doc.setLineCap('butt');
    doc.setFillColor(226, 230, 236);
    for (const ll of d.aprons) { if (ll.length < 3) continue; try { doc.lines(ll.slice(1).map((p, i) => [X(p[1]) - X(ll[i][1]), Y(p[0]) - Y(ll[i][0])]), X(ll[0][1]), Y(ll[0][0]), [1, 1], 'F', true); } catch (e) { /* skip shape */ } }
    for (const tw of d.twys.filter((q) => !q.state)) { doc.setDrawColor(160, 168, 178); doc.setLineWidth(tw.lane ? 0.4 : 1); path(tw.ll); }
    for (const tw of d.twys.filter((q) => q.state)) {
      doc.setDrawColor(...(tw.state === 'dotAffected' ? AMB : RED)); doc.setLineWidth(tw.state === 'closed' ? 1.8 : 1.5);
      if (tw.state !== 'closed') doc.setLineDashPattern([1.2, 2.2], 0);
      path(tw.ll); doc.setLineDashPattern([], 0);
    }
    doc.setDrawColor(...RED); doc.setLineWidth(2.4);
    for (const sg of d.segs) for (const ll of sg.ll) path(ll);
    for (const r of d.rwys) {
      doc.setDrawColor(...(r.closed ? RED : r.its.length ? AMB : [45, 55, 68])); doc.setLineWidth(3.6); path(r.ll);
      for (const p of r.marks) cross(p, 2.6, [255, 255, 255]);
    }
    for (const xx of d.xs) cross([xx.lat, xx.lon], 2.8, [90, 10, 10]);
    // labels: runway ends, and the taxiways that are affected
    const tag = (text, p, col, size, bold) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size * k);
      const tw = doc.getTextWidth(text) + 3, th = size * k + 1.5, x = Math.min(x0 + w - tw - 1, Math.max(x0 + 1, X(p[1]) - tw / 2)), y = Math.min(y0 + h - th - 1, Math.max(y0 + 1, Y(p[0]) - th / 2));
      doc.setFillColor(255, 255, 255); doc.setDrawColor(...col); doc.setLineWidth(0.4); doc.rect(x, y, tw, th, 'FD');
      doc.setTextColor(...col); doc.text(text, x + 1.5, y + th - 2);
    };
    for (const v of d.labels.filter((q) => q.hit && q.hit !== 'note')) tag(t(v.name), v.at, v.hit === 'closed' ? RED : AMB, 5, true);
    for (const r of d.rwys) for (const e of r.ends) {
      // push the number just beyond the runway end
      const o = r.ends[0] === e ? r.ends[1] : r.ends[0], dx = (e.at[1] - o.at[1]) * cosm, dy = e.at[0] - o.at[0], len = Math.hypot(dx, dy) || 1, off = 7 / sc;
      tag(t(e.text), [e.at[0] + (dy / len) * off, e.at[1] + ((dx / len) * off) / cosm], r.closed ? RED : [22, 32, 43], 5.6, true);
    }
    // what is out or changed at each runway end, and obstacle NOTAMs within 3 NM (held at the edge when outside the frame)
    for (const en of d.endNotes || []) {
      // set well beyond the runway number, along the runway line
      const r = d.rwys.find((q) => q.ends.some((e) => e.text === en.end)), e = r && r.ends.find((q) => q.text === en.end), o = r && r.ends.find((q) => q !== e);
      let at = en.at;
      if (e && o) { const dx = (e.at[1] - o.at[1]) * cosm, dy = e.at[0] - o.at[0], len = Math.hypot(dx, dy) || 1, off = 19 / sc; at = [e.at[0] + (dy / len) * off, e.at[1] + ((dx / len) * off) / cosm]; }
      tag(t(en.codes.join(' ')), at, AMB, 4.4, en.level === 'caution');
    }
    for (const o of d.obst || []) {
      const x = Math.min(x0 + w - 6, Math.max(x0 + 6, X(o.lon))), y = Math.min(y0 + h - 12, Math.max(y0 + 14, Y(o.lat)));
      if (o.code === 'OBST') { doc.setFillColor(194, 65, 12); doc.triangle(x - 2.4, y + 2, x + 2.4, y + 2, x, y - 2.6, 'F'); }
      else { doc.setDrawColor(122, 90, 248); doc.setLineWidth(0.6); doc.circle(x, y, 2.4, 'S'); }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(4.4 * k); doc.setTextColor(...(o.code === 'OBST' ? [154, 52, 18] : [90, 60, 200]));
      const lbl = t(o.code === 'OBST' ? `${o.ft != null ? o.ft + "'" : ''}` : o.code), lw = doc.getTextWidth(lbl);
      doc.text(lbl, x + 3.4 + lw > x0 + w - 2 ? x - 3.4 - lw : x + 3.4, y + 1.6);
    }
    if (clipped) doc.restoreGraphicsState();
    doc.setDrawColor(...C.line); doc.setLineWidth(0.6); doc.rect(x0, y0, w, h);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7 * k); doc.setTextColor(...C.ink); doc.text(t(d.id), x0 + 4, y0 + 9 * k);
    const idW = doc.getTextWidth(t(d.id));
    doc.setFont('helvetica', 'normal'); doc.setFontSize(5.4 * k); doc.setTextColor(...C.muted); doc.text(t(d.role || ''), x0 + 8 + idW, y0 + 9 * k);
    if (d.osm) doc.text('(c) OpenStreetMap contributors', x0 + w - 3, y0 + h - 3, { align: 'right' });
    doc.setTextColor(...C.ink);
  }

  async function download(b) {
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('PDF library did not load. Check your connection and reload.');
    let doc, diagrams = [];
    let radar = { list: [] };
    try { if (window.NotamGuide && window.NotamGuide.diagrams) diagrams = await window.NotamGuide.diagrams(b); } catch (e) { /* brief without diagrams */ }
    try { if (window.SimRadar) radar = await window.SimRadar.panels(b); } catch (e) { /* brief without radar maps */ }
    for (const k of [1, 0.94, 0.88, 0.82, 0.76, 0.7]) {
      doc = build(b, k, { diagrams, radar });
      if (doc.getNumberOfPages() <= doc.__pages && !doc.__overflow) break;
    }
    // the continental US radar did not fit on page 3: build again with a fourth page for it
    if (doc.__conusSkipped) for (const k of [1, 0.94, 0.88, 0.82, 0.76, 0.7]) {
      doc = build(b, k, { diagrams, radar, conusPage: true });
      if (doc.getNumberOfPages() <= doc.__pages && !doc.__overflow) break;
    }
    while (doc.getNumberOfPages() > doc.__pages) doc.deletePage(doc.getNumberOfPages());
    const day = new Date(b.plan.etd).toISOString().slice(0, 10);
    doc.save(`Brief_${b.plan.dep}-${b.plan.dest}_${day}_${z(b.plan.etd).replace('/', '')}.pdf`);
  }
  window.BriefPDF = { download, build };
})();
