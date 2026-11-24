'use strict';
// Picks the published approach minimums that the alternate rules need, from the FAA d-TPP data built by
// scripts/minimums.js. All values are for one aircraft approach category.

const normRwy = (r) => String(r || '').toUpperCase().replace(/^0+/, '');
const isRnav = (p) => /RNAV|GPS|RNP/.test(p.name);
const sane = (x) => x && !x.na && x.hat != null && x.hat >= 100 && x.hat <= 4000 && x.vis >= 0.25 && x.vis <= 5;

function options(rec, cat) {
  const straight = [], circling = [];
  let circlingNaCount = 0;
  for (const p of rec.procedures || []) {
    for (const r of p.rows || []) {
      const x = r.cats && r.cats[cat];
      if (!x) continue;
      if (r.circling && x.na) { circlingNaCount++; continue; }
      if (!sane(x)) continue;
      const o = { proc: p.name, pdf: p.pdf, rwy: normRwy(p.rwy), line: r.label, alt: x.alt, hat: x.hat, vis: x.vis, rnav: isRnav(p), vertical: /LPV|VNAV|S-ILS|GLS|RNP/.test(r.label) };
      (r.circling ? circling : straight).push(o);
    }
  }
  straight.sort((a, b) => a.hat - b.hat || a.vis - b.vis);
  circling.sort((a, b) => a.hat - b.hat || a.vis - b.vis);
  return { straight, circling, circlingNaCount };
}

// 135.223(b): what the destination forecast must meet for no alternate to be required.
function destinationTest(rec, { cat = 'C', runway = null } = {}) {
  if (!rec) return null;
  const { straight, circling } = options(rec, cat);
  if (!straight.length && !circling.length) return null;
  const rw = runway ? String(runway).split('/').map(normRwy) : [];
  const forRwy = straight.filter((o) => rw.includes(o.rwy));
  const toUse = (forRwy.length ? forRwy : straight)[0] || circling[0];
  const lowestCirc = circling[0] || null;
  let ceilNeed, basis;
  if (lowestCirc) {
    ceilNeed = lowestCirc.hat + 1500;
    basis = `1,500 ft above the lowest Cat ${cat} circling MDA: ${lowestCirc.alt} ft MSL, HAA ${lowestCirc.hat} ft (${lowestCirc.proc})`;
  } else {
    const lowest = straight[0];
    ceilNeed = Math.max(lowest.hat + 1500, 2000);
    basis = `no circling minimums published, so the higher of 1,500 ft above the lowest published minimum (HAT ${lowest.hat} ft, ${lowest.proc} ${lowest.line}) and 2,000 ft`;
  }
  const visNeed = Math.max(3, toUse.vis + 2);
  return {
    ceilNeed, visNeed, basis,
    visBasis: `3 SM, or 2 SM more than ${toUse.vis} SM on the ${toUse.proc} (${toUse.line}${forRwy.length ? `, the approach to the runway favored by the wind` : ''}), whichever is greater`,
    approach: toUse, circling: lowestCirc, source: `FAA d-TPP cycle ${rec.cycle}`,
  };
}

// Parse the FAA Alternate Minimums entry for nonstandard minimums or NA for one category.
function publishedAlternate(text, cat) {
  if (!text) return null;
  const fr = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
  let worst = null;
  const re = /Cats?\.?\s+([A-D](?:\s*(?:,|and|&)\s*[A-D])*)\s+(\d{3,4})-(\d*)([¼½¾⅛⅜⅝⅞]?)/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[1].includes(cat)) continue;
    const ceil = Number(m[2]), vis = (m[3] ? Number(m[3]) : 0) + (fr[m[4]] || 0);
    if (!worst || ceil > worst.ceil || vis > worst.vis) worst = { ceil: Math.max(ceil, worst ? worst.ceil : 0), vis: Math.max(vis, worst ? worst.vis : 0) };
  }
  return { nonstandard: worst, na: /\bNA\b/.test(text), text };
}

// Alternate weather minimums under OpSpec C055 (Part 135) from the published approaches.
function alternateMinimums(rec, { cat = 'C', runway = null, gps = false, facilities = null, applyPublished = false } = {}) {
  if (!rec) return null;
  const { straight, circling } = options(rec, cat);
  // Without WAAS approval for alternate planning, base it on non-GPS approaches. With it, LNAV or circling only.
  const elig = (o) => (!o.rnav ? true : gps && !o.vertical);
  const s = straight.filter(elig), c = circling.filter(elig);
  if (!s.length && !c.length) return { none: true, reason: gps ? 'No usable approach minimums were found for this category.' : 'Only GPS approaches are published here, and alternate planning on GPS needs WAAS/operator approval (enable it in the form if you have it).', source: `FAA d-TPP cycle ${rec.cycle}` };
  const rw = runway ? String(runway).split('/').map(normRwy) : [];
  const primary = s.find((o) => rw.includes(o.rwy)) || s[0] || c[0];
  // Two facilities: straight-in approaches to two different runways (different physical runways, not opposite ends)
  const runwayKey = (r) => { const n = Number(String(r).replace(/[LRC]/g, '')); return isFinite(n) ? `${Math.min(n, ((n + 17) % 36) + 1)}${String(r).replace(/\d/g, '').replace('L', 'X').replace('R', 'Y')}` : r; };
  const byRunway = new Map();
  for (const o of s) { const k = runwayKey(o.rwy); if (!byRunway.has(k)) byRunway.set(k, o); }
  const two = [...byRunway.values()].filter((o) => !o.rnav).slice(0, 2);
  let res;
  if (two.length === 2 && facilities !== 1) {
    const hi = two[0].hat >= two[1].hat ? two[0] : two[1];
    const hiVis = Math.max(two[0].vis, two[1].vis);
    res = { facilities: 2, ceil: Math.ceil((hi.hat + 200) / 100) * 100, vis: hiVis + 0.5, basis: `two navigation facilities to different runways (${two.map((o) => `${o.proc} ${o.line} ${o.hat} ft/${o.vis} SM`).join(' and ')}): +200 ft and +½ SM to the higher` };
  } else {
    res = { facilities: 1, ceil: Math.ceil((primary.hat + 400) / 100) * 100, vis: primary.vis + 1, basis: `one navigation facility (${primary.proc} ${primary.line}, ${primary.hat} ft / ${primary.vis} SM): +400 ft and +1 SM` };
  }
  const pub = publishedAlternate(rec.alternateMinimums, cat);
  // The FAA's nonstandard alternate minimums replace 600-2/800-2 for Part 91. C055 derives its own, so they are
  // only applied on request; the entry text (including any NA) is always returned for the pilot to read.
  if (applyPublished && pub && pub.nonstandard && (pub.nonstandard.ceil > res.ceil || pub.nonstandard.vis > res.vis)) {
    res.ceil = Math.max(res.ceil, pub.nonstandard.ceil); res.vis = Math.max(res.vis, pub.nonstandard.vis);
    res.basis += `; raised to the FAA nonstandard alternate minimums for Cat ${cat} (${pub.nonstandard.ceil}-${pub.nonstandard.vis})`;
  }
  res.published = pub ? pub.text : null;
  res.publishedNa = pub ? pub.na : false;
  res.approach = primary;
  res.source = `FAA d-TPP cycle ${rec.cycle}`;
  return res;
}

module.exports = { destinationTest, alternateMinimums, publishedAlternate, options };
