// ─────────────────────────────────────────────────────────────────────────────
// Payroll — persistence, identity resolution, and the VISIBILITY PROJECTIONS.
//
// Canonical spec: docs/features/payroll.md. Read it before changing the
// projections; they are the reason the feature was specced before it was
// built.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE
// ----------------------------------------
// A worker can see their own payroll row and nobody else's. That is a
// SERVER-SIDE guarantee: worker queries are scoped by `userId` in the
// `where` clause, never filtered after the fact and never left to the
// client. `payroll-build-gate.test.ts` asserts it.
//
// Three projections, per the spec:
//   worker  -> own rows only, FULL detail (it's their own pay stub)
//   admin   -> any worker, HOURS / GROSS / NET ONLY (no tax breakdown)
//   super   -> any worker, full detail, plus unmatched rows
//
// The admin restriction is applied when BUILDING the payload. Tax columns
// must never be serialized to an admin client and hidden with CSS.
//
// DECOUPLED FROM THE FINANCIAL SYSTEM. Nothing here writes Expense, touches
// P&L, or feeds a tax export — not even employerCost. See the spec for why.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import type { EtDateKey } from "../lib/dates";
import {
  parseGustoPayrollJournal,
  checkConservation,
  PayrollParseError,
  type ParsedPayrollPeriod,
  type ParsedPayrollEntry,
  type NumericField,
} from "./payrollImport";

type Tx = PrismaClient | Prisma.TransactionClient;

/** Who is asking, and therefore how much they get to see. */
export type PayrollViewer =
  | { kind: "worker"; userId: string }
  | { kind: "admin" }
  | { kind: "super" };

// ── Column groups ────────────────────────────────────────────────────────────

/**
 * The only numeric fields an ADMIN may receive for another worker.
 *
 * Derived from the spec's visibility table: hours / gross / net. Everything
 * else — federal, state, Medicare, Social Security, FUTA, employer cost —
 * is withheld. `netPay` and `checkAmount` are the same number in practice
 * but Gusto reports both, and an admin reconciling a bank line needs the
 * check amount.
 */
export const ADMIN_VISIBLE_FIELDS = [
  "regularHours",
  "grossEarnings",
  "netPay",
  "checkAmount",
] as const satisfies readonly NumericField[];

/** Every numeric field. SUPER only — the one view with nothing withheld. */
export const ALL_NUMERIC_FIELDS: readonly NumericField[] = [
  "regularHours",
  "regularRate",
  "regularAmount",
  "additionalEarnings",
  "grossEarnings",
  "employeeTaxes",
  "federalIncomeTax",
  "socialSecurityEmployee",
  "medicareEmployee",
  "additionalMedicareEmployee",
  "stateTaxEmployee",
  "employerTaxes",
  "socialSecurityEmployer",
  "medicareEmployer",
  "futaEmployer",
  "stateUnemploymentEmployer",
  "netPay",
  "reimbursements",
  "donations",
  "checkAmount",
  "employerCost",
];

/**
 * The employer's side of the ledger: what the BUSINESS paid on top of
 * wages, and the resulting total cost of employing someone.
 *
 * SUPER ONLY. Not because it is more sensitive than a tax line — it is
 * simply not the worker's information. A pay stub tells you what you
 * earned and what was withheld from it; the employer's matching Social
 * Security contribution, its FUTA and NC unemployment liability, and what
 * you cost the company in total are the company's books. Gusto draws the
 * same line: an employee's own Gusto account does not show these either.
 *
 * An ADMIN is already excluded from everything but hours/gross/net, so
 * this list is really about narrowing the WORKER's own row.
 */
export const EMPLOYER_SIDE_FIELDS = [
  "employerTaxes",
  "socialSecurityEmployer",
  "medicareEmployer",
  "futaEmployer",
  "stateUnemploymentEmployer",
  "employerCost",
] as const satisfies readonly NumericField[];

/**
 * A worker's own row: their full pay stub, minus the employer's side.
 *
 * DERIVED by subtraction rather than listed out, so a new column added to
 * ALL_NUMERIC_FIELDS reaches the worker automatically UNLESS it is named
 * employer-side. That is the safe default for pay-stub data — a new
 * withholding line is theirs by right — while anything belonging to the
 * company's books has to be declared above to be withheld.
 */
export const WORKER_VISIBLE_FIELDS: readonly NumericField[] = ALL_NUMERIC_FIELDS.filter(
  (f) => !(EMPLOYER_SIDE_FIELDS as readonly NumericField[]).includes(f),
);

/**
 * Which fields a given viewer may receive.
 *
 * Every branch is explicit. An earlier version read `admin ? ADMIN : ALL`,
 * which made "everything" the default for anything that was not an admin
 * — so `super` and `worker` shared one projection and a worker's payload
 * carried the employer-side columns their UI never rendered. Client-side
 * omission is not a control.
 */
export function fieldsFor(viewer: PayrollViewer): readonly NumericField[] {
  switch (viewer.kind) {
    case "admin":
      return ADMIN_VISIBLE_FIELDS;
    case "worker":
      return WORKER_VISIBLE_FIELDS;
    case "super":
      return ALL_NUMERIC_FIELDS;
  }
}

// ── Import ───────────────────────────────────────────────────────────────────

export class PayrollConservationError extends Error {
  constructor(
    message: string,
    readonly mismatches: ReturnType<typeof checkConservation>,
  ) {
    super(message);
  }
}

export type ImportResult = {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  payDay: string;
  label: string | null;
  entryCount: number;
  /** True when this replaced an existing period rather than creating one. */
  replaced: boolean;
  /**
   * On a replace, whether the incoming file ACTUALLY differed from what was
   * already stored.
   *
   * Re-importing the same export is a normal thing to do — you lose track
   * of which file you already loaded. But "replaced" on its own reads as
   * "something changed", so a no-op import looked like a broken one. This
   * lets the UI say which happened. Always false for a fresh create.
   */
  changed: boolean;
  /** Rows whose name has no confirmed identity yet — the review queue. */
  unmatched: Array<{ lastName: string; firstName: string }>;
};

/**
 * Parse, validate, and persist a Gusto payroll journal.
 *
 * ORDER MATTERS: parse → conservation check → persist. Nothing is written
 * until the numbers balance against Gusto's own totals row, because these
 * figures land on a worker's screen labelled as what they were actually
 * paid.
 *
 * A file may contain more than one period (multiple pay schedules); each
 * is imported independently and gets its own audit row.
 */
export async function importPayrollCsv(opts: {
  csvText: string;
  sourceR2Key: string;
  actorUserId: string;
}): Promise<ImportResult[]> {
  let periods: ParsedPayrollPeriod[];
  try {
    periods = parseGustoPayrollJournal(opts.csvText);
  } catch (err) {
    if (err instanceof PayrollParseError) throw err;
    throw new PayrollParseError(
      `Could not read this file as a Gusto Payroll Journal: ${(err as Error).message}`,
    );
  }

  // Validate EVERY period before persisting ANY of them. A two-section file
  // where the second section is corrupt must not leave the first imported
  // and the operator guessing which half landed.
  for (const p of periods) {
    const mismatches = checkConservation(p);
    if (mismatches.length > 0) {
      const first = mismatches[0];
      throw new PayrollConservationError(
        `Payroll period ${p.periodStart} – ${p.periodEnd} does not balance: ` +
          `"${first.header}" sums to ${first.summed} but the Payroll Totals row ` +
          `reports ${first.reported}.`,
        mismatches,
      );
    }
  }

  const results: ImportResult[] = [];
  for (const p of periods) {
    results.push(await persistPeriod(p, opts.sourceR2Key, opts.actorUserId));
  }
  return results;
}

async function persistPeriod(
  parsed: ParsedPayrollPeriod,
  sourceR2Key: string,
  actorUserId: string,
): Promise<ImportResult> {
  // Identity resolution happens outside the transaction — it's read-only
  // and keeps the write window short.
  const identities = await prisma.payrollIdentity.findMany();
  const byName = new Map(
    identities.map((i) => [nameKey(i.lastName, i.firstName), i.userId]),
  );

  const rows = parsed.entries.map((e) => ({
    entry: e,
    userId: byName.get(nameKey(e.rawLastName, e.rawFirstName)) ?? null,
  }));

  const unmatched = rows
    .filter((r) => r.userId === null)
    .map((r) => ({ lastName: r.entry.rawLastName, firstName: r.entry.rawFirstName }));

  return prisma.$transaction(async (tx) => {
    // Natural key is (periodStart, periodEnd) — payDay excluded on purpose,
    // so correcting a wrong pay day REPLACES rather than duplicating.
    const existing = await tx.payrollPeriod.findUnique({
      where: {
        periodStart_periodEnd: {
          periodStart: parsed.periodStart,
          periodEnd: parsed.periodEnd,
        },
      },
      include: { entries: true },
    });

    let periodId: string;
    let replaced = false;
    let changed = true;

    if (existing) {
      replaced = true;
      // Compare what is stored against what is arriving, using each row's
      // verbatim source line. If the operator re-uploaded the same export,
      // these are identical and nothing about the period moves.
      changed =
        existing.payDay !== parsed.payDay ||
        entriesSignature(existing.entries.map((e) => [e.rawLastName, e.rawFirstName, e.raw])) !==
          entriesSignature(rows.map((r) => [r.entry.rawLastName, r.entry.rawFirstName, r.entry.raw]));
      // Snapshot BEFORE destroying. Re-upload is the only edit path, so this
      // audit row is the only surviving record of the previous numbers.
      await writeAudit(tx, AUDIT.PAYROLL.REPLACED, actorUserId, {
        payrollPeriodId: existing.id,
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        payDay: existing.payDay,
        previousPayDay: existing.payDay,
        previousSourceR2Key: existing.sourceR2Key,
        entryCount: parsed.entries.length,
        changed,
        displacedEntries: existing.entries.map((e) => ({
          userId: e.userId,
          rawLastName: e.rawLastName,
          rawFirstName: e.rawFirstName,
          grossEarnings: e.grossEarnings,
          netPay: e.netPay,
          raw: e.raw,
        })),
      });

      // audit-allow: the PAYROLL.REPLACED row written immediately above
      // snapshots every one of these entries before they are removed.
      await tx.payrollEntry.deleteMany({ where: { payrollPeriodId: existing.id } });
      await tx.payrollPeriod.update({
        where: { id: existing.id },
        data: {
          payDay: parsed.payDay,
          label: parsed.label,
          sourceR2Key,
          totals: parsed.totals as unknown as Prisma.InputJsonValue,
          uploadedById: actorUserId,
          // A re-upload of an archived period brings it back — the operator
          // is explicitly re-asserting it.
          archivedAt: null,
          archivedById: null,
        },
      });
      periodId = existing.id;
    } else {
      const created = await tx.payrollPeriod.create({
        data: {
          periodStart: parsed.periodStart,
          periodEnd: parsed.periodEnd,
          payDay: parsed.payDay,
          label: parsed.label,
          sourceR2Key,
          totals: parsed.totals as unknown as Prisma.InputJsonValue,
          uploadedById: actorUserId,
        },
      });
      periodId = created.id;

      await writeAudit(tx, AUDIT.PAYROLL.UPLOADED, actorUserId, {
        payrollPeriodId: periodId,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        payDay: parsed.payDay,
        entryCount: parsed.entries.length,
        unmatchedCount: unmatched.length,
      });
    }

    // audit-allow: entry rows are the body of the period, covered by the
    // PAYROLL.UPLOADED / PAYROLL.REPLACED row for this period (entryCount).
    await tx.payrollEntry.createMany({
      data: rows.map(({ entry, userId }) => entryToRow(entry, periodId, userId)),
    });

    return {
      periodId,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      payDay: parsed.payDay,
      label: parsed.label,
      entryCount: parsed.entries.length,
      replaced,
      changed,
      unmatched,
    };
  });
}

/**
 * Order-independent fingerprint of a period's rows, built from the verbatim
 * source lines rather than the typed columns — so a difference in ANY field
 * counts, including ones the UI never renders.
 */
function entriesSignature(rows: Array<[string, string, unknown]>): string {
  return rows
    .map(([last, first, raw]) => `${last}|${first}|${stableStringify(raw)}`)
    .sort()
    .join("\n");
}

/** JSON.stringify with sorted keys, so key order can't fake a difference. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

function entryToRow(
  e: ParsedPayrollEntry,
  payrollPeriodId: string,
  userId: string | null,
): Prisma.PayrollEntryCreateManyInput {
  const v = e.values;
  return {
    payrollPeriodId,
    userId,
    rawLastName: e.rawLastName,
    rawFirstName: e.rawFirstName,
    workAddress: e.workAddress,
    employeeType: e.employeeType,
    paymentMethod: e.paymentMethod,
    // Every numeric is nullable: blank ≠ zero (see parseMoneyCell).
    regularHours: v.regularHours ?? null,
    regularRate: v.regularRate ?? null,
    regularAmount: v.regularAmount ?? null,
    additionalEarnings: v.additionalEarnings ?? null,
    grossEarnings: v.grossEarnings ?? null,
    employeeTaxes: v.employeeTaxes ?? null,
    federalIncomeTax: v.federalIncomeTax ?? null,
    socialSecurityEmployee: v.socialSecurityEmployee ?? null,
    medicareEmployee: v.medicareEmployee ?? null,
    additionalMedicareEmployee: v.additionalMedicareEmployee ?? null,
    stateTaxEmployee: v.stateTaxEmployee ?? null,
    employerTaxes: v.employerTaxes ?? null,
    socialSecurityEmployer: v.socialSecurityEmployer ?? null,
    medicareEmployer: v.medicareEmployer ?? null,
    futaEmployer: v.futaEmployer ?? null,
    stateUnemploymentEmployer: v.stateUnemploymentEmployer ?? null,
    netPay: v.netPay ?? null,
    reimbursements: v.reimbursements ?? null,
    donations: v.donations ?? null,
    checkAmount: v.checkAmount ?? null,
    employerCost: v.employerCost ?? null,
    raw: e.raw as unknown as Prisma.InputJsonValue,
  };
}

function nameKey(last: string, first: string): string {
  return `${last.trim().toLowerCase()} ${first.trim().toLowerCase()}`;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export type PayrollPeriodSummary = {
  id: string;
  periodStart: string;
  periodEnd: string;
  payDay: string;
  label: string | null;
  /** Present only for admin/super. Workers get their own numbers, not the team's. */
  teamTotals?: {
    grossEarnings: number | null;
    netPay: number | null;
    /** SUPER ONLY — absent from an admin payload. */
    employerCost?: number | null;
  };
  /** Worker view: their own figures for this period, if they have a row. */
  mine?: { grossEarnings: number | null; netPay: number | null };
  entryCount?: number;
  unmatchedCount?: number;
};

/**
 * List periods the viewer is allowed to see, newest pay day first.
 *
 * A worker only sees periods they actually appear in — an empty period, or
 * one predating their hire, is not theirs to browse.
 */
export async function listPeriods(viewer: PayrollViewer): Promise<PayrollPeriodSummary[]> {
  if (viewer.kind === "worker") {
    const periods = await prisma.payrollPeriod.findMany({
      where: {
        archivedAt: null,
        // Server-side scoping. The worker's own row is the JOIN condition,
        // not a post-filter.
        entries: { some: { userId: viewer.userId } },
      },
      orderBy: { payDay: "desc" },
      include: {
        entries: {
          where: { userId: viewer.userId },
          select: { grossEarnings: true, netPay: true },
        },
      },
    });
    return periods.map((p) => ({
      id: p.id,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      payDay: p.payDay,
      label: p.label,
      mine: {
        grossEarnings: p.entries[0]?.grossEarnings ?? null,
        netPay: p.entries[0]?.netPay ?? null,
      },
    }));
  }

  // Admin + Super: every period. Super additionally sees archived ones.
  const periods = await prisma.payrollPeriod.findMany({
    where: viewer.kind === "super" ? {} : { archivedAt: null },
    orderBy: { payDay: "desc" },
    include: { entries: { select: { userId: true } } },
  });

  return periods.map((p) => {
    const t = (p.totals ?? {}) as { values?: Partial<Record<NumericField, number | null>> };
    return {
      id: p.id,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      payDay: p.payDay,
      label: p.label,
      teamTotals: {
        grossEarnings: t.values?.grossEarnings ?? null,
        netPay: t.values?.netPay ?? null,
        // SUPER ONLY. `employerCost` is in TAX_AND_EMPLOYER_FIELDS — the
        // list of everything an admin must not receive — so shipping it in
        // the aggregate would have handed an admin, through the back door,
        // the exact figure the per-entry projection withholds. A team of
        // three makes an aggregate close enough to per-person.
        //
        // It is shown to the operator as an operational figure only: NOT an
        // Expense row, and it never reaches a tax export.
        ...(viewer.kind === "super"
          ? { employerCost: t.values?.employerCost ?? null }
          : {}),
      },
      entryCount: p.entries.length,
      unmatchedCount: p.entries.filter((e) => e.userId === null).length,
    };
  });
}

/**
 * The employer's side of one period's "Payroll Totals" row.
 *
 * SUPER ONLY — returns undefined for anyone else, so the field is absent
 * from the payload rather than present-and-zeroed. Same rule as
 * `teamTotals.employerCost`: the absence IS the access control.
 */
export function employerTotalsFor(
  period: { totals: unknown },
  viewer: PayrollViewer,
): Partial<Record<NumericField, number | null>> | undefined {
  if (viewer.kind !== "super") return undefined;
  const t = (period.totals ?? {}) as {
    values?: Partial<Record<NumericField, number | null>>;
  };
  if (!t.values) return undefined;
  const out: Partial<Record<NumericField, number | null>> = {};
  for (const f of EMPLOYER_SIDE_FIELDS) out[f] = t.values[f] ?? null;
  // Gross rides along so the block can show what the employer taxes sit on
  // top of — "cost = gross + taxes" is the whole point of the section.
  out.grossEarnings = t.values.grossEarnings ?? null;
  return out;
}

export type PayrollEntryView = {
  id: string;
  userId: string | null;
  displayName: string | null;
  rawLastName: string;
  rawFirstName: string;
  employeeType: string | null;
  paymentMethod: string | null;
  /** Only the fields this viewer is permitted to receive. */
  values: Partial<Record<NumericField, number | null>>;
  /** Super only — flags a row with no confirmed identity. */
  unmatched?: boolean;
};

/**
 * Entries for one period, projected for the viewer.
 *
 * `forUserId` narrows an admin/super view to a single worker (the "unless
 * you select a worker" case). It is IGNORED for a worker viewer, whose
 * scope is already fixed to themselves — accepting it there would be a
 * parameter that looks like it grants access.
 */
export async function listEntries(
  periodId: string,
  viewer: PayrollViewer,
  forUserId?: string | null,
): Promise<PayrollEntryView[]> {
  const where: Prisma.PayrollEntryWhereInput = { payrollPeriodId: periodId };

  if (viewer.kind === "worker") {
    where.userId = viewer.userId;
  } else if (forUserId) {
    where.userId = forUserId;
  }

  const entries = await prisma.payrollEntry.findMany({
    where,
    orderBy: [{ rawLastName: "asc" }, { rawFirstName: "asc" }],
    include: { user: { select: { displayName: true } } },
  });

  // Admin never receives an unmatched row: it has no confirmed owner, so
  // showing it in a per-worker admin view would be an unattributed number.
  const visible =
    viewer.kind === "admin" ? entries.filter((e) => e.userId !== null) : entries;

  const fields = fieldsFor(viewer);

  return visible.map((e) => {
    const values: Partial<Record<NumericField, number | null>> = {};
    for (const f of fields) values[f] = (e as Record<string, unknown>)[f] as number | null;
    return {
      id: e.id,
      userId: e.userId,
      displayName: e.user?.displayName ?? null,
      rawLastName: e.rawLastName,
      rawFirstName: e.rawFirstName,
      employeeType: e.employeeType,
      paymentMethod: e.paymentMethod,
      values,
      ...(viewer.kind === "super" ? { unmatched: e.userId === null } : {}),
    };
  });
}

/**
 * Home-tab summary: the worker's most recent payroll row.
 *
 * Deliberately returns no "next pay day". Uploads are manual and
 * sequential, so a predicted date would be inferred from history and wrong
 * the first time a schedule changes. See the spec.
 */
export async function getMyLatest(userId: string): Promise<{
  payDay: string;
  periodStart: string;
  periodEnd: string;
  netPay: number | null;
  grossEarnings: number | null;
  periodsOnRecord: number;
} | null> {
  const entry = await prisma.payrollEntry.findFirst({
    where: { userId, payrollPeriod: { archivedAt: null } },
    orderBy: { payrollPeriod: { payDay: "desc" } },
    include: { payrollPeriod: true },
  });
  if (!entry) return null;

  const periodsOnRecord = await prisma.payrollEntry.count({
    where: { userId, payrollPeriod: { archivedAt: null } },
  });

  return {
    payDay: entry.payrollPeriod.payDay,
    periodStart: entry.payrollPeriod.periodStart,
    periodEnd: entry.payrollPeriod.periodEnd,
    netPay: entry.netPay,
    grossEarnings: entry.grossEarnings,
    periodsOnRecord,
  };
}

/**
 * Does this worker plausibly have a pay period sitting unmatched?
 *
 * THE PROBLEM THIS SOLVES. Payroll rows attach to a User by NAME. When a
 * name changes — marriage, a Gusto typo, "Mike" vs "Michael" — the new
 * period imports with `userId: null` and the worker simply doesn't see it.
 * No gap, no error, no cue. They conclude payroll is late. Meanwhile the
 * Super's review queue says "1 payroll name needs matching" and the worker
 * has no way to know that concerns them.
 *
 * DELIBERATELY TARGETED, not a broadcast. Showing "some rows are unmatched"
 * to every worker would be noise for the matched majority and would tell
 * contractors — who are never in a Gusto payroll journal at all — about a
 * problem that can't be theirs. All three conditions must hold:
 *
 *   1. the worker HAS payroll history (so payroll demonstrably applies to
 *      them — a brand-new hire's first unmatched import is covered by the
 *      empty state's copy instead),
 *   2. they have NO row in the most recent period (there is a real gap),
 *   3. that period contains at least one unmatched row (something plausibly
 *      theirs is waiting).
 *
 * Returns only a flag and a date. No names, no amounts, nothing about
 * anyone else — a worker learns that A period is unattributed, never whose
 * or how much.
 */
export async function getPendingMatchNotice(userId: string): Promise<{
  affected: boolean;
  payDay: string | null;
}> {
  const NONE = { affected: false, payDay: null };

  const latest = await prisma.payrollPeriod.findFirst({
    where: { archivedAt: null },
    orderBy: { payDay: "desc" },
    include: { entries: { select: { userId: true } } },
  });
  if (!latest) return NONE;

  // (2) A row in the newest period means nothing is missing for them.
  if (latest.entries.some((e) => e.userId === userId)) return NONE;

  // (3) Nothing unattributed in that period — their absence is just absence.
  if (!latest.entries.some((e) => e.userId === null)) return NONE;

  // (1) No history at all → a brand-new worker or a contractor. The empty
  // state already tells them how matching works; a "pending match" notice
  // would be a guess.
  const history = await prisma.payrollEntry.count({
    where: { userId, payrollPeriod: { archivedAt: null } },
  });
  if (history === 0) return NONE;

  return { affected: true, payDay: latest.payDay };
}

// ── Identity mapping (Super only) ────────────────────────────────────────────

/** Names appearing in any period with no confirmed identity yet. */
export async function listUnmatchedNames(): Promise<
  Array<{ lastName: string; firstName: string; entryCount: number }>
> {
  const rows = await prisma.payrollEntry.groupBy({
    by: ["rawLastName", "rawFirstName"],
    where: { userId: null },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({
      lastName: r.rawLastName,
      firstName: r.rawFirstName,
      entryCount: r._count._all,
    }))
    .sort((a, b) => a.lastName.localeCompare(b.lastName));
}

/**
 * Confirm that a payroll name belongs to an app user.
 *
 * Back-fills every existing entry with that name, so confirming once makes
 * the worker's whole history visible to them rather than only future
 * uploads.
 */
export async function linkIdentity(opts: {
  lastName: string;
  firstName: string;
  userId: string;
  actorUserId: string;
}): Promise<{ entriesRelinked: number }> {
  const { lastName, firstName, userId, actorUserId } = opts;

  return prisma.$transaction(async (tx) => {
    await tx.payrollIdentity.upsert({
      where: { lastName_firstName: { lastName, firstName } },
      create: { lastName, firstName, userId, confirmedById: actorUserId },
      update: { userId, confirmedById: actorUserId, confirmedAt: new Date() },
    });

    // audit-allow: back-fill under PAYROLL.IDENTITY_LINKED, whose metadata
    // records how many entries this moved (entriesRelinked).
    const relink = await tx.payrollEntry.updateMany({
      where: { rawLastName: lastName, rawFirstName: firstName },
      data: { userId },
    });

    await writeAudit(tx, AUDIT.PAYROLL.IDENTITY_LINKED, actorUserId, {
      lastName,
      firstName,
      userId,
      entriesRelinked: relink.count,
    });

    return { entriesRelinked: relink.count };
  });
}

/**
 * Undo a mapping. Detaches every entry with that name, returning them to
 * the unmatched queue — a wrong link means someone was shown another
 * person's pay, so it must be fully reversible.
 */
export async function unlinkIdentity(opts: {
  lastName: string;
  firstName: string;
  actorUserId: string;
}): Promise<{ entriesDetached: number }> {
  const { lastName, firstName, actorUserId } = opts;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.payrollIdentity.findUnique({
      where: { lastName_firstName: { lastName, firstName } },
    });

    await tx.payrollIdentity.deleteMany({ where: { lastName, firstName } });
    // audit-allow: detach under PAYROLL.IDENTITY_UNLINKED, whose metadata
    // records the previous userId and how many entries this moved.
    const detach = await tx.payrollEntry.updateMany({
      where: { rawLastName: lastName, rawFirstName: firstName },
      data: { userId: null },
    });

    await writeAudit(tx, AUDIT.PAYROLL.IDENTITY_UNLINKED, actorUserId, {
      lastName,
      firstName,
      previousUserId: existing?.userId ?? null,
      entriesDetached: detach.count,
    });

    return { entriesDetached: detach.count };
  });
}

// ── Archive (Super only) ─────────────────────────────────────────────────────

/**
 * Soft-delete a period. Follows the repo-wide archivedAt pattern; hard
 * deletion of a payroll record should not be recoverable-from-backup-only.
 * Snapshots what it hides, same reasoning as REPLACED.
 */
export async function archivePeriod(opts: {
  periodId: string;
  actorUserId: string;
}): Promise<void> {
  const { periodId, actorUserId } = opts;

  await prisma.$transaction(async (tx) => {
    const period = await tx.payrollPeriod.findUnique({
      where: { id: periodId },
      include: { entries: true },
    });
    if (!period) throw new Error("Payroll period not found");

    await writeAudit(tx, AUDIT.PAYROLL.ARCHIVED, actorUserId, {
      payrollPeriodId: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      payDay: period.payDay,
      entryCount: period.entries.length,
      displacedEntries: period.entries.map((e) => ({
        userId: e.userId,
        rawLastName: e.rawLastName,
        rawFirstName: e.rawFirstName,
        grossEarnings: e.grossEarnings,
        netPay: e.netPay,
      })),
    });

    await tx.payrollPeriod.update({
      where: { id: periodId },
      data: { archivedAt: new Date(), archivedById: actorUserId },
    });
  });
}

export type { NumericField, EtDateKey, Tx };
