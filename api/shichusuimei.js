// api/shichusuimei.js
// ✅ 疎通確認用の最小版（あとで本実装に置換） + CORS制限
// POST /api/shichusuimei
// body: { date, time, sex, birthPlace, timeMode, dayBoundaryMode }

import { applyCors } from "../lib/cors.js";

export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (cors.ended) return;

  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // ✅ 最低限の形だけ返す（あなたのtypes.tsの形に合わせる）
    return res.status(200).json({
      ok: true,
      input: {
        date: body?.date || "",
        time: body?.time || "",
        sex: body?.sex || "",
        birthPlace: body?.birthPlace || null,
        timeMode: body?.timeMode || "standard",
        dayBoundaryMode: body?.dayBoundaryMode || "24"
      },
      meta: {
        standard: { y: 1990, m: 7, d: 15, time: body?.time || "" },
        used: { y: 1990, m: 7, d: 15, time: body?.time || "", timeModeUsed: body?.timeMode || "standard", dayBoundaryModeUsed: body?.dayBoundaryMode || "24" },
        place: { pref: body?.birthPlace?.pref || null }
      },
      pillars: {
        year: { kan: "庚", shi: "午", zokan: ["丁","己"], rule: "stub" },
        month:{ kan: "辛", shi: "巳", zokan: ["丙","戊","庚"], rule: "stub" },
        day:  { kan: "庚", shi: "辰", zokan: ["戊","乙","癸"], rule: "stub" },
        hour: body?.time ? { kan: "壬", shi: "午", zokan: ["丁","己"], rule: "stub" } : null
      },
      derived: {
        fiveElements: { counts: { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 } }
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
