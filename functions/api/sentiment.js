// Headline mood: a transparent keyword score tuned for crypto/market headlines.
// Returns a score from -1 (clearly negative) to +1 (clearly positive).
// It's deliberately simple and explainable; it reads headlines, not the full articles.

const POSITIVE = [
  "surge", "surges", "surged", "surging", "soar", "soars", "soared", "rally", "rallies", "rallied",
  "jump", "jumps", "jumped", "gain", "gains", "gained", "climb", "climbs", "climbed", "rises", "rose", "rising",
  "rebound", "rebounds", "rebounded", "recover", "recovers", "recovery", "bullish", "breakout", "breaks out",
  "record high", "all-time high", "new high", "approve", "approves", "approved", "approval", "inflow", "inflows",
  "adoption", "adopts", "partnership", "partners with", "upgrade", "upgrades", "accumulate", "accumulating", "accumulation",
  "whales buy", "buying spree", "beats", "boost", "boosts", "optimism", "optimistic", "outperform", "outperforms",
  "milestone", "uptrend", "rate cut", "rate cuts", "expands", "launches", "integrates", "rally",
  "higher", "pumps", "skyrockets", "rockets",
];
const NEGATIVE = [
  "crash", "crashes", "crashed", "plunge", "plunges", "plunged", "plummet", "plummets", "tumble", "tumbles", "tumbled",
  "slump", "slumps", "sink", "sinks", "sank", "drop", "drops", "dropped", "fall", "falls", "falling", "fell", "decline",
  "declines", "declined", "dip", "dips", "slide", "slides", "slid", "slip", "slips", "slipped", "sell-off", "selloff",
  "sells off", "bearish", "outflow", "outflows", "withdrawals", "liquidation", "liquidations", "liquidated", "hack",
  "hacked", "hacker", "exploit", "exploited", "scam", "fraud", "lawsuit", "sues", "sued", "probe", "investigation",
  "charged", "ban", "bans", "banned", "crackdown", "warns", "warning", "fear", "fears", "loss", "losses", "bankrupt",
  "bankruptcy", "collapse", "collapses", "delist", "delisting", "rout", "panic", "dump", "dumps", "dumped", "lowest",
  "two-year low", "multi-year low", "downtrend", "capitulation", "bleeds", "bleeding", "wipes out", "wiped out",
  "rug pull", "halts", "suspends", "outage", "retreat", "retreats", "weakens", "struggles", "stalls", "sheds",
  "downturn", "give way", "gives way", "under pressure", "slashed", "tanks", "tanked", "bear market",
  "down", "lower", "drags", "losing", "lost",
];

// A positive word right after one of these counts as negative ("fails to rally"), and vice versa.
const NEGATOR_BEFORE = /(?:^|[^a-z])(?:not|no|never|fails? to|failed to|unable to|won't|can't|cannot)\s+(?:\w+\s+)?$/;
// Ignore concessive clauses: "falls despite rate cut" is about the fall.
const CONCESSION = /\b(despite|even as|even though|although)\b.*$/;

function compile(words) {
  return words.map((w) => new RegExp(`(^|[^a-z])(${w.replace(/-/g, "[- ]?")})(?=$|[^a-z])`, "gi"));
}
const POS_RE = compile([...new Set(POSITIVE)]);
const NEG_RE = compile([...new Set(NEGATIVE)]);

function count(text, regs) {
  const hits = [];
  for (const re of regs) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + m[1].length;
      hits.push({ start, end: start + m[2].length });
    }
  }
  return hits;
}

export function scoreHeadline(title) {
  const t = String(title || "").toLowerCase().replace(CONCESSION, "");
  let pos = 0, neg = 0;
  const seen = [];
  const overlaps = (h) => seen.some((s) => h.start < s.end && h.end > s.start);
  for (const [hits, sign] of [[count(t, POS_RE), 1], [count(t, NEG_RE), -1]]) {
    for (const h of hits) {
      if (overlaps(h)) continue;  // "sell-off" vs "sells off", phrase inside phrase
      seen.push(h);
      const negated = NEGATOR_BEFORE.test(t.slice(Math.max(0, h.start - 25), h.start));
      const s = negated ? -sign : sign;
      if (s > 0) pos++; else neg++;
    }
  }
  const score = Math.max(-1, Math.min(1, (pos - neg) / 2));
  return { score, label: score > 0 ? "positive" : score < 0 ? "negative" : "neutral" };
}
