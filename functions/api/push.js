// Alerts while Entryvex is closed.
//   GET  /api/push/key            -> VAPID public key for the browser to subscribe with
//   POST /api/push/sync {id, subscription, prefs}  -> save/refresh this browser's alert settings
//   POST /api/push/remove {id}     -> forget this browser
//   POST /api/push/test {id}       -> send a test notification now
//   cron (every 5 min) -> runAlerts(env): checks price alerts, trade exits (take-profit / stop /
//   time limit), big moves, and BUY setups on markets with a track record, then sends notifications.
// Storage (Cloudflare KV): only an anonymous browser push address + alert settings. No names/emails.
import { vapidKeys, sendPush } from "./webpush.js";
import { SETUPS, RULES } from "../../public/js/engine.js";
import { computeAll } from "../../public/js/indicators.js";

const ALLOWED = [/^https:\/\/(www\.)?entryvex\.trade$/, /^http:\/\/localhost(:\d+)?$/];
const UA = "Mozilla/5.0 (compatible; Entryvex/1.0; +https://entryvex.trade)";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const okId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{16,40}$/.test(id);
const isStock = (s) => typeof s === "string" && s.startsWith("S:");

/* ---------------- HTTP endpoints ---------------- */
export async function onRequest(context) {
  const { request, env } = context;
  if (!env.PUSH) return json({ error: "Closed-app alerts aren't set up on this server." }, 503);
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/push\/?/, "");

  if (request.method === "GET" && path === "key") {
    const keys = await vapidKeys(env.PUSH);
    return json({ publicKey: keys.publicKey });
  }
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED.some((re) => re.test(origin))) return json({ error: "forbidden" }, 403);
  const raw = await request.text();
  if (raw.length > 40_000) return json({ error: "too large" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  if (!okId(body.id)) return json({ error: "bad id" }, 400);
  const key = `sub:${body.id}`;

  if (path === "sync") {
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: "bad subscription" }, 400);
    const prev = (await env.PUSH.get(key, "json")) || {};
    const rec = {
      sub: { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } },
      prefs: cleanPrefs(body.prefs || {}),
      fired: prev.fired || {},
      updated: Date.now(),
    };
    await env.PUSH.put(key, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 45 });  // forgotten after 45 days without a visit
    return json({ ok: true });
  }
  if (path === "remove") { await env.PUSH.delete(key); return json({ ok: true }); }
  if (path === "test") {
    const rec = await env.PUSH.get(key, "json");
    if (!rec) return json({ error: "not subscribed" }, 404);
    const keys = await vapidKeys(env.PUSH);
    const r = await sendPush(rec.sub, { title: "Entryvex alerts are on ✓", body: "You'll get notifications like this even when Entryvex is closed.", url: "/" }, keys);
    if (r.gone) await env.PUSH.delete(key);
    return json({ ok: r.ok, status: r.status });
  }
  return json({ error: "not found" }, 404);
}

const SYM = /^(S:[A-Z0-9.\-]{1,10}|[A-Z0-9]{3,20})$/;
const IVS = new Set(["15m", "1h", "4h"]);
function cleanPrefs(p) {
  const num = (v) => (Number.isFinite(+v) ? +v : null);
  return {
    priceAlerts: (Array.isArray(p.priceAlerts) ? p.priceAlerts : []).slice(0, 30)
      .filter((a) => SYM.test(a.symbol) && (a.dir === "above" || a.dir === "below") && num(a.price) > 0)
      .map((a) => ({ id: String(a.id).slice(0, 16), symbol: a.symbol, dir: a.dir, price: +a.price, base: String(a.base || "").slice(0, 12) })),
    trades: (Array.isArray(p.trades) ? p.trades : []).slice(0, 20)
      .filter((t) => SYM.test(t.symbol))
      .map((t) => ({ id: String(t.id).slice(0, 16), symbol: t.symbol, base: String(t.base || "").slice(0, 12), stop: num(t.stop), target: num(t.target), sellBy: num(t.sellBy) })),
    move: p.move?.on ? { on: true, pct: Math.max(0.5, Math.min(50, num(p.move.pct) || 2)), symbols: (p.move.symbols || []).filter((s) => SYM.test(s)).slice(0, 30) } : { on: false },
    setups: (Array.isArray(p.setups) ? p.setups : []).slice(0, 25)
      .filter((m) => SYM.test(m.symbol) && IVS.has(m.interval) && Array.isArray(m.setupIds))
      .map((m) => ({ symbol: m.symbol, base: String(m.base || "").slice(0, 12), interval: m.interval, setupIds: m.setupIds.filter((x) => SETUPS.some((s) => s.id === x)).slice(0, 4), labels: m.labels || {} })),
  };
}

/* ---------------- Market data (server side) ---------------- */
async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, cf: { cacheTtl: 30 } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const yahooTicker = (sym) => (isStock(sym) ? sym.slice(2) : `${sym.replace(/(USDT|USDC|USD)$/, "")}-USD`);

/** Candles for a symbol: Binance.US for crypto (Yahoo as a fallback), Yahoo for stocks. */
async function candles(sym, interval, limit) {
  if (!isStock(sym)) {
    try {
      const k = await getJSON(`https://api.binance.us/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
      if (Array.isArray(k) && k.length) return k.map((x) => ({ time: x[0] / 1000, open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] }));
    } catch { /* fall back to Yahoo */ }
  }
  const map = { "5m": ["5m", "5d"], "15m": ["15m", "1mo"], "1h": ["60m", "3mo"], "4h": ["60m", "1y"] }[interval];
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker(sym))}?interval=${map[0]}&range=${map[1]}&includePrePost=false`);
  const r = j?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0] || {};
  let c = [];
  (r?.timestamp || []).forEach((t, i) => {
    if (q.close?.[i] == null || q.open?.[i] == null) return;
    c.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] || 0 });
  });
  if (interval === "4h") {   // combine 4 hourly candles of the same day
    const out = []; let cur = null, n = 0, day = null;
    for (const k of c) {
      const d = new Date(k.time * 1000).toISOString().slice(0, 10);
      if (!cur || n === 4 || d !== day) { if (cur) out.push(cur); cur = { ...k }; n = 1; day = d; }
      else { cur.high = Math.max(cur.high, k.high); cur.low = Math.min(cur.low, k.low); cur.close = k.close; cur.volume += k.volume; n++; }
    }
    if (cur) out.push(cur);
    c = out;
  }
  return c.slice(-limit);
}

/* ---------------- The 5-minute check ---------------- */
export async function runAlerts(env, now = Date.now()) {
  if (!env.PUSH) return;
  const keys = await vapidKeys(env.PUSH);
  const list = await env.PUSH.list({ prefix: "sub:", limit: 200 });
  const runSetups = new Date(now).getUTCMinutes() % 15 < 5;   // BUY-setup checks every 15 minutes
  const cache = new Map();
  const get = (sym, iv, limit) => {
    const k = `${sym}|${iv}|${limit}`;
    if (!cache.has(k)) cache.set(k, candles(sym, iv, limit).catch(() => null));
    return cache.get(k);
  };

  for (const { name } of list.keys) {
    const rec = await env.PUSH.get(name, "json");
    if (!rec) continue;
    const p = rec.prefs || {};
    const fired = rec.fired || {};
    const msgs = [];
    const fire = (key, msg) => { if (!fired[key]) { fired[key] = now; msgs.push(msg); } };

    // Latest prices from recent 5-minute candles (also used for big-move checks).
    const syms = new Set([...(p.priceAlerts || []).map((a) => a.symbol), ...(p.trades || []).map((t) => t.symbol), ...(p.move?.on ? p.move.symbols : [])]);
    const recent = {};
    for (const s of syms) { const c = await get(s, "5m", 13); if (c?.length) recent[s] = c; }
    const price = (s) => recent[s]?.at(-1)?.close;
    const label = (s, base) => base || (isStock(s) ? s.slice(2) : s.replace(/(USDT|USDC|USD)$/, ""));

    for (const a of p.priceAlerts || []) {
      const px = price(a.symbol);
      if (px && ((a.dir === "above" && px >= a.price) || (a.dir === "below" && px <= a.price)))
        fire(`p:${a.id}`, { title: `${label(a.symbol, a.base)} is ${a.dir} ${a.price}`, body: `It just traded at ${px}.`, url: `/?s=${encodeURIComponent(a.symbol)}` });
    }
    for (const t of p.trades || []) {
      const px = price(t.symbol), name = label(t.symbol, t.base);
      if (px && t.target && px >= t.target) fire(`t:${t.id}`, { title: `SELL: ${name} take-profit reached 🎯`, body: `Price ${px} is at your target ${t.target}. If your OCO order is set it may have filled; if not, sell now.`, url: `/?s=${encodeURIComponent(t.symbol)}` });
      else if (px && t.stop && px <= t.stop) fire(`t:${t.id}`, { title: `SELL: ${name} stop-loss reached`, body: `Price ${px} is at your stop ${t.stop}. Selling limits the loss.`, url: `/?s=${encodeURIComponent(t.symbol)}` });
      else if (t.sellBy && now >= t.sellBy) fire(`t:${t.id}`, { title: `SELL NOW: ${name} time limit reached`, body: "Neither target nor stop was hit in time. Entryvex's plan is to sell at the market price now.", url: `/?s=${encodeURIComponent(t.symbol)}` });
    }
    if (p.move?.on) {
      const hour = Math.floor(now / 3600e3);
      for (const s of p.move.symbols) {
        const c = recent[s];
        if (!c || c.length < 4) continue;
        const from = c[0].close, to = c.at(-1).close, chg = ((to - from) / from) * 100;
        if (Math.abs(chg) >= p.move.pct) fire(`m:${s}:${hour}`, { title: `${label(s)} ${chg > 0 ? "jumped" : "dropped"} ${Math.abs(chg).toFixed(1)}% in the last hour`, body: `Now ${to}. Big fast moves often come with news.`, url: `/?s=${encodeURIComponent(s)}` });
      }
    }
    if (runSetups) {
      for (const m of p.setups || []) {
        const c = await get(m.symbol, m.interval, RULES.warmup + 60);
        if (!c || c.length < RULES.warmup + 2) continue;
        const x = computeAll(c);
        const i = c.length - 2;   // last CLOSED candle
        for (const s of SETUPS) {
          if (!m.setupIds.includes(s.id)) continue;
          let active = false;
          try { active = !!s.test(i, c, x); } catch {}
          if (active) fire(`s:${m.symbol}:${m.interval}:${s.id}:${c[i].time}`, {
            title: `${m.labels?.[s.id] || "BUY signal"}: ${label(m.symbol, m.base)} · ${s.name} (${m.interval})`,
            body: "A setup with a positive track record just appeared. Open Entryvex for the buy plan, sell prices and size.",
            url: `/?s=${encodeURIComponent(m.symbol)}&i=${m.interval}`,
          });
        }
      }
    }

    if (!msgs.length) continue;
    let gone = false;
    for (const msg of msgs.slice(0, 5)) {
      const r = await sendPush(rec.sub, msg, keys).catch(() => ({ ok: false }));
      if (r.gone) { gone = true; break; }
    }
    // Keep the "already sent" list small: forget entries older than 3 days.
    for (const k of Object.keys(fired)) if (now - fired[k] > 3 * 86400e3) delete fired[k];
    if (gone) await env.PUSH.delete(name);
    else await env.PUSH.put(name, JSON.stringify({ ...rec, fired }), { expirationTtl: 60 * 60 * 24 * 45 });
  }
}
