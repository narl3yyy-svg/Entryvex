// "💼 My holdings": coins and stocks you already own (how many, what you paid). For each one,
// Entryvex gives one measured call and a concrete next step:
//   BUY MORE  – a setup with a winning record is active (with an amount sized to your account);
//   HOLD      – nothing strong either way (with a measured dip level to buy more at);
//   TRIM      – the trend is down with bearish odds: selling some and buying back lower is the
//               measured option (with the real costs of doing that spelled out);
// plus a one-click "alert me to buy more at $X". Everything stays in this browser.
import { getKlineHistory, isStock, stockInfo, get24h } from "./market.js";
import { analyzeAsync } from "./pool.js";
import { forecast } from "./forecast.js";
import { longTermStats } from "./longterm.js";
import { verdictFor } from "./opportunities.js";
import { loadEarningsCalendar, earningsFor, tradingDaysUntil } from "./earnings.js";
import { settings } from "./money.js";
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};
let holdings = store.get("holdings", []);   // [{ id, symbol, qty, cost, addedAt }]
const advice = new Map();                  // symbol → { t, a }
let hooks = { resolveSymbol: async () => null, currentSymbol: () => null, nameFor: (s) => s, onOpen: () => {}, ensureWatched: () => {}, addAlert: () => false, notify: () => {}, askAI: () => {}, getPrice: () => null };
let msg = "";

export function getHoldings() { return holdings.slice(); }
export function holdingOf(sym) { return holdings.find((h) => h.symbol === sym) || null; }
const save = () => store.set("holdings", holdings);

export function initHoldings(h) {
  hooks = { ...hooks, ...h };
  const el = $("tab-holdings");
  el.addEventListener("submit", async (e) => {
    if (e.target.id !== "hold-form") return;
    e.preventDefault();
    const raw = $("hold-sym").value.trim(), qty = parseFloat($("hold-qty").value), cost = parseFloat($("hold-cost").value);
    if (!raw || !(qty > 0) || !(cost > 0)) { msg = "Fill in the coin or stock, how many you own, and the price you paid for each."; render(); return; }
    msg = "Looking it up…"; render();
    const sym = await hooks.resolveSymbol(raw);
    if (!sym) { msg = `Couldn't find “${fmt.esc(raw)}”. Try the ticker (AAPL, BTC, SPY) or search for it in the watchlist first.`; render(); return; }
    const existing = holdings.find((x) => x.symbol === sym);
    if (existing) {   // buying more of the same: combine into one average price
      const q = existing.qty + qty;
      existing.cost = (existing.cost * existing.qty + cost * qty) / q;
      existing.qty = q;
      msg = `Added to your ${fmt.esc(hooks.nameFor(sym))}: you now own ${+q.toFixed(8)} at an average of ${fmt.price(existing.cost)}.`;
    } else {
      holdings.push({ id: Math.random().toString(36).slice(2, 9), symbol: sym, qty, cost, addedAt: Date.now() });
      msg = `Added ${fmt.esc(hooks.nameFor(sym))}. It's also on your watchlist now, so its price stays live.`;
    }
    hooks.ensureWatched(sym);
    save();
    advice.delete(sym);
    e.target.reset();
    render();
    refresh();
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "hold-use-current") { const s = hooks.currentSymbol(); if (s) $("hold-sym").value = s.replace(/^S:/, "").replace(/(USDT|USDC|USD)$/, ""); }
    if (b.dataset.holdOpen) hooks.onOpen(b.dataset.holdOpen);
    if (b.dataset.holdDel) { holdings = holdings.filter((x) => x.id !== b.dataset.holdDel); save(); render(); }
    if (b.dataset.holdAlert) {
      const [sym, dir, price] = b.dataset.holdAlert.split("|");
      if (hooks.addAlert(sym, dir, +price)) { b.textContent = "✓ Alert set"; b.disabled = true; hooks.notify({ kind: "info", symbol: sym, title: `Alert set: ${hooks.nameFor(sym)} ${dir} ${fmt.price(+price)}`, body: "You'll get a pop-up (and a phone or desktop notification if those are on) when it gets there." }); }
    }
    if (b.id === "hold-ask-ai") hooks.askAI("Review my holdings. For each one, should I buy more at the current price, hold, or sell some now and buy back lower? Use Entryvex's calls, the price levels and the risks.");
    if (b.id === "hold-refresh") { advice.clear(); render(); refresh(); }
  });
  render();
}
export function holdingsVisible(on) { if (on) { render(); refresh(); } }

/** Work out each holding's advice (daily chart; ~1–2 s per holding, cached 10 minutes). */
async function refresh() {
  for (const h of holdings) {
    const hit = advice.get(h.symbol);
    if (hit && Date.now() - hit.t < 10 * 60e3) continue;
    try { advice.set(h.symbol, { t: Date.now(), a: await adviseOne(h) }); } catch { advice.set(h.symbol, { t: Date.now(), a: { error: true } }); }
    render();
  }
}

async function adviseOne(h) {
  const sym = h.symbol, stock = isStock(sym);
  const daily = await getKlineHistory(sym, "1d", 1000);
  if (!daily?.length || daily.length < 60) return { error: true };
  let price = hooks.getPrice(sym);
  if (!(price > 0)) { try { price = (await get24h([sym]))[0]?.last; } catch {} }
  if (!(price > 0)) price = daily.at(-1).close;
  const r = daily.length > 260 ? await analyzeAsync(daily, { costPerSide: stock ? 0.0002 : 0.0005, useModel: false }) : null;
  const f = forecast(daily, 86400, 20);
  const lt = longTermStats(daily, stock);
  const v = verdictFor(sym);   // the watchlist check (1h, 4h, daily, plus the chart's candle size)
  let earn = null;
  if (stock) { try { await loadEarningsCalendar(); const e = earningsFor(sym); if (e?.next) earn = { date: e.next.date, days: tradingDaysUntil(e.next.date) }; } catch {} }

  const regime = r?.regime?.now || "unknown";
  const pUp = f?.pUp ?? null;
  const last = f?.bands?.at(-1);
  const dip = last ? last.q[1] : null;          // ~20 days out: price ended at or below this about 1 in 4 times
  const deep = f ? f.range80[0] : null;         // … and below this only about 1 in 10 times
  const buyNow = v?.level === "buy" || r?.overall?.level === "go";
  const bearish = regime === "down" && pUp != null && pUp < 0.47;
  const earningsSoon = earn && earn.days <= 3;

  // How much to add, if adding: risk your max-loss % if it falls to the "deep" level; never over 25% of your balance.
  let addUsd = null;
  if (settings.balance > 0 && deep && deep < price) {
    const stopDist = (price - deep) / price;
    addUsd = Math.min(settings.balance * 0.25, (settings.balance * settings.riskPct / 100) / stopDist);
  }
  const reasons = [];
  if (regime !== "unknown") reasons.push(regime === "down" ? "Daily trend: falling (price below its 200-day average)." : "Daily trend: rising (price above its 200-day average).");
  if (pUp != null) reasons.push(`Next ~20 days: ${Math.round(pUp * 100)}% chance of being higher (measured, ${Math.round((f.accuracy80 || 0) * 100)}% accurate range).`);
  if (lt?.hold) reasons.push(`Held ~3 months from moments like now, it ended higher ${Math.round(lt.hold.pUp * 100)}% of the time.`);
  if (v?.level === "buy") reasons.push(`Buy signal: ${v.label}.`);
  else if (v?.level === "watch") reasons.push(`A setup with a winning record exists here (${v.label}), not active yet.`);
  if (earn) reasons.push(`Earnings in ${earn.days} trading day${earn.days === 1 ? "" : "s"} (${earn.date}): prices often jump on the report.`);

  let call, cls, text;
  if (buyNow && !bearish && !earningsSoon) {
    call = "BUY MORE"; cls = "buy";
    text = `A setup with a winning record is active now. If you want more, ${addUsd ? `about <strong>$${addUsd.toFixed(0)}</strong> keeps your risk at your ${settings.riskPct}% max loss if it falls to ${fmt.price(deep)}` : "enter your trading balance to get a sized amount"}.`;
  } else if (bearish) {
    call = "TRIM"; cls = "sell";
    text = `The trend is down and the odds lean lower. <strong>Don't buy more yet.</strong> If you want to cut risk, sell part (for example a third) now and set an alert to buy back at <strong>${fmt.price(dip)}</strong>. `
      + `That only pays if it really dips there (it ended at or below that about 1 in 4 times), and selling then re-buying costs fees both ways${stock ? " plus tax on any gain in many countries" : " and possibly tax on gains"}. If you're holding for years, simply holding is often the cheaper choice.`;
  } else {
    call = "HOLD"; cls = "hold";
    text = earningsSoon ? `Earnings are days away, so wait until after the report before adding.`
      : regime === "down" ? `The daily trend is falling, so <strong>don't add yet</strong>: buying more just to lower your average price in a downtrend is a common, costly mistake. Keep what you have, set an alert at <strong>${fmt.price(dip)}</strong> to re-check, and add only when Entryvex shows a BUY signal${addUsd ? ` (about <strong>$${addUsd.toFixed(0)}</strong>)` : ""}.`
      : `Nothing strong either way right now. To add on a dip, set an alert at <strong>${fmt.price(dip)}</strong>${addUsd ? ` and add about <strong>$${addUsd.toFixed(0)}</strong> there` : ""}. If it falls below ${fmt.price(deep)} (it ended that low only about 1 in 10 times), re-check before doing anything.`;
  }
  return { price, call, cls, text, reasons, dip, deep, addUsd, regime, pUp, earn };
}

/** For the AI analyst. */
export function holdingsSnapshot() {
  if (!holdings.length) return null;
  return holdings.map((h) => {
    const a = advice.get(h.symbol)?.a;
    const price = a?.price || hooks.getPrice(h.symbol);
    return { symbol: h.symbol, name: hooks.nameFor(h.symbol), quantity: h.qty, pricePaid: h.cost, priceNow: price ?? null,
      profitPct: price ? +((price / h.cost - 1) * 100).toFixed(2) : null, entryvexCall: a?.call || "not checked yet", why: a?.reasons || [],
      buyMoreAlertLevel: a?.dip ?? null, deepDipLevel: a?.deep ?? null, suggestedAddUsd: a?.addUsd ? Math.round(a.addUsd) : null };
  });
}

function render() {
  const el = $("tab-holdings");
  if (!el) return;
  let totVal = 0, totCost = 0;
  const cards = holdings.map((h) => {
    const a = advice.get(h.symbol)?.a;
    const price = a?.price || hooks.getPrice(h.symbol);
    const val = price ? price * h.qty : null, costTot = h.cost * h.qty;
    if (val != null) { totVal += val; totCost += costTot; }
    const pl = val != null ? val - costTot : null, plPct = val != null ? val / costTot - 1 : null;
    const cur = isStock(h.symbol) ? stockInfo(h.symbol).currency : "USD";
    const pre = cur === "USD" ? "$" : cur + " ";
    return `<div class="hold-card">
      <div class="hold-top">
        <div><button class="link-btn hold-name" data-hold-open="${fmt.esc(h.symbol)}">${fmt.esc(hooks.nameFor(h.symbol))}</button>
          <div class="muted small">${+h.qty.toFixed(8)} × ${pre}${fmt.price(h.cost)} paid${price ? ` · now ${pre}${fmt.price(price)}` : ""}</div></div>
        <div class="hold-pl">${val != null ? `<strong class="${pl >= 0 ? "up" : "down"}">${pl >= 0 ? "+" : "−"}${pre}${Math.abs(pl).toFixed(2)}</strong><span class="${pl >= 0 ? "up" : "down"}">${pl >= 0 ? "+" : "−"}${Math.abs(plPct * 100).toFixed(2)}%</span><small class="muted">worth ${pre}${val.toFixed(2)}</small>` : `<span class="muted small">price loading…</span>`}</div>
      </div>
      ${a?.error ? `<p class="muted small">Not enough price history to advise on this one.</p>`
        : a ? `<div class="hold-call d-${a.cls}"><strong>${a.call}</strong><span>${a.text}</span></div>
          <ul class="hold-why small muted">${a.reasons.map((x) => `<li>${fmt.esc(x)}</li>`).join("")}</ul>
          <div class="simple-actions">
            ${a.dip ? `<button class="btn" data-hold-alert="${fmt.esc(h.symbol)}|below|${a.dip}">🔔 Alert me ${a.call === "TRIM" ? "to buy back" : a.regime === "down" ? "to re-check" : "to buy more"} at ${pre}${fmt.price(a.dip)}</button>` : ""}
            <button class="ghost-btn" data-hold-open="${fmt.esc(h.symbol)}">Open chart</button>
            <button class="link-btn small" data-hold-del="${fmt.esc(h.id)}">Remove</button>
          </div>`
        : `<p class="muted small"><span class="typing"><i></i><i></i><i></i></span> Checking its chart, trend, odds and news…</p>`}
    </div>`;
  }).join("");
  const totPl = totVal - totCost;
  el.innerHTML = `
    <div class="hold-head">
      <div><h3>💼 My holdings</h3><p class="muted small">Coins and stocks you already own. Entryvex checks each one and tells you whether to buy more now, hold, or trim and buy back lower, with an alert for the price to act at. Stored only in this browser.</p></div>
      ${holdings.length ? `<div class="hold-total"><span>Total</span><strong>$${totVal.toFixed(2)}</strong><small class="${totPl >= 0 ? "up" : "down"}">${totPl >= 0 ? "+" : "−"}$${Math.abs(totPl).toFixed(2)} (${totCost ? ((totPl / totCost) * 100).toFixed(2) : "0.00"}%)</small></div>` : ""}
    </div>
    <form id="hold-form" class="hold-form" autocomplete="off">
      <label><span>Coin or stock</span><input id="hold-sym" placeholder="BTC, AAPL, SPY…" spellcheck="false" /></label>
      <label><span>How many you own</span><input id="hold-qty" type="number" step="any" min="0" inputmode="decimal" placeholder="e.g. 10" /></label>
      <label><span>Price you paid (each)</span><input id="hold-cost" type="number" step="any" min="0" inputmode="decimal" placeholder="e.g. 150" /></label>
      <div class="hold-form-btns"><button class="btn" type="submit">Add holding</button><button class="link-btn small" type="button" id="hold-use-current">Use the chart's market</button></div>
    </form>
    ${msg ? `<p class="small note">${msg}</p>` : ""}
    ${holdings.length ? `<div class="hold-list">${cards}</div>
      <div class="simple-actions"><button class="btn" id="hold-ask-ai">🤖 Ask the AI about my holdings</button><button class="link-btn small" id="hold-refresh">Re-check all</button></div>
      <p class="tiny muted">Calls use each market's daily chart: Entryvex's setups and their record, the trend, the measured 20-day price range, 3-month history, signals on other candle sizes and (stocks) earnings dates. They describe measured odds, not certainties. Not financial advice.</p>`
      : `<p class="muted small">Nothing added yet. Enter something you own above.</p>`}`;
}
