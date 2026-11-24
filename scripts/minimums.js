#!/usr/bin/env node
'use strict';
// Builds public/minimums/<ID>.json: published landing minimums (DA/MDA, HAT/HAA, visibility per category)
// for every instrument approach at airports an XLS+ can use (hard runway >= 4,000 ft), read from the FAA
// d-TPP approach charts for the current 28-day cycle, plus each airport's entry in the FAA Alternate
// Minimums pages (nonstandard or NA alternate minimums). Needs `pdftotext` (poppler-utils).
//
// Usage: node scripts/minimums.js [--only KDJT,KFLL] [--force]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { parsePlate, alternateEntry } = require('./lib/plate');

const OUT = path.join(__dirname, '..', 'public', 'minimums');
const AIRPORTS = path.join(__dirname, '..', 'public', 'data', 'airports.json');
const UA = 'preflight-wx-briefing (github.com/chris7121992/preflight)';
const args = process.argv.slice(2);
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? new Set(args[i + 1].split(',')) : null; })();
const force = args.includes('--force');

// d-TPP cycles are 28 days; 2611 became effective 2026-10-29.
function cycleFor(now = new Date()) {
  const base = Date.UTC(2026, 9, 29, 9, 1);
  const n = Math.floor((now - base) / (28 * 864e5));
  const eff = new Date(base + n * 28 * 864e5);
  let first = eff.getTime(), idx = 1;
  while (new Date(first - 28 * 864e5).getUTCFullYear() === eff.getUTCFullYear()) { first -= 28 * 864e5; idx++; }
  return `${String(eff.getUTCFullYear()).slice(2)}${String(idx).padStart(2, '0')}`;
}

async function fetchBuf(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
}
const pdftotext = (file, extra) => new Promise((res, rej) => execFile('pdftotext', [...extra, file, '-'], { maxBuffer: 64e6 }, (e, out) => (e ? rej(e) : res(out))));

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

function usableAirports() {
  const list = JSON.parse(fs.readFileSync(AIRPORTS, 'utf8'));
  const ok = new Map();
  for (const a of list) {
    const hard = (a.runways || []).some((r) => {
      const len = Number(String(r.dimension || '').split('x')[0]);
      return len >= 4000 && /ASP|CON|PEM|BIT|TAR|PAV|^A$|^C$|^H$/i.test(String(r.surface || ''));
    });
    if (!hard) continue;
    for (const id of [a.icaoId, a.faaId, ...(a.aliases || [])]) if (id) ok.set(id, a);
  }
  return ok;
}

const main = async () => {
  const cycle = cycleFor();
  const idxFile = path.join(OUT, 'index.json');
  const prev = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : null;
  if (prev && prev.cycle === cycle && !force && !only) { console.log(`Minimums already built for cycle ${cycle}`); return; }
  const meta = await fetchBuf(`https://aeronav.faa.gov/d-tpp/${cycle}/xml_data/d-tpp_Metafile.xml`);
  if (!meta) throw new Error(`No d-TPP metafile for cycle ${cycle}`);
  const xml = meta.toString('utf8');
  fs.mkdirSync(OUT, { recursive: true });
  const usable = usableAirports();

  // Parse the metafile (simple regex walk; the file is regular)
  const airports = [];
  const aptRe = /<airport_name ID="([^"]*)" military="([^"]*)" apt_ident="([^"]*)" icao_ident="([^"]*)"[^>]*>([\s\S]*?)<\/airport_name>/g;
  let m;
  while ((m = aptRe.exec(xml))) {
    const [, name, , faa, icao, body] = m;
    const recs = [...body.matchAll(/<chart_code>([^<]*)<\/chart_code>\s*<chart_name>([^<]*)<\/chart_name>[\s\S]*?<pdf_name>([^<]*)<\/pdf_name>/g)].map((r) => ({ code: r[1], name: r[2].replace(/&amp;/g, '&'), pdf: r[3] }));
    // Standard civil approaches only: skip helicopter, CAT II/III and special-authorization CAT I/II, charted visuals, PRM pages
    const iaps = recs.filter((r) => r.code === 'IAP' && !/COPTER|CONT\.\d*$|, CONT|CAT II|CAT III|SA CAT|VISUAL|AAUP|HI-TACAN|HI-VOR|HI-ILS/.test(r.name));
    if (!iaps.length) continue;
    const id = icao || faa;
    if (only ? !(only.has(icao) || only.has(faa)) : !(usable.has(icao) || usable.has(faa))) continue;
    const alt = recs.find((r) => r.code === 'MIN' && /ALTERNATE/.test(r.name));
    airports.push({ id, icao, faa, name, iaps, altPdf: alt ? alt.pdf : null });
  }
  console.log(`Cycle ${cycle}: ${airports.length} airports, ${airports.reduce((a, b) => a + b.iaps.length, 0)} approach charts`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpp-'));
  // Alternate minimums pages: one PDF per region, shared by many airports
  const altText = new Map();
  for (const pdf of new Set(airports.map((a) => a.altPdf).filter(Boolean))) {
    try {
      const buf = await fetchBuf(`https://aeronav.faa.gov/d-tpp/${cycle}/${pdf}`);
      if (!buf) continue;
      const f = path.join(tmp, pdf); fs.writeFileSync(f, buf);
      altText.set(pdf, await pdftotext(f, []));
      fs.unlinkSync(f);
    } catch (e) { console.warn('alt', pdf, e.message); }
  }

  let done = 0, failed = 0;
  const written = [];
  await pool(airports, 6, async (a) => {
    const procs = [];
    for (const p of a.iaps) {
      try {
        const buf = await fetchBuf(`https://aeronav.faa.gov/d-tpp/${cycle}/${p.pdf}`);
        if (!buf) continue;
        const f = path.join(tmp, `${a.id}-${p.pdf}`); fs.writeFileSync(f, buf);
        const html = await pdftotext(f, ['-bbox', '-f', '1', '-l', '1']);
        fs.unlinkSync(f);
        const rows = parsePlate(html);
        const rwy = (/RWY\s+([0-9]{1,2}[LRC]?)/.exec(p.name) || [])[1] || null;
        procs.push({ name: p.name, pdf: p.pdf, rwy, rows: rows || [], parsed: !!rows });
      } catch (e) { failed++; }
    }
    const altEntry = a.altPdf && altText.has(a.altPdf) ? alternateEntry(altText.get(a.altPdf), [a.faa, a.icao].filter(Boolean)) : null;
    const rec = { id: a.id, icao: a.icao || null, faa: a.faa, name: a.name, cycle, procedures: procs, alternateMinimums: altEntry, chartBase: `https://aeronav.faa.gov/d-tpp/${cycle}/` };
    const json = JSON.stringify(rec);
    fs.writeFileSync(path.join(OUT, `${a.id}.json`), json);
    written.push(a.id);
    if (++done % 100 === 0) console.log(`${done}/${airports.length}`);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!only) for (const f of fs.readdirSync(OUT)) if (f !== 'index.json' && f.endsWith('.json') && !written.includes(f.slice(0, -5))) fs.unlinkSync(path.join(OUT, f));
  if (!only) fs.writeFileSync(idxFile, JSON.stringify({ cycle, builtAt: new Date().toISOString(), airports: written.sort(), failedCharts: failed }));
  console.log(`Wrote ${written.length} airports (${failed} charts failed)`);
};
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { cycleFor };
