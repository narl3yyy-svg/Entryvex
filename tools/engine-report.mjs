// Print the setup engine's results for a few coins using live Binance.US data.
// Usage: node tools/engine-report.mjs [SYMBOL:INTERVAL ...]
//   e.g. node tools/engine-report.mjs BTCUSDT:15m ETHUSDT:1h
import { analyze } from "../public/js/engine.js";

const TAKER_FEE = 0.0002; // Binance.US spot taker fee (0.02%) as of 2026
const get = async (p) => (await fetch("https://api.binance.us/api/v3" + p)).json();

async function history(sym, iv, total) {
  let out = [], end = null;
  while (out.length < total) {
    const lim = Math.min(1000, total - out.length);
    const raw = await get(`/klines?symbol=${sym}&interval=${iv}&limit=${lim}${end ? "&endTime=" + end : ""}`);
    if (!Array.isArray(raw) || !raw.length) break;
    out = raw.map((k) => ({ time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).concat(out);
    end = raw[0][0] - 1;
    if (raw.length < lim) break;
  }
  return out;
}

const pct = (v) => (isFinite(v) ? (v * 100).toFixed(2) + "%" : "-");
const pairs = (process.argv.slice(2).length ? process.argv.slice(2) : ["BTCUSDT:15m", "ETHUSDT:1h", "SOLUSDT:5m", "DOGEUSDT:15m"])
  .map((s) => s.split(":"));

for (const [sym, iv] of pairs) {
  const c = await history(sym, iv, 3000);
  const bt = await get(`/ticker/bookTicker?symbol=${sym}`);
  const spread = (bt.askPrice - bt.bidPrice) / ((+bt.askPrice + +bt.bidPrice) / 2);
  const cost = TAKER_FEE + spread / 2;
  const r = analyze(c, { costPerSide: cost });
  console.log(`\n${sym} ${iv}: ${c.length} candles, spread ${pct(spread)}, cost/side ${pct(cost)} -> ${r.overall.label}`);
  for (const s of r.setups) {
    const t = s.stats;
    console.log(
      `  ${s.name.padEnd(18)} n=${String(t.n).padStart(3)} win=${pct(t.winRate)} [${pct(t.winLo)}-${pct(t.winHi)}] ` +
      `ev=${pct(t.ev)} breakeven=${pct(t.breakeven)} old/new=${pct(t.evOld)}/${pct(t.evNew)} -> ${s.verdict.label}${s.activeNow ? "  **ACTIVE**" : ""}`
    );
  }
}
