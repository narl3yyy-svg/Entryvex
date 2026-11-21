// "If you buy now": what buying the coin/stock on screen at the current price would mean for YOUR money.
// Everything is measured from this market's own history (no guesses):
//   - quantity, fees, break-even price
//   - short term: chance of being in profit after costs at the end of the forecast window, and the
//     likely dollar range (from the tested forecast)
//   - a 1-in-20 bad day (5th-percentile daily move over the last year)
//   - holding ~3 months: how often it ended higher and the typical dollar range (up to 10 years of data)
//   - with Entryvex's standard stop/target: the most you'd lose and what you'd make
import { probAbove, reliability } from "./forecast.js";
import { cachedLongTerm } from "./longterm.js";
import { sizePosition, floorStep } from "./sizing.js";
import { settings } from "./money.js";
import { isStock, stockInfo } from "./market.js";
import { RULES } from "./engine.js";
import * as fmt from "./format.js";
import { fxRate, loadFx, money as fxMoney, majorOf } from "./fx.js";

const $ = (id) => document.getElementById(id);
let ctx = null;
let lastSummary = null;
/** The latest "If you buy now" numbers (for the AI analyst). */
export function getBuyNowSummary() { return lastSummary && lastSummary.symbol === ctx?.symbol ? lastSummary : null; }
// The amount typed in US dollars. Empty / 0 = Entryvex's size (risking your max loss per trade).
let customAmount = +(sessionStorage.getItem("evx.bnAmount") || 0);

// Amount formatters for the market's own currency (set per render; US dollars for USD markets).
const usdMoney = (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 })}`;
const usdPlain = (v) => `$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 })}`;
let money = usdMoney, usd = usdPlain;

export function initBuyNow() {
  const el = $("buynow");
  // Apply the typed amount only on Enter or when leaving the box (not on every keystroke).
  el.addEventListener("change", (e) => {
    if (e.target.id !== "bn-amount") return;
    customAmount = Math.max(0, parseFloat(e.target.value) || 0);
    sessionStorage.setItem("evx.bnAmount", String(customAmount));
    render();
  });
  el.addEventListener("keydown", (e) => { if (e.target.id === "bn-amount" && e.key === "Enter") e.target.blur(); });
}

/** c: { symbol, base, name, interval, price, analysis, forecast, rules } */
export function updateBuyNow(c) {
  ctx = c;
  // Live price ticks must not redraw the card while you're typing an amount.
  if (document.activeElement?.id === "bn-amount") return;
  render();
}

function render() {
  const el = $("buynow");
  if (!el || !ctx || !ctx.price) return;
  const c = ctx, r = c.analysis, f = c.forecast, lt = cachedLongTerm(c.symbol);
  const stock = isStock(c.symbol);
  const unit = stock ? "shares" : c.base;
  const currency = stock ? stockInfo(c.symbol).currency : "USD";
  // Non-USD markets: convert your USD balance at the live exchange rate; amounts show in both currencies.
  const rate = currency === "USD" ? 1 : fxRate(currency);
  const major = majorOf(currency);
  if (!rate) {
    $("buynow").innerHTML = `<div class="bn-card"><div class="d-when-title">If you buy ${fmt.esc(c.base)} now</div>
      <p class="small muted">Loading the ${fmt.esc(major[0])}/USD exchange rate to convert your balance…</p></div>`;
    loadFx(currency).then((x) => {
      if (ctx !== c) return;
      if (x) render();
      else $("buynow").innerHTML = `<div class="bn-card"><p class="small muted">The ${fmt.esc(major[0])}/USD exchange rate is unavailable right now, so Entryvex can't size this in dollars.</p></div>`;
    });
    return;
  }
  const foreign = currency !== "USD";
  money = foreign ? (v) => fxMoney(v, currency, rate, { sign: true }) : usdMoney;
  usd = foreign ? (v) => fxMoney(Math.abs(v), currency, rate) : usdPlain;
  const bal = settings.balance * rate;   // in the market's own currency
  const price = c.price;
  const cost = r?.costPerSide ?? 0.0007;           // fee + half the bid/ask spread, per side
  const atr = r?.atr;

  // Entryvex's suggested amount: risk your "max loss per trade" if price falls 1 ATR (its standard stop).
  const stop = atr ? price - RULES.stopAtr * atr : null;
  const target = atr ? price + RULES.targetAtr * atr : null;
  const suggested = bal > 0 && stop ? sizePosition({ balance: bal, riskPct: settings.riskPct, entry: price, stop, target, costPerSide: cost, rules: c.rules }) : null;

  let amount = customAmount > 0 ? customAmount * rate : suggested?.spend || 0;   // typed in US dollars
  if (bal > 0) amount = Math.min(amount, bal);

  // Quantity the exchange will actually accept.
  let qty = amount > 0 ? floorStep(amount / price, c.rules?.stepSize || (stock ? 1 : 0)) : 0;
  const spend = qty * price;
  const feeIn = spend * cost;
  const breakeven = price * (1 + cost) / (1 - cost);
  const pnlAt = (px) => qty * px * (1 - cost) - spend - feeIn;

  const suggestedUsd = suggested?.spend ? Math.round(suggested.spend / rate) : null;

  const header = `
    <div class="bn-head">
      <div><div class="d-when-title">If you buy ${fmt.esc(c.base)} now at ${stock ? (foreign ? fmt.esc(currency) + " " : "$") : ""}${fmt.price(price)}</div>
        <div class="muted small">${bal > 0 ? `Your balance: ${usdPlain(settings.balance)}${foreign ? ` ≈ ${fxMoney(bal, currency, 0)} at ${fmt.price(rate / major[1])} ${fmt.esc(major[0])} per $1` : ""} · max loss per trade ${settings.riskPct}%` : "Enter your trading balance above to see dollar amounts for your account."}</div></div>
      <label class="bn-amount" title="Type an amount and press Enter. Leave empty to use Entryvex's size, which risks your max loss per trade at its standard stop-loss.">
        <span class="small muted">Amount to buy</span>
        <span class="inp"><em>$</em><input id="bn-amount" type="number" min="0" step="any" inputmode="decimal" enterkeyhint="done"
          placeholder="${suggestedUsd ? suggestedUsd.toLocaleString("en-US") + " (Entryvex size)" : "amount"}" value="${customAmount || ""}" /></span>
      </label>
    </div>`;

  if (!(qty > 0)) {
    $("buynow").innerHTML = `<div class="bn-card">${header}<p class="small muted">${bal > 0 ? (stock && amount > 0 && amount < price ? `That's less than one share (${usd(price)}). Increase the amount.` : "Type an amount and press Enter to see what would happen.") : ""}</p></div>`;
    return;
  }

  lastSummary = { symbol: c.symbol, amountUsd: +(spend / rate).toFixed(2), quantity: +qty.toFixed(8), unit, pctOfBalance: bal > 0 ? +((spend / bal) * 100).toFixed(1) : null,
    feesEachWayUsd: +(feeIn / rate).toFixed(2), breakevenPrice: +breakeven.toPrecision(8), priceCurrency: currency,
    ...(foreign ? { currencyPerUsd: rate, note: `all *Usd figures converted from ${currency} at the live rate` } : {}) };
  const tiles = [];
  // Basics
  tiles.push(`<div><span>You'd get</span><strong class="mono">${+qty.toFixed(8)} ${fmt.esc(unit)}</strong><small class="muted">${usd(spend)}${bal > 0 ? ` · ${Math.round((spend / bal) * 100)}% of balance` : ""} · fees ≈ ${usd(feeIn)} each way</small></div>`);
  tiles.push(`<div><span>Break-even price</span><strong class="mono">${fmt.price(breakeven)}</strong><small class="muted">it must rise ${(((breakeven / price) - 1) * 100).toFixed(2)}% just to cover fees &amp; spread</small></div>`);

  // Short term: tested forecast
  if (f && f.symbol === c.symbol) {
    const pProfit = probAbove(f, breakeven);
    const mins = (f.H * f.intervalSec) / 60;
    const h = mins < 60 ? `${Math.round(mins)} min` : mins < 1440 ? `${+(mins / 60).toFixed(1)} h` : `${+(mins / 1440).toFixed(1)} days`;
    Object.assign(lastSummary, { shortTerm: { horizon: h, chanceOfProfitAfterCostsPct: Math.round(pProfit * 100), likelyResultUsd80pct: [Math.round(pnlAt(f.range80[0]) / rate), Math.round(pnlAt(f.range80[1]) / rate)], middleUsd: Math.round(pnlAt(f.mid) / rate) } });
    const worthLater = spend + feeIn + pnlAt(f.mid);   // what the position would be worth if sold at the most likely price
    tiles.push(`<div class="${pProfit >= 0.5 ? "bn-good" : "bn-bad"}"><span>Chance of profit in ~${h}</span><strong class="bn-big">${Math.round(pProfit * 100)}%</strong>
      <small class="muted">Most likely your ${+qty.toFixed(8)} ${fmt.esc(unit)} would be worth <strong class="${pnlAt(f.mid) >= 0 ? "up" : "down"}">${usd(worthLater)}</strong> after fees (you'd pay ${usd(spend)}) · forecast ${reliability(f.accuracy80).label}</small></div>`);
    tiles.push(`<div><span>Likely result in ~${h}</span>${big(pnlAt(f.mid))}<small class="muted">the most likely profit or loss after fees</small></div>`);
  }
  // Bad day
  const u = spend / rate;
  if (lt?.badDay != null) lastSummary.badDayUsd = Math.round(u * lt.badDay);
  if (lt?.hold) lastSummary.hold3Months = { endedHigherPct: Math.round(lt.hold.pUp * 100), typicalUsd: [Math.round(u * lt.hold.p10), Math.round(u * lt.hold.p90)], middleUsd: Math.round(u * lt.hold.median) };
  if (stop && target) lastSummary.withEntryvexStopTarget = { stop: +stop.toPrecision(8), target: +target.toPrecision(8), lossUsd: Math.round(pnlAt(Math.min(stop, price)) / rate), winUsd: Math.round(pnlAt(target) / rate) };
  if (lt?.badDay != null) {
    tiles.push(`<div><span>A bad day (1 in 20)</span>${big(spend * lt.badDay)}<small class="muted">price ${(lt.badDay * 100).toFixed(1)}% in a day; about ${Math.round(0.05 * (stock ? 252 : 365))} days a year were this bad or worse</small></div>`);
  }
  // Long term
  if (lt?.hold) {
    const h = lt.hold;
    tiles.push(`<div><span>Held ~3 months (history)</span><div class="bn-range">${big(spend * h.p10)}<span class="bn-to">to</span>${big(spend * h.p90)}</div><small class="muted">ended higher ${Math.round(h.pUp * 100)}% of the time · most likely ${money(spend * h.median)}</small></div>`);
  }
  // With Entryvex's stop/target
  if (stop && target) {
    const lossAtStop = pnlAt(Math.min(stop, price)), winAtTarget = pnlAt(target);
    tiles.push(`<div><span>With Entryvex's stop &amp; target</span><div class="bn-range">${big(lossAtStop)}<span class="bn-to">or</span>${big(winAtTarget)}</div><small class="muted">stop ${fmt.price(stop)} · target ${fmt.price(target)}</small></div>`);
  }

  // Warnings and verdict reminder
  const notes = [];
  if (foreign) notes.push(`<div class="note">Priced in ${fmt.esc(major[0])}: your result in dollars also moves with the exchange rate (if the dollar gets 5% stronger, your position is worth about 5% less in dollars). Check that your broker can trade on this exchange, and its currency-conversion fee.</div>`);
  if (/\.T$/.test(c.base)) notes.push(`<div class="note">Tokyo shares normally trade in lots of 100 (${usd(price * 100)} for one lot here). Some brokers offer single shares; check yours.</div>`);
  if (bal > 0 && spend / bal > 0.5) notes.push(`<div class="warn">That's ${Math.round((spend / bal) * 100)}% of your balance in one position. If it drops hard, it hits your whole account. Most traders keep single positions well below 25%.</div>`);
  else if (suggested?.ok && spend > suggested.spend * 1.5) notes.push(`<div class="note">This is more than Entryvex's suggested ${usd(suggested.spend)}: if price falls to the standard stop (${fmt.price(stop)}) you'd lose ${money(pnlAt(stop))}, more than your ${settings.riskPct}% limit.</div>`);
  const lvl = r?.overall?.level;
  const verdict = !r ? "" : r.liquidity && !r.liquidity.ok ? "Entryvex says DON'T BUY here: this market barely trades at this candle size."
    : lvl === "go" ? "Entryvex says BUY: a setup with a proven track record is active."
    : lvl === "caution" && r.best?.verdict.level === "weak" ? "Entryvex says SMALL BUY OR SKIP: only a weak edge is active."
    : "Entryvex currently says WAIT / DON'T BUY: buying now isn't backed by a measured edge. The numbers above show what's realistic if you buy anyway.";

  $("buynow").innerHTML = `<div class="bn-card">${header}
    <div class="bn-grid">${tiles.join("")}</div>
    ${notes.join("")}
    ${verdict ? `<p class="small bn-verdict">${verdict}</p>` : ""}
    <p class="tiny muted">All figures are measured from ${fmt.esc(c.base)}'s own price history and include fees and the bid/ask spread. They describe what has typically happened, not a guarantee.</p>
  </div>`;
}

/** A profit/loss amount in large type: green for a gain, red for a loss. */
function big(v) {
  return `<strong class="bn-big ${v >= 0 ? "up" : "down"}">${money(v)}</strong>`;
}
