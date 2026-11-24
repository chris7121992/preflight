'use strict';
// Flight plan parsers: Garmin/ForeFlight .fpl (XML), KML, GPX, and plain route strings.
// Returns { name, waypoints: [{id, type, lat, lon, alt?}], cruiseAlt?, source }

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
  return m ? decode(m[1]) : null;
}
function tags(xml, name) {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push({ inner: m[1], full: m[0] });
  return out;
}
function attr(fragment, name) {
  const m = fragment.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1] : null;
}

function parseFpl(xml) {
  const table = new Map();
  for (const w of tags(xml, 'waypoint')) {
    const id = tag(w.inner, 'identifier');
    const lat = parseFloat(tag(w.inner, 'lat'));
    const lon = parseFloat(tag(w.inner, 'lon'));
    if (!id || !isFinite(lat) || !isFinite(lon)) continue;
    table.set(id.toUpperCase() + '|' + (tag(w.inner, 'type') || '').toUpperCase(), { id: id.toUpperCase(), type: (tag(w.inner, 'type') || 'WAYPOINT').toUpperCase(), lat, lon });
    if (!table.has(id.toUpperCase())) table.set(id.toUpperCase(), table.get(id.toUpperCase() + '|' + (tag(w.inner, 'type') || '').toUpperCase()));
  }
  const route = tag(xml, 'route');
  const waypoints = [];
  if (route) {
    for (const rp of tags(route, 'route-point')) {
      const id = (tag(rp.inner, 'waypoint-identifier') || '').toUpperCase();
      const type = (tag(rp.inner, 'waypoint-type') || '').toUpperCase();
      const wp = table.get(id + '|' + type) || table.get(id);
      if (wp) waypoints.push({ ...wp });
    }
  }
  if (!waypoints.length) for (const [k, v] of table) if (!k.includes('|')) waypoints.push({ ...v });
  return { name: (route && tag(route, 'route-name')) || null, waypoints, source: 'fpl' };
}

function parseKml(xml) {
  const waypoints = [];
  let line = null;
  for (const pm of tags(xml, 'Placemark')) {
    const name = tag(pm.inner, 'name');
    const point = tag(pm.inner, 'Point');
    const ls = tag(pm.inner, 'LineString');
    if (point) {
      const c = (tag(point, 'coordinates') || '').split(',').map(Number);
      if (isFinite(c[0]) && isFinite(c[1])) waypoints.push({ id: (name || `WP${waypoints.length + 1}`).toUpperCase().replace(/\s+/g, ''), type: 'WAYPOINT', lat: c[1], lon: c[0], alt: isFinite(c[2]) ? c[2] : undefined });
    } else if (ls && !line) {
      line = (tag(ls, 'coordinates') || '').trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((c) => isFinite(c[0]) && isFinite(c[1]))
        .map((c, i) => ({ id: `PT${i + 1}`, type: 'POINT', lat: c[1], lon: c[0], alt: isFinite(c[2]) ? c[2] : undefined }));
    }
  }
  // Prefer named points; fall back to the line track. If both, keep named points (they are the plan's fixes).
  const pts = waypoints.length >= 2 ? waypoints : line || waypoints;
  const alts = pts.map((p) => p.alt).filter((a) => a > 0);
  const maxAltM = alts.length ? Math.max(...alts) : null;
  return { name: tag(xml, 'name'), waypoints: pts, cruiseAlt: maxAltM ? Math.round((maxAltM * 3.28084) / 100) * 100 : undefined, source: 'kml' };
}

function parseGpx(xml) {
  let pts = tags(xml, 'rtept');
  if (!pts.length) pts = tags(xml, 'trkpt');
  if (!pts.length) pts = tags(xml, 'wpt');
  const waypoints = pts.map((p, i) => {
    const open = p.full.slice(0, p.full.indexOf('>') + 1);
    const ele = parseFloat(tag(p.inner, 'ele'));
    return { id: (tag(p.inner, 'name') || `WP${i + 1}`).toUpperCase(), type: 'WAYPOINT', lat: parseFloat(attr(open, 'lat')), lon: parseFloat(attr(open, 'lon')), alt: isFinite(ele) ? ele : undefined };
  }).filter((w) => isFinite(w.lat) && isFinite(w.lon));
  return { name: tag(xml, 'name'), waypoints, source: 'gpx' };
}

// Route string like "KTEB SBJ J48 ... KPBI" or "KTEB DCT KPBI". Coordinates resolved later.
function parseRouteString(text) {
  const tokens = String(text).toUpperCase().replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean);
  const ids = [], procs = [], airways = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t === 'DCT') continue;
    // airways (J22, V16, Q97, UJ20) are kept aside with their place in the route; the two ends are airports
    if (/^[A-Z]{1,2}\d{1,4}[A-Z]?$/.test(t) && k > 0 && k < tokens.length - 1) { airways.push({ token: t, at: ids.length }); continue; }
    // SIDs and STARs (RUUDY6, PTRON9.PSX, STOOP.STOOP4) are kept aside with their place in the route
    if (/^[A-Z]{3,6}\d[A-Z]?(\.[A-Z0-9]+)?$/.test(t) || /^[A-Z0-9]{2,5}\.[A-Z]{3,6}\d[A-Z]?$/.test(t)) { procs.push({ token: t, at: ids.length }); continue; }
    if (/\//.test(t)) continue; // speed/altitude groups
    if (/^[A-Z0-9]{2,5}$/.test(t)) ids.push(t);
  }
  return { name: null, waypoints: ids.map((id) => ({ id, type: 'UNRESOLVED' })), procedures: procs, airways, source: 'route' };
}

function parseFlightPlan(text, filename = '') {
  const t = String(text || '').replace(/^﻿/, '');
  const fn = filename.toLowerCase();
  let r;
  if (fn.endsWith('.kml') || /<kml[\s>]/i.test(t)) r = parseKml(t);
  else if (fn.endsWith('.gpx') || /<gpx[\s>]/i.test(t)) r = parseGpx(t);
  else if (fn.endsWith('.fpl') || /<flight-plan[\s>]/i.test(t)) r = parseFpl(t);
  else if (!/</.test(t)) r = parseRouteString(t);
  else throw new Error('Unrecognized flight plan format. Export from ForeFlight as .fpl (Garmin), .kml or .gpx.');
  // Drop consecutive duplicates
  r.waypoints = r.waypoints.filter((w, i, a) => i === 0 || w.id !== a[i - 1].id || w.lat !== a[i - 1].lat);
  if (r.waypoints.length < 2) throw new Error('Flight plan needs at least a departure and a destination.');
  return r;
}

module.exports = { parseFlightPlan, parseFpl, parseKml, parseGpx, parseRouteString };
