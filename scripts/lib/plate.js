'use strict';
// Reads the landing-minimums block of an FAA d-TPP approach chart from `pdftotext -bbox` output.
// Each minimums row (S-ILS, S-LOC, LPV DA, LNAV/VNAV DA, LNAV MDA, CIRCLING, ...) is split into entries
// by position and each entry is assigned to the aircraft approach categories (A-D) under it.

const FRAC = { 12: 0.5, 14: 0.25, 34: 0.75, 18: 0.125, 38: 0.375, 58: 0.625, 78: 0.875 };
// RVR (ft) to statute miles, per the FAA comparable-values table.
const RVR_SM = [[1600, 0.25], [1800, 0.375], [2000, 0.375], [2400, 0.5], [3200, 0.625], [4000, 0.75], [4500, 0.875], [5000, 1], [6000, 1.25]];
const rvrToSm = (ft) => { let best = RVR_SM[0]; for (const r of RVR_SM) if (Math.abs(r[0] - ft) < Math.abs(best[0] - ft)) best = r; return best[1]; };

function words(bboxHtml) {
  const out = [];
  const re = /xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</g;
  let m;
  while ((m = re.exec(bboxHtml))) out.push({ x: +m[1], y: +m[2], x2: +m[3], y2: +m[4], h: +m[4] - +m[2], t: m[5].replace(/&amp;/g, '&') });
  return out;
}

const LABEL_RE = /^(S-|LPV|LP$|LNAV|GLS|RNP|CIRCLING|SIDESTEP|S-LDA|LDA|SDF|VOR|NDB|ILS|LOC|PAR|ASR)/;

function parsePlate(bboxHtml) {
  const W = words(bboxHtml);
  const cat = W.find((w) => w.t === 'CATEGORY');
  if (!cat) return null;
  const cols = {};
  for (const c of ['A', 'B', 'C', 'D']) {
    const w = W.find((q) => q.t === c && Math.abs(q.y - cat.y) < 3 && q.x > cat.x);
    if (w) cols[c] = (w.x + w.x2) / 2;
  }
  if (!cols.C) return null;
  const xMax = (cols.D || cols.C + 50) + 28;
  const lx = cat.x; // the block can sit on either side of the page
  const top = cat.y + 4, bottom = cat.y + 80;
  // Labels: words at the left edge of the block, grouped by line
  const left = W.filter((w) => w.x >= lx - 6 && w.y > top && w.y < bottom && w.h < 5 && (w.x < lx + 34 || (w.x < lx + 54 && !/^[\d(]/.test(w.t))));
  const lines = [];
  for (const w of left.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const ln = lines.find((l) => Math.abs(l.y - w.y) < 1.6);
    if (ln) ln.words.push(w); else lines.push({ y: w.y, words: [w] });
  }
  const rows = lines.map((l) => ({ y: l.y, label: l.words.sort((a, b) => a.x - b.x).map((w) => w.t).join(' ') })).filter((r) => LABEL_RE.test(r.label));
  if (!rows.length) return null;
  // Assign every value token in the block to the nearest label row (by vertical position)
  const vals = W.filter((w) => w.x >= lx + 34 && w.x < xMax && w.y > top && w.y < bottom && /^([\d(]|\)$|NA$)/.test(w.t));
  for (const r of rows) r.tokens = [];
  for (const v of vals) {
    const r = rows.reduce((a, b) => (Math.abs(b.y - v.y) < Math.abs(a.y - v.y) ? b : a));
    if (Math.abs(r.y - v.y) <= 7.5) r.tokens.push(v);
  }
  const out = [];
  for (const r of rows) {
    const toks = r.tokens.sort((a, b) => a.x - b.x);
    const isFrac = (w) => /^[1357][248]$/.test(w.t) && w.h >= 4.5 && FRAC[w.t] != null;
    const mains = toks.filter((w) => !isFrac(w) && (/^\d{2,5}[-/]\d*$/.test(w.t) || /^NA$/.test(w.t)));
    if (!mains.length) continue;
    const bounds = mains.map((mw, i) => [i ? (mains[i - 1].x2 + mw.x) / 2 : -Infinity, mains[i + 1] ? (mw.x2 + mains[i + 1].x) / 2 : Infinity]);
    const entries = mains.map((mw, i) => {
      const [lo, hi] = bounds[i];
      const span = toks.filter((w) => (w.x + w.x2) / 2 >= lo && (w.x + w.x2) / 2 < hi);
      const x0 = Math.min(...span.map((w) => w.x)), x1 = Math.max(...span.map((w) => w.x2));
      if (mw.t === 'NA') return { na: true, x0, x1 };
      // A visibility fraction is sometimes a separate token butted against the main value ("322-" "78")
      const glued = toks.find((w) => w !== mw && Math.abs(w.x - mw.x2) < 2.5 && Math.abs(w.y - mw.y) < 1.2 && /^\d{1,3}$/.test(w.t) && /-$/.test(mw.t));
      const m = /^(\d{2,5})([-/])(\d*)$/.exec(glued ? mw.t + glued.t : mw.t);
      // "-78" is 7/8, "-138" is 1 3/8, "-212" is 2 1/2
      let whole = m[3], inlineFrac = null;
      if (m[2] === '-' && /^[1357][248]$/.test(m[3])) { whole = ''; inlineFrac = m[3]; }
      else if (m[2] === '-' && /^\d[1357][248]$/.test(m[3])) { whole = m[3][0]; inlineFrac = m[3].slice(1); }
      const near = (w) => w.x >= mw.x2 - 5 && w.x <= mw.x2 + 10;
      let frac = toks.find((w) => isFrac(w) && near(w) && w.y <= mw.y + 1.5 && w.y >= mw.y - 3);
      if (!frac) { // fraction set as separate small numerator and denominator
        const num = toks.find((w) => /^[1357]$/.test(w.t) && w.h < 3.9 && near(w) && w.y < mw.y + 1);
        const den = num && toks.find((w) => /^[248]$/.test(w.t) && w.h < 3.9 && w.x >= num.x - 1 && w.x <= num.x + 7 && w.y > num.y + 1);
        if (num && den) frac = { t: num.t + den.t };
      }
      let vis;
      if (m[2] === '/') {
        const n = Number(m[3]);
        vis = n >= 10 ? { rvr: n * 100, sm: rvrToSm(n * 100) } : { sm: n + (frac ? FRAC[frac.t] : 0) };
      } else vis = { sm: (whole ? Number(whole) : 0) + (inlineFrac ? FRAC[inlineFrac] : frac ? FRAC[frac.t] : 0) };
      // Height above touchdown/airport: the plain number in normal-size type that follows (or sits just below) the main value
      const hatTok = span.filter((w) => w !== mw && w !== glued && w.h <= 4.7 && /^\d{3,5}$/.test(w.t) && Number(w.t) < Number(m[1])).sort((a, b) => Math.abs(a.y - mw.y) - Math.abs(b.y - mw.y) || a.x - b.x)[0];
      const hat = hatTok && Number(hatTok.t) < Number(m[1]) ? Number(hatTok.t) : null;
      return { alt: Number(m[1]), vis, hat, x0, x1 };
    });
    const cats = {};
    for (const [c, cx] of Object.entries(cols)) {
      const e = entries.length === 1 ? entries[0] : entries.reduce((a, b) => (Math.abs((b.x0 + b.x1) / 2 - cx) < Math.abs((a.x0 + a.x1) / 2 - cx) ? b : a));
      cats[c] = e.na ? { na: true } : { alt: e.alt, hat: e.hat, vis: e.vis.sm, rvr: e.vis.rvr || null };
    }
    const row = { label: r.label.replace(/[*#]+$/, '').trim(), circling: /CIRCLING/.test(r.label), cats };
    if (!out.some((o) => JSON.stringify(o) === JSON.stringify(row))) out.push(row);
  }
  return out.length ? out : null;
}

// Pull one airport's entry out of an Alternate Minimums PDF (reading-order text from `pdftotext`).
function alternateEntry(text, ids) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => ids.some((id) => id && l.includes(`(${id})`)));
  if (idx < 0) return null;
  const out = [lines[idx].replace(/[.…]{2,}/g, ' ').replace(/\s+/g, ' ').trim()];
  for (let i = idx + 1; i < Math.min(lines.length, idx + 30); i++) {
    const l = lines[i].trim();
    if (/\((?!GPS\)|RNP\)|DME\)|GLS\))[A-Z0-9]{3,4}\)/.test(l)) break;
    if (!l && /,\s[A-Z]{2}$/.test((lines[i + 1] || '').trim())) break;
    if (/^\d{2} [A-Z]{3} \d{4} to /.test(l)) continue;
    if (l) out.push(l);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

module.exports = { parsePlate, alternateEntry, rvrToSm, words };
