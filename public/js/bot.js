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
  const learned = data.memory.filter((m) => m.status === "benched" || m.status === "promoted");
  el.innerHTML = `
    <div class="bot-head">
      <div>
        <h3>🤖 Entryvex paper-trading bot <span class="pill ${statusCls}">${s.status === "proven" ? "Proven" : s.status === "learning" ? "Learning" : "Not proven"}</span></h3>
        <p class="muted small">Trades a <strong>virtual $${data.startUsd}</strong> on its own, 24/7, across ${data.markets.length} markets (${data.markets.map((m) => fmt.esc(m.name)).join(", ")}) at live prices, with fees, stop-losses and targets. Before each buy it checks the chart, the setup's record, the AI news read and (for stocks) earnings dates. No real money. Started ${when(data.startedAt)} (${s.days.toFixed(1)} days ago).</p>
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
        <div><strong>${fmt.esc(p.market)}: bought at ${fmt.price(p.entry)}</strong> <span class="muted small">${when(p.openedAt)} · ${fmt.esc(p.name)} on ${IV[p.iv] || p.iv} candles · ${p.mode === "trusted" ? "trusted setup" : "exploring (small size)"}</span></div>
        <div class="small">Now ${fmt.price(p.last || p.entry)} · <span class="${openPnl >= 0 ? "up" : "down"}">${openPnl >= 0 ? "+" : "−"}$${Math.abs(openPnl).toFixed(2)}</span> · stop ${fmt.price(p.stop)} · target ${fmt.price(p.target)} · sells by ${when(p.sellBy)}</div>
        <div class="muted small">${fmt.esc(p.why)}</div>
        <button class="link-btn small" data-bot-open="${fmt.esc(p.sym)}">Open ${fmt.esc(p.market)} on the chart</button>
      </div>`; }).join("") : `<p class="muted small">No trade open. It's waiting for a setup with a good record on a 1h, 4h or daily candle close.</p>`}

    <h3>By market</h3>
    <div class="bot-mem">${(data.perMarket || []).filter((m) => m.trades || m.open).map((m) => `<div class="bot-mem-row">
        <span><button class="link-btn" data-bot-open="${fmt.esc(m.sym)}">${fmt.esc(m.name)}</button>${m.open ? " <span class=\"pill pill-on\">open</span>" : ""}</span>
        <span class="mono">${m.trades} trade${m.trades === 1 ? "" : "s"} · ${m.wins} won</span>
        <strong class="mono ${m.pnl >= 0 ? "up" : "down"}">${m.pnl >= 0 ? "+" : "−"}$${Math.abs(m.pnl).toFixed(2)}</strong></div>`).join("") || `<p class="muted small">No trades yet.</p>`}</div>

    <h3>What it has learned ${learned.length ? `<span class="pill pill-thin">${learned.length}</span>` : ""}</h3>
    ${data.memory.length ? `<div class="bot-mem">${data.memory.slice(0, 16).map((m) => `<div class="bot-mem-row ${m.status}">
        <span>${m.market ? `${fmt.esc(m.market)} · ` : ""}${fmt.esc(m.name)}${m.iv && m.iv !== "*" ? ` · ${IV[m.iv] || m.iv}` : ""}${m.regime ? ` · ${m.regime === "down" ? "falling market" : m.regime === "up" ? "rising market" : "—"}` : ""}</span>
        <span class="mono">${m.wins}/${m.n} won · avg ${pc(m.avg)}</span>
        <span class="pill ${m.status === "benched" ? "pill-negative" : m.status === "promoted" ? "pill-edge" : "pill-thin"}">${m.status === "benched" ? (m.group ? "stopped" : "benched") : m.status === "promoted" ? "promoted" : "still testing"}</span></div>`).join("")}</div>`
      : `<p class="muted small">Nothing yet. Every trade it closes is added here.</p>`}

    <h3>Trades and lessons</h3>
    ${trades.length ? `<div class="bot-trades">${trades.map((t) => `<div class="bot-trade">
        <div><span class="pill ${t.pnl >= 0 ? "pill-edge" : "pill-negative"}">${t.pnl >= 0 ? "WIN" : "LOSS"}</span>
          <strong class="${t.pnl >= 0 ? "up" : "down"}">${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${pc(t.ret)})</strong>
          <strong>${fmt.esc(t.market || "BTC")}</strong>
          <span class="muted small">${when(t.openedAt)} → ${when(t.closedAt)} · bought ${fmt.price(t.entry)}, sold ${fmt.price(t.exit)} · ${fmt.esc(t.name)} ${IV[t.iv] || t.iv} · ${t.mode === "trusted" ? "trusted" : "exploring"}${t.news && t.news !== "none" ? ` · news ${t.news}` : ""}</span></div>
        <div class="small">${fmt.esc(t.lesson)}</div></div>`).join("")}</div>
      ${data.trades.length > 12 ? `<button class="link-btn small" id="bot-more">${showAll ? "Show fewer" : `Show all ${data.trades.length} trades`}</button>` : ""}`
      : `<p class="muted small">No closed trades yet.</p>`}

    <details class="picks-honest"><summary>How the bot works</summary><ul class="small">
      <li>Every 5 minutes it checks its markets. When a 1h, 4h or daily candle closes (stocks: during market hours) it looks for Entryvex's setups and candle patterns.</li>
      <li>Before buying it also checks the <strong>AI news read</strong> for that market (it skips unproven setups when the news is negative) and, for stocks, the <strong>earnings calendar</strong>: no buys within 3 trading days of a report, and it sells before one.</li>
      <li><strong>Trusted</strong> setups (a winning record in a daily re-test, in the current kind of market) get a normal trade: it risks ${(data.settings.riskTrusted * 100).toFixed(1)}% of its balance at the stop-loss. <strong>Unproven</strong> ones get small "exploring" trades (${(data.settings.riskExplore * 100).toFixed(1)}% risk) so it gathers evidence. Setups with a losing record are skipped.</li>
      <li>It learns from every closed trade, per market: a setup that keeps losing in a kind of market is <strong>benched</strong>; an unproven one that keeps winning is <strong>promoted</strong>; if buying on a news mood keeps losing, it <strong>stops</strong> doing that; if exploring keeps losing in a kind of market, it stops exploring there.</li>
      <li>Fees: ${(data.settings.fee.crypto * 100).toFixed(2)}% per buy and per sell for crypto, ${(data.settings.fee.stock * 100).toFixed(2)}% for stocks (spread). Up to ${data.settings.maxPositions} trades at once, each at most ${data.settings.maxPositionShare * 100}% of the account, no borrowing.</li>
      <li>It's called <strong>Proven</strong> only after 30+ trades if it's profitable after fees, ahead of just holding these markets, and unlikely to be luck (t ≥ 2). Replayed on the 30 days before launch, it lost 1.5% while holding all 12 equally lost 18.3%: much better than holding in a falling market, but not yet a winner.</li>
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
