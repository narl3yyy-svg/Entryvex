import { test } from "node:test";
import assert from "node:assert/strict";
import { exitOnCandle, wilson, analyze, RULES } from "../public/js/engine.js";
import { forecast } from "../public/js/forecast.js";
import { ema, rsi, atr } from "../public/js/indicators.js";

test("exit rules: gaps fill at the open, same-candle double hit counts as a loss", () => {
  const stop = 95, target = 110;
  assert.deepEqual(exitOnCandle({ open: 90, high: 92, low: 88, close: 91 }, stop, target), { exit: 90, outcome: "stop" });     // gap down
  assert.deepEqual(exitOnCandle({ open: 112, high: 115, low: 111, close: 113 }, stop, target), { exit: 112, outcome: "target" }); // gap up
  assert.deepEqual(exitOnCandle({ open: 100, high: 111, low: 94, close: 100 }, stop, target), { exit: 95, outcome: "stop" });   // both: worst case
  assert.deepEqual(exitOnCandle({ open: 100, high: 111, low: 99, close: 110 }, stop, target), { exit: 110, outcome: "target" });
  assert.equal(exitOnCandle({ open: 100, high: 105, low: 97, close: 101 }, stop, target), null);
});

test("Wilson 95% interval matches the textbook formula", () => {
  const [lo, hi] = wilson(20, 40);
  // p=0.5, n=40 → [0.352, 0.648]
  assert.ok(Math.abs(lo - 0.3519) < 0.001 && Math.abs(hi - 0.6481) < 0.001);
  const [lo0, hi0] = wilson(0, 10);
  assert.ok(lo0 === 0 || lo0 < 1e-12);
  assert.ok(hi0 > 0.25 && hi0 < 0.32);
});

test("indicators: EMA of a constant is the constant; RSI of a rising series is 100", () => {
  const flat = Array(60).fill(10);
  assert.ok(ema(flat, 20).slice(19).every((v) => Math.abs(v - 10) < 1e-12));
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.equal(rsi(up, 14).at(-1), 100);
  const candles = Array.from({ length: 30 }, (_, i) => ({ open: 100, high: 101, low: 99, close: 100 }));
  assert.ok(Math.abs(atr(candles, 14).at(-1) - 2) < 1e-9);
});

// Deterministic pseudo-random generator so tests are repeatable.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function randomWalk(n, seed, vol = 0.004) {
  const r = rng(seed);
  let p = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    const z = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    const c = o * Math.exp(vol * z);
    const hi = Math.max(o, c) * (1 + vol * r() * 0.5), lo = Math.min(o, c) * (1 - vol * r() * 0.5);
    out.push({ time: 1_700_000_000 + i * 900, open: o, high: hi, low: lo, close: c, volume: 1000 + 500 * r() });
    p = c;
  }
  return out;
}

test("backtest on a pure random walk finds no real edge after costs", () => {
  const c = randomWalk(3000, 42);
  const r = analyze(c, { costPerSide: 0.0005 });
  for (const s of r.setups) {
    if (s.stats.n < RULES.minTrades) continue;
    // No setup should be labelled a proven edge on random data (allowing for rare flukes, check EV sign is not strongly positive)
    assert.notEqual(s.verdict.level, "edge", `${s.name} looked like an edge on random data`);
  }
});

test("every simulated trade exits at the stop, the target, a gap open, or the time limit", () => {
  const c = randomWalk(3000, 7);
  const r = analyze(c, { costPerSide: 0 });
  for (const s of r.setups) {
    for (const t of s.trades) {
      assert.ok(["stop", "target", "timeout"].includes(t.outcome));
      assert.ok(t.bars >= 1 && t.bars <= RULES.maxBars);
      assert.ok(t.entryTime > t.signalTime, "entry must be after the signal (no look-ahead)");
    }
  }
});

test("forecast: the 80% range holds about 80% of outcomes on a random walk", () => {
  const c = randomWalk(3000, 99);
  const f = forecast(c, 900, 20);
  assert.ok(f.accuracy80 > 0.72 && f.accuracy80 < 0.88, `accuracy80 was ${f.accuracy80}`);
  assert.ok(f.range80[0] < f.range50[0] && f.range50[1] < f.range80[1], "50% range must sit inside the 80% range");
  assert.ok(f.pUp > 0.4 && f.pUp < 0.6, "a random walk should be close to a coin flip");
});

test("liquidity check flags markets with empty candles or tiny volume", async () => {
  const { checkLiquidity } = await import("../public/js/engine.js");
  const busy = Array.from({ length: 300 }, (_, i) => ({ open: 100, high: 101, low: 99, close: 100, volume: 50 }));
  assert.equal(checkLiquidity(busy).ok, true);
  const empty = busy.map((k, i) => (i % 3 === 0 ? { ...k, high: 100, low: 100, volume: 0 } : k));
  const e = checkLiquidity(empty);
  assert.equal(e.ok, false);
  assert.ok(e.zeroFrac > 0.3);
  const tiny = busy.map((k) => ({ ...k, volume: 2 })); // $200 per candle
  assert.equal(checkLiquidity(tiny).ok, false);
});

test("long-term stats: hold odds are a valid probability and ranges are ordered", async () => {
  const { longTermStats } = await import("../public/js/longterm.js");
  const daily = randomWalk(1500, 5, 0.015).map((k, i) => ({ ...k, time: 1_500_000_000 + i * 86400 }));
  const lt = longTermStats(daily, true);
  assert.ok(lt.hold.pUp >= 0 && lt.hold.pUp <= 1);
  assert.ok(lt.hold.p10 <= lt.hold.median && lt.hold.median <= lt.hold.p90);
  assert.ok(lt.hold.n > 1000);
  assert.ok(lt.vol > 10 && lt.vol < 40, `annualized vol ${lt.vol} should be near 1.5% * sqrt(252) ≈ 24%`);
  assert.equal(longTermStats(daily.slice(0, 100), true), null);
});

test("probAbove: 50% near the middle, falls as the level rises, matches the 80% range edges", async () => {
  const { probAbove } = await import("../public/js/forecast.js");
  const f = forecast(randomWalk(3000, 11), 900, 20);
  const pMid = probAbove(f, f.mid);
  assert.ok(Math.abs(pMid - 0.5) < 0.03, `middle should be ~50%, got ${pMid}`);
  assert.ok(probAbove(f, f.live * 0.95) > probAbove(f, f.live) && probAbove(f, f.live) > probAbove(f, f.live * 1.05));
  assert.ok(Math.abs(probAbove(f, f.range80[1]) - 0.10) < 0.02, "~10% of outcomes end above the top of the 80% range");
  assert.ok(Math.abs(probAbove(f, f.range80[0]) - 0.90) < 0.02, "~90% end above the bottom of the 80% range");
});
