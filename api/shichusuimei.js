// api/shichusuimei.js
// Phase A: 「節入り（24節気）」の境界で月柱（＋年柱の立春境界）を確定する
//
// POST /api/shichusuimei
// body: {
//   date: "YYYY-MM-DD",
//   time: "HH:MM" | "",
//   sex: "M"|"F"|"",
//   birthPlace: {country:"JP", pref:"東京都"} | null,
//   timeMode: "standard"|"mean_solar",     // Phase Bで精密化
//   dayBoundaryMode: "23"|"24"             // Phase Cで精密化
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

// 年干→寅月の干（五虎遁）
function tigerMonthStemForYearStem(yearStem) {
  // 甲己年: 丙寅
  // 乙庚年: 戊寅
  // 丙辛年: 庚寅
  // 丁壬年: 壬寅
  // 戊癸年: 甲寅
  if (yearStem === "甲" || yearStem === "己") return "丙";
  if (yearStem === "乙" || yearStem === "庚") return "戊";
  if (yearStem === "丙" || yearStem === "辛") return "庚";
  if (yearStem === "丁" || yearStem === "壬") return "壬";
  return "甲"; // 戊 or 癸
}

function sexagenaryIndexFromStemBranch(stem, branch) {
  const s = STEMS.indexOf(stem);
  const b = BRANCHES.indexOf(branch);
  if (s < 0 || b < 0) return -1;
  // brute match
  for (let i = 0; i < 60; i++) {
    if (STEMS[i % 10] === stem && BRANCHES[i % 12] === branch) return i;
  }
  return -1;
}

function addStem(stem, add) {
  const i = STEMS.indexOf(stem);
  return STEMS[(i + add + 10) % 10];
}

// ---- 簡易：年柱の干支（立春境界） ----
// ここは Phase A なので “年柱=立春で切替” だけをまず正しく。
// 干支自体は「立春を含む太陽年」ベースで、(year-4) を基準に算出する古典式。
function calcYearPillarByRisshun(yearNumber) {
  // 1984年が甲子年（干支サイクル基準）として扱う
  const idx = (yearNumber - 1984) % 60;
  const i = (idx + 60) % 60;
  return { kan: STEMS[i % 10], shi: BRANCHES[i % 12] };
}

// ---- 日柱/時柱はPhase Aでは“簡易”に実装（後でCで境界精密化） ----
// ※すでにあなたのプロジェクトは「stub」だったので、まずは“動く”日柱/時柱を用意。
//   精密な23/24切替はPhase Cで差し替える。
function toJdnAtUtcMidnight(y, m, d) {
  // Gregorian to JDN at 00:00 UTC
  // https://quasar.as.utexas.edu/BillInfo/JulianDatesG.html (standard algorithm)
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

function calcDayPillarSimple(y, m, d) {
  // 基準日: 1984-02-02 を 甲子日として扱う簡易方式
  const baseJdn = toJdnAtUtcMidnight(1984, 2, 2);
  const jdn = toJdnAtUtcMidnight(y, m, d);
  const diff = jdn - baseJdn;
  const idx = (diff % 60 + 60) % 60;
  return { kan: STEMS[idx % 10], shi: BRANCHES[idx % 12] };
}

function hourBranchFromTime(hh, mm) {
  // 子:23-01, 丑:01-03 ... 亥:21-23
  const minutes = hh * 60 + mm;
  // 23:00-23:59 -> 子
  if (minutes >= 23 * 60) return "子";
  const slot = Math.floor((minutes + 60) / 120); // shift so 00:00-00:59 -> 子 slot 0
  return BRANCHES[slot % 12];
}

function hourStemFromDayStemAndHourBranch(dayStem, hourBranch) {
  // 五鼠遁：甲己日 甲子時、乙庚日 丙子時、丙辛日 戊子時、丁壬日 庚子時、戊癸日 壬子時
  let ziStem;
  if (dayStem === "甲" || dayStem === "己") ziStem = "甲";
  else if (dayStem === "乙" || dayStem === "庚") ziStem = "丙";
  else if (dayStem === "丙" || dayStem === "辛") ziStem = "戊";
  else if (dayStem === "丁" || dayStem === "壬") ziStem = "庚";
  else ziStem = "壬"; // 戊 or 癸

  const ziIndex = STEMS.indexOf(ziStem);
  const hbIndex = BRANCHES.indexOf(hourBranch);
  // 子を0として枝の順で+1ずつ
  const stem = STEMS[(ziIndex + hbIndex) % 10];
  return stem;
}

// ---- 月柱：節入り（12節）で境界を切る（Phase Aの本体） ----
function calcMonthPillarByJie(dateUtcForJst, yearPillarStem) {
  // dateUtcForJst: 入力のJST日時をUTC Dateで表したもの（= JST時刻の-9h）
  // "節"の境界は年をまたぐので、対象年と前後年のjieを作って結合して判定
  const yJst = new Date(dateUtcForJst.getTime() + 9 * 3600 * 1000).getUTCFullYear();

  const jiePrev = buildJie12Utc(yJst - 1);
  const jieThis = buildJie12Utc(yJst);
  const jieNext = buildJie12Utc(yJst + 1);

  const all = [...jiePrev, ...jieThis, ...jieNext].sort((a, b) => a.timeUtc.getTime() - b.timeUtc.getTime());

  // find the latest jie <= dateUtcForJst
  let latest = null;
  for (const j of all) {
    if (j.timeUtc.getTime() <= dateUtcForJst.getTime()) latest = j;
    else break;
  }
  if (!latest) {
    // should not happen, but fallback
    latest = all[0];
  }

  // Determine month index based on jie order starting at 立春 = 寅月
  // We create a "cycle" list that starts from the latest 立春 before date.
  // Simpler: compute monthIndex by mapping angle sequence:
  const angleOrder = [315,345,15,45,75,105,135,165,195,225,255,285]; // same as lib
  const idx = angleOrder.indexOf(latest.angle);
  const monthIndex = idx >= 0 ? idx : 0;

  const monthBranch = MONTH_BRANCHES[monthIndex];

  // month stem: start from 寅月 stem derived from year stem, then +monthIndex
  const firstStem = tigerMonthStemForYearStem(yearPillarStem);
  const monthStem = addStem(firstStem, monthIndex);

  return {
    kan: monthStem,
    shi: monthBranch,
    sekkiUsed: { name: latest.name, angle: latest.angle, timeJst: formatJst(latest.timeUtc) }
  };
}

// ---- 入力処理 ----
function parseDateTimeJstToUtc(dateStr, timeStr) {
  // dateStr: YYYY-MM-DD, timeStr: HH:MM or ""
  const [Y, M, D] = dateStr.split("-").map((v) => parseInt(v, 10));
  let hh = 12, mm = 0; // default noon if time missing
  if (timeStr && timeStr.includes(":")) {
    [hh, mm] = timeStr.split(":").map((v) => parseInt(v, 10));
  } else {
    hh = 12; mm = 0;
  }

  // Construct JST time then convert to UTC Date:
  // UTC = JST - 9h
  const utc = new Date(Date.UTC(Y, M - 1, D, hh - 9, mm, 0));
  return { Y, M, D, hh, mm, utc };
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

    if (!date || typeof date !== "string") {
      return res.status(400).json({ ok: false, error: "date required (YYYY-MM-DD)" });
    }

    const { Y, M, D, hh, mm, utc } = parseDateTimeJstToUtc(date, time);

    // ---- Phase A: 立春で年替わり & 節で月替わり ----
    // 立春時刻を求め、入力が立春より前なら「年柱は前年」
    // 立春は Jie(315°) に含まれる。year=Yのjieにある立春時刻を使う。
    const jieThis = buildJie12Utc(Y);
    const risshun = jieThis.find(j => j.angle === 315) || null;

    // 判定用（JST基準）：入力 utc と risshun.utc 比較でOK（どちらもUTC）
    let yearForPillar = Y;
    if (risshun && utc.getTime() < risshun.timeUtc.getTime()) {
      yearForPillar = Y - 1;
    }

    const yearP = calcYearPillarByRisshun(yearForPillar);

    const monthP = calcMonthPillarByJie(utc, yearP.kan);

    // ---- 簡易 日柱・時柱（Phase Cで日境界精密化予定） ----
    const dayP = calcDayPillarSimple(Y, M, D);

    let hourP = null;
    if (time && time.includes(":")) {
      const hb = hourBranchFromTime(hh, mm);
      const hs = hourStemFromDayStemAndHourBranch(dayP.kan, hb);
      hourP = { kan: hs, shi: hb };
    }

    // ---- 返却（今は蔵干や五行はstubのままでもOK。Phase B以降で強化） ----
    // ただしUI/AI連携のため、構造は確定させる
    const result = {
      ok: true,
      input: {
        date,
        time,
        sex,
        birthPlace,
        timeMode,
        dayBoundaryMode
      },
      meta: {
        standard: { y: Y, m: M, d: D, time: time || "" },
        used: {
          y: Y,
          m: M,
          d: D,
          time: time || "",
          timeModeUsed: timeMode,
          dayBoundaryModeUsed: String(dayBoundaryMode),
          sekkiUsed: monthP.sekkiUsed,
          yearBoundary: risshun ? { name: "立春", timeJst: formatJst(risshun.timeUtc) } : null,
          yearPillarYearUsed: yearForPillar
        },
        place: birthPlace ? { ...birthPlace } : null
      },
      pillars: {
        year: { ...yearP, zokan: [], rule: "sekki_risshun" },
        month: { kan: monthP.kan, shi: monthP.shi, zokan: [], rule: "sekki_12jie" },
        day: { ...dayP, zokan: [], rule: "day_simple_phaseA" },
        hour: hourP ? { ...hourP, zokan: [], rule: "hour_simple_phaseA" } : null
      },
      derived: {
        fiveElements: {
          counts: { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 }
        }
      }
    };

    return res.status(200).json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
