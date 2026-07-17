// Shared "is this occurrence Overdue?" predicate. Called from every
// place that renders the Overdue chip / count so the rule stays in one
// spot — pages/index.tsx (title-bar alert), ServicesTab, JobsTab.
//
// Rule (in plain English):
//   Overdue = the occurrence's scheduled day has passed AND it hasn't
//   reached a "done" status yet AND (for PENDING_PAYMENT specifically)
//   the invoice pay link has expired.
//
// The PENDING_PAYMENT branch is the recent addition: as long as the
// client can still click and pay, we don't call it Overdue. Once the
// tokenized pay link ages past PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS (a
// server setting, default 72h), the client can no longer pay from
// their end and someone has to act — that's the Overdue moment.
//
// Sibling settings:
//   • PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS — drives THIS rule
//   • PAYMENT_REQUEST_STALE_DAYS       — drives the softer "1 stale"
//     highlighting on Awaiting Payment rows (unchanged by this rule)

import { apiGet } from "@/src/lib/api";
import { bizDateKey } from "@/src/lib/lib";

/** Fallback used when the setting isn't available (fresh install, offline,
 *  fetch failed). Matches DEFAULT_EXPIRY_HOURS on the backend so the two
 *  sides stay in lockstep when the operator hasn't overridden it. */
export const DEFAULT_PAYMENT_REQUEST_EXPIRY_HOURS = 72;

// Terminal statuses — an occurrence in any of these is done and cannot
// be Overdue, regardless of dates. Same set every existing overdue
// filter uses.
const DONE_STATUSES = new Set([
  "COMPLETED",
  "CLOSED",
  "ARCHIVED",
  "ACCEPTED",
  "REJECTED",
  "CANCELED",
]);

/** Minimal shape needed to evaluate the predicate. Every consumer of
 *  the Overdue chip already fetches these fields (they come back on
 *  /occurrences and admin variants). */
export type OverdueCandidate = {
  status: string;
  workflow?: string | null;
  startAt?: string | null;
  paymentRequestTokenCreatedAt?: string | null;
};

/** True when a PENDING_PAYMENT occurrence's pay link has expired.
 *  Returns FALSE when no link was ever sent (paymentRequestTokenCreatedAt
 *  is null) — a job with no invoice can't be "invoice-overdue" because
 *  there's no client-facing thing to time out. */
export function isPaymentLinkExpired(
  occ: OverdueCandidate,
  expiryHours: number,
  nowMs = Date.now(),
): boolean {
  if (occ.status !== "PENDING_PAYMENT") return false;
  const createdAt = occ.paymentRequestTokenCreatedAt;
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  const expiresAt = created + expiryHours * 3_600_000;
  return expiresAt < nowMs;
}

/** The full Overdue predicate. `todayKey` is the ET calendar day for
 *  "today" (YYYY-MM-DD) — pass in via bizDateKey so it stays
 *  DST/timezone-safe. `expiryHours` should come from the loaded
 *  PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS setting (or the default constant
 *  when unavailable). */
export function isOccurrenceOverdue(
  occ: OverdueCandidate,
  opts: { todayKey: string; expiryHours: number; nowMs?: number },
): boolean {
  // Announcements aren't work items — never Overdue.
  if (occ.workflow === "ANNOUNCEMENT") return false;
  if (!occ.startAt) return false;
  if (DONE_STATUSES.has(occ.status)) return false;
  const startKey = bizDateKey(occ.startAt);
  if (startKey >= opts.todayKey) return false;
  // PENDING_PAYMENT gets the pay-link-expired grace period. All other
  // non-done statuses (SCHEDULED, IN_PROGRESS, PAUSED,
  // PROPOSAL_SUBMITTED) fall through with just the "startAt is in the
  // past" rule, unchanged.
  if (occ.status === "PENDING_PAYMENT") {
    return isPaymentLinkExpired(occ, opts.expiryHours, opts.nowMs);
  }
  return true;
}

// Module-level cache — the setting value rarely changes and we don't
// want to fetch /api/settings three times on every re-render. First
// caller triggers the fetch; subsequent callers await the same promise.
// A fresh page load re-fetches (no persistence across reloads).
let cachedExpiryHours: number | null = null;
let inflight: Promise<number> | null = null;

/** Read PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS via /api/settings, cached.
 *  Falls back to DEFAULT_PAYMENT_REQUEST_EXPIRY_HOURS if the setting is
 *  missing / unparseable / offline. Callers can safely await this
 *  every render without spamming the network. */
export async function loadPaymentRequestExpiryHours(): Promise<number> {
  if (cachedExpiryHours != null) return cachedExpiryHours;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await apiGet<Array<{ key: string; value: string }>>("/api/settings");
      if (Array.isArray(rows)) {
        const row = rows.find((r) => r?.key === "PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS");
        const parsed = row?.value != null ? Number(row.value) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) {
          cachedExpiryHours = parsed;
          return parsed;
        }
      }
    } catch {
      // fall through to default
    }
    cachedExpiryHours = DEFAULT_PAYMENT_REQUEST_EXPIRY_HOURS;
    return DEFAULT_PAYMENT_REQUEST_EXPIRY_HOURS;
  })();
  return inflight;
}
