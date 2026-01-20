/**
 * Vercel Serverless Function (ESM)
 * /api/shichusuimei
 *
 * ✅ Phase B+ (Sekki boundary precision) + タイムアウト対策（メモ化）
 * - timeMode: standard | mean_solar | true_solar
 * - true_solar => meta.place.eqTimeMin を返す
 * - sekkiBoundaryPrecision: minute | second
 * - sekkiBoundaryTieBreak: after | before
 * - boundaryTimeRef: standard | used
 * - dayBoundaryMode: 24 | 23
 *
 * ✅ 重要:
 * - package.json が "type":"module" のため ESM（export default）で統一
 * - 追加ミス防止: 防御的パース + 例外は必ず {ok:false,error} で返す
 *
 * ✅ 今回の修正（重要）:
 * - sekkiBoundaryPrecision を「比較ロジック」に正しく反映
 *   -> minute のときは分単位比較、second のときは秒単位比較
 *   -> tieBreak は「同値(同じ分/同じ秒)」のときだけ効く
 */

// ------------------------------
// Request-scope cache (memoization)
// ------------------------------
const TERM_CACHE = new Map(); // key: `${year}|${angle}|${precision}` -> result

export default async function handler(req, res) {
  try {
    // ---- CORS / basics ----
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }

    // ✅ Next.js API Route互換: req.body が既にパース済みならそれを使う（速い）
    const body =
      req.body && typeof req.body === "object" ? req.body : await readJsonBody(req);

    // ---- Input parse & defaults ----
    const input = normalizeInput(body);

    // ---- Place / longitude ----
    const place = getPlaceInfo(input.birthPlace);

    // ---- Standard datetime (JST) ----
    const std = parseJstDateTime(input.date, input.time); // { y,m,d, hh,mm,ss, dateObjUtc }
    const standardMeta = {
      y: std.y,
      m: std.m,
      d: std.d,
      time: formatHM(std.hh, std.mm),
    };

    // ---- used time (standard + corrections) ----
    const eqTimeMin = computeEquationOfTimeMinutes(std.dateObjUtc); // minutes
    const used = computeUsedDateTimeJst(
      std,
      input.timeMode,
      place.lonCorrectionMin,
      eqTimeMin
    );

    const precision = input.sekkiBoundaryPrecision; // "minute" | "second"
    const tieBreak = input.sekkiBoundaryTieBreak; // "after" | "before"

    // ---- Risshun time (angle 315) ----
    const risshunThisYear = getSolarTermCached(used.y, 315, precision);

    // 秒(生)は保持しつつ、比較は precision に応じて量子化して行う
    const stdJstSecRaw = toJstSeconds(std);
    const usedJstSecRaw = toJstSeconds(used);

    const stdIsBeforeRisshun = isBeforeBoundaryPrec(
      stdJstSecRaw,
      risshunThisYear.secJst,
      precision,
      tieBreak
    );
    const usedIsBeforeRisshun = isBeforeBoundaryPrec(
      usedJstSecRaw,
      risshunThisYear.secJst,
      precision,
      tieBreak
    );

    const yearPillarYearUsed = usedIsBeforeRisshun ? used.y - 1 : used.y;

    const sekkiUsed = getCurrentSekkiBoundary(used, precision, tieBreak);

    // ---- Pillars ----
    const yearPillar = calcYearPillar(yearPillarYearUsed);
    const monthPillar = calcMonthPillar(used, yearPillar.kan, precision, tieBreak);
    const dayPillar = calcDayPillar(
      std,
      used,
      input.dayBoundaryMode,
      input.boundaryTimeRef
    );
    const hourPillar = calcHourPillar(used, dayPillar.kan, input.time);

    // ---- Derived ----
    const tenDeity = calcTenDeity(
      yearPillar.kan,
      monthPillar.kan,
      dayPillar.kan,
      hourPillar?.kan
    );
    const zokanTenDeity = calcZokanTenDeity(
      yearPillar.shi,
      monthPillar.shi,
      dayPillar.shi,
      hourPillar?.shi,
      dayPillar.kan
    );

    const fiveElements = calcFiveElementsCounts(
      [yearPillar.kan, monthPillar.kan, dayPillar.kan].concat(
        hourPillar?.kan ? [hourPillar.kan] : []
      ),
      [yearPillar.shi, monthPillar.shi, dayPillar.shi].concat(
        hourPillar?.shi ? [hourPillar.shi] : []
      )
    );

    const luck = calcLuckAll({
      used,
      sex: input.sex,
      yearStem: yearPillar.kan,
      monthPillar,
      precision,
      tieBreak,
      birthStd: std,
    });

    // ---- meta.yearBoundaryCheck（precision反映済み）----
    const yearBoundaryCheck = {
      standardIsBeforeRisshun: stdIsBeforeRisshun,
      usedIsBeforeRisshun: usedIsBeforeRisshun,
      standardTimeJst: `${std.y}-${pad2(std.m)}-${pad2(std.d)} ${formatHM(std.hh, std.mm)}`,
      usedTimeJst: `${used.y}-${pad2(used.m)}-${pad2(used.d)} ${formatHM(used.hh, used.mm)}`,
      ...(precision === "second"
        ? {
            standardTimeJstSec: `${std.y}-${pad2(std.m)}-${pad2(std.d)} ${formatHMS(std.hh, std.mm, std.ss)}`,
            usedTimeJstSec: `${used.y}-${pad2(used.m)}-${pad2(used.d)} ${formatHMS(used.hh, used.mm, used.ss)}`,
            risshunTimeJstSec: risshunThisYear.timeJstSec,
          }
        : {}),
    };

    // ---- Build response ----
    const resp = {
      ok: true,
      input: {
        date: input.date,
        time: input.time,
        sex: input.sex,
        birthPlace: input.birthPlace,
        timeMode: input.timeMode,
        dayBoundaryMode: input.dayBoundaryMode,
        boundaryTimeRef: input.boundaryTimeRef,
        sekkiBoundaryPrecision: input.sekkiBoundaryPrecision,
        sekkiBoundaryTieBreak: input.sekkiBoundaryTieBreak,
      },
      meta: {
        standard: standardMeta,
        used: {
          y: used.y,
          m: used.m,
          d: used.d,
          time: formatHM(used.hh, used.mm),
          timeModeUsed: input.timeMode,
          dayBoundaryModeUsed: input.dayBoundaryMode,
          boundaryTimeRefUsed: input.boundaryTimeRef,
          sekkiBoundaryPrecisionUsed: input.sekkiBoundaryPrecision,
          sekkiBoundaryTieBreakUsed: input.sekkiBoundaryTieBreak,
          sekkiUsed: {
            name: sekkiUsed.name,
            angle: sekkiUsed.angle,
            timeJst: sekkiUsed.timeJst,
            ...(precision === "second" ? { timeJstSec: sekkiUsed.timeJstSec } : {}),
          },
          yearBoundary: {
            name: "立春",
            timeJst: risshunThisYear.timeJst,
            ...(precision === "second" ? { timeJstSec: risshunThisYear.timeJstSec } : {}),
          },
          yearPillarYearUsed,
          yearBoundaryCheck,
        },
        place: {
          country: place.country,
          pref: place.pref,
          longitude: place.longitude,
          lonCorrectionMin: round2(place.lonCorrectionMin),
          ...(input.timeMode === "true_solar" ? { eqTimeMin: round2(eqTimeMin) } : {}),
        },
      },
      pillars: {
        year: {
          kan: yearPillar.kan,
          shi: yearPillar.shi,
          zokan: getZokan(yearPillar.shi),
          rule: "sekki_risshun",
        },
        month: {
          kan: monthPillar.kan,
          shi: monthPillar.shi,
          zokan: getZokan(monthPillar.shi),
          rule: "sekki_12jie",
        },
        day: {
          kan: dayPillar.kan,
          shi: dayPillar.shi,
          zokan: getZokan(dayPillar.shi),
          rule: input.dayBoundaryMode === "23" ? "day_boundary_23" : "day_boundary_24",
        },
        hour: hourPillar
          ? {
              kan: hourPillar.kan,
              shi: hourPillar.shi,
              zokan: getZokan(hourPillar.shi),
              rule: "hour_by_used_time",
            }
          : null,
      },
      derived: {
        tenDeity,
        zokanTenDeity,
        fiveElements,
        luck,
      },
    };

    res.statusCode = 200;
    return res.end(JSON.stringify(resp));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  } finally {
    // request-scope的に見せたいので毎回クリア（※Vercelのwarmで残ることがある）
    TERM_CACHE.clear();
  }
}

// ------------------------------
// Body utils
// ------------------------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeInput(body) {
  const date = safeString(body?.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date (expected YYYY-MM-DD)");

  const timeRaw = safeString(body?.time);
  if (timeRaw && !/^\d{2}:\d{2}(:\d{2})?$/.test(timeRaw)) throw new Error("Invalid time (expected HH:MM or HH:MM:SS)");

  const sex = safeString(body?.sex);
  const birthPlace = body?.birthPlace && typeof body.birthPlace === "object" ? body.birthPlace : {};
  const country = safeString(birthPlace.country) || "JP";
  const pref = safeString(birthPlace.pref) || "東京都";

  const timeMode = normalizeEnum(safeString(body?.timeMode) || "standard", ["standard", "mean_solar", "true_solar"], "standard");
  const dayBoundaryMode = normalizeEnum(String(body?.dayBoundaryMode || "24"), ["23", "24"], "24");
  const boundaryTimeRef = normalizeEnum(safeString(body?.boundaryTimeRef) || "used", ["standard", "used"], "used");

  const sekkiBoundaryPrecision = normalizeEnum(safeString(body?.sekkiBoundaryPrecision) || "minute", ["minute", "second"], "minute");
  const sekkiBoundaryTieBreak = normalizeEnum(safeString(body?.sekkiBoundaryTieBreak) || "after", ["after", "before"], "after");

  return {
    date,
    time: timeRaw || "",
    sex: sex === "F" || sex === "M" ? sex : "",
    birthPlace: { country, pref },
    timeMode,
    dayBoundaryMode,
    boundaryTimeRef,
    sekkiBoundaryPrecision,
    sekkiBoundaryTieBreak,
  };
}

function safeString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeEnum(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

// ------------------------------
// Place / longitude
// ------------------------------
function getPlaceInfo(birthPlace) {
  const pref = safeString(birthPlace?.pref) || "東京都";
  const country = safeString(birthPlace?.country) || "JP";
  const longitude = PREF_LONGITUDE[pref] ?? 139.69;
  const lonCorrectionMin = (longitude - 135.0) * 4.0;
  return { country, pref, longitude: round2(longitude), lonCorrectionMin };
}

const PREF_LONGITUDE = {
  "北海道": 141.35, "青森県": 140.74, "岩手県": 141.15, "宮城県": 140.87, "秋田県": 140.10,
  "山形県": 140.36, "福島県": 140.47, "茨城県": 140.45, "栃木県": 139.88, "群馬県": 139.06,
  "埼玉県": 139.65, "千葉県": 140.12, "東京都": 139.69, "神奈川県": 139.64, "新潟県": 139.02,
  "富山県": 137.21, "石川県": 136.66, "福井県": 136.22, "山梨県": 138.57, "長野県": 138.18,
  "岐阜県": 136.72, "静岡県": 138.38, "愛知県": 136.91, "三重県": 136.51, "滋賀県": 135.87,
  "京都府": 135.76, "大阪府": 135.50, "兵庫県": 135.18, "奈良県": 135.83, "和歌山県": 135.17,
  "鳥取県": 134.24, "島根県": 133.05, "岡山県": 133.93, "広島県": 132.46, "山口県": 131.47,
  "徳島県": 134.56, "香川県": 134.04, "愛媛県": 132.77, "高知県": 133.53, "福岡県": 130.40,
  "佐賀県": 130.30, "長崎県": 129.87, "熊本県": 130.71, "大分県": 131.61, "宮崎県": 131.42,
  "鹿児島県": 130.56, "沖縄県": 127.68,
};

// ------------------------------
// DateTime (JST internal)
// ------------------------------
function parseJstDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map((n) => parseInt(n, 10));
  let hh = 12, mm = 0, ss = 0;
  if (timeStr) {
    const parts = timeStr.split(":").map((n) => parseInt(n, 10));
    hh = parts[0] ?? 0;
    mm = parts[1] ?? 0;
    ss = parts[2] ?? 0;
  }
  const dateObjUtc = new Date(Date.UTC(y, m - 1, d, hh - 9, mm, ss));
  return { y, m, d, hh, mm, ss, dateObjUtc };
}

function computeUsedDateTimeJst(std, timeMode, lonCorrectionMin, eqTimeMin) {
  let addMin = 0;
  if (timeMode === "mean_solar") addMin = lonCorrectionMin;
  if (timeMode === "true_solar") addMin = lonCorrectionMin + eqTimeMin;

  const usedUtcMs = std.dateObjUtc.getTime() + addMin * 60 * 1000;

  const u = new Date(usedUtcMs);
  const jst = new Date(u.getTime() + 9 * 3600 * 1000);

  return {
    y: jst.getUTCFullYear(),
    m: jst.getUTCMonth() + 1,
    d: jst.getUTCDate(),
    hh: jst.getUTCHours(),
    mm: jst.getUTCMinutes(),
    ss: jst.getUTCSeconds(),
    dateObjUtc: u,
  };
}

function toJstSeconds(dt) {
  return Math.floor((dt.dateObjUtc.getTime() + 9 * 3600 * 1000) / 1000);
}

/**
 * ✅ precision反映版：境界「より前か？」判定
 * - minute: floor(sec/60) で比較（分単位）
 * - second: sec で比較（秒単位）
 * - tieBreak:
 *    after  => 同値のとき「前ではない」（= after側に倒す）
 *    before => 同値のとき「前である」（= before側に倒す）
 */
function isBeforeBoundaryPrec(tSecRaw, boundarySecRaw, precision, tieBreak) {
  const t = quantByPrecision(tSecRaw, precision);
  const b = quantByPrecision(boundarySecRaw, precision);

  if (t < b) return true;
  if (t > b) return false;

  // equal at precision
  return tieBreak === "before";
}

/**
 * ✅ precision反映版：境界が「過去側として成立するか？」（直近節の選択用）
 * - t == boundary (同値) の扱いだけ tieBreak に依存
 *   after  => 同値は「既に超えた(過去)」
 *   before => 同値は「まだ超えてない(未来)」
 */
function isBoundaryInPastOrNow(boundarySecRaw, tSecRaw, precision, tieBreak) {
  const t = quantByPrecision(tSecRaw, precision);
  const b = quantByPrecision(boundarySecRaw, precision);

  if (b < t) return true;
  if (b > t) return false;
  return tieBreak === "after";
}

/**
 * ✅ precision反映版：境界が「未来側として成立するか？」（次節の選択用）
 * - t == boundary (同値) の扱いだけ tieBreak に依存
 *   before => 同値は「まだ(未来)」
 *   after  => 同値は「もう(過去)」
 */
function isBoundaryInFutureOrNow(boundarySecRaw, tSecRaw, precision, tieBreak) {
  const t = quantByPrecision(tSecRaw, precision);
  const b = quantByPrecision(boundarySecRaw, precision);

  if (b > t) return true;
  if (b < t) return false;
  return tieBreak === "before";
}

function quantByPrecision(sec, precision) {
  if (precision === "minute") return Math.floor(sec / 60);
  return sec; // "second"
}

function pad2(n) { return String(n).padStart(2, "0"); }
function formatHM(h, m) { return `${pad2(h)}:${pad2(m)}`; }
function formatHMS(h, m, s) { return `${pad2(h)}:${pad2(m)}:${pad2(s)}`; }
function round2(x) { return Math.round(x * 100) / 100; }

// ------------------------------
// Equation of Time (minutes) (NOAA approximation)
// ------------------------------
function computeEquationOfTimeMinutes(dateUtc) {
  const d = new Date(dateUtc.getTime());
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1, 0, 0, 0);
  const doy = Math.floor((d.getTime() - start) / 86400000) + 1;
  const gamma = (2 * Math.PI / 365) * (doy - 1 + (d.getUTCHours() - 12) / 24);

  const eq =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  return eq;
}

// ------------------------------
// Solar longitude (apparent) in degrees (simplified)
// ------------------------------
function solarLongitudeDeg(dateUtc) {
  const jd = toJulianDay(dateUtc);
  const T = (jd - 2451545.0) / 36525.0;

  let L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  L0 = normalizeDeg(L0);

  let M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  M = normalizeDeg(M);

  const Mrad = deg2rad(M);
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);

  const trueLong = L0 + C;

  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(omega));

  return normalizeDeg(lambda);
}

function normalizeDeg(x) {
  let v = x % 360;
  if (v < 0) v += 360;
  return v;
}
function deg2rad(x) { return (x * Math.PI) / 180; }
function toJulianDay(dateUtc) {
  const ms = dateUtc.getTime();
  return ms / 86400000 + 2440587.5;
}

// ------------------------------
// Solar term time finder + MEMOIZED wrapper
// ------------------------------
function getSolarTermCached(year, targetAngleDeg, precision) {
  const key = `${year}|${targetAngleDeg}|${precision}`;
  const hit = TERM_CACHE.get(key);
  if (hit) return hit;

  const val = findSolarTermTimeJst(year, targetAngleDeg, precision);
  TERM_CACHE.set(key, val);
  return val;
}

function findSolarTermTimeJst(year, targetAngleDeg, precision) {
  const guess = guessSolarTermDateJst(year, targetAngleDeg);

  const startUtc = new Date(Date.UTC(guess.y, guess.m - 1, guess.d, 0 - 9, 0, 0));
  const endUtc = new Date(startUtc.getTime() + 8 * 86400000);

  const stepMs = 3600000;
  let t0 = startUtc.getTime();
  let f0 = angleDiffSigned(solarLongitudeDeg(new Date(t0)), targetAngleDeg);

  let t1 = null;

  for (let t = t0 + stepMs; t <= endUtc.getTime(); t += stepMs) {
    const f = angleDiffSigned(solarLongitudeDeg(new Date(t)), targetAngleDeg);
    if ((f0 <= 0 && f >= 0) || (f0 >= 0 && f <= 0)) {
      t1 = t;
      break;
    }
    t0 = t;
    f0 = f;
  }

  if (t1 === null) {
    const start2 = startUtc.getTime() - 5 * 86400000;
    const end2 = endUtc.getTime() + 5 * 86400000;
    t0 = start2;
    f0 = angleDiffSigned(solarLongitudeDeg(new Date(t0)), targetAngleDeg);
    for (let t = t0 + stepMs; t <= end2; t += stepMs) {
      const f = angleDiffSigned(solarLongitudeDeg(new Date(t)), targetAngleDeg);
      if ((f0 <= 0 && f >= 0) || (f0 >= 0 && f <= 0)) {
        t1 = t;
        break;
      }
      t0 = t;
      f0 = f;
    }
  }

  if (t1 === null) {
    const fallbackUtc = new Date(Date.UTC(guess.y, guess.m - 1, guess.d, 12 - 9, 0, 0));
    return formatTermResultJst(fallbackUtc, precision, targetAngleDeg);
  }

  const tolMs = precision === "second" ? 1000 : 60000;

  let lo = Math.min(t0, t1);
  let hi = Math.max(t0, t1);

  for (let i = 0; i < 80 && hi - lo > tolMs; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const fmid = angleDiffSigned(solarLongitudeDeg(new Date(mid)), targetAngleDeg);

    const flo = angleDiffSigned(solarLongitudeDeg(new Date(lo)), targetAngleDeg);
    if ((flo <= 0 && fmid >= 0) || (flo >= 0 && fmid <= 0)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  const resultUtc = new Date(hi);
  return formatTermResultJst(resultUtc, precision, targetAngleDeg);
}

function formatTermResultJst(dateUtc, precision, angle) {
  const jst = new Date(dateUtc.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth() + 1;
  const d = jst.getUTCDate();
  const hh = jst.getUTCHours();
  const mm = jst.getUTCMinutes();
  const ss = jst.getUTCSeconds();

  const timeJst = `${y}-${pad2(m)}-${pad2(d)} ${formatHM(hh, mm)}`;
  const timeJstSec = `${y}-${pad2(m)}-${pad2(d)} ${formatHMS(hh, mm, ss)}`;

  return {
    angle,
    timeJst,
    timeJstSec,
    // secJst は生の秒を保持（比較時に precision で量子化する）
    secJst: Math.floor((dateUtc.getTime() + 9 * 3600 * 1000) / 1000),
  };
}

function angleDiffSigned(lon, target) {
  return (lon - target + 540) % 360 - 180;
}

function guessSolarTermDateJst(year, angle) {
  const map = {
    315: { m: 2, d: 4 },  330: { m: 2, d: 19 }, 345: { m: 3, d: 6 },  0: { m: 3, d: 21 },
    15: { m: 4, d: 5 },  30: { m: 4, d: 20 }, 45: { m: 5, d: 6 },  60: { m: 5, d: 21 },
    75: { m: 6, d: 6 },  90: { m: 6, d: 21 }, 105:{ m: 7, d: 7 },  120:{ m: 7, d: 23 },
    135:{ m: 8, d: 8 },  150:{ m: 8, d: 23 }, 165:{ m: 9, d: 8 },  180:{ m: 9, d: 23 },
    195:{ m:10, d: 8 },  210:{ m:10, d: 23 }, 225:{ m:11, d: 7 },  240:{ m:11, d: 22 },
    255:{ m:12, d: 7 },  270:{ m:12, d: 22 }, 285:{ m: 1, d: 6 },  300:{ m: 1, d: 20 },
  };
  const g = map[Number(angle)] || { m: 3, d: 21 };
  return { y: year, m: g.m, d: g.d };
}

// ------------------------------
// Sekki current (12節 boundaries)
// ------------------------------
const SEKKI_12 = [
  { angle: 315, name: "立春" },
  { angle: 345, name: "啓蟄" },
  { angle: 15,  name: "清明" },
  { angle: 45,  name: "立夏" },
  { angle: 75,  name: "芒種" },
  { angle: 105, name: "小暑" },
  { angle: 135, name: "立秋" },
  { angle: 165, name: "白露" },
  { angle: 195, name: "寒露" },
  { angle: 225, name: "立冬" },
  { angle: 255, name: "大雪" },
  { angle: 285, name: "小寒" },
];

function getCurrentSekkiBoundary(used, precision, tieBreak) {
  const cand = [];
  for (const b of SEKKI_12) {
    const a = getSolarTermCached(used.y, b.angle, precision);
    const b1 = getSolarTermCached(used.y - 1, b.angle, precision);
    cand.push({ ...b, ...a });
    cand.push({ ...b, ...b1 });
  }

  const usedSec = toJstSeconds(used);

  let best = null;
  for (const c of cand) {
    const ok = isBoundaryInPastOrNow(c.secJst, usedSec, precision, tieBreak);
    if (!ok) continue;
    if (!best) best = c;
    else {
      // 直近（= 最大）を選ぶ：precisionに合わせて比較
      const bc = quantByPrecision(best.secJst, precision);
      const cc = quantByPrecision(c.secJst, precision);
      if (cc > bc) best = c;
      else if (cc === bc) {
        // 同値(同じ分/同じ秒)なら、より「実秒が後」の方を採用（デバッグ安定）
        if (c.secJst > best.secJst) best = c;
      }
    }
  }

  if (!best) {
    const fb = getSolarTermCached(used.y - 1, 285, precision);
    best = { angle: 285, name: "小寒", ...fb };
  }

  return {
    name: best.name,
    angle: best.angle,
    timeJst: best.timeJst,
    timeJstSec: best.timeJstSec,
  };
}

// ------------------------------
// Pillars basics
// ------------------------------
const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];

function calcYearPillar(pillarYear) {
  const idx = mod(pillarYear - 1984, 60); // 1984=甲子
  return sexagenaryFromIndex(idx);
}

function calcMonthPillar(used, yearStem, precision, tieBreak) {
  const cur = getCurrentSekkiBoundary(used, precision, tieBreak);
  const monthBranch = monthBranchFromBoundaryAngle(cur.angle);
  const monthStem = monthStemFromYearStem(yearStem, monthBranch);
  return { kan: monthStem, shi: monthBranch };
}

function monthBranchFromBoundaryAngle(angle) {
  const map = {
    315: "寅", 345: "卯", 15: "辰", 45: "巳", 75: "午", 105:"未",
    135: "申", 165: "酉", 195:"戌", 225:"亥", 255:"子", 285:"丑",
  };
  return map[Number(angle)] || "寅";
}

function monthStemFromYearStem(yearStem, monthBranch) {
  const startMap = {
    "甲":"丙","己":"丙",
    "乙":"戊","庚":"戊",
    "丙":"庚","辛":"庚",
    "丁":"壬","壬":"壬",
    "戊":"甲","癸":"甲",
  };
  const startStem = startMap[yearStem] || "丙";

  const order = ["寅","卯","辰","巳","午","未","申","酉","戌","亥","子","丑"];
  const k = order.indexOf(monthBranch);
  const startIdx = STEMS.indexOf(startStem);
  return STEMS[mod(startIdx + (k < 0 ? 0 : k), 10)];
}

function calcDayPillar(std, used, dayBoundaryMode, boundaryTimeRef) {
  const ref = boundaryTimeRef === "standard" ? std : used;

  const boundaryMin = dayBoundaryMode === "23" ? 23 * 60 : 24 * 60;
  const tMin = ref.hh * 60 + ref.mm + ref.ss / 60;

  let y = ref.y, m = ref.m, d = ref.d;
  if (tMin >= boundaryMin) {
    const moved = addDaysJst({ y, m, d }, 1);
    y = moved.y; m = moved.m; d = moved.d;
  }

  const jdn = julianDayNumber(y, m, d);
  const idx = mod(jdn + 47, 60); // calibration: 1990-02-04 => 戊戌（あなたの検証に合わせ）
  return sexagenaryFromIndex(idx);
}

function calcHourPillar(used, dayStem, inputTimeRaw) {
  if (!inputTimeRaw) return null;
  const branch = hourBranchFromTime(used.hh, used.mm);
  const stem = hourStemFromDayStem(dayStem, branch);
  return { kan: stem, shi: branch };
}

function hourBranchFromTime(hh, mm) {
  const t = hh * 60 + mm;
  let idx;
  if (t >= 23 * 60) idx = 0;
  else idx = Math.floor((t + 60) / 120);
  const order = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
  return order[mod(idx, 12)];
}

function hourStemFromDayStem(dayStem, hourBranch) {
  const startMap = {
    "甲":"甲","己":"甲",
    "乙":"丙","庚":"丙",
    "丙":"戊","辛":"戊",
    "丁":"庚","壬":"庚",
    "戊":"壬","癸":"壬",
  };
  const startStem = startMap[dayStem] || "甲";
  const order = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
  const k = order.indexOf(hourBranch);
  const startIdx = STEMS.indexOf(startStem);
  return STEMS[mod(startIdx + (k < 0 ? 0 : k), 10)];
}

// ------------------------------
// Hidden stems (蔵干)
// ------------------------------
const ZOKAN = {
  "子":["癸"],
  "丑":["己","癸","辛"],
  "寅":["甲","丙","戊"],
  "卯":["乙"],
  "辰":["戊","乙","癸"],
  "巳":["丙","戊","庚"],
  "午":["丁","己"],
  "未":["己","丁","乙"],
  "申":["庚","壬","戊"],
  "酉":["辛"],
  "戌":["戊","辛","丁"],
  "亥":["壬","甲"],
};

function getZokan(branch) {
  return ZOKAN[branch] ? [...ZOKAN[branch]] : [];
}

// ------------------------------
// Ten Deity (十神)
// ------------------------------
const STEM_INFO = {
  "甲": { elem:"wood", yin:false },
  "乙": { elem:"wood", yin:true },
  "丙": { elem:"fire", yin:false },
  "丁": { elem:"fire", yin:true },
  "戊": { elem:"earth", yin:false },
  "己": { elem:"earth", yin:true },
  "庚": { elem:"metal", yin:false },
  "辛": { elem:"metal", yin:true },
  "壬": { elem:"water", yin:false },
  "癸": { elem:"water", yin:true },
};

function tenDeityOf(dayStem, otherStem) {
  if (!otherStem) return null;
  const d = STEM_INFO[dayStem];
  const o = STEM_INFO[otherStem];
  if (!d || !o) return null;

  const sameYinYang = d.yin === o.yin;
  const rel = elementRelation(d.elem, o.elem);

  if (rel === "same") return sameYinYang ? "比肩" : "劫財";
  if (rel === "day_creates_other") return sameYinYang ? "食神" : "傷官";
  if (rel === "other_creates_day") return sameYinYang ? "印綬" : "偏印";
  if (rel === "day_controls_other") return sameYinYang ? "正財" : "偏財";
  if (rel === "other_controls_day") return sameYinYang ? "正官" : "七殺";
  return null;
}

function elementRelation(dayElem, otherElem) {
  if (dayElem === otherElem) return "same";
  const gen = { wood:"fire", fire:"earth", earth:"metal", metal:"water", water:"wood" };
  const ctl = { wood:"earth", earth:"water", water:"fire", fire:"metal", metal:"wood" };

  if (gen[dayElem] === otherElem) return "day_creates_other";
  if (gen[otherElem] === dayElem) return "other_creates_day";
  if (ctl[dayElem] === otherElem) return "day_controls_other";
  if (ctl[otherElem] === dayElem) return "other_controls_day";
  return "none";
}

function calcTenDeity(yearStem, monthStem, dayStem, hourStem) {
  return {
    year: tenDeityOf(dayStem, yearStem),
    month: tenDeityOf(dayStem, monthStem),
    day: "日主",
    hour: hourStem ? tenDeityOf(dayStem, hourStem) : null,
  };
}

function calcZokanTenDeity(yearBranch, monthBranch, dayBranch, hourBranch, dayStem) {
  const conv = (br) => getZokan(br).map((s) => ({ stem: s, deity: tenDeityOf(dayStem, s) }));
  return {
    year: conv(yearBranch),
    month: conv(monthBranch),
    day: conv(dayBranch),
    hour: hourBranch ? conv(hourBranch) : [],
  };
}

// ------------------------------
// Five elements counts
// ------------------------------
function calcFiveElementsCounts(stems, branches) {
  const counts = { wood:0, fire:0, earth:0, metal:0, water:0 };

  for (const s of stems) {
    const info = STEM_INFO[s];
    if (info) counts[info.elem] += 1;
  }
  for (const b of branches) {
    for (const z of getZokan(b)) {
      const info = STEM_INFO[z];
      if (info) counts[info.elem] += 1;
    }
  }

  return {
    counts,
    note: "Counted from stems: year/month/day/hour + all hidden stems (zokan).",
  };
}

// ------------------------------
// Luck (大運/年運)
// ------------------------------
function calcLuckAll({ used, sex, yearStem, monthPillar, precision, tieBreak, birthStd }) {
  const direction = calcLuckDirection(sex, yearStem);

  const diffMin = calcStartDiffMinutesToJie(used, direction, precision, tieBreak);

  const startAgeYearsF = diffMin / (3 * 24 * 60);
  const startAgeDetail = toAgeDetail(startAgeYearsF);

  const dayun = buildDayunList(monthPillar, direction);

  const nowJst = nowJstDateParts();
  const ageYears = calcAgeYears(birthStd, nowJst);

  const currentDayunIndex = findCurrentDayunIndex(dayun, ageYears);
  const currentDayun = currentDayunIndex >= 0 ? dayun[currentDayunIndex] : null;

  const nenunYearByRisshun = calcNenunYearByRisshun(nowJst, precision, tieBreak);
  const nenun = buildNenunList(nenunYearByRisshun);

  const currentNenunIndex = nenun.findIndex((x) => x.pillarYear === nenunYearByRisshun);
  const currentNenun = currentNenunIndex >= 0 ? nenun[currentNenunIndex] : null;

  return {
    direction,
    startCalcMode: "jie_diff_minutes_div(3days)",
    startDiffMinutes: Math.round(diffMin),
    startAgeYears: Math.floor(startAgeYearsF),
    startAgeDetail,
    current: {
      asOfDateUsed: null,
      ageYears,
      currentDayunIndex: currentDayunIndex < 0 ? 0 : currentDayunIndex,
      currentNenunIndex: currentNenunIndex < 0 ? 0 : currentNenunIndex,
      nenunYearByRisshun,
    },
    dayun,
    nenun,
    currentNenun,
    currentDayun,
  };
}

function calcLuckDirection(sex, yearStem) {
  const yangStems = new Set(["甲","丙","戊","庚","壬"]);
  const isYang = yangStems.has(yearStem);
  if (sex === "M") return isYang ? "forward" : "backward";
  if (sex === "F") return isYang ? "backward" : "forward";
  return "backward";
}

function calcStartDiffMinutesToJie(used, direction, precision, tieBreak) {
  const cand = [];
  for (const b of SEKKI_12) {
    const prev = getSolarTermCached(used.y - 1, b.angle, precision);
    const cur  = getSolarTermCached(used.y, b.angle, precision);
    const next = getSolarTermCached(used.y + 1, b.angle, precision);
    cand.push({ ...b, ...prev }, { ...b, ...cur }, { ...b, ...next });
  }

  const usedSec = toJstSeconds(used);

  if (direction === "forward") {
    // 次の節まで
    let best = null;
    for (const c of cand) {
      const ok = isBoundaryInFutureOrNow(c.secJst, usedSec, precision, tieBreak);
      if (!ok) continue;

      if (!best) best = c;
      else {
        const bc = quantByPrecision(best.secJst, precision);
        const cc = quantByPrecision(c.secJst, precision);
        if (cc < bc) best = c;
        else if (cc === bc && c.secJst < best.secJst) best = c;
      }
    }
    if (!best) {
      best = cand.sort((a, b) => a.secJst - b.secJst)[0];
    }

    return (best.secJst - usedSec) / 60;
  } else {
    // 直前の節から
    let best = null;
    for (const c of cand) {
      const ok = isBoundaryInPastOrNow(c.secJst, usedSec, precision, tieBreak);
      if (!ok) continue;

      if (!best) best = c;
      else {
        const bc = quantByPrecision(best.secJst, precision);
        const cc = quantByPrecision(c.secJst, precision);
        if (cc > bc) best = c;
        else if (cc === bc && c.secJst > best.secJst) best = c;
      }
    }
    if (!best) {
      best = cand.sort((a, b) => b.secJst - a.secJst)[0];
    }

    return (usedSec - best.secJst) / 60;
  }
}

function toAgeDetail(yearsFloat) {
  const y = Math.floor(yearsFloat);
  const remY = yearsFloat - y;
  const monthsFloat = remY * 12;
  const mo = Math.floor(monthsFloat);
  const remM = monthsFloat - mo;
  const days = Math.round(remM * 30);
  return { years: y, months: mo, days };
}

function buildDayunList(monthPillar, direction) {
  const list = [];
  let idx = sexagenaryIndex(monthPillar.kan, monthPillar.shi);
  idx = direction === "forward" ? mod(idx + 1, 60) : mod(idx - 1, 60);

  for (let i = 0; i < 10; i++) {
    const p = sexagenaryFromIndex(idx);
    list.push({
      kan: p.kan,
      shi: p.shi,
      tenDeity: tenDeityOf(monthPillar.kan, p.kan) || null,
      ageFrom: i * 10,
      ageTo: i * 10 + 10,
    });
    idx = direction === "forward" ? mod(idx + 1, 60) : mod(idx - 1, 60);
  }
  return list;
}

function nowJstDateParts() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return {
    y: jst.getUTCFullYear(),
    m: jst.getUTCMonth() + 1,
    d: jst.getUTCDate(),
    hh: jst.getUTCHours(),
    mm: jst.getUTCMinutes(),
    ss: jst.getUTCSeconds(),
  };
}

function calcAgeYears(birthStd, nowJst) {
  const b = new Date(Date.UTC(birthStd.y, birthStd.m - 1, birthStd.d, 0, 0, 0));
  const n = new Date(Date.UTC(nowJst.y, nowJst.m - 1, nowJst.d, 0, 0, 0));
  const diffDays = Math.floor((n.getTime() - b.getTime()) / 86400000);
  return Math.floor(diffDays / 365.2425);
}

function findCurrentDayunIndex(dayun, ageYears) {
  for (let i = 0; i < dayun.length; i++) {
    if (ageYears >= dayun[i].ageFrom && ageYears < dayun[i].ageTo) return i;
  }
  return -1;
}

function calcNenunYearByRisshun(nowJst, precision, tieBreak) {
  const risshun = getSolarTermCached(nowJst.y, 315, precision);
  const nowUtc = Date.UTC(nowJst.y, nowJst.m - 1, nowJst.d, nowJst.hh - 9, nowJst.mm, nowJst.ss);
  const nowSecJst = Math.floor((nowUtc + 9 * 3600 * 1000) / 1000);

  const before = isBeforeBoundaryPrec(nowSecJst, risshun.secJst, precision, tieBreak);
  return before ? (nowJst.y - 1) : nowJst.y;
}

function buildNenunList(centerYearByRisshun) {
  const list = [];
  for (let y = centerYearByRisshun - 6; y <= centerYearByRisshun + 6; y++) {
    const p = calcYearPillar(y);
    list.push({ pillarYear: y, kan: p.kan, shi: p.shi, tenDeity: null });
  }
  return list;
}

// ------------------------------
// Sexagenary helpers
// ------------------------------
function mod(a, m) { return ((a % m) + m) % m; }

function sexagenaryFromIndex(idx) {
  return { kan: STEMS[idx % 10], shi: BRANCHES[idx % 12] };
}

function sexagenaryIndex(kan, shi) {
  for (let i = 0; i < 60; i++) {
    const p = sexagenaryFromIndex(i);
    if (p.kan === kan && p.shi === shi) return i;
  }
  return 0;
}

function julianDayNumber(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 + Math.floor(y2 / 4) - Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045;
}

function addDaysJst(ymd, add) {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0));
  const dt2 = new Date(dt.getTime() + add * 86400000);
  return { y: dt2.getUTCFullYear(), m: dt2.getUTCMonth() + 1, d: dt2.getUTCDate() };
}
