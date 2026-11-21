// Economic calendar: this week's scheduled events that move markets worldwide (central-bank
// decisions and speeches, inflation, jobs, GDP, retail sales…), shown in the viewer's local time
// with a countdown. High-impact events coming up soon also feed the "Entryvex says" outside checks.
import * as fmt from "./format.js";
import { loadEarningsCalendar, upcomingList } from "./earnings.js";

const FLAGS = { USD: "🇺🇸", EUR: "🇪🇺", GBP: "🇬🇧", JPY: "🇯🇵", CNY: "🇨🇳", CAD: "🇨🇦", AUD: "🇦🇺", NZD: "🇳🇿", CHF: "🇨🇭", ALL: "🌐" };
const NAMES = { USD: "United States", EUR: "Euro area", GBP: "United Kingdom", JPY: "Japan", CNY: "China", CAD: "Canada", AUD: "Australia", NZD: "New Zealand", CHF: "Switzerland", ALL: "Global" };
let events = [];
let loadedAt = 0;
let showMedium = false;

export async function loadCalendar(force = false) {
  if (!force && events.length && Date.now() - loadedAt < 10 * 60_000) return events;
  const res = await fetch("/api/market?src=calendar");
  if (!res.ok) throw new Error("calendar " + res.status);
  const j = await res.json();
  events = (Array.isArray(j) ? j : []).map((e) => ({
    title: e.title, country: e.country, impact: e.impact, t: Date.parse(e.date),
    forecast: e.forecast || "", previous: e.previous || "",
  })).filter((e) => isFinite(e.t)).sort((a, b) => a.t - b.t);
  loadedAt = Date.now();
  return events;
}

/** High-impact events in the next `hours` (for outside checks and the AI). */
export function upcomingHighImpact(hours = 3) {
  const now = Date.now(), end = now + hours * 3600e3;
  return events.filter((e) => e.impact === "High" && e.t >= now - 15 * 60e3 && e.t <= end);
}

function countdown(t) {
  const m = Math.round((t - Date.now()) / 60e3);
  if (m < -1) return `${Math.abs(m) < 60 ? Math.abs(m) + " min" : Math.round(Math.abs(m) / 60) + " h"} ago`;
  if (m <= 1) return "now";
  if (m < 60) return `in ${m} min`;
  if (m < 48 * 60) return `in ${Math.floor(m / 60)} h ${m % 60} min`;
  return `in ${Math.round(m / 1440)} days`;
}

export async function renderCalendar() {
  const el = document.getElementById("calendar");
  if (!el) return;
  el.innerHTML = `<p class="muted small">Loading this week's events…</p>`;
  const [eco] = await Promise.allSettled([loadCalendar(), loadEarningsCalendar()]);
  if (eco.status === "rejected") { el.innerHTML = `<p class="muted small">The economic calendar is unavailable right now.</p>` + earningsHtml(); return; }
  draw();
}

/** Company earnings: your watchlist's stocks (next 3 weeks) and the biggest companies reporting this week. */
function earningsHtml() {
  let wl = [];
  try { wl = JSON.parse(localStorage.getItem("evx.watchlist") || "[]"); } catch {}
  const { mine, big } = upcomingList(wl, 7);
  if (!mine.length && !big.length) return "";
  const day = (d) => new Date(d + "T12:00:00Z").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const when = (t) => (t === "pre" ? "before open" : t === "post" ? "after close" : "");
  const eps = (v) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
  const row = (e, mineRow) => `<div class="cal-row earn-row ${mineRow ? "earn-mine" : ""}">
      <span class="mono cal-time">${fmt.esc(day(e.date))}</span><span class="cal-flag">🇺🇸</span>
      <span class="cal-title"><strong>${fmt.esc(e.s)}</strong> ${fmt.esc(e.n)}<small class="muted">${fmt.esc([when(e.t), e.e != null ? `analysts expect EPS ${eps(e.e)}` : "", e.ly != null ? `last year ${eps(e.ly)}` : ""].filter(Boolean).join(" · "))}</small></span>
      <span class="pill pill-thin">Earnings</span></div>`;
  return `<div class="cal-day"><div class="world-gname">📣 Earnings: your watchlist (next 3 weeks)</div>
      ${mine.length ? mine.map((e) => row(e, true)).join("") : `<p class="muted small">None of your watchlist's US stocks report in the next 3 weeks.</p>`}</div>
    ${big.length ? `<div class="cal-day"><div class="world-gname">📣 Biggest companies reporting in the next 7 days</div>${big.map((e) => row(e, false)).join("")}</div>` : ""}
    <p class="tiny muted">Stocks often jump several percent on earnings, overnight and past any stop-loss. Source: Nasdaq earnings calendar.</p>`;
}

function draw() {
  const el = document.getElementById("calendar");
  const now = Date.now();
  const wanted = (e) => e.impact === "High" || (showMedium && e.impact === "Medium");
  let list = events.filter((e) => wanted(e) && e.t >= now - 3 * 3600e3);
  let pastOnly = false;
  if (!list.length) { list = events.filter(wanted); pastOnly = list.length > 0; }   // week is over: show what already happened
  const days = new Map();
  for (const e of list) {
    const key = new Date(e.t).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(e);
  }
  el.innerHTML = `
    <div class="cal-head">
      <span class="muted small">Events that move markets, in your local time (24h).</span>
      <label class="switch small"><input type="checkbox" id="cal-medium" ${showMedium ? "checked" : ""}/> Include medium impact</label>
    </div>
    ${pastOnly ? `<p class="small note">This week's scheduled events are over. Next week's calendar appears here once it's published (usually over the weekend). Earlier this week:</p>` : ""}
    ${list.length ? [...days.entries()].map(([day, evs]) => `
      <div class="cal-day"><div class="world-gname">${fmt.esc(day)}</div>
        ${evs.map((e) => {
          const soon = e.t - now < 60 * 60e3 && e.t - now > -15 * 60e3;
          return `<div class="cal-row ${soon ? "cal-soon" : ""} ${e.t < now ? "cal-past" : ""}">
            <span class="mono cal-time">${new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</span>
            <span class="cal-flag" title="${fmt.esc(NAMES[e.country] || e.country)}">${FLAGS[e.country] || "🌐"}</span>
            <span class="cal-title">${fmt.esc(e.title)}<small class="muted">${fmt.esc(NAMES[e.country] || e.country)}${e.forecast ? ` · expected ${fmt.esc(e.forecast)}` : ""}${e.previous ? ` · last ${fmt.esc(e.previous)}` : ""}</small></span>
            <span class="pill ${e.impact === "High" ? "pill-negative" : "pill-thin"}">${e.impact}</span>
            <span class="small muted cal-cd">${countdown(e.t)}</span>
          </div>`;
        }).join("")}
      </div>`).join("") : `<p class="muted small">No ${showMedium ? "high or medium" : "high"}-impact events left this week.</p>`}
    <p class="tiny muted">High-impact releases often cause sharp, fast moves in stocks, crypto and currencies. Many day traders avoid opening new trades in the 30 minutes around them. Source: Forex Factory weekly calendar.</p>
    ${earningsHtml()}`;
  el.querySelector("#cal-medium")?.addEventListener("change", (ev) => { showMedium = ev.target.checked; draw(); });
}
