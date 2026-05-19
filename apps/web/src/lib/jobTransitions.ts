// Mirror of the server-side transition tables in
// apps/api/src/services/jobs.ts. Kept duplicated (not fetched) so dropdowns
// can filter in real time without a roundtrip. If the server tables ever
// change, update this file too — there's no auto-sync.
//
// Each table is shaped as: workflow → currentStatus → array of valid
// next statuses. Worker (VALID) is a strict subset of admin (ADMIN) —
// admins can do everything workers can plus a handful of reversals.

const VALID_TRANSITIONS: Record<string, Record<string, string[]>> = {
  STANDARD: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["CLOSED", "CANCELED"],
    CLOSED: ["ARCHIVED"],
  },
  ONE_OFF: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["CLOSED", "CANCELED"],
    CLOSED: ["ARCHIVED"],
  },
  ESTIMATE: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PROPOSAL_SUBMITTED", "CANCELED"],
    PROPOSAL_SUBMITTED: ["ACCEPTED", "REJECTED"],
    ACCEPTED: ["CLOSED"],
    REJECTED: ["CLOSED"],
    CLOSED: ["ARCHIVED"],
  },
  TASK: {
    SCHEDULED: ["CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "ARCHIVED"],
  },
  REMINDER: {
    SCHEDULED: ["CLOSED"],
    CLOSED: ["SCHEDULED"],
  },
};

const ADMIN_TRANSITIONS: Record<string, Record<string, string[]>> = {
  STANDARD: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["IN_PROGRESS", "SCHEDULED", "CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "PENDING_PAYMENT", "ARCHIVED"],
  },
  ONE_OFF: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["IN_PROGRESS", "SCHEDULED", "CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "PENDING_PAYMENT", "ARCHIVED"],
  },
  ESTIMATE: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["SCHEDULED", "PROPOSAL_SUBMITTED", "CANCELED"],
    PROPOSAL_SUBMITTED: ["IN_PROGRESS", "ACCEPTED", "REJECTED"],
    ACCEPTED: ["PROPOSAL_SUBMITTED", "CLOSED"],
    REJECTED: ["PROPOSAL_SUBMITTED", "CLOSED"],
    CLOSED: ["ACCEPTED", "ARCHIVED"],
  },
  TASK: {
    SCHEDULED: ["CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "ARCHIVED"],
    CANCELED: ["SCHEDULED"],
  },
  REMINDER: {
    SCHEDULED: ["CLOSED"],
    CLOSED: ["SCHEDULED"],
  },
};

/**
 * Returns the valid next-status options for an occurrence's status select,
 * including the current status itself (so the user can leave it unchanged).
 *
 * @param workflow  occurrence workflow ("STANDARD", "ONE_OFF", etc.)
 * @param fromStatus  the occurrence's CURRENT status (the one in the DB)
 * @param isAdmin  if true, includes admin-only reversal transitions
 */
export function validNextStatuses(
  workflow: string | null | undefined,
  fromStatus: string | null | undefined,
  isAdmin: boolean,
): string[] {
  if (!fromStatus) return [];
  const wf = (workflow ?? "STANDARD").toUpperCase();
  const table = isAdmin ? ADMIN_TRANSITIONS : VALID_TRANSITIONS;
  const targets = table[wf]?.[fromStatus] ?? [];
  // Always include the current status — picking the same value is a no-op
  // and shouldn't be disallowed by the dropdown.
  return targets.includes(fromStatus) ? targets : [fromStatus, ...targets];
}
