// "Your money": balance, risk settings, the daily loss guard, the dollar trade card
// and a manual trade calculator. Everything is stored only in this browser.
import { sizePosition, roundTick } from "./sizing.js";
import * as fmt from "./format.js";

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
  bind("m-daily", "dailyPct", 3, 0.5, 50);

  $("m-log-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = parseFloat($("m-log-usd").value);
    if (!isFinite(v) || v === 0) return;
    const j = journal();
    j.results.push({ t: Date.now(), usd: v });
    saveJournal(j);
    $("m-log-usd").value = "";
    changed();
  });
  $("m-day").addEventListener("click", (e) => {
    if (e.target.closest("[data-undo]")) {
      const j = journal(); j.results.pop(); saveJournal(j); changed();
    }
  });
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

/* ---------------- Daily loss guard ---------------- */
function today() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function journal() {
  const j = store.get("journal", null);
  return j && j.date === today() ? j : { date: today(), results: [] };
}
function saveJournal(j) { store.set("journal", j); }

export function guard() {
  const j = journal();
  const pnl = j.results.reduce((s, r) => s + r.usd, 0);
  const limit = settings.balance * settings.dailyPct / 100;
  const losses = j.results.filter((r) => r.usd < 0).length;
  return { pnl, limit, trades: j.results.length, losses, locked: limit > 0 && pnl <= -limit };
}

function renderDay() {
  const g = guard();
  const el = $("m-day");
  const pnlCls = g.pnl > 0 ? "up" : g.pnl < 0 ? "down" : "";
  const used = g.limit > 0 ? Math.min(1, Math.max(0, -g.pnl / g.limit)) : 0;
  el.innerHTML = `
    <div class="day-line">
      <span>Today: <strong class="mono ${pnlCls}">${g.pnl >= 0 ? "+" : "−"}$${Math.abs(g.pnl).toFixed(2)}</strong>
      <span class="muted"> · ${g.trades} trade${g.trades === 1 ? "" : "s"} logged</span></span>
      ${g.limit > 0 ? `<span class="muted">Daily loss limit: <span class="mono">−$${g.limit.toFixed(2)}</span></span>` : `<span class="muted">Set a balance to turn on the daily loss limit.</span>`}
      ${g.trades ? `<button class="link-btn" data-undo>Undo last</button>` : ""}
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
  const bal = settings.balance;
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
  let warn = "";
  if (sz.reason === "too-small") warn = `<div class="warn">This trade would be smaller than Binance.US's minimum order (${c.quote} ${fmt.price(sz.minSpend)}). Increase your balance or risk %.</div>`;
  else if (sz.reason === "costs-eat-target") warn = `<div class="warn">Fees and spread are bigger than the profit target. This trade can't make money. Skip it.</div>`;
  else if (sz.capped) warn = `<div class="note">Capped at your full balance: the stop is so close that risking ${settings.riskPct}% would need more money than you have. Actual risk is $${sz.lossUsd.toFixed(2)}.</div>`;

  const ocoStopLimit = roundTick(sz.stop * 0.998, c.rules.tickSize);
  const q = `${trimQty(sz.qty)} ${fmt.esc(c.base)}`;

  return `<div class="card">
    <div class="card-title">Trade card · ${fmt.esc(c.setup.name)}</div>
    <div class="plan-grid">
      <div class="hl"><span>Buy</span><strong class="mono">${q}</strong><small class="muted">≈ $${sz.spend.toFixed(2)} · ${(sz.pctOfBalance * 100).toFixed(0)}% of balance</small></div>
      <div><span>If target hits</span><strong class="mono up">+$${sz.winUsd.toFixed(2)}</strong><small class="muted">after fees &amp; spread</small></div>
      <div><span>If stop hits</span><strong class="mono down">−$${sz.lossUsd.toFixed(2)}</strong><small class="muted">${(sz.lossUsd / bal * 100).toFixed(2)}% of balance</small></div>
      ${levels}
      <div><span>Average per trade (measured)</span><strong class="mono ${evUsd >= 0 ? "up" : "down"}">${evUsd >= 0 ? "+" : "−"}$${Math.abs(evUsd).toFixed(2)}</strong><small class="muted">from ${s.n} past trades</small></div>
      <div><span>Reward : risk</span><strong class="mono">${sz.rr.toFixed(2)} : 1</strong><small class="muted">needs ${Math.round(sz.breakevenWin * 100)}% wins to break even</small></div>
      <div><span>Usually resolves in</span><strong class="mono">${c.minutesToResolve ? humanMinutes(c.minutesToResolve) : "—"}</strong><small class="muted">exit at market after ${c.maxBarsText}</small></div>
    </div>
    ${warn}
    ${sz.ok ? `<details class="howto"><summary>How to place this on Binance.US</summary>
      <ol>
        <li>Open Binance.US → <strong>Trade</strong> (Advanced/Spot trading, not the simple Buy/Sell screen, which charges more) → <strong>${fmt.esc(c.base)}/${fmt.esc(c.quote)}</strong>.</li>
        <li><strong>Limit buy</strong> ${copyable(trimQty(sz.qty))} ${fmt.esc(c.base)} at price ${copyable(fmt.price(sz.entry).replace(/,/g, ""))}. A limit order is a "maker" order and usually pays 0% fee.</li>
        <li>Once it fills, place an <strong>OCO sell</strong> for the same amount: limit price (take-profit) ${copyable(plain(sz.target))}, stop ${copyable(plain(sz.stop))}, stop-limit ${copyable(plain(ocoStopLimit))}.</li>
        <li>Afterwards, log the result below ("Log a result") so the daily loss guard stays accurate.</li>
      </ol>
      <p class="small muted">Prices move. If the price has already run past the buy zone, skip it rather than chasing.</p>
    </details>` : ""}
  </div>`;
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
  const bal = settings.balance;
  if (!(bal > 0)) { out.innerHTML = `<p class="prompt">Enter your trading balance above to size a trade.</p>`; return; }
  const sz = sizePosition({
    balance: bal, riskPct: settings.riskPct,
    entry: parseFloat($("c-entry").value), stop: parseFloat($("c-stop").value), target: parseFloat($("c-target").value),
    costPerSide: ctx.costPerSide, rules: ctx.rules,
  });
  const msgs = { missing: "Fill in entry, stop and target.", "stop-above": "The stop must be below the entry (Binance.US spot is buy-then-sell only).", "target-below": "The target must be above the entry." };
  if (msgs[sz.reason]) { out.innerHTML = `<p class="prompt">${msgs[sz.reason]}</p>`; return; }
  out.innerHTML = `
    <div class="plan-grid">
      <div class="hl"><span>Buy</span><strong class="mono">${trimQty(sz.qty)} ${fmt.esc(ctx.base)}</strong><small class="muted">≈ $${sz.spend.toFixed(2)}</small></div>
      <div><span>If target hits</span><strong class="mono ${sz.winUsd >= 0 ? "up" : "down"}">${sz.winUsd >= 0 ? "+" : "−"}$${Math.abs(sz.winUsd).toFixed(2)}</strong></div>
      <div><span>If stop hits</span><strong class="mono down">−$${sz.lossUsd.toFixed(2)}</strong></div>
      <div><span>Reward : risk</span><strong class="mono">${sz.rr.toFixed(2)} : 1</strong></div>
      <div><span>Break-even win rate</span><strong class="mono">${Math.round(sz.breakevenWin * 100)}%</strong></div>
      <div><span>Costs (round trip)</span><strong class="mono">${(ctx.costPerSide * 200).toFixed(3)}%</strong></div>
    </div>
    ${sz.reason === "too-small" ? `<div class="warn">Below Binance.US's minimum order (${fmt.esc(ctx.quote)} ${fmt.price(sz.minSpend)}).</div>` : ""}
    ${sz.reason === "costs-eat-target" ? `<div class="warn">Fees and spread are bigger than this target. It can't make money.</div>` : ""}
    ${sz.capped ? `<div class="note">Capped at your full balance; actual risk is $${sz.lossUsd.toFixed(2)}.</div>` : ""}
    <p class="small muted">This calculator only does the math. Unlike the scanner, it has no measured track record behind it. You'd need to win at least ${Math.round(sz.breakevenWin * 100)}% of trades like this just to break even.</p>`;
}

function humanMinutes(m) {
  if (m < 60) return `~${Math.round(m)} min`;
  if (m < 1440) return `~${(m / 60).toFixed(m < 600 ? 1 : 0)} h`;
  return `~${(m / 1440).toFixed(1)} days`;
}
