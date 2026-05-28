import { prisma } from "../db/prisma";
import { loadQbAccountMap, loadScheduleCLineMap } from "./expenseCategories";

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

// ─────────────────────────────────────────────────────────────────────────────
// Gusto Contractors CSV — one row per 1099 contractor with total paid.
// ─────────────────────────────────────────────────────────────────────────────
export async function gustoContractorsCsv(start: Date, end: Date): Promise<CsvResult> {
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

  for (const p of payments) {
    for (const sp of p.splits) {
      if (isEmployeeClass(sp.user.workerType)) continue;
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
export async function qbIncomeCsv(start: Date, end: Date): Promise<CsvResult> {
  const payments = await loadConfirmedPayments(start, end);

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
  for (const p of payments) {
    const prop = p.occurrence.job?.property;
    const propLabel = [prop?.displayName, prop?.street1, prop?.city, prop?.state]
      .filter(Boolean)
      .join(" — ");
    const customer = prop?.client?.displayName ?? "";
    const description =
      p.note?.trim() ||
      `Service payment${customer ? ` — ${customer}` : ""}${prop?.displayName ? ` (${prop.displayName})` : ""}`;
    lines.push(
      csvRow([
        p.confirmedAt ? toQbDate(p.confirmedAt) : "",
        description,
        round2(p.amountPaid).toFixed(2),
        "Services",
        `PAY-${p.id}`,
        "",
        "1",
        customer,
        propLabel,
        p.method ?? "",
        "",
        "",
        p.occurrence.id,
      ]),
    );
    total += p.amountPaid;
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
  return { csv: lines.join("\n") + "\n", rowCount: payments.length, total: round2(total) };
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

  // Schedule C line + QB chart-of-accounts mapping come from the
  // EXPENSE_CATEGORIES taxonomy — the single source of truth, editable in
  // Settings with no code change. A category whose qbAccount is null lands
  // as "Unmapped" so the operator re-categorizes inside QB after import.
  const [lineMap, qbAccountMap, fixedAssetMinCost] = await Promise.all([
    loadScheduleCLineMap(),
    loadQbAccountMap(),
    loadFixedAssetMinCost(),
  ]);

  // Column shape (7 core spec columns + trailing extras QB ignores):
  //   Date, Description, Amount, Account, Reference ID, Category, Tax Line,
  //   Customer, Property, Method, Vendor, Invoice #, Job ID
  //
  // Reference ID: BusinessExpense → `EXP-{id}`; processor-fee rows
  // synthesized from Payment → `FEE-{paymentId}`. Stable across re-exports
  // so QB dedupes on re-import.
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
  // Fixed-asset purchases (cost ≥ FIXED_ASSET_MIN_COST setting, on/after the
  // policy start date) are skipped here and emitted in qb-fixed-assets.csv
  // instead — they hit a Fixed Asset account on the balance sheet, not the P&L.
  const expenseRows = rows.filter((r) => !isFixedAsset(r, fixedAssetMinCost));
  for (const r of expenseRows) {
    const category = r.category ?? "Other";
    const account = qbAccountMap[category] ?? "Unmapped";
    const prop = r.occurrence?.job?.property;
    const propLabel = prop
      ? [prop.displayName, prop.street1, prop.city, prop.state].filter(Boolean).join(" — ")
      : "";
    lines.push(
      csvRow([
        toQbDate(r.date),
        r.description ?? "",
        round2(r.cost).toFixed(2),
        account,
        `EXP-${r.id}`,
        category,
        lineMap[category] ?? "",
        prop?.client?.displayName ?? "",
        propLabel,
        "",
        r.vendor ?? "",
        r.invoiceNumber ?? "",
        r.occurrence?.id ?? "",
      ]),
    );
    total += r.cost;
  }
  // Append processor-fee rows. Vendor is the payment method (e.g. "Venmo") so
  // the CPA can see which processor charged what. Description includes the
  // Payment ID for traceability back to the source transaction. These rows
  // use the "Payment Processing Fees" category; its Schedule C line + QB
  // account come from the EXPENSE_CATEGORIES taxonomy like any other category.
  for (const p of feePayments) {
    const prop = p.occurrence?.job?.property;
    const clientName = prop?.client?.displayName ?? "";
    const propName = prop?.displayName ?? "";
    const propLabel = prop
      ? [prop.displayName, prop.street1, prop.city, prop.state].filter(Boolean).join(" — ")
      : "";
    const desc = `${p.method} fee on ${clientName}${propName ? ` — ${propName}` : ""} (gross $${round2(p.grossCharged ?? 0).toFixed(2)}, payment ${p.id})`;
    lines.push(
      csvRow([
        p.confirmedAt ? toQbDate(p.confirmedAt) : "",
        desc,
        round2(p.processorFeeAmount ?? 0).toFixed(2),
        qbAccountMap[PROCESSOR_FEE_CATEGORY] ?? "Unmapped",
        `FEE-${p.id}`,
        PROCESSOR_FEE_CATEGORY,
        lineMap[PROCESSOR_FEE_CATEGORY] ?? "10",
        clientName,
        propLabel,
        p.method ?? "",
        p.method ?? "",
        "",
        p.occurrence?.id ?? "",
      ]),
    );
    total += p.processorFeeAmount ?? 0;
  }
  // Append Contract Labor rows — one per contractor PaymentSplit on a
  // confirmed payment. Vendor is the contractor's display name so the
  // CPA's 1099 workflow can group by payee. Owner-earnings splits are
  // already excluded by loadConfirmedPayments; W-2 (employee/trainee)
  // splits are filtered here because their wages flow through Gusto, not QB.
  let contractRowCount = 0;
  for (const p of payments) {
    const prop = p.occurrence?.job?.property;
    const clientName = prop?.client?.displayName ?? "";
    const propLabel = prop
      ? [prop.displayName, prop.street1, prop.city, prop.state].filter(Boolean).join(" — ")
      : "";
    for (const sp of p.splits) {
      if (isEmployeeClass(sp.user.workerType)) continue;
      const vendor = sp.user.displayName ?? sp.user.email ?? "";
      const desc = `Contractor payout to ${vendor}${clientName ? ` for ${clientName}` : ""}${prop?.displayName ? ` (${prop.displayName})` : ""}`;
      lines.push(
        csvRow([
          p.confirmedAt ? toQbDate(p.confirmedAt) : "",
          desc,
          round2(sp.amount).toFixed(2),
          qbAccountMap[CONTRACT_LABOR_CATEGORY] ?? "Unmapped",
          `CL-${sp.id}`,
          CONTRACT_LABOR_CATEGORY,
          lineMap[CONTRACT_LABOR_CATEGORY] ?? "11",
          clientName,
          propLabel,
          "",
          vendor,
          "",
          p.occurrence?.id ?? "",
        ]),
      );
      total += sp.amount;
      contractRowCount += 1;
    }
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
  return {
    csv: lines.join("\n") + "\n",
    rowCount: expenseRows.length + feePayments.length + contractRowCount,
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
        unmapped.push({
          ref: `CL-${sp.id}`,
          date: p.confirmedAt ? toQbDate(p.confirmedAt) : "",
          description: `Contractor payout to ${sp.user.displayName ?? sp.user.email ?? ""}`,
          category: CONTRACT_LABOR_CATEGORY,
          amount: round2(sp.amount),
        });
      }
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
  // Same scan also tallies the Contract Labor rows that show up in the QB
  // Expenses CSV (one CSV row per contractor split). Tracking rows and total
  // here avoids re-querying payments downstream.
  const contractorWorkers = new Set<string>();
  let contractorGross = 0;
  let contractLaborRows = 0;
  for (const p of payments) {
    for (const sp of p.splits) {
      if (!isEmployeeClass(sp.user.workerType)) {
        contractorWorkers.add(sp.user.id);
        contractorGross += sp.amount;
        contractLaborRows += 1;
      }
    }
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
      workers: contractorWorkers.size,
      gross: round2(contractorGross),
    },
    qbIncome: {
      rows: payments.length,
      total: round2(qbIncomeTotal),
    },
    qbExpenses: {
      rows: operatingExpenses.length + processorFeeRows + contractLaborRows,
      total: round2(businessExpenseTotal + processorFeeTotal + contractorGross),
      // Sub-totals exposed for the Exports tab preview
      // ("$X expenses + $Y fees + $Z contractor labor").
      businessExpenseTotal: round2(businessExpenseTotal),
      processorFeeTotal: round2(processorFeeTotal),
      contractLaborTotal: round2(contractorGross),
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
