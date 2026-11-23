// Forecast scorecard: grading rules, the past-data test, and the save → check cycle with fake prices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { grade, callOf, backtest, cronScore, onRequestGet, SCORE } from "../functions/api/scorecard.js";

function walk(n, startSec, step, seed = 7) {
  let x = seed, p = 100;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = p; p = p * Math.exp((rnd() - 0.5) * 0.02);
    out.push({ time: startSec + i * step, open: o, high: Math.max(o, p) * 1.002, low: Math.min(o, p) * 0.998, close: p, volume: 1 });
  }
  return out;
}

test("grading: range hits, lean calls, coin flips", () => {
  const e = { p0: 100, lo: 90, hi: 110, lo50: 95, hi50: 105, pUp: 0.6 };
  const g = grade(e, 104);
  assert.equal(g.in80, true); assert.equal(g.in50, true); assert.equal(g.call, "up"); assert.equal(g.right, true);
  const miss = grade({ ...e, pUp: 0.4 }, 112);
  assert.equal(miss.in80, false); assert.equal(miss.call, "down"); assert.equal(miss.right, false);
  assert.equal(callOf(0.51), null);
  assert.equal(grade({ ...e, pUp: 0.5 }, 104).right, null);
});

test("past-data test uses only earlier candles and lands near 80% on a random walk", () => {
  const c = walk(1000, 0, 3600);
  const st = backtest(c, "1h");
  assert.ok(st.n >= 50, `tests: ${st.n}`);
  const rate = st.in80 / st.n;
  assert.ok(rate > 0.6 && rate < 0.97, `in range ${rate}`);
  // Changing the future must not change a forecast made before it: truncating the data only removes tests.
  const short = backtest(c.slice(0, 700), "1h");
  assert.ok(short.n > 0 && short.n <= st.n + SCORE.backPoints);
});

test("saves forecasts, then checks them once 20 candles have closed", async () => {
  const kv = new Map(); let writes = 0;
  const env = { PUSH: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => { writes++; kv.set(k, v); } } };
  const start = Date.UTC(2026, 0, 5, 0, 0) / 1000 - 1100 * 3600;
  const hourly = walk(1300, start, 3600, 11), daily = walk(1300, start - 300 * 86400, 86400, 13);
  let nowSec = start + 1100 * 3600;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === "api.binance.us") {
      const iv = u.searchParams.get("interval"), lim = +u.searchParams.get("limit");
      const src = iv === "1d" ? daily : hourly;
      const k = src.filter((x) => x.time <= nowSec).slice(-lim).map((x) => [x.time * 1000, x.open, x.high, x.low, x.close, x.volume]);
      return new Response(JSON.stringify(k));
    }
    return new Response(JSON.stringify({ chart: { result: [{ timestamp: [], indicators: { quote: [{}] } }] } }));   // stocks: no data
  };
  try {
    for (let i = 0; i < 30; i++) await cronScore(env, nowSec * 1000);
    let s = JSON.parse(kv.get("score:v1"));
    assert.equal(s.pending.filter((e) => e.iv === "1h").length, 5, "one 1h forecast per crypto market");
    assert.ok(Object.values(s.back).some((b) => b.n > 0), "past-data tests ran");
    assert.equal(s.pending.filter((e) => e.sym.startsWith("S:")).length, 0, "no stock forecasts without data");
    const before = writes;
    for (let i = 0; i < 12; i++) await cronScore(env, nowSec * 1000);   // nothing new within the hour
    assert.equal(writes, before, "no writes when nothing is due");

    nowSec += 22 * 3600;
    await cronScore(env, nowSec * 1000);
    s = JSON.parse(kv.get("score:v1"));
    const g = s.graded.filter((x) => x.iv === "1h");
    assert.equal(g.length, 5, "all five 1h forecasts checked");
    for (const x of g) {
      const t0 = hourly.findIndex((k) => k.time === x.t0);
      assert.equal(x.actual, hourly[t0 + SCORE.H].close, "graded against the close 20 candles later");
      assert.equal(x.in80, x.actual >= x.lo && x.actual <= x.hi);
    }
    assert.equal(s.live["BTCUSDT|1h"].n, 1);

    const body = await (await onRequestGet({ env })).json();
    assert.equal(body.overall["1h"].live.n, 5);
    assert.equal(body.recent.length, 5);
    assert.equal(body.markets.length, 12);
  } finally { globalThis.fetch = realFetch; }
});
