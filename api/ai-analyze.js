// api/ai-analyze.js
// ✅ OpenAI版（Gemini置換） + CORS制限 + デバッグ/フォールバック
// POST /api/ai-analyze
// body: { result: CalculationResult }
//
// env:
//   OPENAI_API_KEY=xxxxx
//   ALLOWED_ORIGINS=https://spikatsu.anjyanen.com,https://www.spikatsu.anjyanen.com

import OpenAI from "openai";
import { applyCors } from "../lib/cors.js";

function pickError(e) {
  return {
    message: String(e?.message || e),
    name: e?.name,
    status: e?.status,
    code: e?.code,
    type: e?.type
  };
}

export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (cors.ended) return;

  // JSON返却を安定させる
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const result = body?.result;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not set (Production env?)" });
    }

    if (!result?.ok || !result?.pillars?.day?.kan) {
      return res.status(400).json({ ok: false, error: "invalid result payload" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const p = result.pillars;
    const d = result.derived || {};
    const luck = d.luck || {};

    const currentNenun =
      (luck?.nenun && luck?.current?.currentNenunIndex >= 0)
        ? luck.nenun[luck.current.currentNenunIndex]
        : null;

    const currentDayun =
      (luck?.dayun && luck?.current?.currentDayunIndex >= 0)
        ? luck.dayun[luck.current.currentDayunIndex]
        : null;

    const payloadForLLM = {
      input: result.input,
      meta: result.meta,
      pillars: {
        year: { kan: p.year.kan, shi: p.year.shi, zokan: p.year.zokan, rule: p.year.rule },
        month: { kan: p.month.kan, shi: p.month.shi, zokan: p.month.zokan, rule: p.month.rule },
        day: { kan: p.day.kan, shi: p.day.shi, zokan: p.day.zokan, rule: p.day.rule },
        hour: p.hour ? { kan: p.hour.kan, shi: p.hour.shi, zokan: p.hour.zokan, rule: p.hour.rule } : null
      },
      derived: {
        tenDeity: d.tenDeity || null,
        zokanTenDeity: d.zokanTenDeity || null,
        fiveElements: d.fiveElements || null,
        luck: {
          current: luck.current || null,
          currentNenun: currentNenun ? {
