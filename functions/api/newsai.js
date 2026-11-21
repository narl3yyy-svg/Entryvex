// GET /api/newsai?sym=BTCUSDT            → the AI's read of the latest headlines for a market
// GET /api/newsai?sym=S:AAPL&name=Apple
// GET /api/newsai?sym=BTCUSDT&track=1    → every past AI read for that market (for measuring it)
//
// The site's own AI (Cloudflare Workers AI) reads up to 25 recent headlines and rates each one:
//   relevance 0–2 (is it really about this coin/company and could it move the price?)
//   impact   −2…+2 (how bad or good for the price, if true)
// They're combined into one news score from −1 (very negative) to +1 (very positive).
//
// Every read is RECORDED with the price at that moment (KV, last 600 per market), and a cron reads
// popular markets about every 2 hours. That record is what lets Entryvex measure — instead of assume —
// whether the AI's news reading actually helps predict the next 24 hours.
import { onRequestGet as getNews } from "./news.js";
import { candles } from "./push.js";

const MODELS = ["@cf/meta/llama-3.1-8b-instruct-fast", "@cf/meta/llama-3.1-8b-instruct"];
const CACHE_SECONDS = 1800;
const SYM = /^(S:[A-Z0-9.^=\-]{1,12}|[A-Z0-9]{3,20})$/;
const LOG_MAX = 600;
export const TRACKED = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "S:SPY", "S:QQQ", "S:AAPL", "S:NVDA", "S:TSLA", "S:MSFT", "S:AMZN"];
const NAMES = { "S:SPY": "S&P 500", "S:QQQ": "Nasdaq 100", "S:AAPL": "Apple", "S:NVDA": "NVIDIA", "S:TSLA": "Tesla", "S:MSFT": "Microsoft", "S:AMZN": "Amazon" };

const isStock = (s) => s.startsWith("S:");
const baseOf = (s) => (isStock(s) ? s.slice(2) : s.replace(/(USDT|USDC|USD)$/, ""));
const logKey = (s) => "nlog:" + (isStock(s) ? s : baseOf(s));    // crypto: one record per coin, whatever the pair
const priceSym = (s) => (isStock(s) ? s : baseOf(s) + "USDT");

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sym = (url.searchParams.get("sym") || "").toUpperCase();
  if (!SYM.test(sym) || /[\^=]/.test(sym)) return json({ error: "bad symbol" }, 400);
  if (url.searchParams.get("track")) {
    const log = env?.PUSH ? (await env.PUSH.get(logKey(sym), "json")) || [] : [];
    return json({ sym, log }, 200, 300);
  }
  const name = (url.searchParams.get("name") || NAMES[sym] || baseOf(sym)).replace(/[^\w .,&'-]/g, "").slice(0, 60);
  if (!env?.AI) return json({ available: false, reason: "The AI news reader runs on the hosted site only." });

  const bucket = Math.floor(Date.now() / (CACHE_SECONDS * 1000));
  const cacheKey = new Request(`${url.origin}/api/newsai?sym=${encodeURIComponent(sym)}&b=${bucket}`);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }

  const body = await readNews(env, url.origin, sym, name, context.waitUntil);
  const res = json(body, 200, body.available ? CACHE_SECONDS : 120);
  if (cache && context.waitUntil && body.available) context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/** Read and score the headlines for one market, and record the result. */
export async function readNews(env, origin, sym, name, waitUntil) {
  const base = baseOf(sym);
  const newsUrl = isStock(sym) ? `${origin}/api/news?stock=${encodeURIComponent(base)}&name=${encodeURIComponent(name)}` : `${origin}/api/news?coin=${encodeURIComponent(base)}`;
  let items = [];
  try {
    const news = await (await getNews({ request: new Request(newsUrl), waitUntil: waitUntil || (() => {}) })).json();
    const since = Date.now() - 36 * 3600e3;
    items = (news.items || []).filter((i) => !i.published || i.published > since).slice(0, 25);
  } catch {}
  if (items.length < 3) return { available: true, sym, score: null, count: items.length, reason: "Not enough recent headlines to read." };

  const list = items.map((it, n) => `${n + 1}. ${it.title} (${it.source})`).join("\n");
  const messages = [
    { role: "system", content:
      `You rate news headlines for how they could affect the price of ${name} (${base}). ` +
      "For EVERY numbered headline output one line exactly in the form: number|relevance|impact\n" +
      "relevance: 0 = not really about it or no price effect, 1 = somewhat, 2 = directly about it and could move the price.\n" +
      "impact: -2 very bad for the price, -1 bad, 0 neutral or unclear, 1 good, 2 very good.\n" +
      "Judge only from the headline text. Price moves that already happened (\"falls 5%\") are reports, not news: give them relevance 1 at most.\n" +
      "After the lines, write one final line starting with 'Why:' that explains in under 25 plain words what the news is mainly about. No advice, no predictions." },
    { role: "user", content: list },
  ];
  let text = null, model = null;
  for (const m of MODELS) {
    try {
      const out = await env.AI.run(m, { messages, max_tokens: 400, temperature: 0 });
      text = (out && (out.response ?? out.result?.response)) || null;
      if (text) { model = m; break; }
    } catch {}
  }
  if (!text) return { available: false, sym, reason: "The AI service didn't respond." };

  const rated = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d{1,2})\s*\|\s*([0-2])\s*\|\s*(-?[0-2])\b/);
    if (!m) continue;
    const i = +m[1] - 1;
    if (!items[i] || rated.some((r) => r.i === i)) continue;
    rated.push({ i, rel: +m[2], imp: +m[3] });
  }
  if (rated.length < Math.min(3, items.length)) return { available: false, sym, reason: "The AI's answer couldn't be read." };
  const wRel = rated.reduce((s, r) => s + r.rel, 0);
  const score = wRel > 0 ? rated.reduce((s, r) => s + r.rel * r.imp, 0) / (2 * wRel) : 0;     // −1 … +1
  const why = (text.match(/why:\s*(.+)/i)?.[1] || "").trim().slice(0, 220);
  const top = rated.filter((r) => r.rel >= 1 && r.imp !== 0).sort((a, b) => b.rel * Math.abs(b.imp) - a.rel * Math.abs(a.imp)).slice(0, 5)
    .map((r) => ({ title: items[r.i].title, source: items[r.i].source, link: items[r.i].link, impact: r.imp, relevance: r.rel }));
  const result = { available: true, sym, model, count: items.length, rated: rated.length, relevant: rated.filter((r) => r.rel > 0).length,
    score: +score.toFixed(3), why, top, generated: Date.now() };

  // Record it with the current price (at most one entry per ~2 hours per market).
  if (env.PUSH) {
    const save = (async () => {
      try {
        const key = logKey(sym);
        const log = (await env.PUSH.get(key, "json")) || [];
        if (log.length && Date.now() - log.at(-1).t < 110 * 60e3) return;   // ≤ 1 write per market per ~2 h (KV free tier: 1,000 writes/day)
        let p = null;
        try { const c = await candles(priceSym(sym), "1h", 1); p = c.at(-1)?.close ?? null; } catch {}
        if (!(p > 0)) return;
        log.push({ t: Date.now(), s: result.score, n: result.relevant, p: +p.toPrecision(8) });
        await env.PUSH.put(key, JSON.stringify(log.slice(-LOG_MAX)));
      } catch {}
    })();
    if (waitUntil) waitUntil(save); else await save;
  }
  return result;
}

/**
 * Cron: read one tracked market on every other 5-minute tick, so each is read about every 2 hours
 * (≈144 AI calls and KV writes a day, well inside the free tiers).
 */
export async function cronNews(env, now = Date.now()) {
  if (!env?.AI || !env?.PUSH) return;
  const tick = Math.floor(now / (5 * 60e3));
  if (tick % 2) return;
  const slot = (tick / 2) % TRACKED.length;
  const sym = TRACKED[slot];
  await readNews(env, "https://entryvex.trade", sym, NAMES[sym] || baseOf(sym), null).catch(() => {});
}

function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });
}
