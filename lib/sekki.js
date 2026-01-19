// lib/sekki.js
// Phase A: 24節気（太陽黄経）近似計算で「節入り境界」を決める
// - 外部ライブラリ無し
// - 太陽視黄経 λ を NOAA/Meeus系の近似式で算出
// - 二分探索で targetAngle に到達する時刻を求める
//
// 出力はDate（UTC）で返す。呼び出し側でJST表示してOK。

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Julian Day (UTC) from JS Date (UTC)
export function toJulianDay(dateUtc) {
  const ms = dateUtc.getTime();
  return ms / 86400000 + 2440587.5; // Unix epoch -> JD
}

// JS Date (UTC) from Julian Day
export function fromJulianDay(jd) {
  const ms = (jd - 2440587.5) * 86400000;
  return new Date(ms);
}

// Normalize angle to [0,360)
function norm360(x) {
  let v = x % 360;
  if (v < 0) v += 360;
  return v;
}

// Smallest positive angular difference from a to b going forward (0..360)
function angForwardDiff(a, b) {
  // how far to move from a to reach b going forward
  return norm360(b - a);
}

/**
 * Apparent solar longitude (deg) for given Julian Day (UTC).
 * Based on simplified NOAA/Meeus style approximation:
 *  - mean longitude L0
 *  - mean anomaly M
 *  - equation of center C
 *  - apparent longitude lambda = true_long - 0.00569 - 0.00478*sin(Omega)
 */
export function solarLongitudeApparentDeg(jd) {
  const T = (jd - 2451545.0) / 36525.0;

  // Mean longitude (deg)
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);

  // Mean anomaly (deg)
  const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);

  const Mrad = M * DEG2RAD;

  // Equation of center (deg)
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);

  const trueLong = L0 + C;

  // Omega (deg) for nutation correction
  const Omega = (125.04 - 1934.136 * T) * DEG2RAD;

  // apparent longitude (deg)
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(Omega);

  return norm360(lambda);
}

/**
 * Find UTC Date when solar longitude reaches targetAngleDeg (0..360),
 * near the given approx UTC Date.
 *
 * We do bisection in [approx - spanDays, approx + spanDays].
 */
export function findSolarLongitudeTimeUtc(targetAngleDeg, approxUtcDate, spanDays = 3) {
  const target = norm360(targetAngleDeg);

  const jd0 = toJulianDay(approxUtcDate);
  const left = jd0 - spanDays;
  const right = jd0 + spanDays;

  // We want f(jd) = forward_diff(lon(jd), target) == 0 at crossing.
  // But lon is cyclic; crossing occurs once within bracket for small span.
  // We'll bisection on "signed" crossing by comparing forward diff changes.

  let lo = left;
  let hi = right;

  // Ensure bracket actually contains crossing:
  // We'll check forward diff at lo and hi; crossing when diff wraps through 0.
  // If not bracketed, expand span modestly.
  let dlo = angForwardDiff(solarLongitudeApparentDeg(lo), target);
  let dhi = angForwardDiff(solarLongitudeApparentDeg(hi), target);

  // In forward diff, at exact target it's 0. As time increases, longitude increases ~1 deg/day.
  // So forward diff should decrease to 0 near crossing then jump to ~360 after passing.
  // We can detect crossing if dlo > dhi is not always true; but to simplify:
  // Expand until longitude at hi has passed target relative to lo in forward sense.
  let expand = 0;
  while (expand < 6) {
    const lonLo = solarLongitudeApparentDeg(lo);
    const lonHi = solarLongitudeApparentDeg(hi);
    const forwardFromLoToHi = angForwardDiff(lonLo, lonHi);
    const forwardFromLoToTarget = angForwardDiff(lonLo, target);
    if (forwardFromLoToHi >= forwardFromLoToTarget) break; // target is between lo..hi in forward motion
    // expand
    lo -= spanDays;
    hi += spanDays;
    expand += 1;
  }

  // Bisection (about ~30 iterations gives sub-second resolution in JD)
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const lonLo = solarLongitudeApparentDeg(lo);
    const lonMid = solarLongitudeApparentDeg(mid);

    const fLoToMid = angForwardDiff(lonLo, lonMid);
    const fLoToTarget = angForwardDiff(lonLo, target);

    if (fLoToMid >= fLoToTarget) {
      // target is between lo..mid
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return fromJulianDay((lo + hi) / 2);
}

/**
 * Build all 24 sekki times for a given Gregorian year.
 * Definition here: each 15° of apparent solar longitude.
 *
 * We use 春分（0°）approx anchor near March 20 and distribute.
 */
export function buildSekki24Utc(year) {
  // Anchor near March 20 00:00 UTC (rough). We'll root-find each angle around a predicted date.
  const anchor = new Date(Date.UTC(year, 2, 20, 0, 0, 0)); // Mar=2

  const out = [];
  for (let k = 0; k < 24; k++) {
    const angle = k * 15; // 0,15,...345
    const deltaDays = (angle / 360) * 365.2422;
    const approx = new Date(anchor.getTime() + deltaDays * 86400000);
    const t = findSolarLongitudeTimeUtc(angle, approx, 4);
    out.push({ angle, timeUtc: t });
  }

  // Sort by time
  out.sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());
  return out;
}

/**
 * 12 "節" (jie) boundaries used for month pillar in many Four Pillars systems:
 * 立春(315), 啓蟄(345), 清明(15), 立夏(45), 芒種(75), 小暑(105),
 * 立秋(135), 白露(165), 寒露(195), 立冬(225), 大雪(255), 小寒(285)
 */
export const JIE_ANGLES = [
  315, 345, 15, 45, 75, 105, 135, 165, 195, 225, 255, 285
];

export const JIE_NAMES = {
  315: "立春",
  345: "啓蟄",
  15:  "清明",
  45:  "立夏",
  75:  "芒種",
  105: "小暑",
  135: "立秋",
  165: "白露",
  195: "寒露",
  225: "立冬",
  255: "大雪",
  285: "小寒"
};

export function buildJie12Utc(year) {
  // We need times that may involve angles that happen early Jan (285° 小寒) and late year.
  // We'll compute with a strategy:
  // - For angles 0..360 in year, some happen in Jan: those belong to "year" but actually occur in Jan.
  // We'll compute approximate per angle from a rough anchor:
  const approxByAngle = (ang) => {
    // use rough calendar mapping
    // 315 (立春) around Feb 4
    // 345 (啓蟄) around Mar 6
    // 15  (清明) around Apr 5
    // 45  (立夏) around May 5
    // 75  (芒種) around Jun 6
    // 105 (小暑) around Jul 7
    // 135 (立秋) around Aug 7
    // 165 (白露) around Sep 8
    // 195 (寒露) around Oct 8
    // 225 (立冬) around Nov 7
    // 255 (大雪) around Dec 7
    // 285 (小寒) around Jan 5 (of same year)
    const map = {
      315: [1, 4],
      345: [2, 6],
      15:  [3, 5],
      45:  [4, 5],
      75:  [5, 6],
      105: [6, 7],
      135: [7, 7],
      165: [8, 8],
      195: [9, 8],
      225: [10, 7],
      255: [11, 7],
      285: [0, 5]
    };
    const [mon, day] = map[ang];
    return new Date(Date.UTC(year, mon, day, 0, 0, 0));
  };

  const out = [];
  for (const ang of JIE_ANGLES) {
    const approx = approxByAngle(ang);
    const t = findSolarLongitudeTimeUtc(ang, approx, 4);
    out.push({ angle: ang, name: JIE_NAMES[ang], timeUtc: t });
  }

  // Sort by UTC time
  out.sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());
  return out;
}

// Format helper (JST ISO-like)
export function formatJst(dateUtc) {
  const ms = dateUtc.getTime() + 9 * 3600 * 1000;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
