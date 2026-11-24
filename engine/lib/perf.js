'use strict';
// Citation XLS+ (Model 560XL, PW545C) performance from Cessna's XLS+ Flight Planning Guide (preliminary edition,
// revisions FM-00 / OM-00): climb, high speed and long range cruise, normal descent, holding and reserve
// allowances. ISA, zero wind, anti-ice off. The guide is not a substitute for the AFM; these tables are for
// planning estimates only and are not corrected for temperature.
const SOURCE = 'Cessna Citation XLS+ Flight Planning Guide (ISA, anti-ice off)';
const LIMITS = { maxRampLb: 20400, maxTakeoffLb: 20200, maxLandingLb: 18700, maxZeroFuelLb: 15100, usableFuelLb: 6740, basicOperatingLb: 12800 };
const W = [20200, 19000, 18000, 16000, 14000];
// 250 KIAS / M 0.65 climb from sea level: altitude -> [minutes], [lb], [nm] by takeoff weight
const CLIMB = {
  15000: [[4, 4, 4, 3, 3], [219, 203, 191, 167, 144], [20, 19, 18, 15, 13]],
  25000: [[8, 8, 7, 6, 5], [374, 347, 325, 282, 242], [42, 39, 36, 32, 27]],
  29000: [[11, 10, 9, 8, 7], [453, 419, 391, 339, 290], [57, 52, 49, 42, 36]],
  31000: [[12, 11, 10, 9, 7], [489, 450, 420, 363, 310], [64, 58, 54, 47, 40]],
  33000: [[13, 12, 11, 9, 8], [523, 481, 448, 386, 329], [71, 65, 60, 51, 44]],
  35000: [[14, 13, 12, 10, 9], [558, 512, 476, 410, 349], [79, 72, 66, 57, 48]],
  37000: [[15, 14, 13, 11, 9], [597, 545, 506, 434, 368], [87, 79, 73, 62, 52]],
  39000: [[17, 16, 14, 12, 10], [641, 583, 539, 460, 389], [98, 89, 81, 69, 58]],
  41000: [[20, 17, 16, 13, 11], [694, 627, 576, 488, 411], [113, 100, 91, 76, 63]],
  43000: [[23, 20, 18, 15, 12], [766, 681, 621, 520, 434], [134, 116, 104, 85, 70]],
  45000: [[29, 24, 21, 17, 14], [887, 757, 678, 556, 460], [172, 140, 123, 97, 79]],
};
// High speed cruise: altitude -> [KTAS], [lb/h] by cruise weight
const HSC = {
  5000: [[280, 280, 280, 280, 280], [1643, 1631, 1621, 1604, 1589]],
  10000: [[353, 353, 353, 353, 353], [2029, 2019, 2010, 1995, 1981]],
  15000: [[379, 379, 379, 379, 379], [2008, 1994, 1984, 1966, 1949]],
  21000: [[414, 414, 414, 414, 414], [2066, 2049, 2036, 2012, 1991]],
  23000: [[427, 427, 427, 427, 427], [2090, 2072, 2058, 2032, 2010]],
  25000: [[432, 434, 435, 437, 439], [2023, 2024, 2024, 2025, 2025]],
  27000: [[436, 437, 439, 441, 443], [1947, 1948, 1948, 1949, 1950]],
  29000: [[436, 438, 440, 442, 444], [1846, 1848, 1850, 1853, 1855]],
  31000: [[438, 439, 441, 441, 441], [1762, 1763, 1764, 1738, 1705]],
  33000: [[437, 437, 437, 437, 437], [1665, 1643, 1625, 1591, 1559]],
  35000: [[433, 433, 433, 433, 433], [1537, 1512, 1493, 1457, 1425]],
  37000: [[431, 431, 431, 431, 431], [1432, 1400, 1377, 1339, 1305]],
  39000: [[431, 431, 431, 431, 431], [1367, 1327, 1297, 1251, 1214]],
  41000: [[422, 429, 431, 431, 431], [1271, 1280, 1267, 1204, 1157]],
  43000: [[396, 410, 418, 429, 431], [1152, 1167, 1173, 1179, 1142]],
  45000: [[353, 378, 394, 416, 426], [1032, 1059, 1077, 1095, 1093]],
};
// Long range cruise (45,000 ft is not available at 20,200 lb)
const LRC = {
  5000: [[237, 233, 229, 221, 213], [1350, 1299, 1257, 1173, 1093]],
  10000: [[263, 255, 251, 243, 234], [1314, 1250, 1210, 1132, 1055]],
  15000: [[283, 278, 273, 263, 254], [1243, 1194, 1154, 1080, 1009]],
  21000: [[299, 295, 291, 283, 276], [1129, 1090, 1060, 995, 934]],
  23000: [[307, 302, 296, 288, 280], [1103, 1061, 1024, 959, 899]],
  25000: [[316, 309, 303, 291, 283], [1083, 1036, 995, 917, 857]],
  27000: [[321, 313, 307, 296, 286], [1051, 999, 958, 885, 820]],
  29000: [[322, 315, 312, 305, 293], [1008, 958, 927, 865, 794]],
  31000: [[324, 320, 318, 310, 296], [974, 929, 903, 838, 758]],
  33000: [[326, 322, 322, 315, 303], [946, 902, 876, 812, 737]],
  35000: [[329, 325, 324, 320, 310], [922, 877, 850, 791, 723]],
  37000: [[335, 330, 328, 323, 314], [910, 862, 828, 765, 697]],
  39000: [[344, 338, 333, 327, 320], [917, 863, 818, 748, 679]],
  41000: [[351, 347, 341, 332, 325], [942, 887, 835, 751, 677]],
  43000: [[358, 356, 349, 339, 330], [985, 929, 871, 776, 693]],
  45000: [[357, 357, 352, 346, 336], [968, 968, 901, 805, 712]],
};
// Normal descent (2,000 ft/min) to sea level at 15,000 lb: altitude -> [minutes, lb, nm]
const DESCENT = { 15000: [8, 133, 38], 25000: [13, 257, 71], 31000: [16, 331, 92], 33000: [17, 351, 99], 35000: [18, 370, 106], 37000: [19, 385, 113], 39000: [20, 400, 120], 41000: [21, 412, 127], 43000: [22, 424, 134], 45000: [23, 435, 141] };
// Holding fuel flow (lb/h): weight -> by altitude
const HOLD_ALT = [0, 5000, 10000, 15000, 20000, 25000, 30000];
const HOLD = { 17000: [1199, 1096, 1037, 985, 938, 894, 858], 16000: [1148, 1049, 994, 944, 898, 853, 817], 15000: [1099, 1003, 952, 904, 859, 814, 776], 14000: [1051, 960, 911, 866, 821, 777, 737], 13000: [1004, 917, 871, 828, 784, 740, 699] };
// Reserve allowances (4 passengers): 45 minutes at 15,000 ft, and alternate plus 45 minutes by alternate distance
const RESERVE_45 = 767;
const IFR_RESERVE = [[100, 1250], [200, 1602], [300, 1878]];

const lerp = (x, x0, x1, y0, y1) => (x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
// value at x from sorted [x, y] pairs, held flat beyond the ends unless `extend`
function at(pairs, x, extend) {
  if (x <= pairs[0][0]) return extend && pairs.length > 1 ? lerp(x, pairs[0][0], pairs[1][0], pairs[0][1], pairs[1][1]) : pairs[0][1];
  const n = pairs.length - 1;
  if (x >= pairs[n][0]) return extend && n ? lerp(x, pairs[n - 1][0], pairs[n][0], pairs[n - 1][1], pairs[n][1]) : pairs[n][1];
  const i = pairs.findIndex((p) => p[0] >= x);
  return lerp(x, pairs[i - 1][0], pairs[i][0], pairs[i - 1][1], pairs[i][1]);
}
const byWeight = (row, w) => at(W.map((x, i) => [x, row[i]]).reverse(), w);
const table2 = (T, alt, w, k) => at(Object.keys(T).map(Number).map((a) => [a, byWeight(T[a][k], w)]), alt);

function climb(altFt, towLb) {
  const f = altFt < 15000 ? altFt / 15000 : 1; // below the first row, in proportion
  const a = Math.max(15000, altFt);
  return { min: table2(CLIMB, a, towLb, 0) * f, lb: table2(CLIMB, a, towLb, 1) * f, nm: table2(CLIMB, a, towLb, 2) * f };
}
function cruise(altFt, weightLb, longRange) {
  const T = longRange ? LRC : HSC;
  return { ktas: table2(T, altFt, weightLb, 0), flow: table2(T, altFt, weightLb, 1) };
}
function descent(altFt) {
  const f = altFt < 15000 ? altFt / 15000 : 1, a = Math.max(15000, altFt);
  const v = (k) => at(Object.keys(DESCENT).map(Number).map((x) => [x, DESCENT[x][k]]), a) * f;
  return { min: v(0), lb: v(1), nm: v(2) };
}
function holdFlow(weightLb, altFt = 10000) {
  const ws = Object.keys(HOLD).map(Number).sort((a, b) => a - b);
  return at(ws.map((w) => [w, at(HOLD_ALT.map((a, i) => [a, HOLD[w][i]]), altFt)]), weightLb, true);
}
// Alternate fuel from the guide's "alternate plus 45 minutes" allowance, less the 45 minutes
const alternateFuel = (nm) => Math.max(250, at(IFR_RESERVE, Math.max(40, nm), true) - RESERVE_45);

// Trip fuel and time: climb, cruise at high speed cruise fuel flow and normal descent. windKt is the average
// component along the route (tailwind positive). tasKt, when lower than the table's high speed cruise, sets the cruise time.
function trip({ distNm, altFt, towLb = 18500, windKt = 0, tasKt = null }) {
  const c = climb(altFt, towLb), d = descent(altFt);
  // climb and descent cover more or less ground with the wind (about half the cruise wind on average)
  let cNm = c.nm + (windKt * 0.5 * c.min) / 60, dNm = d.nm + (windKt * 0.5 * d.min) / 60, k = 1;
  if (cNm + dNm > distNm) { k = distNm / (cNm + dNm); cNm *= k; dNm *= k; } // too short to reach the level
  const cruiseNm = Math.max(0, distNm - cNm - dNm);
  let lb = 0, hours = 0, cr = null;
  for (let i = 0; i < 3; i++) { // cruise at the mid-cruise weight
    cr = cruise(altFt, towLb - c.lb * k - lb / 2);
    hours = cruiseNm / Math.max(150, (tasKt ? Math.min(tasKt, cr.ktas) : cr.ktas) + windKt); // no faster than high speed cruise
    lb = hours * cr.flow;
  }
  return { lb: Math.round(c.lb * k + lb + d.lb * k), min: Math.round(c.min * k + hours * 60 + d.min * k), climb: c, descent: d, cruiseFlow: Math.round(cr.flow), cruiseKtas: Math.round(cr.ktas), reachesLevel: k === 1 };
}

module.exports = { SOURCE, LIMITS, RESERVE_45, climb, cruise, descent, holdFlow, alternateFuel, trip };
