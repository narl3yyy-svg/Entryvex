// Setup Scanner panel: runs the engine for the selected coin and draws the results.
import { analyze, RULES } from "./engine.js";
import { getKlineHistory, getBookTicker } from "./binance.js";
import { coinName } from "./coins.js";
import * as fmt from "./format.js";
import { renderTradeCard, setMarketContext, onMoneyChange } from "./money.js";
import { logFromAnalysis } from "./signals.js";

const $ = (id) => document.getElementById(id);
const HISTORY = 3000;
const MINUTES = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };

const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};

export function createScanner({ chartSeries, getWatchlist, getBase, getInfo, onPickSymbol, onShowTrades, onAnalyzed, onPickInterval }) {
  let ctx = null;          // { symbol, interval, candles, spreadPct }
  let result = null;
  let token = 0;
  let shownSetup = null;   // setup whose past trades are drawn on the chart
  let priceLines = [];

  const feeInput = $("fee");
  feeInput.value = store.get("feePct", 0.02);
  feeInput.addEventListener("change", () => {
    const v = Math.max(0, Math.min(2, +feeInput.value || 0));
    feeInput.value = v;
    store.set("feePct", v);
    if (ctx) recompute();
  });
  $("scan-all").addEventListener("click", scanWatchlist);
  onMoneyChange(() => { if (ctx && result) render(); });

  function costPerSide(spreadPct) {
    const fee = (+feeInput.value || 0) / 100;
    return fee + (isFinite(spreadPct) ? spreadPct / 2 : 0);
  }

  async function analyzeSymbol(symbol, interval) {
    const my = ++token;
    ctx = null; result = null; shownSetup = null;
    clearChart();
    $("verdict").innerHTML = `<div class="verdict-loading">Testing every setup against the last ${HISTORY.toLocaleString()} ${interval} candles…</div>`;
    $("plan").innerHTML = ""; $("setups").innerHTML = ""; $("method").textContent = "";
    try {
      const [candles, book] = await Promise.all([
        getKlineHistory(symbol, interval, HISTORY),
        getBookTicker(symbol).catch(() => ({ spreadPct: NaN })),
      ]);
      if (my !== token) return;
      ctx = { symbol, interval, candles, spreadPct: book.spreadPct };
      recompute();
    } catch (e) {
      if (my !== token) return;
      console.warn(e);
      $("verdict").innerHTML = `<div class="verdict-loading">Couldn't load history from Binance.US. It will retry on the next candle.</div>`;
    }
  }

  /** Feed live candles in so the analysis stays current. */
  function onCandle(c) {
    if (!ctx) return;
    const arr = ctx.candles;
    const last = arr[arr.length - 1];
    if (last && last.time === c.time) arr[arr.length - 1] = c;
    else if (!last || c.time > last.time) { arr.push(c); if (arr.length > HISTORY + 50) arr.shift(); }
    if (c.closed) recompute();
  }

  function recompute() {
    result = analyze(ctx.candles, { costPerSide: costPerSide(ctx.spreadPct) });
    logFromAnalysis(ctx.symbol, ctx.interval, ctx.candles, result);
    render();
    onAnalyzed?.(ctx, result);
  }

  /* ----- "Find an edge": test this coin on several candle sizes ----- */
  $("find-edges").addEventListener("click", findEdges);
  async function findEdges() {
    if (!ctx) return;
    const sym = ctx.symbol;
    const box = $("edges");
    const btn = $("find-edges");
    btn.disabled = true;
    box.innerHTML = `<div class="verdict-loading">Testing ${fmt.esc(coinName(getBase()))} on 5m, 15m, 1h and 4h candles…</div>`;
    const rows = [];
    for (const iv of ["5m", "15m", "1h", "4h"]) {
      try {
        const [c, book] = await Promise.all([getKlineHistory(sym, iv, HISTORY), getBookTicker(sym).catch(() => ({ spreadPct: NaN }))]);
        const r = analyze(c, { costPerSide: costPerSide(book.spreadPct) });
        for (const s of r.setups) if (s.stats.n) rows.push({ iv, s });
      } catch {}
    }
    btn.disabled = false;
    if (sym !== ctx?.symbol) return;
    rows.sort((a, b) => b.s.stats.ev - a.s.stats.ev);
    const good = rows.filter((x) => x.s.verdict.level === "edge" || x.s.verdict.level === "weak");
    box.innerHTML = `<div class="edges-card">
      <div class="edges-head"><strong>Where ${fmt.esc(coinName(getBase()))} has had an edge</strong><button class="link-btn" data-close-edges>Hide</button></div>
      ${good.length ? `<p class="small muted">These setup + candle-size combos made money after costs in the past. Click one to switch to it; then wait for it to show "Active".</p>`
        : `<p class="small">No setup has made money after costs on any candle size for this coin recently. <strong>That's useful to know: don't force trades here.</strong> Try another coin with "Scan watchlist".</p>`}
      <div class="edge-list">${rows.slice(0, 8).map(({ iv, s }) => `
        <button class="edge-row" data-iv="${iv}">
          <span class="mono edge-iv">${iv}</span><span>${fmt.esc(s.name)}</span>
          <span class="pill pill-${s.verdict.level}">${s.verdict.label}</span>
          <span class="mono small">${pctRound(s.stats.winRate)} of ${s.stats.n}</span>
          <span class="mono small ${s.stats.ev > 0 ? "up" : "down"}">${fmt.pct(s.stats.ev * 100)}/trade</span>
          ${s.activeNow ? `<span class="pill pill-on">Active now</span>` : ""}
        </button>`).join("")}</div></div>`;
    box.querySelectorAll(".edge-row").forEach((b) => b.addEventListener("click", () => onPickInterval?.(b.dataset.iv)));
    box.querySelector("[data-close-edges]").addEventListener("click", () => (box.innerHTML = ""));
  }

  function render() {
    const r = result, { interval } = ctx;
    const best = r.best;
    $("scan-sub").textContent = `${coinName(getBase())} · ${interval} candles · updates every closed candle`;

    // Verdict banner
    let conf = "";
    if (best && best.stats.n) {
      const s = best.stats;
      conf = `<div class="conf">
        <div class="conf-big mono">${Math.round(s.winRate * 100)}%</div>
        <div class="conf-text">
          <strong>Measured confidence:</strong> this setup ended in profit <strong>${Math.round(s.winRate * s.n)} of the last ${s.n}</strong> times it appeared here
          (likely true range ${pctRound(s.winLo)}–${pctRound(s.winHi)}). It needs ${pctRound(s.breakeven)} to break even.
        </div></div>`;
    }
    $("verdict").innerHTML = `
      <div class="verdict-bar v-${r.overall.level}">
        <span class="verdict-label">${r.overall.label}</span>
        <span class="verdict-text">${fmt.esc(r.overall.text)}</span>
      </div>${conf}`;

    // Trade plan for the active setup
    clearPriceLines();
    const info = getInfo(ctx.symbol) || {};
    const rules = { stepSize: info.stepSize, minQty: info.minQty, tickSize: info.tickSize, minNotional: info.minNotional };
    setMarketContext({
      symbol: ctx.symbol, base: info.base || getBase(), quote: info.quote || "USDT",
      price: r.price, atr: r.atr, costPerSide: r.costPerSide, rules,
    });
    if (r.plan && best && best.verdict.level !== "negative") {
      const p = r.plan;
      $("plan").innerHTML = renderTradeCard({
        plan: p, setup: best, costPerSide: r.costPerSide, rules,
        symbol: ctx.symbol, interval, verdictLevel: best.verdict.level,
        base: info.base || getBase(), quote: info.quote || "USDT",
        minutesToResolve: (p.medianBars || 0) * (MINUTES[interval] || 0),
        maxBarsText: `${RULES.maxBars} candles (${humanMinutes(RULES.maxBars * (MINUTES[interval] || 0))})`,
      });
      priceLines = [
        chartSeries.createPriceLine({ price: p.target, color: "#22c55e", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Target" }),
        chartSeries.createPriceLine({ price: p.entry, color: "#8a94a6", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "Entry" }),
        chartSeries.createPriceLine({ price: p.stop, color: "#f0506e", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Stop" }),
      ];
    } else {
      $("plan").innerHTML = "";
    }

    // Context: what it's watching and when something last fired
    let last = null;
    for (const s of r.setups) {
      const t = s.trades[s.trades.length - 1];
      if (t && (!last || t.signalTime > last.t.signalTime)) last = { s, t };
    }
    const lastTxt = last
      ? `Last setup here: <strong>${fmt.esc(last.s.name)}</strong> ${fmt.ago(last.t.signalTime * 1000)}, which ${last.t.net > 0 ? `<span class="up">ended in profit (${fmt.pct(last.t.net * 100)})</span>` : `<span class="down">ended in a loss (${fmt.pct(last.t.net * 100)})</span>`}.`
      : "No setup has fired in the loaded history.";
    const edgeCount = r.setups.filter((s) => s.verdict.level === "edge" || s.verdict.level === "weak").length;
    $("scan-context").innerHTML = `<span>Watching for 4 setups on <strong>${interval}</strong> candles; checks again every time a candle closes. ${lastTxt}</span>
      <span>${edgeCount ? `<strong>${edgeCount}</strong> of 4 setups have a positive record here; you'll get a trade card when one is active.` : `None of the 4 setups has made money here after costs. Try <button class="link-btn" data-find-edge>Find an edge</button> or another coin.`}</span>`;
    $("scan-context").querySelector("[data-find-edge]")?.addEventListener("click", findEdges);

    // Setups table
    $("setups").innerHTML = `
      <thead><tr>
        <th>Setup</th><th>Now</th><th class="num">Times seen</th><th class="num">Ended in profit</th>
        <th class="num">Avg win / loss</th><th class="num">Avg per trade</th><th>Verdict</th>
      </tr></thead>
      <tbody>${r.setups.map((s) => {
        const t = s.stats;
        return `<tr data-id="${s.id}" class="${shownSetup === s.id ? "shown" : ""}" title="Click to show its past trades on the chart">
          <td><div class="setup-name">${fmt.esc(s.name)}</div><div class="setup-desc">${fmt.esc(s.plain)}</div></td>
          <td>${s.activeNow ? `<span class="pill pill-on">Active</span>` : `<span class="muted">—</span>`}</td>
          <td class="num mono">${t.n}</td>
          <td class="num mono">${t.n ? `${pctRound(t.winRate)}<div class="sub">${pctRound(t.winLo)}–${pctRound(t.winHi)}</div>` : "—"}</td>
          <td class="num mono">${t.n ? `<span class="up">${fmt.pct(t.avgWin * 100)}</span><div class="sub down">${fmt.pct(t.avgLoss * 100)}</div>` : "—"}</td>
          <td class="num mono ${t.ev > 0 ? "up" : t.ev < 0 ? "down" : ""}">${t.n ? fmt.pct(t.ev * 100) : "—"}</td>
          <td><span class="pill pill-${s.verdict.level}" title="${fmt.esc(s.verdict.why)}">${s.verdict.label}</span></td>
        </tr>`;
      }).join("")}</tbody>`;
    $("setups").querySelectorAll("tbody tr").forEach((tr) =>
      tr.addEventListener("click", () => showTrades(shownSetup === tr.dataset.id ? null : tr.dataset.id)));

    // Method note
    const from = r.sample.from ? new Date(r.sample.from * 1000) : null;
    const to = r.sample.to ? new Date(r.sample.to * 1000) : null;
    const spread = isFinite(ctx.spreadPct) ? (ctx.spreadPct * 100).toFixed(3) + "%" : "unknown";
    $("method").innerHTML = `How this is measured: every past time a setup appeared ${from ? `between ${from.toLocaleDateString()} and ${to.toLocaleDateString()}` : ""},
      we "bought" at the next candle's open, set a stop ${RULES.stopAtr}× ATR below and a target ${RULES.targetAtr}× ATR above, and exited at whichever hit first
      (if both hit in one candle, we count the loss). Costs: ${(+feeInput.value).toFixed(2)}% fee + ${spread} spread (measured live) on both the buy and the sell.
      Long trades only (Binance.US spot can't short). Past results don't guarantee future results.`;

    if (shownSetup) showTrades(shownSetup, false);
  }

  function showTrades(id, fromUser = true) {
    if (fromUser && onShowTrades && id !== shownSetup) onShowTrades(!!id);
    shownSetup = id;
    $("setups").querySelectorAll("tbody tr").forEach((tr) => tr.classList.toggle("shown", tr.dataset.id === id));
    if (!id || !result) { chartSeries.setMarkers([]); return; }
    const s = result.setups.find((x) => x.id === id);
    const first = chartSeries.data()[0]?.time ?? 0;
    const markers = [];
    for (const t of s.trades) {
      if (t.entryTime < first) continue;
      const win = t.net > 0;
      markers.push({ time: t.entryTime, position: "belowBar", color: win ? "#22c55e" : "#f0506e", shape: "arrowUp", text: win ? "W" : "L" });
    }
    chartSeries.setMarkers(markers);
  }

  function clearPriceLines() {
    for (const l of priceLines) { try { chartSeries.removePriceLine(l); } catch {} }
    priceLines = [];
  }
  function clearChart() { clearPriceLines(); try { chartSeries.setMarkers([]); } catch {} }

  /* ----- Scan the whole watchlist on the current timeframe ----- */
  let scanning = false;
  async function scanWatchlist() {
    if (scanning || !ctx) return;
    scanning = true;
    const btn = $("scan-all");
    const syms = getWatchlist();
    const interval = ctx.interval;
    const rows = [];
    let done = 0;
    btn.disabled = true;
    const box = $("scan-results");
    const draw = () => {
      const order = { go: 0, caution: 1, no: 2, wait: 3 };
      rows.sort((a, b) => order[a.level] - order[b.level] || (b.ev ?? -9) - (a.ev ?? -9));
      box.innerHTML = `<div class="scan-title">Watchlist scan · ${interval} candles${done < syms.length ? ` · ${done}/${syms.length}…` : ""}</div>
        <div class="scan-grid">${rows.map((r) => `<button class="scan-row" data-sym="${r.sym}">
          <span class="scan-coin">${fmt.esc(r.base)}</span>
          <span class="pill v-pill-${r.level}">${r.label}</span>
          <span class="scan-detail muted">${r.detail}</span></button>`).join("")}</div>`;
      box.querySelectorAll(".scan-row").forEach((b) => b.addEventListener("click", () => onPickSymbol(b.dataset.sym)));
    };
    draw();
    const queue = [...syms];
    const worker = async () => {
      while (queue.length) {
        const sym = queue.shift();
        try {
          const [c, book] = await Promise.all([getKlineHistory(sym, interval, HISTORY), getBookTicker(sym).catch(() => ({ spreadPct: NaN }))]);
          const r = analyze(c, { costPerSide: costPerSide(book.spreadPct) });
          logFromAnalysis(sym, interval, c, r);
          const b = r.best;
          rows.push({
            sym, base: sym.replace(/(USDT|USDC|USD)$/, ""), level: r.overall.level, label: r.overall.label, ev: b?.stats.ev,
            detail: b ? `${fmt.esc(b.name)} · ${b.stats.n ? `${pctRound(b.stats.winRate)} of ${b.stats.n}` : "no history"} · avg ${fmt.pct(b.stats.ev * 100)}` : "no active setup",
          });
        } catch (e) {
          rows.push({ sym, base: sym, level: "wait", label: "ERROR", detail: "couldn't load data" });
        }
        done++;
        draw();
      }
    };
    await Promise.all([worker(), worker()]);
    btn.disabled = false;
    scanning = false;
  }

  return { analyzeSymbol, onCandle };
}

function pctRound(v) { return isFinite(v) ? Math.round(v * 100) + "%" : "—"; }
function humanMinutes(m) {
  if (!m) return "—";
  if (m < 60) return `~${Math.round(m)} min`;
  if (m < 1440) return `~${(m / 60).toFixed(m < 600 ? 1 : 0)} h`;
  return `~${(m / 1440).toFixed(1)} days`;
}
