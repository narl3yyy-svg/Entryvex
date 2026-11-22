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
import { trainModel } from "./model.js";

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
export function analyze(candles, { costPerSide = 0.0007, formingLast = true, useModel = true } = {}) {
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
    try { model = trainModel(candles, x, lastClosed, costPerSide); } catch { model = null; }
  }
  if (model?.ok) {
    const ms = {
      id: "model", name: "Entryvex model", model: true, strict: true,
      plain: `Entryvex's prediction model is confident price will be higher after ${model.H} candles (it learned from this market's older history and was tested on the newest part it never saw).`,
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
  const rank = { edge: 3, weak: 2, thin: 1, flat: 0.5, negative: 0 };
  active.sort((p, q) => rank[q.verdict.level] - rank[p.verdict.level] || q.stats.ev - p.stats.ev);
  const best = active[0] || null;

  const liquidity = checkLiquidity(candles, lastClosed);

  let overall;
  if (!liquidity.ok) overall = { level: "no", label: "ILLIQUID", text: liquidity.reason };
  else if (!best) overall ={ level: "wait", label: "WAIT", text: "No setup is active right now. Nothing to do, which is often the right call." };
  else if (best.verdict.level === "edge") overall = { level: "go", label: "GO", text: `${best.name} is active, and it has a measured, positive edge on this coin and timeframe after costs.` };
  else if (best.verdict.level === "weak") overall = { level: "caution", label: "CAUTION", text: `${best.name} is active and has been slightly profitable after costs, but the edge isn't statistically clear. Small size or skip.` };
  else if (best.verdict.level === "thin") overall = { level: "caution", label: "UNPROVEN", text: `${best.name} is active, but it has happened too few times here to measure. Treat it as unproven.` };
  else if (best.verdict.level === "flat") overall = { level: "no", label: "NO TRADE", text: `${best.name} is active, but after costs it has roughly broken even here. Any profit so far looks like luck. Skip it.` };
  else overall ={ level: "no", label: "NO TRADE", text: `${best.name} is active, but historically it has lost money after costs on this coin and timeframe. Skip it.` };

  const d = isFinite(a) ? riskDistance(a, price, costPerSide) : NaN;
  const plan = liquidity.ok && best && isFinite(a) ? {
    setup: best.id,
    entry: price,
    stop: price - d,
    target: price + (RULES.targetAtr / RULES.stopAtr) * d,
    stopPct: d / price,
    targetPct: ((RULES.targetAtr / RULES.stopAtr) * d) / price,
    medianBars: best.stats.medianBars,
  } : null;

  const triggers = buyTriggers(candles, x, lastClosed, setups, price);

  return {
    setups, overall, best, plan, costPerSide, atr: a, price, liquidity, triggers,
    regime: { now: regimeNow, label: REGIME_LABEL[regimeNow] },
    model: model?.ok ? { pNow: model.pNow, threshold: model.threshold, H: model.H, test: model.test, weights: model.weights } : null,
    sample: {
      candles: Math.max(0, lastClosed - RULES.warmup),
      from: candles[RULES.warmup]?.time, to: candles[lastClosed]?.time,
    },
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
    return { level: "edge", label: "Proven edge", why: "Profitable with about 95% statistical confidence, win rate above break-even even at the low end of its range, in both older and recent history." };
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
