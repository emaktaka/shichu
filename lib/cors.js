// lib/cors.js
export function applyCors(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin;

  // allow list が空なら全許可（開発向け）
  if (!allow.length) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (origin && allow.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return { ended: true };
  }

  return { ended: false };
}
