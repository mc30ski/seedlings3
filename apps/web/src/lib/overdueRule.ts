// Shared "is this occurrence Overdue?" predicate. Called from every
// place that renders the Overdue chip / count so the rule stays in one
// spot — pages/index.tsx (title-bar alert), ServicesTab, JobsTab.
//
// Rule (in plain English):
//   Job Overdue = the occurrence's scheduled day has passed AND it hasn't
//   reached a "done" status yet.
//
// PENDING_PAYMENT used to be included, gated on the invoice pay link
// having expired. It is now never overdue: the work was finished, and a
// visit waiting on money is already carried by the payment alerts. The
// rename to "Job Overdue" followed from that — this alert means a job
// that did not get finished on time, nothing else.
//
// `isPaymentLinkExpired` stays exported: ServicesTab still uses it for the
// separate awaiting-payment surfaces.
//
// Sibling settings:
//   • PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS — drives THIS rule
//   • PAYMENT_REQUEST_STALE_DAYS       — drives the softer "1 stale"
//     highlighting on Awaiting Payment rows (unchanged by this rule)

import { apiGet } from "@/src/lib/api";
import { bizDateKey } from "@/src/lib/dates";

/** Fallback used when the setting isn't available (fresh install, offline,
 *  fetch failed). Matches DEFAULT_EXPIRY_HOURS on the backend so the two
 *  sides stay in lockstep when the operator hasn't overridden it. */
export const DEFAULT_PAYMENT_REQUEST_EXPIRY_HOURS = 72;

// Statuses that are never Overdue regardless of dates. Two flavors:
//   1. Terminal/done — the work is finished or explicitly closed out.
//   2. Held on purpose — STREAM_PAUSED means the operator paused the
//      recurring stream (typically because the client asked us to hold
//      off). Nothing about that is "overdue"; we're honoring a hold.
const NEVER_OVERDUE_STATUSES = new Set([
  "COMPLETED",
  "CLOSED",
  "ARCHIVED",
  "ACCEPTED",
  "REJECTED",
  "CANCELED",
  // Held-on-purpose — see comment above.
  "STREAM_PAUSED",
  // A visit waiting on money is a PAYMENT problem, not late WORK. The job
  // itself got done. It is already carried by "Payments to review" /
  // "Awaiting client payment", and counting it here too was the last
  // double-count in this alert. This is also why the filter is now called
  // "Job Overdue" — it means a job that did not get finished on time, and a
  // finished-but-unpaid visit is not that.
  "PENDING_PAYMENT",
]);

/** Minimal shape needed to evaluate the predicate. Every consumer of
 *  the Overdue chip already fetches these fields (they come back on
 *  /occurrences and admin variants). */
export type OverdueCandidate = {
  status: string;
  workflow?: string | null;
  startAt?: string | null;
  paymentRequestTokenCreatedAt?: string | null;
  /** Set on synthesized "next visit not scheduled" cards. NOT work — see
   *  the exclusion in isOccurrenceOverdue. */
  _isNextOccurrenceGhost?: boolean;
  /** Set on rows borrowed from another system (Timeline activities,
   *  document expirations) that are merged into the job feed. */
  _foreignKind?: string | null;
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
/**
 * WHICH KIND of overdue this row is, or null when it isn't overdue at all.
 *
 * Two alerts, one rule. They differ only in workflow:
 *
 *   "job"      — STANDARD / ONE_OFF / ESTIMATE (and legacy null). Work at a
 *                property that did not get finished on time. This is the
 *                "Job Overdue" alert.
 *   "activity" — TASK / REMINDER / FOLLOWUP / EVENT. Things the business owes
 *                itself. Late in a real sense, but a different queue and a
 *                different fix, so a separate "Activities Overdue" alert.
 *
 * ANNOUNCEMENT is in neither set and so is never overdue — it falls out of
 * the classification rather than needing its own special case.
 *
 * There is deliberately no exported "is it overdue at all" helper. Every
 * caller has to say which queue it is asking about; a permissive default is
 * how the two alerts would silently start counting each other's rows.
 */
export type OverdueKind = "job" | "activity";

/** Legacy rows predate `workflow` and are ordinary visits. */
const JOB_WORKFLOWS = new Set(["STANDARD", "ONE_OFF", "ESTIMATE"]);
const ACTIVITY_WORKFLOWS = new Set(["TASK", "REMINDER", "FOLLOWUP", "EVENT"]);

export function overdueKind(
  occ: OverdueCandidate,
  opts: { todayKey: string; expiryHours: number; nowMs?: number },
): OverdueKind | null {
  if (!isLate(occ, opts)) return null;
  const w = occ.workflow ?? "";
  if (!w || JOB_WORKFLOWS.has(w)) return "job";
  if (ACTIVITY_WORKFLOWS.has(w)) return "activity";
  return null;
}

/** "Job Overdue" — a visit or estimate that did not get finished on time. */
export function isJobOverdue(
  occ: OverdueCandidate,
  opts: { todayKey: string; expiryHours: number; nowMs?: number },
): boolean {
  return overdueKind(occ, opts) === "job";
}

/** "Activities Overdue" — a task, reminder, follow-up or timeline event
 *  whose date has passed. */
export function isActivityOverdue(
  occ: OverdueCandidate,
  opts: { todayKey: string; expiryHours: number; nowMs?: number },
): boolean {
  return overdueKind(occ, opts) === "activity";
}

/** Shared "is this row late and unfinished", before the workflow split.
 *  Not exported — see the note on overdueKind. */
function isLate(
  occ: OverdueCandidate,
  opts: { todayKey: string; expiryHours: number; nowMs?: number },
): boolean {
  // (ANNOUNCEMENT needs no case here — it is in neither workflow set, so
  // overdueKind classifies it as null.)

  // THINGS THAT HAVE THEIR OWN ALERT ARE NOT ALSO OVERDUE. Every exclusion
  // below is a row that already reports itself somewhere else in the alerts
  // dropdown; counting it here too means one situation, two numbers, and an
  // operator who can't tell whether they have one problem or two.
  //
  // A next-visit ghost is the clearest case. It is not a visit that ran
  // late — it is a placeholder for a visit that was never created, and it
  // is already counted by "Next visits expired". It carries
  // `status: "SCHEDULED"` and a startAt of the day it was due, which is
  // exactly the shape this predicate otherwise calls overdue, so it has to
  // be excluded explicitly.
  if (occ._isNextOccurrenceGhost) return false;

  // Timeline activities and document expirations, merged into the job feed
  // from elsewhere. They carry their own "overdue N days" badge and their
  // own "Timeline" alert.
  if (occ._foreignKind) return false;
  if (!occ.startAt) return false;
  if (NEVER_OVERDUE_STATUSES.has(occ.status)) return false;
  const startKey = bizDateKey(occ.startAt);
  if (startKey >= opts.todayKey) return false;
  // Everything left (SCHEDULED, IN_PROGRESS, PAUSED, PROPOSAL_SUBMITTED)
  // is work whose day has passed and which nobody finished.
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
