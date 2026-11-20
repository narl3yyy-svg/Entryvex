// Technical indicators. Every value at index i uses only candles 0..i (no look-ahead).
// Arrays are aligned with the input candles; early values are NaN until enough data exists.

export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN, sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      sum += values[i];
      if (i === period - 1) { prev = sum / period; out[i] = prev; }
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function stdev(values, period) {
  const out = new Array(values.length).fill(NaN);
  const mean = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - mean[i]) ** 2;
    out[i] = Math.sqrt(s / period);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= period) {
      gain += g; loss += l;
      if (i === period) { gain /= period; loss /= period; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
      continue;
    }
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder's Average True Range. */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(NaN);
  let prev = NaN, sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr = i === 0 ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    if (i < period) {
      sum += tr;
      if (i === period - 1) { prev = sum / period; out[i] = prev; }
      continue;
    }
    prev = (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}

/** Highest high / lowest low of the `period` candles BEFORE index i (excludes i itself). */
export function priorHigh(candles, period) {
  const out = new Array(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let h = -Infinity;
    for (let j = i - period; j < i; j++) h = Math.max(h, candles[j].high);
    out[i] = h;
  }
  return out;
}

export function computeAll(candles) {
  const close = candles.map((c) => c.close);
  const vol = candles.map((c) => c.volume);
  const bbMid = sma(close, 20);
  const bbSd = stdev(close, 20);
  return {
    close,
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    rsi14: rsi(close, 14),
    atr14: atr(candles, 14),
    volAvg20: sma(vol, 20),
    bbLower: bbMid.map((m, i) => m - 2 * bbSd[i]),
    bbUpper: bbMid.map((m, i) => m + 2 * bbSd[i]),
    high20: priorHigh(candles, 20),
  };
}
