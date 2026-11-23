// Entryvex paper-trading bot: trades a VIRTUAL $100 of BTC at live Binance.US prices, 24/7, on the
// server's 5-minute cron. No real money, no exchange keys: every trade is simulated with fees,
// stop-loss, target and a time limit, exactly like the trade plans Entryvex shows people.
//
// How it decides:
//   • When a 1h / 4h / daily candle closes, it checks Entryvex's setups (and candle patterns) on it.
//   • TRUSTED setups (winning record in a daily re-test, in the current kind of market) → normal size.
//   • UNPROVEN setups → small "exploring" trades, so it gathers evidence instead of guessing.
//   • LOSING setups → skipped.
// How it learns (kept forever in its memory):
//   • Every closed trade is stored with a plain-English lesson.
//   • Results are tallied per setup × candle size × market type. A combination that keeps losing
//     is BENCHED (skipped); an unproven one that keeps winning is PROMOTED to full size.
// Efficient: it only downloads candles when one has closed, and only saves when something changed
// (plus an hourly balance snapshot), which keeps it inside free-tier limits.
import { candles } from "./push.js";
import { SETUPS, RULES, regimeAt, riskDistance, exitOnCandle, analyze } from "../../public/js/engine.js";
import { computeAll } from "../../public/js/indicators.js";

const KEY = "bot:state";
const SYM = "BTCUSDT";
const START_USD = 100;
export const BOT = {
  feePerSide: 0.0005,      // 0.05% each way: Binance.US fee + a little spread/slippage
  riskTrusted: 0.02,       // risk 2% of the balance at the stop on trusted setups
  riskExplore: 0.005,      // 0.5% on unproven setups (learning trades)
  ivs: ["1h", "4h", "1d"],
  benchAfter: 5,           // a combination with ≥5 trades and an average loss gets benched
  promoteAfter: 8,         // an unproven one with ≥8 trades and an average gain gets promoted
  minNotional: 10,         // Binance.US minimum order
  exploreStopAfter: 12,    // if ≥12 exploring trades in one market type lost on average, stop exploring there
};
const IV_MS = { "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
const IV_WORD = { "1h": "1-hour", "4h": "4-hour", "1d": "daily" };

function fresh(price, now) {
  return {
    v: 1, startedAt: now, startPrice: price, cash: START_USD, pos: null,
    trades: [], equity: [[now, START_USD, price]], priors: {}, memory: {}, lastClose: {}, events: [], lastTick: now,
  };
}
const memKey = (setupId, iv, regime) => `${setupId}|${iv}|${regime}`;
function memStatus(m) {
  if (!m || m.n < BOT.benchAfter) return "new";
  const avg = m.sum / m.n;
  if (avg < 0) return "benched";
  if (m.n >= BOT.promoteAfter && avg > 0) return "promoted";
  return "ok";
}
const pct = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;
const usd = (x) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(2)}`;

/** The 5-minute tick. */
export async function cronBot(env, now = Date.now()) {
  if (!env?.PUSH) return;
  let s = await env.PUSH.get(KEY, "json");
  let changed = false;
  const recent = await candles(SYM, "5m", 36).catch(() => null);   // last 3 hours of 5-minute candles
  if (!recent?.length) return;
  const price = recent.at(-1).close;
  if (!s) { s = fresh(price, now); changed = true; }

  // 1) Manage the open trade: stop, target or time limit, checked on every 5-minute candle since last tick.
  if (s.pos) {
    const p = s.pos;
    let exit = null, outcome = null;
    for (const k of recent) {
      if (k.time * 1000 < p.checkedTo) continue;
      const r = exitOnCandle(k, p.stop, p.target);
      if (r) { exit = r.exit; outcome = r.outcome; break; }
    }
    if (!exit && now >= p.sellBy) { exit = price; outcome = "timeout"; }
    if (exit) { closeTrade(s, exit, outcome, now); changed = true; }
    else p.checkedTo = recent.at(-1).time * 1000;
  }

  // 2) Re-test the setups once a day (the "prior": what has worked lately, per candle size and market type).
  if (!s.priorsAt || now - s.priorsAt > 24 * 3600e3) {
    for (const iv of BOT.ivs) {
      try {
        const c = await candles(SYM, iv, 1000);
        const r = analyze(c, { costPerSide: BOT.feePerSide, useModel: false });
        s.priors[iv] = { regime: r.regime.now, setups: Object.fromEntries(r.setups.map((x) => [x.id, { name: x.name, level: x.verdict.level, ev: x.stats.ev, n: x.stats.n, win: x.stats.winRate }])) };
      } catch { /* keep yesterday's */ }
    }
    s.priorsAt = now;
    changed = true;
  }

  // 3) Look for a new trade, but only on candle sizes whose candle has just closed.
  {
    const candidates = [];
    for (const iv of BOT.ivs) {
      const closedAt = Math.floor(now / IV_MS[iv]) * IV_MS[iv];
      if (s.lastClose[iv] === closedAt) continue;
      s.lastClose[iv] = closedAt;   // recorded even while a trade is open, so it never acts on an old signal
      changed = true;
      if (s.pos) continue;
      let c;
      try { c = await candles(SYM, iv, 300); } catch { continue; }
      if (!c?.length || c.length < 220) continue;
      const x = computeAll(c);
      const i = c.length - 2;   // last CLOSED candle
      const regime = regimeAt(c, x, i);
      for (const setup of SETUPS) {
        let on = false;
        try { on = !!setup.test(i, c, x) && isFinite(x.atr14[i]); } catch {}
        if (!on) continue;
        const prior = s.priors[iv]?.setups?.[setup.id];
        const mem = s.memory[memKey(setup.id, iv, regime)];
        const status = memStatus(mem);
        if (status === "benched") { note(s, now, "skip", `Skipped ${setup.name} on ${IV_WORD[iv]} candles`, `It lost on average in its last ${mem.n} tries in a ${regime === "down" ? "falling" : "rising"} market, so the bot benched it.`); continue; }
        const trusted = prior && (prior.level === "edge" || prior.level === "weak");
        const losing = prior && prior.level === "negative" && prior.n >= 30;
        if (losing && status !== "promoted") continue;
        const mode = trusted || status === "promoted" ? "trusted" : "explore";
        // Bigger lesson: exploring keeps losing in this kind of market → only trusted setups until it changes.
        const ex = s.memory[memKey("*explore*", "*", regime)];
        if (mode === "explore" && ex && ex.n >= BOT.exploreStopAfter && ex.sum / ex.n < 0) continue;
        candidates.push({ setup, iv, regime, atr: x.atr14[i], prior, mem, mode, score: (mode === "trusted" ? 1 : 0) + (prior?.ev || 0) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    if (candidates[0]) { openTrade(s, candidates[0], price, now); changed = true; }
  }

  // 4) Balance snapshot once an hour (for the chart) — the only routine write.
  const hour = Math.floor(now / 3600e3);
  if (Math.floor((s.equity.at(-1)?.[0] || 0) / 3600e3) !== hour) {
    s.equity.push([now, +equityOf(s, price).toFixed(4), price]);
    if (s.equity.length > 3000) s.equity = s.equity.slice(-3000);
    changed = true;
  }
  s.lastTick = now;
  if (changed) await env.PUSH.put(KEY, JSON.stringify(s));
}

const equityOf = (s, price) => s.cash + (s.pos ? s.pos.qty * price : 0);

function openTrade(s, cand, price, now) {
  const fee = BOT.feePerSide;
  const entry = price;
  const d = riskDistance(cand.atr, entry, fee);
  const stop = entry - d, target = entry + (RULES.targetAtr / RULES.stopAtr) * d;
  const risk = cand.mode === "trusted" ? BOT.riskTrusted : BOT.riskExplore;
  const lossPerUnit = entry - stop + fee * (entry + stop);
  let qty = (s.cash * risk) / lossPerUnit;
  qty = Math.min(qty, (s.cash * 0.995) / (entry * (1 + fee)));   // no borrowing
  if (qty * entry < BOT.minNotional) { note(s, now, "skip", `Skipped ${cand.setup.name}`, `The trade would be under Binance.US's $${BOT.minNotional} minimum.`); return; }
  const cost = qty * entry * (1 + fee);
  s.cash -= cost;
  const why = cand.mode === "trusted"
    ? `Trusted: ${cand.prior ? `won ${Math.round((cand.prior.win || 0) * 100)}% of ${cand.prior.n} past trades (${pct(cand.prior.ev || 0)} each after fees)` : "promoted by its own winning record"}.`
    : `Exploring (small size): this setup isn't proven on ${IV_WORD[cand.iv]} candles yet, so the bot is testing it with little money.`;
  s.pos = {
    id: `${now}`, setup: cand.setup.id, name: cand.setup.name, iv: cand.iv, regime: cand.regime, mode: cand.mode,
    entry, stop, target, qty, cost, openedAt: now, sellBy: now + RULES.maxBars * IV_MS[cand.iv], checkedTo: now, why,
  };
  note(s, now, "open", `Bot bought BTC at $${entry.toFixed(0)} (${cand.setup.name}, ${IV_WORD[cand.iv]})`,
    `${why} Stop $${stop.toFixed(0)}, target $${target.toFixed(0)}, sell by ${new Date(s.pos.sellBy).toISOString().slice(0, 16).replace("T", " ")} UTC.`);
}

function closeTrade(s, exit, outcome, now) {
  const p = s.pos, fee = BOT.feePerSide;
  const proceeds = p.qty * exit * (1 - fee);
  s.cash += proceeds;
  const pnl = proceeds - p.cost, ret = pnl / p.cost;
  const held = Math.max(1, Math.round((now - p.openedAt) / IV_MS[p.iv]));
  const market = p.regime === "down" ? "a falling market" : p.regime === "up" ? "a rising market" : "an unclear market";
  const lesson = outcome === "target" ? `Worked: ${p.name} on ${IV_WORD[p.iv]} candles reached its target after ${held} candle${held === 1 ? "" : "s"} in ${market}.`
    : outcome === "stop" ? `Mistake: ${p.name} on ${IV_WORD[p.iv]} candles hit its stop-loss after ${held} candle${held === 1 ? "" : "s"} in ${market}.`
    : `Ran out of time: ${p.name} on ${IV_WORD[p.iv]} candles hit neither target nor stop within ${RULES.maxBars} candles (${ret >= 0 ? "small gain" : "small loss"}).`;
  // Learn: tally this setup × candle size × market type.
  const k = memKey(p.setup, p.iv, p.regime);
  const m = s.memory[k] || { name: p.name, iv: p.iv, regime: p.regime, n: 0, wins: 0, sum: 0 };
  const before = memStatus(m);
  m.n++; if (pnl > 0) m.wins++; m.sum += ret;
  s.memory[k] = m;
  const after = memStatus(m);
  let learned = "";
  if (after === "benched" && before !== "benched") learned = ` Learned: it will now skip ${p.name} on ${IV_WORD[p.iv]} candles in ${market} (${m.wins} wins of ${m.n}, average ${pct(m.sum / m.n)}).`;
  if (after === "promoted" && before !== "promoted") learned = ` Learned: ${p.name} on ${IV_WORD[p.iv]} candles in ${market} has earned full-size trades (${m.wins} wins of ${m.n}, average ${pct(m.sum / m.n)}).`;
  if (p.mode === "explore") {
    const ek = memKey("*explore*", "*", p.regime);
    const e = s.memory[ek] || { name: "Exploring (any unproven setup)", iv: "*", regime: p.regime, n: 0, wins: 0, sum: 0, group: true };
    const was = e.n >= BOT.exploreStopAfter && e.sum / e.n < 0;
    e.n++; if (pnl > 0) e.wins++; e.sum += ret;
    s.memory[ek] = e;
    if (!was && e.n >= BOT.exploreStopAfter && e.sum / e.n < 0) learned += ` Bigger lesson: unproven setups have lost on average in ${market} (${e.wins} wins of ${e.n}), so it will stop exploring there and only take trusted setups until that changes.`;
  }
  s.trades.push({ ...p, exit, outcome, closedAt: now, pnl: +pnl.toFixed(4), ret: +ret.toFixed(5), lesson: lesson + learned });
  if (s.trades.length > 1000) s.trades = s.trades.slice(-1000);
  s.pos = null;
  note(s, now, "close", `Bot sold BTC at $${exit.toFixed(0)}: ${usd(pnl)} (${pct(ret)})`, lesson + learned);
}

function note(s, t, kind, title, body) {
  s.events.push({ t, kind, title, body });
  if (s.events.length > 60) s.events = s.events.slice(-60);
}

/** Performance summary, including whether it has really proven anything. */
export function summarize(s, price) {
  const eq = equityOf(s, price);
  const closed = s.trades;
  const n = closed.length, wins = closed.filter((t) => t.pnl > 0).length;
  const rets = closed.map((t) => t.ret);
  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  let peak = START_USD, dd = 0;
  for (const [, e] of s.equity) { peak = Math.max(peak, e); dd = Math.min(dd, e / peak - 1); }
  const hold = price / s.startPrice - 1;
  const ret = eq / START_USD - 1;
  const proven = n >= 30 && ret > 0 && ret > hold && t >= 2;
  return {
    equity: +eq.toFixed(2), returnPct: ret, holdPct: hold, trades: n, wins, winRate: n ? wins / n : null, avgPerTrade: n ? mean : null, t,
    maxDrawdown: dd, days: (Date.now() - s.startedAt) / 86400e3,
    status: proven ? "proven" : n < 30 ? "learning" : "not-proven",
    statusText: proven ? "Proven: profitable after fees over 30+ trades, ahead of just holding BTC, and unlikely to be luck."
      : n < 30 ? `Learning: ${n} of the 30 trades needed before its record means anything.`
      : "Not proven: after 30+ trades it isn't clearly beating fees and just holding BTC.",
  };
}

/** GET /api/bot — the bot's public record (read-only). */
export async function onRequestGet(context) {
  const { env } = context;
  const s = env?.PUSH ? await env.PUSH.get(KEY, "json") : null;
  if (!s) return json({ started: false, note: "The bot starts on the next 5-minute check." }, 60);
  const last = s.equity.at(-1)?.[2] || s.startPrice;
  let price = last;
  try { const r = await candles(SYM, "5m", 1); price = r.at(-1)?.close || last; } catch {}
  const memory = Object.values(s.memory).map((m) => ({ ...m, avg: m.n ? m.sum / m.n : 0, status: memStatus(m) })).sort((a, b) => b.n - a.n);
  return json({
    started: true, symbol: SYM, startUsd: START_USD, startedAt: s.startedAt, startPrice: s.startPrice, price, lastTick: s.lastTick,
    settings: BOT, summary: summarize(s, price), position: s.pos, trades: s.trades.slice(-200).reverse(), equity: s.equity,
    memory, priors: s.priors, events: s.events.slice(-30).reverse(),
  }, 60);
}

/** Recent bot events (for "Follow the bot" notifications in the alert cron). */
export async function botEventsSince(env, since) {
  const s = env?.PUSH ? await env.PUSH.get(KEY, "json") : null;
  return (s?.events || []).filter((e) => e.t > since && (e.kind === "open" || e.kind === "close"));
}

function json(obj, maxAge = 0) {
  return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" } });
}
