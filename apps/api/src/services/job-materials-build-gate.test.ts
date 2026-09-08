// ─────────────────────────────────────────────────────────────────────────────
// Job invoice charges — the two-books split
//
// Canonical spec: docs/features/job-materials.md
//
// THE LEDGER (BusinessExpense) is real money off a bank/card statement and IS
// the Schedule C deduction. AN INVOICE CHARGE is what the client is billed on
// a job and creates NO deduction. They reconcile in AGGREGATE ONLY.
//
// Until 2026-09-06 adding a job line also wrote a BusinessExpense, so the same
// money was deducted twice as soon as the operator entered the real card
// charge — and the line came out of the crew's payout instead of being billed
// to the client.
//
// Every assertion here is mutation-tested: break the thing, watch the gate
// fail, revert. A gate nobody has watched fail is a gate you don't have.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { computeBreakdown } from "@repo/money";
import {
  invoiceTotal,
  invoiceLines,
  crewPool,
  laborAndServices,
  materialChargeTotal,
  materialCostTotal,
  humanizeTag,
  INVOICE_LINES_SELECT,
} from "../lib/jobPricing";

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");
const CHARGES = read("invoiceCharges.ts");
const SUPPLIES = read("supplies.ts");
const PRICING = read("../lib/jobPricing.ts");
const REQUESTS = read("paymentRequests.ts");
const PAYMENTS = read("payments.ts");
const ADMIN = read("../routes/admin.ts");
const WORKER = read("../routes/worker.ts");

const WEB = join(__dirname, "../../../../apps/web/src");
const web = (p: string) => readFileSync(join(WEB, p), "utf8");

/** The spec's worked example: labor $150, 25 bags billed $150 (cost $125),
 *  $50 of edging at cost. Invoice $350, pool $150. */
const CANONICAL = {
  price: 150,
  pricingModel: "ITEMIZED" as const,
  addons: [],
  invoiceCharges: [
    { cost: 150, actualCost: 125 },
    { cost: 50, actualCost: 50 },
  ],
};

const SOLO = [{ userId: "a", splitPercent: 100, workerType: "EMPLOYEE" as any }];
const NO_FEES = { contractorFeePercent: 0, employeeMarginPercent: 0 } as any;

/** Comments explaining what the code must NOT do are full of the very
 *  patterns these gates hunt for. Blank them out (preserving newlines so line
 *  numbers still point at the real offender) before scanning. */
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

function sourceFiles(dir: string, exts: RegExp, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "generated", ".next"].includes(e.name)) continue;
      sourceFiles(full, exts, acc);
    } else if (exts.test(e.name) && !e.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] job lines never touch the tax ledger", () => {
  const fnBody = (name: string) => {
    const at = CHARGES.indexOf(`async ${name}`);
    expect(at, `${name} not found — renamed?`).toBeGreaterThan(-1);
    const rest = CHARGES.slice(at);
    const end = rest.indexOf("\n  async ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("adding a charge writes no BusinessExpense", () => {
    // The dual write meant the same money was deducted twice as soon as the
    // operator also entered the real card charge from their statement.
    expect(fnBody("addInvoiceCharge")).not.toMatch(/businessExpense\.create/);
  });

  it("editing a charge never writes through to the ledger", () => {
    expect(fnBody("updateInvoiceCharge")).not.toMatch(/businessExpense\.(update|create)/);
  });

  it("deleting a charge never deletes a ledger row", () => {
    // Worse than the original bug now the link is many-to-one: a single $500
    // receipt shared by four jobs would vanish the first time any one of them
    // dropped a line.
    expect(fnBody("deleteInvoiceCharge")).not.toMatch(/businessExpense\.delete/);
  });

  it("pulling a supply onto a job writes no BusinessExpense", () => {
    const at = SUPPLIES.indexOf("async addHold");
    const body = SUPPLIES.slice(at, SUPPLIES.indexOf("\n  async ", at + 1));
    expect(body).not.toMatch(/businessExpense\.create/);
  });

  it("recording a supply purchase writes no BusinessExpense", () => {
    // It tracks STOCK, not taxes. The deduction is the card charge.
    const at = SUPPLIES.indexOf("async recordPurchase");
    const body = SUPPLIES.slice(at, SUPPLIES.indexOf("\n  async ", at + 1));
    expect(body).not.toMatch(/businessExpense\.create/);
  });

  it("reversing a purchase never deletes a ledger row", () => {
    const at = SUPPLIES.indexOf("async reversePurchase");
    const body = SUPPLIES.slice(at, SUPPLIES.indexOf("\n  async ", at + 1));
    expect(body).not.toMatch(/businessExpense\.delete/);
  });

  it("the breadcrumb link is decorative — no total reads it", () => {
    // A job line MAY point at a ledger row so the operator can remember what
    // a $500 receipt was for. The moment a figure depends on that link we are
    // back to splitting receipts across jobs.
    for (const [name, src] of [
      ["lib/jobPricing.ts", PRICING],
      ["services/workerEarnings.ts", read("workerEarnings.ts")],
    ] as const) {
      expect(src, `${name} must not compute anything from businessExpenseId`)
        .not.toMatch(/businessExpenseId/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the money math, checked against the engine", () => {
  it("the pool is labor + services, and the engine agrees", () => {
    // There is one rule now. The old gate asserted the number DIFFERED by
    // model; the guarantee today is that it does not vary at all, and that it
    // still matches what computeBreakdown actually pays.
    const o = { price: 100, addons: [{ price: 50 }], invoiceCharges: [{ cost: 60 }] } as any;
    expect(crewPool(o)).toBe(150);
    const br = computeBreakdown(invoiceTotal(o), 60, SOLO, NO_FEES);
    expect(Math.round(br.reduce((s2, r) => s2 + r.gross, 0) * 100) / 100).toBe(150);
  });


  it("the pool equals what the payout engine ACTUALLY pays", () => {
    // The only check that matters, and the one that can't encode a wrong
    // answer: whatever crewPool claims, a solo worker at zero fees must be
    // paid exactly that. Asserting a hand-typed number is how the bug got
    // locked in last time.
    for (const occ of [
      { price: 100, addons: [], invoiceCharges: [{ cost: 60 }] },
      { price: 150, addons: [{ price: 50 }], invoiceCharges: [{ cost: 200 }] },
      { price: 80, addons: [], invoiceCharges: [] },
    ]) {
      for (const pricingModel of ["LEGACY", "ITEMIZED"] as const) {
        const o = { ...occ, pricingModel };
        const paid = computeBreakdown(
          invoiceTotal(o), materialChargeTotal(o), SOLO, NO_FEES,
        )[0].net;
        expect(crewPool(o), `${pricingModel} ${JSON.stringify(occ)}`).toBeCloseTo(paid, 2);
      }
    }
  });

  it("the invoice is the pool plus the charges billed on top", () => {
    const o = { price: 100, addons: [{ price: 50 }], invoiceCharges: [{ cost: 60 }] } as any;
    expect(invoiceTotal(o)).toBe(210);
    expect(invoiceTotal(o)).toBe(crewPool(o) + 60);
  });


  it("changing materials never moves the crew's pay on an ITEMIZED job", () => {
    const before = crewPool(CANONICAL);
    const after = crewPool({ ...CANONICAL, invoiceCharges: [{ cost: 900 }] });
    expect(after).toBe(before);
  });

  it("laborAndServices is labor + add-ons, and add-ons ARE in the pool", () => {
    // The distinction that matters is work vs materials, never service vs
    // charge. Adding a service raises BOTH the invoice and the pool.
    const withService = {
      price: 100, pricingModel: "ITEMIZED" as const,
      addons: [{ price: 50 }], invoiceCharges: [{ cost: 30 }],
    };
    expect(laborAndServices(withService)).toBe(150);
    expect(crewPool(withService)).toBe(150);
    expect(invoiceTotal(withService)).toBe(180);
    // Adding a charge raises ONLY the invoice.
    const more = { ...withService, invoiceCharges: [{ cost: 30 }, { cost: 70 }] };
    expect(crewPool(more)).toBe(150);
    expect(invoiceTotal(more)).toBe(250);
  });

  it("the payout engine needs no branch of its own", () => {
    // N = collected − charges. Feeding it the itemized invoice yields the
    // labor pool automatically, which is why packages/money is untouched.
    const rows = computeBreakdown(invoiceTotal(CANONICAL), materialChargeTotal(CANONICAL), SOLO, NO_FEES);
    expect(rows[0].net).toBeCloseTo(150, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] cost is informational and optional", () => {
  it("a line with no recorded cost contributes nothing to job margin", () => {
    expect(materialCostTotal({ invoiceCharges: [{ actualCost: null }] })).toBe(0);
  });

  it("cost never reaches the invoice", () => {
    const lines = invoiceLines(CANONICAL, { laborLabel: "Mow" });
    expect(JSON.stringify(lines)).not.toMatch(/125/);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(invoiceTotal(CANONICAL), 5);
  });

  it("actualCost is never selected onto a client-facing payload", () => {
    // INVOICE_LINES_SELECT is what the pay page reads.
    expect(JSON.stringify(INVOICE_LINES_SELECT)).not.toMatch(/actualCost/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the invoice is derived, in one place", () => {
  it("computeAmountDue delegates to the shared helper", () => {
    // It used to be price + addons, which never billed materials at all.
    const at = REQUESTS.indexOf("async function computeAmountDue");
    const fn = REQUESTS.slice(at, REQUESTS.indexOf("\n}", at));
    expect(fn).toMatch(/return invoiceTotal\(occ\)/);
  });

  it("the promised-payout snapshot prices off the same helper", () => {
    // Passing labor-only would pay the crew out of a number the client was
    // never billed.
    expect(PAYMENTS).toMatch(/const priceTotal = invoiceTotal\(occ\)/);
    expect(PAYMENTS).toMatch(/computeBreakdown\(priceTotal, charges,/);
  });

  it("nothing re-implements the amount-due arithmetic", () => {
    // `tx.expense.aggregate` survived a rename here once purely because `tx`
    // is loosely typed — the compiler never saw it.
    expect(stripComments(PAYMENTS)).not.toMatch(/\btx\.expense\b/);
    expect(stripComments(REQUESTS)).not.toMatch(/price \?\? 0.*addons.*reduce/s);
  });

  it("one builder serves the pay page AND the preview", () => {
    expect(REQUESTS).toMatch(/export async function buildInvoice\(/);
    expect((REQUESTS.match(/await buildInvoice\(occ\)/g) ?? []).length).toBe(2);
    expect(REQUESTS).toMatch(/export const INVOICE_OCCURRENCE_SELECT = \{/);
    expect((REQUESTS.match(/\.\.\.INVOICE_OCCURRENCE_SELECT/g) ?? []).length).toBe(2);
  });

  it("every charge reaches the client's invoice", () => {
    // Materials used to be suppressed on a legacy visit because they were
    // never billed. After the unification they always are — the price on
    // those rows was reduced to compensate, so the total is unchanged.
    const o = { price: 183.23, addons: [], invoiceCharges: [{ cost: 279.27, description: "Mulch" }] } as any;
    const lines = invoiceLines(o);
    expect(lines).toHaveLength(2);
    expect(Math.round(lines.reduce((s2, l) => s2 + l.amount, 0) * 100) / 100).toBe(462.5);
  });

});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] invoice lines are written for a client, not a database", () => {
  const OCC = {
    price: 65,
    pricingModel: "ITEMIZED" as const,
    addons: [
      { price: 25, tag: "HEDGE", customLabel: null, detail: null },
      { price: 40, tag: "LEAF_CLEANUP", customLabel: null, detail: null },
      { price: 15, tag: "MOW", customLabel: "Extra pass out back", detail: null },
    ],
    invoiceCharges: [],
  };

  it("a preset resolves to its configured label", () => {
    const lines = invoiceLines(OCC, {
      laborLabel: "Mow",
      serviceLabels: { HEDGE: "Hedge", LEAF_CLEANUP: "Leaf Cleanup" },
    });
    expect(lines.map((l) => l.label)).toEqual([
      "Mow", "Hedge", "Leaf Cleanup", "Extra pass out back",
    ]);
  });

  it("no raw key survives even with no catalog at all", () => {
    // A tag removed from the catalog, or a setting that failed to parse.
    for (const l of invoiceLines(OCC, { laborLabel: "Mow" })) {
      expect(l.label, `"${l.label}" is an internal key, not something to bill a client`)
        .not.toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(l.label, `"${l.label}" still carries an underscore`).not.toMatch(/_/);
    }
  });

  it("humanizeTag handles the multi-word case a naive title-caser breaks", () => {
    expect(humanizeTag("LEAF_CLEANUP")).toBe("Leaf cleanup");
    expect(humanizeTag("TREE_TRIM")).toBe("Tree trim");
    expect(humanizeTag("MOW")).toBe("Mow");
    expect(humanizeTag("")).toBe("");
  });

  it("the catalog is loaded once, for the whole invoice", () => {
    // Half the invoice with labels and half with raw keys is worse than
    // either. One load, threaded into the labor line AND the add-ons.
    const at = REQUESTS.indexOf("export async function buildInvoice");
    const fn = REQUESTS.slice(at, REQUESTS.indexOf("function propertyLabel", at));
    expect((fn.match(/serviceLabelMap\(\)/g) ?? []).length).toBe(1);
    expect(fn).toMatch(/laborLabel: jobLabelFor\(occ, labels\)/);
    expect(fn).toMatch(/serviceLabels: labels/);
  });

  it("a malformed catalog degrades, it does not fail the invoice", () => {
    const at = REQUESTS.indexOf("async function serviceLabelMap");
    const fn = REQUESTS.slice(at, REQUESTS.indexOf("function jobLabelFor", at));
    expect(fn).toMatch(/catch/);
    expect(fn).toMatch(/return \{\};/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] a job line raises a customer's bill, so it is admin-only", () => {
  it("every mutation refuses a non-admin", () => {
    for (const fn of [
      "addInvoiceCharge", "updateInvoiceCharge", "deleteInvoiceCharge",
      "adminAddInvoiceCharge",
    ]) {
      const at = CHARGES.indexOf(`async ${fn}`);
      const body = CHARGES.slice(at, CHARGES.indexOf("\n  async ", at + 1));
      expect(body, `${fn} must be admin-only`).toMatch(/isAdminUser|isAdminOrSuper/);
    }
  });

  it("the refusal says WHY, so it doesn't read as a bug", () => {
    expect(CHARGES).toMatch(/it changes what the client is billed/);
  });

  it("an inventory line is an ORDINARY charge — name and amount are editable", () => {
    // They used to be refused with a 409, on the theory that the supply
    // catalog decided what a client owes. It does not: supplies are a
    // stock-tracking layer, and what a client is billed is chosen per job and
    // differs between clients for the same item.
    const SVC = stripComments(read("invoiceCharges.ts"));
    expect(SVC).not.toMatch(/DERIVED_FIELD/);
    expect(SVC).not.toMatch(/its amount follows the quantity/);
  });
  it("null CLEARS detail and actualCost — absent is not the same as null", () => {
    // That is how an operator removes something entered by mistake.
    const at = CHARGES.indexOf("async updateInvoiceCharge");
    const body = CHARGES.slice(at, CHARGES.indexOf("\n  async ", at + 1));
    expect(body).toMatch(/if \("actualCost" in input\)/);
    expect(body).toMatch(/if \("detail" in input\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] only the Ledger writes the Ledger", () => {
  const API_SRC = join(__dirname, "..");
  const LEDGER_OWNERS = ["routes/admin.ts"];
  const WRITE = /\bbusinessExpense\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;

  it("no service, plugin or non-Ledger route mutates a BusinessExpense", () => {
    // The tests above check the call sites we know about. This checks the
    // ones we don't — reviewing by memory found the four sites someone
    // thought of and missed an entire family of admin twins.
    const offenders: string[] = [];
    for (const file of sourceFiles(API_SRC, /\.ts$/)) {
      const rel = relative(API_SRC, file);
      if (LEDGER_OWNERS.includes(rel)) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      for (const m of src.matchAll(WRITE)) {
        offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length} — ${m[0]}`);
      }
    }
    expect(
      offenders,
      "A job, supply or payment path is writing to the tax ledger again. " +
        "See docs/features/job-materials.md.",
    ).toEqual([]);
  });

  it("every ledger mutation in the Ledger routes is Super-gated", () => {
    const src = stripComments(ADMIN);
    for (const m of src.matchAll(WRITE)) {
      const before = src.slice(0, m.index);
      const line = before.split("\n").length;
      const routeIdx = Math.max(
        before.lastIndexOf("app.get("), before.lastIndexOf("app.post("),
        before.lastIndexOf("app.patch("), before.lastIndexOf("app.put("),
        before.lastIndexOf("app.delete("),
      );
      const header = src.slice(routeIdx, routeIdx + 400);
      expect(header, `routes/admin.ts:${line} writes the ledger from a non-Ledger route`)
        .toMatch(/["']\/admin\/business-expenses/);
      expect(header, `routes/admin.ts:${line} ledger write is not superGuard`)
        .toMatch(/superGuard/);
    }
  });

  it("a job status change never re-dates a ledger row", () => {
    // Five sites used to push completedAt onto every linked BusinessExpense.
    // With a many-to-one link that moves a shared receipt's deduction between
    // tax periods — across a year boundary at the worst time of year.
    const JOBS = stripComments(read("jobs.ts"));
    expect(JOBS).not.toMatch(/businessExpense\.updateMany/);
    expect(JOBS).not.toMatch(/businessExpense\.update\b/);
  });

  it("deleting a ledger row unlinks, and never destroys or touches stock", () => {
    // This used to branch: a LEGACY pair was deleted with the row, a
    // breadcrumb merely unlinked, and only pricingModel told them apart —
    // getting it backwards destroyed a deduction twice. With one pricing
    // model a job line is always a charge the CLIENT was billed, so there is
    // one behaviour and no way to pick the wrong one.
    const at = ADMIN.indexOf('app.delete("/admin/business-expenses/:id"');
    expect(at).toBeGreaterThan(-1);
    const body = ADMIN.slice(at, at + 6000);
    expect(body, "a job line must never be deleted with a receipt")
      .not.toMatch(/invoiceCharge\.delete/);
    expect(body).toMatch(/inventoryReversed: false/);
    expect(body, "the pointers clear themselves via SetNull").toMatch(/unlinkedInvoiceCharges/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] a job line is an invoice charge, never an expense", () => {
  const BANNED: Array<[RegExp, string]> = [
    [/\b(prisma|tx)\.expense\b/, "prisma.expense → prisma.invoiceCharge"],
    [/\bmodel Expense\b/, "model Expense → model InvoiceCharge"],
    [/\bServicesExpenses\b/, "ServicesExpenses → ServicesInvoiceCharges"],
    [/\b(add|update|delete|adminAdd|adminDelete)Expense\b/, "…Expense → …InvoiceCharge"],
    [/\blistExpensesByOccurrence\b/, "→ listInvoiceChargesByOccurrence"],
    [/\bExpenseItem\b/, "ExpenseItem → InvoiceChargeItem"],
    [/\bManageExpensesDialog\b/, "→ ManageInvoiceChargesDialog"],
    [/\bAddExpenseDialog\b/, "deleted — use ManageInvoiceChargesDialog"],
    [/\/api\/(admin\/)?(occurrences\/[^"'`]*\/)?expenses\b/, "the /expenses routes are now /invoice-charges"],
  ];

  // The rule above catches IDENTIFIERS and ROUTES. It caught none of the copy
  // a worker actually reads, which kept saying "expenses" and "exp" long after
  // the model was renamed — found by hand, four surfaces at a time. These are
  // the literal shapes that leaked, not a general prose rule: a variable named
  // expTotal is fine, a line on screen that says "$25.00 exp" is not.
  const BANNED_COPY: Array<[RegExp, string]> = [
    [/\}\s*exp[`"']/, '"$25.00 exp" → "$25.00 charges"'],
    [/>\s*Expenses?\s*</, 'JSX label "Expenses" → "Charges"'],
    [/expenses on job/i, '"expenses on job" → "charges on job"'],
    [/Custom Expense/, '"Custom Expense" badge → "Added Charge"'],
    [/estimate based on current expenses/i, "→ the charges on this job right now"],
    [/if expenses are added/i, "→ if charges are added"],
  ];

  it("no copy on screen calls a job line an expense", () => {
    // The LEDGER is exempt — BusinessExpense really is a business expense and
    // its surfaces should say so. The banned word here is the one used for a
    // line on a job.
    const LEDGER_SURFACES = ["ui/tabs/BusinessExpensesTab.tsx"];
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB, /\.tsx?$/)) {
      if (LEDGER_SURFACES.includes(relative(WEB, file))) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      for (const [re, fix] of BANNED_COPY) {
        const m = src.match(re);
        if (!m) continue;
        offenders.push(
          `${relative(WEB, file)}:${src.slice(0, m.index).split("\n").length} — ${JSON.stringify(m[0])} (${fix})`,
        );
      }
    }
    expect(
      offenders,
      "The worker reads this. It says charges everywhere else.",
    ).toEqual([]);
  });

  it("the price badge shows the pool and the charges billed on top", () => {
    // "$125.00 ($85.00 + $15.00)" hides the $25 that made it $125. The badge
    // reads: total, pool in parentheses, then the charges — and the parts add
    // up to the total, 85 + 15 + 25 = 125.
    const TAB = stripComments(web("ui/tabs/JobsTab.tsx"));
    expect(TAB).toMatch(/\{money\(displayPrice\)\}\{poolParts\}/);
    // Charges belong INSIDE the parentheses with the rest of the components.
    // Outside, "$125 ($85 + $15) + $25" reads as an adjustment applied to the
    // total rather than a part of it — and leaves a bracket whose contents
    // don't reach the number in front of them.
    expect(TAB).not.toMatch(/\{poolParts\}\{chargesPart\}/);
  });

  it("BOTH price badges show the charges, not just the compact one", () => {
    // There are two: the compact card's and the expanded card's. The expanded
    // one shipped reading "$125.00 ($85.00 + $15.00)" — parts summing to $100
    // against a stated $125, because the $25 of charges that made up the
    // difference was never rendered. A breakdown that doesn't reach its own
    // total is worse than no breakdown.
    const TAB = stripComments(web("ui/tabs/JobsTab.tsx"));

    // COMPACT: one inline parenthetical, "$125 ($85 + $15 + $25)". Space is
    // the constraint there, so the components go unlabelled — but charges are
    // in the list, and the bracket only renders when it says something the
    // total doesn't.
    expect(TAB).toMatch(/\{money\(displayPrice\)\}\{poolParts\}/);
    expect(TAB).toMatch(/if \(billedCharges > 0\) components\.push\(money\(billedCharges\)\)/);
    expect(TAB).toMatch(/components\.length > 1 \? ` \(\$\{components\.join\(" \+ "\)\}\)` : ""/);

    // EXPANDED: the same components, ITEMIZED WITH THEIR NAMES. Three
    // unlabelled numbers in brackets is arithmetic the reader has to decode
    // before it tells them anything, and this card is read to be checked.
    expect(TAB).toMatch(/\["Base labor", basePrice \?\? 0\]/);
    expect(TAB).toMatch(/lines\.push\(\["Added services", addonsAmt\]\)/);
    expect(TAB).toMatch(/lines\.push\(\["Invoice charges", billedCharges\]\)/);
    // …and the breakdown is suppressed when it would only restate the total.
    expect(TAB).toMatch(/\{lines\.length > 1 && \(/);

    // The expanded surface is ONE badge: the total, the payout and the math
    // that connects them share a container. Split across two surfaces the
    // reader has to work out whether the small print belongs to the number
    // above it.
    expect(TAB).toMatch(/borderColor="green\.300" borderRadius="xl"[^\n]*bg="green\.50"/);

    // Both read every charge — there is no era in which one is suppressed.
    expect((TAB.match(/materialChargeTotal\(occ\)/g) ?? []).length).toBe(2);
    expect(TAB, "no era check may survive in the badges").not.toMatch(/pricingModel/);
  });

  it("the compact badge rounds up, but never so the parts stop adding up", () => {
    // Whole dollars on a card that is scanned rather than reconciled — but
    // ceiling each part independently can overshoot the ceiling of the total,
    // and a badge whose own arithmetic is visibly wrong is worse than one with
    // decimals. The exact figures stand in that case.
    const TAB = stripComments(web("ui/tabs/JobsTab.tsx"));
    expect(TAB).toMatch(/const up = \(n: number\) => Math\.ceil\(n\)/);
    expect(TAB).toMatch(
      /up\(displayPrice\) === up\(basePrice \?\? 0\) \+ up\(addonsAmt\) \+ up\(billedCharges\)/,
    );
    expect(TAB).toMatch(/partsAddUp \? `\$\$\{up\(n\)\.toLocaleString\(\)\}` : `\$\$\{n\.toFixed\(2\)\}`/);
  });

  it("every projected figure on a compact card rounds the same way", () => {
    // A card that mixes "$125" with "payout: $70.00" reads as two different
    // kinds of number. The payout and tip badges go through the same rounder.
    const TAB = stripComments(web("ui/tabs/JobsTab.tsx"));
    expect(TAB).toMatch(/const compactMoney = \(n: number\) => `\$\$\{up\(n\)\.toLocaleString\(\)\}`/);
    expect(TAB).toMatch(/\{label\}: \{compactMoney\(payout\)\}/);
    expect(TAB).toMatch(/Your tip: \$\{compactMoney\(mine\)\}/);
  });

  it("a payout line never subtracts charges, because the pool never loses them", () => {
    const TAB = stripComments(web("ui/tabs/JobsTab.tsx"));
    expect(TAB).toMatch(/const chargesRaw = 0;/);
    expect(TAB).not.toMatch(/chargesTot > 0 \? ` − /);
  });


  it("every payout line states the number it arrives at", () => {
    // "$85 + $15 − $30 margin (30%)" leaves the reader to do the arithmetic
    // and hope it matches the badge above. Ending in "= $70.00" makes the
    // line check itself.
    const TAB = stripComments(web("ui/tabs/JobsTab.tsx"));
    expect(TAB).toMatch(/\{rateBasis\}\) = \$\{myPayout\.toFixed\(2\)\}/);
    expect(TAB).toMatch(/\{rateBasis\}\) = \$\{rows\[0\]\.payout\.toFixed\(2\)\}/);
  });

  it("charges kept out of the pool say where they went", () => {
    // They are in the total on the badge above. A worker who cannot find them
    // in the payout line goes looking for them.
    expect(stripComments(web("ui/tabs/JobsTab.tsx"))).toMatch(
      /charges are billed to the client on top — not part of the crew's pool/,
    );
  });

  it("a rate says what it is a percentage of", () => {
    // "(30%)" alone invites the reader to apply it to the invoice total, which
    // includes charges the rate never touches. And "of labor" is only exact
    // when there are no services — on a visit with one, the basis is the pool.
    const TAB = stripComments(web("ui/tabs/JobsTab.tsx"));
    expect(TAB).toMatch(/"of labor \+ services"/);
    expect(TAB).toMatch(/: "of labor"/);
    // LEGACY subtracts charges before applying the rate, so neither of the
    // above describes the basis there.
    expect(TAB).toMatch(/chargesDeducted > 0\s*\n?\s*\? "of what's left"/);
    // No bare percentage left on a payout line.
    expect(TAB).not.toMatch(/\{viewerRate\}%\)/);
    expect(TAB).not.toMatch(/\{rows\[0\]\.ratePct\}%\)/);
    // The per-worker rows apply the rate to that worker's share, not the pool.
    expect(TAB).toMatch(/\{r\.ratePct\}% of share\)/);
  });

  it("the expanded card keeps its decimals", () => {
    // The rounding is a compact-card affordance. poolPrefix drives the
    // expanded card's payout math, where the figures are checked.
    expect(stripComments(web("ui/tabs/JobsTab.tsx")))
      .toMatch(/base labor \+ \$\$\{addonsAmt\.toFixed\(2\)\} services/);
  });

  it("the badge shows every charge — nothing is suppressed by era", () => {
    const TAB = stripComments(web("ui/tabs/JobsTab.tsx"));
    expect((TAB.match(/materialChargeTotal\(occ\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(TAB, "no era check may survive").not.toMatch(/pricingModel/);
  });


  it("the projected-payout line names labor and services separately", () => {
    // "$100.00 − $25.00 charges" is unverifiable — a worker who added a $15
    // service cannot tell whether it is in the $100 at all.
    const TAB = stripComments(web("ui/tabs/JobsTab.tsx"));
    expect(TAB).toMatch(/base labor \+ \$\$\{addonsAmt\.toFixed\(2\)\} services/);
    // …and every payout line reads it, rather than re-deriving its own.
    expect(TAB.match(/\{poolPrefix\}/g) ?? []).toHaveLength(3);
  });

  it("the cards call add-ons Added Services", () => {
    // "Add-on" is the schema's word (OccurrenceAddon). The operator's word is
    // Added Services, and it pairs with the Edit Services button.
    for (const f of ["ui/tabs/JobsTab.tsx", "ui/tabs/ServicesTab.tsx"]) {
      expect(stripComments(web(f)), f).toContain("Added Services:");
    }
  });

  it("no source file uses the retired job-line vocabulary", () => {
    const offenders: string[] = [];
    for (const root of [join(__dirname, ".."), WEB]) {
      for (const file of sourceFiles(root, /\.tsx?$/)) {
        const src = stripComments(readFileSync(file, "utf8"));
        for (const [re, fix] of BANNED) {
          const m = src.match(re);
          if (!m) continue;
          offenders.push(
            `${relative(join(root, ".."), file)}:${src.slice(0, m.index).split("\n").length} — ${m[0]} (${fix})`,
          );
        }
      }
    }
    expect(
      offenders,
      "A job line is what the CLIENT IS CHARGED, not a business expense.",
    ).toEqual([]);
  });

  it("the schema keeps the physical table, so the rename needs no migration", () => {
    const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/model InvoiceCharge \{/);
    expect(schema).toMatch(/@@map\("Expense"\)/);
    expect(schema).toMatch(/invoiceChargeId String\?\s+@unique @map\("expenseId"\)/);
  });

  it("the Ledger vocabulary is untouched — it really is an expense", () => {
    const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/model BusinessExpense \{/);
    expect(schema).toMatch(/businessExpenseId String\?/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] every payout projection branches on the pricing model", () => {
  it("the shared helper has no era to require", () => {
    const H = stripComments(readFileSync(join(__dirname, "./workerEarnings.ts"), "utf8"));
    expect(H).not.toMatch(/pricingModel|LEGACY/);
    expect(H).toMatch(/const N = displayPrice;/);
  });


  it("the web mirror agrees, and still says the server is authoritative", () => {
    const raw = web("ui/tabs/JobsTab.utils.ts");
    expect(stripComments(raw)).not.toMatch(/pricingModel|LEGACY/);
    // The doc comment is the point of this one, so read the file unstripped.
    expect(raw).toMatch(/server is[\s\S]{0,40}authoritative/);
  });


  it("no projection subtracts charges unconditionally", () => {
    // A shared library kept the LEGACY formula after the itemized model
    // shipped and a card promised a worker $10.50 on a job the server would
    // pay $45.50 for — two numbers for one job, on the same screen.
    const offenders: string[] = [];
    for (const root of [join(__dirname, ".."), WEB]) {
      for (const file of sourceFiles(root, /\.tsx?$/)) {
        const src = stripComments(readFileSync(file, "utf8"));
        for (const m of src.matchAll(/Math\.max\(0,\s*displayPrice[^)]*-[^)]*\)/g)) {
          const around = src.slice(Math.max(0, m.index! - 400), m.index! + 200);
          if (!/pricingModel/.test(around)) {
            offenders.push(`${relative(join(root, ".."), file)} — ${m[0].slice(0, 60)}`);
          }
        }
      }
    }
    expect(offenders, "a payout projection is using the LEGACY formula unconditionally")
      .toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the charge dialog behaves the same in every scenario", () => {
  const DLG = web("ui/dialogs/ManageInvoiceChargesDialog.tsx");

  it("one component renders both the add form and the edit form", () => {
    // Two separate layouts drift within days: the add form grows a field the
    // edit form doesn't have, and a detail typed once can never be corrected.
    expect(DLG).toMatch(/function ChargeFields\(/);
    expect((DLG.match(/<ChargeFields\b/g) ?? []).length).toBe(2);
  });

  it("the edit form carries state for all four fields", () => {
    for (const st of ["editCost", "editDesc", "editDetail", "editActualCost"]) {
      const setter = `set${st[0].toUpperCase()}${st.slice(1)}`;
      expect(DLG, `${st} must exist`).toContain(`[${st}, ${setter}]`);
    }
  });

  it("Edit seeds every field from the row, not just name and amount", () => {
    const at = DLG.indexOf("setEditingId(exp.id);");
    const seed = DLG.slice(at, at + 500);
    expect(seed).toMatch(/setEditCost\(/);
    expect(seed).toMatch(/setEditDesc\(/);
    expect(seed).toMatch(/setEditDetail\(exp\.detail/);
    expect(seed).toMatch(/setEditActualCost\(/);
  });

  it("saving an edit sends detail and actualCost, and null clears them", () => {
    const at = DLG.indexOf("async function handleUpdate");
    const fn = DLG.slice(at, DLG.indexOf("\n  const total", at));
    expect(fn).toMatch(/detail: editDetail\.trim\(\) \|\| null/);
    expect(fn).toMatch(/actualCost: editActualCost\.trim\(\) \? parseFloat\(editActualCost\) : null/);
  });

  it("an admin edits through the admin route, like every other verb", () => {
    const at = DLG.indexOf("async function handleUpdate");
    const fn = DLG.slice(at, DLG.indexOf("\n  const total", at));
    expect(fn).toMatch(/isAdmin\s*\n?\s*\?\s*`\/api\/admin\/invoice-charges\/\$\{editingId\}`/);
    // …and that route has to exist. It didn't, once.
    expect(ADMIN).toMatch(/app\.patch\("\/admin\/invoice-charges\/:id", adminGuard/);
  });

  it("the dialog locks nothing on an inventory line", () => {
    const DLG = stripComments(web("ui/dialogs/ManageInvoiceChargesDialog.tsx"));
    expect(DLG).toMatch(/<CurrencyInput value=\{cost\} onChange=\{setCost\} size="sm" \/>/);
    // It explains what the quantity still controls instead of locking a field.
    expect(DLG).toMatch(/re-prices this line/);
  });
  it("a non-admin gets a read-only list, not buttons that 403", () => {
    expect(DLG).toMatch(/\{canCharge && \(\s*\n?\s*<Button[\s\S]{0,500}?Edit/);
    expect(DLG).toMatch(/\{canCharge && \(\s*\n?\s*<Button[\s\S]{0,500}?colorPalette="red"/);
  });

  it("reopening the dialog clears every add field", () => {
    const at = DLG.indexOf("setAddMode(null);");
    const reset = DLG.slice(at, at + 400);
    for (const f of ["setNewCost", "setNewDesc", "setNewDetail", "setNewActualCost"]) {
      expect(reset, `${f} must reset when the dialog opens`).toContain(`${f}("")`);
    }
  });

  it("a recorded cost is visible on the row, not write-only", () => {
    expect(DLG).toMatch(/No cost recorded/);
    expect(DLG).toMatch(/margin/);
  });

  it("no Schedule C picker and no receipt upload", () => {
    expect(DLG).not.toMatch(/Schedule C/);
    expect(DLG).not.toMatch(/ReceiptUpload/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the wording matches what the thing does", () => {
  const DLG = web("ui/dialogs/ManageInvoiceChargesDialog.tsx");

  it("it does NOT claim these aren't business expenses", () => {
    // That phrasing reads as false to anyone who just paid for the mulch, and
    // confused a worker in testing. The money WAS spent; what's true is
    // narrower — this row is not the TAX RECORD.
    expect(DLG).not.toMatch(/not.{0,20}a business expense/is);
    expect(DLG).toMatch(/not where the\s*\n?\s*deduction is recorded/s);
    expect(DLG).toMatch(/Ledger/);
  });

  it("a worker sees copy written for someone who cannot add one", () => {
    expect(DLG).toMatch(/Only an admin can add or change them/);
    expect(DLG).toMatch(/don&rsquo;t come out of your pay/);
  });

  it("the button and dialog say Edit Charges", () => {
    // "Add" understated it: the dialog lists what is on the visit and is the
    // only place a line comes off. "Edit" is what the operator is doing, and
    // it pairs with Edit Services on the same row.
    expect(DLG).toMatch(/<Dialog\.Title>Edit Charges<\/Dialog\.Title>/);
    expect(web("ui/tabs/JobsTab.tsx")).toMatch(/Edit Charges/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] services carry the same optional detail as charges", () => {
  const ADDON_DLG = web("ui/dialogs/ManageAddonsDialog.tsx");

  it("the Add Service dialog collects a client-visible detail", () => {
    expect(ADDON_DLG).toMatch(/Detail for the client/);
    expect(ADDON_DLG).toMatch(/detail: detail\.trim\(\) \|\| undefined/);
  });

  it("both addon routes persist it — neither drops it on the floor", () => {
    for (const [name, src] of [["worker", WORKER], ["admin", ADMIN]] as const) {
      const at = src.indexOf("occurrences/:id/addons");
      const body = src.slice(at, src.indexOf("\n  app.", at));
      expect(body, `${name} addon route must write detail`)
        .toMatch(/detail: detail\?\.trim\(\) \|\| null/);
    }
  });

  it("a service line reaches the invoice with its detail", () => {
    expect(PRICING).toMatch(/for \(const a of occ\.addons \?\? \[\]\)/);
    expect(PRICING).toMatch(/detail: a\.detail\?\.trim\(\) \|\| null/);
    expect(INVOICE_LINES_SELECT.addons.select).toHaveProperty("detail", true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] services have one implementation, and one way off a visit", () => {
  const SHARED = "ui/dialogs/ManageAddonsDialog.tsx";

  it("only the shared dialog POSTs an add-on", () => {
    // There were three: an inline dialog in JobsTab, the shared one in
    // ServicesTab, and a broken one in OccurrenceDialog whose charges were
    // silently discarded on create.
    const offenders: string[] = [];
    for (const f of sourceFiles(WEB, /\.tsx?$/)) {
      const rel = relative(WEB, f);
      if (rel === SHARED) continue;
      if (/apiPost[^\n]*\/addons`/.test(stripComments(readFileSync(f, "utf8")))) offenders.push(rel);
    }
    expect(offenders, "Services live in ManageAddonsDialog. A second copy drifts.").toEqual([]);
  });

  it("only the shared dialog DELETEs an add-on", () => {
    // The job card carried a bare red ✕ on every add-on line: one tap on a
    // collapsed card and a line came off the client's invoice. Taking money
    // off an invoice is not a thing to do in passing — you open the dialog,
    // where every line is in view at once.
    const offenders: string[] = [];
    for (const f of sourceFiles(WEB, /\.tsx?$/)) {
      const rel = relative(WEB, f);
      if (rel === SHARED) continue;
      if (/apiDelete[^\n]*\/addons\//.test(stripComments(readFileSync(f, "utf8")))) offenders.push(rel);
    }
    expect(
      offenders,
      "A service is removed in ManageAddonsDialog, never from a card.",
    ).toEqual([]);
  });

  it("the dialog confirms before taking a service off the invoice", () => {
    const T = stripComments(web(SHARED));
    expect(T).toMatch(/<ConfirmDialog/);
    expect(T).toMatch(/Remove this service\?/);
  });

  it("the shared dialog owns its own pricing hints and guide", () => {
    // So a third mount costs one line, not 120.
    expect(ADDON_DLG_SRC).toMatch(/apiGet<PricingHintEntry\[\]>/);
    expect(ADDON_DLG_SRC).toMatch(/<PricingGuideDialog/);
  });

  it("no caller re-implements the hint lookup", () => {
    for (const name of ["ui/tabs/JobsTab.tsx", "ui/tabs/ServicesTab.tsx"]) {
      expect(web(name), `${name} must not keep its own add-on form state`)
        .not.toMatch(/addonHintEntry|setAddonPrice|setAddonTag/);
    }
  });
});
const ADDON_DLG_SRC = web("ui/dialogs/ManageAddonsDialog.tsx");

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] charges are added from the card, never at creation", () => {
  const OCC_DLG = web("ui/dialogs/OccurrenceDialog.tsx");

  it("the occurrence dialog edits no charges at all", () => {
    // In CREATE mode charges were posted one at a time after the occurrence
    // came back, with every failure swallowed to console.error — so a charge
    // could silently not exist while the operator watched it in a list.
    const code = stripComments(OCC_DLG);
    expect(code).not.toMatch(/setExpenses\(|newExpCost|newExpDesc|expenseCategoryItems/);
    expect(code, "no charge writes from the create/update dialog")
      .not.toMatch(/\/invoice-charges\b/);
  });

  it("the card still lists them, and opens the dialog to change them", () => {
    const TAB = web("ui/tabs/JobsTab.tsx");
    expect(TAB).toMatch(/<ManageInvoiceChargesDialog/);
    expect(TAB).toMatch(/Edit Charges/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the invoice preview cannot drift from the invoice", () => {
  const PREVIEW = web("ui/dialogs/InvoicePreviewDialog.tsx");
  const TAB = web("ui/tabs/JobsTab.tsx");

  it("the preview computes no money of its own", () => {
    const at = REQUESTS.indexOf("async previewInvoice");
    const fn = REQUESTS.slice(at, REQUESTS.indexOf("\n  async ", at + 1));
    expect(fn).not.toMatch(/invoiceTotal\(|invoiceLines\(/);
    expect(fn).toMatch(/await buildInvoice\(occ\)/);
    // crewPool is a DIFFERENT number and legitimately belongs — but from the
    // shared helper, and never inside buildInvoice (the client's payload).
    expect(fn).toMatch(/crewPool: crewPool\(occ as any\)/);
    expect(REQUESTS.slice(
      REQUESTS.indexOf("export async function buildInvoice"),
      REQUESTS.indexOf("function propertyLabel"),
    )).not.toMatch(/crewPool/);
  });

  it("previewing changes nothing — it is a read", () => {
    const at = REQUESTS.indexOf("async previewInvoice");
    const fn = REQUESTS.slice(at, REQUESTS.indexOf("\n  async ", at + 1));
    for (const w of [/\.update\(/, /\.create\(/, /\.delete\(/, /writeAudit\(/, /randomBytes\(/]) {
      expect(fn, `previewInvoice must not write: ${w}`).not.toMatch(w);
    }
  });

  it("the client never renders a number the preview invented", () => {
    expect(PREVIEW).toMatch(/dollar\(data\.amountDue\)/);
    expect(PREVIEW).not.toMatch(/reduce\(/);
  });

  it("it is admin/super only, on the route AND the button", () => {
    expect(ADMIN).toMatch(/app\.get\("\/admin\/occurrences\/:id\/invoice-preview", adminGuard/);
    // Gated on the SELECTED scope. `forAdmin ||` would light it up for a
    // super sitting on another chip.
    // It lives on the Admin row, gated on the SELECTED scope. `forAdmin`
    // here would light it up for a super sitting on another chip.
    const at = TAB.indexOf("adminExtras={");
    expect(at, "the preview button must be on the Admin row").toBeGreaterThan(-1);
    const gate = TAB.slice(at, TAB.indexOf("\n                />", at));
    // The ROW is gated on the selected scope…
    expect(gate).toMatch(/!isCardCompact && \(isAdmin \|\| isSuper\)/);
    expect(gate).toMatch(/Invoice preview/);
    // …and the preview's OWN condition adds no `forAdmin`, which would light
    // it up for a super sitting on another chip. Scoped to this button's
    // conditional rather than "anything before the label" — other buttons on
    // the row carry their own, stricter, pre-existing gates.
    const own = gate.slice(gate.lastIndexOf("{", gate.indexOf("Invoice preview")) - 200,
                           gate.indexOf("Invoice preview"));
    expect(own).not.toMatch(/forAdmin/);
  });

  it("it says on its face that it is not a record", () => {
    expect(PREVIEW).toMatch(/isn&rsquo;t a\s*\n?\s*record of anything/);
    expect(PREVIEW).toMatch(/Not sent/);
  });

  it("it warns what the crew does and doesn't share, with real numbers", () => {
    expect(PREVIEW).toMatch(/dollar\(data\.crewPool\)/);
    expect(PREVIEW).toMatch(/data\.amountDue - data\.crewPool/);
  });

  it("the warning describes THIS job, not the rule in general", () => {
    // On a job with no charges every dollar IS shared. Heading that "Not all
    // of this is shared" over a "Not shared $0.00" row states something false
    // about the invoice on screen, and a box that cries wolf on the plain case
    // teaches the operator to skip it on the job where the split matters.
    //
    // Asserted structurally rather than by copy: both headings must exist and
    // must be selected by the same computed figure that drives the styling.
    expect(PREVIEW).toMatch(/const notShared = Math\.max\(/);
    expect(PREVIEW).toMatch(/notShared > 0\s*\n?\s*\? "Not all of this is shared with the crew"/);
    expect(PREVIEW).toMatch(/: "All of this is shared with the crew"/);
    // Yellow is reserved for the case that actually needs a caution.
    expect(PREVIEW).toMatch(/bg=\{notShared > 0 \? "yellow\.subtle" :/);
    // And the $0.00 row is not rendered at all.
    expect(PREVIEW).toMatch(/\{notShared > 0 && \(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the card leads with what the crew shares", () => {
  const TAB = web("ui/tabs/JobsTab.tsx");

  it("the collapsed row shows labor and the rest separately", () => {
    // Showing only the invoice total reads as a much better day than the crew
    // is actually having.
    expect(TAB).toMatch(/const ultraLabor = crewPool\(occ\);/);
    expect(TAB).toMatch(/const ultraRest =\s*\n?\s*total != null \? Math\.round\(\(total - ultraLabor\)/);
    expect(TAB).toMatch(/\$\{Math\.round\(ultraLabor\)\.toLocaleString\(\)\}/);
    expect(TAB).toMatch(/\+\$\{Math\.round\(ultraRest\)\.toLocaleString\(\)\}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] nothing applies the LEGACY rule to every visit", () => {
  // THE MOST EXPENSIVE MISTAKE IN THIS FEATURE, and it recurred in six places.
  //
  // `computeBreakdown(collected, charges)` computes N = collected − charges.
  // Feeding it labor-only (`price + addons`) and then subtracting the charges
  // is the LEGACY rule. On an ITEMIZED visit the client pays the materials ON
  // TOP, so the pool never sees them — labor-only minus charges takes the
  // mulch out of the crew's pay a second time.
  //
  // It shipped in the payout CONTRACT (adjustOccurrencePrice), the P&L wage
  // accrual, the workdays CSV, an admin earnings projection, and the claim
  // agreement a worker signs. Every one silently under-paid or under-reported.
  //
  // The shape is mechanical, so the check is too: any file that computes a
  // labor-only price total AND a charges total is required to name the branch.
  const PRICE_ONLY = /(price|priceTotal)[^\n]*\?\?[^\n]*\)\s*\+[^\n]*addons?/i;

  it("every file that totals charges also names the pricing model", () => {
    const offenders: string[] = [];
    for (const root of [join(__dirname, ".."), WEB]) {
      for (const file of sourceFiles(root, /\.tsx?$/)) {
        const rel = relative(join(root, ".."), file);
        if (rel.includes("build-gate") || rel.includes(".test.")) continue;
        const src = stripComments(readFileSync(file, "utf8"));
        // Only files that actually do pool arithmetic.
        const totalsCharges =
          /invoiceCharges[^\n]*reduce\(/.test(src)
          || /invoiceCharge\.aggregate/.test(src);
        if (!totalsCharges) continue;
        // A file may legitimately never branch — if it never builds a pool
        // from a labor-only figure. Those pass `collected` (cash) instead.
        if (!PRICE_ONLY.test(src)) continue;
        if (/pricingModel/.test(src) || /invoiceTotal\(|crewPool\(/.test(src)) continue;
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      "builds a pool from labor-only and charges without branching on pricingModel",
    ).toEqual([]);
  });

  it("a worker's pay stats never subtract charges", () => {
    // Charges come out of nobody's pay under either model: ITEMIZED bills them
    // on top, LEGACY took them out of the pool BEFORE the split. Subtracting
    // them from a worker's earnings docks them for materials the business
    // billed to the client.
    const worker = stripComments(readFileSync(join(__dirname, "../routes/worker.ts"), "utf8"));
    expect(worker).not.toMatch(/netEarnings = totalEarnings - totalExpenses/);
    expect(worker).toMatch(/const netEarnings = totalEarnings;/);
    const admin = stripComments(readFileSync(join(__dirname, "../routes/admin.ts"), "utf8"));
    expect(admin).not.toMatch(/netEarnings \+= earnings - expenseShare/);
  });

  it("the claim agreement projects the pool the server will pay", () => {
    // This is the number a worker AGREES TO. It once read price − charges,
    // so an itemized claim understated their own pay.
    const dlg = stripComments(web("ui/dialogs/ClaimAgreementDialog.tsx"));
    expect(dlg).toMatch(/const net = price;/);
    expect(dlg).not.toMatch(/pricingModel|LEGACY/);
  });

});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] removing a charge confirms and is reachable without sight", () => {
  const DLG = () => stripComments(web("ui/dialogs/ManageInvoiceChargesDialog.tsx"));

  it("deleting a charge asks first", () => {
    // Removing a line LOWERS WHAT THE CLIENT OWES. The inline ✕ was taken off
    // the job card for exactly this reason — and the dialog it moved into
    // deleted on a single tap, with no confirm at all. Found by driving it,
    // not by reading it.
    const T = DLG();
    expect(T).toMatch(/<ConfirmDialog/);
    expect(T).toMatch(/Remove this charge\?/);
    expect(T).toMatch(/onClick=\{\(\) => setRemoving\(exp\)\}/);
    expect(T, "the ✕ must not call handleDelete directly")
      .not.toMatch(/onClick=\{\(\) => handleDelete\(exp\.id\)\}/);
  });

  it("the remove control has a name a screen reader can use", () => {
    // "✕" is the whole accessible name of a control that takes money off an
    // invoice.
    expect(DLG()).toMatch(/aria-label=\{`Remove charge: \$\{exp\.description\}`\}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the ledger breadcrumb is reachable where charges are entered", () => {
  it("the picker follows the ROLE, not which chip you're on", () => {
    // `isAdmin` on this dialog means "this is the admin VIEW" and picks the
    // endpoint set. Gating the picker on it hid the link on the Worker chip —
    // which is exactly where an admin who claimed their own job enters the
    // charge. Adding was allowed there; linking was not.
    const DLG = stripComments(web("ui/dialogs/ManageInvoiceChargesDialog.tsx"));
    expect(DLG).toMatch(/const canLink = canLinkLedger \?\? !!isAdmin;/);
    expect(DLG).toMatch(/\{canLink && \(/);
    expect(DLG).not.toMatch(/\{isAdmin && \(\s*\n\s*<Box pl=\{1\}>/);
    // The job card passes the role, not the view.
    expect(stripComments(web("ui/tabs/JobsTab.tsx")))
      .toMatch(/canLinkLedger=\{hasAdminRole \|\| hasSuperRole\}/);
  });

  it("both ledger endpoints exist for it to call", () => {
    const R = stripComments(readFileSync(join(__dirname, "../routes/admin.ts"), "utf8"));
    expect(R).toMatch(/app\.get\("\/admin\/ledger-charges", adminGuard/);
    expect(R).toMatch(/app\.patch\("\/admin\/invoice-charges\/:id\/ledger-link", adminGuard/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the integrity check runs itself", () => {
  // "Remember to run the verification before promoting" is not a safeguard.
  // The day it matters is a production migration that rewrites what clients
  // were invoiced and crews were paid, and that is the day nobody wants an
  // extra step.
  const PKG = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
  const DEPLOY = readFileSync(join(__dirname, "../../scripts/migrate-deploy.ts"), "utf8");
  const VERIFY = readFileSync(join(__dirname, "../../scripts/verify-ledger-integrity.ts"), "utf8");

  it("migrating runs the verification, it is not a separate step", () => {
    expect(PKG.scripts["migrate:deploy"]).toBe("tsx scripts/migrate-deploy.ts");
    // Before AND after: the first pass separates damage this deploy caused
    // from damage it inherited.
    expect((DEPLOY.match(/verify-ledger-integrity\.ts/g) ?? []).length).toBe(2);
    expect(DEPLOY).toMatch(/prisma", "migrate", "deploy"/);
  });

  it("blocks on what the deploy BROKE, not on what it inherited", () => {
    // The two passes are diffed and only NEW problems are fatal.
    //
    // Blocking on any failure at all sounds safer and is not. Production
    // carries 117 payments predating the per-split breakdown columns, whose
    // `amount` means something different; a verifier that reads them the
    // modern way reported 43 correct payments as damaged. Under a
    // block-on-anything rule EVERY deploy goes red for inherited reasons, the
    // operator learns the red means nothing, and the one that matters gets
    // waved through.
    expect(DEPLOY).toMatch(/const introduced = /);
    expect(DEPLOY).toMatch(/!problemsBefore\.has\(m\)/);
    expect(DEPLOY).toMatch(/INTRODUCED \$\{introduced\.length\} NEW INTEGRITY PROBLEM/);
    expect(DEPLOY).toMatch(/process\.exit\(1\)/);
    // Both passes must be CAPTURED, or there is nothing to diff.
    expect(DEPLOY).toMatch(/runCapture\("npx", \["tsx", "scripts\/verify-ledger-integrity\.ts"\]\)/);
    // …and a pre-existing failure must NOT block, or a broken database
    // becomes a database that can never be migrated forward.
    expect(DEPLOY).toMatch(/Not blocking/);
  });

  it("the verifier reads a split the same way the app does", () => {
    // `PaymentSplit.amount` is the worker's NET where the per-split breakdown
    // columns exist and their GROSS where they do not. services/payments.ts
    // branches on exactly this; a verifier that does not is checking different
    // books from the ones the app keeps.
    expect(VERIFY).toMatch(/sp\.netAmount != null/);
    expect(VERIFY).toMatch(/hasBreakdown/);
    // Pre-breakdown rows are genuinely ambiguous — production holds 48 stored
    // gross and 74 stored net — so either reading is accepted there, and only
    // a row reconciling under NEITHER is a problem.
    expect(VERIFY).toMatch(/asGross/);
    expect(VERIFY).toMatch(/reconciles under neither reading/);
  });

  it("it catches the one way the unification could have gone wrong", () => {
    // There used to be a pricingModel column and a mis-run backfill could
    // flip a row to the wrong era — internally consistent, and invisible to a
    // per-row check. The column is gone, so that failure mode is gone with it.
    //
    // What remains is the migration's own arithmetic: it sets
    // `price = price − charges`, so the way it breaks is a NEGATIVE price.
    expect(VERIFY).toMatch(/where: \{ price: \{ lt: 0 \} \}/);
    expect(VERIFY).toMatch(/NEGATIVE price/);
    // And the migration refuses up front rather than half-applying.
    const MIG = readFileSync(
      join(__dirname, "../../prisma/migrations/20260908090000_unify_pricing_model/migration.sql"),
      "utf8",
    );
    expect(MIG).toMatch(/RAISE EXCEPTION/);
    expect(MIG).toMatch(/DROP COLUMN "pricingModel"/);
    expect(MIG).toMatch(/DROP TYPE "JobPricingModel"/);
  });


  it("the check is read-only, so it can be pointed at production", () => {
    expect(VERIFY).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the Supplies UI says what the service actually does", () => {
  // THIS SHIPPED. `recordPurchase` was changed to write no ledger row, the doc
  // was updated to say so, and the screen kept telling the operator the
  // opposite: "Each purchase creates a Business Expense (tax ledger) right
  // away", a Schedule C line picker on every supply, and helper text claiming
  // the job-payout cost is "deducted from the worker's payout".
  //
  // Three false statements on one screen, none of which any test could see,
  // because every gate here read the SERVICE. A guarantee about behaviour is
  // worth nothing if the interface promises something else.
  const TAB = () => stripComments(web("ui/tabs/SuppliesTab.tsx"));

  it("no screen claims a purchase creates a tax entry", () => {
    const T = TAB();
    expect(T).not.toMatch(/creates a Business Expense/i);
    expect(T).toMatch(/no[\s\S]{0,20}tax entry/i);
  });

  it("a supply carries no Schedule C line, because it produces no deduction", () => {
    const T = TAB();
    expect(T, "the Schedule C picker must be gone").not.toMatch(/Schedule C category/);
    expect(T).not.toMatch(/useExpenseCategories/);
  });

  it("the job-payout cost is described as the CLIENT's charge, not the worker's", () => {
    const T = TAB();
    expect(T, "materials never come out of anyone's pay")
      .not.toMatch(/deducted from the worker/i);
    expect(T).toMatch(/billed to the client|the CLIENT is charged/);
  });

  it("the Add/Edit form asks nothing about cost or quantity", () => {
    // ADD SUPPLY ESTABLISHES WHAT A SUPPLY IS. Stock and its price arrive
    // through Buy, one purchase at a time, and the catalog's average is
    // derived from those.
    //
    // A cost field here was a number nobody could keep true: it was labelled
    // "What you pay", which reads as a policy the operator sets, while every
    // recorded purchase silently overwrote it. So entering a receipt quietly
    // restated what all existing stock had cost.
    const T = TAB();
    expect(T, "no cost field may return to this form").not.toMatch(/fBusinessCost/);
    expect(T, "and no cost may be sent from it").not.toMatch(/businessCost:/);
    // The DEFAULT client charge stays — it is what a supply IS priced at to
    // begin with, not a quantity or a cost.
    expect(T).toMatch(/<CurrencyInput value=\{fClientPrice\}/);
    expect(T).toMatch(/Default charge to a client/);
  });

  it("the column is named for what it holds: the CLIENT's price", () => {
    // `jobPayoutCost` said "worker payout" about a number the CLIENT pays.
    // It surfaced in the UI as "Job payout cost (per unit)", so an operator
    // setting a supply's price was told they were setting worker pay.
    // Renamed in migration 20260908140000 — data unchanged, no rows rewritten.
    const SCHEMA = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
    expect(SCHEMA).toMatch(/clientUnitPrice Float @default\(0\)/);
    expect(SCHEMA).toMatch(/clientUnitPrice Float\n/);
    const code = SCHEMA.replace(/^\s*\/\/\/?[^\n]*$/gm, "");
    expect(code, "the old name must survive only in prose").not.toMatch(/jobPayoutCost/);
    for (const f of ["./supplies.ts", "./invoiceCharges.ts", "../routes/admin.ts"]) {
      const src = stripComments(readFileSync(join(__dirname, f), "utf8"));
      expect(src, f).not.toMatch(/jobPayoutCost/);
    }
    expect(stripComments(web("ui/tabs/SuppliesTab.tsx"))).not.toMatch(/jobPayoutCost/);
  });

  it("the catalog asks for a DEFAULT charge, not a price it cannot know", () => {
    // The catalog knows what you PAY. It cannot know what a client will be
    // charged — that is decided when the supply goes onto a job and can differ
    // per client. It used to demand the client price up front, with buttons to
    // "set from cost" as though a fixed markup existed.
    const T = TAB();
    expect(T).toMatch(/Default charge to a client/);
    expect(T, "no fixed-markup shortcut").not.toMatch(/setMarkup/);
  });

  it("the price is settable where it is decided — on the job", () => {
    const DLG = stripComments(web("ui/dialogs/ManageInvoiceChargesDialog.tsx"));
    expect(DLG).toMatch(/clientUnitPrice: pickedUnitPrice\.trim\(\) === "" \? null : Number\(pickedUnitPrice\)/);
    expect(DLG).toMatch(/description: pickedDesc\.trim\(\) \|\| null/);
    const SUP = stripComments(readFileSync(join(__dirname, "./supplies.ts"), "utf8"));
    expect(SUP).toMatch(/input\.clientUnitPrice != null/);
  });
  it("a supply's category is a grouping label, not a Schedule C line", () => {
    // Removing the picker from the DIALOG was half a fix. The service still
    // validated the value against the Schedule C line list and rejected
    // anything else — so the backend went on demanding a tax category for an
    // object that produces no deduction, and any future UI sending a plain
    // label would have got a 400.
    //
    // Fixing one layer and declaring done is the failure this whole file
    // exists to catch; the pair of assertions below has to hold together.
    const SUP = stripComments(readFileSync(join(__dirname, "./supplies.ts"), "utf8"));
    expect(SUP, "the service must not require a Schedule C line")
      .not.toMatch(/Must be a Schedule C line/);
    expect(SUP, "and must not load the tax category list at all")
      .not.toMatch(/loadCategoryLabels/);
    // Still bounded — a grouping label is short.
    expect(SUP).toMatch(/Category is too long/);
  });

  it("…and the service it describes really does write no ledger row", () => {
    // The other half of the contradiction. Both must hold, together.
    const SUP = stripComments(readFileSync(join(__dirname, "./supplies.ts"), "utf8"));
    expect(SUP).not.toMatch(/recordPurchase[^]{0,2000}?businessExpense\.create/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] an inventory pull records what the stock cost us", () => {
  const SUP = () => stripComments(readFileSync(join(__dirname, "./supplies.ts"), "utf8"));

  it("a supply line records NO cost — cost lives in the Ledger", () => {
    // Writing actualCost here imported a COST into a CLIENT CHARGE. Supplies
    // are an approximate stock layer; what was actually spent is a
    // BusinessExpense, reconciled against the accounting software. Mixing them
    // makes the approximate layer look authoritative.
    const SUP = stripComments(readFileSync(join(__dirname, "./supplies.ts"), "utf8"));
    expect(SUP).not.toMatch(/actualCost: Math\.round\(quantity \* supply\.businessCost/);
  });
  it("changing the held quantity re-prices the line but keeps the words", () => {
    // The hold owns the STOCK. It once rewrote the description too, turning a
    // line written for a client back into "Mulch × 5 bag".
    const SUP = stripComments(readFileSync(join(__dirname, "./supplies.ts"), "utf8"));
    expect(SUP).toMatch(/data: \{ cost: newExpenseCost \}/);
    expect(SUP).toMatch(/const description = input\.description\?\.trim\(\) \|\| supply\.name;/);
  });
  it("recording a purchase still writes no ledger row", () => {
    // The deduction is the real card charge in the Ledger. A purchase may
    // POINT at one — many-to-one — but never creates one.
    const S = SUP();
    expect(S).toMatch(/businessExpenseId: input\.businessExpenseId \?\? null/);
    expect(S, "recordPurchase must not create a BusinessExpense")
      .not.toMatch(/recordPurchase[^]{0,2000}?businessExpense\.create/);
  });

  it("the seed exercises every hold state, not just ACTIVE", () => {
    // CONSUMED is the state that actually moves stock; RELEASED is the one
    // that gives it back. Neither existed in seeded data, so the paths that
    // change physical inventory had never run against it.
    const SEED = readFileSync(join(__dirname, "../../prisma/seed.ts"), "utf8");
    expect(SEED).toMatch(/consumeHoldsForOccurrence\(consumedOcc\.id\)/);
    expect(SEED).toMatch(/releaseHoldsForOccurrence\(releasedOcc\.id\)/);
    expect(SEED).toMatch(/supplies\.adjustHold\(/);
    expect(SEED).toMatch(/supplies\.recordAdjustment\(/);
    // Purchases the way the SERVICE makes them: the receipt total is the
    // input, per-unit cost is derived, and one receipt may cover several.
    expect(SEED).toMatch(/totalCost: Math\.round\(qty \* unitPrice \* 100\) \/ 100/);
    // A SECOND LAYER AT A DIFFERENT PRICE, or the fixture cannot exercise
    // FIFO: every purchase at the same price makes any averaging rule look
    // correct, including a wrong one.
    expect(SEED, "restocks must not reuse the first purchase's price")
      .toMatch(/totalCost: Math\.round\(20 \* 4\.6 \* 100\) \/ 100/);
    expect(SEED, "an inventory-backed charge records no cost")
      .not.toMatch(/actualCost: Math\.round\(h\.quantity/);
    expect(SEED).toMatch(/businessExpenseId: receipt\.id/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] what stock cost is derived, never stored", () => {
  const SUPPLIES = () => stripComments(readFileSync(join(__dirname, "./supplies.ts"), "utf8"));
  const SCHEMA = () => readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const TAB = () => readFileSync(
    join(__dirname, "../../../web/src/ui/tabs/SuppliesTab.tsx"), "utf8",
  );

  it("no column stores a supply's cost", () => {
    // `Supply.businessCost` held the most recent purchase price and every buy
    // overwrote it, so recording a receipt silently restated what all existing
    // stock had cost. Dropped in 20260908210000; the figure is now replayed
    // from the purchases. A stored value that must be kept in step with an
    // event log drifts out of it — that is the whole failure mode.
    const code = SCHEMA().replace(/^\s*\/\/\/?[^\n]*$/gm, "");
    expect(code, "a stored cost must not come back").not.toMatch(/businessCost/);
    const MIG = readFileSync(
      join(__dirname, "../../prisma/migrations/20260908210000_supply_cost_is_derived/migration.sql"),
      "utf8",
    );
    expect(MIG).toMatch(/ALTER TABLE "Supply" DROP COLUMN "businessCost"/);
  });

  it("nothing in the service writes a cost onto the catalog", () => {
    const S = SUPPLIES();
    expect(S).not.toMatch(/businessCost/);
    // recordPurchase must move STOCK and nothing else — the purchase row is
    // itself the cost record.
    expect(S).toMatch(/data: \{ onHand: \{ increment: quantity \} \}/);
  });

  it("the average is computed by the shared engine, not re-derived per caller", () => {
    // Two call sites (list and getById) reading the same events is exactly how
    // a list and a detail page start disagreeing about the same supply.
    const S = SUPPLIES();
    expect(S).toMatch(/import \{ fifoCost/);
    expect(S).toMatch(/async function costBySupply/);
    expect((S.match(/costBySupply\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(S, "list must not replay per row — that is an N+1")
      .toMatch(/costBySupply\(rows\.map\(\(r\) => r\.id\)\)/);
  });

  it("only CONSUMED holds draw a layer", () => {
    // An ACTIVE hold is stock RESERVED for a job, not stock off the shelf.
    // Drawing its layer would make the average describe available units while
    // the column beside it counts on-hand ones. RELEASED never left at all.
    //
    // SCOPED TO THE COST QUERY. Asserting `status: "CONSUMED"` against the
    // whole file passes on any file that consumes a hold anywhere — which is
    // this one. Verified by widening the filter to an `in` clause and watching
    // this fail.
    const S = SUPPLIES();
    const at = S.indexOf("async function costBySupply");
    expect(at, "costBySupply must exist to be checked").toBeGreaterThan(-1);
    const body = S.slice(at, S.indexOf("export const supplies", at));
    const holdQuery = body.slice(body.indexOf("supplyHold.findMany"));
    expect(holdQuery.slice(0, 300)).toMatch(/status: "CONSUMED"/);
    expect(holdQuery.slice(0, 300), "no other hold state may be drawn")
      .not.toMatch(/ACTIVE|RELEASED|in: \[/);
  });

  it("the event's date is when it took effect, not when it was typed", () => {
    // A purchase carries a user-entered `date`, so a back-dated receipt takes
    // its place in history rather than being appended to it. A consumption
    // uses `consumedAt`, which is cleared when a payment is reverted — which
    // is why reverting restores the layer with no unwind logic.
    const S = SUPPLIES();
    expect(S).toMatch(/kind: "BUY", at: p\.date/);
    // THE RECEIPT TOTAL, never the stored per-unit price. `unitCost` is a
    // rounded display derivation; multiplying it back up by the unit count
    // multiplies its rounding error — a 20 ft roll at $45.99 stores $2.30/ft
    // and reports $46.00 on hand. Finely divided units make this worse, and
    // supplies are stocked in the unit they are consumed in.
    expect(S).toMatch(/totalCost: p\.totalCost/);
    expect(S, "the rounded unit price must not be fed back into the layers")
      .not.toMatch(/unitCost: p\.unitCost/);
    expect(S).toMatch(/kind: "CONSUME", at: h\.consumedAt \?\? h\.createdAt/);
    expect(S).toMatch(/kind: "ADJUST", at: a\.createdAt/);
  });

  it("the UI names it for what it is and shows no figure it cannot back", () => {
    const T = TAB();
    expect(T).toMatch(/Average price:/);
    expect(T, "the old last-paid label must not survive").not.toMatch(/You pay:/);
    // A supply never bought has no average. $0.00 would claim it was free.
    expect(T).toMatch(/s\.averageCost == null \? \(/);
    expect(T).toMatch(/&mdash;/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] a job title leads with the client", () => {
  // The title truncates from the right. Leading with the property left most
  // cards on a phone reading "Main House" and nothing else.
  //
  // SIX places built this string by hand, and the first swap missed two of
  // them — the list rendered both orders at once until a render spec read the
  // page. One helper now; the gate keeps it that way.
  const LABELS = () => stripComments(web("lib/labels.ts"));

  it("the helper exists and puts the client first", () => {
    const L = LABELS();
    expect(L).toMatch(/export function jobTitleLead\(/);
    expect(L).toMatch(/if \(clientName\) return clientLabel\(clientName\)/);
    // A job with no client still gets a title.
    expect(L).toMatch(/return propertyName \|\| fallback/);
    // The trail is dropped when it would only repeat the lead.
    expect(L).toMatch(/return clientName && propertyName \? propertyName : ""/);
  });

  it("no card builds the old property-first title by hand", () => {
    const offenders: string[] = [];
    for (const f of ["ui/tabs/JobsTab.tsx", "ui/workflows/BeginWorkDayWorkflow.tsx"]) {
      const src = stripComments(web(f));
      // "{property.displayName}" immediately followed by a clientLabel trail.
      if (/displayName\}[^]{0,220}?— \$\{clientLabel\(/.test(src)) offenders.push(f);
      if (/\?\.displayName\}\s*\n\s*\{[^]{0,160}?clientLabel\(/.test(src)) offenders.push(f);
    }
    expect(offenders, "still renders property — client").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the seed carries the shapes the specs need to see", () => {
  // A render spec can only assert on what the dataset puts on screen. The
  // whole services path — the dialog, the "Added Services" block, the
  // "+ $X services" term, add-on lines on an invoice, catalog label
  // resolution — had NO coverage because the seed created not one add-on
  // anywhere. The specs were green; they had nothing to look at.
  const SEED = readFileSync(join(__dirname, "../../prisma/seed.ts"), "utf8");

  it("creates add-on services at all", () => {
    expect(SEED).toMatch(/prisma\.occurrenceAddon\.create/);
  });

  it("puts services on an UNPAID visit, where the payout projection renders", () => {
    // Every add-on in the main seed sits on a paid visit, and the projection
    // only exists before payment — so "base labor + services" had no subject.
    // The job-materials fixtures are the unpaid ones.
    expect(SEED).toMatch(/addons\?: Array<\{ tag\?: string; customLabel\?: string; price: number; detail\?: string \}>/);
    expect(SEED).toMatch(/addons: \[\{ tag: "LEAF_CLEANUP", price: 45 \}\]/);
  });

  it("covers both label paths", () => {
    // A catalog tag must resolve through SERVICE_TYPES; a typed label wins
    // outright; an underscored key must never reach a client as a raw key.
    expect(SEED).toMatch(/tag: "HEDGE"/);
    expect(SEED).toMatch(/tag: "LEAF_CLEANUP"/);
    expect(SEED).toMatch(/customLabel: "Haul off clippings"/);
  });

  it("no pricing era survives in the seed's CODE", () => {
    // Prose may still explain why the split existed — the point is that
    // nothing branches on it any more.
    const code = SEED.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    expect(code).not.toMatch(/pricingModel|LEGACY|ITEMIZED/);
  });


  it("pays for the services it adds", () => {
    // A service is on the invoice, so the client funded it. Attaching add-ons
    // without raising the payment has the crew splitting a pool nobody paid
    // for — which the seed's own job-portion invariant catches.
    expect(SEED).toMatch(/p\.amount = Math\.round\(\(p\.amount \+ extra\) \* 100\) \/ 100/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] a payment ROW is not a payment", () => {
  // `!!occ.payment` is the row's EXISTENCE. Money landing is `confirmed`, and
  // a confirmed payment of $0 is a job closed with nothing collected.
  //
  // Five surfaces made the same claim: the invoice preview announced "This job
  // is already paid ($0.00)", and three job-card renders plus two on the
  // Services tab printed a green "Paid: $0.00" — or "Paid:" on a payment still
  // waiting for admin approval. The preview's own query SELECTED `confirmed`
  // and never read it.
  it("the preview settles on confirmed, and distinguishes a write-off", () => {
    const SVC = stripComments(
      readFileSync(join(__dirname, "./paymentRequests.ts"), "utf8"),
    );
    expect(SVC).toMatch(/settled: !!occ\.payment\?\.confirmed/);
    expect(SVC).not.toMatch(/settled: !!occ\.payment,/);
    expect(SVC).toMatch(/paymentPending: !!occ\.payment && !occ\.payment\.confirmed/);
    expect(SVC).toMatch(/writtenOff: !!occ\.payment\?\.confirmed && !occ\.payment\.amountPaid/);
    // …and null rather than 0, so no caller can render "paid ($0.00)".
    expect(SVC).toMatch(/paidAmount: occ\.payment\?\.amountPaid \? occ\.payment\.amountPaid : null/);
  });

  it("no surface prints Paid except as a branch on the amount", () => {
    // A PROXIMITY CHECK IS NOT A GATE. The first version of this looked for
    // the word "confirmed" within 700 characters, which the neighbouring
    // badge supplied — so removing the amount check entirely still passed.
    // Watched it fail to fail, then wrote this.
    //
    // The precise property: every "Paid: $" that interpolates the amount must
    // be the true-branch of a ternary, i.e. immediately preceded by "? `".
    // A bare `{`Paid: $${amountPaid}`}` is the bug.
    const offenders: string[] = [];
    for (const f of sourceFiles(WEB, /\.tsx?$/)) {
      const rel = relative(WEB, f);
      if (rel.includes("tests/")) continue;
      const src = stripComments(readFileSync(f, "utf8"));
      // `Paid: $${amountPaid}` is TWO dollar signs in source — the literal
      // one, then the `${` of the interpolation. The first version of this
      // regex allowed only one, so it matched nothing in any real file and
      // the gate was decorative. Verified by counting matches before trusting
      // the pass.
      for (const m of src.matchAll(/Paid: \$\$?\{[^}]*amountPaid|Paid: \$\d/g)) {
        const before = src.slice(Math.max(0, m.index! - 40), m.index!);
        if (!/\?\s*`\s*$/.test(before)) {
          offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(
      offenders,
      'prints "Paid:" unconditionally — a $0 payment is a job closed with nothing collected',
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the card shows what the job actually made", () => {
  const TAB = () => stripComments(web("ui/tabs/JobsTab.tsx"));

  it("job profit is revenue minus crew minus what the materials cost", () => {
    // Every other figure on the card reports the client's money or the crew's.
    // The material markup — $25 billed on $20 of mulch — landed in neither, so
    // nothing on the card said whether marking materials up was worth doing.
    const T = TAB();
    expect(T).toMatch(/revenue - crew - matCost - processorFee/);
    expect(T).toMatch(/const matCost = materialCostTotal\(occ\)/);
    // Actual cash once paid, the invoice before that — and a tip is the
    // crew's money, not revenue on the job.
    expect(T).toMatch(/\(pay\.amountPaid \?\? 0\) - \(pay\.tipAmount \?\? 0\)/);
  });

  it("an unpriced charge makes the profit an upper bound, not a windfall", () => {
    // A charge with no recorded cost is not a free one. Booking the whole
    // markup would overstate the job.
    const T = TAB();
    expect(T).toMatch(/c\.cost > 0 && c\.actualCost == null/);
    expect(T).toMatch(/Upper bound — no cost recorded on/);
  });

  it("it is gated on the SELECTED scope, never forAdmin", () => {
    // A Super sitting on the Worker chip must not see the business's take.
    const T = TAB();
    const at = T.indexOf("Est. job profit");
    expect(at).toBeGreaterThan(-1);
    // Anchored on the block's own first statement rather than a byte window —
    // adding a comment inside the block should not decide whether the scope
    // gate is enforced.
    const open = T.lastIndexOf("&& (() => {", T.lastIndexOf("const rawPay = occ.payment as any;", at));
    expect(open, "could not find the job-profit block's guard").toBeGreaterThan(-1);
    const guard = T.slice(Math.max(0, open - 60), open + 12);
    expect(guard).toMatch(/\{\(isAdmin \|\| isSuper\) && \(\(\) => \{/);
    expect(guard, "forAdmin would light it up for a Super on the Worker chip")
      .not.toMatch(/forAdmin/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the dialogs promise a pool, not a payout", () => {
  // "The crew splits it" says a $50 service reaches the crew as $50. It does
  // not: the pool is what the payout engine divides, and margin plus
  // per-worker fees come off first. The operator repeats this copy to the
  // crew, so the overstatement becomes a promise someone else has to break.
  //
  // The banned string is the unqualified promise specifically. The invoice
  // preview's "splits the shared figure between them, then fees and margin
  // come off each person's share" is accurate and stays.
  const SURFACES = [
    "ui/dialogs/ManageAddonsDialog.tsx",
    "ui/dialogs/ManageInvoiceChargesDialog.tsx",
    "ui/tabs/JobsTab.tsx",
  ];

  it("no surface tells the operator the crew splits it", () => {
    for (const f of SURFACES) {
      expect(stripComments(web(f)).toLowerCase()).not.toContain("crew splits it");
    }
  });

  it("both job dialogs say the money raises the POOL", () => {
    for (const f of ["ui/dialogs/ManageAddonsDialog.tsx", "ui/dialogs/ManageInvoiceChargesDialog.tsx"]) {
      expect(stripComments(web(f)).toLowerCase()).toContain("crew&rsquo;s pool");
    }
  });

  it("the add-service dialog says what decides a worker's actual share", () => {
    // Without this the reader still walks away thinking pool == pay.
    const T = stripComments(web("ui/dialogs/ManageAddonsDialog.tsx")).toLowerCase();
    expect(T).toContain("margin");
    expect(T).toMatch(/fee settings/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] changing a sent invoice warns the operator", () => {
  it("every surface that can move the total shows the warning", () => {
    // Warning on some of them is worse than none — it teaches the operator
    // that silence means safe.
    expect(web("ui/dialogs/ManageInvoiceChargesDialog.tsx")).toMatch(/<InvoiceAlreadySentNote/);
    expect(web("ui/dialogs/ManageAddonsDialog.tsx")).toMatch(/<InvoiceAlreadySentNote/);
    for (const [name, src] of [
      ["JobsTab", web("ui/tabs/JobsTab.tsx")],
      ["ServicesTab", web("ui/tabs/ServicesTab.tsx")],
    ] as const) {
      expect(src, `${name} must pass the outstanding amount`).toMatch(/sentInvoiceAmount=\{/);
    }
  });

  it("it only fires while a request is genuinely outstanding", () => {
    const NOTE = web("ui/components/InvoiceAlreadySentNote.tsx");
    expect(NOTE).toMatch(/if \(!occ \|\| !occ\.paymentRequestSentAt \|\| occ\.payment\) return null;/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] supplies carry the same loose link, as a growing list", () => {
  it("a purchase may point at a ledger charge, and many may share one", () => {
    const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
    const blk = schema.slice(schema.indexOf("model SupplyPurchase {"));
    expect(blk.slice(0, blk.indexOf("\n}"))).toMatch(/businessExpenseId String\?\n/);
    expect(schema).toMatch(/supplyPurchases SupplyPurchase\[\]/);
  });

  it("linking is recorded as touching neither money nor stock", () => {
    const at = ADMIN.indexOf("supply-purchases/:id/ledger-link");
    const body = ADMIN.slice(at, ADMIN.indexOf("\n  app.", at));
    expect(body).toMatch(/action: "ledger_link_changed"/);
    expect(body).toMatch(/affectsMoney: false/);
    expect(body).toMatch(/affectsStock: false/);
  });

  it("the job-line link is likewise a pointer, not plumbing", () => {
    const at = ADMIN.indexOf("/admin/invoice-charges/:id/ledger-link");
    const body = ADMIN.slice(at, ADMIN.indexOf("\n  app.", at));
    expect(body).toMatch(/action: "ledger_link_changed"/);
    expect(body).toMatch(/affectsMoney: false/);
    // It may only touch the pointer.
    const write = body.slice(body.indexOf("tx.invoiceCharge.update("));
    const data = write.slice(write.indexOf("data:"), write.indexOf("select:"));
    expect(data).toMatch(/data: \{ businessExpenseId \}/);
    expect(data).not.toMatch(/cost:|actualCost:|detail:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the spec exists", () => {
  it("the canonical spec is present", () => {
    const doc = readFileSync(
      join(__dirname, "../../../../docs/features/job-materials.md"), "utf8",
    );
    expect(doc).toMatch(/two books/i);
    expect(doc).toMatch(/InvoiceCharge/);
    expect(doc.length).toBeGreaterThan(3000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A button lives on the LOWEST role row that applies to it
//
// The job card has three rows: the everyday one, an Admin row (purple badge)
// and a Super row (orange badge). A button only an admin can press reads wrong
// sitting beside Manage Team, which any assignee can use — and it hides the
// fact that it's privileged at all.
//
// This gate is mechanical rather than a list, so a new admin-only button
// dropped into the everyday row fails without anyone remembering the rule.
// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] admin-only buttons sit on the Admin row", () => {
  const TAB = web("ui/tabs/JobsTab.tsx");
  const lines = TAB.split("\n");
  const extrasAt = TAB.indexOf("adminExtras={");
  const extrasLine = TAB.slice(0, extrasAt).split("\n").length;
  const adminRow = TAB.slice(extrasAt, TAB.indexOf("\n                />", extrasAt));

  it("the Admin row exists and is gated on the SELECTED scope", () => {
    expect(extrasAt, "the card must hand buttons to ElevatedActionRow").toBeGreaterThan(-1);
    // `forAdmin` alone would light it up for a super on another chip.
    expect(adminRow).toMatch(/!isCardCompact && \(isAdmin \|\| isSuper\)/);
  });

  it("these admin-only buttons are on it", () => {
    for (const label of [
      "Manage in Services", "Review Hours", "Reset Job",
      "Edit Charges", "Adjust Price", "Invoice preview",
    ]) {
      expect(adminRow, `"${label}" belongs on the Admin row`).toContain(label);
    }
  });

  it("no admin-only button is left in the everyday row", () => {
    // Scans for BUTTON TAGS, not labels — a one-line
    // `{(isAdmin) && (<Button>…</Button>)}` has no label on its own line and
    // slipped straight through a label-based check.
    const offenders: string[] = [];
    for (let i = 7700; i < extrasLine - 1; i++) {
      const l = lines[i] ?? "";
      if (!/<(Button|StatusButton)\b/.test(l)) continue;
      // Nearest enclosing JSX conditional above (or on) this line.
      for (let j = i; j > Math.max(7600, i - 45); j--) {
        const t = (lines[j] ?? "").trim();
        if (t.startsWith("{") && t.includes("&&") && !t.includes("/*")) {
          const admin = /isAdmin|isSuper|forAdmin/.test(t);
          const worker = /isClaimer|isActiveAssignee|isUnassigned|isWorkerView|c\.author\.id|needsConfirmation/.test(t);
          if (admin && !worker) {
            const label = /label="([^"]+)"/.exec(l)?.[1]
              ?? (lines[i + 1] ?? "").trim().slice(0, 30)
              ?? "?";
            offenders.push(`line ${j + 1}: ${t.slice(0, 60)} → ${label}`);
          }
          break;
        }
      }
    }
    expect(
      offenders,
      "A button only an admin can press belongs on the Admin row, not beside " +
        "Manage Team. Move it into the adminExtras prop.",
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every client-visible detail field is actually WRITEABLE
//
// `laborDetail` shipped as a column, a select and a render — with nothing that
// could set it. The operator typed into "Reason" (internal audit metadata),
// reasonably expecting it on the invoice, and nothing appeared.
//
// A field the invoice renders but no UI can fill is worse than no field: it
// looks like a bug in the invoice.
// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] invoice detail fields have an input, not just a column", () => {
  const JOBS = read("jobs.ts");
  const TAB = web("ui/tabs/JobsTab.tsx");

  it("laborDetail can be written through the re-price path", () => {
    const at = JOBS.indexOf("async adjustOccurrencePrice");
    const fn = JOBS.slice(at, JOBS.indexOf("\n  async ", at + 1));
    expect(fn, "the service must accept it").toMatch(/laborDetail\?: string \| null/);
    // undefined leaves it alone; null/"" clears it.
    expect(fn).toMatch(/laborDetail !== undefined/);
    expect(fn).toMatch(/laborDetail: laborDetail\?\.trim\(\) \|\| null/);
    expect(ADMIN, "the route must forward it").toMatch(/"laborDetail" in body/);
  });

  it("the dialog collects it, and keeps it distinct from the internal reason", () => {
    const at = TAB.indexOf("<Dialog.Title>Adjust price</Dialog.Title>");
    const body = TAB.slice(at, at + 6000);
    expect(body).toMatch(/Detail for the client/);
    expect(body).toMatch(/priceEditDetail/);
    // The reason must say plainly that it is NOT client-facing — the two
    // fields sitting unlabelled beside each other is what caused the report.
    expect(body).toMatch(/optional, internal/);
    expect(body).toMatch(/client never sees this/);
    expect(TAB).toMatch(/laborDetail: priceEditDetail\.trim\(\) \|\| null/);
    // Seeded from the row, or editing silently wipes an existing detail.
    expect(TAB).toMatch(/setPriceEditDetail\(String\(\(occ as any\)\.laborDetail \?\? ""\)\)/);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // SHIPPED TO PRODUCTION, 2026-09-08. Every Ledger list request 500'd the
  // moment the deploy landed, because this route's `include` still named
  // `supplyPurchase` — renamed to `supplyPurchases` when the ledger link
  // became many-to-one. Both apps typechecked clean.
  //
  // WHY TYPESCRIPT MISSED IT: excess-property checking only applies to a
  // FRESH object literal written at the call site. Lift the include into its
  // own `const` and TypeScript stops checking its keys entirely — it can name
  // any relation at all and still compile. The error only appears at runtime,
  // from the database, as a bare 500.
  //
  // The fix is `Prisma.validator<Prisma.<Model>Include>()({ ... })`, which
  // restores the key check AND keeps the literal type, so the payload types
  // inferred downstream stay narrow — a bare `: Prisma.XInclude` annotation
  // checks the keys but widens the result, breaking callers that read nested
  // relations. A plain annotation is accepted here for includes nothing
  // infers from. This gate makes sure the next detached include carries one.
  it("a detached Prisma include/select is type-annotated, not `as const`", () => {
    const API_SRC = join(__dirname, "..");
    const DECL = /\bconst\s+(\w*(?:include|select|Include|Select))\s*(:[^=]*)?=\s*\{/g;
    const offenders: string[] = [];
    for (const file of sourceFiles(API_SRC, /\.ts$/)) {
      const rel = relative(API_SRC, file);
      if (rel.endsWith(".test.ts")) continue;
      const src = stripComments(readFileSync(file, "utf8"));
      for (const m of src.matchAll(DECL)) {
        const annotation = (m[2] ?? "").trim();
        if (/^:\s*Prisma\.\w+(Include|Select)\b/.test(annotation)) continue;
        offenders.push(
          `${rel}:${src.slice(0, m.index).split("\n").length} — const ${m[1]}`,
        );
      }
    }
    expect(
      offenders,
      "A Prisma include/select lifted into its own const is NOT key-checked by " +
        "TypeScript — a renamed relation compiles and 500s in production. " +
        "Wrap it in `Prisma.validator<Prisma.<Model>Include>()({ ... })`, or " +
        "inline it at the call site.",
    ).toEqual([]);
  });

  it("no invoice-visible field is render-only", () => {
    // Each detail the invoice can show must have a writer somewhere.
    const api = readFileSync(join(__dirname, "../routes/admin.ts"), "utf8")
      + readFileSync(join(__dirname, "../routes/worker.ts"), "utf8");
    for (const field of ["laborDetail", "detail"]) {
      expect(api.includes(field), `${field} is rendered on the invoice but nothing writes it`)
        .toBe(true);
    }
  });
});
