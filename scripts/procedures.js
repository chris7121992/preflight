#!/usr/bin/env node
'use strict';
// Builds public/procedures/<FAA id>.json: the SIDs and STARs serving each airport, with the fixes of every
// runway body and en-route transition, from the FAA NASR 28-day subscription CSV files (DP, STAR, FIX, NAV).
// Needs `unzip`.
//
// Usage: node scripts/procedures.js [--force]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { cycleFor } = require('./minimums');

const OUT = path.join(__dirname, '..', 'public', 'procedures');
const UA = 'preflight-wx-briefing (github.com/chris7121992/preflight)';
const force = process.argv.includes('--force');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// NASR cycles share the 28-day AIRAC dates with the d-TPP (2026-10-29 is one).
function effectiveDate(now = new Date()) {
  const base = Date.UTC(2026, 9, 29, 9, 1);
  return new Date(base + Math.floor((now - base) / (28 * 864e5)) * 28 * 864e5);
}

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length >= head.length - 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

async function csvFrom(tmp, eff, kind, file) {
  const name = `${String(eff.getUTCDate()).padStart(2, '0')}_${MON[eff.getUTCMonth()]}_${eff.getUTCFullYear()}_${kind}_CSV.zip`;
  const zip = path.join(tmp, name);
  if (!fs.existsSync(zip)) {
    const r = await fetch(`https://nfdc.faa.gov/webContent/28DaySub/extra/${name}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`${r.status} ${name}`);
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  }
  return parseCsv(execFileSync('unzip', ['-p', zip, file], { maxBuffer: 256e6 }).toString('latin1'));
}

const main = async () => {
  const eff = effectiveDate(), cycle = cycleFor();
  const idxFile = path.join(OUT, 'index.json');
  const prev = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : null;
  if (prev && prev.cycle === cycle && !force) { console.log(`Procedures already built for cycle ${cycle}`); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nasr-'));
  const [fix, nav, dpBase, dpRte, dpApt, stBase, stRte, stApt] = await Promise.all([
    csvFrom(tmp, eff, 'FIX', 'FIX_BASE.csv'), csvFrom(tmp, eff, 'NAV', 'NAV_BASE.csv'),
    csvFrom(tmp, eff, 'DP', 'DP_BASE.csv'), csvFrom(tmp, eff, 'DP', 'DP_RTE.csv'), csvFrom(tmp, eff, 'DP', 'DP_APT.csv'),
    csvFrom(tmp, eff, 'STAR', 'STAR_BASE.csv'), csvFrom(tmp, eff, 'STAR', 'STAR_RTE.csv'), csvFrom(tmp, eff, 'STAR', 'STAR_APT.csv'),
  ]);
  const pos = new Map();
  for (const n of nav) if (n.LAT_DECIMAL && !/DECOMMISSIONED|SHUTDOWN/i.test(n.NAV_STATUS || '')) pos.set(n.NAV_ID, [+(+n.LAT_DECIMAL).toFixed(5), +(+n.LONG_DECIMAL).toFixed(5)]);
  for (const f of fix) if (f.LAT_DECIMAL) pos.set(f.FIX_ID, [+(+f.LAT_DECIMAL).toFixed(5), +(+f.LONG_DECIMAL).toFixed(5)]);

  const byAirport = new Map();
  const slot = (id) => { if (!byAirport.has(id)) byAirport.set(id, { sids: [], stars: [] }); return byAirport.get(id); };
  function build(base, rte, apt, codeKey, nameKey, kind) {
    const rteBy = new Map(), aptBy = new Map();
    for (const r of rte) { if (!rteBy.has(r[codeKey])) rteBy.set(r[codeKey], []); rteBy.get(r[codeKey]).push(r); }
    for (const a of apt) { if (!aptBy.has(a[codeKey])) aptBy.set(a[codeKey], []); aptBy.get(a[codeKey]).push(a); }
    for (const b of base) {
      const code = b[codeKey];
      if (kind === 'sids' && b.GRAPHICAL_DP_TYPE && b.GRAPHICAL_DP_TYPE !== 'SID') continue; // obstacle DPs are not filed
      const groups = new Map();
      for (const r of rteBy.get(code) || []) {
        const k = `${r.ROUTE_PORTION_TYPE}|${r.ROUTE_NAME}|${r.BODY_SEQ}|${r.TRANSITION_COMPUTER_CODE}`;
        if (!groups.has(k)) groups.set(k, { type: r.ROUTE_PORTION_TYPE, name: r.ROUTE_NAME, code: r.TRANSITION_COMPUTER_CODE, rows: [] });
        groups.get(k).rows.push(r);
      }
      const legs = [...groups.values()].map((g) => ({
        type: g.type, name: g.name, code: g.code,
        // POINT_SEQ runs against the direction of flight in these files; the name ("A-B") gives the real order
        pts: g.rows.sort((x, y) => Number(x.POINT_SEQ) - Number(y.POINT_SEQ)).map((r) => (pos.has(r.POINT) ? [r.POINT, ...pos.get(r.POINT)] : null)).filter(Boolean),
      })).filter((l) => l.pts.length);
      for (const l of legs) {
        const first = (/^([A-Z0-9]+)-/.exec(l.name) || [])[1];
        if (first && l.pts[l.pts.length - 1][0] === first && l.pts[0][0] !== first) l.pts.reverse();
      }
      const airports = [...new Set((aptBy.get(code) || []).map((a) => a.ARPT_ID))];
      for (const id of airports) {
        const mine = (aptBy.get(code) || []).filter((a) => a.ARPT_ID === id);
        const bodies = legs.filter((l) => l.type === 'BODY').map((l) => ({ name: l.name, rwys: [...new Set(mine.filter((a) => a.BODY_NAME === l.name).map((a) => a.RWY_END_ID))], pts: l.pts })).filter((l) => l.rwys.length);
        if (!bodies.length) continue;
        slot(id)[kind].push({ code, name: b[nameKey], rnav: b.RNAV_FLAG === 'Y', bodies, transitions: legs.filter((l) => l.type === 'TRANSITION').map((l) => ({ code: l.code, name: l.name.replace(/ TRANSITION$/, ''), pts: l.pts })) });
      }
    }
  }
  build(dpBase, dpRte, dpApt, 'DP_COMPUTER_CODE', 'DP_NAME', 'sids');
  build(stBase, stRte, stApt, 'STAR_COMPUTER_CODE', 'ARRIVAL_NAME', 'stars');

  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.json')) fs.unlinkSync(path.join(OUT, f));
  for (const [id, v] of byAirport) fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify({ id, cycle, ...v }));
  fs.writeFileSync(idxFile, JSON.stringify({ cycle, builtAt: new Date().toISOString(), airports: [...byAirport.keys()].sort() }));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`Cycle ${cycle}: procedures for ${byAirport.size} airports`);
};
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
