"use client";

// The pause-reason taxonomy, shared by every surface that shows or filters
// a paused repeating service.
//
// Fetched once per mount and cached at module scope. The list is a Setting —
// it changes when an operator edits it, not while someone is looking at a
// job card — so refetching it per component would be a request per card.

import { useEffect, useState } from "react";
import { apiGet } from "@/src/lib/api";

export type PauseReason = {
  code: string;
  label: string;
  hint?: string;
  defaultReminderDays?: number | null;
};

let cache: PauseReason[] | null = null;
let inflight: Promise<PauseReason[]> | null = null;

async function load(): Promise<PauseReason[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = apiGet<{ reasons: PauseReason[] }>("/api/pause-reasons")
      .then((r) => {
        cache = Array.isArray(r?.reasons) ? r.reasons : [];
        return cache;
      })
      // CACHE THE FAILURE TOO, as a backstop. The caller now declines to
      // ask at all without `schedule.manage` (see `usePauseReasons`), so
      // this should no longer be reached from a worker mount — but a
      // cached empty list is still the right answer if it is, and retrying
      // a 403 forever was the original bug.
      .catch(() => { cache = []; return cache; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Drop the cache so an operator editing the taxonomy sees it without a
 *  full reload. Called from the settings surface that writes it. */
export function invalidatePauseReasons() {
  cache = null;
}

/**
 * The pause-reason taxonomy, or an empty list for somebody who may not read
 * it.
 *
 * `enabled` exists because `/api/pause-reasons` requires `schedule.manage`
 * and JobsTab mounts for every worker: asking unconditionally meant a 403
 * on the Jobs tab for every contractor and employee, once per session. The
 * caller passes `scope.can("schedule.manage")` — the same capability the
 * route checks — so the request is simply not made. An empty list was
 * already the correct answer for them; this stops paying a refusal for it.
 */
export function usePauseReasons(enabled = true): PauseReason[] {
  const [reasons, setReasons] = useState<PauseReason[]>(cache ?? []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void load().then((r) => { if (!cancelled) setReasons(r); });
    return () => { cancelled = true; };
  }, [enabled]);
  return reasons;
}

/** Label for a code, falling back to the raw key.
 *
 *  A retired or hand-edited code must still render as SOMETHING — showing
 *  nothing would make the reason disappear from a card that is definitely
 *  paused for a reason. */
export function pauseReasonLabel(
  code: string | null | undefined,
  reasons: PauseReason[],
): string | null {
  if (!code) return null;
  return reasons.find((r) => r.code === code)?.label ?? code;
}
