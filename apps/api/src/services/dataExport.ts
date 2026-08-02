// Shared payload builder for the "everything" data export.
//
// Two consumers today, and they MUST return identical bytes for the
// same DB state so restoration from a nightly backup produces the same
// artifact a Super would get from the manual "Export All Data" tile:
//
//   1. `GET /admin/export` — Super clicks the tile in Admin → Actions,
//      the JSON streams to their browser. Respects the Business Start
//      Date cutoff so pre-cutoff money rows drop out unless Super has
//      the reveal toggle on.
//
//   2. `GET /cron/client-backup` — nightly Vercel cron uploads the
//      same payload to Google Drive at CompanyClients/YYYY-MM-DD.json.
//      Bypasses the BSD cutoff — a backup that hides historical money
//      rows isn't a backup.
//
// Adding a new table to the export is a ONE-PLACE change (this file).
// Any consumer picks it up automatically. Do NOT re-implement the
// aggregation in a caller — the whole point of extracting it here is
// to keep the "did we export this table?" question single-source.

import { prisma } from "../db/prisma";
import { cutoffWhere, paymentSplitCutoffWhere } from "../lib/businessStartCutoff";

export type DataSnapshot = {
  exportedAt: string;
  /** True when the caller passed a non-null cutoff (i.e. the export is
   *  BSD-filtered). Consumers can inspect this to disambiguate a
   *  "full" backup file from a "filtered" download during restore. */
  bsdCutoffApplied: boolean;
  users: unknown[];
  userRoles: unknown[];
  equipment: unknown[];
  checkouts: unknown[];
  clients: unknown[];
  clientContacts: unknown[];
  properties: unknown[];
  jobs: unknown[];
  jobContacts: unknown[];
  jobClients: unknown[];
  jobSchedules: unknown[];
  jobOccurrences: unknown[];
  jobAssigneeDefaults: unknown[];
  jobOccurrenceAssignees: unknown[];
  payments: unknown[];
  paymentSplits: unknown[];
  expenses: unknown[];
  auditEvents: unknown[];
  guaranteedPayoutAdvances: unknown[];
};

/**
 * Build a full-database snapshot for export/backup.
 *
 * @param cutoff  When non-null, pre-cutoff money rows (Payment,
 *                PaymentSplit, Expense, AuditEvent, Checkout,
 *                GuaranteedPayoutAdvance) are excluded — same
 *                semantics as the Business Start Date filter that
 *                runs across the money-facing UI. Non-money tables
 *                (Users, Clients, Properties, Jobs, etc.) are
 *                unfiltered. Pass `null` for a full backup.
 */
export async function buildDataSnapshot(cutoff: Date | null): Promise<DataSnapshot> {
  const [
    users,
    userRoles,
    equipment,
    checkouts,
    clients,
    clientContacts,
    properties,
    jobs,
    jobContacts,
    jobClients,
    jobSchedules,
    jobOccurrences,
    jobAssigneeDefaults,
    jobOccurrenceAssignees,
    payments,
    paymentSplits,
    expenses,
    auditEvents,
    guaranteedPayoutAdvances,
  ] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.userRole.findMany(),
    prisma.equipment.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.checkout.findMany({ where: { ...cutoffWhere("Checkout", cutoff) } }),
    prisma.client.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.clientContact.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.property.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.job.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.jobContact.findMany(),
    prisma.jobClient.findMany(),
    prisma.jobSchedule.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.jobOccurrence.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.jobAssigneeDefault.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.jobOccurrenceAssignee.findMany(),
    prisma.payment.findMany({ where: { ...cutoffWhere("Payment", cutoff) }, orderBy: { createdAt: "asc" } }),
    prisma.paymentSplit.findMany({ where: { ...paymentSplitCutoffWhere(cutoff) }, orderBy: { createdAt: "asc" } }),
    prisma.expense.findMany({
      where: cutoff ? {
        OR: [
          { businessExpense: { date: { gte: cutoff } } },
          { businessExpense: null, createdAt: { gte: cutoff } },
        ],
      } : undefined,
      orderBy: { createdAt: "asc" },
    }),
    prisma.auditEvent.findMany({ where: { ...cutoffWhere("AuditEvent", cutoff) }, orderBy: { createdAt: "asc" } }),
    prisma.guaranteedPayoutAdvance.findMany({
      where: { ...cutoffWhere("GuaranteedPayoutAdvance", cutoff) },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    bsdCutoffApplied: cutoff !== null,
    users,
    userRoles,
    equipment,
    checkouts,
    clients,
    clientContacts,
    properties,
    jobs,
    jobContacts,
    jobClients,
    jobSchedules,
    jobOccurrences,
    jobAssigneeDefaults,
    jobOccurrenceAssignees,
    payments,
    paymentSplits,
    expenses,
    auditEvents,
    guaranteedPayoutAdvances,
  };
}
