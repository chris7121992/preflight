'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFlightPlan } = require('../engine/lib/parse');
const fronts = require('../engine/lib/fronts');
const dec = require('../engine/lib/decode');
const { bestRunway } = require('../engine/lib/brief');
const geo = require('../engine/lib/geo');

test('parses Garmin/ForeFlight .fpl', () => {
  const p = parseFlightPlan(fs.readFileSync(path.join(__dirname, '../samples/KTEB-KPBI.fpl'), 'utf8'), 'x.fpl');
  assert.deepStrictEqual(p.waypoints.map((w) => w.id), ['KTEB', 'SBJ', 'SAWED', 'ORL', 'KPBI']);
  assert.ok(Math.abs(p.waypoints[0].lat - 40.8501) < 1e-6);
});

test('parses KML with placemarks', () => {
  const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>KDAL-KASE</name>
    <Placemark><name>KDAL</name><Point><coordinates>-96.85,32.85,0</coordinates></Point></Placemark>
    <Placemark><name>KASE</name><Point><coordinates>-106.87,39.22,12000</coordinates></Point></Placemark>
    <Placemark><LineString><coordinates>-96.85,32.85,0 -106.87,39.22,12000</coordinates></LineString></Placemark></Document></kml>`;
  const p = parseFlightPlan(kml, 'a.kml');
  assert.deepStrictEqual(p.waypoints.map((w) => w.id), ['KDAL', 'KASE']);
});

test('parses GPX route', () => {
  const gpx = `<gpx><rte><rtept lat="33.94" lon="-118.41"><name>KLAX</name></rtept><rtept lat="36.08" lon="-115.15"><name>KLAS</name></rtept></rte></gpx>`;
  const p = parseFlightPlan(gpx, 'a.gpx');
  assert.strictEqual(p.waypoints[1].id, 'KLAS');
  assert.strictEqual(p.waypoints[1].lon, -115.15);
});

test('route string drops airways, procedures and DCT', () => {
  const p = parseFlightPlan('KTEB RUUDY6 WAVEY Q97 SAWED DCT ORL KPBI');
  assert.deepStrictEqual(p.waypoints.map((w) => w.id), ['KTEB', 'WAVEY', 'SAWED', 'ORL', 'KPBI']);
});

test('decodes CODSUS points and sections', () => {
  assert.deepStrictEqual(fronts.decodePoint('4699'), { lat: 46, lon: -99 });
  assert.deepStrictEqual(fronts.decodePoint('48109'), { lat: 48, lon: -109 });
  const txt = `CODSUS\nVALID 112318Z\nHIGHS 1035 4699\nLOWS 997 5366\nCOLD 4871 4674 4479\n`;
  const prog = `CODSRP\n12HR PROG VALID 240600Z\nHIGHS 1036 4495\nCOLD 4861 4464 4069\n`;
  const ref = new Date(Date.UTC(2026, 10, 23, 20));
  const s = [...fronts.parseCoded(txt, ref), ...fronts.parseCoded(prog, ref)];
  assert.strictEqual(s[0].valid.toISOString(), '2026-11-23T18:00:00.000Z');
  assert.strictEqual(s[1].valid.toISOString(), '2026-11-24T06:00:00.000Z');
  assert.strictEqual(s[0].fronts[0].type, 'COLD');
  assert.strictEqual(s[0].highs[0].pressure, 1035);
  // A route crossing longitude 74W between 40N and 46N should meet the front
  const route = geo.sampleRoute([{ lat: 47, lon: -66 }, { lat: 40, lon: -66 }], 10).map((p, i) => ({ ...p, t: ref.getTime() + i * 60e3 }));
  const r = fronts.interpretRoute(s, route);
  assert.ok(r.fronts.length >= 1);
  assert.ok(r.fronts[0].motion && r.fronts[0].motion.speedKt > 0);
});

test('TAF window and worst-case', () => {
  const t0 = Date.UTC(2026, 10, 24, 0) / 1000;
  const taf = { fcsts: [
    { timeFrom: t0, timeTo: t0 + 6 * 3600, wdir: 200, wspd: 10, visib: '6+', clouds: [{ cover: 'BKN', base: 3500 }] },
    { timeFrom: t0 + 3600, timeTo: t0 + 4 * 3600, fcstChange: 'TEMPO', wdir: 220, wspd: 15, wgst: 30, visib: '1 1/2', wxString: 'TSRA', clouds: [{ cover: 'OVC', base: 800 }] },
  ] };
  const per = dec.tafWindow(taf, t0 * 1000, (t0 + 7200) * 1000);
  assert.strictEqual(per.length, 2);
  const w = dec.worstOf(per);
  assert.strictEqual(w.ceiling, 800);
  assert.strictEqual(w.vis, 1.5);
  assert.ok(w.flags.thunder);
  assert.strictEqual(dec.worstOf(per.filter((p) => !p.temporary)).category, 'VFR');
});

test('crosswind picks best runway', () => {
  const apt = { runways: [{ id: '01/19', dimension: '6997x150', surface: 'A', alignment: 3 }, { id: '06/24', dimension: '6014x150', surface: 'A', alignment: 48 }] };
  const r = bestRunway(apt, { dir: 330, spd: 20, gst: 30 }, {});
  assert.strictEqual(r.id, '01');
  assert.ok(r.crossG >= 15 && r.crossG <= 17, `gust crosswind ${r.crossG}`);
});

test('position relative to a low', () => {
  const { sectorOf, sideOf } = require('../engine/lib/sfcread');
  assert.strictEqual(sectorOf(60).key, 'ahead');   // northeast of the low
  assert.strictEqual(sectorOf(160).key, 'warm');   // south-southeast: warm sector
  assert.strictEqual(sectorOf(250).key, 'behind'); // west-southwest: low has passed
  assert.strictEqual(sectorOf(0).key, 'north');    // low passing to the south
  const line = [{ lat: 40, lon: -90 }, { lat: 40, lon: -80 }];
  assert.notStrictEqual(sideOf({ lat: 42, lon: -85 }, line), sideOf({ lat: 38, lon: -85 }, line));
});

test('route options score exposure to a convective SIGMET', () => {
  const { exposure, hazardSet } = require('../engine/lib/routing');
  const now = Date.now();
  const sig = { hazard: 'CONVECTIVE', seriesId: '12E', validTimeFrom: now / 1000 - 600, validTimeTo: now / 1000 + 7200, altitudeHi1: 45000,
    coords: [{ lat: 34, lon: -80 }, { lat: 34, lon: -78 }, { lat: 36, lon: -78 }, { lat: 36, lon: -80 }] };
  const hz = hazardSet({ sigmets: [sig] });
  const S = [{ lat: 35, lon: -79, t: now, alt: 41000, phase: 'cruise' }];
  const far = [{ lat: 30, lon: -79, t: now, alt: 41000, phase: 'cruise' }];
  assert.ok(exposure(S, hz).score > 0);
  assert.strictEqual(exposure(far, hz).score, 0);
});

test('approach minimums: 135.223(b) and C055 from chart data', () => {
  const m = require('../engine/lib/minimums');
  const row = (label, alt, hat, vis, circling = false) => ({ label, circling, cats: { C: { alt, hat, vis } } });
  const rec = { cycle: '2611', alternateMinimums: 'X (XXX) ILS Rwy 9 Cat C 900-2½', procedures: [
    { name: 'ILS OR LOC RWY 09', pdf: 'a.PDF', rwy: '09', rows: [row('S-ILS 9', 220, 200, 0.5), row('S-LOC 9', 500, 480, 1), row('CIRCLING', 700, 680, 2, true)] },
    { name: 'ILS OR LOC RWY 27', pdf: 'b.PDF', rwy: '27', rows: [row('S-ILS 27', 270, 250, 0.75)] },
    { name: 'VOR RWY 18', pdf: 'c.PDF', rwy: '18', rows: [row('S-18', 520, 500, 1)] },
    { name: 'RNAV (GPS) RWY 36', pdf: 'd.PDF', rwy: '36', rows: [row('LPV DA', 220, 200, 0.5), row('LNAV MDA', 420, 400, 1)] },
  ] };
  const d = m.destinationTest(rec, { cat: 'C', runway: '27' });
  assert.strictEqual(d.ceilNeed, 2180);
  assert.strictEqual(d.visNeed, 3);
  assert.strictEqual(d.approach.rwy, '27');
  // 09 and 27 are the same pavement, so the second facility is the VOR to 18
  const a = m.alternateMinimums({ ...rec, alternateMinimums: null }, { cat: 'C' });
  assert.strictEqual(a.facilities, 2);
  assert.strictEqual(a.ceil, 700);
  assert.strictEqual(a.vis, 1.5);
  const one = m.alternateMinimums({ ...rec, alternateMinimums: null }, { cat: 'C', facilities: 1 });
  assert.deepStrictEqual([one.ceil, one.vis], [600, 1.5]);
  const raised = m.alternateMinimums(rec, { cat: 'C', applyPublished: true });
  assert.deepStrictEqual([raised.ceil, raised.vis], [900, 2.5]);
  const gpsOnly = { cycle: '2611', procedures: [rec.procedures[3]] };
  assert.ok(m.alternateMinimums(gpsOnly, { cat: 'C' }).none);
  assert.strictEqual(m.alternateMinimums(gpsOnly, { cat: 'C', gps: true }).ceil, 800);
});

test('NOTAM text: closures, partial closures and times', () => {
  const notam = require('../engine/lib/notam');
  const text = [
    'Departure KHOU - William P Hobby', ' RUNWAY',
    ' HOU 09/188 HOU RWY 13L/31R CLSD 2609292023-2712312300',
    ' HOU 11/063 HOU RWY 13R PAPI U/S 2611121331-2611252000EST',
    ' TAXIWAY',
    ' HOU 10/171 HOU TWY M BTN TWY K AND TWY H CLSD 2610302232-2612312359',
    ' HOU 11/117 HOU TWY Z LOCATION MARKINGS BTN TWY D AND TWY H1 REMOVED', '                2611231811-2701312359',
    ' HOU 09/189 HOU TWY K1 CLSD 2609292052-2612312300',
    ' HOU 07/064 HOU NAV ILS RWY 04 U/S 2607131430-2612311800',
    '', 'Destination MMSL - Cabo San Lucas International', ' RUNWAY WORK IN PROGRESS',
    ' B3888/26 NOTAMR B3884/26', ' Q) MMFR/QMRHW/IV/NBO/A/000/999/2257N10956W002', ' A) MMSL', ' B) 2611031400', ' C) 2612030259',
    ' E) RWY 11/29 WIP MEN AND EQPT WILL BE REMOVED FOR ACFT OPS', '', 'US Enroute Navigation NOTAMs',
  ].join('\n');
  const all = notam.parse(text);
  assert.strictEqual(all.length, 7);
  const by = Object.fromEntries(all.map((n) => [n.number, n]));
  assert.deepStrictEqual(by['HOU 09/188'].items.map((i) => [i.kind, i.name, i.status]), [['RWY', '13L/31R', 'closed']]);
  assert.strictEqual(by['HOU 11/063'].items[0].status, 'minor');
  assert.deepStrictEqual(by['HOU 10/171'].items[0].between.map((b) => b.name), ['K', 'H']);
  assert.strictEqual(by['HOU 10/171'].items[0].status, 'restricted');
  assert.strictEqual(by['HOU 11/117'].end, Date.UTC(2027, 0, 31, 23, 59));
  assert.deepStrictEqual(by['HOU 07/064'].nav, { aid: 'ILS', rwy: '4', part: 'aid' });
  assert.strictEqual(by['B3888/26'].location, 'MMSL');
  assert.deepStrictEqual(by['B3888/26'].items.map((i) => [i.name, i.status]), [['11/29', 'affected']]);
  const grouped = notam.byAirport(all, [{ id: 'KHOU', ids: ['KHOU', 'HOU'] }, { id: 'MMSL', ids: ['MMSL'] }]);
  assert.strictEqual(grouped.KHOU.length, 6);
  assert.ok(!notam.activeIn(by['HOU 11/063'], Date.UTC(2026, 10, 26), Date.UTC(2026, 10, 26, 2)));
});

test('procedures: SID and STAR picked for runway and direction of flight', () => {
  const procedures = require('../engine/lib/procedures');
  const dep = { id: 'KAAA', lat: 30, lon: -95 }, dest = { id: 'KBBB', lat: 30, lon: -85 };
  const route = [dep, { id: 'MIDDD', lat: 30.2, lon: -90 }, dest];
  const sids = { sids: [
    { code: 'EAST1.EASTT', name: 'EAST', rnav: true, bodies: [{ name: 'AAA-EASTT', rwys: ['04', '22'], pts: [['EASTT', 30, -94.5]] }], transitions: [{ code: 'EAST1.FARRE', name: 'FARRE', pts: [['EASTT', 30, -94.5], ['FARRE', 30.1, -93.5]] }] },
    { code: 'WEST1.WESTT', name: 'WEST', rnav: true, bodies: [{ name: 'AAA-WESTT', rwys: ['04', '22'], pts: [['WESTT', 30, -95.6]] }], transitions: [] },
    { code: 'ONLY13.EASTT', name: 'ONLY', rnav: false, bodies: [{ name: 'X-EASTT', rwys: ['13'], pts: [['EASTT', 30, -94.5]] }], transitions: [] },
  ] };
  const s = procedures.choose('sids', sids, { airport: dep, runway: '4', route, hz: null, opts: { cruiseAlt: 41000, etd: 0 }, etaMs: 7200e3 });
  assert.strictEqual(s.pick.procCode, 'EAST1.EASTT');
  assert.ok(!s.options.some((o) => o.procCode === 'ONLY13.EASTT'));
  const stars = { stars: [{ code: 'INNN.INNN2', name: 'INNN', rnav: true, bodies: [{ name: 'INNN-BBB', rwys: ['ALL'], pts: [['INNN', 30, -86], ['CLOSE', 30, -85.4]] }], transitions: [{ code: 'MIDDD.INNN2', name: 'MIDDD', pts: [['MIDDD', 30.2, -90], ['INNN', 30, -86]] }] }] };
  const t = procedures.choose('stars', stars, { airport: dest, runway: '9', route, hz: null, opts: { cruiseAlt: 41000, etd: 0 }, etaMs: 7200e3 });
  assert.strictEqual(t.pick.code, 'MIDDD.INNN2');
  assert.ok(t.pick.onFiledRoute);
  const full = procedures.assemble({ route, sid: s, star: t });
  assert.strictEqual(full.string, `KAAA ${s.pick.code} MIDDD.INNN2 KBBB`);
});

test('ForeFlight briefing text: flight details and navigation log', () => {
  const { parseBriefing } = require('../engine/lib/ffbrief');
  const text = [
    'KAAA — KBBB (Nov 24, 2026) in N123AB as TST123 (C56X - 560 Citation XLS+) IFR Created Nov 23 2026 2351Z',
    '250 KIAS/M0.65 - Maximum Cruise Thrust @ FL430 - Normal 2000 FPM Winds Nov 23 2026 1800Z',
    'ETE Distance Avg Wind ETD ETA TOW ELW', '2h58m 933NM 72kt head (284°/109) 19:45 CST / 0145Z 21:43 CST / 0343Z 20330 lbs 16417 lbs',
    'Route RAIM (5° Mask, With Baro-aid)', 'DEPP9 PSX J22 NLD ARRV1 ✓ RAIM: No outages predicted',
    'WAYPOINT AIRWAY HDG CRS ALT CMP DIR/SPD ISA TAS GS LEG REM USED REM ACT LEG REM ETE ACT',
    'KAAA - - 46 - - -3 - - - 933 200 6055 - 2:58 -', 'SAALT DEPP9 167 167 7800 T4 345/005 0 234 240 10 923 315 5940 0:02 2:56 0:02',
    'PSX DEPP9 232 224 FL365 H47 262/069 +2 315 268 37 849 834 5421 0:09 2:38 0:20', 'PALACIOS 117.3',
    '-TOC- DCT 250 244 FL430 H58 278/083 +2 348 290 45 804 1026 5229 0:09 2:29 0:29',
    'NLD J22 257 249 FL430 H88 285/100 -3 411 323 5 658 1547 4708 0:01 2:03 0:55',
    'KBBB ARRV1 298 297 692 T2 039/005 +11 237 240 14 - 4113 2142', 'PSX (H61) 259/070 +2 (H60) 269/076 +5',
    'Alternate KCCC - Somewhere Regional',
  ].join('\n');
  const f = parseBriefing(text);
  assert.deepStrictEqual([f.dep, f.dest, f.alternate, f.cruiseAlt, f.tas, f.callsign], ['KAAA', 'KBBB', 'KCCC', 43000, 411, 'TST123']);
  assert.strictEqual(f.etd, '2026-11-25T01:45:00.000Z');
  assert.strictEqual(f.filedRoute, 'DEPP9 PSX J22 NLD ARRV1');
  assert.strictEqual(f.routeText, 'KAAA SAALT PSX NLD KBBB');
  assert.strictEqual(parseBriefing('nothing here'), null);
});

test('future arrivals are judged on forecasts, never the current METAR', () => {
  const { judgeBasis } = require('../engine/lib/brief');
  const b = (o) => judgeBasis({ hoursAhead: 6, tafCovers: false, hasMetar: true, nModels: 0, role: 'destination', ...o });
  assert.strictEqual(b({ tafCovers: true, nModels: 3 }), 'TAF');
  assert.strictEqual(b({ nModels: 3 }), 'models');
  assert.strictEqual(b({}), 'none', 'a METAR six hours before arrival decides nothing');
  assert.strictEqual(b({ role: 'alternate' }), 'none');
  assert.strictEqual(b({ hoursAhead: 0.5, tafCovers: true, nModels: 3 }), 'METAR');
  assert.strictEqual(b({ hoursAhead: 0.5, hasMetar: false, tafCovers: true }), 'TAF');
  assert.strictEqual(b({ role: 'departure' }), 'METAR');
});

test('simulated radar: reflectivity from model precipitation along the route', () => {
  const sr = require('../engine/lib/simradar');
  assert.strictEqual(sr.dbzOf(0, false), 0);
  assert.ok(sr.dbzOf(1, false) >= 22 && sr.dbzOf(1, false) <= 24);
  assert.ok(sr.dbzOf(10, true) >= 38 && sr.dbzOf(25, true) >= 44);
  const t0 = Date.UTC(2026, 10, 25, 12);
  const samples = Array.from({ length: 31 }, (_, i) => ({ lat: 30 + i * 0.1, lon: -95, s: i * 10, t: t0 + i * 2 * 60e3, alt: 30000, phase: 'cruise' }));
  const pts = sr.routePoints(samples, 4);
  assert.deepStrictEqual(pts.map((p) => p.s), [0, 100, 200, 300]);
  assert.strictEqual(sr.frames(samples).length, 5);
  const time = ['2026-11-25T12:00', '2026-11-25T13:00', '2026-11-25T14:00'];
  const hourly = (wet) => ({ time, precipitation_a: wet ? [0, 12, 12] : [0, 0, 0], precipitation_b: wet ? [0, 14, 14] : [0, 0, 0], weather_code_a: wet ? [3, 95, 95] : [1, 1, 1], weather_code_b: [3, 63, 63], cape_a: [0, 0, 0], cape_b: [0, 0, 0] });
  const factors = [];
  const out = sr.analyze(pts, ['a', 'b'], (i) => hourly(i === 2), (level, cat, title) => factors.push({ level, title }), () => '25/1240Z');
  assert.strictEqual(out.rows[0].max, 0);
  assert.ok(out.rows[2].cells.a.dbz >= 45 && out.rows[2].cells.a.thunder);
  assert.ok(out.rows[2].cells.b.dbz >= 40);
  assert.strictEqual(factors.length, 1);
  assert.strictEqual(factors[0].level, 'caution');
  assert.match(factors[0].title, /heavy echoes on the route at 200 nm/);
});

test('fuel recommendation from a ForeFlight fuel plan and the forecast', () => {
  const { recommend } = require('../engine/lib/fuel');
  const { parseBriefing } = require('../engine/lib/ffbrief');
  const b = parseBriefing(['KAAA — KBBB (Nov 24, 2026) in N1 as ABC1 (C56X - 560 Citation XLS+) IFR', 'ETE Distance Avg Wind ETD ETA TOW ELW', '2h58m 933NM 72kt head (284°/109) 16:45 CST / 2245Z 18:43 MST / 0143Z 19800 lbs 15687 lbs', 'Block Fuel Taxi Fuel Flight Fuel Reserve Fuel Alternate Fuel Extra Fuel Landing Fuel', '6255 lbs 200 lbs 4113 lbs 1750 lbs 0 lbs 392 lbs 2142 lbs'].join('\n'));
  assert.deepStrictEqual({ block: b.fuel.block, flight: b.fuel.flight, reserve: b.fuel.reserve, tow: b.fuel.tow, eteMin: b.fuel.eteMin, headKt: b.fuel.headKt, distNm: b.fuel.distNm }, { block: 6255, flight: 4113, reserve: 1750, tow: 19800, eteMin: 178, headKt: 72, distNm: 933 });
  const base = { rules: '91', distNm: 933, eteMin: 178, windHeadKt: 72, ff: b.fuel };
  const ok = recommend({ ...base });
  assert.strictEqual(ok.minimumLb, 4113 + 1750);
  assert.strictEqual(ok.level, 'info');
  assert.strictEqual(ok.marginLb, 392);
  assert.strictEqual(ok.landingLb, 2142);
  // an alternate becomes required and the destination is IFR: more than planned is needed
  const need = recommend({ ...base, alternate: { id: 'KCCC', filed: true, required: true, distNm: 120 }, flags: { hold: 'KBBB is forecast IFR at ETA' } });
  assert.ok(need.lines.find((l) => l.key === 'alternate').lb > 450);
  assert.strictEqual(need.level, 'nogo');
  assert.match(need.notes.join(' '), /no alternate fuel/);
  // stronger headwind than planned adds trip fuel
  const wind = recommend({ ...base, windHeadKt: 102 });
  assert.ok(wind.lines.find((l) => l.key === 'wind').lb > 300);
  // without a briefing the figures are estimates
  const est = recommend({ rules: '135', distNm: 900, eteMin: 170, cruiseFlow: 1400, estTripLb: 3950 });
  assert.strictEqual(est.plannedLb, null);
  assert.match(est.text, /Flight Planning Guide/);
  assert.ok(est.lines.find((l) => l.key === 'reserve').lb >= 767);
  const perf = require('../engine/lib/perf');
  // the guide's mission table: 900 nm at 35,000 ft is 2:10 and 3,385 lb including 135 lb taxi
  const t = perf.trip({ distNm: 900, altFt: 35000, towLb: 18000 });
  assert.ok(Math.abs(t.min - 130) <= 3 && Math.abs(t.lb + 135 - 3385) <= 110, `${t.min} min ${t.lb} lb`);
  assert.strictEqual(Math.round(perf.cruise(41000, 18000).flow), 1267);
  assert.strictEqual(Math.round(perf.holdFlow(15000, 10000)), 952);
});

test('route strings: procedures are kept aside and every US fix is on file', () => {
  const p = parseFlightPlan('KDFW HUDAD2.CEVEX RAMBL SNSET J58 PGLET DCT KABQ');
  assert.deepStrictEqual(p.waypoints.map((w) => w.id), ['KDFW', 'RAMBL', 'SNSET', 'PGLET', 'KABQ']);
  assert.deepStrictEqual(p.procedures, [{ token: 'HUDAD2.CEVEX', at: 1 }]);
  assert.deepStrictEqual(p.airways, [{ token: 'J58', at: 3 }]);
  const awy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'nav', 'airways.json'), 'utf8'));
  assert.ok(awy.J22.some((pts) => pts.includes('PSX')) && Object.keys(awy).length > 1000);
  assert.deepStrictEqual(parseFlightPlan('KTEB SBJ STOOP.STOOP4 KPBI').procedures, [{ token: 'STOOP.STOOP4', at: 2 }]);
  const nav = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'nav', `${id[0]}.json`), 'utf8'))[id];
  for (const id of ['RAMBL', 'SNSET', 'PGLET', 'MUTEE', 'HUDAD', 'CEVEX']) assert.ok(nav(id) && nav(id)[0][2] === 'F', id);
  assert.strictEqual(nav('SBJ')[0][2], 'N');
});

test('runway length from the Flight Planning Guide tables', () => {
  const f = require('../engine/lib/fieldperf');
  // the guide's headline figures: 3,560 ft takeoff at MTOW and 3,180 ft landing at MLW, sea level, ISA
  assert.deepStrictEqual(f.takeoff({ weightLb: 20200, tempC: 15, elevFt: 0 }), { ft: 3560, flaps: 15 });
  assert.strictEqual(f.landing({ weightLb: 18700, tempC: 15, elevFt: 0 }).ft, 3180);
  assert.strictEqual(f.landing({ weightLb: 18700, tempC: 15, elevFt: 0 }).vref, 117);
  // between printed values, and hotter and higher needs more
  const a = f.takeoff({ weightLb: 19000, tempC: 27, elevFt: 5433 });
  assert.ok(a.flaps === 15 && a.ft > 4900 && a.ft < 5400, JSON.stringify(a));
  // at the climb limit the guide's limit figure is used; beyond it there is no takeoff
  assert.strictEqual(f.takeoff({ weightLb: 20200, tempC: 45, elevFt: 0 }).ft, 5280);
  assert.strictEqual(f.takeoff({ weightLb: 20200, tempC: 38, elevFt: 5433 }).ft, null);
  assert.strictEqual(f.takeoff({ weightLb: 20330, tempC: 20, elevFt: 0 }).ft, null);
});

test('NOTAM notations: lights, aids, obstacles and procedures beyond closures', () => {
  const notam = require('../engine/lib/notam');
  const one = (t) => notam.parseOne(`!HOU 11/001 HOU ${t} 2611010000-2612312359`).notes;
  assert.deepStrictEqual(one('RWY 04 PAPI U/S').map((x) => [x.code, x.rwy]), [['PAPI', '4']]);
  const als = one('RWY 22 ALS U/S')[0];
  assert.strictEqual(als.code, 'ALS'); assert.strictEqual(als.level, 'caution');
  assert.strictEqual(one('RWY 13L/31R CLSD').length, 0);
  assert.deepStrictEqual(one('AD AP WINDCONE FOR RWY 04 U/S').map((x) => [x.code, x.rwy]), [['WIND', '4']]);
  const ils = one('NAV ILS RWY 04 U/S')[0];
  assert.strictEqual(ils.code, 'ILS'); assert.strictEqual(ils.rwy, '4'); assert.strictEqual(ils.level, 'caution');
  const ob = one('OBST CRANE (ASN 2026-ASW-17181-OE) 293604N0951723W (2.7NM SSW HOU) 213FT (170FT AGL) FLAGGED AND LGTD')[0];
  assert.strictEqual(ob.code, 'OBST'); assert.strictEqual(ob.what, 'crane'); assert.strictEqual(ob.ft, 213); assert.strictEqual(ob.nm, 2.7);
  assert.ok(Math.abs(ob.lat - 29.6011) < 0.001 && Math.abs(ob.lon + 95.2897) < 0.001);
  assert.ok(one('OBST TOWER LGT (ASR 1050473) 294549.00N0952138.00W (8.2NM NNW HOU) 242.1FT (190.0FT AGL) U/S')[0].unlit);
  const iap = one('IAP WILLIAM P HOBBY, HOUSTON, TX. ILS OR LOC RWY 13R, AMDT 12D... RNAV (GPS) RWY 4, AMDT 3A... CIRCLING CATS A/B MDA 600/HAA 554.');
  assert.deepStrictEqual(iap.map((x) => x.rwy).sort(), ['13R', '4']);
  const odp = one('ODP WILLIAM P HOBBY, HOUSTON, TX. TAKEOFF MINIMUMS AND (OBSTACLE) DEPARTURE PROCEDURES AMDT 7B... TAKEOFF OBSTACLE NOTES: RWY 13R, TEMPORARY CONSTRUCTION EQUIPMENT, 957FT FROM DER');
  assert.ok(odp.some((x) => x.code === 'DEP' && x.rwy === '13R' && x.der));
  const twy = notam.parseOne('!HOU 11/002 HOU TWY E EDGE MARKINGS BTN APCH END RWY 13L AND TWY Y NOT MARKED 2611010000-2612312359');
  assert.strictEqual(twy.items[0].name, 'E'); assert.strictEqual(twy.notes[0].code, 'MARK'); assert.strictEqual(twy.notes[0].twy, 'E');
});

test('turbulence: shear under a jet is rougher than the level above it, and EDR mapping rises with shear', () => {
  const turb = require('../engine/lib/turb');
  assert.ok(turb.mapEdr(2, [[1, 0.04], [5, 0.19]]) > turb.mapEdr(1.2, [[1, 0.04], [5, 0.19]]));
  assert.strictEqual(turb.catOf(0.05), 'smooth'); assert.strictEqual(turb.catOf(0.25), 'moderate');
  const dep = { lat: 30, lon: -95 }, dest = { lat: 30, lon: -80 };
  const lat = turb.lattice(dep, dest);
  const etd = Date.UTC(2026, 10, 26, 12);
  // westerly jet: 40 kt at 500 hPa rising to 140 kt at 250 hPa, then nearly constant above (smooth near FL430)
  const spd = { 700: 20, 500: 40, 400: 70, 300: 110, 250: 140, 200: 142, 150: 140 }, tmp = { 700: 0, 500: -18, 400: -30, 300: -45, 250: -52, 200: -56, 150: -57 };
  const hourly = { time: ['2026-11-26T12:00', '2026-11-26T13:00', '2026-11-26T14:00'] };
  for (const l of turb.LEVELS) { hourly[`wind_speed_${l}hPa_m`] = [spd[l], spd[l], spd[l]]; hourly[`wind_direction_${l}hPa_m`] = [270, 270, 270]; hourly[`temperature_${l}hPa_m`] = [tmp[l], tmp[l], tmp[l]]; }
  const T = turb.analyze({ lat, raw: { models: ['m'], data: lat.points.map(() => ({ elevation: 10, hourly })), elevation: null }, etd, eteMs: 2 * 3600e3 });
  const mid = { lat: 30, lon: -87.5 };
  const lo = T.at(mid, 32000), hi = T.at(mid, 43000);
  assert.ok(lo.edr > hi.edr * 1.5, `under the jet ${lo.edr} vs above ${hi.edr}`);
  const samples = [0, 100, 200, 300].map((s) => ({ ...require('../engine/lib/geo').interpolate(dep, dest, s / 780), s, alt: 32000 }));
  const st = T.along(samples);
  assert.ok(st.peak >= lo.edr - 0.02 && st.score >= 0);
  const pos = turb.locate(lat, { lat: 31, lon: -87.5 });
  assert.ok(pos.c < -35 && pos.c > -60, `north of an eastbound course is left: ${pos.c}`);
});

test('ForeFlight Runway Analysis: figures are read from labelled text and cleaned', () => {
  const { parseRunwayAnalysis, clean } = require('../engine/lib/ffrunway');
  const ra = parseRunwayAnalysis(['Runway Analysis', 'Takeoff', 'KHOU RWY 13R', 'Runway Condition: Wet', 'Flaps 15', 'Takeoff Weight 19,850 lb', 'Max Allowable Takeoff Weight: 20,200 lb', 'Limited by: Field Length', 'Takeoff Field Length 4,620 ft', 'V1 108 VR 112 V2 119', '', 'Landing', 'MMSL RWY 16', 'Runway Condition Dry', 'Landing Weight 17,900 lb', 'Unfactored Landing Distance 3,010 ft', 'Factored Landing Distance (1.67) 5,020 ft', 'VREF 111 VAPP 116'].join('\n'));
  assert.equal(ra.takeoff.airport, 'KHOU'); assert.equal(ra.takeoff.runway, '13R'); assert.equal(ra.takeoff.distFt, 4620); assert.equal(ra.takeoff.mtowLb, 20200);
  assert.equal(ra.takeoff.wet, true); assert.equal(ra.takeoff.v1, 108); assert.equal(ra.takeoff.vr, 112); assert.equal(ra.takeoff.v2, 119); assert.equal(ra.takeoff.limit, 'field length');
  assert.equal(ra.landing.airport, 'MMSL'); assert.equal(ra.landing.runway, '16'); assert.equal(ra.landing.distFt, 3010); assert.equal(ra.landing.factor, 'actual'); assert.equal(ra.landing.wet, false); assert.equal(ra.landing.vref, 111);
  const only = parseRunwayAnalysis('Landing\nKCDW Runway 22\nLanding Distance Required (factored 60%) 5,400 ft');
  assert.equal(only.takeoff, null); assert.equal(only.landing.distFt, 5400); assert.equal(only.landing.factor, '60');
  assert.equal(parseRunwayAnalysis('nothing useful here'), null);
  const c = clean({ source: 'x.pdf', takeoff: { distFt: '4620', mtowLb: '', runway: 'rwy 4l' }, landing: { distFt: '99', factor: '60' } });
  assert.equal(c.takeoff.distFt, 4620); assert.equal(c.takeoff.runway, '04L'); assert.equal(c.landing, null);
  assert.equal(clean({ takeoff: {}, landing: {} }), null);
});

test('AFM wet runway landing distance is read from the dry distance', () => {
  const { wetLanding } = require('../engine/lib/fieldperf');
  assert.deepEqual([wetLanding(3200).vrefFt, wetLanding(3200).plus10Ft], [3750, 4250]);
  assert.deepEqual([wetLanding(9800).vrefFt, wetLanding(9800).plus10Ft], [10650, 11250]);
  assert.deepEqual([wetLanding(7000).vrefFt, wetLanding(7000).plus10Ft], [7850, 8450]);
  assert.equal(wetLanding(3100).vrefFt, 3650);
  assert.equal(wetLanding(1200).vrefFt, 1900);
  assert.equal(wetLanding(12000), null);
});

test('AFM takeoff tables: wind, speeds and limits', () => {
  const afmto = require('../engine/lib/afmto');
  const fp = require('../engine/lib/fieldperf');
  const q = { weightLb: 20200, tempC: 15, elevFt: 0 };
  const still = afmto.takeoff({ ...q, headKt: 0 });
  assert.equal(still.ft, fp.takeoff(q).ft); // zero wind agrees with the Flight Planning Guide
  assert.equal(still.flaps, 15);
  assert.ok(still.v1 <= still.vr && still.vr < still.v2);
  assert.ok(afmto.takeoff({ ...q, headKt: 10 }).ft < still.ft);
  assert.ok(afmto.takeoff({ ...q, headKt: -10 }).ft > still.ft);
  assert.equal(afmto.takeoff({ ...q, headKt: 50 }).ft, afmto.takeoff({ ...q, headKt: 30 }).ft);
  assert.equal(afmto.takeoff({ ...q, headKt: -11 }).ft, null);
  assert.equal(afmto.takeoff({ weightLb: 20200, tempC: 45, elevFt: 9000, headKt: 0 }).ft, null);
});
