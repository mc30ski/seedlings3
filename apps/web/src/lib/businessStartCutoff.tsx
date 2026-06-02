"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Business Start Date — client-side state.
//
// Two pieces of state share this module:
//
//   1. The EFFECTIVE cutoff for the current request, fetched from
//      /me/business-start. Null = filter off. Non-null = ISO date and the
//      UI should hide/adjust pre-cutoff money fields. The server already
//      filters its API responses; this is for UI surfaces that need to
//      render differently based on whether a filter applies (e.g. job
//      payment badges, Settings active-state indicator).
//
//   2. The Super "Reveal Pre-Cutoff" override. Session-only — a manual
//      page reload (F5, navigate-then-back) always reverts to the filtered
//      view. Toggling the reveal switch (via SettingsTab or the global
//      banner) triggers a full window.location.reload() so every open
//      view re-fetches its data with the new X-Reveal-Pre-Cutoff header
//      state — that's the simplest way to guarantee a consistent
//      post-toggle world without per-tab refetch wiring. A short-lived
//      sessionStorage key (`seedlings:bsdRevealPending`) carries the
//      intended state across that one reload; it's consumed on next mount.
//
// Safety: when `cutoff` is null (filter off / reveal active), the rest of
// the UI should be byte-identical to its pre-feature behavior. Treat the
// hook return as opt-in: if a UI surface doesn't check `cutoff`, it gets
// the same rows the API returned — no implicit hiding.
//
// See apps/api/src/lib/businessStartCutoff.ts for the server-side filter.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  apiGet,
  getRevealPreCutoff,
  setRevealPreCutoff,
  subscribeRevealPreCutoff,
} from "@/src/lib/api";

type CutoffResponse = { cutoff: string | null };

type Ctx = {
  /** Effective cutoff Date, or null when the filter is off. */
  cutoff: Date | null;
  /** True iff the Super reveal override is currently active. */
  reveal: boolean;
  /** Toggle the reveal override. Triggers a refetch of `cutoff`. */
  setReveal: (v: boolean) => void;
  /** Manually refetch the cutoff. Use after writing to BUSINESS_START_* settings. */
  refresh: () => Promise<void>;
};

const BusinessStartCtx = createContext<Ctx | null>(null);

// sessionStorage key used to carry the intended reveal state across the
// page reload that setReveal triggers. Consumed once on next mount, then
// deleted — preserves the "session-only" safety (manual F5 still reverts
// to the filtered view, only the reveal-triggered reload preserves it).
const REVEAL_PENDING_KEY = "seedlings:bsdRevealPending";

export function BusinessStartProvider({ children }: { children: ReactNode }) {
  const [cutoff, setCutoff] = useState<Date | null>(null);
  // Mirror the api.ts module-level reveal boolean into React state so
  // consumers re-render when it changes. The subscribe call below keeps
  // them in sync if reveal is flipped from outside React.
  //
  // On bootstrap, hydrate from sessionStorage if a setReveal-triggered
  // reload just landed us here. Done synchronously inside useState so the
  // X-Reveal-Pre-Cutoff header is set BEFORE the very first API call this
  // tree makes (e.g. /me/business-start below).
  const [reveal, setRevealState] = useState<boolean>(() => {
    if (typeof window === "undefined") return getRevealPreCutoff();
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(REVEAL_PENDING_KEY);
      if (pending != null) sessionStorage.removeItem(REVEAL_PENDING_KEY);
    } catch {
      /* sessionStorage unavailable — fall through to module flag */
    }
    if (pending === "1") {
      setRevealPreCutoff(true);
      return true;
    }
    if (pending === "0") {
      // Explicit OFF from a setReveal(false) reload — also clear any leftover
      // module-level flag from earlier in this same JS context (shouldn't
      // happen after a real reload, but cheap insurance).
      setRevealPreCutoff(false);
      return false;
    }
    return getRevealPreCutoff();
  });

  const fetchCutoff = useCallback(async () => {
    try {
      const res = await apiGet<CutoffResponse>("/me/business-start");
      setCutoff(res.cutoff ? new Date(res.cutoff) : null);
    } catch {
      // On any error, default to "no filter" so the UI doesn't pretend a
      // cutoff is active when we can't verify it. Server-side filtering is
      // independent, so this only affects display.
      setCutoff(null);
    }
  }, []);

  // Initial fetch.
  useEffect(() => {
    void fetchCutoff();
  }, [fetchCutoff]);

  // Keep React state in sync if reveal flips outside of this provider.
  useEffect(() => subscribeRevealPreCutoff(setRevealState), []);

  const setReveal = useCallback((v: boolean) => {
    // Persist the intended state across the reload, then hard-reload so
    // every open tab/view re-fetches its data with the new X-Reveal-Pre-Cutoff
    // header state. Reload is the bluntest fix but the most robust: it busts
    // all in-memory caches at once (HomeTab summary, Payments, Jobs, Stats,
    // Operations, Audit — any view derived from cutoff-affected endpoints),
    // so the operator sees a consistent post-toggle state without any
    // per-tab refetch wiring. sessionStorage keeps the intended state alive
    // for exactly one reload; manual F5 afterward still reverts to OFF, so
    // the "session-only" safety property is preserved.
    try {
      sessionStorage.setItem(REVEAL_PENDING_KEY, v ? "1" : "0");
    } catch {
      /* sessionStorage unavailable — fall back to in-process update */
      setRevealPreCutoff(v);
      void fetchCutoff();
      return;
    }
    if (typeof window !== "undefined") window.location.reload();
  }, [fetchCutoff]);

  const value = useMemo<Ctx>(
    () => ({ cutoff, reveal, setReveal, refresh: fetchCutoff }),
    [cutoff, reveal, setReveal, fetchCutoff],
  );

  return (
    <BusinessStartCtx.Provider value={value}>
      {children}
    </BusinessStartCtx.Provider>
  );
}

/**
 * Read the current effective cutoff + reveal state. Must be used inside
 * <BusinessStartProvider>. Returns `cutoff: null` when the filter is off,
 * which lets call sites treat the hook as opt-in (`if (cutoff)`...).
 */
export function useBusinessStartCutoff(): Ctx {
  const ctx = useContext(BusinessStartCtx);
  if (!ctx) {
    throw new Error(
      "useBusinessStartCutoff must be used inside <BusinessStartProvider>",
    );
  }
  return ctx;
}

/**
 * Returns true iff the given job/payment date is pre-cutoff AND the filter
 * is currently active. UI surfaces use this to show "—" for payment-related
 * fields on pre-cutoff jobs (the API returns null `payment` for those, but
 * a closed job with null payment shouldn't look like an unpaid one).
 */
export function useIsPreCutoff(d: Date | string | null | undefined): boolean {
  const { cutoff } = useBusinessStartCutoff();
  if (!cutoff || !d) return false;
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return false;
  return dt < cutoff;
}
