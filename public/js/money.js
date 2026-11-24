// "Your money": balance, risk settings, the daily loss guard, the dollar trade card
// and a manual trade calculator. Everything is stored only in this browser.
import { sizePosition, roundTick } from "./sizing.js";
import { todayStats, onJournalChange, practiceBalance, PRACTICE_START } from "./journal.js";
import { isStock, stockInfo } from "./market.js";
import * as fmt from "./format.js";
import { fxRate, loadFx, money as fxMoney } from "./fx.js";

/**
 * The account in a market's own currency: the USD balance converted at the live exchange rate.
 * M(v, sign) formats an amount in that currency (with ≈ US dollars for non-USD markets).
 */
function account(symbol) {
  const cur = isStock(symbol) ? stockInfo(symbol).currency : "USD";
  const rate = cur === "USD" ? 1 : fxRate(cur);
  if (!rate) loadFx(cur).then((r) => { if (r) rerender(); });
  const M = (v, sign = "") => (cur === "USD" ? `${sign}$${Math.abs(v).toFixed(2)}` : `${sign}${fxMoney(Math.abs(v), cur, rate)}`);
  return { cur, rate, foreign: cur !== "USD", bal: rate ? settings.balance * rate : 0, M };
}
const rerender = () => renderCalc();

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};

const listeners = new Set();
let ctx = null; // latest market context from the scanner

export const settings = {
  get balance() { return +store.get("balance", 0) || 0; },
  get riskPct() { return +store.get("riskPct", 1) || 1; },
  get dailyPct() { return +store.get("dailyPct", 3) || 3; },
};

export function onMoneyChange(fn) { listeners.add(fn); }
function changed() { renderDay(); renderCalc(); listeners.forEach((fn) => fn()); }

/* ---------------- Settings inputs ---------------- */
export function initMoney() {
  bind("m-balance", "balance", 0, 0, 1e9);
  bind("m-risk", "riskPct", 1, 0.1, 10);

  // Fee presets: plain-language choices that set the % fee the scanner and sizing use.
  const preset = $("fee-preset"), fee = $("fee"), customBox = document.querySelector(".fee-custom");
  const current = String(store.get("feePct", 0.02));
  const match = [...preset.options].find((o) => o.value === current);
  preset.value = match ? current : "custom";
  customBox.hidden = preset.value !== "custom";
  preset.addEventListener("change", () => {
    customBox.hidden = preset.value !== "custom";
    if (preset.value !== "custom") {
      fee.value = preset.value;
      fee.dispatchEvent(new Event("change"));
    } else fee.focus();
  });
  onJournalChange(changed);
  $("calc").addEventListener("toggle", () => { if ($("calc").open) prefillCalc(true); });
  ["c-entry", "c-stop", "c-target"].forEach((id) => $(id).addEventListener("input", renderCalc));
  $("c-reset").addEventListener("click", (e) => { e.preventDefault(); prefillCalc(true); });
  renderDay();
}

function bind(id, key, def, min, max) {
  const el = $(id);
  const v = store.get(key, def);
  el.value = v || "";
  el.addEventListener("change", () => {
    let n = parseFloat(el.value);
    if (!isFinite(n)) n = key === "balance" ? 0 : def;
    n = Math.max(min, Math.min(max, n));
    el.value = n || "";
    store.set(key, n);
    changed();
  });
}

/* ---------------- Daily loss guard (fed by My trades) ---------------- */
export function guard() {
  const d = todayStats();
  const limit = settings.balance * settings.dailyPct / 100;
  // The daily stop setting was removed from the page, so it never locks trading now.
  return { pnl: d.pnl, limit, trades: d.trades, open: d.open, losses: d.losses, locked: false };
}

function renderDay() {
  const el = $("m-day");
  if (!el) return;
  const g = guard();
  const pnlCls = g.pnl > 0 ? "up" : g.pnl < 0 ? "down" : "";
  const used = g.limit > 0 ? Math.min(1, Math.max(0, -g.pnl / g.limit)) : 0;
  el.innerHTML = `
    <div class="day-line">
      <span>Today: <strong class="mono ${pnlCls}">${g.pnl >= 0 ? "+" : "−"}$${Math.abs(g.pnl).toFixed(2)}</strong>
      <span class="muted"> · ${g.trades} closed${g.open ? ` · ${g.open} open` : ""} (from My trades)</span></span>
      ${g.limit > 0 ? `<span class="muted">Stop for the day at <span class="mono">−$${g.limit.toFixed(2)}</span></span>` : `<span class="muted">Enter your balance to turn on the daily stop.</span>`}
    </div>
    ${g.limit > 0 ? `<div class="limit-bar ${g.locked ? "hit" : used > 0.66 ? "near" : ""}"><i style="width:${(used * 100).toFixed(1)}%"></i></div>` : ""}
    ${g.locked ? `<div class="guard-stop"><strong>Daily loss limit reached.</strong> You're down $${Math.abs(g.pnl).toFixed(2)} today. Stop trading for today. Tomorrow resets automatically.</div>` : ""}`;
}

/* ---------------- Trade card (for an active setup) ---------------- */
/**
 * @param c { plan, setup, costPerSide, rules, base, quote, price, interval, minutesToResolve, verdictLevel }
 */
export function renderTradeCard(c) {
  const g = guard();
  // Never size a non-US-dollar market with a USD balance: show the levels only.
  // Non-USD markets: size with the USD balance converted at the live exchange rate.
  const { bal, M } = account(c.symbol);
  const pct = (v) => (v * 100).toFixed(2) + "%";

  if (g.locked) {
    return `<div class="card card-stop"><strong>Trade card hidden: daily loss limit reached.</strong> A setup is active, but you've hit today's limit. Sitting out protects your account.</div>`;
  }

  const sz = bal > 0 ? sizePosition({
    balance: bal, riskPct: settings.riskPct, entry: c.plan.entry, stop: c.plan.stop, target: c.plan.target,
    costPerSide: c.costPerSide, rules: c.rules,
  }) : null;

  const levels = `
    <div><span>Buy around</span><strong class="mono">${fmt.price(sz?.entry ?? c.plan.entry)}</strong></div>
    <div><span>Take profit</span><strong class="mono up">${fmt.price(sz?.target ?? c.plan.target)} <small>(+${pct(c.plan.targetPct)})</small></strong></div>
    <div><span>Stop-loss</span><strong class="mono down">${fmt.price(sz?.stop ?? c.plan.stop)} <small>(−${pct(c.plan.stopPct)})</small></strong></div>`;

  if (!sz) {
    return `<div class="card">
      <div class="card-title">Trade card · ${fmt.esc(c.setup.name)}</div>
      <div class="plan-grid">${levels}</div>
      <p class="prompt">Enter your <strong>trading balance</strong> above and Entryvex will tell you exactly how much to buy and what you'd make or lose in dollars.</p>
    </div>`;
  }

  const evUsd = c.setup.stats.ev * sz.spend;
  const s = c.setup.stats;
  const stock = isStock(c.symbol);
  let warn = "";
  if (sz.reason === "too-small") warn = stock
    ? `<div class="warn">One share (${M(sz.entry)}) costs more than this trade's size allows. Increase your balance or max loss %, or pick a cheaper stock.</div>`
    : `<div class="warn">This trade would be smaller than Binance.US's minimum order (${c.quote} ${fmt.price(sz.minSpend)}). Increase your balance or risk %.</div>`;
  else if (sz.reason === "costs-eat-target") warn = `<div class="warn">Fees and spread are bigger than the profit target. This trade can't make money. Skip it.</div>`;
  else if (sz.capped) warn = `<div class="note">Capped at 25% of your balance so one position can't dominate your account (the stop is close, so risking the full ${settings.riskPct}% would need more). Actual risk is ${M(sz.lossUsd)}.</div>`;

  const ocoStopLimit = roundTick(sz.stop * 0.998, c.rules.tickSize);
  const q = stock ? `${trimQty(sz.qty)} share${sz.qty === 1 ? "" : "s"} of ${fmt.esc(c.base)}` : `${trimQty(sz.qty)} ${fmt.esc(c.base)}`;
  const steps = stock ? `<details class="howto"><summary>How to place this at your broker (Schwab, Fidelity, Robinhood…)</summary>
      <ol>
        <li>Open your broker's app or website → <strong>Trade → Stocks &amp; ETFs</strong> → symbol <strong>${fmt.esc(c.base)}</strong>. US stock trades have $0 commission at most big brokers.</li>
        <li><strong>Buy</strong> ${copyable(trimQty(sz.qty))} shares as a <strong>limit order</strong> at ${copyable(plain(sz.entry))}, time-in-force <strong>Day</strong>. ${account(c.symbol).foreign ? "Only while that exchange is open (local market hours)." : "Only during market hours (9:30am–4pm New York time)."}</li>
        <li>Once it fills, protect it with a <strong>One-Cancels-Other (OCO)</strong> sell for the same ${trimQty(sz.qty)} shares: a <strong>limit sell</strong> at ${copyable(plain(sz.target))} (take-profit) and a <strong>stop sell</strong> at ${copyable(plain(sz.stop))} (stop-loss). Schwab lists this under conditional orders; other brokers call it OCO or a bracket order. If your broker doesn't offer it, at least place the stop sell.</li>
        <li>Click <strong>I took this trade</strong> below so Entryvex tracks it in My trades and records the result automatically.</li>
      </ol>
      <p class="small muted">Stocks can jump overnight: a stop-loss can fill below your stop price if the stock opens lower ("gap down").</p>
    </details>` : null;

  return `<div class="card">
    <div class="card-title">Trade card · ${fmt.esc(c.setup.name)}</div>
    <div class="plan-grid">
      <div class="hl"><span>Buy</span><strong class="mono">${q}</strong><small class="muted">≈ ${M(sz.spend)} · ${(sz.pctOfBalance * 100).toFixed(0)}% of balance</small></div>
      <div><span>If target hits</span><strong class="mono up">${M(sz.winUsd, "+")}</strong><small class="muted">after fees &amp; spread</small></div>
      <div><span>If stop hits</span><strong class="mono down">${M(sz.lossUsd, "−")}</strong><small class="muted">${(sz.lossUsd / bal * 100).toFixed(2)}% of balance</small></div>
      ${levels}
      <div><span>Average per trade (measured)</span><strong class="mono ${evUsd >= 0 ? "up" : "down"}">${M(evUsd, evUsd >= 0 ? "+" : "−")}</strong><small class="muted">from ${s.n} past trades</small></div>
      <div><span>Reward : risk</span><strong class="mono">${sz.rr.toFixed(2)} : 1</strong><small class="muted">needs ${Math.round(sz.breakevenWin * 100)}% wins to break even</small></div>
      <div><span>Usually resolves in</span><strong class="mono">${c.minutesToResolve ? humanMinutes(c.minutesToResolve) : "—"}</strong><small class="muted">exit at market after ${c.maxBarsText}</small></div>
    </div>
    ${warn}
    ${sz.ok ? `${steps ?? `<details class="howto"><summary>How to place this on Binance.US</summary>
      <ol>
        <li>Open Binance.US → <strong>Trade</strong> (Advanced/Spot trading, not the simple Buy/Sell screen, which charges more) → <strong>${fmt.esc(c.base)}/${fmt.esc(c.quote)}</strong>.</li>
        <li><strong>Limit buy</strong> ${copyable(trimQty(sz.qty))} ${fmt.esc(c.base)} at price ${copyable(fmt.price(sz.entry).replace(/,/g, ""))}. A limit order is a "maker" order and usually pays 0% fee.</li>
        <li>Once it fills, place an <strong>OCO sell</strong> for the same amount: limit price (take-profit) ${copyable(plain(sz.target))}, stop ${copyable(plain(sz.stop))}, stop-limit ${copyable(plain(ocoStopLimit))}.</li>
        <li>Click <strong>I took this trade</strong> below so Entryvex tracks it in My trades and records the result automatically.</li>
      </ol>
      <p class="small muted">Prices move. If the price has already run past the buy zone, skip it rather than chasing.</p>
    </details>`}
    <div class="take-row">${takeButton({ symbol: c.symbol, entry: sz.entry, stop: sz.stop, target: sz.target, qty: sz.qty, setup: c.setup.name, verdict: c.verdictLevel, interval: c.interval, source: "entryvex" })}
      <span class="muted small">Only after you've actually placed the order.</span></div>` : ""}
    ${account(c.symbol).foreign ? "" : `<div class="take-row">${practiceButton({ symbol: c.symbol, entry: c.plan.entry, stop: c.plan.stop, target: c.plan.target, setup: c.setup.name, verdict: c.verdictLevel, interval: c.interval }, c.costPerSide, c.rules)}
      <span class="muted small">Not ready to use real money? Try it with pretend money first.</span></div>`}
  </div>`;
}

function takeButton(d) {
  return `<button class="btn take-trade" data-take='${fmt.esc(JSON.stringify(d))}'>✓ I took this trade</button>`;
}
/** "Practice this trade": the same plan, sized for the $1,000 practice account (see journal.js). */
export function practiceButton(d, costPerSide, rules) {
  const bal = practiceBalance();
  // Fractional units are fine with pretend money (and many brokers sell fractional shares).
  const r = { ...(rules || {}), stepSize: 1e-8, minQty: 0, minNotional: 1, tickSize: rules?.tickSize || 1e-8 };
  const sz = bal > 0 ? sizePosition({ balance: bal, riskPct: settings.riskPct || 1, entry: d.entry, stop: d.stop, target: d.target, costPerSide, rules: r }) : null;
  if (!sz?.ok) return "";
  return `<button class="ghost-btn take-trade" data-take='${fmt.esc(JSON.stringify({ ...d, entry: sz.entry, stop: sz.stop, target: sz.target, qty: sz.qty, practice: true, source: "practice" }))}' title="Buy it with pretend money in your $${PRACTICE_START} practice account">🎮 Practice this trade</button>`;
}

function copyable(v) { return `<button class="copy mono" data-copy="${fmt.esc(v)}" title="Copy">${fmt.esc(v)}</button>`; }
function plain(v) { return fmt.price(v).replace(/,/g, ""); }
function trimQty(q) { return String(+q.toFixed(8)); }

document.addEventListener("click", (e) => {
  const b = e.target.closest("button.copy");
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => {
    b.classList.add("copied"); setTimeout(() => b.classList.remove("copied"), 900);
  }).catch(() => {});
});

/* ---------------- Manual calculator ---------------- */
export function setMarketContext(c) {
  const symbolChanged = !ctx || ctx.symbol !== c.symbol;
  ctx = c;
  if ($("calc").open && symbolChanged) prefillCalc(true);
  else renderCalc();
}

function prefillCalc(force) {
  if (!ctx) return;
  const t = ctx.rules.tickSize;
  if (force || !$("c-entry").value) {
    const p = ctx.price;
    const stop = ctx.atr ? p - ctx.atr : p * 0.99;
    const target = ctx.atr ? p + 1.5 * ctx.atr : p * 1.015;
    $("c-entry").value = plain(roundTick(p, t));
    $("c-stop").value = plain(roundTick(stop, t));
    $("c-target").value = plain(roundTick(target, t));
  }
  renderCalc();
}

function renderCalc() {
  const out = $("c-out");
  if (!out || !ctx) return;
  $("c-pair").textContent = `${ctx.base}/${ctx.quote}`;
  const { bal, M, rate } = account(ctx.symbol);
  if (!(settings.balance > 0)) { out.innerHTML = `<p class="prompt">Enter your trading balance above to size a trade.</p>`; return; }
  if (!rate) { out.innerHTML = `<p class="prompt">Loading the exchange rate to convert your balance…</p>`; return; }
  const sz = sizePosition({
    balance: bal, riskPct: settings.riskPct,
    entry: parseFloat($("c-entry").value), stop: parseFloat($("c-stop").value), target: parseFloat($("c-target").value),
    costPerSide: ctx.costPerSide, rules: ctx.rules,
  });
  const msgs = { missing: "Fill in entry, stop and target.", "stop-above": "The stop must be below the entry (Binance.US spot is buy-then-sell only).", "target-below": "The target must be above the entry." };
  if (msgs[sz.reason]) { out.innerHTML = `<p class="prompt">${msgs[sz.reason]}</p>`; return; }
  out.innerHTML = `
    <div class="plan-grid">
      <div class="hl"><span>Buy</span><strong class="mono">${trimQty(sz.qty)} ${fmt.esc(ctx.base)}</strong><small class="muted">≈ ${M(sz.spend)}</small></div>
      <div><span>If target hits</span><strong class="mono ${sz.winUsd >= 0 ? "up" : "down"}">${M(sz.winUsd, sz.winUsd >= 0 ? "+" : "−")}</strong></div>
      <div><span>If stop hits</span><strong class="mono down">${M(sz.lossUsd, "−")}</strong></div>
      <div><span>Reward : risk</span><strong class="mono">${sz.rr.toFixed(2)} : 1</strong></div>
      <div><span>Break-even win rate</span><strong class="mono">${Math.round(sz.breakevenWin * 100)}%</strong></div>
      <div><span>Costs (round trip)</span><strong class="mono">${(ctx.costPerSide * 200).toFixed(3)}%</strong></div>
    </div>
    ${sz.reason === "too-small" ? `<div class="warn">Below Binance.US's minimum order (${fmt.esc(ctx.quote)} ${fmt.price(sz.minSpend)}).</div>` : ""}
    ${sz.reason === "costs-eat-target" ? `<div class="warn">Fees and spread are bigger than this target. It can't make money.</div>` : ""}
    ${sz.capped ? `<div class="note">Capped at 25% of your balance (one-position limit); actual risk is ${M(sz.lossUsd)}.</div>` : ""}
    <p class="small muted">This calculator only does the math. Unlike the scanner, it has no measured track record behind it. You'd need to win at least ${Math.round(sz.breakevenWin * 100)}% of trades like this just to break even.</p>
    ${sz.ok ? `<div class="take-row">${takeButton({ symbol: ctx.symbol, entry: sz.entry, stop: sz.stop, target: sz.target, qty: sz.qty, setup: "My own plan", source: "calculator" })}
      <span class="muted small">Adds it to My trades so Entryvex tracks the result.</span></div>` : ""}`;
}

function humanMinutes(m) {
  if (m < 60) return `~${Math.round(m)} min`;
  if (m < 1440) return `~${(m / 60).toFixed(m < 600 ? 1 : 0)} h`;
  return `~${(m / 1440).toFixed(1)} days`;
}
