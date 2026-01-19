// api/shichusuimei.js
// Phase A+B+C + 「通変星（十神）/ 蔵干十神 / 五行カウント」返却 統合版（完全コピペ）
//
// A: 「節入り（24節気→12節）」境界で月柱、立春境界で年柱
// B: 平均太陽時（経度差補正）を時柱＆日柱境界に反映（都道府県→代表経度）
// C: 日柱境界を 23:00 or 24:00 で切替（dayBoundaryMode）
// +: 通変星（十神）/ 蔵干十神 / 五行カウント を APIで確定して返す（フロント計算しない）
//
// POST /api/shichusuimei
// body: {
//   date: "YYYY-MM-DD",
//   time: "HH:MM" | "",
//   sex: "M"|"F"|"",
//   birthPlace: {country:"JP", pref:"東京都"} | null,
//   timeMode: "standard"|"mean_solar",
//   dayBoundaryMode: "23"|"24"
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

// ---- Phase B: 都道府県→代表経度（最小実装として県庁所在地付近） ----
const PREF_LONGITUDE = {
  "北海道": 141.35,
  "青森県": 140.74,
  "岩手県": 141.15,
  "宮城県": 140.87,
  "秋田県": 140.10,
  "山形県": 140.34,
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

  "岐阜県": 136.76,
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
  "香川県": 134.05,
  "愛媛県": 132.77,
  "高知県": 133.53,

  "福岡県": 130.40,
  "佐賀県": 130.30,
  "長崎県": 129.87,
  "熊本県": 130.71,
  "大分県": 131.61,
  "宮崎県": 131.42,
  "鹿児島県": 130.56,

  "沖縄県": 127.68
};

// 明石標準時（日本標準時の基準経度）
const JST_STANDARD_MERIDIAN = 135.0;

// 経度差補正（分）: (lon - 135) * 4
function longitudeCorrectionMinutes(longitude) {
  if (typeof longitude !== "number" || !Number.isFinite(longitude)) return 0;
  return (longitude - JST_STANDARD_MERIDIAN) * 4;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function fmtHHMM(h, m) {
  return `${pad2(h)}:${pad2(m)}`;
}

function addMinutesToJstDateParts(Y, M, D, hh, mm, addMin) {
  // JSTの(Y,M,D,hh,mm)に分加算して繰り上がりを正しく扱う
  const utc = new Date(Date.UTC(Y, M - 1, D, hh - 9, mm, 0));
  const utc2 = new Date(utc.getTime() + addMin * 60 * 1000);
  const jst2 = new Date(utc2.getTime() + 9 * 60 * 60 * 1000);

  return {
    Y: jst2.getUTCFullYear(),
    M: jst2.getUTCMonth() + 1,
    D: jst2.getUTCDate(),
    hh: jst2.getUTCHours(),
    mm: jst2.getUTCMinutes(),
    utc: utc2
  };
}

// ----------------------------
// 追加: 蔵干（標準テーブル）
// ----------------------------
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
  "亥": ["壬","甲"]
};

function getZokan(branch) {
  return ZOKAN[branch] ? [...ZOKAN[branch]] : [];
}

// ----------------------------
// 追加: 五行 & 十神（通変星）
// ----------------------------
const STEM_ELEMENT = {
  "甲":"wood","乙":"wood",
  "丙":"fire","丁":"fire",
  "戊":"earth","己":"earth",
  "庚":"metal","辛":"metal",
  "壬":"water","癸":"water"
};

const STEM_YINYANG = {
  "甲":"yang","乙":"yin",
  "丙":"yang","丁":"yin",
  "戊":"yang","己":"yin",
  "庚":"yang","辛":"yin",
  "壬":"yang","癸":"yin"
};

const ELEM_GEN = { wood:"fire", fire:"earth", earth:"metal", metal:"water", water:"wood" };
const ELEM_CTRL = { wood:"earth", earth:"water", water:"fire", fire:"metal", metal:"wood" };

function isStem(v) {
  return typeof v === "string" && STEM_ELEMENT[v];
}

function calcTenDeity(dayStem, targetStem) {
  if (!isStem(dayStem) || !isStem(targetStem)) return null;

  const de = STEM_ELEMENT[dayStem];
  const te = STEM_ELEMENT[targetStem];
  const dy = STEM_YINYANG[dayStem];
  const ty = STEM_YINYANG[targetStem];
  const samePolarity = dy === ty;

  // 同気
  if (de === te) return samePolarity ? "比肩" : "劫財";

  // 日主が生む（食傷）
  if (ELEM_GEN[de] === te) return samePolarity ? "食神" : "傷官";

  // 日主が剋す（財）
  if (ELEM_CTRL[de] === te) return samePolarity ? "偏財" : "正財";

  // 日主を剋す（官殺）
  if (ELEM_CTRL[te] === de) return samePolarity ? "七殺" : "正官";

  // 日主を生む（印）
  if (ELEM_GEN[te] === de) return samePolarity ? "偏印" : "正印";

  return null;
}

function countFiveElementsFromStems(stems) {
  const counts = { wood:0, fire:0, earth:0, metal:0, water:0 };
  for (const s of stems) {
    if (!isStem(s)) continue;
    counts[STEM_ELEMENT[s]] += 1;
  }
  return counts;
}

// ---- 年干→寅月の干（五虎遁） ----
function tigerMonthStemForYearStem(yearStem) {
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

// ---- Phase A: 年柱（立春境界） ----
function calcYearPillarByRisshun(yearNumber) {
  const idx = (yearNumber - 1984) % 60;
  const i = (idx + 60) % 60;
  return { kan: STEMS[i % 10], shi: BRANCHES[i % 12] };
}

// ---- 日柱（簡易） ----
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

function calcDayPillarSimple(y, m, d) {
  const baseJdn = toJdnAtUtcMidnight(1984, 2, 2); // 甲子日（簡易基準）
  const jdn = toJdnAtUtcMidnight(y, m, d);
  const diff = jdn - baseJdn;
  const idx = (diff % 60 + 60) % 60;
  return { kan: STEMS[idx % 10], shi: BRANCHES[idx % 12] };
}

// ---- 時柱（簡易） ----
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

// ---- Phase A: 月柱（12節） ----
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
    const dayBoundaryMode = String(body?.dayBoundaryMode ?? "24"); // "23"|"24"

    if (!date || typeof date !== "string") {
      return res.status(400).json({ ok: false, error: "date required (YYYY-MM-DD)" });
    }

    const parsed = parseDateTimeJstToUtc(date, time);
    const { Y, M, D } = parsed;

    // -----------------------------
    // Phase A: 年柱（立春）・月柱（12節）
    // ※ここは「実時刻(JST)」基準のまま（UTCで比較）
    // -----------------------------
    const utcStandard = parsed.utc;

    const jieThis = buildJie12Utc(Y);
    const risshun = jieThis.find(j => j.angle === 315) || null;

    let yearForPillar = Y;
    if (risshun && utcStandard.getTime() < risshun.timeUtc.getTime()) {
      yearForPillar = Y - 1;
    }
    const yearP = calcYearPillarByRisshun(yearForPillar);
    const monthP = calcMonthPillarByJie(utcStandard, yearP.kan);

    // -----------------------------
    // Phase B: 平均太陽時（経度差補正）
    // ・時柱＆日柱境界に反映
    // -----------------------------
    let longitude = null;
    let lonCorrectionMin = 0;

    if (birthPlace?.country === "JP" && birthPlace?.pref && PREF_LONGITUDE[birthPlace.pref] != null) {
      longitude = PREF_LONGITUDE[birthPlace.pref];
    }

    if (timeMode === "mean_solar" && typeof longitude === "number") {
      lonCorrectionMin = longitudeCorrectionMinutes(longitude);
    } else {
      lonCorrectionMin = 0;
    }

    let usedParts = { Y, M, D, hh: parsed.hh, mm: parsed.mm, utc: utcStandard };
    let usedTimeStr = time || "";

    if (time && time.includes(":") && timeMode === "mean_solar" && lonCorrectionMin !== 0) {
      usedParts = addMinutesToJstDateParts(Y, M, D, parsed.hh, parsed.mm, lonCorrectionMin);
      usedTimeStr = fmtHHMM(usedParts.hh, usedParts.mm);
    } else {
      usedParts = { Y, M, D, hh: parsed.hh, mm: parsed.mm, utc: utcStandard };
      usedTimeStr = time || "";
    }

    // -----------------------------
    // Phase C: 日柱境界 23/24 切替
    // ・判定は「usedParts（補正後の時刻）」で行う
    // -----------------------------
    let dayForPillarY = Y, dayForPillarM = M, dayForPillarD = D;

    if (time && time.includes(":")) {
      const usedMin = usedParts.hh * 60 + usedParts.mm;

      if (dayBoundaryMode === "23") {
        // 23:00以降は翌日扱い
        if (usedMin >= 23 * 60) {
          const next = addMinutesToJstDateParts(Y, M, D, 0, 0, 24 * 60);
          dayForPillarY = next.Y;
          dayForPillarM = next.M;
          dayForPillarD = next.D;
        }
      } else {
        // "24": 0:00で日替わり（通常）
      }
    }

    // 日柱（簡易）
    const dayP = calcDayPillarSimple(dayForPillarY, dayForPillarM, dayForPillarD);

    // 時柱（簡易）: 補正後の時刻（usedParts）で枝を出す
    let hourP = null;
    if (time && time.includes(":")) {
      const hb = hourBranchFromTime(usedParts.hh, usedParts.mm);
      const hs = hourStemFromDayStemAndHourBranch(dayP.kan, hb);
      hourP = { kan: hs, shi: hb };
    }

    // -----------------------------
    // 追加: 蔵干を埋める（年/月/日/時）
    // -----------------------------
    const yearZ = getZokan(yearP.shi);
    const monthZ = getZokan(monthP.shi);
    const dayZ = getZokan(dayP.shi);
    const hourZ = hourP ? getZokan(hourP.shi) : [];

    // -----------------------------
    // 追加: 十神（通変星）を確定（基準 = 日干）
    // - tenDeity: 各柱の「天干」の十神（※日干は "日主" で固定）
    // - zokanTenDeity: 各柱の蔵干十神配列
    // -----------------------------
    const dayStem = dayP.kan;

    const tenDeity = {
      year: calcTenDeity(dayStem, yearP.kan),
      month: calcTenDeity(dayStem, monthP.kan),
      day: "日主",
      hour: hourP ? calcTenDeity(dayStem, hourP.kan) : null
    };

    const zokanTenDeity = {
      year: yearZ.map(stem => ({ stem, deity: calcTenDeity(dayStem, stem) })),
      month: monthZ.map(stem => ({ stem, deity: calcTenDeity(dayStem, stem) })),
      day: dayZ.map(stem => ({ stem, deity: calcTenDeity(dayStem, stem) })),
      hour: hourP ? hourZ.map(stem => ({ stem, deity: calcTenDeity(dayStem, stem) })) : []
    };

    // -----------------------------
    // 追加: 五行カウント（確定値）
    // 方針：天干（年/月/日/時）＋ 蔵干（年/月/日/時）を全部カウント
    // -----------------------------
    const stemsToCount = [
      yearP.kan,
      monthP.kan,
      dayP.kan,
      ...(hourP ? [hourP.kan] : []),
      ...yearZ,
      ...monthZ,
      ...dayZ,
      ...hourZ
    ];
    const fiveCounts = countFiveElementsFromStems(stemsToCount);

    // -----------------------------
    // 返却
    // -----------------------------
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
          y: usedParts.Y ?? Y,
          m: usedParts.M ?? M,
          d: usedParts.D ?? D,
          time: usedTimeStr,
          timeModeUsed: timeMode,
          dayBoundaryModeUsed: dayBoundaryMode,
          sekkiUsed: monthP.sekkiUsed,
          yearBoundary: risshun ? { name: "立春", timeJst: formatJst(risshun.timeUtc) } : null,
          yearPillarYearUsed: yearForPillar
        },
        place: birthPlace
          ? {
              ...birthPlace,
              ...(typeof longitude === "number" ? { longitude } : {}),
              ...(timeMode === "mean_solar" && typeof longitude === "number"
                ? { lonCorrectionMin: Number(lonCorrectionMin.toFixed(2)) }
                : {})
            }
          : null
      },
      pillars: {
        year: { ...yearP, zokan: yearZ, rule: "sekki_risshun" },
        month: { kan: monthP.kan, shi: monthP.shi, zokan: monthZ, rule: "sekki_12jie" },
        day: { ...dayP, zokan: dayZ, rule: "day_simple_phaseA" },
        hour: hourP ? { ...hourP, zokan: hourZ, rule: "hour_simple_phaseA" } : null
      },
      derived: {
        tenDeity,
        zokanTenDeity,
        fiveElements: {
          counts: fiveCounts,
          note: "Counted from stems: year/month/day/hour + all hidden stems (zokan)."
        }
      }
    };

    return res.status(200).json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
