import test from "node:test";
import assert from "node:assert/strict";
import { recentMove } from "../public/js/move.js";

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function walk(n, seed, drift = 0) {
  const r = rng(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const u = r() + r() + r() - 1.5; p *= Math.exp(drift + u * 0.004); out.push({ close: p }); }
  return out;
}

test("recentMove: needs enough history", () => {
  assert.equal(recentMove(walk(100, 1)), null);
});

test("recentMove: measures size and direction of the last k candles", () => {
  const bars = walk(2000, 7);
  const last = bars.at(-1).close, from = bars.at(-4).close;
  const m = recentMove(bars, 3, 20);
  assert.ok(Math.abs(m.ret - (last / from - 1)) < 1e-12);
  assert.ok(Math.abs(m.change - (last - from)) < 1e-9);
  assert.ok(m.percentile >= 0 && m.percentile <= 1);
});

test("recentMove: a big jump ranks as unusual", () => {
  const bars = walk(2000, 11);
  const m = recentMove(bars, 3, 20, bars.at(-1).close * 1.05);
  assert.ok(m.percentile > 0.95, "5% jump on a 0.4%-per-candle walk should be rare: " + m.percentile);
  assert.equal(m.dir, 1);
});

test("recentMove: on random walks, 'what happened next' is rarely a clear signal", () => {
  let clear = 0, runs = 40;
  for (let s = 1; s <= runs; s++) {
    const bars = walk(3000, s * 97);
    const m = recentMove(bars, 3, 20, bars.at(-1).close * 1.006);
    if (m.clear) clear++;
  }
  assert.ok(clear <= runs * 0.15, `random walk flagged as predictable too often: ${clear}/${runs}`);
});
