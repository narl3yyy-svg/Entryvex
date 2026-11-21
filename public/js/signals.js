// Signal Record: Entryvex's own live report card.
// Every time a setup fires while Entryvex is open (on the coin you're viewing, or on your
// watchlist when setup alerts are on), it's saved with the verdict Entryvex gave. Later,
// the outcome is checked against real Binance.US candles using the exact same rules as the
// backtest (buy next candle's open, 1×ATR stop, 1.5×ATR target, 24-candle limit, costs).
// Over time this shows whether Entryvex's live confidence actually holds up.
import { RULES, exitOnCandle } from "./engine.js";
import { getKlinesSince } from "./market.js";
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};
const SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const MAX = 600;

let signals = store.get("signals", []);
let hooks = { getInfo: () => null, onPick: () => {} };
const save = () => { store.set("signals", signals.slice(-MAX)); render(); };
const baseOf = (s) => hooks.getInfo(s)?.base ?? s.replace(/(USDT|USDC|USD)$/, "");

/** Record every active setup from an engine result. `candles` must be the array that was analyzed. */
export function logFromAnalysis(symbol, interval, candles, r) {
  if (!r || !candles || candles.length < 3) return;
  const sigTime = candles[candles.length - 2].time;  // last CLOSED candle
  let added = false;
  for (const s of r.setups) {
    if (!s.activeNow) continue;
    const id = `${symbol}|${interval}|${s.id}|${sigTime}`;
    if (signals.some((x) => x.id === id)) continue;
    signals.push({
      id, symbol, interval, setup: s.name, setupId: s.id,
      verdict: s.verdict.level, verdictLabel: s.verdict.label,
      winRate: s.stats.winRate, n: s.stats.n, ev: s.stats.ev,
      signalTime: sigTime, atr: r.atr, cost: r.costPerSide, price: r.price,
      status: "open", loggedAt: Date.now(),
    });
    added = true;
  }
  if (added) save();
}

/* ---------- Resolve outcomes from real candles ---------- */
let resolving = false;
async function resolveOpen() {
  if (resolving) return;
  resolving = true;
  try {
    const now = Date.now() / 1000;
    const open = signals.filter((s) => s.status === "open").slice(0, 25);
    for (const s of open) {
      const sec = SEC[s.interval] || 900;
      const entryTime = s.signalTime + sec;
      if (now < entryTime + sec) continue;  // entry candle hasn't closed yet
      let raw;
      try { raw = await getKlinesSince(s.symbol, s.interval, entryTime, RULES.maxBars + 1); } catch { continue; }
      if (!Array.isArray(raw) || !raw.length) continue;
      const c = raw.filter((k) => k.closeTime < now);  // closed candles only
      if (!c.length) continue;
      const entry = c[0].open;
      const stop = entry - RULES.stopAtr * s.atr, target = entry + RULES.targetAtr * s.atr;
      let outcome = null, exit = null, bars = 0;
      for (let j = 0; j < Math.min(c.length, RULES.maxBars); j++) {
        bars = j + 1;
        const hit = exitOnCandle(c[j], stop, target);
        if (hit) { outcome = hit.outcome; exit = hit.exit; break; }
      }
      if (!outcome && c.length >= RULES.maxBars) { outcome = "timeout"; exit = c[RULES.maxBars - 1].close; bars = RULES.maxBars; }
      if (!outcome) { s.progress = c.length; continue; }
      Object.assign(s, { status: "done", entry, exit, outcome, bars, net: (exit - entry) / entry - 2 * (s.cost || 0), resolvedAt: Date.now() });
    }
  } finally {
    resolving = false;
    save();
  }
}

/* ---------- UI ---------- */
export function initSignals(h) {
  hooks = { ...hooks, ...h };
  $("tab-signals").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.pick) hooks.onPick(b.dataset.pick);
    if (b.id === "sig-clear" && confirm("Clear Entryvex's signal record in this browser?")) { signals = []; save(); }
  });
  render();
  resolveOpen();
  setInterval(resolveOpen, 60_000);
}

const GROUPS = [
  ["edge", "GO (proven edge)", "Entryvex said this setup had a proven edge"],
  ["weak", "CAUTION (weak edge)", "slightly profitable before, not statistically clear"],
  ["thin", "UNPROVEN", "too few past examples to measure"],
  ["flat", "NO CLEAR EDGE", "roughly break-even before; any profit looked like luck"],
  ["negative", "NO TRADE", "Entryvex said skip it: it lost money before"],
];

function render() {
  const root = $("tab-signals");
  if (!root) return;
  const done = signals.filter((s) => s.status === "done");
  const open = signals.filter((s) => s.status === "open");
  const groups = GROUPS.map(([lvl, label, why]) => {
    const g = done.filter((s) => s.verdict === lvl);
    const wins = g.filter((s) => s.net > 0).length;
    const avg = g.length ? g.reduce((a, s) => a + s.net, 0) / g.length : NaN;
    const expected = g.length ? g.reduce((a, s) => a + (s.winRate || 0), 0) / g.length : NaN;
    return { lvl, label, why, n: g.length, winRate: g.length ? wins / g.length : NaN, avg, expected };
  });
  root.innerHTML = `
    <p class="muted small explain">This is Entryvex's <strong>live report card</strong>. Every setup that fires while Entryvex is open is saved with the verdict it gave,
      then checked against real candles afterwards using the same rules as the scanner. If the live results match the scanner's confidence over time, you can trust it more;
      if they don't, you'll see it here. ${open.length ? `<strong>${open.length}</strong> signal${open.length === 1 ? " is" : "s are"} still playing out.` : ""}</p>
    <div class="sig-groups">${groups.map((g) => `
      <div class="sig-group pill-${g.lvl}-box">
        <div class="sig-title"><span class="pill pill-${g.lvl}">${g.label}</span><span class="muted small">${g.why}</span></div>
        <div class="sig-nums">
          <div><span>Finished</span><strong class="mono">${g.n}</strong></div>
          <div><span>Ended in profit</span><strong class="mono">${g.n ? Math.round(g.winRate * 100) + "%" : "—"}</strong></div>
          <div><span>Scanner expected</span><strong class="mono">${g.n ? Math.round(g.expected * 100) + "%" : "—"}</strong></div>
          <div><span>Avg per trade</span><strong class="mono ${g.avg > 0 ? "up" : g.avg < 0 ? "down" : ""}">${g.n ? fmt.pct(g.avg * 100) : "—"}</strong></div>
        </div>
      </div>`).join("")}</div>
    ${done.length < 20 ? `<p class="muted tiny">Small samples are noisy. Judge the record after 30+ finished signals per group.</p>` : ""}
    <h3>Recent signals ${signals.length ? `<button class="link-btn" id="sig-clear">Clear</button>` : ""}</h3>
    ${signals.length ? `<div class="table-wrap"><table class="setups"><thead><tr><th>When</th><th>Coin</th><th>Setup</th><th>Verdict</th><th class="num">Result</th></tr></thead><tbody>
      ${signals.slice().reverse().slice(0, 60).map((s) => `<tr>
        <td class="muted">${new Date(s.signalTime * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} <span class="small">${s.interval}</span></td>
        <td><button class="link-btn" data-pick="${s.symbol}">${fmt.esc(baseOf(s.symbol))}</button></td>
        <td>${fmt.esc(s.setup)}</td>
        <td><span class="pill pill-${s.verdict}">${fmt.esc(s.verdictLabel)}</span></td>
        <td class="num mono ${s.status === "done" ? (s.net > 0 ? "up" : "down") : "muted"}">${s.status === "done"
          ? `${fmt.pct(s.net * 100)} <span class="small muted">${{ target: "🎯", stop: "stop", timeout: "time" }[s.outcome]}</span>`
          : `playing out${s.progress ? ` (${s.progress}/${RULES.maxBars})` : ""}`}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted small">No signals recorded yet. Keep Entryvex open (turn on setup alerts in 🔔 to watch your whole watchlist) and signals will appear here as they fire.</p>`}`;
}
