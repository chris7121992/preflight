'use strict';
// Firebase Cloud Function (2nd gen) serving the briefing API behind Firebase Hosting rewrites:
//   /api/brief  (POST)  -> builds the briefing
//   /api/chart  (GET)   -> proxies NWS chart images
//   /api/health (GET)
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { brief, chart } = require('./handler');

setGlobalOptions({ region: process.env.FUNCTION_REGION || 'us-central1', maxInstances: 10 });

exports.api = onRequest({ timeoutSeconds: 120, memory: '512MiB', cors: false }, async (req, res) => {
  const path = req.path.replace(/^\/api/, '') || '/';
  try {
    if (req.method === 'POST' && path === '/brief') {
      const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.rawBody ? req.rawBody.toString('utf8') : '{}');
      const r = await brief(body);
      res.set('Cache-Control', 'no-store');
      return res.status(r.status).json(r.json);
    }
    if (req.method === 'GET' && path === '/chart') {
      const r = await chart(req.query.u);
      if (r.json) return res.status(r.status).json(r.json);
      res.set('Content-Type', r.type).set('Cache-Control', 'public, max-age=300');
      return res.status(200).send(r.body);
    }
    if (req.method === 'GET' && path === '/health') return res.json({ ok: true });
    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});
