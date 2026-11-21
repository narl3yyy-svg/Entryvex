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
import { isStock } from "./market.js";
import { RULES } from "./engine.js";
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
let ctx = null;
let lastSummary = null;
/** The latest "If you buy now" numbers (for the AI analyst). */
export function getBuyNowSummary() { return lastSummary && lastSummary.symbol === ctx?.symbol ? lastSummary : null; }
let amountMode = sessionStorage.getItem("evx.bnMode") || "suggested";   // "suggested" | "custom" | "10" | "25"
let customAmount = +(sessionStorage.getItem("evx.bnAmount") || 0);

const money = (v) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 })}`;
const usd = (v) => `$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 })}`;

export function initBuyNow() {
  const el = $("buynow");
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-amt]");
    if (!b) return;
    amountMode = b.dataset.amt;
    sessionStorage.setItem("evx.bnMode", amountMode);
    render();
  });
  el.addEventListener("input", (e) => {
    if (e.target.id !== "bn-amount") return;
    customAmount = parseFloat(e.target.value) || 0;
    amountMode = "custom";
    sessionStorage.setItem("evx.bnMode", amountMode);
    sessionStorage.setItem("evx.bnAmount", String(customAmount));
    render(true);
  });
}

/** c: { symbol, base, name, interval, price, analysis, forecast, rules } */
export function updateBuyNow(c) { ctx = c; render(); }

function render(keepFocus = false) {
  const el = $("buynow");
  if (!el || !ctx || !ctx.price) return;
  const c = ctx, r = c.analysis, f = c.forecast, lt = cachedLongTerm(c.symbol);
  const stock = isStock(c.symbol);
  const unit = stock ? "shares" : c.base;
  const bal = settings.balance;
  const price = c.price;
  const cost = r?.costPerSide ?? 0.0007;           // fee + half the bid/ask spread, per side
  const atr = r?.atr;

  // Entryvex's suggested amount: risk your "max loss per trade" if price falls 1 ATR (its standard stop).
  const stop = atr ? price - RULES.stopAtr * atr : null;
  const target = atr ? price + RULES.targetAtr * atr : null;
  const suggested = bal > 0 && stop ? sizePosition({ balance: bal, riskPct: settings.riskPct, entry: price, stop, target, costPerSide: cost, rules: c.rules }) : null;

  let amount = 0;
  if (amountMode === "suggested") amount = suggested?.spend || 0;
  else if (amountMode === "10") amount = bal * 0.10;
  else if (amountMode === "25") amount = bal * 0.25;
  else amount = customAmount;
  if (bal > 0) amount = Math.min(amount, bal);

  // Quantity the exchange will actually accept.
  let qty = amount > 0 ? floorStep(amount / price, c.rules?.stepSize || (stock ? 1 : 0)) : 0;
  const spend = qty * price;
  const feeIn = spend * cost;
  const breakeven = price * (1 + cost) / (1 - cost);
  const pnlAt = (px) => qty * px * (1 - cost) - spend - feeIn;

  const amountInput = keepFocus && document.activeElement?.id === "bn-amount";
  const inputVal = amountMode === "custom" ? customAmount || "" : Math.round(amount) || "";

  const header = `
    <div class="bn-head">
      <div><div class="d-when-title">If you buy ${fmt.esc(c.base)} now at ${stock ? "$" : ""}${fmt.price(price)}</div>
        <div class="muted small">${bal > 0 ? `Your balance: ${usd(bal)} · max loss per trade ${settings.riskPct}%` : "Enter your trading balance above to see dollar amounts for your account."}</div></div>
      <div class="bn-amount">
        <span class="inp"><em>$</em><input id="bn-amount" type="number" min="0" step="any" inputmode="decimal" placeholder="amount" value="${inputVal}" /></span>
        <div class="seg small-seg">
          <button data-amt="suggested" class="${amountMode === "suggested" ? "on" : ""}" title="Sized so Entryvex's standard stop-loss would lose your max-loss %">Entryvex size</button>
          <button data-amt="10" class="${amountMode === "10" ? "on" : ""}">10%</button>
          <button data-amt="25" class="${amountMode === "25" ? "on" : ""}">25%</button>
        </div>
      </div>
    </div>`;

  if (!(qty > 0)) {
    $("buynow").innerHTML = `<div class="bn-card">${header}<p class="small muted">${bal > 0 ? (stock && amount > 0 && amount < price ? `That's less than one share (${usd(price)}). Increase the amount.` : "Choose an amount to see what would happen.") : ""}</p></div>`;
    restoreFocus(amountInput);
    return;
  }

  lastSummary = { symbol: c.symbol, amountUsd: +spend.toFixed(2), quantity: +qty.toFixed(8), unit, pctOfBalance: bal > 0 ? +((spend / bal) * 100).toFixed(1) : null,
    feesEachWayUsd: +feeIn.toFixed(2), breakevenPrice: +breakeven.toPrecision(8) };
  const tiles = [];
  // Basics
  tiles.push(`<div><span>You'd get</span><strong class="mono">${+qty.toFixed(8)} ${fmt.esc(unit)}</strong><small class="muted">${usd(spend)}${bal > 0 ? ` · ${Math.round((spend / bal) * 100)}% of balance` : ""} · fees ≈ ${usd(feeIn)} each way</small></div>`);
  tiles.push(`<div><span>Break-even price</span><strong class="mono">${fmt.price(breakeven)}</strong><small class="muted">it must rise ${(((breakeven / price) - 1) * 100).toFixed(2)}% just to cover fees &amp; spread</small></div>`);

  // Short term: tested forecast
  if (f && f.symbol === c.symbol) {
    const pProfit = probAbove(f, breakeven);
    const mins = (f.H * f.intervalSec) / 60;
    const h = mins < 60 ? `${Math.round(mins)} min` : mins < 1440 ? `${+(mins / 60).toFixed(1)} h` : `${+(mins / 1440).toFixed(1)} days`;
    Object.assign(lastSummary, { shortTerm: { horizon: h, chanceOfProfitAfterCostsPct: Math.round(pProfit * 100), likelyResultUsd80pct: [Math.round(pnlAt(f.range80[0])), Math.round(pnlAt(f.range80[1]))], middleUsd: Math.round(pnlAt(f.mid)) } });
    tiles.push(`<div class="${pProfit >= 0.5 ? "bn-good" : "bn-bad"}"><span>Chance of profit in ~${h}</span><strong class="mono">${Math.round(pProfit * 100)}%</strong><small class="muted">after costs · forecast ${reliability(f.accuracy80).label}</small></div>`);
    tiles.push(`<div><span>Likely result in ~${h} (80%)</span><strong class="mono"><span class="down">${money(pnlAt(f.range80[0]))}</span> to <span class="up">${money(pnlAt(f.range80[1]))}</span></strong><small class="muted">middle ${money(pnlAt(f.mid))}</small></div>`);
  }
  // Bad day
  if (lt?.badDay != null) lastSummary.badDayUsd = Math.round(spend * lt.badDay);
  if (lt?.hold) lastSummary.hold3Months = { endedHigherPct: Math.round(lt.hold.pUp * 100), typicalUsd: [Math.round(spend * lt.hold.p10), Math.round(spend * lt.hold.p90)], middleUsd: Math.round(spend * lt.hold.median) };
  if (stop && target) lastSummary.withEntryvexStopTarget = { stop: +stop.toPrecision(8), target: +target.toPrecision(8), lossUsd: Math.round(pnlAt(Math.min(stop, price))), winUsd: Math.round(pnlAt(target)) };
  if (lt?.badDay != null) {
    tiles.push(`<div><span>A bad day (1 in 20)</span><strong class="mono down">${money(spend * lt.badDay)}</strong><small class="muted">price ${(lt.badDay * 100).toFixed(1)}% in a day; about ${Math.round(0.05 * (stock ? 252 : 365))} days a year were this bad or worse</small></div>`);
  }
  // Long term
  if (lt?.hold) {
    const h = lt.hold;
    tiles.push(`<div><span>Held ~3 months (history)</span><strong class="mono"><span class="down">${money(spend * h.p10)}</span> to <span class="up">${money(spend * h.p90)}</span></strong><small class="muted">ended higher ${Math.round(h.pUp * 100)}% of the time · middle ${money(spend * h.median)}</small></div>`);
  }
  // With Entryvex's stop/target
  if (stop && target) {
    const lossAtStop = pnlAt(Math.min(stop, price)), winAtTarget = pnlAt(target);
    tiles.push(`<div><span>With Entryvex's stop &amp; target</span><strong class="mono"><span class="down">${money(lossAtStop)}</span> / <span class="up">${money(winAtTarget)}</span></strong><small class="muted">stop ${fmt.price(stop)} · target ${fmt.price(target)}</small></div>`);
  }

  // Warnings and verdict reminder
  const notes = [];
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
  restoreFocus(amountInput);
}

function restoreFocus(had) {
  if (!had) return;
  const i = $("bn-amount");
  if (i) { i.focus(); const v = i.value; i.value = ""; i.value = v; }
}
