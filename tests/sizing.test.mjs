// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { sizePosition, floorStep, roundTick, stepDecimals } from "../public/js/sizing.js";

const BTC = { stepSize: 0.00001, minQty: 0.00001, tickSize: 0.01, minNotional: 1 };

test("rounding follows exchange steps", () => {
  assert.equal(floorStep(0.123456, 0.00001), 0.12345);
  assert.equal(floorStep(1234.9, 1), 1234);
  assert.equal(roundTick(58123.456, 0.01), 58123.46);
  assert.equal(stepDecimals(1e-8), 8);
});

test("risking 1% of $1000 with a 1% stop loses at most $10 including costs", () => {
  // Pure risk math (position limit lifted): spend ≈ $10 / (1% + 2×0.02%) ≈ $961.
  const r = sizePosition({ balance: 1000, riskPct: 1, entry: 60000, stop: 59400, target: 60900, costPerSide: 0.0002, rules: BTC, maxPositionPct: 100 });
  assert.ok(r.ok);
  assert.ok(r.lossUsd <= 10.0001 && r.lossUsd > 9.9);
  assert.ok(r.spend < 1000);
  assert.ok(r.winUsd > 0 && r.rr > 1);
  // With the default 25% one-position limit the same trade is capped, so it risks less than $10.
  const capped = sizePosition({ balance: 1000, riskPct: 1, entry: 60000, stop: 59400, target: 60900, costPerSide: 0.0002, rules: BTC });
  assert.ok(capped.capped && capped.spend <= 250 && capped.lossUsd < 10);
});

test("a very tight stop is capped at the account balance", () => {
  const r = sizePosition({ balance: 1000, riskPct: 1, entry: 60000, stop: 59900, target: 60200, costPerSide: 0.0002, rules: BTC });
  assert.ok(r.capped && r.spend <= 250 && r.lossUsd < 10, "capped at the 25% one-position limit");
  const full = sizePosition({ balance: 1000, riskPct: 1, entry: 60000, stop: 59900, target: 60200, costPerSide: 0.0002, rules: BTC, maxPositionPct: 100 });
  assert.ok(full.spend > 900 && full.spend <= 1000);
});

test("orders under the exchange minimum are rejected", () => {
  const r = sizePosition({ balance: 5, riskPct: 1, entry: 60000, stop: 54000, target: 69000, costPerSide: 0.0002, rules: BTC });
  assert.equal(r.reason, "too-small");
});

test("a target smaller than round-trip costs is rejected", () => {
  const r = sizePosition({ balance: 1000, riskPct: 1, entry: 100, stop: 99, target: 100.05, costPerSide: 0.001, rules: {} });
  assert.equal(r.reason, "costs-eat-target");
});

test("whole-coin step sizes produce whole quantities", () => {
  const r = sizePosition({ balance: 1000, riskPct: 2, entry: 0.00000338, stop: 0.0000033, target: 0.0000035, costPerSide: 0.0006,
    rules: { stepSize: 1, minQty: 1, tickSize: 1e-8, minNotional: 1 } });
  assert.ok(r.ok && Number.isInteger(r.qty) && r.lossUsd <= 20.0001);
});

test("invalid levels are rejected", () => {
  assert.equal(sizePosition({ balance: 1000, riskPct: 1, entry: 100, stop: 101, target: 110 }).reason, "stop-above");
  assert.equal(sizePosition({ balance: 1000, riskPct: 1, entry: 100, stop: 99, target: 99.5 }).reason, "target-below");
  assert.equal(sizePosition({ balance: 0, riskPct: 1, entry: 100, stop: 99, target: 102 }).reason, "missing");
});
