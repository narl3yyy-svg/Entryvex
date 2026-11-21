// Coin report card: fundamentals from CoinGecko (fetched by the visitor's browser),
// turned into plain-English sentences, plus the news mood and an AI news summary.
import * as fmt from "./format.js";

const CG = "https://api.coingecko.com/api/v3";
const TTL = 10 * 60 * 1000;

function cacheGet(k) {
  try { const v = JSON.parse(sessionStorage.getItem("evx.cg." + k) || "null"); if (v && Date.now() - v.t < TTL) return v.v; } catch {}
  return null;
}
function cacheSet(k, v) { try { sessionStorage.setItem("evx.cg." + k, JSON.stringify({ t: Date.now(), v })); } catch {} }

async function cg(path) {
  const hit = cacheGet(path);
  if (hit) return hit;
  const res = await fetch(CG + path);
  if (res.status === 429) throw new Error("rate-limited");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const v = await res.json();
  cacheSet(path, v);
  return v;
}

/** Find the coin by ticker (the biggest coin using that ticker) and load its details. */
export async function getProfile(base) {
  const sym = base.toLowerCase();
  const list = await cg(`/coins/markets?vs_currency=usd&symbols=${encodeURIComponent(sym)}&price_change_percentage=7d,30d,1y`);
  if (!Array.isArray(list) || !list.length) return null;
  const m = list.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0))[0];
  let d = null;
  try {
    d = await cg(`/coins/${m.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`);
  } catch {}
  return { m, d };
}

/* ---------------- Plain-English report ---------------- */
const usdBig = (v) => v == null ? "—" : "$" + Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
const n = (v) => Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);

function trendWord(p) {
  if (p == null || !isFinite(p)) return null;
  const a = Math.abs(p);
  const dir = p >= 0 ? "up" : "down";
  if (a < 2) return "roughly flat";
  if (a < 10) return `${dir} a little`;
  if (a < 30) return `${dir} a lot`;
  return p >= 0 ? "up sharply" : "down sharply";
}

function monthsAgo(dateStr) {
  const d = new Date(dateStr);
  const months = (Date.now() - d) / (30.44 * 86400000);
  if (months < 1) return "this month";
  if (months < 24) return `${Math.round(months)} month${Math.round(months) === 1 ? "" : "s"} ago`;
  return `${(months / 12).toFixed(1)} years ago`;
}

function firstSentences(html, max = 2) {
  const text = String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const parts = text.match(/[^.!?]+[.!?]+/g) || (text ? [text] : []);
  return parts.slice(0, max).join(" ").trim();
}

export function plainEnglish({ m, d }) {
  const lines = [];
  const name = m.name;
  // Size
  lines.push({ k: "Size", t: `${name} is the <strong>#${m.market_cap_rank ?? "?"}</strong> cryptocurrency by total value, worth about <strong>${usdBig(m.market_cap)}</strong> in total.` });
  // All-time high
  if (m.ath && m.ath_change_percentage != null) {
    const off = m.ath_change_percentage;
    lines.push({ k: "Vs. its peak", t: off > -5
      ? `It's trading <strong>near its all-time high</strong> of $${fmt.price(m.ath)} (${monthsAgo(m.ath_date)}).`
      : `It's <strong class="down">${Math.abs(off).toFixed(0)}% below</strong> its all-time high of $${fmt.price(m.ath)}, set ${monthsAgo(m.ath_date)}.` });
  }
  // Performance
  const p7 = m.price_change_percentage_7d_in_currency, p30 = m.price_change_percentage_30d_in_currency, p1y = m.price_change_percentage_1y_in_currency;
  const perf = [["past week", p7], ["past month", p30], ["past year", p1y]]
    .filter(([, v]) => v != null && isFinite(v))
    .map(([label, v]) => `${label}: <strong class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</strong> (${trendWord(v)})`);
  if (perf.length) lines.push({ k: "Recent trend", t: perf.join(" · ") });
  // Supply
  if (m.max_supply) {
    const issued = m.circulating_supply / m.max_supply;
    lines.push({ k: "Supply", t: `${(issued * 100).toFixed(0)}% of its ${n(m.max_supply)} maximum coins already exist${issued > 0.9 ? ", so very little new supply is coming" : ", so more coins will still be released over time"}.` });
  } else if (m.circulating_supply) {
    lines.push({ k: "Supply", t: `About ${n(m.circulating_supply)} coins exist and there's <strong>no maximum</strong>, so new coins can keep being created, which can dilute holders.` });
  }
  // Trading activity
  if (m.total_volume && m.market_cap) {
    const turnover = m.total_volume / m.market_cap;
    lines.push({ k: "Trading activity", t: `${usdBig(m.total_volume)} traded in the last 24h (${(turnover * 100).toFixed(1)}% of its value): ${turnover > 0.15 ? "very active, possibly speculative" : turnover > 0.03 ? "healthy" : "fairly quiet"}.` });
  }
  // What it is
  const cats = (d?.categories || []).filter((c) => c && !/holdings|portfolio|ecosystem|fdv|binance|coinbase/i.test(c)).slice(0, 3);
  const about = firstSentences(d?.description?.en, 2);
  if (about || cats.length) lines.push({ k: "What it is", t: `${fmt.esc(about)}${cats.length ? ` <span class="muted">(${cats.map(fmt.esc).join(" · ")})</span>` : ""}` });
  if (d?.genesis_date) lines.push({ k: "Launched", t: `${new Date(d.genesis_date).getFullYear()} (${monthsAgo(d.genesis_date)})` });
  return lines;
}

/* ---------------- Stocks: company report card from SEC filings ---------------- */
let secTickers = null;
export async function secCik(ticker) {
  if (!secTickers) {
    const res = await fetch("/api/market?src=sec-tickers");
    if (!res.ok) throw new Error("SEC " + res.status);
    const j = await res.json();
    secTickers = new Map(Object.values(j).map((x) => [x.ticker.toUpperCase(), { cik: String(x.cik_str).padStart(10, "0"), title: x.title }]));
  }
  return secTickers.get(ticker.toUpperCase().replace(".", "-")) || null;
}

async function secConcept(cik, tax, concept) {
  const res = await fetch(`/api/market?src=sec-concept&cik=${cik}&tax=${tax}&concept=${concept}`);
  if (!res.ok) return null;
  return res.json();
}

/** Quarterly values (3-month periods) keyed by calendar frame like "CY2026Q2". */
function quarterly(fact, unit = "USD") {
  const rows = fact?.units?.[unit] || [];
  const map = new Map();
  for (const r of rows) if (r.frame && /^CY\d{4}Q[1-4]$/.test(r.frame)) map.set(r.frame, r);
  return [...map.values()].sort((a, b) => a.end.localeCompare(b.end));
}
const prevYearFrame = (f) => f.replace(/CY(\d{4})/, (_, y) => `CY${+y - 1}`);
const fmtDate = (s) => new Date(s + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
function growth(now, then) {
  if (!then || !isFinite(now) || !isFinite(then) || then === 0) return "";
  const g = ((now - then) / Math.abs(then)) * 100;
  return ` <span class="${g >= 0 ? "up" : "down"}">(${g >= 0 ? "+" : ""}${g.toFixed(0)}% vs. a year ago)</span>`;
}

export async function getStockProfile(ticker, q = {}) {
  const lines = [];
  const price = q?.last;
  // Price position
  if (q && price) {
    lines.push({ k: "Today", t: `$${fmt.price(price)}, <strong class="${q.changePct >= 0 ? "up" : "down"}">${q.changePct >= 0 ? "+" : ""}${(q.changePct || 0).toFixed(2)}%</strong> vs. yesterday's close${q.marketOpen === false ? " (market is closed now)" : ""}.` });
    if (q.hi52 && q.lo52) {
      const pos = (price - q.lo52) / (q.hi52 - q.lo52);
      lines.push({ k: "52-week range", t: `$${fmt.price(q.lo52)} – $${fmt.price(q.hi52)}. It's ${((1 - price / q.hi52) * 100).toFixed(0)}% below its 1-year high, ${pos > 0.8 ? "near the top" : pos < 0.2 ? "near the bottom" : "in the middle"} of its range.` });
    }
  }

  const sec = await secCik(ticker).catch(() => null);
  if (!sec) {
    lines.push({ k: "Earnings", t: /^[\^]|=/.test(ticker) ? "This is a market index or price (not a company), so there are no earnings to show."
      : /\./.test(ticker) ? "Quarterly filings for companies listed outside the US aren't available yet (Entryvex reads US SEC filings)."
      : "No company filings found. This is probably an ETF or fund, which holds a basket of stocks and doesn't report its own earnings." });
    return { lines, source: "Data: Yahoo Finance prices." };
  }

  const [rev1, rev2, ni, eps, sh] = await Promise.all([
    secConcept(sec.cik, "us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
    secConcept(sec.cik, "us-gaap", "Revenues"),
    secConcept(sec.cik, "us-gaap", "NetIncomeLoss"),
    secConcept(sec.cik, "us-gaap", "EarningsPerShareDiluted"),
    secConcept(sec.cik, "dei", "EntityCommonStockSharesOutstanding"),
  ]);
  const revQ = [quarterly(rev1), quarterly(rev2)].sort((a, b) => (b.at(-1)?.end || "").localeCompare(a.at(-1)?.end || ""))[0];
  const niQ = quarterly(ni);
  const epsQ = quarterly(eps, "USD/shares");
  const byFrame = (arr) => new Map(arr.map((r) => [r.frame, r]));
  const R = byFrame(revQ), N = byFrame(niQ), E = byFrame(epsQ);

  lines.unshift({ k: "Company", t: `${fmt.esc(sec.title)}` });

  const last = revQ.at(-1) || niQ.at(-1);
  if (last) {
    const f = last.frame;
    const r = R.get(f), n = N.get(f), e = E.get(f);
    const parts = [];
    if (r) parts.push(`sales of <strong>${usdBig(r.val)}</strong>${growth(r.val, R.get(prevYearFrame(f))?.val)}`);
    if (n) parts.push(`${n.val >= 0 ? "profit" : "a loss"} of <strong class="${n.val >= 0 ? "up" : "down"}">${usdBig(Math.abs(n.val))}</strong>${growth(n.val, N.get(prevYearFrame(f))?.val)}`);
    if (e) parts.push(`earnings per share $${e.val.toFixed(2)}`);
    lines.push({ k: `Latest quarter (ended ${fmtDate(last.end)})`, t: parts.join("; ") + "." });
    if (r && n && r.val) lines.push({ k: "Profit margin", t: `It kept <strong>${((n.val / r.val) * 100).toFixed(1)}¢</strong> of profit from every $1 of sales last quarter.` });
  }
  // Last 4 quarters
  const last4 = revQ.slice(-4), last4n = niQ.slice(-4), last4e = epsQ.slice(-4);
  if (last4.length === 4 && last4n.length === 4) {
    const rs = last4.reduce((s, x) => s + x.val, 0), ns = last4n.reduce((s, x) => s + x.val, 0);
    lines.push({ k: "Last 12 months", t: `Sales ${usdBig(rs)}, ${ns >= 0 ? "profit" : "loss"} ${usdBig(Math.abs(ns))}.` });
  }
  const shares = (sh?.units?.shares || []).at(-1)?.val;
  if (shares && price) {
    const cap = shares * price;
    let pe = "";
    if (last4e.length === 4) {
      const e4 = last4e.reduce((s, x) => s + x.val, 0);
      pe = e4 > 0 ? ` Price is <strong>${(price / e4).toFixed(1)}×</strong> its last 12 months of earnings (P/E); the US market average is usually around 20–25×.` : " It has lost money over the last 12 months, so there's no P/E.";
    }
    lines.push({ k: "Company value", t: `About <strong>${usdBig(cap)}</strong> in total (market cap).${pe}` });
  }
  if (lines.length < 4) lines.push({ k: "Earnings", t: "This company's filings don't include standard quarterly figures Entryvex can read." });
  return {
    lines,
    source: `Data: <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${sec.cik}&type=10-Q" target="_blank" rel="noopener noreferrer">SEC EDGAR filings</a> (quarterly 10-Q / annual 10-K) and Yahoo Finance prices.`,
  };
}

/* ---------------- Mood ---------------- */
export function moodOf(items, hours = 24) {
  const since = Date.now() - hours * 3600 * 1000;
  const recent = items.filter((i) => i.mood && (!i.published || i.published >= since));
  const c = { positive: 0, negative: 0, neutral: 0 };
  recent.forEach((i) => c[i.mood.label]++);
  const total = recent.length;
  const avg = total ? recent.reduce((s, i) => s + i.mood.score, 0) / total : 0;
  const label = !total ? "No recent headlines" : avg > 0.15 ? "Mostly positive" : avg < -0.15 ? "Mostly negative" : (c.positive && c.negative) ? "Mixed" : "Neutral";
  const level = !total ? "none" : avg > 0.15 ? "pos" : avg < -0.15 ? "neg" : "mid";
  return { ...c, total, avg, label, level };
}

export function moodHtml(md, hours = 24) {
  if (!md.total) return `<div class="mood"><span class="muted">No headlines in the last ${hours}h.</span></div>`;
  const w = (x) => ((x / md.total) * 100).toFixed(1) + "%";
  return `<div class="mood mood-${md.level}">
    <div class="mood-top"><strong>News mood: ${md.label}</strong>
      <span class="muted small">${md.negative} negative · ${md.neutral} neutral · ${md.positive} positive (last ${hours}h)</span></div>
    <div class="mood-bar"><i class="neg" style="width:${w(md.negative)}"></i><i class="neu" style="width:${w(md.neutral)}"></i><i class="pos" style="width:${w(md.positive)}"></i></div>
  </div>`;
}
