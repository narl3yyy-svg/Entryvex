// Alerts: price targets, sudden big moves, and "a setup with a positive track record
// just appeared on my watchlist". Runs in the browser while Entryvex is open
// (a background tab is fine). Delivered as an on-page toast, an optional sound,
// and an optional desktop notification.
import { analyze } from "./engine.js";
import { getKlineHistory, getKlines, getBookTicker, isStock } from "./market.js";
import { coinName } from "./coins.js";
import { logFromAnalysis } from "./signals.js";
import { pushSupported, pushEnabled, enablePush, disablePush, testPush, scheduleSync, ntfyEnabled, ntfyTopic, enableNtfy, disableNtfy } from "./push.js";
import * as fmt from "./format.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};
const MINUTES = { "5m": 5, "15m": 15, "1h": 60, "4h": 240 };

const cfg = Object.assign({
  sound: true,
  desktop: false,
  setup: { on: false, interval: "15m", min: "go" },   // min: "go" | "caution"
  move: { on: false, pct: 2, minutes: 15 },
}, store.get("alertCfg", {}));
let priceAlerts = store.get("priceAlerts", []);  // {id, symbol, dir:"above"|"below", price, created, done}
let history = store.get("alertHistory", []);     // {t, title, body, symbol}
const saveCfg = () => { store.set("alertCfg", cfg); scheduleSync(); };
const savePrice = () => { store.set("priceAlerts", priceAlerts); scheduleSync(); };

/** Settings the server needs for closed-app alerts. */
export function getAlertPrefs() {
  return {
    priceAlerts: priceAlerts.filter((a) => !a.done).map((a) => ({ id: a.id, symbol: a.symbol, dir: a.dir, price: a.price, base: baseOf(a.symbol) })),
    move: { on: cfg.move.on, pct: cfg.move.pct, symbols: hooks.getWatchlist() },
    setupOn: cfg.setup.on, setupMin: cfg.setup.min,
  };
}

let hooks = { getWatchlist: () => [], getInfo: () => null, onPick: () => {}, onBadges: () => {}, getSelected: () => null, getPrice: () => null };

/* ================= Delivery ================= */
let audioCtx = null;
function beep() {
  if (!cfg.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.15);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.16);
    });
  } catch {}
}

let titleTimer = null;
function flashTitle(text) {
  if (document.visibilityState === "visible") return;
  clearInterval(titleTimer);
  const orig = document.title;
  let on = false;
  titleTimer = setInterval(() => { document.title = (on = !on) ? `🔔 ${text}` : orig; }, 1000);
  const stop = () => { clearInterval(titleTimer); document.removeEventListener("visibilitychange", stop); };
  document.addEventListener("visibilitychange", stop);
}

function notify({ title, body, symbol, kind, interval = null }) {
  history.unshift({ t: Date.now(), title, body, symbol, kind, interval, unread: true });
  history = history.slice(0, 30);
  store.set("alertHistory", history);
  toast(title, body, symbol, kind, interval);
  beep();
  flashTitle(title);
  if (cfg.desktop && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, { body, icon: "/favicon.svg", tag: `${kind}:${symbol}` });
      n.onclick = () => { window.focus(); if (symbol) openAlert(symbol, interval); n.close(); };
    } catch {}
  }
  renderDrawer();
}

/** Let other parts of the app (e.g. My trades) raise an alert. */
export function pushAlert(a) { notify(a); }

/** Open the coin or stock an alert is about (on the alert's candle size when it has one). */
function openAlert(symbol, interval) {
  toggleDrawer(false);
  hooks.onPick(symbol, interval);
}

function toast(title, body, symbol, kind, interval = null) {
  const box = $("toasts");
  const el = document.createElement("button");
  el.className = `toast toast-${kind || "info"}`;
  el.innerHTML = `<strong>${fmt.esc(title)}</strong><span>${fmt.esc(body)}</span>`;
  if (symbol) el.title = "Open it";
  el.addEventListener("click", () => { if (symbol) openAlert(symbol, interval); el.remove(); });
  box.prepend(el);
  setTimeout(() => el.classList.add("out"), 9000);
  setTimeout(() => el.remove(), 9600);
}

/* ================= Price + big-move alerts (fed by the live ticker) ================= */
const tape = new Map();       // symbol -> [{t, p}]
const moveCooldown = new Map();

export function onTicker(symbol, price) {
  // Price alerts
  for (const a of priceAlerts) {
    if (a.done || a.symbol !== symbol) continue;
    if ((a.dir === "above" && price >= a.price) || (a.dir === "below" && price <= a.price)) {
      a.done = Date.now();
      savePrice();
      const base = baseOf(symbol);
      notify({ kind: "price", symbol, title: `${base} is ${a.dir} ${fmt.price(a.price)}`, body: `${coinName(base)} just traded at ${fmt.price(price)}.` });
    }
  }
  // Big moves
  if (!cfg.move.on) return;
  const now = Date.now();
  let arr = tape.get(symbol);
  if (!arr) tape.set(symbol, (arr = []));
  if (!arr.length || now - arr[arr.length - 1].t > 5000) arr.push({ t: now, p: price });
  const windowMs = cfg.move.minutes * 60_000;
  while (arr.length && now - arr[0].t > windowMs) arr.shift();
  if (arr.length < 2 || now - arr[0].t < windowMs * 0.5) return;  // need enough history
  const chg = (price - arr[0].p) / arr[0].p * 100;
  if (Math.abs(chg) >= cfg.move.pct && now - (moveCooldown.get(symbol) || 0) > 30 * 60_000) {
    moveCooldown.set(symbol, now);
    const base = baseOf(symbol);
    notify({
      kind: chg > 0 ? "up" : "down", symbol,
      title: `${base} ${chg > 0 ? "jumped" : "dropped"} ${Math.abs(chg).toFixed(1)}% in ${cfg.move.minutes} min`,
      body: `Now ${fmt.price(price)}. Big fast moves often come with news; check the Research panel.`,
    });
  }
}

function baseOf(symbol) { return hooks.getInfo(symbol)?.base ?? symbol.replace(/(USDT|USDC|USD)$/, ""); }

/* ================= Setup alerts (auto-scan after each candle closes) ================= */
const candleCache = new Map(); // `${sym}:${interval}` -> candles
const lastSetupAlert = new Map();
let scanTimer = null;
let badges = {};               // symbol -> {level,label,interval}

function scheduleScan() {
  clearTimeout(scanTimer);
  if (!cfg.setup.on) { badges = {}; hooks.onBadges(badges); return; }
  const ms = MINUTES[cfg.setup.interval] * 60_000;
  const next = Math.ceil(Date.now() / ms) * ms + 4000;  // a few seconds after the candle closes
  scanTimer = setTimeout(async () => { await runScan(); scheduleScan(); }, Math.max(1000, next - Date.now()));
}

async function loadCandles(sym, interval) {
  const key = `${sym}:${interval}`;
  let c = candleCache.get(key);
  if (!c) {
    c = await getKlineHistory(sym, interval, 3000);
  } else {
    const fresh = await getKlines(sym, interval, 5);
    for (const k of fresh) {
      const i = c.findIndex((x) => x.time === k.time);
      if (i >= 0) c[i] = k; else if (k.time > c[c.length - 1].time) c.push(k);
    }
    if (c.length > 3100) c = c.slice(-3000);
  }
  candleCache.set(key, c);
  return c;
}

let scanning = false;
let lastScanText = "";
let pushMsg = "";
let pushBusy = false;
let ntfyMsg = "";
export async function runScan() {
  if (scanning || !cfg.setup.on) return;
  scanning = true;
  const interval = cfg.setup.interval;
  const fee = (+store.get("feePct", 0.02) || 0) / 100;
  const syms = hooks.getWatchlist();
  const queue = [...syms];
  const next = {};
  const worker = async () => {
    while (queue.length) {
      const sym = queue.shift();
      try {
        const [c, book] = await Promise.all([loadCandles(sym, interval), getBookTicker(sym).catch(() => ({ spreadPct: NaN }))]);
        const r = analyze(c, { costPerSide: (isStock(sym) ? 0 : fee) + (isFinite(book.spreadPct) ? book.spreadPct / 2 : 0) });
        logFromAnalysis(sym, interval, c, r);
        next[sym] = { level: r.overall.level, label: r.overall.label, interval };
        const ok = r.overall.level === "go" || (cfg.setup.min === "caution" && r.overall.level === "caution" && r.best?.verdict.level === "weak");
        const key = `${sym}:${c[c.length - 2]?.time}`;
        if (ok && lastSetupAlert.get(sym) !== key) {
          lastSetupAlert.set(sym, key);
          const s = r.best.stats;
          const base = baseOf(sym);
          notify({
            kind: r.overall.level === "go" ? "go" : "caution", symbol: sym, interval,
            title: `${r.overall.label}: ${base} · ${r.best.name} (${interval})`,
            body: `Ended in profit ${Math.round(s.winRate * s.n)} of ${s.n} past times, avg ${fmt.pct(s.ev * 100)} per trade after costs. Open it for the trade card.`,
          });
        }
      } catch (e) { console.warn("alert scan", sym, e); }
    }
  };
  await Promise.all([worker(), worker()]);
  badges = next;
  hooks.onBadges(badges);
  const go = Object.values(next).filter((b) => b.level === "go").length;
  const caution = Object.entries(next).filter(([, b]) => b.level === "caution" && b.label === "CAUTION").length;
  const when = new Date().toLocaleTimeString([], { hour: "2-digit", hourCycle: "h23", minute: "2-digit" });
  lastScanText = `Last checked ${when}: ${syms.length} markets on ${interval}. ` + (go || caution
    ? `${go} GO (proven edge)${caution ? `, ${caution} CAUTION (weak edge)${cfg.setup.min === "go" ? ": you're only alerted on GO, so these didn't alert you. Switch \"Alert on\" to include CAUTION if you want them" : ""}` : ""}.`
    : "Nothing worth trading right now.");
  if ($("alert-scan-status")) $("alert-scan-status").textContent = lastScanText;
  scanning = false;
}

/* ================= Drawer UI ================= */
export function initAlerts(h) {
  hooks = { ...hooks, ...h };
  $("alerts-btn").addEventListener("click", () => toggleDrawer(true));
  $("alerts-close").addEventListener("click", () => toggleDrawer(false));
  $("alerts-overlay").addEventListener("click", () => toggleDrawer(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleDrawer(false); });

  const d = $("alerts-drawer");
  d.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-hist-sym]");
    if (li) openAlert(li.dataset.histSym, li.dataset.histIv || null);
  });
  d.addEventListener("change", (e) => {
    const t = e.target;
    // Price-alert form fields must NOT redraw the panel: redrawing while you click "Add"
    // replaced the button under your mouse, so the click (and the typed price) was lost.
    if (t.id && t.id.startsWith("al-p-")) return;
    if (t.id === "al-sound") cfg.sound = t.checked;
    if (t.id === "al-setup-on") cfg.setup.on = t.checked;
    if (t.id === "al-setup-int") cfg.setup.interval = t.value;
    if (t.id === "al-setup-min") cfg.setup.min = t.value;
    if (t.id === "al-move-on") cfg.move.on = t.checked;
    if (t.id === "al-move-pct") cfg.move.pct = Math.max(0.2, Math.min(50, +t.value || 2));
    if (t.id === "al-move-min") cfg.move.minutes = +t.value || 15;
    saveCfg();
    if (/al-setup/.test(t.id)) { candleCache.clear(); scheduleScan(); if (cfg.setup.on) runScan(); }
    renderDrawer();
  });
  d.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.id === "al-desktop") {
      if (!("Notification" in window)) return;
      if (cfg.desktop) { cfg.desktop = false; }
      else {
        const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
        cfg.desktop = p === "granted";
      }
      saveCfg(); renderDrawer();
    }
    if (t.id === "al-push-on") {
      if (pushBusy) return;
      pushBusy = true; pushMsg = "Turning on…"; renderDrawer();
      try { const r = await enablePush((step) => { pushMsg = step; renderDrawer(); }); pushMsg = r.msg; }
      catch (err) { pushMsg = `Couldn't turn on closed-app alerts in this browser (${err?.message || err}).`; }
      pushBusy = false;
      renderDrawer();
    }
    if (t.id === "al-ntfy-copy") { try { await navigator.clipboard.writeText(ntfyTopic()); t.textContent = "Copied ✓"; } catch { t.textContent = "Select and copy it"; } }
    if (t.id === "al-ntfy-on") { ntfyMsg = "Connecting…"; renderDrawer(); const r = await enableNtfy(); ntfyMsg = r.msg; renderDrawer(); }
    if (t.id === "al-ntfy-off") { await disableNtfy(); ntfyMsg = "Off. Your phone won't get Entryvex alerts any more. You can unsubscribe the topic in the ntfy app."; renderDrawer(); }
    if (t.id === "al-ntfy-test") { ntfyMsg = (await testPush().catch(() => false)) ? "Test sent. It should pop up on your phone within a few seconds. Nothing? Check the topic in the app matches exactly." : "Couldn't send the test. Try Turn off, then Connect again."; renderDrawer(); }
    if (t.id === "al-push-off") { await disablePush(); pushMsg = "Off. This device won't get alerts while Entryvex is closed."; renderDrawer(); }
    if (t.id === "al-push-test") { pushMsg = (await testPush().catch(() => false)) ? "Test sent. It should appear within a few seconds." : "Couldn't send the test. Try turning it off and on again."; renderDrawer(); }
    if (t.id === "al-test") { notify({ kind: "info", symbol: null, title: "Test alert", body: "This is what an Entryvex alert looks like." }); }
    if (t.dataset.del) { priceAlerts = priceAlerts.filter((a) => a.id !== t.dataset.del); savePrice(); renderDrawer(); }
    if (t.id === "al-clear-hist") { history = []; store.set("alertHistory", history); renderDrawer(); }
  });
  d.addEventListener("submit", (e) => {
    e.preventDefault();
    const sym = $("al-p-sym").value, dir = $("al-p-dir").value, price = parseFloat($("al-p-price").value);
    if (!sym || !(price > 0)) return;
    priceAlerts.push({ id: Math.random().toString(36).slice(2, 9), symbol: sym, dir, price, created: Date.now(), done: null });
    savePrice();
    $("al-p-price").value = "";
    renderDrawer();
  });

  renderDrawer();
  scheduleScan();
  if (cfg.setup.on) setTimeout(runScan, 3000);
}

/** Pre-fill the price alert form for a coin (e.g. from the chart header). */
/** Create a price alert from elsewhere in the app (e.g. "alert me to buy more at $X" in My holdings). */
export function addPriceAlert(symbol, dir, price) {
  if (!symbol || !(price > 0) || (dir !== "above" && dir !== "below")) return false;
  priceAlerts = priceAlerts.filter((a) => !(a.symbol === symbol && a.dir === dir && !a.done && Math.abs(a.price / price - 1) < 0.001));
  priceAlerts.push({ id: Math.random().toString(36).slice(2, 9), symbol, dir, price, created: Date.now(), done: null });
  savePrice();
  renderDrawer();
  return true;
}

export function openPriceAlert(symbol) {
  toggleDrawer(true);
  $("al-p-sym").value = symbol;
  const p = hooks.getPrice(symbol);
  if (p) $("al-p-price").placeholder = fmt.price(p).replace(/,/g, "");
  $("al-p-price").focus();
}

function toggleDrawer(open) {
  $("alerts-drawer").classList.toggle("open", open);
  $("alerts-overlay").hidden = !open;
  if (open) renderDrawer();
  // Opening the panel marks everything as read (after it has been shown once with the "new" markers).
  if (open && history.some((h) => h.unread)) {
    setTimeout(() => { history.forEach((h) => (h.unread = false)); store.set("alertHistory", history); updateBadge(); }, 400);
  }
}

/** The bell shows how many alerts have fired that you haven't seen yet. */
function updateBadge() {
  const unread = history.filter((h) => h.unread).length;
  const badge = $("alerts-count");
  badge.textContent = unread > 9 ? "9+" : unread;
  badge.hidden = !unread;
  const rules = priceAlerts.filter((a) => !a.done).length + (cfg.setup.on ? 1 : 0) + (cfg.move.on ? 1 : 0);
  $("alerts-btn").title = `${unread ? `${unread} new alert${unread === 1 ? "" : "s"}. ` : "No new alerts. "}${rules} alert rule${rules === 1 ? "" : "s"} switched on. (A)`;
}

function renderDrawer() {
  updateBadge();

  const wl = hooks.getWatchlist();
  const sel = hooks.getSelected();
  const notifSupported = "Notification" in window;
  const denied = notifSupported && Notification.permission === "denied";
  const body = $("alerts-body");
  const keepSym = $("al-p-sym")?.value;
  body.innerHTML = `
    <section>
      <h3>How you're alerted</h3>
      <p class="muted small">Alerts work while Entryvex is open in a browser tab (a background tab is fine).</p>
      <div class="al-row"><label class="switch"><input type="checkbox" id="al-sound" ${cfg.sound ? "checked" : ""}/> Sound</label>
        <button class="ghost-btn" id="al-desktop" ${!notifSupported || denied ? "disabled" : ""}>${cfg.desktop ? "✓ Desktop notifications on" : "Turn on desktop notifications"}</button>
        <button class="link-btn" id="al-test">Send a test</button></div>
      ${denied ? `<p class="small warn-text">Notifications are blocked for this site in your browser settings.</p>` : ""}
    </section>

    <section>
      <h3>Alerts when Entryvex is closed</h3>
      ${pushSupported()
        ? `<p class="muted small">Get your price, big-move, setup and SELL alerts as phone/computer notifications even when Entryvex isn't open. Checked every 5 minutes.</p>
           <div class="al-row">${pushEnabled()
             ? `<span class="pill pill-edge">On for this device</span><button class="ghost-btn" id="al-push-test">Send a test</button><button class="link-btn" id="al-push-off">Turn off</button>`
             : `<button class="btn" id="al-push-on">Turn on closed-app alerts</button>`}</div>
           <p class="muted tiny" id="al-push-msg">${pushMsg || "Stored on the server: only an anonymous notification address and these alert settings. No name, email or account."}</p>`
        : `<p class="muted small">This browser can't receive alerts while closed. On iPhone/iPad: add Entryvex to your Home Screen (Share → Add to Home Screen), open it from there, then turn this on.</p>`}
      <div class="al-ntfy">
        <h4>📱 Or get them on your phone with the free ntfy app</h4>
        <p class="muted small">Works even when the browser option above doesn't (it doesn't use your browser's push service). No account needed.</p>
        ${ntfyEnabled()
          ? `<div class="al-row"><span class="pill pill-edge">Phone alerts on</span><button class="ghost-btn" id="al-ntfy-test">Send a test</button><button class="link-btn" id="al-ntfy-off">Turn off</button></div>
             <p class="muted tiny">Your private topic: <code class="mono">${fmt.esc(ntfyTopic())}</code></p>`
          : `<ol class="small al-steps">
              <li>Install <strong>ntfy</strong> from the <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener noreferrer">Google Play Store</a> or <a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener noreferrer">App Store</a>.</li>
              <li>In the app tap <strong>＋</strong> (Subscribe to topic) and enter exactly:<br><code class="mono al-topic">${fmt.esc(ntfyTopic())}</code> <button class="link-btn" id="al-ntfy-copy">Copy</button></li>
              <li>Then press: <button class="btn" id="al-ntfy-on">Connect my phone</button></li>
            </ol>`}
        <p class="muted tiny" id="al-ntfy-msg">${ntfyMsg || "Keep the topic private: anyone who knows it could see your alerts (symbols and prices only). Alerts are sent through ntfy.sh."}</p>
      </div>
    </section>

    <section>
      <h3>Setup alerts</h3>
      <label class="switch"><input type="checkbox" id="al-setup-on" ${cfg.setup.on ? "checked" : ""}/> Tell me when a setup with a positive track record appears on my watchlist</label>
      <div class="al-row">
        <label class="small muted">Candles <select id="al-setup-int">${Object.keys(MINUTES).map((k) => `<option ${k === cfg.setup.interval ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <label class="small muted">Alert on <select id="al-setup-min">
          <option value="go" ${cfg.setup.min === "go" ? "selected" : ""}>GO only (proven edge)</option>
          <option value="caution" ${cfg.setup.min === "caution" ? "selected" : ""}>GO + CAUTION (weak edge)</option></select></label>
      </div>
      <p class="muted small" id="alert-scan-status">${cfg.setup.on ? (lastScanText || "Checking your watchlist…") + " Re-checks after every candle closes." : "Off."}</p>
      <p class="muted tiny">GO alerts are rare by design: most setups don't beat fees and spread. Expect days with none.</p>
    </section>

    <section>
      <h3>Big move alerts</h3>
      <label class="switch"><input type="checkbox" id="al-move-on" ${cfg.move.on ? "checked" : ""}/> Tell me when a watchlist coin moves fast</label>
      <div class="al-row">
        <label class="small muted">Move of <input id="al-move-pct" type="number" min="0.2" max="50" step="0.1" value="${cfg.move.pct}" /> %</label>
        <label class="small muted">within <select id="al-move-min">${[5, 15, 30, 60].map((m) => `<option value="${m}" ${m === cfg.move.minutes ? "selected" : ""}>${m} min</option>`).join("")}</select></label>
      </div>
    </section>

    <section>
      <h3>Price alerts</h3>
      <form class="al-row al-price-form" id="al-price-form">
        <select id="al-p-sym">${wl.map((s) => `<option value="${s}" ${s === (keepSym || sel) ? "selected" : ""}>${fmt.esc(baseOf(s))}</option>`).join("")}</select>
        <select id="al-p-dir"><option value="above">goes above</option><option value="below">goes below</option></select>
        <input id="al-p-price" type="number" step="any" min="0" inputmode="decimal" placeholder="price" />
        <button class="btn" type="submit">Add</button>
      </form>
      <ul class="al-list">${priceAlerts.length ? priceAlerts.slice().reverse().map((a) => `
        <li class="${a.done ? "done" : ""}"><span><strong>${fmt.esc(baseOf(a.symbol))}</strong> ${a.dir} <span class="mono">${fmt.price(a.price)}</span>
          ${a.done ? `<span class="muted small"> · triggered ${fmt.ago(a.done)}</span>` : hooks.getPrice(a.symbol) ? `<span class="muted small"> · now ${fmt.price(hooks.getPrice(a.symbol))}</span>` : ""}</span>
          <button class="link-btn" data-del="${a.id}">Remove</button></li>`).join("") : `<li class="muted small">No price alerts yet.</li>`}</ul>
    </section>

    <section>
      <h3>Recent alerts ${history.length ? `<button class="link-btn" id="al-clear-hist">Clear</button>` : ""}</h3>
      <ul class="al-list">${history.length ? history.slice(0, 15).map((h) => `<li class="${h.unread ? "unread" : ""}${h.symbol ? " al-open" : ""}" ${h.symbol ? `data-hist-sym="${fmt.esc(h.symbol)}" data-hist-iv="${fmt.esc(h.interval || "")}" title="Open it"` : ""}><span>${h.unread ? '<span class="new-dot">NEW</span> ' : ""}<strong>${fmt.esc(h.title)}</strong><br><span class="muted small">${fmt.esc(h.body)} · ${fmt.ago(h.t)}</span></span>${h.symbol ? `<span class="al-go">Open ›</span>` : ""}</li>`).join("") : `<li class="muted small">Nothing yet.</li>`}</ul>
    </section>`;
}
