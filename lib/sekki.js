// lib/sekki.js
// 24節気（太陽黄経）を「計算で」求める精密版
// - 太陽の見かけ黄経 λ（Meeus系の近似）を使う
// - 年ごとに 24節気（15°刻み）を UTC Date で算出
// - 既存互換: buildJie12Utc(), formatJst()

// ===== 角度・時間ユーティリティ =====
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function mod360(x) {
  const v = x % 360;
  return v < 0 ? v + 360 : v;
}
function sinDeg(d) {
  return Math.sin(d * DEG2RAD);
}
function cosDeg(d) {
  return Math.cos(d * DEG2RAD);
}

// UTC Date -> Julian Day
function dateToJD(dateUtc) {
  // Julian Day for UTC date/time
  const ms = dateUtc.getTime();
  return ms / 86400000 + 2440587.5; // Unix epoch -> JD
}

// Julian Day -> UTC Date
function jdToDate(jd) {
  const ms = (jd - 2440587.5) * 86400000;
  return new Date(ms);
}

// ===== 太陽の見かけ黄経（近似） =====
// Meeus系の一般的な近似（視黄経）
// 精度は「節入り境界」用途として十分（秒単位までは保証しないが、分単位レベルで安定）
function sunApparentLongitudeDeg(jd) {
  const T = (jd - 2451545.0) / 36525.0;

  const L0 = mod360(
    280.46646 + 36000.76983 * T + 0.0003032 * T * T
  );

  const M = mod360(
    357.52911 + 35999.05029 * T - 0.0001537 * T * T
  );

  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * sinDeg(M) +
    (0.019993 - 0.000101 * T) * sinDeg(2 * M) +
    0.000289 * sinDeg(3 * M);

  const trueLong = L0 + C;

  const omega = 125.04 - 1934.136 * T;
  const lambda =
    trueLong - 0.00569 - 0.00478 * sinDeg(omega);

  // ★ ここが修正点：節気用に 180° 回転させる
  return mod360(lambda + 180);
}

// ===== 24節気定義 =====
// 角度（太陽黄経）: 0=春分, 90=夏至, 180=秋分, 270=冬至
const SEKKI_24 = [
  { name: "立春", angle: 315 },
  { name: "雨水", angle: 330 },
  { name: "啓蟄", angle: 345 },
  { name: "春分", angle: 0 },
  { name: "清明", angle: 15 },
  { name: "穀雨", angle: 30 },
  { name: "立夏", angle: 45 },
  { name: "小満", angle: 60 },
  { name: "芒種", angle: 75 },
  { name: "夏至", angle: 90 },
  { name: "小暑", angle: 105 },
  { name: "大暑", angle: 120 },
  { name: "立秋", angle: 135 },
  { name: "処暑", angle: 150 },
  { name: "白露", angle: 165 },
  { name: "秋分", angle: 180 },
  { name: "寒露", angle: 195 },
  { name: "霜降", angle: 210 },
  { name: "立冬", angle: 225 },
  { name: "小雪", angle: 240 },
  { name: "大雪", angle: 255 },
  { name: "冬至", angle: 270 },
  { name: "小寒", angle: 285 },
  { name: "大寒", angle: 300 },
];

// 角度 crossing 判定（0跨ぎ対応）
function diffAngleSigned(a, b) {
  // return signed smallest difference a-b in (-180..180]
  let d = mod360(a - b);
  if (d > 180) d -= 360;
  return d;
}

// 二分探索で「λ(target)」を解く
function solveLongitudeCrossing(jd1, jd2, targetAngle, maxIter = 40) {
  // 目的: sunLon(jd)=targetAngle を [jd1,jd2] 内で求める
  // 角度のwrapがあるため「差分」を使って符号反転で挟み込み
  let f1 = diffAngleSigned(sunApparentLongitudeDeg(jd1), targetAngle);
  let f2 = diffAngleSigned(sunApparentLongitudeDeg(jd2), targetAngle);

  // 念のため: 挟めていなければ null
  if (f1 === 0) return jd1;
  if (f2 === 0) return jd2;
  if (f1 * f2 > 0) return null;

  let a = jd1, b = jd2;
  for (let i = 0; i < maxIter; i++) {
    const mid = (a + b) / 2;
    const fm = diffAngleSigned(sunApparentLongitudeDeg(mid), targetAngle);
    if (Math.abs(fm) < 1e-7) return mid;
    if (f1 * fm <= 0) {
      b = mid;
      f2 = fm;
    } else {
      a = mid;
      f1 = fm;
    }
  }
  return (a + b) / 2;
}

// 年内の「節気角」を日ステップで探索→区間を見つけて二分探索
function findCrossingInYearUtc(year, targetAngle) {
  // 探索範囲: [year-01-01 .. year+01-01)
  // 立春などは年頭に寄るため、前後を少しバッファして探索
  const start = new Date(Date.UTC(year - 1, 11, 15, 0, 0, 0)); // 前年12/15
  const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59));   // 当年12/31

  // 1日刻みで crossing を探す
  let prev = dateToJD(start);
  let prevVal = diffAngleSigned(sunApparentLongitudeDeg(prev), targetAngle);

  const dayStep = 1; // day
  const totalDays = Math.ceil((end.getTime() - start.getTime()) / 86400000);

  for (let i = 1; i <= totalDays; i++) {
    const jd = prev + dayStep;
    const val = diffAngleSigned(sunApparentLongitudeDeg(jd), targetAngle);

    // 符号が変わったら区間を特定
    if (prevVal === 0) return prev;
    if (val === 0) return jd;
    if (prevVal * val < 0) {
      // この [prev, jd] に解がある
      const solved = solveLongitudeCrossing(prev, jd, targetAngle);
      return solved ?? jd;
    }

    prev = jd;
    prevVal = val;
  }

  // 最後まで見つからなければ null
  return null;
}

// ===== 公開API =====

// 24節気（UTC Date）
export function buildSekki24Utc(year) {
  const out = [];
  for (const s of SEKKI_24) {
    const jd = findCrossingInYearUtc(year, s.angle);
    if (!jd) continue;
    out.push({
      name: s.name,
      angle: s.angle,
      timeUtc: jdToDate(jd),
    });
  }
  // 時刻順にソート
  out.sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());
  return out;
}

// 12節（=月柱の境界に使う「節」だけ）
export function buildJie12Utc(year) {
  // 「節」: 立春, 啓蟄, 清明, 立夏, 芒種, 小暑, 立秋, 白露, 寒露, 立冬, 大雪, 小寒
  const jieAngles = new Set([315, 345, 15, 45, 75, 105, 135, 165, 195, 225, 255, 285]);
  const s24 = buildSekki24Utc(year);
  return s24.filter(x => jieAngles.has(x.angle));
}

// JST表示（YYYY-MM-DD HH:MM）
export function formatJst(dateUtc) {
  const jst = new Date(dateUtc.getTime() + 9 * 3600 * 1000);
  const Y = jst.getUTCFullYear();
  const M = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const D = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D} ${hh}:${mm}`;
}
