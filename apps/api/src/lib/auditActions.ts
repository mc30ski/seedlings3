import { AuditScope, AuditVerb } from "@prisma/client";

export const AUDIT = {
  USER: {
    APPROVED: [AuditScope.USER, AuditVerb.APPROVED] as const,
    ROLE_ASSIGNED: [AuditScope.USER, AuditVerb.ROLE_ASSIGNED] as const,
  },
  EQUIPMENT: {
    CREATED: [AuditScope.EQUIPMENT, AuditVerb.CREATED] as const,
    UPDATED: [AuditScope.EQUIPMENT, AuditVerb.UPDATED] as const,
    RETIRED: [AuditScope.EQUIPMENT, AuditVerb.RETIRED] as const,
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
} as const;

// Useful types
export type AuditTuple = readonly [AuditScope, AuditVerb];

type Values<T> = T[keyof T];
export type AnyAuditTuple = Values<Values<typeof AUDIT>>; // union of all tuples

// Derive the old combined string from `action` column:
export function toActionString([scope, verb]: AuditTuple) {
  return `${scope}_${verb}` as const;
}
