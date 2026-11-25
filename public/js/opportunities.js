// Opportunities board: checks every market in the watchlist on DAILY candles with the trend rule
// (the BUY rule that held up on unseen data; shorter candles never say BUY), and lists
//   1) BUY signals active right now, and
//   2) markets in an uptrend that are close to a BUY ("watch these": the price that would trigger it).
// Refreshes every 15 minutes while Entryvex is open.
import { analyzeAsync, trainPooledAsync } from "./pool.js";
import { getKlineHistory, getBookTicker, isStock } from "./market.js";
import { logFromAnalysis } from "./signals.js";
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
// The watchlist is checked on the candle size shown on the chart (it follows the 1m…1D buttons,
// the 1Y/5Y/ALL views and the Day/Swing/Long-term style switch).
const IV_SHORT = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1D", "1w": "1W" };
const IV_NAME = { "1m": "1-minute", "5m": "5-minute", "15m": "15-minute", "1h": "1-hour", "4h": "4-hour", "1d": "daily", "1w": "weekly" };
let INTERVALS = ["1d"];
let fullAgain = false;
// How often the whole watchlist is re-checked (minutes; 0 = only when you press Scan watchlist).
// Unchanged markets are reused, so frequent checks are cheap. In a background tab it slows to ≥5 min.
export const SCAN_CHOICES = [1, 5, 15, 30, 0];
export function scanEvery() { const v = +store.get("scanEvery", 5); return SCAN_CHOICES.includes(v) ? v : 5; }
function nextDelay() {
  const m = scanEvery();
  if (!m) return null;
  return (document.visibilityState === "visible" ? m : Math.max(m, 5)) * 60_000;
}
function schedule(ms = nextDelay()) { clearTimeout(timer); if (ms != null) timer = setTimeout(() => run(), ms); }
export function setScanEvery(min) {
  try { localStorage.setItem("evx.scanEvery", JSON.stringify(min)); } catch {}
  schedule(min ? Math.min(min * 60_000, 3000) : null);   // apply now: check again shortly, then on the new rhythm
}
let prevBuys = null;   // BUY signals found by the previous check (null = first check since the page opened)

let hooks = { getWatchlist: () => [], getInfo: () => null, nameFor: (s) => s, onPick: () => {}, onUpdate: () => {}, onProgress: () => {} };
let rows = [];          // { sym, iv, r }
let lastRun = 0, running = false, progress = "";
const pending = new Set();   // symbols in the current run
const checked = new Set();   // symbols checked at least once (even if they returned no usable data)
let timer = null;

const store = { get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } } };
const baseOf = (s) => hooks.getInfo(s)?.base ?? s.replace(/^S:/, "").replace(/(USDT|USDC|USD)$/, "");

export function initOpportunities(h) {
  hooks = { ...hooks, ...h };
  $("tab-opps").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.sym) hooks.onPick(b.dataset.sym, b.dataset.iv);
    if (b.dataset.anySym) (hooks.onPickAny || hooks.onPick)(b.dataset.anySym, "1d");
    if (b.id === "opps-refresh") run();
    if (b.id === "radar-refresh") runRadar(true);
  });
  render();
  setTimeout(() => run(), 4_000);  // let the page finish loading first
}

/** Active buy signals found in the latest run (used by the "Entryvex says" panel). */
export function currentBuys() {
  return rows.filter(({ r }) => isBuy(r)).map(({ sym, iv, r }) => ({ sym, iv, label: r.overall.label, setup: r.best.name, base: baseOf(sym) }));
}

/** Markets in a daily uptrend, closest to a new 20-day high first: { sym, iv, s, base, level, away }. */
function watchRows() {
  const out = [];
  for (const { sym, iv, r } of rows) {
    if ((r.liquidity && !r.liquidity.ok) || !r.long || !r.upNow || r.trend?.activeNow) continue;
    const t = (r.triggers || []).find((x) => x.id === "trend" && x.ready);
    if (t) out.push({ sym, iv, s: r.trend, base: baseOf(sym), level: t.level, away: t.away });
  }
  return out.sort((a, b) => a.away - b.away);
}
/** Closest markets to a BUY (used by "Entryvex says" and Today). */
export function topWatch(n = 3) { return watchRows().slice(0, n); }

/** Daily markets for the server's closed-app BUY checks (the trend rule, checked after each daily close). */
export function setupMarkets() {
  return rows.filter(({ iv, r }) => iv === "1d" && !(r.liquidity && !r.liquidity.ok))
    .map(({ sym }) => ({ symbol: sym, base: baseOf(sym), interval: "1d", setupIds: ["trend"], labels: { trend: "BUY" } })).slice(0, 25);
}

/** One-line summary of Entryvex's signals for a symbol across 15m/1h/4h (for the AI). */
export function signalFor(sym) {
  const mine = rows.filter((x) => x.sym === sym);
  if (!mine.length) return "not scanned yet";
  const buy = mine.find(({ r }) => isBuy(r));
  if (buy) return `BUY signal on daily candles (${buy.r.best.name})`;
  const w = watchRows().find((x) => x.sym === sym);
  if (w) return `no buy signal now; in a daily uptrend, BUY if a day closes above ${w.level} (${w.away >= 0 ? "+" : ""}${w.away.toFixed(1)}%)`;
  if (mine.every(({ r }) => r.liquidity && !r.liquidity.ok)) return "barely trades on Binance.US (not tradeable here)";
  return "no daily uptrend, so no buy signal";
}

/**
 * Watchlist color for a symbol, from its latest check on 15m/1h/4h candles:
 *   buy     – a setup with a positive track record is active right now (BUY / SMALL BUY)
 *   wait    – Entryvex has enough history to judge, and there is no buy signal now
 *   unknown – not enough data to judge: too little price history, barely trades here,
 *             or every setup has too few past trades to measure
 *   checking / null – being checked now / not checked yet
 */
export function verdictFor(sym) {
  if (running && pending.has(sym)) return { level: "checking", label: "…", why: "Entryvex is checking this market now." };
  const mine = rows.filter((x) => x.sym === sym);
  if (!mine.length) {
    if (running && (pending.has(sym))) return { level: "checking", label: "…", why: "Entryvex is checking this market now." };
    if (checked.has(sym)) return { level: "unknown", label: "?", why: "Not enough price history on this candle size to measure any setup (needs 250+ candles). Try a smaller candle size." };
    return null;
  }
  const buy = mine.find(({ r }) => isBuy(r));
  if (buy) return { level: "buy", iv: buy.iv, label: "BUY 1D",
    why: "BUY on the daily chart: uptrend, and a day just closed at a new 20-day high (the tested trend rule). Sell with a trailing stop." };
  const usable = mine.filter(({ r }) => !(r.liquidity && !r.liquidity.ok));
  if (!usable.length) return { level: "unknown", label: "?", why: "Barely trades on this exchange, so its prices can't be judged reliably." };
  if (!usable.some(({ r }) => r.long && r.sample?.candles > 0)) return { level: "unknown", label: "?", why: "Not enough daily price history yet (needs about 250 days)." };
  const w = watchRows().find((x) => x.sym === sym);
  // WATCH: in an uptrend; it turns green when a day closes at a new 20-day high.
  if (w) return { level: "watch", label: "WATCH 1D",
    why: `In a daily uptrend. Entryvex says BUY if a day closes above ${fmt.price(w.level)} (${w.away >= 0 ? "+" : ""}${w.away.toFixed(1)}% from now), the 20-day high.` };
  return { level: "wait", label: "WAIT", why: "Don't buy: no uptrend on the daily chart (price isn't above its 200-day average with the 50-day above it). The trend rule waits for one." };
}
/* ---------- Trend radar: the trend rule on ~40 popular markets that aren't on the watchlist ----------
   Trend following works best spread over many markets, and a new user's watchlist is short. Checked at
   most every 6 hours (daily candles change once a day); only a small summary is kept in this browser. */
const RADAR = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "LTCUSDT", "DOTUSDT", "BCHUSDT",
  "S:SPY", "S:QQQ", "S:IWM", "S:DIA", "S:GLD", "S:SLV", "S:TLT", "S:XLE", "S:XLF", "S:XLK", "S:AAPL", "S:MSFT", "S:NVDA", "S:AMZN",
  "S:GOOGL", "S:META", "S:TSLA", "S:AVGO", "S:AMD", "S:NFLX", "S:JPM", "S:V", "S:LLY", "S:XOM", "S:COST", "S:WMT", "S:ORCL", "S:PLTR", "S:KO"];
const RADAR_EVERY = 6 * 3600e3;
let radar = store.get("radar", null), radarRunning = false;
export function radarList() { return RADAR.slice(); }
/** Popular markets (not on the watchlist) with a trend-rule BUY right now. */
export function radarBuys() {
  const mine = new Set(hooks.getWatchlist());
  return (radar?.rows || []).filter((x) => x.buy && !mine.has(x.sym));
}
/** Popular markets in an uptrend, closest to a BUY. */
export function radarWatch(n = 6) {
  const mine = new Set(hooks.getWatchlist());
  return (radar?.rows || []).filter((x) => !x.buy && x.up && isFinite(x.away) && !mine.has(x.sym)).sort((a, b) => a.away - b.away).slice(0, n);
}
async function runRadar(force) {
  if (radarRunning || (!force && radar && Date.now() - radar.at < RADAR_EVERY)) return;
  radarRunning = true; render();
  const fee = (+store.get("feePct", 0.02) || 0) / 100;
  const out = [], queue = RADAR.slice();
  const worker = async () => {
    while (queue.length) {
      const sym = queue.shift();
      try {
        const c = await getKlineHistory(sym, "1d", 3000);
        if (c.length < 260) continue;
        const r = await analyzeAsync(c, { costPerSide: isStock(sym) ? 0.0002 : fee + 0.0003, useModel: false });
        if (r.liquidity && !r.liquidity.ok) continue;
        const t = (r.triggers || []).find((x) => x.id === "trend" && x.ready);
        out.push({ sym, buy: isBuy(r), up: !!r.upNow, level: t?.level ?? null, away: t?.away ?? null, price: r.price, n: r.trend?.stats?.n || 0, ev: r.trend?.stats?.ev ?? null });
      } catch { /* skip markets that fail to load */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  radar = { at: Date.now(), rows: out };
  try { localStorage.setItem("evx.radar", JSON.stringify(radar)); } catch {}
  radarRunning = false;
  render();
  hooks.onUpdate(currentBuys());
}
export function isRunning() { return running; }
export function lastChecked() { return lastRun; }

function isBuy(r) {
  if (r.liquidity && !r.liquidity.ok) return false;
  return r.overall.level === "go" || (r.overall.level === "caution" && r.best?.verdict.level === "weak");
}

/** Check every market in the watchlist (or just `only`, e.g. a newly added symbol). */
export async function run(only) {
  if (running) { if (only) queued.push(...only); else fullAgain = true; return; }
  // Daily only: BUY signals come only from the trend rule on daily candles (shorter candles didn't beat
  // random timing on unseen data), so checking other candle sizes would only cost time.
  INTERVALS = ["1d"];
  running = true;
  clearTimeout(timer);
  const fee = (+store.get("feePct", 0.02) || 0) / 100;
  const syms = only ? only.filter((s) => hooks.getWatchlist().includes(s)) : hooks.getWatchlist();
  const jobs = [];
  for (const sym of syms) for (const iv of INTERVALS) jobs.push({ sym, iv });
  const total = jobs.length;
  pending.clear(); syms.forEach((s) => pending.add(s));
  hooks.onProgress({ running: true, done: 0, total });
  const out = [];
  let done = 0;
  progress = `Checking ${jobs.length} combinations…`;
  render();
  // 1) Load every market's candles (saved history + only what's new).
  const loaded = [];
  const step = (k) => { done += k; hooks.onProgress({ running: true, done: Math.round(done), total }); };
  const loader = async () => {
    while (jobs.length) {
      const { sym, iv } = jobs.shift();
      try {
        const [c, book] = await Promise.all([getKlineHistory(sym, iv, 3000), getBookTicker(sym).catch(() => ({ spreadPct: NaN }))]);
        if (c.length > 250) loaded.push({ sym, iv, c, cost: (isStock(sym) ? 0 : fee) + (isFinite(book.spreadPct) ? book.spreadPct / 2 : 0) });
      } catch { /* skip markets that fail to load */ }
      step(0.5);
    }
  };
  await Promise.all([loader(), loader(), loader(), loader(), loader(), loader()]);

  // 2) One shared prediction model per candle size, trained on all of these markets together
  //    (better on unseen data than one model per market). Retrained only when a new candle closed.
  //    Measured on unseen data: clearly better than per-market models on daily candles (losses per
  //    trade about a quarter as big), slightly worse on 1h/4h, so it's only used for daily.
  if (!only) {
    for (const iv of INTERVALS.filter((v) => SHARED_MODEL_IVS.has(v))) {
      const group = loaded.filter((m) => m.iv === iv);
      const sig = iv + "|" + group.map((m) => `${m.sym}:${m.c.at(-2)?.time}`).sort().join(",");
      if (pooledByIv.get(iv)?.sig === sig) continue;
      try {
        const model = await trainPooledAsync(group.map((m) => ({ candles: m.c, cost: m.cost })));
        pooledByIv.set(iv, { sig, model });
      } catch { pooledByIv.delete(iv); }
    }
  }

  // 3) Analyze each market in background threads, reusing results when nothing has changed.
  const queueA = loaded.slice();
  const analyzer = async () => {
    while (queueA.length) {
      const { sym, iv, c, cost } = queueA.shift();
      try {
        const pooled = pooledByIv.get(iv);
        const key = `${sym}|${iv}`, lastClosedTime = c.at(-2)?.time;
        const hit = resultCache.get(key);
        let r;
        if (hit && hit.t === lastClosedTime && hit.sig === pooled?.sig && Math.abs(hit.cost - cost) < 0.0002) r = hit.r;
        else {
          r = await analyzeAsync(c, { costPerSide: cost, pooled: pooled?.model || null });
          resultCache.set(key, { t: lastClosedTime, cost, sig: pooled?.sig, r });
        }
        logFromAnalysis(sym, iv, c, r);
        out.push({ sym, iv, r });
      } catch { /* skip */ }
      step(0.5);
      if (out.length % 6 === 0) { progress = `Checked ${out.length} of ${loaded.length}…`; render(); }
    }
  };
  await Promise.all([analyzer(), analyzer(), analyzer(), analyzer()]);
  done = total; jobs.length = 0;
  const keep = hooks.getWatchlist();
  rows = only ? rows.filter((x) => !syms.includes(x.sym) && keep.includes(x.sym)).concat(out) : out;
  syms.forEach((s) => checked.add(s));
  if (!only) lastRun = Date.now();
  running = false;
  pending.clear();
  progress = "";
  render();
  hooks.onProgress({ running: false, done: total, total });
  const buysNow = currentBuys();
  // A market just turned green: tell the user right away (not on the first check after opening the page).
  if (!only && prevBuys) {
    for (const b of buysNow) {
      if (prevBuys.has(`${b.sym}|${b.iv}`)) continue;
      hooks.onNewBuy?.(b);
    }
  }
  if (!only) prevBuys = new Set(buysNow.map((b) => `${b.sym}|${b.iv}`));
  hooks.onUpdate(buysNow);
  if (!only) setTimeout(() => runRadar(), 1500);
  const d = nextDelay();
  schedule(d == null ? null : only && lastRun ? Math.max(5_000, d - (Date.now() - lastRun)) : d);
  if (fullAgain) { fullAgain = false; queued.length = 0; run(); return; }
  if (queued.length) { const q = [...new Set(queued)]; queued.length = 0; run(q); }
}
const queued = [];
const resultCache = new Map();
const SHARED_MODEL_IVS = new Set(["1d"]);
const pooledByIv = new Map();    // interval → { sig, model } (the shared prediction model)
/** The shared prediction model for a candle size, if the watchlist check has trained one (for the chart). */
export function pooledModelFor(iv) { return pooledByIv.get(iv)?.model || null; }   // "SYM|interval" → { t: last closed candle time, cost, r }

function radarHtml() {
  const buys = radarBuys(), watch = radarWatch(8);
  const name = (s) => fmt.esc(s.replace(/^S:/, "").replace(/(USDT|USDC|USD)$/, ""));
  const row = (x, pill) => `<button class="opp-row${x.buy ? " opp-buy" : ""}" data-any-sym="${fmt.esc(x.sym)}">
      <span class="opp-coin">${name(x.sym)}</span><span class="mono opp-iv">1D</span>${pill}
      <span>${x.buy ? "Trend breakout" : `BUY above <strong class="mono">${fmt.price(x.level)}</strong>`}</span>
      <span class="mono small">${x.buy ? (x.n ? `here: ${fmt.pct(x.ev * 100)}/trade over ${x.n}` : "") : (x.away > 0 ? `+${x.away.toFixed(1)}% away` : "above it now: watch the close")}</span></button>`;
  return `<h3>📡 Trend radar: ${RADAR.length} popular markets ${buys.length ? `<span class="pill pill-edge">${buys.length}</span>` : ""}</h3>
    <p class="muted tiny">The same trend rule on big coins, stocks and ETFs that aren't on your list (trend following works best spread over many markets). ${radarRunning ? `<span class="typing"><i></i><i></i><i></i></span> Checking…` : radar ? `Checked ${new Date(radar.at).toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit" })}. <button class="link-btn tiny" id="radar-refresh">Check again</button>` : "Starts after your watchlist check."}</p>
    ${buys.length ? `<div class="opps-list">${buys.map((x) => row(x, `<span class="pill pill-edge">BUY</span>`)).join("")}</div>` : radar ? `<p class="muted small">No BUY signals in these markets right now.</p>` : ""}
    ${watch.length ? `<p class="muted tiny">Closest to a BUY:</p><div class="opps-list">${watch.map((x) => row(x, `<span class="pill pill-thin">WATCH</span>`)).join("")}</div>` : ""}`;
}

function render() {
  const root = $("tab-opps");
  if (!root) return;
  const buys = rows.filter(({ r }) => isBuy(r));
  const watch = watchRows();
  const markets = new Set(rows.map((x) => x.sym)).size;
  const thin = rows.filter(({ r }) => r.liquidity && !r.liquidity.ok);
  const thinNames = [...new Set(thin.map((x) => `${baseOf(x.sym)} ${x.iv}`))];
  const count = $("opps-count");
  if (count) { count.textContent = buys.length; count.hidden = !buys.length; }

  root.innerHTML = `
    <p class="muted small explain">Entryvex checks <strong>every market in your watchlist</strong> on daily candles with its trend rule: BUY when a market in an uptrend closes at a new 20-day high, then sell with a trailing stop. On data it never saw it made money after fees, with much smaller drops than just holding (<button class="link-btn" data-open-score>how it was tested</button>). Click any row to open it.</p>
    <div class="opps-status">
      <span>${running ? `<span class="typing"><i></i><i></i><i></i></span> ${fmt.esc(progress)}` : lastRun
        ? `Last checked ${new Date(lastRun).toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit" })}: ${markets} markets on daily candles.`
        : "Starting the first check…"}</span>
      <button class="ghost-btn" id="opps-refresh" ${running ? "disabled" : ""}>Check now</button>
    </div>

    <h3>Buy signals right now ${buys.length ? `<span class="pill pill-edge">${buys.length}</span>` : ""}</h3>
    ${buys.length ? `<div class="opps-list">${buys.map(({ sym, iv, r }) => {
      const s = r.best.stats;
      return `<button class="opp-row opp-buy" data-sym="${sym}" data-iv="${iv}">
        <span class="opp-coin">${fmt.esc(baseOf(sym))}</span><span class="mono opp-iv">${IV_SHORT[iv] || iv}</span>
        <span class="pill pill-edge">BUY</span>
        <span>${fmt.esc(r.best.name)}</span>
        <span class="mono small">${s.n ? `here: ${fmt.pct(s.ev * 100)}/trade over ${s.n}` : "new market"}</span></button>`;
    }).join("")}</div>`
      : `<p class="muted small">${lastRun ? "No buy signals anywhere in your watchlist right now. That's normal: most of the time the honest answer is to wait." : "…"}</p>`}

    <h3>Watch these: in an uptrend, close to a BUY</h3>
    ${watch.length ? `<p class="muted tiny">Each turns into a BUY when a day closes above the price shown. Setup alerts (🔔) tell you when it happens.</p>
      <div class="opps-list">${watch.slice(0, 12).map(({ sym, iv, level, away }) => `
        <button class="opp-row" data-sym="${sym}" data-iv="${iv}">
          <span class="opp-coin">${fmt.esc(baseOf(sym))}</span><span class="mono opp-iv">${IV_SHORT[iv] || iv}</span>
          <span class="pill pill-thin">WATCH</span>
          <span>BUY above <strong class="mono">${fmt.price(level)}</strong></span>
          <span class="mono small">${away > 0 ? `+${away.toFixed(1)}% away` : "above it now: watch the close"}</span></button>`).join("")}</div>`
      : `<p class="muted small">${lastRun ? "None of your watchlist is in a daily uptrend right now. The trend rule waits; try adding more coins or stocks." : "…"}</p>`}
    ${radarHtml()}
    ${thinNames.length ? `<p class="muted tiny">Skipped because they barely trade on Binance.US at that candle size (prices jump, stops can't protect you): ${thinNames.map(fmt.esc).join(", ")}.</p>` : ""}`;
}
