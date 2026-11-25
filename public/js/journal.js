// My Trades: a journal of the trades YOU place. Click "I took this trade" on a trade card
// (or add one by hand); Entryvex follows the live price and records the result itself
// when your take-profit or stop-loss is hit, or when you close it. Stored only in this browser.
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};

let trades = store.get("trades", []);
const listeners = new Set();
let hooks = { getWatchlist: () => [], ensureWatched: () => {}, getInfo: () => null, getPrice: () => null, onPick: () => {}, notify: () => {} };

export function onJournalChange(fn) { listeners.add(fn); }
function save() { store.set("trades", trades); listeners.forEach((fn) => fn()); render(); }
const feeRate = () => (+store.get("feePct", 0.02) || 0) / 100;
const baseOf = (s) => hooks.getInfo(s)?.base ?? s.replace(/(USDT|USDC|USD)$/, "");

export function openTrades() { return trades.filter((t) => t.status === "open"); }

/* ---------- Practice account: pretend money, real prices ---------- */
// "Practice this trade" puts a BUY signal into a virtual $1,000 account, so a new user can see how
// following Entryvex would have gone before risking anything. Practice trades never count toward
// the daily loss guard or the real results.
export const PRACTICE_START = 1000;
export function practiceBalance() {
  const since = +store.get("practiceFrom", 0);
  return PRACTICE_START + trades.filter((t) => t.practice && t.status === "closed" && t.openedAt >= since).reduce((s, t) => s + t.pnl, 0);
}

/** P&L after fees for a closed trade (or an open one at `price`). */
function pnl(t, exit) {
  const gross = (exit - t.entry) * t.qty;
  const fees = t.fee * (t.entry * t.qty + exit * t.qty);
  return gross - fees;
}

/* ---------- Day stats (used by the daily loss guard) ---------- */
function sameDay(a, b) { const x = new Date(a), y = new Date(b); return x.toDateString() === y.toDateString(); }
export function todayStats() {
  const now = Date.now();
  const closed = trades.filter((t) => !t.practice && t.status === "closed" && sameDay(t.closedAt, now));
  return { pnl: closed.reduce((s, t) => s + t.pnl, 0), trades: closed.length, open: openTrades().filter((t) => !t.practice).length, losses: closed.filter((t) => t.pnl < 0).length };
}

/* ---------- Adding / closing ---------- */
export function addTrade(t) {
  const trade = {
    id: Math.random().toString(36).slice(2, 10),
    symbol: t.symbol, entry: +t.entry, qty: +t.qty,
    stop: t.stop ? +t.stop : null, target: t.target ? +t.target : null,
    trail: t.trail > 0 ? +t.trail : null, hi: +t.entry, firstStop: t.stop ? +t.stop : null,
    setup: t.setup || null, verdict: t.verdict || null, interval: t.interval || null,
    source: t.source || "manual", fee: feeRate(), practice: !!t.practice,
    openedAt: Date.now(), status: "open",
  };
  // Entryvex's plan has a time limit: if neither level is hit within 24 candles, sell at market.
  const sec = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 }[trade.interval];
  // Trend trades (trailing stop) have no time limit: the stop decides when to sell.
  if (sec && trade.source !== "manual" && !trade.trail) trade.sellBy = trade.openedAt + 24 * sec * 1000;
  if (t.sellBy > Date.now()) trade.sellBy = +t.sellBy;   // e.g. copying the bot: same sell-by time as the bot
  hooks.ensureWatched(trade.symbol);
  trades.push(trade);
  if (t.exit) closeTrade(trade.id, +t.exit, "manual");
  else save();
  return trade;
}

export function closeTrade(id, exit, reason) {
  const t = trades.find((x) => x.id === id);
  if (!t || t.status !== "open" || !(exit > 0)) return;
  t.status = "closed"; t.exit = exit; t.closedAt = Date.now(); t.reason = reason; t.pnl = pnl(t, exit);
  save();
}

/** Live price feed: auto-close when the take-profit or stop-loss is touched (like an OCO order would). */
export function onTicker(symbol, price) {
  let changed = false;
  for (const t of trades) {
    if (t.status !== "open" || t.symbol !== symbol) continue;
    t.last = price;
    if (t.stop && price <= t.stop) {
      // Practice fills at the worse of the stop and the price (a gap can jump past a stop-loss).
      closeQuiet(t, t.practice ? Math.min(price, t.stop) : t.stop, "stop");
      const gain = t.pnl >= 0;
      hooks.notify({ kind: gain ? "up" : "down", symbol, title: `${baseOf(symbol)} ${t.trail && gain ? "trailing stop hit: gain locked in" : "stop-loss hit"}${t.practice ? " (practice)" : ""}`, body: t.practice ? `Practice account: ${gain ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} after fees.${gain ? "" : " Losses are part of every strategy; what matters is the total over many trades."}` : `My Trades recorded ${gain ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} after fees.${gain ? "" : " The daily loss guard is updated."}` });
      changed = true;
    } else if (t.trail && price > (t.hi || t.entry)) {
      // Trend trade: the stop follows the highest price since buying (never moves down).
      t.hi = price;
      const next = +(price - t.trail).toPrecision(8);
      if (next > t.stop) {
        t.stop = next; changed = true;
        if (!t.practice && Date.now() - (t.trailNotified || 0) > 20 * 3600e3 && next > t.entry * 0.99) {
          t.trailNotified = Date.now();
          hooks.notify({ kind: "info", symbol, title: `${baseOf(symbol)}: raise your stop to ${fmt.price(next)}`, body: "Your trend trade is rising, so its trailing stop moved up. Update the stop-loss order at your exchange or broker (never lower it)." });
        }
      }
    } else if (t.target && price >= t.target) {
      closeQuiet(t, t.target, "target");
      hooks.notify({ kind: "up", symbol, title: `${baseOf(symbol)} take-profit hit 🎯${t.practice ? " (practice)" : ""}`, body: `${t.practice ? "Practice account" : "My Trades recorded"} ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} after fees.` });
      changed = true;
    }
  }
  if (changed) save();
  else if (!$("tab-trades")?.hidden) paintLive();
}

/** Time-limit check: tell the user to sell when the plan's time is up. */
function checkTimeLimits() {
  let changed = false;
  for (const t of openTrades()) {
    if (!t.sellBy || t.timeAlerted || Date.now() < t.sellBy) continue;
    if (t.practice) {   // practice trades sell themselves at the time limit, like the plan says
      const px = t.last ?? hooks.getPrice(t.symbol);
      if (!(px > 0)) continue;
      closeQuiet(t, px, "time"); changed = true;
      hooks.notify({ kind: "info", symbol: t.symbol, title: `${baseOf(t.symbol)} practice trade sold at the time limit`, body: `Practice account: ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} after fees.` });
      continue;
    }
    t.timeAlerted = true; changed = true;
    hooks.notify({ kind: "caution", symbol: t.symbol, title: `SELL NOW: ${baseOf(t.symbol)} time limit reached`,
      body: "Neither the take-profit nor the stop-loss was hit in time. Entryvex's plan is to sell at the market price now. Then record the sale in My trades." });
  }
  if (changed) save();
}

/** Plain-language status of an open trade: what to do right now. */
export function tradeAdvice(t, price) {
  const now = Date.now();
  if (t.sellBy && now >= t.sellBy) return { action: "SELL NOW", level: "sell", why: "The plan's time limit has passed without hitting the target or stop. Sell at the market price." };
  if (price && t.target && price >= t.target) return { action: "SELL NOW", level: "sell", why: "The take-profit price has been reached." };
  if (price && t.stop && price <= t.stop) return { action: "SELL NOW", level: "sell", why: t.trail && price > t.entry ? "The trailing stop has been reached. Selling locks in the gain." : "The stop-loss price has been reached. Selling limits the loss." };
  if (t.trail) return { action: "HOLD", level: "hold", why: `Keep holding: this is a trend trade with no fixed target. Your stop is now <strong>${fmt.price(t.stop)}</strong> (${fmt.price(t.trail)} under the highest price since you bought, ${fmt.price(t.hi || t.entry)}). ${t.practice ? "Entryvex sells this practice trade automatically when the price falls to it." : "If the stop at your broker is lower, raise it to this. Sell only when the price falls to it."}` };
  const parts = [];
  if (t.target) parts.push(`sell for a profit at <strong>${fmt.price(t.target)}</strong>`);
  if (t.stop) parts.push(`sell to limit the loss at <strong>${fmt.price(t.stop)}</strong>`);
  if (t.sellBy) parts.push(`otherwise sell by <strong>${new Date(t.sellBy).toLocaleString([], { weekday: "short", hour: "2-digit", hourCycle: "h23", minute: "2-digit" })}</strong>`);
  return { action: "HOLD", level: "hold", why: parts.length ? `Keep holding. Plan: ${parts.join("; ")}.` : "No sell plan set. Add a stop-loss and take-profit below." };
}
function closeQuiet(t, exit, reason) { t.status = "closed"; t.exit = exit; t.closedAt = Date.now(); t.reason = reason; t.pnl = pnl(t, exit); }

/* ---------- UI ---------- */
export function initJournal(h) {
  hooks = { ...hooks, ...h };
  const root = $("tab-trades");
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === "close") {
      const input = root.querySelector(`input[data-exit="${id}"]`);
      closeTrade(id, parseFloat(input.value), "manual");
    }
    if (b.dataset.act === "delete") { trades = trades.filter((t) => t.id !== id); save(); }
    if (b.dataset.act === "pick") hooks.onPick(b.dataset.sym);
    if (b.id === "j-practice-reset" && confirm("Start the practice account again at $1,000? Past practice trades stay in the history.")) { store.set("practiceFrom", Date.now()); render(); }
    if (b.id === "j-clear" && confirm("Delete your whole trade history from this browser? This can't be undone.")) { trades = []; save(); }
  });
  root.addEventListener("change", (e) => {
    const el = e.target;
    const t = trades.find((x) => x.id === el.dataset.edit);
    if (!t) return;
    const v = parseFloat(el.value);
    if (el.dataset.field === "entry" && v > 0) t.entry = v;
    if (el.dataset.field === "qty" && v > 0) t.qty = v;
    if (el.dataset.field === "stop") t.stop = v > 0 ? v : null;
    if (el.dataset.field === "target") t.target = v > 0 ? v : null;
    save();
  });
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    const sym = $("j-sym").value, entry = parseFloat($("j-entry").value), usd = parseFloat($("j-usd").value);
    if (!sym || !(entry > 0) || !(usd > 0)) return;
    addTrade({
      symbol: sym, entry, qty: usd / entry, stop: parseFloat($("j-stop").value) || null, target: parseFloat($("j-target").value) || null,
      exit: parseFloat($("j-exit").value) || null, source: "manual",
    });
    e.target.reset();
  });
  // "I took this trade" buttons live on the trade card and the calculator.
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button.take-trade");
    if (!b) return;
    const d = JSON.parse(b.dataset.take);
    if (d.practice && openTrades().some((t) => t.practice && t.symbol === d.symbol)) {
      hooks.notify({ kind: "info", symbol: d.symbol, title: `Already practising ${baseOf(d.symbol)}`, body: "One practice trade per market at a time. See it in My trades." });
      hooks.showTab?.("trades");
      return;
    }
    if (d.practice) { const px = hooks.getPrice(d.symbol); if (px > 0 && d.entry > 0 && px > d.entry) { d.qty = d.qty * d.entry / px; d.entry = px; } }   // buys at the live price, never better
    addTrade(d);
    hooks.notify(d.practice
      ? { kind: "info", symbol: d.symbol, title: `Practice trade: ${baseOf(d.symbol)}`, body: "Bought with pretend money at the live price. Entryvex sells it at the take-profit, the stop-loss or the time limit, and adds the result to your practice account." }
      : { kind: "info", symbol: d.symbol, title: `Added to My Trades: ${baseOf(d.symbol)}`, body: "Entryvex will follow the price and record the result when your target or stop is hit. Edit the fill price if yours was different." });
    hooks.showTab?.("trades");
  });
  render();
  checkTimeLimits();
  setInterval(checkTimeLimits, 30_000);
}

function stats(practice = false) {
  const since = practice ? +store.get("practiceFrom", 0) : 0;
  const closed = trades.filter((t) => t.status === "closed" && !!t.practice === practice && t.openedAt >= since);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const sum = (a) => a.reduce((s, t) => s + t.pnl, 0);
  return {
    n: closed.length, total: sum(closed), winRate: closed.length ? wins.length / closed.length : NaN,
    avgWin: wins.length ? sum(wins) / wins.length : 0, avgLoss: losses.length ? sum(losses) / losses.length : 0,
    fromEntryvex: closed.filter((t) => t.source === "entryvex"),
  };
}

function money(v) { return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`; }
function plain(v) { return fmt.price(v).replace(/,/g, ""); }

function render() {
  const root = $("tab-trades");
  if (!root) return;
  const count = $("trades-count");
  if (count) { const n = openTrades().length; count.textContent = n; count.hidden = !n; }
  const s = stats();
  const open = openTrades();
  const closed = trades.filter((t) => t.status === "closed").sort((a, b) => b.closedAt - a.closedAt);
  const wl = hooks.getWatchlist();
  const ev = s.fromEntryvex;
  const ps = stats(true), pBal = practiceBalance(), pOpen = open.filter((t) => t.practice).length;
  const practiceBox = ps.n || pOpen ? `<div class="j-practice">
      <div class="j-practice-h"><strong>🎮 Practice account</strong> <span class="muted small">pretend money, real prices</span> <button class="link-btn" id="j-practice-reset">Start again</button></div>
      <div class="j-stats">
        <div><span>Balance</span><strong class="mono ${pBal >= PRACTICE_START ? "up" : "down"}">$${pBal.toFixed(2)}</strong></div>
        <div><span>Return</span><strong class="mono ${pBal >= PRACTICE_START ? "up" : "down"}">${((pBal / PRACTICE_START - 1) * 100).toFixed(2)}%</strong></div>
        <div><span>Closed / open</span><strong class="mono">${ps.n} / ${pOpen}</strong></div>
        <div><span>Win rate</span><strong class="mono">${isFinite(ps.winRate) ? Math.round(ps.winRate * 100) + "%" : "—"}</strong></div>
      </div>
      <p class="muted small">${ps.n < 20 ? `A real verdict needs about 20 closed practice trades (${ps.n} so far). Many small wins and a few losses is normal.` : pBal >= PRACTICE_START ? "Following Entryvex's signals has made money in practice. If you go real, start small and keep the same rules." : "Following the signals has lost money in practice so far. Keep practising before using real money."}</p>
    </div>` : `<p class="muted small">🎮 <strong>New to trading?</strong> Press <strong>Practice this trade</strong> on any BUY signal. Entryvex buys it with pretend money (a $${PRACTICE_START} practice account) and sells it by the plan, so you can see how following the signals goes before risking real money.</p>`;
  root.innerHTML = `
    ${practiceBox}
    <p class="muted small explain">Track the trades <strong>you</strong> place on Binance.US (or anywhere). Click <strong>"I took this trade"</strong> on a trade card, or add one below.
      Entryvex follows the live price and records the result automatically when your take-profit or stop-loss is hit, just like an OCO order would. Results feed the daily loss guard.</p>

    <div class="j-stats">
      <div><span>Total result</span><strong class="mono ${s.total >= 0 ? "up" : "down"}">${s.n ? money(s.total) : "—"}</strong></div>
      <div><span>Closed trades</span><strong class="mono">${s.n}</strong></div>
      <div><span>Win rate</span><strong class="mono">${isFinite(s.winRate) ? Math.round(s.winRate * 100) + "%" : "—"}</strong></div>
      <div><span>Avg win / loss</span><strong class="mono"><span class="up">${s.n ? money(s.avgWin) : "—"}</span> / <span class="down">${s.n ? money(s.avgLoss) : "—"}</span></strong></div>
      <div><span>From Entryvex cards</span><strong class="mono">${ev.length ? `${ev.length} · ${money(ev.reduce((a, t) => a + t.pnl, 0))}` : "—"}</strong></div>
    </div>

    <h3>Open trades ${open.length ? `<span class="muted small">(${open.length})</span>` : ""}</h3>
    ${open.length ? `<div class="j-open">${open.map(openCard).join("")}</div>` : `<p class="muted small">No open trades. When you buy something, add it here so Entryvex can track it.</p>`}

    <details class="j-add"><summary>Add a trade by hand</summary>
      <form class="j-form">
        <label><span>Coin</span><select id="j-sym">${wl.map((x) => `<option value="${x}">${fmt.esc(baseOf(x))}</option>`).join("")}</select></label>
        <label><span>Buy price</span><input id="j-entry" type="number" step="any" min="0" required inputmode="decimal" /></label>
        <label><span>Amount spent ($)</span><input id="j-usd" type="number" step="any" min="0" required inputmode="decimal" /></label>
        <label><span>Stop-loss (optional)</span><input id="j-stop" type="number" step="any" min="0" inputmode="decimal" /></label>
        <label><span>Take-profit (optional)</span><input id="j-target" type="number" step="any" min="0" inputmode="decimal" /></label>
        <label><span>Already sold at (optional)</span><input id="j-exit" type="number" step="any" min="0" inputmode="decimal" /></label>
        <button class="btn" type="submit">Add trade</button>
      </form>
    </details>

    <h3>History ${closed.length ? `<button class="link-btn" id="j-clear">Clear history</button>` : ""}</h3>
    ${closed.length ? `<div class="table-wrap"><table class="setups j-table"><thead><tr><th>Closed</th><th>Coin</th><th>From</th><th class="num">Buy → Sell</th><th class="num">Result</th><th>How</th><th></th></tr></thead><tbody>
      ${closed.slice(0, 100).map((t) => `<tr>
        <td class="muted">${new Date(t.closedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", hourCycle: "h23", minute: "2-digit" })}</td>
        <td><button class="link-btn" data-act="pick" data-sym="${t.symbol}">${fmt.esc(baseOf(t.symbol))}</button></td>
        <td class="muted small">${t.practice ? "🎮 practice · " : ""}${t.setup ? fmt.esc(t.setup) : "manual"}</td>
        <td class="num mono">${fmt.price(t.entry)} → ${fmt.price(t.exit)}</td>
        <td class="num mono ${t.pnl >= 0 ? "up" : "down"}">${money(t.pnl)}</td>
        <td class="muted small">${{ target: "🎯 target", stop: "stop-loss", manual: "you closed", time: "time limit" }[t.reason] || t.reason}</td>
        <td><button class="link-btn" data-act="delete" data-id="${t.id}" title="Delete">✕</button></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted small">No closed trades yet.</p>`}`;
}

function openCard(t) {
  const price = t.last ?? hooks.getPrice(t.symbol);
  const live = price ? pnl(t, price) : null;
  let progress = "";
  if (t.stop && t.target && price) {
    const pct = Math.max(0, Math.min(1, (price - t.stop) / (t.target - t.stop)));
    progress = `<div class="j-progress" title="Where the price is between your stop-loss (left) and take-profit (right)"><i style="left:${(pct * 100).toFixed(1)}%"></i></div>
      <div class="j-progress-labels mono small"><span class="down">stop ${fmt.price(t.stop)}</span><span class="up">target ${fmt.price(t.target)}</span></div>`;
  }
  if (t.trail && price) {
    const locked = t.stop > t.entry;
    progress = `<div class="j-trail small"><span class="pill ${locked ? "pill-edge" : "pill-thin"}">TRAILING STOP ${fmt.price(t.stop)}</span>
      <span class="muted">${locked ? "above your buy price: a gain is locked in" : `first stop ${fmt.price(t.firstStop ?? t.stop)}`} · highest since buying ${fmt.price(t.hi || t.entry)} · the stop stays ${fmt.price(t.trail)} under it and never moves down</span></div>`;
  }
  const adv = tradeAdvice(t, price);
  return `<div class="j-card" data-open="${t.id}">
    <div class="j-advice adv-${adv.level}"><strong>${adv.action}</strong><span>${adv.why}</span></div>
    <div class="j-card-top">
      <button class="link-btn j-coin" data-act="pick" data-sym="${t.symbol}">${fmt.esc(baseOf(t.symbol))}</button>
      <span class="muted small">${t.practice ? `<span class="pill pill-thin">PRACTICE</span> ` : ""}${t.setup ? fmt.esc(t.setup) + " · " : ""}opened ${fmt.ago(t.openedAt)}</span>
      <strong class="mono j-live ${live == null ? "" : live >= 0 ? "up" : "down"}" data-live="${t.id}">${live == null ? "—" : money(live)}</strong>
    </div>
    ${progress}
    <div class="j-edit">
      <label><span>Bought at</span><input type="number" step="any" data-edit="${t.id}" data-field="entry" value="${plain(t.entry)}" /></label>
      <label><span>Amount (coins)</span><input type="number" step="any" data-edit="${t.id}" data-field="qty" value="${+t.qty.toFixed(8)}" /></label>
      <label><span>Stop-loss</span><input type="number" step="any" data-edit="${t.id}" data-field="stop" value="${t.stop ? plain(t.stop) : ""}" /></label>
      <label><span>Take-profit</span><input type="number" step="any" data-edit="${t.id}" data-field="target" value="${t.target ? plain(t.target) : ""}" /></label>
    </div>
    <div class="j-close">
      <span class="small muted">Sold it yourself?</span>
      <input type="number" step="any" data-exit="${t.id}" value="${price ? plain(price) : ""}" />
      <button class="ghost-btn" data-act="close" data-id="${t.id}">Record sale</button>
      <button class="link-btn" data-act="delete" data-id="${t.id}">Delete</button>
    </div>
  </div>`;
}

/** Update only the live numbers (avoids re-rendering inputs while you type). */
function paintLive() {
  for (const t of openTrades()) {
    const el = document.querySelector(`[data-live="${t.id}"]`);
    if (!el) continue;
    const price = t.last ?? hooks.getPrice(t.symbol);
    if (!price) continue;
    const v = pnl(t, price);
    el.textContent = money(v);
    el.className = `mono j-live ${v >= 0 ? "up" : "down"}`;
    const dot = document.querySelector(`[data-open="${t.id}"] .j-progress i`);
    if (dot && t.stop && t.target) dot.style.left = (Math.max(0, Math.min(1, (price - t.stop) / (t.target - t.stop))) * 100).toFixed(1) + "%";
  }
}
