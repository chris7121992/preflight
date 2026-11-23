'use strict';
// Spherical geometry helpers. Distances in nautical miles, angles in degrees.
const R_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function distNm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Intermediate point on the great circle, fraction f in [0,1].
function interpolate(a, b, f) {
  const d = distNm(a, b) / R_NM;
  if (d === 0) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(rad(a.lat)) * Math.cos(rad(a.lon)) + B * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon));
  const y = A * Math.cos(rad(a.lat)) * Math.sin(rad(a.lon)) + B * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon));
  const z = A * Math.sin(rad(a.lat)) + B * Math.sin(rad(b.lat));
  return { lat: deg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: deg(Math.atan2(y, x)) };
}

function routeLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += distNm(points[i - 1], points[i]);
  return d;
}

// Sample a route every `stepNm`, returning points with cumulative distance `s`.
function sampleRoute(points, stepNm = 10) {
  const out = [];
  let cum = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const seg = distNm(a, b);
    const n = Math.max(1, Math.ceil(seg / stepNm));
    for (let k = 0; k < n; k++) {
      const p = interpolate(a, b, k / n);
      out.push({ lat: p.lat, lon: p.lon, s: cum + (seg * k) / n, leg: i - 1 });
    }
    cum += seg;
  }
  const last = points[points.length - 1];
  out.push({ lat: last.lat, lon: last.lon, s: cum, leg: points.length - 2 });
  return out;
}

// Local equirectangular projection around a reference point (good to a few hundred nm).
function project(p, ref) {
  return { x: (p.lon - ref.lon) * 60 * Math.cos(rad(ref.lat)), y: (p.lat - ref.lat) * 60 };
}

function distPointToSegmentNm(p, a, b) {
  const P = project(p, p), A = project(a, p), B = project(b, p);
  const dx = B.x - A.x, dy = B.y - A.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? -(A.x * dx + A.y * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = A.x + t * dx, y = A.y + t * dy;
  return { d: Math.hypot(x - P.x, y - P.y), t };
}

function distPointToPolylineNm(p, line) {
  if (!line.length) return { d: Infinity, idx: -1 };
  if (line.length === 1) return { d: distNm(p, line[0]), idx: 0, t: 0 };
  let best = { d: Infinity, idx: -1, t: 0 };
  for (let i = 1; i < line.length; i++) {
    const r = distPointToSegmentNm(p, line[i - 1], line[i]);
    if (r.d < best.d) best = { d: r.d, idx: i - 1, t: r.t };
  }
  return best;
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lon, yi = poly[i].lat, xj = poly[j].lon, yj = poly[j].lat;
    if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Distance from a point to a polygon: 0 if inside, else distance to nearest edge.
function distPointToPolygonNm(p, poly) {
  if (poly.length >= 3 && pointInPolygon(p, poly)) return 0;
  const ring = poly.length && (poly[0].lat !== poly[poly.length - 1].lat || poly[0].lon !== poly[poly.length - 1].lon) ? [...poly, poly[0]] : poly;
  return distPointToPolylineNm(p, ring).d;
}

// Segment intersection in local projection (returns fraction along a->b or null).
function segIntersect(a, b, c, d) {
  const ref = a;
  const A = project(a, ref), B = project(b, ref), C = project(c, ref), D = project(d, ref);
  const r = { x: B.x - A.x, y: B.y - A.y }, s = { x: D.x - C.x, y: D.y - C.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((C.x - A.x) * s.y - (C.y - A.y) * s.x) / den;
  const u = ((C.x - A.x) * r.y - (C.y - A.y) * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function compass(b) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(((b % 360) + 360) % 360 / 22.5) % 16];
}

function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}

module.exports = {
  R_NM, rad, deg, distNm, bearing, interpolate, routeLength, sampleRoute, project,
  distPointToSegmentNm, distPointToPolylineNm, pointInPolygon, distPointToPolygonNm, segIntersect, compass, angleDiff,
};
