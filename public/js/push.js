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
export async function enablePush() {
  if (!pushSupported()) return { ok: false, msg: "This browser can't receive alerts while closed. On iPhone/iPad, first add Entryvex to your Home Screen (Share → Add to Home Screen) and open it from there." };
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, msg: "Notifications are blocked for entryvex.trade. Allow them in your browser's site settings, then try again." };
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { publicKey } = await (await fetch("/api/push/key")).json();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  store.set("pushOn", true);
  const ok = await sync(sub);
  return ok ? { ok: true, msg: "On. Entryvex checks every 5 minutes and notifies this device even when the site is closed." } : { ok: false, msg: "Couldn't reach the alert server. Try again in a minute." };
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
