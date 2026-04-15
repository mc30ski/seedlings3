"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type OfflineState = {
  /** True when the browser has no network OR force-offline is enabled */
  isOffline: boolean;
  /** True when the user manually toggled force-offline */
  isForceOffline: boolean;
  /** Toggle force-offline mode */
  setForceOffline: (v: boolean) => void;
  /** Timestamp of last successful API sync */
  lastSyncedAt: Date | null;
  /** Update the last synced timestamp */
  markSynced: () => void;
};

const OfflineContext = createContext<OfflineState>({
  isOffline: false,
  isForceOffline: false,
  setForceOffline: () => {},
  lastSyncedAt: null,
  markSynced: () => {},
});

export function useOffline() {
  return useContext(OfflineContext);
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [browserOffline, setBrowserOffline] = useState(false);
  const [forceOffline, setForceOfflineRaw] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  // Read force-offline from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem("seedlings_forceOffline");
      if (stored === "true") setForceOfflineRaw(true);
    } catch {}
  }, []);

  // Listen to browser online/offline events
  useEffect(() => {
    setBrowserOffline(!navigator.onLine);
    const goOnline = () => setBrowserOffline(false);
    const goOffline = () => setBrowserOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  const setForceOffline = useCallback((v: boolean) => {
    setForceOfflineRaw(v);
    try { localStorage.setItem("seedlings_forceOffline", String(v)); } catch {}
  }, []);

  const markSynced = useCallback(() => {
    setLastSyncedAt(new Date());
  }, []);

  const isOffline = browserOffline || forceOffline;

  return (
    <OfflineContext.Provider value={{ isOffline, isForceOffline: forceOffline, setForceOffline, lastSyncedAt, markSynced }}>
      {children}
    </OfflineContext.Provider>
  );
}

// Register the service worker
export function registerServiceWorker() {
  if (typeof window === "undefined") return;
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("SW registration failed:", err);
      });
    });
  }
}
