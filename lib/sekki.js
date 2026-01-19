// /api/lib/sekki.js
// Phase B+ : 節入り（12節）の境界を “安定して” 求めるための誤差ガード強化版
// - 太陽黄経（見かけ）を使い、目標角度に達する時刻を 2分探索で求める
// - 近似誤差を見越して「必ず括る（bracket）」→括れなければ探索幅を自動拡張
// - 年またぎでも取りこぼさないよう buildJie12Utc(y) は “その年の12節” を安定生成

// -----------------------------
// 基本ユーティリティ
// -----------------------------
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function mod360(x) {
  let v = x % 360;
  if (v < 0) v += 360;
  return v;
}
function sinDeg(d) { return Math.sin(d * DEG2RAD); }
function cosDeg(d) { return Math.cos(d * DEG2RAD); }

// -----------------------------
// Julian Day
// -----------------------------
export function toJulianDay(dateUtc) {
  // dateUtc: Date (UTC基準で解釈)
  const y = dateUtc.getUTCFullYear();
  const m = dateUtc.getUTCMonth() + 1;
  const D =
    dateUtc.getUTCDate() +
    (dateUtc.getUTCHours() +
      (dateUtc.getUTCMinutes() +
        (dateUtc.getUTCSeconds() + dateUtc.getUTCMilliseconds() / 1000) / 60) /
        60) /
      24;

  let Y = y;
  let M = m;
  if (M <= 2) {
    Y -= 1;
    M += 12;
  }
  const A = Math.floor(Y / 100);
  const B = 2 - A + Math.floor(A / 4);

  const JD =
    Math.floor(365.25 * (Y + 4716)) +
    Math.floor(30.6001 * (M + 1)) +
    D +
    B -
    1524.5;

  return JD;
}

export function fromJulianDay(jd) {
  // jd -> Date(UTC)
  // Meeus
  const Z = Math.floor(jd + 0.5);
  const F = jd + 0.5 - Z;

  let A = Z;
  const alpha = Math.floor((Z - 1867216.25) / 36524.25);
  A = Z + 1 + alpha - Math.floor(alpha / 4);

  const B = A + 1524;
  const C = Math.floor((B - 122.1) / 365.25);
  const D = Math.floor(365.25 * C);
  const E = Math.floor((B - D) / 30.6001);

  const day = B - D - Math.floor(30.6001 * E) + F;
  const month = E < 14 ? E - 1 : E - 13;
  const year = month > 2 ? C - 4716 : C - 4715;

  const dayInt = Math.floor(day);
  const dayFrac = day - dayInt;

  const hours = dayFrac * 24;
  const hh = Math.floor(hours);
  const minutes = (hours - hh) * 60;
  const mm = Math.floor(minutes);
  const seconds = (minutes - mm) * 60;
  const ss = Math.floor(seconds);
  const ms = Math.round((seconds - ss) * 1000);

  return new Date(Date.UTC(year, month - 1, dayInt, hh, mm, ss, ms));
}

// -----------------------------
// 太陽の見かけ黄経（簡易高精度）
// ※ ここは前回の「+180°補正」を組み込み済み
// -----------------------------
export function sunApparentLongitudeDeg(jd) {
  // Low-precision but reliable for sekki boundaries
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

  // ★節気用に 180°回転（前回の修正を恒久化）
  return mod360(lambda + 180);
}

// -----------------------------
// 節気（12節）定義
// 立春(315)→雨水(345)→啓蟄(15)→春分(45)→...→小寒(285)
// -----------------------------
const JIE_12 = [
  { name: "立春", angle: 315 },
  { name: "雨水", angle: 345 },
  { name: "啓蟄", angle: 15 },
  { name: "春分", angle: 45 },
  { name: "清明", angle: 75 },
  { name: "立夏", angle: 105 },
  { name: "芒種", angle: 135 },
  { name: "小暑", angle: 165 },
  { name: "立秋", angle: 195 },
  { name: "白露", angle: 225 },
  { name: "寒露", angle: 255 },
  { name: "小寒", angle: 285 }
];

// -----------------------------
// 角度差（循環）: target - current を [-180, +180) に正規化
// -----------------------------
function diffDegSigned(target, current) {
  let d = mod360(target - current);
  if (d >= 180) d -= 360;
  return d;
}

// -----------------------------
// 目標角度に到達する時刻を “必ず括って” 二分探索で求める
// ここが誤差ガードの核心
// -----------------------------
function findTimeWhenLongitudeHitsAngleUtc(targetAngle, approxUtc, guardDays = 6) {
  // approxUtc: 近似中心（この周辺にあるはず）
  // guardDays: 初期探索幅（±guardDays日）…括れなければ倍々拡張

  const maxExpand = 4; // 6d -> 12 -> 24 -> 48日 まで拡張
  const msDay = 86400000;

  const f = (tUtc) => {
    const jd = toJulianDay(tUtc);
    const lon = sunApparentLongitudeDeg(jd);
    return diffDegSigned(targetAngle, lon);
  };

  // bracket: f(t0) と f(t1) が符号反転する区間を見つける
  let left = new Date(approxUtc.getTime() - guardDays * msDay);
  let right = new Date(approxUtc.getTime() + guardDays * msDay);

  let fl = f(left);
  let fr = f(right);

  let expand = 0;
  while (fl === 0 ? false : fr === 0 ? false : (fl > 0) === (fr > 0)) {
    // 符号が同じ → まだ括れていない。幅を広げる。
    expand++;
    if (expand > maxExpand) {
      // 最終手段：日次スキャンで括り直す（さらに安全）
      const stepHours = 6; // 6時間刻み
      const stepMs = stepHours * 3600000;
      let t = new Date(approxUtc.getTime() - 60 * msDay);
      const end = new Date(approxUtc.getTime() + 60 * msDay);

      let prevT = t;
      let prevF = f(prevT);

      while (t.getTime() <= end.getTime()) {
        t = new Date(t.getTime() + stepMs);
        const curF = f(t);
        if ((prevF > 0) !== (curF > 0)) {
          left = prevT;
          right = t;
          fl = prevF;
          fr = curF;
          break;
        }
        prevT = t;
        prevF = curF;
      }
      break;
    }
    const widen = guardDays * Math.pow(2, expand);
    left = new Date(approxUtc.getTime() - widen * msDay);
    right = new Date(approxUtc.getTime() + widen * msDay);
    fl = f(left);
    fr = f(right);
  }

  // 二分探索（分精度で十分）
  let lo = left.getTime();
  let hi = right.getTime();
  let flo = f(new Date(lo));

  // 収束条件：±30秒まで
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const fmid = f(new Date(mid));

    if ((flo > 0) !== (fmid > 0)) {
      hi = mid;
      // fr = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }

    if (hi - lo < 30000) break;
  }

  return new Date((lo + hi) / 2);
}

// -----------------------------
// 年のだいたいの節気日時（近似）を作る
// ※ ここが “初期中心” で、findTime... が括って正確化する
// -----------------------------
function approxJieCenterUtc(year, angle) {
  // 超ざっくり：春分(45°)を3/20付近として、角度→日数換算で初期中心を作る
  // 360° ≒ 365.2422日
  const daysPerDeg = 365.2422 / 360;
  // 春分(45°)近似中心（UTC）: 3/20 12:00 UTC（雑だがOK。括るので）
  const base = new Date(Date.UTC(year, 2, 20, 12, 0, 0));
  const diffDeg = diffDegSigned(angle, 45); // angle - 45 を循環で
  const diffDays = diffDeg * daysPerDeg;

  return new Date(base.getTime() + diffDays * 86400000);
}

// -----------------------------
// 外部API：その年の12節(UTC)を生成
// -----------------------------
export function buildJie12Utc(year) {
  // 12節それぞれ、近似中心→括り二分探索で時刻確定
  const out = JIE_12.map(({ name, angle }) => {
    const approx = approxJieCenterUtc(year, angle);
    const timeUtc = findTimeWhenLongitudeHitsAngleUtc(angle, approx, 6);
    return { name, angle, timeUtc };
  });

  // 念のため時刻順にソート
  out.sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());

  // 安全ガード：年をまたぐ節が混じる可能性があるので、year基準で “最も近い12個” を採用
  // （例えば立春は2/4前後で安定するが、近似がズレた場合に備える）
  // ここでは「yearの1/1〜翌年1/1」周辺に最も近い12個へ再選別する
  const center = new Date(Date.UTC(year, 6, 1, 0, 0, 0)); // 7/1 を中心に
  out.sort((a, b) => Math.abs(a.timeUtc - center) - Math.abs(b.timeUtc - center));
  const picked = out.slice(0, 12);
  picked.sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());

  // 角度の重複や欠落がないかチェック（落ちたら fallback しないが、開発時に気づける）
  // ※本番ではconsole.warnのみ
  const uniqAngles = new Set(picked.map(x => x.angle));
  if (uniqAngles.size !== 12) {
    console.warn("[sekki] angle duplicate/missing detected", picked);
  }

  return picked;
}

// -----------------------------
// JST表示
// -----------------------------
export function formatJst(dateUtc) {
  const j = new Date(dateUtc.getTime() + 9 * 3600 * 1000);
  const Y = j.getUTCFullYear();
  const M = String(j.getUTCMonth() + 1).padStart(2, "0");
  const D = String(j.getUTCDate()).padStart(2, "0");
  const hh = String(j.getUTCHours()).padStart(2, "0");
  const mm = String(j.getUTCMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D} ${hh}:${mm}`;
}
