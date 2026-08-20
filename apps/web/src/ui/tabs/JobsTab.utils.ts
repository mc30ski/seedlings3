// ─────────────────────────────────────────────────────────────────────────────
// JobsTab.utils — pure occurrence helpers extracted out of the
// JobsTab body so the main file focuses on stateful UI. Zero React,
// zero side effects, no closure captures — safe to import from any
// child renderer (cards, filters, dialogs).
// ─────────────────────────────────────────────────────────────────────────────

import { fmtDateOpts } from "@/src/lib/lib";
import { JOB_KIND, JOB_OCCURRENCE_STATUS } from "@/src/lib/types";

/** Human-friendly duration ("1h 24m" / "36m"). */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Elapsed job minutes, paused-time subtracted. Null when not started.
 *  Clamped to 0 so invalid timestamps (completedAt before startedAt)
 *  don't render negatives — matches the backend Hours-this-week clamp. */
export function effectiveMinutes(occ: {
  startedAt?: string | null;
  completedAt?: string | null;
  pausedAt?: string | null;
  totalPausedMs?: number | null;
  status?: string;
}): number | null {
  if (!occ.startedAt) return null;
  const startMs = new Date(occ.startedAt).getTime();
  const paused = occ.totalPausedMs ?? 0;
  let endMs: number;
  if (occ.status === "PAUSED" && occ.pausedAt) endMs = new Date(occ.pausedAt).getTime();
  else if (occ.completedAt) endMs = new Date(occ.completedAt).getTime();
  else endMs = Date.now();
  return Math.max(0, (endMs - startMs - paused) / 60000);
}

/** Sort order used to display assignees consistently: claimer first,
 *  active assignees next, observers last. */
export function assigneeSortOrder(a: { assignedById?: string | null; userId: string; role?: string | null }): number {
  const isClaimer = a.assignedById === a.userId && a.role !== "observer";
  if (isClaimer) return 0;
  if (a.role === "observer") return 2;
  return 1;
}

/** Sum of add-on prices on the occurrence (0 when none). */
export function addonTotal(occ: any): number {
  return (occ.addons ?? []).reduce((s: number, a: any) => s + (a.price ?? 0), 0);
}

/** Whether the claimer can still edit billables (expenses, add-ons).
 *  Full edit through completion + PENDING_PAYMENT-before-committed;
 *  locks when a payment is sent or recorded. CLOSED / terminal always
 *  frozen (admin edits those via Services tab). */
export function occInEditableState(occ: any): boolean {
  switch (occ?.status) {
    case "SCHEDULED":
    case "IN_PROGRESS":
    case "PAUSED":
    case "COMPLETED":
      return true;
    case "PENDING_PAYMENT":
      return !occ.payment && !occ.paymentRequestSentAt;
    default:
      return false;
  }
}

/** Occurrence total = base price (or proposal) + add-ons. Null when
 *  base is unpriced and there are no add-ons. */
export function totalPrice(occ: any): number | null {
  const base = (occ.price || null) ?? (occ.proposalAmount || null);
  if (base == null) return addonTotal(occ) > 0 ? addonTotal(occ) : null;
  return base + addonTotal(occ);
}

/** Robust jobTags reader — accepts already-parsed arrays or JSON
 *  strings, returns [] on either absent or malformed. */
export function parseJobTags(occ: any): string[] {
  if (!occ.jobTags) return [];
  if (Array.isArray(occ.jobTags)) return occ.jobTags;
  try { return JSON.parse(occ.jobTags); } catch { return []; }
}

/** Preset quick-contact message keyed off occurrence state. Currently
 *  covers two flows — request confirmation (SCHEDULED + unconfirmed)
 *  and request payment (PENDING_PAYMENT). Returns null otherwise. */
export function getQuickMessage(occ: any, contactName: string | null): { label: string; body: string } | null {
  const name = contactName ?? "there";
  const dateStr = occ.startAt
    ? fmtDateOpts(occ.startAt, { weekday: "long", month: "long", day: "numeric" })
    : "your upcoming appointment";
  const prop = occ.job?.property;
  const addressStr = [prop?.street1, prop?.city, prop?.state].filter(Boolean).join(", ");
  const atAddress = addressStr ? ` at ${addressStr}` : "";
  // Confirmation request also fires for unclaimed rows — admins
  // regularly request confirmation on the client's behalf, and the
  // copy is claim-agnostic ("we have your appointment scheduled").
  if (occ.status === "SCHEDULED" && occ.jobId && !(occ as any).isClientConfirmed) {
    return {
      label: "Request Confirmation",
      body: `Hi ${name}, this is Seedlings Lawn Care. We have your lawn service scheduled for ${dateStr}${atAddress}. Could you please confirm this works for you? Or let us know if you need to reschedule.`,
    };
  }
  if (occ.status === "PENDING_PAYMENT") {
    const amount = totalPrice(occ);
    const amountStr = amount != null ? ` of $${amount.toFixed(2)}` : "";
    return {
      label: "Request Payment",
      body: `Hi ${name}, this is Seedlings Lawn Care. Your lawn service on ${dateStr}${atAddress} has been completed. A payment${amountStr} is due at your earliest convenience. Please let us know if you have any questions. Thank you!`,
    };
  }
  return null;
}

// ─── Constants ────────────────────────────────────────────────────────────
/** Status filter dropdown states. Includes ARCHIVED, CANCELED, and
 *  the synthetic PAUSED_REPEATING pseudo-status (previously exposed
 *  as separate icon toggles). Callers handle those three by wiring
 *  their state flags (showCanceled / showArchived / pausedRepeating
 *  Only) off the current dropdown selection. */
export const statusStates = [
  "ALL",
  "UNCLAIMED",
  "UNCONFIRMED",
  ...JOB_OCCURRENCE_STATUS.filter((s) => s !== "ARCHIVED" && s !== "CANCELED"),
  "CANCELED",
  "ARCHIVED",
  "PAUSED_REPEATING",
] as const;

/** Preset date range chips. */
export const quickDateItemsBase = [
  { label: "Now", value: "now" },
  { label: "Tomorrow", value: "tomorrow" },
  { label: "This week", value: "thisWeek" },
  { label: "This month", value: "thisMonth" },
  { label: "Yesterday", value: "yesterday" },
  { label: "Last week", value: "lastWeek" },
  { label: "Last month", value: "lastMonth" },
];

/** Job kind filter states (includes ALL sentinel). */
export const kindStates = ["ALL", ...JOB_KIND] as const;

// ─── Card density ─────────────────────────────────────────────────────────
/** Three visual density levels: ultra (single-row scan), semi (default
 *  compact card), expanded (full detail). Click on a card cycles it
 *  through the modes independently of the global setting. */
export type CardDensity = "ultra" | "semi" | "expanded";

/** Cycle order matches the segmented toggle (left→right). */
export const CARD_DENSITY_CYCLE: CardDensity[] = ["ultra", "semi", "expanded"];

/** Next density in the cycle. */
export function nextDensity(m: CardDensity): CardDensity {
  const i = CARD_DENSITY_CYCLE.indexOf(m);
  return CARD_DENSITY_CYCLE[(i + 1) % CARD_DENSITY_CYCLE.length];
}
