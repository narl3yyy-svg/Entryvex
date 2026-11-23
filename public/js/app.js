import { getSymbols } from "./binance.js";
import { get24h, getKlines, createTickerFeed, createKlineFeed, isStock, stockInfo, registerStock, searchStocks, POPULAR } from "./market.js";
import { COINS, coinName, DEFAULT_WATCHLIST } from "./coins.js";
import * as fmt from "./format.js";
import { createScanner } from "./scanner.js";
import { initMoney } from "./money.js";
import { getProfile, plainEnglish, moodOf, moodHtml, getStockProfile } from "./research.js";
import { initAlerts, onTicker, openPriceAlert, pushAlert, getAlertPrefs } from "./alerts.js";
import { initPush, scheduleSync } from "./push.js";
import { ema, computeAll } from "./indicators.js";
import { scanPatterns, measurePattern } from "./patterns.js";
import { forecast, describeOdds, reliability } from "./forecast.js";
import { initJournal, onTicker as journalTicker, openTrades } from "./journal.js";
import { initSignals } from "./signals.js";
import { initAI, setAIContext } from "./ai.js";
import { renderDecision, refreshDecision } from "./decision.js";
import { initOpportunities, run as runOpportunities, setupMarkets, signalFor, verdictFor, isRunning as oppsRunning, lastChecked as oppsLastChecked, scanEvery, setScanEvery, SCAN_CHOICES } from "./opportunities.js";
import { initMovers, moversVisible } from "./movers.js";
import { renderLongTerm } from "./longterm.js";
import { initWorld, worldVisible } from "./world.js";
import { renderCalendar, loadCalendar } from "./calendar.js";
import { initBuyNow, updateBuyNow } from "./buynow.js";
import { onMoneyChange } from "./money.js";
import { onJournalChange } from "./journal.js";
import { recentMove } from "./move.js";
import { initPicks, picksVisible, rankFor, run as runPicks } from "./picks.js";
import { onFx, fxRate } from "./fx.js";
import { initBrowse } from "./browse.js";
import { initBot, botVisible, followBot, botViewCached } from "./bot.js";
import { initHoldings, holdingsVisible } from "./holdings.js";
import { initScorecard, scorecardVisible } from "./scorecard.js";
import { addPriceAlert } from "./alerts.js";
import { sizePosition } from "./sizing.js";
import { settings as moneySettings } from "./money.js";
import { addTrade } from "./journal.js";
import { renderEarnings } from "./earnings.js";
import { renderNewsAi } from "./newsai.js";

const $ = (id) => document.getElementById(id);
const QUOTES = ["USDT", "USD", "USDC"];

const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};

const state = {
  allSymbols: [],
  bySymbol: new Map(),
  watchlist: store.get("watchlist", DEFAULT_WATCHLIST),
  selected: store.get("selected", "BTCUSDT"),
  interval: store.get("interval", "15m"),
  view: store.get("view", null),          // "1y" | "5y" | "all" | null
  showPatterns: store.get("patterns", true),
  patternsNow: null,
  stats: new Map(),
  newsTab: store.get("newsTab", "report"),
  badges: {},
  showEma: store.get("ema", true),
  showForecast: store.get("forecast", true),
  forecast: null,
  analysis: null,
  status: { ticker: "connecting", kline: "connecting" },
};

let tickerStream = null;
let klineStream = null;
let chart, candles, volume, scanner, emaLines, fcLines = [];
const INTERVAL_SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
const FC_H = 20;

/* ---------- Forecast: measured price range for the next FC_H candles ---------- */
function updateForecast(ctx, result) {
  const f = forecast(ctx.candles, INTERVAL_SEC[ctx.interval] || 900, FC_H);
  state.forecast = f ? { ...f, interval: ctx.interval, symbol: ctx.symbol } : null;
  state.analysis = { result, interval: ctx.interval, symbol: ctx.symbol };
  drawForecast();
  renderForecastBox();
  pushAIContext();
  renderDecision(decisionCtx());
  updateBuyNow(decisionCtx());
  if (ltSymbol !== ctx.symbol) { ltSymbol = ctx.symbol; renderLongTerm({ ...decisionCtx(), onLoaded: () => updateBuyNow(decisionCtx()) }); renderEarnings(decisionCtx()); }
}
let ltSymbol = null;

/* "Entryvex says" panel */
function decisionCtx() {
  const sym = state.selected, info = state.bySymbol.get(sym) || {}, s = state.stats.get(sym);
  return {
    symbol: sym, base: info.base ?? sym, name: nameFor(sym), interval: state.interval,
    price: s?.last ?? lastCandle?.close, marketOpen: s?.marketOpen,
    analysis: state.analysis && state.analysis.symbol === sym && state.analysis.interval === state.interval ? state.analysis.result : null,
    forecast: state.forecast && state.forecast.symbol === sym ? state.forecast : null,
    patterns: state.patternsNow && state.patternsNow.symbol === sym ? state.patternsNow.list : [],
    rules: { stepSize: info.stepSize, minQty: info.minQty, tickSize: info.tickSize, minNotional: info.minNotional },
    currency: info.currency,
    move: currentMove(sym),
    patterns: state.patternsNow && state.patternsNow.symbol === sym ? state.patternsNow.list : [],
    intervalSec: IV_SEC[state.interval],
  };
}
const IV_SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
let moveCache = { key: "", t: 0, v: null };
/** Recent-move check for "Entryvex says" (recomputed at most every 5 s). */
function currentMove(sym) {
  const key = sym + ":" + state.interval;
  if (moveCache.key === key && Date.now() - moveCache.t < 5000) return moveCache.v;
  let v = null;
  try { if (candles && lastCandle) v = recentMove(candles.data(), 3, 20, state.stats.get(sym)?.last ?? lastCandle.close); } catch {}
  moveCache = { key, t: Date.now(), v };
  return v;
}
let decisionTimer = 0;
function tickDecision() {
  const now = Date.now();
  if (now - decisionTimer < 1500) return;
  decisionTimer = now;
  refreshDecision(decisionCtx());
  updateBuyNow(decisionCtx());
}
function drawForecast() {
  const f = state.forecast;
  const cap = $("fc-caption");
  if (!f || !state.showForecast || f.symbol !== state.selected) {
    fcLines.forEach((l) => l.setData([]));
    if (cap) cap.hidden = true;
    drawForecastZone();
    return;
  }
  const start = { time: f.t0, value: f.live };
  fcLines.forEach((line, k) => line.setData([start, ...f.bands.map((b) => ({ time: b.time, value: b.q[4 - k] }))]));
  if (cap) {
    const last = f.bands.at(-1);
    cap.hidden = false;
    cap.innerHTML = `<strong>Forecast, next ~${horizonText(f)}:</strong> the price ended inside the <span class="fc-zone-swatch"></span> shaded zone
      <strong>${Math.round(f.accuracy80 * 100)}%</strong> of the time in past tests. Most likely <strong>${fmt.price(last.q[2])}</strong>
      · <span class="${f.pUp >= 0.5 ? "up" : "down"}">${Math.round(f.pUp * 100)}% chance higher</span>
      ${(() => { const m = modelInfo(); return m ? `<br>Entryvex model: <strong>${Math.round(m.p * 100)}%</strong> chance of a profit after costs <span class="muted">(${m.skill === "good" ? "proven on unseen data" : m.skill === "some" ? "a little skill on unseen data" : "no proven skill on this market yet"})</span>` : ""; })()}`;
  }
  drawForecastZone();
}

/*
 * The forecast as a shaded zone instead of five dotted lines: the outer zone is where price ended up
 * 8 in 10 times (80% range), the darker core is the more likely half (50% range), and one solid
 * line is the most likely path. Drawn on a canvas over the chart, kept in step with zoom and scroll.
 */
let fcCanvas = null, fcRaf = 0, fcSig = "";
function drawForecastZone() {
  const box = $("chart");
  if (!fcCanvas) {
    fcCanvas = document.createElement("canvas");
    fcCanvas.className = "fc-zone";
    box.appendChild(fcCanvas);
  }
  const f = state.forecast;
  const on = f && state.showForecast && f.symbol === state.selected;
  const dpr = window.devicePixelRatio || 1;
  const W = box.clientWidth, H = box.clientHeight;
  const ts = chart.timeScale();
  const pts = on ? [{ time: f.t0, q: [f.live, f.live, f.live, f.live, f.live] }, ...f.bands] : [];
  const xy = pts.map((b) => ({ x: ts.timeToCoordinate(b.time), y: b.q.map((v) => candles.priceToCoordinate(v)) }))
    .filter((p) => p.x != null && p.y.every((v) => v != null));
  const sig = `${W}x${H}|${xy.map((p) => `${Math.round(p.x)},${Math.round(p.y[0])},${Math.round(p.y[4])}`).join(";")}`;
  if (sig === fcSig) return;
  fcSig = sig;
  if (fcCanvas.width !== W * dpr || fcCanvas.height !== H * dpr) { fcCanvas.width = W * dpr; fcCanvas.height = H * dpr; fcCanvas.style.width = W + "px"; fcCanvas.style.height = H + "px"; }
  const g = fcCanvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  if (xy.length < 2) return;
  const band = (lo, hi, color) => {
    g.beginPath();
    xy.forEach((p, i) => (i ? g.lineTo(p.x, p.y[hi]) : g.moveTo(p.x, p.y[hi])));
    for (let i = xy.length - 1; i >= 0; i--) g.lineTo(xy[i].x, xy[i].y[lo]);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  };
  band(0, 4, "rgba(122,162,255,0.10)");   // 80% zone
  band(1, 3, "rgba(122,162,255,0.16)");   // 50% core
}
/** Keep the zone glued to the chart while zooming, scrolling or resizing (cheap: skips when nothing moved). */
function forecastZoneLoop() {
  cancelAnimationFrame(fcRaf);
  const step = () => {
    if (document.visibilityState === "visible" && state.showForecast) drawForecastZone();
    fcRaf = requestAnimationFrame(step);
  };
  fcRaf = requestAnimationFrame(step);
}
function horizonText(f) {
  const mins = (f.H * f.intervalSec) / 60;
  return mins < 60 ? `${Math.round(mins)} minutes` : mins < 1440 ? `${+(mins / 60).toFixed(1)} hours` : `${+(mins / 1440).toFixed(1)} days`;
}
function renderForecastBox() {
  const f = state.forecast, box = $("forecast-box");
  $("forecast-toggle").classList.toggle("on", state.showForecast);
  if (!f || f.symbol !== state.selected) { box.innerHTML = ""; return; }
  const rel = reliability(f.accuracy80);
  const base = currentBase();
  const chg = (v) => `${v >= f.live ? "+" : ""}${(((v - f.live) / f.live) * 100).toFixed(1)}%`;
  box.innerHTML = `
    <div class="fc-main">
      <div class="fc-title">Forecast · next ${f.H} candles (~${horizonText(f)})</div>
      <div class="fc-range"><span class="muted">8 in 10 times between</span>
        <strong class="mono down">${fmt.price(f.range80[0])}</strong><span class="muted small">(${chg(f.range80[0])})</span>
        <span class="muted">and</span>
        <strong class="mono up">${fmt.price(f.range80[1])}</strong><span class="muted small">(${chg(f.range80[1])})</span>
        <span class="muted">· middle ${fmt.price(f.mid)}</span></div>
    </div>
    <div class="fc-facts">
      <div title="How often price really finished inside the 80% range, tested on recent data the forecast wasn't built from"><span>Forecast accuracy</span>
        <strong class="fc-${rel.level}">${Math.round(f.accuracy80 * 100)}% inside range</strong><small class="muted">${rel.label} · ${f.tested.toLocaleString()} tests</small></div>
      <div><span>Chance ${fmt.esc(base)} is higher in ~${horizonText(f)}</span>
        <strong class="mono">${Math.round(f.pUp * 100)}%</strong><small class="muted">${describeOdds(f.pUp)}</small></div>
      <div title="Only counting past moments when the trend looked like it does now"><span>When the trend looked like now</span>
        <strong class="mono">${isFinite(f.pUpTrend) ? Math.round(f.pUpTrend * 100) + "% higher" : "—"}</strong><small class="muted">price ${f.trendLabel.split(" (")[0]} · ${f.nTrend.toLocaleString()} cases</small></div>
      ${modelTile()}
    </div>`;
}

/** The Entryvex model's call for now, with how good it proved to be on history it never saw. */
function modelInfo() {
  const a = state.analysis;
  if (!a || a.symbol !== state.selected || a.interval !== state.interval) return null;
  const m = a.result?.model, s = a.result?.setups?.find((x) => x.id === "model");
  if (!m || m.pNow == null) return null;
  const skill = !isFinite(m.test.auc) ? "untested" : m.test.auc >= 0.58 ? "good" : m.test.auc >= 0.54 ? "some" : "none";
  return { p: m.pNow, auc: m.test.auc, skill, verdict: s?.verdict, stats: s?.stats, H: m.H, top: m.weights.slice(0, 3).map((w) => w.name) };
}
function modelTile() {
  const m = modelInfo();
  if (!m) return "";
  const label = { good: "proven skill on unseen data", some: "a little skill on unseen data", none: "no better than chance here yet", untested: "not tested yet" }[m.skill];
  return `<div title="Learns from this market's own chart (trend, momentum, RSI, volume, breakouts, candle patterns, market type) and is tested on recent history it never saw. Leans most on: ${fmt.esc(m.top.join(", "))}.">
    <span>Entryvex model: chance of a profit after costs in ~${m.H} candles</span>
    <strong class="mono ${m.skill === "none" ? "" : m.p >= 0.55 ? "up" : m.p <= 0.45 ? "down" : ""}">${Math.round(m.p * 100)}%</strong>
    <small class="muted">${label} (score ${isFinite(m.auc) ? m.auc.toFixed(2) : "—"}, 0.50 = guessing)${m.verdict?.level === "edge" || m.verdict?.level === "weak" ? ` · its buy calls made ${(m.stats.ev * 100).toFixed(2)}%/trade on unseen data` : ""}</small></div>`;
}
function toggleForecast() {
  state.showForecast = !state.showForecast;
  store.set("forecast", state.showForecast);
  drawForecast(); renderForecastBox();
}

function pushAIContext() {
  const sym = state.selected, info = state.bySymbol.get(sym), s = state.stats.get(sym);
  setAIContext({
    symbol: sym, base: info?.base, quote: info?.quote, name: nameFor(sym), interval: state.interval,
    isStock: isStock(sym), marketOpen: s?.marketOpen,
    price: s?.last ?? lastCandle?.close, change24h: s?.changePct, high24h: s?.high, low24h: s?.low, volume24h: s?.quoteVolume,
    forecast: state.forecast && state.forecast.symbol === sym ? state.forecast : null,
    patterns: state.patternsNow && state.patternsNow.symbol === sym ? state.patternsNow.list : [],
    analysis: state.analysis && state.analysis.symbol === sym ? state.analysis : null,
  });
}
let emaState = null; // { closes: [], times: [], v: {20: [], 50: []} }

/* EMA 20/50 overlay: full calculation on load, then incremental updates per tick. */
function setEmaData(data) {
  const closes = data.map((c) => c.close);
  emaState = { closes, times: data.map((c) => c.time), v: { 20: ema(closes, 20), 50: ema(closes, 50) } };
  for (const p of [20, 50]) {
    emaLines[p].setData(emaState.v[p].map((v, i) => ({ time: emaState.times[i], value: v })).filter((x) => isFinite(x.value)));
  }
  applyEmaVisibility();
}
function updateEma(c) {
  if (!emaState) return;
  const { closes, times, v } = emaState;
  const n = times.length;
  if (n && times[n - 1] === c.time) closes[n - 1] = c.close;
  else if (!n || c.time > times[n - 1]) { closes.push(c.close); times.push(c.time); v[20].push(NaN); v[50].push(NaN); }
  else return;
  const i = closes.length - 1;
  for (const p of [20, 50]) {
    const prev = v[p][i - 1];
    if (!isFinite(prev)) continue;
    const k = 2 / (p + 1);
    v[p][i] = c.close * k + prev * (1 - k);
    emaLines[p].update({ time: c.time, value: v[p][i] });
  }
}
function applyEmaVisibility() {
  for (const p of [20, 50]) emaLines[p].applyOptions({ visible: state.showEma });
  $("ema-toggle").classList.toggle("on", state.showEma);
}
let lastCandle = null;
let klineLoadToken = 0;

/* ---------- Status + clock ---------- */
function setStatus(which, s) {
  state.status[which] = s;
  const vals = Object.values(state.status);
  const overall = vals.every((v) => v === "live") ? "live" : vals.includes("down") ? "down" : "connecting";
  const el = $("status");
  el.dataset.state = overall;
  el.querySelector("span").textContent =
    overall === "live" ? "Live" : overall === "down" ? "Reconnecting…" : "Connecting…";
}
function tickClock() {
  const d = new Date();
  $("clock").textContent = d.toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit", second: "2-digit" }) + " local";
}

/* ---------- Watchlist ---------- */
/* Watchlist sorting. "mine" = your own order (drag to rearrange); the others only change how it's shown. */
const SORTS = new Set(["mine", "price-desc", "price-asc", "chg-desc", "chg-asc", "signal"]);
let wlSort = SORTS.has(store.get("wlSort", "mine")) ? store.get("wlSort", "mine") : "mine";
/** Price in US dollars (so yen, euro or pence prices sort in the right place). */
function usdPrice(sym) {
  const p = state.stats.get(sym)?.last;
  if (!(p > 0)) return null;
  if (!isStock(sym)) return p;
  const cur = stockInfo(sym).currency || "USD";
  const r = cur === "USD" ? 1 : fxRate(cur);
  return r ? p / r : p;
}
const SIGNAL_RANK = { buy: 0, watch: 1, wait: 2, unknown: 3, checking: 4 };
function displayOrder() {
  if (wlSort === "mine") return state.watchlist.slice();
  const list = state.watchlist.slice();
  const pos = new Map(list.map((s, i) => [s, i]));
  const num = (v, missingLast) => (v == null || !isFinite(v) ? missingLast : v);
  const key = {
    "price-desc": (s) => -num(usdPrice(s), -Infinity),
    "price-asc": (s) => num(usdPrice(s), Infinity),
    "chg-desc": (s) => -num(state.stats.get(s)?.changePct, -Infinity),
    "chg-asc": (s) => num(state.stats.get(s)?.changePct, Infinity),
    signal: (s) => SIGNAL_RANK[rowVerdict(s)?.level] ?? 5,
  }[wlSort];
  return list.sort((a, b) => (key(a) - key(b)) || (pos.get(a) - pos.get(b)));
}
/** Re-order the existing rows without rebuilding them (cheap; used as prices move). */
function resortWatchlist() {
  if (wlSort === "mine") return;
  const ul = $("watchlist");
  if (wlDrag.li) return;
  const order = displayOrder();
  const now = [...ul.children].map((li) => li.dataset.sym);
  if (order.join() === now.join()) return;
  for (const sym of order) { const li = ul.querySelector(`li[data-sym="${CSS.escape(sym)}"]`); if (li) ul.appendChild(li); }
}

function renderWatchlist() {
  const ul = $("watchlist");
  ul.innerHTML = "";
  ul.classList.toggle("sorted", wlSort !== "mine");
  for (const sym of displayOrder()) {
    const info = state.bySymbol.get(sym);
    const base = info?.base ?? sym;
    const li = document.createElement("li");
    li.dataset.sym = sym;
    if (sym === state.selected) li.classList.add("active");
    li.innerHTML = `
      <span class="wl-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
      <span class="wl-base">${fmt.esc(base)}${isStock(sym) ? `<span class="kind-tag">${fmt.esc(info?.kind || "Stock")}</span>` : `<span class="muted small"> / ${fmt.esc(info?.quote ?? "")}</span>`}<span data-f="sig"></span></span>
      <span class="wl-price" data-f="price">—</span>
      <span class="wl-name">${fmt.esc(nameFor(sym))}</span>
      <span class="wl-chg" data-f="chg">—</span>
      <button class="wl-remove" title="Remove from watchlist" aria-label="Remove ${fmt.esc(base)}">×</button>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".wl-grip") || wlDrag.justDropped) return;
      if (e.target.closest(".wl-remove")) { removeFromWatchlist(sym); e.stopPropagation(); return; }
      // A BUY row opens on the candle size the buy signal is on, so the chart and "Entryvex says" match the pill.
      const v = rowVerdict(sym);
      if (v?.level === "buy" && v.iv && v.iv !== state.interval) {
        state.selected = sym;   // set first so the interval change loads this market
        document.querySelector(`#intervals button[data-i="${v.iv}"]`)?.click();
      }
      selectSymbol(sym);
    });
    ul.appendChild(li);
    paintSignal(li, sym);
    paintRow(sym);
  }
}

/* Drag to reorder (mouse and touch): grab the ⋮⋮ grip and move the row. */
const wlDrag = { li: null, pointerId: null, justDropped: false };
function initWatchlistDrag() {
  const ul = $("watchlist");
  ul.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest(".wl-grip");
    if (!grip || wlSort !== "mine") return;   // dragging only rearranges "My order"
    e.preventDefault();
    wlDrag.li = grip.closest("li");
    wlDrag.pointerId = e.pointerId;
    wlDrag.li.classList.add("dragging");
    ul.classList.add("is-dragging");
    try { grip.setPointerCapture(e.pointerId); } catch {}
  });
  ul.addEventListener("pointermove", (e) => {
    if (!wlDrag.li || e.pointerId !== wlDrag.pointerId) return;
    // Auto-scroll near the top/bottom edge of the list.
    const box = ul.getBoundingClientRect();
    if (e.clientY < box.top + 30) ul.scrollTop -= 8;
    else if (e.clientY > box.bottom - 30) ul.scrollTop += 8;
    const rows = [...ul.querySelectorAll("li:not(.dragging)")];
    const target = rows.find((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    if (target) ul.insertBefore(wlDrag.li, target); else ul.appendChild(wlDrag.li);
  });
  const end = (e) => {
    if (!wlDrag.li || e.pointerId !== wlDrag.pointerId) return;
    wlDrag.li.classList.remove("dragging");
    ul.classList.remove("is-dragging");
    const order = [...ul.querySelectorAll("li")].map((li) => li.dataset.sym);
    wlDrag.li = null;
    if (order.join() !== state.watchlist.join()) {
      state.watchlist = order;
      store.set("watchlist", state.watchlist);
    }
    wlDrag.justDropped = true;
    setTimeout(() => (wlDrag.justDropped = false), 50);
  };
  ul.addEventListener("pointerup", end);
  ul.addEventListener("pointercancel", end);
}

/** Watchlist verdict: Entryvex's latest check, or the setup-alert scan as a fallback. */
function rowVerdict(sym) {
  const v = verdictFor(sym);
  if (v) return v;
  const b = state.badges[sym];
  if (b && b.level === "go") return { level: "buy", label: b.label, why: `Setup alert on ${b.interval} candles: ${b.label}` };
  return null;
}
function paintSignal(li, sym) {
  const v = rowVerdict(sym);
  li.classList.toggle("sig-buy", v?.level === "buy");
  li.classList.toggle("sig-watch", v?.level === "watch");
  li.classList.toggle("sig-wait", v?.level === "wait");
  li.classList.toggle("sig-unknown", v?.level === "unknown");
  const el = li.querySelector('[data-f="sig"]');
  if (!el) return;
  const cls = v ? { buy: "buy", watch: "sig-watching", wait: "wait", unknown: "unknown", checking: "checking" }[v.level] : "";
  const bot = botViewCached(sym)?.holding;
  el.innerHTML = (v ? `<span class="wl-sig ${cls}">${fmt.esc(v.level === "unknown" ? "NO DATA" : v.label)}</span>` : "")
    + (bot ? `<span class="wl-sig wl-bot" title="The Entryvex paper-trading bot owns this (bought at ${fmt.esc(fmt.price(bot.entry))})">🤖</span>` : "");
  li.title = v ? v.why : "Not checked yet. Press Scan watchlist.";
}
/** "Auto-check every …" selector (re-checks the whole watchlist on its own). */
function autoSelect() {
  const v = scanEvery();
  return `<label class="wl-auto" title="How often Entryvex re-checks every market in your watchlist on its own. Markets with no new candle are reused, so frequent checks are light.">⟳
    <select id="wl-auto">${SCAN_CHOICES.map((m) => `<option value="${m}" ${m === v ? "selected" : ""}>${m ? `every ${m} min` : "off"}</option>`).join("")}</select></label>`;
}
function paintSignals() {
  document.querySelectorAll("#watchlist li[data-sym]").forEach((li) => paintSignal(li, li.dataset.sym));
  const n = { buy: 0, watch: 0, wait: 0, unknown: 0 };
  for (const sym of state.watchlist) { const v = rowVerdict(sym); if (v && n[v.level] != null) n[v.level]++; }
  const at = oppsLastChecked();
  // One line that is also the color key: green = buy now, red = don't buy yet, yellow = not enough data.
  const el = $("wl-summary");
  el.title = "Row colors: green = buy signal now · blue = watch: a setup with a winning record exists here, waiting for it to appear · red = don't buy: nothing has a winning record here lately · yellow = not enough data to judge. Checked on the candle size shown on the chart. No buy signals is normal: most of the time, waiting is the right call.";
  el.innerHTML = oppsRunning() ? `<span>Checking every market…</span><span class="when"></span>${autoSelect()}`
    : at ? `<span><i class="dot" style="background:var(--up)"></i><strong class="b">${n.buy}</strong> buy</span>
        <span><i class="dot" style="background:#4c9aff"></i><strong class="wt">${n.watch}</strong> watch</span>
        <span><i class="dot" style="background:var(--down)"></i><strong class="w">${n.wait}</strong> wait</span>
        <span><i class="dot" style="background:#e8b931"></i><strong class="u">${n.unknown}</strong> no data</span>
        <span class="when">${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</span>${autoSelect()}`
    : `<span><i class="dot" style="background:var(--up)"></i>buy</span><span><i class="dot" style="background:var(--down)"></i>wait</span><span><i class="dot" style="background:#e8b931"></i>no data</span>`;
}

function paintRow(sym, prevLast) {
  const li = $("watchlist").querySelector(`li[data-sym="${sym}"]`);
  const s = state.stats.get(sym);
  if (!li || !s) return;
  const p = li.querySelector('[data-f="price"]');
  const c = li.querySelector('[data-f="chg"]');
  p.textContent = fmt.price(s.last);
  c.textContent = fmt.pct(s.changePct);
  c.className = "wl-chg " + (s.changePct >= 0 ? "up" : "down");
  // The row color is Entryvex's verdict; a price tick only blinks the price briefly.
  if (prevLast != null && prevLast !== s.last) {
    p.classList.remove("blip-up", "blip-down");
    p.classList.add(s.last > prevLast ? "blip-up" : "blip-down");
    clearTimeout(blipTimers.get(sym));
    blipTimers.set(sym, setTimeout(() => p.classList.remove("blip-up", "blip-down"), 900));
  }
  paintSignal(li, sym);
}
const blipTimers = new Map();

function addToWatchlist(sym) {
  if (!state.watchlist.includes(sym)) {
    state.watchlist.push(sym);
    store.set("watchlist", state.watchlist);
    scheduleSync();
    refreshTickers();
    setTimeout(() => runOpportunities([sym]), 1500);   // color the new row as soon as it's checked
  }
  selectSymbol(sym);
}

function removeFromWatchlist(sym) {
  state.watchlist = state.watchlist.filter((s) => s !== sym);
  store.set("watchlist", state.watchlist);
  if (state.selected === sym && state.watchlist.length) selectSymbol(state.watchlist[0]);
  refreshTickers();
}

async function refreshTickers() {
  renderWatchlist();
  try {
    const rows = await get24h(state.watchlist);
    for (const r of rows) state.stats.set(r.symbol, r);
    state.watchlist.forEach((s) => paintRow(s));
    resortWatchlist();   // prices just arrived: put rows in the chosen sort order
    paintHeader();
  } catch (e) { console.warn(e); }

  if (tickerStream) tickerStream.close();
  tickerStream = createTickerFeed(state.watchlist.slice(), {
    onStatus: (s) => setStatus("ticker", s),
    onTick: (t) => {
      const prev = state.stats.get(t.symbol);
      state.stats.set(t.symbol, { ...prev, ...t });
      if (isStock(t.symbol)) state.bySymbol.set(t.symbol, stockInfo(t.symbol));
      paintRow(t.symbol, prev?.last);
      if (t.symbol === state.selected) paintHeader();
      onTicker(t.symbol, t.last);
      journalTicker(t.symbol, t.last);
    },
  });
}

/** "$" for US dollars, otherwise the currency code (e.g. "JPY 3,450"). */
function curPrefix(cur) { return !cur || cur === "USD" ? "$" : `${cur} `; }

/** Display name for any symbol: coin name for crypto, company name for stocks. */
function nameFor(sym) {
  if (isStock(sym)) return stockInfo(sym).name;
  return coinName(state.bySymbol.get(sym)?.base ?? sym);
}

/* ---------- Search ---------- */
let searchHits = [];
let searchIdx = 0;
function cryptoPair(base) {
  for (const q of QUOTES) { const s = state.allSymbols.find((x) => x.base === base && x.quote === q); if (s) return s; }
  return null;
}
/** Empty search box: popular markets to add with one tap. */
function popularHits() {
  const hits = [];
  for (const b of POPULAR.crypto) { const s = cryptoPair(b); if (s) hits.push({ ...s, kind: "crypto", group: "Popular crypto · Binance.US" }); }
  const stock = (ticker, name, kind, group, exchange = "") => hits.push({ symbol: "S:" + ticker, ticker, name, exchange, assetKind: kind, kind: "stock", group });
  for (const t of POPULAR.indices) stock(t, POPULAR.indexNames[t], "Index", "Indices");
  for (const [t, n] of POPULAR.etfs) stock(t, n, "ETF", "Popular ETFs");
  for (const [t, n] of POPULAR.us) stock(t, n, "Stock", "Popular US stocks");
  for (const [t, n, ex] of POPULAR.intl) stock(t, n, "Stock", "Popular international stocks", ex);
  return hits;
}
function runSearch(q) {
  const box = $("search-results");
  q = q.trim().toLowerCase();
  clearTimeout(stockSearchTimer);
  if (!q) {
    ++stockSearchToken;
    searchHits = popularHits(); searchIdx = 0;
    drawSearch("", false); box.hidden = false; return;
  }
  searchHits = state.allSymbols
    .filter((s) => QUOTES.includes(s.quote))
    .map((s) => {
      const name = coinName(s.base).toLowerCase();
      const b = s.base.toLowerCase();
      let score = b === q ? 0 : b.startsWith(q) ? 1 : name.startsWith(q) ? 2 : b.includes(q) || name.includes(q) ? 3 : 9;
      score += QUOTES.indexOf(s.quote) * 0.1;
      return { s, score };
    })
    .filter((x) => x.score < 9)
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((x) => ({ ...x.s, kind: "crypto", group: "Crypto · Binance.US" }));
  searchIdx = 0;
  drawSearch(q, true);
  box.hidden = false;
  // Stocks, ETFs and indices come from a server search (debounced).
  const token = ++stockSearchToken;
  stockSearchTimer = setTimeout(async () => {
    let stocks = [];
    try { stocks = await searchStocks(q); } catch {}
    if (token !== stockSearchToken) return;
    const crypto = searchHits.filter((h) => h.kind === "crypto");
    const st = stocks.map((s) => ({ ...s, assetKind: s.kind, kind: "stock", group: "Stocks, ETFs & indices · worldwide" }));
    // An exact stock/index match ("dji", "spy") goes above weak crypto matches.
    const strong = st.length && (st[0].assetKind === "Index" || st[0].ticker.replace(/^\^/, "").toLowerCase() === q) && !crypto.some((c) => c.base.toLowerCase() === q);
    searchHits = strong ? st.concat(crypto) : crypto.concat(st);
    searchIdx = 0;
    drawSearch(q, false);
  }, 250);
}
let stockSearchTimer = null, stockSearchToken = 0;
function drawSearch(q, loadingStocks) {
  const box = $("search-results");
  const row = (s, i) => {
    const added = state.watchlist.includes(s.symbol) ? " · added" : "";
    return s.kind === "crypto"
      ? `<button data-i="${i}" class="${i === searchIdx ? "active" : ""}"><span><strong>${fmt.esc(s.base)}</strong> <span class="muted">/ ${fmt.esc(s.quote)}</span></span>
          <span class="muted small">${fmt.esc(coinName(s.base))}${added}</span></button>`
      : `<button data-i="${i}" class="${i === searchIdx ? "active" : ""}"><span><strong>${fmt.esc(s.ticker)}</strong> <span class="kind-tag">${fmt.esc(s.assetKind || "Stock")}</span></span>
          <span class="muted small">${fmt.esc(s.name)}${s.exchange ? " · " + fmt.esc(s.exchange) : ""}${added}</span></button>`;
  };
  let html = "", group = null;
  searchHits.forEach((h, i) => {
    if (h.group !== group) { group = h.group; html += `<div class="sr-head">${fmt.esc(group)}</div>`; }
    html += row(h, i);
  });
  if (q) {
    if (!searchHits.some((h) => h.kind === "crypto")) html += `<div class="sr-head">Crypto · Binance.US</div><div class="empty">No crypto pair on Binance.US matches “${fmt.esc(q)}”.</div>`;
    if (!searchHits.some((h) => h.kind === "stock")) html += `<div class="sr-head">Stocks, ETFs &amp; indices</div><div class="empty">${loadingStocks ? "Searching…" : `Nothing matches “${fmt.esc(q)}”. Try the ticker or company name.`}</div>`;
  } else html = `<div class="sr-tip muted small">Type any ticker or name: every US stock and ETF, major world indices, and stocks from 30+ exchanges.</div>` + html;
  box.innerHTML = html;
}
function pickSearch(i) {
  const s = searchHits[i];
  if (!s) return;
  $("search").value = "";
  $("search-results").hidden = true;
  if (s.kind === "stock") {
    registerStock(s.symbol, { name: s.name, exchange: s.exchange, kind: s.assetKind || "Stock" });
    state.bySymbol.set(s.symbol, stockInfo(s.symbol));
  }
  addToWatchlist(s.symbol);
}

/* ---------- Header ---------- */
/** "⭐ Stock Rank #3 of 101" next to a stock's name (opens the Stock picks tab). */
function rankPill(sym) {
  const r = rankFor(sym);
  if (!r) return "";
  return ` <button class="rank-pill ${r.top ? "top" : ""}" data-open-picks title="Entryvex Stock Rank: monthly momentum, trend and steadiness ranking of ${r.of} large US stocks. ${r.top ? "In this month's top 10." : ""}">⭐ Rank ${r.rank} of ${r.of}</button>`;
}
function paintHeader() {
  const sym = state.selected;
  const info = state.bySymbol.get(sym);
  const s = state.stats.get(sym);
  const base = info?.base ?? sym;
  const stock = isStock(sym);
  $("sym-name").textContent = nameFor(sym);
  $("sym-pair").innerHTML = stock
    ? `${fmt.esc(base)} · ${fmt.esc(info?.exchange || "US market")}${s && s.marketOpen != null ? ` <span class="mkt ${s.marketOpen ? "open" : "closed"}">${s.marketOpen ? "Market open" : "Market closed"}</span>` : ""}${rankPill(sym)}`
    : fmt.esc(info ? `${info.base}/${info.quote}` : sym);
  const last = s?.last ?? lastCandle?.close;
  $("sym-price").textContent = (stock ? curPrefix(info?.currency) : "") + fmt.price(last);
  const chg = $("sym-change");
  chg.textContent = s ? fmt.pct(s.changePct) + (stock ? " today" : " 24h") : "—";
  chg.className = "chip mono " + (s ? (s.changePct >= 0 ? "up" : "down") : "");
  document.querySelectorAll(".stats dt")[0].textContent = stock ? "Day high" : "24h high";
  document.querySelectorAll(".stats dt")[1].textContent = stock ? "Day low" : "24h low";
  document.querySelectorAll(".stats dt")[2].textContent = stock ? "Day volume" : "24h volume";
  $("sym-high").textContent = fmt.price(s?.high);
  $("sym-low").textContent = fmt.price(s?.low);
  $("sym-vol").textContent = s ? (stock ? curPrefix(info?.currency) : "$") + fmt.compact(s.quoteVolume) : "—";
  if (last) document.title = `${fmt.price(last)} ${base} · Entryvex`;
  pushAIContext();
  tickDecision();
}

/* ---------- Chart ---------- */
// The chart library works in UTC; show every time in the device's own time zone instead.
const toDate = (t) => new Date((typeof t === "number" ? t : Date.UTC(t.year, t.month - 1, t.day) / 1000) * 1000);
function localTick(time, type) {
  const d = toDate(time);
  switch (type) {
    case 0: return String(d.getFullYear());                                        // year
    case 1: return d.toLocaleDateString([], { month: "short" });                  // month
    case 2: return d.toLocaleDateString([], { month: "short", day: "numeric" });  // day
    case 4: return d.toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit", second: "2-digit" });
    default: return d.toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit" });
  }
}
function localCrosshairTime(time) {
  const d = toDate(time);
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", hourCycle: "h23", minute: "2-digit" });
}
function initChart() {
  const el = $("chart");
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: "#8a94a6", fontFamily: "Inter, system-ui, sans-serif" },
    grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
    rightPriceScale: { borderColor: "#232a35" },
    timeScale: { borderColor: "#232a35", timeVisible: true, secondsVisible: false, shiftVisibleRangeOnNewBar: true, tickMarkFormatter: localTick },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { priceFormatter: (p) => fmt.price(p), timeFormatter: localCrosshairTime },
    // The mouse wheel scrolls the page; hold Ctrl and use the wheel to zoom. Click and drag still pans.
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
  });
  el.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;              // plain wheel: let the page scroll
    e.preventDefault();                  // Ctrl+wheel: zoom the chart (not the browser page)
    const ts = chart.timeScale(), r = ts.getVisibleLogicalRange();
    if (!r) return;
    const box = el.getBoundingClientRect();
    const at = ts.coordinateToLogical(e.clientX - box.left) ?? (r.from + r.to) / 2;
    const k = Math.exp(Math.max(-1, Math.min(1, e.deltaY / 300)));   // >1 zooms out, <1 zooms in
    const from = at - (at - r.from) * k, to = at + (r.to - at) * k;
    if (to - from < 10 || to - from > 5000) return;
    ts.setVisibleLogicalRange({ from, to });
  }, { passive: false });
  candles = chart.addCandlestickSeries({
    upColor: "#22c55e", downColor: "#f0506e", borderVisible: false,
    wickUpColor: "#22c55e", wickDownColor: "#f0506e",
  });
  volume = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  const lineOpts = { lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  emaLines = {
    20: chart.addLineSeries({ ...lineOpts, color: "rgba(224,179,65,0.85)", title: "" }),
    50: chart.addLineSeries({ ...lineOpts, color: "rgba(122,162,255,0.85)", title: "" }),
  };
  // Forecast: the shaded zone is drawn by drawForecastZone(); these series give it its edges,
  // the solid "most likely" line and the plain-English labels on the price axis.
  const fc = { lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false };
  fcLines = [
    chart.addLineSeries({ ...fc, color: "rgba(46,229,157,0.55)", lineStyle: 0, title: "Likely high" }),
    chart.addLineSeries({ ...fc, color: "rgba(0,0,0,0)", lineVisible: false, title: "", lastValueVisible: false }),
    chart.addLineSeries({ ...fc, color: "rgba(230,234,240,0.9)", lineWidth: 2, lineStyle: 0, title: "Most likely" }),
    chart.addLineSeries({ ...fc, color: "rgba(0,0,0,0)", lineVisible: false, title: "", lastValueVisible: false }),
    chart.addLineSeries({ ...fc, color: "rgba(240,80,110,0.55)", lineStyle: 0, title: "Likely low" }),
  ];
  // Caption above the chart explaining the forecast in one line.
  const cap = document.createElement("div");
  cap.id = "fc-caption"; cap.className = "fc-caption"; cap.hidden = true;
  el.appendChild(cap);
  forecastZoneLoop();
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  chart.subscribeCrosshairMove((p) => {
    // Hovered candle (and how much was traded in it) goes into the tooltip next to the cursor.
    const d = p?.seriesData?.get(candles);
    const v = p?.seriesData?.get(volume)?.value;
    candleTip(p, d, v);
  });
}

/* Tooltip next to the cursor: the hovered candle's time, prices, change and how much was traded. */
function candleTip(p, c, v) {
  const box = $("chart");
  let tip = box.querySelector(".chart-tip");
  if (!p?.point || !c || p.point.x < 0 || p.point.y < 0) { if (tip) tip.hidden = true; return; }
  if (!tip) { tip = document.createElement("div"); tip.className = "chart-tip"; box.appendChild(tip); }
  const sym = state.selected, info = state.bySymbol.get(sym), stock = isStock(sym);
  const cur = stock ? stockInfo(sym).currency : null;
  const pre = stock ? curPrefix(cur) : (/^(USD|USDT|USDC)$/.test(info?.quote ?? "") ? "$" : "");
  const chg = c.open ? (c.close / c.open - 1) * 100 : 0;
  const isIndex = stock && info?.kind === "Index";
  let volRow = "";
  if (!isIndex && isFinite(v)) {
    const unit = stock ? (v === 1 ? "share" : "shares") : (info?.base ?? "");
    const amt = v >= 1e6 ? fmt.compact(v) : v >= 1000 ? Math.round(v).toLocaleString("en-US") : (+v.toPrecision(4)).toLocaleString("en-US", { maximumFractionDigits: 8 });
    const value = v * ((c.high + c.low + c.close) / 3);
    volRow = `<div class="ct-vol"><span>Traded</span><strong>${fmt.esc(amt)} ${fmt.esc(unit)}</strong></div>
      <div class="ct-vol"><span>Worth about</span><strong>${fmt.esc(pre || "")}${fmt.compact(value)}${pre ? "" : " " + fmt.esc(info?.quote ?? "")}</strong></div>`;
  }
  tip.innerHTML = `<div class="ct-time">${fmt.esc(localCrosshairTime(c.time))}</div>
    <div class="ct-grid"><span>Open</span><b>${fmt.price(c.open)}</b><span>High</span><b>${fmt.price(c.high)}</b>
      <span>Low</span><b>${fmt.price(c.low)}</b><span>Close</span><b class="${chg >= 0 ? "up" : "down"}">${fmt.price(c.close)} <small>${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%</small></b></div>
    ${volRow}
    ${(() => { const ps = state.showPatterns && patternHits?.sym === sym ? patternHits.byTime.get(c.time) : null;
      return ps?.length ? `<div class="ct-pat">${ps.map((p) => `<div class="${p.dir > 0 ? "up" : "down"}">${p.dir > 0 ? "▲" : "▼"} ${fmt.esc(p.name)}</div>`).join("")}</div>` : ""; })()}`;
  tip.hidden = false;
  // Sit beside the cursor, flipping to the other side near the right/bottom edges.
  const w = tip.offsetWidth, h = tip.offsetHeight, W = box.clientWidth, Hh = box.clientHeight;
  let x = p.point.x + 16, y = p.point.y + 16;
  if (x + w > W - 70) x = p.point.x - w - 16;
  if (y + h > Hh - 30) y = p.point.y - h - 16;
  tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
}

// Keep the live candle in the middle of the chart, with empty space to its right.
// New candles shift the view along, so it stays centered as time passes.
const CENTER_BARS = 70; // candles visible on each side of the live one
function centerLive(count) {
  const last = (count ?? candles.data().length) - 1;
  if (last < 0) return;
  chart.timeScale().setVisibleLogicalRange({ from: last - CENTER_BARS, to: last + CENTER_BARS });
}

/* Candlestick patterns: markers on the chart, and the ones that just formed (for "Entryvex says"). */
function refreshPatterns(sym) {
  const data = candles.data();
  if (data.length < 60) { candles.setMarkers([]); state.patternsNow = null; return; }
  const x = computeAll(data);
  const last = data.length - 2;   // the newest candle is still forming
  const hits = scanPatterns(data, x, Math.max(15, data.length - 400), last);
  patternHits = { sym, hits, byTime: new Map() };
  for (const h of hits) { const a = patternHits.byTime.get(h.time) || []; a.push(h.p); patternHits.byTime.set(h.time, a); }
  drawPatternMarkers();
  // Patterns completed on one of the last 3 closed candles, each with what price did after it here.
  const list = hits.filter((h) => h.i >= last - 2).map((h) => {
    const m = measurePattern(data, x, h.p.id, 10, last);
    return { id: h.p.id, name: h.p.name, dir: h.p.dir, plain: h.p.plain, candlesAgo: last - h.i, measured: m };
  });
  state.patternsNow = { symbol: sym, list };
  refreshDecision(decisionCtx());
}
let patternHits = null;
/** Small arrows only (names would overlap); hover a candle to see which pattern it is. */
function drawPatternMarkers() {
  const ok = state.showPatterns && patternHits && patternHits.sym === state.selected;
  candles.setMarkers(ok ? patternHits.hits.map((h) => ({
    time: h.time, position: h.p.dir > 0 ? "belowBar" : "aboveBar", shape: h.p.dir > 0 ? "arrowUp" : "arrowDown",
    color: h.p.dir > 0 ? "rgba(34,197,94,0.9)" : "rgba(240,80,110,0.9)", size: 1,
  })) : []);
}
function togglePatterns() {
  state.showPatterns = !state.showPatterns;
  store.set("patterns", state.showPatterns);
  $("patterns-toggle").classList.toggle("on", state.showPatterns);
  refreshPatterns(state.selected);
}

/* 1Y / 5Y / ALL: a candle size plus how much history to show. */
const VIEWS = { "1y": { interval: "1d", days: 365 }, "5y": { interval: "1w", days: 1826 }, all: { interval: "1w", days: null } };
function showView(view, data) {
  const ts = chart.timeScale();
  if (!view.days || !data.length) { ts.fitContent(); return; }
  const to = data.at(-1).time, from = to - view.days * 86400;
  const i = data.findIndex((c) => c.time >= from);
  ts.setVisibleLogicalRange({ from: Math.max(0, i) - 0.5, to: data.length + 2 });
}
/** The button that should look selected: a view (1Y/5Y/ALL) or a candle size. */
function markIntervalButtons() {
  const key = state.view || state.interval;
  document.querySelectorAll("#intervals button").forEach((x) => x.classList.toggle("on", x.dataset.i === key));
}

function chartMessage(text) {
  let m = $("chart").querySelector(".chart-msg");
  if (!text) { m?.remove(); return; }
  if (!m) { m = document.createElement("div"); m.className = "chart-msg"; $("chart").appendChild(m); }
  m.textContent = text;
}

function volBar(c) {
  return { time: c.time, value: c.volume, color: c.close >= c.open ? "rgba(34,197,94,0.35)" : "rgba(240,80,110,0.35)" };
}

async function loadChart() {
  const sym = state.selected, interval = state.interval;
  const token = ++klineLoadToken;
  if (klineStream) { klineStream.close(); klineStream = null; }
  state.forecast = null; state.analysis = null; drawForecast(); renderForecastBox();
  renderDecision(decisionCtx());
  chartMessage("Loading chart…");
  try {
    const view = VIEWS[state.view];
    const data = await getKlines(sym, interval, view && !view.days ? (isStock(sym) ? 5000 : 1000) : 500);
    if (token !== klineLoadToken) return;
    const prec = fmt.precisionFor(data.at(-1)?.close ?? 1);
    candles.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 1 / 10 ** prec } });
    candles.setData(data);
    volume.setData(data.map(volBar));
    setEmaData(data);
    lastCandle = data.at(-1) ?? null;
    if (view) showView(view, data);
    else centerLive(data.length);
    refreshPatterns(sym);
    chartMessage("");
    paintHeader();
    scanner.analyzeSymbol(sym, interval);
  } catch (e) {
    console.warn(e);
    chartMessage(`Couldn't load chart data${isStock(sym) ? "" : " from Binance.US"}. Retrying…`);
    setTimeout(() => token === klineLoadToken && loadChart(), 5000);
    return;
  }

  klineStream = createKlineFeed(sym, interval, {
    onStatus: (s) => setStatus("kline", s),
    onCandle: (c) => {
      if (token !== klineLoadToken) return;
      if (lastCandle && c.time < lastCandle.time) return;
      const newCandle = lastCandle && c.time > lastCandle.time;
      candles.update(c);
      volume.update(volBar(c));
      updateEma(c);
      lastCandle = c;
      if (newCandle) refreshPatterns(sym);   // the previous candle just closed: check it for patterns
      scanner.onCandle(c);
      if (!state.stats.has(sym)) paintHeader();
    },
  });
}

function selectSymbol(sym) {
  state.selected = sym;
  store.set("selected", sym);
  document.querySelectorAll("#watchlist li").forEach((li) => li.classList.toggle("active", li.dataset.sym === sym));
  lastCandle = null;
  paintHeader();
  loadChart();
  loadNews();
  if (!state.stats.has(sym)) get24h([sym]).then((r) => { r.forEach((x) => state.stats.set(x.symbol, x)); paintHeader(); }).catch(() => {});
}

/* ---------- News ---------- */
let newsToken = 0;
let headlinesMode = store.get("headlines", "world");
const newsCache = new Map();
/** News for a crypto coin ("BTC"), a stock symbol ("S:AAPL"), or all crypto (""). */
async function fetchNews(coin) {
  const key = coin || "*";
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.t < 120_000) return hit.v;
  const qs = !coin ? "" : coin === "@world" ? "?world=1" : isStock(coin)
    ? `?stock=${encodeURIComponent(coin.slice(2))}&name=${encodeURIComponent(stockInfo(coin).name)}`
    : `?coin=${encodeURIComponent(coin)}`;
  const res = await fetch(`/api/news${qs}`);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const v = await res.json();
  newsCache.set(key, { t: Date.now(), v });
  return v;
}

const MOOD_ICON = { positive: "▲", negative: "▼", neutral: "•" };
function newsItemHtml(it) {
  const m = it.mood?.label || "neutral";
  return `<li><a href="${fmt.esc(it.link)}" target="_blank" rel="noopener noreferrer">
    <div class="news-title"><span class="mood-dot md-${m}" title="Headline mood: ${m}">${MOOD_ICON[m]}</span>${fmt.esc(it.title)}</div>
    <div class="news-sub">${it.region ? `<span class="tag region">${fmt.esc(it.region)}</span>` : ""}<span>${fmt.esc(it.source)}</span><span>·</span><span>${fmt.ago(it.published)}</span>
      ${(it.coins || []).slice(0, 4).map((c) => `<span class="tag">${fmt.esc(c)}</span>`).join("")}</div></a></li>`;
}

function currentBase() {
  return state.bySymbol.get(state.selected)?.base ?? state.selected.replace(/(USDT|USDC|USD)$/, "");
}

async function loadNews() {
  const token = ++newsToken;
  const base = currentBase();
  $("news-tab-coin").textContent = "News"; $("news-tab-coin").title = `Headlines for ${base}`;
  const tab = state.newsTab;
  const listTab = tab === "coin" || tab === "all";
  $("report").hidden = tab !== "report";
  $("world").hidden = tab !== "world";
  $("calendar").hidden = tab !== "calendar";
  $("news-meta").hidden = !listTab;
  $("news-list").hidden = !listTab;
  worldVisible(tab === "world");
  if (tab === "report") return loadReport(base, token);
  if (tab === "world") return;
  if (tab === "calendar") return renderCalendar();

  // "Headlines": global business news (Americas, Europe, Asia) or crypto news.
  const coin = tab === "coin" ? (isStock(state.selected) ? state.selected : base) : headlinesMode === "world" ? "@world" : "";
  const list = $("news-list");
  $("news-meta").textContent = "Loading headlines…";
  try {
    const data = await fetchNews(coin);
    if (token !== newsToken) return;
    const meta =
      `${data.items.length} headlines · updated ${new Date(data.updated).toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit" })}` +
      (data.failedSources?.length ? ` · unavailable: ${data.failedSources.join(", ")}` : "");
    const toggle = tab === "all" ? `<div class="seg small-seg headlines-toggle"><button data-hl="world" class="${headlinesMode === "world" ? "on" : ""}">World business</button><button data-hl="crypto" class="${headlinesMode === "crypto" ? "on" : ""}">Crypto</button></div>` : "";
    $("news-meta").innerHTML = toggle + (coin && coin !== "@world" ? moodHtml(moodOf(data.items)) : "") + `<div>${fmt.esc(meta)}</div>`;
    list.innerHTML = data.items.length
      ? data.items.map(newsItemHtml).join("")
      : `<li class="news-empty">No recent headlines for ${fmt.esc(nameFor(state.selected))}.</li>`;
  } catch (e) {
    if (token !== newsToken) return;
    $("news-meta").textContent = "";
    list.innerHTML = `<li class="news-empty">News is unavailable right now. (The news service runs on the hosted site. If you opened the file directly, run the local dev server instead.)</li>`;
  }
}

/* ---------- Report tab ---------- */
async function loadReport(base, token) {
  const el = $("report");
  const sym = state.selected;
  const stock = isStock(sym);
  const name = nameFor(sym);
  const newsKey = stock ? sym : base;
  el.innerHTML = `
    <section class="r-sec" id="r-ai"><h3>What's happening</h3><div class="muted small">Reading the latest ${fmt.esc(name)} headlines…</div></section>
    <section class="r-sec" id="r-newsai"></section>
    <section class="r-sec" id="r-mood"></section>
    <section class="r-sec" id="r-card"><h3>${fmt.esc(name)} report card</h3><div class="muted small">Loading ${stock ? "company" : "coin"} data…</div></section>`;

  // AI news read (scored headlines + its measured record)
  renderNewsAi($("r-newsai"), sym, name, () => token === newsToken).catch(() => {});

  // News mood + AI summary
  fetchNews(newsKey).then((data) => {
    if (token !== newsToken) return;
    $("r-mood").innerHTML = moodHtml(moodOf(data.items)) +
      `<button class="link-btn" data-goto="coin">See all ${data.items.length} ${fmt.esc(base)} headlines →</button>`;
  }).catch(() => { if (token === newsToken) $("r-mood").innerHTML = `<div class="muted small">News unavailable.</div>`; });

  fetch(`/api/summary?${stock ? "stock" : "coin"}=${encodeURIComponent(base)}&name=${encodeURIComponent(name)}`)
    .then((r) => r.json())
    .then((s) => {
      if (token !== newsToken) return;
      const box = $("r-ai");
      if (!s.available || !s.bullets) {
        box.innerHTML = `<h3>What's happening</h3><div class="muted small">${fmt.esc(s.reason || "AI summary unavailable right now.")}</div>`;
        return;
      }
      box.innerHTML = `<h3>What's happening <span class="ai-badge">AI</span></h3>
        <ul class="ai-list">${s.bullets.map((b) => `<li>${fmt.esc(b)}</li>`).join("")}</ul>
        <div class="muted tiny">Written by AI from ${s.count} recent headlines${s.generated ? ` at ${new Date(s.generated).toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit" })}` : ""}. It can be wrong. Check the sources. Not advice.</div>`;
    })
    .catch(() => { if (token === newsToken) $("r-ai").innerHTML = `<h3>What's happening</h3><div class="muted small">AI summary unavailable right now.</div>`; });

  // Fundamentals
  if (stock) {
    try {
      const p = await getStockProfile(base, state.stats.get(sym));
      if (token !== newsToken) return;
      $("r-card").innerHTML = `<h3>${fmt.esc(name)} report card</h3>
        <dl class="rc">${p.lines.map((l) => `<div><dt>${l.k}</dt><dd>${l.t}</dd></div>`).join("")}</dl>
        <p class="muted tiny">${p.source}</p>`;
    } catch (e) {
      if (token !== newsToken) return;
      $("r-card").innerHTML = `<h3>${fmt.esc(name)} report card</h3><div class="muted small">Couldn't load company filings right now.</div>`;
    }
    return;
  }
  try {
    const p = await getProfile(base);
    if (token !== newsToken) return;
    if (!p) { $("r-card").innerHTML = `<h3>${fmt.esc(name)} report card</h3><div class="muted small">No CoinGecko data found for ${fmt.esc(base)}.</div>`; return; }
    const lines = plainEnglish(p);
    const img = p.m.image ? `<img src="${fmt.esc(p.m.image)}" alt="" width="20" height="20" loading="lazy" />` : "";
    $("r-card").innerHTML = `<h3>${img}${fmt.esc(p.m.name)} report card</h3>
      <dl class="rc">${lines.map((l) => `<div><dt>${l.k}</dt><dd>${l.t}</dd></div>`).join("")}</dl>
      <p class="muted tiny">Crypto coins don't publish quarterly earnings like companies do, so this shows size, supply and price history instead.
      Data: <a href="https://www.coingecko.com/en/coins/${encodeURIComponent(p.m.id)}" target="_blank" rel="noopener noreferrer">CoinGecko</a>.</p>`;
  } catch (e) {
    if (token !== newsToken) return;
    $("r-card").innerHTML = `<h3>${fmt.esc(name)} report card</h3><div class="muted small">${e.message === "rate-limited"
      ? "CoinGecko is busy (free-tier limit). Try again in a minute." : "Couldn't load coin data right now."}</div>`;
  }
}

/* ---------- Polish: EMA toggle + keyboard shortcuts ---------- */
function toggleEma() {
  state.showEma = !state.showEma;
  store.set("ema", state.showEma);
  applyEmaVisibility();
}

function initShortcuts() {
  const intervals = ["1m", "5m", "15m", "1h", "4h", "1d"];
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "select", "textarea"].includes(tag) || e.target.isContentEditable) return;
    const k = e.key;
    if (k === "/") { e.preventDefault(); $("search").focus(); }
    else if (k >= "1" && k <= "6") { document.querySelector(`#intervals button[data-i="${intervals[+k - 1]}"]`)?.click(); }
    else if (k === "l" || k === "L") centerLive();
    else if (k === "e" || k === "E") toggleEma();
    else if (k === "p" || k === "P") togglePatterns();
    else if (k === "f" || k === "F") toggleForecast();
    else if (k === "a" || k === "A") $("alerts-btn").click();
    else if (k === "?") $("help").hidden = !$("help").hidden;
    else if (k === "Escape") $("help").hidden = true;
    else if (k === "ArrowDown" || k === "ArrowUp") {
      const i = state.watchlist.indexOf(state.selected);
      const n = state.watchlist.length;
      if (!n) return;
      e.preventDefault();
      selectSymbol(state.watchlist[(i + (k === "ArrowDown" ? 1 : -1) + n) % n]);
      document.querySelector(`#watchlist li[data-sym="${state.selected}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });
  document.addEventListener("click", (e) => {
    if (!$("help").hidden && !e.target.closest("#help, #help-btn")) $("help").hidden = true;
  });
}

/** Candle size or trading style changed: re-check the whole watchlist on the new candle size. */
let ivTimer = 0;
function onIntervalChanged() {
  clearTimeout(ivTimer);
  ivTimer = setTimeout(() => runOpportunities(), 600);
}
/* Copy the bot's open trade on this market into My trades, sized for the user's balance. */
function copyBotTrade() {
  const sym = state.selected, p = botViewCached(sym)?.holding;
  const price = state.stats.get(sym)?.last ?? lastCandle?.close;
  if (!p || !(price > 0)) return;
  const name = nameFor(sym);
  if (price <= p.stop || price >= p.target) {
    pushAlert({ kind: "info", symbol: sym, title: "Too late to copy", body: `${name} is already ${price <= p.stop ? "at or below the bot's stop-loss" : "at or above the bot's target"}. Entryvex won't copy a trade whose plan has already played out.` });
    return;
  }
  if (!(moneySettings.balance > 0)) {
    pushAlert({ kind: "info", symbol: sym, title: "Enter your trading balance first", body: "Type it in Trading balance (under the chart) so Entryvex can size the copy for you." });
    $("m-balance")?.scrollIntoView({ behavior: "smooth", block: "center" }); $("m-balance")?.focus();
    return;
  }
  const info = state.bySymbol.get(sym) || {};
  const cost = isStock(sym) ? 0.0002 : 0.0005;
  const sz = sizePosition({ balance: moneySettings.balance, riskPct: moneySettings.riskPct, entry: price, stop: p.stop, target: p.target, costPerSide: cost,
    rules: { stepSize: info.stepSize, minQty: info.minQty, tickSize: info.tickSize, minNotional: info.minNotional } });
  if (!sz?.ok) {
    pushAlert({ kind: "info", symbol: sym, title: "Can't size this copy", body: sz?.reason === "too-small" ? "Your balance and max-loss setting make this trade smaller than the exchange minimum." : "The bot's stop and target don't leave room for a trade at today's price." });
    return;
  }
  addTrade({ symbol: sym, entry: price, qty: sz.qty, stop: p.stop, target: p.target, setup: `Copied the bot: ${p.name}`, interval: p.iv, source: "bot-copy", sellBy: p.sellBy });
  pushAlert({ kind: "info", symbol: sym, title: `Copied: buy ${+sz.qty.toFixed(8)} ${isStock(sym) ? "shares of " + name : name}`,
    body: `About $${sz.spend.toFixed(2)} at ${fmt.price(price)}. Now place it at your exchange or broker, then set a take-profit at ${fmt.price(p.target)} and a stop-loss at ${fmt.price(p.stop)}. It's in My trades; Entryvex will tell you when to sell.` });
}

/* ---------- Simple / Pro mode ---------- */
// Simple (default for everyone): click a coin or stock and get one big BUY / SELL / WAIT card with how
// much and when to sell. Pro: every tool, table and number.
const SIMPLE_TABS = new Set(["holdings", "bot", "score", "trades", "ai"]);
function applyMode(mode) {
  if (mode !== "pro") mode = "simple";
  store.set("mode", mode);
  document.body.classList.toggle("mode-simple", mode === "simple");
  document.querySelectorAll("#mode-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  if (mode === "simple") {
    const cur = document.querySelector("#center-tabs button.on")?.dataset.tab;
    if (cur && !SIMPLE_TABS.has(cur)) document.querySelector('#center-tabs button[data-tab="bot"]')?.click();
  }
}
function initMode() {
  applyMode(store.get("mode", "simple"));
  $("mode-seg").addEventListener("click", (e) => { const b = e.target.closest("button[data-mode]"); if (b) applyMode(b.dataset.mode); });
  $("simple-card").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-mode-pro")) applyMode("pro");
    if (b.hasAttribute("data-copy-bot")) copyBotTrade();
    if (b.hasAttribute("data-open-holdings")) { document.querySelector('#center-tabs button[data-tab="holdings"]')?.click(); $("center-tabs").scrollIntoView({ behavior: "smooth", block: "start" }); }
    if (b.hasAttribute("data-take-pro")) {   // the trade card (with "I took this trade") lives in Pro's Scanner tab
      applyMode("pro");
      document.querySelector('#center-tabs button[data-tab="scanner"]')?.click();
      setTimeout(() => (document.querySelector(".take-row, #trade-card, #tab-scanner .card") || $("center-tabs")).scrollIntoView({ behavior: "smooth", block: "center" }), 200);
    }
    if (b.hasAttribute("data-open-bot")) { document.querySelector('#center-tabs button[data-tab="bot"]')?.click(); $("center-tabs").scrollIntoView({ behavior: "smooth", block: "start" }); }
    if (b.hasAttribute("data-goto-opps")) { applyMode("pro"); document.querySelector('#center-tabs button[data-tab="opps"]')?.click(); $("center-tabs").scrollIntoView({ behavior: "smooth", block: "start" }); }
    if (b.dataset.gotoIv) document.querySelector(`#intervals button[data-i="${b.dataset.gotoIv}"]`)?.click();
    if (b.hasAttribute("data-open-alerts")) $("alerts-btn").click();
  });
}

/** Top "Scan watchlist" button: refresh every price and re-check every market now, staying where you are. */
function scanFromTop() {
  if (oppsRunning()) return;
  refreshTickers();
  runOpportunities();
  if (state.selected) loadChart();
}
/** "Scan watchlist": open Opportunities and re-check every market in the watchlist now. */
function scanWholeWatchlist() {
  document.querySelector('#center-tabs button[data-tab="opps"]')?.click();
  $("center-tabs").scrollIntoView({ behavior: "smooth", block: "start" });
  runOpportunities();
}

/* ---------- Trading style: Day trader / Swing trader / Long-term holder ---------- */
const STYLES = {
  day: { interval: "5m", hint: "Fast signals on 5-minute candles. Check the calendar before big news." },
  swing: { interval: "4h", hint: "Trades lasting days to weeks on 4-hour candles." },
  hold: { interval: "1d", hint: "Months to years on daily candles: long-term view first." },
};
function applyStyle(style, changeInterval) {
  if (!STYLES[style]) style = "swing";
  store.set("style", style);
  document.body.classList.remove("style-day", "style-swing", "style-hold");
  document.body.classList.add("style-" + style);
  document.querySelectorAll("#style-seg button").forEach((b) => b.classList.toggle("on", b.dataset.style === style));
  $("style-hint").textContent = STYLES[style].hint;
  if (changeInterval && state.interval !== STYLES[style].interval) {
    document.querySelector(`#intervals button[data-i="${STYLES[style].interval}"]`)?.click();
  }
  ltSymbol = null;   // re-render the long-term card (open/closed depends on the style)
  renderLongTerm({ ...decisionCtx(), onLoaded: () => updateBuyNow(decisionCtx()) });
}
function initStyle() {
  applyStyle(store.get("style", "swing"), false);
  $("style-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-style]");
    if (b) applyStyle(b.dataset.style, true);
  });
}

/* ---------- First-visit welcome guide ---------- */
function initWelcome() {
  const box = $("welcome");
  const steps = [...box.querySelectorAll("[data-step]")];
  const dots = [...box.querySelectorAll(".w-dots i")];
  let i = 0;
  const show = (n) => {
    i = n;
    steps.forEach((s, k) => (s.hidden = k !== i));
    dots.forEach((d, k) => d.classList.toggle("on", k === i));
    $("w-next").textContent = i === steps.length - 1 ? "Start" : "Next";
  };
  const close = () => { box.hidden = true; store.set("welcomed", true); };
  const open = () => { show(0); box.hidden = false; $("w-next").focus(); };
  $("w-next").addEventListener("click", () => (i < steps.length - 1 ? show(i + 1) : close()));
  $("w-skip").addEventListener("click", close);
  box.addEventListener("click", (e) => { if (e.target === box) close(); });
  document.addEventListener("keydown", (e) => { if (!box.hidden && e.key === "Escape") close(); });
  $("show-welcome").addEventListener("click", () => { $("help").hidden = true; open(); });
  if (!store.get("welcomed", false)) open();
}

/* ---------- Installable app ---------- */
function initInstall() {
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; $("install-btn").hidden = false; });
  $("install-btn").addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null; $("install-btn").hidden = true;
  });
  window.addEventListener("appinstalled", () => ($("install-btn").hidden = true));
}

/* ---------- Boot ---------- */
async function boot() {
  tickClock();
  setInterval(tickClock, 1000);
  initChart();
  initMoney();
  scanner = createScanner({
    chartSeries: candles,
    getWatchlist: () => state.watchlist.slice(),
    getBase: () => state.bySymbol.get(state.selected)?.base ?? state.selected,
    getInfo: (sym) => state.bySymbol.get(sym),
    onPickSymbol: (sym) => { selectSymbol(sym); window.scrollTo({ top: 0, behavior: "smooth" }); },
    // Zoom out to show all past trades on the chart; zoom back to the live candle when hidden.
    onShowTrades: (showing) => (showing ? chart.timeScale().fitContent() : centerLive()),
    onAnalyzed: updateForecast,
    onPickInterval: (iv) => document.querySelector(`#intervals button[data-i="${iv}"]`)?.click(),
    onScanAll: scanWholeWatchlist,
    restoreMarkers: () => drawPatternMarkers(),
  });
  $("center-live").addEventListener("click", () => centerLive());
  $("scan-top").addEventListener("click", scanFromTop);
  initMode();
  $("wl-sort").value = wlSort;
  $("wl-sort").addEventListener("change", (e) => { wlSort = SORTS.has(e.target.value) ? e.target.value : "mine"; store.set("wlSort", wlSort); renderWatchlist(); });
  setInterval(resortWatchlist, 5000);   // keep the sort right as prices and signals change
  $("wl-summary").addEventListener("change", (e) => { if (e.target.id === "wl-auto") setScanEvery(+e.target.value); });
  $("sym-pair").addEventListener("click", (e) => {
    if (!e.target.closest("[data-open-picks]")) return;
    document.querySelector('#center-tabs button[data-tab="picks"]')?.click();
    $("center-tabs").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // Stock Rank in the background (cached 6 h) so stock pages and the AI can show each stock's rank.
  setTimeout(() => runPicks().then(paintHeader), 20_000);
  onMoneyChange(() => { refreshDecision(decisionCtx()); updateBuyNow(decisionCtx()); });
  onFx(() => { refreshDecision(decisionCtx()); updateBuyNow(decisionCtx()); });
  initBuyNow();
  onJournalChange(() => refreshDecision(decisionCtx()));
  $("decision").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-open-alerts")) $("alerts-btn").click();
    if (b.hasAttribute("data-find-edge")) { document.querySelector('#center-tabs button[data-tab="scanner"]')?.click(); $("find-edges").click(); $("edges").scrollIntoView({ behavior: "smooth", block: "center" }); }
    if (b.hasAttribute("data-goto-opps")) { document.querySelector('#center-tabs button[data-tab="opps"]')?.click(); $("center-tabs").scrollIntoView({ behavior: "smooth", block: "start" }); }
    if (b.hasAttribute("data-scan-all")) scanWholeWatchlist();
    if (b.dataset.gotoIv) document.querySelector(`#intervals button[data-i="${b.dataset.gotoIv}"]`)?.click();
  });
  $("ema-toggle").addEventListener("click", toggleEma);
  $("patterns-toggle").addEventListener("click", togglePatterns);
  $("patterns-toggle").classList.toggle("on", state.showPatterns);
  $("price-alert-btn").addEventListener("click", () => openPriceAlert(state.selected));
  $("help-btn").addEventListener("click", () => ($("help").hidden = !$("help").hidden));
  initAlerts({
    getWatchlist: () => state.watchlist.slice(),
    getInfo: (sym) => state.bySymbol.get(sym),
    getSelected: () => state.selected,
    getPrice: (sym) => state.stats.get(sym)?.last,
    // Clicking an alert opens that coin or stock (on the alert's candle size), without adding it to the watchlist.
    onPick: (sym, iv) => {
      if (isStock(sym)) state.bySymbol.set(sym, stockInfo(sym));
      if (iv && iv !== state.interval && document.querySelector(`#intervals button[data-i="${iv}"]`)) {
        state.selected = sym;
        document.querySelector(`#intervals button[data-i="${iv}"]`).click();
      }
      selectSymbol(sym);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onBadges: (b) => { state.badges = b; renderWatchlist(); },
  });
  initShortcuts();
  initWorld({ onOpen: (sym) => { state.bySymbol.set(sym, stockInfo(sym)); pick(sym); } });
  loadCalendar().catch(() => {});
  $("news-meta").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-hl]");
    if (!b) return;
    headlinesMode = b.dataset.hl; store.set("headlines", headlinesMode); loadNews();
  });
  initInstall();
  initStyle();
  initWelcome();
  initWatchlistDrag();
  $("forecast-toggle").addEventListener("click", toggleForecast);

  // Center tabs: Scanner / My trades / Signal record / AI
  const showTab = (tab) => {
    store.set("centerTab", tab);
    document.querySelectorAll("#center-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    for (const t of ["scanner", "movers", "holdings", "bot", "score", "picks", "opps", "trades", "signals", "ai"]) $("tab-" + t).hidden = t !== tab;
    botVisible(tab === "bot");
    holdingsVisible(tab === "holdings");
    scorecardVisible(tab === "score");
    moversVisible(tab === "movers");
    picksVisible(tab === "picks");
    if (tab === "ai") $("ai-input").focus({ preventScroll: true });
  };
  // Browse markets: ranked lists next to the watchlist (open on the chart, or ＋ to add).
  const registerFromBrowse = (sym, meta) => { if (meta && isStock(sym)) { registerStock(sym, meta); state.bySymbol.set(sym, stockInfo(sym)); } };
  initBrowse({
    cryptoPair: (base) => cryptoPair(base)?.symbol || null,
    isWatched: (sym) => state.watchlist.includes(sym),
    onOpen: (sym, meta) => { registerFromBrowse(sym, meta); selectSymbol(sym); if (innerWidth < 900) $("chart").scrollIntoView({ behavior: "smooth", block: "start" }); },
    onAdd: (sym, meta) => { registerFromBrowse(sym, meta); addToWatchlist(sym); },
  });
  initHoldings({
    // "BTC" → the Binance.US pair; anything else → the best stock/ETF/index match.
    resolveSymbol: async (raw) => {
      const t = raw.trim().toUpperCase().replace(/\s+/g, "");
      if (t.startsWith("S:")) { registerStock(t, {}); return t; }
      const pair = cryptoPair(t.replace(/(USDT|USDC|USD)$/, ""));
      if (pair) return pair.symbol;
      const found = await searchStocks(raw).catch(() => []);
      const hit = found.find((x) => x.ticker.toUpperCase() === t) || found[0];
      if (!hit) return null;
      registerStock(hit.symbol, { name: hit.name, exchange: hit.exchange, kind: hit.kind });
      state.bySymbol.set(hit.symbol, stockInfo(hit.symbol));
      return hit.symbol;
    },
    currentSymbol: () => state.selected,
    nameFor,
    getPrice: (sym) => state.stats.get(sym)?.last ?? null,
    onOpen: (sym) => { if (isStock(sym)) state.bySymbol.set(sym, stockInfo(sym)); selectSymbol(sym); window.scrollTo({ top: 0, behavior: "smooth" }); },
    ensureWatched: (sym) => {
      if (state.watchlist.includes(sym)) return;
      state.watchlist.push(sym); store.set("watchlist", state.watchlist); scheduleSync(); refreshTickers();
      setTimeout(() => runOpportunities([sym]), 1500);
    },
    addAlert: (sym, dir, price) => addPriceAlert(sym, dir, price),
    notify: pushAlert,
    askAI: (q) => {
      document.querySelector('#center-tabs button[data-tab="ai"]')?.click();
      $("ai-input").value = q;
      $("ai-form").requestSubmit();
    },
  });
  initBot({
    notify: pushAlert,
    onFollowChange: () => scheduleSync(500),   // tell the alert server (phone / closed-app alerts)
    openMarket: (sym) => { if (isStock(sym)) state.bySymbol.set(sym, stockInfo(sym)); selectSymbol(sym); window.scrollTo({ top: 0, behavior: "smooth" }); },
  });
  initScorecard({ openMarket: (sym) => { if (isStock(sym)) state.bySymbol.set(sym, stockInfo(sym)); selectSymbol(sym); window.scrollTo({ top: 0, behavior: "smooth" }); } });
  // "See every check" links in the forecast box and the answer card open the Scorecard tab.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-open-score]")) return;
    showTab("score");
    $("center-tabs").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  initPicks({ onPick: (sym) => { state.bySymbol.set(sym, stockInfo(sym)); pick(sym); } });
  document.querySelectorAll("#center-tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  // Links from bot notifications (/?tab=bot) open the Bot tab.
  const urlTab = new URLSearchParams(location.search).get("tab");
  showTab(urlTab === "bot" ? "bot" : store.get("centerTab", "scanner"));
  if (urlTab === "bot") setTimeout(() => $("center-tabs").scrollIntoView({ behavior: "smooth", block: "start" }), 800);

  const pick = (sym) => { if (!state.watchlist.includes(sym)) addToWatchlist(sym); else selectSymbol(sym); window.scrollTo({ top: 0, behavior: "smooth" }); };
  initJournal({
    getWatchlist: () => state.watchlist.slice(),
    ensureWatched: (sym) => { if (!state.watchlist.includes(sym)) { state.watchlist.push(sym); store.set("watchlist", state.watchlist); refreshTickers(); } },
    getInfo: (sym) => state.bySymbol.get(sym),
    getPrice: (sym) => state.stats.get(sym)?.last,
    onPick: pick,
    notify: pushAlert,
    showTab: (t) => { showTab(t); $("center-tabs").scrollIntoView({ behavior: "smooth", block: "start" }); },
  });
  initSignals({ getInfo: (sym) => state.bySymbol.get(sym), onPick: pick });
  initMovers({
    onOpen: (sym) => { if (isStock(sym)) state.bySymbol.set(sym, stockInfo(sym)); pick(sym); },
  });
  initOpportunities({
    getWatchlist: () => state.watchlist.slice(),
    getInfo: (sym) => state.bySymbol.get(sym),
    onPick: (sym, iv) => {
      if (iv && iv !== state.interval) { state.interval = iv; state.view = null; store.set("interval", iv); store.set("view", null); markIntervalButtons(); onIntervalChanged(); }
      if (sym === state.selected) loadChart(); else pick(sym);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    getInterval: () => (state.interval === "1w" ? "1d" : state.interval),
    // A watchlist market just turned green: pop-up, sound, and a desktop notification if those are on.
    onNewBuy: (b) => pushAlert({ kind: "setup", symbol: b.sym, interval: b.iv, title: `${b.label === "GO" ? "BUY" : "SMALL BUY"}: ${b.base} on ${b.iv} candles`,
      body: `${b.setup} just appeared and has a winning record here. Tap to see the plan.` }),   // weekly has too little history to test setups: use daily
    onUpdate: () => { refreshDecision(decisionCtx()); scheduleSync(); paintSignals(); },
    onProgress: ({ running, done, total }) => {
      const b = $("scan-top");
      b.disabled = running;
      b.querySelector("span").textContent = running ? `Scanning ${Math.min(100, Math.round((done / Math.max(1, total)) * 100))}%` : "Scan watchlist";
      paintSignals();
    },
  });
  initPush({
    buildPrefs: () => {
      const a = getAlertPrefs();
      return {
        priceAlerts: a.priceAlerts, move: a.move,
        trades: openTrades().map((t) => ({ id: t.id, symbol: t.symbol, base: state.bySymbol.get(t.symbol)?.base, stop: t.stop, target: t.target, sellBy: t.sellBy })),
        setups: a.setupOn ? setupMarkets(a.setupMin) : [],
        followBot: followBot(),
      };
    },
  });
  onJournalChange(() => scheduleSync());
  initAI({
    getSettings: () => ({ balance: +store.get("balance", 0), riskPct: +store.get("riskPct", 1), feePct: +store.get("feePct", 0.02) }),
    getWatchlistInfo: () => state.watchlist.map((sym) => {
      const info = state.bySymbol.get(sym) || {};
      return { sym, ticker: info.base || sym, name: nameFor(sym), kind: isStock(sym) ? "stock" : "crypto", changePct: state.stats.get(sym)?.changePct ?? null, signal: signalFor(sym) };
    }),
    onPick: (sym) => { if (sym) pick(sym); },
  });

  if (!VIEWS[state.view]) state.view = null;
  markIntervalButtons();
  document.querySelectorAll("#intervals button").forEach((b) => {
    b.addEventListener("click", () => {
      const v = VIEWS[b.dataset.i];
      state.view = v ? b.dataset.i : null;
      state.interval = v ? v.interval : b.dataset.i;
      store.set("interval", state.interval);
      store.set("view", state.view);
      markIntervalButtons();
      loadChart();
      onIntervalChanged();
    });
  });
  const setNewsTab = (tab) => {
    state.newsTab = tab;
    store.set("newsTab", tab);
    document.querySelectorAll("#news-tabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
    loadNews();
  };
  document.querySelectorAll("#news-tabs button").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === state.newsTab);
    b.addEventListener("click", () => setNewsTab(b.dataset.tab));
  });
  $("report").addEventListener("click", (e) => {
    const g = e.target.closest("[data-goto]");
    if (g) setNewsTab(g.dataset.goto);
  });

  const input = $("search");
  input.addEventListener("input", () => runSearch(input.value));
  input.addEventListener("focus", () => runSearch(input.value));
  input.addEventListener("keydown", (e) => {
    const box = $("search-results");
    if (box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      searchIdx = (searchIdx + (e.key === "ArrowDown" ? 1 : -1) + searchHits.length) % Math.max(1, searchHits.length);
      box.querySelectorAll("button").forEach((b, i) => b.classList.toggle("active", i === searchIdx));
    } else if (e.key === "Enter") { e.preventDefault(); pickSearch(searchIdx); }
    else if (e.key === "Escape") { box.hidden = true; }
  });
  $("search-results").addEventListener("mousedown", (e) => {
    const b = e.target.closest("button");
    if (b) { e.preventDefault(); pickSearch(+b.dataset.i); }
  });
  input.addEventListener("blur", () => setTimeout(() => ($("search-results").hidden = true), 120));

  // Stocks: add a few well-known ones the first time, and register every stock in the watchlist.
  if (!store.get("stocksAdded", false)) {
    const defaults = [["S:SPY", "SPDR S&P 500 ETF", "ETF"], ["S:AAPL", "Apple Inc.", "Stock"], ["S:NVDA", "NVIDIA Corporation", "Stock"], ["S:TSLA", "Tesla, Inc.", "Stock"], ["S:MSFT", "Microsoft Corporation", "Stock"]];
    for (const [sym, name, kind] of defaults) {
      registerStock(sym, { name, kind });
      if (!state.watchlist.includes(sym)) state.watchlist.push(sym);
    }
    store.set("stocksAdded", true);
    store.set("watchlist", state.watchlist);
  }
  for (const sym of state.watchlist) if (isStock(sym)) state.bySymbol.set(sym, stockInfo(sym));

  try {
    state.allSymbols = await getSymbols();
    for (const s of state.allSymbols) state.bySymbol.set(s.symbol, s);
    // Drop crypto pairs that no longer trade (stocks are kept).
    state.watchlist = state.watchlist.filter((s) => isStock(s) || state.bySymbol.has(s));
    if (!state.watchlist.length) state.watchlist = DEFAULT_WATCHLIST.filter((s) => state.bySymbol.has(s));
    store.set("watchlist", state.watchlist);
  } catch (e) {
    console.warn("symbols failed", e);
  }
  // Opened from a notification: /?s=SYMBOL&i=INTERVAL
  const qp = new URLSearchParams(location.search);
  const linkSym = qp.get("s"), linkIv = qp.get("i");
  if (linkSym && /^(S:[A-Z0-9.^=\-]{1,12}|[A-Z0-9]{3,20})$/.test(linkSym)) {
    if (isStock(linkSym)) { registerStock(linkSym, {}); state.bySymbol.set(linkSym, stockInfo(linkSym)); }
    if (state.bySymbol.has(linkSym)) {
      if (!state.watchlist.includes(linkSym)) { state.watchlist.push(linkSym); store.set("watchlist", state.watchlist); }
      state.selected = linkSym;
    }
    if (linkIv && ["1m", "5m", "15m", "1h", "4h", "1d"].includes(linkIv)) {
      state.interval = linkIv; state.view = null; store.set("interval", linkIv); store.set("view", null);
      markIntervalButtons();
    }
    history.replaceState(null, "", "/");
  }
  if (!state.bySymbol.has(state.selected) && state.watchlist.length) state.selected = state.watchlist[0];

  refreshTickers();
  selectSymbol(state.selected);
  setInterval(() => document.visibilityState === "visible" && loadNews(), 180_000);
}

boot();
