// "Ask the analyst" chat. Sends your question plus a compact snapshot of the live data
// on screen to /api/ask, and shows the answer.
import * as fmt from "./format.js";
import { openTrades } from "./journal.js";
import { getChecks } from "./decision.js";
import { cachedLongTerm, cachedFundamentals } from "./longterm.js";
import { getBuyNowSummary } from "./buynow.js";
import { currentBuys, topWatch, signalFor } from "./opportunities.js";

const $ = (id) => document.getElementById(id);
let live = {};
let hooks = { getSettings: () => ({}) };
let chat = [];
try { chat = JSON.parse(sessionStorage.getItem("evx.chat") || "[]"); } catch {}
const saveChat = () => { try { sessionStorage.setItem("evx.chat", JSON.stringify(chat.slice(-20))); } catch {} };

const SUGGEST = [
  "Is now a good time to buy {coin}?",
  "Explain what the scanner is saying, in simple terms.",
  "If I put $500 into {coin}, what's my risk?",
  "Where is {coin} likely to be in the next few hours?",
  "What's the news saying about {coin}?",
  "Which candle size works best for {coin}?",
];

export function setAIContext(ctx) {
  const changed = ctx.base !== live.base;
  live = ctx;
  if (changed) renderSuggest();
}

export function initAI(h) {
  hooks = { ...hooks, ...h };
  $("ai-briefing").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "brief-run") runBriefing(true);
    if (b.dataset.sym) hooks.onPick?.(b.dataset.sym);
  });
  renderBriefing(loadBriefing());
  $("ai-form").addEventListener("submit", (e) => { e.preventDefault(); ask($("ai-input").value); });
  $("ai-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask($("ai-input").value); }
  });
  $("ai-suggest").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) ask(b.dataset.q); });
  $("ai-chat").addEventListener("click", (e) => { if (e.target.closest("[data-clear-chat]")) { chat = []; saveChat(); renderChat(); } });
  renderChat();
  renderSuggest();
}

function renderSuggest() {
  const coin = live.base || "this coin";
  $("ai-suggest").innerHTML = SUGGEST.map((q) => q.replace("{coin}", coin))
    .map((q) => `<button class="chip" data-q="${fmt.esc(q)}">${fmt.esc(q)}</button>`).join("");
}

/* ---------------- Watchlist briefing ---------------- */
function loadBriefing() {
  try { return JSON.parse(localStorage.getItem("evx.briefing") || "null"); } catch { return null; }
}
let briefingBusy = false;
async function runBriefing() {
  if (briefingBusy) return;
  briefingBusy = true;
  renderBriefing(loadBriefing(), "Reading the latest news for every coin and stock on your watchlist…");
  try {
    const list = hooks.getWatchlistInfo?.() || [];
    const since = Date.now() - 48 * 3600e3;
    const items = [];
    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const w = queue.shift();
        let headlines = [];
        try {
          const qs = w.kind === "stock" ? `stock=${encodeURIComponent(w.ticker)}&name=${encodeURIComponent(w.name)}` : `coin=${encodeURIComponent(w.ticker)}`;
          const d = await (await fetch(`/api/news?${qs}`)).json();
          headlines = d.items.filter((i) => !i.published || i.published >= since).slice(0, 4).map((i) => ({ title: i.title, mood: i.mood?.label }));
        } catch {}
        items.push({ ...w, headlines });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    items.sort((a, b) => list.findIndex((x) => x.sym === a.sym) - list.findIndex((x) => x.sym === b.sym));
    const res = await fetch("/api/briefing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "unavailable");
    const saved = {
      ...d, at: Date.now(),
      symbols: Object.fromEntries(items.map((x) => [x.ticker.toUpperCase(), x.sym])),
      changes: Object.fromEntries(items.map((x) => [x.ticker.toUpperCase(), x.changePct])),   // real price change, from live data
    };
    try { localStorage.setItem("evx.briefing", JSON.stringify(saved)); } catch {}
    renderBriefing(saved);
  } catch (e) {
    renderBriefing(loadBriefing(), `Couldn't create the briefing: ${e.message}. Try again in a minute.`);
  }
  briefingBusy = false;
}
function renderBriefing(b, status = "") {
  const el = $("ai-briefing");
  const fresh = b && Date.now() - b.at < 30 * 60e3;
  el.innerHTML = `<div class="brief-head"><strong>Watchlist briefing</strong>
      <button class="btn" id="brief-run" ${briefingBusy ? "disabled" : ""}>${b ? "Refresh briefing" : "Brief me on my watchlist"}</button></div>
    ${status ? `<p class="small muted">${briefingBusy ? '<span class="typing"><i></i><i></i><i></i></span> ' : ""}${fmt.esc(status)}</p>` : ""}
    ${b?.lines?.length ? `<ul class="brief-list">${b.lines.map((l) => {
        const ch = b.changes?.[l.ticker];
        const move = ch == null || !isFinite(ch) ? "" : `<span class="mono brief-chg ${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "▲ +" : "▼ "}${ch.toFixed(2)}%</span>`;
        return `<li><button class="link-btn brief-sym" data-sym="${fmt.esc(b.symbols?.[l.ticker] || "")}">${fmt.esc(l.ticker)}</button>${move} ${fmt.esc(l.text)}</li>`;
      }).join("")}</ul>
      ${b.watch ? `<p class="small brief-watch"><strong>Watch:</strong> ${fmt.esc(b.watch)}</p>` : ""}
      <p class="tiny muted">Written by AI from each symbol's latest headlines, price change and Entryvex's signals${b.at ? ` at ${new Date(b.at).toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit" })}` : ""}${fresh ? "" : " (over 30 minutes old: refresh for the latest)"}. It can be wrong; tap a ticker to check.</p>`
      : (!status ? `<p class="small muted">One tap: Entryvex reads the latest news for every coin and stock on your watchlist and summarizes what's going on.</p>` : "")}`;
}

function round(v, d = 6) { return v == null || !isFinite(v) ? null : +(+v).toPrecision(d); }

async function snapshot() {
  const f = live.forecast, a = live.analysis?.result;
  let news = null;
  try {
    const r = await fetch(live.isStock ? `/api/news?stock=${encodeURIComponent(live.base || "")}&name=${encodeURIComponent(live.name || "")}` : `/api/news?coin=${encodeURIComponent(live.base || "")}`);
    const d = await r.json();
    const items = d.items.slice(0, 12);
    const c = { positive: 0, negative: 0, neutral: 0 };
    d.items.forEach((i) => i.mood && c[i.mood.label]++);
    news = { moodCounts: c, headlines: items.map((i) => ({ title: i.title, source: i.source, mood: i.mood?.label, hoursAgo: i.published ? round((Date.now() - i.published) / 3.6e6, 2) : null })) };
  } catch {}
  const s = hooks.getSettings();
  return {
    asset: live.isStock
      ? { type: "US stock/ETF", name: live.name, ticker: live.base, market: "US stock market, bought through the user's broker (e.g. Schwab); regular hours 9:30am-4pm New York time; $0 commission", marketOpenNow: live.marketOpen }
      : { type: "crypto", name: live.name, ticker: live.base, pair: `${live.base}/${live.quote}`, market: "Binance.US spot (buy then sell, no shorting), trades 24/7" },
    price: { now: round(live.price), [live.isStock ? "changeVsYesterdayClosePct" : "change24hPct"]: round(live.change24h, 3), high24h: round(live.high24h), low24h: round(live.low24h), volume24hUsd: round(live.volume24h, 4) },
    candleSize: live.interval,
    forecast: f ? {
      horizon: `next ${f.H} candles of ${f.interval}`,
      range80pct: [round(f.range80[0]), round(f.range80[1])], range50pct: [round(f.range50[0]), round(f.range50[1])], middle: round(f.mid),
      testedAccuracyOf80pctRange: `${Math.round(f.accuracy80 * 100)}% of ${f.tested} past tests finished inside it`,
      chanceHigherAfterHorizon: `${Math.round(f.pUp * 100)}% (from ${f.nUp} past cases)`,
      chanceHigherWhenTrendLikeNow: isFinite(f.pUpTrend) ? `${Math.round(f.pUpTrend * 100)}% (${f.nTrend} cases; price ${f.trendLabel})` : null,
    } : "not loaded",
    scanner: a ? {
      verdictNow: a.overall.label, explanation: a.overall.text,
      rules: "Each setup was replayed on the last ~3000 candles: buy next candle's open, stop 1x ATR below, target 1.5x ATR above, max 24 candles, fees+spread both ways.",
      setups: a.setups.map((x) => ({ name: x.name, activeNow: x.activeNow, timesSeen: x.stats.n, endedInProfitPct: x.stats.n ? Math.round(x.stats.winRate * 100) : null,
        avgResultPerTradePct: x.stats.n ? round(x.stats.ev * 100, 3) : null, verdict: x.verdict.label })),
      tradePlan: a.plan && a.best && a.best.verdict.level !== "negative" ? { buyAround: round(a.plan.entry), stopLoss: round(a.plan.stop), takeProfit: round(a.plan.target) } : null,
      costPerSidePct: round(a.costPerSide * 100, 3),
    } : "not loaded",
    news,
    entryvexSays: a ? {
      verdict: a.liquidity && !a.liquidity.ok ? "DON'T BUY (market barely trades)" : a.overall.label,
      liquidity: a.liquidity && !a.liquidity.ok ? a.liquidity.reason : "trades normally",
      buyTriggersWithTrackRecord: (a.triggers || []).filter((t) => t.setup && ["edge", "weak"].includes(t.setup.verdict.level)).map((t) => ({
        setup: t.setup.name, verdict: t.setup.verdict.label, possibleNow: t.ready,
        condition: t.text.replace("{L}", t.level != null ? String(round(t.level)) : ""), distanceFromPricePct: t.away != null ? round(t.away, 3) : null,
        pastRecord: `${Math.round(t.setup.stats.winRate * 100)}% of ${t.setup.stats.n} ended in profit, ${round(t.setup.stats.ev * 100, 3)}%/trade after costs` })),
    } : "not loaded",
    outsideChecks: (getChecks(live.symbol, live.interval) || []).map((x) => ({ check: x.label, says: x.text, effect: x.effect > 0 ? "helping" : x.effect < 0 ? "against" : "neutral" })),
    longTermHold: (() => { const lt = cachedLongTerm(live.symbol); return lt ? {
      trend: lt.above200 ? (lt.golden ? "uptrend (above 200-day, 50-day above 200-day)" : "mixed (above 200-day)") : (lt.golden ? "mixed (below 200-day)" : "downtrend (below 200-day)"),
      returnsPct: { "1m": round(lt.r1m, 3), "3m": round(lt.r3m, 3), "6m": round(lt.r6m, 3), "1y": round(lt.r1y, 3) }, fromOneYearHighPct: round(lt.fromHigh, 3), yearlySwingPct: round(lt.vol, 3),
      held3Months: lt.hold ? `${Math.round(lt.hold.pUp * 100)}% ended higher; typical ${Math.round(lt.hold.p10 * 100)}% to +${Math.round(lt.hold.p90 * 100)}% (${lt.hold.n} past cases, ~${Math.round(lt.years)} years)` : null,
    } : "not loaded"; })(),
    companyFundamentals: (cachedFundamentals(live.symbol) || []).map((l) => `${l.k}: ${String(l.t).replace(/<[^>]+>/g, "")}`),
    ifUserBuysNow: getBuyNowSummary() || "balance not set or not loaded",
    acrossWatchlist: {
      buySignalsNow: currentBuys().map((b) => `${b.base} ${b.iv}: ${b.label === "GO" ? "BUY" : "SMALL BUY"} (${b.setup})`),
      setupsToWatch: topWatch(6).map((w) => `${w.base} ${w.iv}: ${w.s.name} (${w.s.verdict.label}, ${Math.round(w.s.stats.winRate * 100)}% of ${w.s.stats.n})`),
      perSymbol: (hooks.getWatchlistInfo?.() || []).slice(0, 20).map((w) => `${w.ticker}: ${w.changePct != null ? (w.changePct >= 0 ? "+" : "") + w.changePct.toFixed(2) + "% today, " : ""}${signalFor(w.sym)}`),
    },
    user: { tradingBalanceUsd: s.balance || "not set", maxLossPerTradePct: s.riskPct, feePerBuyOrSellPct: s.feePct,
      openTradesInThisCoin: openTrades().filter((t) => t.symbol === live.symbol).map((t) => ({ boughtAt: t.entry, amount: t.qty, stop: t.stop, target: t.target })) },
  };
}

let busy = false;
async function ask(q) {
  q = String(q || "").trim();
  if (!q || busy) return;
  busy = true;
  $("ai-input").value = "";
  chat.push({ role: "user", content: q });
  chat.push({ role: "assistant", content: "", pending: true });
  renderChat();
  try {
    const context = await snapshot();
    const res = await fetch("/api/ask", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: q, history: chat.filter((m) => !m.pending).slice(-7, -1), context }),
    });
    const d = await res.json();
    chat[chat.length - 1] = { role: "assistant", content: d.answer || d.error || "No answer.", coin: live.base, error: !d.answer };
  } catch {
    chat[chat.length - 1] = { role: "assistant", content: "Couldn't reach the analyst. Check your connection and try again.", error: true };
  }
  busy = false;
  saveChat();
  renderChat();
}

function md(text) {
  // Tiny, safe formatter: escape first, then **bold** and "- " bullets.
  const lines = fmt.esc(text).split("\n");
  let html = "", inList = false;
  for (const l of lines) {
    const b = l.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (b) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${b[1]}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    if (l.trim()) html += `<p>${l}</p>`;
  }
  if (inList) html += "</ul>";
  return html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function renderChat() {
  const box = $("ai-chat");
  if (!chat.length) { box.innerHTML = ""; box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = chat.map((m) => m.role === "user"
    ? `<div class="msg msg-user">${fmt.esc(m.content)}</div>`
    : `<div class="msg msg-ai ${m.error ? "msg-err" : ""}">${m.pending ? `<span class="typing"><i></i><i></i><i></i></span> Reading the live data…` : md(m.content)}</div>`).join("")
    + `<button class="link-btn" data-clear-chat>Clear chat</button>`;
  box.scrollTop = box.scrollHeight;
}
