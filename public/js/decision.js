// "Entryvex says": one plain answer for the coin/stock on screen.
//   - Already own it?  -> HOLD or SELL NOW, with the exact sell prices and a sell-by time.
//   - Otherwise        -> BUY / SMALL BUY OR SKIP / DON'T BUY / WAIT, from the scanner's MEASURED verdict.
// Five outside checks (bigger trend, overall market, fear gauge, news mood, forecast odds) are shown
// as tailwinds/headwinds. They're context only: they are not part of the measured win rate.
import { getKlineHistory, get24h, isStock, stockInfo } from "./market.js";
import { ema } from "./indicators.js";
import { sizePosition } from "./sizing.js";
import { settings, guard } from "./money.js";
import { openTrades, tradeAdvice } from "./journal.js";
import { RULES } from "./engine.js";
import * as fmt from "./format.js";
import { currentBuys, topWatch } from "./opportunities.js";
import { describeOdds, reliability } from "./forecast.js";
import { upcomingHighImpact, loadCalendar } from "./calendar.js";

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
const SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
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

async function marketBackdrop(stock) {
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

async function fearGauge(stock) {
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

function forecastOdds(f) {
  if (!f) return null;
  const p = f.pUp;
  return {
    label: "Measured odds of being higher",
    effect: p >= 0.55 ? 1 : p <= 0.45 ? -1 : 0,
    text: `${Math.round(p * 100)}% of the time, price was higher ${f.H} candles later${Math.abs(p - 0.5) < 0.03 ? " (basically a coin flip)" : ""}.`,
  };
}

async function outsideChecks(c) {
  const key = `${c.symbol}:${c.interval}`;
  const hit = ctxCache.get(key);
  if (hit && Date.now() - hit.t < 120_000) return hit.v;
  const stock = isStock(c.symbol);
  const results = await Promise.allSettled([bigTrend(c.symbol, c.interval), marketBackdrop(stock), fearGauge(stock), newsMood(c.symbol, c.base, c.name), eventRisk()]);
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
}

function html(c, checks) {
  const r = c.analysis;
  const stock = isStock(c.symbol);
  const unit = stock ? "shares" : c.base;
  const held = openTrades().filter((t) => t.symbol === c.symbol);
  const f = c.forecast;
  const all = checks ? [...checks, forecastOdds(f)].filter(Boolean) : null;
  const tail = all ? all.filter((x) => x.effect > 0).length : 0;
  const head = all ? all.filter((x) => x.effect < 0).length : 0;

  let verdict, cls, headline, steps = "", meter = "";

  if (held.length) {
    // You own it: the only question is hold or sell.
    const t = held[0];
    const adv = tradeAdvice(t, c.price);
    verdict = adv.action; cls = adv.level === "sell" ? "sell" : "hold";
    const pnl = c.price ? (c.price - t.entry) * t.qty - t.fee * (t.entry * t.qty + c.price * t.qty) : null;
    headline = `You own ${+t.qty.toFixed(8)} ${unit}${pnl != null ? `, now <strong class="${pnl >= 0 ? "up" : "down"}">${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}</strong> after fees` : ""}. ${adv.why}`;
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
      headline = lvl === "go"
        ? `<strong>${fmt.esc(best.name)}</strong> just appeared, and on this ${stock ? "stock" : "coin"} it has ended in profit <strong>${Math.round(s.winRate * s.n)} of ${s.n}</strong> times after costs.`
        : `<strong>${fmt.esc(best.name)}</strong> just appeared. It has been only slightly profitable here (${Math.round(s.winRate * 100)}% of ${s.n} times), so it's not a strong signal. Use a smaller amount or skip it.`;
      if (head >= 3) headline += ` <span class="down">Careful: ${head} of ${all.length} outside checks are against it right now.</span>`;
      if (stock && c.marketOpen === false) headline += ` <span class="muted">The market is closed: you can only place this after 9:30am New York time, so re-check then.</span>`;
      meter = confidenceMeter(s.winRate, s.winLo, s.winHi, s.breakeven, s.n);
      steps = buySteps(c, r, unit);
    } else {
      cls = lvl === "wait" ? "wait" : "no";
      verdict = lvl === "wait" ? "WAIT · DON'T BUY YET" : "DON'T BUY";
      headline = lvl === "wait"
        ? `None of the setups Entryvex trusts is happening on ${c.base} right now, so there's no good reason to buy at this moment.`
        : lvl === "no" && best?.verdict.level === "flat"
          ? `A setup is active, but on ${c.base} it has only <strong>broken even</strong> after costs (${fmt.pct(best.stats.ev * 100)} per trade, too small to be more than luck). Skip it.`
          : lvl === "no"
          ? `A setup is active, but on ${c.base} it has <strong>lost money</strong> after costs in the past (${Math.round(best.stats.winRate * 100)}% wins, ${fmt.pct(best.stats.ev * 100)} per trade). Skip it.`
          : `A setup is active, but it has only happened ${best?.stats.n ?? 0} times here, too few to know if it works. Skip it.`;
      const elsewhere = currentBuys().filter((b) => b.sym !== c.symbol);
      if (elsewhere.length) headline += ` <span class="d-elsewhere">Elsewhere right now: ${elsewhere.slice(0, 3).map((b) => `<button class="link-btn" data-goto-opps>${fmt.esc(b.label === "GO" ? "BUY" : "small buy")} on ${fmt.esc(b.base)} (${b.iv})</button>`).join(", ")}.</span>`;
      steps = whenToBuy(c, r, best) + predicts(c) + `<ol class="d-steps">
        <li><strong>Do nothing for now.</strong> Not trading is a good decision when the odds aren't on your side.</li>
        <li>Entryvex re-checks every time a ${c.interval} candle closes. Turn on <button class="link-btn" data-open-alerts>setup alerts 🔔</button> to be told the moment a BUY appears on any of your coins or stocks.</li>
        <li>Want to look elsewhere? Try <button class="link-btn" data-find-edge>Find an edge for this ${stock ? "stock" : "coin"}</button> or <button class="link-btn" data-scan-all>Scan watchlist</button>.</li>
      </ol>`;
    }
  }

  const checksHtml = all == null
    ? `<div class="muted small">Checking the bigger trend, the overall market, fear levels and news…</div>`
    : `<div class="d-checks">${all.map((x) => `<div class="d-check eff-${x.effect > 0 ? "pos" : x.effect < 0 ? "neg" : "neu"}">
          <span class="d-ico">${x.effect > 0 ? "▲" : x.effect < 0 ? "▼" : "•"}</span>
          <span><strong>${fmt.esc(x.label)}</strong> ${fmt.esc(x.text)}</span></div>`).join("")}</div>
       <p class="tiny muted">${tail} helping · ${head} against · ${all.length - tail - head} neutral. These checks add context from outside sources; they are <em>not</em> part of the measured win rate, because there isn't enough history to prove how much they help.</p>`;

  return `<div class="d-card d-${cls}">
    <div class="d-top">
      <div class="d-verdict"><span class="d-label">Entryvex says</span><strong>${verdict}</strong></div>
      <div class="d-headline">${headline}</div>
    </div>
    ${meter}
    ${steps}
    <details class="d-more" ${held.length ? "" : ""}><summary>Why? Outside checks (${all ? `${tail} for · ${head} against` : "loading"})</summary>${checksHtml}</details>
  </div>`;
}

/** "When would Entryvex say BUY?": the price conditions for setups with a positive track record. */
function whenToBuy(c, r, best) {
  const trig = (r.triggers || []).filter((t) => t.setup && (t.setup.verdict.level === "edge" || t.setup.verdict.level === "weak"));
  const fill = (t) => t.text.replace("{L}", t.level != null
    ? `<strong>${fmt.price(t.level)}</strong> <span class="muted">(${t.away >= 0 ? "+" : ""}${t.away.toFixed(1)}% from now)</span>` : "");
  if (!trig.length) {
    const alt = topWatch(3).filter((w) => w.sym !== c.symbol);
    return `<div class="d-when"><div class="d-when-title">When would Entryvex say BUY?</div>
      <p class="small">None of the 4 setups has a reliable track record on <strong>${fmt.esc(c.base)}</strong> with ${c.interval} candles, so <strong>there's no price where Entryvex would say BUY here</strong>. Trading it anyway would be a guess.</p>
      ${alt.length ? `<p class="small">Where Entryvex <em>would</em> buy instead (when the setup appears): ${alt.map((w) => `<button class="link-btn" data-goto-opps>${fmt.esc(w.base)} ${w.iv} · ${fmt.esc(w.s.name)}</button> <span class="muted">(${Math.round(w.s.stats.winRate * 100)}% of ${w.s.stats.n}, ${fmt.pct(w.s.stats.ev * 100)}/trade)</span>`).join(" · ")}</p>`
        : `<p class="small muted">Try <button class="link-btn" data-find-edge>Find an edge</button> to test other candle sizes for ${fmt.esc(c.base)}.</p>`}
    </div>`;
  }
  return `<div class="d-when"><div class="d-when-title">When would Entryvex say BUY?</div>
    <ul class="d-trig">${trig.map((t) => `<li class="${t.ready ? "" : "muted"}">
      <span class="pill pill-${t.setup.verdict.level}">${fmt.esc(t.setup.verdict.label)}</span>
      <strong>${fmt.esc(t.setup.name)}:</strong> ${t.ready ? "BUY if " + fill(t) : "Not possible right now: " + fill(t)}.
      <span class="muted small">Past record here: ended in profit ${Math.round(t.setup.stats.winRate * t.setup.stats.n)} of ${t.setup.stats.n} times, ${fmt.pct(t.setup.stats.ev * 100)} per trade after costs.</span></li>`).join("")}</ul>
    <p class="tiny muted">Entryvex re-checks after every ${c.interval} candle closes and switches to BUY (with the full plan) the moment one of these happens.</p>
  </div>`;
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
    <span class="muted">This forecast has been ${rel.label} (${Math.round(f.accuracy80 * 100)}% of past tests landed inside the range).</span></p></div>`;
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
  const foreign = isStock(c.symbol) && stockInfo(c.symbol).currency !== "USD";
  const bal = foreign ? 0 : settings.balance;   // never mix a USD balance with other currencies
  const sz = bal > 0 ? sizePosition({ balance: bal, riskPct: settings.riskPct, entry: p.entry, stop: p.stop, target: p.target, costPerSide: r.costPerSide, rules: c.rules }) : null;
  const sellBy = new Date(Date.now() + RULES.maxBars * (SEC[c.interval] || 900) * 1000)
    .toLocaleString([], { weekday: "short", hour: "2-digit", hourCycle: "h23", minute: "2-digit" });
  const amount = sz?.ok
    ? `<strong>${+sz.qty.toFixed(8)} ${fmt.esc(unit)}</strong> (about $${sz.spend.toFixed(2)})`
    : sz ? "a small amount (your balance is too small for Entryvex's sizing; see the trade card)" : "the amount shown on the trade card (enter your balance below to calculate it)";
  return `<ol class="d-steps">
    <li><strong>Buy</strong> ${amount} at about <strong>${fmt.price(sz?.entry ?? p.entry)}</strong>. Use a limit order.</li>
    <li><strong>Right away, set your sell orders:</strong> take-profit at <strong class="up">${fmt.price(sz?.target ?? p.target)}</strong>${sz?.ok ? ` (+$${sz.winUsd.toFixed(2)})` : ""} and stop-loss at <strong class="down">${fmt.price(sz?.stop ?? p.stop)}</strong>${sz?.ok ? ` (−$${sz.lossUsd.toFixed(2)})` : ""}, as one OCO order.</li>
    <li><strong>If neither is hit by ${sellBy}</strong>, sell at the market price. That's the time limit the track record is based on.</li>
    <li>Click <strong>I took this trade</strong> on the trade card below. Entryvex will then tell you when to sell.</li>
  </ol>`;
}
