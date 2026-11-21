// "It just jumped — should I chase it?"
// Measures the last few candles' move against this market's own history:
//   • how unusual the move is (percentile among all moves of the same length), and
//   • what happened next after past moves at least this big in the same direction
//     (share that ended higher H candles later, and the average return).
// Pure function, no network: works on the candles already loaded for the chart.

/**
 * @param {{close:number}[]} bars  candles, oldest first (the last one may be the live candle)
 * @param {number} k   move length in candles
 * @param {number} H   how far ahead to look after past moves
 * @param {number} [livePrice]  latest price (defaults to the last close)
 */
export function recentMove(bars, k = 3, H = 20, livePrice) {
  const c = bars.map((b) => b.close).filter((v) => v > 0);
  const n = c.length;
  if (n < 300 || k < 1) return null;
  const now = livePrice > 0 ? livePrice : c[n - 1];
  const from = c[n - 1 - k];
  const ret = now / from - 1;

  // Volatility-normalize so calm and wild periods compare fairly: z = move / recent typical move.
  const lr = [];
  for (let i = 1; i < n; i++) lr.push(Math.log(c[i] / c[i - 1]));
  const W = 100;
  const sdAt = (i) => {   // std of 1-candle log returns over the W candles ending at candle i (exclusive of later data)
    const a = Math.max(0, i - W), seg = lr.slice(a, i);
    if (seg.length < 20) return NaN;
    const m = seg.reduce((s, v) => s + v, 0) / seg.length;
    return Math.sqrt(seg.reduce((s, v) => s + (v - m) ** 2, 0) / (seg.length - 1));
  };
  const zOf = (i) => { const sd = sdAt(i - k) * Math.sqrt(k); return sd > 0 ? Math.log(c[i] / c[i - k]) / sd : NaN; };
  const zNow = (() => { const sd = sdAt(n - 1 - k) * Math.sqrt(k); return sd > 0 ? Math.log(now / from) / sd : NaN; })();
  if (!isFinite(zNow)) return null;

  // Percentile of |move| among all past k-candle moves.
  const absZ = [];
  for (let i = W + k; i < n - 1; i++) { const z = zOf(i); if (isFinite(z)) absZ.push(Math.abs(z)); }
  const pct = absZ.length ? absZ.filter((z) => z < Math.abs(zNow)).length / absZ.length : NaN;

  // Past moves at least this big in the same direction (non-overlapping), and what came next.
  const dir = Math.sign(zNow) || 1;
  const thr = Math.max(Math.abs(zNow), 0.5);
  const fwd = [];
  for (let i = W + k; i < n - 1 - H; i++) {
    const z = zOf(i);
    if (!isFinite(z) || z * dir < thr) continue;
    fwd.push(c[i + H] / c[i] - 1);
    i += k;   // skip ahead so one long run isn't counted many times
  }
  const cases = fwd.length;
  const higher = cases ? fwd.filter((r) => r > 0).length / cases : NaN;
  const avg = cases ? fwd.reduce((s, v) => s + v, 0) / cases : NaN;
  // Is "higher" share distinguishable from a coin flip? (normal approx, 95%)
  const se = cases ? Math.sqrt(0.25 / cases) : NaN;
  const clear = cases >= 30 && Math.abs(higher - 0.5) > 1.96 * se;
  return { k, H, ret, change: now - from, z: zNow, percentile: pct, cases, higher, avg, clear, dir };
}
