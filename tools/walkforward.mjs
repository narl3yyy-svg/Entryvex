// Walk-forward test of Entryvex's BUY answers on data they never saw.
//
// Entryvex says BUY only with its trend rule on daily candles (see TREND in public/js/engine.js):
// uptrend (price above its 200-day average, 50-day above the 200-day) and a daily close above the
// previous 20-day high; buy at the next open; first stop 2 ATR under the entry, then a trailing stop
// 3 ATR under the highest price since buying; no fixed target; fees both ways. The rule's numbers are
// textbook values fixed before testing, so nothing is fitted: every trade in the test period is "unseen".
//
// For each of the 40 Trend-radar markets it replays the newest half of up to 3000 daily candles exactly as the
// app would (only candles up to each moment), and compares with:
//   • random timing: the same trade (same stops) entered at random moments, 20 random runs;
//   • random timing in an uptrend: same, but only when the trend filter is on (shows what the breakout adds);
//   • just holding the market over the same period (return and worst drop).
// The previous version's results (short-term setups on 1h/4h/daily, before the rebuild) are kept under
// "before", so the Scorecard can show why the rebuild happened.
//
// Writes public/data/walkforward.json, which the Scorecard tab and the answer card show.
// Usage: node tools/walkforward.mjs          (about a minute; public market data only)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { TREND_SETUP, trendTrade, checkLiquidity, RULES } from "../public/js/engine.js";
import { computeAll } from "../public/js/indicators.js";

// The 40 markets of the Trend radar (opportunities.js): big coins, US stocks and ETFs (incl. gold, bonds, energy).
const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "LTCUSDT", "DOTUSDT", "BCHUSDT"];
const STOCKS = ["SPY", "QQQ", "IWM", "DIA", "GLD", "SLV", "TLT", "XLE", "XLF", "XLK", "AAPL", "MSFT", "NVDA", "AMZN",
  "GOOGL", "META", "TSLA", "AVGO", "AMD", "NFLX", "JPM", "V", "LLY", "XOM", "COST", "WMT", "ORCL", "PLTR", "KO"];
const HISTORY = 3000, START = 1500;
const OUT = new URL("../public/data/walkforward.json", import.meta.url);

async function binance(sym, total) {
  let end = Date.now(), all = [];
  while (all.length < total) {
    const k = await (await fetch(`https://api.binance.us/api/v3/klines?symbol=${sym}&interval=1d&limit=1000&endTime=${end}`)).json();
    if (!Array.isArray(k) || !k.length) break;
    all = k.map((x) => ({ time: x[0] / 1000, open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] })).concat(all);
    end = k[0][0] - 1;
    if (k.length < 1000) break;
  }
  return all.slice(-total);
}
async function yahoo(t) {
  const j = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=12y`, { headers: { "user-agent": "Mozilla/5.0" } })).json();
  const r = j.chart.result[0], q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 }))
    .filter((c) => c.close != null && c.open != null).slice(-HISTORY);
}

const blank = () => ({ n: 0, sum: 0, sum2: 0, wins: 0, bars: 0 });
const add = (a, net, bars) => { a.n++; a.sum += net; a.sum2 += net * net; a.bars += bars; if (net > 0) a.wins++; };
const fin = (a) => {
  if (!a.n) return { n: 0 };
  const avg = a.sum / a.n, sd = Math.sqrt(Math.max(0, a.sum2 / a.n - avg * avg));
  return { n: a.n, avg: +avg.toFixed(5), win: +(a.wins / a.n).toFixed(3), se: +(sd / Math.sqrt(a.n)).toFixed(5), days: +(a.bars / a.n).toFixed(1) };
};
const up = (c, x, i) => c[i].close > x.ema200[i] && x.ema50[i] > x.ema200[i];

/** Replay entries chosen by `pick(i)` one at a time; returns trades and a compounding equity curve. */
function replay(c, x, cost, pick) {
  const trades = [];
  let eq = 1, peak = 1, dd = 0, inMarket = 0;
  for (let i = START; i < c.length - 2; i++) {
    if (!pick(i) || !isFinite(x.atr14[i])) continue;
    const r = trendTrade(c, x, i, c.length - 1, cost);
    const end = r ? r.end : c.length - 1;
    const exit = r ? r.exit : c.at(-1).close, entry = r ? r.entry : c[i + 1].open;
    for (let j = i + 1; j <= end; j++) { const m = eq * (Math.min(c[j].low, c[j].close) / entry); dd = Math.max(dd, 1 - m / peak); }
    const net = (exit - entry) / entry - 2 * cost;
    eq *= 1 + net; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
    inMarket += end - i;
    trades.push({ net, bars: end - i, open: !r });
    i = end;
  }
  return { trades, eq, dd, expo: inMarket / (c.length - 2 - START) };
}

const data = {};
for (const s of CRYPTO) data[s] = await binance(s, HISTORY);
for (const s of STOCKS) data["S:" + s] = await yahoo(s);

const agg = { buy: blank(), random: blank(), randomUp: blank() };
const perMarket = [];
let from = Infinity, to = 0, beatRandom = 0, beatRandomUp = 0, counted = 0;
for (const [sym, c] of Object.entries(data)) {
  if (c.length < START + 100) { console.error(sym, "too little history"); continue; }
  const cost = sym.startsWith("S:") ? 0.0002 : 0.0005;
  const x = computeAll(c);
  // What the app says at each moment: the trend rule fires on the last CLOSED candle, in a liquid market.
  const buy = replay(c, x, cost, (i) => TREND_SETUP.test(i, c, x) && checkLiquidity(c, i).ok);
  const closed = buy.trades.filter((t) => !t.open);
  for (const t of closed) add(agg.buy, t.net, t.bars);
  // Random timing with the same exits (20 runs), anywhere and only in uptrends.
  const rnd = (filter) => {
    const a = blank();
    for (let seed0 = 1; seed0 <= 20; seed0++) {
      let seed = seed0 * 7919;
      const R = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (const t of replay(c, x, cost, (i) => filter(i) && R() < 0.08).trades) if (!t.open) add(a, t.net, t.bars);
    }
    return a;
  };
  const r1 = rnd(() => true), r2 = rnd((i) => up(c, x, i));
  for (const k of ["n", "sum", "sum2", "wins", "bars"]) { agg.random[k] += r1[k] / 20; agg.randomUp[k] += r2[k] / 20; }
  const avg = closed.length ? closed.reduce((s, t) => s + t.net, 0) / closed.length : NaN;
  if (closed.length) { counted++; if (avg > r1.sum / r1.n) beatRandom++; if (avg > r2.sum / r2.n) beatRandomUp++; }
  const years = (c.at(-1).time - c[START].time) / 31557600;
  let peak = 0, bhDd = 0;
  for (let i = START; i < c.length; i++) { peak = Math.max(peak, c[i].close); bhDd = Math.max(bhDd, 1 - c[i].close / peak); }
  const cagr = (v) => +((v ** (1 / years) - 1)).toFixed(4);
  perMarket.push({ sym, trades: buy.trades.length, avg: +avg.toFixed(5), cagr: cagr(buy.eq), dd: +buy.dd.toFixed(3), inMarket: +buy.expo.toFixed(3),
    holdCagr: cagr(c.at(-1).close / c[START].close), holdDd: +bhDd.toFixed(3) });
  from = Math.min(from, c[START].time); to = Math.max(to, c.at(-1).time);
  console.error(sym, "done", buy.trades.length, "trades");
}
const med = (k) => { const v = perMarket.map((m) => m[k]).filter(isFinite).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

let before = null;
try { const old = JSON.parse(await readFile(OUT, "utf8")); before = old.before || (old.byIv ? { generated: old.generated, period: old.period, byIv: old.byIv } : null); } catch {}

const result = {
  generated: new Date().toISOString().slice(0, 10),
  markets: Object.keys(data),
  period: { from: new Date(from * 1000).toISOString().slice(0, 10), to: new Date(to * 1000).toISOString().slice(0, 10) },
  rule: { name: TREND_SETUP.name, interval: "1d", stopAtr: 2, trailAtr: 3, warmup: RULES.warmup },
  trend: {
    buy: fin(agg.buy), random: fin(agg.random), randomUp: fin(agg.randomUp),
    markets: counted, beatRandom, beatRandomUp,
    median: { cagr: med("cagr"), holdCagr: med("holdCagr"), dd: med("dd"), holdDd: med("holdDd"), inMarket: med("inMarket") },
    perMarket,
  },
  before,
};
await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(OUT, JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify({ ...result, before: before ? "(kept)" : null, trend: { ...result.trend, perMarket: undefined } }, null, 1));
