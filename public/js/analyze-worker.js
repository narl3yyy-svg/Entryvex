// Runs the engine (setups, candle patterns and the prediction model) off the page's main thread,
// so checking a whole watchlist doesn't freeze scrolling or the chart.
import { analyze, trainPooled } from "./engine.js";

/** Plain copy without functions (structured clone keeps NaN, which the app relies on). */
function plain(v, seen = new Map()) {
  if (v === null || typeof v !== "object") return typeof v === "function" ? undefined : v;
  if (seen.has(v)) return seen.get(v);
  if (Array.isArray(v)) { const a = []; seen.set(v, a); for (const x of v) a.push(plain(x, seen)); return a; }
  if (v instanceof Map) return undefined;
  const o = {};
  seen.set(v, o);
  for (const [k, x] of Object.entries(v)) if (typeof x !== "function") o[k] = plain(x, seen);
  return o;
}

self.onmessage = (e) => {
  const { id, candles, opts, markets } = e.data;
  try { self.postMessage({ id, r: markets ? trainPooled(markets) : plain(analyze(candles, opts)) }); }
  catch (err) { self.postMessage({ id, error: String(err?.message || err) }); }
};
