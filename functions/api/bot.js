// Entryvex paper-trading bot (v3): trades a VIRTUAL $100 across 12 markets (crypto + US stocks/ETFs)
// on the server's 5-minute cron. No real money, no exchange keys: every trade is simulated with fees.
//
// It follows ONE rule, the one that held up on data it never saw (tools/walkforward.mjs):
//   • BUY when a daily candle closes at a new 20-day high while the market is in an uptrend
//     (price above its 200-day average, 50-day average above the 200-day);
//   • SELL with a trailing stop: 2 ATR under the entry at first, then 3 ATR under the highest price
//     since it bought, moved up after every daily close and never down. No fixed target.
// Risk control: it risks 1% of the account per trade at the stop, at most 6 trades at once, each at
// most 25% of the account. Stocks: no buys within 3 trading days of an earnings report, and it sells
// before one (prices often jump straight past a stop-loss on the news).
// v2 (many short-term setups on 1h/4h/daily) is kept in `archive`: on unseen data those setups didn't
// beat fees or random timing, which is why the bot was rebuilt.
import { candles } from "./push.js";
import { TREND, TREND_SETUP, regimeAt, trendStop, trailStop, exitOnCandle } from "../../public/js/engine.js";
import { computeAll } from "../../public/js/indicators.js";

const KEY = "bot:state";
const START_USD = 100;
export const MARKETS = [
  { sym: "BTCUSDT", name: "Bitcoin", news: "nlog:BTC" }, { sym: "ETHUSDT", name: "Ethereum", news: "nlog:ETH" },
  { sym: "SOLUSDT", name: "Solana", news: "nlog:SOL" }, { sym: "XRPUSDT", name: "XRP", news: "nlog:XRP" },
  { sym: "DOGEUSDT", name: "Dogecoin", news: "nlog:DOGE" },
  { sym: "S:SPY", name: "S&P 500 (SPY)", news: "nlog:S:SPY", stock: true }, { sym: "S:QQQ", name: "Nasdaq 100 (QQQ)", news: "nlog:S:QQQ", stock: true },
  { sym: "S:AAPL", name: "Apple", news: "nlog:S:AAPL", stock: true, earnings: "AAPL" }, { sym: "S:NVDA", name: "NVIDIA", news: "nlog:S:NVDA", stock: true, earnings: "NVDA" },
  { sym: "S:TSLA", name: "Tesla", news: "nlog:S:TSLA", stock: true, earnings: "TSLA" }, { sym: "S:MSFT", name: "Microsoft", news: "nlog:S:MSFT", stock: true, earnings: "MSFT" },
  { sym: "S:AMZN", name: "Amazon", news: "nlog:S:AMZN", stock: true, earnings: "AMZN" },
];
export const BOT = {
  version: 3,
  fee: { crypto: 0.0005, stock: 0.0002 },   // per side: Binance.US fee + slippage / stock spread ($0 commission)
  risk: 0.01,                                // share of the account lost if the first stop is hit
  maxPositions: 6, maxPositionShare: 0.25,   // at most 6 trades at once, each ≤25% of the account
  ivs: ["1d"],
  checksPerTick: 6,                          // daily-candle checks per 5-minute tick
  stopAtr: TREND.stopAtr, trailAtr: TREND.trailAtr,
  earningsDays: 3, minNotional: 10,
};
const IV_MS = { "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
const IV_WORD = { "1h": "1-hour", "4h": "4-hour", "1d": "daily" };
// Stocks: Yahoo's candles follow the trading session, so they're re-checked on a timer during market hours.
const STOCK_RECHECK = { "1h": 30 * 60e3, "4h": 2 * 3600e3, "1d": 2 * 3600e3 };
const bySym = Object.fromEntries(MARKETS.map((m) => [m.sym, m]));
const feeOf = (sym) => (bySym[sym]?.stock ? BOT.fee.stock : BOT.fee.crypto);
const pct = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;
const usd = (x) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;
const px = (v) => (v >= 1000 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(4));

/** US stock market open right now? (weekdays 9:30–16:00 New York; holidays show up as stale candles) */
function usMarketOpen(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const m = +p.hour * 60 + +p.minute;
  return m >= 9 * 60 + 30 && m < 16 * 60;
}
const memKey = (...parts) => parts.join("|");
// Per-market record, for display only. The bot doesn't bench a market after a few losses: trend trades
// lose more often than they win, and a handful of results on one market is mostly luck.
function memStatus(m) { return !m || m.n < 5 ? "new" : "ok"; }
function tally(s, key, init, ret, pnl) {
  const m = s.memory[key] || { ...init, n: 0, wins: 0, sum: 0 };
  m.n++; if (pnl > 0) m.wins++; m.sum += ret;
  s.memory[key] = m;
  return m;
}

function fresh(now) {
  return { v: 3, startedAt: now, cash: START_USD, positions: [], trades: [], equity: [], startPrices: {}, lastPrice: {},
    memory: {}, lastSeen: {}, nextCheck: {}, events: [], earnings: { at: 0, dates: {} }, lastTick: now, archive: [] };
}

/** The 5-minute tick. */
export async function cronBot(env, now = Date.now()) {
  if (!env?.PUSH) return;
  let s = await env.PUSH.get(KEY, "json");
  let changed = false, soft = false;   // soft = only bookkeeping (which candles were checked): saved at most every 30 min
  if (!s || s.v !== 3) {
    const old = s;
    s = fresh(now);
    if (old) {
      const oldEq = old.v === 2 ? old.cash + (old.positions || []).reduce((x, p) => x + p.qty * (old.lastPrice?.[p.sym] || p.entry), 0) : null;
      s.archive = [...(old.archive || []), ...(old.trades || [])].slice(-300);
      s.previous = { version: old.v, startedAt: old.startedAt, trades: old.trades?.length || 0, equity: oldEq != null ? +oldEq.toFixed(2) : null };
    }
    note(s, now, "info", "The bot was rebuilt around the tested trend rule",
      "It now buys only when a daily candle closes at a new 20-day high in an uptrend, and sells with a trailing stop. The old short-term setups didn't beat fees or random timing on data they never saw. It restarted with a virtual $100; the old trades are kept for reference.");
    changed = true;
  }
  const stocksOpen = usMarketOpen(now);

  // 0) Earnings calendar for the stocks it trades (refreshed daily).
  if (now - (s.earnings.at || 0) > 20 * 3600e3) { await refreshEarnings(s, now).catch(() => {}); changed = true; }

  // 1) Watch open trades between daily closes: the (trailing) stop, and selling before an earnings report.
  for (const p of s.positions.slice()) {
    const m = bySym[p.sym];
    if (m?.stock && !stocksOpen) continue;   // can't sell while the market is closed
    let recent;
    try { recent = await candles(p.sym, "5m", 36); } catch { continue; }
    if (!recent?.length) continue;
    const price = recent.at(-1).close;
    s.lastPrice[p.sym] = price; p.last = price;
    let exit = null, outcome = null;
    for (const k of recent) {
      if (k.time * 1000 < p.checkedTo) continue;
      const r = exitOnCandle(k, p.stop, Infinity);
      if (r) { exit = r.exit; outcome = r.outcome; break; }
    }
    if (!exit && now >= p.sellBy) { exit = price; outcome = "timeout"; }
    if (!exit && m?.earnings && earningsWithin(s, m.earnings, now, 1)) { exit = price; outcome = "earnings"; }
    if (exit) { closeTrade(s, p, exit, outcome, now); changed = true; }
    else p.checkedTo = recent.at(-1).time * 1000;
  }

  // 2) After each daily close: move up the trailing stops, then look for new trend breakouts.
  const due = [];
  for (const m of MARKETS) {
    const k = `${m.sym}|1d`;
    if (m.stock && !stocksOpen) continue;
    if ((s.nextCheck[k] || 0) <= now) due.push({ m, k });
  }
  due.sort((a, b) => (s.nextCheck[a.k] || 0) - (s.nextCheck[b.k] || 0));
  const candidates = [];
  for (const { m, k } of due.slice(0, BOT.checksPerTick)) {
    // Next check: just after the next daily close (crypto), or every 2 hours in market hours (stocks).
    s.nextCheck[k] = m.stock ? now + STOCK_RECHECK["1d"] : (Math.floor(now / IV_MS["1d"]) + 1) * IV_MS["1d"] + 60e3;
    changed = true;   // must be saved: otherwise the same candle could be judged again later (a stale signal)
    let c;
    try { c = await candles(m.sym, "1d", 320); } catch { continue; }
    if (!c?.length || c.length < 220) continue;
    s.lastPrice[m.sym] = c.at(-1).close;
    if (!s.startPrices[m.sym]) s.startPrices[m.sym] = c.at(-1).close;
    const i = c.length - 2;                      // last CLOSED daily candle
    if (s.lastSeen[k] === c[i].time) continue;   // already judged this candle
    s.lastSeen[k] = c[i].time;
    const x = computeAll(c);
    const pos = s.positions.find((p) => p.sym === m.sym);
    if (pos) {
      if (c[i].time * 1000 >= pos.openedAt - IV_MS["1d"]) {
        pos.hi = Math.max(pos.hi || pos.entry, c[i].high);
        const before = pos.stop;
        pos.stop = trailStop(pos.stop, pos.hi, x.atr14[i]);
        if (pos.stop > before * 1.0001) pos.trailMoves = (pos.trailMoves || 0) + 1;
      }
      continue;
    }
    let on = false;
    try { on = !!TREND_SETUP.test(i, c, x) && isFinite(x.atr14[i]); } catch {}
    if (on) candidates.push(judge(s, m, regimeAt(c, x, i), x.atr14[i], c.at(-1).close, c[i].close / x.ema200[i], now));
  }
  for (const cand of candidates.filter((x) => x.go).sort((a, b) => b.score - a.score)) {
    if (s.positions.length >= BOT.maxPositions || s.positions.some((p) => p.sym === cand.m.sym)) continue;
    if (openTrade(s, cand, now)) changed = true;
  }
  for (const cand of candidates.filter((x) => !x.go && x.skipNote)) { note(s, now, "skip", cand.skipNote[0], cand.skipNote[1], cand.m.sym); soft = true; }

  // 3) Hourly snapshot of the account and of "just holding all 12 equally" (for the chart).
  const hour = Math.floor(now / 3600e3);
  if (Math.floor((s.equity.at(-1)?.[0] || 0) / 3600e3) !== hour && Object.keys(s.startPrices).length) {
    s.equity.push([now, +equityOf(s).toFixed(4), +basketOf(s).toFixed(4)]);
    if (s.equity.length > 3000) s.equity = s.equity.slice(-3000);
    changed = true;
  }
  s.lastTick = now;
  if (changed || (soft && now - (s.lastSave || 0) >= 30 * 60e3)) { s.lastSave = now; await env.PUSH.put(KEY, JSON.stringify(s)); }
}

/** A trend breakout just happened: anything that says "not now"? */
function judge(s, m, regime, atr, price, strength, now) {
  const where = `${m.name} (daily trend breakout)`;
  if (m.earnings && earningsWithin(s, m.earnings, now, BOT.earningsDays)) return { m, skipNote: [`Skipped ${where}`, `${m.name} reports earnings within ${BOT.earningsDays} trading days. Prices often jump past a stop-loss on the news.`] };
  return { go: true, m, regime, atr, price, score: strength };   // strongest uptrend first when slots are short
}

const equityOf = (s) => s.cash + s.positions.reduce((a, p) => a + p.qty * (s.lastPrice[p.sym] || p.entry), 0);
/** What $100 split equally across the markets (at the bot's start) would be worth now. */
function basketOf(s) {
  const syms = Object.keys(s.startPrices).filter((k) => s.lastPrice[k]);
  if (!syms.length) return START_USD;
  return START_USD * syms.reduce((a, k) => a + s.lastPrice[k] / s.startPrices[k], 0) / syms.length;
}

function openTrade(s, c, now) {
  const fee = feeOf(c.m.sym), entry = c.price;
  const stop = trendStop(entry, c.atr, fee);
  if (!(stop > 0 && stop < entry)) return false;
  const eq = equityOf(s);
  const lossPerUnit = entry - stop + fee * (entry + stop);
  let qty = (eq * BOT.risk) / lossPerUnit;
  qty = Math.min(qty, (eq * BOT.maxPositionShare) / entry, (s.cash * 0.995) / (entry * (1 + fee)));
  if (c.m.stock) qty = Math.floor(qty * 1000) / 1000;   // fractional shares (most US brokers allow them)
  if (!(qty * entry >= BOT.minNotional)) return false;
  const cost = qty * entry * (1 + fee);
  s.cash -= cost;
  const reasons = [
    `A daily candle closed at a new 20-day high while ${c.m.name} is in an uptrend (price ${pct(c.score - 1)} above its 200-day average).`,
    "This is Entryvex's trend rule, which made money after fees on data it never saw.",
    c.m.earnings ? "No earnings report in the next few days." : "",
  ].filter(Boolean).join(" ");
  const p = { id: `${now}-${c.m.sym}`, sym: c.m.sym, market: c.m.name, setup: TREND_SETUP.id, name: TREND_SETUP.name, iv: "1d", regime: c.regime, mode: "trend",
    entry, stop, firstStop: stop, target: null, trail: true, hi: entry, atr: c.atr, qty, cost, openedAt: now,
    sellBy: now + TREND.maxBars * IV_MS["1d"], checkedTo: now, last: entry, why: reasons };
  s.positions.push(p);
  note(s, now, "open", `Bot bought ${c.m.name} at ${px(entry)} (daily trend breakout)`,
    `${reasons} Risking 1% of the account. First stop ${px(stop)}; after every daily close it moves the stop up to ${TREND.trailAtr} ATR under the highest price since buying.`, c.m.sym);
  return true;
}

function closeTrade(s, p, exit, outcome, now) {
  const fee = feeOf(p.sym);
  const proceeds = p.qty * exit * (1 - fee);
  s.cash += proceeds;
  s.positions = s.positions.filter((x) => x !== p);
  const pnl = proceeds - p.cost, ret = pnl / p.cost;
  const held = Math.max(1, Math.round((now - p.openedAt) / IV_MS["1d"]));
  const market = p.regime === "down" ? "a falling market" : p.regime === "up" ? "a rising market" : "an unclear market";
  const what = `${p.name} on ${p.market} (${IV_WORD[p.iv]})`;
  const days = `${held} day${held === 1 ? "" : "s"}`;
  let lesson = outcome === "stop" && ret > 0 ? `Trend ride: the trailing stop sold ${p.market} after ${days} and locked in a gain (the stop had been moved up ${p.trailMoves || 0} time${p.trailMoves === 1 ? "" : "s"}).`
    : outcome === "stop" ? `Stopped out: ${what} fell back to its stop after ${days}. Trend trades lose more often than they win; the rule relies on the winners being bigger.`
    : outcome === "earnings" ? `Sold before earnings: ${what} (${ret >= 0 ? "gain" : "loss"}), so a report surprise couldn't jump past the stop.`
    : `Time limit: ${what} was still open after ${TREND.maxBars} days, so it sold at the market price.`;
  const m = tally(s, memKey(p.sym), { market: p.market, name: p.name, iv: p.iv }, ret, pnl);
  if (m.n >= 3) lesson += ` On ${p.market} so far: ${m.wins} of ${m.n} trend trades won, average ${pct(m.sum / m.n)}.`;
  s.trades.push({ ...p, exit, outcome, closedAt: now, pnl: +pnl.toFixed(4), ret: +ret.toFixed(5), lesson });
  if (s.trades.length > 1000) s.trades = s.trades.slice(-1000);
  note(s, now, "close", `Bot sold ${p.market} at ${px(exit)}: ${usd(pnl)} (${pct(ret)})`, lesson, p.sym);
}

/** Nasdaq earnings calendar for the next 7 days (only the stocks the bot trades). */
async function refreshEarnings(s, now) {
  const want = new Set(MARKETS.filter((m) => m.earnings).map((m) => m.earnings));
  const dates = {};
  for (let k = 0; k < 8; k++) {
    const d = new Date(now + k * 86400e3);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const ds = d.toISOString().slice(0, 10);
    try {
      const r = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${ds}`, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", accept: "application/json" } });
      const j = await r.json();
      for (const row of j?.data?.rows || []) if (want.has(row.symbol)) dates[row.symbol] = ds;
    } catch {}
  }
  s.earnings = { at: now, dates };
}
function earningsWithin(s, ticker, now, tradingDays) {
  const ds = s.earnings?.dates?.[ticker];
  if (!ds) return false;
  let n = 0;
  for (let t = now; n <= tradingDays; t += 86400e3) {
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    if (d.toISOString().slice(0, 10) === ds) return true;
    n++;
  }
  return false;
}

function note(s, t, kind, title, body, sym = null) {
  s.events.push({ t, kind, title, body, sym });
  if (s.events.length > 80) s.events = s.events.slice(-80);
}

/** Performance summary, including whether it has really proven anything. */
export function summarize(s) {
  const eq = equityOf(s), basket = basketOf(s);
  const closed = s.trades, n = closed.length, wins = closed.filter((t) => t.pnl > 0).length;
  const rets = closed.map((t) => t.ret);
  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  let peak = START_USD, dd = 0;
  for (const [, e] of s.equity) { peak = Math.max(peak, e); dd = Math.min(dd, e / peak - 1); }
  const ret = eq / START_USD - 1, hold = basket / START_USD - 1;
  const proven = n >= 30 && ret > 0 && ret > hold && t >= 2;
  return {
    equity: +eq.toFixed(2), returnPct: ret, holdPct: hold, trades: n, wins, winRate: n ? wins / n : null, avgPerTrade: n ? mean : null, t,
    maxDrawdown: dd, days: (Date.now() - s.startedAt) / 86400e3, open: s.positions.length,
    status: proven ? "proven" : n < 30 ? "learning" : "not-proven",
    statusText: proven ? "Proven: profitable after fees over 30+ trades, ahead of just holding these markets, and unlikely to be luck."
      : n < 30 ? `Learning: ${n} of the 30 trades needed before its record means anything.`
      : "Not proven: after 30+ trades it isn't clearly beating fees and just holding these markets.",
  };
}

/** GET /api/bot — the bot's public record (read-only). */
export async function onRequestGet(context) {
  const { env } = context;
  const s = env?.PUSH ? await env.PUSH.get(KEY, "json") : null;
  if (!s || s.v !== 3) return json({ started: false, note: "The bot starts on the next 5-minute check." }, 60);
  const memory = Object.entries(s.memory).map(([k, m]) => ({ key: k, ...m, avg: m.n ? m.sum / m.n : 0, status: memStatus(m) })).sort((a, b) => b.n - a.n);
  const perMarket = MARKETS.map((m) => {
    const t = s.trades.filter((x) => x.sym === m.sym);
    return { sym: m.sym, name: m.name, trades: t.length, wins: t.filter((x) => x.pnl > 0).length, pnl: +t.reduce((a, x) => a + x.pnl, 0).toFixed(2), open: s.positions.some((p) => p.sym === m.sym) };
  });
  return json({
    started: true, version: 3, previous: s.previous || null, startUsd: START_USD, startedAt: s.startedAt, lastTick: s.lastTick, markets: MARKETS.map((m) => ({ sym: m.sym, name: m.name })),
    settings: BOT, summary: summarize(s), positions: s.positions, trades: s.trades.slice(-200).reverse(), equity: s.equity,
    memory, perMarket, events: s.events.slice(-40).reverse(), earnings: s.earnings?.dates || {}, archiveCount: s.archive?.length || 0,
  }, 60);
}

/** Recent bot trades (for "Follow the bot" notifications in the alert cron). */
export async function botEventsSince(env, since) {
  const s = env?.PUSH ? await env.PUSH.get(KEY, "json") : null;
  return (s?.events || []).filter((e) => e.t > since && (e.kind === "open" || e.kind === "close"));
}

function json(obj, maxAge = 0) {
  return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" } });
}
