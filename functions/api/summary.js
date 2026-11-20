// GET /api/summary?coin=BTC
// A short, plain-English summary of what the latest headlines say about a coin,
// written by a small AI model on Cloudflare Workers AI. Built only from headlines
// this server fetched itself (no user-supplied text), and cached for 30 minutes.
import { onRequestGet as getNews } from "./news.js";

const MODELS = ["@cf/meta/llama-3.1-8b-instruct-fast", "@cf/meta/llama-3.1-8b-instruct"];
const CACHE_SECONDS = 1800;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const stock = (url.searchParams.get("stock") || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
  const coin = stock || (url.searchParams.get("coin") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const name = (url.searchParams.get("name") || coin).replace(/[^\w .,&'-]/g, "").slice(0, 60);
  if (!coin) return json({ error: "coin required" }, 400);
  const kind = stock ? "stock" : "crypto";

  if (!env || !env.AI) {
    return json({ available: false, reason: "AI summaries run on the hosted site only." });
  }

  const bucket = Math.floor(Date.now() / (CACHE_SECONDS * 1000));
  const cacheKey = new Request(`${url.origin}/api/summary?${kind}=${coin}&b=${bucket}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const newsUrl = stock ? `${url.origin}/api/news?stock=${stock}&name=${encodeURIComponent(name)}` : `${url.origin}/api/news?coin=${coin}`;
  const newsRes = await getNews({ request: new Request(newsUrl), waitUntil: context.waitUntil });
  const news = await newsRes.json();
  const dayAgo = Date.now() - 36 * 3600 * 1000;
  const items = news.items.filter((i) => !i.published || i.published > dayAgo).slice(0, 25);
  if (items.length < 3) {
    return json({ available: true, coin, summary: null, reason: "Not enough recent headlines to summarize.", count: items.length });
  }

  const headlines = items.map((i, n) => `${n + 1}. ${i.title} (${i.source})`).join("\n");
  const messages = [
    {
      role: "system",
      content:
        `You summarize ${kind} news headlines for a beginner investor in plain English. ` +
        "Use ONLY the headlines provided; do not add facts, numbers or events that are not in them. " +
        "Do not give buy/sell advice and do not predict prices. " +
        "Write exactly 3 bullet points, each starting with '- ' and under 30 words. " +
        "Then a final line exactly in the form 'Mood: positive' or 'Mood: negative' or 'Mood: mixed' or 'Mood: neutral'.",
    },
    { role: "user", content: `${stock ? "Company" : "Coin"}: ${name} (${coin}). Latest headlines:\n${headlines}` },
  ];

  let text = null, model = null, lastErr = null;
  for (const m of MODELS) {
    try {
      const out = await env.AI.run(m, { messages, max_tokens: 300, temperature: 0.2 });
      text = (out && (out.response ?? out.result?.response)) || null;
      if (text) { model = m; break; }
    } catch (e) { lastErr = String(e && e.message || e); }
  }
  if (!text) return json({ available: false, reason: "The AI service didn't respond.", detail: lastErr }, 200, 60);

  const bullets = text.split("\n").map((l) => l.trim()).filter((l) => /^[-•*]\s+/.test(l)).map((l) => l.replace(/^[-•*]\s+/, "")).slice(0, 3);
  const moodMatch = text.match(/mood:\s*(positive|negative|mixed|neutral)/i);
  const body = {
    available: true, coin, model, count: items.length,
    bullets: bullets.length ? bullets : [text.slice(0, 400)],
    mood: moodMatch ? moodMatch[1].toLowerCase() : null,
    generated: Date.now(),
  };
  const res = json(body, 200, CACHE_SECONDS);
  if (cache && context.waitUntil) context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });
}
