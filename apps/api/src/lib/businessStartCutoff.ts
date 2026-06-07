// ─────────────────────────────────────────────────────────────────────────────
// Business Start Date filter — non-destructive money cleanup
//
// PURPOSE
// Provides a per-request "money cutoff" that lets the app present a clean
// slate from the company's official start date onward, while preserving every
// row in the database. Pre-cutoff Payments, BusinessExpenses, Expenses,
// Checkouts, AuditEvents and SupplyPurchases are HIDDEN from queries (not
// deleted). A Super user can transiently disable the filter via the
// X-Reveal-Pre-Cutoff header to inspect old data (e.g. for tax exports).
//
// SAFETY INVARIANTS (do not violate when extending this module)
//   1. When the feature is disabled OR the Super reveal header is honored,
//      `resolveCutoff()` returns `null` and every helper here returns an
//      EMPTY object/where so the underlying query is byte-identical to its
//      pre-feature shape. Off-state must always === pre-feature behavior.
//   2. Any failure path (setting missing, value unparseable, role lookup
//      throws) defaults to "no filter" — never accidentally hide data.
//   3. The Setting rows default to disabled when not seeded, so a fresh
//      production deploy lands with the filter OFF until an operator turns
//      it on explicitly in Settings.
//
// WHEN ADDING A NEW MONEY MODEL
//   - Add the model to `CutoffModel` and `MODEL_DATE_FIELD` below.
//   - Find every read query for that model in the codebase and add
//     `...cutoffWhere("YourModel", cutoff)` to its `where` (or use the
//     filtered-include helpers for nested money on JobOccurrence).
//   - Update the seed in apps/api/prisma/seed.ts to include both pre- and
//     post-cutoff rows so the filter can be exercised.
//   - Update the memory note at .claude/.../memory/feature_business_start_date.md.
// ─────────────────────────────────────────────────────────────────────────────

import type { FastifyRequest } from "fastify";
import { prisma } from "../db/prisma";
import { etMidnight } from "./dates";

export const BUSINESS_START_DATE_KEY = "BUSINESS_START_DATE";
export const BUSINESS_START_DATE_ENABLED_KEY = "BUSINESS_START_DATE_ENABLED";

// HTTP header that lets a verified Super temporarily disable the filter for
// the current request. Lowercased to match Node's normalized header map.
export const REVEAL_PRE_CUTOFF_HEADER = "x-reveal-pre-cutoff";

// Money tables whose top-level queries respect the cutoff. The value is the
// DateTime column used as the cutoff anchor on that table.
//
//   Payment         — createdAt (stable; doesn't move on approval)
//   PaymentSplit    — filtered via parent payment.createdAt (use
//                     `paymentSplitCutoffWhere` — splits are delete+recreated
//                     at approval, so PaymentSplit.createdAt is unreliable)
//   BusinessExpense — date (user-entered; matches Expense's paired anchor)
//   Expense         — businessExpense.date when paired, else createdAt
//                     (Expense and BusinessExpense are 1:1 — anchoring on the
//                     same date keeps the two surfaces consistent)
//   Checkout        — releasedAt (when rentalCost materializes; null until
//                     released, so still-active checkouts pass through)
//   AuditEvent      — createdAt
//   SupplyPurchase  — date
const MODEL_DATE_FIELD = {
  Payment: "createdAt",
  BusinessExpense: "date",
  Checkout: "releasedAt",
  AuditEvent: "createdAt",
  SupplyPurchase: "date",
  // Guaranteed-payout advances anchor on exportedAt — the moment the
  // operator committed to paying the contractor out-of-band for the
  // referenced occurrence. This is the cash-flow date for both 1099
  // and QB Expenses reporting, matching how Payment.createdAt anchors
  // confirmed splits.
  GuaranteedPayoutAdvance: "exportedAt",
} as const;

export type CutoffModel = keyof typeof MODEL_DATE_FIELD;

// ─────────────────────────────────────────────────────────────────────────────
// resolveCutoff
//
// Returns the effective cutoff Date for this request, or null when the filter
// is off (either globally disabled, or transiently disabled by a verified
// Super via the reveal header).
//
// SAFETY: any failure (settings throw, parse fail, role lookup throw) returns
// null. Never accidentally hide data on a transient error.
// ─────────────────────────────────────────────────────────────────────────────
export async function resolveCutoff(req: FastifyRequest): Promise<Date | null> {
  try {
    const [enabledRow, dateRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: BUSINESS_START_DATE_ENABLED_KEY } }),
      prisma.setting.findUnique({ where: { key: BUSINESS_START_DATE_KEY } }),
    ]);

    // Disabled (or unset) → no filter. This is the production-default path
    // before an operator flips the toggle in Settings.
    if (enabledRow?.value !== "true") return null;

    // Enabled but date missing/unparseable → no filter. Can't anchor a
    // cutoff without a date.
    if (!dateRow?.value) return null;
    const cutoff = parseCutoffValue(dateRow.value);
    if (!cutoff) return null;

    // Super reveal — only honored when `req.user.roles` (post-impersonation)
    // still includes SUPER. A Super impersonating a non-Super loses the
    // reveal capability for that request, which matches the rest of
    // impersonation's "see what they see" contract.
    const revealHeader = req.headers[REVEAL_PRE_CUTOFF_HEADER];
    if (revealHeader === "true" || revealHeader === "1") {
      const roles = (req as any).user?.roles as string[] | undefined;
      if (roles?.includes("SUPER")) return null;
    }

    return cutoff;
  } catch {
    // Default-to-no-filter on any failure. A transient DB hiccup must never
    // be the reason a Payment row disappears from an export.
    return null;
  }
}

// Parse the stored value. Accept "YYYY-MM-DD" (interpreted as local midnight)
// or any value the Date constructor handles. Returns null on parse failure.
function parseCutoffValue(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // YYYY-MM-DD → anchor on ET midnight (NOT server-local) so a row
  // created at 23:59 ET the day BEFORE the cutoff is correctly excluded.
  // The old `new Date(y, m-1, d)` constructor used server-local time =
  // UTC on Vercel, which mis-anchored the cutoff by 4-5 hours and let
  // rows from before the official start date slip into reports.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const dt = etMidnight(trimmed);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }
  const dt = new Date(trimmed);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// cutoffWhere
//
// Pattern A: top-level `where` augmentation for one of the money tables.
// Returns {} when cutoff is null, so the original query is unchanged.
//
//   const where = { confirmed: true, ...cutoffWhere("Payment", cutoff) };
// ─────────────────────────────────────────────────────────────────────────────
export function cutoffWhere(
  model: CutoffModel,
  cutoff: Date | null,
): Record<string, any> {
  if (cutoff == null) return {};
  const field = MODEL_DATE_FIELD[model];
  return { [field]: { gte: cutoff } };
}

// ─────────────────────────────────────────────────────────────────────────────
// paymentSplitCutoffWhere
//
// PaymentSplit rows are delete-and-recreated at approval time, so their own
// createdAt jumps to the approval date. The stable anchor is the parent
// Payment's createdAt. Returns {} when cutoff is null.
//
//   prisma.paymentSplit.findMany({
//     where: { userId, ...paymentSplitCutoffWhere(cutoff) }
//   })
// ─────────────────────────────────────────────────────────────────────────────
export function paymentSplitCutoffWhere(
  cutoff: Date | null,
): Record<string, any> {
  if (cutoff == null) return {};
  return { payment: { createdAt: { gte: cutoff } } };
}

// ─────────────────────────────────────────────────────────────────────────────
// expenseCutoffWhere
//
// Expense ↔ BusinessExpense are paired 1:1. To keep both surfaces consistent
// we anchor on BusinessExpense.date when paired, falling back to
// Expense.createdAt for the rare un-paired row. Returns {} when cutoff null.
// ─────────────────────────────────────────────────────────────────────────────
export function expenseCutoffWhere(
  cutoff: Date | null,
): Record<string, any> {
  if (cutoff == null) return {};
  return {
    OR: [
      { businessExpense: { date: { gte: cutoff } } },
      // Unpaired Expense rows (e.g. supply-hold-sourced where the BE was the
      // purchase, not this Expense) — fall back to the Expense's own createdAt.
      { businessExpense: null, createdAt: { gte: cutoff } },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern B — filtered-include helpers for JobOccurrence's money relations.
//
// JobOccurrence isn't a money table, but operations/statistics/dashboard
// endpoints iterate occurrences and sum data from their `payment` / `expenses`
// includes. Filtering at the include level lets aggregations stay the same:
// pre-cutoff occurrences still appear (per design: jobs remain visible) but
// their `payment` resolves to null and `expenses` to [], so revenue/expense
// totals naturally skip them with no math changes.
//
// Both helpers preserve any caller-supplied `where`/`select`/`include` and
// merge the cutoff `where` on top.
// ─────────────────────────────────────────────────────────────────────────────

type IncludeArgs = Record<string, any>;

// Generic over the extras object so callers preserve Prisma's typed
// `include`/`select`/`where` inference. Without the generic, the return
// type was `Record<string, any>` and downstream `o.payment.splits` lost
// its type, forcing every call site into `(sp: any) =>`. With it,
// passing `{ include: { splits: true } }` flows through unchanged.
export function paymentIncludeWithCutoff<T extends IncludeArgs>(
  cutoff: Date | null,
  extras?: T,
): T {
  const base = (extras ?? ({} as T));
  if (cutoff == null) return base;
  const existing = ((base as any).where ?? {}) as Record<string, any>;
  return {
    ...(base as any),
    where: { ...existing, createdAt: { gte: cutoff } },
  } as T;
}

export function expensesIncludeWithCutoff<T extends IncludeArgs>(
  cutoff: Date | null,
  extras?: T,
): T {
  const base = (extras ?? ({} as T));
  if (cutoff == null) return base;
  const existing = ((base as any).where ?? {}) as Record<string, any>;
  return {
    ...(base as any),
    where: {
      ...existing,
      OR: [
        { businessExpense: { date: { gte: cutoff } } },
        { businessExpense: null, createdAt: { gte: cutoff } },
      ],
    },
  } as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern C — occurrence work-date cutoff.
//
// For employee earnings aggregations that iterate JobOccurrence directly and
// project promised net regardless of Payment row presence. The "money event"
// for an employee is the work date, not the payment date — wages accrue when
// work is done. We exclude occurrences whose work date is pre-cutoff.
//
// Work date precedence: completedAt > startedAt > startAt. The where clause
// expresses "the EFFECTIVE work date is >= cutoff" via an OR over the three
// fields with appropriate NULL guards so an occurrence isn't excluded just
// because its later fields aren't set yet.
// ─────────────────────────────────────────────────────────────────────────────
export function occurrenceWorkDateCutoff(
  cutoff: Date | null,
): Record<string, any> {
  if (cutoff == null) return {};
  return {
    OR: [
      { completedAt: { gte: cutoff } },
      { completedAt: null, startedAt: { gte: cutoff } },
      { completedAt: null, startedAt: null, startAt: { gte: cutoff } },
    ],
  };
}
