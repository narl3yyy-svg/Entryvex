import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNews, pool, MIN_CASES } from "../public/js/newsai-model.js";

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
const T0 = Date.UTC(2026, 0, 1);
// Hourly random-walk prices; optionally the news score "knows" the next 24 h.
function world(days, seed, informative) {
  const r = rng(seed), bars = [];
  let p = 100;
  for (let h = 0; h < days * 24; h++) { p *= Math.exp((r() - 0.5) * 0.01); bars.push({ time: (T0 + h * 3600e3) / 1000, close: p }); }
  const log = [];
  for (let d = 0; d < days - 2; d++) {
    const i = d * 24, j = i + 24;
    const future = bars[j].close / bars[i].close - 1;
    const s = informative ? Math.sign(future) * 0.5 : (r() - 0.5);
    log.push({ t: bars[i].time * 1000, s, p: bars[i].close });
  }
  return { bars, log };
}

test("a score that knows the future is detected as helping", () => {
  const { bars, log } = world(60, 7, true);
  const e = evaluateNews(log, bars);
  assert.ok(e.cases >= MIN_CASES);
  assert.equal(e.hit, 1);
  assert.equal(e.verdict.level, "helps");
});

test("random scores are not called helpful", () => {
  let helps = 0;
  for (let s = 1; s <= 40; s++) {
    const { bars, log } = world(60, s * 31, false);
    if (evaluateNews(log, bars).verdict.helps) helps++;
  }
  assert.ok(helps <= 3, `random news scores marked helpful ${helps}/40 times`);
});

test("overlapping reads are thinned and recent ones wait", () => {
  const { bars } = world(10, 3, false);
  const log = [];
  for (let h = 0; h < 10 * 24; h += 1) log.push({ t: bars[h].time * 1000, s: 0.5, p: bars[h].close });
  const e = evaluateNews(log, bars);
  assert.ok(e.cases <= 10, "at most one independent case per day: " + e.cases);
  assert.ok(e.pending >= 24, "the last day of reads can't be judged yet");
  assert.equal(e.verdict.level, "collecting");
});

test("pool combines markets", () => {
  const a = evaluateNews(...Object.values(world(40, 5, true)).reverse());
  const p = pool([a, a]);
  assert.equal(p.cases, a.cases * 2);
  assert.ok(p.t > a.t);
});

import { calibrate, expectedMove } from "../public/js/newsai-model.js";
test("calibration learns how much a score is worth", () => {
  const r = rng(11), rows = [];
  for (let i = 0; i < 200; i++) { const s = r() * 2 - 1; rows.push({ s, ret: 0.01 * s + (r() - 0.5) * 0.004 }); }
  const cal = calibrate(rows);
  assert.ok(Math.abs(cal.slope - 0.01) < 0.001, "slope " + cal.slope);
  assert.ok(Math.abs(expectedMove(cal, 0.5) - 0.005) < 0.0006);
  const noise = []; for (let i = 0; i < 200; i++) noise.push({ s: r() * 2 - 1, ret: (r() - 0.5) * 0.02 });
  const c2 = calibrate(noise);
  assert.ok(expectedMove(c2, 0.5) === null || Math.abs(c2.tSlope) >= 2);
});
