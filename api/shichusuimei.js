// ===== /api/shichusuimei.js : Part 1/3 =====
/**
 * Magic Wands 準拠・暦ベース四柱推命エンジン
 *
 * 方針：
 * - 天文計算・秒単位節入りは使用しない
 * - 年柱：立春「日」基準（2/4）
 * - 月柱：節「日」基準（時刻無視）
 * - 日柱：23時切替固定
 * - 時柱：JSTそのまま
 * - 「命式は原則ズレない」思想に準拠
 *
 * 出力JSON構造は既存APIと互換
 */

export default async function handler(req, res) {
  try {
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

    const body =
      req.body && typeof req.body === "object" ? req.body : await readJsonBody(req);

    const input = normalizeInput(body);

    const std = parseJstDateTime(input.date, input.time);

    // --- 年柱（立春 2/4 基準・日単位） ---
    const yearForPillar = isBeforeDate(std, { m: 2, d: 4 }) ? std.y - 1 : std.y;
    const yearPillar = calcYearPillar(yearForPillar);

    // --- 月柱（節「日」基準・Magic準拠） ---
    const monthBoundary = getMonthBoundaryByDate(std);
    const monthPillar = calcMonthPillarFromBoundary(monthBoundary, yearPillar.kan);

    // --- 日柱（23時切替） ---
    const dayPillar = calcDayPillar23(std);

    // --- 時柱 ---
    const hourPillar = input.time ? calcHourPillar(std, dayPillar.kan) : null;

    const resp = {
      ok: true,
      input: {
        date: input.date,
        time: input.time,
        sex: input.sex,
        birthPlace: input.birthPlace,
      },
      meta: {
        standard: {
          y: std.y,
          m: std.m,
          d: std.d,
          time: formatHM(std.hh, std.mm),
        },
        used: {
          y: std.y,
          m: std.m,
          d: std.d,
          time: formatHM(std.hh, std.mm),
          yearPillarYearUsed: yearForPillar,
          monthBoundary: monthBoundary,
        },
      },
      pillars: {
        year: { ...yearPillar, zokan: getZokan(yearPillar.shi) },
        month: { ...monthPillar, zokan: getZokan(monthPillar.shi) },
        day: { ...dayPillar, zokan: getZokan(dayPillar.shi) },
        hour: hourPillar
          ? { ...hourPillar, zokan: getZokan(hourPillar.shi) }
          : null,
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
// utils / input
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date");

  const timeRaw = safeString(body?.time);
  if (timeRaw && !/^\d{2}:\d{2}(:\d{2})?$/.test(timeRaw))
    throw new Error("Invalid time");

  const sex = safeString(body?.sex);
  const birthPlace =
    body?.birthPlace && typeof body.birthPlace === "object"
      ? body.birthPlace
      : { country: "JP", pref: "東京都" };

  return {
    date,
    time: timeRaw || "",
    sex,
    birthPlace,
  };
}

function safeString(v) {
  return typeof v === "string" ? v.trim() : "";
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
const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];

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
// Month (Magic-style fixed boundaries)
// ------------------------------
const MONTH_BOUNDARIES = [
  { m: 2, d: 4, angle: 315, name: "立春", branch: "寅" },
  { m: 3, d: 6, angle: 345, name: "啓蟄", branch: "卯" },
  { m: 4, d: 5, angle: 15,  name: "清明", branch: "辰" },
  { m: 5, d: 6, angle: 45,  name: "立夏", branch: "巳" },
  { m: 6, d: 6, angle: 75,  name: "芒種", branch: "午" },
  { m: 7, d: 7, angle: 105, name: "小暑", branch: "未" },
  { m: 8, d: 8, angle: 135, name: "立秋", branch: "申" },
  { m: 9, d: 8, angle: 165, name: "白露", branch: "酉" },
  { m:10, d: 8, angle: 195, name: "寒露", branch: "戌" },
  { m:11, d: 7, angle: 225, name: "立冬", branch: "亥" },
  { m:12, d: 7, angle: 255, name: "大雪", branch: "子" },
  { m: 1, d: 6, angle: 285, name: "小寒", branch: "丑" },
];

function getMonthBoundaryByDate(std) {
  let best = null;
  for (const b of MONTH_BOUNDARIES) {
    const before =
      std.m > b.m || (std.m === b.m && std.d >= b.d);
    if (before) best = b;
  }
  if (!best) best = MONTH_BOUNDARIES[MONTH_BOUNDARIES.length - 1];
  return best;
}

function calcMonthPillarFromBoundary(boundary, yearStem) {
  const monthBranch = boundary.branch;
  const monthStem = monthStemFromYearStem(yearStem, monthBranch);
  return { kan: monthStem, shi: monthBranch };
}

function monthStemFromYearStem(yearStem, monthBranch) {
  const startMap = {
    "甲":"丙","己":"丙",
    "乙":"戊","庚":"戊",
    "丙":"庚","辛":"庚",
    "丁":"壬","壬":"壬",
    "戊":"甲","癸":"甲",
  };
  const order = ["寅","卯","辰","巳","午","未","申","酉","戌","亥","子","丑"];
  const startStem = startMap[yearStem] || "丙";
  const k = order.indexOf(monthBranch);
  const startIdx = STEMS.indexOf(startStem);
  return STEMS[mod(startIdx + k, 10)];
}

// ------------------------------
// Day / Hour (23時切替)
// ------------------------------
function calcDayPillar23(std) {
  let y = std.y, m = std.m, d = std.d;
  if (std.hh >= 23) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    const n = new Date(dt.getTime() + 86400000);
    y = n.getUTCFullYear();
    m = n.getUTCMonth() + 1;
    d = n.getUTCDate();
  }
  const jdn = julianDayNumber(y, m, d);
  const idx = mod(jdn + 47, 60); // Magic基準合わせ
  return sexagenaryFromIndex(idx);
}

function calcHourPillar(std, dayStem) {
  const t = std.hh * 60 + std.mm;
  let idx;
  if (t >= 23 * 60) idx = 0;
  else idx = Math.floor((t + 60) / 120);
  const branch = BRANCHES[mod(idx, 12)];

  const startMap = {
    "甲":"甲","己":"甲",
    "乙":"丙","庚":"丙",
    "丙":"戊","辛":"戊",
    "丁":"庚","壬":"庚",
    "戊":"壬","癸":"壬",
  };
  const startStem = startMap[dayStem] || "甲";
  const startIdx = STEMS.indexOf(startStem);
  const k = BRANCHES.indexOf(branch);
  const stem = STEMS[mod(startIdx + k, 10)];
  return { kan: stem, shi: branch };
}

// ------------------------------
function julianDayNumber(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 +
    Math.floor(y2 / 4) - Math.floor(y2 / 100) +
    Math.floor(y2 / 400) - 32045;
}

// ------------------------------
// Hidden stems (stub,続きはPart2)
// ------------------------------
function getZokan(branch) {
  const Z = {
    "子":["癸"], "丑":["己","癸","辛"], "寅":["甲","丙","戊"], "卯":["乙"],
    "辰":["戊","乙","癸"], "巳":["丙","戊","庚"], "午":["丁","己"], "未":["己","丁","乙"],
    "申":["庚","壬","戊"], "酉":["辛"], "戌":["戊","辛","丁"], "亥":["壬","甲"],
  };
  return Z[branch] ? [...Z[branch]] : [];
}
