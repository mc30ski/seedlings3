import { AuditScope, AuditVerb } from "@prisma/client";

export const AUDIT = {
  USER: {
    APPROVED: [AuditScope.USER, AuditVerb.APPROVED] as const,
    ROLE_ASSIGNED: [AuditScope.USER, AuditVerb.ROLE_ASSIGNED] as const,
    ROLE_REMOVED: [AuditScope.USER, AuditVerb.ROLE_REMOVED] as const,
    DELETED: [AuditScope.USER, AuditVerb.DELETED] as const,
    WORKER_TYPE_SET: [AuditScope.USER, AuditVerb.WORKER_TYPE_SET] as const,
    INSURANCE_UPLOADED: [AuditScope.USER, AuditVerb.INSURANCE_UPLOADED] as const,
    CONTRACTOR_AGREED: [AuditScope.USER, AuditVerb.CONTRACTOR_AGREED] as const,
    W9_COLLECTED: [AuditScope.USER, AuditVerb.W9_COLLECTED] as const,
    GUARANTEED_PAYOUT_STARTED: [AuditScope.USER, AuditVerb.GUARANTEED_PAYOUT_STARTED] as const,
    GUARANTEED_PAYOUT_ENDED: [AuditScope.USER, AuditVerb.GUARANTEED_PAYOUT_ENDED] as const,
    SIGN_IN: [AuditScope.USER, AuditVerb.SIGN_IN] as const,
    // Reusing UPDATED for privilege flips — the metadata payload carries
    // which privilege changed and to what. Keeps schema enums small.
    PRIVILEGES_UPDATED: [AuditScope.USER, AuditVerb.UPDATED] as const,
    PAYMENT_COMMS_MODE_UPDATED: [AuditScope.USER, AuditVerb.UPDATED] as const,
    OWNER_FLAG_UPDATED: [AuditScope.USER, AuditVerb.UPDATED] as const,
  },
  EQUIPMENT: {
    CREATED: [AuditScope.EQUIPMENT, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.EQUIPMENT, AuditVerb.UPDATED] as const,
    RETIRED: [AuditScope.EQUIPMENT, AuditVerb.RETIRED] as const,
    UNRETIRED: [AuditScope.EQUIPMENT, AuditVerb.UNRETIRED] as const,
    DELETED: [AuditScope.EQUIPMENT, AuditVerb.DELETED] as const,
    CHECKED_OUT: [AuditScope.EQUIPMENT, AuditVerb.CHECKED_OUT] as const,
    RELEASED: [AuditScope.EQUIPMENT, AuditVerb.RELEASED] as const,
    MAINTENANCE_START: [
      AuditScope.EQUIPMENT,
      AuditVerb.MAINTENANCE_START,
    ] as const,
    MAINTENANCE_END: [AuditScope.EQUIPMENT, AuditVerb.MAINTENANCE_END] as const,
    RESERVED: [AuditScope.EQUIPMENT, AuditVerb.RESERVED] as const,
    RESERVATION_CANCELLED: [
      AuditScope.EQUIPMENT,
      AuditVerb.RESERVATION_CANCELLED,
    ] as const,
    RETURNED: [AuditScope.EQUIPMENT, AuditVerb.RETURNED] as const,
    FORCE_RELEASED: [AuditScope.EQUIPMENT, AuditVerb.FORCE_RELEASED] as const,
  },
  CLIENT: {
    CREATED: [AuditScope.CLIENT, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.CLIENT, AuditVerb.UPDATED] as const,
    PAUSED: [AuditScope.CLIENT, AuditVerb.UPDATED] as const,
    UNPAUSED: [AuditScope.CLIENT, AuditVerb.UPDATED] as const,
    ARCHIVED: [AuditScope.CLIENT, AuditVerb.RETIRED] as const,
    UNARCHIVED: [AuditScope.CLIENT, AuditVerb.UNRETIRED] as const,
    DELETED: [AuditScope.CLIENT, AuditVerb.DELETED] as const,

    CONTACT_CREATED: [AuditScope.CLIENT, AuditVerb.CREATED] as const,
    CONTACT_UPDATED: [AuditScope.CLIENT, AuditVerb.UPDATED] as const,
    CONTACT_PAUSED: [AuditScope.CLIENT, AuditVerb.UPDATED] as const,
    CONTACT_UNPAUSED: [AuditScope.CLIENT, AuditVerb.UPDATED] as const,
    CONTACT_ARCHIVED: [AuditScope.CLIENT, AuditVerb.RETIRED] as const, // using RETIRED to mean archived
    CONTACT_UNARCHIVED: [AuditScope.CLIENT, AuditVerb.UNRETIRED] as const,
    CONTACT_DELETED: [AuditScope.CLIENT, AuditVerb.DELETED] as const,
    CONTACT_LINKED: [AuditScope.CLIENT, AuditVerb.UPDATED] as const,
    CONTACT_UNLINKED: [AuditScope.CLIENT, AuditVerb.UPDATED] as const,
  },
  PROPERTY: {
    CREATED: [AuditScope.PROPERTY, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.PROPERTY, AuditVerb.UPDATED] as const,
    ARCHIVED: [AuditScope.PROPERTY, AuditVerb.RETIRED] as const, // using RETIRED to mean archived
    UNARCHIVED: [AuditScope.PROPERTY, AuditVerb.UNRETIRED] as const,
    DELETED: [AuditScope.PROPERTY, AuditVerb.DELETED] as const,
    PRIMARY_CONTACT_SET: [
      AuditScope.PROPERTY,
      AuditVerb.PRIMARY_CONTACT_SET,
    ] as const,
  },
  JOB: {
    CREATED: [AuditScope.JOB, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
    ARCHIVED: [AuditScope.JOB, AuditVerb.RETIRED] as const,
    // schedule/occurrence/assignees can be treated as UPDATED for now
    SCHEDULE_UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
    OCCURRENCE_CREATED: [AuditScope.JOB, AuditVerb.CREATED] as const,
    OCCURRENCE_UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
    OCCURRENCE_ARCHIVED: [AuditScope.JOB, AuditVerb.RETIRED] as const,
    OCCURRENCES_GENERATED: [AuditScope.JOB, AuditVerb.CREATED] as const,
    ASSIGNEES_UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
  },
  SETTING: {
    UPDATED: [AuditScope.SETTING, AuditVerb.SETTING_UPDATED] as const,
    PAYMENT_METHOD_UPDATED: [AuditScope.SETTING, AuditVerb.PAYMENT_METHOD_UPDATED] as const,
  },
  NOTIFICATION: {
    SENT: [AuditScope.NOTIFICATION, AuditVerb.SENT] as const,
  },
  DOCUMENT: {
    CREATED: [AuditScope.DOCUMENT, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.DOCUMENT, AuditVerb.UPDATED] as const,
    ARCHIVED: [AuditScope.DOCUMENT, AuditVerb.RETIRED] as const,
    UNARCHIVED: [AuditScope.DOCUMENT, AuditVerb.UNRETIRED] as const,
    DELETED: [AuditScope.DOCUMENT, AuditVerb.DELETED] as const,
    VERSION_ADDED: [AuditScope.DOCUMENT, AuditVerb.VERSION_ADDED] as const,
    VERSION_RESTORED: [AuditScope.DOCUMENT, AuditVerb.VERSION_RESTORED] as const,
    VERSION_DELETED: [AuditScope.DOCUMENT, AuditVerb.VERSION_DELETED] as const,
    VIEWED: [AuditScope.DOCUMENT, AuditVerb.VIEWED] as const,
    DOWNLOADED: [AuditScope.DOCUMENT, AuditVerb.DOWNLOADED] as const,
  },
  TIMELINE: {
    CREATED: [AuditScope.TIMELINE, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.TIMELINE, AuditVerb.UPDATED] as const,
    ARCHIVED: [AuditScope.TIMELINE, AuditVerb.RETIRED] as const,
    UNARCHIVED: [AuditScope.TIMELINE, AuditVerb.UNRETIRED] as const,
    DELETED: [AuditScope.TIMELINE, AuditVerb.DELETED] as const,
    COMPLETED: [AuditScope.TIMELINE, AuditVerb.COMPLETED] as const,
  },
  BANNER: {
    POSTED: [AuditScope.BANNER, AuditVerb.CREATED] as const,
    DISMISSED: [AuditScope.BANNER, AuditVerb.UPDATED] as const,
    DELETED: [AuditScope.BANNER, AuditVerb.DELETED] as const,
  },
  EXPORT: {
    // CSV downloaded from the Exports tab. Records (actor, kind,
    // range) so the Audit Log shows when each payroll / QB pull
    // happened. The ExportRun table also persists the bytes for
    // a byte-identical re-download; this audit event is the
    // operator-facing summary.
    DOWNLOADED: [AuditScope.EXPORT, AuditVerb.DOWNLOADED] as const,
  },
  WORKDAY: {
    // Worker workday lifecycle events. The audit detail payload carries
    // the action discriminator (pause / resume / etc.) so the existing
    // verbs cover the full state machine without needing new enum values.
    //   CREATED   → start workday
    //   UPDATED   → pause / resume / edit times
    //   COMPLETED → end workday
    //   APPROVED  → admin approval (future phase)
    // Impersonation: when an admin acts on a worker's workday, actorId is
    // the admin's id and detail.impersonatedUserId is the worker's id so
    // the audit trail reflects who actually pushed the button.
    CREATED: [AuditScope.WORKDAY, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.WORKDAY, AuditVerb.UPDATED] as const,
    COMPLETED: [AuditScope.WORKDAY, AuditVerb.COMPLETED] as const,
    APPROVED: [AuditScope.WORKDAY, AuditVerb.APPROVED] as const,
    // Cancel — worker realized they started by mistake (e.g. tapped the
    // button while clearing notifications). Hard-deletes the row; the
    // audit detail preserves what the deleted row looked like.
    DELETED: [AuditScope.WORKDAY, AuditVerb.DELETED] as const,
  },
  PAYMENT: {
    // Reusing AuditVerb.CREATED for the admin-direct record path keeps the
    // "admin recorded a payment" semantics consistent with how other scopes
    // log mutations. The new verbs cover the approval-flow specifics.
    CREATED: [AuditScope.PAYMENT, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.PAYMENT, AuditVerb.UPDATED] as const,
    DELETED: [AuditScope.PAYMENT, AuditVerb.DELETED] as const,
    SELF_REPORTED: [AuditScope.PAYMENT, AuditVerb.SELF_REPORTED] as const,
    APPROVED: [AuditScope.PAYMENT, AuditVerb.APPROVED] as const,
    REJECTED: [AuditScope.PAYMENT, AuditVerb.REJECTED] as const,
    REQUEST_SENT: [AuditScope.PAYMENT, AuditVerb.REQUEST_SENT] as const,
    TOKEN_ACCESSED: [AuditScope.PAYMENT, AuditVerb.TOKEN_ACCESSED] as const,
    WRITTEN_OFF: [AuditScope.PAYMENT, AuditVerb.WRITTEN_OFF] as const,
    // Super-only "pretend this service never happened" — stronger than
    // WRITTEN_OFF. The payment stays in the DB (with all its history)
    // but is erased from every financial aggregate/export. Gated by
    // type-APPROVE at the UI layer + `superGuard` at the route layer.
    SKIPPED: [AuditScope.PAYMENT, AuditVerb.SKIPPED] as const,
    UNSKIPPED: [AuditScope.PAYMENT, AuditVerb.UNSKIPPED] as const,
    ADJUSTED: [AuditScope.PAYMENT, AuditVerb.ADJUSTED] as const,
    OWNER_EARNINGS_RECORDED: [AuditScope.PAYMENT, AuditVerb.OWNER_EARNINGS_RECORDED] as const,
    FEE_APPLIED: [AuditScope.PAYMENT, AuditVerb.FEE_APPLIED] as const,
  },
  LEDGER_FOLLOWUP: {
    CREATED: [AuditScope.LEDGER_FOLLOWUP, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.LEDGER_FOLLOWUP, AuditVerb.UPDATED] as const,
    // Reusing COMPLETED for "resolved" — same semantic ("finished
    // working on this item") and keeps the verb enum small. Metadata
    // payload carries any resolution note.
    RESOLVED: [AuditScope.LEDGER_FOLLOWUP, AuditVerb.COMPLETED] as const,
    DELETED: [AuditScope.LEDGER_FOLLOWUP, AuditVerb.DELETED] as const,
  },
} as const;

// Useful types
export type AuditTuple = readonly [AuditScope, AuditVerb];

type Values<T> = T[keyof T];
export type AnyAuditTuple = Values<Values<typeof AUDIT>>; // union of all tuples

// Derive the old combined string from `action` column:
export function toActionString([scope, verb]: AuditTuple) {
  return `${scope}_${verb}` as const;
}
