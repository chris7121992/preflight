'use strict';
// Numerical weather prediction guidance at the terminals: HRRR (3 km, hourly), NBM (blend), GFS and ECMWF IFS.
// The values come from each model's GRIB2 output, decoded to points by Open-Meteo. Model output is guidance;
// it is compared with the TAF so the pilot can see where the models and the forecaster disagree.

const dec = require('./decode');

const MODEL_NAMES = { ncep_hrrr_conus: 'HRRR', ncep_nbm_conus: 'NBM', gfs_seamless: 'GFS', ecmwf_ifs025: 'ECMWF' };
const CAT_ORDER = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
const fmtZ = (ms) => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
};

function wxText(code) {
  if (code == null) return null;
  if (code >= 95) return code >= 96 ? 'thunderstorm with hail' : 'thunderstorm';
  if (code === 56 || code === 57) return 'freezing drizzle';
  if (code === 66 || code === 67) return 'freezing rain';
  if (code >= 85) return 'snow showers';
  if (code >= 80) return 'rain showers';
  if (code >= 71) return 'snow';
  if (code >= 61) return 'rain';
  if (code >= 51) return 'drizzle';
  if (code === 45 || code === 48) return 'fog';
  return null;
}

// Summarize one model over a time window at one point.
function modelWindow(h, model, from, to) {
  const k = (v) => `${v}_${model}`;
  if (!h || !h.time || !h[k('temperature_2m')]) return null;
  const idx = [];
  h.time.forEach((t, i) => { const ms = Date.parse(t + 'Z'); if (ms >= from - 30 * 60e3 && ms <= to + 30 * 60e3) idx.push(i); });
  if (!idx.length) return null;
  const vals = (v) => idx.map((i) => (h[k(v)] || [])[i]).filter((x) => x != null);
  const temps = vals('temperature_2m');
  if (!temps.length) return null;
  const min = (a) => (a.length ? Math.min(...a) : null), max = (a) => (a.length ? Math.max(...a) : null);
  // Cloud base estimate from the surface temperature/dew point spread (about 400 ft per °C), used only when the model has low cloud.
  let ceil = null;
  idx.forEach((i) => {
    const lc = (h[k('cloud_cover_low')] || [])[i], T = (h[k('temperature_2m')] || [])[i], Td = (h[k('dew_point_2m')] || [])[i];
    if (lc != null && lc >= 60 && T != null && Td != null) {
      const base = Math.max(100, Math.round(((T - Td) * 400) / 100) * 100);
      if (ceil == null || base < ceil) ceil = base;
    }
  });
  const visM = min(vals('visibility'));
  const vis = visM != null ? Math.min(10, Math.round((visM / 1609.34) * 4) / 4) : null;
  const codes = vals('weather_code');
  const worstCode = codes.length ? codes.reduce((a, b) => (rank(b) > rank(a) ? b : a)) : null;
  return {
    model: MODEL_NAMES[model] || model,
    temp: Math.round(temps[Math.floor(temps.length / 2)]),
    dewp: (() => { const d = vals('dew_point_2m'); return d.length ? Math.round(d[Math.floor(d.length / 2)]) : null; })(),
    lowCloudMax: max(vals('cloud_cover_low')),
    ceilingEst: ceil,
    vis,
    category: dec.flightCategory(ceil, vis),
    precipMm: (() => { const p = vals('precipitation'); return p.length ? Math.round(p.reduce((a, b) => a + b, 0) * 10) / 10 : null; })(),
    wx: wxText(worstCode),
    wxCode: worstCode,
    windMax: max(vals('wind_speed_10m')) != null ? Math.round(max(vals('wind_speed_10m'))) : null,
    gustMax: max(vals('wind_gusts_10m')) != null ? Math.round(max(vals('wind_gusts_10m'))) : null,
    capeMax: max(vals('cape')) != null ? Math.round(max(vals('cape'))) : null,
    liMin: min(vals('lifted_index')),
    frzFt: (() => { const f = vals('freezing_level_height'); return f.length ? Math.round((min(f) * 3.28084) / 100) * 100 : null; })(),
  };
}
function rank(code) {
  if (code == null) return -1;
  if (code >= 95) return 100 + code;
  if ([56, 57, 66, 67].includes(code)) return 90;
  return code;
}

// stations: [{ id, role, lat, lon, from, to, tafCategory, tafFlags }]
function analyze(raw, stations, add) {
  const out = [];
  if (!raw) return out;
  stations.forEach((st, i) => {
    const h = raw.data[i] && raw.data[i].hourly;
    const models = raw.models.map((m) => modelWindow(h, m, st.from, st.to)).filter(Boolean);
    const entry = { id: st.id, role: st.role, window: [new Date(st.from).toISOString(), new Date(st.to).toISOString()], models };
    out.push(entry);
    if (!models.length) return;
    const cats = models.map((m) => CAT_ORDER[m.category] ?? 0);
    const worstCat = Math.max(...cats);
    const nWorse = (c) => cats.filter((x) => x >= c).length;
    const names = (pred) => models.filter(pred).map((m) => m.model).join(', ');
    const span = `${fmtZ(st.from)}-${fmtZ(st.to)}`;
    entry.consensus = Object.keys(CAT_ORDER).find((k) => CAT_ORDER[k] === [...cats].sort((a, b) => a - b)[Math.floor((cats.length - 1) / 2)]);
    entry.spread = Math.max(...cats) - Math.min(...cats);
    const tafCat = st.tafCategory != null ? CAT_ORDER[st.tafCategory] : null;
    if (st.role !== 'departure' && tafCat != null && worstCat >= 2 && nWorse(2) >= 2 && worstCat > tafCat) {
      add('caution', 'Forecast', `${st.id}: models are worse than the TAF at ${st.role === 'alternate' ? 'the alternate ETA' : 'ETA'}`, `For ${span} the TAF gives ${st.tafCategory}, but ${names((m) => CAT_ORDER[m.category] >= 2)} show IFR or lower (lowest estimated cloud base ${Math.min(...models.map((m) => m.ceilingEst ?? 99999)) === 99999 ? 'n/a' : Math.min(...models.map((m) => m.ceilingEst ?? 99999)) + ' ft'}, visibility down to ${Math.min(...models.map((m) => m.vis ?? 10))} SM). When guidance and the TAF disagree, plan for the worse until a TAF amendment or the observations settle it; carry the fuel and an alternate that work either way.`, st.id);
    }
    if (entry.spread >= 2) add('info', 'Forecast', `${st.id}: low model agreement`, `The models range from ${Object.keys(CAT_ORDER).find((k) => CAT_ORDER[k] === Math.min(...cats))} to ${Object.keys(CAT_ORDER).find((k) => CAT_ORDER[k] === worstCat)} for ${span}. Low agreement means a low-confidence forecast; recheck before departure.`, st.id);
    const fz = models.filter((m) => [56, 57, 66, 67].includes(m.wxCode));
    if (fz.length >= 2 && !(st.tafFlags && st.tafFlags.freezingPrecip)) add('caution', 'Icing', `${st.id}: models show freezing precipitation`, `${fz.map((m) => m.model).join(', ')} forecast ${fz[0].wx} at ${st.id} for ${span}, which the TAF does not carry. Freezing rain/drizzle is outside the XLS+ certification; check the freezing level and TAF amendments.`, st.id);
    const ts = models.filter((m) => (m.wxCode != null && m.wxCode >= 95) || (m.capeMax != null && m.capeMax >= 1000 && m.liMin != null && m.liMin <= -3));
    if (ts.length >= 2 && !(st.tafFlags && st.tafFlags.thunder)) add('caution', 'Convection', `${st.id}: models support thunderstorms`, `${ts.map((m) => `${m.model} (CAPE ${m.capeMax ?? '?'} J/kg, LI ${m.liMin != null ? Math.round(m.liMin) : '?'})`).join(', ')} for ${span}. The TAF has no thunderstorms; expect possible amendments and keep a convection-free alternate.`, st.id);
    const gust = models.filter((m) => m.gustMax != null && m.gustMax >= 35);
    if (gust.length >= 2) add('caution', 'Wind', `${st.id}: models show gusts to ${Math.max(...gust.map((m) => m.gustMax))} kt`, `${gust.map((m) => `${m.model} ${m.gustMax} kt`).join(', ')} for ${span}. Check the crosswind on the planned runway with these gusts.`, st.id);
  });
  return out;
}

// Icing potential along the route from GFS pressure-level temperature and humidity (a simple RH/temperature screen).
function icingLayers(upper) {
  const out = [];
  for (const u of upper) {
    for (const [lvl, ft] of [[850, 5000], [700, 10000], [500, 18000]]) {
      const T = u[`t${lvl}`], RH = u[`rh${lvl}`];
      if (T == null || RH == null) continue;
      if (T <= 0 && T >= -18 && RH >= 85) out.push({ alongNm: Math.round(u.s), lvl, ft, T: Math.round(T), RH: Math.round(RH) });
    }
  }
  return out;
}

module.exports = { modelWindow, analyze, icingLayers, wxText, MODEL_NAMES };
