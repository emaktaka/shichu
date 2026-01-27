/**
 * Vercel Serverless Function (ESM)
 * /api/ai-user-advice
 *
 * ✅ 依頼者向け：一般人でもわかる長文（1000〜1200字）で丁寧に解説
 * - 入力: { result: < /api/shichusuimei のレスポンス丸ごと > }
 * - 出力: { ok:true, text:"..." }  ※Markdown
 *
 * ✅ 重要:
 * - package.json が "type":"module" のため ESM（export default）
 * - OpenAI: Responses APIを優先、失敗時Chat Completionsへフォールバック
 * - 例外は必ず {ok:false,error} で返す
 *
 * ✅ CORS強化:
 * - try の外で必ずCORSヘッダを付与
 * - OPTIONS（preflight）を最優先で200返却
 * - GETで疎通確認できる診断レスポンス追加
 *
 * ✅ 安定化（今回追加）:
 * - ping:true で OpenAI を呼ばず即返却（疎通確認）
 * - OpenAI 呼び出しにタイムアウトを入れて無限pendingを防止
 *
 * ✅ Safari対策（今回修正）:
 * - Access-Control-Allow-Origin を固定せず、Originに合わせて返す（or *）
 * - Allow-Headers に Accept を含める（preflight不一致対策）
 */

export default async function handler(req, res) {
  // ==============================
  // ✅ CORS（Safari “Load failed” 対策）
  // ==============================
  const origin = req.headers?.origin || "";

  // 許可したいオリジン（必要なら追加）
  const ALLOWED_ORIGINS = new Set([
    "https://saw.anjyanen.com",
    "https://www.saw.anjyanen.com",
    "https://spikatsu.anjyanen.com",
    "https://www.spikatsu.anjyanen.com",
  ]);

  // Originが取れないケースもあるので、その場合は * に逃がす
  // ※ credentials: "include" を使う予定が無いなら * が一番安全
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "*";

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin"); // ✅ CDNsでOrigin別キャッシュ崩れ防止
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS,GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");

  // ✅ Preflight（最優先）
  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true }));
  }

  // ✅ GETで疎通確認（ブラウザで開いてOKならデプロイ確認が可能）
  if (req.method === "GET") {
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        ok: true,
        route: "/api/ai-user-advice",
        deployed: true,
        time: new Date().toISOString(),
        originSeen: origin || null,
        allowOrigin,
      })
    );
  }

  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }

    const body =
      req.body && typeof req.body === "object" ? req.body : await readJsonBody(req);

    // ✅ 追加：疎通確認用（OpenAIを呼ばず即返し）
    if (body?.ping === true) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, pong: true, time: new Date().toISOString() }));
    }

    const result = body?.result;
    if (!result || typeof result !== "object") {
      throw new Error("Invalid body: expected { result: {...} }");
    }
    if (!result.ok) {
      throw new Error("Invalid result: result.ok is false");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

    const model = process.env.OPENAI_MODEL_USER || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const temperature = clampNumber(process.env.OPENAI_TEMPERATURE_USER, 0.7, 0, 1.5);

    const prompt = buildUserAdvicePrompt(result);

    const text = await callOpenAIText({ apiKey, model, temperature, prompt });

    // 軽い整形（改行の暴れ防止）
    const finalText = String(text).replace(/\n{3,}/g, "\n\n").trim();

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, text: finalText }));
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

function clampNumber(v, fallback, min, max) {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ------------------------------
// Prompt builder（依頼者向け）
// ------------------------------
function buildUserAdvicePrompt(result) {
  const inp = result.input || {};
  const meta = result.meta || {};
  const used = meta.used || {};
  const pillars = result.pillars || {};
  const derived = result.derived || {};

  // 依頼者向けは「鑑定データ」を“読み解き用に要約したJSON”を渡す（内部表示はしない）
  const data = {
    input: {
      date: inp.date,
      time: inp.time || "",
      sex: inp.sex || "",
      pref: meta?.place?.pref || inp?.birthPlace?.pref || "",
      timeMode: inp.timeMode,
      dayBoundaryMode: inp.dayBoundaryMode,
    },
    pillars: {
      year: simplifyPillar(pillars.year),
      month: simplifyPillar(pillars.month),
      day: simplifyPillar(pillars.day),
      hour: simplifyPillar(pillars.hour),
    },
    derived: {
      fiveElements: derived.fiveElements || null,
      tenDeity: derived.tenDeity || null,
      luck: derived.luck || null,
    },
    hints: {
      // 通変星の“翻訳”の土台（AIにブレなく説明させる）
      tenDeityGlossary: {
        "比肩": "自分を強く持つ・自立心が高まる",
        "劫財": "仲間意識が強まり、人との関わりが増える（競争も）",
        "食神": "気持ちに余裕が出て楽しみが増える・育てる力",
        "傷官": "感受性が鋭くなり、変化を求める・表現力が増す",
        "偏財": "ご縁が広がる・チャンスが外から入る",
        "正財": "堅実さ・積み上げ・生活とお金の整え",
        "偏官": "勢い・決断・挑戦が増える（無理は禁物）",
        "正官": "責任・信頼・評価が高まりやすい",
        "偏印": "ひらめき・独自性・方向転換が起きやすい",
        "印綬": "学び・回復・支援が得られやすい",
      },
      fiveElementsNote:
        "五行（木火土金水）は『性質のバランス』。多すぎる/少なすぎる要素があると、得意と苦手がハッキリ出る。",
    },
    // 境界メタはUIに出さないが、文章品質のため“境界の存在”だけはAIに渡す
    boundary: {
      yearBoundaryName: used?.yearBoundary?.name || null,
      yearBoundaryTime: used?.yearBoundary?.timeJstSec || used?.yearBoundary?.timeJst || null,
      monthBoundaryName: used?.monthBoundary?.name || null,
      monthBoundaryTime: used?.monthBoundary?.timeJstSec || used?.monthBoundary?.timeJst || null,
      note:
        "節入り（年=立春/月=節）付近は性質が混ざりやすく、気質や運の出方が揺れやすい傾向がある。",
    },
  };

  const prompt = `
# 役割
あなたは一流の四柱推命鑑定師兼、心理カウンセラーです。
専門用語の羅列である「鑑定データ」を読み解き、占いに詳しくない一般ユーザーが深く納得し、前向きになれるような【詳細な解説文】を作成してください。

# 鑑定データ（入力）
以下のJSONを読み取り、必要な情報を整理して文章化してください（JSONは出力に貼らないこと）。
${JSON.stringify(data, null, 2)}

# 執筆ルール
1. **専門用語の翻訳**:
   - 「比肩」を「自分を強く持つ時期」など、日常的な言葉に置き換えて説明してください。
   - 上の tenDeityGlossary を“必ず基準”として使い、ブレない説明にしてください。
2. **構成**: 以下の4セクションで構成してください（見出しは固定）。
   - 【あなたの本質と性格】: 宿命が示す本来の自分
   - 【現在の運気の流れ】: 今、どのような時期にいるのか
   - 【仕事と人間関係の傾向】: 周囲との関わり方の注意点やアドバイス
   - 【開運のアクション】: 具体的に何をすべきか（五行バランスを根拠に）
3. **トーン**:
   - 奏加たかお様が提唱する「スピ活ひろば」の精神に基づき、優しく、かつ論理的で信頼感のある丁寧語。
4. **文量**:
   - 各項目300文字程度、トータル1,000〜1,200文字程度の長文で詳しく解説してください。
5. **重要**:
   - JSONや内部仕様（API、Phase、実装用語、キー名）は出力しないこと。
   - “節入り境界”は、必要な場合だけ自然な一文として触れてよい（例：節の切り替わり付近は性質が混ざりやすい、など）。

# 出力形式
Markdown形式で出力してください。
`.trim();

  return prompt;
}

function simplifyPillar(p) {
  if (!p) return null;
  const kan = p.kan?.text ?? p.kan ?? "";
  const shi = p.shi?.text ?? p.shi ?? "";
  return { kan, shi };
}

// ------------------------------
// OpenAI caller (Responses -> fallback Chat Completions)
//   ✅ タイムアウト付き（無限pending防止）
// ------------------------------
async function callOpenAIText({ apiKey, model, temperature, prompt }) {
  const TIMEOUT_MS = 25000; // 長文なら 35000 でもOK

  // 1) Responses API（タイムアウト付き）
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
      if (txt) return txt.trim();
    } else {
      const errTxt = await r.text().catch(() => "");
      throw new Error(`Responses API HTTP ${r.status} ${errTxt}`.slice(0, 300));
    }
  } catch (_) {
    // fallbackへ
  }

  // 2) Chat Completions fallback（タイムアウト付き）
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
