// Entryvex paper-trading bot (v2): trades a VIRTUAL $100 across 12 markets (crypto + US stocks/ETFs)
// on the server's 5-minute cron. No real money, no exchange keys: every trade is simulated with
// fees, a stop-loss, a target and a time limit, like the plans Entryvex shows people.
//
// Before every buy it weighs:
//   • the chart: Entryvex's setups and candle patterns on 1h, 4h and daily candles, and whether
//     the market is rising or falling;
//   • the record: a daily re-test of each setup on that market (trusted / unproven / losing);
//   • the news: the latest AI read of that market's headlines (Entryvex records one every ~2 hours);
//   • earnings (stocks): it won't buy within 3 trading days of a report, and sells before one,
//     because prices often jump straight past a stop-loss on the news;
//   • its own memory of what has worked.
// It learns from every closed trade (kept permanently):
//   • per market × setup × candle size × market type: a combination that keeps losing is BENCHED,
//     an unproven one that keeps winning is PROMOTED;
//   • per news mood: if buying on negative news keeps losing, it stops doing that;
//   • per market type: if its exploring trades keep losing there, it stops exploring there.
// Efficient: candles are only downloaded when one has closed (a few markets per tick), and its
// memory is saved only when something changed, which stays inside free-tier limits.
import { candles } from "./push.js";
import { SETUPS, RULES, regimeAt, riskDistance, exitOnCandle, analyze } from "../../public/js/engine.js";
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
  fee: { crypto: 0.0005, stock: 0.0002 },   // per side: Binance.US fee + slippage / stock spread ($0 commission)
  riskTrusted: 0.015, riskExplore: 0.004,   // share of the account lost if the stop is hit
  maxPositions: 4, maxPositionShare: 0.3,    // at most 4 trades at once, each ≤30% of the account
  ivs: ["1h", "4h", "1d"],
  checksPerTick: 12,                         // candle checks per 5-minute tick (all due checks in one go = one save)
  benchAfter: 5, promoteAfter: 8, exploreStopAfter: 12, newsStopAfter: 6,
  earningsDays: 3, minNotional: 10,
};
const IV_MS = { "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
const IV_WORD = { "1h": "1-hour", "4h": "4-hour", "1d": "daily" };
// Stocks: Yahoo's candles follow the trading session, so they're re-checked on a timer during market hours.
const STOCK_RECHECK = { "1h": 30 * 60e3, "4h": 2 * 3600e3, "1d": 6 * 3600e3 };
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
function memStatus(m, benchAfter = BOT.benchAfter) {
  if (!m || m.n < (benchAfter || BOT.benchAfter)) return "new";
  const avg = m.sum / m.n;
  if (avg < 0) return "benched";
  if (m.n >= BOT.promoteAfter) return "promoted";
  return "ok";
}
function tally(s, key, init, ret, pnl) {
  const m = s.memory[key] || { ...init, n: 0, wins: 0, sum: 0 };
  const before = memStatus(m, init.benchAfter);
  m.n++; if (pnl > 0) m.wins++; m.sum += ret;
  s.memory[key] = m;
  return { m, before, after: memStatus(m, init.benchAfter) };
}

function fresh(now) {
  return { v: 2, startedAt: now, cash: START_USD, positions: [], trades: [], equity: [], startPrices: {}, lastPrice: {},
    priors: {}, memory: {}, lastSeen: {}, nextCheck: {}, events: [], earnings: { at: 0, dates: {} }, lastTick: now, archive: [] };
}

/** The 5-minute tick. */
export async function cronBot(env, now = Date.now()) {
  if (!env?.PUSH) return;
  let s = await env.PUSH.get(KEY, "json");
  let changed = false, soft = false;   // soft = only bookkeeping (which candles were checked): saved at most every 30 min
  if (!s || s.v !== 2) {
    const old = s;
    s = fresh(now);
    if (old?.trades?.length) s.archive = old.trades.slice(-200);   // keep the BTC-only bot's trades for reference
    note(s, now, "info", "The bot now trades 12 markets", "It restarted with a virtual $100 to trade BTC, ETH, SOL, XRP, DOGE, SPY, QQQ, Apple, NVIDIA, Tesla, Microsoft and Amazon.");
    changed = true;
  }
  const stocksOpen = usMarketOpen(now);

  // 0) Earnings calendar for the stocks it trades (refreshed daily).
  if (now - (s.earnings.at || 0) > 20 * 3600e3) { await refreshEarnings(s, now).catch(() => {}); changed = true; }

  // 1) Manage open trades: stop, target, time limit, and selling before an earnings report.
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
      const r = exitOnCandle(k, p.stop, p.target);
      if (r) { exit = r.exit; outcome = r.outcome; break; }
    }
    if (!exit && now >= p.sellBy) { exit = price; outcome = "timeout"; }
    if (!exit && m?.earnings && earningsWithin(s, m.earnings, now, 1)) { exit = price; outcome = "earnings"; }
    if (exit) { closeTrade(s, p, exit, outcome, now); changed = true; }
    else p.checkedTo = recent.at(-1).time * 1000;
  }

  // 2) Re-test one market's setups per tick when its record is a day old.
  const stale = MARKETS.filter((m) => now - (s.priors[m.sym]?.at || 0) > 24 * 3600e3)[0];
  if (stale) {
    const entry = { at: now };
    for (const iv of BOT.ivs) {
      try {
        const c = await candles(stale.sym, iv, 1000);
        if (c?.length > 300) {
          const r = analyze(c, { costPerSide: feeOf(stale.sym), useModel: false });
          entry[iv] = { regime: r.regime.now, setups: Object.fromEntries(r.setups.map((x) => [x.id, { level: x.verdict.level, ev: x.stats.ev, n: x.stats.n, win: x.stats.winRate }])) };
          s.lastPrice[stale.sym] = c.at(-1).close;
        }
      } catch {}
    }
    s.priors[stale.sym] = entry;
    changed = true;
  }

  // 3) Check a few markets whose candle just closed (crypto on schedule; stocks during market hours).
  const due = [];
  for (const m of MARKETS) for (const iv of BOT.ivs) {
    const k = `${m.sym}|${iv}`;
    if (m.stock && !stocksOpen) continue;
    if ((s.nextCheck[k] || 0) <= now) due.push({ m, iv, k });
  }
  due.sort((a, b) => (s.nextCheck[a.k] || 0) - (s.nextCheck[b.k] || 0));
  const candidates = [];
  for (const { m, iv, k } of due.slice(0, BOT.checksPerTick)) {
    // Next check: just after the next candle closes (crypto), or in 30 minutes (stocks: Yahoo's candles follow the session).
    s.nextCheck[k] = m.stock ? now + STOCK_RECHECK[iv] : (Math.floor(now / IV_MS[iv]) + 1) * IV_MS[iv] + 60e3;
    changed = true;   // must be saved: otherwise the same candle could be judged again later (a stale signal)
    let c;
    try { c = await candles(m.sym, iv, 300); } catch { continue; }
    if (!c?.length || c.length < 220) continue;
    s.lastPrice[m.sym] = c.at(-1).close;
    if (!s.startPrices[m.sym]) s.startPrices[m.sym] = c.at(-1).close;
    const i = c.length - 2;                      // last CLOSED candle
    if (s.lastSeen[k] === c[i].time) continue;   // already judged this candle
    s.lastSeen[k] = c[i].time;
    if (s.positions.some((p) => p.sym === m.sym)) continue;
    const x = computeAll(c);
    const regime = regimeAt(c, x, i);
    for (const setup of SETUPS) {
      let on = false;
      try { on = !!setup.test(i, c, x) && isFinite(x.atr14[i]); } catch {}
      if (on) candidates.push(await judge(env, s, m, iv, setup, regime, x.atr14[i], c.at(-1).close, now));
    }
  }
  for (const cand of candidates.filter((x) => x.go).sort((a, b) => b.score - a.score)) {
    if (s.positions.length >= BOT.maxPositions || s.positions.some((p) => p.sym === cand.m.sym)) continue;
    if (openTrade(s, cand, now)) changed = true;
  }
  for (const cand of candidates.filter((x) => !x.go && x.skipNote)) { note(s, now, "skip", cand.skipNote[0], cand.skipNote[1]); soft = true; }

  // 4) Hourly snapshot of the account and of "just holding all 12 equally" (for the chart).
  const hour = Math.floor(now / 3600e3);
  if (Math.floor((s.equity.at(-1)?.[0] || 0) / 3600e3) !== hour && Object.keys(s.startPrices).length) {
    s.equity.push([now, +equityOf(s).toFixed(4), +basketOf(s).toFixed(4)]);
    if (s.equity.length > 3000) s.equity = s.equity.slice(-3000);
    changed = true;
  }
  s.lastTick = now;
  if (changed || (soft && now - (s.lastSave || 0) >= 30 * 60e3)) { s.lastSave = now; await env.PUSH.put(KEY, JSON.stringify(s)); }
}

/** Weigh all the evidence for one active setup. */
async function judge(env, s, m, iv, setup, regime, atr, price, now) {
  const prior = s.priors[m.sym]?.[iv]?.setups?.[setup.id];
  const combo = s.memory[memKey(m.sym, setup.id, iv, regime)];
  const status = memStatus(combo);
  const where = `${setup.name} on ${m.name} (${IV_WORD[iv]})`;
  if (status === "benched") return { skipNote: [`Skipped ${where}`, `It lost on average in its last ${combo.n} tries in a ${regime === "down" ? "falling" : "rising"} market, so the bot benched it.`] };
  const trusted = prior && (prior.level === "edge" || prior.level === "weak");
  if (prior && prior.level === "negative" && prior.n >= 30 && status !== "promoted") return {};
  const mode = trusted || status === "promoted" ? "trusted" : "explore";
  const ex = s.memory[memKey("*explore*", regime)];
  if (mode === "explore" && ex && ex.n >= BOT.exploreStopAfter && ex.sum / ex.n < 0) return {};
  // News: the latest AI read of this market's headlines (if it's recent).
  let news = null;
  try {
    const log = await env.PUSH.get(m.news, "json");
    const last = log?.at(-1);
    if (last && now - last.t < 8 * 3600e3) news = { score: last.s, mood: last.s <= -0.25 ? "negative" : last.s >= 0.25 ? "positive" : "neutral" };
  } catch {}
  if (news) {
    const nm = s.memory[memKey("*news*", news.mood)];
    if (nm && nm.n >= BOT.newsStopAfter && nm.sum / nm.n < 0) return { skipNote: [`Skipped ${where}`, `The news is ${news.mood} (AI score ${news.score.toFixed(2)}), and the bot has learned that buying on ${news.mood} news has lost on average (${nm.wins} wins of ${nm.n}).`] };
    if (news.mood === "negative" && mode === "explore") return { skipNote: [`Skipped ${where}`, `Unproven setup and negative news (AI score ${news.score.toFixed(2)}): not worth testing now.`] };
  }
  // Earnings (stocks).
  if (m.earnings && earningsWithin(s, m.earnings, now, BOT.earningsDays)) return { skipNote: [`Skipped ${where}`, `${m.name} reports earnings within ${BOT.earningsDays} trading days. Prices often jump past a stop-loss on the news.`] };
  const score = (mode === "trusted" ? 1 : 0) + (prior?.ev || 0) * 10 + (news ? news.score * 0.2 : 0);
  return { go: true, m, iv, setup, regime, atr, price, prior, combo, mode, news, score };
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
  const d = riskDistance(c.atr, entry, fee);
  const stop = entry - d, target = entry + (RULES.targetAtr / RULES.stopAtr) * d;
  const eq = equityOf(s);
  const lossPerUnit = entry - stop + fee * (entry + stop);
  let qty = (eq * (c.mode === "trusted" ? BOT.riskTrusted : BOT.riskExplore)) / lossPerUnit;
  qty = Math.min(qty, (eq * BOT.maxPositionShare) / entry, (s.cash * 0.995) / (entry * (1 + fee)));
  if (c.m.stock) qty = Math.floor(qty * 1000) / 1000;   // fractional shares (most US brokers allow them)
  if (!(qty * entry >= BOT.minNotional)) return false;
  const cost = qty * entry * (1 + fee);
  s.cash -= cost;
  const reasons = [
    c.mode === "trusted"
      ? `Trusted setup: ${c.prior ? `won ${Math.round((c.prior.win || 0) * 100)}% of ${c.prior.n} past trades here (${pct(c.prior.ev || 0)} each after fees)` : "promoted by its own winning record"}.`
      : `Exploring with a small amount: this setup isn't proven on ${c.m.name} ${IV_WORD[c.iv]} candles yet.`,
    `Market is ${c.regime === "down" ? "falling" : c.regime === "up" ? "rising" : "unclear"} on ${IV_WORD[c.iv]} candles.`,
    c.news ? `News read by AI: ${c.news.mood} (${c.news.score >= 0 ? "+" : ""}${c.news.score.toFixed(2)}).` : "No recent AI news read.",
    c.m.earnings ? "No earnings report in the next few days." : "",
  ].filter(Boolean).join(" ");
  const p = { id: `${now}-${c.m.sym}`, sym: c.m.sym, market: c.m.name, setup: c.setup.id, name: c.setup.name, iv: c.iv, regime: c.regime, mode: c.mode,
    news: c.news?.mood || "none", newsScore: c.news?.score ?? null, entry, stop, target, qty, cost, openedAt: now,
    sellBy: now + RULES.maxBars * IV_MS[c.iv], checkedTo: now, last: entry, why: reasons };
  s.positions.push(p);
  note(s, now, "open", `Bot bought ${c.m.name} at ${px(entry)} (${c.setup.name}, ${IV_WORD[c.iv]})`,
    `${reasons} Risking ${c.mode === "trusted" ? "1.5%" : "0.4%"} of the account. Stop ${px(stop)}, target ${px(target)}.`, c.m.sym);
  return true;
}

function closeTrade(s, p, exit, outcome, now) {
  const fee = feeOf(p.sym);
  const proceeds = p.qty * exit * (1 - fee);
  s.cash += proceeds;
  s.positions = s.positions.filter((x) => x !== p);
  const pnl = proceeds - p.cost, ret = pnl / p.cost;
  const held = Math.max(1, Math.round((now - p.openedAt) / IV_MS[p.iv]));
  const market = p.regime === "down" ? "a falling market" : p.regime === "up" ? "a rising market" : "an unclear market";
  const what = `${p.name} on ${p.market} (${IV_WORD[p.iv]})`;
  let lesson = outcome === "target" ? `Worked: ${what} reached its target after ${held} candle${held === 1 ? "" : "s"} in ${market}.`
    : outcome === "stop" ? `Mistake: ${what} hit its stop-loss after ${held} candle${held === 1 ? "" : "s"} in ${market}.`
    : outcome === "earnings" ? `Sold before earnings: ${what} (${ret >= 0 ? "small gain" : "small loss"}), so a report surprise couldn't jump past the stop.`
    : `Ran out of time: ${what} hit neither target nor stop within ${RULES.maxBars} candles (${ret >= 0 ? "small gain" : "small loss"}).`;
  if (p.news !== "none") lesson += ` The news was ${p.news} when it bought.`;
  // Learn: market × setup × candle size × market type; news mood; exploring per market type.
  const add = [];
  const a = tally(s, memKey(p.sym, p.setup, p.iv, p.regime), { market: p.market, name: p.name, iv: p.iv, regime: p.regime }, ret, pnl);
  if (a.after === "benched" && a.before !== "benched") add.push(`It will now skip ${what} in ${market} (${a.m.wins} wins of ${a.m.n}, average ${pct(a.m.sum / a.m.n)}).`);
  if (a.after === "promoted" && a.before !== "promoted") add.push(`${what} in ${market} has earned full-size trades (${a.m.wins} wins of ${a.m.n}, average ${pct(a.m.sum / a.m.n)}).`);
  if (p.news !== "none") {
    const n = tally(s, memKey("*news*", p.news), { name: `Buying on ${p.news} news`, group: true, benchAfter: BOT.newsStopAfter }, ret, pnl);
    if (n.after === "benched" && n.before !== "benched") add.push(`Buying when the news is ${p.news} has lost on average (${n.m.wins} wins of ${n.m.n}), so it will stop doing that.`);
  }
  if (p.mode === "explore") {
    const e = tally(s, memKey("*explore*", p.regime), { name: "Exploring unproven setups", group: true, regime: p.regime, benchAfter: BOT.exploreStopAfter }, ret, pnl);
    if (e.after === "benched" && e.before !== "benched") add.push(`Unproven setups have lost on average in ${market} (${e.m.wins} wins of ${e.m.n}), so it will stop exploring there until that changes.`);
  }
  if (add.length) lesson += ` Learned: ${add.join(" ")}`;
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
  if (!s || s.v !== 2) return json({ started: false, note: "The bot starts on the next 5-minute check." }, 60);
  const memory = Object.entries(s.memory).map(([k, m]) => ({ key: k, ...m, avg: m.n ? m.sum / m.n : 0, status: memStatus(m, m.benchAfter) })).sort((a, b) => b.n - a.n);
  const perMarket = MARKETS.map((m) => {
    const t = s.trades.filter((x) => x.sym === m.sym);
    return { sym: m.sym, name: m.name, trades: t.length, wins: t.filter((x) => x.pnl > 0).length, pnl: +t.reduce((a, x) => a + x.pnl, 0).toFixed(2), open: s.positions.some((p) => p.sym === m.sym) };
  });
  return json({
    started: true, version: 2, startUsd: START_USD, startedAt: s.startedAt, lastTick: s.lastTick, markets: MARKETS.map((m) => ({ sym: m.sym, name: m.name })),
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
