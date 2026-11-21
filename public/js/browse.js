// "Browse markets": ranked lists next to the watchlist.
//   Crypto  – top 200 coins by market value (CoinGecko)
//   Stocks  – top 1,000 companies by market value (Yahoo Finance screener)
//   ETFs    – top 700 most-traded ETFs (Yahoo Finance screener)
//   Indices – major world stock indices
// Tap a row to open it on the chart; ＋ adds it to your watchlist. Lists refresh every 30 minutes.
import { POPULAR } from "./market.js";
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
const TTL = 30 * 60e3;
const lists = { crypto: null, stocks: null, etfs: null, indices: null };
const loadedAt = {};
let tab = "crypto", filter = "";
let hooks = { cryptoPair: () => null, onOpen: () => {}, onAdd: () => {}, isWatched: () => false };

const INDICES = [
  ["^GSPC", "Americas"], ["^DJI", "Americas"], ["^IXIC", "Americas"], ["^NDX", "Americas"], ["^RUT", "Americas"], ["^VIX", "Americas"],
  ["^GSPTSE", "Americas"], ["^BVSP", "Americas"], ["^MXX", "Americas"],
  ["^FTSE", "Europe"], ["^GDAXI", "Europe"], ["^FCHI", "Europe"], ["^STOXX50E", "Europe"], ["^AEX", "Europe"], ["^IBEX", "Europe"], ["^SSMI", "Europe"],
  ["^N225", "Asia-Pacific"], ["^HSI", "Asia-Pacific"], ["000001.SS", "Asia-Pacific"], ["^BSESN", "Asia-Pacific"], ["^NSEI", "Asia-Pacific"],
  ["^KS11", "Asia-Pacific"], ["^AXJO", "Asia-Pacific"], ["^TWII", "Asia-Pacific"], ["^STI", "Asia-Pacific"],
];
const EXTRA_NAMES = { "^MXX": "Mexico IPC", "^AEX": "AEX (Amsterdam)", "^IBEX": "IBEX 35 (Spain)", "^SSMI": "Swiss Market Index", "^TWII": "Taiwan Weighted", "^STI": "Straits Times (Singapore)" };

export function initBrowse(h) {
  hooks = { ...hooks, ...h };
  $("wl-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    document.querySelectorAll("#wl-tabs button").forEach((x) => x.classList.toggle("on", x === b));
    const browse = b.dataset.v === "browse";
    $("wl-view").hidden = browse;
    $("browse-view").hidden = !browse;
    if (browse) load(tab);
  });
  $("browse-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-b]");
    if (!b) return;
    tab = b.dataset.b;
    document.querySelectorAll("#browse-seg button").forEach((x) => x.classList.toggle("on", x === b));
    load(tab);
  });
  let t = 0;
  $("browse-filter").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { filter = e.target.value.trim().toLowerCase(); render(); }, 120); });
  $("browse-list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-sym]");
    if (!li) return;
    const row = (lists[tab] || []).find((r) => r.sym === li.dataset.sym);
    if (!row) return;
    if (e.target.closest(".br-add")) {
      hooks.onAdd(row.sym, row.meta);
      li.querySelector(".br-add").textContent = "✓";
      li.querySelector(".br-add").classList.add("added");
    } else hooks.onOpen(row.sym, row.meta);
  });
}

async function load(which) {
  render();
  if (lists[which] && Date.now() - (loadedAt[which] || 0) < TTL) return;
  $("browse-meta").textContent = "Loading…";
  try {
    lists[which] = await LOADERS[which]();
    loadedAt[which] = Date.now();
  } catch {
    if (!lists[which]) { $("browse-meta").textContent = "Couldn't load this list right now. Try again in a minute."; return; }
  }
  if (which === tab) render();
}

const LOADERS = {
  async crypto() {
    const r = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=220&page=1&sparkline=false&price_change_percentage=24h");
    if (!r.ok) throw new Error("coingecko " + r.status);
    const j = await r.json();
    return j.map((c, i) => {
      const base = String(c.symbol || "").toUpperCase();
      const pair = hooks.cryptoPair(base);
      // On Binance.US: live pair. Otherwise: Yahoo Finance's USD price (chart and research, no exchange trading here).
      const sym = pair || `S:${base}-USD`;
      return { rank: c.market_cap_rank || i + 1, sym, ticker: base, name: c.name, price: c.current_price, chg: c.price_change_percentage_24h, cap: c.market_cap,
        note: pair ? "" : "not on Binance.US", meta: pair ? null : { name: c.name, exchange: "Crypto (USD)", kind: "Crypto" } };
    }).filter((x) => /^[A-Z0-9]{2,10}$/.test(x.ticker)).slice(0, 200);
  },
  async stocks() { return screener("largest_market_cap", 4); },
  async etfs() { return (await screener("most_actives_etfs", 3)).slice(0, 700); },
  async indices() {
    return INDICES.map(([s, region], i) => ({ rank: i + 1, sym: "S:" + s, ticker: s, name: POPULAR.indexNames[s] || EXTRA_NAMES[s] || s, price: null, chg: null, note: region,
      meta: { name: POPULAR.indexNames[s] || EXTRA_NAMES[s] || s, exchange: "Index", kind: "Index" } }));
  },
};

async function screener(id, pages) {
  const out = [];
  for (let k = 0; k < pages; k++) {
    const r = await fetch(`/api/market?src=screener&id=${id}&start=${k * 250}`);
    if (!r.ok) { if (out.length) break; throw new Error("screener " + r.status); }
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (k === 0 && tab === (id === "largest_market_cap" ? "stocks" : "etfs")) { lists[id === "largest_market_cap" ? "stocks" : "etfs"] = toRows(out); render(); }
  }
  return toRows(out);
}
function toRows(raw) {
  const seen = new Set();
  return raw.filter((x) => !seen.has(x.s) && seen.add(x.s)).map((x, i) => ({
    rank: i + 1, sym: "S:" + x.s, ticker: x.s, name: x.n, price: x.p, chg: x.c, cap: x.mc, cur: x.cur, note: "",
    meta: { name: x.n, exchange: x.ex, kind: x.t },
  }));
}

function render() {
  const ul = $("browse-list");
  if (!ul) return;
  const all = lists[tab];
  if (!all) { ul.innerHTML = ""; return; }
  const rows = filter ? all.filter((r) => r.ticker.toLowerCase().includes(filter) || String(r.name).toLowerCase().includes(filter)) : all;
  const label = { crypto: "coins by market value", stocks: "companies by market value", etfs: "most-traded ETFs", indices: "world stock indices" }[tab];
  $("browse-meta").textContent = `${filter ? `${rows.length} of ` : "Top "}${all.length} ${label}${loadedAt[tab] ? ` · ${new Date(loadedAt[tab]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}` : ""}. Tap to open, ＋ to add to your watchlist.`;
  ul.innerHTML = rows.map((r) => {
    const watched = hooks.isWatched(r.sym);
    const pre = r.cur && r.cur !== "USD" ? r.cur + " " : r.price != null ? "$" : "";
    return `<li data-sym="${fmt.esc(r.sym)}">
      <span class="br-rank mono">${r.rank}</span>
      <span class="wl-base">${fmt.esc(r.ticker)}${r.note ? `<span class="muted tiny"> · ${fmt.esc(r.note)}</span>` : ""}</span>
      <span class="wl-price">${r.price != null ? pre + fmt.price(r.price) : ""}</span>
      <span class="wl-name">${fmt.esc(r.name)}${r.cap ? `<span class="muted"> · ${r.cur && r.cur !== "USD" ? r.cur + " " : "$"}${fmt.compact(r.cap)}</span>` : ""}</span>
      <span class="wl-chg ${r.chg >= 0 ? "up" : "down"}">${r.chg != null ? fmt.pct(r.chg) : ""}</span>
      <button class="br-add ${watched ? "added" : ""}" title="${watched ? "In your watchlist" : "Add to watchlist"}" aria-label="Add ${fmt.esc(r.ticker)} to watchlist">${watched ? "✓" : "＋"}</button>
    </li>`;
  }).join("") || `<li class="muted small br-empty">Nothing matches “${fmt.esc(filter)}”.</li>`;
}
