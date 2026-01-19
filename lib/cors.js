// lib/cors.js
export function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // curl等の Origin無しは許可（必要なら stricter に変更OK）
  const isAllowed = !origin || allowed.includes(origin);

  if (origin && isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
