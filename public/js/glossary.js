// Plain-English explanations for trading words. After a panel is drawn, the first time each known
// word appears in it gets a dotted underline; hover (desktop) or tap (phone) shows what it means.
// Works on text only (never inside buttons, links, inputs or numbers), so it can't break the layout.

const TERMS = [
  ["stop-loss", "A sell order that triggers if the price falls to a level you choose, so a losing trade stays small. Set it right after you buy."],
  ["take-profit", "A sell order at a higher price you choose, so you lock in the gain when the price gets there."],
  ["OCO", "\"One cancels the other\": a take-profit and a stop-loss placed together. When one fills, the exchange cancels the other."],
  ["limit order", "An order to buy or sell only at your price or better. Usually cheaper than a market order, but it may not fill."],
  ["market order", "An order that fills right away at whatever price is available. Fast, but you pay the spread and sometimes more."],
  ["limit buy", "A buy order that only fills at your price or lower."],
  ["80% range", "Where the price ended up 8 times out of 10 in the past, scaled to how jumpy the market is now. The scorecard checks how often it really works."],
  ["50% range", "Where the price ended up half the time in the past: the most likely zone."],
  ["setup", "A specific situation on the chart (like a pullback in an uptrend) that Entryvex tests against this market's history, after fees."],
  ["uptrend", "Price is above its longer-term average and that average is rising: buyers have been in control."],
  ["downtrend", "Price is below its longer-term average and that average is falling: sellers have been in control. Buying here is riskier."],
  ["fees", "What the exchange or broker charges per trade. Entryvex subtracts fees and the spread from every result it shows."],
  ["spread", "The gap between the best buy and sell price. Crossing it is a hidden cost of every trade."],
  ["earnings", "A company's quarterly results report. The stock can jump or drop a lot the next day, even past a stop-loss."],
  ["VIX", "The stock market's \"fear gauge\": how big a swing investors expect in the S&P 500. Under 20 is calm; over 30 is fearful."],
  ["Fear & Greed", "A 0–100 score of the crypto crowd's mood. Very low = fear (big swings), very high = greed (rallies often stall)."],
  ["paper-trading", "Trading with pretend money at real prices, to test a strategy without risk."],
  ["practice account", "A pretend $1,000 account. Practice trades use real prices and the same plan, but no real money."],
  ["drawdown", "The biggest drop from a high point in an account's value before it recovered."],
  ["candle", "One bar on the chart: the open, high, low and close price for one period (like 1 hour)."],
  ["time limit", "If neither the take-profit nor the stop-loss is hit by then, the plan is to sell at the market price. The track record was measured this way."],
  ["coin flip", "Right about half the time: no real ability to predict the direction."],
  ["track record", "How this exact signal did every time it happened before on this market, after fees."],
  ["after fees", "With trading costs (fee + spread) already subtracted, so the numbers are what you'd actually keep."],
];
const byWord = new Map(TERMS.map(([w, d]) => [w.toLowerCase(), d]));
const RE = new RegExp(`\\b(${TERMS.map(([w]) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s")).sort((a, b) => b.length - a.length).join("|")})s?\\b`, "i");
const SKIP = new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "OPTION", "ABBR", "SCRIPT", "STYLE", "SUMMARY", "CODE"]);

/** Underline the first appearance of each known word inside `el`. */
export function applyGlossary(el) {
  if (!el) return;
  const seen = new Set([...el.querySelectorAll("abbr.term")].map((a) => a.dataset.term));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      for (let p = n.parentElement; p && p !== el; p = p.parentElement) if (SKIP.has(p.tagName) || p.classList?.contains("mono")) return NodeFilter.FILTER_REJECT;
      return RE.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const RG = new RegExp(RE.source, "gi");
  for (let node of nodes) {
    // Every known word in this bit of text, first appearance only (a word already explained is skipped).
    const hits = [...node.nodeValue.matchAll(RG)].filter((m) => {
      const key = m[1].toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key) || !byWord.has(key)) return false;
      seen.add(key); m.key = key; return true;
    });
    for (let i = hits.length - 1; i >= 0; i--) {   // from the end, so earlier positions stay valid
      const m = hits[i];
      const word = node.splitText(m.index);
      word.splitText(m[0].length);
      const abbr = document.createElement("abbr");
      abbr.className = "term";
      abbr.dataset.term = m.key;
      abbr.title = byWord.get(m.key);
      abbr.tabIndex = 0;
      abbr.textContent = word.nodeValue;
      word.replaceWith(abbr);
    }
  }
}

/** Keep panels explained as they redraw (prices update them often, so this is cheap and idempotent). */
export function watchGlossary(ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    let queued = false;
    const run = () => { queued = false; applyGlossary(el); };
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } }).observe(el, { childList: true, subtree: true });
    applyGlossary(el);
  }
}

// Tap (or Enter) on a word: show its meaning in a small bubble. Desktop hover uses the title.
let bubble = null;
function show(t) {
  hide();
  bubble = document.createElement("div");
  bubble.className = "term-bubble";
  bubble.setAttribute("role", "tooltip");
  bubble.textContent = t.title;
  document.body.appendChild(bubble);
  const r = t.getBoundingClientRect(), w = Math.min(300, innerWidth - 24);
  bubble.style.width = w + "px";
  bubble.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + "px";
  const below = r.bottom + 8, h = bubble.offsetHeight;
  bubble.style.top = (below + h < innerHeight ? below : Math.max(8, r.top - h - 8)) + scrollY + "px";
}
function hide() { bubble?.remove(); bubble = null; }
document.addEventListener("click", (e) => {
  const t = e.target.closest?.("abbr.term");
  if (t) { e.preventDefault(); show(t); } else hide();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hide();
  if (e.key === "Enter" && e.target.matches?.("abbr.term")) show(e.target);
});
addEventListener("scroll", hide, { passive: true });
