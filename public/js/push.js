// Closed-app alerts (browser side): subscribe this browser to push notifications and keep the
// server's copy of your alert settings up to date. Stored on the server: an anonymous push address
// and the alert settings below. No name, email or account.
const store = {
  get(k, d) { try { const v = localStorage.getItem("evx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evx." + k, JSON.stringify(v)); } catch {} },
};
let hooks = { buildPrefs: () => ({}) };
let syncTimer = null;

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && location.protocol === "https:";
export const pushEnabled = () => !!store.get("pushOn", false);

function browserId() {
  let id = store.get("pushId", null);
  if (!id) {
    const b = crypto.getRandomValues(new Uint8Array(18));
    id = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    store.set("pushId", id);
  }
  return id;
}
const keyBytes = (b64) => {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

export function initPush(h) {
  hooks = { ...hooks, ...h };
  if (pushEnabled()) scheduleSync(2000);   // refresh the server copy on every visit
}

/** Turn closed-app alerts on: ask permission, subscribe, and send settings. Returns a status message. */
/** Rejects with `msg` if `p` doesn't finish within `ms` (browsers can leave some of these steps waiting forever). */
const within = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { friendly: true })), ms))]);
const isBrave = async () => { try { return !!(navigator.brave && await navigator.brave.isBrave()); } catch { return false; } };

export async function enablePush(onStep = () => {}) {
  if (!pushSupported()) return { ok: false, msg: "This browser can't receive alerts while closed. On iPhone/iPad, first add Entryvex to your Home Screen (Share → Add to Home Screen) and open it from there." };
  try {
    // 1. Permission. Chrome and Edge sometimes show this quietly as a small bell/crossed-bell icon in the address bar.
    let perm = Notification.permission;
    if (perm === "default") {
      onStep("Your browser is asking for permission: click Allow. (No popup? Look for a 🔔 icon at the left or right end of the address bar.)");
      perm = await within(Notification.requestPermission(), 45_000,
        "No answer to the notification permission request. Click the 🔔 or ⓘ / lock icon in the address bar, set Notifications to Allow, then press the button again.");
    }
    if (perm !== "granted") return { ok: false, msg: "Notifications are blocked for entryvex.trade. Click the lock / ⓘ icon in the address bar → Site settings → Notifications → Allow, reload the page, then try again." };

    // 2. The background helper that receives notifications.
    onStep("Starting the background helper…");
    const reg = await within(navigator.serviceWorker.register("/sw.js"), 15_000, "The background helper didn't start. Reload the page and try again.");
    await within(navigator.serviceWorker.ready, 15_000, "The background helper didn't start. Reload the page and try again.");

    // 3. A push address from the browser's push service.
    onStep("Getting a notification address from your browser… (up to 30 seconds)");
    const { publicKey } = await within(fetch("/api/push/key").then((r) => r.json()), 15_000, "Couldn't reach the alert server. Try again in a minute.");
    const brave = await isBrave();
    const edge = /Edg\//.test(navigator.userAgent);
    const noAnswer = brave
      ? "Brave blocks this by default. Open brave://settings/privacy, turn on “Use Google services for push messaging”, restart Brave, then try again."
      : `Your browser's push service (${edge ? "Microsoft's" : "Google's"}) didn't answer, so the browser can't get a notification address. Common causes: `
        + `an ad-blocker or network filter (Pi-hole, AdGuard, router or company firewall) blocking ${edge ? "Microsoft's notification servers (*.notify.windows.com)" : "Google's push servers (fcm.googleapis.com, mtalk.google.com)"}, `
        + `a VPN, or notifications turned off for the browser in Windows (Settings → System → Notifications). Fix that and try again${edge ? "" : ", or try Microsoft Edge, which uses a different push service"}. `
        + "Alerts still work as normal while Entryvex is open.";
    let sub = await within(reg.pushManager.getSubscription(), 10_000, noAnswer);
    if (!sub) sub = await within(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }), 20_000, noAnswer);

    // 4. Send the settings to Entryvex's alert server.
    onStep("Saving your alert settings…");
    store.set("pushOn", true);
    const ok = await within(sync(sub), 15_000, "Couldn't reach the alert server. Try again in a minute.");
    return ok ? { ok: true, msg: "On. Entryvex checks every 5 minutes and notifies this device even when the site is closed. Press “Send a test” to check." }
      : { ok: false, msg: "Couldn't reach the alert server. Try again in a minute." };
  } catch (e) {
    if (e.friendly) return { ok: false, msg: e.message };
    const brave = await isBrave();
    if (e.name === "AbortError" || /push service/i.test(e.message || ""))
      return { ok: false, msg: brave ? "Brave blocks this by default. Open brave://settings/privacy, turn on “Use Google services for push messaging”, restart Brave, then try again."
        : "Your browser's push service refused the request. Try Chrome or Edge, or check that your browser is allowed to show notifications in Windows settings." };
    if (e.name === "NotAllowedError") return { ok: false, msg: "Notifications are blocked for entryvex.trade. Allow them in the site settings (lock / ⓘ icon in the address bar), then try again." };
    return { ok: false, msg: `Couldn't turn on closed-app alerts: ${e.message || e.name}.` };
  }
}

export async function disablePush() {
  store.set("pushOn", false);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {}
  await fetch("/api/push/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: browserId() }) }).catch(() => {});
}

export async function testPush() {
  const r = await fetch("/api/push/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: browserId() }) });
  return r.ok;
}

/** Settings changed: send the new copy to the server shortly (debounced). */
export function scheduleSync(delay = 3000) {
  if (!pushEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync().catch(() => {}), delay);
}

async function sync(sub) {
  if (!sub) {
    const reg = await navigator.serviceWorker.getRegistration();
    sub = await reg?.pushManager.getSubscription();
    if (!sub) { store.set("pushOn", false); return false; }
  }
  const res = await fetch("/api/push/sync", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: browserId(), subscription: sub.toJSON(), prefs: hooks.buildPrefs() }),
  });
  return res.ok;
}
