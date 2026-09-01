// ─────────────────────────────────────────────────────────────────────────────
// Payroll build gate
//
// PURPOSE
// Payroll is the most sensitive data this app holds — gross pay, federal and
// state withholding, net pay, per person. Two things must never regress:
//
//   1. A worker can see their OWN row and nobody else's.
//   2. An ADMIN looking at another worker gets hours / gross / net ONLY.
//      The tax breakdown is Super-only.
//
// Both are decisions recorded in docs/features/payroll.md before any code
// existed. This gate is what stops a later refactor quietly undoing them.
//
// WHY SOME ASSERTIONS READ SOURCE
// The projection rules are pure functions and are tested behaviourally. The
// query SCOPING cannot be — it needs a database — so those are asserted
// against the source text. That is deliberately a tripwire, not a proof: it
// fails loudly if the `where` clause that scopes a worker's query is removed
// or renamed, which is the regression that would leak one person's pay to
// another.
//
// WHAT BREAKS IF THIS GATE IS IGNORED
// A worker sees a colleague's net pay, or an admin sees withholding they
// were never meant to. Neither is recoverable by an apology.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { netForJob } from "./reconcileWorkers";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import {
  fieldsFor,
  ADMIN_VISIBLE_FIELDS,
  ALL_NUMERIC_FIELDS,
  EMPLOYER_SIDE_FIELDS,
  WORKER_VISIBLE_FIELDS,
} from "./payroll";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SERVICE_SRC = readFileSync(join(REPO_ROOT, "apps/api/src/services/payroll.ts"), "utf8");
const ROUTES_SRC = readFileSync(join(REPO_ROOT, "apps/api/src/routes/payroll.ts"), "utf8");

/**
 * Everything an admin must NOT receive about another worker. Spelled out
 * rather than derived, so adding a new tax column to the model does not
 * silently widen what an admin can see — the new field is absent from
 * ADMIN_VISIBLE_FIELDS by default and this list is the explicit record of
 * intent.
 */
/**
 * The withholding side — a worker's own pay-stub data. They see all of it;
 * an admin sees none of it for someone else.
 */
const EMPLOYEE_SIDE_TAX_FIELDS = [
  "employeeTaxes",
  "federalIncomeTax",
  "socialSecurityEmployee",
  "medicareEmployee",
  "additionalMedicareEmployee",
  "stateTaxEmployee",
] as const;

const TAX_AND_EMPLOYER_FIELDS = [
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
  "employerCost",
] as const;

describe("payroll build gate — admin projection", () => {
  it("an admin receives ONLY hours / gross / net / check amount", () => {
    expect([...ADMIN_VISIBLE_FIELDS].sort()).toEqual(
      ["checkAmount", "grossEarnings", "netPay", "regularHours"].sort(),
    );
  });

  it("an admin receives NO tax or employer-cost field", () => {
    const admin = fieldsFor({ kind: "admin" });
    for (const f of TAX_AND_EMPLOYER_FIELDS) {
      expect(admin, `admin must not receive ${f}`).not.toContain(f);
    }
  });

  it("the TEAM TOTAL employer cost is super-only too", () => {
    // The per-entry projection withholds employerCost from an admin, but
    // listPeriods also ships a period-level aggregate. Handing an admin the
    // aggregate would have returned, through the back door, exactly the
    // figure fieldsFor() withholds — and on a three-person payroll an
    // aggregate is close enough to per-person to matter.
    //
    // Asserted against the source because the aggregate is built from the
    // stored `totals` JSON, not from fieldsFor(), so it is NOT covered by
    // any assertion above.
    expect(
      SERVICE_SRC,
      "listPeriods must gate teamTotals.employerCost on viewer.kind === 'super'",
    ).toMatch(
      /\.\.\.\(viewer\.kind === "super"\s*\?\s*\{\s*employerCost:/,
    );
  });

  it("an admin does not receive the pay rate", () => {
    // Wage is already a worker-sensitive field elsewhere in the app; the
    // admin payroll view is about reconciling amounts, not rates.
    expect(fieldsFor({ kind: "admin" })).not.toContain("regularRate");
  });

  it("a worker receives their OWN full WITHHOLDING breakdown", () => {
    // It is their own pay-stub data. The hours/gross/net restriction is
    // about an ADMIN looking at someone else, not about a worker's own row.
    const worker = fieldsFor({ kind: "worker", userId: "u1" });
    for (const f of EMPLOYEE_SIDE_TAX_FIELDS) {
      expect(worker, `worker must receive their own ${f}`).toContain(f);
    }
  });

  it("a worker receives NO employer-side field, ever", () => {
    // Narrowed 2026-08-26. `fieldsFor` used to read `admin ? ADMIN : ALL`,
    // so worker and super shared one projection: a worker's own payload
    // carried employerTaxes, FUTA, NC unemployment and employerCost. The
    // UI never rendered them, but client-side omission is not a control —
    // the row was one DevTools tab away.
    //
    // These are the company's books, not a pay stub. Gusto draws the same
    // line: an employee's own account does not show them either.
    const worker = fieldsFor({ kind: "worker", userId: "u1" });
    for (const f of EMPLOYER_SIDE_FIELDS) {
      expect(worker, `worker must NOT receive ${f} — that is the company's book`).not.toContain(f);
    }
  });

  it("the worker projection is derived, so a NEW column defaults to visible", () => {
    // Subtraction, not a hand-maintained list. A new withholding line is
    // the worker's by right and should reach them automatically; anything
    // belonging to the employer has to be declared in EMPLOYER_SIDE_FIELDS
    // to be withheld. The reverse default would silently hide pay-stub
    // data every time the parser gained a column.
    expect([...WORKER_VISIBLE_FIELDS].sort()).toEqual(
      ALL_NUMERIC_FIELDS.filter(
        (f) => !(EMPLOYER_SIDE_FIELDS as readonly string[]).includes(f),
      ).sort(),
    );
  });

  it("every viewer kind is projected explicitly, never by falling through", () => {
    // The original bug was a default: `admin ? ADMIN : ALL` made
    // "everything" the else-branch, so `super` and `worker` silently
    // shared it. Each kind must name its own list.
    const worker = fieldsFor({ kind: "worker", userId: "u1" });
    const admin = fieldsFor({ kind: "admin" });
    const su = fieldsFor({ kind: "super" });
    expect(su).toEqual(ALL_NUMERIC_FIELDS);
    expect(worker).not.toEqual(ALL_NUMERIC_FIELDS);
    expect(admin).not.toEqual(ALL_NUMERIC_FIELDS);
    expect(worker.length).toBeLessThan(su.length);
    expect(admin.length).toBeLessThan(worker.length);
  });

  it("a super receives the full breakdown", () => {
    const su = fieldsFor({ kind: "super" });
    for (const f of TAX_AND_EMPLOYER_FIELDS) {
      expect(su).toContain(f);
    }
  });

  it("the admin field list is a strict subset of all fields", () => {
    for (const f of ADMIN_VISIBLE_FIELDS) expect(ALL_NUMERIC_FIELDS).toContain(f);
    expect(ADMIN_VISIBLE_FIELDS.length).toBeLessThan(ALL_NUMERIC_FIELDS.length);
  });

  it("projection is decided by viewer kind, never defaulted to full", () => {
    // A refactor that made `fieldsFor` return everything for an unknown
    // viewer would pass the tests above while leaking in production.
    expect(fieldsFor({ kind: "admin" })).not.toEqual(ALL_NUMERIC_FIELDS);
    expect(fieldsFor({ kind: "admin" }).length).toBe(ADMIN_VISIBLE_FIELDS.length);
  });
});

describe("payroll build gate — worker query scoping", () => {
  it("listEntries scopes a worker to their own userId", () => {
    // The worker branch must constrain the Prisma `where`, not post-filter.
    expect(SERVICE_SRC).toMatch(/if \(viewer\.kind === "worker"\) \{\s*where\.userId = viewer\.userId;/);
  });

  it("listPeriods scopes a worker by their own entries", () => {
    expect(SERVICE_SRC).toMatch(/entries:\s*\{\s*some:\s*\{\s*userId:\s*viewer\.userId/);
  });

  it("getMyLatest filters by userId", () => {
    expect(SERVICE_SRC).toMatch(/where:\s*\{\s*userId,/);
  });

  it("listEntries ignores forUserId for a worker viewer", () => {
    // Honouring it would turn a documentation parameter into an access
    // grant: a worker passing someone else's id would read their row.
    //
    // Asserted structurally rather than positionally: the worker branch and
    // the forUserId branch must be the two arms of ONE if/else, so there is
    // no path where a worker viewer reaches forUserId.
    expect(SERVICE_SRC).toMatch(
      /if \(viewer\.kind === "worker"\) \{\s*where\.userId = viewer\.userId;\s*\} else if \(forUserId\) \{\s*where\.userId = forUserId;\s*\}/,
    );
  });

  it("an unmatched row is never shown to an admin", () => {
    // No confirmed owner means the number is unattributed; showing it in a
    // per-worker admin view would imply an attribution that does not exist.
    expect(SERVICE_SRC).toMatch(
      /viewer\.kind === "admin" \? entries\.filter\(\(e\) => e\.userId !== null\)/,
    );
  });
});

describe("payroll build gate — route guards", () => {
  it("every /me/payroll route is worker-guarded", () => {
    const meRoutes = [...ROUTES_SRC.matchAll(/app\.get\("(\/me\/payroll[^"]*)",\s*(\w+)/g)];
    expect(meRoutes.length).toBeGreaterThanOrEqual(3);
    for (const [, path, guard] of meRoutes) {
      expect(guard, `${path} must use workerGuard`).toBe("workerGuard");
    }
  });

  it("every /me/payroll route builds a WORKER viewer, never admin or super", () => {
    // The reduced-projection surfaces live under /payroll/*. If a /me route
    // ever constructed an operator viewer it would hand a worker the whole
    // team's data.
    const meBlock = ROUTES_SRC.slice(
      ROUTES_SRC.indexOf("── Worker surfaces"),
      ROUTES_SRC.indexOf("── Operator surfaces"),
    );
    expect(meBlock.length).toBeGreaterThan(0);
    expect(meBlock).not.toMatch(/operatorViewer/);
    expect(meBlock).not.toMatch(/kind:\s*"(admin|super)"/);
    expect(meBlock).toMatch(/kind:\s*"worker"/);
  });

  it("operator read surfaces require at least ADMIN", () => {
    const ops = [...ROUTES_SRC.matchAll(/app\.get\("(\/payroll\/[^"]*)",\s*(\w+)/g)];
    expect(ops.length).toBeGreaterThanOrEqual(2);
    for (const [, path, guard] of ops) {
      expect(["adminGuard", "superGuard"], `${path}`).toContain(guard);
    }
  });

  it("EVERY payroll mutation is Super-only", () => {
    // Import, identity link/unlink, and archive all rewrite what workers
    // see about their own pay. None of them is an admin-level action.
    const mutations = [
      ...ROUTES_SRC.matchAll(/app\.(post|delete|patch|put)\("([^"]*)",\s*(\w+)/g),
    ];
    expect(mutations.length).toBeGreaterThanOrEqual(4);
    for (const [, verb, path, guard] of mutations) {
      expect(guard, `${verb.toUpperCase()} ${path} must be superGuard`).toBe("superGuard");
    }
  });
});

describe("payroll build gate — import safety", () => {
  it("nothing is persisted until every period balances", () => {
    // The conservation loop must complete for ALL periods before the
    // persist loop starts. Interleaving them would leave a two-section
    // file half-imported when the second section is corrupt.
    const fn = SERVICE_SRC.slice(SERVICE_SRC.indexOf("export async function importPayrollCsv"));
    const checkIdx = fn.indexOf("checkConservation");
    const persistIdx = fn.indexOf("persistPeriod(");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(checkIdx);
  });

  it("replacement snapshots the entries it destroys BEFORE deleting them", () => {
    // Re-upload is the only edit path, so this audit row is the sole
    // record of what the numbers were before.
    const replaceIdx = SERVICE_SRC.indexOf("AUDIT.PAYROLL.REPLACED");
    const deleteIdx = SERVICE_SRC.indexOf("tx.payrollEntry.deleteMany");
    expect(replaceIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(replaceIdx);
    expect(SERVICE_SRC).toMatch(/displacedEntries:/);
  });

  it("archive is a soft delete that snapshots what it hides", () => {
    const fn = SERVICE_SRC.slice(SERVICE_SRC.indexOf("export async function archivePeriod"));
    expect(fn).toMatch(/AUDIT\.PAYROLL\.ARCHIVED/);
    expect(fn).toMatch(/archivedAt: new Date\(\)/);
    // No hard delete of the period anywhere in the service.
    expect(SERVICE_SRC).not.toMatch(/payrollPeriod\.delete\b/);
  });
});

describe("payroll build gate — decoupled from the financial system", () => {
  it("payroll never writes an Expense, BusinessExpense, or Payment", () => {
    // The spec's central non-goal. employerCost is a real business cost but
    // wiring it into Expenses would double-count against the worker-payment
    // math already in payments.ts.
    for (const forbidden of [
      /\bexpense\.(create|update|upsert|delete)/i,
      /\bbusinessExpense\.(create|update|upsert|delete)/i,
      /\bpayment\.(create|update|upsert|delete)/i,
      /\bpaymentSplit\./i,
    ]) {
      expect(SERVICE_SRC, `payroll must not touch ${forbidden}`).not.toMatch(forbidden);
      expect(ROUTES_SRC, `payroll must not touch ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("no payroll module imports the P&L or the payroll-tax ESTIMATOR", () => {
    // The app estimates employer payroll tax (payrollTaxEstimates.ts) and
    // shows it as a synthetic "Employer payroll taxes (est.)" P&L line.
    // This feature imports the ACTUAL figures for the same quantities.
    //
    // They must never be connected. Entangling them makes every future
    // question about a P&L number start with "is this a period where
    // payroll happened to be uploaded?" — and the answer changes
    // retroactively as periods are imported, replaced, or archived. A
    // number that silently changes meaning based on unrelated upload
    // activity is worse than one that is consistently an estimate.
    const IMPORT_SRC = readFileSync(
      join(REPO_ROOT, "apps/api/src/services/payrollImport.ts"),
      "utf8",
    );
    for (const [name, src] of [
      ["services/payroll.ts", SERVICE_SRC],
      ["services/payrollImport.ts", IMPORT_SRC],
      ["routes/payroll.ts", ROUTES_SRC],
    ] as const) {
      expect(src, `${name} must not import pnlReport`).not.toMatch(
        /from\s+["'][^"']*pnlReport["']/,
      );
      expect(src, `${name} must not import payrollTaxEstimates`).not.toMatch(
        /from\s+["'][^"']*payrollTaxEstimates["']/,
      );
    }
  });

  it("the P&L and the estimator know nothing about imported payroll", () => {
    // The other direction of the same firewall.
    for (const f of ["pnlReport.ts", "payrollTaxEstimates.ts"]) {
      const src = readFileSync(join(REPO_ROOT, "apps/api/src/services", f), "utf8");
      expect(src, `${f} must not import the payroll service`).not.toMatch(
        /from\s+["']\.\/payroll(Import)?["']/,
      );
      expect(src, `${f} must not read imported payroll rows`).not.toMatch(
        /payrollEntry\.|payrollPeriod\.|PayrollEntry|PayrollPeriod/,
      );
    }
  });

  it('the P&L employer-tax line keeps its "(est.)" label', () => {
    // If actuals ever belong on an operator's P&L they get their own,
    // separately-labelled line — never a substitution into this one.
    const pnl = readFileSync(join(REPO_ROOT, "apps/api/src/services/pnlReport.ts"), "utf8");
    expect(pnl).toMatch(/Employer payroll taxes \(est\.\)/);
  });

  it("payroll models are absent from the tax/QuickBooks exports", () => {
    // Gusto owns payroll tax reporting; the app does not produce 1099s or
    // W-2s and must not smuggle payroll figures into an export.
    const exportsSrc = readFileSync(
      join(REPO_ROOT, "apps/api/src/services/exports.ts"),
      "utf8",
    );
    expect(exportsSrc).not.toMatch(/payrollEntry|payrollPeriod|PayrollEntry|PayrollPeriod/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A made-whole worker must not be reported at twice their pay.
//
// `gross`/`fee` come from the PROMISED snapshot; `topUp` is the make-whole
// stamped on the PaymentSplit when the payment resolves. On a written-off job
// those are two different bases — `gross - fee` ALREADY equals the promised
// net — so the old `gross - fee + topUp` form counted the same money twice.
//
// Shipped: David Wanderski reported at $35.00 on a job he was paid $17.50 for,
// across 12 production rows. Identical two-basis error to the one the payment
// card had, found only because someone asked how tips land across payroll
// cycles.
// ─────────────────────────────────────────────────────────────────────────────
describe("netForJob — the make-whole double-count", () => {
  it("uses the split as the source of truth once a payment exists", () => {
    // $50 job, client never paid, employee made whole at their promised net.
    // Snapshot: gross 25, fee 7.50 -> net 17.50. Top-up: 17.50. Paid: 17.50.
    expect(netForJob({ amount: 17.5 }, 25, 7.5, 17.5)).toBe(17.5);
    // The form that shipped, kept here so the regression is legible:
    expect(25 - 7.5 + 17.5).toBe(35);
  });

  it("still reports the estimate before any payment exists", () => {
    // No split yet — gross/fee are the only basis there is, and a pre-payment
    // estimate must not collapse to $0.
    expect(netForJob(undefined, 25, 7.5, 0)).toBe(17.5);
  });

  it("follows the split even when it diverges from the snapshot", () => {
    // Underpaid contractor: capped at what actually arrived, not the promise.
    expect(netForJob({ amount: 12 }, 25, 7.5, 0)).toBe(12);
    // And upward, when an adjustment paid more than the stale snapshot said.
    expect(netForJob({ amount: 22 }, 25, 7.5, 0)).toBe(22);
  });

  it("is exact to the cent", () => {
    expect(netForJob(undefined, 52.5, 18.375, 0)).toBe(34.13);
  });
});
