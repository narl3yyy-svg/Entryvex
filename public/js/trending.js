// What the crypto crowd is looking at right now: CoinGecko's "trending" list, the coins people
// search for most on CoinGecko over the last 24 hours, plus the trending categories.
// It's a measure of attention, not of quality: trending coins are often small, risky and already
// up a lot. Entryvex shows it as context and records it (server, hourly) so its effect can be measured.

let cache = null, loading = null;
const TTL = 10 * 60e3;

/** { at, coins: [{ pos, symbol, name, cap, price, chg24 }], categories: [name] } */
export function getTrending() {
  if (cache && Date.now() - cache.at < TTL) return Promise.resolve(cache);
  if (loading) return loading;
  loading = fetch("https://api.coingecko.com/api/v3/search/trending")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("trending " + r.status))))
    .then((j) => {
      cache = {
        at: Date.now(),
        coins: (j.coins || []).map((c, i) => ({
          pos: i + 1, symbol: String(c.item?.symbol || "").toUpperCase(), name: c.item?.name || "", cap: c.item?.market_cap_rank || null,
          price: c.item?.data?.price ?? null, chg24: c.item?.data?.price_change_percentage_24h?.usd ?? null,
        })).filter((c) => /^[A-Z0-9]{2,12}$/.test(c.symbol)),
        categories: (j.categories || []).map((x) => x.name).filter(Boolean).slice(0, 6),
      };
      return cache;
    })
    .finally(() => (loading = null));
  return loading;
}

/** Trending position for a coin (by its ticker), or null. Uses the cached list only. */
export function trendingRank(base) {
  if (!cache || !base) return null;
  return cache.coins.find((c) => c.symbol === String(base).toUpperCase()) || null;
}

/** Outside check for "Entryvex says" (crypto only). Context, never a vote: attention isn't proven to help. */
export async function trendingCheck(base) {
  try { await getTrending(); } catch { return null; }
  const t = trendingRank(base);
  if (!t) return null;
  return {
    label: "Crowd attention",
    effect: 0,
    text: `#${t.pos} on CoinGecko's trending searches right now${t.chg24 != null ? ` (${t.chg24 >= 0 ? "+" : ""}${t.chg24.toFixed(1)}% in 24h)` : ""}. Lots of people are looking at it. That often comes after a big move and can reverse fast; Entryvex is still measuring whether it predicts anything.`,
  };
}

/** For the AI analyst. */
export function trendingSnapshot() {
  if (!cache) return null;
  return { source: "CoinGecko trending searches (last 24h)", coins: cache.coins.map((c) => `#${c.pos} ${c.symbol}${c.chg24 != null ? ` ${c.chg24 >= 0 ? "+" : ""}${c.chg24.toFixed(1)}%/24h` : ""}${c.cap ? ` (size rank ${c.cap})` : ""}`), categories: cache.categories };
}
