// "🤖 Bot" tab: the paper-trading bot's public record (functions/api/bot.js runs it on the server).
// Shows its virtual balance vs simply holding BTC, whether it has proven anything, the open trade,
// every trade with its lesson, and what it has learned. "Follow the bot" sends its trades as alerts.
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};
let hooks = { notify: () => {}, onFollowChange: () => {}, openMarket: () => {} };
let data = null, visible = false, timer = null, chart = null, showAll = false, ticks = 0;

export const followBot = () => !!store.get("followBot", false);

export function initBot(h) {
  hooks = { ...hooks, ...h };
  $("tab-bot").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "bot-follow") { store.set("followBot", !followBot()); hooks.onFollowChange(); render(); }
    if (b.id === "bot-more") { showAll = !showAll; render(); }
    if (b.dataset.botOpen) hooks.openMarket(b.dataset.botOpen);
  });
  // Followers get the bot's trades as in-app alerts while Entryvex is open (and via push/ntfy when closed).
  load();
  poll();
}

/** What the bot is doing on one market (from the last loaded record; null if unknown). */
export function botViewCached(sym) {
  if (!data?.started) return null;
  const holding = (data.positions || []).find((p) => p.sym === sym) || null;
  const t = (data.trades || []).filter((x) => x.sym === sym);
  return { holding, trades: t.length, wins: t.filter((x) => x.pnl > 0).length };
}
/** The last loaded record (null until loaded). */
export function botData() { return data; }
export function botVisible(on) { visible = on; if (on) { load().then(render); } }

async function load() {
  try { const r = await fetch("/api/bot", { cache: "no-store" }); if (r.ok) data = await r.json(); } catch {}
  return data;
}
function poll() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    ticks++;
    // Every minute while you're watching or following it; every 5 minutes otherwise (for the answer card).
    if (followBot() || visible || ticks % 5 === 0) {
      const before = store.get("botSeen", 0);
      await load();
      const fresh = (data?.events || []).filter((e) => e.t > before && (e.kind === "open" || e.kind === "close"));
      if (data?.events?.length) store.set("botSeen", Math.max(before, ...data.events.map((e) => e.t)));
      if (followBot() && before) for (const e of fresh.reverse()) hooks.notify({ kind: "info", symbol: e.sym || null, title: `🤖 ${e.title}`, body: e.body });
      if (visible) render();
    }
    poll();
  }, 60_000);
}

const pc = (x, d = 2) => (x == null || !isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const money = (x) => `$${(+x).toFixed(2)}`;
const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const IV = { "1h": "1h", "4h": "4h", "1d": "1D" };

function render() {
  const el = $("tab-bot");
  if (!el) return;
  if (!data) { el.innerHTML = `<p class="muted small">Loading the bot's record…</p>`; return; }
  if (!data.started) { el.innerHTML = `<p class="muted small">${fmt.esc(data.note || "The bot hasn't started yet.")}</p>`; return; }
  const s = data.summary, positions = data.positions || [];
  const statusCls = s.status === "proven" ? "pill-edge" : s.status === "learning" ? "pill-thin" : "pill-negative";
  const feeOf = (sym) => (sym.startsWith("S:") ? data.settings.fee.stock : data.settings.fee.crypto);
  const trades = showAll ? data.trades : data.trades.slice(0, 12);
  el.innerHTML = `
    <div class="bot-head">
      <div>
        <h3>🤖 Entryvex paper-trading bot <span class="pill ${statusCls}">${s.status === "proven" ? "Proven" : s.status === "learning" ? "Learning" : "Not proven"}</span></h3>
        <p class="muted small">Trades a <strong>virtual $${data.startUsd}</strong> on its own, 24/7, across ${data.markets.length} markets (${data.markets.map((m) => fmt.esc(m.name)).join(", ")}) at live prices, with fees. It follows Entryvex's <strong>trend rule</strong>: buy when a daily candle closes at a new 20-day high in an uptrend, then sell with a trailing stop. No real money. Started ${when(data.startedAt)} (${s.days.toFixed(1)} days ago).${data.previous?.trades ? ` <span class="muted">Rebuilt from an older version that made ${data.previous.trades} short-term trades${data.previous.equity != null ? ` and ended at $${data.previous.equity.toFixed(2)}` : ""}.</span>` : ""}</p>
      </div>
      <button class="${followBot() ? "ghost-btn" : "btn"}" id="bot-follow" title="Get an alert every time the bot buys or sells (in the app; on your phone too if closed-app or ntfy alerts are on)">${followBot() ? "✓ Following" : "🔔 Follow the bot"}</button>
    </div>
    <p class="small bot-status">${fmt.esc(s.statusText)}</p>
    <div class="bot-tiles">
      <div><span>Bot balance</span><strong class="${s.returnPct >= 0 ? "up" : "down"}">${money(s.equity)}</strong><small>${pc(s.returnPct)} since start</small></div>
      <div><span>Just holding all ${data.markets.length} equally</span><strong class="${s.holdPct >= 0 ? "up" : "down"}">${money(data.startUsd * (1 + s.holdPct))}</strong><small>${pc(s.holdPct)} since start</small></div>
      <div><span>Trades</span><strong>${s.trades}</strong><small>${s.trades ? `${s.wins} won (${Math.round(s.winRate * 100)}%) · avg ${pc(s.avgPerTrade)}` : "none yet"}</small></div>
      <div><span>Worst drop</span><strong class="down">${pc(s.maxDrawdown, 1)}</strong><small>from its highest balance</small></div>
    </div>
    <div id="bot-chart" class="bot-chart"></div>
    <div class="picks-legend small"><span><i style="background:#2ee59d"></i>Bot balance</span><span><i style="background:#7aa2ff"></i>$${data.startUsd} split across all ${data.markets.length}, just held</span></div>

    <h3>Open trades <span class="muted small">${positions.length} of ${data.settings.maxPositions} max</span></h3>
    ${positions.length ? positions.map((p) => {
      const openPnl = p.qty * (p.last || p.entry) * (1 - feeOf(p.sym)) - p.cost;
      return `<div class="bot-pos">
        <div><strong>${fmt.esc(p.market)}: bought at ${fmt.price(p.entry)}</strong> <span class="muted small">${when(p.openedAt)} · ${fmt.esc(p.name)} on ${IV[p.iv] || p.iv} candles${p.mode === "trend" ? "" : p.mode === "trusted" ? " · trusted setup" : " · exploring (small size)"}</span></div>
        <div class="small">Now ${fmt.price(p.last || p.entry)} · <span class="${openPnl >= 0 ? "up" : "down"}">${openPnl >= 0 ? "+" : "−"}$${Math.abs(openPnl).toFixed(2)}</span> · ${p.trail
          ? `trailing stop <strong>${fmt.price(p.stop)}</strong>${p.stop > p.firstStop ? ` (moved up from ${fmt.price(p.firstStop)})` : ""} · highest since buying ${fmt.price(p.hi || p.entry)} · no fixed target`
          : `stop ${fmt.price(p.stop)} · target ${fmt.price(p.target)} · sells by ${when(p.sellBy)}`}</div>
        <div class="muted small">${fmt.esc(p.why)}</div>
        <button class="link-btn small" data-bot-open="${fmt.esc(p.sym)}">Open ${fmt.esc(p.market)} on the chart</button>
      </div>`; }).join("") : `<p class="muted small">No trade open. It's waiting for a daily close at a new 20-day high in one of its markets while that market is in an uptrend. That can take days or weeks; waiting is part of the rule.</p>`}

    <h3>By market</h3>
    <div class="bot-mem">${(data.perMarket || []).filter((m) => m.trades || m.open).map((m) => `<div class="bot-mem-row">
        <span><button class="link-btn" data-bot-open="${fmt.esc(m.sym)}">${fmt.esc(m.name)}</button>${m.open ? " <span class=\"pill pill-on\">open</span>" : ""}</span>
        <span class="mono">${m.trades} trade${m.trades === 1 ? "" : "s"} · ${m.wins} won</span>
        <strong class="mono ${m.pnl >= 0 ? "up" : "down"}">${m.pnl >= 0 ? "+" : "−"}$${Math.abs(m.pnl).toFixed(2)}</strong></div>`).join("") || `<p class="muted small">No trades yet.</p>`}</div>

    <h3>Trades and lessons</h3>
    ${trades.length ? `<div class="bot-trades">${trades.map((t) => `<div class="bot-trade">
        <div><span class="pill ${t.pnl >= 0 ? "pill-edge" : "pill-negative"}">${t.pnl >= 0 ? "WIN" : "LOSS"}</span>
          <strong class="${t.pnl >= 0 ? "up" : "down"}">${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${pc(t.ret)})</strong>
          <strong>${fmt.esc(t.market || "BTC")}</strong>
          <span class="muted small">${when(t.openedAt)} → ${when(t.closedAt)} · bought ${fmt.price(t.entry)}, sold ${fmt.price(t.exit)} · ${fmt.esc(t.name)} ${IV[t.iv] || t.iv}</span></div>
        <div class="small">${fmt.esc(t.lesson)}</div></div>`).join("")}</div>
      ${data.trades.length > 12 ? `<button class="link-btn small" id="bot-more">${showAll ? "Show fewer" : `Show all ${data.trades.length} trades`}</button>` : ""}`
      : `<p class="muted small">No closed trades yet.</p>`}

    <details class="picks-honest"><summary>How the bot works</summary><ul class="small">
      <li>After every daily close (stocks: checked during market hours) it looks at each of its ${data.markets.length} markets. It buys when a day closes above the highest price of the previous 20 days while the market is in an uptrend: price above its 200-day average and the 50-day average above the 200-day.</li>
      <li>It sells with a <strong>trailing stop</strong>: first ${data.settings.stopAtr} ATR (a measure of the normal daily move) under the entry, then ${data.settings.trailAtr} ATR under the highest price since it bought, moved up after every daily close and never down. There's no fixed take-profit, so winners can run. Most trades end in a small loss; a few big winners are what pay for them.</li>
      <li>Why this rule: Entryvex replayed its signals on years of data they never saw. The old short-term setups didn't beat fees or buying at random moments. This trend rule made money after fees on daily charts (a little more than random timing) and its worst drops were less than half as deep as just holding, though it earned less than holding in these strongly rising markets. See the Scorecard tab.</li>
      <li>It risks ${(data.settings.risk * 100).toFixed(0)}% of its balance per trade at the first stop, holds up to ${data.settings.maxPositions} trades at once, each at most ${data.settings.maxPositionShare * 100}% of the account, no borrowing. Stocks: no buys within ${data.settings.earningsDays} trading days of an earnings report, and it sells before one.</li>
      <li>Fees: ${(data.settings.fee.crypto * 100).toFixed(2)}% per buy and per sell for crypto, ${(data.settings.fee.stock * 100).toFixed(2)}% for stocks (spread).</li>
      <li>It's called <strong>Proven</strong> only after 30+ trades if it's profitable after fees, ahead of just holding these markets, and unlikely to be luck (t ≥ 2). Trend trades are slow, so that will take months.</li>
      <li>This is a simulation for research. Real orders can fill at slightly different prices. It never trades your money.</li>
    </ul></details>`;
  drawChart();
}

function drawChart() {
  const el = $("bot-chart");
  if (!el || !window.LightweightCharts || !data?.equity?.length) return;
  if (chart) { try { chart.remove(); } catch {} chart = null; }
  chart = window.LightweightCharts.createChart(el, {
    height: 200, layout: { background: { color: "transparent" }, textColor: "#9aa4b2" },
    grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true }, handleScroll: false, handleScale: false,
  });
  const seen = new Set();
  const pts = data.equity.filter(([t]) => { const k = Math.floor(t / 1000); if (seen.has(k)) return false; seen.add(k); return true; });
  const fmtUsd = { type: "custom", formatter: (v) => "$" + v.toFixed(2) };
  chart.addLineSeries({ color: "#7aa2ff", lineWidth: 2, priceLineVisible: false, priceFormat: fmtUsd })
    .setData(pts.map(([t, , basket]) => ({ time: Math.floor(t / 1000), value: basket })));
  chart.addLineSeries({ color: "#2ee59d", lineWidth: 2, priceLineVisible: false, priceFormat: fmtUsd })
    .setData(pts.map(([t, e]) => ({ time: Math.floor(t / 1000), value: e })));
  chart.timeScale().fitContent();
}
