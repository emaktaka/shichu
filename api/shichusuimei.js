// api/shichusuimei.js
// Phase A: 「節入り（24節気）」の境界で月柱（＋年柱の立春境界）を確定する
// Phase B: 「真太陽時（平均太陽時）」= 経度差補正（明石135°基準）
// Phase C: 「日干支の23時/24時切替」(入力 dayBoundaryMode)
// Phase D: 「大運/年運」+ 年運は立春境界で切る精密版
//
// POST /api/shichusuimei
// body: {
//   date: "YYYY-MM-DD",
//   time: "HH:MM" | "",
//   sex: "M"|"F"|"",
//   birthPlace: {country:"JP", pref:"東京都"} | null,
//   timeMode: "standard"|"mean_solar",
//   dayBoundaryMode: "23"|"24",
//   asOfDate?: "YYYY-MM-DD"   // 任意：年運/大運の「現在」をこの日付で判定（なければサーバー当日）
// }
//
// env:
//   ALLOWED_ORIGINS = "https://spikatsu.anjyanen.com,https://www.spikatsu.anjyanen.com"

import { applyCors } from "../lib/cors.js";
import { buildJie12Utc, formatJst } from "../lib/sekki.js";

// ---- 干支ユーティリティ ----
const STEMS = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];

// 月支（寅から順）
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

// 年干→寅月の干（五虎遁）
function tigerMonthStemForYearStem(yearStem) {
  // 甲己年: 丙寅 / 乙庚年: 戊寅 / 丙辛年: 庚寅 / 丁壬年: 壬寅 / 戊癸年: 甲寅
  if (yearStem === "甲" || yearStem === "己") return "丙";
  if (yearStem === "乙" || yearStem === "庚") return "戊";
  if (yearStem === "丙" || yearStem === "辛") return "庚";
  if (yearStem === "丁" || yearStem === "壬") return "壬";
  return "甲"; // 戊 or 癸
}

function addStem(stem, add) {
  const i = STEMS.indexOf(stem);
  return STEMS[(i + add + 10) % 10];
}
function addBranch(branch, add) {
  const i = BRANCHES.indexOf(branch);
  return BRANCHES[(i + add + 12) % 12];
}

// ---- Phase A: 年柱の干支（立春境界） ----
function calcYearPillarByRisshun(yearNumber) {
  // 1984年が甲子年
  const idx = (yearNumber - 1984) % 60;
  const i = (idx + 60) % 60;
  return { kan: STEMS[i % 10], shi: BRANCHES[i % 12] };
}

// ---- Phase C: 日柱 23/24 境界（簡易日干支） ----
// ※Phase Aの簡易方式を保ちつつ、境界だけ切り替え可能にする
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
  // 基準日: 1984-02-02 を 甲子日
  const baseJdn = toJdnAtUtcMidnight(1984, 2, 2);
  const jdn = toJdnAtUtcMidnight(y, m, d);
  const diff = jdn - baseJdn;
  const idx = (diff % 60 + 60) % 60;
  return { kan: STEMS[idx % 10], shi: BRANCHES[idx % 12] };
}
function calcDayPillarWithBoundary({ Y, M, D, hh, mm, dayBoundaryMode }) {
  // dayBoundaryMode "24": 0:00で日替わり（そのままYMD）
  // dayBoundaryMode "23": 23:00以降は翌日扱い（古流の境界）
  let y = Y, m = M, d = D;
  if (String(dayBoundaryMode) === "23") {
    const minutes = hh * 60 + mm;
    if (minutes >= 23 * 60) {
      // 翌日へ（簡易）
      const dt = new Date(Date.UTC(Y, M - 1, D, 0, 0, 0));
      dt.setUTCDate(dt.getUTCDate() + 1);
      y = dt.getUTCFullYear();
      m = dt.getUTCMonth() + 1;
      d = dt.getUTCDate();
    }
  }
  return calcDayPillarSimpleByYMD(y, m, d);
}

// ---- 時柱（簡易：真太陽時補正後の時刻で判定） ----
function hourBranchFromTime(hh, mm) {
  // 子:23-01, 丑:01-03 ... 亥:21-23
  const minutes = hh * 60 + mm;
  if (minutes >= 23 * 60) return "子";
  const slot = Math.floor((minutes + 60) / 120);
  return BRANCHES[slot % 12];
}
function hourStemFromDayStemAndHourBranch(dayStem, hourBranch) {
  // 五鼠遁：甲己日 甲子時、乙庚日 丙子時、丙辛日 戊子時、丁壬日 庚子時、戊癸日 壬子時
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

// ---- 月柱：節入り（12節）で境界を切る（Phase Aの本体） ----
function calcMonthPillarByJie(dateUtcForJst, yearPillarStem) {
  const yJst = new Date(dateUtcForJst.getTime() + 9 * 3600 * 1000).getUTCFullYear();

  const jiePrev = buildJie12Utc(yJst - 1);
  const jieThis = buildJie12Utc(yJst);
  const jieNext = buildJie12Utc(yJst + 1);

  const all = [...jiePrev, ...jieThis, ...jieNext].sort(
    (a, b) => a.timeUtc.getTime() - b.timeUtc.getTime()
  );

  let latest = null;
  for (const j of all) {
    if (j.timeUtc.getTime() <= dateUtcForJst.getTime()) latest = j;
    else break;
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
    sekkiUsed: { name: latest.name, angle: latest.angle, timeJst: formatJst(latest.timeUtc) }
  };
}

// ---- 入力処理（JST入力→UTC Date） ----
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

// ---- Phase D: 十神（通変星）計算（干→五行/陰陽） ----
const STEM_INFO = {
  "甲": { elem: "wood", yin: "yang" }, "乙": { elem: "wood", yin: "yin" },
  "丙": { elem: "fire", yin: "yang" }, "丁": { elem: "fire", yin: "yin" },
  "戊": { elem: "earth", yin: "yang" }, "己": { elem: "earth", yin: "yin" },
  "庚": { elem: "metal", yin: "yang" }, "辛": { elem: "metal", yin: "yin" },
  "壬": { elem: "water", yin: "yang" }, "癸": { elem: "water", yin: "yin" }
};
function relationElem(dayElem, otherElem) {
  // return: "same" | "produce_out" | "produce_in" | "control_out" | "control_in"
  // 生： wood->fire->earth->metal->water->wood
  const order = ["wood","fire","earth","metal","water"];
  const di = order.indexOf(dayElem);
  const oi = order.indexOf(otherElem);
  if (di < 0 || oi < 0) return "same";
  if (dayElem === otherElem) return "same";
  // day produces other
  if (order[(di + 1) % 5] === otherElem) return "produce_out";
  // other produces day
  if (order[(oi + 1) % 5] === dayElem) return "produce_in";
  // day controls other: wood controls earth, fire controls metal, earth controls water, metal controls wood, water controls fire
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

  // 伝統的な割当
  // same: 比肩(同陰陽)/劫財(異陰陽)
  if (rel === "same") return samePolarity ? "比肩" : "劫財";
  // produce_out: 食神(同)/傷官(異)
  if (rel === "produce_out") return samePolarity ? "食神" : "傷官";
  // produce_in: 偏印(同)/印綬(異)  ※流派で呼称が逆の場合あり（ここは一般的な並び）
  if (rel === "produce_in") return samePolarity ? "偏印" : "印綬";
  // control_out: 偏財(同)/正財(異)
  if (rel === "control_out") return samePolarity ? "偏財" : "正財";
  // control_in: 七殺(同)/正官(異)
  if (rel === "control_in") return samePolarity ? "七殺" : "正官";

  return null;
}

// ---- Phase D: 蔵干（簡易） ----
// ※最小の蔵干表（必要分のみ）— 全支を用意（のちに精密版へ差し替え可能）
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

// ---- Phase D: 五行カウント ----
function elementOfStem(stem) {
  return STEM_INFO[stem]?.elem || null;
}
function countFiveElementsFromPillars(pillars) {
  const counts = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };

  const addStemCount = (s) => {
    const e = elementOfStem(s);
    if (e) counts[e] += 1;
  };

  // 表干
  addStemCount(pillars.year.kan);
  addStemCount(pillars.month.kan);
  addStemCount(pillars.day.kan);
  if (pillars.hour) addStemCount(pillars.hour.kan);

  // 蔵干
  for (const k of ["year","month","day","hour"]) {
    const p = pillars[k];
    if (!p) continue;
    const z = Array.isArray(p.zokan) ? p.zokan : [];
    for (const s of z) addStemCount(s);
  }
  return counts;
}

// ---- Phase D: 大運 / 年運 ----
function isYangStem(stem) {
  const yin = STEM_INFO[stem]?.yin;
  return yin === "yang";
}
function calcDirection(yearStem, sex) {
  // よく使われるルール：
  // 陽年：男=順行 女=逆行 / 陰年：男=逆行 女=順行
  if (!sex || (sex !== "M" && sex !== "F")) return null;
  const yang = isYangStem(yearStem);
  if (yang && sex === "M") return "forward";
  if (yang && sex === "F") return "backward";
  if (!yang && sex === "M") return "backward";
  return "forward"; // !yang && F
}

function findNearestJieForStart(birthUtc, direction) {
  // 起運：順行→次の節、逆行→前の節までの日数を使う（節＝12節）
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

function calcStartAgeYearsByJieDiff(birthUtc, targetJie) {
  // 古典：節までの日数 ÷ 3 ＝ 起運年齢（年）
  const diffMs = Math.abs(targetJie.timeUtc.getTime() - birthUtc.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const years = diffDays / 3;
  // UI向けに小数1桁
  return Math.round(years * 10) / 10;
}

function buildDayun(monthPillar, direction, startAgeYears, count = 10, dayStemForTenDeity) {
  // 月柱からスタートし、順行なら+1、逆行なら-1で干支を進める。各10年刻み。
  const step = direction === "backward" ? -1 : 1;

  const list = [];
  for (let i = 0; i < count; i++) {
    const n = i + 1; // 1運目は月柱の次として扱う流派が多いが、ここでは「月柱から+1」を1運目にする
    const kan = addStem(monthPillar.kan, step * n);
    const shi = addBranch(monthPillar.shi, step * n);

    const ageFrom = Math.round((startAgeYears + (i * 10)) * 10) / 10;
    const ageTo = Math.round((startAgeYears + ((i + 1) * 10)) * 10) / 10;

    list.push({
      kan,
      shi,
      tenDeity: dayStemForTenDeity ? tenDeity(dayStemForTenDeity, kan) : null,
      ageFrom,
      ageTo
    });
  }
  return list;
}

function getRisshunUtcForYear(y) {
  const jie = buildJie12Utc(y);
  return jie.find(j => j.angle === 315) || null; // 立春
}

function parseAsOfDateJstToUtc(asOfDateStr) {
  // asOfDate: YYYY-MM-DD（JSTの0時として扱う）
  const [Y, M, D] = asOfDateStr.split("-").map((v) => parseInt(v, 10));
  return new Date(Date.UTC(Y, M - 1, D, -9, 0, 0)); // JST 00:00 -> UTC -9h
}

function getNenunYearByRisshun(asOfUtc) {
  // asOfUtc を JST 年に直して、その年の立春と比較して「年運年」を確定
  const asOfJst = new Date(asOfUtc.getTime() + 9 * 3600 * 1000);
  const y = asOfJst.getUTCFullYear();

  const r = getRisshunUtcForYear(y);
  if (!r) return y;

  // asOf が立春より前なら前年扱い
  if (asOfUtc.getTime() < r.timeUtc.getTime()) return y - 1;
  return y;
}

function buildNenunList(centerYear, span = 6, dayStemForTenDeity) {
  // centerYear を中心に (span*2+1) 年返す（例：前後6年=13年分）
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
  // 範囲外の場合：最も近い
  if (ageYears < dayun[0].ageFrom) return 0;
  return dayun.length - 1;
}

function calcAgeYearsAtAsOf(birthDateJstYMD, asOfUtc) {
  // birthDateJstYMD: {Y,M,D} (JST日付)
  // asOfUtc: UTC Date（JST換算の“現在日”）
  const birth = new Date(Date.UTC(birthDateJstYMD.Y, birthDateJstYMD.M - 1, birthDateJstYMD.D, -9, 0, 0)); // JST 00:00
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

    if (!date || typeof date !== "string") {
      return res.status(400).json({ ok: false, error: "date required (YYYY-MM-DD)" });
    }

    // --- 入力(JST) → UTC ---
    const parsed = parseDateTimeJstToUtc(date, time);
    const { Y, M, D } = parsed;

    // standard（入力そのままのJST時刻）
    const stdUtc = parsed.utc;
    const stdHH = parsed.hh;
    const stdMM = parsed.mm;
    const stdHHMM = time ? fmtHHMM(stdHH, stdMM) : "";

    // --- Phase B: 平均太陽時補正（usedUtc / usedHHMM を作る） ---
    let usedUtc = new Date(stdUtc.getTime());
    let usedHH = stdHH;
    let usedMM = stdMM;

    let longitude = null;
    let lonCorrectionMin = 0;

    if (timeMode === "mean_solar" && birthPlace?.country === "JP" && birthPlace?.pref) {
      longitude = PREF_LONGITUDE[birthPlace.pref] ?? null;
      if (longitude != null && time) {
        lonCorrectionMin = (longitude - 135) * 4; // 明石135°との差×4分
        usedUtc = new Date(usedUtc.getTime() + lonCorrectionMin * 60 * 1000);

        // usedUtc を JST 表示の hh:mm に再反映
        const usedJst = new Date(usedUtc.getTime() + 9 * 3600 * 1000);
        usedHH = usedJst.getUTCHours();
        usedMM = usedJst.getUTCMinutes();
      }
    }
    const usedHHMM = time ? fmtHHMM(usedHH, usedMM) : "";

    // ---- Phase A: 立春で年替わり & 節で月替わり ----
    // 年柱の立春は「入力日（JST）の年」で取得し、usedUtc と比較する
    const jieThis = buildJie12Utc(Y);
    const risshun = jieThis.find(j => j.angle === 315) || null;

    let yearForPillar = Y;
    if (risshun && usedUtc.getTime() < risshun.timeUtc.getTime()) {
      yearForPillar = Y - 1;
    }
    const yearP = calcYearPillarByRisshun(yearForPillar);

    // 月柱：節入り（12節）— 判定は usedUtc（平均太陽時補正後）で行う
    const monthP = calcMonthPillarByJie(usedUtc, yearP.kan);

    // ---- Phase C: 日柱（23/24切替）— 判定は usedHH:usedMM を使う ----
    const dayP = calcDayPillarWithBoundary({ Y, M, D, hh: usedHH, mm: usedMM, dayBoundaryMode });

    // ---- 時柱：判定は usedHH:usedMM を使う ----
    let hourP = null;
    if (time && time.includes(":")) {
      const hb = hourBranchFromTime(usedHH, usedMM);
      const hs = hourStemFromDayStemAndHourBranch(dayP.kan, hb);
      hourP = { kan: hs, shi: hb };
    }

    // ---- Phase D: 蔵干（支→蔵干表）付与 ----
    const yearZ = ZOKAN_TABLE[yearP.shi] || [];
    const monthZ = ZOKAN_TABLE[monthP.shi] || [];
    const dayZ = ZOKAN_TABLE[dayP.shi] || [];
    const hourZ = hourP ? (ZOKAN_TABLE[hourP.shi] || []) : [];

    // ---- Phase D: 通変星（十神）・蔵干十神 ----
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

    // ---- pillars 構築 ----
    const pillars = {
      year: { kan: yearP.kan, shi: yearP.shi, zokan: yearZ, rule: "sekki_risshun" },
      month: { kan: monthP.kan, shi: monthP.shi, zokan: monthZ, rule: "sekki_12jie" },
      day: { kan: dayP.kan, shi: dayP.shi, zokan: dayZ, rule: "day_boundary_" + String(dayBoundaryMode) },
      hour: hourP ? { kan: hourP.kan, shi: hourP.shi, zokan: hourZ, rule: "hour_by_used_time" } : null
    };

    // ---- Phase D: 五行カウント ----
    const fiveCounts = countFiveElementsFromPillars(pillars);

    // ---- Phase D: 大運/年運 ----
    const direction = calcDirection(yearP.kan, sex);
    const luck = { direction: direction || null };

    let dayun = null;
    let nenun = null;
    let current = null;
    let startAgeYears = null;
    let startCalcMode = null;

    if (direction) {
      const targetJie = findNearestJieForStart(usedUtc, direction);
      startAgeYears = calcStartAgeYearsByJieDiff(usedUtc, targetJie);
      startCalcMode = "jie_diff_days_div3";

      dayun = buildDayun(
        { kan: monthP.kan, shi: monthP.shi },
        direction,
        startAgeYears,
        10,
        dayP.kan
      );

      // 「現在」の判定日（asOfDateがあればそれ、なければサーバー当日）
      const asOfUtc = (asOfDate && typeof asOfDate === "string" && asOfDate.includes("-"))
        ? parseAsOfDateJstToUtc(asOfDate)
        : new Date();

      const nenunYear = getNenunYearByRisshun(asOfUtc);
      nenun = buildNenunList(nenunYear, 6, dayP.kan); // 前後6年=13年

      // current index
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

    luck.startCalcMode = startCalcMode;
    luck.startAgeYears = startAgeYears;
    luck.dayun = dayun;
    luck.nenun = nenun;
    luck.current = current;

    // 現在運を取り出し（AIに渡しやすい形）
    const currentNenun =
      (luck?.nenun && luck?.current?.currentNenunIndex >= 0)
        ? luck.nenun[luck.current.currentNenunIndex]
        : null;
    const currentDayun =
      (luck?.dayun && luck?.current?.currentDayunIndex >= 0)
        ? luck.dayun[luck.current.currentDayunIndex]
        : null;

    // ---- meta ----
    const meta = {
      standard: { y: Y, m: M, d: D, time: stdHHMM || "" },
      used: {
        y: Y,
        m: M,
        d: D,
        time: usedHHMM || "",
        timeModeUsed: timeMode,
        dayBoundaryModeUsed: String(dayBoundaryMode),
        sekkiUsed: monthP.sekkiUsed,
        yearBoundary: risshun ? { name: "立春", timeJst: formatJst(risshun.timeUtc) } : null,
        yearPillarYearUsed: yearForPillar
      },
      place: birthPlace ? { ...birthPlace } : null
    };

    if (timeMode === "mean_solar" && birthPlace?.country === "JP" && birthPlace?.pref) {
      meta.place = {
        ...(birthPlace ? { ...birthPlace } : {}),
        longitude: longitude,
        lonCorrectionMin: Number((lonCorrectionMin).toFixed(2))
      };
    }

    // ---- result ----
    const result = {
      ok: true,
      input: {
        date,
        time,
        sex,
        birthPlace,
        timeMode,
        dayBoundaryMode,
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
          direction: luck.direction || null,
          startCalcMode: luck.startCalcMode || null,
          startAgeYears: (luck.startAgeYears ?? null),
          current: luck.current || null,
          dayun: luck.dayun || null,
          nenun: luck.nenun || null,
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
