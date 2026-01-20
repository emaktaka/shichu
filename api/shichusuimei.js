// api/shichusuimei.js
// ESM (package.json: { "type": "module" }) 対応
// 四柱推命（節入り境界精密化 / 真太陽時 / 月境界デバッグ monthBoundaryCheck）
// - timeMode: standard / mean_solar / true_solar
// - dayBoundaryMode: "23" / "24"
// - boundaryTimeRef: "standard" / "used"
// - sekkiBoundaryPrecision: "minute" / "second"
// - sekkiBoundaryTieBreak: "after" / "before"
// - meta.used.yearBoundaryCheck + meta.used.monthBoundaryCheck（prev/next + 差分）
// - sekkiBoundaryPrecision=second のときだけ *TimeJstSec を強制表示（デバッグ一貫性）

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method Not Allowed" });
      return;
    }

    const body = typeof req.body === "string" ? safeJsonParse(req.body) : req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ ok: false, error: "Invalid JSON body" });
      return;
    }

    // ---- input normalize ----
    const dateStr = (body.date || "").trim();
    const timeStr = (body.time || "").trim(); // allow "11:11" or "11:11:41" or ""
    const sex = (body.sex || "").trim(); // "F" / "M" / ""
    const birthPlace = body.birthPlace || {};
    const pref = (birthPlace.pref || "").trim() || "東京都";
    const country = (birthPlace.country || "").trim() || "JP";

    const timeMode = normalizeEnum(body.timeMode, ["standard", "mean_solar", "true_solar"], "standard");
    const dayBoundaryMode = normalizeEnum(String(body.dayBoundaryMode || "24"), ["23", "24"], "24");
    const boundaryTimeRef = normalizeEnum(String(body.boundaryTimeRef || "used"), ["standard", "used"], "used");
    const sekkiBoundaryPrecision = normalizeEnum(
      String(body.sekkiBoundaryPrecision || "minute"),
      ["minute", "second"],
      "minute"
    );
    const sekkiBoundaryTieBreak = normalizeEnum(
      String(body.sekkiBoundaryTieBreak || "after"),
      ["after", "before"],
      "after"
    );

    // ---- validate date/time ----
    const d0 = parseYmd(dateStr);
    if (!d0) {
      res.status(400).json({ ok: false, error: "Invalid date (YYYY-MM-DD)" });
      return;
    }

    // time can be empty => hour pillar null (仕様)
    const t0 = timeStr ? parseHms(timeStr) : null;
    if (timeStr && !t0) {
      res.status(400).json({ ok: false, error: "Invalid time (HH:MM or HH:MM:SS)" });
      return;
    }

    // ---- place -> longitude ----
    const longitude = getPrefLongitude(pref); // degrees East
    const lonCorrectionMin = round2((longitude - 135.0) * 4); // minutes
    const eqTimeMin = timeMode === "true_solar" ? round2(calcEquationOfTimeMinutesJst(d0.y, d0.m, d0.d)) : undefined;

    // ---- build standard datetime in JST ----
    const standard = {
      y: d0.y,
      m: d0.m,
      d: d0.d,
      time: timeStr ? toHHMMSS(t0.h, t0.min, t0.sec, "minute") : "", // keep UI-friendly (minute) if no seconds input
    };
    const standardDateJst = makeDateJst(d0.y, d0.m, d0.d, t0 ? t0.h : 0, t0 ? t0.min : 0, t0 ? t0.sec : 0);

    // ---- apply timeMode correction -> used datetime ----
    const addMin =
      timeMode === "standard"
        ? 0
        : timeMode === "mean_solar"
        ? lonCorrectionMin
        : lonCorrectionMin + (eqTimeMin || 0);

    const usedDateJst = t0 ? addMinutes(standardDateJst, addMin) : standardDateJst;
    const used = {
      y: usedDateJst.getFullYear(),
      m: usedDateJst.getMonth() + 1,
      d: usedDateJst.getDate(),
      time: t0 ? toHHMMSS(usedDateJst.getHours(), usedDateJst.getMinutes(), usedDateJst.getSeconds(), "minute") : "",
      timeModeUsed: timeMode,
      dayBoundaryModeUsed: dayBoundaryMode,
      boundaryTimeRefUsed: boundaryTimeRef,
      sekkiBoundaryPrecisionUsed: sekkiBoundaryPrecision,
      sekkiBoundaryTieBreakUsed: sekkiBoundaryTieBreak,
    };

    // ---- Sekki times (JST) for boundary checks ----
    // We compute 12 “jie” boundaries (principal month boundaries in this app design):
    // 小寒(285), 立春(315), 惊蛰(345), 清明(15), 立夏(45), 芒種(75),
    // 小暑(105), 立秋(135), 白露(165), 寒露(195), 立冬(225), 大雪(255)
    const yForSekki = standard.y; // base year for lookup
    const sekkiJie = await getJieBoundariesJst(yForSekki);

    // Determine reference datetime for boundary check (standard or used)
    const refDateJst = boundaryTimeRef === "standard" ? standardDateJst : usedDateJst;

    // ---- Year boundary = Risshun (315°) ----
    const risshun = sekkiJie.find((x) => x.angle === 315);
    if (!risshun) throw new Error("Sekki Risshun not found");

    // Determine before/after by precision & tie break
    const standardCmp = compareToBoundary(standardDateJst, risshun.dateJst, sekkiBoundaryPrecision, sekkiBoundaryTieBreak);
    const usedCmp = compareToBoundary(usedDateJst, risshun.dateJst, sekkiBoundaryPrecision, sekkiBoundaryTieBreak);
    // cmp < 0 => before, >=0 => after
    const standardIsBeforeRisshun = standardCmp < 0;
    const usedIsBeforeRisshun = usedCmp < 0;

    // "yearPillarYearUsed": year number used for pillar (before risshun => previous year)
    const yearPillarYearUsed = usedIsBeforeRisshun ? used.y - 1 : used.y;

    // ---- Month boundary (current month’s jie) ----
    const monthBoundary = findPrevJieBoundary(refDateJst, sekkiJie);
    const prevBoundary = findPrevJieBoundary(monthBoundary.dateJst, sekkiJie, true);
    const nextBoundary = findNextJieBoundary(monthBoundary.dateJst, sekkiJie);

    // monthBoundaryCheck + differences
    const standardMonthCmp = compareToBoundary(
      standardDateJst,
      monthBoundary.dateJst,
      sekkiBoundaryPrecision,
      sekkiBoundaryTieBreak
    );
    const usedMonthCmp = compareToBoundary(
      usedDateJst,
      monthBoundary.dateJst,
      sekkiBoundaryPrecision,
      sekkiBoundaryTieBreak
    );

    const monthDiffStandardSec = diffSeconds(standardDateJst, monthBoundary.dateJst);
    const monthDiffUsedSec = diffSeconds(usedDateJst, monthBoundary.dateJst);

    // ---- meta.used.* sekkiUsed / yearBoundary / monthBoundary ----
    // Keep compatibility: sekkiUsed is the monthBoundary in this Phase, plus yearBoundary is risshun.
    used.sekkiUsed = formatSekki(monthBoundary, sekkiBoundaryPrecision);
    used.yearBoundary = formatSekki(risshun, sekkiBoundaryPrecision);
    used.monthBoundary = formatSekki(monthBoundary, sekkiBoundaryPrecision);

    used.yearPillarYearUsed = yearPillarYearUsed;

    used.yearBoundaryCheck = {
      standardIsBeforeRisshun,
      usedIsBeforeRisshun,
      standardTimeJst: fmtJstMinute(standardDateJst),
      usedTimeJst: fmtJstMinute(usedDateJst),
    };

    used.monthBoundaryCheck = {
      standardIsBeforeMonthBoundary: standardMonthCmp < 0,
      usedIsBeforeMonthBoundary: usedMonthCmp < 0,
      standardTimeJst: fmtJstMinute(standardDateJst),
      usedTimeJst: fmtJstMinute(usedDateJst),
      boundaryName: monthBoundary.name,
      boundaryAngle: monthBoundary.angle,
      boundaryTimeJst: fmtJstMinute(monthBoundary.dateJst),
      prevBoundary: prevBoundary ? { name: prevBoundary.name, angle: prevBoundary.angle, timeJst: fmtJstMinute(prevBoundary.dateJst) } : null,
      nextBoundary: nextBoundary ? { name: nextBoundary.name, angle: nextBoundary.angle, timeJst: fmtJstMinute(nextBoundary.dateJst) } : null,
      diff: {
        standard: buildDiffObject(monthDiffStandardSec),
        used: buildDiffObject(monthDiffUsedSec),
      },
    };

    // sekkiBoundaryPrecision=second のときだけ *TimeJstSec を強制表示
    if (sekkiBoundaryPrecision === "second") {
      used.yearBoundaryCheck.standardTimeJstSec = fmtJstSecond(standardDateJst);
      used.yearBoundaryCheck.usedTimeJstSec = fmtJstSecond(usedDateJst);
      used.yearBoundaryCheck.risshunTimeJstSec = fmtJstSecond(risshun.dateJst);

      used.monthBoundaryCheck.standardTimeJstSec = fmtJstSecond(standardDateJst);
      used.monthBoundaryCheck.usedTimeJstSec = fmtJstSecond(usedDateJst);
      used.monthBoundaryCheck.boundaryTimeJstSec = fmtJstSecond(monthBoundary.dateJst);
      if (prevBoundary) used.monthBoundaryCheck.prevBoundary.timeJstSec = fmtJstSecond(prevBoundary.dateJst);
      if (nextBoundary) used.monthBoundaryCheck.nextBoundary.timeJstSec = fmtJstSecond(nextBoundary.dateJst);

      used.sekkiUsed.timeJstSec = fmtJstSecond(monthBoundary.dateJst);
      used.yearBoundary.timeJstSec = fmtJstSecond(risshun.dateJst);
      used.monthBoundary.timeJstSec = fmtJstSecond(monthBoundary.dateJst);
    }

    // ---- pillars calculation ----
    // Year pillar
    const yearPillar = sexagenaryFromGregorianYear(yearPillarYearUsed);

    // Month pillar: determined by month branch from boundary angle group; month stem from year stem
    const monthBranch = monthBranchFromJieAngle(monthBoundary.angle);
    const monthPillar = buildMonthPillar(yearPillar.kan, monthBranch);

    // Day pillar: day boundary may shift day date for pillar
    const dayPillarDateJst = calcDayPillarDate(refDateJst, dayBoundaryMode);
    const dayPillar = sexagenaryFromJstDate(dayPillarDateJst);

    // Hour pillar: if no time -> null
    const hourPillar = t0 ? buildHourPillar(dayPillar.kan, usedDateJst) : null;

    // Hidden stems (zokan)
    const yearZokan = zokanOfShi(yearPillar.shi);
    const monthZokan = zokanOfShi(monthPillar.shi);
    const dayZokan = zokanOfShi(dayPillar.shi);
    const hourZokan = hourPillar ? zokanOfShi(hourPillar.shi) : null;

    const pillars = {
      year: { ...yearPillar, zokan: yearZokan, rule: "sekki_risshun" },
      month: { ...monthPillar, zokan: monthZokan, rule: "sekki_12jie" },
      day: { ...dayPillar, zokan: dayZokan, rule: `day_boundary_${dayBoundaryMode}` },
      hour: hourPillar ? { ...hourPillar, zokan: hourZokan, rule: "hour_by_used_time" } : null,
    };

    // ---- derived ----
    const tenDeity = {
      year: tenDeityFrom(dayPillar.kan, yearPillar.kan),
      month: tenDeityFrom(dayPillar.kan, monthPillar.kan),
      day: "日主",
      hour: hourPillar ? tenDeityFrom(dayPillar.kan, hourPillar.kan) : null,
    };

    const zokanTenDeity = {
      year: yearZokan.map((s) => ({ stem: s, deity: tenDeityFrom(dayPillar.kan, s) })),
      month: monthZokan.map((s) => ({ stem: s, deity: tenDeityFrom(dayPillar.kan, s) })),
      day: dayZokan.map((s) => ({ stem: s, deity: tenDeityFrom(dayPillar.kan, s) })),
      hour: hourPillar ? hourZokan.map((s) => ({ stem: s, deity: tenDeityFrom(dayPillar.kan, s) })) : null,
    };

    const fiveElements = countFiveElements(pillars);

    const luck = buildLuck({
      sex,
      dayStem: dayPillar.kan,
      monthPillar,
      usedDateJst,
      sekkiJie,
    });

    // ---- boundaryNarrative (AIが本文に必ず含めるため) ----
    const boundaryNarrative = buildBoundaryNarrative({
      boundaryTimeRef,
      sekkiBoundaryPrecision,
      sekkiBoundaryTieBreak,
      standardDateJst,
      usedDateJst,
      yearBoundary: risshun,
      monthBoundary,
      prevBoundary,
      nextBoundary,
      yearBoundaryCheck: used.yearBoundaryCheck,
      monthBoundaryCheck: used.monthBoundaryCheck,
    });

    // ---- response ----
    const out = {
      ok: true,
      input: {
        date: dateStr,
        time: timeStr || "",
        sex: sex || "",
        birthPlace: { country, pref },
        timeMode,
        dayBoundaryMode,
        boundaryTimeRef,
        sekkiBoundaryPrecision,
        sekkiBoundaryTieBreak,
      },
      meta: {
        standard,
        used: {
          ...used,
          boundaryNarrative, // ✅ OpenAI側で必ず本文に入れる用
        },
        place: {
          country,
          pref,
          longitude: round2(longitude),
          lonCorrectionMin,
          ...(timeMode === "true_solar" ? { eqTimeMin: round2(eqTimeMin) } : {}),
        },
      },
      pillars,
      derived: {
        tenDeity,
        zokanTenDeity,
        fiveElements,
        luck,
      },
    };

    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}

/* ---------------- helpers ---------------- */

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizeEnum(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

function parseYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1800 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function parseHms(hms) {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hms);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]), s = m[3] ? Number(m[3]) : 0;
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) return null;
  return { h, min: mi, sec: s };
}

function makeDateJst(y, m, d, hh, mm, ss) {
  // Create Date representing JST wall clock, by creating UTC then shifting.
  // JST = UTC+9
  const utc = Date.UTC(y, m - 1, d, hh - 9, mm, ss, 0);
  return new Date(utc);
}

function addMinutes(dateObj, minutes) {
  return new Date(dateObj.getTime() + minutes * 60 * 1000);
}

function toHHMMSS(h, m, s, precision) {
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return precision === "second" ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

function fmtJstMinute(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours()
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtJstSecond(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours()
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function compareToBoundary(dateJst, boundaryJst, precision, tieBreak) {
  // returns negative if date < boundary, positive if date > boundary, 0 if equal (at precision)
  if (precision === "minute") {
    const a = Math.floor(dateJst.getTime() / 60000);
    const b = Math.floor(boundaryJst.getTime() / 60000);
    if (a < b) return -1;
    if (a > b) return 1;
    // equal minute => tieBreak decides AFTER or BEFORE treat
    return tieBreak === "after" ? 1 : -1;
  }
  // second
  const a = Math.floor(dateJst.getTime() / 1000);
  const b = Math.floor(boundaryJst.getTime() / 1000);
  if (a < b) return -1;
  if (a > b) return 1;
  return tieBreak === "after" ? 1 : -1;
}

function diffSeconds(a, b) {
  // a - b in seconds (signed)
  return Math.round((a.getTime() - b.getTime()) / 1000);
}

function buildDiffObject(secSigned) {
  const abs = Math.abs(secSigned);
  const minutes = abs / 60;
  const days = abs / 86400;
  return {
    seconds: secSigned,
    minutes: round2(secSigned / 60),
    days: round6(secSigned / 86400),
    label: secSigned === 0 ? "境界同刻" : secSigned > 0 ? "直後(+)": "直前(-)",
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
function round6(x) {
  return Math.round(x * 1_000_000) / 1_000_000;
}

/* -------- prefecture longitude (approx / centroid-ish) -------- */
function getPrefLongitude(pref) {
  // You can refine later; this is good enough for lonCorrectionMin accuracy.
  const map = {
    "北海道": 141.35,
    "青森県": 140.74,
    "岩手県": 141.15,
    "宮城県": 140.87,
    "秋田県": 140.10,
    "山形県": 140.36,
    "福島県": 140.47,
    "茨城県": 140.47,
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
    "滋賀県": 136.15,
    "京都府": 135.77,
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
    "福岡県": 130.42,
    "佐賀県": 130.30,
    "長崎県": 129.87,
    "熊本県": 130.74,
    "大分県": 131.61,
    "宮崎県": 131.42,
    "鹿児島県": 130.56,
    "沖縄県": 127.68,
  };
  return map[pref] ?? 135.0;
}

/* -------- Equation of Time (minutes) approx for given JST date --------
   returns minutes to add to mean solar time to get true solar time (EoT).
   Sign convention: we follow common approximation; this matches your outputs roughly.
*/
function calcEquationOfTimeMinutesJst(y, m, d) {
  // Use a standard approximation (NOAA-like) based on day-of-year.
  // We compute for noon local to stabilize; precision is enough for UI.
  const doy = dayOfYear(y, m, d);
  const B = (2 * Math.PI * (doy - 81)) / 364;
  // minutes
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  return eot;
}

function dayOfYear(y, m, d) {
  const start = Date.UTC(y, 0, 1);
  const now = Date.UTC(y, m - 1, d);
  return Math.floor((now - start) / 86400000) + 1;
}

/* ---------------- Sekki (Jie) boundaries ---------------- */

async function getJieBoundariesJst(year) {
  // Compute 12 jie boundaries for the given year (and neighbors for edge cases)
  // We include also neighbors (year-1, year+1) then filter.
  const targets = [
    { name: "小寒", angle: 285 },
    { name: "立春", angle: 315 },
    { name: "惊蛰", angle: 345 },
    { name: "清明", angle: 15 },
    { name: "立夏", angle: 45 },
    { name: "芒種", angle: 75 },
    { name: "小暑", angle: 105 },
    { name: "立秋", angle: 135 },
    { name: "白露", angle: 165 },
    { name: "寒露", angle: 195 },
    { name: "立冬", angle: 225 },
    { name: "大雪", angle: 255 },
  ];

  const years = [year - 1, year, year + 1];
  const all = [];
  for (const yy of years) {
    for (const t of targets) {
      const dt = findSolarLongitudeCrossingJst(yy, t.angle);
      all.push({ ...t, dateJst: dt });
    }
  }

  // Keep sorted by time
  all.sort((a, b) => a.dateJst.getTime() - b.dateJst.getTime());

  // Return a time-window around the requested year to support prev/next lookups.
  const start = makeDateJst(year, 1, 1, 0, 0, 0).getTime() - 35 * 86400000;
  const end = makeDateJst(year, 12, 31, 23, 59, 59).getTime() + 35 * 86400000;
  return all.filter((x) => x.dateJst.getTime() >= start && x.dateJst.getTime() <= end);
}

function findPrevJieBoundary(refJst, list, strictPrev = false) {
  const t = refJst.getTime();
  let best = null;
  for (const s of list) {
    const st = s.dateJst.getTime();
    if (strictPrev) {
      if (st < t) best = s;
    } else {
      if (st <= t) best = s;
    }
  }
  // If nothing found, fallback earliest
  return best ?? list[0];
}

function findNextJieBoundary(refJst, list) {
  const t = refJst.getTime();
  for (const s of list) {
    if (s.dateJst.getTime() > t) return s;
  }
  return null;
}

function formatSekki(s, precision) {
  return {
    name: s.name,
    angle: s.angle,
    timeJst: precision === "second" ? fmtJstMinute(s.dateJst) : fmtJstMinute(s.dateJst),
  };
}

/* -------- Solar longitude crossing (approx; deterministic) --------
   NOTE: This is an approximation engine. If you later replace it with your existing
   high-accuracy sekki table, keep the function signature and the rest stays intact.
*/
function findSolarLongitudeCrossingJst(year, targetDeg) {
  // Search in UTC time, then convert to JST Date object
  // We scan from Dec 15 (prev year) to Jan 20 (next year) to catch early/late crossings.
  const startUtc = Date.UTC(year, 0, 1, 0, 0, 0) - 20 * 86400000;
  const endUtc = Date.UTC(year, 11, 31, 23, 59, 59) + 20 * 86400000;

  const step = 6 * 3600 * 1000; // 6h
  let t0 = startUtc;
  let lon0 = normalizeDeg(sunEclipticLongitudeDeg(t0));
  let foundA = null;

  for (let t1 = startUtc + step; t1 <= endUtc; t1 += step) {
    const lon1 = normalizeDeg(sunEclipticLongitudeDeg(t1));
    if (crossedLongitude(lon0, lon1, targetDeg)) {
      foundA = { a: t0, b: t1 };
      break;
    }
    t0 = t1;
    lon0 = lon1;
  }

  if (!foundA) {
    // fallback: return Jan 1 00:00 JST
    return new Date(Date.UTC(year, 0, 1, 0, 0, 0) + 9 * 3600 * 1000);
  }

  // Binary search to second-level
  let a = foundA.a;
  let b = foundA.b;
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((a + b) / 2);
    const lona = normalizeDeg(sunEclipticLongitudeDeg(a));
    const lonm = normalizeDeg(sunEclipticLongitudeDeg(mid));
    if (crossedLongitude(lona, lonm, targetDeg)) {
      b = mid;
    } else {
      a = mid;
    }
  }

  const utcMs = b;
  // convert UTC -> JST wall time date object:
  return new Date(utcMs + 9 * 3600 * 1000);
}

function crossedLongitude(lonA, lonB, target) {
  // handle wrap-around
  const a = lonA;
  const b = lonB;
  const t = normalizeDeg(target);

  // Convert to a continuous interval by possibly adding 360 to b
  let bb = b;
  if (bb < a) bb += 360;
  let tt = t;
  if (tt < a) tt += 360;

  return a <= tt && tt <= bb;
}

function normalizeDeg(x) {
  let v = x % 360;
  if (v < 0) v += 360;
  return v;
}

// Simplified solar longitude (Meeus-ish, adequate for boundaries)
function sunEclipticLongitudeDeg(utcMs) {
  const JD = utcMs / 86400000 + 2440587.5; // Unix epoch -> JD
  const T = (JD - 2451545.0) / 36525.0;

  const L0 = normalizeDeg(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = normalizeDeg(357.52911 + 35999.05029 * T - 0.0001537 * T * T);

  const Mrad = (M * Math.PI) / 180;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);

  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin((omega * Math.PI) / 180);

  return normalizeDeg(lambda);
}

/* ---------------- Sexagenary (干支) ---------------- */

const KAN = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const SHI = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];

// base: 1984 = 甲子
function sexagenaryFromGregorianYear(y) {
  const idx = mod(y - 1984, 60);
  return { kan: KAN[idx % 10], shi: SHI[idx % 12] };
}

function sexagenaryFromJstDate(dateJst) {
  // Day stem/branch: use a known reference. 1984-02-02 is 甲子 (commonly used reference).
  // This is an approximation; keep stable and deterministic for your app.
  const ref = makeDateJst(1984, 2, 2, 0, 0, 0);
  const days = Math.floor((stripTime(dateJst).getTime() - stripTime(ref).getTime()) / 86400000);
  const idx = mod(days, 60);
  return { kan: KAN[idx % 10], shi: SHI[idx % 12] };
}

function stripTime(d) {
  return makeDateJst(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0, 0);
}

function mod(a, n) {
  const r = a % n;
  return r < 0 ? r + n : r;
}

/* ---------------- Month / Hour pillars ---------------- */

function monthBranchFromJieAngle(angle) {
  // Month branches by jie:
  // 立春(315)=寅, 惊蛰(345)=卯, 清明(15)=辰, 立夏(45)=巳, 芒種(75)=午, 小暑(105)=未,
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
  return map[angle] || "寅";
}

function buildMonthPillar(yearStem, monthBranch) {
  // Month stem depends on year stem group:
  // 甲己年: 丙寅 시작, 乙庚年: 戊寅, 丙辛年: 庚寅, 丁壬年: 壬寅, 戊癸年: 甲寅
  const startStemByYearStem = {
    "甲": "丙", "己": "丙",
    "乙": "戊", "庚": "戊",
    "丙": "庚", "辛": "庚",
    "丁": "壬", "壬": "壬",
    "戊": "甲", "癸": "甲",
  };
  const startStem = startStemByYearStem[yearStem] || "丙";
  const monthOrder = ["寅","卯","辰","巳","午","未","申","酉","戌","亥","子","丑"];
  const idx = monthOrder.indexOf(monthBranch);
  const stemIdx = (KAN.indexOf(startStem) + (idx < 0 ? 0 : idx)) % 10;
  return { kan: KAN[stemIdx], shi: monthBranch };
}

function calcDayPillarDate(refDateJst, dayBoundaryMode) {
  // If boundary=23 and time >=23:00 then day pillar date is next day.
  // If boundary=24 then normal midnight boundary.
  const hh = refDateJst.getHours();
  const mm = refDateJst.getMinutes();
  const ss = refDateJst.getSeconds();

  if (dayBoundaryMode === "23") {
    const atOrAfter23 = hh > 23 || (hh === 23 && (mm > 0 || ss >= 0));
    if (atOrAfter23) {
      return addMinutes(stripTime(refDateJst), 24 * 60); // next day 00:00
    }
  }
  // 24 mode: no shift
  return stripTime(refDateJst);
}

function buildHourPillar(dayStem, usedDateJst) {
  const hb = hourBranchFromTime(usedDateJst.getHours(), usedDateJst.getMinutes());
  const hs = hourStemFromDayStem(dayStem, hb);
  return { kan: hs, shi: hb };
}

function hourBranchFromTime(h, m) {
  // 子: 23:00-00:59, 丑:01-02:59,... 亥:21-22:59
  const total = h * 60 + m;
  if (total >= 23 * 60 || total < 1 * 60) return "子";
  const idx = Math.floor((total - 60) / 120) + 1; // starting 丑 at 01:00
  const order = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
  return order[Math.max(0, Math.min(order.length - 1, idx))];
}

function hourStemFromDayStem(dayStem, hourBranch) {
  // Day stem group -> 子 hour stem:
  // 甲己: 甲子, 乙庚: 丙子, 丙辛: 戊子, 丁壬: 庚子, 戊癸: 壬子
  const start = {
    "甲": "甲", "己": "甲",
    "乙": "丙", "庚": "丙",
    "丙": "戊", "辛": "戊",
    "丁": "庚", "壬": "庚",
    "戊": "壬", "癸": "壬",
  }[dayStem] || "甲";

  const order = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
  const idx = order.indexOf(hourBranch);
  const stemIdx = (KAN.indexOf(start) + (idx < 0 ? 0 : idx)) % 10;
  return KAN[stemIdx];
}

/* ---------------- Zokan (hidden stems) ---------------- */

function zokanOfShi(shi) {
  const map = {
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
  return map[shi] || [];
}

/* ---------------- Ten Deity (十神) ---------------- */

const STEM_ELEMENT = {
  "甲": { el: "wood", yin: 0 }, "乙": { el: "wood", yin: 1 },
  "丙": { el: "fire", yin: 0 }, "丁": { el: "fire", yin: 1 },
  "戊": { el: "earth", yin: 0 }, "己": { el: "earth", yin: 1 },
  "庚": { el: "metal", yin: 0 }, "辛": { el: "metal", yin: 1 },
  "壬": { el: "water", yin: 0 }, "癸": { el: "water", yin: 1 },
};

function tenDeityFrom(dayStem, otherStem) {
  if (!dayStem || !otherStem) return null;
  const d = STEM_ELEMENT[dayStem];
  const o = STEM_ELEMENT[otherStem];
  if (!d || !o) return null;

  const samePol = d.yin === o.yin;

  // Generating/controlling relations from dayStem perspective:
  // 比劫: same element
  if (d.el === o.el) return samePol ? "比肩" : "劫財";

  // Day generates other => 食傷
  if (generates(d.el, o.el)) return samePol ? "食神" : "傷官";

  // Other generates day => 印
  if (generates(o.el, d.el)) return samePol ? "偏印" : "印綬";

  // Day controls other => 財
  if (controls(d.el, o.el)) return samePol ? "偏財" : "正財";

  // Other controls day => 官殺
  if (controls(o.el, d.el)) return samePol ? "七殺" : "正官";

  return null;
}

function generates(a, b) {
  return (
    (a === "wood" && b === "fire") ||
    (a === "fire" && b === "earth") ||
    (a === "earth" && b === "metal") ||
    (a === "metal" && b === "water") ||
    (a === "water" && b === "wood")
  );
}

function controls(a, b) {
  return (
    (a === "wood" && b === "earth") ||
    (a === "earth" && b === "water") ||
    (a === "water" && b === "fire") ||
    (a === "fire" && b === "metal") ||
    (a === "metal" && b === "wood")
  );
}

/* ---------------- Five elements count ---------------- */

function stemToEl(stem) {
  return STEM_ELEMENT[stem]?.el || null;
}

function countFiveElements(pillars) {
  const counts = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };

  const addStem = (s) => {
    const el = stemToEl(s);
    if (el) counts[el] += 1;
  };

  // stems
  addStem(pillars.year.kan);
  addStem(pillars.month.kan);
  addStem(pillars.day.kan);
  if (pillars.hour?.kan) addStem(pillars.hour.kan);

  // zokan
  (pillars.year.zokan || []).forEach(addStem);
  (pillars.month.zokan || []).forEach(addStem);
  (pillars.day.zokan || []).forEach(addStem);
  (pillars.hour?.zokan || []).forEach(addStem);

  return {
    counts,
    note: "Counted from stems: year/month/day/hour + all hidden stems (zokan).",
  };
}

/* ---------------- Luck (大運/年運) ---------------- */

function buildLuck({ sex, dayStem, monthPillar, usedDateJst, sekkiJie }) {
  // direction: traditional rule (simplified)
  const dayYin = STEM_ELEMENT[dayStem]?.yin === 1;
  let direction = "forward";
  if (sex === "M") direction = dayYin ? "backward" : "forward";
  else if (sex === "F") direction = dayYin ? "forward" : "backward";
  else direction = "backward"; // default stable behavior like your logs often show backward

  // start age: minutes diff between birth time and next/prev boundary (3 days = 1 year)
  const ref = usedDateJst;
  const prev = findPrevJieBoundary(ref, sekkiJie);
  const next = findNextJieBoundary(ref, sekkiJie) || prev;

  const diffMin = direction === "forward"
    ? Math.max(0, Math.round((next.dateJst.getTime() - ref.getTime()) / 60000))
    : Math.max(0, Math.round((ref.getTime() - prev.dateJst.getTime()) / 60000));

  const startAge = diffMin / (3 * 24 * 60); // years
  const startAgeYears = Math.floor(startAge + 1e-9);
  const remYears = startAge - startAgeYears;
  const months = Math.floor(remYears * 12 + 1e-9);
  const days = Math.floor((remYears * 365.2422) % 30.437 + 1e-9);

  const dayun = buildDayun(monthPillar, dayStem, direction);

  // current (use server current date; your UI shows null too)
  const now = new Date(); // UTC Date but represents now; for simplicity treat as JST by adding 9h
  const nowJst = new Date(now.getTime() + 9 * 3600 * 1000);

  const ageYears = calcAgeYearsApprox(usedDateJst, nowJst);
  const currentDayunIndex = clamp(Math.floor(ageYears / 10), 0, dayun.length - 1);

  const nenunYearByRisshun = calcNenunYearByRisshun(nowJst, sekkiJie);
  const nenun = buildNenun(nenunYearByRisshun, dayStem);

  const currentNenunIndex = nenun.findIndex((x) => x.pillarYear === nenunYearByRisshun);
  const currentNenun = nenun[currentNenunIndex >= 0 ? currentNenunIndex : 0];
  const currentDayun = dayun[currentDayunIndex];

  return {
    direction,
    startCalcMode: "jie_diff_minutes_div(3days)",
    startDiffMinutes: diffMin,
    startAgeYears,
    startAgeDetail: { years: startAgeYears, months, days },
    current: {
      asOfDateUsed: null,
      ageYears,
      currentDayunIndex,
      currentNenunIndex: currentNenunIndex >= 0 ? currentNenunIndex : 0,
      nenunYearByRisshun,
    },
    dayun,
    nenun,
    currentNenun,
    currentDayun,
  };
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function calcAgeYearsApprox(birthJst, nowJst) {
  const ms = nowJst.getTime() - birthJst.getTime();
  const years = ms / (365.2422 * 86400000);
  return Math.max(0, Math.floor(years));
}

function calcNenunYearByRisshun(nowJst, sekkiJie) {
  // Determine if now is before this year's risshun; if yes, pillar year is previous year
  const y = nowJst.getFullYear();
  const list = sekkiJie; // includes neighbors
  const r = list.find((x) => x.angle === 315 && x.dateJst.getFullYear() === y);
  if (!r) return y;
  const cmp = nowJst.getTime() < r.dateJst.getTime();
  return cmp ? y - 1 : y;
}

function buildDayun(monthPillar, dayStem, direction) {
  // Build 10 periods, step stems/branches by +/-1 in sexagenary cycle
  const startIdx = sexagenaryIndex(monthPillar.kan, monthPillar.shi);
  const step = direction === "forward" ? 1 : -1;
  const arr = [];
  for (let i = 0; i < 10; i++) {
    const idx = mod(startIdx + step * i, 60);
    const kan = KAN[idx % 10];
    const shi = SHI[idx % 12];
    arr.push({
      kan,
      shi,
      tenDeity: tenDeityFrom(dayStem, kan),
      ageFrom: i * 10,
      ageTo: (i + 1) * 10,
    });
  }
  return arr;
}

function buildNenun(centerYear, dayStem) {
  // 13 years: center-6 .. center+6
  const out = [];
  for (let y = centerYear - 6; y <= centerYear + 6; y++) {
    const p = sexagenaryFromGregorianYear(y);
    out.push({
      pillarYear: y,
      kan: p.kan,
      shi: p.shi,
      tenDeity: tenDeityFrom(dayStem, p.kan),
    });
  }
  return out;
}

function sexagenaryIndex(kan, shi) {
  // find the (0..59) where KAN[i%10]=kan and SHI[i%12]=shi
  const ki = KAN.indexOf(kan);
  const si = SHI.indexOf(shi);
  if (ki < 0 || si < 0) return 0;
  for (let i = 0; i < 60; i++) {
    if (i % 10 === ki && i % 12 === si) return i;
  }
  return 0;
}

/* ---------------- boundaryNarrative ---------------- */

function buildBoundaryNarrative(ctx) {
  const p = ctx.sekkiBoundaryPrecision === "second" ? "秒" : "分";
  const tieb = ctx.sekkiBoundaryTieBreak === "after" ? "同刻は後(=境界後扱い)" : "同刻は前(=境界前扱い)";
  const ref = ctx.boundaryTimeRef === "used" ? "補正後(used)" : "補正前(standard)";
  const lines = [];

  lines.push("【境界メモ boundaryNarrative】");
  lines.push(`基準時刻: ${ref} / 精度: ${p} / タイブレーク: ${tieb}`);

  lines.push("");
  lines.push("■ 年境界（立春）");
  lines.push(`標準: ${fmtJstMinute(ctx.standardDateJst)} / used: ${fmtJstMinute(ctx.usedDateJst)}`);
  lines.push(`立春: ${fmtJstMinute(ctx.yearBoundary.dateJst)}`);
  if (ctx.sekkiBoundaryPrecision === "second") {
    lines.push(`標準(秒): ${fmtJstSecond(ctx.standardDateJst)} / used(秒): ${fmtJstSecond(ctx.usedDateJst)} / 立春(秒): ${fmtJstSecond(ctx.yearBoundary.dateJst)}`);
  }
  lines.push(`判定: standardIsBeforeRisshun=${ctx.yearBoundaryCheck.standardIsBeforeRisshun} / usedIsBeforeRisshun=${ctx.yearBoundaryCheck.usedIsBeforeRisshun}`);

  lines.push("");
  lines.push("■ 月境界（12節）");
  lines.push(`月境界: ${ctx.monthBoundary.name}(${ctx.monthBoundary.angle}°) @ ${fmtJstMinute(ctx.monthBoundary.dateJst)}`);
  if (ctx.prevBoundary) lines.push(`直前節: ${ctx.prevBoundary.name}(${ctx.prevBoundary.angle}°) @ ${fmtJstMinute(ctx.prevBoundary.dateJst)}`);
  if (ctx.nextBoundary) lines.push(`直後節: ${ctx.nextBoundary.name}(${ctx.nextBoundary.angle}°) @ ${fmtJstMinute(ctx.nextBoundary.dateJst)}`);
  lines.push(`差分(standard): ${ctx.monthBoundaryCheck.diff.standard.label} ${ctx.monthBoundaryCheck.diff.standard.seconds}s (${ctx.monthBoundaryCheck.diff.standard.minutes}m)`);
  lines.push(`差分(used): ${ctx.monthBoundaryCheck.diff.used.label} ${ctx.monthBoundaryCheck.diff.used.seconds}s (${ctx.monthBoundaryCheck.diff.used.minutes}m)`);
  if (ctx.sekkiBoundaryPrecision === "second") {
    lines.push(`標準(秒): ${fmtJstSecond(ctx.standardDateJst)} / used(秒): ${fmtJstSecond(ctx.usedDateJst)} / 境界(秒): ${fmtJstSecond(ctx.monthBoundary.dateJst)}`);
  }

  lines.push("【/境界メモ】");
  return lines.join("\n");
}
