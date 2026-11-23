// "🤖 Bot" tab: the paper-trading bot's public record (functions/api/bot.js runs it on the server).
// Shows its virtual balance vs simply holding BTC, whether it has proven anything, the open trade,
// every trade with its lesson, and what it has learned. "Follow the bot" sends its trades as alerts.
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};
let hooks = { notify: () => {}, onFollowChange: () => {}, openBtc: () => {} };
let data = null, visible = false, timer = null, chart = null, showAll = false;

export const followBot = () => !!store.get("followBot", false);

export function initBot(h) {
  hooks = { ...hooks, ...h };
  $("tab-bot").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "bot-follow") { store.set("followBot", !followBot()); hooks.onFollowChange(); render(); }
    if (b.id === "bot-more") { showAll = !showAll; render(); }
    if (b.id === "bot-open-btc") hooks.openBtc();
  });
  // Followers get the bot's trades as in-app alerts while Entryvex is open (and via push/ntfy when closed).
  poll();
}
export function botVisible(on) { visible = on; if (on) { load().then(render); } }

async function load() {
  try { const r = await fetch("/api/bot", { cache: "no-store" }); if (r.ok) data = await r.json(); } catch {}
  return data;
}
function poll() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (followBot() || visible) {
      const before = store.get("botSeen", 0);
      await load();
      const fresh = (data?.events || []).filter((e) => e.t > before && (e.kind === "open" || e.kind === "close"));
      if (data?.events?.length) store.set("botSeen", Math.max(before, ...data.events.map((e) => e.t)));
      if (followBot() && before) for (const e of fresh.reverse()) hooks.notify({ kind: "info", symbol: "BTCUSDT", title: `🤖 ${e.title}`, body: e.body });
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
  const s = data.summary, p = data.position;
  const statusCls = s.status === "proven" ? "pill-edge" : s.status === "learning" ? "pill-thin" : "pill-negative";
  const openPnl = p ? p.qty * data.price * (1 - data.settings.feePerSide) - p.cost : null;
  const trades = showAll ? data.trades : data.trades.slice(0, 12);
  const learned = data.memory.filter((m) => m.status === "benched" || m.status === "promoted");
  el.innerHTML = `
    <div class="bot-head">
      <div>
        <h3>🤖 Entryvex paper-trading bot <span class="pill ${statusCls}">${s.status === "proven" ? "Proven" : s.status === "learning" ? "Learning" : "Not proven"}</span></h3>
        <p class="muted small">Trades a <strong>virtual $${data.startUsd}</strong> of BTC on its own, 24/7, at live Binance.US prices with fees, stop-losses and targets. No real money. Started ${when(data.startedAt)} (${s.days.toFixed(1)} days ago).</p>
      </div>
      <button class="${followBot() ? "ghost-btn" : "btn"}" id="bot-follow" title="Get an alert every time the bot buys or sells (in the app; on your phone too if closed-app or ntfy alerts are on)">${followBot() ? "✓ Following" : "🔔 Follow the bot"}</button>
    </div>
    <p class="small bot-status">${fmt.esc(s.statusText)}</p>
    <div class="bot-tiles">
      <div><span>Bot balance</span><strong class="${s.returnPct >= 0 ? "up" : "down"}">${money(s.equity)}</strong><small>${pc(s.returnPct)} since start</small></div>
      <div><span>Just holding BTC</span><strong class="${s.holdPct >= 0 ? "up" : "down"}">${money(data.startUsd * (1 + s.holdPct))}</strong><small>${pc(s.holdPct)} since start</small></div>
      <div><span>Trades</span><strong>${s.trades}</strong><small>${s.trades ? `${s.wins} won (${Math.round(s.winRate * 100)}%) · avg ${pc(s.avgPerTrade)}` : "none yet"}</small></div>
      <div><span>Worst drop</span><strong class="down">${pc(s.maxDrawdown, 1)}</strong><small>from its highest balance</small></div>
    </div>
    <div id="bot-chart" class="bot-chart"></div>
    <div class="picks-legend small"><span><i style="background:#2ee59d"></i>Bot balance</span><span><i style="background:#7aa2ff"></i>$${data.startUsd} of BTC just held</span></div>

    <h3>Open trade</h3>
    ${p ? `<div class="bot-pos">
        <div><strong>Bought ${(+p.qty).toFixed(6)} BTC at $${p.entry.toFixed(0)}</strong> <span class="muted small">${when(p.openedAt)} · ${fmt.esc(p.name)} on ${IV[p.iv] || p.iv} candles · ${p.mode === "trusted" ? "trusted setup" : "exploring (small size)"}</span></div>
        <div class="small">Now $${(+data.price).toFixed(0)} · <span class="${openPnl >= 0 ? "up" : "down"}">${openPnl >= 0 ? "+" : "−"}$${Math.abs(openPnl).toFixed(2)}</span> · stop $${p.stop.toFixed(0)} · target $${p.target.toFixed(0)} · sells by ${when(p.sellBy)}</div>
        <div class="muted small">${fmt.esc(p.why)}</div>
        <button class="link-btn small" id="bot-open-btc">Open BTC on the chart</button>
      </div>` : `<p class="muted small">No trade open. It's waiting for a setup on a 1h, 4h or daily candle close.</p>`}

    <h3>What it has learned ${learned.length ? `<span class="pill pill-thin">${learned.length}</span>` : ""}</h3>
    ${data.memory.length ? `<div class="bot-mem">${data.memory.slice(0, 16).map((m) => `<div class="bot-mem-row ${m.status}">
        <span>${fmt.esc(m.name)}${m.iv !== "*" ? ` · ${IV[m.iv] || m.iv}` : ""} · ${m.regime === "down" ? "falling market" : m.regime === "up" ? "rising market" : "—"}</span>
        <span class="mono">${m.wins}/${m.n} won · avg ${pc(m.avg)}</span>
        <span class="pill ${m.status === "benched" ? "pill-negative" : m.status === "promoted" ? "pill-edge" : "pill-thin"}">${m.status === "benched" ? (m.group ? "stopped exploring" : "benched") : m.status === "promoted" ? "promoted" : "still testing"}</span></div>`).join("")}</div>`
      : `<p class="muted small">Nothing yet. Every trade it closes is added here.</p>`}

    <h3>Trades and lessons</h3>
    ${trades.length ? `<div class="bot-trades">${trades.map((t) => `<div class="bot-trade">
        <div><span class="pill ${t.pnl >= 0 ? "pill-edge" : "pill-negative"}">${t.pnl >= 0 ? "WIN" : "LOSS"}</span>
          <strong class="${t.pnl >= 0 ? "up" : "down"}">${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${pc(t.ret)})</strong>
          <span class="muted small">${when(t.openedAt)} → ${when(t.closedAt)} · bought $${t.entry.toFixed(0)}, sold $${t.exit.toFixed(0)} · ${fmt.esc(t.name)} ${IV[t.iv] || t.iv} · ${t.mode === "trusted" ? "trusted" : "exploring"}</span></div>
        <div class="small">${fmt.esc(t.lesson)}</div></div>`).join("")}</div>
      ${data.trades.length > 12 ? `<button class="link-btn small" id="bot-more">${showAll ? "Show fewer" : `Show all ${data.trades.length} trades`}</button>` : ""}`
      : `<p class="muted small">No closed trades yet.</p>`}

    <details class="picks-honest"><summary>How the bot works</summary><ul class="small">
      <li>Every 5 minutes it checks BTC. When a 1h, 4h or daily candle closes it looks for Entryvex's setups and candle patterns.</li>
      <li><strong>Trusted</strong> setups (a winning record in a daily re-test, in the current kind of market) get a normal trade: it risks ${(data.settings.riskTrusted * 100).toFixed(1)}% of its balance at the stop-loss. <strong>Unproven</strong> ones get small "exploring" trades (${(data.settings.riskExplore * 100).toFixed(1)}% risk) so it gathers evidence. Setups with a losing record are skipped.</li>
      <li>It learns from every closed trade: a setup that keeps losing in a kind of market is <strong>benched</strong>; an unproven one that keeps winning is <strong>promoted</strong>; if its exploring trades keep losing in a kind of market, it <strong>stops exploring</strong> there.</li>
      <li>Fees: ${(data.settings.feePerSide * 100).toFixed(2)}% per buy and per sell. One trade at a time, no borrowing, Binance.US's $${data.settings.minNotional} minimum.</li>
      <li>It's called <strong>Proven</strong> only after 30+ trades if it's profitable after fees, ahead of just holding BTC, and unlikely to be luck (t ≥ 2). Replayed on the last 90 days before launch, it lost 5.7% while holding BTC lost 23.5%: better than holding in a falling market, but not yet a winner.</li>
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
    .setData(pts.map(([t, , px]) => ({ time: Math.floor(t / 1000), value: data.startUsd * (px / data.startPrice) })));
  chart.addLineSeries({ color: "#2ee59d", lineWidth: 2, priceLineVisible: false, priceFormat: fmtUsd })
    .setData(pts.map(([t, e]) => ({ time: Math.floor(t / 1000), value: e })));
  chart.timeScale().fitContent();
}
