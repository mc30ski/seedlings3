import { prisma } from "../db/prisma";
import { etFormatDate } from "../lib/dates";
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
  if (/^[=+\-@\t\r]/.test(s)) {
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
          startedAt: true,
          completedAt: true,
          totalPausedMs: true,
          assignees: {
            select: {
              userId: true,
              role: true,
            },
          },
          job: {
            select: {
              // Job doesn't have a `title` field — the operator-facing
              // label on each row uses JobOccurrence.title (selected
              // above) and falls back to Job.description.
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
  const rows = await prisma.businessExpense.findMany({
    where: {
      type: "EXPENSE",
      ...expenseAnchorDateWhere(start, end),
    },
    include: {
      occurrence: { select: { completedAt: true } },
    },
  });

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
    "Description",
    "Vendor",
    "Amount",
  ];
  const lines: string[] = [csvRow(header)];
  let total = 0;
  let rowCount = 0;
  for (const { r, effDate } of enriched) {
    lines.push(
      csvRow([
        toIsoDate(effDate),
        r.category ?? "",
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
  lines.push(csvRow(["TOTALS", "", "", "", round2(total).toFixed(2)]));
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
  // Comprehensive per-row view of every dollar that came IN during the
  // window:
  //
  //   • Service payments → one row per PaymentSplit on every confirmed,
  //     non-written-off payment. Both worker payouts AND owner-earnings
  //     splits surface (the owner-earnings ones are the business's own
  //     cut of the payment, which is income to the business). Each row
  //     also carries the parent payment's Gross / Processor Fee / Net
  //     so the operator can reconcile against bank deposit entries.
  //
  //   • Equipment rental income → one row per Checkout with
  //     `rentalCost > 0` released in window. Income to the business
  //     from a contractor renter; processor fee is zero.
  //
  // The Amount column on each row is that row's own contribution to
  // income; summing Amount across the whole file = total inflow for
  // the period. Gross / Fee / Net intentionally do NOT sum across rows
  // (they'd double-count when a payment has multiple splits).
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

  // Recipient-type label (operator-facing). For service payments this
  // is the split user's WorkerType; for owner-earnings splits we
  // override to "Owner" so the operator can see at a glance which
  // rows are the business's own cut. Equipment rental is its own
  // category since the recipient ("Business") isn't a worker.
  function recipientType(t: string | null | undefined): string {
    switch (t) {
      case "EMPLOYEE": return "Employee";
      case "TRAINEE": return "Trainee";
      case "CONTRACTOR": return "Contractor";
      default: return "Unclassified";
    }
  }

  type Row = {
    date: string;
    source: string;       // "Service" or "Equipment Rental"
    recipient: string;    // worker name OR "Business" for rental income
    recipientType: string;
    recipientEmail: string;
    client: string;       // client name (service) or renter name (rental)
    property: string;     // property name (service) or equipment name (rental)
    job: string;          // job title (service) or empty (rental)
    method: string;
    grossCharged: number;
    processorFee: number;
    netReceived: number;
    amount: number;
  };
  const rows: Row[] = [];

  for (const p of payments) {
    const occ: any = (p as any).occurrence ?? null;
    const job: any = occ?.job ?? null;
    const property: any = job?.property ?? null;
    const client: any = property?.client ?? null;
    const grossCharged = round2((p as any).grossCharged ?? p.amountPaid ?? 0);
    const processorFee = round2((p as any).processorFeeAmount ?? 0);
    const netReceived = round2(grossCharged - processorFee);
    const dateLabel = p.confirmedAt ? toIsoDate(p.confirmedAt) : "";
    const propertyName = property?.displayName ?? "";
    const clientName = client?.displayName ?? "";
    const jobTitle = occ?.title ?? job?.description ?? "";
    const method = p.method ?? "";
    for (const sp of p.splits) {
      const user = sp.user;
      const isOwnerCut = (sp as any).ownerEarnings === true;
      rows.push({
        date: dateLabel,
        source: "Service",
        recipient: user.displayName ?? user.email ?? "(unnamed)",
        recipientType: isOwnerCut ? "Owner" : recipientType(user.workerType),
        recipientEmail: user.email ?? "",
        client: clientName,
        property: propertyName,
        job: jobTitle,
        method,
        grossCharged,
        processorFee,
        netReceived,
        amount: round2(sp.amount ?? 0),
      });
    }
  }

  for (const c of rentals) {
    const equipName =
      [c.equipment?.brand, c.equipment?.model].filter(Boolean).join(" ") ||
      c.equipment?.shortDesc ||
      "Equipment rental";
    const rentalCost = round2(c.rentalCost ?? 0);
    rows.push({
      date: c.releasedAt ? toIsoDate(c.releasedAt) : "",
      source: "Equipment Rental",
      recipient: "Business",
      recipientType: "Business",
      recipientEmail: "",
      client: c.user?.displayName ?? c.user?.email ?? "",
      property: equipName,
      job: "",
      method: "",
      grossCharged: rentalCost,
      processorFee: 0,
      netReceived: rentalCost,
      amount: rentalCost,
    });
  }

  // Date ASC, then by source (Equipment Rental sorts after Service —
  // payments first for each day), then by recipient.
  rows.sort((a, b) => {
    const dateDiff = a.date.localeCompare(b.date);
    if (dateDiff !== 0) return dateDiff;
    const sourceDiff = a.source.localeCompare(b.source);
    if (sourceDiff !== 0) return sourceDiff;
    return a.recipient.localeCompare(b.recipient);
  });

  const header = [
    "Date",
    "Source",
    "Recipient",
    "Recipient Type",
    "Recipient Email",
    "Client / Renter",
    "Property / Equipment",
    "Job",
    "Payment Method",
    "Gross Charged",
    "Processor Fee",
    "Net Received",
    "Amount",
  ];
  const lines: string[] = [csvRow(header)];
  let amountTotal = 0;
  for (const r of rows) {
    lines.push(
      csvRow([
        r.date,
        r.source,
        r.recipient,
        r.recipientType,
        r.recipientEmail,
        r.client,
        r.property,
        r.job,
        r.method,
        r.grossCharged.toFixed(2),
        r.processorFee.toFixed(2),
        r.netReceived.toFixed(2),
        r.amount.toFixed(2),
      ]),
    );
    amountTotal += r.amount;
  }
  // TOTALS sums the Amount column only — that captures total inflow
  // (worker payouts + business's cut + equipment rental income).
  // Gross/Fee/Net are intentionally NOT totaled — they'd double-count
  // when a payment has multiple splits.
  lines.push(
    csvRow([
      "TOTALS",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      round2(amountTotal).toFixed(2),
    ]),
  );
  return { csv: finalizeCsv(lines), rowCount: rows.length, total: round2(amountTotal) };
}
