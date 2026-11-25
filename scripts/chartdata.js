'use strict';
// Builds public/nav/chart.json for the aviation-style map layer: the navaids and the jet (J) and RNAV (Q)
// airways with their coordinates, from the per-letter fix files and airways.json that procedures.js writes.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'public', 'nav');

const fixes = {};
for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
  const f = path.join(DIR, `${L}.json`);
  if (fs.existsSync(f)) Object.assign(fixes, JSON.parse(fs.readFileSync(f, 'utf8')));
}
const airways = JSON.parse(fs.readFileSync(path.join(DIR, 'airways.json'), 'utf8'));
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * Math.cos((a[0] * Math.PI) / 180)) ** 2;

const nav = [];
for (const [id, list] of Object.entries(fixes)) for (const p of list) if (p[2] === 'N' && id.length === 3) nav.push([id, r4(p[0]), r4(p[1])]);

function build(test) {
  const out = [];
  for (const [name, segs] of Object.entries(airways)) {
    if (!test(name)) continue;
    for (const seg of segs) {
      const line = [];
      let prev = null;
      for (const id of seg) {
        const c = fixes[id];
        if (!c || !c.length) continue;
        // a name used in more than one place: take the one that continues the airway
        const p = prev ? c.slice().sort((a, b) => d2(a, prev) - d2(b, prev))[0] : c[0];
        if (prev && d2(p, prev) > 64) continue; // more than about 480 nm from the last point: wrong fix
        line.push(r4(p[0]), r4(p[1]));
        prev = p;
      }
      if (line.length >= 4) out.push([name, line]);
    }
  }
  return out;
}
const high = build((n) => /^[JQ]\d/.test(n)), low = build((n) => /^[VT]\d/.test(n));
fs.writeFileSync(path.join(DIR, 'chart.json'), JSON.stringify({ built: new Date().toISOString().slice(0, 10), nav, high, low }));
console.log(`chart.json: ${nav.length} navaids, ${high.length} high and ${low.length} low airway sections, ${Math.round(fs.statSync(path.join(DIR, 'chart.json')).size / 1024)} kB`);
