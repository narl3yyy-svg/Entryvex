// GET /api/market?src=...: a small, locked-down relay for stock data that browsers can't
// fetch directly (no CORS): Yahoo Finance prices/search and SEC EDGAR company filings.
// Only fixed upstream URLs built from validated parameters are allowed. Responses are passed
// through untouched (no parsing here, to keep server CPU tiny) and cached at the edge.

const UA = "Mozilla/5.0 (compatible; Entryvex/1.0; +https://entryvex.trade)";
const SEC_UA = "Entryvex research dashboard https://entryvex.trade";
const SYM = /^[A-Z0-9.^=\-]{1,12}$/;
const INTERVALS = new Set(["1m", "5m", "15m", "60m", "1d", "1wk", "1mo"]);
const RANGES = new Set(["1d", "2d", "5d", "7d", "1mo", "60d", "3mo", "1y", "730d", "2y", "5y", "10y", "20y"]);

function route(p) {
  const src = p.get("src");
  if (src === "chart") {
    const s = (p.get("symbol") || "").toUpperCase();
    const iv = p.get("interval"), range = p.get("range");
    if (!SYM.test(s) || !INTERVALS.has(iv) || !RANGES.has(range)) return null;
    const ttl = iv === "1m" || iv === "5m" ? 15 : iv === "15m" || iv === "60m" ? 60 : iv === "1mo" ? 3600 : 900;
    const q = `${encodeURIComponent(s)}?interval=${iv}&range=${range}&includePrePost=false`;
    return { urls: [`https://query1.finance.yahoo.com/v8/finance/chart/${q}`, `https://query2.finance.yahoo.com/v8/finance/chart/${q}`], ttl, ua: UA };
  }
  if (src === "search") {
    const q = (p.get("q") || "").slice(0, 40).trim();
    if (!q) return null;
    const qs = `q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
    return { urls: [`https://query1.finance.yahoo.com/v1/finance/search?${qs}`, `https://query2.finance.yahoo.com/v1/finance/search?${qs}`], ttl: 3600, ua: UA };
  }
  if (src === "screener") {
    const id = p.get("id") || "";
    if (!["most_actives", "day_gainers", "day_losers"].includes(id)) return null;
    const qs = `scrIds=${id}&count=25`;
    return { urls: [`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?${qs}`, `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?${qs}`], ttl: 60, ua: UA };
  }
  if (src === "calendar") {
    // This week's economic calendar (central banks, inflation, jobs, GDP…) for major economies.
    return { urls: ["https://nfs.faireconomy.media/ff_calendar_thisweek.json"], ttl: 900, ua: UA };
  }
  if (src === "sec-tickers") return { urls: ["https://www.sec.gov/files/company_tickers.json"], ttl: 86400, ua: SEC_UA };
  if (src === "sec-concept") {
    const cik = p.get("cik") || "", tax = p.get("tax") || "", concept = p.get("concept") || "";
    if (!/^\d{10}$/.test(cik) || !/^(us-gaap|dei)$/.test(tax) || !/^[A-Za-z]{3,80}$/.test(concept)) return null;
    return { urls: [`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${tax}/${concept}.json`], ttl: 21600, ua: SEC_UA };
  }
  return null;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const r = route(url.searchParams);
  if (!r) return new Response(JSON.stringify({ error: "bad request" }), { status: 400, headers: { "content-type": "application/json" } });

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }

  let upstream = null;
  for (const u of r.urls) {
    try {
      upstream = await fetch(u, { headers: { "user-agent": r.ua, accept: "application/json" }, cf: { cacheTtl: r.ttl } });
      if (upstream.ok) break;
    } catch { upstream = null; }
  }
  if (!upstream) return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 502, headers: { "content-type": "application/json" } });
  // A company that simply doesn't report a given figure isn't an error: answer "missing" quietly.
  if (upstream.status === 404 && url.searchParams.get("src") === "sec-concept") {
    return new Response(JSON.stringify({ missing: true }), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${r.ttl}` } });
  }

  const res = new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": upstream.ok ? `public, max-age=${r.ttl}` : "no-store" },
  });
  if (upstream.ok && cache && context.waitUntil) context.waitUntil(cache.put(key, res.clone()));
  return res;
}
