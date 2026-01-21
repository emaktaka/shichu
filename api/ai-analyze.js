/**
 * Vercel Serverless Function (ESM)
 * /api/ai-analyze
 *
 * ✅ Phase C: 節入り境界（year/month）を鑑定文に反映
 * - 入力: { result: < /api/shichusuimei のレスポンス丸ごと > }
 * - 出力: { ok:true, text:"..." }
 *
 * ✅ 追加（今回 / C強化）:
 * - 二人称禁止（「あなた」等を使わず「命主/この方/ご本人」で統一）
 * - 「節入り境界の読み（年/⽉）」章が必ず出るように検証し、不足なら1回だけ再生成
 * - 末尾に「鑑定師用要点（箇条書き）」を必ず追加（編集前提の要約）
 *
 * ✅ 重要:
 * - package.json が "type":"module" のため ESM（export default）
 * - OpenAI: Responses APIを優先し、失敗時はChat Completionsへフォールバック
 * - 例外は必ず {ok:false,error} で返す
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

    const body =
      req.body && typeof req.body === "object" ? req.body : await readJsonBody(req);

    const result = body?.result;
    if (!result || typeof result !== "object") {
      throw new Error("Invalid body: expected { result: {...} }");
    }
    if (!result.ok) {
      throw new Error("Invalid result: result.ok is false");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const temperature = clampNumber(process.env.OPENAI_TEMPERATURE, 0.6, 0, 1.5);

    // 1st generation
    const prompt1 = buildJapanesePrompt(result, { attempt: 1 });
    let text = await callOpenAIText({ apiKey, model, temperature, prompt: prompt1 });

    // Validate required sections & style
    if (!passesQualityGate(text)) {
      // 2nd generation (only once): stricter instructions with a small retry note
      const prompt2 = buildJapanesePrompt(result, { attempt: 2, previousText: text });
      text = await callOpenAIText({
        apiKey,
        model,
        temperature: Math.min(temperature + 0.05, 1.2),
        prompt: prompt2,
      });
    }

    // Final safety polish (soft): enforce no "あなた" if it slips
    text = sanitizeSecondPerson(text);

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, text }));
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
// Quality gate (required sections + "no あなた")
// ------------------------------
function passesQualityGate(text) {
  if (!text || typeof text !== "string") return false;

  // Must include these section headers (Markdown "##")
  const must = [
    /##\s*1\.\s*宿命と性格の本質/,
    /##\s*2\.\s*節入り境界の読み/,
    /##\s*6\.\s*今の運気テーマ/,
    /##\s*7\.\s*開運アクション/,
    /##\s*鑑定師用要点/,
  ];

  for (const re of must) {
    if (!re.test(text)) return false;
  }

  // Must mention year/month boundary keywords somewhere
  const boundaryWordsOk =
    /(立春|年の境界|年境界)/.test(text) && /(月|節|月の境界|月境界)/.test(text);
  if (!boundaryWordsOk) return false;

  // "あなた" should not appear
  if (/(あなた|君|きみ|貴方)/.test(text)) return false;

  return true;
}

function sanitizeSecondPerson(text) {
  // Hard replace only obvious "あなた" occurrences (best-effort)
  // ※完全な文脈変換はAI側での遵守を前提にし、ここは“保険”として軽めにする
  return String(text)
    .replaceAll("あなた", "命主")
    .replaceAll("貴方", "命主")
    .replaceAll("きみ", "命主")
    .replaceAll("君", "命主");
}

// ------------------------------
// Prompt builder (JP)  ※Cベース維持 + 強化
// ------------------------------
function buildJapanesePrompt(result, { attempt, previousText } = {}) {
  const inp = result.input || {};
  const meta = result.meta || {};
  const used = meta.used || {};
  const place = meta.place || {};
  const pillars = result.pillars || {};
  const derived = result.derived || {};

  const yCheck = used.yearBoundaryCheck || null;
  const mCheck = used.monthBoundaryCheck || null;

  // 境界説明（年）
  const yearBoundaryText = buildBoundaryNarrative({
    typeLabel: "年（立春）",
    boundary: used.yearBoundary || null,
    check: yCheck,
    tieBreak: used.sekkiBoundaryTieBreakUsed || inp.sekkiBoundaryTieBreak,
    precision: used.sekkiBoundaryPrecisionUsed || inp.sekkiBoundaryPrecision,
  });

  // 境界説明（月）
  const monthBoundaryText = buildMonthBoundaryNarrative({
    boundary: used.monthBoundary || null,
    check: mCheck,
    tieBreak: used.sekkiBoundaryTieBreakUsed || inp.sekkiBoundaryTieBreak,
    precision: used.sekkiBoundaryPrecisionUsed || inp.sekkiBoundaryPrecision,
  });

  // 鑑定に必要な要点（機械→人間変換の素材）
  const payload = {
    input: {
      date: inp.date,
      time: inp.time || "",
      sex: inp.sex || "",
      birthPlace: inp.birthPlace || null,
      timeMode: inp.timeMode,
      dayBoundaryMode: inp.dayBoundaryMode,
      boundaryTimeRef: inp.boundaryTimeRef,
      sekkiBoundaryPrecision: inp.sekkiBoundaryPrecision,
      sekkiBoundaryTieBreak: inp.sekkiBoundaryTieBreak,
    },
    meta: {
      used: {
        timeJst: `${used.y}-${pad2(used.m)}-${pad2(used.d)} ${used.time || ""}`.trim(),
        sekkiUsed: used.sekkiUsed || null,
        monthBoundary: used.monthBoundary || null,
        yearBoundary: used.yearBoundary || null,
        yearPillarYearUsed: used.yearPillarYearUsed,
        yearBoundaryCheck: used.yearBoundaryCheck || null,
        monthBoundaryCheck: used.monthBoundaryCheck || null,
      },
      place: {
        pref: place.pref,
        longitude: place.longitude,
        lonCorrectionMin: place.lonCorrectionMin,
        eqTimeMin: place.eqTimeMin,
      },
    },
    pillars: {
      year: pillars.year || null,
      month: pillars.month || null,
      day: pillars.day || null,
      hour: pillars.hour || null,
    },
    derived: {
      tenDeity: derived.tenDeity || null,
      fiveElements: derived.fiveElements || null,
      luck: derived.luck || null,
    },
    boundaryNarrative: {
      year: yearBoundaryText,
      month: monthBoundaryText,
    },
  };

  const baseRule = `
あなたは四柱推命の鑑定文を日本語で作る専門家です。
以下のJSON（命式結果）を元に、鑑定師が扱いやすい自然な鑑定文を書いてください。

【最重要ルール（必ず遵守）】
- 二人称「あなた」「君」「貴方」を一切使わない。呼称は「命主」「この方」「ご本人」で統一する。
- 内部用語（デカン、API、Phaseなど）や実装用語は絶対に出さない。
- 「節入り境界の読み（年/⽉）」は必ず本文の章として出す（年=立春 / 月=節）。
- 境界の説明は、単なる時刻の羅列で終わらせず、
  「境界の直前/直後は性質が混ざる」「境界付近は出方が揺れやすい」など“境界生まれ”の意味を鑑定語として説明する。
- monthBoundaryCheck に prevBoundary/nextBoundary があれば、前後の節名を文章に入れてよい（節名は表示OK）。

【構成（必ずこの順 / 見出しは固定）】
# 四柱推命鑑定結果
## 1. 宿命と性格の本質（まず日干中心）
## 2. 節入り境界の読み（年/⽉：境界の影響をわかりやすく）
## 3. 五行バランス（不足と補い方）
## 4. 仕事運
## 5. 恋愛・対人
## 6. 今の運気テーマ（大運・年運）
## 7. 開運アクション（今日/今週できる3つ）
## 鑑定師用要点（編集用メモ）
- 5〜10行の箇条書きで「要点」「注意点」「境界由来の補足」をまとめる

【出力形式】
- Markdown（# や ## を使う）
- 最後に余計な注釈や断り文は書かない
`.trim();

  const retryAdd =
    attempt === 2
      ? `
【再生成の注意（重要）】
- 前回出力に不足がありました。今回は必ず次を満たすこと:
  1) 「## 2. 節入り境界の読み」が明確に存在し、年(立春)と月(節)の両方を説明している
  2) 「## 鑑定師用要点（編集用メモ）」が末尾に存在する
  3) 二人称「あなた」を使わない
`.trim()
      : "";

  const prev =
    attempt === 2 && previousText
      ? `\n\n---\n前回出力（参照用・改善して再作成すること）:\n${String(previousText).slice(0, 2000)}\n`
      : "";

  return `${baseRule}\n\n${retryAdd}\n\n---\n\n命式JSON:\n${JSON.stringify(payload, null, 2)}${prev}`;
}

function buildBoundaryNarrative({ typeLabel, boundary, check, tieBreak, precision }) {
  if (!boundary || !check) return `${typeLabel}の境界情報は取得できませんでした。`;

  const sBefore = check.standardIsBeforeRisshun ?? check.standardIsBeforeMonthBoundary;
  const uBefore = check.usedIsBeforeRisshun ?? check.usedIsBeforeMonthBoundary;

  const bName = boundary.name || "（不明）";
  const bTime = boundary.timeJstSec || boundary.timeJst || "（不明）";

  const tieNote =
    precision === "second"
      ? `（同秒の扱い：${tieBreak === "before" ? "同秒は“前”扱い" : "同秒は“後”扱い"}）`
      : "";

  const stdT = check.standardTimeJstSec || check.standardTimeJst || "（不明）";
  const usedT = check.usedTimeJstSec || check.usedTimeJst || "（不明）";

  return `${typeLabel}の境界は「${bName}（${bTime}）」です。標準時(${stdT})は境界の${
    sBefore ? "前" : "後"
  }、補正後(${usedT})も境界の${uBefore ? "前" : "後"}判定です。${tieNote}`.trim();
}

function buildMonthBoundaryNarrative({ boundary, check, tieBreak, precision }) {
  if (!boundary || !check) return `月の節境界情報は取得できませんでした。`;

  const bName = check.boundaryName || boundary.name || "（不明）";
  const bTime =
    check.boundaryTimeJstSec ||
    check.boundaryTimeJst ||
    boundary.timeJstSec ||
    boundary.timeJst ||
    "（不明）";

  const sBefore = check.standardIsBeforeMonthBoundary;
  const uBefore = check.usedIsBeforeMonthBoundary;

  const stdT = check.standardTimeJstSec || check.standardTimeJst || "（不明）";
  const usedT = check.usedTimeJstSec || check.usedTimeJst || "（不明）";

  const prev = check.prevBoundary
    ? `前の節は「${check.prevBoundary.name}（${check.prevBoundary.timeJstSec || check.prevBoundary.timeJst}）」`
    : "";
  const next = check.nextBoundary
    ? `次の節は「${check.nextBoundary.name}（${check.nextBoundary.timeJstSec || check.nextBoundary.timeJst}）」`
    : "";

  const tieNote =
    precision === "second"
      ? `（同秒の扱い：${tieBreak === "before" ? "同秒は“前”扱い" : "同秒は“後”扱い"}）`
      : "";

  const around = [prev, next].filter(Boolean).join(" / ");

  return `月の節境界は「${bName}（${bTime}）」です。標準時(${stdT})は境界の${
    sBefore ? "前" : "後"
  }、補正後(${usedT})も境界の${uBefore ? "前" : "後"}判定です。${
    around ? `（${around}）` : ""
  }${tieNote}`.trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// ------------------------------
// OpenAI caller (Responses -> fallback Chat Completions)
// ------------------------------
async function callOpenAIText({ apiKey, model, temperature, prompt }) {
  // 1) Responses API
  try {
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
    });

    if (r.ok) {
      const j = await r.json();
      const txt =
        (typeof j?.output_text === "string" && j.output_text) ||
        extractTextFromResponses(j);
      if (txt) return txt.trim();
    }
  } catch (_) {
    // fallbackへ
  }

  // 2) Chat Completions fallback
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
  });

  const j2 = await r2.json().catch(() => ({}));
  if (!r2.ok) {
    throw new Error(j2?.error?.message || "OpenAI API failed");
  }
  const txt = j2?.choices?.[0]?.message?.content;
  if (!txt) throw new Error("OpenAI returned empty text");
  return String(txt).trim();
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
