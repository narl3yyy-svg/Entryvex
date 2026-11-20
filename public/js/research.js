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
