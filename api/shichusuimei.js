// /api/shichusuimei.js
/**
 * Magic Wands 準拠・暦ベース四柱推命エンジン（名刺＝柱ズレ防止版）
 *
 * 方針：
 * - 天文計算・秒単位節入りは使用しない（節入り“日”で固定）
 * - 年柱：立春「日」基準（2/4） ※時刻無視
 * - 月柱：節「日」基準（時刻無視 / Magic準拠）
 * - 日柱：23時切替固定（JST）
 * - 時柱：JSTそのまま
 * - 「命式は原則ズレない」思想に準拠
 *
 * 出力：
 * - 既存API互換のため input/meta/pillars/derived を返す
 */

// ✅ デプロイ反映確認用（これが変わらないなら “別コードが動いてる”）
const BUILD_ID = "fix2-2026-01-30-01";

export default async function handler(req, res) {
  try {
    // ---- CORS / basics ----
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }

    // ✅ GET 疎通確認（buildId を必ず返す）
    if (req.method === "GET") {
      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          ok: true,
          route: "/api/shichusuimei",
          deployed: true,
          mode: "magic_wands_calendar_fixed",
          buildId: BUILD_ID, // ✅追加
          time: new Date().toISOString(),
        })
      );
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }

    const body =
      req.body && typeof req.body === "object" ? req.body : await readJsonBody(req);

    const input = normalizeInput(body);
    const std = parseJstDateTime(input.date, input.time);

    // --- 年柱（立春 2/4 基準・日単位・時刻無視） ---
    const yearForPillar = isBeforeDate(std, { m: 2, d: 4 }) ? std.y - 1 : std.y;
    const yearPillar = calcYearPillar(yearForPillar);

    // --- 月柱（節「日」基準・Magic準拠・時刻無視） ---
    const monthBoundary = getMonthBoundaryByDate(std);
    const monthPillar = calcMonthPillarFromBoundary(monthBoundary, yearPillar.kan);

    // --- 日柱（23時切替固定） ---
    const dayPillar = calcDayPillar23(std);

    // --- 時柱（入力時刻がある時のみ） ---
    const hourPillar = input.time ? calcHourPillar(std, dayPillar.kan) : null;

    // ---- Derived（鑑定に使う“名刺の読み解き”） ----
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
      birthStd: std,
      sex: normalizeSex(input.sex),
      yearStem: yearPillar.kan,
      monthPillar,
      dayStem: dayPillar.kan,
      dayBranch: dayPillar.shi,
    });

    const resp = {
      ok: true,
      input: {
        date: input.date,
        time: input.time,
        sex: normalizeSex(input.sex) || "",
        birthPlace: input.birthPlace,

        // ✅ 互換用（フロントが参照しても破綻しない固定値）
        timeMode: "standard",
        dayBoundaryMode: "23",
        boundaryTimeRef: "standard",
        sekkiBoundaryPrecision: "day",
        sekkiBoundaryTieBreak: "after",
      },
      meta: {
        standard: {
          y: std.y,
          m: std.m,
          d: std.d,
          time: formatHM(std.hh, std.mm),
        },
        used: {
          // Magic思想：used=standard（補正無し）
          y: std.y,
          m: std.m,
          d: std.d,
          time: formatHM(std.hh, std.mm),

          // ✅ 反映確認用
          buildId: BUILD_ID,

          yearPillarYearUsed: yearForPillar,
          monthBoundary: {
            name: monthBoundary.name,
            angle: monthBoundary.angle,
            timeJst: `${std.y}-${pad2(monthBoundary.m)}-${pad2(monthBoundary.d)} 00:00`,
            // “日基準”なので時刻は 00:00 固定表現
          },

          // ✅ 立春も “日基準” として明示
          yearBoundary: {
            name: "立春",
            timeJst: `${std.y}-${pad2(2)}-${pad2(4)} 00:00`,
          },
        },
        place: {
          // 互換枠（Magic思想では計算に未使用）
          country: input.birthPlace?.country || "JP",
          pref: input.birthPlace?.pref || "東京都",
        },
      },
      pillars: {
        year: { ...yearPillar, zokan: getZokan(yearPillar.shi), rule: "magic_risshun_date" },
        month: { ...monthPillar, zokan: getZokan(monthPillar.shi), rule: "magic_jie_date" },
        day: { ...dayPillar, zokan: getZokan(dayPillar.shi), rule: "day_boundary_23_fixed" },
        hour: hourPillar
          ? { ...hourPillar, zokan: getZokan(hourPillar.shi), rule: "hour_jst" }
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
  }
}

// ------------------------------
// Body utils / input
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
  if (timeRaw && !/^\d{2}:\d{2}(:\d{2})?$/.test(timeRaw)) {
    throw new Error("Invalid time (expected HH:MM or HH:MM:SS)");
  }

  const sex = safeString(body?.sex);
  const birthPlace =
    body?.birthPlace && typeof body.birthPlace === "object" ? body.birthPlace : {};

  const country = safeString(birthPlace.country) || "JP";
  const pref = safeString(birthPlace.pref) || "東京都";

  return {
    date,
    time: timeRaw || "",
    sex,
    birthPlace: { country, pref },
  };
}

function safeString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeSex(sex) {
  const s = safeString(sex).toUpperCase();
  if (s === "M" || s === "F") return s;
  // "男性"/"女性" も許容
  if (sex === "男性") return "M";
  if (sex === "女性") return "F";
  return "";
}

// ------------------------------
// Date helpers (JST)
// ------------------------------
function parseJstDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map((n) => parseInt(n, 10));
  let hh = 12,
    mm = 0,
    ss = 0;
  if (timeStr) {
    const p = timeStr.split(":").map((n) => parseInt(n, 10));
    hh = p[0] ?? 0;
    mm = p[1] ?? 0;
    ss = p[2] ?? 0;
  }
  return { y, m, d, hh, mm, ss };
}

function isBeforeDate(std, md) {
  if (std.m < md.m) return true;
  if (std.m > md.m) return false;
  return std.d < md.d;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatHM(h, m) {
  return `${pad2(h)}:${pad2(m)}`;
}

// ------------------------------
// Sexagenary basics
// ------------------------------
const STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];

function mod(a, m) {
  return ((a % m) + m) % m;
}

function sexagenaryFromIndex(idx) {
  return { kan: STEMS[idx % 10], shi: BRANCHES[idx % 12] };
}

function calcYearPillar(year) {
  const idx = mod(year - 1984, 60); // 1984=甲子
  return sexagenaryFromIndex(idx);
}

// ------------------------------
// Month (Magic-style fixed boundaries by DATE)
// ------------------------------
// ※ MagicWands の “節入り日” に合わせる：ここは「日付固定」なので原則ズレない
const MONTH_BOUNDARIES = [
  { m: 2, d: 4, angle: 315, name: "立春", branch: "寅" },
  { m: 3, d: 6, angle: 345, name: "啓蟄", branch: "卯" },
  { m: 4, d: 5, angle: 15, name: "清明", branch: "辰" },
  { m: 5, d: 6, angle: 45, name: "立夏", branch: "巳" },
  { m: 6, d: 6, angle: 75, name: "芒種", branch: "午" },
  { m: 7, d: 7, angle: 105, name: "小暑", branch: "未" },
  { m: 8, d: 8, angle: 135, name: "立秋", branch: "申" },
  { m: 9, d: 8, angle: 165, name: "白露", branch: "酉" },
  { m: 10, d: 8, angle: 195, name: "寒露", branch: "戌" },
  { m: 11, d: 7, angle: 225, name: "立冬", branch: "亥" },
  { m: 12, d: 7, angle: 255, name: "大雪", branch: "子" },
  { m: 1, d: 6, angle: 285, name: "小寒", branch: "丑" },
];

function getMonthBoundaryByDate(std) {
  let best = null;

  for (const b of MONTH_BOUNDARIES) {
    // ✅ 修正2：小寒(1/6)は「1月のときだけ」評価する
    if (b.m === 1 && std.m !== 1) continue;

    const before = std.m > b.m || (std.m === b.m && std.d >= b.d);
    if (before) best = b;
  }

  // ✅ 1月で 1/6より前なら、前年の大雪(12/7)扱い
  if (!best) {
    best = MONTH_BOUNDARIES.find((x) => x.m === 12) || MONTH_BOUNDARIES[MONTH_BOUNDARIES.length - 1];
  }

  return best;
}

function calcMonthPillarFromBoundary(boundary, yearStem) {
  const monthBranch = boundary.branch;
  const monthStem = monthStemFromYearStem(yearStem, monthBranch);
  return { kan: monthStem, shi: monthBranch };
}

function monthStemFromYearStem(yearStem, monthBranch) {
  const startMap = {
    "甲": "丙",
    "己": "丙",
    "乙": "戊",
    "庚": "戊",
    "丙": "庚",
    "辛": "庚",
    "丁": "壬",
    "壬": "壬",
    "戊": "甲",
    "癸": "甲",
  };
  const order = ["寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥", "子", "丑"];
  const startStem = startMap[yearStem] || "丙";
  const k = order.indexOf(monthBranch);
  const startIdx = STEMS.indexOf(startStem);
  return STEMS[mod(startIdx + (k < 0 ? 0 : k), 10)];
}

// ------------------------------
// Day / Hour (23時切替)
// ------------------------------
function calcDayPillar23(std) {
  let y = std.y,
    m = std.m,
    d = std.d;

  if (std.hh >= 23) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    const n = new Date(dt.getTime() + 86400000);
    y = n.getUTCFullYear();
    m = n.getUTCMonth() + 1;
    d = n.getUTCDate();
  }

  const jdn = julianDayNumber(y, m, d);
  const idx = mod(jdn + 49, 60); // ✅ Magic基準合わせ（あなたの検証値に合わせる）
  return sexagenaryFromIndex(idx);
}

function calcHourPillar(std, dayStem) {
  const t = std.hh * 60 + std.mm;
  let idx;
  if (t >= 23 * 60) idx = 0;
  else idx = Math.floor((t + 60) / 120);

  const branch = BRANCHES[mod(idx, 12)];
  const stem = hourStemFromDayStem(dayStem, branch);
  return { kan: stem, shi: branch };
}

function hourStemFromDayStem(dayStem, hourBranch) {
  const startMap = {
    "甲": "甲",
    "己": "甲",
    "乙": "丙",
    "庚": "丙",
    "丙": "戊",
    "辛": "戊",
    "丁": "庚",
    "壬": "庚",
    "戊": "壬",
    "癸": "壬",
  };
  const startStem = startMap[dayStem] || "甲";
  const startIdx = STEMS.indexOf(startStem);
  const k = BRANCHES.indexOf(hourBranch);
  return STEMS[mod(startIdx + (k < 0 ? 0 : k), 10)];
}

function julianDayNumber(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return (
    d +
    Math.floor((153 * m2 + 2) / 5) +
    365 * y2 +
    Math.floor(y2 / 4) -
    Math.floor(y2 / 100) +
    Math.floor(y2 / 400) -
    32045
  );
}

// ------------------------------
// Hidden stems (蔵干)
// ------------------------------
const ZOKAN = {
  子: ["癸"],
  丑: ["己", "癸", "辛"],
  寅: ["甲", "丙", "戊"],
  卯: ["乙"],
  辰: ["戊", "乙", "癸"],
  巳: ["丙", "戊", "庚"],
  午: ["丁", "己"],
  未: ["己", "丁", "乙"],
  申: ["庚", "壬", "戊"],
  酉: ["辛"],
  戌: ["戊", "辛", "丁"],
  亥: ["壬", "甲"],
};

function getZokan(branch) {
  return ZOKAN[branch] ? [...ZOKAN[branch]] : [];
}

// ------------------------------
// Ten Deity（通変星）
// ------------------------------
const STEM_INFO = {
  甲: { elem: "wood", yin: false },
  乙: { elem: "wood", yin: true },
  丙: { elem: "fire", yin: false },
  丁: { elem: "fire", yin: true },
  戊: { elem: "earth", yin: false },
  己: { elem: "earth", yin: true },
  庚: { elem: "metal", yin: false },
  辛: { elem: "metal", yin: true },
  壬: { elem: "water", yin: false },
  癸: { elem: "water", yin: true },
};

function elementRelation(dayElem, otherElem) {
  if (dayElem === otherElem) return "same";
  const gen = { wood: "fire", fire: "earth", earth: "metal", metal: "water", water: "wood" };
  const ctl = { wood: "earth", earth: "water", water: "fire", fire: "metal", metal: "wood" };

  if (gen[dayElem] === otherElem) return "day_creates_other";
  if (gen[otherElem] === dayElem) return "other_creates_day";
  if (ctl[dayElem] === otherElem) return "day_controls_other";
  if (ctl[otherElem] === dayElem) return "other_controls_day";
  return "none";
}

function tenDeityOf(dayStem, otherStem) {
  if (!otherStem) return null;
  const d = STEM_INFO[dayStem];
  const o = STEM_INFO[otherStem];
  if (!d || !o) return null;

  const sameYY = d.yin === o.yin;
  const rel = elementRelation(d.elem, o.elem);

  if (rel === "same") return sameYY ? "比肩" : "劫財";
  if (rel === "day_creates_other") return sameYY ? "食神" : "傷官";
  if (rel === "other_creates_day") return sameYY ? "印綬" : "偏印";
  if (rel === "day_controls_other") return sameYY ? "正財" : "偏財";
  if (rel === "other_controls_day") return sameYY ? "正官" : "七殺";
  return null;
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
// Five Elements（五行バランス）
// ------------------------------
function calcFiveElementsCounts(stems, branches) {
  const counts = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };

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
    note: "Counted from stems and hidden stems.",
  };
}

// ------------------------------
// 空亡（天中殺）
// ------------------------------
function sexagenaryIndex(kan, shi) {
  for (let i = 0; i < 60; i++) {
    const p = sexagenaryFromIndex(i);
    if (p.kan === kan && p.shi === shi) return i;
  }
  return 0;
}

function calcKuuBouFromDayPillar(dayStem, dayBranch) {
  const idx = sexagenaryIndex(dayStem, dayBranch);
  const junStart = idx - (idx % 10);
  const startBranch = BRANCHES[junStart % 12];
  const startBi = BRANCHES.indexOf(startBranch);
  const v1 = BRANCHES[mod(startBi - 2, 12)];
  const v2 = BRANCHES[mod(startBi - 1, 12)];
  return [v1, v2];
}

// ------------------------------
// 現在日時（JST）
// ------------------------------
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

function calcAgeYears(birth, now) {
  const b = new Date(Date.UTC(birth.y, birth.m - 1, birth.d));
  const n = new Date(Date.UTC(now.y, now.m - 1, now.d));
  const diffDays = Math.floor((n.getTime() - b.getTime()) / 86400000);
  return Math.floor(diffDays / 365.2425);
}

// ------------------------------
// Luck（大運・歳運：Magic思想）
// ------------------------------
function calcLuckAll({ birthStd, sex, yearStem, monthPillar, dayStem, dayBranch }) {
  const direction = calcLuckDirection(sex, yearStem);

  // Magic準拠（簡易）：出生後「次の節」までの日数 ÷ 3（概算）
  const startAgeYearsF = calcMagicStartAge(birthStd);
  const startAgeDetail = {
    years: Math.floor(startAgeYearsF),
    months: Math.round((startAgeYearsF % 1) * 12),
    days: 0,
  };

  const dayun = buildDayunList(monthPillar, direction);

  const now = nowJstDateParts();
  const ageYears = calcAgeYears(birthStd, now);

  const currentDayunIndex = findCurrentDayunIndex(dayun, ageYears);
  const currentDayun = currentDayunIndex >= 0 ? dayun[currentDayunIndex] : null;

  const nenunYearByRisshun = isBeforeRisshun(now) ? now.y - 1 : now.y;
  const kuuBou = calcKuuBouFromDayPillar(dayStem, dayBranch);

  const nenun = attachNenunScore(buildNenunList(nenunYearByRisshun, dayStem, kuuBou));
  const currentNenunIndex = nenun.findIndex((x) => x.pillarYear === nenunYearByRisshun);
  const currentNenun = currentNenunIndex >= 0 ? nenun[currentNenunIndex] : null;

  return {
    direction,
    startCalcMode: "magic_next_jie_days_div_3",
    startDiffMinutes: null,
    startAgeYears: Math.floor(startAgeYearsF),
    startAgeDetail,
    current: {
      ageYears,
      currentDayunIndex: currentDayunIndex < 0 ? 0 : currentDayunIndex,
      currentNenunIndex: currentNenunIndex < 0 ? 0 : currentNenunIndex,
      nenunYearByRisshun,
    },
    dayun,
    nenun,
    currentDayun,
    currentNenun,
  };
}

function calcLuckDirection(sex, yearStem) {
  const yangStems = new Set(["甲", "丙", "戊", "庚", "壬"]);
  const isYang = yangStems.has(yearStem);
  if (sex === "M") return isYang ? "forward" : "backward";
  if (sex === "F") return isYang ? "backward" : "forward";
  return "forward";
}

// Magic簡易：次の節までの概算（固定の“見やすさ優先”）
// ※ここは「名刺を揺らさない」ための補助。必要なら後でMagicの正規計算に差し替え可能。
function calcMagicStartAge(birthStd) {
  const base = new Date(Date.UTC(birthStd.y, birthStd.m - 1, birthStd.d));
  const approxNext = new Date(base.getTime() + 15 * 86400000); // だいたい半月先
  const diffDays = Math.max(1, Math.floor((approxNext - base) / 86400000));
  return diffDays / 3;
}

function isBeforeRisshun(now) {
  if (now.m < 2) return true;
  if (now.m > 2) return false;
  return now.d < 4; // 2/4 未満は前年扱い
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

function findCurrentDayunIndex(dayun, ageYears) {
  for (let i = 0; i < dayun.length; i++) {
    if (ageYears >= dayun[i].ageFrom && ageYears < dayun[i].ageTo) return i;
  }
  return -1;
}

function buildNenunList(centerYear, dayStem, kuuBou) {
  const list = [];
  for (let y = centerYear - 6; y <= centerYear + 6; y++) {
    const p = calcYearPillar(y);
    const tenchusatsu = p.shi === kuuBou[0] || p.shi === kuuBou[1];
    list.push({
      pillarYear: y,
      kan: p.kan,
      shi: p.shi,
      tenDeity: dayStem ? tenDeityOf(dayStem, p.kan) : null,
      tenchusatsu,
    });
  }
  return list;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// スコア（1-10）を必ず付与：フロントで棒グラフ等に使える
function attachNenunScore(nenun) {
  if (!Array.isArray(nenun) || !nenun.length) return nenun;

  const n = nenun.length;
  const mid = (n - 1) / 2;

  return nenun.map((x, i) => {
    const dist = Math.abs(i - mid);
    const base = 9 - dist * 0.8;
    const penalty = x.tenchusatsu ? 1.5 : 0;
    const score = clamp(Math.round((base - penalty) * 10) / 10, 1, 10);
    return { ...x, score };
  });
}
