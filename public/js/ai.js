// "Ask the analyst" chat. Sends your question plus a compact snapshot of the live data
// on screen to /api/ask, and shows the answer.
import * as fmt from "./format.js";
import { openTrades } from "./journal.js";

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

function round(v, d = 6) { return v == null || !isFinite(v) ? null : +(+v).toPrecision(d); }

async function snapshot() {
  const f = live.forecast, a = live.analysis?.result;
  let news = null;
  try {
    const r = await fetch(`/api/news?coin=${encodeURIComponent(live.base || "")}`);
    const d = await r.json();
    const items = d.items.slice(0, 12);
    const c = { positive: 0, negative: 0, neutral: 0 };
    d.items.forEach((i) => i.mood && c[i.mood.label]++);
    news = { moodCounts: c, headlines: items.map((i) => ({ title: i.title, source: i.source, mood: i.mood?.label, hoursAgo: i.published ? round((Date.now() - i.published) / 3.6e6, 2) : null })) };
  } catch {}
  const s = hooks.getSettings();
  return {
    coin: { name: live.name, ticker: live.base, pair: `${live.base}/${live.quote}`, exchange: "Binance.US (spot only; you can buy then sell, no shorting)" },
    price: { now: round(live.price), change24hPct: round(live.change24h, 3), high24h: round(live.high24h), low24h: round(live.low24h), volume24hUsd: round(live.volume24h, 4) },
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
