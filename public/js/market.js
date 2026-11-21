// One market layer for crypto (Binance.US) and US stocks/ETFs (Yahoo Finance via /api/market).
// Stock symbols are written "S:AAPL"; everything else is a Binance.US pair like "BTCUSDT".
// Other modules call these functions and never need to know which market a symbol is from.
import * as bn from "./binance.js";

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
  return { symbol: sym, base: t, name: m.name || t, exchange: m.exchange, kind: m.kind || "Stock", ...STOCK_RULES, quote: currency, currency };
}

/* ---------------- Yahoo chart parsing ---------------- */
const STOCK_IV = {
  "1m": { interval: "1m", range: "7d", recent: "1d" },
  "5m": { interval: "5m", range: "60d", recent: "5d" },
  "15m": { interval: "15m", range: "60d", recent: "5d" },
  "1h": { interval: "60m", range: "730d", recent: "1mo" },
  "4h": { interval: "60m", range: "730d", recent: "3mo", group: 4 },
  "1d": { interval: "1d", range: "10y", recent: "3mo" },
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
  if (hit && Date.now() - hit.t < 120_000) return hit.v.slice(-total);
  const { candles } = await stockChart(sym, interval, "range");
  histCache.set(key, { t: Date.now(), v: candles });  // cache everything; callers slice what they need
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
  const sec = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[interval] || 900;
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
    const poll = async () => {
      if (closed) return;
      const res = await Promise.allSettled(stocks.map(stockQuote));
      let ok = 0;
      res.forEach((r) => { if (r.status === "fulfilled" && r.value) { ok++; onTick(r.value); } });
      status.s = ok ? "live" : "down"; report();
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
  const poll = async () => {
    if (closed) return;
    try {
      const { candles } = await stockChart(sym, interval, "recent");
      const recent = candles.slice(-3);
      recent.forEach((c, i) => {
        if (c.time < lastTime) return;
        onCandle({ ...c, closed: i < recent.length - 1 });
      });
      lastTime = recent.at(-2)?.time ?? lastTime;
      onStatus("live");
    } catch { onStatus("down"); }
    timer = setTimeout(poll, document.visibilityState === "visible" ? every : every * 3);
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
export async function searchStocks(q) {
  q = q.trim();
  if (!q) return [];
  const res = await fetch(`/api/market?src=search&q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  const j = await res.json();
  return (j.quotes || [])
    .filter((x) => (x.quoteType === "EQUITY" || x.quoteType === "ETF" || x.quoteType === "INDEX") && x.symbol && x.symbol.length <= 12
      && (US_EXCHANGES.has(x.exchange) || INTL_EXCHANGES.has(x.exchange) || x.quoteType === "INDEX"))
    .sort((a, b) => (US_EXCHANGES.has(b.exchange) ? 1 : 0) - (US_EXCHANGES.has(a.exchange) ? 1 : 0))
    .slice(0, 8)
    .map((x) => ({ symbol: "S:" + x.symbol, ticker: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchDisp || x.exchange,
      kind: x.quoteType === "ETF" ? "ETF" : x.quoteType === "INDEX" ? "Index" : "Stock", intl: !US_EXCHANGES.has(x.exchange) }));
}
