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
//   2. The Super "Reveal Pre-Cutoff" override. In-memory, NOT persisted —
//      a page reload always reverts to the filtered view. Toggling this
//      flips the X-Reveal-Pre-Cutoff header on every subsequent API call
//      AND refetches the cutoff (since the server's resolved cutoff
//      depends on whether the header is honored).
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

export function BusinessStartProvider({ children }: { children: ReactNode }) {
  const [cutoff, setCutoff] = useState<Date | null>(null);
  // Mirror the api.ts module-level reveal boolean into React state so
  // consumers re-render when it changes. The subscribe call below keeps
  // them in sync if reveal is flipped from outside React.
  const [reveal, setRevealState] = useState<boolean>(() => getRevealPreCutoff());

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

  const setReveal = useCallback(
    (v: boolean) => {
      setRevealPreCutoff(v);
      // Refetch — the server's resolved cutoff depends on the reveal header.
      void fetchCutoff();
    },
    [fetchCutoff],
  );

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
