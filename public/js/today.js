// "☀️ Today" tab: the one-screen daily brief for new users. What the markets feel like, which of your
// markets has a BUY signal right now, what to do with what you own, what the bot did, and what's coming
// up (earnings, big economic news). Everything here comes from data the rest of the app already measures.
import * as fmt from "./format.js";
import { currentBuys, topWatch, lastChecked, isRunning } from "./opportunities.js";
import { holdingsSnapshot, refreshHoldings } from "./holdings.js";
import { botData } from "./bot.js";
import { marketBackdrop, fearGauge } from "./decision.js";
import { loadEarningsCalendar, upcomingList } from "./earnings.js";
import { loadCalendar, upcomingHighImpact } from "./calendar.js";
import { scoreSummary } from "./scorecard.js";
import { practiceBalance, PRACTICE_START, openTrades, onJournalChange } from "./journal.js";

const $ = (id) => document.getElementById(id);
let hooks = { getWatchlist: () => [], nameFor: (s) => s, open: () => {}, showTab: () => {} };
let visible = false, timer = null, mood = null, moodAt = 0;

export function initToday(h) {
  hooks = { ...hooks, ...h };
  onJournalChange(() => todayRefresh());
  $("tab-today").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.todayOpen) hooks.open(b.dataset.todayOpen, b.dataset.iv || null);
    if (b.dataset.todayTab) hooks.showTab(b.dataset.todayTab);
  });  if (visible) render();   // the tab may have been opened before the hooks were ready
}
export function todayVisible(on) {
  visible = on;
  clearInterval(timer);
  if (!on) return;
  render(); refresh();
  timer = setInterval(() => { render(); if (Date.now() - moodAt > 10 * 60e3) refresh(); }, 60_000);
}
/** Called when the scanner, bot or holdings have news, so the brief stays current while it's open. */
export function todayRefresh() { if (visible) render(); }

async function refresh() {
  const [c, s, sb, sf] = await Promise.allSettled([marketBackdrop(false), marketBackdrop(true), fearGauge(false), fearGauge(true)]);
  mood = [c, s, sb, sf].map((r) => (r.status === "fulfilled" ? r.value : null));
  moodAt = Date.now();
  render();
  await Promise.allSettled([loadEarningsCalendar(), loadCalendar(), refreshHoldings()]);
  render();
}

const IV = { "15m": "15-min", "1h": "1-hour", "4h": "4-hour", "1d": "daily" };
const CALL = { "BUY MORE": "up", TRIM: "down", HOLD: "" };
const CALL_SET = new Set(Object.keys(CALL));
const when = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = (d) => new Date(d + "T12:00:00Z").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const pc = (x) => (x == null || !isFinite(x) ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}%`);

function moodTiles() {
  if (!mood) return `<p class="muted small">Reading the market mood…</p>`;
  const tile = (m) => m ? `<div class="today-mood eff-${m.effect > 0 ? "pos" : m.effect < 0 ? "neg" : "neu"}"><span>${fmt.esc(m.label)}</span><p>${fmt.esc(m.text)}</p></div>` : "";
  return `<div class="today-moods">${mood.map(tile).join("")}</div>`;
}

function headline(buys, hold, bot) {
  const parts = [];
  const neg = (mood || []).filter((m) => m?.effect < 0).length, pos = (mood || []).filter((m) => m?.effect > 0).length;
  parts.push(!mood ? "" : neg >= 2 ? "Markets are rough today, so be extra careful." : pos >= 3 ? "Markets look healthy today." : "Markets are mixed today.");
  parts.push(buys.length ? `${buys.length} buy signal${buys.length === 1 ? "" : "s"} on your list.` : "No buy signals on your list right now. Waiting is fine.");
  const act = hold.filter((h) => h.entryvexCall === "BUY MORE" || h.entryvexCall === "TRIM").length;
  const unchecked = hold.filter((h) => !CALL_SET.has(h.entryvexCall)).length;
  if (hold.length) parts.push(act ? `${act} of your holdings need${act === 1 ? "s" : ""} a decision.` : unchecked ? "Checking your holdings…" : "Your holdings: nothing to do.");
  if (bot?.positions?.length) parts.push(`The bot holds ${bot.positions.length} trade${bot.positions.length === 1 ? "" : "s"}.`);
  return parts.filter(Boolean).join(" ");
}

function buysHtml(buys) {
  if (buys.length) return `<div class="today-list">${buys.map((b) => `<button class="today-row" data-today-open="${fmt.esc(b.sym)}" data-iv="${fmt.esc(b.iv)}">
      <span class="pill pill-edge">BUY</span><strong>${fmt.esc(hooks.nameFor(b.sym))}</strong>
      <span class="muted small">${fmt.esc(b.setup)} on ${IV[b.iv] || b.iv} candles</span><span class="today-go">Open the plan →</span></button>`).join("")}</div>`;
  const w = topWatch(3);
  const checked = lastChecked();
  return `<p class="small">${isRunning() ? "Checking your list now…" : `Nothing on your watchlist has a buy signal${checked ? ` (checked ${fmt.ago(checked)})` : ""}. Most of the time that's the right answer.`}</p>
    ${w.length ? `<p class="small muted">Closest to a signal (in a daily uptrend, waiting for a new 20-day high):</p><div class="today-list">${w.map((x) => `<button class="today-row" data-today-open="${fmt.esc(x.sym)}" data-iv="${fmt.esc(x.iv)}">
      <span class="pill">WATCH</span><strong>${fmt.esc(hooks.nameFor(x.sym))}</strong><span class="muted small">BUY above ${fmt.price(x.level)} · ${x.away >= 0 ? "+" : ""}${x.away.toFixed(1)}% away</span></button>`).join("")}</div>` : ""}`;
}

function holdHtml(hold) {
  if (!hold.length) return `<p class="small muted">You haven't added anything you own. <button class="link-btn" data-today-tab="holdings">Add a holding</button> and Entryvex will tell you whether to buy more, hold or trim.</p>`;
  return `<div class="today-list">${hold.map((h) => `<button class="today-row" data-today-tab="holdings">
    <span class="pill ${CALL[h.entryvexCall] === "up" ? "pill-edge" : CALL[h.entryvexCall] === "down" ? "pill-negative" : ""}">${CALL_SET.has(h.entryvexCall) ? h.entryvexCall : "CHECKING…"}</span>
    <strong>${fmt.esc(h.name)}</strong><span class="small ${h.profitPct >= 0 ? "up" : "down"}">${pc(h.profitPct)}</span>
    <span class="muted small">${h.why?.[0] ? fmt.esc(String(h.why[0]).slice(0, 110)) : ""}</span></button>`).join("")}</div>`;
}

function botHtml(b) {
  if (!b?.started) return `<p class="small muted">Loading the bot…</p>`;
  const s = b.summary;
  const last = (b.events || []).filter((e) => e.kind === "open" || e.kind === "close").slice(-1)[0];
  return `<p class="small">Virtual <strong>$${s.equity.toFixed(2)}</strong> from $${b.startUsd} (<span class="${s.returnPct >= 0 ? "up" : "down"}">${pc(s.returnPct * 100)}</span>; just holding all ${b.markets.length} markets: <span class="${s.holdPct >= 0 ? "up" : "down"}">${pc(s.holdPct * 100)}</span>). ${s.trades} closed trade${s.trades === 1 ? "" : "s"}, ${s.open} open.
    ${last ? `<br><span class="muted">Latest: ${fmt.esc(last.title)} (${fmt.ago(last.t)}).</span>` : ""}
    <br><button class="link-btn" data-today-tab="bot">See its trades and what it learned</button></p>`;
}

function practiceHtml() {
  const open = openTrades().filter((t) => t.practice).length, bal = practiceBalance();
  if (!open && Math.abs(bal - PRACTICE_START) < 0.005) return "";
  return `<p class="small">🎮 <strong>Your practice account:</strong> <span class="${bal >= PRACTICE_START ? "up" : "down"}">$${bal.toFixed(2)}</span> from $${PRACTICE_START}${open ? `, ${open} practice trade${open === 1 ? "" : "s"} open` : ""}. <button class="link-btn" data-today-tab="trades">See them</button></p>`;
}

function comingHtml() {
  const syms = [...new Set([...hooks.getWatchlist(), ...(holdingsSnapshot() || []).map((h) => h.symbol)])];
  const { mine } = upcomingList(syms, 7);
  const soonE = mine.filter((e) => Date.parse(e.date + "T23:59:59Z") - Date.now() < 8 * 86400e3);
  const macro = upcomingHighImpact(24).filter((e) => e.country === "USD");   // US news is what moves US stocks and crypto most
  if (!soonE.length && !macro.length) return `<p class="small muted">No earnings for your stocks this week and no high-impact economic news in the next 24 hours.</p>`;
  return `<div class="today-list">
    ${soonE.map((e) => `<button class="today-row" data-today-open="${fmt.esc(e.sym)}"><span class="pill pill-thin">EARNINGS</span><strong>${fmt.esc(hooks.nameFor(e.sym))}</strong><span class="muted small">${day(e.date)}${e.time ? ` · ${fmt.esc(e.time)}` : ""}: prices can jump past a stop-loss on the news</span></button>`).join("")}
    ${macro.map((e) => `<div class="today-row"><span class="pill pill-thin">NEWS</span><strong>${fmt.esc(e.country)} ${fmt.esc(e.title)}</strong><span class="muted small">${when(e.t)}: expect sudden swings around it</span></div>`).join("")}
  </div>`;
}

function render() {
  const el = $("tab-today");
  if (!el || !visible) return;
  const buys = currentBuys(), hold = holdingsSnapshot() || [], bot = botData(), sc = scoreSummary();
  const date = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  el.innerHTML = `
    <div class="today-head"><h3>☀️ Today · ${date}</h3><p>${fmt.esc(headline(buys, hold, bot))}</p></div>
    <h4>Market mood</h4>${moodTiles()}
    <h4>Buy signals on your list</h4>${buysHtml(buys)}
    <h4>What you own</h4>${holdHtml(hold)}
    <h4>🤖 The bot</h4>${botHtml(bot)}
    ${practiceHtml()}
    <h4>Coming up</h4>${comingHtml()}
    ${sc ? `<p class="small muted">📏 How much to trust the forecasts: price landed inside the 80% range ${sc.in80}% of the time (${sc.n} ${sc.live ? "live checks" : "tests on past data"}). <button class="link-btn" data-today-tab="score">See the scorecard</button></p>` : ""}
    <p class="tiny muted">Entryvex measures what has worked before; it can't see the future. Never trade money you can't afford to lose.</p>`;
}
