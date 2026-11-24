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

test('Collins position relative to a low', () => {
  const { sectorOf, sideOf } = require('../engine/lib/collins');
  assert.strictEqual(sectorOf(60).key, 'ahead');   // northeast of the low
  assert.strictEqual(sectorOf(160).key, 'warm');   // south-southeast: warm sector
  assert.strictEqual(sectorOf(250).key, 'behind'); // west-southwest: low has passed
  assert.strictEqual(sectorOf(0).key, 'north');    // low passing to the south
  const line = [{ lat: 40, lon: -90 }, { lat: 40, lon: -80 }];
  assert.notStrictEqual(sideOf({ lat: 42, lon: -85 }, line), sideOf({ lat: 38, lon: -85 }, line));
});
