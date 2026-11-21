import test from "node:test";
import assert from "node:assert/strict";
import { etParts, earningsMoves } from "../public/js/earnings-model.js";

// Weekday daily bars starting Mon 2025-01-06, session open 14:30 UTC (9:30 New York, winter time).
function bars(n, closeAt) {
  const out = []; let t = Date.UTC(2025, 0, 6, 14, 30) / 1000;
  while (out.length < n) {
    const wd = new Date(t * 1000).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push({ time: t, close: closeAt(out.length) });
    t += 86400;
  }
  return out;
}

test("etParts converts to New York time (winter and summer)", () => {
  assert.deepEqual(etParts(Date.parse("2026-11-02T21:30:00Z")), { date: "2026-11-02", mins: 16 * 60 + 30 });
  assert.deepEqual(etParts(Date.parse("2026-07-30T20:30:00Z")), { date: "2026-07-30", mins: 16 * 60 + 30 });
  assert.equal(etParts(Date.parse("2026-01-15T03:00:00Z")).date, "2026-01-14");
});

test("after-close releases are measured on the next session, pre-market ones the same day", () => {
  // Flat at 100, with jumps on day 10 (+8%) and day 30 (−5%), small noise elsewhere.
  const b = bars(60, (i) => 100 * (i >= 10 ? 1.08 : 1) * (i >= 30 ? 0.95 : 1) * (1 + (i % 3) * 0.001));
  const d9 = new Date(b[9].time * 1000).toISOString().slice(0, 10);    // filed after the close of day 9
  const d30 = new Date(b[30].time * 1000).toISOString().slice(0, 10);  // filed before the open of day 30
  const r = earningsMoves(b, [{ a: `${d9}T21:05:00Z` }, { a: `${d30}T12:00:00Z` }]);
  assert.equal(r.n, 2);
  const byDate = Object.fromEntries(r.moves.map((m) => [m.date, m]));
  const day10 = new Date(b[10].time * 1000).toISOString().slice(0, 10);
  assert.ok(Math.abs(byDate[day10].move - (b[10].close / b[9].close - 1)) < 1e-12);
  assert.equal(byDate[day10].when, "after close");
  assert.ok(Math.abs(byDate[d30].move - (b[30].close / b[29].close - 1)) < 1e-12);
  assert.equal(byDate[d30].when, "before open");
});

test("stats: average and median absolute move, share up, vs a normal day", () => {
  const jumps = { 20: 1.06, 80: 0.96, 140: 1.05, 200: 0.97, 260: 1.04 };
  let p = 100;
  const b = bars(300, (i) => (p *= (jumps[i] || 1) * (i % 2 ? 1.004 : 0.996)));
  const rel = Object.keys(jumps).map((i) => ({ a: new Date(b[i].time * 1000).toISOString().slice(0, 10) + "T12:00:00Z" }));
  const r = earningsMoves(b, rel);
  assert.equal(r.n, 5);
  assert.equal(r.pUp, 3 / 5);
  assert.ok(r.medianAbs > 0.03 && r.normalAbs < 0.005 && r.ratio > 5);
  assert.ok(r.biggestUp > 0.05 && r.biggestDown < -0.03);
});
