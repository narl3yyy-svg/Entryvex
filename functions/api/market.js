// GET /api/market?src=...: a small, locked-down relay for stock data that browsers can't
// fetch directly (no CORS): Yahoo Finance prices/search and SEC EDGAR company filings.
// Only fixed upstream URLs built from validated parameters are allowed. Responses are passed
// through untouched (no parsing here, to keep server CPU tiny) and cached at the edge.

const UA = "Mozilla/5.0 (compatible; Entryvex/1.0; +https://entryvex.trade)";
const SEC_UA = "Entryvex research dashboard https://entryvex.trade";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SYM = /^[A-Z0-9.^=\-]{1,12}$/;
const INTERVALS = new Set(["1m", "5m", "15m", "60m", "1d", "1wk", "1mo"]);
const RANGES = new Set(["1d", "2d", "5d", "7d", "1mo", "60d", "3mo", "1y", "730d", "2y", "5y", "10y", "20y", "max"]);

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
    // Ranked lists for "Browse": biggest companies and most-traded ETFs, 250 per page (start 0–750).
    const big = ["largest_market_cap", "most_actives_etfs"].includes(id);
    if (!big && !["most_actives", "day_gainers", "day_losers"].includes(id)) return null;
    const start = big ? Math.max(0, Math.min(750, parseInt(p.get("start") || "0", 10) || 0)) : 0;
    if (big && start % 250) return null;
    const qs = big ? `scrIds=${id}&count=250&start=${start}` : `scrIds=${id}&count=25`;
    return { urls: [`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?${qs}`, `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?${qs}`], ttl: big ? 1800 : 60, ua: UA, slim: big ? slimScreener : null };
  }
  if (src === "calendar") {
    // This week's economic calendar (central banks, inflation, jobs, GDP…) for major economies.
    return { urls: ["https://nfs.faireconomy.media/ff_calendar_thisweek.json"], ttl: 900, ua: UA };
  }
  if (src === "earnings") {
    // US earnings calendar for one day (Nasdaq). Only dates from 10 days ago to 60 days ahead.
    const d = p.get("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    const days = (Date.parse(d + "T00:00:00Z") - Date.now()) / 86400e3;
    if (!(days > -11 && days < 61)) return null;
    return { urls: [`https://api.nasdaq.com/api/calendar/earnings?date=${d}`], ttl: days < 0 ? 86400 : 10800, ua: BROWSER_UA, slim: slimEarnings };
  }
  if (src === "sec-earnings") {
    // Past earnings releases (8-K filings with item 2.02) and their exact filing times.
    const cik = p.get("cik") || "";
    if (!/^\d{10}$/.test(cik)) return null;
    // page 1–3 = older filing history (companies with many filings have it split into extra files).
    const page = p.get("page");
    if (page != null && !/^[1-3]$/.test(page)) return null;
    const file = page ? `CIK${cik}-submissions-00${page}.json` : `CIK${cik}.json`;
    return { urls: [`https://data.sec.gov/submissions/${file}`], ttl: page ? 86400 : 21600, ua: SEC_UA, slimText: slimSecEarnings };
  }
  if (src === "sec-tickers") return { urls: ["https://www.sec.gov/files/company_tickers.json"], ttl: 86400, ua: SEC_UA };
  if (src === "sec-concept") {
    const cik = p.get("cik") || "", tax = p.get("tax") || "", concept = p.get("concept") || "";
    if (!/^\d{10}$/.test(cik) || !/^(us-gaap|dei)$/.test(tax) || !/^[A-Za-z]{3,80}$/.test(concept)) return null;
    return { urls: [`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${tax}/${concept}.json`], ttl: 21600, ua: SEC_UA };
  }
  return null;
}

/**
 * From a company's SEC filing index, keep only earnings releases: 8-K filings that include item 2.02
 * ("Results of Operations"), with their acceptance time. The index can be several MB, so instead of
 * parsing all of it, only the four parallel lists we need are cut out of the text and parsed.
 */
function slimSecEarnings(text) {
  // The main index wraps the lists in "recent"; the older pages have them at the top level.
  const start = Math.max(0, text.indexOf('"recent"'));
  const list = (key) => {
    const i = text.indexOf(`"${key}":[`, start);
    if (i < 0) throw new Error("format");
    const a = text.indexOf("[", i), b = text.indexOf("]", a);
    return JSON.parse(text.slice(a, b + 1));
  };
  const form = list("form"), date = list("filingDate"), acc = list("acceptanceDateTime"), items = list("items");
  const out = [];
  for (let k = 0; k < form.length; k++) {
    if (form[k] === "8-K" && String(items[k] || "").split(",").includes("2.02")) out.push({ d: date[k], a: acc[k] });
  }
  return out;
}

/** Ranked screener page → just what the Browse list shows. */
function slimScreener(j) {
  const q = j?.finance?.result?.[0]?.quotes || [];
  return q.filter((x) => x.symbol && x.symbol.length <= 12).map((x) => ({
    s: x.symbol, n: String(x.shortName || x.longName || x.symbol).slice(0, 60), p: x.regularMarketPrice ?? null,
    c: x.regularMarketChangePercent ?? null, mc: x.marketCap ?? x.netAssets ?? null, v: x.regularMarketVolume ?? null,
    t: x.quoteType === "ETF" ? "ETF" : "Stock", cur: x.currency || "USD", ex: x.fullExchangeName || x.exchange || "",
  }));
}

/** Keep only what Entryvex shows from the earnings calendar (much smaller for phones). */
function slimEarnings(j) {
  const rows = j?.data?.rows || [];
  const num = (v) => { const x = parseFloat(String(v || "").replace(/[$,()]/g, "")); return isFinite(x) ? (String(v).includes("(") ? -x : x) : null; };
  return rows.filter((r) => r.symbol && /^[A-Z.\-]{1,8}$/.test(r.symbol)).map((r) => ({
    s: r.symbol, n: String(r.name || "").slice(0, 80),
    t: r.time === "time-pre-market" ? "pre" : r.time === "time-after-hours" ? "post" : "",
    e: num(r.epsForecast), ne: parseInt(r.noOfEsts, 10) || 0, ly: num(r.lastYearEPS), mc: num(r.marketCap),
  }));
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
      upstream = await fetch(u, { headers: { "user-agent": r.ua, accept: "application/json, text/plain, */*", ...(r.slim ? { "accept-language": "en-US,en;q=0.9" } : {}) }, cf: { cacheTtl: r.ttl } });
      if (upstream.ok) break;
    } catch { upstream = null; }
  }
  if (!upstream) return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 502, headers: { "content-type": "application/json" } });
  // A company that simply doesn't report a given figure isn't an error: answer "missing" quietly.
  if (upstream.status === 404 && url.searchParams.get("src") === "sec-concept") {
    return new Response(JSON.stringify({ missing: true }), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${r.ttl}` } });
  }

  let body = upstream.body;
  if ((r.slim || r.slimText) && upstream.ok) {
    try { body = JSON.stringify(r.slim ? r.slim(await upstream.json()) : r.slimText(await upstream.text())); }
    catch { return new Response(JSON.stringify({ error: "upstream format" }), { status: 502, headers: { "content-type": "application/json" } }); }
  }
  const res = new Response(body, {
    status: upstream.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": upstream.ok ? `public, max-age=${r.ttl}` : "no-store" },
  });
  if (upstream.ok && cache && context.waitUntil) context.waitUntil(cache.put(key, res.clone()));
  return res;
}
