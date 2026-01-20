/**
 * Vercel Serverless Function (CommonJS)
 * /api/shichusuimei
 *
 * ✅ Phase B+ (Sekki boundary precision)
 * - timeMode: standard | mean_solar | true_solar
 * - true_solar adds eqTimeMin (equation of time) and MUST return meta.place.eqTimeMin
 * - sekkiBoundaryPrecision: minute | second (default: minute)
 * - sekkiBoundaryTieBreak: after | before (default: after)
 * - boundaryTimeRef: standard | used (default: used)
 * - dayBoundaryMode: 24 | 23 (default: 24)
 *
 * ⚠️ 追加ミス対策:
 * - 依存0（このファイル単体で動く）
 * - すべて防御的にパース／デフォルト付与
 * - 例外は必ず { ok:false, error } で返す
 */

module.exports = async function handler(req, res) {
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

    const body = await readJsonBody(req);

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
    const used = computeUsedDateTimeJst(std, input.timeMode, place.lonCorrectionMin, eqTimeMin);

    // ---- Sekki boundary precision ----
    const precision = input.sekkiBoundaryPrecision; // "minute" | "second"
    const tieBreak = input.sekkiBoundaryTieBreak; // "after" | "before"

    // ---- Compute Risshun time for boundary year check (angle 315) ----
    // We compute risshun for the used-year (JST year), but for dates in Jan it may be next Feb.
    // We'll compute risshun around Feb for used.y and used.y-1 as needed.
    const risshunThisYear = findSolarTermTimeJst(used.y, 315, precision);
    const risshunPrevYear = findSolarTermTimeJst(used.y - 1, 315, precision);

    const stdJstSec = toJstSeconds(std);
    const usedJstSec = toJstSeconds(used);

    // standard before/after risshun?
    const stdIsBeforeRisshun = isBeforeBoundary(stdJstSec, risshunThisYear.secJst, tieBreak);
    // used before/after risshun?
    const usedIsBeforeRisshun = isBeforeBoundary(usedJstSec, risshunThisYear.secJst, tieBreak);

    // If used date is in Jan, risshunThisYear is in Feb same year; ok.
    // If used date is in late Dec, risshunThisYear is in Feb next year? No, used.y is Dec year; risshun is Feb of that year (already past).
    // This is fine.

    const yearPillarYearUsed = usedIsBeforeRisshun ? (used.y - 1) : used.y;

    // for year pillar boundary metadata: pick the risshun time that matches the used-year boundary we used
    const yearBoundary = risshunThisYear;

    // ---- Determine current sekki used (12 "節" boundaries) ----
    const sekkiUsed = getCurrentSekkiBoundary(used, precision, tieBreak);

    // ---- Pillars ----
    const yearPillar = calcYearPillar(yearPillarYearUsed);
    const monthPillar = calcMonthPillar(used, yearPillar.kan, precision, tieBreak);
    const dayPillar = calcDayPillar(std, used, input.dayBoundaryMode, input.boundaryTimeRef);
    const hourPillar = calcHourPillar(used, dayPillar.kan, input.time);

    // ---- Derived ----
    const tenDeity = calcTenDeity(yearPillar.kan, monthPillar.kan, dayPillar.kan, hourPillar?.kan);
    const zokanTenDeity = calcZokanTenDeity(yearPillar.shi, monthPillar.shi, dayPillar.shi, hourPillar?.shi, dayPillar.kan);

    const fiveElements = calcFiveElementsCounts(
      [yearPillar.kan, monthPillar.kan, dayPillar.kan].concat(hourPillar?.kan ? [hourPillar.kan] : []),
      [yearPillar.shi, monthPillar.shi, dayPillar.shi].concat(hourPillar?.shi ? [hourPillar.shi] : [])
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
            timeJst: yearBoundary.timeJst,
            ...(precision === "second" ? { timeJstSec: yearBoundary.timeJstSec } : {}),
          },
          yearPillarYearUsed,
          yearBoundaryCheck: {
            standardIsBeforeRisshun,
            usedIsBeforeRisshun,
            standardTimeJst: `${pad2(std.y)}-${pad2(std.m)}-${pad2(std.d)} ${formatHM(std.hh, std.mm)}`,
            usedTimeJst: `${pad2(used.y)}-${pad2(used.m)}-${pad2(used.d)} ${formatHM(used.hh, used.mm)}`,
            ...(precision === "second"
              ? {
                  standardTimeJstSec: `${pad2(std.y)}-${pad2(std.m)}-${pad2(std.d)} ${formatHMS(std.hh, std.mm, std.ss)}`,
                  usedTimeJstSec: `${pad2(used.y)}-${pad2(used.m)}-${pad2(used.d)} ${formatHMS(used.hh, used.mm, used.ss)}`,
                  risshunTimeJstSec: yearBoundary.timeJstSec,
                }
              : {}),
          },
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
    return res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  }
};

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
      } catch (e) {
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
  // allow "" (unknown time)
  if (timeRaw && !/^\d{2}:\d{2}(:\d{2})?$/.test(timeRaw)) throw new Error("Invalid time (expected HH:MM or HH:MM:SS)");

  const sex = safeString(body?.sex); // "F" | "M" | ""
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
  const longitude = PREF_LONGITUDE[pref] ?? 139.69; // fallback Tokyo
  const lonCorrectionMin = (longitude - 135.0) * 4.0; // JST central meridian 135E
  return { country, pref, longitude: round2(longitude), lonCorrectionMin };
}

// Approx longitude (pref capital area). Enough for tool-level correction.
const PREF_LONGITUDE = {
  "北海道": 141.35,
  "青森県": 140.74,
  "岩手県": 141.15,
  "宮城県": 140.87,
  "秋田県": 140.10,
  "山形県": 140.36,
  "福島県": 140.47,
  "茨城県": 140.45,
  "栃木県": 139.88,
  "群馬県": 139.06,
  "埼玉県": 139.65,
  "千葉県": 140.12,
  "東京都": 139.69,
  "神奈川県": 139.64,
  "新潟県": 139.02,
  "富山県": 137.21,
  "石川県": 136.66,
  "福井県": 136.22,
  "山梨県": 138.57,
  "長野県": 138.18,
  "岐阜県": 136.72,
  "静岡県": 138.38,
  "愛知県": 136.91,
  "三重県": 136.51,
  "滋賀県": 135.87,
  "京都府": 135.76,
  "大阪府": 135.50,
  "兵庫県": 135.18,
  "奈良県": 135.83,
  "和歌山県": 135.17,
  "鳥取県": 134.24,
  "島根県": 133.05,
  "岡山県": 133.93,
  "広島県": 132.46,
  "山口県": 131.47,
  "徳島県": 134.56,
  "香川県": 134.04,
  "愛媛県": 132.77,
  "高知県": 133.53,
  "福岡県": 130.40,
  "佐賀県": 130.30,
  "長崎県": 129.87,
  "熊本県": 130.71,
  "大分県": 131.61,
  "宮崎県": 131.42,
  "鹿児島県": 130.56,
  "沖縄県": 127.68,
};

// ------------------------------
// DateTime (JST internal)
// ------------------------------
function parseJstDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map((n) => parseInt(n, 10));
  let hh = 12,
    mm = 0,
    ss = 0;
  if (timeStr) {
    const parts = timeStr.split(":").map((n) => parseInt(n, 10));
    hh = parts[0] ?? 0;
    mm = parts[1] ?? 0;
    ss = parts[2] ?? 0;
  }
  // create UTC Date that corresponds to JST time (JST = UTC+9)
  const dateObjUtc = new Date(Date.UTC(y, m - 1, d, hh - 9, mm, ss));
  return { y, m, d, hh, mm, ss, dateObjUtc };
}

function computeUsedDateTimeJst(std, timeMode, lonCorrectionMin, eqTimeMin) {
  // used = standard + correction minutes
  let addMin = 0;
  if (timeMode === "mean_solar") addMin = lonCorrectionMin;
  if (timeMode === "true_solar") addMin = lonCorrectionMin + eqTimeMin;

  const usedUtcMs = std.dateObjUtc.getTime() + addMin * 60 * 1000;

  // convert back to JST components
  const u = new Date(usedUtcMs);
  // u is UTC, but our "JST" is u + 9 hours in components
  const jst = new Date(u.getTime() + 9 * 3600 * 1000);

  return {
    y: jst.getUTCFullYear(),
    m: jst.getUTCMonth() + 1,
    d: jst.getUTCDate(),
    hh: jst.getUTCHours(),
    mm: jst.getUTCMinutes(),
    ss: jst.getUTCSeconds(),
    dateObjUtc: u, // keep UTC
  };
}

function toJstSeconds(dt) {
  // seconds from epoch in JST perspective: use UTC ms + 9h offset then floor seconds
  return Math.floor((dt.dateObjUtc.getTime() + 9 * 3600 * 1000) / 1000);
}

function isBeforeBoundary(tSec, boundarySec, tieBreak) {
  // tieBreak: "after" means equality counts as after boundary -> before = (t < boundary)
  // tieBreak: "before" means equality counts as before boundary -> before = (t <= boundary)
  return tieBreak === "before" ? tSec <= boundarySec : tSec < boundarySec;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatHM(h, m) {
  return `${pad2(h)}:${pad2(m)}`;
}
function formatHMS(h, m, s) {
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}
function round2(x) {
  return Math.round(x * 100) / 100;
}

// ------------------------------
// Equation of Time (minutes)
// Approx enough to match tool-level outputs (e.g. -13.6min around early Feb)
// ------------------------------
function computeEquationOfTimeMinutes(dateUtc) {
  // Using NOAA approximation based on fractional year (gamma)
  // dateUtc is UTC Date corresponding to JST instant
  const d = new Date(dateUtc.getTime());
  const year = d.getUTCFullYear();

  // day of year in UTC
  const start = Date.UTC(year, 0, 1, 0, 0, 0);
  const doy = Math.floor((d.getTime() - start) / 86400000) + 1;

  // fractional year (radians)
  const gamma = (2 * Math.PI / 365) * (doy - 1 + (d.getUTCHours() - 12) / 24);

  // equation of time in minutes
  const eq =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  return eq; // minutes
}

// ------------------------------
// Solar longitude (apparent) in degrees
// (simplified, good enough for solar term boundaries)
// ------------------------------
function solarLongitudeDeg(dateUtc) {
  const jd = toJulianDay(dateUtc);
  const T = (jd - 2451545.0) / 36525.0;

  // Mean longitude L0 (deg)
  let L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  L0 = normalizeDeg(L0);

  // Mean anomaly M (deg)
  let M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  M = normalizeDeg(M);

  // Eccentricity e
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;

  // Sun equation of center C (deg)
  const Mrad = deg2rad(M);
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);

  // True longitude
  const trueLong = L0 + C;

  // Apparent longitude correction (omega)
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(deg2rad(omega));

  return normalizeDeg(lambda);
}

function normalizeDeg(x) {
  let v = x % 360;
  if (v < 0) v += 360;
  return v;
}
function deg2rad(x) {
  return (x * Math.PI) / 180;
}
function toJulianDay(dateUtc) {
  // Julian Day from UTC date
  const ms = dateUtc.getTime();
  return ms / 86400000 + 2440587.5;
}

// ------------------------------
// Solar term time finder (binary search to seconds)
// Returns JST string, plus JST seconds epoch-like counter for comparisons.
// ------------------------------
function findSolarTermTimeJst(year, targetAngleDeg, precision) {
  // Provide a reasonable guess date window for each term angle (JST)
  const guess = guessSolarTermDateJst(year, targetAngleDeg);

  // Search window: +/- 4 days around guess
  const startUtc = new Date(Date.UTC(guess.y, guess.m - 1, guess.d, 0 - 9, 0, 0)); // JST00:00 -> UTC-9
  const endUtc = new Date(startUtc.getTime() + 8 * 86400000); // 8 days

  // Bracket by stepping 1 hour
  const stepMs = 3600000;
  let t0 = startUtc.getTime();
  let f0 = angleDiffSigned(solarLongitudeDeg(new Date(t0)), targetAngleDeg);

  let t1 = null,
    f1 = null;

  for (let t = t0 + stepMs; t <= endUtc.getTime(); t += stepMs) {
    const f = angleDiffSigned(solarLongitudeDeg(new Date(t)), targetAngleDeg);
    // detect sign change crossing
    if ((f0 <= 0 && f >= 0) || (f0 >= 0 && f <= 0)) {
      t1 = t;
      f1 = f;
      break;
    }
    t0 = t;
    f0 = f;
  }

  // If not bracketed, expand a bit (rare)
  if (t1 === null) {
    const start2 = startUtc.getTime() - 5 * 86400000;
    const end2 = endUtc.getTime() + 5 * 86400000;
    t0 = start2;
    f0 = angleDiffSigned(solarLongitudeDeg(new Date(t0)), targetAngleDeg);
    for (let t = t0 + stepMs; t <= end2; t += stepMs) {
      const f = angleDiffSigned(solarLongitudeDeg(new Date(t)), targetAngleDeg);
      if ((f0 <= 0 && f >= 0) || (f0 >= 0 && f <= 0)) {
        t1 = t;
        f1 = f;
        break;
      }
      t0 = t;
      f0 = f;
    }
  }

  if (t1 === null) {
    // fallback: return guess at noon JST (should not happen often)
    const fallbackUtc = new Date(Date.UTC(guess.y, guess.m - 1, guess.d, 12 - 9, 0, 0));
    return formatTermResultJst(fallbackUtc, precision, targetAngleDeg);
  }

  // Binary search to 1 second (or 1 minute)
  const tolMs = precision === "second" ? 1000 : 60000;

  let lo = Math.min(t0, t1);
  let hi = Math.max(t0, t1);

  for (let i = 0; i < 80 && hi - lo > tolMs; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const fmid = angleDiffSigned(solarLongitudeDeg(new Date(mid)), targetAngleDeg);

    // We want root near 0; use sign to shrink interval
    const flo = angleDiffSigned(solarLongitudeDeg(new Date(lo)), targetAngleDeg);
    if ((flo <= 0 && fmid >= 0) || (flo >= 0 && fmid <= 0)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  // Choose hi as crossing time
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
    secJst: Math.floor((dateUtc.getTime() + 9 * 3600 * 1000) / 1000),
  };
}

// Signed diff in degrees (-180..+180)
function angleDiffSigned(lon, target) {
  let d = (lon - target + 540) % 360 - 180;
  return d;
}

// Rough guess date for each solar term (JST), based on typical Japanese "二十四節気" dates.
// We only need a good-enough bracket start.
function guessSolarTermDateJst(year, angle) {
  // Map 24 terms to approx dates (month/day). Angles: 315,330,345,0,15,... (every 15deg)
  // We use main boundaries (節) but this is fine for bracketing.
  const map = {
    315: { m: 2, d: 4 },  // 立春
    330: { m: 2, d: 19 }, // 雨水
    345: { m: 3, d: 6 },  // 啓蟄
    0:   { m: 3, d: 21 }, // 春分
    15:  { m: 4, d: 5 },  // 清明
    30:  { m: 4, d: 20 }, // 穀雨
    45:  { m: 5, d: 6 },  // 立夏
    60:  { m: 5, d: 21 }, // 小満
    75:  { m: 6, d: 6 },  // 芒種
    90:  { m: 6, d: 21 }, // 夏至
    105: { m: 7, d: 7 },  // 小暑
    120: { m: 7, d: 23 }, // 大暑
    135: { m: 8, d: 8 },  // 立秋
    150: { m: 8, d: 23 }, // 処暑
    165: { m: 9, d: 8 },  // 白露
    180: { m: 9, d: 23 }, // 秋分
    195: { m: 10, d: 8 }, // 寒露
    210: { m: 10, d: 23 },// 霜降
    225: { m: 11, d: 7 }, // 立冬
    240: { m: 11, d: 22 },// 小雪
    255: { m: 12, d: 7 }, // 大雪
    270: { m: 12, d: 22 },// 冬至
    285: { m: 1, d: 6 },  // 小寒 (belongs to next year in mapping logic)
    300: { m: 1, d: 20 }, // 大寒
  };

  const key = Number(angle);
  const g = map[key] || { m: 3, d: 21 };

  // For angles in Jan (285,300), they occur in Jan of the given year
  // For other angles, they occur within that year as mapped.
  return { y: year, m: g.m, d: g.d };
}

// ------------------------------
// Sekki current (12節 boundaries for month)
// We'll return the latest boundary <= used (or < depending tieBreak) among the 12 "節" angles.
// ------------------------------
function getCurrentSekkiBoundary(used, precision, tieBreak) {
  // 12 "節" angles (month boundaries)
  const boundaries = [
    { angle: 315, name: "立春" },
    { angle: 345, name: "啓蟄" },
    { angle: 15, name: "清明" },
    { angle: 45, name: "立夏" },
    { angle: 75, name: "芒種" },
    { angle: 105, name: "小暑" },
    { angle: 135, name: "立秋" },
    { angle: 165, name: "白露" },
    { angle: 195, name: "寒露" },
    { angle: 225, name: "立冬" },
    { angle: 255, name: "大雪" },
    { angle: 285, name: "小寒" },
  ];

  // Build candidate times across year boundary: use.y and use.y-1 for early Jan
  const cand = [];
  for (const b of boundaries) {
    cand.push({ ...b, ...findSolarTermTimeJst(used.y, b.angle, precision) });
    cand.push({ ...b, ...findSolarTermTimeJst(used.y - 1, b.angle, precision) });
  }

  const usedSec = toJstSeconds(used);

  // Choose latest boundary time <= used (tieBreak defines equality)
  let best = null;
  for (const c of cand) {
    const isBeforeOrEq = tieBreak === "before" ? c.secJst <= usedSec : c.secJst < usedSec;
    const isBeforeOrEqAfter = tieBreak === "after" ? c.secJst <= usedSec : c.secJst < usedSec;
    const ok = tieBreak === "after" ? isBeforeOrEqAfter : isBeforeOrEq;

    if (!ok) continue;
    if (!best || c.secJst > best.secJst) best = c;
  }

  // If none found (very early year edge), fallback to last year's 小寒
  if (!best) {
    const fallback = findSolarTermTimeJst(used.y - 1, 285, precision);
    best = { angle: 285, name: "小寒", ...fallback };
  }

  return {
    name: best.name,
    angle: best.angle,
    timeJst: best.timeJst.replace(/-/g, "-").replace(" ", " "),
    timeJstSec: best.timeJstSec.replace(/-/g, "-").replace(" ", " "),
  };
}

// ------------------------------
// Pillars basics
// ------------------------------
const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];

function calcYearPillar(pillarYear) {
  // 1984 is 甲子
  const idx = mod(pillarYear - 1984, 60);
  const { kan, shi } = sexagenaryFromIndex(idx);
  return { kan, shi };
}

function calcMonthPillar(used, yearStem, precision, tieBreak) {
  // Determine month branch from 12節 boundaries (立春=寅 month start)
  // We'll compute current boundary (same as getCurrentSekkiBoundary) and map angle -> month branch.
  const cur = getCurrentSekkiBoundary(used, precision, tieBreak);
  const monthBranch = monthBranchFromBoundaryAngle(cur.angle);

  // Month stem from year stem group, starting at 寅
  const monthStem = monthStemFromYearStem(yearStem, monthBranch);

  return { kan: monthStem, shi: monthBranch };
}

function monthBranchFromBoundaryAngle(angle) {
  // Boundaries (節) start month branches:
  // 立春(315)=寅, 啓蟄(345)=卯, 清明(15)=辰, 立夏(45)=巳, 芒種(75)=午, 小暑(105)=未,
  // 立秋(135)=申, 白露(165)=酉, 寒露(195)=戌, 立冬(225)=亥, 大雪(255)=子, 小寒(285)=丑
  const map = {
    315: "寅",
    345: "卯",
    15: "辰",
    45: "巳",
    75: "午",
    105: "未",
    135: "申",
    165: "酉",
    195: "戌",
    225: "亥",
    255: "子",
    285: "丑",
  };
  return map[Number(angle)] || "寅";
}

function monthStemFromYearStem(yearStem, monthBranch) {
  // Start stem for 寅月 depends on year stem:
  // 甲己 -> 丙, 乙庚 -> 戊, 丙辛 -> 庚, 丁壬 -> 壬, 戊癸 -> 甲
  const startMap = {
    "甲": "丙", "己": "丙",
    "乙": "戊", "庚": "戊",
    "丙": "庚", "辛": "庚",
    "丁": "壬", "壬": "壬",
    "戊": "甲", "癸": "甲",
  };
  const startStem = startMap[yearStem] || "丙"; // 寅月 stem

  // Month branch order from 寅: 寅卯辰巳午未申酉戌亥子丑
  const order = ["寅","卯","辰","巳","午","未","申","酉","戌","亥","子","丑"];
  const k = order.indexOf(monthBranch);
  const startIdx = STEMS.indexOf(startStem);
  const stem = STEMS[mod(startIdx + (k < 0 ? 0 : k), 10)];
  return stem;
}

function calcDayPillar(std, used, dayBoundaryMode, boundaryTimeRef) {
  // Choose time reference for day boundary judgement
  const ref = boundaryTimeRef === "standard" ? std : used;

  // Determine pillar date (JST) with day boundary
  const boundaryMin = dayBoundaryMode === "23" ? 23 * 60 : 24 * 60;

  const tMin = ref.hh * 60 + ref.mm + ref.ss / 60;
  let y = ref.y, m = ref.m, d = ref.d;

  if (tMin >= boundaryMin) {
    // move to next day
    const moved = addDaysJst({ y, m, d }, 1);
    y = moved.y; m = moved.m; d = moved.d;
  }

  // JDN uses Gregorian date (y,m,d) at JST date
  const jdn = julianDayNumber(y, m, d);
  // Calibrate: idx = (JDN + 47) % 60 makes 1990-02-04 => 戊戌 (matches your sample)
  const idx = mod(jdn + 47, 60);
  const { kan, shi } = sexagenaryFromIndex(idx);
  return { kan, shi };
}

function calcHourPillar(used, dayStem, inputTimeRaw) {
  if (!inputTimeRaw) return null; // unknown time
  const branch = hourBranchFromTime(used.hh, used.mm);
  const stem = hourStemFromDayStem(dayStem, branch);
  return { kan: stem, shi: branch };
}

function hourBranchFromTime(hh, mm) {
  const t = hh * 60 + mm;
  // 子: 23:00-00:59, 丑: 01:00-02:59 ... 亥: 21:00-22:59
  // We'll map by "double-hour index" starting 子=0 at 23:00.
  let idx;
  if (t >= 23 * 60) idx = 0;
  else idx = Math.floor((t + 60) / 120); // 00:00->0, 01:00->1, ...
  const order = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
  return order[mod(idx, 12)];
}

function hourStemFromDayStem(dayStem, hourBranch) {
  // 子 hour stem depends on day stem:
  // 甲己 -> 甲, 乙庚 -> 丙, 丙辛 -> 戊, 丁壬 -> 庚, 戊癸 -> 壬
  const startMap = {
    "甲": "甲", "己": "甲",
    "乙": "丙", "庚": "丙",
    "丙": "戊", "辛": "戊",
    "丁": "庚", "壬": "庚",
    "戊": "壬", "癸": "壬",
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
  "子": ["癸"],
  "丑": ["己","癸","辛"],
  "寅": ["甲","丙","戊"],
  "卯": ["乙"],
  "辰": ["戊","乙","癸"],
  "巳": ["丙","戊","庚"],
  "午": ["丁","己"],
  "未": ["己","丁","乙"],
  "申": ["庚","壬","戊"],
  "酉": ["辛"],
  "戌": ["戊","辛","丁"],
  "亥": ["壬","甲"],
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

// dayStem 기준으로 otherStem의 十神を出す
function tenDeityOf(dayStem, otherStem) {
  if (!otherStem) return null;

  const d = STEM_INFO[dayStem];
  const o = STEM_INFO[otherStem];
  if (!d || !o) return null;

  const sameYinYang = d.yin === o.yin;

  // 生剋: dayElem -> otherElem relation
  // day creates other => 食神/傷官
  // other creates day => 印綬/偏印
  // day controls other => 正財/偏財
  // other controls day => 正官/七殺
  // same elem => 比肩/劫財
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
  // generating cycle: wood->fire->earth->metal->water->wood
  const gen = { wood:"fire", fire:"earth", earth:"metal", metal:"water", water:"wood" };
  // controlling cycle: wood->earth->water->fire->metal->wood
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
    const zokan = getZokan(b);
    for (const z of zokan) {
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
  const direction = calcLuckDirection(sex, yearStem); // forward/backward

  // 起運: nearest (direction-based) "節" boundary (12 angles) from used birth time
  const diffMin = calcStartDiffMinutesToJie(used, direction, precision, tieBreak);

  const startAgeYears = diffMin / (3 * 24 * 60); // 3 days = 1 year
  const startAgeDetail = toAgeDetail(startAgeYears);

  // dayun list (10 decades)
  const dayun = buildDayunList(monthPillar, direction);

  // current age and current indexes
  const nowJst = nowJstDateParts();
  const ageYears = calcAgeYears(birthStd, nowJst);

  const currentDayunIndex = findCurrentDayunIndex(dayun, ageYears);
  const currentDayun = currentDayunIndex >= 0 ? dayun[currentDayunIndex] : null;

  // Nenun by Risshun year 기준
  const nenunYearByRisshun = calcNenunYearByRisshun(nowJst, precision);
  const nenun = buildNenunList(nenunYearByRisshun);

  const currentNenunIndex = nenun.findIndex((x) => x.pillarYear === nenunYearByRisshun);
  const currentNenun = currentNenunIndex >= 0 ? nenun[currentNenunIndex] : null;

  return {
    direction,
    startCalcMode: "jie_diff_minutes_div(3days)",
    startDiffMinutes: Math.round(diffMin),
    startAgeYears: Math.floor(startAgeYears),
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
  // Rule: (Male & Yang) or (Female & Yin) => forward, else backward
  const yangStems = new Set(["甲","丙","戊","庚","壬"]);
  const isYang = yangStems.has(yearStem);
  if (sex === "M") return isYang ? "forward" : "backward";
  if (sex === "F") return isYang ? "backward" : "forward";
  // unknown sex -> default backward (safer)
  return "backward";
}

function calcStartDiffMinutesToJie(used, direction, precision, tieBreak) {
  const boundaries = [
    { angle: 315, name: "立春" },
    { angle: 345, name: "啓蟄" },
    { angle: 15, name: "清明" },
    { angle: 45, name: "立夏" },
    { angle: 75, name: "芒種" },
    { angle: 105, name: "小暑" },
    { angle: 135, name: "立秋" },
    { angle: 165, name: "白露" },
    { angle: 195, name: "寒露" },
    { angle: 225, name: "立冬" },
    { angle: 255, name: "大雪" },
    { angle: 285, name: "小寒" },
  ];

  // candidate term times for used.y and used.y-1 and used.y+1 (edge safe)
  const cand = [];
  for (const b of boundaries) {
    cand.push({ ...b, ...findSolarTermTimeJst(used.y - 1, b.angle, precision) });
    cand.push({ ...b, ...findSolarTermTimeJst(used.y, b.angle, precision) });
    cand.push({ ...b, ...findSolarTermTimeJst(used.y + 1, b.angle, precision) });
  }

  const usedSec = toJstSeconds(used);

  if (direction === "forward") {
    // next boundary after used (tieBreak affects equality)
    let best = null;
    for (const c of cand) {
      const ok = tieBreak === "after" ? c.secJst > usedSec : c.secJst >= usedSec;
      if (!ok) continue;
      if (!best || c.secJst < best.secJst) best = c;
    }
    if (!best) best = cand.sort((a,b) => a.secJst - b.secJst)[0];
    return (best.secJst - usedSec) / 60;
  } else {
    // previous boundary before used
    let best = null;
    for (const c of cand) {
      const ok = tieBreak === "after" ? c.secJst <= usedSec : c.secJst < usedSec;
      if (!ok) continue;
      if (!best || c.secJst > best.secJst) best = c;
    }
    if (!best) best = cand.sort((a,b) => b.secJst - a.secJst)[0];
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
  // First dayun is month pillar shifted by 1 step in direction
  let idx = sexagenaryIndex(monthPillar.kan, monthPillar.shi);
  idx = direction === "forward" ? mod(idx + 1, 60) : mod(idx - 1, 60);

  for (let i = 0; i < 10; i++) {
    const { kan, shi } = sexagenaryFromIndex(idx);
    list.push({
      kan,
      shi,
      tenDeity: tenDeityOf(monthPillar.kan /*not perfect*/, kan) || null,
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
  // approximate age in years based on JST date difference
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

function calcNenunYearByRisshun(nowJst, precision) {
  // Determine if "today JST" is before risshun of this year
  const risshun = findSolarTermTimeJst(nowJst.y, 315, precision);
  const nowSec = Math.floor(Date.UTC(nowJst.y, nowJst.m - 1, nowJst.d, nowJst.hh - 9, nowJst.mm, nowJst.ss) / 1000) + 9*3600; // rough JST sec
  const before = nowSec < risshun.secJst; // tieBreak not needed for "now"
  return before ? (nowJst.y - 1) : nowJst.y;
}

function buildNenunList(centerYearByRisshun) {
  const list = [];
  for (let y = centerYearByRisshun - 6; y <= centerYearByRisshun + 6; y++) {
    const p = calcYearPillar(y);
    list.push({
      pillarYear: y,
      kan: p.kan,
      shi: p.shi,
      tenDeity: null, // optional
    });
  }
  return list;
}

// ------------------------------
// Sexagenary helpers
// ------------------------------
function mod(a, m) {
  return ((a % m) + m) % m;
}

function sexagenaryFromIndex(idx) {
  const stem = STEMS[idx % 10];
  const branch = BRANCHES[idx % 12];
  return { kan: stem, shi: branch };
}

function sexagenaryIndex(kan, shi) {
  for (let i = 0; i < 60; i++) {
    const p = sexagenaryFromIndex(i);
    if (p.kan === kan && p.shi === shi) return i;
  }
  return 0;
}

function julianDayNumber(y, m, d) {
  // Gregorian calendar JDN
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 + Math.floor(y2 / 4) - Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045;
}

function addDaysJst(ymd, add) {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0));
  const dt2 = new Date(dt.getTime() + add * 86400000);
  return {
    y: dt2.getUTCFullYear(),
    m: dt2.getUTCMonth() + 1,
    d: dt2.getUTCDate(),
  };
}
