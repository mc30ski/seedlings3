import { prisma } from "../db/prisma";
import { loadScheduleCLineMap } from "./expenseCategories";

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

// Hours worked on an occurrence, in decimal hours, divided across active
// (non-observer) workers. Returns 0 if the job isn't timed.
function hoursPerWorker(occ: {
  startedAt: Date | null;
  completedAt: Date | null;
  totalPausedMs: number | null;
  assigneeCount: number;
}): number {
  if (!occ.startedAt || !occ.completedAt) return 0;
  const elapsedMs = occ.completedAt.getTime() - occ.startedAt.getTime() - (occ.totalPausedMs ?? 0);
  if (elapsedMs <= 0) return 0;
  const workers = Math.max(1, occ.assigneeCount);
  return elapsedMs / 1000 / 3600 / workers;
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
async function loadCompletedOccurrences(start: Date, end: Date) {
  return prisma.jobOccurrence.findMany({
    where: {
      completedAt: { gte: start, lte: end },
      status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
      workflow: { in: ["STANDARD", "ONE_OFF"] as any },
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
    const occHours = hoursPerWorker({
      startedAt: occ.startedAt,
      completedAt: occ.completedAt,
      totalPausedMs: occ.totalPausedMs,
      assigneeCount: active.length,
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
export async function gustoW2Csv(start: Date, end: Date): Promise<string> {
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
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Gusto Contractors CSV — one row per 1099 contractor with total paid.
// ─────────────────────────────────────────────────────────────────────────────
export async function gustoContractorsCsv(start: Date, end: Date): Promise<string> {
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
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// QB Income CSV — one row per confirmed Payment.
// ─────────────────────────────────────────────────────────────────────────────
export async function qbIncomeCsv(start: Date, end: Date): Promise<string> {
  const payments = await loadConfirmedPayments(start, end);

  const header = [
    "Date",
    "Customer",
    "Property",
    "Amount",
    "Method",
    "Job ID",
    "Payment ID",
    "Note",
  ];
  const lines: string[] = [csvRow(header)];
  let total = 0;
  for (const p of payments) {
    const prop = p.occurrence.job?.property;
    const propLabel = [prop?.displayName, prop?.street1, prop?.city, prop?.state]
      .filter(Boolean)
      .join(" — ");
    lines.push(
      csvRow([
        p.confirmedAt ? toIsoDate(p.confirmedAt) : "",
        prop?.client?.displayName ?? "",
        propLabel,
        round2(p.amountPaid).toFixed(2),
        p.method ?? "",
        p.occurrence.id,
        p.id,
        p.note ?? "",
      ]),
    );
    total += p.amountPaid;
  }
  lines.push(
    csvRow([
      "TOTALS",
      "",
      "",
      round2(total).toFixed(2),
      "",
      "",
      "",
      "",
    ]),
  );
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// QB Expenses CSV — BusinessExpense rows in [start, end] (date field). Pulls
// only the BusinessExpense table to avoid double-counting: every per-job
// Expense and SupplyPurchase has a paired BusinessExpense row already, so
// pulling only BE gives the canonical, deduped set.
// ─────────────────────────────────────────────────────────────────────────────
// Synthetic category for processor-fee rows — sourced from Payment records,
// never a hand-logged BusinessExpense. Its Schedule C line comes from the
// EXPENSE_CATEGORIES taxonomy like any other category.
const PROCESSOR_FEE_CATEGORY = "Payment Processing Fees";

export async function qbExpensesCsv(start: Date, end: Date): Promise<string> {
  const [rows, feePayments] = await Promise.all([
    prisma.businessExpense.findMany({
      // QB Expenses export — Schedule C lines apply only to operating
      // expenses. Equity entries flow through qbEquityCsv.
      where: { type: "EXPENSE", date: { gte: start, lte: end } },
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
            job: { select: { property: { select: { displayName: true, client: { select: { displayName: true } } } } } },
          },
        },
      },
      orderBy: { confirmedAt: "asc" },
    }),
  ]);

  // Schedule C line numbers come from the EXPENSE_CATEGORIES taxonomy — the
  // single source of truth, editable in Settings with no code change.
  const lineMap = await loadScheduleCLineMap();

  const header = [
    "Date",
    "Vendor",
    "Schedule C Category",
    "Schedule C Line",
    "Amount",
    "Description",
    "Invoice #",
  ];
  const lines: string[] = [csvRow(header)];
  let total = 0;
  for (const r of rows) {
    const category = r.category ?? "Other";
    lines.push(
      csvRow([
        toIsoDate(r.date),
        r.vendor ?? "",
        category,
        lineMap[category] ?? "",
        round2(r.cost).toFixed(2),
        r.description ?? "",
        r.invoiceNumber ?? "",
      ]),
    );
    total += r.cost;
  }
  // Append processor-fee rows. Vendor is the payment method (e.g. "Venmo") so
  // the CPA can see which processor charged what. Description includes the
  // Payment ID for traceability back to the source transaction. These rows
  // use the "Payment Processing Fees" category; its Schedule C line is whatever
  // the EXPENSE_CATEGORIES taxonomy maps it to.
  for (const p of feePayments) {
    const prop = p.occurrence?.job?.property;
    const clientName = prop?.client?.displayName ?? "";
    const propName = prop?.displayName ?? "";
    const desc = `${p.method} fee on ${clientName}${propName ? ` — ${propName}` : ""} (gross $${round2(p.grossCharged ?? 0).toFixed(2)}, payment ${p.id})`;
    lines.push(
      csvRow([
        p.confirmedAt ? toIsoDate(p.confirmedAt) : "",
        p.method ?? "",
        PROCESSOR_FEE_CATEGORY,
        lineMap[PROCESSOR_FEE_CATEGORY] ?? "10",
        round2(p.processorFeeAmount ?? 0).toFixed(2),
        desc,
        "",
      ]),
    );
    total += p.processorFeeAmount ?? 0;
  }
  lines.push(
    csvRow([
      "TOTALS",
      "",
      "",
      "",
      round2(total).toFixed(2),
      "",
      "",
    ]),
  );
  return lines.join("\n") + "\n";
}

// QuickBooks Equity export — owner capital contributions and owner draws.
// These are equity-account movements (balance-sheet), not P&L. The CPA imports
// them into the corresponding equity accounts; do NOT mix into qb-expenses.
//
// Account names are the QuickBooks defaults for a sole-prop / single-member
// LLC chart of accounts. Override in QB at import time if the user's COA uses
// different account names.
const QB_EQUITY_ACCOUNT: Record<"CAPITAL_CONTRIBUTION" | "OWNER_DRAW", string> = {
  CAPITAL_CONTRIBUTION: "Owner's Investment",
  OWNER_DRAW: "Owner's Draw",
};

export async function qbEquityCsv(start: Date, end: Date): Promise<string> {
  const rows = await prisma.businessExpense.findMany({
    where: {
      type: { in: ["CAPITAL_CONTRIBUTION", "OWNER_DRAW"] },
      date: { gte: start, lte: end },
    },
    orderBy: [{ date: "asc" }, { type: "asc" }],
  });

  const header = [
    "Date",
    "Type",
    "Account",
    "Amount",
    "Description",
    "Vendor",
    "Notes",
  ];
  const lines: string[] = [csvRow(header)];
  let contributionTotal = 0;
  let drawTotal = 0;
  for (const r of rows) {
    const typeKey = r.type as "CAPITAL_CONTRIBUTION" | "OWNER_DRAW";
    const account = QB_EQUITY_ACCOUNT[typeKey];
    const amount = round2(r.cost);
    lines.push(
      csvRow([
        toIsoDate(r.date),
        typeKey === "CAPITAL_CONTRIBUTION" ? "Capital Contribution" : "Owner Draw",
        account,
        amount.toFixed(2),
        r.description ?? "",
        r.vendor ?? "",
        r.notes ?? "",
      ]),
    );
    if (typeKey === "CAPITAL_CONTRIBUTION") contributionTotal += amount;
    else drawTotal += amount;
  }
  // Two sub-totals so the CPA / spreadsheet check eyeballs each equity
  // account independently — they post to different lines in QB.
  lines.push(csvRow(["SUBTOTAL Capital Contributions", "", "", round2(contributionTotal).toFixed(2), "", "", ""]));
  lines.push(csvRow(["SUBTOTAL Owner Draws", "", "", round2(drawTotal).toFixed(2), "", "", ""]));
  lines.push(csvRow(["TOTALS", "", "", round2(contributionTotal + drawTotal).toFixed(2), "", "", ""]));
  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview — JSON sanity figures for the Exports tab page (row counts + totals
// for each of the four files). Avoids the user having to download just to peek.
// ─────────────────────────────────────────────────────────────────────────────
export type ExportPreview = {
  gustoW2: { workers: number; hours: number; gross: number };
  gustoContractors: { workers: number; gross: number };
  qbIncome: { rows: number; total: number };
  qbExpenses: {
    rows: number;
    total: number;
    businessExpenseTotal: number;
    processorFeeTotal: number;
  };
  qbEquity: {
    rows: number;
    contributionTotal: number;
    drawTotal: number;
  };
};

export async function exportPreview(start: Date, end: Date): Promise<ExportPreview> {
  const payments = await loadConfirmedPayments(start, end);

  // W-2 preview — work-anchored, same source as the W-2 CSV (completed jobs +
  // promised net). NOT payment-anchored, so it ties out to the export.
  const w2Rows = await computeW2Earnings(start, end);
  const w2Hours = w2Rows.reduce((s, r) => s + r.hours, 0);
  const w2Gross = w2Rows.reduce((s, r) => s + r.gross, 0);

  // Contractors stay payment-anchored — sum their splits on confirmed payments.
  const contractorWorkers = new Set<string>();
  let contractorGross = 0;
  for (const p of payments) {
    for (const sp of p.splits) {
      if (!isEmployeeClass(sp.user.workerType)) {
        contractorWorkers.add(sp.user.id);
        contractorGross += sp.amount;
      }
    }
  }

  const qbIncomeTotal = payments.reduce((s, p) => s + p.amountPaid, 0);

  const expenses = await prisma.businessExpense.findMany({
    // Preview row count + total for the QB Expenses CSV button. Equity
    // entries (contributions/draws) export via the QB Equity CSV — different
    // account class, must not be mixed into the expense total.
    where: { type: "EXPENSE", date: { gte: start, lte: end } },
    select: { cost: true },
  });
  const businessExpenseTotal = expenses.reduce((s, e) => s + e.cost, 0);
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

  return {
    gustoW2: {
      workers: w2Rows.length,
      hours: round2(w2Hours),
      gross: round2(w2Gross),
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
      rows: expenses.length + processorFeeRows,
      total: round2(businessExpenseTotal + processorFeeTotal),
      // Sub-totals exposed for the Exports tab preview ("$X expenses + $Y fees").
      businessExpenseTotal: round2(businessExpenseTotal),
      processorFeeTotal: round2(processorFeeTotal),
    },
    qbEquity: {
      rows: equityRows.length,
      contributionTotal: round2(contributionTotal),
      drawTotal: round2(drawTotal),
    },
  };
}
