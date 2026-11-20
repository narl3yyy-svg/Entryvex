// Binance.US public market data, read straight from the browser.
// Read-only: no API keys, no account access, no trading.

const REST = "https://api.binance.us/api/v3";
const WS = "wss://stream.binance.us:9443/stream?streams=";

async function getJSON(path) {
  const res = await fetch(REST + path);
  if (!res.ok) throw new Error(`Binance.US ${res.status} on ${path}`);
  return res.json();
}

/** All trading spot pairs: [{symbol, base, quote}] (cached for the session). */
export async function getSymbols() {
  try {
    const cached = JSON.parse(sessionStorage.getItem("evx.symbols") || "null");
    if (cached && Date.now() - cached.t < 3600_000) return cached.v;
  } catch {}
  const info = await getJSON("/exchangeInfo");
  const v = info.symbols
    .filter((s) => s.status === "TRADING")
    .map((s) => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset }));
  try { sessionStorage.setItem("evx.symbols", JSON.stringify({ t: Date.now(), v })); } catch {}
  return v;
}

/** 24h stats for a list of symbols. */
export async function get24h(symbols) {
  if (!symbols.length) return [];
  const q = encodeURIComponent(JSON.stringify(symbols));
  const raw = await getJSON(`/ticker/24hr?symbols=${q}`);
  return raw.map((t) => ({
    symbol: t.symbol,
    last: +t.lastPrice,
    open: +t.openPrice,
    changePct: +t.priceChangePercent,
    high: +t.highPrice,
    low: +t.lowPrice,
    quoteVolume: +t.quoteVolume,
  }));
}

/** Candle history. */
export async function getKlines(symbol, interval, limit = 500) {
  const raw = await getJSON(`/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return raw.map(parseKlineArray);
}

function parseKlineArray(k) {
  return { time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
}

/**
 * A self-healing WebSocket for one or more Binance streams.
 * onMessage(streamName, data); onStatus("live" | "connecting" | "down").
 */
export class Stream {
  constructor(streams, { onMessage, onStatus }) {
    this.streams = streams;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.retry = 0;
    this.closed = false;
    this.lastMsg = 0;
    this.open();
    // Watchdog: if no data for 30s, reconnect.
    this.dog = setInterval(() => {
      if (this.ws && this.ws.readyState === 1 && Date.now() - this.lastMsg > 30_000) this.ws.close();
    }, 10_000);
  }

  open() {
    if (this.closed || !this.streams.length) return;
    this.onStatus("connecting");
    const ws = new WebSocket(WS + this.streams.join("/"));
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.lastMsg = Date.now(); this.onStatus("live"); };
    ws.onmessage = (e) => {
      this.lastMsg = Date.now();
      try {
        const msg = JSON.parse(e.data);
        if (msg.stream) this.onMessage(msg.stream, msg.data);
      } catch {}
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.onStatus("down");
      const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.open(), wait);
    };
    ws.onerror = () => ws.close();
  }

  close() {
    this.closed = true;
    clearInterval(this.dog);
    if (this.ws) this.ws.close();
  }
}

export function klineFromStream(d) {
  const k = d.k;
  return { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, closed: k.x };
}
