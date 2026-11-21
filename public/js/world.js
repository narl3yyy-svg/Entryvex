// World markets board: major indices across the Americas, Europe and Asia-Pacific, plus the
// global "macro" prices traders watch (gold, oil, the dollar, euro, yen, US 10-year yield, VIX).
// Each shows today's change vs. the previous close, a small intraday chart, and whether that
// market is open right now. Refreshes every 60 seconds while visible.
import * as fmt from "./format.js";
import { registerStock } from "./market.js";

const GROUPS = [
  { name: "Americas", items: [
    ["^GSPC", "S&P 500", "🇺🇸"], ["^IXIC", "Nasdaq", "🇺🇸"], ["^DJI", "Dow Jones", "🇺🇸"], ["^RUT", "Russell 2000", "🇺🇸"],
    ["^GSPTSE", "TSX (Canada)", "🇨🇦"], ["^BVSP", "Bovespa (Brazil)", "🇧🇷"], ["^MXX", "IPC (Mexico)", "🇲🇽"],
  ] },
  { name: "Europe", items: [
    ["^FTSE", "FTSE 100 (UK)", "🇬🇧"], ["^GDAXI", "DAX (Germany)", "🇩🇪"], ["^FCHI", "CAC 40 (France)", "🇫🇷"], ["^STOXX50E", "Euro Stoxx 50", "🇪🇺"],
  ] },
  { name: "Asia-Pacific", items: [
    ["^N225", "Nikkei 225 (Japan)", "🇯🇵"], ["^HSI", "Hang Seng (HK)", "🇭🇰"], ["000001.SS", "Shanghai (China)", "🇨🇳"],
    ["^BSESN", "Sensex (India)", "🇮🇳"], ["^KS11", "KOSPI (Korea)", "🇰🇷"], ["^AXJO", "ASX 200 (Australia)", "🇦🇺"],
  ] },
  { name: "Macro", items: [
    ["ES=F", "S&P 500 futures", "📈"], ["GC=F", "Gold", "🥇"], ["CL=F", "Oil (WTI)", "🛢️"], ["^TNX", "US 10-yr yield", "🏦"],
    ["DX-Y.NYB", "US dollar index", "💵"], ["EURUSD=X", "EUR / USD", "💶"], ["JPY=X", "USD / JPY", "💴"], ["^VIX", "VIX (fear gauge)", "⚠️"],
  ] },
];

let hooks = { onOpen: () => {} };
let data = new Map();     // symbol -> { price, change, open, spark, currency }
let timer = null, updated = 0;

export function initWorld(h) {
  hooks = { ...hooks, ...h };
  document.getElementById("world").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sym]");
    if (!b) return;
    registerStock("S:" + b.dataset.sym, { name: b.dataset.name, kind: "Index" });
    hooks.onOpen("S:" + b.dataset.sym);
  });
}

export function worldVisible(visible) {
  clearTimeout(timer);
  if (visible) refresh();
}

/** Latest world snapshot (for the AI analyst and outside checks). */
export function worldSnapshot() {
  const out = {};
  for (const g of GROUPS) for (const [sym, name] of g.items) {
    const d = data.get(sym);
    if (d) out[name] = { changePct: +d.change.toFixed(2), open: d.open };
  }
  return out;
}

async function load(sym) {
  const r = (await (await fetch(`/api/market?src=chart&symbol=${encodeURIComponent(sym)}&interval=5m&range=1d`)).json())?.chart?.result?.[0];
  if (!r) return null;
  const m = r.meta;
  const closes = (r.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
  const price = m.regularMarketPrice ?? closes.at(-1);
  const prev = m.chartPreviousClose ?? m.previousClose;
  const p = m.currentTradingPeriod?.regular;
  const now = Date.now() / 1000;
  return { price, change: prev ? ((price - prev) / prev) * 100 : 0, open: p ? now >= p.start && now < p.end : null, spark: closes, currency: m.currency };
}

export async function refresh() {
  clearTimeout(timer);
  const all = GROUPS.flatMap((g) => g.items.map((x) => x[0]));
  const res = await Promise.allSettled(all.map(load));
  res.forEach((r, i) => { if (r.status === "fulfilled" && r.value) data.set(all[i], r.value); });
  updated = Date.now();
  render();
  timer = setTimeout(() => { if (!document.getElementById("world").hidden) refresh(); }, 60_000);
}

function spark(values, up) {
  if (!values || values.length < 2) return "";
  const w = 64, h = 20, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${up ? "var(--up)" : "var(--down)"}" stroke-width="1.4"/></svg>`;
}

function render() {
  const el = document.getElementById("world");
  if (!el) return;
  const openCount = [...data.values()].filter((d) => d.open).length;
  el.innerHTML = `
    <div class="world-head"><span class="muted small"><span class="live-dot"></span> ${updated ? `Updated ${new Date(updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} · ${openCount} markets open now` : "Loading…"}</span></div>
    ${GROUPS.map((g) => `
      <div class="world-group"><div class="world-gname">${g.name}</div>
        ${g.items.map(([sym, name, flag]) => {
          const d = data.get(sym);
          if (!d) return `<div class="world-row muted small">${flag} ${fmt.esc(name)} · loading…</div>`;
          const up = d.change >= 0;
          return `<button class="world-row" data-sym="${fmt.esc(sym)}" data-name="${fmt.esc(name)}" title="Open ${fmt.esc(name)} on the chart">
            <span class="w-flag">${flag}</span>
            <span class="w-name">${fmt.esc(name)}<small class="${d.open ? "w-open" : "w-closed"}">${d.open ? "● open" : "closed"}</small></span>
            ${spark(d.spark, up)}
            <span class="w-num"><span class="mono">${fmt.price(d.price)}</span><span class="mono small ${up ? "up" : "down"}">${up ? "+" : ""}${d.change.toFixed(2)}%</span></span>
          </button>`;
        }).join("")}
      </div>`).join("")}
    <p class="tiny muted">Change is vs. each market's previous close. Index levels are in local points; the yield is in %. Tap any row to open its chart, forecast and long-term view. Data: Yahoo Finance.</p>`;
}
