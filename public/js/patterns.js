// Candlestick pattern recognition, using the standard definitions found in common candlestick
// pattern guides (Nison's Japanese candlestick rules as popularized online).
//
// Every pattern needs the right CONTEXT: a bullish reversal only counts after a decline, a bearish
// one only after a rise. Sizes are judged against the market's own recent candles (average body
// over the last 14), so the same rules work on BTC 1-minute and Apple daily.
//
// Entryvex never assumes a pattern works: bullish patterns are tested as buy setups by the engine
// (win rate and profit after costs on THIS market and candle size), and bearish ones are measured
// by what price did afterwards. Pure functions, no DOM.

const bodyOf = (k) => Math.abs(k.close - k.open);
const rangeOf = (k) => k.high - k.low;
const upperOf = (k) => k.high - Math.max(k.open, k.close);
const lowerOf = (k) => Math.min(k.open, k.close) - k.low;
const green = (k) => k.close > k.open;
const red = (k) => k.close < k.open;

const avgCache = new WeakMap();
/** Average candle body over the 14 candles before i (cached per candle array). */
function avgBody(c, i) {
  let arr = avgCache.get(c);
  if (!arr || arr.length !== c.length) {
    arr = new Array(c.length).fill(NaN);
    let sum = 0;
    for (let j = 0; j < c.length; j++) {
      sum += bodyOf(c[j]);
      if (j >= 14) sum -= bodyOf(c[j - 14]);
      if (j >= 13) arr[j] = sum / 14;
    }
    avgCache.set(c, arr);
  }
  return arr[i - 1];
}

/** Price fell into this candle (5-candle decline and below the 20-average). */
function downtrend(c, i, x) {
  return i >= 6 && c[i - 1].close < c[i - 6].close && (!x?.ema20 || c[i - 1].close < x.ema20[i - 1]);
}
function uptrend(c, i, x) {
  return i >= 6 && c[i - 1].close > c[i - 6].close && (!x?.ema20 || c[i - 1].close > x.ema20[i - 1]);
}

export const PATTERNS = [
  /* ---------------- Bullish reversals (after a decline) ---------------- */
  { id: "hammer", name: "Hammer", dir: 1, bars: 1,
    plain: "After a decline, a small body at the top with a long lower wick (at least twice the body): sellers pushed price down but buyers took it back.",
    test: (c, i, x) => { const k = c[i], b = bodyOf(k), r = rangeOf(k);
      return downtrend(c, i, x) && r > 0 && b > 0 && b <= 0.35 * r && lowerOf(k) >= 2 * b && upperOf(k) <= 0.15 * r; } },
  { id: "invhammer", name: "Inverted hammer", dir: 1, bars: 1,
    plain: "After a decline, a small body at the bottom with a long upper wick: buyers are starting to test higher prices.",
    test: (c, i, x) => { const k = c[i], b = bodyOf(k), r = rangeOf(k);
      return downtrend(c, i, x) && r > 0 && b > 0 && b <= 0.35 * r && upperOf(k) >= 2 * b && lowerOf(k) <= 0.15 * r; } },
  { id: "bullengulf", name: "Bullish engulfing", dir: 1, bars: 2,
    plain: "After a decline, a green candle whose body completely covers the previous red candle's body.",
    test: (c, i, x) => { const p = c[i - 1], k = c[i];
      return downtrend(c, i - 1 + 1, x) && red(p) && green(k) && k.open <= p.close && k.close >= p.open && bodyOf(k) > bodyOf(p); } },
  { id: "piercing", name: "Piercing line", dir: 1, bars: 2,
    plain: "After a decline, a long red candle, then a green candle that opens lower but closes above the middle of the red body.",
    test: (c, i, x) => { const p = c[i - 1], k = c[i], ab = avgBody(c, i);
      return downtrend(c, i, x) && red(p) && bodyOf(p) > ab && green(k) && k.open < p.close && k.close > (p.open + p.close) / 2 && k.close < p.open; } },
  { id: "morningstar", name: "Morning star", dir: 1, bars: 3,
    plain: "After a decline: a long red candle, a small 'star' candle, then a green candle that closes above the middle of the first one.",
    test: (c, i, x) => { const a = c[i - 2], s = c[i - 1], k = c[i], ab = avgBody(c, i);
      return downtrend(c, i - 1, x) && red(a) && bodyOf(a) > ab && bodyOf(s) <= 0.35 * bodyOf(a) && green(k) && k.close > (a.open + a.close) / 2; } },
  { id: "soldiers", name: "Three white soldiers", dir: 1, bars: 3,
    plain: "After a decline, three long green candles in a row, each opening inside the last one's body and closing higher, with small upper wicks.",
    test: (c, i, x) => { const ab = avgBody(c, i);
      for (let j = i - 2; j <= i; j++) { const k = c[j]; if (!green(k) || bodyOf(k) < 0.7 * ab || upperOf(k) > 0.4 * bodyOf(k)) return false; }
      return downtrend(c, i - 2, x) && c[i - 1].close > c[i - 2].close && c[i].close > c[i - 1].close
        && c[i - 1].open >= c[i - 2].open && c[i - 1].open <= c[i - 2].close && c[i].open >= c[i - 1].open && c[i].open <= c[i - 1].close; } },
  { id: "bullharami", name: "Bullish harami", dir: 1, bars: 2,
    plain: "After a decline, a long red candle followed by a small green candle that fits inside its body: selling is losing strength.",
    test: (c, i, x) => { const p = c[i - 1], k = c[i], ab = avgBody(c, i);
      return downtrend(c, i, x) && red(p) && bodyOf(p) > ab && green(k) && k.open > p.close && k.close < p.open && bodyOf(k) <= 0.5 * bodyOf(p); } },
  { id: "dragonfly", name: "Dragonfly doji", dir: 1, bars: 1,
    plain: "After a decline, open and close at the very top of the candle with a long lower wick: a strong rejection of lower prices.",
    test: (c, i, x) => { const k = c[i], r = rangeOf(k);
      return downtrend(c, i, x) && r > 0 && bodyOf(k) <= 0.1 * r && lowerOf(k) >= 0.7 * r; } },

  /* ---------------- Bearish reversals (after a rise) ---------------- */
  { id: "shootingstar", name: "Shooting star", dir: -1, bars: 1,
    plain: "After a rise, a small body at the bottom with a long upper wick: buyers pushed up but sellers took it back.",
    test: (c, i, x) => { const k = c[i], b = bodyOf(k), r = rangeOf(k);
      return uptrend(c, i, x) && r > 0 && b > 0 && b <= 0.35 * r && upperOf(k) >= 2 * b && lowerOf(k) <= 0.15 * r; } },
  { id: "hangingman", name: "Hanging man", dir: -1, bars: 1,
    plain: "After a rise, a small body at the top with a long lower wick: a warning that sellers are appearing.",
    test: (c, i, x) => { const k = c[i], b = bodyOf(k), r = rangeOf(k);
      return uptrend(c, i, x) && r > 0 && b > 0 && b <= 0.35 * r && lowerOf(k) >= 2 * b && upperOf(k) <= 0.15 * r; } },
  { id: "bearengulf", name: "Bearish engulfing", dir: -1, bars: 2,
    plain: "After a rise, a red candle whose body completely covers the previous green candle's body.",
    test: (c, i, x) => { const p = c[i - 1], k = c[i];
      return uptrend(c, i, x) && green(p) && red(k) && k.open >= p.close && k.close <= p.open && bodyOf(k) > bodyOf(p); } },
  { id: "darkcloud", name: "Dark cloud cover", dir: -1, bars: 2,
    plain: "After a rise, a long green candle, then a red candle that opens higher but closes below the middle of the green body.",
    test: (c, i, x) => { const p = c[i - 1], k = c[i], ab = avgBody(c, i);
      return uptrend(c, i, x) && green(p) && bodyOf(p) > ab && red(k) && k.open > p.close && k.close < (p.open + p.close) / 2 && k.close > p.open; } },
  { id: "eveningstar", name: "Evening star", dir: -1, bars: 3,
    plain: "After a rise: a long green candle, a small 'star' candle, then a red candle that closes below the middle of the first one.",
    test: (c, i, x) => { const a = c[i - 2], s = c[i - 1], k = c[i], ab = avgBody(c, i);
      return uptrend(c, i - 1, x) && green(a) && bodyOf(a) > ab && bodyOf(s) <= 0.35 * bodyOf(a) && red(k) && k.close < (a.open + a.close) / 2; } },
  { id: "crows", name: "Three black crows", dir: -1, bars: 3,
    plain: "After a rise, three long red candles in a row, each opening inside the last one's body and closing lower.",
    test: (c, i, x) => { const ab = avgBody(c, i);
      for (let j = i - 2; j <= i; j++) { const k = c[j]; if (!red(k) || bodyOf(k) < 0.7 * ab || lowerOf(k) > 0.4 * bodyOf(k)) return false; }
      return uptrend(c, i - 2, x) && c[i - 1].close < c[i - 2].close && c[i].close < c[i - 1].close
        && c[i - 1].open <= c[i - 2].open && c[i - 1].open >= c[i - 2].close && c[i].open <= c[i - 1].open && c[i].open >= c[i - 1].close; } },
  { id: "bearharami", name: "Bearish harami", dir: -1, bars: 2,
    plain: "After a rise, a long green candle followed by a small red candle inside its body: buying is losing strength.",
    test: (c, i, x) => { const p = c[i - 1], k = c[i], ab = avgBody(c, i);
      return uptrend(c, i, x) && green(p) && bodyOf(p) > ab && red(k) && k.open < p.close && k.close > p.open && bodyOf(k) <= 0.5 * bodyOf(p); } },
  { id: "gravestone", name: "Gravestone doji", dir: -1, bars: 1,
    plain: "After a rise, open and close at the very bottom of the candle with a long upper wick: a strong rejection of higher prices.",
    test: (c, i, x) => { const k = c[i], r = rangeOf(k);
      return uptrend(c, i, x) && r > 0 && bodyOf(k) <= 0.1 * r && upperOf(k) >= 0.7 * r; } },
];
export const BY_ID = Object.fromEntries(PATTERNS.map((p) => [p.id, p]));

/** Patterns completed on candle i. */
export function patternsAt(c, i, x) {
  if (i < 15 || i >= c.length) return [];
  const out = [];
  for (const p of PATTERNS) { try { if (p.test(c, i, x)) out.push(p); } catch {} }
  return out;
}

/** Every pattern in candles [from, to] (for chart markers). */
export function scanPatterns(c, x, from = 15, to = c.length - 1) {
  const hits = [];
  for (let i = Math.max(15, from); i <= to; i++) for (const p of patternsAt(c, i, x)) hits.push({ i, time: c[i].time, p });
  return hits;
}

/**
 * What price did after a pattern on this market: return over the next `h` candles from the close
 * of the pattern candle, vs the average h-candle return (so a trending market doesn't flatter it).
 * Non-overlapping occurrences only.
 */
export function measurePattern(c, x, id, h = 10, lastClosed = c.length - 2) {
  const p = BY_ID[id];
  const rets = [], all = [];
  for (let i = 15; i + h <= lastClosed; i++) all.push(c[i + h].close / c[i].close - 1);
  const base = all.length ? all.reduce((a, v) => a + v, 0) / all.length : 0;
  for (let i = 15; i + h <= lastClosed; i++) {
    let ok = false;
    try { ok = p.test(c, i, x); } catch {}
    if (!ok) continue;
    rets.push(c[i + h].close / c[i].close - 1);
    i += h;
  }
  const n = rets.length;
  if (!n) return { n: 0 };
  const ex = rets.map((r) => r - base);
  const mean = ex.reduce((a, v) => a + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(ex.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : NaN;
  const worked = rets.filter((r) => Math.sign(r) === p.dir).length / n;   // went the way the pattern says
  return { n, h, avgMove: rets.reduce((a, v) => a + v, 0) / n, vsNormal: mean, worked, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : NaN };
}
