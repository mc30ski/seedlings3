"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { processQueue, getPendingCount, getFailedCount, getSyncingCount, subscribeQueue } from "./offlineQueue";

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
  /** Number of pending + failed queued actions */
  queueCount: number;
};

const OfflineContext = createContext<OfflineState>({
  isOffline: false,
  isForceOffline: false,
  setForceOffline: () => {},
  lastSyncedAt: null,
  markSynced: () => {},
  queueCount: 0,
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

  // Queue count — lingers for 3s after reaching 0 so the user can see it
  const [realQueueCount, setRealQueueCount] = useState(0);
  const [queueCount, setQueueCount] = useState(0);
  const lingerTimerRef = useRef<NodeJS.Timeout | null>(null);
  const prevOfflineRef = useRef(isOffline);

  useEffect(() => {
    const refresh = () => {
      Promise.all([getPendingCount(), getFailedCount(), getSyncingCount()])
        .then(([p, f, s]) => {
          const count = p + f + s;
          setRealQueueCount(count);
          if (count > 0) {
            // Has items — show immediately, clear any linger timer
            if (lingerTimerRef.current) { clearTimeout(lingerTimerRef.current); lingerTimerRef.current = null; }
            setQueueCount(count);
          } else {
            // Dropped to 0 — linger for 3s before hiding
            if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
            lingerTimerRef.current = setTimeout(() => {
              setQueueCount(0);
              lingerTimerRef.current = null;
            }, 3000);
          }
        })
        .catch(() => {});
    };
    refresh();
    return subscribeQueue(refresh);
  }, []);

  // Auto-process queue when coming back online
  useEffect(() => {
    if (prevOfflineRef.current && !isOffline) {
      // Just came online — process queue
      processQueue().then((result) => {
        if (result.synced > 0 || result.failed > 0) {
          setLastSyncedAt(new Date());
          window.dispatchEvent(new CustomEvent("offlineQueue:processed", { detail: result }));
        }
      }).catch(() => {});
    }
    prevOfflineRef.current = isOffline;
  }, [isOffline]);

  return (
    <OfflineContext.Provider value={{ isOffline, isForceOffline: forceOffline, setForceOffline, lastSyncedAt, markSynced, queueCount }}>
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
