import { useState, useCallback, useEffect } from "react";

const PREFIX = "seedlings_";

/**
 * useState wrapper that persists to localStorage.
 * Reads initial value from localStorage on mount; writes on every change.
 */
export function usePersistedState<T>(
  key: string,
  defaultValue: T | (() => T),
): [T, (val: T | ((prev: T) => T)) => void] {
  const fullKey = PREFIX + key;

  const [value, setValueRaw] = useState<T>(() => {
    const fallback = typeof defaultValue === "function"
      ? (defaultValue as () => T)()
      : defaultValue;
    if (typeof window === "undefined") return fallback;
    try {
      const stored = localStorage.getItem(fullKey);
      if (stored === null) return fallback;
      return JSON.parse(stored) as T;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch {
      // quota exceeded or similar — ignore
    }
  }, [fullKey, value]);

  return [value, setValueRaw];
}
