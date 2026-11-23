// Forecast scorecard: Entryvex's price forecasts, written down BEFORE the fact and graded after.
//
// Every few hours (1h charts) or once a day (1d charts) the server saves the forecast for each of the
// bot's 12 markets: the 80% range, the 50% range and the odds of being higher 20 candles later.
// When those 20 candles have closed, it checks what really happened: did price land inside the range,
// and was the lean (up/down) right? The record is public at /api/scorecard and in the app.
//
// "Tested on past data" fills the scorecard straight away: the same forecast, made at past moments
// using only the candles before that moment, then checked against what came next.
import { forecast } from "../../public/js/forecast.js";
import { candles } from "./push.js";
import { MARKETS } from "./bot.js";

const KEY = "score:v1";
export const SCORE = {
  H: 20,                                   // candles ahead (same as the chart forecast)
  ivs: { "1h": 3600, "1d": 86400 },
  lean: 0.03,                              // odds within 3 points of 50% = "no call" (a coin flip)
  keep: 400,                               // graded forecasts kept in full (totals are kept forever)
  logEvery: { "1h": 4 * 3600e3, "1d": 20 * 3600e3 },
  backPoints: 60, backRefresh: 7 * 86400e3,
  fetchesPerTick: 4,                       // price fetches per 5-minute tick for saving/checking
  retryAfter: 30 * 60e3,                   // a market/chart is looked at again after 30 minutes at most
};
const bySym = Object.fromEntries(MARKETS.map((m) => [m.sym, m]));
const blank = () => ({ n: 0, in80: 0, in50: 0, called: 0, right: 0 });
const fresh = (now) => ({ v: 1, started: now, pending: [], graded: [], live: {}, back: {}, lastLog: {}, tried: {} });

export function callOf(pUp) {
  return pUp >= 0.5 + SCORE.lean ? "up" : pUp <= 0.5 - SCORE.lean ? "down" : null;
}
/** Grade one forecast against the real close H candles later. */
export function grade(e, actual) {
  const call = callOf(e.pUp);
  return {
    ...e, actual,
    in80: actual >= e.lo && actual <= e.hi,
    in50: actual >= e.lo50 && actual <= e.hi50,
    call, right: call ? (call === "up") === (actual > e.p0) : null,
  };
}
function tally(st, g) {
  st.n++; if (g.in80) st.in80++; if (g.in50) st.in50++;
  if (g.call) { st.called++; if (g.right) st.right++; }
}
function record(f, sym, iv, now) {
  const r = (x) => +x.toPrecision(8);
  return { sym, iv, t0: f.t0, at: now, p0: r(f.live), lo: r(f.range80[0]), hi: r(f.range80[1]), lo50: r(f.range50[0]), hi50: r(f.range50[1]), mid: r(f.mid), pUp: +f.pUp.toFixed(3) };
}

/** Walk forward through history: forecast at past moments using only earlier candles, then check. */
export function backtest(all, iv) {
  const sec = SCORE.ivs[iv], H = SCORE.H;
  const closed = all.slice(0, -1);         // the newest candle may still be forming
  const start = 320, last = closed.length - 1 - H;
  const st = { ...blank(), from: null, to: null };
  if (last <= start) return st;
  const step = Math.max(1, Math.floor((last - start) / SCORE.backPoints));
  for (let t = start; t <= last; t += step) {
    const f = forecast(closed.slice(0, t + 1), sec, H);
    if (!f) continue;
    tally(st, grade(record(f, "", iv, 0), closed[t + H].close));
    st.from ??= closed[t].time * 1000; st.to = closed[t + H].time * 1000;
  }
  return st;
}

/** When a forecast's 20 candles should have closed (stocks only trade ~6.5 hours a day, 5 days a week). */
function dueAt(e) {
  const stock = e.sym.startsWith("S:");
  if (e.iv === "1h") return e.at + (stock ? 4 * 86400e3 : SCORE.H * 3600e3);
  return e.at + (stock ? 29 * 86400e3 : SCORE.H * 86400e3);
}

function usMarketOpen(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const m = +p.hour * 60 + +p.minute;
  return !["Sat", "Sun"].includes(p.weekday) && m >= 570 && m < 960;
}

export async function cronScore(env, now = Date.now()) {
  if (!env?.PUSH) return;
  let s = await env.PUSH.get(KEY, "json");
  let changed = false;
  if (!s || s.v !== 1) { s = fresh(now); changed = true; }

  // 1) One past-data test per tick until every market and chart has one (refreshed weekly).
  for (const m of MARKETS) {
    let done = false;
    for (const iv of Object.keys(SCORE.ivs)) {
      const k = `${m.sym}|${iv}`;
      if (s.back[k] && now - s.back[k].at < SCORE.backRefresh) continue;
      try {
        const c = await candles(m.sym, iv, 1000);
        s.back[k] = { ...backtest(c, iv), at: now };
      } catch { s.back[k] = { ...blank(), at: now - SCORE.backRefresh + 3600e3, failed: true }; }   // retry in an hour
      changed = done = true;
      break;
    }
    if (done) break;
  }

  // 2) Save new forecasts and grade the ones whose 20 candles have closed. A few price fetches per
  //    5-minute tick (Cloudflare limits outside requests per run, shared with the bot and alerts).
  {
    const open = usMarketOpen(now);
    s.tried ??= {};
    let fetches = 0;
    for (const m of MARKETS) {
      for (const [iv, sec] of Object.entries(SCORE.ivs)) {
        if (fetches >= SCORE.fetchesPerTick) break;
        const k = `${m.sym}|${iv}`;
        if (now - (s.tried[k] || 0) < SCORE.retryAfter) continue;   // checked or failed recently
        const due = s.pending.filter((e) => e.sym === m.sym && e.iv === iv && now >= dueAt(e));
        const last = s.lastLog[k];
        const wantLog = (!last || now - last.at >= SCORE.logEvery[iv]) && (!m.stock || open);
        if (!due.length && !wantLog) continue;
        fetches++;
        s.tried[k] = now;
        let c;
        try { c = await candles(m.sym, iv, 1000); } catch { continue; }
        if (!c?.length) continue;
        changed = true;
        let graded = 0;
        for (const e of due) {
          // Nearest candle, not an exact match: Yahoo stamps today's still-forming candle with the latest trade time.
          const i = c.findIndex((x) => Math.abs(x.time - e.t0) < sec / 2);
          if (i >= 0 && i + SCORE.H < c.length - 1) {
            const g = grade(e, c[i + SCORE.H].close);
            g.doneAt = now;
            s.graded.push(g);
            tally((s.live[k] ??= blank()), g);
            s.pending.splice(s.pending.indexOf(e), 1);
            graded++;
          } else if (i < 0 && now - e.at > 120 * 86400e3) s.pending.splice(s.pending.indexOf(e), 1);   // can't be checked any more
        }
        if (due.length && !graded && !wantLog) s.tried[k] = now + 2 * 3600e3;   // not closed yet: look again in ~2.5 hours
        if (wantLog) {
          const f = forecast(c, sec, SCORE.H);
          if (f && f.t0 !== last?.t0) { s.pending.push(record(f, m.sym, iv, now)); s.lastLog[k] = { at: now, t0: f.t0 }; }
        }
      }
    }
    if (s.graded.length > SCORE.keep) s.graded = s.graded.slice(-SCORE.keep);
  }
  if (changed) await env.PUSH.put(KEY, JSON.stringify(s));
}

function sum(list) {
  const t = blank();
  for (const x of list) if (x) for (const f of Object.keys(t)) t[f] += x[f] || 0;
  return t;
}

/** GET /api/scorecard: the public record. */
export async function onRequestGet({ env }) {
  const s = env?.PUSH ? await env.PUSH.get(KEY, "json") : null;
  const ivs = Object.keys(SCORE.ivs);
  const body = !s ? { started: null } : {
    started: s.started, H: SCORE.H, lean: SCORE.lean, ivs,
    overall: Object.fromEntries(ivs.map((iv) => [iv, {
      live: sum(MARKETS.map((m) => s.live[`${m.sym}|${iv}`])),
      back: sum(MARKETS.map((m) => s.back[`${m.sym}|${iv}`])),
    }])),
    markets: MARKETS.map((m) => ({
      sym: m.sym, name: m.name, stock: !!m.stock,
      ...Object.fromEntries(ivs.map((iv) => {
        const k = `${m.sym}|${iv}`, b = s.back[k];
        return [iv, { live: s.live[k] || blank(), back: b && !b.failed ? { n: b.n, in80: b.in80, in50: b.in50, called: b.called, right: b.right, from: b.from, to: b.to } : null }];
      })),
    })),
    recent: s.graded.slice(-60).reverse().map((g) => ({ ...g, name: bySym[g.sym]?.name || g.sym })),
    waiting: s.pending.length,
    nextCheck: s.pending.length ? Math.min(...s.pending.map(dueAt)) : null,
  };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } });
}
