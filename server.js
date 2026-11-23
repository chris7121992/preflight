'use strict';
// Preflight weather briefing server: static UI + /api/brief. No dependencies (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseFlightPlan } = require('./lib/parse');
const { buildBriefing } = require('./lib/brief');

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.fpl': 'application/xml', '.json': 'application/json' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Upload too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/brief') {
      const body = JSON.parse(await readBody(req) || '{}');
      const text = body.fileText || body.routeText || '';
      let plan;
      try {
        plan = parseFlightPlan(text, body.filename || '');
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      if (body.alternate == null && plan.waypoints.length) body.alternate = '';
      const brief = await buildBriefing(plan, body);
      return send(res, 200, brief);
    }
    if (req.method === 'GET' && url.pathname === '/api/chart') {
      // Proxy chart images from a fixed allowlist of NWS hosts
      const u = new URL(url.searchParams.get('u') || '');
      if (!['www.wpc.ncep.noaa.gov', 'aviationweather.gov'].includes(u.hostname) || u.protocol !== 'https:') return send(res, 400, { error: 'Host not allowed' });
      const r = await fetch(u, { headers: { 'User-Agent': 'preflight-wx-briefing/1.0' } });
      if (!r.ok) return send(res, 502, { error: `Upstream ${r.status}` });
      res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'image/gif', 'Cache-Control': 'max-age=300' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUB, p));
    if (!file.startsWith(PUB)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Not found' });
      send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e) });
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`Preflight weather briefing running at http://localhost:${PORT}`));
module.exports = server;
