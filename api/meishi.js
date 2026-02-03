// /api/meishi.js
/**
 * 名刺API（表示専用）
 *
 * - /api/shichusuimei の結果をそのまま受け取る
 * - 計算は原則しない（ただし「空亡（天中殺）」だけは正確性のため日干支から算出）
 * - 人が読む「名刺表示」に整形して返す
 *
 * I/O:
 * - 入力: { result: < /api/shichusuimei のレスポンス丸ごと > }
 * - 出力: { ok:true, meishi }
 */

export default async function handler(req, res) {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET 疎通確認（任意だが便利）
    if (req.method === "GET") {
      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          ok: true,
          route: "/api/meishi",
          deployed: true,
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

    const r = body?.result;
    if (!r || !r.pillars) {
      throw new Error("Invalid input: result is required");
    }

    const p = r.pillars || {};
    const d = r.derived || {};

    const dayKan = p.day?.kan || "";
    const dayShi = p.day?.shi || "";

    // ✅ 空亡（天中殺）は「日干支（60干支）」から算出する（正確性のため）
    // /api/shichusuimei.js と同等のロジック
    const kuuBou = calcKuuBouFromDayPillar(dayKan, dayShi);

    const meishi = {
      pillars: {
        year: p.year ? `${p.year.kan || ""}${p.year.shi || ""}` : "",
        month: p.month ? `${p.month.kan || ""}${p.month.shi || ""}` : "",
        day: p.day ? `${p.day.kan || ""}${p.day.shi || ""}` : "",
        hour: p.hour ? `${p.hour.kan || ""}${p.hour.shi || ""}` : "",
      },

      labels: {
        year: "年柱",
        month: "月柱",
        day: "日柱（命主）",
        hour: "時柱",
      },

      tenDeity: {
        year: d?.tenDeity?.year || "",
        month: d?.tenDeity?.month || "",
        day: "日主",
        hour: d?.tenDeity?.hour || "",
      },

      zokan: {
        year: p.year?.zokan || [],
        month: p.month?.zokan || [],
        day: p.day?.zokan || [],
        hour: p.hour?.zokan || [],
      },

      // 五行（countsのみ渡す）
      fiveElements: d?.fiveElements?.counts || {},

      // 空亡（天中殺）
      kuuBou,
    };

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, meishi }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}

// ----------------- utils -----------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ------------------------------
// 空亡（天中殺）: 日干支(60干支)から算出
// /api/shichusuimei.js と同等のロジック
// ------------------------------
const STEMS = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];

function mod(a, m) {
  return ((a % m) + m) % m;
}
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
function calcKuuBouFromDayPillar(dayKan, dayShi) {
  if (!dayKan || !dayShi) return [];
  const idx = sexagenaryIndex(dayKan, dayShi);
  const junStart = idx - (idx % 10);
  const startBranch = BRANCHES[junStart % 12];
  const startBi = BRANCHES.indexOf(startBranch);
  const v1 = BRANCHES[mod(startBi - 2, 12)];
  const v2 = BRANCHES[mod(startBi - 1, 12)];
  return [v1, v2];
}
