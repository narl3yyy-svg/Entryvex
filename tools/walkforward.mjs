// Walk-forward test of Entryvex's BUY / SMALL BUY answers on data they never saw.
//
// For each of the bot's 12 markets and each candle size, it steps through the newest part of the
// history one moment at a time. At every moment it runs exactly the analysis the app runs, using only
// the candles up to that moment. When the answer is BUY or SMALL BUY it takes that trade with the
// app's own stop-loss, take-profit and time limit, after fees, one trade at a time per market.
// For comparison it also takes the same kind of trade at random moments ("no signal, same exits").
//
// Writes public/data/walkforward.json, which the Scorecard tab and the answer card show.
// Usage: node tools/walkforward.mjs          (takes a few minutes; public market data only)
import { writeFile, mkdir } from "node:fs/promises";
import { analyze, riskDistance, RULES, exitOnCandle } from "../public/js/engine.js";
import { computeAll } from "../public/js/indicators.js";

const CRYPTO = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];
const STOCKS = ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "MSFT", "AMZN"];
const IVS = { "1h": 3, "4h": 2, "1d": 1 };   // check every Nth candle (1h has the most candles)
const HISTORY = 3000, START = 1500;           // the app analyses up to 3000 candles; test the newest half

async function binance(sym, iv, total) {
  let end = Date.now(), all = [];
  while (all.length < total) {
    const k = await (await fetch(`https://api.binance.us/api/v3/klines?symbol=${sym}&interval=${iv}&limit=1000&endTime=${end}`)).json();
    if (!Array.isArray(k) || !k.length) break;
    all = k.map((x) => ({ time: x[0] / 1000, open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] })).concat(all);
    end = k[0][0] - 1;
    if (k.length < 1000) break;
  }
  return all.slice(-total);
}
async function yahoo(t, interval, range) {
  const j = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=${interval}&range=${range}`, { headers: { "user-agent": "Mozilla/5.0" } })).json();
  const r = j.chart.result[0], q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 })).filter((c) => c.close != null && c.open != null);
}
function group4(c) {   // 4h candles from 1h: four hourly candles of the same day (as the app does)
  const o = []; let cur = null, n = 0, day = null;
  for (const k of c) {
    const d = new Date(k.time * 1000).toISOString().slice(0, 10);
    if (!cur || n === 4 || d !== day) { if (cur) o.push(cur); cur = { ...k }; n = 1; day = d; }
    else { cur.high = Math.max(cur.high, k.high); cur.low = Math.min(cur.low, k.low); cur.close = k.close; cur.volume += k.volume; n++; }
  }
  if (cur) o.push(cur);
  return o;
}

function trade(c, x, t, cost) {
  const e = t + 1, entry = c[e].open, d = riskDistance(x.atr14[t], entry, cost);
  const stop = entry - d, target = entry + (RULES.targetAtr / RULES.stopAtr) * d;
  let exit = c[e + RULES.maxBars - 1].close, j = e + RULES.maxBars - 1;
  for (let k = e; k < e + RULES.maxBars; k++) { const z = exitOnCandle(c[k], stop, target); if (z) { exit = z.exit; j = k; break; } }
  return { net: (exit - entry) / entry - 2 * cost, end: j };
}

const blank = () => ({ n: 0, sum: 0, sum2: 0, wins: 0 });
const add = (a, net) => { a.n++; a.sum += net; a.sum2 += net * net; if (net > 0) a.wins++; };
const fin = (a) => {
  if (!a.n) return { n: 0 };
  const avg = a.sum / a.n, sd = Math.sqrt(Math.max(0, a.sum2 / a.n - avg * avg));
  return { n: a.n, avg: +avg.toFixed(5), win: +(a.wins / a.n).toFixed(3), se: +(sd / Math.sqrt(a.n)).toFixed(5) };
};

const data = {};
for (const s of CRYPTO) for (const iv of Object.keys(IVS)) data[`${s}|${iv}`] = await binance(s, iv, HISTORY);
for (const s of STOCKS) {
  const h = await yahoo(s, "60m", "730d");
  data[`S:${s}|1h`] = h.slice(-HISTORY); data[`S:${s}|4h`] = group4(h).slice(-HISTORY);
  data[`S:${s}|1d`] = (await yahoo(s, "1d", "10y")).slice(-HISTORY);
}

const out = {};
let from = Infinity, to = 0;
for (const [key, c] of Object.entries(data)) {
  const iv = key.split("|")[1], every = IVS[iv];
  const cost = key.startsWith("S:") ? 0.0002 : 0.0005;
  if (c.length < START + RULES.maxBars + 10) continue;
  const x = computeAll(c);
  const g = (out[iv] ??= { buy: blank(), smallBuy: blank(), model: blank(), setups: blank(), random: blank(), markets: 0 });
  g.markets++;
  let busy = -1, busyR = -1, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = START; t + RULES.maxBars + 1 < c.length; t++) {
    // Random-timing comparison: same exits, entered at random moments (about as often as signals).
    if (t > busyR && rnd() < 0.08) { const r = trade(c, x, t, cost); add(g.random, r.net); busyR = r.end; }
    if (t <= busy || (t - START) % every) continue;
    const r = analyze(c.slice(0, t + 2), { costPerSide: cost, formingLast: true });   // candle t+1 is still forming
    const lvl = r.overall.level;
    if (lvl !== "go" && lvl !== "caution") continue;
    const tr = trade(c, x, t, cost);
    busy = tr.end;
    add(lvl === "go" ? g.buy : g.smallBuy, tr.net);
    add(r.best?.model ? g.model : g.setups, tr.net);
    from = Math.min(from, c[t].time); to = Math.max(to, c[t].time);
  }
  console.error(key, "done");
}
const result = {
  generated: new Date().toISOString().slice(0, 10),
  markets: [...CRYPTO, ...STOCKS.map((s) => "S:" + s)],
  period: { from: new Date(from * 1000).toISOString().slice(0, 10), to: new Date(to * 1000).toISOString().slice(0, 10) },
  rules: { stopAtr: RULES.stopAtr, targetAtr: RULES.targetAtr, maxBars: RULES.maxBars },
  byIv: Object.fromEntries(Object.entries(out).map(([iv, g]) => [iv, { markets: g.markets, buy: fin(g.buy), smallBuy: fin(g.smallBuy), model: fin(g.model), setups: fin(g.setups), random: fin(g.random) }])),
};
await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(new URL("../public/data/walkforward.json", import.meta.url), JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify(result, null, 1));
