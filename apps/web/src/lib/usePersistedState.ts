import { useState, useEffect } from "react";

const PREFIX = "seedlings_";

/** Clear all seedlings localStorage entries — call on sign-out */
export function clearAllPersistedState() {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keysToRemove.push(key);
    }
    for (const key of keysToRemove) localStorage.removeItem(key);
  } catch {}
}

/**
 * useState wrapper that persists to localStorage.
 * Reads from localStorage in the useState initializer so the first render
 * already has the correct value — no hydration re-render flicker.
 *
 * SSR-safe: returns the default value when window is undefined. The persisted-
 * state-dependent UI in this app is gated behind a client-side `mounted` flag,
 * so SSR never renders any value-dependent markup.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T | (() => T),
): [T, (val: T | ((prev: T) => T)) => void] {
  const fullKey = PREFIX + key;

  const [value, setValueRaw] = useState<T>(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = localStorage.getItem(fullKey);
        if (stored !== null) return JSON.parse(stored) as T;
      } catch {}
    }
    return typeof defaultValue === "function" ? (defaultValue as () => T)() : defaultValue;
  });

  // Write on changes. We don't track an "isFirst" flag because the initial
  // value already matches localStorage (it was just read from there) — writing
  // the same value back is a no-op for our purposes.
  useEffect(() => {
    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch {}
  }, [fullKey, value]);

  return [value, setValueRaw];
}
