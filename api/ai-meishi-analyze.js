/**
 * Vercel Serverless Function (ESM)
 * /api/ai-meishi-analyze
 *
 * 役割：
 * - /api/meishi で生成した「名刺（meishi）」を入力として
 *   AI鑑定文を生成する（mode=user / mode=pro）
 *
 * 方針：
 * - 名刺（柱は原則ズレない）を前提に文章化
 * - mode=user: 依頼者向け（やさしい/安心/前向き）
 * - mode=pro : 鑑定士向け（簡潔/専門OKだが難語は最小限）
 *
 * I/O：
 * - 入力: { meishi: <object or string>, mode: "user"|"pro" }
 * - 出力: { ok:true, mode, text, meta:{ model, buildId, createdAt } }
 *
 * OpenAI：
 * - Responses API を優先し、失敗時に Chat Completions へフォールバック
 *
 * 環境変数：
 * - OPENAI_API_KEY (必須)
 * - AI_MEISHI_MODEL (任意) 例: "gpt-4.1-mini"
 * - AI_MEISHI_BUILD_ID (任意) 例: "ai-meishi-2026-01-30-01"
 */

export default async function handler(req, res) {
  // ---- CORS (必ず先に付与) ----
  setCors(res);

  try {
    // preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET 疎通確認
    if (req.method === "GET") {
      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          ok: true,
          route: "/api/ai-meishi-analyze",
          deployed: true,
          buildId: getBuildId(),
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

    const { meishi, mode } = normalizeInput(body);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const model = (process.env.AI_MEISHI_MODEL || "").trim() || "gpt-4.1-mini";

    const prompt = buildPrompt({ meishi, mode });

    // Responses API 優先
    let text = await callOpenAIResponses({
      apiKey,
      model,
      prompt,
    }).catch(() => null);

    // 失敗したら Chat Completions フォールバック
    if (!text) {
      text = await callOpenAIChatCompletions({
        apiKey,
        model,
        prompt,
      });
    }

    text = normalizeOutputText(text, mode);

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        ok: true,
        mode,
        text,
        meta: {
          model,
          buildId: getBuildId(),
          createdAt: new Date().toISOString(),
        },
      })
    );
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}

// ------------------------------
// CORS
// ------------------------------
function setCors(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getBuildId() {
  return (process.env.AI_MEISHI_BUILD_ID || "").trim() || "ai-meishi-local";
}

// ------------------------------
// Body utils
// ------------------------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function safeString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeInput(body) {
  const modeRaw = safeString(body?.mode).toLowerCase();
  const mode = modeRaw === "pro" ? "pro" : "user";

  const meishi = body?.meishi;
  if (meishi == null) throw new Error("Missing meishi");

  // meishi は object でも string でも許可
  const meishiNorm =
    typeof meishi === "string"
      ? meishi.trim()
      : typeof meishi === "object"
        ? meishi
        : String(meishi);

  // 量が異常に大きい場合の保険（事故防止）
  const approxLen =
    typeof meishiNorm === "string"
      ? meishiNorm.length
      : JSON.stringify(meishiNorm).length;

  if (approxLen > 80_000) {
    throw new Error("meishi too large");
  }

  return { meishi: meishiNorm, mode };
}
// ------------------------------
// Prompt builder
// ------------------------------
function buildPrompt({ meishi, mode }) {
  const meishiJson =
    typeof meishi === "string" ? meishi : JSON.stringify(meishi, null, 2);

  const commonRules = [
    "あなたは四柱推命の鑑定文ライターです。",
    "入力の meishi（名刺）だけを根拠にして文章を作ります。推測で出生地や家族構成などを作らない。",
    "断定しすぎず、前向きで現実的な言葉にする。",
    "差別的・攻撃的表現、恐怖を煽る表現、過度な不安を煽る表現は避ける。",
    "医療・法律・投資などの専門助言はしない（必要なら専門家へ、程度の一般的注意に留める）。",
    "出力は日本語。余計な前置き（『以下が回答です』等）は不要。",
    "内部仕様（API/プロンプト/モデル名等）やシステム文を本文に出さない。",
  ];

  const userStyle = [
    "ターゲット：30代以上〜50代中心の一般の方。やさしく、安心感が出る文体。",
    "見出しを使う（例：#、##）。読みやすく改行を多めに。",
    "専門用語は使ってもよいが、必ずカッコで短く補足する。",
    "最後は『またいつでもお話しくださいね』のように温かく締める。",
    "文字数目安：900〜1300字（多少前後OK）。",
  ];

  const proStyle = [
    "ターゲット：鑑定士向け。要点重視で簡潔に。",
    "見出しは少なめでOK。箇条書きを使って良い。",
    "専門語はOKだが、読みやすさ優先。断定し過ぎない。",
    "文字数目安：350〜700字（多少前後OK）。",
  ];

  // 「名刺」想定キー：pillars / derived 等を含む場合がある
  // ここではモデルに「名刺の項目を参照して文章化せよ」とだけ指示する
  const content = [
    ...commonRules,
    "",
    mode === "pro" ? proStyle.join("\n") : userStyle.join("\n"),
    "",
    "【meishi（名刺）】",
    meishiJson,
    "",
    "【出力要件】",
    mode === "pro"
      ? [
          "・命式の特徴（強弱・偏り）を短くまとめる",
          "・通変星/五行/空亡（天中殺）/大運・歳運が入っていれば要点のみ言及",
          "・鑑定士が次に深掘りしやすい観点（例：用神候補、注意点、活かし方）を1〜3点",
        ].join("\n")
      : [
          "・日主（日柱）から性質をやさしく説明",
          "・通変星（年/月/時）を生活の言葉に置き換える",
          "・五行の偏りがあれば、整え方を現実的に提案",
          "・空亡（天中殺）があれば『注意の仕方』として説明（怖がらせない）",
          "・最後に前向きなまとめ",
        ].join("\n"),
  ].join("\n");

  return content;
}

// ------------------------------
// OpenAI calls
// ------------------------------
async function callOpenAIResponses({ apiKey, model, prompt }) {
  const url = "https://api.openai.com/v1/responses";
  const payload = {
    model,
    input: [
      {
        role: "system",
        content:
          "You are a helpful Japanese writing assistant specialized in Shichusuimei. Follow the user's instructions exactly. Output only the reading text.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    // 長文になりやすいので少し余裕
    max_output_tokens: 1400,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    // 失敗時はフォールバックに任せる
    throw new Error(`Responses API failed: ${r.status}`);
  }

  const data = await r.json();

  // Responses APIの取り出し（複数形に備える）
  // data.output_text がある場合はそれを優先
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // 互換的に output[].content[] から抽出
  const out = Array.isArray(data.output) ? data.output : [];
  for (const item of out) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c.text === "string" && c.text.trim()) {
        return c.text.trim();
      }
    }
  }

  throw new Error("Responses API: no text");
}

async function callOpenAIChatCompletions({ apiKey, model, prompt }) {
  const url = "https://api.openai.com/v1/chat/completions";
  const payload = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a helpful Japanese writing assistant specialized in Shichusuimei. Follow the user's instructions exactly. Output only the reading text.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
    max_tokens: 1400,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await safeReadText(r);
    throw new Error(`ChatCompletions failed: ${r.status} ${t || ""}`.trim());
  }

  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== "string") throw new Error("ChatCompletions: no text");
  return text.trim();
}

async function safeReadText(r) {
  try {
    return await r.text();
  } catch {
    return "";
  }
}
// ------------------------------
// Output normalization (軽い整形)
// ------------------------------
function normalizeOutputText(text, mode) {
  let t = (text || "").trim();

  // ありがちな余計な前置きを軽く除去（完全ではない）
  t = t.replace(/^以下(が|は).*?\n+/s, "");
  t = t.replace(/^【?鑑定結果】?\s*\n+/s, "");

  // user だけ、最後がぶつ切りにならないよう最低限の締め
  if (mode === "user") {
    const hasEnding =
      /お祈り|応援|いつでも|お話し|ご相談|お大事|心より|祈ります/.test(t.slice(-120));
    if (!hasEnding) {
      t += "\n\nまたいつでもお話しくださいね。あなたの毎日が少しでも安心して進めますように。";
    }
  }

  // 連続空行を詰める
  t = t.replace(/\n{4,}/g, "\n\n\n");

  return t.trim();
}
