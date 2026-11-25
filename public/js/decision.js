// "Entryvex says": one plain answer for the coin/stock on screen.
//   - Already own it?  -> HOLD or SELL NOW, with the exact sell prices and a sell-by time.
//   - Otherwise        -> BUY / DON'T BUY / WAIT. BUY comes only from the trend rule on daily candles (engine.js).
// Five outside checks (bigger trend, overall market, fear gauge, news mood, forecast odds) are shown
// as tailwinds/headwinds. They're context only: they are not part of the measured win rate.
import { getKlineHistory, get24h, isStock, stockInfo } from "./market.js";
import { ema } from "./indicators.js";
import { sizePosition } from "./sizing.js";
import { settings, guard, practiceButton } from "./money.js";
import { openTrades, tradeAdvice } from "./journal.js";
import { RULES } from "./engine.js";
import * as fmt from "./format.js";
import { fxRate, money as fxMoney } from "./fx.js";
import { currentBuys, topWatch } from "./opportunities.js";
import { describeOdds, reliability } from "./forecast.js";
import { upcomingHighImpact, loadCalendar } from "./calendar.js";
import { earningsCheck } from "./earnings.js";
import { newsAiCheck } from "./newsai.js";
import { trendingCheck } from "./trending.js";
import { botViewCached } from "./bot.js";
import { holdingOf } from "./holdings.js";
import { scoreLine, scoreFor, walkLine } from "./scorecard.js";

/** Scheduled high-impact economic events soon (central banks, inflation, jobs…) mean sudden swings. */
async function eventRisk() {
  await loadCalendar().catch(() => {});
  const soon = upcomingHighImpact(3);
  if (!soon.length) return { label: "Economic calendar", effect: 0, text: "No high-impact economic events in the next 3 hours." };
  const e = soon[0];
  const mins = Math.round((e.t - Date.now()) / 60e3);
  const when = mins <= 0 ? "happening now" : mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h ${mins % 60} min`;
  return {
    label: "Economic calendar", effect: -1,
    text: `${e.country} ${e.title} ${when}${soon.length > 1 ? ` (+${soon.length - 1} more high-impact)` : ""}. Expect sudden swings; many traders wait until 30 minutes after.`,
  };
}

const $ = (id) => document.getElementById(id);
const HIGHER = { "1m": "15m", "5m": "1h", "15m": "4h", "1h": "1d", "4h": "1d", "1d": "1d" };
const IV_WORD = { "1m": "1-minute", "5m": "5-minute", "15m": "15-minute", "1h": "1-hour", "4h": "4-hour", "1d": "daily", "1w": "weekly" };
const SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
const ctxCache = new Map();

/* ---------------- Outside checks ---------------- */
async function bigTrend(sym, interval) {
  const hi = HIGHER[interval];
  const c = await getKlineHistory(sym, hi, 300);
  if (c.length < 60) return null;
  const closes = c.map((k) => k.close);
  const e = ema(closes, 50);
  const last = closes.at(-1), e50 = e.at(-1), e50ago = e.at(-6);
  const up = last > e50 && e50 > e50ago, down = last < e50 && e50 < e50ago;
  return {
    label: `Bigger trend (${hi} candles)`,
    effect: up ? 1 : down ? -1 : 0,
    text: up ? "Uptrend: price is above its rising 50-candle average." : down ? "Downtrend: price is below its falling 50-candle average. Buying into a downtrend is riskier." : "Sideways: no clear direction on the bigger picture.",
  };
}

export async function marketBackdrop(stock) {
  const ref = stock ? "S:SPY" : "BTCUSDT";
  const [q] = await get24h([ref]);
  if (!q) return null;
  const ch = q.changePct;
  const name = stock ? "S&P 500 (SPY)" : "Bitcoin";
  return {
    label: stock ? "Overall stock market" : "Overall crypto market",
    effect: ch > 0.5 ? 1 : ch < -1 ? -1 : 0,
    text: `${name} is ${ch >= 0 ? "up" : "down"} ${Math.abs(ch).toFixed(1)}% ${stock ? "today" : "in 24h"}. ${ch < -1 ? "When the whole market falls, most things fall with it." : ch > 0.5 ? "A rising market helps most trades." : "The market is fairly calm."}`,
  };
}

export async function fearGauge(stock) {
  if (stock) {
    const res = await fetch("/api/market?src=chart&symbol=%5EVIX&interval=1d&range=5d");
    const v = (await res.json())?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!v) return null;
    return {
      label: "Stock market fear (VIX)",
      effect: v < 20 ? 1 : v > 30 ? -1 : 0,
      text: `VIX is ${v.toFixed(1)}: ${v < 20 ? "calm markets" : v <= 30 ? "investors are nervous" : "high fear; prices are swinging a lot, so stops get hit more often"}.`,
    };
  }
  const res = await fetch("https://api.alternative.me/fng/?limit=1");
  const d = (await res.json())?.data?.[0];
  if (!d) return null;
  const v = +d.value;
  return {
    label: "Crypto Fear & Greed index",
    effect: v >= 45 && v <= 75 ? 1 : v < 25 ? -1 : 0,
    text: `${v}/100, "${d.value_classification}". ${v < 25 ? "Extreme fear: sharp drops are common, though bounces can be big too." : v > 75 ? "Extreme greed: rallies often stall when everyone is already in." : "A normal range."}`,
  };
}

async function newsMood(sym, base, name) {
  const qs = isStock(sym) ? `stock=${encodeURIComponent(base)}&name=${encodeURIComponent(name)}` : `coin=${encodeURIComponent(base)}`;
  const d = await (await fetch(`/api/news?${qs}`)).json();
  const since = Date.now() - 24 * 3600e3;
  const recent = d.items.filter((i) => i.mood && (!i.published || i.published >= since));
  if (!recent.length) return { label: "News mood (24h)", effect: 0, text: "Hardly any news in the last day." };
  const pos = recent.filter((i) => i.mood.label === "positive").length, neg = recent.filter((i) => i.mood.label === "negative").length;
  const avg = recent.reduce((s, i) => s + i.mood.score, 0) / recent.length;
  return {
    label: "News mood (24h)",
    effect: avg > 0.15 ? 1 : avg < -0.15 ? -1 : 0,
    text: `${pos} positive vs ${neg} negative headlines out of ${recent.length}.`,
  };
}

function forecastOdds(f, sym, iv) {
  if (!f) return null;
  const p = f.pUp;
  // The scorecard checks this lean against what really happened. Where it has been no better than a
  // coin flip on this market, it's shown but not counted for or against a trade.
  const sc = scoreFor(sym, iv);
  const weak = sc && sc.called >= 20 && sc.dir < 55;
  return {
    label: "Measured odds of being higher",
    effect: weak ? 0 : p >= 0.55 ? 1 : p <= 0.45 ? -1 : 0,
    text: `${Math.round(p * 100)}% of the time, price was higher ${f.H} candles later${Math.abs(p - 0.5) < 0.03 ? " (basically a coin flip)" : ""}.`
      + (weak ? ` Not counted: on this market the lean has been right only ${sc.dir}% of the time (${sc.live ? "live" : "past-data"} scorecard).` : sc && sc.called >= 20 ? ` Its lean has been right ${sc.dir}% of the time here.` : ""),
  };
}

async function outsideChecks(c) {
  const key = `${c.symbol}:${c.interval}`;
  const hit = ctxCache.get(key);
  if (hit && Date.now() - hit.t < 120_000) return hit.v;
  const stock = isStock(c.symbol);
  const results = await Promise.allSettled([bigTrend(c.symbol, c.interval), marketBackdrop(stock), fearGauge(stock), newsMood(c.symbol, c.base, c.name), eventRisk(), stock ? earningsCheck(c.symbol) : null, newsAiCheck(c.symbol, c.name), stock ? null : trendingCheck(c.base)]);
  const v = results.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean);
  ctxCache.set(key, { t: Date.now(), v });
  return v;
}

/** Outside checks already loaded for a market (for the AI analyst). */
export function getChecks(sym, interval) { return ctxCache.get(`${sym}:${interval}`)?.v || null; }

/* ---------------- Render ---------------- */
let token = 0;
export async function renderDecision(c) {
  const el = $("decision");
  if (!el || !c || !c.symbol) return;
  const my = ++token;
  el.innerHTML = html(c, null);
  paintSimple(c);
  const checks = await outsideChecks(c).catch(() => []);
  if (my !== token) return;
  el.innerHTML = html(c, checks);
}

/** Cheap re-render for price ticks (uses cached outside checks). */
export function refreshDecision(c) {
  const el = $("decision");
  if (!el || !c || !c.symbol) return;
  const hit = ctxCache.get(`${c.symbol}:${c.interval}`);
  el.innerHTML = html(c, hit ? hit.v : null);
  paintSimple(c);
}
function paintSimple(c) { const s = $("simple-card"); if (s) s.innerHTML = simpleHtml(c); }

function html(c, checks) {
  const r = c.analysis;
  const stock = isStock(c.symbol);
  const unit = stock ? "shares" : c.base;
  const held = openTrades().filter((t) => t.symbol === c.symbol);
  const f = c.forecast;
  const all = checks ? [...checks, forecastOdds(f, c.symbol, f?.interval || c.interval)].filter(Boolean) : null;
  const tail = all ? all.filter((x) => x.effect > 0).length : 0;
  const head = all ? all.filter((x) => x.effect < 0).length : 0;

  let verdict, cls, headline, steps = "", meter = "";

  if (held.length) {
    // You own it: the only question is hold or sell.
    const t = held[0];
    const adv = tradeAdvice(t, c.price);
    verdict = adv.action; cls = adv.level === "sell" ? "sell" : "hold";
    const pnl = c.price ? (c.price - t.entry) * t.qty - t.fee * (t.entry * t.qty + c.price * t.qty) : null;
    headline = `${t.practice ? "🎮 Practice trade (pretend money): " : ""}You own ${+t.qty.toFixed(8)} ${unit}${pnl != null ? `, now <strong class="${pnl >= 0 ? "up" : "down"}">${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}</strong> after fees` : ""}. ${adv.why}`;
  } else if (!r) {
    verdict = "CHECKING…"; cls = "wait"; headline = "Testing this market's setups against its history…";
  } else if (r.liquidity && !r.liquidity.ok) {
    verdict = "DON'T BUY"; cls = "no";
    headline = `<strong>${fmt.esc(c.base)} barely trades here.</strong> ${fmt.esc(r.liquidity.reason)}`;
    steps = `<ol class="d-steps"><li>Switch to a bigger candle size (1h or 4h) or a busier market like BTC, ETH or a stock.</li>
      <li>Or check <button class="link-btn" data-goto-opps>Opportunities</button> for markets that trade well and have a buy signal.</li></ol>`;
  } else if (guard().locked) {
    verdict = "STOP FOR TODAY"; cls = "no";
    headline = "You've reached your daily loss limit. The best trade right now is no trade. Entryvex resets tomorrow.";
  } else {
    const best = r.best;
    // The scanner shows both "weak edge" and "too few examples" in yellow; only a weak edge is a (small) buy.
    let lvl = r.overall.level;
    if (lvl === "caution" && best?.verdict.level !== "weak") lvl = "thin";
    if (lvl === "go" || lvl === "caution") {
      verdict = lvl === "go" ? "BUY" : "SMALL BUY OR SKIP";
      cls = lvl === "go" ? "buy" : "caution";
      const s = best.stats;
      if (best.trend) {
        headline = `<strong>Trend breakout:</strong> ${fmt.esc(c.base)} is in an uptrend and a day just closed at a new 20-day high. That's Entryvex's trend rule: on data it never saw it made money after fees, with worst drops about half as deep as just holding. ${trendRecord(c, s)}`;
      } else {
        const what = best.model
          ? `<strong>The Entryvex model</strong> is confident this trade works right now${lvl === "go" ? "," : "."}`
          : `<strong>${fmt.esc(best.name)}</strong> just appeared${lvl === "go" ? "," : "."}`;
        headline = lvl === "go"
          ? `${what} and on this ${stock ? "stock" : "coin"} it has ended in profit <strong>${Math.round(s.winRate * s.n)} of ${s.n}</strong> times after costs.`
          : `${what} It has been only slightly profitable here (${Math.round(s.winRate * 100)}% of ${s.n} times), so it's not a strong signal. Use a smaller amount or skip it.`;
      }
      if (head >= 3) headline += ` <span class="down">Careful: ${head} of ${all.length} outside checks are against it right now.</span>`;
      if (stock && c.marketOpen === false) headline += ` <span class="muted">The market is closed: you can only place this when it opens${stockInfo(c.symbol).currency === "USD" ? " (9:30am New York time)" : ""}, so re-check then.</span>`;
      if (!best.trend) meter = confidenceMeter(s.winRate, s.winLo, s.winHi, s.breakeven, s.n);
      const tested = best.trend ? walkLine(c.interval) : "";
      steps = (tested ? `<p class="small d-tested">${tested}</p>` : "") + buySteps(c, r, unit);
    } else {
      cls = lvl === "wait" ? "wait" : "no";
      verdict = lvl === "wait" ? "WAIT · DON'T BUY YET" : "DON'T BUY";
      headline = r.overall.shortChart
        ? `<strong>Short charts don't give BUY signals.</strong> On candles shorter than a day, Entryvex's buy signals lost money after fees when tested on data they never saw, no better than buying at random moments. Check the daily chart for ${fmt.esc(c.base)}. <button class="link-btn" data-goto-iv="1d">Show the daily chart</button>`
        : lvl === "wait" && r.long
        ? (r.upNow && isFinite(r.overall.trigger)
          ? (c.price > r.overall.trigger
            ? `${fmt.esc(c.base)} is in an uptrend and trading <strong>above its 20-day high (${fmt.price(r.overall.trigger)})</strong> right now. If today's candle closes above it, Entryvex says <strong>BUY</strong> after the close.`
            : `${fmt.esc(c.base)} is in an uptrend, but hasn't made a new 20-day high yet. Entryvex says <strong>BUY when a day closes above ${fmt.price(r.overall.trigger)}</strong> <span class="muted">(${fmtAway(r.overall.trigger, c.price)} from now)</span>.`)
          : `<strong>No uptrend on ${fmt.esc(c.base)}'s daily chart</strong> (price isn't above its 200-day average with the 50-day above it). The trend rule waits for one, so there's no reason to buy now.`)
        : lvl === "wait"
        ? `None of the setups Entryvex trusts is happening on ${c.base} right now, so there's no good reason to buy at this moment.`
        : lvl === "no" && best?.verdict.level === "flat"
          ? `A setup is active, but on ${c.base} it has only <strong>broken even</strong> after costs (${fmt.pct(best.stats.ev * 100)} per trade, too small to be more than luck). Skip it.`
          : lvl === "no"
          ? `A setup is active, but on ${c.base} it has <strong>lost money</strong> after costs in the past (${Math.round(best.stats.winRate * 100)}% wins, ${fmt.pct(best.stats.ev * 100)} per trade). Skip it.`
          : `A setup is active, but it has only happened ${best?.stats.n ?? 0} times here, too few to know if it works. Skip it.`;
      const elsewhere = currentBuys().filter((b) => b.sym !== c.symbol);
      if (elsewhere.length) headline += ` <span class="d-elsewhere">Elsewhere right now: ${elsewhere.slice(0, 3).map((b) => `<button class="link-btn" data-goto-opps>${fmt.esc(b.label === "GO" ? "BUY" : "small buy")} on ${fmt.esc(b.base)} (${b.iv})</button>`).join(", ")}.</span>`;
      // The forecast has its own box right below, so it isn't repeated here.
      const bigMove = c.move && c.move.percentile >= 0.8;
      steps = regimeNote(c, r) + patternNote(c, r) + (bigMove ? moveNote(c) : "") + whenToBuy(c, r) + `
        <div class="d-actions"><span><strong>Do nothing for now.</strong> Entryvex re-checks after every ${r.long ? "daily close" : `${c.interval} candle`}.</span>
          <button class="ghost-btn" data-open-alerts>🔔 Alert me when a BUY appears</button>
          ${r.long ? "" : `<button class="ghost-btn" data-goto-iv="1d">Show the daily chart</button>`}
          <button class="ghost-btn" data-scan-all>Scan watchlist</button></div>`;
    }
  }

  const checksHtml = all == null
    ? `<div class="muted small">Checking the bigger trend, the overall market, fear levels and news…</div>`
    : `<div class="d-checks">${all.map((x) => `<div class="d-check eff-${x.effect > 0 ? "pos" : x.effect < 0 ? "neg" : "neu"}">
          <span class="d-ico">${x.effect > 0 ? "▲" : x.effect < 0 ? "▼" : "•"}</span>
          <span><strong>${fmt.esc(x.label)}</strong> ${fmt.esc(x.text)}</span></div>`).join("")}</div>
       <p class="tiny muted">${tail} helping · ${head} against · ${all.length - tail - head} neutral. These checks add context from outside sources; they are <em>not</em> part of the measured win rate, because there isn't enough history to prove how much they help.</p>`;

  // A buy on this market at another candle size (the watchlist checks 1h, 4h and daily too).
  const otherIv = !held.length && cls !== "buy" && cls !== "caution" ? currentBuys().find((b) => b.sym === c.symbol && b.iv !== c.interval) : null;
  const otherBanner = otherIv ? `<div class="d-other-iv"><span>📈 <strong>${otherIv.label === "GO" ? "BUY" : "SMALL BUY"} on ${fmt.esc(IV_WORD[otherIv.iv] || otherIv.iv)} candles</strong> right now (${fmt.esc(otherIv.setup)}). This card is about the ${fmt.esc(IV_WORD[c.interval] || c.interval)} chart on screen.</span>
      <button class="btn" data-goto-iv="${fmt.esc(otherIv.iv)}">Show the ${fmt.esc(IV_WORD[otherIv.iv] || otherIv.iv)} buy</button></div>` : "";
  return `<div class="d-card d-${cls}">${otherBanner}
    <div class="d-top">
      <div class="d-verdict"><span class="d-label">Entryvex says</span><strong>${verdict}</strong></div>
      <div class="d-headline">${headline}</div>
    </div>
    ${meter}
    ${steps}
    <details class="d-more" ${held.length ? "" : ""}><summary>Why? Outside checks (${all ? `${tail} for · ${head} against` : "loading"})</summary>${checksHtml}</details>
  </div>`;
}

/** "When would Entryvex say BUY?": the trend rule's price trigger on the daily chart. */
function whenToBuy(c, r) {
  const head = `<div class="d-when"><div class="d-when-title">When would Entryvex say BUY?</div>`;
  if (r.overall.shortChart) return `${head}<p class="small">Only on the <strong>daily chart</strong>: when a market in an uptrend closes at a new 20-day high. <button class="link-btn" data-goto-iv="1d">Show ${fmt.esc(c.base)} on daily candles</button></p></div>`;
  const t = (r.triggers || []).find((x) => x.id === "trend");
  const alt = topWatch(3).filter((w) => w.sym !== c.symbol);
  const others = alt.length ? `<p class="small">Closest to a BUY in your watchlist: ${alt.map((w) => `<button class="link-btn" data-goto-opps>${fmt.esc(w.base)} above ${fmt.price(w.level)}</button> <span class="muted">(${w.away >= 0 ? "+" : ""}${w.away.toFixed(1)}%)</span>`).join(" · ")}</p>` : "";
  if (!t) return `${head}<p class="small">Not enough daily history yet to check for a trend.</p>${others}</div>`;
  const fill = t.text.replace("{L}", t.level != null ? `<strong>${fmt.price(t.level)}</strong> <span class="muted">(${t.away >= 0 ? "+" : ""}${t.away.toFixed(1)}% from now)</span>` : "");
  return `${head}
    <ul class="d-trig"><li class="${t.ready ? "" : "muted"}"><span class="pill pill-edge">Tested rule</span> <strong>Trend breakout:</strong> ${t.ready ? "BUY if " + fill : "Not possible yet: " + fill}.
      <span class="muted small">${fmt.esc(t.setup.verdict.why)}</span></li></ul>
    ${others}
    <p class="tiny muted">Entryvex re-checks after every daily close and switches to BUY (with the full plan) the moment it happens.</p>
  </div>`;
}
const fmtAway = (level, price) => { const a = ((level - price) / price) * 100; return `${a >= 0 ? "+" : ""}${a.toFixed(1)}%`; };
/** One sentence on the trend rule's past record on this market. */
function trendRecord(c, s) {
  if (!s || s.n < 8) return `<span class="muted">It has happened only ${s?.n || 0} times on ${fmt.esc(c.base)}'s daily chart, too few to judge it here on its own.</span>`;
  return `On ${fmt.esc(c.base)} it made <strong class="${s.ev >= 0 ? "up" : "down"}">${fmt.pct(s.ev * 100)}</strong> per trade on average over ${s.n} past trades after fees, winning ${Math.round(s.winRate * 100)}% of them: trend trades lose more often than they win, and the winners are bigger.`;
}

/** Which kind of market we're in, and that setups are judged by their record in this kind of market. */
function regimeNote(c, r) {
  const g = r?.regime;
  if (!g || g.now === "unknown") return "";
  const judged = r.setups.filter((s) => s.basis === "regime").length;
  const up = g.now === "up";
  return `<p class="small d-regime" title="${fmt.esc(`${c.base} is in a ${g.label} on ${c.interval} candles. Setups with 30+ past trades in this kind of market are judged only by those trades.`)}"><span class="pill ${up ? "pill-edge" : "pill-negative"}">${up ? "▲ Rising market" : "▼ Falling market"}</span>
    <span class="muted">${up ? "Price is above its 200-candle average." : "Price is below its 200-candle average: buying setups usually struggle."} ${judged ? `${judged} of ${r.setups.length} setups judged on ${up ? "rising" : "falling"}-market trades only.` : ""}</span></p>`;
}

/** Candlestick patterns that just formed, each with its MEASURED record on this market. */
function patternNote(c, r) {
  const list = c.patterns || [];
  if (!list.length) return "";
  const rows = list.map((p) => {
    const when = p.candlesAgo === 0 ? "on the last closed candle" : `${p.candlesAgo} candle${p.candlesAgo === 1 ? "" : "s"} ago`;
    let record;
    if (p.dir > 0) {
      const s = r?.setups?.find((x) => x.id === "p_" + p.id)?.stats;
      record = s && s.n
        ? (s.n < 30 ? `Only ${s.n} past cases here, too few to trust.`
          : `Bought after it here: ended in profit ${Math.round(s.winRate * s.n)} of ${s.n} times, <strong class="${s.ev > 0 ? "up" : "down"}">${fmt.pct(s.ev * 100)}</strong> per trade after costs.`)
        : "No past cases here yet.";
    } else {
      const m = p.measured;
      record = m && m.n
        ? (m.n < 10 ? `Only ${m.n} past cases on this chart, too few to trust.`
          : `After it here, price fell within ${m.h} candles ${Math.round(m.worked * 100)}% of the time (${m.n} cases; average ${fmt.pct(m.avgMove * 100)}).`)
        : "No past cases on this chart yet.";
    }
    return `<li><span class="${p.dir > 0 ? "up" : "down"}">${p.dir > 0 ? "▲ Bullish" : "▼ Bearish"}</span> <strong>${fmt.esc(p.name)}</strong> ${when}. <span class="muted">${fmt.esc(p.plain)}</span> ${record}</li>`;
  }).join("");
  return `<div class="d-when"><div class="d-when-title">Candle patterns just formed</div><ul class="d-trig">${rows}</ul>
    <p class="tiny muted">Patterns are judged by what they actually did on ${fmt.esc(c.base)} at this candle size, not by what guides say they should do. A bullish pattern becomes a BUY only if its record here is proven.</p></div>`;
}

/** "It just jumped, why not buy?": how big the last few candles' move is, and what followed similar moves here. */
function moveNote(c) {
  const m = c.move;
  if (!m || !isFinite(m.percentile)) return "";
  const minutes = c.intervalSec ? (m.k * c.intervalSec) / 60 : null;
  const span = minutes == null ? `${m.k} candles` : minutes < 60 ? `~${Math.round(minutes)} min` : minutes < 1440 ? `~${+(minutes / 60).toFixed(1)} h` : `~${Math.round(minutes / 1440)} days`;
  const hMin = c.intervalSec ? (m.H * c.intervalSec) / 60 : null;
  const later = hMin == null ? `${m.H} candles later` : hMin < 60 ? `${Math.round(hMin)} min later` : hMin < 1440 ? `${+(hMin / 60).toFixed(1)} h later` : `${Math.round(hMin / 1440)} days later`;
  const up = m.ret >= 0;
  const p = Math.round(m.percentile * 100);
  const size = p >= 95 ? "an unusually big move" : p >= 80 ? "a fairly big move" : p >= 40 ? "a normal-size move" : "a small move";
  const sign = up ? "+" : "−";
  let what = "";
  if (m.cases >= 15) {
    const hi = Math.round(m.higher * 100);
    what = ` After <strong>${m.cases}</strong> past ${up ? "rises" : "drops"} at least this big, price was higher ${later} <strong>${hi}%</strong> of the time (average ${m.avg >= 0 ? "+" : ""}${(m.avg * 100).toFixed(2)}%).`;
    what += !m.clear
      ? ` That's ${Math.abs(hi - 50) <= 3 ? "a coin flip" : "too close to a coin flip to rely on"}: ${up ? "buying after a jump like this hasn't had an edge here" : "a drop like this hasn't reliably bounced"}.`
      : (m.higher > 0.5) === up
        ? ` Moves like this have tended to ${up ? "keep going" : "bounce"} a little, but that alone isn't a tested trade with a stop and target, so Entryvex doesn't call it a BUY.`
        : ` Moves like this have tended to ${up ? "fade back" : "keep falling"}, a reason not to chase it.`;
  } else what = ` There are too few past moves this big (${m.cases}) to say what usually happens next.`;
  return `<div class="d-when"><div class="d-when-title">Just moved ${up ? "up" : "down"}? Here's what that means</div>
    <p class="small">${fmt.esc(c.base)} is <strong class="${up ? "up" : "down"}">${sign}${fmt.price(Math.abs(m.change))} (${sign}${Math.abs(m.ret * 100).toFixed(2)}%)</strong> over the last ${m.k} candles (${span}).
    That's ${size} for ${fmt.esc(c.base)}: bigger than ${p}% of its ${span} moves.${what}</p></div>`;
}

/** What the measured forecast says, in one or two plain sentences. */
function predicts(c) {
  const f = c.forecast;
  if (!f) return "";
  const mins = (f.H * f.intervalSec) / 60;
  const h = mins < 60 ? `${Math.round(mins)} minutes` : mins < 1440 ? `${+(mins / 60).toFixed(1)} hours` : `${+(mins / 1440).toFixed(1)} days`;
  const rel = reliability(f.accuracy80);
  return `<div class="d-when"><div class="d-when-title">What Entryvex predicts (next ~${h})</div>
    <p class="small">Most likely between <strong class="down">${fmt.price(f.range80[0])}</strong> and <strong class="up">${fmt.price(f.range80[1])}</strong> (80% range), middle ${fmt.price(f.mid)}.
    Chance it's higher by then: <strong>${Math.round(f.pUp * 100)}%</strong>, ${describeOdds(f.pUp)}.
    <span class="muted">This forecast has been ${rel.label} (${Math.round(f.accuracy80 * 100)}% of past tests landed inside the range).</span></p>
    ${(() => { const s = scoreLine(c.symbol, f.interval || c.interval); return s ? `<p class="small">${s}</p>` : ""; })()}</div>`;
}

function confidenceMeter(p, lo, hi, be, n) {
  const pct = (v) => `${Math.max(0, Math.min(100, v * 100)).toFixed(1)}%`;
  return `<div class="d-meter" title="Bar: measured win rate. Shaded: likely true range (95%). Line: the win rate needed to break even.">
    <div class="d-meter-top"><span>Measured confidence</span><strong>${Math.round(p * 100)}%</strong><span class="muted small">likely ${Math.round(lo * 100)}–${Math.round(hi * 100)}% · needs ${Math.round(be * 100)}% to break even · ${n} past cases</span></div>
    <div class="d-bar"><i class="d-range" style="left:${pct(lo)};width:calc(${pct(hi)} - ${pct(lo)})"></i><i class="d-fill" style="width:${pct(p)}"></i><i class="d-be" style="left:${pct(be)}"></i></div>
  </div>`;
}

function buySteps(c, r, unit) {
  const p = r.plan;
  if (!p) return "";
  // Non-USD markets: convert the USD balance at the live rate (no sizing until the rate is loaded).
  const cur = isStock(c.symbol) ? stockInfo(c.symbol).currency : "USD";
  const rate = cur === "USD" ? 1 : fxRate(cur);
  const bal = rate ? settings.balance * rate : 0;
  const amt = (v, sign) => (cur === "USD" ? `${sign || ""}$${Math.abs(v).toFixed(2)}` : `${sign || ""}${fxMoney(Math.abs(v), cur, rate)}`);
  const sz = bal > 0 ? sizePosition({ balance: bal, riskPct: settings.riskPct, entry: p.entry, stop: p.stop, target: p.target, costPerSide: r.costPerSide, rules: c.rules }) : null;
  if (p.kind === "trail") return trailSteps(c, r, p, sz, amt, unit);
  const sellBy = new Date(Date.now() + RULES.maxBars * (SEC[c.interval] || 900) * 1000)
    .toLocaleString([], { weekday: "short", hour: "2-digit", hourCycle: "h23", minute: "2-digit" });
  const amount = sz?.ok
    ? `<strong>${+sz.qty.toFixed(8)} ${fmt.esc(unit)}</strong> (about ${amt(sz.spend)})`
    : sz ? "a small amount (your balance is too small for Entryvex's sizing; see the trade card)" : "the amount shown on the trade card (enter your balance below to calculate it)";
  return `<ol class="d-steps">
    <li><strong>Buy</strong> ${amount} at about <strong>${fmt.price(sz?.entry ?? p.entry)}</strong>. Use a limit order.</li>
    <li><strong>Right away, set your sell orders:</strong> take-profit at <strong class="up">${fmt.price(sz?.target ?? p.target)}</strong>${sz?.ok ? ` (${amt(sz.winUsd, "+")})` : ""} and stop-loss at <strong class="down">${fmt.price(sz?.stop ?? p.stop)}</strong>${sz?.ok ? ` (${amt(sz.lossUsd, "−")})` : ""}, as one OCO order.</li>
    <li><strong>If neither is hit by ${sellBy}</strong>, sell at the market price. That's the time limit the track record is based on.</li>
    <li>Click <strong>I took this trade</strong> on the trade card below. Entryvex will then tell you when to sell.</li>
  </ol>`;
}

/** Steps for a trend trade: one stop-loss that you move up after each daily close, no fixed target. */
function trailSteps(c, r, p, sz, amt, unit) {
  const amount = sz?.ok
    ? `<strong>${+sz.qty.toFixed(8)} ${fmt.esc(unit)}</strong> (about ${amt(sz.spend)})`
    : sz ? "a small amount (your balance is too small for Entryvex's sizing; see the trade card)" : "the amount shown on the trade card (enter your balance below to calculate it)";
  return `<ol class="d-steps">
    <li><strong>Buy</strong> ${amount} at about <strong>${fmt.price(sz?.entry ?? p.entry)}</strong>. Use a limit order.</li>
    <li><strong>Right away, set a stop-loss</strong> at <strong class="down">${fmt.price(sz?.stop ?? p.stop)}</strong>${sz?.ok ? ` (${amt(sz.lossUsd, "−")} if hit)` : ""}.</li>
    <li><strong>After each daily close, move the stop up</strong> to ${p.trailAtr} ATR (about <strong>${fmt.price(p.trail)}</strong>) below the highest price since you bought. Never move it down. Entryvex works out the new stop for you in My trades.</li>
    <li><strong>No fixed take-profit.</strong> You sell when the price falls back to your stop, which lets winners run. Most trend trades end in a small loss; the few big winners pay for them.</li>
    <li>Click <strong>I took this trade</strong> on the trade card below. Entryvex will then track your stop.</li>
  </ol>`;
}

/* ---------------- Simple mode: one big answer ---------------- */
/**
 * BUY / SELL / WAIT for a beginner, from the same measured evidence as the full card:
 *   BUY  – the trend rule fires on this daily chart (with how much, and the trailing stop);
 *   SELL – you own it and the plan says sell, or the trend is down with a bearish sign (for owners);
 *   WAIT – no trend breakout right now (with the price that would trigger one, or where to look instead).
 * Plus what the Entryvex paper-trading bot is doing on this market.
 */
function simpleHtml(c) {
  const r = c.analysis;
  const stock = isStock(c.symbol);
  const unit = stock ? "shares" : c.base;
  const held = openTrades().filter((t) => t.symbol === c.symbol);
  const f = c.forecast;
  let word, cls, why, plan = "";
  if (held.length) {
    const adv = tradeAdvice(held[0], c.price);
    word = adv.level === "sell" ? "SELL" : "HOLD"; cls = adv.level === "sell" ? "sell" : "hold";
    why = (held[0].practice ? "<strong>Your practice trade</strong> (pretend money). " : "") + adv.why;
  } else if (!r) {
    word = "CHECKING"; cls = "wait"; why = `Testing ${fmt.esc(c.base)}'s setups against its history…`;
  } else if (r.liquidity && !r.liquidity.ok) {
    word = "DON'T BUY"; cls = "no"; why = `${fmt.esc(c.base)} barely trades on this exchange at this candle size, so prices jump and a stop-loss can't protect you.`;
  } else {
    const best = r.best;
    let lvl = r.overall.level;
    if (lvl === "caution" && best?.verdict.level !== "weak") lvl = "thin";
    const bearishPattern = (c.patterns || []).some((p) => p.dir < 0);
    const falling = r.regime?.now === "down";
    if (lvl === "go" || lvl === "caution") {
      word = lvl === "go" ? "BUY" : "SMALL BUY"; cls = lvl === "go" ? "buy" : "caution";
      const s = best.stats;
      why = best.trend
        ? `${fmt.esc(c.base)} is in an uptrend and a day just closed at a new 20-day high: Entryvex's trend rule, which made money after fees on data it never saw. ${trendRecord(c, s)}`
        : `${best.model ? "Entryvex's prediction model" : `The “${fmt.esc(best.name)}” setup`} just signalled a buy. On ${fmt.esc(c.base)} it ended in profit <strong>${Math.round(s.winRate * s.n)} of ${s.n}</strong> times after fees${lvl === "go" ? "" : " (only slightly profitable, so use a smaller amount)"}.`;
      const usd = !stock || stockInfo(c.symbol).currency === "USD";
      const practice = usd && r.plan ? practiceButton({ symbol: c.symbol, entry: r.plan.entry, stop: r.plan.stop, target: r.plan.target, trail: r.plan.trail || null, setup: best.name, verdict: lvl, interval: c.interval }, r.costPerSide, c.rules) : "";
      const tested = walkLine(c.interval);
      plan = (tested ? `<p class="small simple-bot">${tested}</p>` : "") + buySteps(c, r, unit) + `<div class="simple-actions"><button class="btn" data-take-pro>I took this trade: track it for me</button>${practice}</div>`;
    } else if (falling && (bearishPattern || (f && f.pUp < 0.45))) {
      word = "SELL"; cls = "sell";
      why = `The trend is down (price is below its 200-candle average)${bearishPattern ? " and a bearish candle pattern just formed" : ""}${f && f.pUp < 0.45 ? `, and only ${Math.round(f.pUp * 100)}% of similar moments ended higher` : ""}. <strong>Don't buy.</strong> If you own ${fmt.esc(c.base)}, Entryvex would sell or keep a tight stop-loss.`;
    } else {
      word = "WAIT"; cls = "wait";
      const watch = topWatch(2).find((w) => w.sym !== c.symbol);
      const elsewhere = watch ? ` Closest to a BUY in your watchlist: <button class="link-btn" data-goto-opps>${fmt.esc(watch.base)} above ${fmt.price(watch.level)} (${watch.away >= 0 ? "+" : ""}${watch.away.toFixed(1)}%)</button>.` : "";
      why = r.overall.shortChart
        ? `Short charts don't give BUY signals: in testing on data they never saw, Entryvex's signals on candles shorter than a day lost money after fees. <button class="link-btn" data-goto-iv="1d">Check ${fmt.esc(c.base)} on the daily chart</button>.`
        : r.upNow && isFinite(r.overall.trigger)
        ? (c.price > r.overall.trigger
          ? `${fmt.esc(c.base)} is in an uptrend and trading above its 20-day high (${fmt.price(r.overall.trigger)}) right now. <strong>If today's candle closes above it, Entryvex says BUY</strong> after the close. Don't jump in before the close: the rule was tested on closing prices.${elsewhere}`
          : `${fmt.esc(c.base)} is in an uptrend. Entryvex says <strong>BUY if a day closes above ${fmt.price(r.overall.trigger)}</strong> (${fmtAway(r.overall.trigger, c.price)} from now), a new 20-day high.${elsewhere}`)
        : `No uptrend on ${fmt.esc(c.base)}'s daily chart, so Entryvex's trend rule says wait.${elsewhere}`;
    }
    const otherIv = cls !== "buy" && cls !== "caution" ? currentBuys().find((b) => b.sym === c.symbol && b.iv !== c.interval) : null;
    if (otherIv) plan += `<div class="d-other-iv"><span>📈 <strong>${otherIv.label === "GO" ? "BUY" : "SMALL BUY"} on ${fmt.esc(IV_WORD[otherIv.iv] || otherIv.iv)} candles</strong> right now.</span><button class="btn" data-goto-iv="${fmt.esc(otherIv.iv)}">Show it</button></div>`;
  }
  const bot = botLine(c.symbol) + ownLine(c);
  return `<div class="simple d-${cls}">
    <div class="simple-top"><span class="simple-label">Entryvex says</span><strong class="simple-word">${word}</strong></div>
    <p class="simple-why">${why}</p>
    ${plan}
    ${f ? `<p class="small muted">Next ~${(f.H * f.intervalSec) / 3600 < 48 ? Math.round((f.H * f.intervalSec) / 3600) + " hours" : Math.round((f.H * f.intervalSec) / 86400) + " days"}: most likely between <strong class="down">${fmt.price(f.range80[0])}</strong> and <strong class="up">${fmt.price(f.range80[1])}</strong> (right ${Math.round(f.accuracy80 * 100)}% of the time in tests).</p>${(() => { const s = scoreLine(c.symbol, f.interval || c.interval); return s ? `<p class="small muted">${s}</p>` : ""; })()}` : ""}
    ${bot}
    <p class="tiny muted">Not financial advice: every number is measured from past prices, and markets can do anything. Only trade money you can afford to lose. Switch to <button class="link-btn tiny" data-mode-pro>Pro</button> for all the details.</p>
  </div>`;
}
function ownLine(c) {
  const h = holdingOf(c.symbol);
  if (!h || !(c.price > 0)) return "";
  const pl = (c.price / h.cost - 1) * 100;
  return `<p class="small simple-bot">💼 <strong>You own ${+h.qty.toFixed(8)}</strong> at ${fmt.price(h.cost)} (<span class="${pl >= 0 ? "up" : "down"}">${pl >= 0 ? "+" : ""}${pl.toFixed(2)}%</span>). <button class="link-btn" data-open-holdings>Buy more, hold or trim?</button></p>`;
}
function botLine(sym) {
  const v = botViewCached(sym);
  if (!v) return "";
  if (v.holding) {
    const p = v.holding, pnl = ((p.last || p.entry) / p.entry - 1) * 100;
    const exits = p.trail ? `it sells if the price falls to its trailing stop, now ${fmt.price(p.stop)}` : `it sells at ${fmt.price(p.target)} to take profit or ${fmt.price(p.stop)} to cut the loss`;
    return `<div class="small simple-bot">🤖 <strong>The Entryvex bot owns ${fmt.esc(p.market)}</strong> (bought at ${fmt.price(p.entry)}, now ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%; ${exits}). <button class="link-btn" data-open-bot>Why it bought</button>
      <div class="simple-actions"><button class="btn" data-copy-bot>Copy this trade</button><span class="muted tiny">Adds it to My trades with the bot's stop, sized for your balance. You place the real order yourself. The bot isn't proven yet, so keep it small.</span></div></div>`;
  }
  if (v.trades) return `<p class="small simple-bot">🤖 The Entryvex bot has traded this ${v.trades} time${v.trades === 1 ? "" : "s"} (${v.wins} won) and doesn't own it now. <button class="link-btn" data-open-bot>See why</button></p>`;
  return "";
}
