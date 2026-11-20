// Forecast: where price is likely to be over the next H candles, MEASURED from this coin's
// own history (not a guess). For every past moment we look at how far price moved 1..H candles
// later, and take the middle 50% and 80% of those moves. Then we check the forecast's own
// accuracy on data it wasn't built from (how often price really finished inside the range),
// and the measured odds of being higher or lower.
import { ema } from "./indicators.js";

const QS = [0.1, 0.25, 0.5, 0.75, 0.9];
const LOOKBACK = 2500;

function quantiles(arr, qs) {
  const s = Float64Array.from(arr).sort();
  return qs.map((q) => {
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  });
}

/**
 * @param candles oldest→newest; the last one may be forming (its close is the live price).
 * @param intervalSec seconds per candle
 */
export function forecast(candles, intervalSec, H = 20) {
  const closed = candles.slice(0, -1).slice(-LOOKBACK - H);
  const n = closed.length;
  if (n < 300) return null;
  const close = closed.map((c) => c.close);
  const live = candles[candles.length - 1].close;
  const t0 = candles[candles.length - 1].time;

  // Volatility right now vs. then: moves are measured in units of the volatility at the time
  // (stdev of 1-candle moves over the previous VOLN candles), then scaled to today's volatility.
  // This keeps the range honest when the market gets calmer or wilder.
  const VOLN = 50;
  const lr = close.map((c, i) => (i ? Math.log(c / close[i - 1]) : 0));
  const vol = new Array(n).fill(NaN);
  let s = 0, s2 = 0;
  for (let i = 1; i < n; i++) {
    s += lr[i]; s2 += lr[i] * lr[i];
    if (i > VOLN) { s -= lr[i - VOLN]; s2 -= lr[i - VOLN] * lr[i - VOLN]; }
    if (i >= VOLN) { const m = s / VOLN; vol[i] = Math.sqrt(Math.max(1e-12, s2 / VOLN - m * m)); }
  }
  const volNow = vol[n - 1];
  const z = (t, h) => Math.log(close[t + h] / close[t]) / (vol[t] * Math.sqrt(h));

  const bands = [];
  for (let h = 1; h <= H; h++) {
    const r = [];
    for (let t = VOLN; t + h < n; t++) r.push(z(t, h));
    const q = quantiles(r, QS);
    bands.push({ time: t0 + h * intervalSec, q: q.map((x) => live * Math.exp(x * volNow * Math.sqrt(h))) });
  }

  // Accuracy check on unseen data: build the H-step range from the older 60%, test on the newest 40%.
  const zH = [];
  for (let t = VOLN; t + H < n; t++) zH.push(z(t, H));
  const split = Math.floor(zH.length * 0.6);
  const [q10, q25, , q75, q90] = quantiles(zH.slice(0, split), QS);
  const test = zH.slice(split);
  const in80 = test.filter((x) => x >= q10 && x <= q90).length / test.length;
  const in50 = test.filter((x) => x >= q25 && x <= q75).length / test.length;

  // Direction: overall, and when the trend looked like it does now (price vs its 50-EMA)
  const e50 = ema(close, 50);
  const nowAbove = live > e50[n - 1];
  let up = 0, all = 0, upC = 0, allC = 0;
  for (let t = 50; t + H < n; t++) {
    const isUp = close[t + H] > close[t];
    all++; if (isUp) up++;
    if ((close[t] > e50[t]) === nowAbove) { allC++; if (isUp) upC++; }
  }

  const last = bands[bands.length - 1].q;
  return {
    H, intervalSec, live, t0, bands,
    range80: [last[0], last[4]], range50: [last[1], last[3]], mid: last[2],
    accuracy80: in80, accuracy50: in50, tested: test.length,
    pUp: up / all, nUp: all,
    pUpTrend: allC ? upC / allC : NaN, nTrend: allC, trendLabel: nowAbove ? "above its 50-candle average (uptrend)" : "below its 50-candle average (downtrend)",
    samples: n,
  };
}

export function describeOdds(p) {
  if (!isFinite(p)) return "unknown";
  const d = Math.abs(p - 0.5);
  if (d < 0.03) return "a coin flip, no real direction";
  if (d < 0.07) return p > 0.5 ? "a slight lean up" : "a slight lean down";
  return p > 0.5 ? "a clear lean up" : "a clear lean down";
}

export function reliability(acc80) {
  if (!isFinite(acc80)) return { label: "unknown", level: "mid" };
  const off = Math.abs(acc80 - 0.8);
  if (off <= 0.05) return { label: "reliable", level: "good" };
  if (off <= 0.12) return { label: "fairly reliable", level: "mid" };
  return { label: acc80 < 0.8 ? "unreliable: price broke out of the range more than expected" : "too wide (overly cautious)", level: "bad" };
}
