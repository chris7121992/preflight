'use strict';
// Reads NOTAM text (pasted, or extracted from a ForeFlight briefing PDF) and picks out runway, taxiway and
// apron closures and restrictions so they can be drawn on an airport diagram and checked against the ETA.

// Plain-language briefings spell words out; contract them so one set of patterns covers both styles.
function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[‐-―]/g, '-')
    .replace(/\bRUNWAYS?\b/gi, 'RWY').replace(/\bTAXIWAYS?\b/gi, 'TWY').replace(/\bTAXILANES?\b/gi, 'TXL')
    .replace(/\bCLOSED\b/gi, 'CLSD').replace(/\bBETWEEN\b/gi, 'BTN').replace(/\bRWYS\b/g, 'RWY').replace(/\bTWYS\b/g, 'TWY')
    .replace(/\bUNSERVICEABLE\b|\bOUT OF SERVICE\b/gi, 'U/S');
}

// "2611250400" (YYMMDDHHMM, UTC) -> ms
function stamp(s) {
  const m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/.exec(s || '');
  if (!m) return null;
  const t = Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isFinite(t) && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 && +m[4] <= 24 ? t : null;
}

// Split a block of text into individual NOTAMs. Recognizes FAA domestic ("HOU 11/045 HOU RWY ...", with or
// without a leading "!") and ICAO series numbers ("B3887/26 NOTAMN"). Blank lines are kept as paragraph marks.
const START = /(?:^|\s)(!?[A-Z][A-Z0-9]{2,3} \d{1,2}\/\d{3,4} (?=[A-Z0-9]{3,4} )|[A-Z]\d{4}\/\d{2}(?= NOTAM[NRC]\b))/g;
function split(text) {
  const t = normalize(text).replace(/\f/g, '\n').replace(/^.*NOTAMs: Page \d+ of \d+.*$/gm, '').replace(/[ \t]+/g, ' ');
  const flat = t.replace(/\n\s*\n+/g, ' ¶ ').replace(/\n/g, ' ').replace(/ +/g, ' ');
  const cuts = [];
  let m;
  START.lastIndex = 0;
  while ((m = START.exec(flat))) cuts.push(m.index + (m[0].length - m[1].length));
  const out = [];
  if (cuts.length) {
    for (let i = 0; i < cuts.length; i++) out.push(flat.slice(cuts[i], cuts[i + 1] != null ? cuts[i + 1] : flat.length));
  } else {
    // No NOTAM numbers found: treat each line that mentions a runway/taxiway as its own item
    for (const line of t.split(/\n+/)) if (/\b(RWY|TWY|TXL|APRON|RAMP)\b/.test(line)) out.push(line);
  }
  return out.map((s) => {
    // A domestic NOTAM ends at its time group; an ICAO one at the end of its paragraph
    const tg = /\b\d{10}-(\d{10}|PERM)(EST)?\b/.exec(s);
    if (tg && !/^[A-Z]\d{4}\/\d{2} NOTAM/.test(s)) s = s.slice(0, tg.index + tg[0].length);
    else if (/ E\) /.test(s)) { const e = s.indexOf(' E) '); const para = s.indexOf('¶', e); if (para > 0) s = s.slice(0, para); }
    return s.replace(/¶/g, ' ').replace(/\s+/g, ' ').trim();
  }).filter((s) => s.length > 8);
}

const RWY_ID = '\\d{1,2}[LRC]?';
const cleanRwy = (r) => r.replace(/^0/, '');
const WORDS = new Set(['AND', 'ALL', 'BTN', 'CLSD', 'EAST', 'WEST', 'NORTH', 'SOUTH', 'OF', 'TO', 'FM', 'FROM', 'EXC', 'ADJ', 'WIP', 'THE', 'FOR', 'AT', 'IN', 'ON', 'TWY', 'RWY', 'APRON', 'RAMP', 'EDGE', 'LGT', 'CL', 'SFC', 'NE', 'NW', 'SE', 'SW', 'N', 'S', 'E', 'W', 'PARL', 'SIDE', 'INT', 'PORTION', 'PRKG', 'HLDG', 'DE-ICE', 'RUN', 'UP']);
// Taxiway designators: one or two letters, optionally with digits (A, B1, AA, K12)
const isTwyName = (w) => /^[A-Z]{1,2}\d{0,2}$/.test(w) && !WORDS.has(w);

function listAfter(text, key) {
  // names that follow "TWY" (or "TXL"): "A, B, C1 AND D" up to the first word that is not a designator
  const out = [];
  const re = new RegExp(`\\b${key} ([A-Z0-9, /&-]+)`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const toks = m[1].replace(/[,/&]/g, ' ').split(/\s+/).filter(Boolean);
    if (toks[0] === 'ALL') { out.push('ALL'); continue; }
    let first = true;
    for (const w of toks) {
      if (w === 'AND') continue;
      // the designator straight after the keyword may be a compass letter (TWY E, TWY N1)
      if (!(isTwyName(w) || (first && /^[NSEW]\d{0,2}$/.test(w)))) break;
      first = false;
      out.push(w);
    }
  }
  return [...new Set(out)];
}

// Everything else a NOTAM can say about an airport, as short notations for the diagram: which runway end or
// taxiway it belongs to, a position when the text gives one, and a code (PAPI, ALS, ILS, OBST, IAP ...).
const COORD = /(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS]) ?(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])/;
function coord(txt) {
  const m = COORD.exec(txt);
  if (!m) return null;
  const lat = (+m[1] + +m[2] / 60 + +m[3] / 3600) * (m[4] === 'S' ? -1 : 1), lon = (+m[5] + +m[6] / 60 + +m[7] / 3600) * (m[8] === 'W' ? -1 : 1);
  return { lat: +lat.toFixed(5), lon: +lon.toFixed(5) };
}
const NOTE_NAMES = {
  PAPI: 'PAPI/VASI', ALS: 'approach lights', LGT: 'runway lights', REIL: 'runway end lights', RVR: 'RVR', THR: 'threshold', DIST: 'declared distances',
  FICON: 'surface condition', MARK: 'signs or markings', WIP: 'work in progress', WIND: 'windcone', ABN: 'airport beacon', OBST: 'obstacle', UAS: 'drone activity',
  AIRSPACE: 'airspace', IAP: 'approach procedure', DEP: 'takeoff obstacle note', SID: 'departure procedure', STAR: 'arrival procedure', ODP: 'obstacle departure',
  SVC: 'service', COM: 'frequency', WX: 'weather reporting', TWR: 'tower', FUEL: 'fuel', ARFF: 'fire and rescue', AD: 'airport', 'AP CLSD': 'airport closed', NAV: 'navaid', NOTE: 'note',
};
function annotate(n, cond) {
  const notes = [];
  const push = (code, o) => notes.push({ code, name: NOTE_NAMES[code] || code.toLowerCase(), level: 'info', rwy: null, twy: null, ...o });
  const out = /U\/S|UNUSABLE|NOT AVBL|\bUNREL\b|UNMON|DECOMMISSIONED|\bNA\b|\bOTS\b/.test(cond);
  const firstRwy = () => { const m = new RegExp(`\\bRWY (${RWY_ID}(?:\\/${RWY_ID})?)`).exec(cond); return m ? m[1].split('/').map(cleanRwy).join('/') : null; };
  const sub = n.subject;
  if (sub === 'RWY') {
    const rwy = firstRwy();
    const t = cond.replace(/^RWY \S+ ?/, '');
    const hit = [
      [/\b(PAPI|VASI|PLASI|PVASI|VGSI)\b/, 'PAPI'], [/\b(ALS|ALSF-?[12]?|MALSR?|MALSF|SSALR|SSALS|SSALF|ODALS|RAIL|SFL)\b/, 'ALS'], [/\b(REIL|RTHL|RENL)\b/, 'REIL'],
      [/\bRVR[TMR]?\b/, 'RVR'], [/\b(EDGE LGT|CL LGT|TDZ LGT|RCLL|TDZL|HIRL|MIRL|LIRL|RWY LGT|LGT)\b/, 'LGT'], [/DISPLACED|\bTHR\b/, 'THR'],
      [/DECLARED DIST|\b(TORA|TODA|ASDA|LDA) \d/, 'DIST'], [/\bFICON\b|\bBA (POOR|MEDIUM|NIL|GOOD)/, 'FICON'], [/\bWIP\b|CONST/, 'WIP'], [/SIGN|MARKINGS?|\bMARKED\b/, 'MARK'],
    ].filter(([re]) => re.test(t)).map((x) => x[1]);
    // lights named in a threshold or sign NOTAM are not a lighting outage of their own
    const codes = hit.includes('PAPI') || hit.includes('ALS') || hit.includes('REIL') ? hit.filter((c) => c !== 'LGT' && c !== 'MARK') : hit;
    if (!codes.length && !/\bCLSD\b/.test(cond)) codes.push('NOTE');
    for (const code of codes) push(code, { rwy, level: (code === 'ALS' && out) || code === 'DIST' || code === 'THR' || code === 'FICON' ? 'caution' : 'info' });
  } else if (sub === 'TWY' || sub === 'TXL' || sub === 'APRON' || sub === 'RAMP') {
    const code = /\bLGT\b/.test(cond) ? 'LGT' : /SIGN|MARKINGS?|\bMARKED\b/.test(cond) ? 'MARK' : /\bWIP\b|CONST/.test(cond) ? 'WIP' : 'NOTE';
    for (const it of n.items) if (it.status === 'minor') push(code === 'LGT' ? 'LGT' : code, { name: code === 'LGT' ? 'taxiway lights' : NOTE_NAMES[code], twy: it.kind === 'TWY' ? it.name : null, apron: it.kind === 'APRON' ? it.name : null });
  } else if (sub === 'NAV') {
    const aid = (/\b(ILS|LOC|GP|GS|VORTAC|VOR\/DME|VOR|NDB|DME|TACAN|LDA)\b/.exec(cond) || [null, 'NAV'])[1];
    push(aid === 'GP' ? 'GS' : aid, { name: aid === 'NAV' ? 'navaid' : aid, rwy: firstRwy(), level: n.nav && n.nav.part === 'aid' ? 'caution' : 'info' });
  } else if (sub === 'AD') {
    if (/WIND ?CONE|WDI\b/.test(cond)) push('WIND', { rwy: firstRwy() });
    else if (/\bAP CLSD\b/.test(cond)) push('AP CLSD', { level: 'caution', partial: /CLSD (TO|EXC|FOR)\b|\bEXC\b|\bPPR\b/.test(cond) });
    else if (/\bABN\b/.test(cond)) push('ABN', {});
    else push('AD', {});
  } else if (sub === 'OBST' || sub === 'AIRSPACE') {
    const c = coord(cond), h = /(\d+(?:\.\d+)?) ?FT \((\d+(?:\.\d+)?) ?FT AGL\)/.exec(cond), rel = /\((\d+(?:\.\d+)?) ?NM ([NSEW]{1,3}) ([A-Z0-9]{3,4})\)/.exec(cond), rad = /(\d+(?:\.\d+)?) ?NM RADIUS/.exec(cond);
    const what = sub === 'OBST' ? (/^OBST ([A-Z ]+?)(?: LGT)?(?= \(| \d|$)/.exec(cond) || [null, 'OBSTACLE'])[1].trim() : (/\bUAS\b/.test(cond) ? 'UAS' : 'AIRSPACE');
    push(sub === 'OBST' ? 'OBST' : what, {
      what: what.toLowerCase(), lat: c ? c.lat : null, lon: c ? c.lon : null, ft: h ? Math.round(+h[1]) : null, agl: h ? Math.round(+h[2]) : null,
      nm: rel ? +rel[1] : null, dir: rel ? rel[2] : null, radiusNm: rad ? +rad[1] : null, unlit: sub === 'OBST' && /LGT\b.*U\/S/.test(cond),
    });
  } else if (sub === 'IAP') {
    const rw = [...new Set([...cond.matchAll(new RegExp(`\\b(?:ILS|LOC|RNAV|RNP|GPS|VOR|NDB|LDA|TACAN|DME|\\))[^.]{0,24}? RWY (${RWY_ID})`, 'g'))].map((m) => cleanRwy(m[1])))];
    const na = /\bNA\b|NOT AUTHORIZED/.test(cond);
    if (rw.length) for (const r of rw) push('IAP', { rwy: r, level: na ? 'caution' : 'info' }); else push('IAP', { level: na ? 'caution' : 'info' });
  } else if (sub === 'ODP' || sub === 'SID' || sub === 'STAR') {
    const proc = sub === 'ODP' ? null : (/\. ([A-Z]+(?: [A-Z]+)? (?:ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE) (?:DEPARTURE|ARRIVAL))/.exec(cond) || [])[1] || null;
    push(sub, { proc, level: /PROCEDURE NA\b/.test(cond) ? 'caution' : 'info' });
    if (sub === 'ODP' && /OBSTACLE NOTES/.test(cond)) {
      const part = cond.slice(cond.indexOf('OBSTACLE NOTES'));
      for (const r of new Set([...part.matchAll(new RegExp(`\\bRWY (${RWY_ID}),`, 'g'))].map((m) => cleanRwy(m[1])))) push('DEP', { rwy: r, der: true });
    }
  } else if (sub === 'SVC') {
    push(/\bWX\b|ASOS|AWOS|ATIS/.test(cond) ? 'WX' : /\b(TWR|ATCT)\b/.test(cond) ? 'TWR' : /FUEL/.test(cond) ? 'FUEL' : /ARFF/.test(cond) ? 'ARFF' : 'SVC', { level: /\b(TWR|ATCT)\b.*CLSD|ARFF/.test(cond) ? 'caution' : 'info' });
  } else if (sub === 'COM') push('COM', {});
  else if (!n.items.length) push('NOTE', {});
  return notes;
}

function parseOne(raw) {
  const n = parseBody(raw);
  try { n.notes = annotate(n, n.summary || ''); } catch (e) { n.notes = []; }
  return n;
}
function parseBody(raw) {
  const text = raw.replace(/^!/, '');
  const head = /^([A-Z][A-Z0-9]{2,3}) (\d{1,2}\/\d{3,4}) ([A-Z0-9]{3,4}) /.exec(text);
  const icao = /^([A-Z]\d{4}\/\d{2})/.exec(text);
  const n = { raw, number: head ? `${head[1]} ${head[2]}` : icao ? icao[1] : null, location: head ? head[3] : null, start: null, end: null, perm: false, items: [] };
  if (!n.location) { const a = /\bA\) ?([A-Z]{4})\b/.exec(text); if (a) n.location = a[1]; }
  // Effective times
  let tm = /\b(\d{10})-(\d{10}|PERM)(?:EST)?\b/.exec(text);
  if (tm) { n.start = stamp(tm[1]); n.end = tm[2] === 'PERM' ? null : stamp(tm[2]); n.perm = tm[2] === 'PERM'; }
  else {
    const b = /\bB\) ?(\d{10})/.exec(text), c = /\bC\) ?(\d{10}|PERM)/.exec(text);
    if (b) n.start = stamp(b[1]);
    if (c) { n.end = c[1] === 'PERM' ? null : stamp(c[1]); n.perm = c[1] === 'PERM'; }
  }
  const body = (/\bE\) ?([\s\S]*?)(?: F\) | G\) |$)/.exec(text) || [null, head ? text.slice(head[0].length) : text])[1];
  // Only the part of the body up to the time group describes the condition
  const cond = body.replace(/\b\d{10}-(\d{10}|PERM)(EST)?\b.*$/, '').trim();
  n.summary = cond;
  // The subject is the keyword that opens the text (FAA: "RWY", "TWY", "APRON", "NAV", "OBST", "AD AP" ...)
  const first = /^(RWY|TWY|TXL|APRON|RAMP|NAV|AD|OBST|AIRSPACE|SVC|COM|IAP|SID|STAR|ODP)\b/.exec(cond);
  n.subject = first ? first[1] : null;
  if (n.subject === 'NAV') {
    const r = new RegExp(`\\b(ILS|LOC|GP|GS|VOR|VORTAC|NDB|DME|TACAN|LDA)\\b.*?(?:RWY (${RWY_ID}))?`).exec(cond);
    if (/U\/S|UNUSABLE|NOT AVBL/.test(cond)) n.nav = { aid: r ? r[1] : 'NAV', rwy: (/\bRWY (\d{1,2}[LRC]?)/.exec(cond) || [])[1] ? cleanRwy((/\bRWY (\d{1,2}[LRC]?)/.exec(cond))[1]) : null, part: /\b(IM|MM|OM|DME)\b U\/S/.test(cond) && !/\b(LOC|GP|GS)\b U\/S/.test(cond) ? 'marker' : 'aid' };
    return n;
  }
  if (!first || !/^(RWY|TWY|TXL|APRON|RAMP)$/.test(first[1])) return n;
  const closed = /\bCLSD\b/.test(cond);
  const side = (txt) => {
    const k = /\b(RWY|TWY|TXL) ([A-Z0-9/]+)/.exec(txt);
    if (k) return { kind: k[1] === 'RWY' ? 'RWY' : 'TWY', name: k[1] === 'RWY' ? k[2].split('/').map(cleanRwy).join('/') : k[2], end: /APCH END|DEP END|\bTHR\b/.test(txt) };
    return isTwyName(txt.trim()) ? { kind: 'TWY', name: txt.trim() } : { kind: 'TEXT', name: txt.trim() };
  };
  const btn = /\bBTN (.+?) AND (.+?)(?= CLSD| NOT | REMOVED| MISSING| LGT| WIP| U\/S| DUE |$)/.exec(cond);
  const between = btn ? [side(btn[1]), side(btn[2])] : null;
  const atM = /\bAT (?:INT|INTERSECTION)(?: OF)? (.+?)(?= CLSD| NOT | WIP| U\/S| IRREGULAR|$)/.exec(cond);
  const at = atM ? side(atM[1]) : null;
  const partial = !!(between || at) || /CLSD (TO|EXC|FOR)\b|WINGSPAN|\bEXC\b|\bPPR\b|PORTION|\b(EAST|WEST|NORTH|SOUTH|[NSEW]{1,2}) \d+ ?FT\b/.test(cond);
  const subject = cond;
  const cutAt = [subject.indexOf(' BTN '), subject.indexOf(' AT INT')].filter((i) => i >= 0).sort((x, y) => x - y)[0];
  const lead = cutAt != null ? subject.slice(0, cutAt) : subject;
  const status = closed ? (partial ? 'restricted' : 'closed')
    : /\bWIP\b|CONST|IRREGULAR SFC|FICON|\bBA (POOR|MEDIUM|NIL)|DISPLACED|SAFETY AREA|DECLARED DIST|\b(TORA|TODA|ASDA|LDA) \d/.test(cond) ? 'affected' : 'minor';
  if (first[1] === 'RWY') {
    const re = new RegExp(`\\bRWY (${RWY_ID}(?:\\/${RWY_ID})?)`, 'g');
    const m = re.exec(lead);
    if (m) n.items.push({ kind: 'RWY', name: m[1].split('/').map(cleanRwy).join('/'), status, between, at });
  } else if (first[1] === 'TWY' || first[1] === 'TXL') {
    for (const name of listAfter(lead, first[1])) n.items.push({ kind: 'TWY', name, status, between, at });
  } else {
    const m = new RegExp(`^${first[1]} ([A-Z0-9 -]+?)(?= CLSD| BTN| WIP| DIRECTION| OBJECT| EDGE| SFC| MARKINGS| LGT|$)`).exec(lead);
    n.items.push({ kind: 'APRON', name: m ? m[1].trim() : 'ALL', status, between, at });
  }
  return n;
}

function parse(text) {
  const seen = new Set();
  return split(text).map(parseOne).filter((n) => { const k = n.raw; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Is the NOTAM in force during [t0, t1]? Unknown times count as in force.
function activeIn(n, t0, t1) {
  if (n.start != null && n.start > t1) return false;
  if (n.end != null && n.end < t0) return false;
  return true;
}

// Group NOTAMs by airport. `airports` is [{ id, ids: [all identifiers] }]; FAA NOTAMs use the 3-letter id.
function byAirport(notams, airports) {
  const out = {};
  for (const a of airports) {
    const ids = new Set();
    for (const id of a.ids.filter(Boolean)) { ids.add(id); if (/^K[A-Z]{3}$/.test(id)) ids.add(id.slice(1)); }
    out[a.id] = notams.filter((n) => n.location && ids.has(n.location));
  }
  return out;
}

const runwayEnds = (name) => String(name || '').split('/').map(cleanRwy);
const sameRunway = (a, b) => runwayEnds(a).some((x) => runwayEnds(b).includes(x));

module.exports = { parse, split, parseOne, activeIn, byAirport, sameRunway, stamp, NOTE_NAMES };
