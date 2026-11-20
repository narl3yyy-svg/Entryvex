import { getSymbols } from "./binance.js";
import { get24h, getKlines, createTickerFeed, createKlineFeed, isStock, stockInfo, registerStock, searchStocks } from "./market.js";
import { COINS, coinName, DEFAULT_WATCHLIST } from "./coins.js";
import * as fmt from "./format.js";
import { createScanner } from "./scanner.js";
import { initMoney } from "./money.js";
import { getProfile, plainEnglish, moodOf, moodHtml, getStockProfile } from "./research.js";
import { initAlerts, onTicker, openPriceAlert, pushAlert } from "./alerts.js";
import { ema } from "./indicators.js";
import { forecast, describeOdds, reliability } from "./forecast.js";
import { initJournal, onTicker as journalTicker } from "./journal.js";
import { initSignals } from "./signals.js";
import { initAI, setAIContext } from "./ai.js";

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
const INTERVAL_SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const FC_H = 20;

/* ---------- Forecast: measured price range for the next FC_H candles ---------- */
function updateForecast(ctx, result) {
  const f = forecast(ctx.candles, INTERVAL_SEC[ctx.interval] || 900, FC_H);
  state.forecast = f ? { ...f, interval: ctx.interval, symbol: ctx.symbol } : null;
  state.analysis = { result, interval: ctx.interval, symbol: ctx.symbol };
  drawForecast();
  renderForecastBox();
  pushAIContext();
}
function drawForecast() {
  const f = state.forecast;
  if (!f || !state.showForecast || f.symbol !== state.selected) { fcLines.forEach((l) => l.setData([])); return; }
  const start = { time: f.t0, value: f.live };
  fcLines.forEach((line, k) => line.setData([start, ...f.bands.map((b) => ({ time: b.time, value: b.q[4 - k] }))]));
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
      <div class="fc-range"><span class="muted">80% likely between</span>
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
    </div>`;
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
  $("clock").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " local";
}

/* ---------- Watchlist ---------- */
function renderWatchlist() {
  const ul = $("watchlist");
  ul.innerHTML = "";
  for (const sym of state.watchlist) {
    const info = state.bySymbol.get(sym);
    const base = info?.base ?? sym;
    const li = document.createElement("li");
    li.dataset.sym = sym;
    if (sym === state.selected) li.classList.add("active");
    li.innerHTML = `
      <span class="wl-base">${fmt.esc(base)}${isStock(sym) ? `<span class="kind-tag">${fmt.esc(info?.kind || "Stock")}</span>` : `<span class="muted small"> / ${fmt.esc(info?.quote ?? "")}</span>`}${badgeHtml(sym)}</span>
      <span class="wl-price" data-f="price">—</span>
      <span class="wl-name">${fmt.esc(nameFor(sym))}</span>
      <span class="wl-chg" data-f="chg">—</span>
      <button class="wl-remove" title="Remove from watchlist" aria-label="Remove ${fmt.esc(base)}">×</button>`;
    li.addEventListener("click", (e) => {
      if (e.target.closest(".wl-remove")) { removeFromWatchlist(sym); e.stopPropagation(); return; }
      selectSymbol(sym);
    });
    ul.appendChild(li);
    paintRow(sym);
  }
}

function badgeHtml(sym) {
  const b = state.badges[sym];
  if (!b || !["go", "caution", "no"].includes(b.level)) return "";
  return `<span class="wl-badge ${b.level}" title="Setup alert scan on ${b.interval} candles">${fmt.esc(b.label)}</span>`;
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
  if (prevLast != null && prevLast !== s.last) {
    li.classList.remove("flash-up", "flash-down");
    void li.offsetWidth;
    li.classList.add(s.last > prevLast ? "flash-up" : "flash-down");
  }
}

function addToWatchlist(sym) {
  if (!state.watchlist.includes(sym)) {
    state.watchlist.push(sym);
    store.set("watchlist", state.watchlist);
    refreshTickers();
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

/** Display name for any symbol: coin name for crypto, company name for stocks. */
function nameFor(sym) {
  if (isStock(sym)) return stockInfo(sym).name;
  return coinName(state.bySymbol.get(sym)?.base ?? sym);
}

/* ---------- Search ---------- */
let searchHits = [];
let searchIdx = 0;
function runSearch(q) {
  const box = $("search-results");
  q = q.trim().toLowerCase();
  if (!q) { box.hidden = true; return; }
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
    .slice(0, 8)
    .map((x) => x.s);
  searchHits = searchHits.slice(0, 5).map((s) => ({ ...s, kind: "crypto" }));
  searchIdx = 0;
  drawSearch(q, true);
  box.hidden = false;
  // Stocks & ETFs come from a server search (debounced).
  clearTimeout(stockSearchTimer);
  const token = ++stockSearchToken;
  stockSearchTimer = setTimeout(async () => {
    let stocks = [];
    try { stocks = await searchStocks(q); } catch {}
    if (token !== stockSearchToken) return;
    searchHits = searchHits.filter((h) => h.kind === "crypto").concat(stocks.map((s) => ({ ...s, kind: "stock" })));
    drawSearch(q, false);
  }, 250);
}
let stockSearchTimer = null, stockSearchToken = 0;
function drawSearch(q, loadingStocks) {
  const box = $("search-results");
  const crypto = searchHits.filter((h) => h.kind === "crypto");
  const stocks = searchHits.filter((h) => h.kind === "stock");
  const row = (s) => {
    const i = searchHits.indexOf(s);
    const added = state.watchlist.includes(s.symbol) ? " · added" : "";
    return s.kind === "crypto"
      ? `<button data-i="${i}" class="${i === searchIdx ? "active" : ""}"><span><strong>${fmt.esc(s.base)}</strong> <span class="muted">/ ${fmt.esc(s.quote)}</span></span>
          <span class="muted small">${fmt.esc(coinName(s.base))}${added}</span></button>`
      : `<button data-i="${i}" class="${i === searchIdx ? "active" : ""}"><span><strong>${fmt.esc(s.ticker)}</strong> <span class="kind-tag">${fmt.esc(s.kind)}</span></span>
          <span class="muted small">${fmt.esc(s.name)} · ${fmt.esc(s.exchange || "")}${added}</span></button>`;
  };
  box.innerHTML =
    `<div class="sr-head">Crypto · Binance.US</div>` + (crypto.length ? crypto.map(row).join("") : `<div class="empty">No crypto pair matches “${fmt.esc(q)}”.</div>`) +
    `<div class="sr-head">US stocks &amp; ETFs</div>` + (stocks.length ? stocks.map(row).join("") : `<div class="empty">${loadingStocks ? "Searching…" : `No US stock matches “${fmt.esc(q)}”.`}</div>`);
}
function pickSearch(i) {
  const s = searchHits[i];
  if (!s) return;
  $("search").value = "";
  $("search-results").hidden = true;
  if (s.kind === "stock") {
    registerStock(s.symbol, { name: s.name, exchange: s.exchange, kind: s.kind });
    state.bySymbol.set(s.symbol, stockInfo(s.symbol));
  }
  addToWatchlist(s.symbol);
}

/* ---------- Header ---------- */
function paintHeader() {
  const sym = state.selected;
  const info = state.bySymbol.get(sym);
  const s = state.stats.get(sym);
  const base = info?.base ?? sym;
  const stock = isStock(sym);
  $("sym-name").textContent = nameFor(sym);
  $("sym-pair").innerHTML = stock
    ? `${fmt.esc(base)} · ${fmt.esc(info?.exchange || "US market")}${s && s.marketOpen != null ? ` <span class="mkt ${s.marketOpen ? "open" : "closed"}">${s.marketOpen ? "Market open" : "Market closed"}</span>` : ""}`
    : fmt.esc(info ? `${info.base}/${info.quote}` : sym);
  const last = s?.last ?? lastCandle?.close;
  $("sym-price").textContent = (stock ? "$" : "") + fmt.price(last);
  const chg = $("sym-change");
  chg.textContent = s ? fmt.pct(s.changePct) + (stock ? " today" : " 24h") : "—";
  chg.className = "chip mono " + (s ? (s.changePct >= 0 ? "up" : "down") : "");
  document.querySelectorAll(".stats dt")[0].textContent = stock ? "Day high" : "24h high";
  document.querySelectorAll(".stats dt")[1].textContent = stock ? "Day low" : "24h low";
  document.querySelectorAll(".stats dt")[2].textContent = stock ? "Day volume" : "24h volume";
  $("sym-high").textContent = fmt.price(s?.high);
  $("sym-low").textContent = fmt.price(s?.low);
  $("sym-vol").textContent = s ? "$" + fmt.compact(s.quoteVolume) : "—";
  if (last) document.title = `${fmt.price(last)} ${base} · Entryvex`;
  pushAIContext();
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
    case 4: return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    default: return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}
function localCrosshairTime(time) {
  const d = toDate(time);
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
  });
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
  // Forecast range lines (80% outer, 50% inner, middle)
  const fc = { lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false };
  fcLines = [
    chart.addLineSeries({ ...fc, color: "rgba(46,229,157,0.45)", lineStyle: 2, title: "80% high" }),
    chart.addLineSeries({ ...fc, color: "rgba(46,229,157,0.8)", lineStyle: 2, title: "", lastValueVisible: false }),
    chart.addLineSeries({ ...fc, color: "rgba(230,234,240,0.7)", lineStyle: 1, title: "middle" }),
    chart.addLineSeries({ ...fc, color: "rgba(240,80,110,0.8)", lineStyle: 2, title: "", lastValueVisible: false }),
    chart.addLineSeries({ ...fc, color: "rgba(240,80,110,0.45)", lineStyle: 2, title: "80% low" }),
  ];
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  chart.subscribeCrosshairMove((p) => {
    const d = p?.seriesData?.get(candles);
    const c = d || lastCandle;
    if (!c) { $("candle-info").textContent = ""; return; }
    $("candle-info").textContent = `O ${fmt.price(c.open)}  H ${fmt.price(c.high)}  L ${fmt.price(c.low)}  C ${fmt.price(c.close)}`;
  });
}

// Keep the live candle in the middle of the chart, with empty space to its right.
// New candles shift the view along, so it stays centered as time passes.
const CENTER_BARS = 70; // candles visible on each side of the live one
function centerLive(count) {
  const last = (count ?? candles.data().length) - 1;
  if (last < 0) return;
  chart.timeScale().setVisibleLogicalRange({ from: last - CENTER_BARS, to: last + CENTER_BARS });
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
  state.forecast = null; drawForecast(); renderForecastBox();
  chartMessage("Loading chart…");
  try {
    const data = await getKlines(sym, interval, 500);
    if (token !== klineLoadToken) return;
    const prec = fmt.precisionFor(data.at(-1)?.close ?? 1);
    candles.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 1 / 10 ** prec } });
    candles.setData(data);
    volume.setData(data.map(volBar));
    setEmaData(data);
    lastCandle = data.at(-1) ?? null;
    centerLive(data.length);
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
      candles.update(c);
      volume.update(volBar(c));
      updateEma(c);
      lastCandle = c;
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
const newsCache = new Map();
/** News for a crypto coin ("BTC"), a stock symbol ("S:AAPL"), or all crypto (""). */
async function fetchNews(coin) {
  const key = coin || "*";
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.t < 120_000) return hit.v;
  const qs = !coin ? "" : isStock(coin)
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
    <div class="news-sub"><span>${fmt.esc(it.source)}</span><span>·</span><span>${fmt.ago(it.published)}</span>
      ${(it.coins || []).slice(0, 4).map((c) => `<span class="tag">${fmt.esc(c)}</span>`).join("")}</div></a></li>`;
}

function currentBase() {
  return state.bySymbol.get(state.selected)?.base ?? state.selected.replace(/(USDT|USDC|USD)$/, "");
}

async function loadNews() {
  const token = ++newsToken;
  const base = currentBase();
  $("news-tab-coin").textContent = `${base} news`;
  const reportTab = state.newsTab === "report";
  $("report").hidden = !reportTab;
  $("news-meta").hidden = reportTab;
  $("news-list").hidden = reportTab;
  if (reportTab) return loadReport(base, token);

  const coin = state.newsTab === "coin" ? (isStock(state.selected) ? state.selected : base) : "";
  const list = $("news-list");
  $("news-meta").textContent = "Loading headlines…";
  try {
    const data = await fetchNews(coin);
    if (token !== newsToken) return;
    const meta =
      `${data.items.length} headlines · updated ${new Date(data.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` +
      (data.failedSources?.length ? ` · unavailable: ${data.failedSources.join(", ")}` : "");
    $("news-meta").innerHTML = (coin ? moodHtml(moodOf(data.items)) : "") + `<div>${fmt.esc(meta)}</div>`;
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
    <section class="r-sec" id="r-mood"></section>
    <section class="r-sec" id="r-card"><h3>${fmt.esc(name)} report card</h3><div class="muted small">Loading ${stock ? "company" : "coin"} data…</div></section>`;

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
        <div class="muted tiny">Written by AI from ${s.count} recent headlines${s.generated ? ` at ${new Date(s.generated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}. It can be wrong. Check the sources. Not advice.</div>`;
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
  });
  $("center-live").addEventListener("click", () => centerLive());
  $("ema-toggle").addEventListener("click", toggleEma);
  $("price-alert-btn").addEventListener("click", () => openPriceAlert(state.selected));
  $("help-btn").addEventListener("click", () => ($("help").hidden = !$("help").hidden));
  initAlerts({
    getWatchlist: () => state.watchlist.slice(),
    getInfo: (sym) => state.bySymbol.get(sym),
    getSelected: () => state.selected,
    getPrice: (sym) => state.stats.get(sym)?.last,
    onPick: (sym) => { if (!state.watchlist.includes(sym)) addToWatchlist(sym); else selectSymbol(sym); window.scrollTo({ top: 0, behavior: "smooth" }); },
    onBadges: (b) => { state.badges = b; renderWatchlist(); },
  });
  initShortcuts();
  $("forecast-toggle").addEventListener("click", toggleForecast);

  // Center tabs: Scanner / My trades / Signal record / AI
  const showTab = (tab) => {
    store.set("centerTab", tab);
    document.querySelectorAll("#center-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    for (const t of ["scanner", "trades", "signals", "ai"]) $("tab-" + t).hidden = t !== tab;
    if (tab === "ai") $("ai-input").focus({ preventScroll: true });
  };
  document.querySelectorAll("#center-tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  showTab(store.get("centerTab", "scanner"));

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
  initAI({ getSettings: () => ({ balance: +store.get("balance", 0), riskPct: +store.get("riskPct", 1), feePct: +store.get("feePct", 0.02) }) });

  document.querySelectorAll("#intervals button").forEach((b) => {
    b.classList.toggle("on", b.dataset.i === state.interval);
    b.addEventListener("click", () => {
      state.interval = b.dataset.i;
      store.set("interval", state.interval);
      document.querySelectorAll("#intervals button").forEach((x) => x.classList.toggle("on", x === b));
      loadChart();
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
  if (!state.bySymbol.has(state.selected) && state.watchlist.length) state.selected = state.watchlist[0];

  refreshTickers();
  selectSymbol(state.selected);
  setInterval(() => document.visibilityState === "visible" && loadNews(), 180_000);
}

boot();
