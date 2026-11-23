'use strict';
// Local dev server: static UI + the same /api handlers the Cloud Function uses. No dependencies (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { brief, chart } = require('./functions/handler');

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
      const r = await brief(JSON.parse((await readBody(req)) || '{}'));
      return send(res, r.status, r.json);
    }
    if (req.method === 'GET' && url.pathname === '/api/chart') {
      const r = await chart(url.searchParams.get('u'));
      if (r.json) return send(res, r.status, r.json);
      res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'max-age=300' });
      return res.end(r.body);
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
