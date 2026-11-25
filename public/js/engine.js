// Entryvex setup engine.
//
// 1. Detect trading "setups" on closed candles.
// 2. Replay every past occurrence of each setup on this coin + timeframe:
//    enter at the NEXT candle's open, exit at a target or a stop (or after a time limit),
//    subtract fees + spread on both the buy and the sell.
// 3. Report what actually happened: how often the target was hit first, average
//    win/loss, expected value per trade, and whether the edge is statistically real.
//
// The confidence number is a measured historical hit-rate, never a guess.
// Long-only, because Binance.US spot accounts can't short.

import { computeAll } from "./indicators.js";
import { PATTERNS } from "./patterns.js";
import { trainModel, featuresAt, fitLogistic, predictorFrom, auc, FEATURE_NAMES, MODEL } from "./model.js";

export const RULES = {
  stopAtr: 1.0,     // stop-loss distance in ATRs below entry
  targetAtr: 1.5,   // profit target distance in ATRs above entry
  maxBars: 24,      // give up and exit at market after this many candles
  minTrades: 30,    // below this, history is too thin to trust
  warmup: 200,      // candles needed before indicators are reliable
  minRiskCosts: 4,  // the stop is never closer than 4× the one-way cost (so the target ≥ 3× the round-trip cost)
};

/**
 * Stop distance (as a price amount) for a trade: 1 ATR, but never so small that fees and spread
 * eat the profit target. On tiny candles (1m/5m) one ATR can be smaller than the round-trip cost,
 * which would make every trade a loser by construction. Fixed rule, not tuned to results.
 */
export function riskDistance(atr, price, costPerSide) {
  return Math.max(RULES.stopAtr * atr, RULES.minRiskCosts * costPerSide * price);
}

/**
 * The trend rule: the BUY rule that held up best on data it never saw (tools/walkforward.mjs): it made
 * money after fees, a little more than random timing, with much smaller drops than just holding.
 * Daily charts only. Buy when the market is in an uptrend (price above its 200-day average, and the
 * 50-day average above the 200-day) and a day closes above the highest price of the previous 20 days.
 * Sell with a trailing stop: start 2 ATR below the entry, then keep it 3 ATR below the highest price
 * since you bought (a "chandelier" stop, a standard trend-following exit), never lowering it.
 * No fixed take-profit: winners are allowed to run, which is where trend following makes its money.
 * All numbers are standard textbook values chosen before testing, not tuned to the results.
 */
export const TREND = {
  stopAtr: 2,          // first stop: 2 ATR below entry
  trailAtr: 3,         // then 3 ATR below the highest high since entry
  maxBars: 400,        // safety cap for the past-record replay (about 13 months of daily candles)
  minSpacingSec: 20 * 3600,   // "daily or longer" candles
};
export const TREND_SETUP = {
  id: "trend", name: "Trend breakout", trend: true,
  plain: "The market is in an uptrend (price above its 200-day average, 50-day average above the 200-day) and a day just closed above the highest price of the previous 20 days.",
  test: (i, c, x) => c[i].close > x.ema200[i] && x.ema50[i] > x.ema200[i] && c[i].close > x.high20[i],
};
/** Candles of a day or longer? (median spacing of the last 30 candles) */
export function isLongChart(candles) {
  const t = candles.slice(-31).map((k) => k.time);
  if (t.length < 3) return false;
  const gaps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] >= TREND.minSpacingSec;
}
/** The trailing stop after a candle: never lower than before, 3 ATR under the highest high so far. */
export function trailStop(prevStop, highSinceEntry, atrNow) {
  return isFinite(atrNow) ? Math.max(prevStop, highSinceEntry - TREND.trailAtr * atrNow) : prevStop;
}
/** First stop for a trend trade bought at `entry`. */
export function trendStop(entry, atr, cost) {
  return entry - Math.max(TREND.stopAtr * atr, RULES.minRiskCosts * cost * entry);
}
/** Replay one trend trade signalled at candle i: buy next open, exit at the (trailing) stop. null if still open. */
export function trendTrade(c, x, i, lastClosed, cost) {
  const e = i + 1;
  if (e > lastClosed || !isFinite(x.atr14[i])) return null;
  const entry = c[e].open;
  let stop = trendStop(entry, x.atr14[i], cost), hi = entry;
  for (let j = e; j <= lastClosed; j++) {
    const k = c[j];
    if (k.open <= stop) return { entry, exit: k.open, outcome: "stop", end: j };
    if (k.low <= stop) return { entry, exit: stop, outcome: "stop", end: j };
    if (j - e + 1 >= TREND.maxBars) return { entry, exit: k.close, outcome: "timeout", end: j };
    hi = Math.max(hi, k.high);
    stop = trailStop(stop, hi, x.atr14[j]);
  }
  return null;
}
function trendBacktest(c, x, lastClosed, cost) {
  const trades = [];
  for (let i = RULES.warmup; i < lastClosed; i++) {
    if (!safeTest(TREND_SETUP, i, c, x)) continue;
    const r = trendTrade(c, x, i, lastClosed, cost);
    if (!r) break;
    const net = (r.exit - r.entry) / r.entry - 2 * cost;
    trades.push({ signalTime: c[i].time, entryTime: c[i + 1].time, exitTime: c[r.end].time, entry: r.entry, exit: r.exit, outcome: r.outcome, net, bars: r.end - i, regime: regimeAt(c, x, i) });
    i = r.end;
  }
  return trades;
}

export const SETUPS = [
  {
    id: "breakout",
    name: "Volume breakout",
    plain: "Price just closed above its highest point of the previous 20 candles, on at least 1.5× normal volume.",
    test: (i, c, x) =>
      c[i].close > x.high20[i] && c[i].close > c[i].open && c[i].volume > 1.5 * x.volAvg20[i],
  },
  {
    id: "pullback",
    name: "Trend pullback",
    plain: "In an uptrend (20-average above a rising 50-average), price dipped to the 20-average and bounced back up.",
    test: (i, c, x) =>
      x.ema20[i] > x.ema50[i] && x.ema50[i] > x.ema50[i - 5] &&
      c[i].low <= x.ema20[i] + 0.2 * x.atr14[i] && c[i].close > x.ema20[i] &&
      c[i].close > c[i].open && x.rsi14[i] >= 40 && x.rsi14[i] <= 65,
  },
  {
    id: "oversold",
    name: "Oversold bounce",
    plain: "Price got stretched far below normal (RSI under 30, under the lower Bollinger band) and the latest candle closed green.",
    test: (i, c, x) =>
      Math.min(x.rsi14[i], x.rsi14[i - 1]) < 30 && c[i - 1].low < x.bbLower[i - 1] &&
      c[i].close > c[i].open && c[i].close > c[i - 1].close,
  },
  {
    id: "momentum",
    name: "Momentum turn-up",
    plain: "Strong uptrend (price above the 20, 50 and 200 averages) and momentum just crossed back above RSI 55.",
    test: (i, c, x) =>
      c[i].close > x.ema20[i] && x.ema20[i] > x.ema50[i] && x.ema50[i] > x.ema200[i] &&
      x.rsi14[i] >= 55 && x.rsi14[i] <= 72 && x.rsi14[i - 1] < 55,
  },
  // Bullish candlestick patterns (see patterns.js), each tested as its own buy setup.
  // `strict`: with this many extra setups, one could look good by luck alone, so a pattern needs
  // stronger evidence (t ≥ 2.5 instead of 2) before Entryvex calls it a proven edge.
  ...PATTERNS.filter((p) => p.dir === 1).map((p) => ({
    id: "p_" + p.id, name: p.name, plain: p.plain, pattern: true, strict: true,
    test: (i, c, x) => p.test(c, i, x),
  })),
];

/**
 * Analyze one coin on one timeframe.
 * @param candles  oldest → newest; the LAST candle may still be forming and is never used as a signal.
 * @param costPerSide  fraction (0.0007 = 0.07%) charged on entry AND on exit (fee + half-spread).
 */
export function analyze(candles, { costPerSide = 0.0007, formingLast = true, useModel = true, modelLabel = "trade", pooled = null } = {}) {
  const x = computeAll(candles);
  const lastClosed = candles.length - (formingLast ? 2 : 1);
  // Market regime now: price above or below its 200-candle average. Long setups behave very
  // differently in rising and falling markets, so each setup is judged by its record in the SAME
  // regime as now, when there are enough such trades (otherwise by its whole record).
  const regimeNow = regimeAt(candles, x, lastClosed);
  const setups = SETUPS.map((s) => {
    const trades = backtest(candles, x, s, lastClosed, costPerSide);
    const statsAll = summarize(trades);
    const same = trades.filter((t) => t.regime === regimeNow);
    const statsRegime = summarize(same);
    const useRegime = regimeNow !== "unknown" && statsRegime.n >= RULES.minTrades;
    const stats = useRegime ? statsRegime : statsAll;
    const activeNow = lastClosed >= RULES.warmup && safeTest(s, lastClosed, candles, x);
    return { ...s, trades, stats, statsAll, statsRegime, basis: useRegime ? "regime" : "all", activeNow, verdict: verdictFor(stats, s.strict) };
  });

  // The Entryvex model (model.js): one prediction combining trend, momentum, RSI, volume, breakouts,
  // candle patterns and market type, learned on the older 70% of this market's history. Its buy
  // signal (its most confident 20% of calls) is replayed ONLY on the newest 30% it never saw, with
  // the same stop/target/time limit/costs as every setup, and judged with the stricter bar.
  let model = null;
  if (useModel) {
    // Trained on the exact trade it will be judged by: buy next open, target before stop within the time limit, after costs.
    const label = modelLabel === "trade" ? (i) => tradeWins(candles, x, i, lastClosed, costPerSide) : null;
    try {
      // A shared model trained across the whole watchlist (see trainPooled) predicts better than one
      // trained on a single market's history; use it when the watchlist check has made one.
      model = pooled ? applyPooled(pooled, candles, x, lastClosed, costPerSide)
        : trainModel(candles, x, lastClosed, costPerSide, { label, labelBars: RULES.maxBars + 1 });
    } catch { model = null; }
  }
  if (model?.ok) {
    const ms = {
      id: "model", name: "Entryvex model", model: true, strict: true,
      plain: model.shared
        ? "Entryvex's prediction model (trained on every market in your watchlist at this candle size) expects this trade to work: target before stop, after costs. It's judged only on the period after its training cutoff."
        : "Entryvex's prediction model (trained on this market's older history) expects this trade to work: target before stop, after costs. It's judged only on the newest part of history it never saw.",
      test: (i) => i >= model.testStart && (model.probs.get(i) ?? 0) >= model.threshold,
    };
    const trades = backtest(candles, x, ms, lastClosed, costPerSide);
    const stats = summarize(trades);
    const activeNow = ms.test(lastClosed);
    setups.push({ ...ms, trades, stats, statsAll: stats, statsRegime: stats, basis: "unseen", activeNow, verdict: verdictFor(stats, true) });
  }

  const a = x.atr14[lastClosed];
  const price = candles[candles.length - 1].close;
  const active = setups.filter((s) => s.activeNow);
  const rank = { tested: 4, edge: 3, weak: 2, thin: 1, flat: 0.5, negative: 0 };
  active.sort((p, q) => rank[q.verdict.level] - rank[p.verdict.level] || q.stats.ev - p.stats.ev);
  let best = active[0] || null;

  const liquidity = checkLiquidity(candles, lastClosed);

  // BUY answers come ONLY from the trend rule on daily (or longer) candles: on unseen data it made money
  // after fees with small drops. The other setups are still measured and shown as research, but on
  // unseen data they lost money after fees (worse than random timing), so they no longer produce a BUY.
  const long = isLongChart(candles);
  const trendTrades = trendBacktest(candles, x, lastClosed, costPerSide);
  const tStats = summarize(trendTrades);
  const trend = {
    ...TREND_SETUP, trades: trendTrades, stats: tStats, statsAll: tStats, statsRegime: tStats, basis: "all", exit: "trail",
    activeNow: long && lastClosed >= RULES.warmup && safeTest(TREND_SETUP, lastClosed, candles, x),
    verdict: trendVerdict(tStats),
  };
  setups.unshift(trend);
  const upNow = lastClosed >= RULES.warmup && candles[lastClosed].close > x.ema200[lastClosed] && x.ema50[lastClosed] > x.ema200[lastClosed];
  const hi20 = lastClosed >= 20 ? Math.max(...candles.slice(lastClosed - 19, lastClosed + 1).map((k) => k.high)) : NaN;

  let overall, buyFrom = null;
  if (!liquidity.ok) overall = { level: "no", label: "ILLIQUID", text: liquidity.reason };
  else if (!long) overall = { level: "wait", label: "WAIT", shortChart: true, text: "On candles shorter than a day, Entryvex's buy signals lost money after fees when tested on data they never saw (no better than buying at random moments). BUY signals come from the daily chart." };
  else if (trend.activeNow) { overall = { level: "go", label: "GO", text: "Uptrend, and a day just closed at a new 20-day high: Entryvex's trend rule, which made money after fees on data it never saw. Sell with a trailing stop." }; buyFrom = trend; }
  else if (upNow) overall = { level: "wait", label: "WAIT", trigger: hi20, text: `Uptrend, but no new 20-day high yet. Entryvex says BUY when a day closes above ${fmtP(hi20)}.` };
  else overall = { level: "wait", label: "WAIT", text: "No uptrend: price isn't above its 200-day average with the 50-day above it. The trend rule waits for one." };

  const plan = buyFrom && isFinite(a) ? {
    setup: buyFrom.id,
    kind: "trail",
    entry: price,
    stop: trendStop(price, a, costPerSide),
    target: null,
    trailAtr: TREND.trailAtr,
    trail: TREND.trailAtr * a,
    atr: a,
    stopPct: (price - trendStop(price, a, costPerSide)) / price,
    targetPct: null,
    medianBars: buyFrom.stats.medianBars,
  } : null;

  const triggers = long ? trendTriggers(candles, x, lastClosed, trend, price, upNow, hi20) : [];

  if (buyFrom) best = buyFrom;
  return {
    setups, overall, best, plan, costPerSide, atr: a, price, liquidity, triggers, long, trend, upNow,
    regime: { now: regimeNow, label: REGIME_LABEL[regimeNow] },
    model: model?.ok ? { pNow: model.pNow, threshold: model.threshold, H: model.H, test: model.test, weights: model.weights, shared: !!model.shared } : null,
    sample: {
      candles: Math.max(0, lastClosed - RULES.warmup),
      from: candles[RULES.warmup]?.time, to: candles[lastClosed]?.time,
    },
  };
}

const fmtP = (v) => (isFinite(v) ? (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toPrecision(4)) : "?");

/** "When would Entryvex say BUY?" on a daily chart: the trend rule's price trigger. */
function trendTriggers(c, x, i, trend, price, upNow, hi20) {
  if (i < RULES.warmup) return [];
  return [upNow
    ? { id: "trend", setup: trend, level: hi20, away: ((hi20 - price) / price) * 100, ready: true, text: "a day closes above {L} (the 20-day high) while the uptrend holds" }
    : { id: "trend", setup: trend, level: null, away: null, ready: false,
        text: c[i].close > x.ema200[i]
          ? "first needs the 50-day average to rise above the 200-day average (the uptrend isn't confirmed yet)"
          : `first needs an uptrend: price back above its 200-day average (about ${fmtP(x.ema200[i])})` }];
}

/** The trend rule is judged across many markets (see the Scorecard), so one market's own record is context. */
function trendVerdict(s) {
  if (s.n < 8) return { level: "tested", label: "Tested rule", why: `Only ${s.n} past trades on this market, too few to judge it here on its own. Across 12 markets the rule made money after fees on data it never saw.` };
  return {
    level: "tested", label: "Tested rule",
    why: `On this market it made ${(s.ev * 100).toFixed(1)}% per trade on average over ${s.n} past trades (won ${Math.round(s.winRate * 100)}%). Trend trades win less than half the time; the winners are bigger than the losers. Across 12 markets the rule made money after fees on data it never saw.`,
  };
}

/**
 * "When would Entryvex say BUY?": for each setup, what has to happen next (in prices) for it to fire,
 * computed from the current indicator values. `ready` = all conditions except the final trigger are met.
 */
function buyTriggers(c, x, i, setups, price) {
  if (i < RULES.warmup) return [];
  const pctAway = (lvl) => ((lvl - price) / price) * 100;
  const out = [];
  const by = Object.fromEntries(setups.map((s) => [s.id, s]));
  const hi20 = Math.max(...c.slice(i - 19, i + 1).map((k) => k.high));   // the level the next candle must beat
  const uptrend = x.ema20[i] > x.ema50[i] && x.ema50[i] > x.ema50[i - 5];
  const aligned = c[i].close > x.ema20[i] && x.ema20[i] > x.ema50[i] && x.ema50[i] > x.ema200[i];

  out.push({
    id: "breakout", setup: by.breakout, level: hi20, away: pctAway(hi20), ready: true,
    text: "a candle closes above {L} (the 20-candle high) on at least 1.5× normal volume",
  });
  out.push(uptrend
    ? { id: "pullback", setup: by.pullback, level: x.ema20[i], away: pctAway(x.ema20[i]), ready: true,
        text: price > x.ema20[i]
          ? "price dips to about {L} (its 20-candle average) and a green candle closes back above it"
          : "a green candle closes back above {L} (its 20-candle average) while the uptrend holds" }
    : { id: "pullback", setup: by.pullback, level: null, away: null, ready: false,
        text: "first needs an uptrend (the 20-candle average above a rising 50-candle average); there isn't one now" });
  out.push({
    id: "oversold", setup: by.oversold, level: x.bbLower[i], away: pctAway(x.bbLower[i]), ready: x.rsi14[i] < 40,
    text: price > x.bbLower[i]
      ? `price drops below about {L} (the lower Bollinger band) with RSI under 30 (now ${x.rsi14[i].toFixed(0)}), then a green candle closes higher`
      : `price is already below {L} (the lower Bollinger band); it needs RSI under 30 (now ${x.rsi14[i].toFixed(0)}) and then a green candle that closes higher`,
  });
  out.push(aligned
    ? { id: "momentum", setup: by.momentum, level: null, away: null, ready: true,
        text: `RSI climbs back above 55 (now ${x.rsi14[i].toFixed(0)}) while the uptrend holds` }
    : { id: "momentum", setup: by.momentum, level: null, away: null, ready: false,
        text: "first needs a strong uptrend (price above its 20, 50 and 200-candle averages); there isn't one now" });
  // Candlestick patterns: no single price level, just the shape forming after a decline.
  const falling = i >= 6 && c[i].close < c[i - 5].close;
  for (const s of setups.filter((q) => q.pattern)) {
    out.push({ id: s.id, setup: s, level: null, away: null, ready: falling,
      text: falling ? `a ${s.name.toLowerCase()} forms: ${s.plain.replace(/^After a decline, /, "").replace(/\.$/, "")}`
        : `first needs a decline (a ${s.name.toLowerCase()} is a bottoming pattern); price isn't falling now` });
  }
  return out;
}

/**
 * Is this market liquid enough to trade on this candle size? Measured on the last 500 closed candles.
 * Thin markets (lots of empty candles, or very little money changing hands) produce fake patterns,
 * and stop-losses can't protect you there because price jumps straight past them.
 */
export const LIQUIDITY = { maxZeroVolume: 0.2, maxFlat: 0.4, minMedianUsd: 1000 };
export function checkLiquidity(candles, lastClosed = candles.length - 2) {
  const recent = candles.slice(Math.max(0, lastClosed - 499), lastClosed + 1);
  if (recent.length < 50) return { ok: true, zeroFrac: 0, flatFrac: 0, medianUsd: NaN };
  const zeroFrac = recent.filter((k) => !(k.volume > 0)).length / recent.length;
  const flatFrac = recent.filter((k) => k.high === k.low).length / recent.length;
  const usd = recent.map((k) => (k.volume || 0) * k.close).sort((x, y) => x - y);
  const medianUsd = usd[Math.floor(usd.length / 2)];
  let reason = null;
  if (zeroFrac > LIQUIDITY.maxZeroVolume || flatFrac > LIQUIDITY.maxFlat)
    reason = `This market barely trades on this candle size: ${Math.round(zeroFrac * 100)}% of recent candles had no trades at all. Prices jump instead of moving smoothly, so a stop-loss can't protect you. Don't trade it here; try a bigger candle size or a busier market.`;
  else if (medianUsd < LIQUIDITY.minMedianUsd)
    reason = `Very little money trades here: a typical candle sees only about $${Math.round(medianUsd).toLocaleString()} change hands. Even a small order can move the price against you. Don't trade it here; try a bigger candle size or a busier market.`;
  return { ok: !reason, zeroFrac, flatFrac, medianUsd, reason };
}

export const REGIME_LABEL = { up: "rising market (price above its 200-candle average)", down: "falling market (price below its 200-candle average)", unknown: "not enough history to tell" };
/** "up" / "down" by price vs its 200-candle average at candle i. */
export function regimeAt(c, x, i) {
  const m = x.ema200?.[i];
  if (!isFinite(m) || i < RULES.warmup) return "unknown";
  return c[i].close >= m ? "up" : "down";
}

/**
 * One model for many markets at one candle size: more examples to learn from, so it generalizes
 * better (tested: clearly better on unseen data on 1h and daily). Every market shares ONE time
 * cutoff: training only uses trades that finished before it, and each market is judged only after it.
 * @param markets [{ candles, cost }]
 * @returns plain data { w, b, mu, sd, cutoff, threshold, n } (safe to send between threads) or null
 */
export function trainPooled(markets, { target = "trade" } = {}) {
  const H = target === "trade" ? RULES.maxBars + 1 : MODEL.H;
  const prepared = markets.filter((m) => m.candles?.length > 600).map((m) => ({ ...m, x: computeAll(m.candles), last: m.candles.length - 2 }));
  if (prepared.length < 3) return null;
  const cut = prepared.map(({ candles: c, last }) => c[Math.floor(210 + (last - H - 210) * MODEL.trainFrac)].time).sort((a, b) => a - b);
  const cutoff = cut[Math.floor(cut.length / 2)];   // median market's 70% point
  const X = [], y = [];
  for (const { candles: c, x, last, cost } of prepared) {
    for (let i = 210; i + H <= last && c[i + H].time < cutoff; i++) {
      const f = featuresAt(c, x, i);
      if (!f) continue;
      const yi = target === "trade" ? tradeWins(c, x, i, last, cost) : (c[i + H].close > c[i].close * (1 + 2 * cost) ? 1 : 0);
      if (yi == null) continue;
      X.push(f); y.push(yi);
    }
  }
  if (X.length < 800 || y.every((v) => v === y[0])) return null;
  const m = fitLogistic(X, y);
  const p = X.map((f) => m.predict(f)).sort((a, b) => a - b);
  return { w: m.w, b: m.b, mu: m.mu, sd: m.sd, cutoff, threshold: p[Math.floor(p.length * (1 - MODEL.topFrac))], n: X.length, markets: prepared.length, target };
}

/** Use a shared model on one market: predictions only count after its training cutoff. */
function applyPooled(pm, c, x, lastClosed, cost) {
  const predict = predictorFrom(pm);
  const H = RULES.maxBars + 1;
  const testStart = c.findIndex((k) => k.time > pm.cutoff);
  if (testStart < 0 || lastClosed - testStart < 50) return { ok: false };
  const probs = new Map(), tp = [], ty = [];
  for (let i = Math.max(210, testStart); i <= lastClosed; i++) {
    const f = featuresAt(c, x, i);
    if (!f) continue;
    const p = predict(f);
    probs.set(i, p);
    if (i + H <= lastClosed) { const yi = tradeWins(c, x, i, lastClosed, cost); if (yi != null) { tp.push(p); ty.push(yi); } }
  }
  const top = tp.map((p, k) => [p, ty[k]]).filter(([p]) => p >= pm.threshold);
  return {
    ok: true, shared: true, probs, threshold: pm.threshold, testStart: Math.max(210, testStart), pNow: probs.get(lastClosed) ?? null, H,
    test: { auc: auc(tp, ty), base: ty.length ? ty.reduce((a, v) => a + v, 0) / ty.length : NaN, hitTop: top.length ? top.filter(([, v]) => v).length / top.length : NaN, nTop: top.length, n: tp.length },
    weights: FEATURE_NAMES.map((name, j) => ({ name, w: pm.w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)),
  };
}

/** Would the standard trade signalled at candle i have made money after costs? (1/0, null if unfinished) */
function tradeWins(c, x, i, lastClosed, cost) {
  const e = i + 1;
  if (e + RULES.maxBars - 1 > lastClosed || !isFinite(x.atr14[i])) return null;
  const entry = c[e].open, d = riskDistance(x.atr14[i], entry, cost);
  const stop = entry - d, target = entry + (RULES.targetAtr / RULES.stopAtr) * d;
  let exit = c[e + RULES.maxBars - 1].close;
  for (let j = e; j < e + RULES.maxBars; j++) { const r = exitOnCandle(c[j], stop, target); if (r) { exit = r.exit; break; } }
  return (exit - entry) / entry - 2 * cost > 0 ? 1 : 0;
}

function safeTest(s, i, c, x) {
  try { return !!s.test(i, c, x) && isFinite(x.atr14[i]); } catch { return false; }
}

function backtest(c, x, setup, lastClosed, cost) {
  const trades = [];
  for (let i = RULES.warmup; i < lastClosed; i++) {
    if (!safeTest(setup, i, c, x)) continue;
    const entryIdx = i + 1;
    const entry = c[entryIdx].open;
    const d = riskDistance(x.atr14[i], entry, cost);
    const stop = entry - d;
    const target = entry + (RULES.targetAtr / RULES.stopAtr) * d;
    let exit = null, outcome = null, j = entryIdx;
    for (; j <= Math.min(entryIdx + RULES.maxBars - 1, lastClosed); j++) {
      const r = exitOnCandle(c[j], stop, target);
      if (r) { exit = r.exit; outcome = r.outcome; break; }
    }
    if (!outcome) {
      if (entryIdx + RULES.maxBars - 1 > lastClosed) break;         // not finished yet: don't count it
      j = entryIdx + RULES.maxBars - 1;
      exit = c[j].close; outcome = "timeout";
    }
    const net = (exit - entry) / entry - 2 * cost;
    trades.push({ signalTime: c[i].time, entryTime: c[entryIdx].time, exitTime: c[j].time, entry, exit, outcome, net, bars: j - entryIdx + 1, regime: regimeAt(c, x, i) });
    i = j; // no overlapping trades: next signal only after this one is closed
  }
  return trades;
}

/**
 * Did this candle take us out of the trade, and at what price?
 * - Opened beyond a level (a gap): you get the OPEN price, which is worse than the stop
 *   (or better than the target), not the level itself.
 * - Both levels inside one candle: we can't know which came first, so assume the stop (worst case).
 */
export function exitOnCandle(k, stop, target) {
  if (k.open <= stop) return { exit: k.open, outcome: "stop" };
  if (k.open >= target) return { exit: k.open, outcome: "target" };
  if (k.low <= stop) return { exit: stop, outcome: "stop" };
  if (k.high >= target) return { exit: target, outcome: "target" };
  return null;
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: NaN, ev: NaN };
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const mean = (a) => a.reduce((s, t) => s + t.net, 0) / (a.length || 1);
  const ev = mean(trades);
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? mean(losses) : 0;
  const winRate = wins.length / n;
  const [lo, hi] = wilson(wins.length, n);
  const breakeven = avgWin > 0 ? Math.abs(avgLoss) / (avgWin + Math.abs(avgLoss)) : 1;
  const half = Math.floor(n / 2);
  const evOld = n >= 10 ? mean(trades.slice(0, half)) : NaN;
  const evNew = n >= 10 ? mean(trades.slice(half)) : NaN;
  const targetHits = trades.filter((t) => t.outcome === "target").length;
  const bars = trades.map((t) => t.bars).sort((a, b) => a - b);
  // t-statistic of the average result: how many standard errors above zero it is.
  // ~1 means "probably positive", ~2 means "positive with ~95% confidence".
  const sd = n > 1 ? Math.sqrt(trades.reduce((s, t) => s + (t.net - ev) ** 2, 0) / (n - 1)) : NaN;
  const tStat = sd > 0 ? ev / (sd / Math.sqrt(n)) : 0;
  return {
    n, winRate, winLo: lo, winHi: hi, avgWin, avgLoss, ev, breakeven, sd, tStat,
    targetRate: targetHits / n,
    evOld, evNew,
    medianBars: bars[Math.floor(bars.length / 2)],
    total: trades.reduce((s, t) => s + t.net, 0),
  };
}

function verdictFor(s, strict = false) {
  const needT = strict ? 2.5 : 2;
  if (s.n < RULES.minTrades) return { level: "thin", label: "Too few", why: `Only ${s.n} past occurrences. Need ${RULES.minTrades}+ to measure.` };
  if (s.ev <= 0) return { level: "negative", label: "Loses money", why: "Average result after costs is negative." };
  if (s.tStat < 1)
    return { level: "flat", label: "No clear edge", why: `Slightly positive on average (${(s.ev * 100).toFixed(2)}%/trade), but so small compared with how much results vary that it's most likely luck.` };
  const consistent = s.evOld > 0 && s.evNew > 0;
  if (s.winLo > s.breakeven && consistent && s.tStat >= needT)
    return { level: "edge", label: "Strong record", why: "Profitable in its past record with about 95% statistical confidence, win rate above break-even even at the low end of its range, in both older and recent history. A past record isn't a promise: see the Scorecard for how BUY answers did on data they never saw." };
  return { level: "weak", label: "Weak edge", why: consistent
    ? "Profitable, and probably not just luck, but not proven: the win rate could still be at or below break-even."
    : "Profitable overall but not consistent: older and recent history disagree." };
}

/** 95% Wilson score interval for a win rate. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
