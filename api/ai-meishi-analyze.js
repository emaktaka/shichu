// /api/ai-meishi-analyze.js
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

    const body =
      req.body && typeof req.body === "object" ? req.body : await readJsonBody(req);

    const meishi = body?.meishi;
    const mode = body?.mode === "pro" ? "pro" : "user";

    if (!meishi) throw new Error("meishi is required");

    const systemPrompt = buildSystemPrompt(mode);
    const userPrompt = buildUserPrompt(meishi);

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_output_tokens: 1200,
    });

    const text =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      "";

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        ok: true,
        mode,
        text,
      })
    );
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}

// ---------------- utils ----------------
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
  });
}

function buildSystemPrompt(mode) {
  if (mode === "pro") {
    return `
あなたは四柱推命の鑑定士向けAIです。
- 専門用語OK
- 断定的で簡潔
- 命式の「名刺情報」から読みを整理する
- 推測や新しい計算は禁止
`;
  }
  return `
あなたは四柱推命の依頼者向け鑑定文AIです。
- やさしく丁寧
- 断定しすぎない
- 不安を煽らない
- 専門語は説明する
`;
}

function buildUserPrompt(meishi) {
  return `
以下は四柱推命の「名刺情報」です。
この内容をもとに鑑定文を書いてください。

【柱】
年柱：${meishi.pillars.year}
月柱：${meishi.pillars.month}
日柱：${meishi.pillars.day}
時柱：${meishi.pillars.hour}

【通変星】
年：${meishi.tenDeity.year}
月：${meishi.tenDeity.month}
日：日主
時：${meishi.tenDeity.hour}

【五行バランス】
${Object.entries(meishi.fiveElements)
  .map(([k, v]) => `${k}: ${v}`)
  .join(", ")}

【空亡】
${meishi.kuuBou?.join("・") || "なし"}

※ 命式は確定済み。計算し直さないこと。
`;
}
