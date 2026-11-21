// "Stock picks" tab: Entryvex Stock Rank (see picks-model.js) applied to ~100 large US companies,
// with the current top picks, the full ranking, and an honest month-by-month track record vs the
// S&P 500 (SPY, dividends included) and vs simply owning all the same stocks equally.
import { rankAt, backtest, verdict, alignMonthly, WEIGHTS, DEFAULTS } from "./picks-model.js";
import { registerStock } from "./market.js";
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);

// Large, well-known US companies across all sectors (fixed list).
export const UNIVERSE = [
  ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "NVIDIA"], ["AMZN", "Amazon"], ["GOOGL", "Alphabet"], ["META", "Meta Platforms"],
  ["BRK-B", "Berkshire Hathaway"], ["AVGO", "Broadcom"], ["TSLA", "Tesla"], ["JPM", "JPMorgan Chase"], ["LLY", "Eli Lilly"], ["V", "Visa"],
  ["UNH", "UnitedHealth"], ["XOM", "Exxon Mobil"], ["MA", "Mastercard"], ["JNJ", "Johnson & Johnson"], ["PG", "Procter & Gamble"], ["HD", "Home Depot"],
  ["COST", "Costco"], ["ABBV", "AbbVie"], ["WMT", "Walmart"], ["NFLX", "Netflix"], ["MRK", "Merck"], ["CVX", "Chevron"], ["KO", "Coca-Cola"],
  ["PEP", "PepsiCo"], ["BAC", "Bank of America"], ["ADBE", "Adobe"], ["CRM", "Salesforce"], ["AMD", "AMD"], ["TMO", "Thermo Fisher"],
  ["ORCL", "Oracle"], ["ACN", "Accenture"], ["MCD", "McDonald's"], ["CSCO", "Cisco"], ["ABT", "Abbott"], ["LIN", "Linde"], ["WFC", "Wells Fargo"],
  ["DHR", "Danaher"], ["TXN", "Texas Instruments"], ["QCOM", "Qualcomm"], ["INTU", "Intuit"], ["PM", "Philip Morris"], ["DIS", "Disney"],
  ["CAT", "Caterpillar"], ["VZ", "Verizon"], ["AMGN", "Amgen"], ["IBM", "IBM"], ["GE", "GE Aerospace"], ["NEE", "NextEra Energy"], ["PFE", "Pfizer"],
  ["CMCSA", "Comcast"], ["UNP", "Union Pacific"], ["LOW", "Lowe's"], ["SPGI", "S&P Global"], ["HON", "Honeywell"], ["RTX", "RTX"],
  ["AMAT", "Applied Materials"], ["GS", "Goldman Sachs"], ["UPS", "UPS"], ["BKNG", "Booking"], ["ISRG", "Intuitive Surgical"], ["T", "AT&T"],
  ["SBUX", "Starbucks"], ["NKE", "Nike"], ["MS", "Morgan Stanley"], ["PLD", "Prologis"], ["BLK", "BlackRock"], ["ELV", "Elevance Health"],
  ["MDT", "Medtronic"], ["DE", "Deere"], ["LMT", "Lockheed Martin"], ["AXP", "American Express"], ["SYK", "Stryker"], ["ADP", "ADP"],
  ["TJX", "TJX"], ["GILD", "Gilead"], ["MDLZ", "Mondelez"], ["CVS", "CVS Health"], ["CB", "Chubb"], ["VRTX", "Vertex"], ["REGN", "Regeneron"],
  ["ADI", "Analog Devices"], ["C", "Citigroup"], ["BMY", "Bristol Myers Squibb"], ["SCHW", "Charles Schwab"], ["LRCX", "Lam Research"],
  ["MU", "Micron"], ["SO", "Southern Co."], ["DUK", "Duke Energy"], ["BA", "Boeing"], ["MO", "Altria"], ["ZTS", "Zoetis"], ["CI", "Cigna"],
  ["CL", "Colgate-Palmolive"], ["EOG", "EOG Resources"], ["SLB", "SLB"], ["FDX", "FedEx"], ["EMR", "Emerson"], ["GD", "General Dynamics"], ["ITW", "Illinois Tool Works"],
];
const NAMES = Object.fromEntries(UNIVERSE);
const BENCH = "SPY";
const CACHE_KEY = "evx.picksData";
const CACHE_MS = 6 * 3600e3;

let hooks = { onPick: () => {} };
let state = { status: "idle", progress: 0, data: null, result: null, error: "", showAll: false };
let chart = null;

/* ---------- Data ---------- */
async function fetchMonthly(sym) {
  const res = await fetch(`/api/market?src=chart&symbol=${encodeURIComponent(sym)}&interval=1mo&range=20y`);
  if (!res.ok) throw new Error(sym + " " + res.status);
  const r = (await res.json())?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const adj = r?.indicators?.adjclose?.[0]?.adjclose || r?.indicators?.quote?.[0]?.close || [];
  const out = [];
  ts.forEach((t, i) => { if (adj[i] > 0) out.push({ month: new Date((t + 43200) * 1000).toISOString().slice(0, 7), close: +adj[i].toPrecision(8) }); });
  // Several bars can land in the same month (Yahoo adds today's quote): keep the latest.
  const byMonth = new Map(out.map((b) => [b.month, b]));
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

async function loadData(force) {
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c && Date.now() - c.t < CACHE_MS && c.bars && Object.keys(c.bars).length > 50) return c;
    } catch {}
  }
  const syms = [BENCH, ...UNIVERSE.map((u) => u[0])];
  const bars = {};
  let done = 0;
  const queue = syms.slice();
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try { const b = await fetchMonthly(s); if (b.length >= 14) bars[s] = b; } catch {}
      done++;
      state.progress = done / syms.length;
      if (done % 5 === 0) render();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  if (!bars[BENCH] || Object.keys(bars).length < 50) throw new Error("not enough data");
  const data = { t: Date.now(), bars };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
  return data;
}

function compute(data) {
  const { months, series } = alignMonthly(data.bars);
  const bench = series[BENCH];
  const stocks = Object.fromEntries(Object.entries(series).filter(([s]) => s !== BENCH));
  const thisMonth = new Date().toISOString().slice(0, 7);
  const partial = months.at(-1) === thisMonth;
  // Track record: complete months only. Current ranking: latest prices (this month so far).
  const full = partial ? months.length - 1 : months.length;
  const cut = (arr) => arr.slice(0, full);
  const bt = backtest(months.slice(0, full), Object.fromEntries(Object.entries(stocks).map(([s, a]) => [s, cut(a)])), cut(bench), {});
  const now = rankAt(stocks, months.length - 1);
  return { months, now, bt, v: verdict(bt.stats), asOf: data.t, partial, count: Object.keys(stocks).length };
}

/** Rank info for one stock symbol ("S:AAPL"), if Stock Rank covers it and has run. */
export function rankFor(sym) {
  const r = state.result;
  if (!r || !sym?.startsWith("S:")) return null;
  const row = r.now.find((x) => x.sym === sym.slice(2));
  if (!row) return null;
  return { rank: row.rank, of: r.now.length, top: row.rank <= DEFAULTS.top, momentum12_1: +(row.momentum * 100).toFixed(1), trendVs10MonthAvg: +(row.trend * 100).toFixed(1),
    volatility: +(row.volatility * 100).toFixed(1), modelRecord: summaryLine() };
}
/** One-line summary for the AI analyst. */
export function summaryLine() {
  const r = state.result;
  if (!r?.bt.stats) return null;
  const s = r.bt.stats;
  return `Stock Rank top ${DEFAULTS.top} (monthly, ${s.from}–${s.to}, after costs): ${pct(s.cagr.model)}/yr vs S&P 500 ${pct(s.cagr.bench)}/yr and same-stocks equal-weight ${pct(s.cagr.all)}/yr; verdict: ${r.v.label}. Current top: ${r.now.slice(0, DEFAULTS.top).map((x) => x.sym).join(", ")}.`;
}
export function picksSnapshot() {
  const r = state.result;
  if (!r) return null;
  return { verdict: r.v.label, record: summaryLine(), currentTop: r.now.slice(0, DEFAULTS.top).map((x) => ({ symbol: x.sym, name: NAMES[x.sym], rank: x.rank })) };
}

export async function run(force = false) {
  if (state.status === "loading") return;
  state.status = "loading"; state.progress = 0; state.error = "";
  render();
  try {
    state.data = await loadData(force);
    state.result = compute(state.data);
    state.status = "ready";
  } catch (e) {
    state.status = "error"; state.error = "Couldn't load enough price history right now. Try again in a minute.";
  }
  render();
}

/* ---------- UI ---------- */
const pct = (x, d = 1) => (isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%` : "—");
const cls = (x) => (x >= 0 ? "up" : "down");

export function initPicks(h) {
  hooks = { ...hooks, ...h };
  $("tab-picks").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.sym) {
      const sym = "S:" + b.dataset.sym;
      registerStock(sym, { name: NAMES[b.dataset.sym] || b.dataset.sym, exchange: "US", kind: "Stock" });
      hooks.onPick(sym);
    }
    if (b.id === "picks-refresh") run(true);
    if (b.id === "picks-all") { state.showAll = !state.showAll; render(); }
  });
  render();
}
export function picksVisible(on) { if (on && state.status === "idle") run(); }

function render() {
  const root = $("tab-picks");
  if (!root) return;
  if (state.status === "idle") { root.innerHTML = `<p class="muted small">Opening…</p>`; return; }
  if (state.status === "loading") {
    root.innerHTML = `<div class="picks-load"><span class="typing"><i></i><i></i><i></i></span> Loading up to 20 years of monthly prices for ${UNIVERSE.length} companies… ${Math.round(state.progress * 100)}%</div>`;
    return;
  }
  if (state.status === "error") { root.innerHTML = `<p class="muted small">${fmt.esc(state.error)}</p><button class="ghost-btn" id="picks-refresh">Try again</button>`; return; }
  const r = state.result, s = r.bt.stats;
  const top = r.now.slice(0, DEFAULTS.top);
  const list = state.showAll ? r.now : top;
  const asOf = new Date(r.asOf).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  root.innerHTML = `
    <div class="picks-intro">
      <p class="small"><strong>Entryvex Stock Rank</strong> scores ${r.count} large US companies every month on three measured factors:
        <strong>momentum</strong> (last 12 months, skipping the latest), <strong>trend</strong> (price vs its 10-month average) and <strong>steadiness</strong> (lower volatility scores higher).
        It holds the top ${DEFAULTS.top} for a month, then re-ranks. Built for <strong>long-term holders and swing traders</strong>, not day trading.</p>
    </div>

    <h3>Top ${DEFAULTS.top} right now <span class="muted small">· prices as of ${fmt.esc(asOf)}${r.partial ? " (this month so far)" : ""}</span></h3>
    <div class="picks-table" role="table">
      <div class="pk-row pk-head" role="row"><span>#</span><span>Company</span><span title="Return over the past 12 months, skipping the latest month">12-month momentum</span><span title="Price vs its 10-month average">Trend</span><span title="Yearly volatility: lower is steadier">Volatility</span><span title="Combined score (0 = average)">Score</span></div>
      ${list.map((x) => `<button class="pk-row ${x.rank <= DEFAULTS.top ? "pk-top" : ""}" data-sym="${fmt.esc(x.sym)}" role="row" title="Open ${fmt.esc(x.sym)}">
        <span class="mono">${x.rank}</span>
        <span><strong>${fmt.esc(x.sym)}</strong> <span class="muted small">${fmt.esc(NAMES[x.sym] || "")}</span></span>
        <span class="mono ${cls(x.momentum)}">${pct(x.momentum, 0)}</span>
        <span class="mono ${cls(x.trend)}">${pct(x.trend, 1)}</span>
        <span class="mono">${(x.volatility * 100).toFixed(0)}%</span>
        <span class="mono">${x.score >= 0 ? "+" : ""}${x.score.toFixed(2)}</span></button>`).join("")}
    </div>
    <button class="link-btn small" id="picks-all">${state.showAll ? "Show only the top " + DEFAULTS.top : `Show all ${r.now.length} ranked`}</button>

    <h3>Track record <span class="pill pill-${r.v.level}">${fmt.esc(r.v.label)}</span></h3>
    ${s ? `
    <div class="picks-stats">
      <div><span>Stock Rank top ${DEFAULTS.top}</span><strong class="${cls(s.cagr.model)}">${pct(s.cagr.model)}/yr</strong><small class="muted">worst fall ${pct(s.maxDD.model, 0)}</small></div>
      <div><span>S&amp;P 500 (SPY)</span><strong class="${cls(s.cagr.bench)}">${pct(s.cagr.bench)}/yr</strong><small class="muted">worst fall ${pct(s.maxDD.bench, 0)}</small></div>
      <div><span>All ${r.count} stocks, equal amounts</span><strong class="${cls(s.cagr.all)}">${pct(s.cagr.all)}/yr</strong><small class="muted">worst fall ${pct(s.maxDD.all, 0)}</small></div>
    </div>
    <div id="picks-chart" class="picks-chart"></div>
    <div class="picks-legend small"><span><i style="background:#2ee59d"></i>Stock Rank top ${DEFAULTS.top}</span><span><i style="background:#7aa2ff"></i>S&amp;P 500</span><span><i style="background:#9aa4b2"></i>All ${r.count} stocks equally</span><span class="muted">$1 invested, log scale</span></div>
    <ul class="picks-facts small">
      <li>Tested month by month from <strong>${fmt.esc(s.from)}</strong> to <strong>${fmt.esc(s.to)}</strong> (${s.n} months), including ${(DEFAULTS.costPerSide * 100).toFixed(1)}% trading cost per buy and sell. About ${Math.round(s.avgTurnover * DEFAULTS.top)} of the ${DEFAULTS.top} stocks change in a typical month.</li>
      <li>Beat the S&amp;P 500 in <strong>${Math.round(s.beatBench * 100)}%</strong> of months, and beat owning all ${r.count} stocks equally in <strong>${Math.round(s.beatAll * 100)}%</strong> of months.</li>
      <li>First half of the test: ${pct(s.firstHalf.model)}/yr vs ${pct(s.firstHalf.all)}/yr for all stocks. Second half: ${pct(s.secondHalf.model)}/yr vs ${pct(s.secondHalf.all)}/yr.</li>
      ${s.last12 ? `<li>Last 12 months: <strong class="${cls(s.last12.model)}">${pct(s.last12.model)}</strong> vs S&amp;P 500 ${pct(s.last12.bench)}.${s.last36 ? ` Last 3 years: ${pct(s.last36.model)} vs ${pct(s.last36.bench)}.` : ""}</li>` : ""}
      <li>Statistical strength of the lead over the same stocks: t = ${isFinite(s.tAll) ? s.tAll.toFixed(2) : "—"} (2 or more is solid evidence; under 1 is noise).</li>
    </ul>` : `<p class="muted small">Not enough history to test yet.</p>`}

    <details class="picks-honest"><summary>How to read this honestly</summary>
      <ul class="small">
        <li><strong>The fair comparison is "all ${r.count} stocks equally"</strong>, not the S&amp;P 500. The list is <em>today's</em> large companies, which all survived and grew. Any strategy picking from them looks better in the past than it would have in real time (survivorship bias). Beating that line is what shows the ranking itself adds something.</li>
        <li>The factor weights (momentum ${WEIGHTS.momentum}, trend ${WEIGHTS.trend}, volatility ${WEIGHTS.volatility}) were fixed before testing and never tuned to these results, so the record isn't curve-fitted.</li>
        <li>Momentum strategies can drop hard when markets suddenly reverse (for example 2009 and 2020). Expect losing months and years.</li>
        <li>This is research, not financial advice. Past results don't guarantee future returns.</li>
      </ul>
    </details>
    <p class="tiny muted">Monthly prices with dividends from Yahoo Finance. Updates every 6 hours. <button class="link-btn tiny" id="picks-refresh">Reload now</button></p>`;
  drawChart(r);
}

function drawChart(r) {
  const el = $("picks-chart");
  if (!el || !window.LightweightCharts || !r.bt.months.length) return;
  if (chart) { try { chart.remove(); } catch {} chart = null; }
  chart = window.LightweightCharts.createChart(el, {
    height: 220, layout: { background: { color: "transparent" }, textColor: "#9aa4b2" },
    grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
    rightPriceScale: { mode: 1, borderVisible: false }, timeScale: { borderVisible: false }, handleScroll: false, handleScale: false,
    crosshair: { mode: 0 },
  });
  const t = (m) => Math.floor(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 1) / 1000);
  const start = r.bt.months[0].month;
  const first = (k) => [{ time: t(start) - 30 * 86400, value: 1 }];   // $1 at the start
  const add = (color, key, width) => {
    const s = chart.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: true, priceFormat: { type: "custom", formatter: (v) => "$" + v.toFixed(2) } });
    s.setData(first().concat(r.bt.months.map((m) => ({ time: t(m.month), value: m[key] }))));
  };
  add("#9aa4b2", "eqAll", 1);
  add("#7aa2ff", "eqBench", 2);
  add("#2ee59d", "eqModel", 2);
  chart.timeScale().fitContent();
  new ResizeObserver(() => chart && chart.applyOptions({ width: el.clientWidth })).observe(el);
}
