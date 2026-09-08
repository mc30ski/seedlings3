// ─────────────────────────────────────────────────────────────────────────────
// ONE PRICING MODEL, as a table of scenarios with hand-computed answers.
//
// There used to be two — LEGACY and ITEMIZED — because historical visits never
// billed their materials. Nineteen call sites had to branch, and six of them
// got it wrong. Migration 20260908090000 rewrote the nine affected production
// rows (`price = base − charges`) so the single rule below reproduces exactly
// what those clients were invoiced and exactly what those crews were paid, and
// dropped the column.
//
// This file is the guard on that rule staying single. Every expectation was
// worked out on paper first, and each pool figure is checked against
// `computeBreakdown` — the engine that actually pays people — rather than
// against another helper in the same file agreeing with itself.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { computeBreakdown } from "@repo/money";
import { invoiceTotal, crewPool, laborAndServices, materialChargeTotal, invoiceLines } from "./jobPricing";

const r2 = (n: number) => Math.round(n * 100) / 100;
const RATES = { contractorFeePercent: 20, employeeMarginPercent: 30 };
const occ = (price: number | null, charges: number[] = [], addons: number[] = []) => ({
  price,
  addons: addons.map((p) => ({ price: p })),
  invoiceCharges: charges.map((c) => ({ cost: c })),
});

type Row = {
  name: string;
  price: number | null;
  charges: number[];
  addons: number[];
  invoice: number;
  pool: number;
};

const TABLE: Row[] = [
  { name: "plain job", price: 100, charges: [], addons: [], invoice: 100, pool: 100 },
  { name: "materials billed on top", price: 100, charges: [60], addons: [], invoice: 160, pool: 100 },
  { name: "with a service", price: 100, charges: [60], addons: [45], invoice: 205, pool: 145 },
  { name: "several charges", price: 350, charges: [150, 50, 40], addons: [], invoice: 590, pool: 350 },
  { name: "fractional", price: 99.99, charges: [33.33, 0.01], addons: [], invoice: 133.33, pool: 99.99 },
  // Materials costing more than the labor is now an ordinary job, not the
  // pathology it was under the old rule (where the pool clamped at zero).
  { name: "materials exceed the labor", price: 150, charges: [200], addons: [], invoice: 350, pool: 150 },
  { name: "charge-only visit", price: null, charges: [40], addons: [], invoice: 40, pool: 0 },
  { name: "converted legacy row", price: 183.23, charges: [279.27], addons: [], invoice: 462.5, pool: 183.23 },
];

describe("the pricing model", () => {
  for (const t of TABLE) {
    const o = occ(t.price, t.charges, t.addons) as any;

    it(`${t.name}: bills the client ${t.invoice}`, () => {
      expect(invoiceTotal(o)).toBe(t.invoice);
    });

    it(`${t.name}: crew pool is ${t.pool}`, () => {
      expect(crewPool(o)).toBe(t.pool);
    });

    it(`${t.name}: the PAYOUT ENGINE agrees the pool is ${t.pool}`, () => {
      const br = computeBreakdown(
        invoiceTotal(o),
        materialChargeTotal(o),
        [{ userId: "u", splitPercent: 100, workerType: "EMPLOYEE" as any }],
        RATES,
      );
      expect(r2(br.reduce((s, r) => s + r.gross, 0))).toBe(t.pool);
    });

    it(`${t.name}: the invoice lines sum to the invoice`, () => {
      expect(r2(invoiceLines(o).reduce((s, l) => s + l.amount, 0))).toBe(t.invoice);
    });
  }

  it("the pool is ALWAYS labor + services — there is no other rule", () => {
    for (const t of TABLE) {
      const o = occ(t.price, t.charges, t.addons) as any;
      expect(crewPool(o), t.name).toBe(laborAndServices(o));
    }
  });

  it("the invoice is ALWAYS the pool plus the charges", () => {
    for (const t of TABLE) {
      const o = occ(t.price, t.charges, t.addons) as any;
      expect(invoiceTotal(o), t.name).toBe(r2(crewPool(o) + materialChargeTotal(o)));
    }
  });

  it("the pool is never negative and never exceeds the invoice", () => {
    for (const t of TABLE) {
      const o = occ(t.price, t.charges, t.addons) as any;
      expect(crewPool(o)).toBeGreaterThanOrEqual(0);
      expect(crewPool(o)).toBeLessThanOrEqual(invoiceTotal(o) + 0.001);
    }
  });

  it("a CONVERTED legacy row reproduces what the client was actually invoiced", () => {
    // Production's largest converted row: invoiced $462.50, crew paid out of
    // $183.23. The migration rewrote the price from 462.50 to 183.23 and left
    // the $279.27 charge alone; both facts must come back out unchanged.
    const o = occ(183.23, [279.27]) as any;
    expect(invoiceTotal(o)).toBe(462.5);
    expect(crewPool(o)).toBe(183.23);
  });

  it("nothing in the pricing helpers can branch on an era any more", () => {
    // The column is gone; this catches an attempt to reintroduce the idea by
    // any other name.
    const src = readFileSync(join(__dirname, "./jobPricing.ts"), "utf8");
    const code = src.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    expect(code).not.toMatch(/pricingModel|LEGACY|ITEMIZED/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
