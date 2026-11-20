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

export const RULES = {
  stopAtr: 1.0,     // stop-loss distance in ATRs below entry
  targetAtr: 1.5,   // profit target distance in ATRs above entry
  maxBars: 24,      // give up and exit at market after this many candles
  minTrades: 30,    // below this, history is too thin to trust
  warmup: 200,      // candles needed before indicators are reliable
};

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
];

/**
 * Analyze one coin on one timeframe.
 * @param candles  oldest → newest; the LAST candle may still be forming and is never used as a signal.
 * @param costPerSide  fraction (0.0007 = 0.07%) charged on entry AND on exit (fee + half-spread).
 */
export function analyze(candles, { costPerSide = 0.0007, formingLast = true } = {}) {
  const x = computeAll(candles);
  const lastClosed = candles.length - (formingLast ? 2 : 1);
  const setups = SETUPS.map((s) => {
    const trades = backtest(candles, x, s, lastClosed, costPerSide);
    const stats = summarize(trades);
    const activeNow = lastClosed >= RULES.warmup && safeTest(s, lastClosed, candles, x);
    return { ...s, trades, stats, activeNow, verdict: verdictFor(stats) };
  });

  const a = x.atr14[lastClosed];
  const price = candles[candles.length - 1].close;
  const active = setups.filter((s) => s.activeNow);
  const rank = { edge: 3, weak: 2, thin: 1, negative: 0 };
  active.sort((p, q) => rank[q.verdict.level] - rank[p.verdict.level] || q.stats.ev - p.stats.ev);
  const best = active[0] || null;

  let overall;
  if (!best) overall = { level: "wait", label: "WAIT", text: "No setup is active right now. Nothing to do, which is often the right call." };
  else if (best.verdict.level === "edge") overall = { level: "go", label: "GO", text: `${best.name} is active, and it has a measured, positive edge on this coin and timeframe after costs.` };
  else if (best.verdict.level === "weak") overall = { level: "caution", label: "CAUTION", text: `${best.name} is active and has been slightly profitable after costs, but the edge isn't statistically clear. Small size or skip.` };
  else if (best.verdict.level === "thin") overall = { level: "caution", label: "UNPROVEN", text: `${best.name} is active, but it has happened too few times here to measure. Treat it as unproven.` };
  else overall = { level: "no", label: "NO TRADE", text: `${best.name} is active, but historically it has lost money after costs on this coin and timeframe. Skip it.` };

  const plan = best && isFinite(a) ? {
    setup: best.id,
    entry: price,
    stop: price - RULES.stopAtr * a,
    target: price + RULES.targetAtr * a,
    stopPct: (RULES.stopAtr * a) / price,
    targetPct: (RULES.targetAtr * a) / price,
    medianBars: best.stats.medianBars,
  } : null;

  return {
    setups, overall, best, plan, costPerSide,
    sample: {
      candles: Math.max(0, lastClosed - RULES.warmup),
      from: candles[RULES.warmup]?.time, to: candles[lastClosed]?.time,
    },
  };
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
    const a = x.atr14[i];
    const stop = entry - RULES.stopAtr * a;
    const target = entry + RULES.targetAtr * a;
    let exit = null, outcome = null, j = entryIdx;
    for (; j <= Math.min(entryIdx + RULES.maxBars - 1, lastClosed); j++) {
      const hitStop = c[j].low <= stop;
      const hitTarget = c[j].high >= target;
      if (hitStop) { exit = stop; outcome = "stop"; break; }       // if both in one candle, assume the worst
      if (hitTarget) { exit = target; outcome = "target"; break; }
    }
    if (!outcome) {
      if (entryIdx + RULES.maxBars - 1 > lastClosed) break;         // not finished yet: don't count it
      j = entryIdx + RULES.maxBars - 1;
      exit = c[j].close; outcome = "timeout";
    }
    const net = (exit - entry) / entry - 2 * cost;
    trades.push({ signalTime: c[i].time, entryTime: c[entryIdx].time, exitTime: c[j].time, entry, exit, outcome, net, bars: j - entryIdx + 1 });
    i = j; // no overlapping trades: next signal only after this one is closed
  }
  return trades;
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
  return {
    n, winRate, winLo: lo, winHi: hi, avgWin, avgLoss, ev, breakeven,
    targetRate: targetHits / n,
    evOld, evNew,
    medianBars: bars[Math.floor(bars.length / 2)],
    total: trades.reduce((s, t) => s + t.net, 0),
  };
}

function verdictFor(s) {
  if (s.n < RULES.minTrades) return { level: "thin", label: "Too few", why: `Only ${s.n} past occurrences. Need ${RULES.minTrades}+ to measure.` };
  if (s.ev <= 0) return { level: "negative", label: "Loses money", why: "Average result after costs is negative." };
  const consistent = s.evOld > 0 && s.evNew > 0;
  if (s.winLo > s.breakeven && consistent)
    return { level: "edge", label: "Proven edge", why: "Win rate is above break-even even at the low end of its range, in both older and recent history." };
  return { level: "weak", label: "Weak edge", why: consistent
    ? "Slightly profitable, but the win rate could plausibly be at or below break-even."
    : "Profitable overall but not consistent: older and recent history disagree." };
}

/** 95% Wilson score interval for a win rate. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
