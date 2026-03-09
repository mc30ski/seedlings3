import { AuditScope, AuditVerb } from "@prisma/client";

export const AUDIT = {
  USER: {
    APPROVED: [AuditScope.USER, AuditVerb.APPROVED] as const,
    ROLE_ASSIGNED: [AuditScope.USER, AuditVerb.ROLE_ASSIGNED] as const,
    ROLE_REMOVED: [AuditScope.USER, AuditVerb.ROLE_REMOVED] as const,
    DELETED: [AuditScope.USER, AuditVerb.DELETED] as const,
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
    // schedule/occurrence/assignees can be treated as UPDATED for now
    SCHEDULE_UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
    OCCURRENCE_CREATED: [AuditScope.JOB, AuditVerb.CREATED] as const,
    OCCURRENCE_UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
    OCCURRENCES_GENERATED: [AuditScope.JOB, AuditVerb.CREATED] as const,
    ASSIGNEES_UPDATED: [AuditScope.JOB, AuditVerb.UPDATED] as const,
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
