// POST /api/briefing: AI briefing for the user's whole watchlist.
// The page collects, for each symbol, its live price change, Entryvex's signals and the latest
// headlines (from /api/news), and this endpoint asks the AI to summarize ONLY that data.
const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"];
const ALLOWED = [/^https:\/\/(www\.)?entryvex\.trade$/, /^http:\/\/localhost(:\d+)?$/];
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const SYSTEM = `You write a short market briefing for a beginner investor about the coins and stocks on their watchlist.
Use ONLY the data provided (Entryvex signal, headlines). Never invent news, numbers or events. No buy/sell advice and no price predictions.
Do NOT state whether the price rose or fell or by how much: the exact price change is shown next to your line from live data. Describe what the NEWS is about and its mood; if there are no headlines, say "No notable news."
Output format, exactly:
- One line per symbol, in the given order: "TICKER: <one sentence, max 22 words, about the news and its mood>"
- Then a final line: "Watch: <one sentence on the 1-3 most important things across the whole list>"
No other text, no headings, no markdown.`;

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED.some((re) => re.test(origin))) return json({ error: "forbidden" }, 403);
  const raw = await request.text();
  if (raw.length > 40_000) return json({ error: "too large" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 15).map((x) => ({
    ticker: String(x.ticker || "").slice(0, 12), name: String(x.name || "").slice(0, 60), kind: x.kind === "stock" ? "stock" : "crypto",
    changePct: Number.isFinite(+x.changePct) ? +(+x.changePct).toFixed(2) : null, signal: String(x.signal || "").slice(0, 80),
    headlines: (Array.isArray(x.headlines) ? x.headlines : []).slice(0, 5).map((h) => `${String(h.title || "").slice(0, 160)} [${h.mood || "neutral"}]`),
  })).filter((x) => x.ticker);
  if (!items.length) return json({ error: "empty watchlist" }, 400);
  if (!env || !env.AI) return json({ lines: [], watch: "AI briefings run on the live site (entryvex.trade) only." });

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Watchlist data (captured ${new Date().toISOString()}):\n${JSON.stringify(items)}` },
  ];
  let text = "", model = null;
  for (const m of MODELS) {
    try {
      const out = await env.AI.run(m, { messages, max_tokens: 900, temperature: 0.2 });
      text = (out && (out.response ?? out.result?.response)) || "";
      if (text.trim()) { model = m; break; }
    } catch { /* try the next model */ }
  }
  if (!text.trim()) return json({ error: "The AI is unavailable right now. Try again later." }, 503);

  const tickers = new Set(items.map((x) => x.ticker.toUpperCase()));
  const lines = [];
  let watch = "";
  for (const l of text.split("\n").map((s) => s.replace(/^[-*•\s]+/, "").trim()).filter(Boolean)) {
    const m = l.match(/^([A-Z0-9.\-]{1,12})\s*:\s*(.+)$/i);
    if (m && /^watch$/i.test(m[1])) watch = m[2];
    else if (m && tickers.has(m[1].toUpperCase())) lines.push({ ticker: m[1].toUpperCase(), text: m[2] });
  }
  return json({ lines, watch, model, generated: Date.now() });
}
