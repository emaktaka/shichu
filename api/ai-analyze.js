// api/ai-analyze.js
// ✅ OpenAI版（Gemini置換） + CORS対応
// POST /api/ai-analyze
// body: { result: CalculationResult }
//
// env:
//   OPENAI_API_KEY=xxxx
//   ALLOWED_ORIGINS=https://spikatsu.anjyanen.com,https://www.spikatsu.anjyanen.com

import OpenAI from "openai";
import { applyCors } from "../lib/cors.js";

export default async function handler(req, res) {
  const cors = applyCors(req, res);
  if (cors.ended) return;

  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const result = body?.result;

    if (!result?.ok || !result?.pillars?.day?.kan) {
      return res.status(400).json({ ok: false, error: "invalid result payload" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not set" });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const p = result.pillars;
    const d = result.derived || {};
    const luck = d.luck || {};
    const sexLabel =
      result.input?.sex === "M" ? "男性" :
      result.input?.sex === "F" ? "女性" : "未選択";

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
        year:  { kan: p.year.kan,  shi: p.year.shi,  zokan: p.year.zokan,  rule: p.year.rule },
        month: { kan: p.month.kan, shi: p.month.shi, zokan: p.month.zokan, rule: p.month.rule },
        day:   { kan: p.day.kan,   shi: p.day.shi,   zokan: p.day.zokan,   rule: p.day.rule },
        hour:  p.hour ? { kan: p.hour.kan, shi: p.hour.shi, zokan: p.hour.zokan, rule: p.hour.rule } : null,
      },
      derived: {
        tenDeity: d.tenDeity || null,
        zokanTenDeity: d.zokanTenDeity || null,
        fiveElements: d.fiveElements || null,
        luck: {
          direction: luck.direction || null,
          startCalcMode: luck.startCalcMode || null,
          startAgeYears: luck.startAgeYears ?? null,
          current: luck.current || null,
          currentNenun: currentNenun ? {
            pillarYear: currentNenun.pillarYear,
            kan: currentNenun.kan,
            shi: currentNenun.shi,
            tenDeity: currentNenun.tenDeity,
            relationsToNatal: currentNenun.relationsToNatal || null,
          } : null,
          currentDayun: currentDayun ? {
            kan: currentDayun.kan,
            shi: currentDayun.shi,
            tenDeity: currentDayun.tenDeity,
            ageFrom: currentDayun.ageFrom,
            ageTo: currentDayun.ageTo,
            relationsToNatal: currentDayun.relationsToNatal || null,
          } : null,
        }
      }
    };

    const system = `
あなたは「スピ活ひろば」の専属・四柱推命鑑定師です。
- 口調：優しく、しかし確信を持って。恐怖を煽る表現は禁止。
- 方針：吉凶断定よりも「活かし方」「整え方」「具体策」へ。
- 専門性：日干・月令・蔵干・通変星（十神）・五行・年運/大運の現在テーマを重視。
- 出力形式：Markdown。見出しと箇条書きを使い、読みやすく。
- 禁止：内部実装語（JDN、index60、MVP、Mock、計算式）を本文に出さない。
`.trim();

    const user = `
以下は鑑定に必要な確定データです（JSON）。このデータのみを根拠に鑑定してください。
\`\`\`json
${JSON.stringify(payloadForLLM, null, 2)}
\`\`\`

# 依頼（必ずこの順で）
1. 宿命と性格の本質（※日干＋蔵干＋月令を中心）
2. 五行バランス（過不足→メンタル/体調の傾向。※不足の補い方も）
3. 仕事運・適職（※月柱・十神・五行から具体的に）
4. 恋愛/対人（※必要なら。決めつけ禁止）
5. いまの運気テーマ（年運/大運の“現在”があれば最優先で言語化）
6. 開運アクション（今日/今週できる具体策を3つ）
※時柱が null の場合は「出生時間不明」と明記し、時柱依存の断定を避けてください。
`.trim();

    // ✅ まずは確実に動くモデルをデフォルトに（後で上げられる）
    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    const response = await client.responses.create({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.7,
    });

    return res.status(200).json({
      ok: true,
      text: response.output_text || "",
      model: response.model || model,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
