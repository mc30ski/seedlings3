import { AuditScope, AuditVerb } from "@prisma/client";

export const AUDIT = {
  USER: {
    APPROVED: [AuditScope.USER, AuditVerb.APPROVED] as const,
    ROLE_ASSIGNED: [AuditScope.USER, AuditVerb.ROLE_ASSIGNED] as const,
    ROLE_REMOVED: [AuditScope.USER, AuditVerb.ROLE_REMOVED] as const,
    DELETED: [AuditScope.USER, AuditVerb.DELETED] as const,
    WORKER_TYPE_SET: [AuditScope.USER, AuditVerb.WORKER_TYPE_SET] as const,
    // INSURANCE_UPLOADED, CONTRACTOR_AGREED, and W9_COLLECTED verbs were
    // removed as part of the compliance-policy migration. All three
    // concepts now flow through the PolicySignature system and use the
    // POLICY.* verbs below.
    GUARANTEED_PAYOUT_STARTED: [AuditScope.USER, AuditVerb.GUARANTEED_PAYOUT_STARTED] as const,
    GUARANTEED_PAYOUT_ENDED: [AuditScope.USER, AuditVerb.GUARANTEED_PAYOUT_ENDED] as const,
    SIGN_IN: [AuditScope.USER, AuditVerb.SIGN_IN] as const,
    // Reusing UPDATED for privilege flips — the metadata payload carries
    // which privilege changed and to what. Keeps schema enums small.
    PRIVILEGES_UPDATED: [AuditScope.USER, AuditVerb.UPDATED] as const,
    PAYMENT_COMMS_MODE_UPDATED: [AuditScope.USER, AuditVerb.UPDATED] as const,
    OWNER_FLAG_UPDATED: [AuditScope.USER, AuditVerb.UPDATED] as const,
    CREATED: [AuditScope.USER, AuditVerb.CREATED] as const,
    WAGE_UPDATED: [AuditScope.USER, AuditVerb.WAGE_UPDATED] as const,
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
    // PAUSED / UNPAUSED audit constants removed in Step 5 with the
    // ClientStatus.PAUSED enum value. Historical AuditEvent rows tagged
    // as "CLIENT_UPDATED" still exist and are queryable by scope+verb.
    ARCHIVED: [AuditScope.CLIENT, AuditVerb.RETIRED] as const,
    UNARCHIVED: [AuditScope.CLIENT, AuditVerb.UNRETIRED] as const,
    DELETED: [AuditScope.CLIENT, AuditVerb.DELETED] as const,

    CONTACT_CREATED: [AuditScope.CLIENT, AuditVerb.CREATED] as const,
    CONTACT_UPDATED: [AuditScope.CLIENT, AuditVerb.UPDATED] as const,
    // CONTACT_PAUSED / CONTACT_UNPAUSED removed with ContactStatus.PAUSED.
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
    UNARCHIVED: [AuditScope.JOB, AuditVerb.UNRETIRED] as const,
    // schedule/occurrence/assignees can be treated as UPDATED for now
    SCHEDULE_UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
    OCCURRENCE_CREATED: [AuditScope.JOB, AuditVerb.CREATED] as const,
    OCCURRENCE_UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
    OCCURRENCE_ARCHIVED: [AuditScope.JOB, AuditVerb.RETIRED] as const,
    OCCURRENCES_GENERATED: [AuditScope.JOB, AuditVerb.CREATED] as const,
    ASSIGNEES_UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
    // OCCURRENCE_ARCHIVED maps to RETIRED and misrepresents a hard delete,
    // so destructive paths get their own verb.
    OCCURRENCE_DELETED: [AuditScope.JOB, AuditVerb.OCCURRENCE_DELETED] as const,
    DELETED: [AuditScope.JOB, AuditVerb.DELETED] as const,
    // Addons change what the client is billed.
    ADDON_ADDED: [AuditScope.JOB, AuditVerb.ADDON_ADDED] as const,
    ADDON_REMOVED: [AuditScope.JOB, AuditVerb.ADDON_REMOVED] as const,
    PHOTO_DELETED: [AuditScope.JOB, AuditVerb.PHOTO_DELETED] as const,
    COMMENT_DELETED: [AuditScope.JOB, AuditVerb.COMMENT_DELETED] as const,
  },
  SETTING: {
    UPDATED: [AuditScope.SETTING, AuditVerb.SETTING_UPDATED] as const,
    PAYMENT_METHOD_UPDATED: [AuditScope.SETTING, AuditVerb.PAYMENT_METHOD_UPDATED] as const,
  },
  NOTIFICATION: {
    SENT: [AuditScope.NOTIFICATION, AuditVerb.SENT] as const,
    // Template CRUD — the scope previously only covered actually sending
    // a notification, so edits to the templates that shape every outbound
    // message were invisible.
    CREATED: [AuditScope.NOTIFICATION, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.NOTIFICATION, AuditVerb.UPDATED] as const,
    DELETED: [AuditScope.NOTIFICATION, AuditVerb.DELETED] as const,
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
  POLICY_DOCUMENT: {
    // Policy template + version lifecycle. See PolicyDocument /
    // PolicyDocumentVersion models + services/policies.ts.
    CREATED: [AuditScope.POLICY_DOCUMENT, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.POLICY_DOCUMENT, AuditVerb.UPDATED] as const,
    ARCHIVED: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_ARCHIVED] as const,
    UNARCHIVED: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_UNARCHIVED] as const,
    // Hard delete — only allowed on already-archived policies. Destroys the
    // policy row plus every version, signature, exception, and reading-
    // progress row. Metadata records what was destroyed so the audit
    // trail preserves that even though the underlying rows are gone.
    DELETED: [AuditScope.POLICY_DOCUMENT, AuditVerb.DELETED] as const,
    VERSION_DRAFTED: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_VERSION_DRAFTED] as const,
    VERSION_SUBMITTED_FOR_APPROVAL: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_VERSION_SUBMITTED_FOR_APPROVAL] as const,
    VERSION_APPROVED: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_VERSION_APPROVED] as const,
    VERSION_PUBLISHED: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_VERSION_PUBLISHED] as const,
    VERSION_ROLLED_BACK: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_VERSION_ROLLED_BACK] as const,
    // Bulk revoke — invalidates every current signature on a policy so
    // workers have to re-sign. Requires "type APPROVE" at UI.
    FORCE_RESIGN: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_FORCE_RESIGN] as const,
    // Per-worker exception grants (max 90d, requires reason). See
    // PolicyException model.
    EXCEPTION_GRANTED: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_EXCEPTION_GRANTED] as const,
    EXCEPTION_REVOKED: [AuditScope.POLICY_DOCUMENT, AuditVerb.POLICY_EXCEPTION_REVOKED] as const,
  },
  POLICY_SIGNATURE: {
    // Signature events. actor = worker for self-sign; actor = admin for
    // on-behalf uploads and admin actions.
    SIGNED: [AuditScope.POLICY_SIGNATURE, AuditVerb.POLICY_SIGNED] as const,
    REVOKED: [AuditScope.POLICY_SIGNATURE, AuditVerb.POLICY_SIGNATURE_REVOKED] as const,
    // Admin verification of a worker-uploaded artifact (APPROVED or
    // REJECTED). Metadata carries the decision and optional reason.
    UPLOAD_REVIEWED: [AuditScope.POLICY_SIGNATURE, AuditVerb.POLICY_UPLOAD_REVIEWED] as const,
    // Admin bypassed the worker sign flow entirely by uploading the
    // artifact on behalf. Requires "type APPROVE" for SIGN-type docs;
    // routine for NONE-type docs.
    ADMIN_UPLOADED_ON_BEHALF: [AuditScope.POLICY_SIGNATURE, AuditVerb.POLICY_ADMIN_UPLOADED_ON_BEHALF] as const,
  },
  PROMOTION: {
    // Lifecycle + edit + burst events for the Promotions feature. Metadata
    // always includes promotionId; state-transition rows also include
    // fromStatus/toStatus. See services/promotions.ts + routes/promotions.ts.
    CREATED: [AuditScope.PROMOTION, AuditVerb.CREATED] as const,
    STARTED: [AuditScope.PROMOTION, AuditVerb.PROMOTION_STARTED] as const,
    PAUSED: [AuditScope.PROMOTION, AuditVerb.PROMOTION_PAUSED] as const,
    RESUMED: [AuditScope.PROMOTION, AuditVerb.PROMOTION_RESUMED] as const,
    RETIRED: [AuditScope.PROMOTION, AuditVerb.PROMOTION_RETIRED] as const,
    EDITED: [AuditScope.PROMOTION, AuditVerb.PROMOTION_EDITED] as const,
    DUPLICATED: [AuditScope.PROMOTION, AuditVerb.PROMOTION_DUPLICATED] as const,
    // Permanent hard delete. The promotion row is gone, so this entry is
    // the only remaining record — its metadata carries the title, slug,
    // status, and whether delivery history was destroyed via the
    // type-APPROVE override.
    DELETED: [AuditScope.PROMOTION, AuditVerb.DELETED] as const,
    DISPATCHED: [AuditScope.PROMOTION, AuditVerb.PROMOTION_DISPATCHED] as const,
    TEST_SENT: [AuditScope.PROMOTION, AuditVerb.PROMOTION_TEST_SENT] as const,
    // Rotation of the auto-managed PROMOTION_HMAC_SECRET. Rare admin
    // action; metadata carries { previousSecretPreviewHash, rotatedAt }
    // so the audit trail can prove a rotation happened without exposing
    // the secret itself.
    HMAC_ROTATED: [AuditScope.PROMOTION, AuditVerb.PROMOTION_HMAC_ROTATED] as const,
  },
  VANITY: {
    // Vanity URL CRUD verbs. Scope: VANITY. See models VanityPage below.
    // Metadata carries { slug, kind, isDefault }.
    CREATED: [AuditScope.VANITY, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.VANITY, AuditVerb.UPDATED] as const,
    DELETED: [AuditScope.VANITY, AuditVerb.DELETED] as const,
  },
  PROMO_OPT: {
    // Per-contact promotional-message opt-out / opt-in events. Metadata
    // always includes { contactId, clientId, channel, source, reason? }.
    // source ∈ client_self_email_link | client_self_sms_link |
    //          client_self_invoice_page | super_manual | hard_bounce
    OPTED_OUT: [AuditScope.PROMO_OPT, AuditVerb.PROMO_OPTED_OUT] as const,
    OPTED_IN: [AuditScope.PROMO_OPT, AuditVerb.PROMO_OPTED_IN] as const,
  },
  // ── Added 2026-08-22 ────────────────────────────────────────────────
  // A system-wide sweep found these domains mutating user-meaningful
  // state with no audit trail whatsoever. Several are money paths.
  EXPENSE: {
    // Covers both the job-linked `Expense` and its paired tax-ledger
    // `BusinessExpense` — they're written and deleted as a pair, so one
    // scope with a metadata discriminator beats two that always co-fire.
    CREATED: [AuditScope.EXPENSE, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.EXPENSE, AuditVerb.UPDATED] as const,
    DELETED: [AuditScope.EXPENSE, AuditVerb.DELETED] as const,
    RECONCILED: [AuditScope.EXPENSE, AuditVerb.RECONCILED] as const,
    RECEIPT_ATTACHED: [AuditScope.EXPENSE, AuditVerb.RECEIPT_ATTACHED] as const,
    RECEIPT_DELETED: [AuditScope.EXPENSE, AuditVerb.RECEIPT_DELETED] as const,
  },
  SUPPLY: {
    CREATED: [AuditScope.SUPPLY, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.SUPPLY, AuditVerb.UPDATED] as const,
    ARCHIVED: [AuditScope.SUPPLY, AuditVerb.RETIRED] as const,
    UNARCHIVED: [AuditScope.SUPPLY, AuditVerb.UNRETIRED] as const,
    PURCHASE_RECORDED: [AuditScope.SUPPLY, AuditVerb.PURCHASE_RECORDED] as const,
    PURCHASE_REVERSED: [AuditScope.SUPPLY, AuditVerb.DELETED] as const,
    ADJUSTED: [AuditScope.SUPPLY, AuditVerb.ADJUSTED] as const,
    // Holds charge a job (and therefore reduce a worker's payout), so
    // they get their own verbs rather than hiding inside UPDATED.
    HOLD_CREATED: [AuditScope.SUPPLY, AuditVerb.HOLD_CREATED] as const,
    HOLD_REMOVED: [AuditScope.SUPPLY, AuditVerb.HOLD_REMOVED] as const,
    HOLD_ADJUSTED: [AuditScope.SUPPLY, AuditVerb.HOLD_ADJUSTED] as const,
  },
  MILEAGE: {
    CREATED: [AuditScope.MILEAGE, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.MILEAGE, AuditVerb.UPDATED] as const,
    COMPLETED: [AuditScope.MILEAGE, AuditVerb.COMPLETED] as const,
    DELETED: [AuditScope.MILEAGE, AuditVerb.DELETED] as const,
    ADJUSTED: [AuditScope.MILEAGE, AuditVerb.ADJUSTED] as const,
    APPROVED: [AuditScope.MILEAGE, AuditVerb.APPROVED] as const,
    UNAPPROVED: [AuditScope.MILEAGE, AuditVerb.UNAPPROVED] as const,
  },
  GROUP: {
    CREATED: [AuditScope.GROUP, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.GROUP, AuditVerb.UPDATED] as const,
    ARCHIVED: [AuditScope.GROUP, AuditVerb.RETIRED] as const,
    UNARCHIVED: [AuditScope.GROUP, AuditVerb.UNRETIRED] as const,
    // Membership drives equipmentCostPercent, which decides who is billed
    // for a group equipment rental — money, not bookkeeping.
    MEMBER_ADDED: [AuditScope.GROUP, AuditVerb.MEMBER_ADDED] as const,
    MEMBER_REMOVED: [AuditScope.GROUP, AuditVerb.MEMBER_REMOVED] as const,
    MEMBER_UPDATED: [AuditScope.GROUP, AuditVerb.MEMBER_UPDATED] as const,
  },
  VEHICLE: {
    CREATED: [AuditScope.VEHICLE, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.VEHICLE, AuditVerb.UPDATED] as const,
    ARCHIVED: [AuditScope.VEHICLE, AuditVerb.RETIRED] as const,
    UNARCHIVED: [AuditScope.VEHICLE, AuditVerb.UNRETIRED] as const,
    // Assignment gates whether a worker can log deductible miles.
    ASSIGNED: [AuditScope.VEHICLE, AuditVerb.ASSIGNED] as const,
    UNASSIGNED: [AuditScope.VEHICLE, AuditVerb.UNASSIGNED] as const,
  },
  CHANGE_REQUEST: {
    CREATED: [AuditScope.CHANGE_REQUEST, AuditVerb.CREATED] as const,
    APPROVED: [AuditScope.CHANGE_REQUEST, AuditVerb.APPROVED] as const,
    DENIED: [AuditScope.CHANGE_REQUEST, AuditVerb.DENIED] as const,
    CANCELED: [AuditScope.CHANGE_REQUEST, AuditVerb.CANCELED] as const,
  },
  EQUIPMENT_COLLECTION: {
    CREATED: [AuditScope.EQUIPMENT_COLLECTION, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.EQUIPMENT_COLLECTION, AuditVerb.UPDATED] as const,
    DELETED: [AuditScope.EQUIPMENT_COLLECTION, AuditVerb.DELETED] as const,
  },
  CALENDAR_FEED: {
    // Minting one hands out a bearer token that reads a worker's schedule
    // without authentication.
    CREATED: [AuditScope.CALENDAR_FEED, AuditVerb.CREATED] as const,
    DELETED: [AuditScope.CALENDAR_FEED, AuditVerb.DELETED] as const,
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
