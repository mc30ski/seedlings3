import { prisma } from "../db/prisma";

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
// Gusto W-2 CSV — one row per employee/trainee with totals in the period.
// ─────────────────────────────────────────────────────────────────────────────
export async function gustoW2Csv(start: Date, end: Date): Promise<string> {
  const payments = await loadConfirmedPayments(start, end);

  type Agg = {
    userId: string;
    first: string;
    last: string;
    email: string;
    workerType: string;
    hours: number;
    gross: number;
    jobs: number;
  };
  const byWorker = new Map<string, Agg>();

  for (const p of payments) {
    const occ = p.occurrence;
    const activeAssignees = occ.assignees.filter((a) => a.role !== "observer");
    const occHours = hoursPerWorker({
      startedAt: occ.startedAt,
      completedAt: occ.completedAt,
      totalPausedMs: occ.totalPausedMs,
      assigneeCount: activeAssignees.length,
    });
    for (const sp of p.splits) {
      if (!isEmployeeClass(sp.user.workerType)) continue;
      const k = sp.user.id;
      const cur = byWorker.get(k);
      const { first, last } = splitName(sp.user.displayName);
      if (cur) {
        cur.hours += occHours;
        cur.gross += sp.amount;
        cur.jobs += 1;
      } else {
        byWorker.set(k, {
          userId: k,
          first,
          last,
          email: sp.user.email ?? "",
          workerType: sp.user.workerType ?? "",
          hours: occHours,
          gross: sp.amount,
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
const SCHEDULE_C_LINES: Record<string, string> = {
  Advertising: "8",
  "Car and truck expenses": "9",
  "Contract labor": "11",
  Depreciation: "13",
  Insurance: "15",
  "Legal and professional services": "17",
  "Office expense": "18",
  "Rent or lease — vehicles/equipment": "20a",
  "Rent or lease — other business property": "20b",
  "Repairs and maintenance": "21",
  Supplies: "22",
  "Taxes and licenses": "23",
  Travel: "24a",
  Meals: "24b",
  Utilities: "25",
  Other: "27a",
};

export async function qbExpensesCsv(start: Date, end: Date): Promise<string> {
  const rows = await prisma.businessExpense.findMany({
    where: { date: { gte: start, lte: end } },
    orderBy: { date: "asc" },
  });

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
        SCHEDULE_C_LINES[category] ?? "",
        round2(r.cost).toFixed(2),
        r.description ?? "",
        r.invoiceNumber ?? "",
      ]),
    );
    total += r.cost;
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

// ─────────────────────────────────────────────────────────────────────────────
// Preview — JSON sanity figures for the Exports tab page (row counts + totals
// for each of the four files). Avoids the user having to download just to peek.
// ─────────────────────────────────────────────────────────────────────────────
export type ExportPreview = {
  gustoW2: { workers: number; hours: number; gross: number };
  gustoContractors: { workers: number; gross: number };
  qbIncome: { rows: number; total: number };
  qbExpenses: { rows: number; total: number };
};

export async function exportPreview(start: Date, end: Date): Promise<ExportPreview> {
  const payments = await loadConfirmedPayments(start, end);

  const w2Workers = new Set<string>();
  let w2Hours = 0;
  let w2Gross = 0;
  const contractorWorkers = new Set<string>();
  let contractorGross = 0;

  for (const p of payments) {
    const occ = p.occurrence;
    const activeAssignees = occ.assignees.filter((a) => a.role !== "observer");
    const occHours = hoursPerWorker({
      startedAt: occ.startedAt,
      completedAt: occ.completedAt,
      totalPausedMs: occ.totalPausedMs,
      assigneeCount: activeAssignees.length,
    });
    for (const sp of p.splits) {
      if (isEmployeeClass(sp.user.workerType)) {
        w2Workers.add(sp.user.id);
        w2Hours += occHours;
        w2Gross += sp.amount;
      } else {
        contractorWorkers.add(sp.user.id);
        contractorGross += sp.amount;
      }
    }
  }

  const qbIncomeTotal = payments.reduce((s, p) => s + p.amountPaid, 0);

  const expenses = await prisma.businessExpense.findMany({
    where: { date: { gte: start, lte: end } },
    select: { cost: true },
  });
  const qbExpensesTotal = expenses.reduce((s, e) => s + e.cost, 0);

  return {
    gustoW2: {
      workers: w2Workers.size,
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
      rows: expenses.length,
      total: round2(qbExpensesTotal),
    },
  };
}
