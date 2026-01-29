// ===== /api/ai-user-advice.js : Part 1/3 =====
/**
 * Magic Wands 準拠「名刺（命式）固定」→ AI文章化
 *
 * ✅ 方針（重要）:
 * - /api/shichusuimei の result を「正」として扱う（再計算しない）
 * - 節入り秒・真太陽時・境界などの “計算” は一切しない
 * - modeで文体を切替:
 *   - client: 依頼者向け（やさしい/納得/1000〜1200字・Markdown）
 *   - professional: 鑑定士向け（根拠/読み筋/箇条書き多め）
 *
 * ✅ 入力:
 *  POST { result: < /api/shichusuimei レスポンス丸ごと >, mode?, focus?, ping? }
 *
 * ✅ 出力:
 *  { ok:true, text:"(Markdown)", summary:{...} }
 *
 * ✅ 安定化:
 * - ping:true で OpenAIを呼ばず返す
 * - タイムアウト付き（AbortController）
 * - JSON出力のパース失敗時はフォールバック
 *
 * ✅ CORS:
 * - Safari対策で Origin を見て返す（環境変数 ALLOWED_ORIGINS 対応）
 */

export default async function handler(req, res) {
  // ------------------------------
  // CORS
  // ------------------------------
  const origin = req.headers?.origin || "";
  const allowList = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin =
    !allowList.length ? (origin || "*") : (origin && allowList.includes(origin) ? origin : "");

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (allowOrigin) res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  else res.setHeader("Access-Control-Allow-Origin", "*"); // 基本は *（credentials使わない前提）
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
  // Safari preflightズレ対策で Accept も許可
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

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
        route: "/api/ai-user-advice",
        deployed: true,
        time: new Date().toISOString(),
        originSeen: origin || null,
        allowOrigin: allowOrigin || "*",
      })
    );
  }

  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }

    const body = req.body && typeof req.body === "object" ? req.body : await readJsonBody(req);

    // ping: OpenAI呼ばない
    if (body?.ping === true) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, pong: true, time: new Date().toISOString() }));
    }

    const result = body?.result;
    if (!result || typeof result !== "object") throw new Error("Invalid body: expected { result: {...} }");
    if (result.ok === false) throw new Error("Invalid result: result.ok is false");

    const modeRaw = safeString(body?.mode).toLowerCase();
    const mode = modeRaw === "professional" ? "professional" : "client";

    const focusRaw = safeString(body?.focus).toLowerCase();
    const focus = ["love", "work", "money", "life", "health"].includes(focusRaw) ? focusRaw : "life";

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

    const model =
      process.env.OPENAI_MODEL_USER ||
      process.env.OPENAI_MODEL ||
      "gpt-4o-mini";

    const temperature = clampNumber(process.env.OPENAI_TEMPERATURE_USER, 0.7, 0, 1.5);

    // 「名刺（命式）」前提のデータ要約（※再計算禁止）
    const payload = buildFixedMeishikiPayload(result);

    const prompt = buildAdvicePrompt({ payload, mode, focus });

    const outText = await callOpenAIText({ apiKey, model, temperature, prompt });

    // 期待：JSON { text, summary } だが崩れることもあるので保険
    const parsed = safeJsonParse(outText);
    const text = (parsed && typeof parsed.text === "string") ? parsed.text : String(outText || "");
    const summary = (parsed && parsed.summary && typeof parsed.summary === "object") ? parsed.summary : {};

    const finalText = String(text).replace(/\n{3,}/g, "\n\n").trim();

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, text: finalText, summary }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
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

function clampNumber(v, fallback, min, max) {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeJsonParse(s) {
  try {
    if (typeof s !== "string") return null;
    const t = s.trim();

    // そのままJSON
    if (t.startsWith("{") && t.endsWith("}")) return JSON.parse(t);

    // ```json ... ``` 形式
    const m = t.match(/```json\s*([\s\S]*?)\s*```/i);
    if (m && m[1]) return JSON.parse(m[1].trim());

    return null;
  } catch {
    return null;
  }
}

// ------------------------------
// 名刺（命式）固定：必要情報だけ抜き出す
// ------------------------------
function buildFixedMeishikiPayload(result) {
  const input = result.input || {};
  const meta = result.meta || {};
  const std = meta.standard || {};
  const used = meta.used || {};
  const pillars = result.pillars || {};
  const derived = result.derived || {};

  // 派生が未統合の旧結果でも落ちないように
  const tenDeity = derived.tenDeity || null;
  const fiveElements = derived.fiveElements || null;
  const luck = derived.luck || null;

  // 最低限の名刺（柱）
  const meishiki = {
    year: simplifyPillar(pillars.year),
    month: simplifyPillar(pillars.month),
    day: simplifyPillar(pillars.day),
    hour: simplifyPillar(pillars.hour),
  };

  // 付加情報（ある分だけ）
  const extras = {
    tenDeity,
    fiveElements,
    luck: simplifyLuck(luck),
    note: {
      // 「再計算禁止」をAIに強制するための宣言
      policy: "This meishiki is fixed. Do not recalculate pillars/boundaries/astronomy. Interpret only.",
    },
  };

  return {
    input: {
      date: input.date || `${std.y || ""}-${std.m || ""}-${std.d || ""}`,
      time: input.time || used.time || std.time || "",
      sex: input.sex || "",
      pref: input.birthPlace?.pref || "",
    },
    meta: {
      standard: { y: std.y, m: std.m, d: std.d, time: std.time || "" },
      used: { y: used.y, m: used.m, d: used.d, time: used.time || "" },
      monthBoundary: used.monthBoundary || null,
      yearPillarYearUsed: used.yearPillarYearUsed ?? null,
    },
    meishiki,
    extras,
  };
}

function simplifyPillar(p) {
  if (!p || typeof p !== "object") return null;
  const kan = p.kan?.text ?? p.kan ?? "";
  const shi = p.shi?.text ?? p.shi ?? "";
  return { kan, shi };
}

function simplifyLuck(luck) {
  if (!luck || typeof luck !== "object") return null;
  const out = {
    direction: luck.direction || null,
    startAgeYears: luck.startAgeYears ?? null,
    startAgeDetail: luck.startAgeDetail || null,
    current: luck.current || null,
    dayun: Array.isArray(luck.dayun) ? luck.dayun.slice(0, 10) : null,
    nenun: Array.isArray(luck.nenun) ? luck.nenun.slice(0, 13) : null,
    currentDayun: luck.currentDayun || null,
    currentNenun: luck.currentNenun || null,
  };
  return out;
}
// ===== /api/ai-user-advice.js : Part 2/3 =====
// ------------------------------
// Prompt builder（mode切替）
// ------------------------------
function buildAdvicePrompt({ payload, mode, focus }) {
  // mode別の指示
  const modeRule =
    mode === "professional"
      ? `
# 出力スタイル（professional）
- 対象：四柱推命の鑑定士（実務で使える読み筋）
- 専門語は出してよい（ただし過剰な羅列は避ける）
- 「根拠→読み→注意点→使い方」の順で短く鋭く
- 最後に「依頼者へ伝える言い換え例」を3つ付ける（短文）
- 文字量：800〜1400字程度（多少前後OK）
`
      : `
# 出力スタイル（client）
- 対象：占い初心者（依頼者向け）
- 専門語の羅列はしない（出すなら必ず日常語に翻訳）
- トーン：優しく、安心感があり、論理的で信頼できる丁寧語
- 文字量：合計1000〜1200字（目安）
- 構成は必ず4セクション（見出し固定）
  - 【あなたの本質と性格】
  - 【現在の運気の流れ】
  - 【仕事と人間関係の傾向】
  - 【開運のアクション】
`;

  const focusRule = `
# focus（重視テーマ）
- focus="${focus}"
- life: 全体バランス
- love: 恋愛/復縁/パートナー
- work: 仕事/適職/対人
- money: 金運/収支/習慣
- health: メンタル/体調/休み方
※ただし「命式の読み」を歪めず、焦点を当てるだけにする
`.trim();

  // “名刺固定” を強制
  const hardRules = `
# 絶対ルール（重要）
1) 以下のJSONは「名刺（命式）」として正しい前提。**再計算・推測で柱を変えない。**
2) 節入り秒・真太陽時・境界などの話はしない（計算や実装に触れない）。
3) 出力にJSONやAPI用語、キー名は貼らない。
4) 出力は **JSON形式** で返す（text, summary）。
   - text: Markdown（本文）
   - summary: object（短い要約。依頼者に見せてもOKな表現）
`.trim();

  // 十神翻訳の固定（依頼者向けのブレ防止）
  const tenDeityGlossary = {
    "比肩": "自分を強く持つ・自立心が高まる",
    "劫財": "仲間意識が強まり、人との関わりが増える（競争も）",
    "食神": "気持ちに余裕が出て楽しみが増える・育てる力",
    "傷官": "感受性が鋭くなり、変化を求める・表現力が増す",
    "偏財": "ご縁が広がる・チャンスが外から入る",
    "正財": "堅実さ・積み上げ・生活とお金の整え",
    "偏官": "勢い・決断・挑戦が増える（無理は禁物）",
    "正官": "責任・信頼・評価が高まりやすい",
    "七殺": "プレッシャーと突破力（急ぎすぎ注意）",
    "偏印": "ひらめき・独自性・方向転換が起きやすい",
    "印綬": "学び・回復・支援が得られやすい",
  };

  const dataForAI = {
    // AIに渡すのは「名刺の要点」だけ（再計算しない）
    ...payload,
    glossary: { tenDeity: tenDeityGlossary },
  };

  // clientは4セクション固定。professionalは自由だが見出し推奨。
  const sectionRule =
    mode === "professional"
      ? `
# 構成（professional推奨）
- 見出し例：
  1. 命式の核（格・日主の状態・五行）
  2. 読み筋（強み/課題）
  3. 運（大運/歳運の使い方）
  4. 注意点（やりがちミス）
  5. 依頼者へ伝える言い換え例（3つ）
`
      : `
# 構成（client固定）
必ず次の見出し4つを、この順で使うこと（見出し文言は変更禁止）：
- 【あなたの本質と性格】
- 【現在の運気の流れ】
- 【仕事と人間関係の傾向】
- 【開運のアクション】
`;

  const prompt = `
# 役割
あなたは一流の四柱推命鑑定師であり、文章化のプロです。
「名刺（命式）」をもとに、読み解きとアドバイスを作ります。

${hardRules}

${modeRule}

${focusRule}

${sectionRule}

# 名刺（命式）データ（入力）
以下のJSONを読み取り、解釈してください（出力に貼らない）。
${JSON.stringify(dataForAI, null, 2)}

# 出力JSONフォーマット（厳守）
{
  "text": "Markdown本文（改行OK）",
  "summary": {
    "core": "命式の核を1文",
    "strength": "強みを1文",
    "care": "注意点を1文",
    "action": "今日からの行動を1文"
  }
}
`.trim();

  return prompt;
}
// ===== /api/ai-user-advice.js : Part 3/3 =====
// ------------------------------
// OpenAI caller (Responses -> fallback Chat Completions)
//   ✅ タイムアウト付き（無限pending防止）
// ------------------------------
async function callOpenAIText({ apiKey, model, temperature, prompt }) {
  const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 25000);

  // 1) Responses API
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: prompt,
        temperature,
      }),
      signal: controller.signal,
    });

    clearTimeout(t);

    if (r.ok) {
      const j = await r.json();
      const txt =
        (typeof j?.output_text === "string" && j.output_text) ||
        extractTextFromResponses(j);
      if (txt) return String(txt).trim();
    } else {
      const errTxt = await r.text().catch(() => "");
      throw new Error(`Responses API HTTP ${r.status} ${errTxt}`.slice(0, 300));
    }
  } catch (_) {
    // fallbackへ
  }

  // 2) Chat Completions fallback
  const controller2 = new AbortController();
  const t2 = setTimeout(() => controller2.abort(), TIMEOUT_MS);

  try {
    const r2 = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller2.signal,
    });

    clearTimeout(t2);

    const j2 = await r2.json().catch(() => ({}));
    if (!r2.ok) {
      throw new Error(j2?.error?.message || `OpenAI API failed (HTTP ${r2.status})`);
    }
    const txt = j2?.choices?.[0]?.message?.content;
    if (!txt) throw new Error("OpenAI returned empty text");
    return String(txt).trim();
  } catch (e) {
    clearTimeout(t2);
    if (String(e?.name) === "AbortError") {
      throw new Error("OpenAI timeout（生成に時間がかかりすぎました。再試行してください）");
    }
    throw e;
  }
}

function extractTextFromResponses(j) {
  const out = j?.output;
  if (!Array.isArray(out)) return "";
  const parts = [];
  for (const item of out) {
    const c = item?.content;
    if (!Array.isArray(c)) continue;
    for (const cc of c) {
      if (cc?.type === "output_text" && typeof cc?.text === "string") {
        parts.push(cc.text);
      }
    }
  }
  return parts.join("\n");
}
