import test from "node:test";
import assert from "node:assert/strict";

// Synthetic BTC history served through a fake Binance API, so the bot runs exactly as on the server.
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
const MS = { "5m": 300e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
function makeHistory(days, seed) {
  const r = rng(seed), start = Date.UTC(2025, 0, 1), five = [];
  let p = 60000;
  const n = (days + 1200) * 288;
  for (let i = 0; i < n; i++) {
    const o = p; p *= Math.exp((r() + r() + r() - 1.5) * 0.002);
    five.push([start + i * MS["5m"], o, Math.max(o, p) * 1.0005, Math.min(o, p) * 0.9995, p, 1 + r()]);
  }
  const agg = (iv) => {
    const out = [], step = MS[iv] / MS["5m"];
    for (let i = 0; i + step <= five.length; i += step) {
      const g = five.slice(i, i + step);
      out.push([g[0][0], g[0][1], Math.max(...g.map((k) => k[2])), Math.min(...g.map((k) => k[3])), g.at(-1)[4], g.reduce((a, k) => a + k[5], 0)]);
    }
    return out;
  };
  return { "5m": five, "1h": agg("1h"), "4h": agg("4h"), "1d": agg("1d"), end: five.at(-1)[0] };
}

test("paper bot: virtual money only, sane trades, learns, few writes", async () => {
  const H = makeHistory(12, 7);
  let now = H.end - 12 * 86400e3;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url), iv = u.searchParams.get("interval"), lim = +u.searchParams.get("limit");
    const rows = H[iv].filter((k) => k[0] + MS[iv] <= now).slice(-lim);
    return { ok: true, json: async () => rows };
  };
  try {
    const { cronBot, summarize, BOT } = await import("../functions/api/bot.js");
    const kv = new Map(); let writes = 0;
    const env = { PUSH: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => { writes++; kv.set(k, v); } } };
    const days = 12;
    for (let k = 0; k < days * 288; k++, now += 5 * 60e3) await cronBot(env, now);
    const s = JSON.parse(kv.get("bot:state"));
    assert.ok(s.cash >= 0, "never spends money it doesn't have");
    for (const t of s.trades) {
      assert.ok(t.qty * t.entry >= BOT.minNotional - 1e-9, "respects the minimum order");
      assert.ok(t.stop < t.entry && t.target > t.entry, "stop below, target above");
      assert.ok(["stop", "target", "timeout"].includes(t.outcome));
      assert.ok(t.lesson.length > 20);
      assert.ok(t.closedAt >= t.openedAt);
    }
    const learnedTrades = Object.values(s.memory).filter((m) => !m.group).reduce((a, m) => a + m.n, 0);
    assert.equal(learnedTrades, s.trades.length, "every closed trade is remembered");
    assert.ok(writes / days < 60, `saves ${writes / days}/day`);
    const sum = summarize(s, s.equity.at(-1)[2]);
    assert.ok(["learning", "not-proven", "proven"].includes(sum.status));
  } finally { globalThis.fetch = realFetch; }
});
