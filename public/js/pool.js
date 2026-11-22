// A small pool of background workers for the engine. Falls back to running on the main thread
// when workers aren't available (old browsers) or fail to start.
import { analyze, trainPooled } from "./engine.js";

const SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
let workers = null, broken = false, seq = 0;
const waiting = new Map();
const idle = [];
const queue = [];

function start() {
  if (workers || broken) return;
  try {
    workers = [];
    for (let k = 0; k < SIZE; k++) {
      const w = new Worker(new URL("./analyze-worker.js", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        const job = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        idle.push(w);
        pump();
        if (!job) return;
        if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.r);
      };
      w.onerror = () => { broken = true; for (const [, j] of waiting) j.fallback(); waiting.clear(); };
      workers.push(w);
      idle.push(w);
    }
  } catch { broken = true; }
}
function pump() {
  while (idle.length && queue.length) {
    const w = idle.pop(), job = queue.shift();
    waiting.set(job.id, job);
    w.postMessage({ id: job.id, candles: job.candles, opts: job.opts, markets: job.markets });
  }
}

/** Train the shared model (engine.trainPooled) in a background worker. */
export function trainPooledAsync(markets) {
  start();
  if (broken) return Promise.resolve(trainPooled(markets));
  return new Promise((resolve, reject) => {
    const job = { id: ++seq, markets, resolve, reject, fallback: () => { try { resolve(trainPooled(markets)); } catch (e) { reject(e); } } };
    queue.push(job);
    pump();
  });
}

/** Analyze candles in a background worker; resolves with the same result shape as analyze(). */
export function analyzeAsync(candles, opts) {
  start();
  if (broken) return Promise.resolve(analyze(candles, opts));
  return new Promise((resolve, reject) => {
    const job = { id: ++seq, candles, opts, resolve, reject, fallback: () => { try { resolve(analyze(candles, opts)); } catch (e) { reject(e); } } };
    queue.push(job);
    pump();
  });
}
