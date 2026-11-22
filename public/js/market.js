// One market layer for crypto (Binance.US) and US stocks/ETFs (Yahoo Finance via /api/market).
// Stock symbols are written "S:AAPL"; everything else is a Binance.US pair like "BTCUSDT".
// Other modules call these functions and never need to know which market a symbol is from.
import * as bn from "./binance.js";
import { loadCandles, saveCandles, mergeCandles } from "./candlecache.js";

export const isStock = (sym) => typeof sym === "string" && sym.startsWith("S:");
export const tickerOf = (sym) => (isStock(sym) ? sym.slice(2) : sym);

/* ---------------- Stock registry (name + order rules) ---------------- */
const STOCK_RULES = { quote: "USD", stepSize: 1, minQty: 1, tickSize: 0.01, minNotional: 1, type: "stock" };
let stockMeta = {};
try { stockMeta = JSON.parse(localStorage.getItem("evx.stockMeta") || "{}"); } catch {}
export function registerStock(sym, meta) {
  stockMeta[sym] = { ...(stockMeta[sym] || {}), ...meta };
  try { localStorage.setItem("evx.stockMeta", JSON.stringify(stockMeta)); } catch {}
}
export function stockInfo(sym) {
  const t = tickerOf(sym), m = stockMeta[sym] || {};
  const currency = m.currency || "USD";
  // Index symbols always start with "^" (older saved entries may say "stock").
  const kind = t.startsWith("^") ? "Index" : m.kind && m.kind !== "stock" ? m.kind : "Stock";
  return { symbol: sym, base: t, name: m.name || t, exchange: m.exchange, kind, ...STOCK_RULES, quote: currency, currency };
}

/* ---------------- Yahoo chart parsing ---------------- */
const STOCK_IV = {
  "1m": { interval: "1m", range: "7d", recent: "1d" },
  "5m": { interval: "5m", range: "60d", recent: "5d" },
  "15m": { interval: "15m", range: "60d", recent: "5d" },
  "1h": { interval: "60m", range: "730d", recent: "1mo" },
  "4h": { interval: "60m", range: "730d", recent: "3mo", group: 4 },
  "1d": { interval: "1d", range: "10y", recent: "3mo" },
  "1w": { interval: "1wk", range: "max", recent: "1y" },
};

async function stockChart(sym, interval, which = "range") {
  const m = STOCK_IV[interval] || STOCK_IV["15m"];
  const url = `/api/market?src=chart&symbol=${encodeURIComponent(tickerOf(sym))}&interval=${m.interval}&range=${which === "recent" ? m.recent : m.range}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stock data ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(j?.chart?.error?.description || "No stock data");
  const q = r.indicators?.quote?.[0] || {};
  let candles = [];
  (r.timestamp || []).forEach((t, i) => {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) return;
    candles.push({ time: t, open: o, high: h, low: l, close: c, volume: q.volume?.[i] || 0 });
  });
  if (m.group) candles = groupCandles(candles, m.group);
  const meta = r.meta || {};
  if (meta.longName || meta.shortName || meta.currency) registerStock(sym, { name: meta.longName || meta.shortName || stockMeta[sym]?.name, exchange: meta.fullExchangeName || meta.exchangeName, currency: meta.currency });
  return { candles, meta };
}

/** Combine every `n` consecutive candles of the same trading day (used for 4h from 1h). */
function groupCandles(c, n) {
  const out = [];
  let cur = null, count = 0, day = null;
  for (const k of c) {
    const d = new Date(k.time * 1000).toISOString().slice(0, 10);
    if (!cur || count === n || d !== day) {
      if (cur) out.push(cur);
      cur = { ...k }; count = 1; day = d;
    } else {
      cur.high = Math.max(cur.high, k.high); cur.low = Math.min(cur.low, k.low);
      cur.close = k.close; cur.volume += k.volume; count++;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function marketOpen(meta) {
  const p = meta?.currentTradingPeriod?.regular;
  if (!p) return null;
  const now = Date.now() / 1000;
  return now >= p.start && now < p.end;
}

/* ---------------- Unified API (same shapes as binance.js) ---------------- */
const histCache = new Map();
export async function getKlineHistory(sym, interval, total = 3000) {
  if (!isStock(sym)) return bn.getKlineHistory(sym, interval, total);
  const key = `${sym}:${interval}`;
  const hit = histCache.get(key);
  if (hit && Date.now() - hit.t < 60_000) return hit.v.slice(-total);
  // Saved from an earlier visit and still overlapping the short "recent" range? Then download only that.
  const dbKey = `yh:${sym}:${interval}`;
  const { candles: saved } = await loadCandles(dbKey);
  const recentDays = { "1m": 1, "5m": 5, "15m": 5, "1h": 28, "4h": 85, "1d": 85, "1w": 360 }[interval];
  if (saved.length && recentDays && Date.now() / 1000 - saved.at(-1).time < (recentDays - 1) * 86400) {
    try {
      const { candles: fresh } = await stockChart(sym, interval, "recent");
      if (fresh.length && fresh[0].time <= saved.at(-1).time) {
        const merged = mergeCandles(saved, fresh).slice(-6000);
        histCache.set(key, { t: Date.now(), v: merged });
        if (fresh.at(-1).time > saved.at(-1).time) saveCandles(dbKey, merged, 6000);   // only when a new candle appeared
        return merged.slice(-total);
      }
    } catch { /* fall through to a full download */ }
  }
  const { candles } = await stockChart(sym, interval, "range");
  histCache.set(key, { t: Date.now(), v: candles });  // cache everything; callers slice what they need
  saveCandles(dbKey, candles, 6000);
  return candles.slice(-total);
}

export async function getKlines(sym, interval, limit = 500) {
  if (!isStock(sym)) return bn.getKlines(sym, interval, limit);
  if (limit > 60) return (await getKlineHistory(sym, interval, limit)).slice(-limit);
  const { candles } = await stockChart(sym, interval, "recent");
  return candles.slice(-limit);
}

/** Candles starting at `startSec` (used to check how a past signal turned out). */
export async function getKlinesSince(sym, interval, startSec, limit) {
  if (!isStock(sym)) {
    const raw = await (await fetch(`https://api.binance.us/api/v3/klines?symbol=${sym}&interval=${interval}&startTime=${startSec * 1000}&limit=${limit}`)).json();
    return raw.map((k) => ({ time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], closeTime: k[6] / 1000 }));
  }
  const all = await getKlineHistory(sym, interval, 3000);
  const sec = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 }[interval] || 900;
  return all.filter((k) => k.time >= startSec).slice(0, limit).map((k) => ({ ...k, closeTime: k.time + sec }));
}

/** Cost of crossing the bid/ask. Measured live for crypto; a conservative estimate for stocks. */
export async function getBookTicker(sym) {
  if (!isStock(sym)) return bn.getBookTicker(sym);
  return { spreadPct: 0.0004, estimated: true };
}

/** 24h-style stats. For stocks, "change" is vs. the previous close and the market state is included. */
export async function get24h(symbols) {
  const crypto = symbols.filter((s) => !isStock(s));
  const stocks = symbols.filter(isStock);
  const out = crypto.length ? await bn.get24h(crypto) : [];
  const sres = await Promise.allSettled(stocks.map(stockQuote));
  sres.forEach((r) => { if (r.status === "fulfilled" && r.value) out.push(r.value); });
  return out;
}

const nyDate = (t) => new Date(t * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York" });

async function stockQuote(sym) {
  const { candles, meta } = await stockChart(sym, "5m", "recent");
  const last = meta.regularMarketPrice ?? candles.at(-1)?.close;
  // "Today" = the latest trading session in the data; compare with the previous session's close.
  const lastDay = candles.length ? nyDate(candles.at(-1).time) : null;
  const session = candles.filter((c) => nyDate(c.time) === lastDay);
  const before = candles.filter((c) => c.time < (session[0]?.time ?? 0));
  const prev = before.at(-1)?.close ?? meta.previousClose ?? meta.chartPreviousClose;
  const dayHigh = session.length ? Math.max(...session.map((c) => c.high)) : meta.regularMarketDayHigh;
  const dayLow = session.length ? Math.min(...session.map((c) => c.low)) : meta.regularMarketDayLow;
  const dayVol = session.reduce((s, c) => s + (c.volume || 0) * c.close, 0);
  return {
    symbol: sym, last, open: prev,
    changePct: prev ? ((last - prev) / prev) * 100 : 0,
    high: dayHigh, low: dayLow,
    quoteVolume: dayVol || (meta.regularMarketVolume || 0) * last,
    marketOpen: marketOpen(meta), hi52: meta.fiftyTwoWeekHigh, lo52: meta.fiftyTwoWeekLow,
  };
}

/* ---------------- Live feeds ---------------- */
/**
 * Live prices for a list of symbols. Crypto streams over WebSocket; stocks are polled.
 * onTick({symbol, last, open, high, low, quoteVolume, changePct, marketOpen?})
 */
export function createTickerFeed(symbols, { onTick, onStatus }) {
  const crypto = symbols.filter((s) => !isStock(s));
  const stocks = symbols.filter(isStock);
  const status = { c: crypto.length ? "connecting" : "live", s: stocks.length ? "connecting" : "live" };
  const report = () => onStatus(status.c === "live" && status.s === "live" ? "live" : (status.c === "down" || status.s === "down") ? "down" : "connecting");
  let stream = null, timer = null, closed = false;
  if (crypto.length) {
    stream = new bn.Stream(crypto.map((s) => s.toLowerCase() + "@miniTicker"), {
      onStatus: (s) => { status.c = s; report(); },
      onMessage: (_st, d) => {
        const open = +d.o, last = +d.c;
        onTick({ symbol: d.s, last, open, high: +d.h, low: +d.l, quoteVolume: +d.q, changePct: open ? ((last - open) / open) * 100 : 0 });
      },
    });
  }
  if (stocks.length) {
    // Markets that are closed (nights, weekends, holidays) are only re-checked every 5 minutes:
    // their price can't change, so there's no point asking every 10 seconds.
    const last = new Map();   // symbol → { t, open }
    const poll = async () => {
      if (closed) return;
      const now = Date.now();
      const due = stocks.filter((s) => { const l = last.get(s); return !l || l.open !== false || now - l.t > 5 * 60_000; });
      const res = await Promise.allSettled(due.map(stockQuote));
      let ok = 0;
      res.forEach((r, k) => {
        if (r.status === "fulfilled" && r.value) { ok++; onTick(r.value); last.set(due[k], { t: now, open: r.value.marketOpen }); }
      });
      if (due.length) { status.s = ok ? "live" : "down"; report(); }
      timer = setTimeout(poll, document.visibilityState === "visible" ? 10_000 : 30_000);
    };
    poll();
  }
  report();
  return { close() { closed = true; stream?.close(); clearTimeout(timer); } };
}

/** Live candles for the chart. onCandle({time, open, high, low, close, volume, closed}) */
export function createKlineFeed(sym, interval, { onCandle, onStatus }) {
  if (!isStock(sym)) {
    const s = new bn.Stream([`${sym.toLowerCase()}@kline_${interval}`], { onStatus, onMessage: (_st, d) => onCandle(bn.klineFromStream(d)) });
    return { close: () => s.close() };
  }
  let closed = false, timer = null, lastTime = 0;
  const every = interval === "1m" || interval === "5m" ? 10_000 : 30_000;
  let isOpen = null;
  const poll = async () => {
    if (closed) return;
    try {
      const { candles, meta } = await stockChart(sym, interval, "recent");
      isOpen = marketOpen(meta);
      const recent = candles.slice(-3);
      recent.forEach((c, i) => {
        if (c.time < lastTime) return;
        onCandle({ ...c, closed: i < recent.length - 1 });
      });
      lastTime = recent.at(-2)?.time ?? lastTime;
      onStatus("live");
    } catch { onStatus("down"); }
    // Closed market: the candles can't change, so check again in 5 minutes instead.
    timer = setTimeout(poll, isOpen === false ? 5 * 60_000 : document.visibilityState === "visible" ? every : every * 3);
  };
  onStatus("connecting");
  poll();
  return { close() { closed = true; clearTimeout(timer); } };
}

/* ---------------- Stock search ---------------- */
const US_EXCHANGES = new Set(["NMS", "NYQ", "NGM", "NCM", "ASE", "PCX", "BTS", "NAS", "NYS", "PNK"]);
// Major international exchanges (Yahoo codes): Europe, Asia-Pacific, the Americas.
const INTL_EXCHANGES = new Set(["LSE", "GER", "FRA", "PAR", "AMS", "BRU", "MIL", "MCE", "EBS", "STO", "CPH", "HEL", "OSL", "VIE", "LIS",
  "JPX", "HKG", "SHH", "SHZ", "KSC", "KOE", "TAI", "TWO", "NSI", "BSE", "ASX", "NZE", "SES", "TOR", "VAN", "SAO", "MEX"]);
// Everyday names people type for the big indices → the index itself, shown first.
const INDEX_ALIASES = {
  "^DJI": ["dji", "djia", "dow", "dow jones", "dow 30", "dow jones industrial average", "the dow"],
  "^GSPC": ["spx", "s&p", "s&p 500", "s&p500", "sp500", "sp 500", "gspc"],
  "^IXIC": ["nasdaq", "nasdaq composite", "ixic", "comp"],
  "^NDX": ["ndx", "nasdaq 100", "nasdaq-100", "nas100"],
  "^RUT": ["rut", "russell", "russell 2000", "small caps"],
  "^VIX": ["vix", "volatility", "fear index"],
  "^FTSE": ["ftse", "ftse 100", "footsie", "uk100"],
  "^GDAXI": ["dax", "dax 40", "germany 40", "de40"],
  "^FCHI": ["cac", "cac 40", "france 40"],
  "^STOXX50E": ["stoxx", "euro stoxx", "euro stoxx 50", "sx5e"],
  "^N225": ["nikkei", "nikkei 225", "n225", "japan 225"],
  "^HSI": ["hang seng", "hsi", "hong kong 50"],
  "000001.SS": ["shanghai", "shanghai composite", "sse"],
  "^BSESN": ["sensex", "bse"],
  "^NSEI": ["nifty", "nifty 50"],
  "^KS11": ["kospi"],
  "^AXJO": ["asx", "asx 200", "australia 200"],
  "^GSPTSE": ["tsx", "s&p/tsx"],
  "^BVSP": ["bovespa", "ibovespa"],
};
const INDEX_NAMES = { "^DJI": "Dow Jones Industrial Average", "^GSPC": "S&P 500", "^IXIC": "Nasdaq Composite", "^NDX": "Nasdaq-100", "^RUT": "Russell 2000",
  "^VIX": "CBOE Volatility Index (VIX)", "^FTSE": "FTSE 100", "^GDAXI": "DAX 40", "^FCHI": "CAC 40", "^STOXX50E": "Euro Stoxx 50", "^N225": "Nikkei 225",
  "^HSI": "Hang Seng", "000001.SS": "Shanghai Composite", "^BSESN": "BSE Sensex", "^NSEI": "Nifty 50", "^KS11": "KOSPI", "^AXJO": "S&P/ASX 200",
  "^GSPTSE": "S&P/TSX Composite", "^BVSP": "Bovespa" };
function aliasHits(q) {
  const s = q.toLowerCase().replace(/\s+/g, " ").trim();
  if (s.length < 2) return [];
  return Object.entries(INDEX_ALIASES)
    .map(([sym, names]) => ({ sym, score: names.includes(s) ? 0 : names.some((n) => n.startsWith(s)) && s.length >= 3 ? 1 : 9 }))
    .filter((x) => x.score < 9).sort((a, b) => a.score - b.score)
    .map(({ sym }) => ({ symbol: "S:" + sym, ticker: sym, name: INDEX_NAMES[sym], exchange: "Index", kind: "Index", intl: !/^\^(DJI|GSPC|IXIC|NDX|RUT|VIX)$/.test(sym) }));
}

export async function searchStocks(q) {
  q = q.trim();
  if (!q) return [];
  const aliases = aliasHits(q);
  let quotes = [];
  try {
    const res = await fetch(`/api/market?src=search&q=${encodeURIComponent(q)}`);
    if (res.ok) quotes = (await res.json()).quotes || [];
  } catch {}
  const Q = q.toUpperCase().replace(/^\^/, "");
  const found = quotes
    .filter((x) => (x.quoteType === "EQUITY" || x.quoteType === "ETF" || x.quoteType === "INDEX") && x.symbol && x.symbol.length <= 12
      && (US_EXCHANGES.has(x.exchange) || INTL_EXCHANGES.has(x.exchange) || x.quoteType === "INDEX"))
    // Keep Yahoo's relevance order, but put an exact ticker match first (DJI → ^DJI, AAPL → AAPL).
    .map((x, i) => ({ x, rank: (x.symbol.replace(/^\^/, "") === Q ? 0 : 1) * 100 + i }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ x }) => ({ symbol: "S:" + x.symbol, ticker: x.symbol, name: INDEX_NAMES[x.symbol] || x.longname || x.shortname || x.symbol, exchange: x.exchDisp || x.exchange,
      kind: x.quoteType === "ETF" ? "ETF" : x.quoteType === "INDEX" ? "Index" : "Stock", intl: !US_EXCHANGES.has(x.exchange) && x.quoteType !== "INDEX" }));
  const seen = new Set();
  return [...aliases, ...found].filter((h) => !seen.has(h.symbol) && seen.add(h.symbol)).slice(0, 8);
}

/** Popular markets for the empty search box (quick add). */
export const POPULAR = {
  crypto: ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "LTC", "DOT", "SUI", "SHIB", "BCH", "XLM", "HBAR", "UNI", "AAVE", "NEAR"],
  indices: ["^GSPC", "^DJI", "^IXIC", "^RUT", "^VIX"],
  etfs: [["SPY", "SPDR S&P 500 ETF"], ["QQQ", "Invesco QQQ (Nasdaq-100)"], ["DIA", "SPDR Dow Jones ETF"], ["IWM", "iShares Russell 2000"], ["VOO", "Vanguard S&P 500"], ["VTI", "Vanguard Total Stock Market"], ["GLD", "SPDR Gold Shares"], ["TLT", "iShares 20+ Year Treasury"], ["SMH", "VanEck Semiconductor"], ["ARKK", "ARK Innovation"]],
  us: [["NVDA", "NVIDIA"], ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["AMZN", "Amazon"], ["GOOGL", "Alphabet"], ["META", "Meta Platforms"], ["TSLA", "Tesla"], ["AVGO", "Broadcom"], ["BRK-B", "Berkshire Hathaway"], ["JPM", "JPMorgan Chase"], ["AMD", "AMD"], ["NFLX", "Netflix"], ["PLTR", "Palantir"], ["COIN", "Coinbase"], ["MSTR", "Strategy (MicroStrategy)"]],
  intl: [["TSM", "TSMC (US listing)", "NYSE"], ["ASML", "ASML (US listing)", "Nasdaq"], ["7203.T", "Toyota", "Tokyo"], ["6758.T", "Sony", "Tokyo"], ["0700.HK", "Tencent", "Hong Kong"], ["9988.HK", "Alibaba", "Hong Kong"], ["005930.KS", "Samsung Electronics", "Seoul"],
    ["SAP.DE", "SAP", "XETRA"], ["MC.PA", "LVMH", "Paris"], ["NESN.SW", "Nestlé", "Zurich"], ["NOVO-B.CO", "Novo Nordisk", "Copenhagen"], ["SHEL.L", "Shell", "London"], ["AZN.L", "AstraZeneca", "London"], ["RELIANCE.NS", "Reliance Industries", "NSE India"], ["SHOP.TO", "Shopify", "Toronto"], ["BHP.AX", "BHP", "Sydney"]],
  indexNames: INDEX_NAMES,
};
