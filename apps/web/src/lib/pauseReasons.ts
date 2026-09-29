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
    inflight = apiGet<{ reasons: PauseReason[] }>("/api/admin/pause-reasons")
      .then((r) => {
        cache = Array.isArray(r?.reasons) ? r.reasons : [];
        return cache;
      })
      // CACHE THE FAILURE TOO. JobsTab is mounted for workers, and the
      // endpoint is admin-gated — without this every worker mount retried
      // the 403 forever. An empty list is correct for them: the pause
      // surfaces are admin-only, so nothing renders a label anyway.
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

export function usePauseReasons(): PauseReason[] {
  const [reasons, setReasons] = useState<PauseReason[]>(cache ?? []);
  useEffect(() => {
    let cancelled = false;
    void load().then((r) => { if (!cancelled) setReasons(r); });
    return () => { cancelled = true; };
  }, []);
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
