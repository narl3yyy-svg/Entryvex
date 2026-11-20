import { getSymbols, get24h, getKlines, Stream, klineFromStream } from "./binance.js";
import { COINS, coinName, DEFAULT_WATCHLIST } from "./coins.js";
import * as fmt from "./format.js";
import { createScanner } from "./scanner.js";

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
  newsTab: "coin",
  status: { ticker: "connecting", kline: "connecting" },
};

let tickerStream = null;
let klineStream = null;
let chart, candles, volume, scanner;
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
      <span class="wl-base">${fmt.esc(base)}<span class="muted small"> / ${fmt.esc(info?.quote ?? "")}</span></span>
      <span class="wl-price" data-f="price">—</span>
      <span class="wl-name">${fmt.esc(coinName(base))}</span>
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
  tickerStream = new Stream(
    state.watchlist.map((s) => s.toLowerCase() + "@miniTicker"),
    {
      onStatus: (s) => setStatus("ticker", s),
      onMessage: (_stream, d) => {
        const prev = state.stats.get(d.s);
        const open = +d.o, last = +d.c;
        state.stats.set(d.s, {
          symbol: d.s, last, open, high: +d.h, low: +d.l, quoteVolume: +d.q,
          changePct: open ? ((last - open) / open) * 100 : 0,
        });
        paintRow(d.s, prev?.last);
        if (d.s === state.selected) paintHeader();
      },
    }
  );
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
  searchIdx = 0;
  box.innerHTML = searchHits.length
    ? searchHits.map((s, i) => `<button data-i="${i}" class="${i === 0 ? "active" : ""}">
        <span><strong>${fmt.esc(s.base)}</strong> <span class="muted">/ ${fmt.esc(s.quote)}</span></span>
        <span class="muted small">${fmt.esc(coinName(s.base))}${state.watchlist.includes(s.symbol) ? " · added" : ""}</span></button>`).join("")
    : `<div class="empty">No Binance.US pair matches “${fmt.esc(q)}”.</div>`;
  box.hidden = false;
}
function pickSearch(i) {
  const s = searchHits[i];
  if (!s) return;
  $("search").value = "";
  $("search-results").hidden = true;
  addToWatchlist(s.symbol);
}

/* ---------- Header ---------- */
function paintHeader() {
  const sym = state.selected;
  const info = state.bySymbol.get(sym);
  const s = state.stats.get(sym);
  const base = info?.base ?? sym;
  $("sym-name").textContent = coinName(base);
  $("sym-pair").textContent = info ? `${info.base}/${info.quote}` : sym;
  const last = s?.last ?? lastCandle?.close;
  $("sym-price").textContent = fmt.price(last);
  const chg = $("sym-change");
  chg.textContent = s ? fmt.pct(s.changePct) + " 24h" : "—";
  chg.className = "chip mono " + (s ? (s.changePct >= 0 ? "up" : "down") : "");
  $("sym-high").textContent = fmt.price(s?.high);
  $("sym-low").textContent = fmt.price(s?.low);
  $("sym-vol").textContent = s ? "$" + fmt.compact(s.quoteVolume) : "—";
  if (last) document.title = `${fmt.price(last)} ${base} · Entryvex`;
}

/* ---------- Chart ---------- */
function initChart() {
  const el = $("chart");
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: "#8a94a6", fontFamily: "Inter, system-ui, sans-serif" },
    grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
    rightPriceScale: { borderColor: "#232a35" },
    timeScale: { borderColor: "#232a35", timeVisible: true, secondsVisible: false, shiftVisibleRangeOnNewBar: true },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { priceFormatter: (p) => fmt.price(p) },
  });
  candles = chart.addCandlestickSeries({
    upColor: "#22c55e", downColor: "#f0506e", borderVisible: false,
    wickUpColor: "#22c55e", wickDownColor: "#f0506e",
  });
  volume = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
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
  chartMessage("Loading chart…");
  try {
    const data = await getKlines(sym, interval, 500);
    if (token !== klineLoadToken) return;
    const prec = fmt.precisionFor(data.at(-1)?.close ?? 1);
    candles.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 1 / 10 ** prec } });
    candles.setData(data);
    volume.setData(data.map(volBar));
    lastCandle = data.at(-1) ?? null;
    centerLive(data.length);
    chartMessage("");
    paintHeader();
    scanner.analyzeSymbol(sym, interval);
  } catch (e) {
    console.warn(e);
    chartMessage("Couldn't load chart data from Binance.US. Retrying…");
    setTimeout(() => token === klineLoadToken && loadChart(), 5000);
    return;
  }

  klineStream = new Stream([`${sym.toLowerCase()}@kline_${interval}`], {
    onStatus: (s) => setStatus("kline", s),
    onMessage: (_stream, d) => {
      if (token !== klineLoadToken) return;
      const c = klineFromStream(d);
      if (lastCandle && c.time < lastCandle.time) return;
      candles.update(c);
      volume.update(volBar(c));
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
async function loadNews() {
  const token = ++newsToken;
  const base = state.bySymbol.get(state.selected)?.base ?? state.selected.replace(/(USDT|USDC|USD)$/, "");
  $("news-tab-coin").textContent = base;
  const coin = state.newsTab === "coin" ? base : "";
  const list = $("news-list");
  $("news-meta").textContent = "Loading headlines…";
  try {
    const res = await fetch(`/api/news${coin ? "?coin=" + encodeURIComponent(coin) : ""}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (token !== newsToken) return;
    $("news-meta").textContent =
      `${data.items.length} headlines · updated ${new Date(data.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` +
      (data.failedSources?.length ? ` · unavailable: ${data.failedSources.join(", ")}` : "");
    list.innerHTML = data.items.length
      ? data.items.map((it) => `<li><a href="${fmt.esc(it.link)}" target="_blank" rel="noopener noreferrer">
          <div class="news-title">${fmt.esc(it.title)}</div>
          <div class="news-sub"><span>${fmt.esc(it.source)}</span><span>·</span><span>${fmt.ago(it.published)}</span>
            ${(it.coins || []).slice(0, 4).map((c) => `<span class="tag">${fmt.esc(c)}</span>`).join("")}</div></a></li>`).join("")
      : `<li class="news-empty">No recent headlines for ${fmt.esc(coinName(base))}.</li>`;
  } catch (e) {
    if (token !== newsToken) return;
    $("news-meta").textContent = "";
    list.innerHTML = `<li class="news-empty">News is unavailable right now. (The news service runs on the hosted site. If you opened the file directly, run the local dev server instead.)</li>`;
  }
}

/* ---------- Boot ---------- */
async function boot() {
  tickClock();
  setInterval(tickClock, 1000);
  initChart();
  scanner = createScanner({
    chartSeries: candles,
    getWatchlist: () => state.watchlist.slice(),
    getBase: () => state.bySymbol.get(state.selected)?.base ?? state.selected,
    onPickSymbol: (sym) => { selectSymbol(sym); window.scrollTo({ top: 0, behavior: "smooth" }); },
    // Zoom out to show all past trades on the chart; zoom back to the live candle when hidden.
    onShowTrades: (showing) => (showing ? chart.timeScale().fitContent() : centerLive()),
  });
  $("center-live").addEventListener("click", () => centerLive());

  document.querySelectorAll("#intervals button").forEach((b) => {
    b.classList.toggle("on", b.dataset.i === state.interval);
    b.addEventListener("click", () => {
      state.interval = b.dataset.i;
      store.set("interval", state.interval);
      document.querySelectorAll("#intervals button").forEach((x) => x.classList.toggle("on", x === b));
      loadChart();
    });
  });
  document.querySelectorAll("#news-tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      state.newsTab = b.dataset.tab;
      document.querySelectorAll("#news-tabs button").forEach((x) => x.classList.toggle("on", x === b));
      loadNews();
    });
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

  try {
    state.allSymbols = await getSymbols();
    for (const s of state.allSymbols) state.bySymbol.set(s.symbol, s);
    // Drop pairs that no longer trade.
    state.watchlist = state.watchlist.filter((s) => state.bySymbol.has(s));
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
