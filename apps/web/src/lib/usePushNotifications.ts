"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiDelete } from "./api";

const PUBLIC_VAPID_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

// Set when the user explicitly removes their subscription on this device, so
// the self-heal in _app.tsx doesn't silently recreate it on next mount. Cleared
// when the user re-subscribes. This distinguishes "iOS quietly invalidated"
// (auto-recover) from "user said no" (stay off).
const EXPLICITLY_DISABLED_KEY = "seedlings_pushExplicitlyDisabled";

function readExplicitlyDisabled(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(EXPLICITLY_DISABLED_KEY) === "1"; } catch { return false; }
}
function writeExplicitlyDisabled(v: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (v) localStorage.setItem(EXPLICITLY_DISABLED_KEY, "1");
    else localStorage.removeItem(EXPLICITLY_DISABLED_KEY);
  } catch {}
}

export type PushStatus =
  | "loading"
  | "unsupported"            // browser has no Push API at all
  | "needs-pwa-install"      // iOS Safari, not installed to Home Screen yet
  | "default"                // permission not yet asked
  | "granted-no-sub"         // permission granted but no active sub (rare; can re-subscribe)
  | "granted"                // permission granted + at least one active sub
  | "denied";                // user blocked at the browser/OS level

export type DeviceSubscription = {
  id: string;
  endpoint: string;
  userAgent?: string | null;
  label?: string | null;
  createdAt: string;
  lastUsedAt?: string | null;
};

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

function isStandalonePWA(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (window.navigator as any).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)")?.matches === true
  );
}

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function pushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function getReg(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export function usePushNotifications() {
  const [status, setStatus] = useState<PushStatus>("loading");
  const [devices, setDevices] = useState<DeviceSubscription[]>([]);
  const [busy, setBusy] = useState(false);
  const [explicitlyDisabled, setExplicitlyDisabled] = useState<boolean>(readExplicitlyDisabled);

  const refresh = useCallback(async () => {
    if (!pushSupported()) {
      setStatus("unsupported");
      return;
    }
    if (isIOS() && !isStandalonePWA()) {
      setStatus("needs-pwa-install");
      return;
    }
    const perm = Notification.permission;
    if (perm === "denied") {
      setStatus("denied");
      return;
    }
    const reg = await getReg();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (perm === "default") {
      setStatus("default");
    } else {
      setStatus(sub ? "granted" : "granted-no-sub");
    }
    try {
      const list = await apiGet<DeviceSubscription[]>("/api/me/push-subscriptions");
      setDevices(Array.isArray(list) ? list : []);
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const subscribe = useCallback(async (label?: string): Promise<{ ok: boolean; error?: string }> => {
    if (!pushSupported()) return { ok: false, error: "Push not supported" };
    if (!PUBLIC_VAPID_KEY) return { ok: false, error: "VAPID public key missing" };
    if (isIOS() && !isStandalonePWA()) return { ok: false, error: "Add to Home Screen first" };

    setBusy(true);
    try {
      // Notification.requestPermission must be called from a user gesture;
      // this hook is invoked from a button onClick so that's fine.
      let perm = Notification.permission;
      if (perm === "default") perm = await Notification.requestPermission();
      if (perm !== "granted") {
        await refresh();
        return { ok: false, error: perm === "denied" ? "Permission denied" : "Permission not granted" };
      }

      const reg = await getReg();
      if (!reg) return { ok: false, error: "Service worker not ready" };

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(PUBLIC_VAPID_KEY),
        });
      }

      const json: any = sub.toJSON();
      await apiPost("/api/me/push-subscriptions", {
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh,
        auth: json.keys?.auth,
        userAgent: navigator.userAgent,
        label: label ?? null,
      });

      // User has opted in — clear any prior explicit-disable flag so self-heal
      // resumes recovering invalidated subs on this device.
      writeExplicitlyDisabled(false);
      setExplicitlyDisabled(false);

      await refresh();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || "Failed to subscribe" };
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const unsubscribeThisDevice = useCallback(async (): Promise<{ ok: boolean }> => {
    setBusy(true);
    try {
      const reg = await getReg();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const endpoint = sub.endpoint;
        try { await sub.unsubscribe(); } catch {}
        // Match the local row by endpoint and DELETE on the server.
        const list = await apiGet<DeviceSubscription[]>("/api/me/push-subscriptions").catch(() => []);
        const row = (Array.isArray(list) ? list : []).find((d) => d.endpoint === endpoint);
        if (row) await apiDelete(`/api/me/push-subscriptions/${row.id}`).catch(() => {});
      }
      // User explicitly turned push off — block self-heal from recreating it.
      writeExplicitlyDisabled(true);
      setExplicitlyDisabled(true);
      await refresh();
      return { ok: true };
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const removeDevice = useCallback(async (id: string): Promise<{ ok: boolean }> => {
    setBusy(true);
    try {
      // If we're removing this device's own subscription, also tear it down locally.
      const reg = await getReg();
      const local = reg ? await reg.pushManager.getSubscription() : null;
      const localEndpoint = local?.endpoint;
      const target = devices.find((d) => d.id === id);
      const removingThisDevice = !!(target && localEndpoint && target.endpoint === localEndpoint && local);
      if (removingThisDevice && local) {
        try { await local.unsubscribe(); } catch {}
      }
      await apiDelete(`/api/me/push-subscriptions/${id}`).catch(() => {});
      // If the user removed THIS device, treat it as an explicit opt-out so
      // the self-heal in _app.tsx doesn't silently recreate it on next mount.
      if (removingThisDevice) {
        writeExplicitlyDisabled(true);
        setExplicitlyDisabled(true);
      }
      await refresh();
      return { ok: true };
    } finally {
      setBusy(false);
    }
  }, [devices, refresh]);

  return {
    status,
    devices,
    busy,
    explicitlyDisabled,
    refresh,
    subscribe,
    unsubscribeThisDevice,
    removeDevice,
  };
}

/**
 * Self-healing re-subscribe on PWA launch. Mount once at the app shell.
 * Idempotent: if the existing subscription is still valid, the upsert is a
 * no-op. If the browser silently invalidated it, this re-subscribes and
 * registers the new endpoint with the API.
 */
export async function refreshPushSubscription(): Promise<void> {
  if (!pushSupported()) return;
  if (!PUBLIC_VAPID_KEY) return;
  if (isIOS() && !isStandalonePWA()) return;
  if (Notification.permission !== "granted") return;
  // Respect explicit opt-out: don't auto-recreate a sub the user just removed.
  if (readExplicitlyDisabled()) return;

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(PUBLIC_VAPID_KEY),
      });
    }
    const json: any = sub.toJSON();
    await apiPost("/api/me/push-subscriptions", {
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
      userAgent: navigator.userAgent,
    });
  } catch (err) {
    console.warn("Push self-heal failed:", err);
  }
}
