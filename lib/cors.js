// lib/cors.js
export function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // ✅ 本番は Origin 必須（外部直叩きを防ぐ）
  if (!origin) {
    res.status(403).json({ ok: false, error: "CORS blocked (missing Origin)" });
    return { ended: true };
  }

  const isAllowed = allowed.includes(origin);

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  if (req.method === "OPTIONS") {
    if (!isAllowed) {
      res.status(403).end("CORS blocked");
      return { ended: true };
    }
    res.status(204).end();
    return { ended: true };
  }

  if (!isAllowed) {
    res.status(403).json({ ok: false, error: "CORS blocked" });
    return { ended: true };
  }

  return { ended: false };
}
