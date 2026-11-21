// Long-term view: for people holding for months, not minutes.
// From up to ~10 years of daily candles it MEASURES what happened to anyone who bought on a random
// day and held ~3 months: how often they ended higher and the typical range of results, overall and
// in situations like today (above or below the 200-day average). Plus trend, recent returns, and how
// bumpy the ride is. For stocks, the latest quarterly earnings from SEC filings are added.
import { getKlineHistory, isStock } from "./market.js";
import { sma } from "./indicators.js";
import { getStockProfile } from "./research.js";
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
const cache = new Map();

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Pure calculation on daily candles (exported for tests). */
export function longTermStats(daily, stock) {
  const n = daily.length;
  if (n < 260) return null;
  const close = daily.map((k) => k.close);
  const time = daily.map((k) => k.time);
  const s200 = sma(close, 200), s50 = sma(close, 50);
  const last = close[n - 1];
  const H = stock ? 63 : 90;              // ~3 months: 63 trading days for stocks, 90 calendar days for crypto
  const perYear = stock ? 252 : 365;

  // Returns over calendar windows
  const ret = (days) => {
    const t0 = time[n - 1] - days * 86400;
    const i = time.findIndex((t) => t >= t0);
    return i >= 0 && i < n - 1 ? (last / close[i] - 1) * 100 : NaN;
  };

  // Hold-for-H outcomes for every past start day
  const all = [], same = [];
  const nowAbove = last > s200[n - 1];
  for (let t = 200; t + H < n; t++) {
    const r = close[t + H] / close[t] - 1;
    all.push(r);
    if ((close[t] > s200[t]) === nowAbove) same.push(r);
  }
  const summarize = (arr) => {
    if (arr.length < 50) return null;
    const s = [...arr].sort((a, b) => a - b);
    return { n: arr.length, pUp: arr.filter((x) => x > 0).length / arr.length, p10: quantile(s, 0.1), median: quantile(s, 0.5), p90: quantile(s, 0.9) };
  };

  // Volatility: annualized from daily log returns over the last year
  const lr = [];
  for (let i = Math.max(1, n - perYear); i < n; i++) lr.push(Math.log(close[i] / close[i - 1]));
  const m = lr.reduce((a, b) => a + b, 0) / lr.length;
  const vol = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1)) * Math.sqrt(perYear) * 100;

  const yearHigh = Math.max(...close.slice(-perYear));
  // A "bad day": the 5th-percentile daily move over the last year (1 day in 20 was this bad or worse).
  const dailyMoves = [];
  for (let i = Math.max(1, n - perYear); i < n; i++) dailyMoves.push(close[i] / close[i - 1] - 1);
  const badDay = quantile([...dailyMoves].sort((a, b) => a - b), 0.05);
  return {
    last, above200: nowAbove, s200: s200[n - 1], s50: s50[n - 1], golden: s50[n - 1] > s200[n - 1],
    r1m: ret(30), r3m: ret(91), r6m: ret(182), r1y: ret(365),
    fromHigh: (last / yearHigh - 1) * 100, vol, H, badDay, years: (time[n - 1] - time[200]) / (365 * 86400),
    hold: summarize(all), holdSame: summarize(same),
  };
}

/** Long-term stats already loaded for a symbol (or null). */
export function cachedLongTerm(sym) { return cache.get(sym)?.lt ?? null; }
export function cachedFundamentals(sym) { return cache.get(sym)?.fundamentals ?? null; }

export async function renderLongTerm(c) {
  const el = $("longterm");
  if (!el || !c?.symbol) return;
  const key = c.symbol;
  const sym = c.symbol, stock = isStock(sym);
  el.innerHTML = `<div class="lt-card"><div class="d-when-title">Long-term view (holding for months)</div><div class="muted small">Measuring years of daily data…</div></div>`;
  try {
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.t > 30 * 60_000) {
      const daily = await getKlineHistory(sym, "1d", 3000);
      const lt = longTermStats(daily, stock);
      let fundamentals = null;
      if (stock) {
        try {
          const p = await getStockProfile(c.base, null);
          fundamentals = p.lines.filter((l) => /^Latest quarter|^Company value|^Last 12 months/.test(l.k));
        } catch {}
      }
      hit = { t: Date.now(), lt, fundamentals };
      cache.set(key, hit);
    }
    if (c.symbol !== sym) return;
    el.innerHTML = html(c, hit.lt, hit.fundamentals, stock);
    c.onLoaded?.();
  } catch (e) {
    el.innerHTML = `<div class="lt-card"><div class="d-when-title">Long-term view</div><div class="muted small">Couldn't load long-term data right now.</div></div>`;
  }
}

function html(c, lt, fundamentals, stock) {
  if (!lt) return `<div class="lt-card"><div class="d-when-title">Long-term view (holding for months)</div><p class="small muted">Not enough history yet (needs more than a year of daily data).</p></div>`;
  const p = (v) => (isFinite(v) ? `<strong class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</strong>` : "—");
  const months = stock ? "3 months (63 trading days)" : "3 months (90 days)";
  const trend = lt.above200 && lt.golden ? { label: "Healthy uptrend", cls: "up", text: "Price is above its 200-day average, and the 50-day average is above the 200-day: the long-term trend is up." }
    : !lt.above200 && !lt.golden ? { label: "Downtrend", cls: "down", text: "Price is below its 200-day average, and the 50-day average is below the 200-day: the long-term trend is down. Long-term buyers often wait for it to turn." }
    : { label: "Mixed / turning", cls: "", text: `Price is ${lt.above200 ? "above" : "below"} its 200-day average, but the 50-day average is ${lt.golden ? "above" : "below"} the 200-day: the trend may be changing.` };
  const h = lt.hold, hs = lt.holdSame;
  const pctR = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;
  return `<div class="lt-card">
    <div class="lt-head"><div class="d-when-title">Long-term view (holding for months)</div><span class="pill ${trend.cls === "up" ? "pill-edge" : trend.cls === "down" ? "pill-negative" : "pill-thin"}">${trend.label}</span></div>
    <p class="small">${trend.text}</p>
    ${h ? `<div class="lt-hold">
      <div><span>Bought on any day and held ${months}</span><strong>${Math.round(h.pUp * 100)}% ended higher</strong>
        <small class="muted">typical result ${pctR(h.p10)} to ${pctR(h.p90)} (middle ${pctR(h.median)}) · ${h.n.toLocaleString()} past cases, ~${lt.years.toFixed(0)} years</small></div>
      ${hs ? `<div><span>…when the trend looked like now (${lt.above200 ? "above" : "below"} the 200-day)</span><strong>${Math.round(hs.pUp * 100)}% ended higher</strong>
        <small class="muted">typical result ${pctR(hs.p10)} to ${pctR(hs.p90)} (middle ${pctR(hs.median)}) · ${hs.n.toLocaleString()} cases</small></div>` : ""}
    </div>` : ""}
    <div class="lt-grid">
      <div><span>1 month</span>${p(lt.r1m)}</div><div><span>3 months</span>${p(lt.r3m)}</div>
      <div><span>6 months</span>${p(lt.r6m)}</div><div><span>1 year</span>${p(lt.r1y)}</div>
      <div><span>From 1-year high</span>${p(lt.fromHigh)}</div>
      <div title="How much the price typically swings in a year (annualized volatility)"><span>Yearly swing</span><strong>±${lt.vol.toFixed(0)}%</strong></div>
    </div>
    ${fundamentals?.length ? `<dl class="rc lt-fund">${fundamentals.map((l) => `<div><dt>${l.k}</dt><dd>${l.t}</dd></div>`).join("")}</dl>` : ""}
    <p class="tiny muted">These are measured from this ${stock ? "stock's" : "coin's"} own history, not a prediction. Past results don't guarantee the future; a ±${lt.vol.toFixed(0)}% yearly swing means large drops along the way are normal.</p>
  </div>`;
}
