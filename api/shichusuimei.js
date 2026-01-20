// api/shichusuimei.js
// Phase A: 「節入り（24節気）」の境界で月柱（＋年柱の立春境界）を確定する
// Phase B: 「平均太陽時」= 経度差補正（明石135°基準）
// Phase B+: 「真太陽時」= 平均太陽時 + 均時差(EoT)
// Phase C: 「日干支の23時/24時切替」(入力 dayBoundaryMode)
// Phase D: 「大運/年運」+ 年運は立春境界で切る精密版
// Phase D+: 起運年齢を“分単位”で厳密計算（節までの差分Minutes ÷ (3日換算)）
//
// ★節入り境界 精密化（Phase A++）
// - boundaryTimeRef: "used" | "standard"
//   年柱（立春）境界判定を「補正後 usedUtc」か「補正前 stdUtc」どちらで行うかを選べる。
//   デフォルト "used"（現状維持）。
// - sekkiBoundaryPrecision: "second" | "minute"
//   節入り境界比較の粒度。
// - sekkiBoundaryTieBreak: "after" | "before"
//   境界ちょうど(同一と見なした)場合の扱い。
//   "after" 推奨（境界ちょうど＝切替後）
//
// ★今回の追加（バグ防止/検証強化）
// - yearBoundary に timeJstSec を追加（分表示と判定(秒)のズレを可視化）
// - 月柱の「節入り判定」にも precision/tieBreak を適用（立春ちょうど等の境界でブレ防止）
// - sekkiUsed は常に timeJstSec を返す（条件分岐で欠けないように）
//
// POST /api/shichusuimei
// body: {
//   date: "YYYY-MM-DD",
//   time: "HH:MM" | "",
//   sex: "M"|"F"|"",
//   birthPlace: {country:"JP", pref:"東京都"} | null,
//   timeMode: "standard"|"mean_solar"|"true_solar",
//   dayBoundaryMode: "23"|"24",
//   boundaryTimeRef?: "used"|"standard",
//   sekkiBoundaryPrecision?: "second"|"minute",
//   sekkiBoundaryTieBreak?: "after"|"before",
//   asOfDate?: "YYYY-MM-DD"
// }
//
// env:
//   ALLOWED_ORIGINS = "https://spikatsu.anjyanen.com,https://www.spikatsu.anjyanen.com"

import { applyCors } from "../lib/cors.js";
import { buildJie12Utc, formatJst } from "../lib/sekki.js";

// ---- 干支ユーティリティ ----
const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const MONTH_BRANCHES = ["寅","卯","辰","巳","午","未","申","酉","戌","亥","子","丑"];

// ---- Phase B: 都道府県 → 代表経度（最小マップ）----
const PREF_LONGITUDE = {
  "北海道": 141.35, "青森県": 140.74, "岩手県": 141.15, "宮城県": 140.87, "秋田県": 140.10, "山形県": 140.36, "福島県": 140.47,
  "茨城県": 140.45, "栃木県": 139.88, "群馬県": 139.06, "埼玉県": 139.65, "千葉県": 140.12, "東京都": 139.69, "神奈川県": 139.64,
  "新潟県": 139.02, "富山県": 137.21, "石川県": 136.65, "福井県": 136.22, "山梨県": 138.57, "長野県": 138.18,
  "岐阜県": 136.72, "静岡県": 138.38, "愛知県": 136.91, "三重県": 136.51,
  "滋賀県": 135.87, "京都府": 135.76, "大阪府": 135.52, "兵庫県": 135.18, "奈良県": 135.83, "和歌山県": 135.17,
  "鳥取県": 134.24, "島根県": 133.05, "岡山県": 133.93, "広島県": 132.46, "山口県": 131.47,
  "徳島県": 134.56, "香川県": 134.04, "愛媛県": 132.77, "高知県": 133.53,
  "福岡県": 130.40, "佐賀県": 130.30, "長崎県": 129.87, "熊本県": 130.71, "大分県": 131.61, "宮崎県": 131.42, "鹿児島県": 130.56,
  "沖縄県": 127.68
};

// ========== Phase B+ 均時差（Equation of Time / EoT） ==========
// 返り値：分（真太陽時 = 平均太陽時 + eqTimeMin）
function equationOfTimeMinutes(dateUtc) {
  const y = dateUtc.getUTCFullYear();
  const m = dateUtc.getUTCMonth() + 1;
  const d = dateUtc.getUTCDate();

  const start = Date.UTC(y, 0, 1);
  const today = Date.UTC(y, m - 1, d);
  const n = Math.floor((today - start) / (24 * 3600 * 1000)) + 1;

  const gamma = (2 * Math.PI / 365) * (n - 1 + (12 - 12) / 24);

  const eot =
    229.18 * (
      0.000075
      + 0.001868 * Math.cos(gamma)
      - 0.032077 * Math.sin(gamma)
      - 0.014615 * Math.cos(2 * gamma)
      - 0.040849 * Math.sin(2 * gamma)
    );

  return eot;
}

// ---- 年干→寅月の干（五虎遁） ----
function tigerMonthStemForYearStem(yearStem) {
  if (yearStem === "甲" || yearStem === "己") return "丙";
  if (yearStem === "乙" || yearStem === "庚") return "戊";
  if (yearStem === "丙" || yearStem === "辛") return "庚";
  if (yearStem === "丁" || yearStem === "壬") return "壬";
  return "甲";
}
function addStem(stem, add) {
  const i = STEMS.indexOf(stem);
  return STEMS[(i + add + 10) % 10];
}
function addBranch(branch, add) {
  const i = BRANCHES.indexOf(branch);
  return BRANCHES[(i + add + 12) % 12];
}

// ---- Phase A: 年柱（立春境界） ----
function calcYearPillarByRisshun(yearNumber) {
  const idx = (yearNumber - 1984) % 60;
  const i = (idx + 60) % 60;
  return { kan: STEMS[i % 10], shi: BRANCHES[i % 12] };
}

// ---- Phase C: 日柱 23/24 境界（簡易日干支） ----
function toJdnAtUtcMidnight(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  const jdn =
    d +
    Math.floor((153 * m2 + 2) / 5) +
    365 * y2 +
    Math.floor(y2 / 4) -
    Math.floor(y2 / 100) +
    Math.floor(y2 / 400) -
    32045;
  return jdn;
}
function calcDayPillarSimpleByYMD(y, m, d) {
  const baseJdn = toJdnAtUtcMidnight(1984, 2, 2);
  const jdn = toJdnAtUtcMidnight(y, m, d);
  const diff = jdn - baseJdn;
  const idx = (diff % 60 + 60) % 60;
  return { kan: STEMS[idx % 10], shi: BRANCHES[idx % 12] };
}
function calcDayPillarWithBoundary({ Y, M, D, hh, mm, dayBoundaryMode }) {
  let y = Y, m = M, d = D;
  if (String(dayBoundaryMode) === "23") {
    const minutes = hh * 60 + mm;
    if (minutes >= 23 * 60) {
      const dt = new Date(Date.UTC(Y, M - 1, D, 0, 0, 0));
      dt.setUTCDate(dt.getUTCDate() + 1);
      y = dt.getUTCFullYear();
      m = dt.getUTCMonth() + 1;
      d = dt.getUTCDate();
    }
  }
  return calcDayPillarSimpleByYMD(y, m, d);
}

// ---- 時柱（補正後の時刻で判定） ----
function hourBranchFromTime(hh, mm) {
  const minutes = hh * 60 + mm;
  if (minutes >= 23 * 60) return "子";
  const slot = Math.floor((minutes + 60) / 120);
  return BRANCHES[slot % 12];
}
function hourStemFromDayStemAndHourBranch(dayStem, hourBranch) {
  let ziStem;
  if (dayStem === "甲" || dayStem === "己") ziStem = "甲";
  else if (dayStem === "乙" || dayStem === "庚") ziStem = "丙";
  else if (dayStem === "丙" || dayStem === "辛") ziStem = "戊";
  else if (dayStem === "丁" || dayStem === "壬") ziStem = "庚";
  else ziStem = "壬";
  const ziIndex = STEMS.indexOf(ziStem);
  const hbIndex = BRANCHES.indexOf(hourBranch);
  return STEMS[(ziIndex + hbIndex) % 10];
}

// ---- 入力処理 ----
function parseDateTimeJstToUtc(dateStr, timeStr) {
  const [Y, M, D] = dateStr.split("-").map((v) => parseInt(v, 10));
  let hh = 12, mm = 0;
  if (timeStr && timeStr.includes(":")) {
    [hh, mm] = timeStr.split(":").map((v) => parseInt(v, 10));
  } else {
    hh = 12; mm = 0;
  }
  const utc = new Date(Date.UTC(Y, M - 1, D, hh - 9, mm, 0));
  return { Y, M, D, hh, mm, utc };
}
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtHHMM(hh, mm) { return `${pad2(hh)}:${pad2(mm)}`; }

// ---- Phase A++: 秒表示/境界比較ユーティリティ ----
function formatJstSec(dateUtc) {
  const d = new Date(dateUtc.getTime() + 9 * 3600 * 1000);
  const Y = d.getUTCFullYear();
  const M = pad2(d.getUTCMonth() + 1);
  const D = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `${Y}-${M}-${D} ${hh}:${mm}:${ss}`;
}
function toPrecisionTs(dateUtc, precision) {
  const t = dateUtc.getTime();
  if (precision === "minute") return Math.floor(t / 60000) * 60000; // truncate to minute
  return t; // "second"
}
function compareWithTie(aUtc, bUtc, precision, tieBreak) {
  const a = toPrecisionTs(aUtc, precision);
  const b = toPrecisionTs(bUtc, precision);
  if (a < b) return -1;
  if (a > b) return 1;
  // tie
  return tieBreak === "before" ? -1 : 1; // after => treat as "not before"
}

// ---- 月柱：節入り（12節）で境界（precision/tieBreak対応） ----
function calcMonthPillarByJie(dateUtcForJst, yearPillarStem, precision, tieBreak) {
  const yJst = new Date(dateUtcForJst.getTime() + 9 * 3600 * 1000).getUTCFullYear();
  const jiePrev = buildJie12Utc(yJst - 1);
  const jieThis = buildJie12Utc(yJst);
  const jieNext = buildJie12Utc(yJst + 1);
  const all = [...jiePrev, ...jieThis, ...jieNext].sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());

  // latest: j.timeUtc <= dateUtc (with precision/tieBreak)
  let latest = null;
  for (const j of all) {
    const cmp = compareWithTie(j.timeUtc, dateUtcForJst, precision, tieBreak);
    // cmp === 1 means j >= date (or tie treated as after) when comparing j vs date.
    // we need j <= date : that is NOT (j > date). simplest:
    if (j.timeUtc.getTime() <= dateUtcForJst.getTime()) {
      // keep tentative, but handle tie policy by using compareWithTie(date, j)
      const isAfter = compareWithTie(dateUtcForJst, j.timeUtc, precision, tieBreak) !== -1;
      if (isAfter) latest = j;
      continue;
    } else {
      // j is strictly after by ms; cannot be latest
      break;
    }
  }
  if (!latest) latest = all[0];

  const angleOrder = [315,345,15,45,75,105,135,165,195,225,255,285];
  const idx = angleOrder.indexOf(latest.angle);
  const monthIndex = idx >= 0 ? idx : 0;

  const monthBranch = MONTH_BRANCHES[monthIndex];
  const firstStem = tigerMonthStemForYearStem(yearPillarStem);
  const monthStem = addStem(firstStem, monthIndex);

  return {
    kan: monthStem,
    shi: monthBranch,
    sekkiUsed: {
      name: latest.name,
      angle: latest.angle,
      timeJst: formatJst(latest.timeUtc),
      timeJstSec: formatJstSec(latest.timeUtc)
    }
  };
}

// ---- 十神（通変星） ----
const STEM_INFO = {
  "甲": { elem: "wood", yin: "yang" }, "乙": { elem: "wood", yin: "yin" },
  "丙": { elem: "fire", yin: "yang" }, "丁": { elem: "fire", yin: "yin" },
  "戊": { elem: "earth", yin: "yang" }, "己": { elem: "earth", yin: "yin" },
  "庚": { elem: "metal", yin: "yang" }, "辛": { elem: "metal", yin: "yin" },
  "壬": { elem: "water", yin: "yang" }, "癸": { elem: "water", yin: "yin" }
};
function relationElem(dayElem, otherElem) {
  const order = ["wood","fire","earth","metal","water"];
  const di = order.indexOf(dayElem);
  const oi = order.indexOf(otherElem);
  if (di < 0 || oi < 0) return "same";
  if (dayElem === otherElem) return "same";

  if (order[(di + 1) % 5] === otherElem) return "produce_out";
  if (order[(oi + 1) % 5] === dayElem) return "produce_in";

  const controls = { wood: "earth", fire: "metal", earth: "water", metal: "wood", water: "fire" };
  if (controls[dayElem] === otherElem) return "control_out";
  if (controls[otherElem] === dayElem) return "control_in";
  return "same";
}
function tenDeity(dayStem, otherStem) {
  if (!dayStem || !otherStem) return null;
  if (dayStem === otherStem) return "比肩";
  const d = STEM_INFO[dayStem];
  const o = STEM_INFO[otherStem];
  if (!d || !o) return null;
  const rel = relationElem(d.elem, o.elem);
  const samePolarity = d.yin === o.yin;

  if (rel === "same") return samePolarity ? "比肩" : "劫財";
  if (rel === "produce_out") return samePolarity ? "食神" : "傷官";
  if (rel === "produce_in") return samePolarity ? "偏印" : "印綬";
  if (rel === "control_out") return samePolarity ? "偏財" : "正財";
  if (rel === "control_in") return samePolarity ? "七殺" : "正官";
  return null;
}

// ---- 蔵干表 ----
const ZOKAN_TABLE = {
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
  "亥": ["壬","甲"]
};

// ---- 五行カウント ----
function elementOfStem(stem) { return STEM_INFO[stem]?.elem || null; }
function countFiveElementsFromPillars(pillars) {
  const counts = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  const addStemCount = (s) => {
    const e = elementOfStem(s);
    if (e) counts[e] += 1;
  };

  addStemCount(pillars.year.kan);
  addStemCount(pillars.month.kan);
  addStemCount(pillars.day.kan);
  if (pillars.hour) addStemCount(pillars.hour.kan);

  for (const k of ["year","month","day","hour"]) {
    const p = pillars[k];
    if (!p) continue;
    const z = Array.isArray(p.zokan) ? p.zokan : [];
    for (const s of z) addStemCount(s);
  }
  return counts;
}

// ---- 大運/年運 ----
function isYangStem(stem) { return STEM_INFO[stem]?.yin === "yang"; }
function calcDirection(yearStem, sex) {
  if (!sex || (sex !== "M" && sex !== "F")) return null;
  const yang = isYangStem(yearStem);
  if (yang && sex === "M") return "forward";
  if (yang && sex === "F") return "backward";
  if (!yang && sex === "M") return "backward";
  return "forward";
}
function findNearestJieForStart(birthUtc, direction) {
  const yJst = new Date(birthUtc.getTime() + 9 * 3600 * 1000).getUTCFullYear();
  const all = [
    ...buildJie12Utc(yJst - 1),
    ...buildJie12Utc(yJst),
    ...buildJie12Utc(yJst + 1),
  ].sort((a,b)=>a.timeUtc.getTime()-b.timeUtc.getTime());

  let prev = null, next = null;
  for (const j of all) {
    if (j.timeUtc.getTime() <= birthUtc.getTime()) prev = j;
    if (j.timeUtc.getTime() > birthUtc.getTime()) { next = j; break; }
  }
  if (!prev) prev = all[0];
  if (!next) next = all[all.length - 1];
  return direction === "backward" ? prev : next;
}
function calcStartAgeByJieDiffMinutes(birthUtc, targetJie) {
  const diffMs = Math.abs(targetJie.timeUtc.getTime() - birthUtc.getTime());
  const diffMinutes = diffMs / (1000 * 60);

  const minutesPerYear = 3 * 24 * 60; // 3 days
  const yearsExact = diffMinutes / minutesPerYear;

  const yearsInt = Math.floor(yearsExact);
  const monthsExact = (yearsExact - yearsInt) * 12;
  const monthsInt = Math.floor(monthsExact);
  const daysApprox = Math.round((monthsExact - monthsInt) * 30.44);

  const yearsRounded1 = Math.round(yearsExact * 10) / 10;

  return {
    yearsExact,
    yearsRounded1,
    detail: { years: yearsInt, months: monthsInt, days: daysApprox },
    diffMinutes: Math.round(diffMinutes)
  };
}
function buildDayun(monthPillar, direction, startAgeYears, count = 10, dayStemForTenDeity) {
  const step = direction === "backward" ? -1 : 1;
  const list = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    const kan = addStem(monthPillar.kan, step * n);
    const shi = addBranch(monthPillar.shi, step * n);
    const ageFrom = Math.round((startAgeYears + (i * 10)) * 10) / 10;
    const ageTo = Math.round((startAgeYears + ((i + 1) * 10)) * 10) / 10;
    list.push({
      kan, shi,
      tenDeity: dayStemForTenDeity ? tenDeity(dayStemForTenDeity, kan) : null,
      ageFrom, ageTo
    });
  }
  return list;
}
function getRisshunUtcForYear(y) {
  const jie = buildJie12Utc(y);
  return jie.find(j => j.angle === 315) || null;
}
function parseAsOfDateJstToUtc(asOfDateStr) {
  const [Y, M, D] = asOfDateStr.split("-").map((v) => parseInt(v, 10));
  return new Date(Date.UTC(Y, M - 1, D, -9, 0, 0));
}
function getNenunYearByRisshun(asOfUtc) {
  const asOfJst = new Date(asOfUtc.getTime() + 9 * 3600 * 1000);
  const y = asOfJst.getUTCFullYear();
  const r = getRisshunUtcForYear(y);
  if (!r) return y;
  if (asOfUtc.getTime() < r.timeUtc.getTime()) return y - 1;
  return y;
}
function buildNenunList(centerYear, span = 6, dayStemForTenDeity) {
  const list = [];
  for (let y = centerYear - span; y <= centerYear + span; y++) {
    const yp = calcYearPillarByRisshun(y);
    list.push({
      pillarYear: y,
      kan: yp.kan,
      shi: yp.shi,
      tenDeity: dayStemForTenDeity ? tenDeity(dayStemForTenDeity, yp.kan) : null
    });
  }
  return list;
}
function pickCurrentDayunIndex(dayun, ageYears) {
  if (!Array.isArray(dayun) || dayun.length === 0) return -1;
  for (let i = 0; i < dayun.length; i++) {
    const d = dayun[i];
    if (ageYears >= d.ageFrom && ageYears < d.ageTo) return i;
  }
  if (ageYears < dayun[0].ageFrom) return 0;
  return dayun.length - 1;
}
function calcAgeYearsAtAsOf(birthDateJstYMD, asOfUtc) {
  const birth = new Date(Date.UTC(birthDateJstYMD.Y, birthDateJstYMD.M - 1, birthDateJstYMD.D, -9, 0, 0));
  const diffDays = (asOfUtc.getTime() - birth.getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round((diffDays / 365.2425) * 10) / 10);
}

// ---- API ----
export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (cors.ended) return;

  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const date = body?.date;
    const time = body?.time ?? "";
    const sex = body?.sex ?? "";
    const birthPlace = body?.birthPlace ?? null;
    const timeMode = body?.timeMode ?? "standard";
    const dayBoundaryMode = body?.dayBoundaryMode ?? "24";
    const asOfDate = body?.asOfDate ?? null;

    // ★年柱(立春)境界判定に使う時刻参照
    const boundaryTimeRef = body?.boundaryTimeRef ?? "used";

    // ★節入り境界 精密化
    const sekkiBoundaryPrecision = body?.sekkiBoundaryPrecision ?? "second"; // "second" | "minute"
    const sekkiBoundaryTieBreak = body?.sekkiBoundaryTieBreak ?? "after";     // "after" | "before"

    if (!date || typeof date !== "string") {
      return res.status(400).json({ ok: false, error: "date required (YYYY-MM-DD)" });
    }

    // --- 入力(JST) → UTC ---
    const parsed = parseDateTimeJstToUtc(date, time);
    const { Y, M, D } = parsed;

    // standard
    const stdUtc = parsed.utc;
    const stdHH = parsed.hh;
    const stdMM = parsed.mm;
    const stdHHMM = time ? fmtHHMM(stdHH, stdMM) : "";

    // --- Phase B / B+ 補正 ---
    let usedUtc = new Date(stdUtc.getTime());
    let usedHH = stdHH;
    let usedMM = stdMM;

    let longitude = null;
    let lonCorrectionMin = 0;
    let eqTimeMin = 0;

    const wantsMeanSolar = timeMode === "mean_solar" || timeMode === "true_solar";
    const wantsTrueSolar = timeMode === "true_solar";

    if (wantsMeanSolar && birthPlace?.country === "JP" && birthPlace?.pref) {
      longitude = PREF_LONGITUDE[birthPlace.pref] ?? null;

      if (longitude != null && time) {
        // 経度差（平均太陽時）
        lonCorrectionMin = (longitude - 135) * 4;
        usedUtc = new Date(usedUtc.getTime() + lonCorrectionMin * 60 * 1000);

        // 均時差（真太陽時）
        if (wantsTrueSolar) {
          eqTimeMin = equationOfTimeMinutes(usedUtc);
          usedUtc = new Date(usedUtc.getTime() + eqTimeMin * 60 * 1000);
        }

        const usedJst = new Date(usedUtc.getTime() + 9 * 3600 * 1000);
        usedHH = usedJst.getUTCHours();
        usedMM = usedJst.getUTCMinutes();
      }
    }

    const usedHHMM = time ? fmtHHMM(usedHH, usedMM) : "";

    // ---- Phase A: 立春で年替わり & 節で月替わり ----
    const jieThis = buildJie12Utc(Y);
    const risshun = jieThis.find(j => j.angle === 315) || null;

    // 境界判定に使う基準時刻
    const boundaryUtc = (boundaryTimeRef === "standard") ? stdUtc : usedUtc;

    let yearForPillar = Y;
    if (risshun) {
      const cmp = compareWithTie(boundaryUtc, risshun.timeUtc, sekkiBoundaryPrecision, sekkiBoundaryTieBreak);
      if (cmp === -1) yearForPillar = Y - 1;
    }

    const yearP = calcYearPillarByRisshun(yearForPillar);

    // ★月柱も precision/tieBreak を適用
    const monthP = calcMonthPillarByJie(
      usedUtc,
      yearP.kan,
      sekkiBoundaryPrecision,
      sekkiBoundaryTieBreak
    );

    // ---- Phase C: 日柱（23/24切替）----
    const dayP = calcDayPillarWithBoundary({ Y, M, D, hh: usedHH, mm: usedMM, dayBoundaryMode });

    // ---- 時柱：used時刻で判定 ----
    let hourP = null;
    if (time && time.includes(":")) {
      const hb = hourBranchFromTime(usedHH, usedMM);
      const hs = hourStemFromDayStemAndHourBranch(dayP.kan, hb);
      hourP = { kan: hs, shi: hb };
    }

    // ---- 蔵干付与 ----
    const yearZ = ZOKAN_TABLE[yearP.shi] || [];
    const monthZ = ZOKAN_TABLE[monthP.shi] || [];
    const dayZ = ZOKAN_TABLE[dayP.shi] || [];
    const hourZ = hourP ? (ZOKAN_TABLE[hourP.shi] || []) : [];

    const tenDeityTop = {
      year: tenDeity(dayP.kan, yearP.kan),
      month: tenDeity(dayP.kan, monthP.kan),
      day: "日主",
      hour: hourP ? tenDeity(dayP.kan, hourP.kan) : null
    };

    const zokanTenDeity = {
      year: yearZ.map(stem => ({ stem, deity: tenDeity(dayP.kan, stem) })),
      month: monthZ.map(stem => ({ stem, deity: tenDeity(dayP.kan, stem) })),
      day: dayZ.map(stem => ({ stem, deity: tenDeity(dayP.kan, stem) })),
      hour: hourP ? hourZ.map(stem => ({ stem, deity: tenDeity(dayP.kan, stem) })) : []
    };

    const pillars = {
      year: { kan: yearP.kan, shi: yearP.shi, zokan: yearZ, rule: "sekki_risshun" },
      month: { kan: monthP.kan, shi: monthP.shi, zokan: monthZ, rule: "sekki_12jie" },
      day: { kan: dayP.kan, shi: dayP.shi, zokan: dayZ, rule: "day_boundary_" + String(dayBoundaryMode) },
      hour: hourP ? { kan: hourP.kan, shi: hourP.shi, zokan: hourZ, rule: "hour_by_used_time" } : null
    };

    const fiveCounts = countFiveElementsFromPillars(pillars);

    // ---- Phase D/D+: 大運/年運 ----
    const direction = calcDirection(yearP.kan, sex);

    let dayun = null;
    let nenun = null;
    let current = null;

    let startAgeYears = null;
    let startAgeDetail = null;
    let startCalcMode = null;
    let startDiffMinutes = null;

    if (direction) {
      const targetJie = findNearestJieForStart(usedUtc, direction);

      const start = calcStartAgeByJieDiffMinutes(usedUtc, targetJie);
      startAgeYears = start.yearsRounded1;
      startAgeDetail = start.detail;
      startDiffMinutes = start.diffMinutes;
      startCalcMode = "jie_diff_minutes_div(3days)";

      dayun = buildDayun(
        { kan: monthP.kan, shi: monthP.shi },
        direction,
        startAgeYears,
        10,
        dayP.kan
      );

      const asOfUtc = (asOfDate && typeof asOfDate === "string" && asOfDate.includes("-"))
        ? parseAsOfDateJstToUtc(asOfDate)
        : new Date();

      const nenunYear = getNenunYearByRisshun(asOfUtc);
      nenun = buildNenunList(nenunYear, 6, dayP.kan);

      const ageYears = calcAgeYearsAtAsOf({ Y, M, D }, asOfUtc);
      const currentDayunIndex = pickCurrentDayunIndex(dayun, ageYears);
      const currentNenunIndex = nenun.findIndex(x => x.pillarYear === nenunYear);

      current = {
        asOfDateUsed: (asOfDate && typeof asOfDate === "string") ? asOfDate : null,
        ageYears,
        currentDayunIndex,
        currentNenunIndex,
        nenunYearByRisshun: nenunYear
      };
    }

    const currentNenun =
      (nenun && current?.currentNenunIndex >= 0)
        ? nenun[current.currentNenunIndex]
        : null;
    const currentDayun =
      (dayun && current?.currentDayunIndex >= 0)
        ? dayun[current.currentDayunIndex]
        : null;

    const meta = {
      standard: { y: Y, m: M, d: D, time: stdHHMM || "" },
      used: {
        y: Y,
        m: M,
        d: D,
        time: usedHHMM || "",
        timeModeUsed: timeMode,
        dayBoundaryModeUsed: String(dayBoundaryMode),
        boundaryTimeRefUsed: boundaryTimeRef,
        sekkiBoundaryPrecisionUsed: sekkiBoundaryPrecision,
        sekkiBoundaryTieBreakUsed: sekkiBoundaryTieBreak,
        sekkiUsed: monthP.sekkiUsed,
        yearBoundary: risshun
          ? { name: "立春", timeJst: formatJst(risshun.timeUtc), timeJstSec: formatJstSec(risshun.timeUtc) }
          : null,
        yearPillarYearUsed: yearForPillar
      },
      place: birthPlace ? { ...birthPlace } : null
    };

    if ((timeMode === "mean_solar" || timeMode === "true_solar") && birthPlace?.country === "JP" && birthPlace?.pref) {
      meta.place = {
        ...(birthPlace ? { ...birthPlace } : {}),
        longitude: longitude,
        lonCorrectionMin: Number((lonCorrectionMin).toFixed(2)),
        ...(timeMode === "true_solar" ? { eqTimeMin: Number((eqTimeMin).toFixed(2)) } : {})
      };
    }

    // ★検証用（標準/補正後のどちらが立春前かを併記 + 秒表示）
    if (risshun) {
      meta.used.yearBoundaryCheck = {
        standardIsBeforeRisshun: compareWithTie(stdUtc, risshun.timeUtc, sekkiBoundaryPrecision, sekkiBoundaryTieBreak) === -1,
        usedIsBeforeRisshun: compareWithTie(usedUtc, risshun.timeUtc, sekkiBoundaryPrecision, sekkiBoundaryTieBreak) === -1,
        standardTimeJst: formatJst(stdUtc),
        usedTimeJst: formatJst(usedUtc),
        standardTimeJstSec: formatJstSec(stdUtc),
        usedTimeJstSec: formatJstSec(usedUtc),
        risshunTimeJstSec: formatJstSec(risshun.timeUtc)
      };
    }

    const result = {
      ok: true,
      input: {
        date,
        time,
        sex,
        birthPlace,
        timeMode,
        dayBoundaryMode,
        boundaryTimeRef,
        sekkiBoundaryPrecision,
        sekkiBoundaryTieBreak,
        ...(asOfDate ? { asOfDate } : {})
      },
      meta,
      pillars,
      derived: {
        tenDeity: tenDeityTop,
        zokanTenDeity,
        fiveElements: {
          counts: fiveCounts,
          note: "Counted from stems: year/month/day/hour + all hidden stems (zokan)."
        },
        luck: {
          direction: direction || null,
          startCalcMode: startCalcMode || null,
          startDiffMinutes: startDiffMinutes ?? null,
          startAgeYears: startAgeYears ?? null,
          startAgeDetail: startAgeDetail ?? null,
          current: current || null,
          dayun: dayun || null,
          nenun: nenun || null,
          currentNenun: currentNenun || null,
          currentDayun: currentDayun || null
        }
      }
    };

    return res.status(200).json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
