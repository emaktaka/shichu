/**
 * Vercel Serverless Function (ESM)
 * /api/ai-meishi-analyze
 *
 * 役割：
 * - /api/meishi で生成した「名刺（meishi）」を入力として
 *   AI鑑定文を生成する（mode=user / mode=pro）
 *
 * 追加：
 * - focus: ["business","health",...] を受け取り、user向け鑑定を深掘りする
 *
 * 方針：
 * - 名刺（柱は原則ズレない）を前提に文章化
 * - mode=user: 依頼者向け（やさしい/安心/前向き）
 * - mode=pro : 鑑定士向け（簡潔/専門OKだが難語は最小限）
 *
 * I/O：
 * - 入力: { meishi: <object or string>, mode: "user"|"pro", focus?: string[] }
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

    const { meishi, mode, focus } = normalizeInput(body);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const model = (process.env.AI_MEISHI_MODEL || "").trim() || "gpt-4.1-mini";

    const prompt = buildPrompt({ meishi, mode, focus });

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

function normalizeFocus(raw) {
  // 許可する focus を固定（勝手な文言流入・プロンプト汚染防止）
  const ALLOW = new Set([
    "business",
    "health",
    "relationship",
    "love",
    "money",
    "work",
    "family",
    "self",
  ]);

  const arr = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : []);
  const cleaned = arr
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .map((x) => x.toLowerCase())
    .filter((x) => ALLOW.has(x));

  // 重複除去・最大5
  return Array.from(new Set(cleaned)).slice(0, 5);
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

  const focus = normalizeFocus(body?.focus);

  return { meishi: meishiNorm, mode, focus };
}

// ------------------------------
// Prompt builder
// ------------------------------
function buildPrompt({ meishi, mode, focus }) {
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

  // ✅ user は“鑑定書として深く長く”へ拡張
  const userStyle = [
    "ターゲット：30代以上〜50代中心の一般の方。人生の指針として読める、深く丁寧な文体。",
    "単なる性格説明ではなく『なぜそうなるのか』『どう活かすのか』まで踏み込む。",
    "見出し（#、##、###）を必ず使い、鑑定書として体系立てて構成する。",
    "専門用語は使ってよいが、必ず噛み砕いた補足説明を入れる。",
    "断定や恐怖を煽る表現は避けつつ、必要な注意点は誠実に伝える。",
    "名刺（meishi）に含まれない事実（職業・年齢・具体的出来事など）は推測しない。",
    "文字数目安：2000〜2600字（内容が濃い場合は多少前後してよい）。",
    "最後は必ず『これからどう向き合えば良いか』で前向きに締める（温かい一言で締める）。",
  ];

  const proStyle = [
    "ターゲット：鑑定士向け。要点重視で簡潔に。",
    "見出しは少なめでOK。箇条書きを使って良い。",
    "専門語はOKだが、読みやすさ優先。断定し過ぎない。",
    "文字数目安：350〜700字（多少前後OK）。",
  ];

  const focusMapJa = {
    business: "ビジネス（運営・発信・集客・方向性）",
    health: "健康（生活リズム・メンタル・体力配分）",
    relationship: "対人関係（人脈・信頼・距離感）",
    love: "恋愛（出会い・関係の育て方）",
    money: "金運（収支・価値提供・守り方）",
    work: "仕事（適性・役割・伸ばし方）",
    family: "家族（関係性・役割調整）",
    self: "自己実現（才能・学び・軸作り）",
  };

  const focusLine =
    Array.isArray(focus) && focus.length
      ? `【特に深掘りするテーマ（focus）】\n${focus
          .map((k) => `- ${k}: ${focusMapJa[k] || k}`)
          .join("\n")}\n（上記テーマは、鑑定書の中で必ず具体的に深掘りする）`
      : "【特に深掘りするテーマ（focus）】指定なし（全体をバランス良く深掘りする）";

  const content = [
    ...commonRules,
    "",
    mode === "pro" ? proStyle.join("\n") : userStyle.join("\n"),
    "",
    focusLine,
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
          "・【命式の構成と全体像】日主を中心に、命式全体のバランスと特徴を丁寧に解説する",
          "・【五行の深層分析】五行の偏りが、性格・行動・心身にどう影響するかを具体化する",
          "・【本質的な性格と天命】表に出やすい性質と、内側に秘めた可能性の両方に触れる",
          "・【運気のリズム】大運・年運・空亡（天中殺）が示す『流れ』を怖がらせず説明する",
          "・【実践的アドバイス】五行補正・思考の持ち方・日常で意識すべき行動を提示する",
          "・focus が指定されている場合、そのテーマに対して『具体的な打ち手』を必ず書く",
          "・鑑定書として一貫した流れを持たせ、読み終えた後に『行動できる』内容にする",
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
    // 長文化に合わせて少し増やす（上限はモデル側で丸められる）
    max_output_tokens: 1800,
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
    throw new Error(`Responses API failed: ${r.status}`);
  }

  const data = await r.json();

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

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
    max_tokens: 1800,
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

  t = t.replace(/^以下(が|は).*?\n+/s, "");
  t = t.replace(/^【?鑑定結果】?\s*\n+/s, "");

  if (mode === "user") {
    const hasEnding =
      /お祈り|応援|いつでも|お話し|ご相談|お大事|心より|祈ります/.test(t.slice(-160));
    if (!hasEnding) {
      t += "\n\nまたいつでもお話しくださいね。あなたの毎日が少しでも安心して進めますように。";
    }
  }

  t = t.replace(/\n{4,}/g, "\n\n\n");

  return t.trim();
}
