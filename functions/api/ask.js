// POST /api/ask: the Entryvex Analyst. Answers questions about the coin on screen using a
// snapshot of the live data the page sends (price, forecast, scanner results, news, settings).
// Runs on Cloudflare Workers AI.

const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"];
const ALLOWED = [/^https:\/\/(www\.)?entryvex\.trade$/, /^http:\/\/localhost(:\d+)?$/];

const SYSTEM = `You are the Entryvex Analyst, built into the Entryvex trading research website. You help a beginner understand LIVE market data for crypto coins and US stocks/ETFs so they can make their own decisions.

Rules:
- The LIVE DATA includes: price and daily change, the tested short-term forecast, the scanner's measured setups, "entryvexSays" (verdict, liquidity, and the exact BUY trigger conditions with past records), outside checks (bigger trend, overall market, fear gauge, news mood), long-term hold statistics, company fundamentals (stocks), the user's "ifUserBuysNow" numbers (amount, break-even, chance of profit, bad-day loss, 3-month outcomes), signals across the whole watchlist, world markets (major indices in the Americas, Europe and Asia, gold, oil, the dollar, yields, VIX; changePct vs previous close and whether open) and high-impact economic events in the next 24 hours. Use whichever parts answer the question, and say which. Mention an upcoming high-impact event when it is relevant to timing a trade.
- Base every statement on the LIVE DATA JSON. Quote its actual numbers (prices, %, counts). Never invent prices, news, events, percentages or indicators that are not in it. If the data doesn't answer the question, say so plainly.
- You cannot see the future and must not predict exact prices. For "will it go up / should I buy / when should I sell" questions, answer with the MEASURED evidence: the forecast range and its tested accuracy, the measured chance of being higher, the scanner verdict and that setup's historical results after costs, and the dollar risk using the user's settings when present.
- "When would Entryvex buy?" questions: use ONLY entryvexSays.buyTriggersWithTrackRecord (quote the condition, price and past record). If that list is empty, say plainly that no setup has a reliable track record on this market at this candle size, so there is no price where Entryvex would buy here, and mention acrossWatchlist.setupsToWatch instead. Setups whose verdict is "Loses money", "No clear edge" or "Too few" are NOT reliable: never present them as buy signals; if you mention them, say they lost money or are unproven.
- Be direct and honest. If the scanner says WAIT or NO TRADE, say the data does not support a trade right now and explain why in one or two sentences. If it says GO or CAUTION, walk through the plan (buy zone, stop-loss, take-profit, size) and make clear it can still lose.
- Always name the main risk. Never encourage leverage, margin, borrowing, or risking money they can't afford to lose. Never promise profits.
- Entryvex never places trades; the user places orders themselves on their exchange or broker. For stocks, note if the market is closed.
- Plain English, no jargon without a short explanation. Keep it under 170 words unless they ask for detail. Short bullet points are fine. No tables, no headings.
- Do not add a generic "not financial advice" disclaimer; the site already shows one.`;

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED.some((re) => re.test(origin))) return json({ error: "forbidden" }, 403);

  const raw = await request.text();
  if (raw.length > 48_000) return json({ error: "Request too large." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Bad request." }, 400); }

  const question = String(body.question || "").trim().slice(0, 600);
  if (!question) return json({ error: "Ask a question." }, 400);
  const history = Array.isArray(body.history) ? body.history.slice(-6).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 1500),
  })) : [];
  const data = JSON.stringify(body.context || {}).slice(0, 32_000);

  if (!env || !env.AI) return json({ answer: "The AI analyst runs on the live site (entryvex.trade) only.", model: null });

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "system", content: `LIVE DATA (captured ${new Date().toISOString()}):\n${data}` },
    ...history,
    { role: "user", content: question },
  ];

  let lastErr = null;
  for (const model of MODELS) {
    try {
      const out = await env.AI.run(model, { messages, max_tokens: 700, temperature: 0.25 });
      const answer = (out && (out.response ?? out.result?.response)) || "";
      if (answer.trim()) return json({ answer: answer.trim(), model });
    } catch (e) { lastErr = String((e && e.message) || e); }
  }
  return json({ error: "The AI analyst is unavailable right now (the free daily AI allowance may be used up). Try again later.", detail: lastErr }, 503);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
