// Entryvex model: one prediction that combines everything Entryvex reads from the chart.
//
// For every candle it measures a set of features (trend, momentum, RSI, distance from averages,
// volume surge, breakouts, candlestick patterns, rising/falling market) and learns, on THIS market
// and candle size, how they relate to "price is higher than the trading costs after H candles".
// The learner is a regularized logistic regression: small, fast, and hard to over-fit.
//
// Honest testing (walk-forward): it's trained on the older 70% of history only, then judged on the
// newest 30% it has never seen, with a gap between them so no future data leaks in. Its buy signal
// is replayed on that unseen part with the same stop, target, time limit and costs as every other
// setup, and only counts when that record holds up. Pure functions, no DOM.
import { PATTERNS } from "./patterns.js";

const BULL = PATTERNS.filter((p) => p.dir === 1), BEAR = PATTERNS.filter((p) => p.dir === -1);
export const MODEL = { H: 20, trainFrac: 0.7, iters: 250, lr: 0.3, l2: 0.02, topFrac: 0.2 };
export const FEATURE_NAMES = ["1-candle move", "5-candle move", "20-candle move", "RSI", "vs 20-average", "20 vs 50 average",
  "rising market", "volume surge", "20-candle breakout", "bullish pattern", "bearish pattern", "volatility"];

/** Feature vector at candle i (null if indicators aren't ready). */
export function featuresAt(c, x, i) {
  const a = x.atr14[i], cl = c[i].close;
  if (!(a > 0) || i < 210 || !isFinite(x.ema200[i]) || !isFinite(x.rsi14[i])) return null;
  const r = (k) => Math.log(cl / c[i - k].close) / ((a / cl) * Math.sqrt(k));   // move in "typical moves"
  let bull = 0, bear = 0;
  for (const p of BULL) { try { if (p.test(c, i, x)) { bull = 1; break; } } catch {} }
  for (const p of BEAR) { try { if (p.test(c, i, x)) { bear = 1; break; } } catch {} }
  return [
    r(1), r(5), r(20),
    (x.rsi14[i] - 50) / 25,
    (cl - x.ema20[i]) / a,
    (x.ema20[i] - x.ema50[i]) / a,
    cl >= x.ema200[i] ? 1 : -1,
    Math.log(Math.max(1e-9, c[i].volume || 0) / Math.max(1e-9, x.volAvg20[i] || 1)),
    cl > x.high20[i] ? 1 : 0,
    bull, bear,
    Math.log((a / cl) / Math.max(1e-9, x.atr14[i - 50] / c[i - 50].close)),
  ].map((v) => (isFinite(v) ? Math.max(-6, Math.min(6, v)) : 0));
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Logistic regression with L2, full-batch gradient descent on standardized features. */
export function fitLogistic(X, y, { iters = MODEL.iters, lr = MODEL.lr, l2 = MODEL.l2 } = {}) {
  const n = X.length, d = X[0].length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const row of X) row.forEach((v, j) => (mu[j] += v / n));
  for (const row of X) row.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / n));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((row) => row.map((v, j) => (v - mu[j]) / sd[j]));
  const w = new Array(d).fill(0);
  const base = y.reduce((s, v) => s + v, 0) / n;
  let b = Math.log(Math.max(1e-6, base) / Math.max(1e-6, 1 - base));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let k = 0; k < n; k++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Z[k][j];
      const e = sigmoid(z) - y[k];
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * Z[k][j];
    }
    b -= (lr * gb) / n;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return { w, b, mu, sd, predict: (f) => { let z = b; for (let j = 0; j < d; j++) z += w[j] * ((f[j] - mu[j]) / sd[j]); return sigmoid(z); } };
}

/** Area under the ROC curve: 0.5 = no skill, 1 = perfect ranking. */
export function auc(p, y) {
  const pos = [], neg = [];
  p.forEach((v, i) => (y[i] ? pos : neg).push(v));
  if (!pos.length || !neg.length) return NaN;
  const all = p.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (all[k][1]) rankSum += avgRank;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/**
 * Train on the older part, test on the newest part.
 * Returns { ok, probs (per candle index, test part + now), threshold, testStart, pNow, test: { auc, base, hitTop, n } , weights }.
 */
export function trainModel(c, x, lastClosed, costPerSide) {
  const H = MODEL.H;
  const first = 210, lastLabeled = lastClosed - H;
  if (lastLabeled - first < 600) return { ok: false, reason: "not enough history" };
  const split = Math.floor(first + (lastLabeled - first) * MODEL.trainFrac);
  const need = 1 + 2 * costPerSide;
  const X = [], y = [];
  for (let i = first; i <= split - H; i++) {        // gap of H candles before the test part
    const f = featuresAt(c, x, i);
    if (!f) continue;
    X.push(f); y.push(c[i + H].close > c[i].close * need ? 1 : 0);
  }
  if (X.length < 400 || y.every((v) => v === y[0])) return { ok: false, reason: "not enough varied history" };
  const m = fitLogistic(X, y);
  const trainP = X.map((f) => m.predict(f)).sort((a, b) => a - b);
  const threshold = Math.max(0.5, trainP[Math.floor(trainP.length * (1 - MODEL.topFrac))]);
  const probs = new Map();
  const tp = [], ty = [];
  for (let i = split; i <= lastClosed; i++) {
    const f = featuresAt(c, x, i);
    if (!f) continue;
    const p = m.predict(f);
    probs.set(i, p);
    if (i <= lastLabeled) { tp.push(p); ty.push(c[i + H].close > c[i].close * need ? 1 : 0); }
  }
  const base = ty.length ? ty.reduce((s, v) => s + v, 0) / ty.length : NaN;
  const top = tp.map((p, k) => [p, ty[k]]).filter(([p]) => p >= threshold);
  const hitTop = top.length ? top.filter(([, v]) => v).length / top.length : NaN;
  const pNow = probs.get(lastClosed) ?? null;
  return {
    ok: true, probs, threshold, testStart: split, pNow, H,
    test: { auc: auc(tp, ty), base, hitTop, nTop: top.length, n: tp.length },
    weights: FEATURE_NAMES.map((name, j) => ({ name, w: m.w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)),
  };
}
