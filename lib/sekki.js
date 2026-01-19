// lib/sekki.js
// Phase A++: 24節気（または月柱用12節）の「節入り時刻」を太陽視黄経で分単位精密化
//
// 使い方：
//   buildJie12Utc(year) -> 月柱境界用12節（315,345,15,...,285）
//   buildJie24Utc(year) -> 24節気（0,15,30,...,345）
//
// 戻り値：[{ name, angle, timeUtc: Date }, ...]
//
// NOTE:
// - NOAA系の近似（太陽視黄経）+ 二分探索。
// - 四柱推命用途の「節入り境界」には十分実用（分単位〜秒単位）。
// - 将来さらに高精度（VSOP87等）へ差し替えたい場合は solarApparentLongitudeDegUtc を置換。

// ---- 表示用（JST） ----
export function formatJst(dateUtc) {
  const jst = new Date(dateUtc.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

// ---- 角度ユーティリティ ----
function norm360(deg) {
  let x = deg % 360;
  if (x < 0) x += 360;
  return x;
}
// 角度差を [-180, +180) に正規化（符号で跨ぎを判定しやすくする）
function angDiffSigned(targetDeg, currentDeg) {
  let d = norm360(targetDeg) - norm360(currentDeg);
  d = ((d + 540) % 360) - 180;
  return d;
}

// ---- JD / 時刻変換（UTC） ----
function toJulianDay(dateUtc) {
  // dateUtc: Date (UTC)
  return dateUtc.getTime() / 86400000 + 2440587.5;
}
function fromJulianDay(jd) {
  return new Date((jd - 2440587.5) * 86400000);
}

// ---- NOAA系 近似：太陽視黄経（度） ----
// 参考：NOAA Solar Calculator / Meeus系の簡易式を組合せた実用近似
function solarApparentLongitudeDegUtc(dateUtc) {
  const jd = toJulianDay(dateUtc);
  const T = (jd - 2451545.0) / 36525.0;

  // 幾何平均黄経 L0
  let L0 =
    280.46646 +
    36000.76983 * T +
    0.0003032 * T * T;
  L0 = norm360(L0);

  // 平均近点角 M
  let M =
    357.52911 +
    35999.05029 * T -
    0.0001537 * T * T;
  M = norm360(M);
  const Mrad = (Math.PI / 180) * M;

  // 離心率 e
  const e =
    0.016708634 -
    0.000042037 * T -
    0.0000001267 * T * T;

  // 中心差 C
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);

  // 真黄経
  const trueLong = L0 + C;

  // 視黄経補正（章動＋光行差の簡易）
  const omega = 125.04 - 1934.136 * T;
  const lambdaApp = trueLong - 0.00569 - 0.00478 * Math.sin((Math.PI / 180) * omega);

  return norm360(lambdaApp);
}

// ---- 二分探索で λ = targetDeg の時刻を求める ----
function findTimeForSolarLongitudeUtc(targetDeg, approxJd, windowDays = 3) {
  // まず近傍で符号反転する区間を探す
  const stepHours = 6; // 粗探索（6h刻み）
  const stepDays = stepHours / 24;

  const startJd = approxJd - windowDays;
  const endJd = approxJd + windowDays;

  let prevJd = startJd;
  let prevDiff = angDiffSigned(targetDeg, solarApparentLongitudeDegUtc(fromJulianDay(prevJd)));

  let bracket = null;

  for (let jd = startJd + stepDays; jd <= endJd + 1e-9; jd += stepDays) {
    const curDiff = angDiffSigned(targetDeg, solarApparentLongitudeDegUtc(fromJulianDay(jd)));

    // 符号が変わる or ほぼゼロに近い
    if ((prevDiff === 0) || (curDiff === 0) || (prevDiff < 0 && curDiff > 0) || (prevDiff > 0 && curDiff < 0)) {
      bracket = { a: prevJd, b: jd };
      break;
    }
    prevJd = jd;
    prevDiff = curDiff;
  }

  if (!bracket) {
    // 万一見つからない場合、窓を広げてリトライ（年末年始の跨ぎ等の保険）
    const w2 = windowDays * 2;
    if (w2 <= 14) return findTimeForSolarLongitudeUtc(targetDeg, approxJd, w2);
    // ここまで来たら諦め（通常起きない）
    return fromJulianDay(approxJd);
  }

  // 二分探索（秒単位相当まで）
  let lo = bracket.a;
  let hi = bracket.b;

  for (let i = 0; i < 60; i++) { // 2^-60 day ≒ 0.001s 未満
    const mid = (lo + hi) / 2;
    const diffLo = angDiffSigned(targetDeg, solarApparentLongitudeDegUtc(fromJulianDay(lo)));
    const diffMid = angDiffSigned(targetDeg, solarApparentLongitudeDegUtc(fromJulianDay(mid)));

    if (diffMid === 0) {
      lo = hi = mid;
      break;
    }

    // lo-mid で符号反転していれば hi を midへ
    if ((diffLo < 0 && diffMid > 0) || (diffLo > 0 && diffMid < 0)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return fromJulianDay((lo + hi) / 2);
}

// ---- 概算JDを作る ----
// 方針：春分（λ=0）を年の基準にして、targetDeg を 0.9856°/day で割って日数へ
// さらに「その年の3/20 12:00 UTC」を基点にする（概算で十分、後で探索で詰める）
function approxJdForTargetLongitude(year, targetDeg) {
  // 基点：3/20 12:00 UTC（春分近傍）
  const base = new Date(Date.UTC(year, 2, 20, 12, 0, 0));
  const baseJd = toJulianDay(base);

  // 基点の視黄経（実際は年でズレるので補正する）
  const baseLon = solarApparentLongitudeDegUtc(base);

  // target - baseLon の差を [-180,180) にして日数換算
  const dDeg = angDiffSigned(targetDeg, baseLon);
  const days = dDeg / 0.98564736; // 平均日周運動（deg/day）

  return baseJd + days;
}

// ---- 節名テーブル ----
const JIE24 = [
  { angle:   0, name: "春分" },
  { angle:  15, name: "清明" },
  { angle:  30, name: "穀雨" },
  { angle:  45, name: "立夏" },
  { angle:  60, name: "小満" },
  { angle:  75, name: "芒種" },
  { angle:  90, name: "夏至" },
  { angle: 105, name: "小暑" },
  { angle: 120, name: "大暑" },
  { angle: 135, name: "立秋" },
  { angle: 150, name: "処暑" },
  { angle: 165, name: "白露" },
  { angle: 180, name: "秋分" },
  { angle: 195, name: "寒露" },
  { angle: 210, name: "霜降" },
  { angle: 225, name: "立冬" },
  { angle: 240, name: "小雪" },
  { angle: 255, name: "大雪" },
  { angle: 270, name: "冬至" },
  { angle: 285, name: "小寒" },
  { angle: 300, name: "大寒" },
  { angle: 315, name: "立春" },
  { angle: 330, name: "雨水" },
  { angle: 345, name: "啓蟄" },
];

// 月柱境界用12節（あなたの api/shichusuimei.js 側の angleOrder と同じ並び）
const JIE12_FOR_MONTH = [
  { angle: 315, name: "立春" },
  { angle: 345, name: "啓蟄" },
  { angle:  15, name: "清明" },
  { angle:  45, name: "立夏" },
  { angle:  75, name: "芒種" },
  { angle: 105, name: "小暑" },
  { angle: 135, name: "立秋" },
  { angle: 165, name: "白露" },
  { angle: 195, name: "寒露" },
  { angle: 225, name: "立冬" },
  { angle: 255, name: "大雪" },
  { angle: 285, name: "小寒" },
];

// ---- 公開API ----
export function buildJie24Utc(year) {
  const out = [];
  for (const j of JIE24) {
    const approxJd = approxJdForTargetLongitude(year, j.angle);
    const timeUtc = findTimeForSolarLongitudeUtc(j.angle, approxJd, 4);
    out.push({ name: j.name, angle: j.angle, timeUtc });
  }
  out.sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());
  return out;
}

export function buildJie12Utc(year) {
  // 既存API名を維持（あなたの api/shichusuimei.js が import しているため）
  const out = [];
  for (const j of JIE12_FOR_MONTH) {
    const approxJd = approxJdForTargetLongitude(year, j.angle);
    const timeUtc = findTimeForSolarLongitudeUtc(j.angle, approxJd, 4);
    out.push({ name: j.name, angle: j.angle, timeUtc });
  }
  out.sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());
  return out;
}
