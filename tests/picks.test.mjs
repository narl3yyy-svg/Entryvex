import test from "node:test";
import assert from "node:assert/strict";
import { factorsAt, rankAt, backtest, verdict, maxDrawdown, alignMonthly } from "../public/js/picks-model.js";

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function walk(n, r, drift = 0.008, vol = 0.07) {
  let p = 100; const out = [];
  for (let i = 0; i < n; i++) { const u = (r() + r() + r() - 1.5) * 2; p *= Math.exp(drift + u * vol); out.push(p); }
  return out;
}

test("factorsAt: 12-1 momentum, trend and volatility by hand", () => {
  const c = Array.from({ length: 13 }, (_, i) => 100 * 1.01 ** i);   // steady +1%/month
  const f = factorsAt(c, 12);
  assert.ok(Math.abs(f.momentum - (1.01 ** 11 - 1)) < 1e-12);       // P[11]/P[0] − 1 (skips last month)
  assert.ok(f.volatility < 1e-9);                                    // constant returns → no volatility
  const sma = c.slice(3).reduce((s, v) => s + v, 0) / 10;
  assert.ok(Math.abs(f.trend - (c[12] / sma - 1)) < 1e-12);
  assert.equal(factorsAt(c, 11), null);
  assert.equal(factorsAt([...c.slice(0, 5), null, ...c.slice(6)], 12), null);
});

test("rankAt: strong steady riser ranks first, steep faller last", () => {
  const r = rng(3), series = {};
  for (let k = 0; k < 20; k++) series["S" + k] = walk(30, r, 0.005, 0.05);
  series.UP = Array.from({ length: 30 }, (_, i) => 100 * 1.05 ** i);
  series.DOWN = Array.from({ length: 30 }, (_, i) => 100 * 0.93 ** i);
  const ranked = rankAt(series, 29);
  assert.equal(ranked[0].sym, "UP");
  assert.equal(ranked.at(-1).sym, "DOWN");
  assert.deepEqual(ranked.map((x) => x.rank), ranked.map((_, i) => i + 1));
});

test("no look-ahead: changing later prices doesn't change an earlier ranking", () => {
  const r = rng(9), series = {};
  for (let k = 0; k < 25; k++) series["S" + k] = walk(60, r);
  const before = rankAt(series, 30).map((x) => x.sym).join();
  for (const s of Object.values(series)) for (let i = 31; i < 60; i++) s[i] *= 3 + (i % 5);
  assert.equal(rankAt(series, 30).map((x) => x.sym).join(), before);
});

test("backtest: costs are charged and random stocks don't show a proven edge", () => {
  let edges = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(seed * 101), series = {};
    for (let k = 0; k < 60; k++) series["S" + k] = walk(180, r);
    const bench = walk(180, r);
    const months = Array.from({ length: 180 }, (_, i) => String(i).padStart(4, "0"));
    const bt = backtest(months, series, bench, { top: 10, costPerSide: 0.001 });
    const free = backtest(months, series, bench, { top: 10, costPerSide: 0 });
    assert.ok(bt.stats.cagr.model < free.stats.cagr.model, "costs must lower returns");
    if (verdict(bt.stats).level === "edge") edges++;
  }
  assert.ok(edges <= 3, `random walks shown as a proven edge too often: ${edges}/30`);
});

test("maxDrawdown and alignMonthly", () => {
  assert.ok(Math.abs(maxDrawdown([1, 1.2, 0.9, 1.3, 1.04]) - (0.9 / 1.2 - 1)) < 1e-12);
  const a = alignMonthly({ A: [{ month: "2024-01", close: 1 }, { month: "2024-03", close: 3 }], B: [{ month: "2024-02", close: 2 }] });
  assert.deepEqual(a.months, ["2024-01", "2024-02", "2024-03"]);
  assert.deepEqual(a.series.A, [1, null, 3]);
  assert.deepEqual(a.series.B, [null, 2, null]);
});
