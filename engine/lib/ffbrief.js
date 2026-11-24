'use strict';
// Reads the flight details out of the text of a ForeFlight briefing PDF: departure, destination, ETD, cruise
// level, true airspeed, alternate, the filed route string and the waypoints of the navigation log.

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const AIRWAY = /^(DCT|[A-Z]{1,2}\d{1,4}[A-Z]?|[A-Z]{3,6}\d[A-Z]?)$/;

function parseBriefing(text) {
  const lines = String(text || '').split(/\n/).map((l) => l.replace(/[ \t]+/g, ' ').trim());
  const out = { dep: null, dest: null, alternate: null, etd: null, cruiseAlt: null, tas: null, callsign: null, tail: null, type: null, rules: null, filedRoute: null, waypoints: [] };
  // "KHOU — MMSL (Nov 24, 2026) in N123AB as ABC123 (C56X - 560 Citation XLS+ GEN 2) IFR"
  const head = lines.map((l) => /^([A-Z0-9]{3,4}) [—–-] ([A-Z0-9]{3,4}) \(([A-Za-z]{3}) (\d{1,2}), (\d{4})\)(?: in (\S+))?(?: as (\S+))?(?: \(([A-Z0-9]{2,4})\b[^)]*\))?(?: (IFR|VFR))?/.exec(l)).find(Boolean);
  if (!head) return null;
  out.dep = head[1]; out.dest = head[2]; out.tail = head[6] || null; out.callsign = head[7] || null; out.type = head[8] || null; out.rules = head[9] || null;
  const date = { y: +head[5], m: MONTHS[head[3].toUpperCase()], d: +head[4] };
  const fl = lines.map((l) => /@ ?FL(\d{3})\b/.exec(l)).find(Boolean);
  if (fl) out.cruiseAlt = +fl[1] * 100;
  // ETD: "16:45 CST / 2245Z". The date in the heading is the local date of departure.
  const etd = lines.map((l) => /\b(\d{1,2}):(\d{2}) [A-Za-z ]{2,40}? ?\/ ?(\d{2})(\d{2})Z\b/.exec(l)).find(Boolean);
  if (etd && date.m != null) {
    let t = Date.UTC(date.y, date.m, date.d, +etd[3], +etd[4]);
    const diff = +etd[3] - +etd[1]; // UTC hour minus local hour
    if (diff < -12) t += 864e5; else if (diff > 12) t -= 864e5; // local date and UTC date differ
    else if (diff < 0 && diff > -12 && +etd[1] >= 12 && +etd[3] < 12) t += 864e5;
    out.etd = new Date(t).toISOString();
  }
  // Filed route: the line under the "Route" heading of the summary
  const ri = lines.findIndex((l) => /^Route\b/.test(l) && !/^Routes\b/.test(l));
  if (ri >= 0) for (let i = ri + 1; i < Math.min(lines.length, ri + 4); i++) {
    const l = lines[i].replace(/[✓✔✗⚠]?\s*RAIM\b.*$/, '').trim();
    if (l && /^[A-Z0-9 ./]+$/.test(l) && l.split(' ').length >= 1 && !/^WAYPOINT/.test(l)) { out.filedRoute = l; break; }
  }
  // Navigation log rows: "SAALT PTRON9 167 167 7800 T4 345/005 0 234 240 ..." (the first row has no airway)
  const seen = [];
  const tas = [];
  for (const l of lines) {
    if (/^(NOTAMs|Departure|Destination|Weather|METAR)\b/.test(l) && seen.length > 1 && /NOTAMs/.test(l)) break;
    const m = /^([A-Z0-9]{2,6}) (?:([A-Z0-9]{2,8}) )?(\d{3}|-) (\d{3}|-) (FL\d{3}|\d{1,5}) (.*)$/.exec(l);
    if (!m) continue;
    const id = m[1];
    if (m[2] && !AIRWAY.test(m[2])) continue;
    if (!seen.length && id !== out.dep) continue; // the log starts at the departure airport
    if (seen[seen.length - 1] !== id) seen.push(id);
    const sp = /\b\d{3}\/\d{3} [+-]?\d{1,2} (\d{3}) \d{3}\b/.exec(m[6]);
    if (sp && out.cruiseAlt && m[5] === `FL${out.cruiseAlt / 100}`) tas.push(+sp[1]);
    if (id === out.dest && seen.length > 1) break;
  }
  if (seen.length && seen[seen.length - 1] !== out.dest) seen.push(out.dest);
  out.waypoints = seen.length > 1 ? seen : [out.dep, out.dest];
  if (tas.length) out.tas = tas.sort((a, b) => a - b)[Math.floor(tas.length / 2)];
  // Alternate: a NOTAM/weather section headed "Alternate KXXX - Name", or "Alternate (KXXX)"
  const alt = lines.map((l) => /^(?:1st |First )?Alternate(?: Airport)?:? \(?([A-Z][A-Z0-9]{3})\)?(?: [-—]|$)/.exec(l)).find(Boolean);
  if (alt && alt[1] !== out.dest) out.alternate = alt[1];
  // Fuel plan: a heading line of names with the figures on the next line
  const fi = lines.findIndex((l) => /Block Fuel.*Flight Fuel/.test(l));
  if (fi >= 0 && lines[fi + 1]) {
    const names = lines[fi].match(/(Block|Taxi|Flight|Reserve|Alternate|Extra|Landing) Fuel/g) || [];
    const nums = (lines[fi + 1].match(/\d[\d,]* ?lbs?/gi) || []).map((x) => parseInt(x.replace(/,/g, ''), 10));
    if (names.length && nums.length === names.length) {
      out.fuel = {};
      names.forEach((n, i) => { out.fuel[n.split(' ')[0].toLowerCase()] = nums[i]; });
      const wi = lines.findIndex((l) => /\bTOW\b.*\bELW\b/.test(l));
      const w = wi >= 0 && lines[wi + 1] ? (lines[wi + 1].match(/\d[\d,]* ?lbs?/gi) || []).map((x) => parseInt(x.replace(/,/g, ''), 10)) : [];
      if (w.length >= 2) { out.fuel.tow = w[w.length - 2]; out.fuel.elw = w[w.length - 1]; }
      const sum = lines.slice(0, 12).join(' ');
      const e = /\b(\d{1,2})h(\d{2})m\b/.exec(sum); if (e) out.fuel.eteMin = +e[1] * 60 + +e[2];
      const wd = /\b(\d{1,3}) ?kt (head|tail)\b/i.exec(sum); if (wd) out.fuel.headKt = /head/i.test(wd[2]) ? +wd[1] : -wd[1];
      const dn = /\b(\d{2,4}) ?NM\b/.exec(sum); if (dn) out.fuel.distNm = +dn[1];
    }
  }
  out.routeText = out.waypoints.join(' ');
  return out;
}

module.exports = { parseBriefing };
