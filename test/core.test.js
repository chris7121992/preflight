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
