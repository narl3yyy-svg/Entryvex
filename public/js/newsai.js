// AI news reader in the app: the AI's latest read of the headlines for the market on screen, and
// its MEASURED record (did its scores predict the next 24 hours?). The read only counts toward
// "Entryvex says" once its record proves it helps; until then it's shown as labelled context.
import { evaluateNews, pool, expectedMove } from "./newsai-model.js";
import { getKlineHistory, isStock } from "./market.js";
import * as fmt from "./format.js";

const TRACKED = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "S:SPY", "S:QQQ", "S:AAPL", "S:NVDA", "S:TSLA", "S:MSFT", "S:AMZN"];
const reads = new Map(), records = new Map();
let pooled = null;

// Indexes and futures (^DJI, GC=F) have no company headlines; the server doesn't read news for them.
const NO_NEWS = (sym) => /[\^=]/.test(sym);

export async function getNewsRead(sym, name) {
  if (NO_NEWS(sym)) return { available: false, reason: "Indexes and futures have no company headlines of their own, so the AI doesn't read news for them. See the News tab for market-wide headlines." };
  const hit = reads.get(sym);
  if (hit && Date.now() - hit.t < 10 * 60e3) return hit.v;
  let v = null;
  try {
    const r = await fetch(`/api/newsai?sym=${encodeURIComponent(sym)}&name=${encodeURIComponent(name || "")}`);
    v = r.ok ? await r.json() : null;
  } catch {}
  reads.set(sym, { t: Date.now(), v });
  return v;
}

export async function getNewsRecord(sym) {
  if (NO_NEWS(sym)) return null;
  const hit = records.get(sym);
  if (hit && Date.now() - hit.t < 30 * 60e3) return hit.v;
  let v = null;
  try {
    const [tr, bars] = await Promise.all([fetch(`/api/newsai?sym=${encodeURIComponent(sym)}&track=1`).then((r) => (r.ok ? r.json() : null)), getKlineHistory(sym, "1h", 3000)]);
    v = evaluateNews(tr?.log || [], bars);
  } catch {}
  records.set(sym, { t: Date.now(), v });
  return v;
}

/** The record pooled over all markets the AI reads every hour (more cases, quicker verdict). */
export async function getPooledRecord() {
  if (pooled && Date.now() - pooled.t < 30 * 60e3) return pooled.v;
  const evals = [];
  for (const s of TRACKED) evals.push(await getNewsRecord(s).catch(() => null));   // one at a time: gentle on phones
  const v = pool(evals);
  pooled = { t: Date.now(), v };
  return v;
}

const scoreWord = (s) => (s >= 0.35 ? "clearly positive" : s >= 0.1 ? "slightly positive" : s <= -0.35 ? "clearly negative" : s <= -0.1 ? "slightly negative" : "neutral");

/** Outside check for "Entryvex says". Counts only if the AI's record proves it helps. */
export async function newsAiCheck(sym, name) {
  const [read, rec] = await Promise.all([getNewsRead(sym, name), getNewsRecord(sym)]);
  if (!read?.available || read.score == null) return null;
  const proven = rec?.verdict?.helps;
  const dir = read.score >= 0.15 ? 1 : read.score <= -0.15 ? -1 : 0;
  return {
    label: "News read by AI",
    effect: proven ? dir : 0,
    text: `${scoreWord(read.score)} (${read.score >= 0 ? "+" : ""}${read.score.toFixed(2)}) from ${read.relevant} relevant of ${read.count} headlines${read.why ? `: ${read.why.replace(/[.\s]+$/, "")}` : ""}. `
      + (proven ? `Its record here: right ${Math.round(rec.hit * 100)}% of ${rec.cases} days, so it counts.${learned(rec, read.score)}` : `Not counted yet: ${rec?.verdict?.label?.toLowerCase() || "no record yet"}.`),
  };
}

/** Section in the Report tab. */
export async function renderNewsAi(el, sym, name, isCurrent) {
  el.innerHTML = `<h3>News read by AI <span class="ai-badge">AI</span></h3><div class="muted small">The AI is rating the latest headlines…</div>`;
  const [read, rec] = await Promise.all([getNewsRead(sym, name), getNewsRecord(sym)]);
  if (!isCurrent()) return;
  if (!read?.available) { el.innerHTML = `<h3>News read by AI</h3><div class="muted small">${fmt.esc(read?.reason || "The AI news reader is unavailable right now.")}</div>`; return; }
  if (read.score == null) { el.innerHTML = `<h3>News read by AI</h3><div class="muted small">${fmt.esc(read.reason || "Not enough recent headlines.")}</div>`; return; }
  const pct = Math.round(((read.score + 1) / 2) * 100);
  el.innerHTML = `<h3>News read by AI <span class="ai-badge">AI</span></h3>
    <div class="nai-score"><span class="nai-label ${read.score >= 0.1 ? "up" : read.score <= -0.1 ? "down" : ""}">${fmt.esc(scoreWord(read.score))}</span>
      <div class="nai-bar" title="AI news score ${read.score.toFixed(2)} (−1 very negative … +1 very positive)"><i style="left:${pct}%"></i></div>
      <span class="mono small">${read.score >= 0 ? "+" : ""}${read.score.toFixed(2)}</span></div>
    ${read.why ? `<p class="small">${fmt.esc(read.why)}</p>` : ""}
    ${read.top?.length ? `<ul class="nai-top">${read.top.map((h) => `<li><span class="${h.impact > 0 ? "up" : "down"}" title="${h.impact > 0 ? "Good" : "Bad"} for the price (strength ${Math.abs(h.impact)} of 2)">${(h.impact > 0 ? "▲" : "▼").repeat(Math.abs(h.impact))}</span> ${h.link ? `<a href="${fmt.esc(h.link)}" target="_blank" rel="noopener noreferrer">${fmt.esc(h.title)}</a>` : fmt.esc(h.title)} <span class="muted tiny">${fmt.esc(h.source || "")}</span></li>`).join("")}</ul>` : ""}
    <div class="nai-record">${recordHtml(rec)}${rec?.verdict?.helps ? `<span class="small">${learned(rec, read.score)}</span>` : ""}</div>
    <button class="link-btn small" data-nai-pool>Check the AI's record across all ${TRACKED.length} markets it reads every 2 hours</button>
    <div class="nai-pool small"></div>
    <p class="muted tiny">Read by AI from ${read.count} headlines (${read.relevant} relevant) at ${new Date(read.generated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}. Every read is recorded with the price, and Entryvex measures whether the score predicted the next 24 hours. It only counts toward "Entryvex says" once that record proves it helps.</p>`;
  el.querySelector("[data-nai-pool]").addEventListener("click", async (e) => {
    const box = el.querySelector(".nai-pool");
    e.target.disabled = true;
    box.textContent = "Measuring across all tracked markets…";
    const p = await getPooledRecord();
    box.innerHTML = p.cases ? `Across ${p.markets} markets: ${p.cases} independent days measured, right ${Math.round(p.hit * 100)}% of the time (t = ${p.t.toFixed(2)}). <strong>${fmt.esc(p.verdict.label)}.</strong>`
      : `Not enough history yet. The AI reads each market about every 2 hours; a day later, each read can be checked.`;
  });
}

function recordHtml(rec) {
  if (!rec) return `<span class="muted small">Track record unavailable.</span>`;
  if (!rec.cases) return `<span class="small"><strong>Track record:</strong> ${rec.reads} read${rec.reads === 1 ? "" : "s"} recorded so far${rec.pending ? ` (${rec.pending} still within their 24 hours)` : ""}. None can be judged yet.</span>`;
  const pa = rec.afterPositive, na = rec.afterNegative;
  return `<span class="small"><strong>Track record here:</strong> <span class="pill pill-${rec.verdict.level === "helps" ? "edge" : rec.verdict.level === "misleading" ? "negative" : "thin"}">${fmt.esc(rec.verdict.label)}</span>
    ${rec.cases} independent days judged, the AI's direction was right ${Math.round(rec.hit * 100)}% of the time${isFinite(rec.t) ? ` (t = ${rec.t.toFixed(2)})` : ""}.
    ${pa?.n ? `After positive reads, price moved ${fmtPct(pa.avg)} on average over 24 h` : ""}${pa?.n && na?.n ? "; " : ""}${na?.n ? `after negative reads, ${fmtPct(na.avg)}` : ""}${pa?.n || na?.n ? "." : ""}</span>`;
}
const fmtPct = (x) => (isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%` : "—");
/** What the record has taught it about a score of this size (only when the fit is significant). */
function learned(rec, score) {
  const m = expectedMove(rec?.calibration, score);
  return m == null ? "" : ` Learned from ${rec.calibration.n} days: reads like this have meant about ${fmtPct(m)} over the next 24 hours, beyond the usual drift.`;
}

/** For the AI analyst. */
export function newsAiSnapshot(sym) {
  const read = reads.get(sym)?.v, rec = records.get(sym)?.v;
  if (!read?.available || read.score == null) return null;
  return { score: read.score, meaning: scoreWord(read.score), why: read.why, headlinesRead: read.count, relevant: read.relevant,
    mostImportant: (read.top || []).map((h) => `${h.impact > 0 ? "+" : ""}${h.impact} ${h.title}`),
    record: rec ? { verdict: rec.verdict.label, independentDaysJudged: rec.cases, directionRightPct: isFinite(rec.hit) ? Math.round(rec.hit * 100) : null, tStat: isFinite(rec.t) ? +rec.t.toFixed(2) : null } : null,
    countsTowardVerdict: !!rec?.verdict?.helps };
}
