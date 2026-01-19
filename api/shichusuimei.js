// api/shichusuimei.js
// Phase A+B+C 統合版（完全コピペ）
// A: 「節入り（24節気→12節）」境界で月柱、立春境界で年柱
// B: 平均太陽時（経度差補正）を時柱＆日柱境界に反映（都道府県→代表経度）
// C: 日柱境界を 23:00 or 24:00 で切替（dayBoundaryMode）

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
// ※ 必要なら後で「市区町村」や「海外」対応へ拡張
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
  // JSTの(Y,M,D,hh,mm)に分加算して、繰り上がりを正しく扱う
  // いったん UTC Date にして処理（JST = UTC+9なので、UTCに変換して加算）
  const utc = new Date(Date.UTC(Y, M - 1, D, hh - 9, mm, 0));
  const utc2 = new Date(utc.getTime() + addMin * 60 * 1000);
  const jst2 = new Date(utc2.getTime() + 9 * 60 * 60 * 1000);

  const y2 = jst2.getUTCFullYear();
  const mo2 = jst2.getUTCMonth() + 1;
  const d2 = jst2.getUTCDate();
  const h2 = jst2.getUTCHours();
  const mi2 = jst2.getUTCMinutes();

  return { Y: y2, M: mo2, D: d2, hh: h2, mm: mi2, utc: utc2 };
}

// ---- 年干→寅月の干（五虎遁） ----
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

function addStem(stem, add) {
  const i = STEMS.indexOf(stem);
  return STEMS[(i + add + 10) % 10];
}

// ---- Phase A: 年柱（立春境界） ----
function calcYearPillarByRisshun(yearNumber) {
  // 1984年が甲子年として扱う簡易方式
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
  // 基準日: 1984-02-02 を 甲子日として扱う簡易方式
  const baseJdn = toJdnAtUtcMidnight(1984, 2, 2);
  const jdn = toJdnAtUtcMidnight(y, m, d);
  const diff = jdn - baseJdn;
  const idx = (diff % 60 + 60) % 60;
  return { kan: STEMS[idx % 10], shi: BRANCHES[idx % 12] };
}

// ---- 時柱（簡易） ----
function hourBranchFromTime(hh, mm) {
  // 子:23-01, 丑:01-03 ... 亥:21-23
  const minutes = hh * 60 + mm;
  if (minutes >= 23 * 60) return "子";
  const slot = Math.floor((minutes + 60) / 120); // 00:00-00:59 -> 子
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

    // 補正後（JST）: usedParts
    // ※ time が空なら、日柱境界/時柱は判定不能なので "12:00" 等で無理に補正しない
    let usedParts = { Y, M, D, hh: parsed.hh, mm: parsed.mm, utc: utcStandard };
    let usedTimeStr = time || "";
    if (time && time.includes(":") && timeMode === "mean_solar" && lonCorrectionMin !== 0) {
      // 経度差補正を「JST入力時刻」に加算して “平均太陽時の時計表示” を得る
      usedParts = addMinutesToJstDateParts(Y, M, D, parsed.hh, parsed.mm, lonCorrectionMin);
      usedTimeStr = fmtHHMM(usedParts.hh, usedParts.mm);
    } else {
      // standard の場合 or 補正なし
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
          const next = addMinutesToJstDateParts(Y, M, D, 0, 0, 24 * 60); // JSTで翌日0:00
          dayForPillarY = next.Y;
          dayForPillarM = next.M;
          dayForPillarD = next.D;
        }
      } else {
        // "24": 0:00で日替わり（通常）
        // 何もしない
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
          // used は「表示・再現性」優先で、補正後のカレンダー日付も返す
          y: usedParts.Y ?? Y,
          m: usedParts.M ?? M,
          d: usedParts.D ?? D,
          time: usedTimeStr,
          timeModeUsed: timeMode,
          dayBoundaryModeUsed: dayBoundaryMode,
          // Phase Aで確定した境界情報（実時刻ベース）
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
