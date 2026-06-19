import { prisma } from "../db/prisma";
import { etFormatDate, etFormatTimeOpts } from "../lib/dates";
import { loadExpenseCategories } from "./expenseCategories";
import {
  computeBreakdown,
  loadRates,
  wasUserInGuaranteedPayoutAt,
  type WorkerInput,
} from "./payments";

// Returned by every CSV builder. `rowCount` counts data rows only
// (excludes header + TOTALS); `total` is the dollar figure on the TOTALS
// line. The route layer doesn't persist these anywhere now — they're
// emitted for eyeball validation only.
export type CsvResult = {
  csv: string;
  rowCount: number;
  total: number;
};

// CSV-export service for the Money → Preview tab. Two flat files
// (expensesCsv, workersCsv) plus helpers shared with the P&L Report.
// All routes super-admin-gated at the route layer. Cash basis: payment-
// derived rows anchor on Payment.confirmedAt; expense rows anchor on the
// effective date (occurrence.completedAt for per-occurrence, BE.date for
// freestanding) — same rules QB enforces, so reconciliation tracks.

// CSV-injection-safe field escape. Excel/LibreOffice interprets any
// field STARTING with `=`, `+`, `-`, `@`, tab (\t), or CR (\r) as a
// formula, which is a real attack vector (OWASP CSV Injection) — a
// client or worker named `=cmd|/c calc!` would execute the moment the
// operator opens the CSV. We defuse those leads by prefixing a single
// quote (the canonical Excel "treat literally" marker).
function csvEscape(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Strip leading/trailing whitespace AFTER the formula check — leading
  // whitespace would mask a `\t=...` payload otherwise.
  // A plain signed number like `-370.45` is not a formula and Excel
  // renders it as a number; skip the literal prefix so numeric
  // columns don't render as `'-370.45`. The injection vector is
  // formula-shaped strings (e.g. `=cmd|/c calc!`, `-2+3*cmd`), not
  // pure numerics.
  const isPureNumber = /^-?\d+(\.\d+)?$/.test(s);
  if (!isPureNumber && /^[=+\-@\t\r]/.test(s)) {
    s = "'" + s; // Excel-safe literal prefix
  }
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Join cells with commas. We use CRLF line endings (\r\n) per RFC 4180 —
// older Excel and a few Windows tools choke on bare LF and render the
// whole file as a single cell. The csv outputs below glue the rows with
// CRLF and append a trailing CRLF.
function csvRow(cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

// UTF-8 byte-order mark. Prepend to any CSV that may contain
// non-ASCII characters (names with accents, addresses with curly
// quotes, etc.) — without it, Excel-on-Windows interprets the file as
// ANSI and shows characters as garbage. Modern Excel + Google Sheets
// detect the BOM and decode correctly.
const UTF8_BOM = "﻿";

// Single canonical CSV finalizer. Glues row strings with CRLF (RFC 4180,
// the only line-ending Excel-on-Windows handles correctly), appends a
// trailing CRLF, and prepends a UTF-8 BOM. EVERY csv-returning function
// in this file goes through here — never `lines.join("\n")` directly,
// or BOM + CRLF will be missing and Excel will render the file wrong.
function finalizeCsv(lines: string[]): string {
  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}

// YYYY-MM-DD in Eastern Time. Delegates to the shared etFormatDate so
// all date formatting in this codebase routes through a single helper.
// See lib/dates.ts.
function toIsoDate(d: Date): string {
  return etFormatDate(d);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isEmployeeClass(t: string | null | undefined): boolean {
  return t === "EMPLOYEE" || t === "TRAINEE";
}

// Common loader: confirmed payments in [start, end] with everything we need.
async function loadConfirmedPayments(start: Date, end: Date) {
  return prisma.payment.findMany({
    where: {
      confirmed: true,
      confirmedAt: { gte: start, lte: end },
      writtenOff: false,
    },
    include: {
      occurrence: {
        select: {
          id: true,
          title: true,
          workflow: true,
          startedAt: true,
          completedAt: true,
          totalPausedMs: true,
          assignees: {
            // Include user displayName/email so the Income CSV's
            // Workers column can list the people who actually did
            // the work, not just the people who received non-owner-
            // earnings PaymentSplit rows. Without the user join,
            // owner-only jobs (where the only split is owner-
            // earnings) render with an empty Workers column even
            // though the owner did the work.
            select: {
              userId: true,
              role: true,
              user: {
                select: {
                  displayName: true,
                  email: true,
                },
              },
            },
          },
          job: {
            select: {
              // Job doesn't have a `title` field — the operator-facing
              // label on each row uses JobOccurrence.title (selected
              // above), falling back to Job.description, then to a
              // workflow-derived label (e.g. "Recurring service").
              description: true,
              property: {
                select: {
                  displayName: true,
                  street1: true,
                  city: true,
                  state: true,
                  client: { select: { displayName: true } },
                },
              },
            },
          },
        },
      },
      // ALL splits — including owner-earnings rows. The Income CSV
      // surfaces them as "Owner / Business" income so the operator sees
      // the full payment breakdown (worker payouts + the business's
      // own cut). When a caller needs only payout-side rows it can
      // filter by `ownerEarnings === false` in memory.
      splits: {
        include: {
          user: {
            select: {
              id: true,
              displayName: true,
              email: true,
              workerType: true,
            },
          },
        },
      },
    },
    orderBy: { confirmedAt: "asc" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// W-2 earnings — WORK-anchored, not payment-anchored.
//
// An employee/trainee is a W-2 worker: their wages accrue when they DO the
// work and must be paid on the regular payroll schedule for the period the
// work fell in — regardless of whether (or when) the client pays. So the W-2
// export is driven by JOBS COMPLETED in the window, bucketed by completedAt,
// and the amount is each worker's PROMISED NET (the made-whole figure):
//   • If the occurrence has a promisedPayouts snapshot, read the net from it.
//   • Otherwise compute it from price/expenses/split — a job completed but
//     not yet payment-initiated still owes the employee their wage.
// A later client underpayment never claws back an employee's W-2 wage; the
// business absorbs it. Owner-earnings assignees are excluded (draw, not pay).
// (Contrast: the contractor export below stays payment-anchored.)
// ─────────────────────────────────────────────────────────────────────────────

type W2Agg = {
  userId: string;
  first: string;
  last: string;
  email: string;
  workerType: string;
  hours: number;
  gross: number;
  jobs: number;
};


// Completed STANDARD/ONE_OFF occurrences in the window — the W-2 wage events.
// hoursApprovedAt filter is the payroll-integrity gate: occurrences whose
// hours haven't been admin-approved are excluded from the export. They
// surface in the title-bar alert and the Exports tab pre-download warning
// until reviewed (or hours edited back within tolerance to auto-approve).

/**
 * Aggregate W-2 (employee + trainee) earnings for the window, work-anchored.
 * Shared by the CSV export and the preview.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Gusto W-2 CSV — one row per employee/trainee with totals in the period.
// ─────────────────────────────────────────────────────────────────────────────

// Computes the work-anchored items for contractors in their guaranteed-
// payout (GP) period — pure-read, ZERO database writes, fully idempotent.
//
// During GP, a contractor's payment is wage-like (work-anchored, paid on
// the next payroll cycle for the period the work fell in), the same model
// W-2 employees use. After GP expires, the same contractor's payment
// reverts to split-anchored (paid when the client's payment is confirmed).
//
// This function is the wage-side computation: one entry per (user ×
// occurrence) where the contractor was in GP at occurrence.completedAt
// AND completedAt ∈ [start, end]. Callers use it to:
//   • feed gustoContractorsCsv's work-anchored half
//   • feed exportPreview's tally for the same window
//   • populate worker/admin earnings dashboards (filtered by userId)
//
// There is NO exclusion based on existing PaymentSplits or any prior
// GuaranteedPayoutAdvance row. That's the whole point of idempotency —
// the same (start, end, optional userId) input ALWAYS produces the same
// output regardless of what other side effects have happened.
//
// Dedup against eventual client payment is handled at PaymentSplit
// creation time: when the client later pays for a GP-period occurrence,
// fetchAdvanceFlagsByUser derives `guaranteedPayoutPaidAt` from the same
// "was user in GP at completedAt" rule used here. The Gusto Contractors
// CSV's payment-anchored half then skips flagged splits.
//
// `opts.userId` narrows the result to a single contractor — used by
// worker/admin earnings dashboards.
export type GpWorkAnchoredItem = {
  userId: string;
  occurrenceId: string;
  amount: number;
  completedAt: Date;
  contractor: { id: string; displayName: string | null; email: string | null };
  // Property + client context — non-null when the occurrence has them
  // wired up. Used by the QB Expenses CSV's Contract Labor descriptions
  // and by any other consumer that wants the human-readable provenance.
  property: { displayName: string | null; clientDisplayName: string | null } | null;
};

export async function loadGpWorkAnchoredItems(
  start: Date,
  end: Date,
  opts?: { userId?: string },
): Promise<GpWorkAnchoredItem[]> {
  const occs = await prisma.jobOccurrence.findMany({
    where: {
      completedAt: { gte: start, lte: end },
      status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
      workflow: { in: ["STANDARD", "ONE_OFF"] as any },
      assignees: {
        some: {
          // SQL NULL-safety: `role != 'observer'` evaluates to NULL when
          // role IS NULL, dropping the row. Most assignees have NULL role
          // (only crew membership sets one) — without this OR, NULL-role
          // contractor jobs silently disappear from the Gusto Contractors
          // export and the contractor doesn't get paid.
          OR: [{ role: null }, { role: { not: "observer" } }],
          user: {
            workerType: "CONTRACTOR",
            ...(opts?.userId ? { id: opts.userId } : {}),
          },
        },
      },
    },
    include: {
      assignees: {
        select: {
          userId: true,
          role: true,
          user: {
            select: {
              id: true,
              displayName: true,
              email: true,
              workerType: true,
              guaranteedPayoutUntil: true,
              guaranteedPayoutStartedAt: true,
              guaranteedPayoutHistory: true,
            },
          },
        },
      },
      addons: { select: { price: true } },
      expenses: { select: { cost: true } },
      job: {
        select: {
          property: {
            select: {
              displayName: true,
              client: { select: { displayName: true } },
            },
          },
        },
      },
    },
  });

  if (occs.length === 0) return [];
  const rates = await loadRates(prisma);
  const out: GpWorkAnchoredItem[] = [];

  for (const occ of occs) {
    if (!occ.completedAt) continue;
    const completedAt = occ.completedAt; // narrow once for closure capture
    const active = occ.assignees.filter((a) => a.role !== "observer");
    if (active.length === 0) continue;

    const qualifying = active.filter(
      (a) =>
        a.user.workerType === "CONTRACTOR" &&
        (!opts?.userId || a.userId === opts.userId) &&
        wasUserInGuaranteedPayoutAt(
          {
            guaranteedPayoutUntil: a.user.guaranteedPayoutUntil,
            guaranteedPayoutStartedAt: a.user.guaranteedPayoutStartedAt,
            guaranteedPayoutHistory: a.user.guaranteedPayoutHistory,
          },
          completedAt,
        ),
    );
    if (qualifying.length === 0) continue;

    // Prefer the promisedPayouts snapshot when it exists — it was locked
    // in at completion time and reflects what each worker was actually
    // promised. Recomputing from the current price + assignees can drift
    // if the price was edited post-completion or a contractor was
    // removed pre-payment. GP guarantees pay the contractor what they
    // were promised; the snapshot IS the promise.
    const promisedPayoutsSnapshot = (occ as any).promisedPayouts as
      | Array<{ userId: string; net: number }>
      | null
      | undefined;
    const snapshotByUser = new Map<string, number>(
      Array.isArray(promisedPayoutsSnapshot)
        ? promisedPayoutsSnapshot
            .map((r: any) => [String(r.userId), Number(r.net) || 0] as [string, number])
            .filter((r) => r[1] > 0)
        : [],
    );

    // Fallback path (no snapshot OR contractor not in snapshot): compute
    // promised net the same way the snapshot would have at completion
    // time, using current price/expenses + current assignees. Preserved
    // for older data created before the snapshot feature existed.
    const completionSplits = (occ as any).completionSplits as
      | Array<{ userId: string; percent: number }>
      | null
      | undefined;
    const splitPctById = new Map<string, number>(
      Array.isArray(completionSplits)
        ? completionSplits.map((s: any) => [s.userId, Number(s.percent) || 0])
        : [],
    );
    const fallbackPct = active.length > 0 ? 100 / active.length : 0;
    const workersList: WorkerInput[] = active.map((a) => ({
      userId: a.userId,
      splitPercent: splitPctById.get(a.userId) ?? fallbackPct,
      workerType: a.user.workerType,
    }));
    const priceTotal =
      ((occ as any).price ?? (occ as any).proposalAmount ?? 0) +
      (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
    const expTotal = (occ.expenses ?? []).reduce(
      (s, e) => s + (e.cost ?? 0),
      0,
    );
    const fallbackBreakdown = computeBreakdown(priceTotal, expTotal, workersList, rates);

    for (const q of qualifying) {
      const snapshotNet = snapshotByUser.get(q.userId);
      let amount: number;
      if (snapshotNet != null && snapshotNet > 0) {
        amount = round2(snapshotNet);
      } else {
        const promisedRow = fallbackBreakdown.find((r) => r.userId === q.userId);
        if (!promisedRow || promisedRow.net <= 0) continue;
        amount = round2(promisedRow.net);
      }
      const property = (occ as any).job?.property
        ? {
            displayName: (occ as any).job.property.displayName as string | null,
            clientDisplayName: (occ as any).job.property.client?.displayName ?? null,
          }
        : null;
      out.push({
        userId: q.userId,
        occurrenceId: occ.id,
        amount,
        completedAt,
        contractor: {
          id: q.user.id,
          displayName: q.user.displayName,
          email: q.user.email,
        },
        property,
      });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gusto Contractors CSV — one row per 1099 contractor with total paid.
//
// PURE READ. Idempotent: same (start, end) → same CSV, no DB writes.
//
// Two sources of pay aggregated per contractor:
//   (a) Payment-anchored (post-GP path): confirmed PaymentSplits in
//       window, EXCLUDING any flagged with guaranteedPayoutPaidAt
//       (those splits' contractor was in GP at occurrence completion and
//       was already paid on the wage-path payroll cycle for that work).
//   (b) Work-anchored (GP path): for any contractor in their guaranteed-
//       payout period at the moment their occurrence completed, paid
//       like a W-2 employee — included on the contractor CSV for the
//       period the work fell in, NOT the period the client eventually
//       paid. Computed from JobOccurrence.completedAt + promisedPayouts
//       snapshot.
//
// Cross-week dedup: when the client eventually pays for a GP-period
// occurrence, the resulting PaymentSplit is created with
// guaranteedPayoutPaidAt set (see fetchAdvanceFlagsByUser — same
// derivation as half (b) here). Half (a) skips those splits, so the
// contractor is never paid for the same work twice.
//
// Idempotency contract: this function never inserts into
// GuaranteedPayoutAdvance (or anywhere else). Gusto is the system of
// record for what was actually paid. The app is the calculator that
// computes "what should be on this CSV given current data" — the same
// answer every time.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// QB Income CSV — one row per confirmed Payment.
//
// Column shape (7 core spec columns + trailing extras QB ignores on import):
//   Date, Description, Amount, Account, Reference ID, Category, Tax Line,
//   Customer, Property, Method, Vendor, Invoice #, Job ID
//
// • Reference ID = `PAY-{cuid}` so QB can dedupe on re-import and the
//   three QB CSVs never collide.
// • Account = "Services" — the default QB Simple Start income account for a
//   service business. Operator can re-map in QB at import time.
// • Tax Line = "1" (Schedule C Gross receipts or sales).
// • Category is blank — only meaningful for expenses.
// ─────────────────────────────────────────────────────────────────────────────
// Default values used when the EQUIPMENT_RENTAL_INCOME_CONFIG setting is
// missing, blank, or unparseable. Mirrors the existing fallback patterns
// for other config-driven export taxonomies (EXPENSE_CATEGORIES, etc.).
const EQUIPMENT_RENTAL_INCOME_CONFIG_DEFAULT = {
  // QB chart-of-accounts entry name. Must match the operator's QB
  // configuration exactly (capitalization + spacing) for the CSV import
  // to route to the right account.
  qbAccount: "Equipment Rental Income",
  // Schedule C line number. Default "1" = Gross receipts (alongside
  // service revenue). Some CPAs prefer "6" (Other gross receipts) for
  // a separate visibility — flip via the setting, not the code.
  scheduleCLine: "1",
};



// ─────────────────────────────────────────────────────────────────────────────
// QB Expenses CSV — BusinessExpense rows in [start, end] (date field). Pulls
// only the BusinessExpense table to avoid double-counting: every per-job
// Expense and SupplyPurchase has a paired BusinessExpense row already, so
// pulling only BE gives the canonical, deduped set.
// ─────────────────────────────────────────────────────────────────────────────
// Capitalization policy. The start date is fixed in code — it anchors when
// the business adopted Fixed Asset accounting. The dollar threshold is
// operator-editable via the FIXED_ASSET_MIN_COST setting so the de minimis
// limit can be raised (e.g. to $2,500 to match the IRS safe harbor) without
// a redeploy.
const FIXED_ASSET_START_DATE = new Date("2026-05-28T00:00:00.000Z");
const FIXED_ASSET_MIN_COST_DEFAULT = 500;

/**
 * Load the configured FIXED_ASSET_MIN_COST. Returns the default if the
 * setting is missing, blank, non-numeric, or non-positive — a malformed
 * value should not silently disable the capitalization split.
 */
export async function loadFixedAssetMinCost(
  client: typeof prisma | any = prisma,
): Promise<number> {
  const row = await client.setting.findUnique({ where: { key: "FIXED_ASSET_MIN_COST" } });
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : FIXED_ASSET_MIN_COST_DEFAULT;
}

export function isFixedAsset(be: { cost: number; date: Date }, minCost: number): boolean {
  return be.cost >= minCost && be.date.getTime() >= FIXED_ASSET_START_DATE.getTime();
}

/**
 * Build the where clause that selects BusinessExpense rows whose
 * **effective** date falls in [start, end]:
 *
 * - **Freestanding** BE (no `occurrenceId`): anchored on `BE.date` —
 *   the date the operator typed when logging the expense.
 * - **Per-occurrence** BE (linked to a JobOccurrence): anchored on
 *   `occurrence.completedAt`. If the occurrence hasn't been completed
 *   yet, the row is excluded from every window — the expense isn't
 *   "real" until the job actually happens. This matches the operator's
 *   mental model: planning an expense for a future job shouldn't
 *   inflate this period's expenses.
 *
 * The `type` filter is the caller's responsibility (EXPENSE vs equity
 * vs both) — this helper only handles the anchoring.
 */
export function expenseAnchorDateWhere(start: Date, end: Date) {
  return {
    OR: [
      { occurrenceId: null, date: { gte: start, lte: end } },
      {
        occurrenceId: { not: null },
        occurrence: { completedAt: { gte: start, lte: end, not: null } },
      },
    ],
  };
}

/**
 * Returns the **effective** date for a BusinessExpense row — the date
 * that should appear on the QB CSV row and that the export window
 * compares against. Matches the anchoring rule in
 * `expenseAnchorDateWhere`.
 */
export function effectiveExpenseDate(be: {
  date: Date;
  occurrenceId?: string | null;
  occurrence?: { completedAt: Date | null } | null;
}): Date {
  if (be.occurrenceId && be.occurrence?.completedAt) return be.occurrence.completedAt;
  return be.date;
}

/**
 * Whether qb-journal-expenses.csv should emit Contract Labor rows.
 * Setting: QB_INCLUDE_CONTRACT_LABOR (boolean). Default = true (current
 * behavior — the app's CSV is the only path getting contractor labor
 * into QB). Flip to false once Gusto's QuickBooks integration is
 * configured to post contractor payments directly; the app's rows
 * become duplicative at that point.
 */

// Synthetic category for processor-fee rows — sourced from Payment records,
// never a hand-logged BusinessExpense. Its Schedule C line comes from the
// EXPENSE_CATEGORIES taxonomy like any other category.
const PROCESSOR_FEE_CATEGORY = "Payment Processing Fees";

// Synthetic category for Contract Labor rows — sourced from PaymentSplit
// records (one row per non-W-2 contractor split on a confirmed payment).
// The label must match the EXPENSE_CATEGORIES entry exactly so the QB
// account + Schedule C line resolve through the same taxonomy lookup
// every other expense row uses.
const CONTRACT_LABOR_CATEGORY = "Contract labor";



// QuickBooks Equity export — owner capital contributions and owner draws.
// These are equity-account movements (balance-sheet), not P&L. The CPA imports
// them into the corresponding equity accounts; do NOT mix into qb-expenses.
//
// Account names match the QB chart of accounts the operator has configured
// (plural — "Owner Investments" / "Owner Draws"). Must match QB exactly
// (capitalization / spacing) for the import to land in the right account.
const QB_EQUITY_ACCOUNT: Record<"CAPITAL_CONTRIBUTION" | "OWNER_DRAW", string> = {
  CAPITAL_CONTRIBUTION: "Owner Investments",
  OWNER_DRAW: "Owner Draws",
};


// ─────────────────────────────────────────────────────────────────────────────
// QB Fixed Assets CSV — BusinessExpense purchases ≥ $500 dated on/after the
// capitalization policy start date. These hit a Fixed Asset account on the
// balance sheet (depreciated over the asset's useful life), NOT the P&L —
// so they're excluded from qb-expenses.csv to avoid double-counting.
//
// Operator workflow after import: open each asset in QB, set the Fixed
// Asset sub-account (Vehicles / Machinery / etc.), useful life, and
// depreciation method. The CSV gets every asset on the books; the CPA
// drives the depreciation entries from there.
// ─────────────────────────────────────────────────────────────────────────────

// A single row that would land as "Unmapped" in qb-expenses.csv — i.e. its


// ─────────────────────────────────────────────────────────────────────────────
// Preview CSVs — replacement for the old QB + Gusto exports.
//
// The Money → Preview tab supersedes Money → Exports. The operator's new
// workflow doesn't use the app to import into QB or Gusto directly; QB
// is bank-fed and is the source of truth. These two CSVs are
// reconciliation aids — quick visual checks that what's in the app
// matches what landed in QB.
//
//   • expensesCsv  → flat list of money OUT (BusinessExpense rows of
//                    type EXPENSE only) for the date range. P&L-side
//                    items. Excludes equity (CAPITAL_CONTRIBUTION /
//                    OWNER_DRAW) — those flow through the separate
//                    capitalCsv since they hit equity accounts on the
//                    balance sheet, not the P&L.
//
//   • capitalCsv   → equity-only flat list: CAPITAL_CONTRIBUTION rows
//                    (owner puts money in) and OWNER_DRAW rows (owner
//                    takes money out). Kept separate from expensesCsv
//                    so the operator can validate equity activity
//                    against the equity accounts in their accounting
//                    software without mixing in P&L expenses.
//
//   • incomeCsv    → one row per inflow source in the window. Service
//                    payments produce one row per PaymentSplit (worker
//                    payouts AND owner-earnings rows, so the business's
//                    own cut is visible). Equipment rentals produce one
//                    row per Checkout. Each row carries the parent
//                    payment's gross / processor fee / net so operator
//                    can match against bank deposit entries.
//
// All three anchor on effective dates (occurrence.completedAt for
// per-job expenses, Payment.confirmedAt for worker rows, BE.date for
// freestanding rows) so they match what actually hit the bank — same
// cash-basis rules accounting software enforces.
// ─────────────────────────────────────────────────────────────────────────────

export async function expensesCsv(start: Date, end: Date): Promise<CsvResult> {
  // EXPENSE-type BusinessExpense rows only — operating cash-out, the
  // P&L side of the books. Anchored on effective date so per-occurrence
  // expenses on future jobs don't appear until those jobs complete.
  // Equity entries (CAPITAL_CONTRIBUTION / OWNER_DRAW) flow through
  // capitalCsv instead — different account class, must not be mixed.
  //
  // Schedule C Line + Accounting Mapping columns join the row's
  // `category` to the EXPENSE_CATEGORIES taxonomy. Categories not in
  // the taxonomy (or no longer in it) leave those columns blank — the
  // CSV still lists the row so it isn't silently dropped.
  const [rows, categories] = await Promise.all([
    prisma.businessExpense.findMany({
      where: {
        type: "EXPENSE",
        ...expenseAnchorDateWhere(start, end),
      },
      include: {
        occurrence: { select: { completedAt: true } },
      },
    }),
    loadExpenseCategories(),
  ]);

  // Category-label → (scheduleCLine, qbAccount) lookup. Reading the
  // taxonomy once outside the row loop keeps the CSV O(rows) instead
  // of O(rows × categories) on a long history window.
  const catMeta = new Map<string, { scheduleCLine: string; accountingMapping: string }>();
  for (const c of categories) {
    catMeta.set(c.label, {
      scheduleCLine: c.scheduleCLine ?? "",
      accountingMapping: c.qbAccount ?? "",
    });
  }

  // Sort by effective date so the file reads chronologically. Within
  // the same date, alphabetize by description for stable diffs run-to-run.
  const enriched = rows
    .map((r) => ({ r, effDate: effectiveExpenseDate(r) }))
    .sort((a, b) => {
      const diff = a.effDate.getTime() - b.effDate.getTime();
      if (diff !== 0) return diff;
      return (a.r.description ?? "").localeCompare(b.r.description ?? "");
    });

  const header = [
    "Date",
    "Category",
    "Schedule C Line",
    "Accounting Mapping",
    "Description",
    "Vendor",
    "Amount",
  ];
  const lines: string[] = [csvRow(header)];
  let total = 0;
  let rowCount = 0;
  for (const { r, effDate } of enriched) {
    const meta = catMeta.get(r.category ?? "");
    lines.push(
      csvRow([
        toIsoDate(effDate),
        r.category ?? "",
        meta?.scheduleCLine ?? "",
        meta?.accountingMapping ?? "",
        r.description ?? "",
        r.vendor ?? "",
        round2(r.cost).toFixed(2),
      ]),
    );
    total += r.cost;
    rowCount += 1;
  }
  // Final TOTALS line — operator can eyeball the bottom line against
  // the in-app P&L Expenses subtotal for the same window.
  lines.push(csvRow(["TOTALS", "", "", "", "", "", round2(total).toFixed(2)]));
  return { csv: finalizeCsv(lines), rowCount, total: round2(total) };
}

export async function capitalCsv(start: Date, end: Date): Promise<CsvResult> {
  // Equity entries only — money the owner puts INTO the business
  // (CAPITAL_CONTRIBUTION) and money the owner takes OUT
  // (OWNER_DRAW). Both hit equity accounts on the balance sheet rather
  // than the P&L, which is why they're broken out from the operating
  // Expenses CSV. The accounting software typically posts them to
  // "Owner's Equity" / "Owner Draws" — match the totals against those.
  //
  // Direction column makes the IN vs OUT distinction explicit even
  // though the type label already encodes it, since some operators
  // skim the column rather than re-parsing the type string each row.
  const rows = await prisma.businessExpense.findMany({
    where: {
      type: { in: ["CAPITAL_CONTRIBUTION", "OWNER_DRAW"] },
      date: { gte: start, lte: end },
    },
    orderBy: { date: "asc" },
  });

  const header = [
    "Date",
    "Type",
    "Direction",
    "Description",
    "Amount",
  ];
  const lines: string[] = [csvRow(header)];
  let contributionTotal = 0;
  let drawTotal = 0;
  for (const r of rows) {
    const isContribution = r.type === "CAPITAL_CONTRIBUTION";
    lines.push(
      csvRow([
        toIsoDate(r.date),
        isContribution ? "Capital contribution" : "Owner draw",
        isContribution ? "In (owner → business)" : "Out (business → owner)",
        r.description ?? "",
        round2(r.cost).toFixed(2),
      ]),
    );
    if (isContribution) contributionTotal += r.cost;
    else drawTotal += r.cost;
  }
  // Three-line footer — contributions and draws shown separately so the
  // operator can match each against its own equity account without
  // having to bucket the rows themselves. Net is contributions minus
  // draws (positive = owner put more in than took out this period).
  const net = contributionTotal - drawTotal;
  lines.push(csvRow(["", "", "", "Contributions total", round2(contributionTotal).toFixed(2)]));
  lines.push(csvRow(["", "", "", "Owner draws total", round2(drawTotal).toFixed(2)]));
  lines.push(csvRow(["", "", "", "Net (contributions − draws)", round2(net).toFixed(2)]));
  return { csv: finalizeCsv(lines), rowCount: rows.length, total: round2(contributionTotal + drawTotal) };
}

export async function incomeCsv(start: Date, end: Date): Promise<CsvResult> {
  // Service-income view of every dollar that came IN during the window.
  // ONE ROW PER PAYMENT (or per equipment rental) — not per
  // PaymentSplit. The earlier split-per-row layout was diagnostic-
  // shaped (great for debugging individual worker shares) but made
  // bank-deposit reconciliation harder because every multi-worker
  // payment appeared as N rows whose Payment Gross / Processor Fee /
  // Payment Net repeated identically. Operators were summing those
  // columns and getting over-counts.
  //
  //   • Service payments → one row per confirmed, non-written-off
  //     Payment. A Workers column lists the displayNames of every
  //     non-owner-earnings split recipient (the people who actually
  //     worked the job). Worker Payouts + Owner Earnings sum to
  //     Payment Net per row.
  //
  //   • Equipment rental income → one row per Checkout with
  //     `rentalCost > 0` released in window. The renter goes in the
  //     Client / Renter column; the entire rental cost flows to
  //     Payment Net (no processor fee, no worker split).
  //
  // The Payment Net column is the canonical bank-reconciliation
  // figure. Sum it → total cash deposits for the period.
  const [payments, rentals] = await Promise.all([
    loadConfirmedPayments(start, end),
    prisma.checkout.findMany({
      where: {
        rentalCost: { gt: 0 },
        releasedAt: { gte: start, lte: end },
      },
      include: {
        equipment: { select: { shortDesc: true, brand: true, model: true } },
        user: { select: { displayName: true, email: true, workerType: true } },
      },
      orderBy: { releasedAt: "asc" },
    }),
  ]);

  // Fallback for the Job column when neither JobOccurrence.title nor
  // Job.description is set (typical for STANDARD recurring service
  // jobs — they live on a schedule, not a title). Maps the occurrence's
  // workflow to a readable phrase so the column is never silently empty.
  function workflowLabel(w: string | null | undefined): string {
    switch (w) {
      case "STANDARD": return "Recurring service";
      case "ONE_OFF": return "One-off service";
      case "ESTIMATE": return "Estimate";
      case "TASK": return "Task";
      case "REMINDER": return "Reminder";
      case "EVENT": return "Event";
      case "FOLLOWUP": return "Followup";
      case "ANNOUNCEMENT": return "Announcement";
      default: return "";
    }
  }

  type Row = {
    date: string;
    source: string;
    client: string;
    property: string;
    job: string;
    workers: string;
    method: string;
    paymentGross: number | null;
    processorFee: number | null;
    paymentNet: number | null;
    workerPayouts: number | null;
    ownerEarnings: number | null;
  };
  const rows: Row[] = [];

  for (const p of payments) {
    const occ: any = (p as any).occurrence ?? null;
    const job: any = occ?.job ?? null;
    const property: any = job?.property ?? null;
    const client: any = property?.client ?? null;
    const paymentGross = round2((p as any).grossCharged ?? p.amountPaid ?? 0);
    const processorFee = round2((p as any).processorFeeAmount ?? 0);
    const paymentNet = round2(paymentGross - processorFee);
    const dateLabel = p.confirmedAt ? toIsoDate(p.confirmedAt) : "";
    const propertyName = property?.displayName ?? "";
    const clientName = client?.displayName ?? "";
    // Job column: explicit title → workflow-derived label. We
    // intentionally do NOT fall back to job.description here — that
    // field can be a multi-sentence note about a property, which
    // clutters the CSV column when surfaced as a "job" label. The
    // description still appears on the job detail page in-app; the
    // CSV uses the consistent workflow label for any untitled row.
    const jobTitle = occ?.title?.trim() || workflowLabel(occ?.workflow);
    const method = p.method ?? "";

    // Aggregate the splits into the per-payment view: worker payouts
    // vs owner earnings totals.
    let workerPayouts = 0;
    let ownerEarnings = 0;
    for (const sp of p.splits) {
      const spAny = sp as any;
      const isOwnerCut = spAny.ownerEarnings === true;
      if (isOwnerCut) {
        ownerEarnings += sp.amount ?? 0;
      } else {
        workerPayouts += sp.amount ?? 0;
      }
    }

    // Workers column — built from the JobOccurrence assignees, NOT
    // from the PaymentSplit rows. Splits would mislead in two cases:
    // (a) owner-only jobs where the only split is owner-earnings and
    // the worker column would render empty; (b) jobs where the
    // assignee list and split list don't match (rare but possible
    // when the operator created splits manually). The assignee list
    // is the canonical "who did the work" answer.
    const workerNames: string[] = [];
    const seenWorkerIds = new Set<string>();
    for (const a of (occ?.assignees ?? []) as Array<{ userId: string; role: string | null; user: { displayName: string | null; email: string | null } | null }>) {
      // Same NULL-role inclusion rule used everywhere else in the
      // codebase — `role IS NULL` means "regular worker, no special
      // role." Only `observer` is excluded.
      if (a.role === "observer") continue;
      const name = a.user?.displayName ?? a.user?.email ?? null;
      if (name && !seenWorkerIds.has(a.userId)) {
        seenWorkerIds.add(a.userId);
        workerNames.push(name);
      }
    }
    rows.push({
      date: dateLabel,
      source: "Service",
      client: clientName,
      property: propertyName,
      job: jobTitle,
      workers: workerNames.sort((a, b) => a.localeCompare(b)).join(", "),
      method,
      paymentGross,
      processorFee,
      paymentNet,
      workerPayouts: round2(workerPayouts),
      ownerEarnings: round2(ownerEarnings),
    });
  }

  for (const c of rentals) {
    const equipName =
      [c.equipment?.brand, c.equipment?.model].filter(Boolean).join(" ") ||
      c.equipment?.shortDesc ||
      "Equipment rental";
    const rentalCost = round2(c.rentalCost ?? 0);
    // Rentals: all cash flows straight to the business bank — no
    // processor leg, no worker split, no owner-earnings line. Payment
    // Net carries the full amount so the column-total ties out to
    // every dollar deposited.
    rows.push({
      date: c.releasedAt ? toIsoDate(c.releasedAt) : "",
      source: "Equipment Rental",
      client: c.user?.displayName ?? c.user?.email ?? "",
      property: equipName,
      job: "",
      workers: "",
      method: "",
      paymentGross: rentalCost,
      processorFee: null,
      paymentNet: rentalCost,
      workerPayouts: null,
      ownerEarnings: null,
    });
  }

  // Date ASC, then by source (Equipment Rental sorts after Service —
  // payments first for each day), then by client.
  rows.sort((a, b) => {
    const dateDiff = a.date.localeCompare(b.date);
    if (dateDiff !== 0) return dateDiff;
    const sourceDiff = a.source.localeCompare(b.source);
    if (sourceDiff !== 0) return sourceDiff;
    return a.client.localeCompare(b.client);
  });

  const header = [
    "Date",
    "Source",
    "Client / Renter",
    "Property / Equipment",
    "Job",
    "Workers",
    "Payment Method",
    "Payment Gross",
    "Processor Fee",
    "Payment Net",
    "Worker Payouts",
    "Owner Earnings",
  ];
  const lines: string[] = [csvRow(header)];
  // Now that there's one row per payment (not per split), every
  // numeric-column total sums cleanly without over-counting.
  // Sanity identity: Payment Net = Worker Payouts + Owner Earnings
  // for each Service row, and Payment Net = Payment Gross for each
  // Rental row (no processor fee, no split).
  let paymentGrossTotal = 0;
  let processorFeeTotal = 0;
  let paymentNetTotal = 0;
  let workerPayoutsTotal = 0;
  let ownerEarningsTotal = 0;
  function fmtNum(n: number | null): string {
    return n == null ? "" : n.toFixed(2);
  }
  for (const r of rows) {
    lines.push(
      csvRow([
        r.date,
        r.source,
        r.client,
        r.property,
        r.job,
        r.workers,
        r.method,
        fmtNum(r.paymentGross),
        fmtNum(r.processorFee),
        fmtNum(r.paymentNet),
        fmtNum(r.workerPayouts),
        fmtNum(r.ownerEarnings),
      ]),
    );
    paymentGrossTotal += r.paymentGross ?? 0;
    processorFeeTotal += r.processorFee ?? 0;
    paymentNetTotal += r.paymentNet ?? 0;
    workerPayoutsTotal += r.workerPayouts ?? 0;
    ownerEarningsTotal += r.ownerEarnings ?? 0;
  }
  // 7 leading empties for: Date, Source, Client, Property, Job,
  // Workers, Payment Method — then the five numeric column totals.
  lines.push(
    csvRow([
      "TOTALS",
      "", "", "", "", "", "",
      round2(paymentGrossTotal).toFixed(2),
      round2(processorFeeTotal).toFixed(2),
      round2(paymentNetTotal).toFixed(2),
      round2(workerPayoutsTotal).toFixed(2),
      round2(ownerEarningsTotal).toFixed(2),
    ]),
  );
  return { csv: finalizeCsv(lines), rowCount: rows.length, total: round2(paymentNetTotal) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workdays CSV — one row per worker per workday in window. Drives payroll
// reconciliation against Gusto.
//
// Date filter routes through `workdayDate` (ET YYYY-MM-DD strings on
// WorkerWorkday), NOT the underlying timestamps. A workday that started
// at 11 PM Mon and ended at 2 AM Tue stays anchored to Monday — keeps
// the export aligned with the operator's mental model and with the
// Super → Workdays tab.
//
// Active hours computed from (endedAt − startedAt) − totalPausedMs.
// Open rows (no endedAt yet) leave Active Hours blank — they aren't a
// finished workday and shouldn't contribute to a totaled hours figure.
// The Status column distinguishes the open variants from completed/
// approved rows so the operator can spot rows that need closing.
//
// Business Start Date cutoff intentionally NOT applied — that filter is
// scoped to money/audit data per docs/FINANCIAL_SYSTEM.md; workdays are
// a labor record. Operator picks the window via the date range picker.
// ─────────────────────────────────────────────────────────────────────────────

export async function workdaysCsv(start: Date, end: Date): Promise<CsvResult> {
  // ET-anchored boundary keys. workdayDate is YYYY-MM-DD ET, so string
  // comparison is correct (lexicographic == chronological for that format).
  const fromKey = etFormatDate(start);
  const toKey = etFormatDate(end);

  const todayKey = etFormatDate(new Date());

  const [workdays, occs] = await Promise.all([
    prisma.workerWorkday.findMany({
      where: { workdayDate: { gte: fromKey, lte: toKey } },
      include: {
        user: { select: { displayName: true, email: true, workerType: true } },
        approvedBy: { select: { displayName: true, email: true } },
      },
    }),
    // Pre-fetch occurrences whose completedAt OR startAt falls anywhere
    // in the window, with their non-observer assignees + the parent
    // payment splits. Single query here drives the per-(date, worker)
    // Jobs Completed count, the today-only Jobs Remaining count, AND
    // the Net Earnings figure (sum of confirmed PaymentSplit amounts
    // attributed to work the worker did on that date).
    //
    // Owner-earnings splits and GP-flagged contractor splits are
    // filtered server-side — the former are the business's own cut
    // (not personal wage), the latter were already paid via the
    // wage-path Gusto run (would double-count). Mirrors the QB Income
    // export's filter rules.
    //
    // Only real-job workflows count for Jobs Completed / Remaining —
    // tasks / reminders / events / followups / announcements are
    // coordination items, not billable jobs.
    prisma.jobOccurrence.findMany({
      where: {
        OR: [
          { completedAt: { gte: start, lte: end } },
          { startAt: { gte: start, lte: end } },
        ],
        workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
      },
      select: {
        startAt: true,
        completedAt: true,
        status: true,
        price: true,
        completionSplits: true,
        promisedPayouts: true,
        addons: { select: { price: true } },
        expenses: { select: { cost: true } },
        assignees: {
          // role IS NULL is the common "regular worker" case — SQL
          // would drop those rows with a bare `role != 'observer'`
          // since NULL comparisons evaluate to UNKNOWN. Match the
          // pattern used elsewhere in the codebase.
          where: { OR: [{ role: null }, { role: { not: "observer" } }] },
          select: {
            userId: true,
            user: { select: { workerType: true } },
          },
        },
        payment: {
          select: {
            confirmed: true,
            writtenOff: true,
            splits: {
              where: {
                ownerEarnings: false,
                guaranteedPayoutPaidAt: null,
              },
              select: {
                userId: true,
                amount: true,
                topUpAmount: true,
              },
            },
          },
        },
      },
    }),
  ]);

  // Rates loaded once outside the loop. Used by the runtime fallback
  // (occurrences without a promisedPayouts snapshot) to derive what
  // each worker was owed at completion time. Mirrors the W-2 export's
  // approach — see services/payments.ts computeBreakdown for the math.
  const rates = await loadRates(prisma);

  // Sort: date asc, then worker display name asc. Prisma can't order by
  // joined fields cleanly so we sort in memory once.
  workdays.sort((a, b) => {
    const d = a.workdayDate.localeCompare(b.workdayDate);
    if (d !== 0) return d;
    const an = a.user.displayName ?? a.user.email ?? "";
    const bn = b.user.displayName ?? b.user.email ?? "";
    return an.localeCompare(bn);
  });

  // Build per-(workdayDate, userId) count maps.
  //   completedMap — occurrences this worker COMPLETED on this ET day
  //                  (anchored on completedAt). Counted on every row.
  //   remainingMap — occurrences this worker has SCHEDULED on this ET
  //                  day (anchored on startAt) that aren't yet
  //                  completed. Only surfaced in the CSV for today's
  //                  workdays — past-day "remaining" is ambiguous
  //                  (rescheduled? skipped? still open?), so we leave
  //                  the cell blank there per the planning discussion.
  const finishedStatuses = new Set([
    "COMPLETED", "CLOSED", "PENDING_PAYMENT", "ARCHIVED", "CANCELED",
  ]);
  const completedMap = new Map<string, number>();
  const remainingMap = new Map<string, number>();
  // Net earnings per (workdayDate, userId). Source priority:
  //
  //   1. JobOccurrence.promisedPayouts snapshot — locked at completion
  //      time, captures what each worker was OWED regardless of when
  //      (or whether) the client pays. `net` on the snapshot is
  //      already gross − fee/margin (pre-top-up), exactly what the
  //      operator needs to see for hourly-rate-vs-minimum-wage audit.
  //      This is the right answer for employees + trainees (W-2 wage
  //      workers paid via Gusto regardless of client payment) and for
  //      contractors who completed work that hasn't been paid yet.
  //
  //   2. Fallback to PaymentSplit.amount − topUpAmount on a confirmed
  //      payment — for legacy occurrences predating the snapshot
  //      feature, when the snapshot is null but a payment exists.
  //
  //   3. Otherwise zero — no snapshot, no payment, no signal.
  //
  // Owner-earnings + GP-flagged splits are filtered server-side by
  // the query; the snapshot itself never includes owner-earnings.
  const moneyMap = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  type PromisedPayoutEntry = { userId?: unknown; net?: unknown };
  function readSnapshot(raw: unknown): Map<string, number> | null {
    if (!Array.isArray(raw)) return null;
    const m = new Map<string, number>();
    for (const r of raw as PromisedPayoutEntry[]) {
      if (!r || typeof r !== "object") continue;
      const uid = typeof r.userId === "string" ? r.userId : null;
      const net = Number(r.net) || 0;
      if (uid && net !== 0) m.set(uid, (m.get(uid) ?? 0) + net);
    }
    return m.size > 0 ? m : null;
  }

  // Runtime fallback — replicates computeBreakdown at the point of
  // completion, so an occurrence missing its promisedPayouts snapshot
  // (legacy data, seeded fixtures, jobs completed before the snapshot
  // feature shipped) still produces correct per-worker net figures.
  // Returns a userId → net map matching the snapshot shape exactly.
  function computeFallbackPayouts(
    occ: (typeof occs)[number],
  ): Map<string, number> {
    const m = new Map<string, number>();
    const active = occ.assignees ?? [];
    if (active.length === 0) return m;
    const priceTotal =
      (occ.price ?? 0) +
      (occ.addons ?? []).reduce((s: number, a: any) => s + (a.price ?? 0), 0);
    const expTotal = (occ.expenses ?? []).reduce(
      (s: number, e: any) => s + (e.cost ?? 0),
      0,
    );
    const completionSplits = (occ as any).completionSplits as
      | Array<{ userId: string; percent: number }>
      | null
      | undefined;
    const splitPctById = new Map<string, number>(
      Array.isArray(completionSplits)
        ? completionSplits.map((s: any) => [s.userId, Number(s.percent) || 0])
        : [],
    );
    const fallbackPct = active.length > 0 ? 100 / active.length : 0;
    const workersList: WorkerInput[] = active.map((a: any) => ({
      userId: a.userId,
      workerType: a.user?.workerType ?? null,
      splitPercent: splitPctById.get(a.userId) ?? fallbackPct,
    }));
    const breakdown = computeBreakdown(priceTotal, expTotal, workersList, rates);
    for (const r of breakdown) {
      if (r.net !== 0) m.set(r.userId, (m.get(r.userId) ?? 0) + r.net);
    }
    return m;
  }

  for (const occ of occs) {
    if (occ.completedAt) {
      const day = etFormatDate(occ.completedAt);
      for (const a of occ.assignees) bump(completedMap, `${day}|${a.userId}`);

      // Source priority: snapshot → runtime compute → confirmed split.
      // The runtime compute uses the SAME math the snapshot would have
      // captured at completion (computeBreakdown w/ current price +
      // assignees + rates), so seeded / legacy occurrences without a
      // snapshot still produce the right per-worker net. The
      // PaymentSplit branch only matters when there's neither a
      // snapshot nor enough state to recompute (very old data).
      const snapshot = readSnapshot((occ as any).promisedPayouts);
      const earnings = snapshot ?? computeFallbackPayouts(occ);
      if (earnings.size > 0) {
        for (const [userId, net] of earnings) {
          const k = `${day}|${userId}`;
          moneyMap.set(k, (moneyMap.get(k) ?? 0) + net);
        }
      } else if (occ.payment?.confirmed && !occ.payment.writtenOff) {
        for (const sp of occ.payment.splits) {
          const k = `${day}|${sp.userId}`;
          const preTopUp = (sp.amount ?? 0) - (sp.topUpAmount ?? 0);
          moneyMap.set(k, (moneyMap.get(k) ?? 0) + preTopUp);
        }
      }
    }
    if (occ.startAt && !finishedStatuses.has(occ.status as string)) {
      const day = etFormatDate(occ.startAt);
      for (const a of occ.assignees) bump(remainingMap, `${day}|${a.userId}`);
    }
  }

  function workerTypeLabel(t: string | null | undefined): string {
    switch (t) {
      case "EMPLOYEE": return "Employee";
      case "TRAINEE": return "Trainee";
      case "CONTRACTOR": return "Contractor";
      default: return "Unclassified";
    }
  }

  // Derived status — matches the labels on the Super → Workdays tab so
  // the operator's mental model stays consistent across surfaces.
  function rowStatus(w: { endedAt: Date | null; pausedAt: Date | null; approvedAt: Date | null }): string {
    if (w.endedAt && w.approvedAt) return "Approved";
    if (w.endedAt) return "Completed";
    if (w.pausedAt) return "Paused";
    return "In progress";
  }

  const header = [
    "Date",
    "Worker",
    "Worker Type",
    "Worker Email",
    "Started At",
    "Ended At",
    "Paused Minutes",
    "Active Hours",
    "Jobs Completed",
    "Jobs Remaining",
    "Net Earnings",
    "Hourly Wage",
    "Status",
    "Approved By",
    "Approved At",
  ];

  const lines: string[] = [csvRow(header)];
  let activeHoursTotal = 0;
  let pausedMinutesTotal = 0;
  let jobsCompletedTotal = 0;
  let jobsRemainingTotal = 0;
  let netEarningsTotal = 0;
  for (const w of workdays) {
    const startedAtLabel = etFormatTimeOpts(w.startedAt, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const endedAtLabel = w.endedAt
      ? etFormatTimeOpts(w.endedAt, { hour: "2-digit", minute: "2-digit", hour12: false })
      : "";
    const pausedMinutes = Math.round((w.totalPausedMs ?? 0) / 60000);
    // Active hours only meaningful once the workday is closed. Open
    // rows leave the cell blank rather than printing a partial number
    // that would bias the TOTALS row.
    const activeHoursStr = w.endedAt
      ? round2(
          (w.endedAt.getTime() - w.startedAt.getTime() - (w.totalPausedMs ?? 0)) / 3600000,
        ).toFixed(2)
      : "";
    const approvedAtLabel = w.approvedAt
      ? `${etFormatDate(w.approvedAt)} ${etFormatTimeOpts(w.approvedAt, { hour: "2-digit", minute: "2-digit", hour12: false })}`
      : "";
    const mapKey = `${w.workdayDate}|${w.userId}`;
    const jobsCompleted = completedMap.get(mapKey) ?? 0;
    // Remaining only populates for today's row — past-day "remaining"
    // is ambiguous (rescheduled vs. skipped vs. still open). For past
    // dates the cell is blank so the operator doesn't misread a count
    // as "this worker had N unfinished jobs that day."
    const isTodayRow = w.workdayDate === todayKey;
    const jobsRemaining = isTodayRow ? (remainingMap.get(mapKey) ?? 0) : null;
    const netEarnings = round2(moneyMap.get(mapKey) ?? 0);
    // Hourly wage = earnings ÷ active hours, only when both are
    // meaningful. Open workdays (no Active Hours) render blank for
    // Hourly Wage too — can't divide by a partial running clock.
    const activeHoursNum = activeHoursStr !== "" ? Number(activeHoursStr) : 0;
    const hourlyWageStr = activeHoursStr !== "" && activeHoursNum > 0
      ? round2(netEarnings / activeHoursNum).toFixed(2)
      : "";
    lines.push(
      csvRow([
        w.workdayDate,
        w.user.displayName ?? w.user.email ?? "(unnamed)",
        workerTypeLabel(w.user.workerType),
        w.user.email ?? "",
        startedAtLabel,
        endedAtLabel,
        pausedMinutes.toString(),
        activeHoursStr,
        jobsCompleted.toString(),
        jobsRemaining == null ? "" : jobsRemaining.toString(),
        netEarnings.toFixed(2),
        hourlyWageStr,
        rowStatus(w),
        w.approvedBy?.displayName ?? w.approvedBy?.email ?? "",
        approvedAtLabel,
      ]),
    );
    if (activeHoursStr !== "") activeHoursTotal += Number(activeHoursStr);
    pausedMinutesTotal += pausedMinutes;
    jobsCompletedTotal += jobsCompleted;
    if (jobsRemaining != null) jobsRemainingTotal += jobsRemaining;
    netEarningsTotal += netEarnings;
  }
  // TOTALS row — sums numeric columns. Hourly Wage is intentionally
  // blank: each row's hourly is a per-worker figure (their own pay ÷
  // their own hours); a single aggregate cell at the bottom would
  // average across workers, which isn't anyone's actual rate and
  // misleads more than it helps. The earnings + hours totals are
  // still there so the operator can compute a blended figure
  // themselves if they want.
  lines.push(
    csvRow([
      "TOTALS",
      "", "", "", "", "",
      pausedMinutesTotal.toString(),
      round2(activeHoursTotal).toFixed(2),
      jobsCompletedTotal.toString(),
      jobsRemainingTotal.toString(),
      round2(netEarningsTotal).toFixed(2),
      "",
      "", "", "",
    ]),
  );
  return { csv: finalizeCsv(lines), rowCount: workdays.length, total: round2(activeHoursTotal) };
}
