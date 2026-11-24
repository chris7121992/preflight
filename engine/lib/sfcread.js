'use strict';
// Surface-analysis interpretation done the way a pilot reads the surface chart:
//  1. Find the lows first: where they are, how strong, where their moisture comes from, which way they go,
//     and where the route sits relative to each one.
//  2. Check upper-level support (500 mb flow, trough position, cold air aloft, the jet).
//  3. Treat fronts and troughs as sloping zones, not lines.
//  4. Read the surface winds at the terminals as clues to the low's track.
//  5. Know which way better weather lies, and check the weather upstream.
// Everything here is a rule of thumb from the book applied to current data; it is advisory only.

const geo = require('./geo');
const { shiftPoint, FRONT_NAMES, FRONT_WX } = require('./fronts');

const fmtZ = (ms) => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ftTxt = (ft) => (ft >= 18000 ? 'FL' + Math.round(ft / 100) : (Math.round(ft / 100) * 100).toLocaleString('en-US') + ' ft');
const dir3 = (d) => String(Math.round(d) % 360).padStart(3, '0');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Move a point by a bearing and distance (flat-earth approximation, fine for a few hundred nm).
function offset(p, brgDeg, dNm) {
  return shiftPoint(p, dNm * Math.sin(geo.rad(brgDeg)), dNm * Math.cos(geo.rad(brgDeg)));
}
// Position of a moving pressure center at time ms.
function centerAt(c, t0, ms) {
  if (!c.motion || !c.motion.speedKt) return { lat: c.lat, lon: c.lon };
  return offset(c, c.motion.towardDeg, (c.motion.speedKt * (ms - t0)) / 3600e3);
}
function frontAt(f, t0, ms) {
  if (!f.motion) return f.points;
  const dtH = (ms - t0) / 3600e3;
  return f.points.map((p) => shiftPoint(p, f.motion.vx * dtH, f.motion.vy * dtH));
}
// Which side of a polyline a point is on (+1 left / -1 right, relative to the line's drawing order).
function sideOf(p, line) {
  if (line.length < 2) return 0;
  const r = geo.distPointToPolylineNm(p, line);
  const A = geo.project(line[r.idx], p), B = geo.project(line[r.idx + 1], p);
  const cross = (B.x - A.x) * (0 - A.y) - (B.y - A.y) * (0 - A.x);
  return cross >= 0 ? 1 : -1;
}
// Mean wind vector (meteorological "from" direction and speed).
function meanWind(list) {
  let u = 0, v = 0, n = 0;
  for (const w of list) {
    if (w.dir == null || w.spd == null) continue;
    u += -w.spd * Math.sin(geo.rad(w.dir)); v += -w.spd * Math.cos(geo.rad(w.dir)); n++;
  }
  if (!n) return null;
  u /= n; v /= n;
  return { dir: (geo.deg(Math.atan2(-u, -v)) + 360) % 360, spd: Math.hypot(u, v) };
}
const between = (b, lo, hi) => (lo <= hi ? b >= lo && b < hi : b >= lo || b < hi);

// Where a point sits relative to a low, in the book's terms (bearing from the low to the point).
function sectorOf(brg) {
  if (between(brg, 20, 110)) return { key: 'ahead', txt: 'ahead of the low (its east/northeast side)', wx: 'This is where the low does its lifting. Treat the area east of any low as warm-frontal weather whether or not a warm front is drawn: wide areas of low ceilings and rain, with alternates hard to find nearby.' };
  if (between(brg, 110, 200)) return { key: 'warm', txt: 'in the warm sector (south/southeast of the low)', wx: 'Between the fronts the weather is often decent, but the air is warm, moist and unstable. Only the cold front is left to deal with, and storms can form well ahead of it.' };
  if (between(brg, 200, 290)) return { key: 'behind', txt: 'behind the low (its south-west/west side)', wx: 'Once a low is east of you the weather improves: northwest winds, colder and drier air, with bumpy stratocumulus and some rime ice in the cloud that remains.' };
  if (between(brg, 290, 340)) return { key: 'wrap', txt: 'northwest of the low', wx: 'Wrap-around cloud and gusty northerly winds; upslope cloud and snow where the terrain rises.' };
  return { key: 'north', txt: 'north of the low', wx: 'A low passing south of you is the icing case: easterly winds, a long spell of low cloud and precipitation, and freezing rain or snow in cold weather. The more easterly the wind, the worse and longer the weather.' };
}

function analyze(sf, ctx) {
  const { S, dep, dest, prof, stations, opts, upper = [], regional = [] } = ctx;
  const paras = [], factors = [];
  const add = (level, category, title, detail, where) => factors.push({ level, category, title, detail, where: where || 'surface' });
  const t0 = sf.analysisValid ? Date.parse(sf.analysisValid) : Date.now();
  const etd = opts.etd, eta = prof.eta;
  const depSt = stations.find((s) => s.role === 'departure');
  const destSt = stations.find((s) => s.role === 'destination');
  const mid = S[Math.floor(S.length / 2)];
  const terminals = [
    { st: depSt, pt: dep, t: etd, label: `${dep.id} at departure` },
    { st: destSt, pt: dest, t: eta, label: `${dest.id} at arrival` },
  ];
  const obs = regional.filter((m) => isFinite(m.lat) && isFinite(m.lon));
  const highs = sf.analysisHighs || [];
  const isWinter = [10, 11, 0, 1, 2, 3].includes(new Date(etd).getUTCMonth());
  const isSummer = [4, 5, 6, 7, 8].includes(new Date(etd).getUTCMonth());
  const summary = { lowSectors: [] };

  // ---------------------------------------------------------------- 1. Where are the lows?
  const lows = sf.centers.filter((c) => c.kind === 'L').slice(0, 3);
  const lowTxt = [];
  for (const L of lows) {
    const parts = [];
    const fromDep = geo.distNm(dep, L), fromDest = geo.distNm(dest, L);
    const ref = fromDep < fromDest ? dep : dest;
    parts.push(`A ${L.pressure} mb low is ${Math.round(Math.min(fromDep, fromDest))} nm ${geo.compass(geo.bearing(ref, L))} of ${ref.id}.`);
    // Strength: pressure difference and distance to the nearest high
    const nh = highs.map((h) => ({ h, d: geo.distNm(h, L) })).sort((a, b) => a.d - b.d)[0];
    let strength = 'unknown';
    if (nh) {
      const grad = ((nh.h.pressure - L.pressure) / nh.d) * 100;
      strength = grad >= 3.5 ? 'strong' : grad >= 1.8 ? 'moderate' : 'weak';
      parts.push(`A low is judged by its neighbor high: the ${nh.h.pressure} mb high ${Math.round(nh.d)} nm away gives ${nh.h.pressure - L.pressure} mb over that distance (${grad.toFixed(1)} mb per 100 nm), a ${strength} system${strength === 'strong' ? ' with strong winds around it' : ''}. If winds turn out stronger than forecast, the low is stronger than forecast.`);
    }
    // Development and motion
    const m = L.motion;
    if (m) {
      const trend = m.pressureTrend;
      const dev = trend <= -2 ? 'deepening' : trend >= 2 ? 'filling' : 'holding steady';
      if (m.speedKt > 55) parts.push(`Matching it to the 12-hour prog implies ${m.speedKt} kt toward the ${m.towardCompass}, faster than lows really move, so the center is probably re-forming elsewhere (a new low taking over) rather than moving. That is a system still forming: positions shift from one briefing to the next and forecasts are more possibility than fact.`);
      else parts.push(`On the 12-hour prog it ${m.speedKt < 5 ? 'is nearly stationary' : `moves ${m.towardCompass} at about ${m.speedKt} kt`} and is ${dev} (${trend > 0 ? '+' : ''}${trend} mb).${dev === 'deepening' && m.speedKt < 12 ? ' A low that is still gaining strength tends to stay put, so its future track is the least certain part of the forecast.' : ''}${dev === 'filling' ? ' A filling low is past its peak and its weather should slowly ease.' : ''}`);
    } else parts.push('Its motion could not be matched on the 12-hour prog, so treat its track as uncertain.');
    // Neighbor lows: one strong low suppresses development of another within ~500 miles
    const other = lows.find((o) => o !== L && geo.distNm(o, L) < 450 && o.pressure < L.pressure - 4);
    if (other) parts.push(`It is within 450 nm of the deeper ${other.pressure} mb low, and a low that close to a stronger one is unlikely to develop much.`);
    // Moisture source: dew points in the low's southeast quadrant (the inflow side)
    const inflow = obs.filter((o) => { const d = geo.distNm(L, o), b = geo.bearing(L, o); return d >= 40 && d <= 400 && between(b, 70, 200) && o.dewp != null; });
    let moisture = null;
    if (inflow.length >= 3) {
      moisture = mean(inflow.map((o) => o.dewp));
      const rich = moisture >= 12, dry = moisture < 2;
      parts.push(`Its circulation draws air from the south and east, where ${inflow.length} stations average a ${Math.round(moisture)}°C dew point: ${rich ? 'rich Gulf or Atlantic moisture, so expect a wet system with low ceilings, heavy rain and convection' : dry ? 'dry air, so this low will be characterized more by wind than by cloud and precipitation' : 'moderate moisture, enough for widespread cloud and precipitation'}.`);
    }
    // Where the route sits relative to the low, at the time we are there
    const where = [];
    for (const [label, pt, ms] of [[`${dep.id} at departure`, dep, etd], ['mid-route', mid, mid.t], [`${dest.id} at arrival`, dest, eta]]) {
      const Lp = centerAt(L, t0, ms);
      const d = geo.distNm(Lp, pt);
      if (d > 700) continue;
      const sec = sectorOf(geo.bearing(Lp, pt));
      where.push({ label, d, sec, pt, ms });
    }
    if (where.length) {
      parts.push('Your position relative to it: ' + where.map((w) => `${w.label} you are ${Math.round(w.d)} nm ${w.sec.txt}`).join('; ') + '.');
      const key = where[where.length - 1];
      parts.push(key.sec.wx + (moisture != null && moisture < 2 ? ' With dry air feeding this low, though, expect wind and turbulence more than cloud and precipitation.' : ''));
      summary.lowSectors.push({ L, where, strength, moisture });
    }
    // In its path?
    if (m && m.speedKt >= 8 && m.speedKt <= 55) {
      for (const [pt, ms, nm] of [[dest, eta, dest.id], [dep, etd, dep.id]]) {
        const b = geo.bearing(L, pt), d = geo.distNm(L, pt);
        const reach = m.speedKt * Math.max(0, (ms - t0) / 3600e3 + 6);
        if (Math.abs(geo.angleDiff(b, m.towardDeg)) <= 35 && d <= reach + 150 && d <= 700) {
          parts.push(`It is heading for ${nm}. A low southwest of you moving northeast puts you in its path, and you should not count it out until it is well east of you.`);
          add('caution', 'Surface analysis', `${L.pressure} mb low is tracking toward ${nm}`, `The low ${Math.round(d)} nm ${geo.compass(geo.bearing(pt, L))} of ${nm} is moving ${m.towardCompass} at ${m.speedKt} kt (${m.pressureTrend > 0 ? '+' : ''}${m.pressureTrend} mb in ${Math.round(m.hours)} h). Expect conditions at ${nm} to trend worse than a static forecast suggests; compare the TAF with the low's timing and pick an alternate away from its track.`, nm);
          break;
        }
      }
    }
    lowTxt.push(parts.join(' '));
  }
  paras.push({ heading: '1. Where are the lows?', text: `WPC surface analysis valid ${sf.analysisValid ? fmtZ(t0) : 'latest'}. Every weather picture starts with this question, because lows make the weather. ${lowTxt.length ? lowTxt.join(' ') : 'No low centers are analysed within 600 nm of the route, so frontal or air-mass effects (below) are what to look at.'}` });

  // Highs
  const hNear = sf.centers.filter((c) => c.kind === 'H').slice(0, 2);
  if (hNear.length) {
    const ht = hNear.map((H) => {
      let t = `A ${H.pressure} mb high is ${H.distNm} nm ${H.bearingFromRoute} of the route (abeam ~${H.alongRouteNm} nm): sinking, drier, generally more stable air with clockwise flow.`;
      for (const { st, pt } of terminals) {
        const b = geo.bearing(pt, H), d = geo.distNm(pt, H);
        const coastal = (pt.lon > -82 && pt.lat > 25) || (pt.lat < 31 && pt.lon > -98);
        if (d < 700 && between(b, 300, 60) && coastal) t += ` With the high north of ${st ? st.id : pt.id}, the flow there is onshore from the east, which brings low cloud and drizzle along the coast even under high pressure.`;
      }
      if (H.motion && H.motion.pressureTrend <= -2) t += ' It is weakening.';
      return t;
    });
    paras.push({ heading: 'Highs', text: ht.join(' ') });
  }

  // ---------------------------------------------------------------- 2. Upper-level support
  const up = upper.filter((u) => u.d500 != null && u.s500 != null);
  if (up.length) {
    const w500 = meanWind(up.map((u) => ({ dir: u.d500, spd: u.s500 })));
    const lapse = mean(up.filter((u) => u.t850 != null && u.t500 != null).map((u) => (u.t850 - u.t500) / 13.5));
    const t500 = mean(up.filter((u) => u.t500 != null).map((u) => u.t500));
    const parts = [];
    const d = w500.dir, sp = Math.round(w500.spd);
    let flow;
    if (between(d, 190, 250)) flow = 'sw';
    else if (between(d, 250, 290)) flow = 'w';
    else if (between(d, 290, 20)) flow = 'nw';
    else flow = 'odd';
    summary.flow = flow; summary.w500 = { dir: Math.round(d), spd: sp };
    parts.push(`GFS 500 mb (about 18,000 ft) flow along the route averages ${dir3(d)}° at ${sp} kt.`);
    if (flow === 'sw') parts.push(`Southwesterly flow aloft means you are east of an upper trough, the side where surface lows form and move northeast. This is upper-level support: rising air over a surface low has somewhere to go. If a low is southwest of you under this flow, expect it to head for your position, and even if no low is analysed yet, one can form, so read the forecasts with suspicion.`);
    else if (flow === 'w') parts.push(`Flat west-to-east flow aloft offers little upper-level support, so ${isSummer ? 'strong lows are unlikely, though in summer local thunderstorms can still break out when a cool pocket aloft passes over warm surface air' : 'strong low development is unlikely and surface systems should not reach very high'}.`);
    else if (flow === 'nw') parts.push('Northwesterly flow aloft puts you west of the upper trough: colder, drier air coming down from the north and little support for lows developing overhead. Weather under this flow tends to be clearing and bumpy rather than stormy.');
    else parts.push('Easterly or southerly flow at 500 mb points to a closed low aloft nearby. If it is cut off from the main flow it will dawdle, giving an extended period of bad weather below and east of it.');
    // Trough or ridge axis crossing the route
    const byLon = up.slice().sort((a, b) => a.lon - b.lon);
    for (let i = 1; i < byLon.length; i++) {
      const a = byLon[i - 1], b = byLon[i];
      const va = -a.s500 * Math.cos(geo.rad(a.d500)), vb = -b.s500 * Math.cos(geo.rad(b.d500));
      if (va < -5 && vb > 5) { parts.push(`The flow turns from northerly to southerly between ${Math.round(a.s)} and ${Math.round(b.s)} nm along the route, which puts an upper trough axis there. Weather is likely to be worse east of that line.`); summary.troughAloft = true; break; }
      if (va > 5 && vb < -5) { parts.push(`The flow turns from southerly to northerly between ${Math.round(a.s)} and ${Math.round(b.s)} nm along the route, an upper ridge, usually with better weather.`); break; }
    }
    if (!summary.troughAloft && flow === 'sw') summary.troughAloft = true; // trough to the west
    if (flow === 'sw' && sp >= 60) { parts.push(`At ${sp} kt this is jet-strength flow heading northeast ahead of the trough. When the jet is northeastbound within a couple of hundred miles west of you, thunderstorms are likely to be in lines and severe, and squall lines can form 100 nm or more ahead of the cold front.`); summary.jetNE = true; }
    if (lapse != null) {
      summary.lapse = lapse;
      parts.push(`Temperatures fall ${lapse.toFixed(1)}°C per 1,000 ft between 850 and 500 mb (about 5,000 to 18,000 ft). The line is 2°C per 1,000 ft: air cooling faster than that supports towering cloud and storms when there is moisture and lift, slower than that resists them. This air is ${lapse >= 2.2 ? 'unstable' : lapse >= 1.7 ? 'close to neutral, so lift (a front or low) can still set off convection' : 'stable, so expect layered (stratiform) cloud rather than towering cumulus'}.`);
    }
    if (t500 != null) {
      const dev = Math.round(t500 - -20.7);
      parts.push(`At 500 mb it is ${Math.round(t500)}°C, ${Math.abs(dev)}°C ${dev >= 0 ? 'warmer' : 'colder'} than standard. ${dev <= -4 ? 'Cold air aloft over warmer air below is instability, and a low or trough aloft to your west means be prepared for things to get worse.' : dev >= 4 ? 'Warm air aloft is a stabilizing lid.' : ''}`.trim());
    }
    // Low-level circulation: northeasterly surface flow under southwesterly 850 flow means warm air overrunning cold
    for (const { st, pt } of terminals) {
      if (!st || !st.metar || st.metar.wind.dir == null) continue;
      const u = upper.slice().sort((a, b) => geo.distNm(a, pt) - geo.distNm(b, pt))[0];
      if (!u || u.d850 == null) continue;
      if (between(st.metar.wind.dir, 0, 130) && between(u.d850, 180, 270)) {
        parts.push(`At ${st.id} the surface wind is from ${dir3(st.metar.wind.dir)}° while the 850 mb wind (about 5,000 ft) is from ${dir3(u.d850)}°: warm air overrunning cold air near the ground. Even if no warm front is drawn, expect one or a low to develop, and with southerly winds aloft the icing is in the cloud of the warm layer.`);
        summary.overrunning = summary.overrunning || st.id;
      }
    }
    paras.push({ heading: '2. Upper-level support', text: parts.join(' ') });
  }

  // ---------------------------------------------------------------- 3. Fronts as zones
  const relevantFr = sf.fronts.filter((f) => f.crossesRoute || f.depPassage || f.destPassage || f.encounter.distNm <= 150).slice(0, 5);
  const distantFr = sf.fronts.filter((f) => !relevantFr.includes(f));
  if (!sf.fronts.length) paras.push({ heading: '3. Fronts and troughs', text: 'No fronts or troughs are analysed within 400 nm of the route. The weather will come from the air mass itself (moisture and stability above) rather than frontal lift.' });
  for (const f of relevantFr) {
    const parts = [];
    const slope = f.type === 'COLD' ? 80 : f.type === 'TROF' || f.type === 'DRYLN' || f.type === 'SQLN' ? null : 100;
    // Temperature and wind contrast across the front, from METARs near where the route meets it
    const refPt = f.encounter;
    const nowPts = f.points;
    const near = obs.filter((o) => geo.distNm(o, refPt) <= 300).map((o) => ({ o, d: geo.distPointToPolylineNm(o, nowPts).d, side: sideOf(o, nowPts) })).filter((x) => x.d >= 20 && x.d <= 180);
    const sideA = near.filter((x) => x.side > 0 && x.o.temp != null), sideB = near.filter((x) => x.side < 0 && x.o.temp != null);
    let coldSign = null, contrast = null, coldSideWind = null;
    if (sideA.length >= 2 && sideB.length >= 2) {
      const tA = mean(sideA.map((x) => x.o.temp)), tB = mean(sideB.map((x) => x.o.temp));
      contrast = Math.abs(tA - tB);
      coldSign = tA < tB ? 1 : -1;
      const coldSide = coldSign > 0 ? sideA : sideB, warmSide = coldSign > 0 ? sideB : sideA;
      coldSideWind = meanWind(coldSide.map((x) => ({ dir: x.o.wdir === 'VRB' ? null : Number(x.o.wdir), spd: x.o.wspd })));
      const warmWind = meanWind(warmSide.map((x) => ({ dir: x.o.wdir === 'VRB' ? null : Number(x.o.wdir), spd: x.o.wspd })));
      const dWarm = mean(warmSide.filter((x) => x.o.dewp != null).map((x) => x.o.dewp));
      f._dWarm = dWarm;
      parts.push(`Stations within 180 nm of it show ${Math.round(Math.min(tA, tB))}°C on the cold side and ${Math.round(Math.max(tA, tB))}°C on the warm side, a ${Math.round(contrast)}°C contrast${coldSideWind && warmWind ? `, with winds ${dir3(warmWind.dir)}°/${Math.round(warmWind.spd)} kt ahead in the warm air and ${dir3(coldSideWind.dir)}°/${Math.round(coldSideWind.spd)} kt in the cold air` : ''}${dWarm != null ? ` and ${Math.round(dWarm)}°C dew points in the warm air` : ''}.`);
      if (contrast >= 10) parts.push('That is a sharp front, which is an active, chaotic zone with strong wind shift, turbulence and convection packed into a narrow band.');
      else if (contrast <= 4) parts.push('That is a weak, diffuse boundary; expect it to behave more like a trough.');
      if (f.type === 'COLD' && warmWind && coldSideWind && between(warmWind.dir, 150, 240) && warmWind.spd >= 12 && between(coldSideWind.dir, 280, 360) && coldSideWind.spd >= 12) parts.push('Strong southerly flow ahead meeting strong northwesterly flow behind means convergence along the front: storms and turbulence.');
      if (f.type === 'COLD' && coldSideWind && coldSideWind.spd >= 5) {
        const seg = geo.distPointToPolylineNm(refPt, nowPts);
        const a = nowPts[seg.idx], b = nowPts[seg.idx + 1] || a;
        const fb = geo.bearing(a, b);
        const toward = (coldSideWind.dir + 180) % 360;
        const normal = Math.abs(Math.sin(geo.rad(geo.angleDiff(toward, fb)))) * coldSideWind.spd;
        parts.push(normal >= coldSideWind.spd * 0.6 ? 'Winds behind it blow across the front, so it will keep moving.' : 'Winds behind it run nearly parallel to the front, which points to a front that is slowing or about to stall, stretching out the bad weather.');
        if (between(coldSideWind.dir, 190, 260)) parts.push('Southwest winds behind a cold front mean the low it belongs to is deepening.');
      }
    }
    // Motion and timing
    const mv = !f.motion ? 'Its movement could not be matched on the 12-hour prog; treat it as slow-moving or changing character.' : f.motion.speedKt < 5 ? 'Comparing the analysis with the 12-hour prog it is nearly stationary, and waves (new lows) form on stationary fronts.' : `It is moving ${f.motion.towardCompass} at about ${f.motion.speedKt} kt${f.motion.becomes ? `, becoming a ${FRONT_NAMES[f.motion.becomes] || f.motion.becomes}` : ''}${f.type === 'COLD' ? (f.motion.speedKt >= 25 ? ', a fast cold front with a sharp, convective band' : ' (a typical cold front moves about 25 kt; slower means a wider, wetter band)') : ''}.`;
    parts.push(mv);
    parts.push(f.crossesRoute ? `Projected to your flight times, the route meets it about ${f.encounter.alongRouteNm} nm from ${dep.id} around ${fmtZ(Date.parse(f.encounter.time))}.` : `Projected to your flight times it stays at least ${f.encounter.distNm} nm from the route.`);
    if (f.depPassage) parts.push(`It reaches ${dep.id} around ${fmtZ(Date.parse(f.depPassage))} (ETD ${fmtZ(etd)}).`);
    if (f.destPassage) parts.push(`It reaches ${dest.id} around ${fmtZ(Date.parse(f.destPassage))} (ETA ${fmtZ(eta)}).`);
    // Cold side by station contrast, else by front type and motion
    if (coldSign == null && f.motion && f.motion.speedKt >= 5 && nowPts.length > 1) {
      const P = nowPts[Math.floor(nowPts.length / 2)];
      const ahead = sideOf(offset(P, f.motion.towardDeg, 60), nowPts);
      coldSign = f.type === 'COLD' ? -ahead : f.type === 'WARM' || f.type === 'OCFNT' ? ahead : null;
    }
    // Slope: height of the frontal surface over each terminal
    if (slope && coldSign != null) {
      const zone = [];
      for (const { pt, t, label } of terminals) {
        const line = frontAt(f, t0, t);
        const dd = geo.distPointToPolylineNm(pt, line).d;
        const onCold = sideOf(pt, line) === coldSign;
        if (!onCold || dd > 300) { if (!onCold && dd <= 300) zone.push(`${label} you are ${Math.round(dd)} nm on the warm side, below no frontal surface`); continue; }
        const h = (dd * 6076) / slope;
        zone.push(`${label} you are ${Math.round(dd)} nm on the cold side, where the frontal surface is roughly ${h >= 45000 ? 'above FL450' : ftTxt(h)} overhead`);
        if (f.type !== 'COLD' && dd <= 100) summary.nearWarmFront = summary.nearWarmFront || { f, label, dd, pt };
        if (h < opts.cruiseAlt && h > 1500) {
          summary.slopeCross = summary.slopeCross || [];
          const prev = summary.slopeCross.find((x) => x.label === label);
          if (!prev) summary.slopeCross.push({ label, h, f }); else if (h < prev.h) Object.assign(prev, { h, f });
        }
      }
      parts.push(`Think of fronts as sloping zones, not lines: about 1:${slope} for a ${f.type === 'COLD' ? 'cold' : 'warm or stationary'} front, so the frontal surface rises about ${(Math.round(6076 * 100 / slope / 100) * 100).toLocaleString('en-US')} ft over 100 nm into the cold air${f.type === 'COLD' ? '' : ' and the cloud shield can run 600-700 nm ahead of the surface position'}. ${zone.length ? cap(zone.join('; ')) + '.' : ''} The climb or descent through that surface is where icing, turbulence and wind shift concentrate${f.type !== 'COLD' ? ', and the front aloft can be 200 nm or more from where it is drawn on the surface chart' : ''}.`);
    }
    if (f.type === 'TROF') parts.push('Treat a trough as a front until it proves otherwise, with the worse weather east of it and improvement to the west.');
    if (f.type !== 'TROF') parts.push(FRONT_WX[f.type] || '');
    paras.push({ heading: `3. ${cap(f.name)}${f.strength ? ` (${f.strength})` : ''}: ${f.crossesRoute ? 'crosses the route' : f.encounter.distNm + ' nm from the route'}`, text: parts.filter(Boolean).join(' ') });
  }
  if (distantFr.length) paras.push({ heading: '3. Other boundaries within 400 nm', text: distantFr.map((f) => `${cap(f.name)} ${f.nearestNowNm} nm from the route${f.motion && f.motion.speedKt >= 5 ? `, moving ${f.motion.towardCompass} at ${f.motion.speedKt} kt` : ', nearly stationary'}, projected to stay ${f.encounter.distNm}+ nm away.`).join(' ') + ' Think in zones: these matter if the departure slips or you divert toward them.' });

  // ---------------------------------------------------------------- 4. Terminal winds as clues
  const tparts = [];
  for (const { st, pt } of terminals) {
    if (!st || !st.metar) continue;
    const m = st.metar;
    const spread = m.temp != null && m.dewp != null ? Math.round(m.temp - m.dewp) : null;
    let t = `${st.id}: ${m.category}, wind ${m.wind.vrb ? 'variable' : m.wind.dir != null ? dir3(m.wind.dir) + '°' : 'calm'} at ${m.wind.spd} kt${m.wind.gst ? ' gusting ' + m.wind.gst : ''}, ${m.temp}°C, dew point ${m.dewp}°C.`;
    const lowW = lows.filter((L) => geo.distNm(L, pt) <= 700 && L.lon < pt.lon + 3)[0];
    if (lowW && m.wind.dir != null && !m.wind.vrb && m.wind.spd >= 4) {
      const w = m.wind.dir, lowEast = lowW.lon > pt.lon;
      if (between(w, 200, 260)) t += ` A southwest wind with the ${lowW.pressure} mb low to the west says the low will pass north of ${st.id}.`;
      else if (between(w, 140, 200)) t += ` A south or southeast wind says the ${lowW.pressure} mb low may pass close to ${st.id}.`;
      else if (between(w, 20, 140)) t += ` An easterly wind says the ${lowW.pressure} mb low will pass south of ${st.id}; the more easterly the wind, the worse and longer-lasting the weather.`;
      else t += lowEast ? ` A westerly to northerly wind says the ${lowW.pressure} mb low has already gone by ${st.id}.` : ` A westerly to northerly wind with the ${lowW.pressure} mb low still to the west means ${st.id} is in cold air behind a front and not yet in the low's circulation; watch for the wind to back to the south as it approaches.`;
    }
    if (spread != null && spread <= 3 && /\s[-+]?(SH|TS|FZ)?(RA|DZ)\b/.test(String(m.raw || '').split(' RMK')[0])) t += ` Rain falling into air with a ${spread}°C spread will form scud and lower the ceilings.`;
    else if (spread != null && spread <= 2) t += ` The ${spread}°C spread means fog or low stratus can form quickly as temperatures fall.`;
    tparts.push(t);
  }
  if (tparts.length) paras.push({ heading: '4. Terminal winds and the low\'s track', text: tparts.join(' ') });

  // ---------------------------------------------------------------- 5. Which way is better weather, and upstream
  const bparts = [];
  const w700 = meanWind(upper.filter((u) => u.d700 != null).map((u) => ({ dir: u.d700, spd: u.s700 })));
  const trk = geo.bearing(dep, dest);
  if (w700 && w700.spd >= 10) {
    const comp = -w700.spd * Math.cos(geo.rad(geo.angleDiff(w700.dir, trk)));
    const better = (w700.dir + 270) % 360; // back to the wind, low on the left: better weather to the right of where the wind blows
    const rel = geo.angleDiff(better, trk);
    bparts.push(`Winds near 10,000 ft (700 mb) average ${dir3(w700.dir)}° at ${Math.round(w700.spd)} kt, a ${Math.abs(Math.round(comp))} kt ${comp >= 0 ? 'tailwind' : 'headwind'} component on your track. The rule of thumb is that with a tailwind the better weather is to the right and with a headwind it is to the left, because lower pressure lies to the left of the wind. Here that points ${geo.compass(better)}${Math.abs(rel) < 45 ? ' (roughly ahead)' : Math.abs(rel) > 135 ? ' (roughly behind you)' : rel > 0 ? ' (right of course)' : ' (left of course)'}, so favor alternates and diversions in that direction.`);
    summary.betterDir = geo.compass(better);
  }
  // Upstream: in the direction from which the main system is coming
  const key = relevantFr.find((f) => f.crossesRoute || f.destPassage) || relevantFr[0];
  const keyLow = lows[0];
  let fromDir = null, upRef = dest, sys = null;
  if (key && key.motion && key.motion.speedKt >= 5) { fromDir = (key.motion.towardDeg + 180) % 360; sys = `the ${key.name}`; upRef = { lat: key.encounter.lat, lon: key.encounter.lon, id: key.crossesRoute ? `the point where the route meets the ${key.name}` : `the part of the route closest to the ${key.name}` }; }
  else if (keyLow && keyLow.motion && keyLow.motion.speedKt >= 5 && keyLow.motion.speedKt <= 55) { fromDir = (keyLow.motion.towardDeg + 180) % 360; sys = `the ${keyLow.pressure} mb low`; }
  else if (w700) { fromDir = w700.dir; sys = 'the mid-level steering flow'; }
  if (fromDir != null) {
    const up0 = offset(upRef, fromDir, 200);
    const cand = obs.filter((o) => geo.distNm(o, up0) <= 120 && o.icaoId && /^K|^C|^M/.test(o.icaoId)).sort((a, b) => geo.distNm(a, up0) - geo.distNm(b, up0)).slice(0, 5);
    const desc = cand.map((o) => `${o.icaoId}${o.fltCat ? ' ' + o.fltCat : ''}${o.wxString ? ' ' + o.wxString : ''} ${o.wdir != null ? (o.wdir === 'VRB' ? 'VRB' : dir3(o.wdir)) + '/' + o.wspd + 'kt' : ''} ${o.temp != null ? o.temp + '°C' : ''}`.replace(/\s+/g, ' ').trim());
    bparts.push(`Check the weather upstream, in the direction from which the system is moving. ${cap(sys)} is coming from the ${geo.compass(fromDir)}, so about 200 nm ${geo.compass(fromDir)} of ${upRef.id} is what is on the way${desc.length ? `: ${desc.join('; ')}` : ', but no reports were found there'}. ${desc.length ? 'If these are worse than the forecast for your destination, the forecast is likely too optimistic; weather is what you find, not what is forecast.' : ''}`);
    summary.upstream = cand;
  }
  if (bparts.length) paras.push({ heading: '5. Better weather and the upstream check', text: bparts.join(' ') });

  // ---------------------------------------------------------------- factors from the method
  const destTemp = destSt && destSt.metar ? destSt.metar.temp : null;
  for (const ls of summary.lowSectors) {
    const arr = ls.where.find((w) => /arrival/.test(w.label));
    if (!arr || arr.d > 500) continue;
    if (arr.sec.key === 'north' && destTemp != null && destTemp <= 4) add('caution', 'Icing', `${dest.id} is north of the ${ls.L.pressure} mb low with a ${destTemp}°C surface temperature`, `At arrival the low is about ${Math.round(arr.d)} nm ${geo.compass(geo.bearing(dest, centerAt(ls.L, t0, eta)))} of ${dest.id}. A low passing south of you is the icing case: warmer air aloft over a cold surface (freezing rain, ice pellets) and a long period of easterly flow and low cloud. Check the freezing level, icing PIREPs and the TAF for FZRA/PL, and keep the alternate out of the cold air.`, dest.id);
    if (arr.sec.key === 'ahead' && arr.d <= 400) add('info', 'Surface analysis', `${dest.id} is on the lifting side of the ${ls.L.pressure} mb low at arrival`, `About ${Math.round(arr.d)} nm ${arr.sec.txt}. Treat it as warm-frontal weather: widespread low ceilings, with alternates affected too. Pick an alternate outside the low's circulation, ${summary.betterDir ? 'toward the ' + summary.betterDir : 'on the far side from its track'}.`, dest.id);
  }
  if (summary.nearWarmFront) {
    const nw = summary.nearWarmFront;
    const eastOfLow = lows.some((L) => geo.distNm(L, nw.pt) <= 400 && between(geo.bearing(L, nw.pt), 20, 130));
    const dew = nw.f._dWarm != null ? nw.f._dWarm : destSt && destSt.metar ? destSt.metar.dewp : null;
    if ((eastOfLow || (summary.lapse != null && summary.lapse >= 1.8)) && dew != null && dew >= 8 && (summary.lapse == null || summary.lapse >= 1.6)) add('caution', 'Convection', `Possible embedded thunderstorms near the ${nw.f.name}`, `${cap(nw.label)} you are within ${Math.round(nw.dd)} nm of the surface ${nw.f.name} on its cold side${eastOfLow ? ', just east of a low' : ''}. The worst embedded thunderstorms are usually within about 100 miles of a warm front's surface position and just east of the low, hidden in stratus. Use onboard radar and datalink, and get the latest Convective SIGMETs before the descent.`, nw.pt.id);
  }
  const warmSectorRoute = summary.lowSectors.some((ls) => ls.where.some((w) => w.sec.key === 'warm' && w.d <= 500));
  const coldNear = relevantFr.some((f) => f.type === 'COLD' || f.type === 'SQLN');
  if (summary.jetNE && coldNear && (warmSectorRoute || (summary.lapse != null && summary.lapse >= 2))) add('caution', 'Convection', 'Squall-line setup ahead of the cold front', `Strong southwesterly flow aloft (${summary.w500.dir}°/${summary.w500.spd} kt at 500 mb) ahead of a cold front${summary.lapse != null ? `, with a ${summary.lapse.toFixed(1)}°C/1,000 ft lapse rate,` : ''} is the pattern for lines of severe storms forming 100 nm or more ahead of the front. Plan wide deviations (20 nm from severe cells) and check Convective SIGMETs and the SPC outlook.`, 'surface');
  if (summary.overrunning && destTemp != null && destTemp <= 3 && summary.overrunning === dest.id) add('caution', 'Icing', `${dest.id}: warm air overrunning cold air near the surface`, `Northeast-to-east surface winds under southwesterly winds near 5,000 ft at ${dest.id}, with ${destTemp}°C at the surface. That is the classic freezing rain setup; check the TAF and PIREPs for FZRA and plan an alternate in warmer air.`, dest.id);

  // ---------------------------------------------------------------- bottom line
  const bl = [];
  const arrSec = summary.lowSectors.map((ls) => ({ ls, w: ls.where.find((w) => /arrival/.test(w.label)) })).filter((x) => x.w && x.w.d <= 600)[0];
  if (arrSec) bl.push(`Position first: at arrival ${dest.id} is ${arrSec.w.sec.txt.replace('the low', `the ${arrSec.ls.L.pressure} mb low`)} (${arrSec.ls.strength}${arrSec.ls.moisture != null ? `, ${arrSec.ls.moisture >= 12 ? 'moist' : arrSec.ls.moisture < 2 ? 'dry' : 'moderately moist'}` : ''}).`);
  else bl.push(`No low is close enough to dominate the weather at ${dest.id}; the air mass and any nearby boundary decide it.`);
  if (summary.flow) bl.push(summary.flow === 'sw' ? 'Upper support is present (southwesterly flow aloft), so expect systems to develop or hold together rather than weaken.' : summary.flow === 'nw' ? 'Flow aloft is northwesterly, so systems should be clearing out or weakening.' : summary.flow === 'w' ? 'Flow aloft is flat, so there is little support for systems to strengthen.' : 'A closed low aloft is nearby, so expect slow, persistent weather.');
  const crossing = sf.fronts.filter((f) => f.crossesRoute);
  if (crossing.length) bl.push(`The ${crossing.map((f) => f.name).join(' and ')} cross${crossing.length === 1 ? 'es' : ''} the route; at FL${Math.round(opts.cruiseAlt / 100)} you are above most frontal stratus, so the exposure is in the climb and descent through the frontal surface and in any embedded convection.`);
  if (summary.slopeCross && summary.slopeCross.length) bl.push(`You pass through a frontal surface near ${summary.slopeCross.map((x) => `${ftTxt(x.h)} (${x.label})`).join(' and ')}; brief anti-ice use and expect a wind shift there.`);
  if (summary.betterDir) bl.push(`Better weather lies to the ${summary.betterDir}: put the alternate and any diversion plan that way.`);
  bl.push('The forecast is a starting point, so compare what you see en route with it and replan early if the weather runs ahead of schedule.');
  paras.push({ heading: 'What it means for this flight', text: bl.join(' ') });

  return { paras, factors, summary: { flow: summary.flow || null, w500: summary.w500 || null, lapse: summary.lapse != null ? Math.round(summary.lapse * 10) / 10 : null, betterWeather: summary.betterDir || null, upstream: (summary.upstream || []).map((o) => o.icaoId) } };
}

module.exports = { analyze, sectorOf, sideOf };
