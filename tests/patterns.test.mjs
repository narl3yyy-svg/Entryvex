import test from "node:test";
import assert from "node:assert/strict";
import { patternsAt, measurePattern, PATTERNS } from "../public/js/patterns.js";

// 20 falling candles (each −1), so the context is a decline; then the test candle(s).
function falling(n = 20, start = 200) {
  const c = [];
  let p = start;
  for (let i = 0; i < n; i++) { c.push({ time: i * 60, open: p, high: p + 0.3, low: p - 1.3, close: p - 1 }); p -= 1; }
  return c;
}
function rising(n = 20, start = 100) {
  const c = [];
  let p = start;
  for (let i = 0; i < n; i++) { c.push({ time: i * 60, open: p, high: p + 1.3, low: p - 0.3, close: p + 1 }); p += 1; }
  return c;
}
const ids = (c) => patternsAt(c, c.length - 1, null).map((p) => p.id);

test("hammer after a decline", () => {
  const c = falling(); const p = c.at(-1).close;
  c.push({ time: 9999, open: p - 0.2, high: p + 0.05, low: p - 3, close: p });          // body 0.2, lower wick 2.8
  assert.ok(ids(c).includes("hammer"));
});
test("the same shape after a rise is a hanging man, not a hammer", () => {
  const c = rising(); const p = c.at(-1).close;
  c.push({ time: 9999, open: p - 0.2, high: p + 0.05, low: p - 3, close: p });
  assert.ok(ids(c).includes("hangingman"));
  assert.ok(!ids(c).includes("hammer"));
});
test("bullish engulfing", () => {
  const c = falling(); const p = c.at(-1).close;
  c.push({ time: 9998, open: p, high: p + 0.2, low: p - 1.2, close: p - 1 });          // red
  c.push({ time: 9999, open: p - 1.1, high: p + 0.6, low: p - 1.2, close: p + 0.5 });  // green covers it
  assert.ok(ids(c).includes("bullengulf"));
});
test("morning star", () => {
  const c = falling(); const p = c.at(-1).close;
  c.push({ time: 9997, open: p, high: p + 0.1, low: p - 2.2, close: p - 2 });          // long red
  c.push({ time: 9998, open: p - 2.1, high: p - 1.9, low: p - 2.5, close: p - 2.2 });  // small star
  c.push({ time: 9999, open: p - 2.1, high: p - 0.4, low: p - 2.2, close: p - 0.5 });  // green above the middle
  assert.ok(ids(c).includes("morningstar"));
});
test("three black crows after a rise", () => {
  const c = rising(); const p = c.at(-1).close;
  c.push({ time: 9997, open: p + 0.1, high: p + 0.2, low: p - 1.6, close: p - 1.5 });
  c.push({ time: 9998, open: p - 0.5, high: p - 0.4, low: p - 3.1, close: p - 3 });
  c.push({ time: 9999, open: p - 2, high: p - 1.9, low: p - 4.6, close: p - 4.5 });
  assert.ok(ids(c).includes("crows"));
});
test("plain trend candles are not patterns", () => {
  assert.deepEqual(ids(falling(30)), []);
  assert.deepEqual(ids(rising(30)), []);
});
test("measurePattern: counts occurrences and direction", () => {
  // Repeating cycle: decline, hammer, then a rise of +5.
  const c = [];
  let t = 0;
  for (let cyc = 0; cyc < 8; cyc++) {
    let p = 200;
    for (let i = 0; i < 10; i++) { c.push({ time: t++, open: p, high: p + 0.3, low: p - 1.3, close: p - 1 }); p -= 1; }
    c.push({ time: t++, open: p - 0.2, high: p + 0.05, low: p - 3, close: p });
    for (let i = 0; i < 12; i++) { c.push({ time: t++, open: p, high: p + 0.6, low: p - 0.1, close: p + 0.5 }); p += 0.5; }
  }
  const m = measurePattern(c, null, "hammer", 10, c.length - 1);
  assert.ok(m.n >= 6, "n " + m.n);
  assert.equal(m.worked, 1);
});
test("every pattern has a plain-English description", () => {
  for (const p of PATTERNS) assert.ok(p.plain.length > 30 && (p.dir === 1 || p.dir === -1), p.id);
});
