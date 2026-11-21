// Market movers: what the whole market is trading right now.
//   Stocks: most traded today (by dollar volume), top gainers / losers today (Yahoo Finance screeners),
//           and most traded over the last 30 days (computed from daily candles).
//   Crypto: most traded on Binance.US in the last 24h and last 30 days (from Binance.US volume).
// Refreshes every 60 seconds while the tab is open.
import * as fmt from "./format.js";
import { registerStock } from "./market.js";
import { coinName } from "./coins.js";

const $ = (id) => document.getElementById(id);
let hooks = { onOpen: () => {} };
let mode = "stocks";
let timer = null;
let data = { stocks: null, crypto: null };
const monthCache = { stocks: null, crypto: null };

const usd = (v) => (v == null || !isFinite(v) ? "—" : "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v));
const pct = (v) => (v == null || !isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

export function initMovers(h) {
  hooks = { ...hooks, ...h };
  const root = $("tab-movers");
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.mode) { mode = b.dataset.mode; render(); refresh(); }
    if (b.dataset.open) {
      const d = JSON.parse(b.dataset.open);
      if (d.kind === "stock") registerStock(d.sym, { name: d.name, kind: d.etf ? "ETF" : "Stock" });
      hooks.onOpen(d.sym);
    }
  });
  render();
}

/** Called when the Movers tab is shown or hidden. */
export function moversVisible(visible) {
  clearTimeout(timer);
  if (!visible) return;
  refresh();
}

async function refresh() {
  clearTimeout(timer);
  try {
    if (mode === "stocks") data.stocks = await loadStocks();
    else data.crypto = await loadCrypto();
  } catch (e) { console.warn("movers", e); }
  render();
  if (!$("tab-movers").hidden) timer = setTimeout(refresh, 60_000);
}

/* ---------------- Stocks ---------------- */
async function screener(id) {
  const res = await fetch(`/api/market?src=screener&id=${id}`);
  if (!res.ok) throw new Error("screener " + res.status);
  const j = await res.json();
  return (j?.finance?.result?.[0]?.quotes || []).map((q) => ({
    ticker: q.symbol, name: q.shortName || q.longName || q.symbol, price: q.regularMarketPrice,
    change: q.regularMarketChangePercent, volume: q.regularMarketVolume,
    dollarVol: (q.regularMarketVolume || 0) * (q.regularMarketPrice || 0), etf: q.quoteType === "ETF",
  }));
}

async function loadStocks() {
  const [active, gainers, losers] = await Promise.all([screener("most_actives"), screener("day_gainers"), screener("day_losers")]);
  const today = [...active].sort((a, b) => b.dollarVol - a.dollarVol);
  // Last 30 days: sum of (daily volume × close) for today's most-active stocks plus a few market giants.
  let month = monthCache.stocks;
  if (!month || Date.now() - month.t > 30 * 60_000) {
    const pool = [...new Set([...active.map((x) => x.ticker), "SPY", "QQQ", "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD"])];
    const names = Object.fromEntries(active.map((x) => [x.ticker, x.name]));
    const rows = await Promise.all(pool.map(async (t) => {
      try {
        const r = (await (await fetch(`/api/market?src=chart&symbol=${encodeURIComponent(t)}&interval=1d&range=1mo`)).json())?.chart?.result?.[0];
        const q = r?.indicators?.quote?.[0];
        if (!q) return null;
        let dv = 0, days = 0;
        (r.timestamp || []).forEach((_, i) => { if (q.close[i] != null && q.volume[i] != null) { dv += q.close[i] * q.volume[i]; days++; } });
        const first = q.close.find((v) => v != null), last = r.meta.regularMarketPrice;
        return { ticker: t, name: r.meta.longName || r.meta.shortName || names[t] || t, dollarVol: dv, days, change: first ? ((last - first) / first) * 100 : null, price: last, etf: r.meta.instrumentType === "ETF" };
      } catch { return null; }
    }));
    month = { t: Date.now(), v: rows.filter(Boolean).sort((a, b) => b.dollarVol - a.dollarVol) };
    monthCache.stocks = month;
  }
  return { today, gainers, losers, month: month.v, updated: Date.now() };
}

/* ---------------- Crypto (Binance.US) ---------------- */
// Stablecoins track $1 and aren't "movers".
const STABLE = /^(USDT|USDC|USDCB|BUSD|DAI|FDUSD|TUSD|PYUSD|USDP|USD1|USDE|GUSD|EURC|EURT)$/;

/** Combine a coin's USDT/USD/USDC pairs: add up the money traded, use the busiest pair's price. */
function byCoin(pairs) {
  const groups = new Map();
  for (const p of pairs) {
    const g = groups.get(p.base);
    if (!g) groups.set(p.base, { ...p, pairs: [p] });
    else {
      g.pairs.push(p);
      g.dollarVol += p.dollarVol;
      const top = g.pairs.reduce((a, b) => (b.dollarVol > a.dollarVol ? b : a));
      Object.assign(g, { sym: top.sym, quote: top.quote, price: top.price, change: top.change });
    }
  }
  return [...groups.values()];
}

async function loadCrypto() {
  const all = await (await fetch("https://api.binance.us/api/v3/ticker/24hr")).json();
  const pairs = all
    .filter((t) => /(USDT|USD|USDC)$/.test(t.symbol))
    .map((t) => ({ sym: t.symbol, base: t.symbol.replace(/(USDT|USDC|USD)$/, ""), quote: t.symbol.match(/(USDT|USDC|USD)$/)[1], price: +t.lastPrice, change: +t.priceChangePercent, dollarVol: +t.quoteVolume }))
    .filter((t) => t.dollarVol > 0 && t.base && !STABLE.test(t.base));
  const coins = byCoin(pairs);
  const today = [...coins].sort((a, b) => b.dollarVol - a.dollarVol);
  const gainers = coins.filter((r) => r.dollarVol > 50_000).sort((a, b) => b.change - a.change).slice(0, 10);
  const losers = coins.filter((r) => r.dollarVol > 50_000).sort((a, b) => a.change - b.change).slice(0, 10);
  let month = monthCache.crypto;
  if (!month || Date.now() - month.t > 30 * 60_000) {
    const topPairs = today.slice(0, 15).flatMap((c) => c.pairs);
    const res = await Promise.all(topPairs.map(async (p) => {
      try {
        const k = await (await fetch(`https://api.binance.us/api/v3/klines?symbol=${p.sym}&interval=1d&limit=30`)).json();
        return { ...p, dollarVol: k.reduce((s, x) => s + +x[7], 0), change: k.length ? ((p.price - +k[0][1]) / +k[0][1]) * 100 : null };
      } catch { return null; }
    }));
    month = { t: Date.now(), v: byCoin(res.filter(Boolean)).sort((a, b) => b.dollarVol - a.dollarVol) };
    monthCache.crypto = month;
  }
  return { today, gainers, losers, month: month.v, updated: Date.now() };
}

/* ---------------- Render ---------------- */
function table(rows, kind, n, cols) {
  if (!rows?.length) return `<p class="muted small">No data right now.</p>`;
  return `<div class="table-wrap"><table class="setups movers-table"><thead><tr><th>#</th><th>${kind === "stock" ? "Stock" : "Coin"}</th><th class="num">Price</th><th class="num">${cols.change}</th><th class="num">${cols.vol}</th><th></th></tr></thead><tbody>
    ${rows.slice(0, n).map((r, i) => {
      const sym = kind === "stock" ? "S:" + r.ticker : r.sym;
      const label = kind === "stock" ? r.ticker : r.base;
      const name = kind === "stock" ? r.name : coinName(r.base);
      const open = fmt.esc(JSON.stringify({ sym, kind, name, etf: !!r.etf }));
      return `<tr>
        <td class="muted">${i + 1}</td>
        <td><strong>${fmt.esc(label)}</strong>${r.etf ? ' <span class="kind-tag">ETF</span>' : ""}<div class="sub">${fmt.esc(name)}</div></td>
        <td class="num mono">${kind === "stock" ? "$" : ""}${fmt.price(r.price)}</td>
        <td class="num mono ${r.change >= 0 ? "up" : "down"}">${pct(r.change)}</td>
        <td class="num mono">${usd(r.dollarVol)}</td>
        <td><button class="ghost-btn" data-open='${open}'>Open</button></td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function render() {
  const root = $("tab-movers");
  if (!root) return;
  const d = data[mode];
  const kind = mode === "stocks" ? "stock" : "crypto";
  root.innerHTML = `
    <div class="movers-head">
      <div class="seg" role="tablist"><button data-mode="stocks" class="${mode === "stocks" ? "on" : ""}">US stocks</button><button data-mode="crypto" class="${mode === "crypto" ? "on" : ""}">Crypto (Binance.US)</button></div>
      <span class="muted small">${d ? `<span class="live-dot"></span> Live · updated ${new Date(d.updated).toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit", second: "2-digit" })} · refreshes every minute` : `<span class="typing"><i></i><i></i><i></i></span> Loading…`}</span>
    </div>
    ${d ? `
      <h3>Most traded ${mode === "stocks" ? "today" : "in the last 24 hours"}</h3>
      <p class="muted tiny">Ranked by dollars traded (shares × price), the truest measure of where the money is.${mode === "stocks" ? " Outside market hours this shows the most recent session." : ""}</p>
      ${table(d.today, kind, 10, { change: "Today", vol: "Traded" })}
      <h3>Most traded in the last 30 days</h3>
      <p class="muted tiny">${mode === "stocks" ? "Among today's most active stocks plus the largest US companies and ETFs." : "Among the 20 busiest Binance.US pairs."} "30-day" is the price change over the period.</p>
      ${table(d.month, kind, 10, { change: "30-day", vol: "Traded (30d)" })}
      <div class="movers-split">
        <div><h3>Top gainers today</h3>${table(d.gainers, kind, 5, { change: "Today", vol: "Traded" })}</div>
        <div><h3>Top losers today</h3>${table(d.losers, kind, 5, { change: "Today", vol: "Traded" })}</div>
      </div>
      <p class="muted tiny">Big movers are big for a reason (news, earnings, hype); they also swing the most. Open one to see what Entryvex's measured signals say before you act.</p>` : ""}`;
}
