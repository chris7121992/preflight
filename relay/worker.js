// Cloudflare Worker: free CORS relay for the NWS/AWC weather feeds used by the briefing page.
// Only fetches allowlisted hosts, only GET, only from the allowed page origins, and caches for 60 s.
const ALLOWED_HOSTS = ['aviationweather.gov', 'tgftp.nws.noaa.gov', 'api.weather.gov'];
const ALLOWED_ORIGINS = ['https://preflight-29da3.web.app', 'https://preflight-29da3.firebaseapp.com', 'http://localhost:3000', 'http://localhost:5000'];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response('Origin not allowed', { status: 403, headers: cors });

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('url') || ''); } catch { return new Response('Bad url', { status: 400, headers: cors }); }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.includes(target.hostname)) return new Response('Host not allowed', { status: 400, headers: cors });

    const cache = caches.default;
    const key = new Request(target.toString(), { method: 'GET' });
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(target.toString(), { headers: { 'User-Agent': 'preflight-wx-briefing/1.0 (relay)', Accept: target.hostname === 'api.weather.gov' ? 'application/geo+json' : '*/*' } });
      res = new Response(up.body, { status: up.status, headers: { 'Content-Type': up.headers.get('Content-Type') || 'text/plain', 'Cache-Control': 'public, max-age=60' } });
      if (up.ok) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
