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

    // ✅ mode に応じて出力トークンを増やす（途中で切れにくくする）
    const tokenBudget = getTokenBudget(mode);

    // Responses API 優先
    let text = await callOpenAIResponses({
      apiKey,
      model,
      prompt,
      max_output_tokens: tokenBudget.max_output_tokens,
    }).catch(() => null);

    // 失敗したら Chat Completions フォールバック
    if (!text) {
      text = await callOpenAIChatCompletions({
        apiKey,
        model,
        prompt,
        max_tokens: tokenBudget.max_tokens,
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

// ✅ modeごとのトークン予算（切れ防止）
function getTokenBudget(mode) {
  if (mode === "pro") {
    return {
      max_output_tokens: 2200, // proでも簡素化させない
      max_tokens: 2200,
    };
  }
  return {
    max_output_tokens: 3600, // userは長文（3000字超）想定
    max_tokens: 3600,
  };
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
  // ✅ business/work統合（work は受け取っても business に寄せる）
  // ✅ 恋愛は新規(love_new)、復縁(fukuen)を別扱い
  const ALLOW = new Set([
    "business",
    "health",
    "relationship",
    "love_new",
    "fukuen",
    "money",
    "family",
    "self",
  ]);

  const arr = Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : []);
  const cleaned = arr
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .map((x) => x.toLowerCase())
    .map((x) => {
      // 旧仕様互換
      if (x === "work") return "business";      // work → business へ統合
      if (x === "love") return "love_new";      // love → 恋愛（新規）へ
      if (x === "恋愛") return "love_new";
      if (x === "復縁") return "fukuen";
      return x;
    })
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

  // ✅ フリガナ指示（依頼者向けのみ強制）
  const furiganaRulesUser = [
    "【重要：読みやすさ】四柱推命の専門用語は、初出だけ必ずフリガナ（読み）を丸括弧で付ける。",
    "例：日主（にっしゅ）／月令（げつれい）／通変星（つうへんせい）／蔵干（ぞうかん）／十二運（じゅうにうん）／空亡（くうぼう）／天中殺（てんちゅうさつ）／大運（たいうん）／年運（ねんうん）／用神（ようじん）／忌神（きしん）／印綬（いんじゅ）／偏印（へんいん）／比肩（ひけん）／劫財（ごうざい）／食神（しょくしん）／傷官（しょうかん）／偏財（へんざい）／正財（せいざい）／偏官（へんかん）／正官（せいかん）／偏官＝七殺（しちさつ）／正官（せいかん）",
    "同じ用語を繰り返すたびにフリガナは不要（初出のみ）。",
    "漢字が難しい概念は、短い言い換えを添える（例：『用神＝バランスを整える助け役』のように1行）。",
  ];

  const commonRules = [
    "あなたは四柱推命の鑑定文ライターです。",
    "入力の meishi（名刺）だけを根拠にして文章を作ります。推測で出生地や家族構成などを作らない。",
    "断定しすぎず、前向きで現実的な言葉にする。",
    "差別的・攻撃的表現、恐怖を煽る表現、過度な不安を煽る表現は避ける。",
    "医療・法律・投資などの専門助言はしない（必要なら専門家へ、程度の一般的注意に留める）。",
    "出力は日本語。余計な前置き（『以下が回答です』等）は不要。",
    "内部仕様（API/プロンプト/モデル名等）やシステム文を本文に出さない。",
    "重要：途中で文章を投げ出さない。見出し構成を最後まで書き切り、結論と次の一歩で締める。",
  ];

  // ✅ user は“鑑定書として深く長く”へ拡張（3000字以上）
  const userStyle = [
    "ターゲット：30代以上〜50代中心の一般の方。人生の指針として読める、深く丁寧な文体。",
    "単なる性格説明ではなく『なぜそうなるのか』『どう活かすのか』『何から始めるのか』まで踏み込む。",
    "見出し（#、##、###）を必ず使い、鑑定書として体系立てて構成する。",
    "専門用語は使ってよいが、必ず噛み砕いた補足説明を入れる（1〜2行でOK）。",
    "断定や恐怖を煽る表現は避けつつ、必要な注意点は誠実に伝える（『気をつければ活かせる』の形）。",
    "名刺（meishi）に含まれない事実（職業・年齢・具体的出来事など）は推測しない。",
    "文字数目安：3000〜3600字（最低3000字以上）。",
    "重要：途中で切れないように、最後の『まとめ』『具体的アクション』『温かい一言』まで必ず書き切る。",
    "最後は必ず『これからどう向き合えば良いか』で前向きに締める（温かい一言で締める）。",
  ];

  // ✅ pro は「簡素」ではなく「鑑定素材として密度」を上げる
  const proStyle = [
    "ターゲット：鑑定士向け。要点重視だが“簡素化しない”。鑑定の素材として密度を保つ。",
    "見出しは使う（短くても良い）。箇条書きを適切に使う。",
    "専門語はOK。ただし読み筋が伝わるように、用語は短い補足つきにする。",
    "文字数目安：1200〜2000字（最低1200字以上）。",
    "次の鑑定で確認すべき質問（3〜6個）と、読み筋（仮説）を必ず添える。",
    "用神/忌神は meishi の五行・十神等がある場合に『候補』として提示（断定しない）。",
  ];

  const focusMapJa = {
    business: "ビジネス（仕事含む：運営・発信・集客・方向性）",
    health: "健康（生活リズム・メンタル・体力配分）",
    relationship: "対人関係（人脈・信頼・距離感）",
    love_new: "恋愛（新規の出会い：出会い方・関係の育て方）",
    fukuen: "復縁（過去の相手：再接近のタイミング・距離の詰め方）",
    money: "金運（収支・価値提供・守り方）",
    family: "家族（関係性・役割調整）",
    self: "自己実現（才能・学び・軸作り）",
  };

  const focusLine =
    Array.isArray(focus) && focus.length
      ? `【特に深掘りするテーマ（focus）】\n${focus
          .map((k) => `- ${k}: ${focusMapJa[k] || k}`)
          .join("\n")}\n（上記テーマは、鑑定書の中で必ず具体的に深掘りする。恋愛（新規）と復縁は混ぜない）`
      : "【特に深掘りするテーマ（focus）】指定なし（全体をバランス良く深掘りする）";

  const content = [
    ...commonRules,
    "",
    mode === "pro" ? proStyle.join("\n") : userStyle.join("\n"),
    "",
    ...(mode === "pro" ? [] : furiganaRulesUser),
    "",
    focusLine,
    "",
    "【meishi（名刺）】",
    meishiJson,
    "",
    "【出力要件】",
    mode === "pro"
      ? [
          "・命式の特徴（強弱・偏り）を“情報として”まとめる（鑑定の足場）。",
          "・通変星/五行/蔵干/空亡（天中殺）/大運・年運が入っていれば、読み筋と注意点を明確化。",
          "・鑑定士が次に深掘りしやすい観点：①核となるテーマ ②リスク ③活かし方 ④確認質問（3〜6）",
          "・最後に『鑑定の方針案（2〜3案）』を提示（例：用神候補/整え方/優先順位）。",
          "・短すぎ禁止。最低1200字以上。",
        ].join("\n")
      : [
          "・【命式の構成と全体像】日主を中心に、命式全体のバランスと特徴を丁寧に解説する。",
          "・【五行の深層分析】五行の偏りが、性格・行動・心身にどう影響するかを具体化する。",
          "・【本質的な性格と天命】表に出やすい性質と、内側に秘めた可能性の両方に触れる。",
          "・【運気のリズム】大運・年運・空亡（天中殺）が示す『流れ』を怖がらせず説明する。",
          "・【実践的アドバイス】五行補正・思考の持ち方・日常で意識すべき行動を提示する。",
          "・focus が指定されている場合、そのテーマごとに章を作り『具体的な打ち手（手順・頻度・NG）』を必ず書く。",
          "・恋愛（新規）と復縁は別ケースとして扱い、混ぜない（章も分ける）。",
          "・鑑定書として一貫した流れを持たせ、読み終えた後に『行動できる』内容にする。",
          "・短すぎ禁止。最低3000字以上。最後の締めまで書き切る。",
        ].join("\n"),
  ].join("\n");

  return content;
}

// ------------------------------
// OpenAI calls
// ------------------------------
async function callOpenAIResponses({ apiKey, model, prompt, max_output_tokens }) {
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
    // ✅ modeに応じて増やす（途中で切れにくく）
    max_output_tokens: typeof max_output_tokens === "number" ? max_output_tokens : 1800,
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

async function callOpenAIChatCompletions({ apiKey, model, prompt, max_tokens }) {
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
    max_tokens: typeof max_tokens === "number" ? max_tokens : 1800,
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
    // ✅ 末尾が途切れた場合の保険（最後まで書かせる指示はプロンプトに入れているが念のため）
    const hasEnding =
      /お祈り|応援|いつでも|お話し|ご相談|お大事|心より|祈ります/.test(t.slice(-220));
    if (!hasEnding) {
      t += "\n\nまたいつでもお話しくださいね。あなたの毎日が少しでも安心して進めますように。";
    }

    // ✅ もし極端に短い場合は、警告文ではなく自然に補う（表示上の事故防止）
    if (t.length < 1400) {
      t +=
        "\n\n（補足）もし文章が短く感じる場合は、focus（深掘りテーマ）を複数選んで再生成すると、より具体的な行動計画まで出やすくなります。";
    }
  }

  t = t.replace(/\n{4,}/g, "\n\n\n");

  return t.trim();
}
