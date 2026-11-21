// Candle history saved in this browser (IndexedDB) between visits, so opening Entryvex only
// downloads the candles that are new since last time instead of up to 3,000 per market.
// Everything stays on this device. If storage isn't available (private mode, blocked site data),
// every function quietly falls back to "nothing saved" and the app downloads as before.

const DB = "entryvex", STORE = "candles", VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

/** Saved candles for a key, oldest first ([] when nothing is saved). */
export async function loadCandles(key) {
  const db = await open();
  if (!db) return { candles: [], saved: 0 };
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        if (!v || !Array.isArray(v.c)) return resolve({ candles: [], saved: 0 });
        resolve({ saved: v.saved || 0, all: !!v.all, candles: v.c.map((k) => ({ time: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] })) });
      };
      req.onerror = () => resolve({ candles: [], saved: 0 });
    } catch { resolve({ candles: [], saved: 0 }); }
  });
}

/**
 * Save candles for a key (compact arrays; keeps at most `max`). `all` = this is the market's entire
 * history (it has fewer candles than were asked for). Never throws.
 */
export async function saveCandles(key, candles, max = 3000, all = false) {
  const db = await open();
  if (!db || !candles?.length) return;
  try {
    const c = candles.slice(-max).map((k) => [k.time, k.open, k.high, k.low, k.close, k.volume || 0]);
    db.transaction(STORE, "readwrite").objectStore(STORE).put({ saved: Date.now(), all, c }, key);
  } catch {}
}

/**
 * Merge freshly downloaded candles into saved ones: everything from the first new candle's time
 * onwards is replaced (the last saved candle may have still been forming).
 */
export function mergeCandles(saved, fresh) {
  if (!fresh.length) return saved.slice();
  if (!saved.length) return fresh.slice();
  const t0 = fresh[0].time;
  const keep = saved.filter((k) => k.time < t0);
  return keep.concat(fresh);
}
