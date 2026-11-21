// Measuring the AI news reader: did its score predict the next 24 hours?
//
// Each recorded read = { t (ms), s (score −1…+1), p (price then) }. For each read old enough, the
// return over the following `hours` is taken from hourly candles. Then:
//   • only reads with an opinion (|score| ≥ 0.1) are judged;
//   • reads are thinned so no two are within `hours` of each other (overlapping windows would
//     count the same price move many times and fake significance);
//   • the market's own drift is removed (if a coin rose all month, "positive" calls would look
//     right for free), and we test whether sign(score) × (return − average return) is above zero.
// Verdict uses the same bar as the trade engine: t ≥ 2 with enough independent cases.
// Pure functions, testable without the network.

export const MIN_CASES = 20;

/** Close of the first hourly candle at/after `ms` (null if the gap is over 4 days, e.g. missing data). */
function priceAt(bars, ms) {
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].time * 1000 >= ms) { k = m; hi = m - 1; } else lo = m + 1; }
  if (k < 0) return null;
  if (bars[k].time * 1000 - ms > 4 * 86400e3) return null;
  return bars[k].close;
}

/**
 * @param log   [{ t, s, p }]
 * @param bars  hourly candles, oldest first: { time (s), close }
 */
export function evaluateNews(log, bars, hours = 24) {
  const H = hours * 3600e3;
  const last = bars.length ? bars.at(-1).time * 1000 : 0;
  const rows = [];
  for (const e of [...log].sort((a, b) => a.t - b.t)) {
    if (!(e.p > 0) || !isFinite(e.s) || e.t + H > last) continue;
    const later = priceAt(bars, e.t + H);
    if (!(later > 0)) continue;
    rows.push({ t: e.t, s: e.s, ret: later / e.p - 1 });
  }
  const pending = log.filter((e) => e.t + H > last).length;
  // Independent sample: at least `hours` apart, with an opinion.
  const indep = [];
  for (const r of rows) {
    if (Math.abs(r.s) < 0.1) continue;
    if (indep.length && r.t - indep.at(-1).t < H) continue;
    indep.push(r);
  }
  const n = indep.length;
  const out = { reads: log.length, measured: rows.length, pending, cases: n };
  if (n < 2) return { ...out, verdict: verdict(n, NaN, NaN) };
  const drift = rows.reduce((a, r) => a + r.ret, 0) / rows.length;
  const x = indep.map((r) => Math.sign(r.s) * (r.ret - drift));
  const mean = x.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(x.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN;
  const hit = indep.filter((r) => Math.sign(r.s) === Math.sign(r.ret)).length / n;
  const pos = indep.filter((r) => r.s > 0), neg = indep.filter((r) => r.s < 0);
  const avg = (a) => (a.length ? a.reduce((s, r) => s + r.ret, 0) / a.length : NaN);
  return { ...out, hit, t, edgePerCase: mean, drift, afterPositive: { n: pos.length, avg: avg(pos) }, afterNegative: { n: neg.length, avg: avg(neg) },
    calibration: calibrate(indep, drift), verdict: verdict(n, t, hit) };
}

/**
 * "Learning" from the record: a least-squares fit of the next-24h move (beyond the market's drift)
 * on the AI's score, using only independent days. The slope says how much a given score has really
 * been worth, e.g. slope 0.012 → a +0.5 read has meant about +0.6% over 24 hours.
 * Cheap (a few multiplications), no storage, refits itself as the record grows.
 */
export function calibrate(rows, drift = 0) {
  const n = rows.length;
  if (n < MIN_CASES) return null;
  const xs = rows.map((r) => r.s), ys = rows.map((r) => r.ret - drift);
  const mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx, intercept = my - slope * mx;
  const resid = ys.map((y, i) => y - intercept - slope * xs[i]);
  const se = Math.sqrt(resid.reduce((a, v) => a + v * v, 0) / (n - 2) / sxx);
  return { slope, intercept, tSlope: se > 0 ? slope / se : NaN, n };
}

/** Expected extra 24-hour move for a score, from a calibration (null if it isn't significant). */
export function expectedMove(cal, score) {
  if (!cal || !(cal.tSlope >= 2)) return null;
  return cal.slope * score;
}

export function verdict(n, t, hit) {
  if (n < MIN_CASES) return { level: "collecting", label: `Collecting evidence (${n} of ${MIN_CASES} independent days)`, helps: false };
  if (t >= 2 && hit > 0.5) return { level: "helps", label: "Proven to help", helps: true };
  if (t <= -2) return { level: "misleading", label: "Has been misleading", helps: false };
  return { level: "none", label: "No proven effect yet", helps: false };
}

/** Combine several markets' evaluations into one (cases are independent across markets). */
export function pool(evals) {
  const ok = evals.filter((e) => e && e.cases >= 2 && isFinite(e.t));
  const n = ok.reduce((s, e) => s + e.cases, 0);
  if (!n) return { cases: 0, verdict: verdict(0, NaN, NaN) };
  // Stouffer's method: combine t-scores weighted by √n.
  const z = ok.reduce((s, e) => s + e.t * Math.sqrt(e.cases), 0) / Math.sqrt(ok.reduce((s, e) => s + e.cases, 0));
  const hit = ok.reduce((s, e) => s + e.hit * e.cases, 0) / n;
  return { cases: n, markets: ok.length, t: z, hit, verdict: verdict(n, z, hit) };
}
