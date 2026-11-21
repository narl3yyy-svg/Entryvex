// Live currency conversion so a USD trading balance can size trades on non-US-dollar markets
// (Tokyo, London, Frankfurt…). Rates come from Yahoo Finance FX quotes ("JPY=X" = yen per 1 USD),
// refreshed every 10 minutes.
//
// Some exchanges quote in minor units: London in pence (GBp), Johannesburg in cents (ZAc),
// Tel Aviv in agorot (ILA). Those are handled as 1/100 of the main currency.

const MINOR = { GBp: ["GBP", 100], GBX: ["GBP", 100], ZAc: ["ZAR", 100], ZAC: ["ZAR", 100], ILA: ["ILS", 100] };
const SYMBOL = { USD: "$", GBP: "£", EUR: "€", JPY: "¥", CNY: "CN¥", HKD: "HK$", KRW: "₩", INR: "₹", AUD: "A$", CAD: "C$", BRL: "R$", MXN: "MX$", CHF: "CHF ", SEK: "SEK ", NOK: "NOK ", DKK: "DKK ", TWD: "NT$", SGD: "S$", NZD: "NZ$", ZAR: "R", ILS: "₪" };
const cache = new Map();     // main currency → { rate, t }
const pending = new Map();
const TTL = 10 * 60_000;

/** Main currency and minor-unit divisor for a quote currency ("GBp" → ["GBP", 100]). */
export function majorOf(cur) { return MINOR[cur] || [cur || "USD", 1]; }

/** Units of the quote currency per 1 USD (e.g. 150 for JPY, 79 for GBp at 0.79 GBP/USD), or null if not loaded yet. */
export function fxRate(cur) {
  const [major, div] = majorOf(cur);
  if (major === "USD") return 1;
  const hit = cache.get(major);
  if (!hit || Date.now() - hit.t > TTL) loadFx(cur);
  return hit ? hit.rate * div : null;
}

/** Load a rate; resolves to units of `cur` per 1 USD (or null when unavailable). */
export function loadFx(cur) {
  const [major, div] = majorOf(cur);
  if (major === "USD") return Promise.resolve(1);
  if (!/^[A-Z]{3}$/.test(major)) return Promise.resolve(null);
  if (pending.has(major)) return pending.get(major).then((r) => (r ? r * div : null));
  const p = fetch(`/api/market?src=chart&symbol=${major}%3DX&interval=1d&range=5d`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const rate = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (rate > 0) { cache.set(major, { rate, t: Date.now() }); listeners.forEach((f) => f(major)); return rate; }
      return null;
    })
    .catch(() => null)
    .finally(() => pending.delete(major));
  pending.set(major, p);
  return p.then((r) => (r ? r * div : null));
}

const listeners = new Set();
/** Called when a new rate arrives (to re-render). */
export function onFx(fn) { listeners.add(fn); }

/**
 * Format an amount given in the quote currency, with its US-dollar value:
 *   money(12345, "JPY", 150) → "¥12,345 (≈$82.30)"
 */
export function money(v, cur, rate, { sign = false } = {}) {
  const [major, div] = majorOf(cur);
  const main = v / div;
  const s = sign ? (v >= 0 ? "+" : "−") : v < 0 ? "−" : "";
  const sym = SYMBOL[major] ?? major + " ";
  const digits = Math.abs(main) >= 1000 || major === "JPY" || major === "KRW" ? 0 : 2;
  const local = `${s}${sym}${Math.abs(main).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
  if (major === "USD") return local;
  if (!(rate > 0)) return local;
  const usd = Math.abs(v / rate);
  return `${local} <span class="muted">(≈${s}$${usd.toLocaleString("en-US", { maximumFractionDigits: usd < 100 ? 2 : 0 })})</span>`;
}
