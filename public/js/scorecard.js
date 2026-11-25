// "📏 Scorecard" tab: Entryvex's price forecasts, saved before the fact and checked after
// (functions/api/scorecard.js does the saving and checking on the server). Nothing is hidden:
// misses count the same as hits, and every recent check is listed.
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
let data = null, visible = false, loadedAt = 0, hooks = { openMarket: () => {}, onLoad: () => {} };
const LIVE_MIN = 20;   // use the live record for a market once it has this many checks

const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const HORIZON = { "1h": "next ~20 hours", "1d": "next ~20 trading days" };
const CHART = { "1h": "1h chart", "1d": "1D chart" };

export function initScorecard(h) {
  hooks = { ...hooks, ...h };
  $("tab-score").addEventListener("click", (e) => {
    const b = e.target.closest("[data-score-open]");
    if (b) hooks.openMarket(b.dataset.scoreOpen);
  });
  load();
  loadWalk();
}
export function scorecardVisible(on) { visible = on; if (on) load(true).then(render); }

async function load(force) {
  if (!force && data && Date.now() - loadedAt < 10 * 60e3) return data;
  const first = !data;
  try { const r = await fetch("/api/scorecard"); if (r.ok) { data = await r.json(); loadedAt = Date.now(); if (first) hooks.onLoad(); } } catch {}
  return data;
}

/* ---------- BUY signals tested on unseen data (tools/walkforward.mjs → public/data/walkforward.json) ---------- */
let walk = null;
async function loadWalk() {
  try { const r = await fetch("/data/walkforward.json"); if (r.ok) { walk = await r.json(); hooks.onLoad(); } } catch {}
}
const pp = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;
/** Plain verdict for one candle size of the OLD answers (before the rebuild). */
function walkVerdict(g) {
  const n = (g.buy?.n || 0) + (g.smallBuy?.n || 0);
  if (n < 20) return null;
  const avg = ((g.buy.avg || 0) * (g.buy.n || 0) + (g.smallBuy.avg || 0) * (g.smallBuy.n || 0)) / n;
  return { n, avg };
}
const pct0 = (x) => `${Math.round(x * 100)}%`;
/** One line for the answer card under a BUY: how the trend rule did on unseen data. */
export function walkLine(iv) {
  const t = walk?.trend;
  if (!t?.buy?.n || iv !== "1d") return "";
  return `🧪 <strong>Tested on unseen data</strong> (${t.markets} markets, ${walk.period.from.slice(0, 4)}–${walk.period.to.slice(0, 4)}): this rule made ${pp(t.buy.avg)} per trade after fees over ${t.buy.n} trades, winning ${pct0(t.buy.win)}. Buying at random moments with the same stops made ${pp(t.random.avg)}, so the timing edge is small; the bigger benefit is risk: its worst drop was ${pct0(t.median.dd)} vs ${pct0(t.median.holdDd)} for just holding (typical market). <strong>Start with the practice account or a small amount.</strong> <button class="link-btn" data-open-score>How this was tested</button>`;
}
function walkSection() {
  const t = walk?.trend;
  if (!t?.buy?.n) return "";
  const row = (label, a, cls = "") => a?.n ? `<tr class="${cls}"><td>${label}</td><td class="num">${Math.round(a.n)}</td><td class="num ${a.avg >= 0 ? "up" : "down"}">${pp(a.avg)}</td><td class="num">${pct0(a.win)}</td><td class="num">${a.days ? Math.round(a.days) + "d" : "—"}</td></tr>` : "";
  const m = t.median;
  const IVN = { "1h": "1-hour", "4h": "4-hour", "1d": "Daily" };
  const before = walk.before?.byIv ? Object.entries(walk.before.byIv).map(([iv, g]) => { const v = walkVerdict(g); return v ? `${IVN[iv] || iv} ${pp(v.avg)} (random ${pp(g.random.avg)})` : ""; }).filter(Boolean).join(" · ") : "";
  return `<h4>🧪 BUY signals tested on unseen data</h4>
    <p class="muted small">Entryvex says BUY only with its <strong>trend rule</strong> on daily candles: an uptrend (price above its 200-day average, 50-day above the 200-day) and a day closing above the previous 20-day high; then a stop ${walk.rule.stopAtr} ATR under the entry that trails ${walk.rule.trailAtr} ATR under the highest price since buying. Its numbers are textbook values fixed before testing, so nothing was fitted to these results. Replayed on ${t.markets} markets from ${walk.period.from} to ${walk.period.to}, after fees, looking only at the history up to each moment. Updated ${walk.generated}.</p>
    <div class="score-tiles">
      <div class="score-tile"><div class="score-tile-h"><strong>Per trade</strong> <span class="small ${t.buy.avg > t.random.avg ? "up" : ""}">${t.buy.avg > 0 ? "made money after fees" : "lost money"}</span></div>
        <table class="score-table"><thead><tr><th>Entries</th><th class="num">Trades</th><th class="num">Avg per trade</th><th class="num">Won</th><th class="num">Held</th></tr></thead><tbody>
          ${row("Trend rule (the BUY answers)", t.buy)}${row("Random moments, same stops", t.random, "muted")}${row("Random moments in an uptrend", t.randomUp, "muted")}
        </tbody></table>
        <p class="tiny muted">Beat random timing in ${t.beatRandom} of ${t.markets} markets, and random timing in an uptrend in ${t.beatRandomUp} of ${t.markets}.</p></div>
      <div class="score-tile"><div class="score-tile-h"><strong>Versus just holding</strong> <span class="small muted">typical (median) market</span></div>
        <table class="score-table"><thead><tr><th></th><th class="num">Per year</th><th class="num">Worst drop</th><th class="num">In the market</th></tr></thead><tbody>
          <tr><td>Trend rule</td><td class="num ${m.cagr >= 0 ? "up" : "down"}">${pp(m.cagr)}</td><td class="num down">−${pct0(m.dd)}</td><td class="num">${pct0(m.inMarket)} of the time</td></tr>
          <tr class="muted"><td>Just holding</td><td class="num">${pp(m.holdCagr)}</td><td class="num down">−${pct0(m.holdDd)}</td><td class="num">100%</td></tr>
        </tbody></table></div>
    </div>
    <p class="small"><strong>What this means:</strong> the trend rule made money after fees, a little more per trade than random timing, and cut the worst drops by more than half. But over these years, when most of these markets rose a lot, simply holding earned more. Its job is to keep you out of the big crashes and catch the strong runs, not to beat the market. Most trend trades lose a little; a few big winners pay for them, so judge it over many trades.</p>
    ${before ? `<p class="small muted"><strong>Why Entryvex was rebuilt:</strong> its earlier BUY answers (short-term setups) lost money per trade on unseen data: ${before}. They no longer produce a BUY.</p>` : ""}`;
}

/** The record for one market and chart, for the forecast box: live once it has enough checks, else tested. */
export function scoreFor(sym, iv) {
  const m = data?.markets?.find((x) => x.sym === sym)?.[iv];
  if (!m) return null;
  const useLive = m.live.n >= LIVE_MIN;
  const r = useLive ? m.live : m.back;
  if (!r?.n) return null;
  return { live: useLive, n: r.n, in80: pct(r.in80, r.n), dir: pct(r.right, r.called), called: r.called, liveN: m.live.n };
}

/** Overall range record across markets (1h chart), for the daily brief. */
export function scoreSummary() {
  const o = data?.overall?.["1h"];
  if (!o) return null;
  const live = o.live.n >= LIVE_MIN, r = live ? o.live : o.back;
  return r.n ? { live, n: r.n, in80: pct(r.in80, r.n) } : null;
}

/** One plain sentence for the forecast box ("" if this market/chart isn't tracked). */
export function scoreLine(sym, iv) {
  const s = scoreFor(sym, iv);
  if (!s) return "";
  const src = s.live ? `the last ${s.n} live forecasts` : `${s.n} tests on past data`;
  const dir = s.called >= 10 ? ` The up/down lean was right ${s.dir}% of the time${s.dir < 55 ? " (close to a coin flip, so lean on the range, not the lean)" : ""}.` : "";
  return `📏 <strong>Scorecard</strong> (${src}): price ended inside the 80% range <strong>${s.in80}%</strong> of the time.${dir} <button class="link-btn" data-open-score>See every check</button>`;
}

function rangeVerdict(p) {
  if (p == null) return { cls: "", word: "—" };
  if (Math.abs(p - 80) <= 6) return { cls: "up", word: "on target" };
  if (p < 80) return { cls: p < 70 ? "down" : "", word: "a bit too narrow" };
  return { cls: "", word: "a bit too wide (cautious)" };
}
function dirVerdict(p, n) {
  if (p == null || n < 10) return { cls: "", word: "not enough calls yet" };
  if (p >= 58) return { cls: "up", word: "better than a coin flip" };
  if (p >= 52) return { cls: "", word: "slightly better than a coin flip" };
  return { cls: "down", word: "no better than a coin flip" };
}

function tile(iv) {
  const o = data.overall[iv], live = o.live.n >= LIVE_MIN, r = live ? o.live : o.back;
  const rp = pct(r.in80, r.n), dp = pct(r.right, r.called);
  const rv = rangeVerdict(rp), dv = dirVerdict(dp, r.called);
  return `<div class="score-tile">
    <div class="score-tile-h"><strong>${CHART[iv]}</strong> <span class="muted small">forecasting the ${HORIZON[iv]}</span></div>
    <div class="bot-tiles">
      <div><span>Price landed in the 80% range</span><strong class="${rv.cls}">${rp == null ? "—" : rp + "%"}</strong><small>aim: 80% · ${rv.word}</small></div>
      <div><span>Up/down lean was right</span><strong class="${dv.cls}">${dp == null ? "—" : dp + "%"}</strong><small>coin flip: 50% · ${dv.word}</small></div>
    </div>
    <p class="muted small">${live ? `Live: ${o.live.n} forecasts saved in advance and checked.` : `${o.back.n} tests on past data (each forecast used only the candles before that moment).`} Live checks so far: ${o.live.n}.</p>
  </div>`;
}

function cell(m, iv) {
  const x = m[iv], live = x.live.n >= LIVE_MIN, r = live ? x.live : x.back;
  if (!r?.n) return `<td class="muted">—</td>`;
  const rp = pct(r.in80, r.n), dp = pct(r.right, r.called);
  const rv = rangeVerdict(rp), dv = dirVerdict(dp, r.called);
  return `<td title="${live ? "Live record" : "Tested on past data"}: ${r.n} forecasts${x.live.n && !live ? `, ${x.live.n} live so far` : ""}">
    <span class="${rv.cls}">${rp}%</span> <span class="muted">in range</span><br>
    <span class="${dv.cls}">${dp == null ? "—" : dp + "%"}</span> <span class="muted">lean right${r.called < 10 ? " (few calls)" : ""}</span></td>`;
}

function recentRow(g) {
  const lean = g.call ? `lean ${g.call} (${Math.round(g.pUp * 100)}% up)` : "no lean (coin flip)";
  const dir = g.call ? (g.right ? `<span class="up">lean ✓</span>` : `<span class="down">lean ✗</span>`) : `<span class="muted">no lean</span>`;
  return `<div class="score-row">
    <button class="link-btn" data-score-open="${fmt.esc(g.sym)}">${fmt.esc(g.name)}</button>
    <span class="muted small">${CHART[g.iv]} · ${when(g.at)}</span>
    <span class="small">said ${fmt.price(g.lo)}–${fmt.price(g.hi)}, ${lean}</span>
    <span class="small">ended ${fmt.price(g.actual)} ${g.in80 ? `<span class="up">in range ✓</span>` : `<span class="down">outside ✗</span>`} · ${dir}</span>
  </div>`;
}

function render() {
  const el = $("tab-score");
  if (!el || !visible) return;
  if (!data) { el.innerHTML = `<p class="muted small">Loading the scorecard…</p>`; return; }
  if (!data.started) { el.innerHTML = `<p class="muted small">The scorecard starts within the next few minutes. Check back soon.</p>`; return; }
  const tested = data.markets.map((m) => m["1d"].back).filter(Boolean);
  const from = tested.length ? Math.min(...tested.map((b) => b.from || Infinity)) : null;
  el.innerHTML = `
    <div class="bot-head"><div>
      <h3>📏 Forecast scorecard</h3>
      <p class="muted small">Every forecast here is <strong>saved before it happens and checked after</strong>, for the ${data.markets.length} markets the bot trades. Misses count the same as hits. An honest forecast lands inside its 80% range about 80% of the time; an up/down lean is only useful if it beats a 50% coin flip.</p>
    </div></div>
    <div class="score-tiles">${data.ivs.map(tile).join("")}</div>
    <h4>By market</h4>
    <div class="score-table-wrap"><table class="score-table">
      <thead><tr><th>Market</th>${data.ivs.map((iv) => `<th>${CHART[iv]}</th>`).join("")}</tr></thead>
      <tbody>${data.markets.map((m) => `<tr><td><button class="link-btn" data-score-open="${fmt.esc(m.sym)}">${fmt.esc(m.name)}</button></td>${data.ivs.map((iv) => cell(m, iv)).join("")}</tr>`).join("")}</tbody>
    </table></div>
    <p class="muted small">Each cell uses the live record once it has ${LIVE_MIN} checks; until then, tests on past data${from && isFinite(from) ? ` (daily tests go back to ${day(from)})` : ""}.</p>
    ${walkSection()}
    <h4>Latest checks</h4>
    ${data.recent.length ? `<div class="score-list">${data.recent.slice(0, 25).map(recentRow).join("")}</div>`
      : `<p class="muted small">No live forecast has finished yet.${data.nextCheck ? ` The first check is due around ${when(data.nextCheck)}.` : ""}</p>`}
    <p class="muted small">${data.waiting} forecast${data.waiting === 1 ? "" : "s"} waiting to be checked.</p>
    <details class="small"><summary>How this is measured</summary>
      <p class="muted">Every 4 hours (1h chart) or once a day (1D chart), the server saves Entryvex's forecast for each market: the range price should end in after 20 candles, and the measured odds of being higher. US stocks are only saved while the market is open. When the 20 candles have closed, the real price is compared with what was said. A lean counts only when the odds were at least ${Math.round((0.5 + data.lean) * 100)}% one way; otherwise it's a coin flip and isn't scored. The record can't be edited after the fact.</p>
    </details>`;
}
