// Entryvex Stock Rank: a monthly ranking model for large US stocks, with an honest track record.
//
// Every month-end, each stock gets a score from three well-documented factors, using ONLY prices
// up to that month (no look-ahead):
//   • Momentum (12-1): return over the past 12 months, skipping the most recent month.
//   • Trend: price vs its 10-month average.
//   • Low volatility: steadier stocks score higher (volatility of the last 12 monthly returns).
// Each factor is turned into a cross-sectional z-score (capped at ±3) and combined with weights
// that were FIXED before testing, never tuned to the results:
//   score = 0.50·z(momentum) + 0.25·z(trend) − 0.25·z(volatility)
// The model holds the top N stocks, equal-weighted, re-ranked monthly, paying trading costs on
// every change. Because the weights are not fitted, every month of the record is out-of-sample
// with respect to the weights. (The stock list is today's large companies; see `notes`.)

export const WEIGHTS = { momentum: 0.5, trend: 0.25, volatility: -0.25 };
export const DEFAULTS = { top: 10, costPerSide: 0.001, minHistory: 13 };

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

/**
 * Factor values for one stock at month index t of its price series (closes, oldest first).
 * Returns null without enough history.
 */
export function factorsAt(closes, t) {
  if (t < 12 || closes[t] == null) return null;
  const w = closes.slice(t - 12, t + 1);
  if (w.some((v) => !(v > 0))) return null;
  const momentum = w[11] / w[0] - 1;                    // P[t-1] / P[t-12] − 1
  const rets = [];
  for (let i = 1; i < w.length; i++) rets.push(Math.log(w[i] / w[i - 1]));
  const volatility = sd(rets) * Math.sqrt(12);          // annualized
  const sma10 = mean(w.slice(-10));
  const trend = w[12] / sma10 - 1;
  return { momentum, trend, volatility };
}

function zscores(vals) {
  const m = mean(vals), s = sd(vals);
  return vals.map((v) => (s > 0 ? Math.max(-3, Math.min(3, (v - m) / s)) : 0));
}

/**
 * Rank all stocks at a month index. `series` is { SYM: closes[] } aligned on the same months.
 * Returns [{ sym, score, rank, momentum, trend, volatility, z: {...} }] best first.
 */
export function rankAt(series, t) {
  const rows = [];
  for (const [sym, closes] of Object.entries(series)) {
    const f = factorsAt(closes, t);
    if (f) rows.push({ sym, ...f });
  }
  if (rows.length < 5) return [];
  const zm = zscores(rows.map((r) => r.momentum));
  const zt = zscores(rows.map((r) => r.trend));
  const zv = zscores(rows.map((r) => r.volatility));
  rows.forEach((r, i) => {
    r.z = { momentum: zm[i], trend: zt[i], volatility: zv[i] };
    r.score = WEIGHTS.momentum * zm[i] + WEIGHTS.trend * zt[i] + WEIGHTS.volatility * zv[i];
  });
  rows.sort((a, b) => b.score - a.score || a.sym.localeCompare(b.sym));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

/**
 * Walk-forward test. `months` = month keys (YYYY-MM), `series` = aligned closes (null = no data),
 * `bench` = benchmark closes on the same months (e.g. SPY, dividends included).
 * At each month-end t: rank with data ≤ t, hold the top N from t to t+1.
 */
export function backtest(months, series, bench, opts = {}) {
  const { top, costPerSide } = { ...DEFAULTS, ...opts };
  const out = [];
  let held = new Set();
  let eqModel = 1, eqAll = 1, eqBench = 1;
  for (let t = 12; t < months.length - 1; t++) {
    const ranked = rankAt(series, t);
    // Only stocks that also have a price next month can be held (a stock without one is dropped from both sides).
    const tradable = ranked.filter((r) => series[r.sym][t + 1] > 0);
    if (tradable.length < top * 2 || !(bench[t] > 0) || !(bench[t + 1] > 0)) continue;
    const picks = tradable.slice(0, top).map((r) => r.sym);
    const ret = (s) => series[s][t + 1] / series[s][t] - 1;
    const gross = mean(picks.map(ret));
    // Turnover: share of the portfolio replaced this month (each replaced slot = sell + buy).
    const changed = held.size ? picks.filter((s) => !held.has(s)).length / top : 1;
    const cost = changed * 2 * costPerSide;
    const model = gross - cost;
    const all = mean(tradable.map((r) => ret(r.sym)));
    const b = bench[t + 1] / bench[t] - 1;
    eqModel *= 1 + model; eqAll *= 1 + all; eqBench *= 1 + b;
    out.push({ month: months[t + 1], picks, model, all, bench: b, turnover: changed, eqModel, eqAll, eqBench });
    held = new Set(picks);
  }
  return { months: out, stats: summarize(out) };
}

/** Max peak-to-trough fall of an equity curve. */
export function maxDrawdown(eq) {
  let peak = -Infinity, dd = 0;
  for (const v of eq) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  return dd;
}

/** One-sided t-statistic of the mean of x. */
export function tStat(x) {
  if (x.length < 3) return NaN;
  const s = sd(x);
  return s > 0 ? mean(x) / (s / Math.sqrt(x.length)) : NaN;
}

function cagr(rets) {
  const g = rets.reduce((p, r) => p * (1 + r), 1);
  return rets.length ? g ** (12 / rets.length) - 1 : NaN;
}

export function summarize(rows) {
  if (rows.length < 12) return null;
  const m = rows.map((r) => r.model), a = rows.map((r) => r.all), b = rows.map((r) => r.bench);
  const exB = rows.map((r) => r.model - r.bench), exA = rows.map((r) => r.model - r.all);
  const half = Math.floor(rows.length / 2);
  const part = (lo, hi) => ({ model: cagr(m.slice(lo, hi)), bench: cagr(b.slice(lo, hi)), all: cagr(a.slice(lo, hi)) });
  const last = (k) => ({ model: m.slice(-k).reduce((p, r) => p * (1 + r), 1) - 1, bench: b.slice(-k).reduce((p, r) => p * (1 + r), 1) - 1, all: a.slice(-k).reduce((p, r) => p * (1 + r), 1) - 1 });
  return {
    n: rows.length, from: rows[0].month, to: rows.at(-1).month,
    cagr: { model: cagr(m), bench: cagr(b), all: cagr(a) },
    vol: { model: sd(m) * Math.sqrt(12), bench: sd(b) * Math.sqrt(12), all: sd(a) * Math.sqrt(12) },
    maxDD: { model: maxDrawdown(rows.map((r) => r.eqModel)), bench: maxDrawdown(rows.map((r) => r.eqBench)), all: maxDrawdown(rows.map((r) => r.eqAll)) },
    beatBench: exB.filter((x) => x > 0).length / rows.length,
    beatAll: exA.filter((x) => x > 0).length / rows.length,
    tBench: tStat(exB), tAll: tStat(exA),
    avgTurnover: mean(rows.map((r) => r.turnover)),
    firstHalf: part(0, half), secondHalf: part(half, rows.length),
    last12: rows.length >= 12 ? last(12) : null,
    last36: rows.length >= 36 ? last(36) : null,
  };
}

/** Plain verdict on the record, using the same standard as the trade engine (t ≥ 2 = evidence). */
export function verdict(stats) {
  if (!stats) return { level: "thin", label: "Not enough history" };
  const halvesOk = stats.firstHalf.model > stats.firstHalf.all && stats.secondHalf.model > stats.secondHalf.all;
  if (stats.tAll >= 2 && halvesOk) return { level: "edge", label: "Beat its own stock list, consistently" };
  if (stats.tAll >= 1 && stats.cagr.model > stats.cagr.all) return { level: "weak", label: "Ahead, but not proven" };
  if (stats.cagr.model > stats.cagr.all) return { level: "flat", label: "Slightly ahead, could be luck" };
  return { level: "negative", label: "Behind its own stock list" };
}

/**
 * Align monthly bars from several symbols on one month axis.
 * `bars` = { SYM: [{ month: "YYYY-MM", close }] }. Returns { months, series: { SYM: (number|null)[] } }.
 */
export function alignMonthly(bars) {
  const set = new Set();
  for (const list of Object.values(bars)) for (const b of list) set.add(b.month);
  const months = [...set].sort();
  const idx = new Map(months.map((m, i) => [m, i]));
  const series = {};
  for (const [sym, list] of Object.entries(bars)) {
    const arr = new Array(months.length).fill(null);
    for (const b of list) if (b.close > 0) arr[idx.get(b.month)] = b.close;
    series[sym] = arr;
  }
  return { months, series };
}
