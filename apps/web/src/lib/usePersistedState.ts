import { useState, useEffect, useRef } from "react";

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
 * Reads initial value from localStorage on mount (client-side only); writes on every change.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T | (() => T),
): [T, (val: T | ((prev: T) => T)) => void] {
  const fullKey = PREFIX + key;

  const [value, setValueRaw] = useState<T>(() => {
    return typeof defaultValue === "function"
      ? (defaultValue as () => T)()
      : defaultValue;
  });

  // On client mount, re-read from localStorage in case SSR returned default
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    try {
      const stored = localStorage.getItem(fullKey);
      if (stored !== null) {
        const parsed = JSON.parse(stored) as T;
        if (JSON.stringify(parsed) !== JSON.stringify(value)) {
          setValueRaw(parsed);
        }
      }
    } catch {}
  }, []);

  // Write to localStorage on changes (skip the initial hydration write)
  const isFirstWrite = useRef(true);
  useEffect(() => {
    if (isFirstWrite.current) {
      isFirstWrite.current = false;
      return;
    }
    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch {}
  }, [fullKey, value]);

  return [value, setValueRaw];
}
