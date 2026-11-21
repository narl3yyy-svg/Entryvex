import test from "node:test";
import assert from "node:assert/strict";
import { mergeCandles } from "../public/js/candlecache.js";

const k = (t, c) => ({ time: t, open: c, high: c, low: c, close: c, volume: 1 });
test("merge replaces the overlapping (possibly still-forming) candles", () => {
  const saved = [k(1, 10), k(2, 11), k(3, 12)];          // candle 3 was still forming when saved
  const fresh = [k(3, 13), k(4, 14), k(5, 15)];
  assert.deepEqual(mergeCandles(saved, fresh).map((x) => [x.time, x.close]), [[1, 10], [2, 11], [3, 13], [4, 14], [5, 15]]);
});
test("merge with nothing new or nothing saved", () => {
  const a = [k(1, 1), k(2, 2)];
  assert.deepEqual(mergeCandles(a, []), a);
  assert.deepEqual(mergeCandles([], a), a);
});
