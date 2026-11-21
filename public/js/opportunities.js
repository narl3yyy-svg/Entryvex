// Opportunities board: checks every market in the watchlist on 15m, 1h and 4h candles,
// using the same measured engine as the scanner, and lists
//   1) BUY signals active right now, and
//   2) setups with a positive track record that aren't active yet ("watch these").
// Refreshes every 15 minutes while Entryvex is open.
import { analyze } from "./engine.js";
import { getKlineHistory, getBookTicker, isStock } from "./market.js";
import { logFromAnalysis } from "./signals.js";
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
const INTERVALS = ["15m", "1h", "4h"];
const REFRESH_MS = 15 * 60_000;

let hooks = { getWatchlist: () => [], getInfo: () => null, nameFor: (s) => s, onPick: () => {}, onUpdate: () => {} };
let rows = [];          // { sym, iv, r }
let lastRun = 0, running = false, progress = "";
let timer = null;

const store = { get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } } };
const baseOf = (s) => hooks.getInfo(s)?.base ?? s.replace(/^S:/, "").replace(/(USDT|USDC|USD)$/, "");

export function initOpportunities(h) {
  hooks = { ...hooks, ...h };
  $("tab-opps").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.sym) hooks.onPick(b.dataset.sym, b.dataset.iv);
    if (b.id === "opps-refresh") run();
  });
  render();
  setTimeout(run, 15_000);  // let the page finish loading first
}

/** Active buy signals found in the latest run (used by the "Entryvex says" panel). */
export function currentBuys() {
  return rows.filter(({ r }) => isBuy(r)).map(({ sym, iv, r }) => ({ sym, iv, label: r.overall.label, setup: r.best.name, base: baseOf(sym) }));
}

/** Best setups with a positive record that aren't active yet (used by "Entryvex says"). */
export function topWatch(n = 3) {
  const out = [];
  for (const { sym, iv, r } of rows) {
    if (r.liquidity && !r.liquidity.ok) continue;
    for (const s of r.setups) if ((s.verdict.level === "edge" || s.verdict.level === "weak") && !s.activeNow) out.push({ sym, iv, s, base: baseOf(sym) });
  }
  return out.sort((a, b) => b.s.stats.ev - a.s.stats.ev).slice(0, n);
}

/** Markets/setups with a track record, for the server's closed-app BUY checks. */
export function setupMarkets(min = "go") {
  const out = [];
  for (const { sym, iv, r } of rows) {
    if (r.liquidity && !r.liquidity.ok) continue;
    const good = r.setups.filter((s) => s.verdict.level === "edge" || (min === "caution" && s.verdict.level === "weak"));
    if (good.length) out.push({ symbol: sym, base: baseOf(sym), interval: iv, setupIds: good.map((s) => s.id),
      labels: Object.fromEntries(good.map((s) => [s.id, s.verdict.level === "edge" ? "BUY" : "SMALL BUY"])) });
  }
  return out.slice(0, 25);
}

/** One-line summary of Entryvex's signals for a symbol across 15m/1h/4h (for the AI). */
export function signalFor(sym) {
  const mine = rows.filter((x) => x.sym === sym);
  if (!mine.length) return "not scanned yet";
  const buy = mine.find(({ r }) => isBuy(r));
  if (buy) return `${buy.r.overall.level === "go" ? "BUY" : "SMALL BUY"} signal on ${buy.iv} (${buy.r.best.name})`;
  const watch = mine.flatMap(({ iv, r }) => (r.liquidity && !r.liquidity.ok) ? [] : r.setups.filter((s) => s.verdict.level === "edge" || s.verdict.level === "weak").map((s) => `${iv} ${s.name}`));
  if (watch.length) return `no buy signal now; setups with a track record: ${watch.slice(0, 2).join(", ")}`;
  if (mine.every(({ r }) => r.liquidity && !r.liquidity.ok)) return "barely trades on Binance.US (not tradeable here)";
  return "no setup with a reliable track record";
}

function isBuy(r) {
  if (r.liquidity && !r.liquidity.ok) return false;
  return r.overall.level === "go" || (r.overall.level === "caution" && r.best?.verdict.level === "weak");
}

export async function run() {
  if (running) return;
  running = true;
  clearTimeout(timer);
  const fee = (+store.get("feePct", 0.02) || 0) / 100;
  const jobs = [];
  for (const sym of hooks.getWatchlist()) for (const iv of INTERVALS) jobs.push({ sym, iv });
  const out = [];
  let done = 0;
  progress = `Checking ${jobs.length} combinations…`;
  render();
  const worker = async () => {
    while (jobs.length) {
      const { sym, iv } = jobs.shift();
      try {
        const [c, book] = await Promise.all([getKlineHistory(sym, iv, 3000), getBookTicker(sym).catch(() => ({ spreadPct: NaN }))]);
        if (c.length > 250) {
          const cost = (isStock(sym) ? 0 : fee) + (isFinite(book.spreadPct) ? book.spreadPct / 2 : 0);
          const r = analyze(c, { costPerSide: cost });
          logFromAnalysis(sym, iv, c, r);
          out.push({ sym, iv, r });
        }
      } catch (e) { /* skip markets that fail to load */ }
      done++;
      if (done % 6 === 0) { progress = `Checked ${done} of ${done + jobs.length}…`; render(); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  rows = out;
  lastRun = Date.now();
  running = false;
  progress = "";
  render();
  hooks.onUpdate(currentBuys());
  timer = setTimeout(run, REFRESH_MS);
}

function render() {
  const root = $("tab-opps");
  if (!root) return;
  const buys = rows.filter(({ r }) => isBuy(r)).sort((a, b) => (b.r.best.stats.ev - a.r.best.stats.ev));
  const watch = [];
  for (const { sym, iv, r } of rows) {
    if (r.liquidity && !r.liquidity.ok) continue;  // thin markets: patterns there aren't tradeable
    for (const s of r.setups) {
      if ((s.verdict.level === "edge" || s.verdict.level === "weak") && !s.activeNow) watch.push({ sym, iv, s });
    }
  }
  watch.sort((a, b) => (b.s.verdict.level === "edge") - (a.s.verdict.level === "edge") || b.s.stats.ev - a.s.stats.ev);
  const markets = new Set(rows.map((x) => x.sym)).size;
  const thin = rows.filter(({ r }) => r.liquidity && !r.liquidity.ok);
  const thinNames = [...new Set(thin.map((x) => `${baseOf(x.sym)} ${x.iv}`))];
  const count = $("opps-count");
  if (count) { count.textContent = buys.length; count.hidden = !buys.length; }

  root.innerHTML = `
    <p class="muted small explain">Entryvex checks <strong>every market in your watchlist</strong> on 15-minute, 1-hour and 4-hour candles with the same measured method as the scanner,
      and refreshes every 15 minutes while it's open. Click any row to open it.</p>
    <div class="opps-status">
      <span>${running ? `<span class="typing"><i></i><i></i><i></i></span> ${fmt.esc(progress)}` : lastRun
        ? `Last checked ${new Date(lastRun).toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit" })}: ${markets} markets × ${INTERVALS.length} candle sizes.`
        : "Starting the first check…"}</span>
      <button class="ghost-btn" id="opps-refresh" ${running ? "disabled" : ""}>Check now</button>
    </div>

    <h3>Buy signals right now ${buys.length ? `<span class="pill pill-edge">${buys.length}</span>` : ""}</h3>
    ${buys.length ? `<div class="opps-list">${buys.map(({ sym, iv, r }) => {
      const s = r.best.stats;
      return `<button class="opp-row opp-buy" data-sym="${sym}" data-iv="${iv}">
        <span class="opp-coin">${fmt.esc(baseOf(sym))}</span><span class="mono opp-iv">${iv}</span>
        <span class="pill ${r.overall.level === "go" ? "pill-edge" : "pill-weak"}">${r.overall.level === "go" ? "BUY" : "SMALL BUY"}</span>
        <span>${fmt.esc(r.best.name)}</span>
        <span class="mono small">won ${Math.round(s.winRate * s.n)}/${s.n} · ${fmt.pct(s.ev * 100)}/trade</span></button>`;
    }).join("")}</div>`
      : `<p class="muted small">${lastRun ? "No buy signals anywhere in your watchlist right now. That's normal: most of the time the honest answer is to wait." : "…"}</p>`}

    <h3>Watch these: setups with a good track record (not active yet)</h3>
    ${watch.length ? `<p class="muted tiny">When one of these appears, it becomes a buy signal. Setup alerts (🔔) tell you the moment it happens.</p>
      <div class="opps-list">${watch.slice(0, 12).map(({ sym, iv, s }) => `
        <button class="opp-row" data-sym="${sym}" data-iv="${iv}">
          <span class="opp-coin">${fmt.esc(baseOf(sym))}</span><span class="mono opp-iv">${iv}</span>
          <span class="pill pill-${s.verdict.level}">${s.verdict.label}</span>
          <span>${fmt.esc(s.name)}</span>
          <span class="mono small">won ${Math.round(s.stats.winRate * 100)}% of ${s.stats.n} · ${fmt.pct(s.stats.ev * 100)}/trade</span></button>`).join("")}</div>`
      : `<p class="muted small">${lastRun ? "None of the setups has a positive track record on your watchlist right now. Try adding more coins or stocks." : "…"}</p>`}
    ${thinNames.length ? `<p class="muted tiny">Skipped because they barely trade on Binance.US at that candle size (prices jump, stops can't protect you): ${thinNames.map(fmt.esc).join(", ")}.</p>` : ""}`;
}
