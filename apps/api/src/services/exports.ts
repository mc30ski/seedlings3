import { prisma } from "../db/prisma";
import { loadQbAccountMap, loadScheduleCLineMap } from "./expenseCategories";
import { generateLedgerId } from "../lib/ledgerId";
import {
  computeBreakdown,
  loadRates,
  wasUserInGuaranteedPayoutAt,
  type WorkerInput,
} from "./payments";

// Returned by every CSV builder. `rowCount` counts data rows only (excludes
// header + TOTALS); `total` is the dollar figure on the TOTALS line. The
// route layer persists these to ExportRun so the history view eyeballs
// against the file without re-parsing the bytes.
export type CsvResult = {
  csv: string;
  rowCount: number;
  total: number;
};

// CSV-export service. All exports are super-admin-gated at the route layer.
// Cash-basis: Payment.confirmedAt anchors all payment-derived rows so that
// unconfirmed (pending-approval) payments are never counted as income or wages.
//
// Returns plain CSV strings (route layer sets Content-Type and Content-Disposition).
// Every CSV ends with a TOTALS row for eyeball verification against the
// in-app PaymentsTab numbers.

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

function toIsoDate(d: Date): string {
  // YYYY-MM-DD in UTC. The route layer accepts caller-provided start/end as
  // YYYY-MM-DD and converts to inclusive day boundaries before calling here.
  return d.toISOString().slice(0, 10);
}

// MM/DD/YYYY in UTC. QuickBooks' CSV importer parses this format by default.
function toQbDate(d: Date): string {
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD
  const [y, m, day] = iso.split("-");
  return `${m}/${day}/${y}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// QuickBooks Online journal-entry import format.
//
// The QB income and expenses CSVs both use the canonical 10-column journal-
// entry shape so the operator can import them straight into QB Online's
// "Journal Entries" importer without re-shaping. Every source transaction
// emits a balanced pair of rows (debit + credit) sharing the same JournalNo;
// the second row's JournalDate is blank (QB groups by adjacent JournalNo and
// expects the date only on the leader row).
//
// Counter-account for both directions is `APP_CLEARING_ACCOUNT` — a clearing
// account the operator sets up in QB. Income debits clearing, then credits
// the income account; expenses debit the expense account, then credit
// clearing. When a real bank deposit/withdrawal lands in QB, it offsets the
// clearing balance, and the operator reconciles the two sides.
// ─────────────────────────────────────────────────────────────────────────────
const JOURNAL_HEADER = [
  "*JournalNo",
  "*JournalDate",
  "*AccountName",
  "*Debits",
  "*Credits",
  "Description",
  "Name",
  "Currency",
  "Location",
  "Class",
];

const APP_CLEARING_ACCOUNT = "App Clearing Account";

function incomeJournalRows(
  journalNo: string,
  dateStr: string,
  incomeAccount: string,
  amount: number,
  description: string,
  name: string,
): string[] {
  const amt = round2(amount).toFixed(2);
  return [
    csvRow([journalNo, dateStr, APP_CLEARING_ACCOUNT, amt, "", description, name, "", "", ""]),
    csvRow([journalNo, "", incomeAccount, "", amt, description, name, "", "", ""]),
  ];
}

function expenseJournalRows(
  journalNo: string,
  dateStr: string,
  expenseAccount: string,
  amount: number,
  description: string,
  name: string,
): string[] {
  const amt = round2(amount).toFixed(2);
  return [
    csvRow([journalNo, dateStr, expenseAccount, amt, "", description, name, "", "", ""]),
    csvRow([journalNo, "", APP_CLEARING_ACCOUNT, "", amt, description, name, "", "", ""]),
  ];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isEmployeeClass(t: string | null | undefined): boolean {
  return t === "EMPLOYEE" || t === "TRAINEE";
}

function splitName(displayName: string | null | undefined): { first: string; last: string } {
  if (!displayName) return { first: "", last: "" };
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

// Wall-clock hours each worker spent on an occurrence. Use this for
// payroll exports: every active worker on a job clocked in for the full
// wall-clock duration, so they each get reported the same number of hours.
// Returns 0 if the job isn't timed.
//
// Example: 2 workers on a job that ran 20 wall-clock minutes →
// wallClockHoursPerWorker = 0.333 → each W-2 worker reports 20 minutes,
// total W-2 labor on this job = 40 person-minutes.
function wallClockHoursPerWorker(occ: {
  startedAt: Date | null;
  completedAt: Date | null;
  totalPausedMs: number | null;
}): number {
  if (!occ.startedAt || !occ.completedAt) return 0;
  const elapsedMs = occ.completedAt.getTime() - occ.startedAt.getTime() - (occ.totalPausedMs ?? 0);
  if (elapsedMs <= 0) return 0;
  return elapsedMs / 1000 / 3600;
}

// Labor effort split across active workers — wall-clock hours DIVIDED by
// the crew size. Use this for cost-allocation views (e.g. "share of job
// duration per worker"), NOT for payroll. For the same 2-worker / 20-min
// example, this returns 0.167h per worker (10 min). Currently has no
// callers; kept for future cost-allocation reports so the math intent
// stays explicit (don't reach for `wallClockHoursPerWorker` for this
// purpose by mistake).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function laborSplitHoursPerWorker(occ: {
  startedAt: Date | null;
  completedAt: Date | null;
  totalPausedMs: number | null;
  assigneeCount: number;
}): number {
  const wall = wallClockHoursPerWorker(occ);
  if (wall === 0) return 0;
  return wall / Math.max(1, occ.assigneeCount);
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
      splits: {
        // Exclude owner-earnings splits from every export. The owner takes a
        // draw, not a paycheck — they should never appear in Gusto payroll
        // or in worker payout reports.
        where: { ownerEarnings: false },
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

async function loadEmployeeMarginPercent(): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT" },
  });
  return Number(row?.value ?? 0) || 0;
}

// Completed STANDARD/ONE_OFF occurrences in the window — the W-2 wage events.
// hoursApprovedAt filter is the payroll-integrity gate: occurrences whose
// hours haven't been admin-approved are excluded from the export. They
// surface in the title-bar alert and the Exports tab pre-download warning
// until reviewed (or hours edited back within tolerance to auto-approve).
async function loadCompletedOccurrences(start: Date, end: Date) {
  return prisma.jobOccurrence.findMany({
    where: {
      completedAt: { gte: start, lte: end },
      status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
      workflow: { in: ["STANDARD", "ONE_OFF"] as any },
      hoursApprovedAt: { not: null },
    },
    select: {
      id: true,
      startedAt: true,
      completedAt: true,
      totalPausedMs: true,
      price: true,
      proposalAmount: true,
      promisedPayouts: true,
      completionSplits: true,
      addons: { select: { price: true } },
      expenses: { select: { cost: true } },
      assignees: {
        select: {
          userId: true,
          role: true,
          user: {
            select: { id: true, displayName: true, email: true, workerType: true, isOwner: true },
          },
        },
      },
    },
  });
}

/**
 * Aggregate W-2 (employee + trainee) earnings for the window, work-anchored.
 * Shared by the CSV export and the preview.
 */
async function computeW2Earnings(start: Date, end: Date): Promise<W2Agg[]> {
  const [occs, marginPct] = await Promise.all([
    loadCompletedOccurrences(start, end),
    loadEmployeeMarginPercent(),
  ]);
  const byWorker = new Map<string, W2Agg>();

  for (const occ of occs) {
    const active = occ.assignees.filter((a) => a.role !== "observer");
    if (active.length === 0) continue;
    // Each active worker is paid for the full wall-clock duration they
    // clocked in for — NOT a divided share of it. Total W-2 labor hours
    // logged for the job = wallClockHours × workerCount.
    const occHours = wallClockHoursPerWorker({
      startedAt: occ.startedAt,
      completedAt: occ.completedAt,
      totalPausedMs: occ.totalPausedMs,
    });
    const priceTotal =
      (occ.price ?? occ.proposalAmount ?? 0) +
      (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
    const expTotal = (occ.expenses ?? []).reduce((s, e) => s + (e.cost ?? 0), 0);
    const N = Math.max(0, priceTotal - expTotal);
    const promised = (occ.promisedPayouts as Array<{ userId: string; net: number }> | null) ?? null;
    const splitPctById = new Map<string, number>(
      (Array.isArray(occ.completionSplits) ? occ.completionSplits : []).map((s: any) => [s.userId, Number(s.percent) || 0]),
    );

    for (const a of active) {
      if (!isEmployeeClass(a.user.workerType)) continue;
      if (a.user.isOwner) continue; // owner takes a draw — never on payroll
      // Promised net: snapshot if present, else computed.
      let net: number;
      const snap = promised?.find((r) => r.userId === a.userId);
      if (snap) {
        net = snap.net;
      } else {
        const fraction = splitPctById.has(a.userId)
          ? (splitPctById.get(a.userId) ?? 0) / 100
          : 1 / active.length;
        const grossShare = N * fraction;
        net = grossShare * (1 - marginPct / 100);
      }
      const k = a.userId;
      const cur = byWorker.get(k);
      const { first, last } = splitName(a.user.displayName);
      if (cur) {
        cur.hours += occHours;
        cur.gross += net;
        cur.jobs += 1;
      } else {
        byWorker.set(k, {
          userId: k,
          first,
          last,
          email: a.user.email ?? "",
          workerType: a.user.workerType ?? "",
          hours: occHours,
          gross: net,
          jobs: 1,
        });
      }
    }
  }
  return Array.from(byWorker.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Gusto W-2 CSV — one row per employee/trainee with totals in the period.
// ─────────────────────────────────────────────────────────────────────────────
export async function gustoW2Csv(start: Date, end: Date): Promise<CsvResult> {
  const rows = (await computeW2Earnings(start, end)).sort((a, b) =>
    (a.last || a.first).localeCompare(b.last || b.first),
  );

  const header = [
    "First Name",
    "Last Name",
    "Email",
    "Worker Type",
    "Hours Worked",
    "Gross Pay",
    "# of Jobs",
    "Pay Period Start",
    "Pay Period End",
  ];
  const lines: string[] = [csvRow(header)];
  let totalHours = 0;
  let totalGross = 0;
  let totalJobs = 0;
  const startStr = toIsoDate(start);
  const endStr = toIsoDate(end);
  for (const r of rows) {
    lines.push(
      csvRow([
        r.first,
        r.last,
        r.email,
        r.workerType,
        round2(r.hours).toFixed(2),
        round2(r.gross).toFixed(2),
        r.jobs,
        startStr,
        endStr,
      ]),
    );
    totalHours += r.hours;
    totalGross += r.gross;
    totalJobs += r.jobs;
  }
  lines.push(
    csvRow([
      "TOTALS",
      "",
      "",
      "",
      round2(totalHours).toFixed(2),
      round2(totalGross).toFixed(2),
      totalJobs,
      "",
      "",
    ]),
  );
  return { csv: lines.join("\n") + "\n", rowCount: rows.length, total: round2(totalGross) };
}

// Computes the work-anchored GP advance candidates for a window WITHOUT
// writing any advance rows. Shared by gustoContractorsCsv (which then
// inserts the rows) and exportPreview (read-only — just needs the totals
// for the Exports tab UI). Returns one entry per (user × occurrence)
// that would receive an advance on this export run.
//
// Eligibility = active OR historical GP period covers occurrence.completedAt
//   AND no GuaranteedPayoutAdvance exists yet for this (user, occurrence)
//   AND no PaymentSplit exists for this user on this occurrence's payment
//       (client hasn't paid → standard payment-anchored flow doesn't cover it)
export type GpAdvanceCandidate = {
  userId: string;
  occurrenceId: string;
  amount: number;
  contractor: { id: string; displayName: string | null; email: string | null };
};

async function loadGpAdvanceCandidates(
  start: Date,
  end: Date,
): Promise<GpAdvanceCandidate[]> {
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
          user: { workerType: "CONTRACTOR" },
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
      payment: { include: { splits: { select: { userId: true } } } },
    },
  });

  if (occs.length === 0) return [];
  const rates = await loadRates(prisma);
  const out: GpAdvanceCandidate[] = [];

  for (const occ of occs) {
    if (!occ.completedAt) continue;
    const completedAt = occ.completedAt; // narrow once for closure capture
    const active = occ.assignees.filter((a) => a.role !== "observer");
    if (active.length === 0) continue;

    const qualifying = active.filter(
      (a) =>
        a.user.workerType === "CONTRACTOR" &&
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

    const existingAdvances = await prisma.guaranteedPayoutAdvance.findMany({
      where: {
        occurrenceId: occ.id,
        userId: { in: qualifying.map((q) => q.userId) },
      },
      select: { userId: true },
    });
    const advancedUserIds = new Set(existingAdvances.map((a) => a.userId));
    const splitUserIds = new Set(
      (occ.payment?.splits ?? []).map((s: any) => s.userId),
    );
    const eligible = qualifying.filter(
      (q) => !advancedUserIds.has(q.userId) && !splitUserIds.has(q.userId),
    );
    if (eligible.length === 0) continue;

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
    const promised = computeBreakdown(priceTotal, expTotal, workersList, rates);

    for (const q of eligible) {
      const promisedRow = promised.find((r) => r.userId === q.userId);
      if (!promisedRow || promisedRow.net <= 0) continue;
      out.push({
        userId: q.userId,
        occurrenceId: occ.id,
        amount: round2(promisedRow.net),
        contractor: {
          id: q.user.id,
          displayName: q.user.displayName,
          email: q.user.email,
        },
      });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gusto Contractors CSV — one row per 1099 contractor with total paid.
//
// Two sources of pay aggregated per contractor:
//   (a) Payment-anchored: confirmed PaymentSplits in window, EXCLUDING any
//       flagged with guaranteedPayoutPaidAt (those splits were already
//       disbursed via a prior GP advance and re-counting them would
//       double-pay).
//   (b) Work-anchored GP advance: for any contractor with an active OR
//       historical GP period covering an occurrence's completedAt, find
//       completed-in-window occurrences they were active assignee on
//       where no PaymentSplit exists yet (client hasn't paid) AND no
//       prior GuaranteedPayoutAdvance exists. Compute promised net via
//       canonical computeBreakdown, ADD to CSV total, INSERT advance row.
//
// The advance INSERT is what makes the next client-payment cycle reconcile
// correctly: payments.ts split-creation hooks find the advance and stamp
// guaranteedPayoutPaidAt on the resulting split, taking it out of the
// payment-anchored bucket above. See feature memo `feature_guaranteed_payout`.
// ─────────────────────────────────────────────────────────────────────────────
export async function gustoContractorsCsv(
  start: Date,
  end: Date,
  exportedByUserId?: string | null,
): Promise<CsvResult> {
  const payments = await loadConfirmedPayments(start, end);

  type Agg = {
    userId: string;
    first: string;
    last: string;
    email: string;
    total: number;
    jobs: number;
  };
  const byWorker = new Map<string, Agg>();

  // (a) Payment-anchored part: confirmed PaymentSplits, minus GP-flagged.
  for (const p of payments) {
    for (const sp of p.splits) {
      if (isEmployeeClass(sp.user.workerType)) continue;
      // Skip splits already disbursed via GP advance — the contractor
      // received this money out-of-band on a prior payroll cycle.
      if ((sp as any).guaranteedPayoutPaidAt != null) continue;
      const k = sp.user.id;
      const cur = byWorker.get(k);
      const { first, last } = splitName(sp.user.displayName);
      if (cur) {
        cur.total += sp.amount;
        cur.jobs += 1;
      } else {
        byWorker.set(k, {
          userId: k,
          first,
          last,
          email: sp.user.email ?? "",
          total: sp.amount,
          jobs: 1,
        });
      }
    }
  }

  // (b) Work-anchored GP advance part. Use the shared candidate finder
  // (preview also uses it for read-only totals), then persist each
  // candidate as a GuaranteedPayoutAdvance row + roll into byWorker.
  // Unique constraint on (userId, occurrenceId) is the idempotency
  // belt-and-suspenders.
  const candidates = await loadGpAdvanceCandidates(start, end);
  if (candidates.length > 0) {
    const exportedAtNow = new Date();
    for (const c of candidates) {
      await prisma.guaranteedPayoutAdvance.create({
        data: {
          ledgerId: generateLedgerId(),
          userId: c.userId,
          occurrenceId: c.occurrenceId,
          amount: c.amount,
          exportedAt: exportedAtNow,
          exportedByUserId: exportedByUserId ?? null,
        },
      });

      const cur = byWorker.get(c.userId);
      const { first, last } = splitName(c.contractor.displayName);
      if (cur) {
        cur.total += c.amount;
        cur.jobs += 1;
      } else {
        byWorker.set(c.userId, {
          userId: c.userId,
          first,
          last,
          email: c.contractor.email ?? "",
          total: c.amount,
          jobs: 1,
        });
      }
    }
  }

  const rows = Array.from(byWorker.values()).sort((a, b) =>
    (a.last || a.first).localeCompare(b.last || b.first),
  );

  const header = [
    "First Name",
    "Last Name",
    "Email",
    "Total Paid",
    "# of Jobs",
    "Pay Period Start",
    "Pay Period End",
  ];
  const lines: string[] = [csvRow(header)];
  let totalPaid = 0;
  let totalJobs = 0;
  const startStr = toIsoDate(start);
  const endStr = toIsoDate(end);
  for (const r of rows) {
    lines.push(
      csvRow([
        r.first,
        r.last,
        r.email,
        round2(r.total).toFixed(2),
        r.jobs,
        startStr,
        endStr,
      ]),
    );
    totalPaid += r.total;
    totalJobs += r.jobs;
  }
  lines.push(
    csvRow([
      "TOTALS",
      "",
      "",
      round2(totalPaid).toFixed(2),
      totalJobs,
      "",
      "",
    ]),
  );
  return { csv: lines.join("\n") + "\n", rowCount: rows.length, total: round2(totalPaid) };
}

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

async function loadEquipmentRentalIncomeConfig(
  client: typeof prisma | any = prisma,
): Promise<{ qbAccount: string; scheduleCLine: string }> {
  const row = await client.setting.findUnique({
    where: { key: "EQUIPMENT_RENTAL_INCOME_CONFIG" },
  });
  if (!row?.value) return EQUIPMENT_RENTAL_INCOME_CONFIG_DEFAULT;
  try {
    const parsed = JSON.parse(row.value);
    return {
      qbAccount:
        typeof parsed?.qbAccount === "string" && parsed.qbAccount.trim()
          ? parsed.qbAccount.trim()
          : EQUIPMENT_RENTAL_INCOME_CONFIG_DEFAULT.qbAccount,
      scheduleCLine:
        typeof parsed?.scheduleCLine === "string" && parsed.scheduleCLine.trim()
          ? parsed.scheduleCLine.trim()
          : EQUIPMENT_RENTAL_INCOME_CONFIG_DEFAULT.scheduleCLine,
    };
  } catch {
    // Malformed JSON — fall back to defaults rather than blow up the
    // entire export. The operator will notice the wrong values in QB
    // on import, which is the right surface for catching this.
    return EQUIPMENT_RENTAL_INCOME_CONFIG_DEFAULT;
  }
}

export async function qbIncomeCsv(start: Date, end: Date): Promise<CsvResult> {
  // Income comes from two sources:
  //   1. Confirmed Payment rows — client → business job payments
  //   2. Equipment rental Checkouts — contractor → business equipment income
  //      (see memory/project_equipment_rental_income.md)
  // Both are raw cash-flow fields. No derived values participate.
  const [payments, equipmentRentals, rentalIncomeConfig] = await Promise.all([
    loadConfirmedPayments(start, end),
    // Pull every checkout released in the window with a positive billed
    // total — but also fetch the per-worker CheckoutSplit rows so we can
    // attribute group-rental income to each individual contractor. Solo
    // rentals have no splits and emit a single row at Checkout.rentalCost
    // (= the solo contractor's full amount, or 0 for solo employees).
    // Group rentals emit one row per contractor split (amount > 0); the
    // employee/trainee splits have amount = 0 and are filtered out.
    prisma.checkout.findMany({
      where: {
        rentalCost: { gt: 0 },
        releasedAt: { gte: start, lte: end },
      },
      include: {
        equipment: { select: { id: true, shortDesc: true, brand: true, model: true } },
        user: { select: { id: true, displayName: true, email: true } },
        splits: {
          where: { amount: { gt: 0 } },
          include: { user: { select: { id: true, displayName: true, email: true } } },
        },
      },
      orderBy: { releasedAt: "asc" },
    }),
    loadEquipmentRentalIncomeConfig(),
  ]);

  // Journal-entry format: every source transaction emits a balanced
  // debit/credit pair. Income flow:
  //   Row 1: debit  App Clearing Account
  //   Row 2: credit the configured income account
  // Both rows share JournalNo; only Row 1 carries JournalDate. No TOTALS
  // row — QB rejects rows it can't categorize as journal lines.
  const lines: string[] = [csvRow(JOURNAL_HEADER)];
  let total = 0;
  let transactionCount = 0;

  const SERVICE_INCOME_ACCOUNT = "Services";

  // Job-payment income. JournalNo = Payment.ledgerId (SLC-YYMMDD-XXXX).
  // Legacy `PAY-{cuid}` is the defensive fallback only for rows that
  // somehow escaped backfill — should never happen post-backfill.
  for (const p of payments) {
    const prop = p.occurrence.job?.property;
    const customer = prop?.client?.displayName ?? "";
    const description =
      p.note?.trim() ||
      `Service payment${customer ? ` — ${customer}` : ""}${prop?.displayName ? ` (${prop.displayName})` : ""}`;
    const dateStr = p.confirmedAt ? toQbDate(p.confirmedAt) : "";
    lines.push(
      ...incomeJournalRows(
        (p as any).ledgerId ?? `PAY-${p.id}`,
        dateStr,
        SERVICE_INCOME_ACCOUNT,
        p.amountPaid,
        description,
        customer,
      ),
    );
    total += p.amountPaid;
    transactionCount += 1;
  }

  // Equipment rental income. Solo rentals → one journal per checkout
  // (JournalNo = Checkout.ledgerId). Group rentals → one journal per
  // contractor split; the split's JournalNo derives from the parent
  // Checkout's ledgerId + last 4 chars of the userId (uppercased) so
  // the entry stays distinct per contractor and fits under QB's 21-char
  // JournalNo limit.
  for (const c of equipmentRentals) {
    if (!c.releasedAt) continue;
    const eqLabel = [c.equipment.brand, c.equipment.model].filter(Boolean).join(" ") || c.equipment.shortDesc;
    const descPrefix = `Equipment rental — ${eqLabel}${c.rentalDays ? ` (${c.rentalDays}d)` : ""}`;
    const dateStr = toQbDate(c.releasedAt);
    const parentLedger = (c as any).ledgerId as string | null | undefined;

    if (c.splits.length > 0) {
      for (const sp of c.splits) {
        if (sp.amount == null || sp.amount <= 0) continue;
        const contractorName = sp.user.displayName ?? sp.user.email ?? sp.user.id;
        const journalNo = parentLedger
          ? `${parentLedger}-${sp.userId.slice(-4).toUpperCase()}`
          : `RENT-${c.id}-${sp.userId}`;
        lines.push(
          ...incomeJournalRows(
            journalNo,
            dateStr,
            rentalIncomeConfig.qbAccount,
            sp.amount,
            descPrefix,
            contractorName,
          ),
        );
        total += sp.amount;
        transactionCount += 1;
      }
    } else {
      if (c.rentalCost == null || c.rentalCost <= 0) continue;
      const contractorName = c.user.displayName ?? c.user.email ?? c.user.id;
      lines.push(
        ...incomeJournalRows(
          parentLedger ?? `RENT-${c.id}`,
          dateStr,
          rentalIncomeConfig.qbAccount,
          c.rentalCost,
          descPrefix,
          contractorName,
        ),
      );
      total += c.rentalCost;
      transactionCount += 1;
    }
  }

  // rowCount = source transaction count (NOT line count) so downstream
  // displays still read "N payments + M rentals" rather than 2× that.
  return { csv: lines.join("\n") + "\n", rowCount: transactionCount, total: round2(total) };
}

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
async function loadFixedAssetMinCost(
  client: typeof prisma | any = prisma,
): Promise<number> {
  const row = await client.setting.findUnique({ where: { key: "FIXED_ASSET_MIN_COST" } });
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : FIXED_ASSET_MIN_COST_DEFAULT;
}

function isFixedAsset(be: { cost: number; date: Date }, minCost: number): boolean {
  return be.cost >= minCost && be.date.getTime() >= FIXED_ASSET_START_DATE.getTime();
}

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

export async function qbExpensesCsv(start: Date, end: Date): Promise<CsvResult> {
  const [rows, feePayments, payments] = await Promise.all([
    prisma.businessExpense.findMany({
      // QB Expenses export — Schedule C lines apply only to operating
      // expenses. Equity entries flow through qbEquityCsv.
      where: { type: "EXPENSE", date: { gte: start, lte: end } },
      include: {
        occurrence: {
          select: {
            id: true,
            job: {
              select: {
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
      },
      orderBy: { date: "asc" },
    }),
    // Processor fees ride alongside business expenses in the QB export. We
    // tag them with category "Payment Processing Fees" so QB sorts them into
    // their own line on import — and so this app never has to maintain a
    // synthetic BusinessExpense row for fees the bank statement already
    // shows. Filtered to confirmed, non-zero-fee, non-written-off rows.
    prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
        processorFeeAmount: { gt: 0 },
      },
      select: {
        id: true,
        // Parent ledgerId is required — the processor-fee JournalNo derives
        // from it as `{ledgerId}-F`. Without this select, ledgerId comes
        // through as undefined and the export falls back to the legacy
        // FEE-{cuid} format which exceeds QB's 21-char doc_num limit.
        ledgerId: true,
        method: true,
        confirmedAt: true,
        processorFeeAmount: true,
        grossCharged: true,
        occurrence: {
          select: {
            id: true,
            job: {
              select: {
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
      },
      orderBy: { confirmedAt: "asc" },
    }),
    // Confirmed payments with their splits — used to synthesize one
    // Contract Labor expense row per contractor PaymentSplit. The loader
    // already filters out ownerEarnings splits (owner takes a draw, not a
    // 1099). Employee/trainee splits are filtered below; their wages flow
    // through the W-2 (Gusto) export, never QB Expenses.
    loadConfirmedPayments(start, end),
  ]);

  // QB chart-of-accounts mapping comes from the EXPENSE_CATEGORIES taxonomy
  // (Settings-editable). A category whose qbAccount is null lands as
  // "Unmapped" so the operator re-categorizes inside QB after import.
  // Schedule C line numbers no longer ride along on the journal-entry
  // format (journal entries route purely by AccountName), but the line
  // mapping is still used by the unmapped-rows preflight elsewhere.
  const [qbAccountMap, fixedAssetMinCost] = await Promise.all([
    loadQbAccountMap(),
    loadFixedAssetMinCost(),
  ]);

  // Journal-entry format. Each source transaction emits a balanced pair:
  //   Row 1: debit  the mapped expense account (sub-accounts use colon)
  //   Row 2: credit App Clearing Account
  // No TOTALS row — QB rejects unbalanced footer rows.
  const lines: string[] = [csvRow(JOURNAL_HEADER)];
  let total = 0;
  let transactionCount = 0;

  // Fixed-asset purchases are excluded — they belong on the balance sheet
  // (qb-fixed-assets export) not the P&L journal.
  // Operating expenses. JournalNo = BusinessExpense.ledgerId.
  const expenseRows = rows.filter((r) => !isFixedAsset(r, fixedAssetMinCost));
  for (const r of expenseRows) {
    const category = r.category ?? "Other";
    const account = qbAccountMap[category] ?? "Unmapped";
    const prop = r.occurrence?.job?.property;
    const clientName = prop?.client?.displayName ?? "";
    // Name column intentionally blank on expense rows. QB's journal-entry
    // importer rejects a Name that isn't already on the Vendor/Customer
    // list; with the column blank, every row imports cleanly without the
    // operator pre-creating every vendor. Vendor + client name are still
    // surfaced in the Description column for traceability.
    const vendorTrace = (r.vendor ?? "").trim() || clientName;
    const descWithVendor = vendorTrace
      ? `${r.description ?? ""}${r.description ? " · " : ""}${vendorTrace}`
      : (r.description ?? "");
    lines.push(
      ...expenseJournalRows(
        (r as any).ledgerId ?? `EXP-${r.id}`,
        toQbDate(r.date),
        account,
        r.cost,
        descWithVendor,
        "",
      ),
    );
    total += r.cost;
    transactionCount += 1;
  }

  // Processor-fee journals. No DB row — JournalNo derives from the parent
  // Payment.ledgerId with a `-F` suffix (e.g. SLC-260605-X7K2-F = 17 chars).
  for (const p of feePayments) {
    const prop = p.occurrence?.job?.property;
    const clientName = prop?.client?.displayName ?? "";
    const propName = prop?.displayName ?? "";
    const desc = `${p.method} fee on ${clientName}${propName ? ` — ${propName}` : ""} (gross $${round2(p.grossCharged ?? 0).toFixed(2)}, payment ${p.id})`;
    const account = qbAccountMap[PROCESSOR_FEE_CATEGORY] ?? "Unmapped";
    const parentLedger = (p as any).ledgerId as string | null | undefined;
    const journalNo = parentLedger ? `${parentLedger}-F` : `FEE-${p.id}`;
    lines.push(
      ...expenseJournalRows(
        journalNo,
        p.confirmedAt ? toQbDate(p.confirmedAt) : "",
        account,
        p.processorFeeAmount ?? 0,
        desc,
        "", // Name intentionally blank — see operating-expense loop above.
      ),
    );
    total += p.processorFeeAmount ?? 0;
    transactionCount += 1;
  }

  // Contract Labor journals — one per non-flagged contractor PaymentSplit.
  // JournalNo derives from the parent Payment.ledgerId + last 4 chars of
  // the contractor's userId (uppercased). Unique per (payment, contractor)
  // and survives split delete+recreate at reconciliation — the parent
  // payment's ledgerId is stable.
  const contractLaborAccount = qbAccountMap[CONTRACT_LABOR_CATEGORY] ?? "Unmapped";
  for (const p of payments) {
    const prop = p.occurrence?.job?.property;
    const clientName = prop?.client?.displayName ?? "";
    const parentLedger = (p as any).ledgerId as string | null | undefined;
    for (const sp of p.splits) {
      if (isEmployeeClass(sp.user.workerType)) continue;
      if ((sp as any).guaranteedPayoutPaidAt != null) continue;
      const vendor = sp.user.displayName ?? sp.user.email ?? "";
      const desc = `Contractor payout to ${vendor}${clientName ? ` for ${clientName}` : ""}${prop?.displayName ? ` (${prop.displayName})` : ""}`;
      const journalNo = parentLedger
        ? `${parentLedger}-${sp.userId.slice(-4).toUpperCase()}`
        : `CL-${sp.id}`;
      lines.push(
        ...expenseJournalRows(
          journalNo,
          p.confirmedAt ? toQbDate(p.confirmedAt) : "",
          contractLaborAccount,
          sp.amount,
          desc,
          "", // Name intentionally blank — see operating-expense loop above.
        ),
      );
      total += sp.amount;
      transactionCount += 1;
    }
  }

  // GP advance journals.
  const gpAdvances = await prisma.guaranteedPayoutAdvance.findMany({
    where: { exportedAt: { gte: start, lte: end } },
    include: {
      user: { select: { displayName: true, email: true } },
      occurrence: {
        select: {
          id: true,
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
      },
    },
    orderBy: { exportedAt: "asc" },
  });
  for (const adv of gpAdvances) {
    const prop = adv.occurrence?.job?.property;
    const clientName = prop?.client?.displayName ?? "";
    const vendor = adv.user?.displayName ?? adv.user?.email ?? "";
    const desc = `Contractor advance (guaranteed payout) to ${vendor}${clientName ? ` for ${clientName}` : ""}${prop?.displayName ? ` (${prop.displayName})` : ""}`;
    lines.push(
      ...expenseJournalRows(
        (adv as any).ledgerId ?? `GPA-${adv.id}`,
        toQbDate(adv.exportedAt),
        contractLaborAccount,
        adv.amount,
        desc,
        "", // Name intentionally blank — see operating-expense loop above.
      ),
    );
    total += adv.amount;
    transactionCount += 1;
  }

  return {
    csv: lines.join("\n") + "\n",
    rowCount: transactionCount,
    total: round2(total),
  };
}


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

export async function qbEquityCsv(start: Date, end: Date): Promise<CsvResult> {
  const rows = await prisma.businessExpense.findMany({
    where: {
      type: { in: ["CAPITAL_CONTRIBUTION", "OWNER_DRAW"] },
      date: { gte: start, lte: end },
    },
    orderBy: [{ date: "asc" }, { type: "asc" }],
  });

  // Column shape (7 core spec columns + trailing extras QB ignores):
  //   Date, Description, Amount, Account, Reference ID, Category, Tax Line,
  //   Customer, Property, Method, Vendor, Invoice #, Job ID
  //
  // Reference ID: `EXP-{id}` — equity entries are BusinessExpense rows.
  // Tax Line is blank because equity movements are balance-sheet, not Schedule C.
  // Customer/Property/Method/Vendor/Invoice #/Job ID are always blank — the
  // only sides of an equity entry are the owner and the business.
  // Notes (if any) are appended to Description so no information is lost.
  const header = [
    "Date",
    "Description",
    "Amount",
    "Account",
    "Reference ID",
    "Category",
    "Tax Line",
    "Customer",
    "Property",
    "Method",
    "Vendor",
    "Invoice #",
    "Job ID",
  ];
  const lines: string[] = [csvRow(header)];
  let contributionTotal = 0;
  let drawTotal = 0;
  for (const r of rows) {
    const typeKey = r.type as "CAPITAL_CONTRIBUTION" | "OWNER_DRAW";
    const account = QB_EQUITY_ACCOUNT[typeKey];
    const category = typeKey === "CAPITAL_CONTRIBUTION" ? "Capital Contribution" : "Owner Draw";
    const amount = round2(r.cost);
    const desc = [r.description, r.notes].filter((s) => s && s.trim()).join(" — ");
    lines.push(
      csvRow([
        toQbDate(r.date),
        desc,
        amount.toFixed(2),
        account,
        `EXP-${r.id}`,
        category,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]),
    );
    if (typeKey === "CAPITAL_CONTRIBUTION") contributionTotal += amount;
    else drawTotal += amount;
  }
  // Two sub-totals so the CPA / spreadsheet check eyeballs each equity
  // account independently — they post to different lines in QB.
  const blank10 = ["", "", "", "", "", "", "", "", "", ""];
  lines.push(csvRow(["SUBTOTAL Capital Contributions", "", round2(contributionTotal).toFixed(2), ...blank10]));
  lines.push(csvRow(["SUBTOTAL Owner Draws", "", round2(drawTotal).toFixed(2), ...blank10]));
  lines.push(csvRow(["TOTALS", "", round2(contributionTotal + drawTotal).toFixed(2), ...blank10]));
  return {
    csv: lines.join("\n") + "\n",
    rowCount: rows.length,
    total: round2(contributionTotal + drawTotal),
  };
}

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
export async function qbFixedAssetsCsv(start: Date, end: Date): Promise<CsvResult> {
  // Push the threshold into the query so the DB does the heavy lifting and
  // we don't pull the whole expense table just to filter in JS. If the
  // window ends before the policy start date, there can be no fixed-asset
  // rows in range — skip the query entirely.
  const fixedAssetMinCost = await loadFixedAssetMinCost();
  const effectiveStart = start < FIXED_ASSET_START_DATE ? FIXED_ASSET_START_DATE : start;
  const rows =
    end < FIXED_ASSET_START_DATE
      ? []
      : await prisma.businessExpense.findMany({
          where: {
            type: "EXPENSE",
            date: { gte: effectiveStart, lte: end },
            cost: { gte: fixedAssetMinCost },
          },
          include: {
            equipment: { select: { id: true, shortDesc: true, brand: true, model: true } },
            occurrence: {
              select: {
                id: true,
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
            },
          },
          orderBy: { date: "asc" },
        });

  // Same 13-column shape as the other QB CSVs so the operator can eyeball
  // them side-by-side. Account = "Fixed Assets" (generic catch-all); the
  // operator re-assigns to a specific Fixed Asset sub-account in QB at
  // import time. Tax Line is blank (fixed assets aren't a Schedule C line —
  // depreciation entries come later and live on line 13 via the regular
  // expense path).
  const header = [
    "Date",
    "Description",
    "Amount",
    "Account",
    "Reference ID",
    "Category",
    "Tax Line",
    "Customer",
    "Property",
    "Method",
    "Vendor",
    "Invoice #",
    "Job ID",
  ];
  const lines: string[] = [csvRow(header)];
  let total = 0;
  for (const r of rows) {
    const prop = r.occurrence?.job?.property;
    const equipName = r.equipment
      ? r.equipment.shortDesc ||
        [r.equipment.brand, r.equipment.model].filter(Boolean).join(" ")
      : "";
    const description = [r.description, equipName ? `(${equipName})` : null]
      .filter(Boolean)
      .join(" ");
    lines.push(
      csvRow([
        toQbDate(r.date),
        description,
        round2(r.cost).toFixed(2),
        "Fixed Assets",
        `EXP-${r.id}`,
        r.category ?? "",
        "",
        prop?.client?.displayName ?? "",
        prop?.displayName ?? "",
        "",
        r.vendor ?? "",
        r.invoiceNumber ?? "",
        r.occurrence?.id ?? "",
      ]),
    );
    total += r.cost;
  }
  lines.push(
    csvRow([
      "TOTALS",
      "",
      round2(total).toFixed(2),
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
    ]),
  );
  return { csv: lines.join("\n") + "\n", rowCount: rows.length, total: round2(total) };
}

// A single row that would land as "Unmapped" in qb-expenses.csv — i.e. its
// category has no qbAccount mapping in the EXPENSE_CATEGORIES taxonomy. The
// Exports tab uses this list to BLOCK the download (single CSV + zip) and
// surface the refs so the operator can re-categorize in Settings.
export type UnmappedExpenseRow = {
  ref: string;          // EXP-{id} / FEE-{id} / CL-{id}
  date: string;         // MM/DD/YYYY
  description: string;
  category: string;     // The taxonomy label that has no qbAccount.
  amount: number;
};

/**
 * Scan every row that would appear in qb-expenses.csv and return the ones
 * whose category resolves to qbAccount = null. Equity rows are NOT included
 * (qb-equity.csv has its own hardcoded account names, no taxonomy lookup).
 *
 * Used by exportPreview AND by the route guard so unmapped rows block the
 * download before the file is ever generated.
 */
export async function findUnmappedExpenseRows(
  start: Date,
  end: Date,
): Promise<UnmappedExpenseRow[]> {
  const [businessExpenses, feePayments, payments, qbAccountMap] = await Promise.all([
    prisma.businessExpense.findMany({
      where: { type: "EXPENSE", date: { gte: start, lte: end } },
      orderBy: { date: "asc" },
    }),
    prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
        processorFeeAmount: { gt: 0 },
      },
      select: { id: true, confirmedAt: true, processorFeeAmount: true, method: true },
      orderBy: { confirmedAt: "asc" },
    }),
    loadConfirmedPayments(start, end),
    loadQbAccountMap(),
  ]);
  const fixedAssetMinCost = await loadFixedAssetMinCost();

  const unmapped: UnmappedExpenseRow[] = [];

  for (const r of businessExpenses) {
    // Fixed-asset rows never appear in qb-expenses.csv, so their category
    // never needs a qbAccount mapping — skip the unmapped check for them.
    if (isFixedAsset(r, fixedAssetMinCost)) continue;
    const category = r.category ?? "Other";
    if (!qbAccountMap[category]) {
      unmapped.push({
        ref: `EXP-${r.id}`,
        date: toQbDate(r.date),
        description: r.description ?? "",
        category,
        amount: round2(r.cost),
      });
    }
  }
  // Processor fees and Contract Labor are synthetic categories — they only
  // appear unmapped if the operator removed those entries from the taxonomy.
  // Cheap to check, prevents a silent "Unmapped" surprise in the CSV.
  if (!qbAccountMap[PROCESSOR_FEE_CATEGORY]) {
    for (const p of feePayments) {
      unmapped.push({
        ref: `FEE-${p.id}`,
        date: p.confirmedAt ? toQbDate(p.confirmedAt) : "",
        description: `${p.method ?? ""} processor fee`,
        category: PROCESSOR_FEE_CATEGORY,
        amount: round2(p.processorFeeAmount ?? 0),
      });
    }
  }
  if (!qbAccountMap[CONTRACT_LABOR_CATEGORY]) {
    for (const p of payments) {
      for (const sp of p.splits) {
        if (isEmployeeClass(sp.user.workerType)) continue;
        // Splits already disbursed via GP advance get a `GPA-` ref row
        // separately (below); don't double-count.
        if ((sp as any).guaranteedPayoutPaidAt != null) continue;
        unmapped.push({
          ref: `CL-${sp.id}`,
          date: p.confirmedAt ? toQbDate(p.confirmedAt) : "",
          description: `Contractor payout to ${sp.user.displayName ?? sp.user.email ?? ""}`,
          category: CONTRACT_LABOR_CATEGORY,
          amount: round2(sp.amount),
        });
      }
    }
    // GP advances also land in Contract Labor; warn the same way if the
    // category is unmapped so the operator doesn't ship an "Unmapped"
    // row to QB.
    const advances = await prisma.guaranteedPayoutAdvance.findMany({
      where: { exportedAt: { gte: start, lte: end } },
      include: { user: { select: { displayName: true, email: true } } },
    });
    for (const adv of advances) {
      unmapped.push({
        ref: `GPA-${adv.id}`,
        date: toQbDate(adv.exportedAt),
        description: `Contractor advance (guaranteed payout) to ${adv.user?.displayName ?? adv.user?.email ?? ""}`,
        category: CONTRACT_LABOR_CATEGORY,
        amount: round2(adv.amount),
      });
    }
  }
  return unmapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview — JSON sanity figures for the Exports tab page (row counts + totals
// for each of the four files). Avoids the user having to download just to peek.
// ─────────────────────────────────────────────────────────────────────────────
export type ExportPreview = {
  gustoW2: {
    workers: number;
    hours: number;
    gross: number;
    // Count of completed STANDARD/ONE_OFF occurrences in the window whose
    // hours haven't been admin-approved. Excluded from the export — surfaced
    // as a pre-download warning so the operator can review first.
    unapprovedOccurrences: number;
  };
  gustoContractors: { workers: number; gross: number };
  qbIncome: { rows: number; total: number };
  qbExpenses: {
    rows: number;
    total: number;
    businessExpenseTotal: number;
    processorFeeTotal: number;
    // Contractor (1099) payouts synthesized from PaymentSplit rows. Counted
    // here because the QB Expenses CSV includes one Contract Labor row per
    // contractor split; not double-counted against the Gusto Contractors
    // export (which is a separate Gusto-side input, not a QB import).
    contractLaborTotal: number;
    // Rows whose category has no QB chart-of-accounts mapping — would land
    // as "Unmapped" in the CSV. Non-empty array BLOCKS the qb-expenses.csv
    // and qb-bundle.zip downloads at the route layer; the Exports tab
    // surfaces the list so the operator can re-categorize in Settings.
    unmappedRows: UnmappedExpenseRow[];
  };
  qbEquity: {
    rows: number;
    contributionTotal: number;
    drawTotal: number;
  };
  // Fixed-asset purchases (cost ≥ FIXED_ASSET_MIN_COST setting, on/after the
  // policy start date) — pulled OUT of qbExpenses since they hit a
  // balance-sheet Fixed Asset account rather than a P&L expense line.
  // `threshold` is the live configured cutoff so UI hint text stays in sync
  // with the setting.
  qbFixedAssets: { rows: number; total: number; threshold: number };
};

export async function exportPreview(start: Date, end: Date): Promise<ExportPreview> {
  const payments = await loadConfirmedPayments(start, end);

  // W-2 preview — work-anchored, same source as the W-2 CSV (completed jobs +
  // promised net). NOT payment-anchored, so it ties out to the export.
  const w2Rows = await computeW2Earnings(start, end);
  const w2Hours = w2Rows.reduce((s, r) => s + r.hours, 0);
  const w2Gross = w2Rows.reduce((s, r) => s + r.gross, 0);
  // Count of W-2-relevant occurrences in the window whose hours haven't
  // been approved yet — they were excluded from w2Rows above. The Exports
  // tab surfaces this as a pre-download warning.
  const unapprovedW2Occurrences = await prisma.jobOccurrence.count({
    where: {
      completedAt: { gte: start, lte: end },
      status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
      workflow: { in: ["STANDARD", "ONE_OFF"] as any },
      hoursApprovedAt: null,
    },
  });

  // Contractors stay payment-anchored — sum their splits on confirmed payments.
  // Contractor numbers split two ways:
  //   gustoContractor*  = what the next Gusto Contractors CSV will show
  //                       (non-flagged splits in window + GP candidates
  //                        this run would CREATE). Prior advances aren't
  //                        included because they appeared on a prior CSV.
  //   qbContractLabor*  = what the QB Expenses CSV's Contract Labor
  //                       section will show (non-flagged splits + GP
  //                       candidates + prior advances dated in window —
  //                        all three are Contract Labor expense events).
  // The two were equivalent before Slice 2; Slice 2's reconciliation
  // bookkeeping splits them.
  const gustoContractorWorkers = new Set<string>();
  let gustoContractorGross = 0;
  let qbContractLaborRows = 0;
  let qbContractLaborTotal = 0;
  for (const p of payments) {
    for (const sp of p.splits) {
      if (isEmployeeClass(sp.user.workerType)) continue;
      // Flagged splits don't appear in either CSV — they're already
      // counted via the matching advance row (in window or prior).
      if ((sp as any).guaranteedPayoutPaidAt != null) continue;
      gustoContractorWorkers.add(sp.user.id);
      gustoContractorGross += sp.amount;
      qbContractLaborRows += 1;
      qbContractLaborTotal += sp.amount;
    }
  }
  // GP candidates this run WOULD create — read-only here, so preview
  // matches what the actual export will produce. Goes into both Gusto
  // (this period's payout) and QB (this period's Contract Labor).
  const gpCandidates = await loadGpAdvanceCandidates(start, end);
  for (const c of gpCandidates) {
    gustoContractorWorkers.add(c.userId);
    gustoContractorGross += c.amount;
    qbContractLaborRows += 1;
    qbContractLaborTotal += c.amount;
  }
  // Prior advance rows with exportedAt in window — only on QB (already
  // paid via the previous run's CSV, so they don't re-appear on Gusto).
  // The candidate query filters out already-advanced (userId,
  // occurrenceId) pairs so these don't overlap with gpCandidates.
  const priorAdvances = await prisma.guaranteedPayoutAdvance.findMany({
    where: { exportedAt: { gte: start, lte: end } },
    select: { amount: true },
  });
  for (const a of priorAdvances) {
    qbContractLaborRows += 1;
    qbContractLaborTotal += a.amount;
  }

  const qbIncomeTotal = payments.reduce((s, p) => s + p.amountPaid, 0);

  const expenses = await prisma.businessExpense.findMany({
    // Preview row count + total for the QB Expenses CSV button. Equity
    // entries (contributions/draws) export via the QB Equity CSV — different
    // account class, must not be mixed into the expense total. Fixed-asset
    // rows are split out below so they don't double-count against expenses.
    where: { type: "EXPENSE", date: { gte: start, lte: end } },
    select: { cost: true, date: true },
  });
  const fixedAssetMinCost = await loadFixedAssetMinCost();
  const fixedAssetExpenses = expenses.filter((e) => isFixedAsset(e, fixedAssetMinCost));
  const operatingExpenses = expenses.filter((e) => !isFixedAsset(e, fixedAssetMinCost));
  const businessExpenseTotal = operatingExpenses.reduce((s, e) => s + e.cost, 0);
  const fixedAssetTotal = fixedAssetExpenses.reduce((s, e) => s + e.cost, 0);
  const processorFeeTotal = payments.reduce((s, p) => s + (p.processorFeeAmount ?? 0), 0);
  const processorFeeRows = payments.filter((p) => (p.processorFeeAmount ?? 0) > 0).length;

  // Equity preview — capital contributions + owner draws in range, summed
  // separately so the CPA-facing tab shows both numbers up front.
  const equityRows = await prisma.businessExpense.findMany({
    where: {
      type: { in: ["CAPITAL_CONTRIBUTION", "OWNER_DRAW"] },
      date: { gte: start, lte: end },
    },
    select: { type: true, cost: true },
  });
  let contributionTotal = 0;
  let drawTotal = 0;
  for (const r of equityRows) {
    if (r.type === "CAPITAL_CONTRIBUTION") contributionTotal += r.cost;
    else if (r.type === "OWNER_DRAW") drawTotal += r.cost;
  }

  const unmappedRows = await findUnmappedExpenseRows(start, end);

  return {
    gustoW2: {
      workers: w2Rows.length,
      hours: round2(w2Hours),
      gross: round2(w2Gross),
      unapprovedOccurrences: unapprovedW2Occurrences,
    },
    gustoContractors: {
      workers: gustoContractorWorkers.size,
      gross: round2(gustoContractorGross),
    },
    qbIncome: {
      rows: payments.length,
      total: round2(qbIncomeTotal),
    },
    qbExpenses: {
      rows: operatingExpenses.length + processorFeeRows + qbContractLaborRows,
      total: round2(businessExpenseTotal + processorFeeTotal + qbContractLaborTotal),
      // Sub-totals exposed for the Exports tab preview
      // ("$X expenses + $Y fees + $Z contractor labor").
      businessExpenseTotal: round2(businessExpenseTotal),
      processorFeeTotal: round2(processorFeeTotal),
      contractLaborTotal: round2(qbContractLaborTotal),
      unmappedRows,
    },
    qbEquity: {
      rows: equityRows.length,
      contributionTotal: round2(contributionTotal),
      drawTotal: round2(drawTotal),
    },
    qbFixedAssets: {
      rows: fixedAssetExpenses.length,
      total: round2(fixedAssetTotal),
      threshold: fixedAssetMinCost,
    },
  };
}
