// How a stock has moved on its past earnings days, measured from real filings and prices.
//
// Earnings releases come from SEC 8-K filings with item 2.02 and their exact acceptance time.
// The "reaction day" is the first full trading session after the news:
//   filed after 16:00 New York time → the next trading day
//   filed before 9:30               → that same day
//   filed during trading hours      → that same day (part of the move happened before the filing)
// Move = that day's close vs the previous close. Pure functions (no network), so they're testable.

const ET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** New York date ("YYYY-MM-DD") and minutes after midnight for a timestamp in ms. */
export function etParts(ms) {
  const p = Object.fromEntries(ET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, mins: +p.hour * 60 + +p.minute };
}

/**
 * @param bars      daily candles, oldest first: { time (unix seconds), close }
 * @param releases  [{ a: ISO acceptance time }] (any order)
 * @returns { n, moves: [{ date, move, when }], avgAbs, medianAbs, pUp, normalAbs, ratio, biggestUp, biggestDown } or null
 */
export function earningsMoves(bars, releases) {
  if (!bars?.length || !releases?.length) return null;
  const days = bars.map((b) => etParts(b.time * 1000).date);
  const moves = [];
  const used = new Set();
  for (const r of releases) {
    const t = Date.parse(r.a);
    if (!isFinite(t)) continue;
    const { date, mins } = etParts(t);
    const when = mins >= 16 * 60 ? "after close" : mins < 9 * 60 + 30 ? "before open" : "during trading";
    // First session on/after the release date (strictly after, when filed after the close).
    let d = days.findIndex((x) => (when === "after close" ? x > date : x >= date));
    if (d < 1 || used.has(d)) continue;
    // Skip if the price data has a gap of more than a week around the release (missing history).
    if ((bars[d].time - bars[d - 1].time) > 7 * 86400) continue;
    used.add(d);
    moves.push({ date: days[d], released: date, when, move: bars[d].close / bars[d - 1].close - 1 });
  }
  if (moves.length < 4) return moves.length ? { n: moves.length, moves: moves.sort((a, b) => (a.date < b.date ? 1 : -1)) } : null;
  moves.sort((a, b) => (a.date < b.date ? 1 : -1));   // newest first
  const abs = moves.map((m) => Math.abs(m.move)).sort((a, b) => a - b);
  // A normal day: median absolute daily move over the same period, excluding the earnings days.
  const first = days.indexOf(moves.at(-1).date);
  const normal = [];
  for (let i = Math.max(1, first); i < bars.length; i++) if (!used.has(i)) normal.push(Math.abs(bars[i].close / bars[i - 1].close - 1));
  normal.sort((a, b) => a - b);
  const med = (a) => (a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN);
  const normalAbs = med(normal);
  return {
    n: moves.length, moves,
    avgAbs: abs.reduce((s, v) => s + v, 0) / abs.length,
    medianAbs: med(abs),
    pUp: moves.filter((m) => m.move > 0).length / moves.length,
    normalAbs, ratio: normalAbs > 0 ? med(abs) / normalAbs : NaN,
    biggestUp: Math.max(...moves.map((m) => m.move)),
    biggestDown: Math.min(...moves.map((m) => m.move)),
  };
}
