// /api/meishi.js
/**
 * 名刺API（表示専用）
 *
 * - /api/shichusuimei の結果をそのまま受け取る
 * - 計算は一切しない
 * - 人が読む「名刺表示」に整形して返す
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

    const body = req.body && typeof req.body === "object"
      ? req.body
      : await readJsonBody(req);

    const r = body?.result;
    if (!r || !r.pillars || !r.derived) {
      throw new Error("Invalid input: result is required");
    }

    const p = r.pillars;
    const d = r.derived;

    const meishi = {
      pillars: {
        year: p.year ? `${p.year.kan}${p.year.shi}` : "",
        month: p.month ? `${p.month.kan}${p.month.shi}` : "",
        day: p.day ? `${p.day.kan}${p.day.shi}` : "",
        hour: p.hour ? `${p.hour.kan}${p.hour.shi}` : ""
      },

      labels: {
        year: "年柱",
        month: "月柱",
        day: "日柱（命主）",
        hour: "時柱"
      },

      tenDeity: {
        year: d.tenDeity?.year || "",
        month: d.tenDeity?.month || "",
        day: "日主",
        hour: d.tenDeity?.hour || ""
      },

      zokan: {
        year: p.year?.zokan || [],
        month: p.month?.zokan || [],
        day: p.day?.zokan || [],
        hour: p.hour?.zokan || []
      },

      fiveElements: d.fiveElements?.counts || {},

      kuuBou: d.luck?.kuuBou || calcKuuBouFallback(p.day)
    };

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, meishi }));

  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}

// ----------------- utils -----------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

// 万一 luck に kuuBou が無い場合の保険
function calcKuuBouFallback(dayPillar) {
  if (!dayPillar) return [];
  const BRANCHES = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
  const idx = BRANCHES.indexOf(dayPillar.shi);
  if (idx < 0) return [];
  return [
    BRANCHES[(idx + 10) % 12],
    BRANCHES[(idx + 11) % 12]
  ];
}
