import test from "node:test";
import assert from "node:assert/strict";
import { majorOf, money, fxRate } from "../public/js/fx.js";
import { sizePosition } from "../public/js/sizing.js";

test("minor-unit currencies (pence, cents, agorot)", () => {
  assert.deepEqual(majorOf("GBp"), ["GBP", 100]);
  assert.deepEqual(majorOf("ZAc"), ["ZAR", 100]);
  assert.deepEqual(majorOf("JPY"), ["JPY", 1]);
  assert.equal(fxRate("USD"), 1);
});

test("money(): local amount with its dollar value", () => {
  assert.equal(money(15000, "JPY", 150), '¥15,000 <span class="muted">(≈$100)</span>');
  // 2,500 pence = £25.00; at 0.8 GBP per $ (80 pence per $) that's $31.25
  assert.equal(money(2500, "GBp", 80), '£25.00 <span class="muted">(≈$31.25)</span>');
  assert.equal(money(-12.5, "EUR", 0.9, { sign: true }), '−€12.50 <span class="muted">(≈−$13.89)</span>');
  assert.equal(money(42, "USD", 1), "$42.00");
});

test("sizing in a foreign currency equals sizing in dollars, converted", () => {
  const rate = 150;   // yen per dollar
  const usd = sizePosition({ balance: 10000, riskPct: 1, entry: 20, stop: 19, target: 21.5, costPerSide: 0.001, rules: {} });
  const jpy = sizePosition({ balance: 10000 * rate, riskPct: 1, entry: 20 * rate, stop: 19 * rate, target: 21.5 * rate, costPerSide: 0.001, rules: {} });
  assert.ok(Math.abs(jpy.lossUsd / rate - usd.lossUsd) < 1e-6);
  assert.ok(Math.abs(jpy.spend / rate - usd.spend) < 1e-6);
  assert.ok(Math.abs(jpy.qty - usd.qty) < 1e-9);
});
