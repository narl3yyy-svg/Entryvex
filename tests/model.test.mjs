import test from "node:test";
import assert from "node:assert/strict";
import { fitLogistic, auc } from "../public/js/model.js";
import { analyze } from "../public/js/engine.js";

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

test("auc: perfect, reversed and no-skill rankings", () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
});

test("logistic regression learns a real relationship", () => {
  const r = rng(5), X = [], y = [];
  for (let i = 0; i < 2000; i++) { const a = r() * 2 - 1, b = r() * 2 - 1; X.push([a, b]); y.push(r() < 1 / (1 + Math.exp(-3 * a)) ? 1 : 0); }
  const m = fitLogistic(X, y);
  assert.ok(m.w[0] > 0.5 && Math.abs(m.w[1]) < 0.2, JSON.stringify(m.w));
  assert.ok(auc(X.map((f) => m.predict(f)), y) > 0.7);
});

test("the model never shows a proven edge on random prices", () => {
  let edges = 0;
  for (let s = 1; s <= 12; s++) {
    const r = rng(s * 101), c = []; let p = 100;
    for (let i = 0; i < 2500; i++) { const o = p; p *= Math.exp((r() + r() + r() - 1.5) * 0.01); c.push({ time: i * 3600, open: o, high: Math.max(o, p) * 1.002, low: Math.min(o, p) * 0.998, close: p, volume: 1000 * (1 + r()) }); }
    const m = analyze(c, { costPerSide: 0.0005 }).setups.find((x) => x.id === "model");
    if (m?.verdict.level === "edge") edges++;
  }
  assert.ok(edges <= 1, `random prices produced ${edges} model edges`);
});
