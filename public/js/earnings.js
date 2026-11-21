// Company earnings: when each US stock reports next (Nasdaq earnings calendar, with the analysts'
// consensus EPS estimate) and how much it has moved on its past earnings days (SEC 8-K item 2.02
// filings + daily prices, see earnings-model.js). Earnings are the biggest scheduled risk for a stock:
// prices often jump several percent overnight, straight past any stop-loss.
import { earningsMoves, etParts } from "./earnings-model.js";
import { getKlineHistory, isStock } from "./market.js";
import { secCik } from "./research.js";
import * as fmt from "./format.js";

const CAL_KEY = "evx.earnCal";
const CAL_MS = 3 * 3600e3;
let cal = null;            // { t, days: { "YYYY-MM-DD": [rows] } }
let calLoading = null;
const hist = new Map();    // sym → { t, v }
const listeners = new Set();
export function onEarnings(fn) { listeners.add(fn); }

function dates() {
  // Weekdays from 7 days ago to 21 days ahead (New York dates).
  const out = [];
  const today = etParts(Date.now()).date;
  const base = Date.parse(today + "T12:00:00Z");
  for (let k = -7; k <= 21; k++) {
    const d = new Date(base + k * 86400e3);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Load the earnings calendar (cached 3 h). */
export function loadEarningsCalendar() {
  if (cal && Date.now() - cal.t < CAL_MS) return Promise.resolve(cal);
  if (!cal) {
    try { const c = JSON.parse(localStorage.getItem(CAL_KEY) || "null"); if (c && Date.now() - c.t < CAL_MS) { cal = c; return Promise.resolve(cal); } } catch {}
  }
  if (calLoading) return calLoading;
  calLoading = (async () => {
    const want = dates(), days = {};
    const q = want.slice();
    let ok = 0;
    const worker = async () => {
      while (q.length) {
        const d = q.shift();
        try {
          const r = await fetch(`/api/market?src=earnings&date=${d}`);
          if (r.ok) { const rows = await r.json(); if (Array.isArray(rows)) { days[d] = rows; ok++; } }
        } catch {}
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (!ok) throw new Error("earnings calendar unavailable");
    cal = { t: Date.now(), days };
    try { localStorage.setItem(CAL_KEY, JSON.stringify(cal)); } catch {}
    listeners.forEach((f) => f());
    return cal;
  })().finally(() => (calLoading = null));
  return calLoading;
}

const tick = (sym) => sym.replace(/^S:/, "").replace("-", ".").toUpperCase();
const same = (a, b) => a.replace(/[.\-]/g, "") === b.replace(/[.\-]/g, "");

/** Next (or very recent) earnings date for a US stock, from the loaded calendar. */
export function earningsFor(sym) {
  if (!cal || !isStock(sym)) return null;
  const t = tick(sym);
  const today = etParts(Date.now()).date;
  let next = null, last = null;
  for (const [d, rows] of Object.entries(cal.days)) {
    const row = rows.find((r) => same(r.s, t));
    if (!row) continue;
    const e = { date: d, time: row.t, eps: row.e, estimates: row.ne, lastYearEps: row.ly, name: row.n };
    if (d >= today) { if (!next || d < next.date) next = e; }
    else if (!last || d > last.date) last = e;
  }
  const covered = Object.keys(cal.days).sort();
  return { next, last, coveredUntil: covered.at(-1) };
}

/** Trading days (weekdays) from today to a New York date. */
export function tradingDaysUntil(date) {
  const today = etParts(Date.now()).date;
  let n = 0;
  for (let t = Date.parse(today + "T12:00:00Z"); t < Date.parse(date + "T12:00:00Z"); t += 86400e3) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/** Plain description of a scheduled report: "Thu Nov 26, after the close (in 3 trading days)". */
export function describeNext(e) {
  if (!e) return "";
  const d = new Date(e.date + "T12:00:00Z").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const when = e.time === "pre" ? ", before the open" : e.time === "post" ? ", after the close" : "";
  const n = tradingDaysUntil(e.date);
  return `${d}${when} (${n === 0 ? "today" : n === 1 ? "next trading day" : `in ${n} trading days`})`;
}

/** Measured moves on past earnings days (cached 12 h per stock). */
export async function earningsHistory(sym) {
  if (!isStock(sym) || /[.^=]/.test(tick(sym).replace(/\.[AB]$/, ""))) return null;   // US-listed companies only
  const hit = hist.get(sym);
  if (hit && Date.now() - hit.t < 12 * 3600e3) return hit.v;
  let v = null;
  try {
    const sec = await secCik(tick(sym).replace(".", "-"));
    if (sec) {
      const [res, bars] = await Promise.all([fetch(`/api/market?src=sec-earnings&cik=${sec.cik}`), getKlineHistory(sym, "1d", 3000)]);
      let rel = res.ok ? await res.json() : [];
      if (!Array.isArray(rel)) rel = [];
      // Companies with many SEC filings keep only about a year in the main index: read one older page too.
      if (rel.length < 12) {
        try {
          const older = await fetch(`/api/market?src=sec-earnings&cik=${sec.cik}&page=1`);
          if (older.ok) { const o = await older.json(); if (Array.isArray(o)) rel = rel.concat(o); }
        } catch {}
      }
      v = rel.length ? earningsMoves(bars, rel) : null;
    }
  } catch { v = null; }
  hist.set(sym, { t: Date.now(), v });
  return v;
}
export function cachedEarningsHistory(sym) { return hist.get(sym)?.v ?? null; }

/** Upcoming reports for a list of symbols plus the largest companies reporting in the next `days`. */
export function upcomingList(symbols, days = 7) {
  if (!cal) return { mine: [], big: [] };
  const today = etParts(Date.now()).date;
  const end = new Date(Date.parse(today + "T12:00:00Z") + days * 86400e3).toISOString().slice(0, 10);
  const mineT = new Map(symbols.filter(isStock).map((s) => [tick(s), s]));
  const mine = [], big = [];
  for (const [d, rows] of Object.entries(cal.days)) {
    if (d < today) continue;
    for (const r of rows) {
      const hitSym = [...mineT.keys()].find((t) => same(t, r.s));
      if (hitSym) mine.push({ sym: mineT.get(hitSym), date: d, ...r });
      if (d <= end && r.mc > 0) big.push({ date: d, ...r });
    }
  }
  mine.sort((a, b) => (a.date < b.date ? -1 : 1));
  big.sort((a, b) => b.mc - a.mc);
  return { mine, big: big.slice(0, 15).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.mc - a.mc)) };
}

/** Compact summary for the AI analyst. */
export function earningsSnapshot(sym) {
  if (!isStock(sym)) return null;
  const e = earningsFor(sym), h = cachedEarningsHistory(sym);
  if (!e && !h) return null;
  return {
    nextReport: e?.next ? { date: e.next.date, timing: e.next.time === "pre" ? "before open" : e.next.time === "post" ? "after close" : "not specified", tradingDaysAway: tradingDaysUntil(e.next.date), consensusEps: e.next.eps, analysts: e.next.estimates, epsSameQuarterLastYear: e.next.lastYearEps } : `none scheduled before ${e?.coveredUntil || "?"}`,
    pastEarningsDays: h?.medianAbs != null ? { reports: h.n, typicalMovePct: +(h.medianAbs * 100).toFixed(1), averageMovePct: +(h.avgAbs * 100).toFixed(1), normalDayMovePct: +(h.normalAbs * 100).toFixed(2), timesNormal: +h.ratio.toFixed(1), closedHigherPct: Math.round(h.pUp * 100), biggestUpPct: +(h.biggestUp * 100).toFixed(1), biggestDownPct: +(h.biggestDown * 100).toFixed(1) } : null,
  };
}

/* ---------------- Card under "Entryvex says" (US stocks) ---------------- */
let cardToken = 0;
const pc = (x, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`;
const usOnly = (sym) => isStock(sym) && !/[.^=]/.test(tick(sym).replace(/\.[AB]$/, ""));

export async function renderEarnings(c) {
  const el = document.getElementById("earnings-box");
  if (!el) return;
  const sym = c?.symbol;
  if (!sym || !usOnly(sym)) { el.innerHTML = ""; return; }
  const my = ++cardToken;
  el.innerHTML = cardHtml(c.base, sym, true);
  await Promise.allSettled([loadEarningsCalendar(), earningsHistory(sym)]);
  if (my !== cardToken) return;
  el.innerHTML = cardHtml(c.base, sym, false);
}

function cardHtml(base, sym, loading) {
  const e = earningsFor(sym), h = cachedEarningsHistory(sym);
  const b = fmt.esc(base);
  if (loading && !e && !h) return `<div class="earn-card"><div class="d-when-title">📣 Earnings</div><p class="small muted">Loading the earnings calendar and ${b}'s past earnings days…</p></div>`;
  const next = e?.next;
  const away = next ? tradingDaysUntil(next.date) : null;
  const soon = next && away <= 3;
  let top;
  if (next) {
    top = `<p class="small"><strong>Next report: ${fmt.esc(describeNext(next))}.</strong>`
      + (next.eps != null ? ` Analysts expect earnings of <strong>${next.eps < 0 ? "−" : ""}$${Math.abs(next.eps).toFixed(2)}</strong> a share${next.estimates ? ` (${next.estimates} analyst${next.estimates === 1 ? "" : "s"})` : ""}${next.lastYearEps != null ? `, vs ${next.lastYearEps < 0 ? "−" : ""}$${Math.abs(next.lastYearEps).toFixed(2)} in the same quarter last year` : ""}.` : "")
      + `</p>`;
  } else if (e && (e.last || h?.moves?.length)) {
    // Prefer the SEC filing date (exact) over the calendar's date for the last report.
    const lastDate = h?.moves?.[0]?.released || e.last.date;
    top = `<p class="small">Last reported ${fmt.esc(new Date(lastDate + "T12:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" }))}. No report scheduled in the next 3 weeks.</p>`;
  } else if (e) {
    top = `<p class="small muted">No earnings report scheduled in the next 3 weeks.</p>`;
  } else top = `<p class="small muted">The earnings calendar is unavailable right now.</p>`;

  let past = "";
  if (h?.medianAbs != null) {
    past = `<p class="small">On its last <strong>${h.n}</strong> earnings days, ${b} typically moved <strong>±${(h.medianAbs * 100).toFixed(1)}%</strong>
      ${isFinite(h.ratio) && h.ratio >= 1.2 ? `(<strong>${h.ratio.toFixed(1)}×</strong> a normal day's ±${(h.normalAbs * 100).toFixed(1)}%)` : `(about the same as a normal day)`}
      and closed higher ${Math.round(h.pUp * 100)}% of the time. Biggest: <span class="up">${pc(h.biggestUp)}</span> / <span class="down">${pc(h.biggestDown)}</span>.</p>
      <div class="earn-chips">${h.moves.slice(0, 8).map((m) => `<span class="earn-chip ${m.move >= 0 ? "up" : "down"}" title="Reported ${fmt.esc(m.released)} ${fmt.esc(m.when)}; move measured on ${fmt.esc(m.date)}">${fmt.esc(new Date(m.date + "T12:00:00Z").toLocaleDateString([], { month: "short", year: "numeric", timeZone: "UTC" }))} ${pc(m.move)}</span>`).join("")}</div>`;
  } else if (loading) past = `<p class="small muted">Measuring past earnings days…</p>`;

  const warn = soon ? `<div class="warn">Earnings ${away === 0 ? "today" : `in ${away} trading day${away === 1 ? "" : "s"}`}. If you hold through the report, the price can open far from today's${h?.medianAbs != null ? ` (typically ±${(h.medianAbs * 100).toFixed(1)}%)` : ""}, and a stop-loss can't protect you from that gap. Short-term traders often close or shrink positions before the report.</div>` : "";
  return `<div class="earn-card ${soon ? "earn-soon" : ""}"><div class="d-when-title">📣 Earnings</div>${top}${warn}${past}
    <p class="tiny muted">Dates and estimates: Nasdaq earnings calendar. Past moves: measured from ${b}'s SEC earnings filings (8-K) and daily closing prices.</p></div>`;
}

/** Outside check for "Entryvex says": earnings within 3 trading days is a headwind for new trades. */
export async function earningsCheck(sym) {
  if (!usOnly(sym)) return null;
  await Promise.allSettled([loadEarningsCalendar(), earningsHistory(sym)]);
  const e = earningsFor(sym), h = cachedEarningsHistory(sym);
  if (!e) return null;
  const move = h?.medianAbs != null ? ` On past reports it typically moved ±${(h.medianAbs * 100).toFixed(1)}%.` : "";
  if (!e.next) return { label: "Earnings", effect: 0, text: `No earnings report in the next 3 weeks.` };
  const away = tradingDaysUntil(e.next.date);
  return away <= 3
    ? { label: "Earnings", effect: -1, text: `Reports ${describeNext(e.next)}. Prices can gap past a stop-loss on the news.${move}` }
    : { label: "Earnings", effect: 0, text: `Next report ${describeNext(e.next)}.${move}` };
}
