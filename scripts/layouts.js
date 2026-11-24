#!/usr/bin/env node
'use strict';
// Builds public/layout/<ID>.json: runway, taxiway and apron shapes for each airport that has approach
// minimums on file, from OpenStreetMap (Overpass API). The NOTAM closure guide draws these.
// Data © OpenStreetMap contributors, ODbL.
//
// Usage: node scripts/layouts.js [--only KHOU,KTEB] [--force]
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'layout');
const AIRPORTS = path.join(__dirname, '..', 'public', 'data', 'airports.json');
const MINS = path.join(__dirname, '..', 'public', 'minimums', 'index.json');
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = 'preflight-wx-briefing (airport layout build)';
const args = process.argv.slice(2);
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? new Set(args[i + 1].split(',')) : null; })();
const force = args.includes('--force');
const limit = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i + 1]) : Infinity; })();
const BATCH = 20, RADIUS = 3800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const distM = (p, q) => Math.hypot((p.lat - q.lat) * 111320, (p.lon - q.lon) * 111320 * Math.cos((p.lat * Math.PI) / 180));

async function overpass(q) {
  for (let i = 0; i < 6; i++) {
    const url = MIRRORS[i % MIRRORS.length];
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, signal: AbortSignal.timeout(120e3) });
      if (r.ok) { const j = await r.json(); if (j && Array.isArray(j.elements)) return j.elements; }
    } catch (e) { /* next mirror */ }
    await sleep(4000 * (i + 1));
  }
  return null;
}

// Compact form: { a: kind (r runway, t taxiway, l taxilane, p apron), r: ref, g: [lat, lon, lat, lon ...] }
const KIND = { runway: 'r', taxiway: 't', taxilane: 'l', apron: 'p' };
const pack = (e) => ({ a: KIND[e.tags.aeroway], r: e.tags.ref || '', g: e.geometry.flatMap((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]) });

const main = async () => {
  const list = JSON.parse(fs.readFileSync(AIRPORTS, 'utf8'));
  const ids = only ? [...only] : JSON.parse(fs.readFileSync(MINS, 'utf8')).airports;
  fs.mkdirSync(OUT, { recursive: true });
  const todo = [];
  for (const id of ids) {
    const a = list.find((x) => x.icaoId === id || x.faaId === id || (x.aliases || []).includes(id));
    if (!a || a.lat == null) continue;
    if (!force && fs.existsSync(path.join(OUT, `${id}.json`))) continue;
    todo.push({ id, lat: a.lat, lon: a.lon });
  }
  console.log(`${todo.length} airports to build`);
  // airports with no runway in OpenStreetMap are remembered so later runs do not ask again
  const skipFile = path.join(OUT, 'none.json');
  const none = new Set(fs.existsSync(skipFile) ? JSON.parse(fs.readFileSync(skipFile, 'utf8')) : []);
  const work = todo.filter((a) => force || !none.has(a.id)).slice(0, limit);
  todo.length = 0; todo.push(...work);
  let done = 0, empty = 0, failed = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const q = `[out:json][timeout:90];(${batch.map((a) => `way["aeroway"~"^(runway|taxiway|taxilane|apron)$"](around:${RADIUS},${a.lat},${a.lon});`).join('')});out tags geom;`;
    const els = await overpass(q);
    if (!els) { failed += batch.length; console.warn(`batch at ${i} failed`); continue; }
    const ways = els.filter((e) => e.geometry && e.geometry.length > 1 && e.tags && KIND[e.tags.aeroway] && e.tags.runway !== 'displaced_threshold');
    for (const a of batch) {
      const mine = ways.filter((e) => distM(e.geometry[Math.floor(e.geometry.length / 2)], a) < RADIUS + 700).map(pack);
      if (!mine.some((w) => w.a === 'r')) { empty++; none.add(a.id); continue; }
      fs.writeFileSync(path.join(OUT, `${a.id}.json`), JSON.stringify({ id: a.id, builtAt: new Date().toISOString().slice(0, 10), ways: mine }));
      done++;
    }
    if ((i / BATCH) % 10 === 0) console.log(`${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    await sleep(2500);
  }
  fs.writeFileSync(skipFile, JSON.stringify([...none].sort()));
  const have = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'none.json').map((f) => f.slice(0, -5)).sort();
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ builtAt: new Date().toISOString(), airports: have }));
  console.log(`REMAINING ${Math.max(0, work.length - done - empty)}`);
  console.log(`Wrote ${done} layouts (${empty} without runways in OpenStreetMap, ${failed} failed); ${have.length} on file`);
};
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
