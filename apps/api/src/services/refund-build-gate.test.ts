// ─────────────────────────────────────────────────────────────────────────────
// Refund (negative expense) build gate
//
// A refund is recorded as a BusinessExpense with a NEGATIVE cost, dated when
// the money came back. There is deliberately no REFUND EntryType: every total
// in the app is a SUM(), which nets a negative correctly on its own, whereas a
// new enum member would require each of the P&L, the QuickBooks export, the
// Schedule C grouping, category totals and the forecaster to learn a sign rule
// — and missing one call site silently corrupts a total.
//
// The two things that must hold:
//   1. Negatives are allowed ONLY on EXPENSE. A negative contribution is an
//      owner draw and a negative draw is a contribution; permitting both
//      spellings would make the equity section ambiguous to total.
//   2. The negative-number input mask stays OPT-IN. CurrencyInput is used by
//      18 call sites — prices, payments, wages — where a negative is a
//      data-entry error, not a refund.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const ADMIN = readFileSync(join(REPO_ROOT, "apps/api/src/routes/admin.ts"), "utf8");
const CURRENCY = readFileSync(
  join(REPO_ROOT, "apps/web/src/ui/components/CurrencyInput.tsx"), "utf8",
);
const LEDGER = readFileSync(
  join(REPO_ROOT, "apps/web/src/ui/tabs/BusinessExpensesTab.tsx"), "utf8",
);

describe("refund build gate — negatives are EXPENSE-only", () => {
  it("the create path rejects a negative on the equity types", () => {
    expect(ADMIN).toMatch(/Number\(b\.cost\) < 0 && type !== "EXPENSE"/);
  });

  it("the update path checks the type the row will END UP as", () => {
    // Editing a refund INTO a capital contribution has to be caught, so the
    // check must use the incoming type when one is supplied.
    expect(ADMIN).toMatch(/const finalType = nextType \?\? existing\.type/);
    expect(ADMIN).toMatch(/finalCost < 0 && finalType !== "EXPENSE"/);
  });

  it("both messages name the type the operator should have used", () => {
    // A bare "not allowed" leaves them stuck; the right answer is one click away.
    expect(ADMIN).toMatch(/A negative contribution is an owner draw/);
    expect(ADMIN).toMatch(/A negative draw is a capital contribution/);
  });
});

describe("refund build gate — the negative mask stays opt-in", () => {
  it("CurrencyInput defaults allowNegative to false", () => {
    expect(CURRENCY).toMatch(/allowNegative = false/);
  });

  it("the mask only admits a minus when the call site asked for it", () => {
    expect(CURRENCY).toMatch(/allowNegative \? \/\^-\?\\d\*/);
  });

  it("blur does not silently wipe a negative the call site permitted", () => {
    // The original cleared any n < 0 on blur, which would have eaten a
    // refund the moment focus left the field.
    expect(CURRENCY).toMatch(/isNaN\(n\) \|\| \(n < 0 && !allowNegative\)/);
  });

  it("the Ledger opts in only while the entry is an EXPENSE", () => {
    expect(LEDGER).toMatch(/allowNegative=\{fType === "EXPENSE"\}/);
  });

  it("the Ledger also blocks the save, since the type can change after typing", () => {
    expect(LEDGER).toMatch(/parseFloat\(fCost\) < 0 && fType !== "EXPENSE"/);
  });
});

describe("refund build gate — a refund reads as money coming back", () => {
  it("a negative row is coloured differently from a charge", () => {
    // fmtUSD renders the minus, but in the same orange as a charge it scans
    // as money going out — the opposite of what happened.
    expect(LEDGER).toMatch(/e\.cost < 0 \? "green\.600" : "orange\.600"/);
  });

  it("a negative row carries an explicit Refund chip", () => {
    expect(LEDGER).toMatch(/e\.cost < 0 && \([\s\S]{0,220}Refund/);
  });
});

describe("refund build gate — no REFUND EntryType crept in", () => {
  it("EntryType still has exactly the three members", () => {
    const schema = readFileSync(join(REPO_ROOT, "apps/api/prisma/schema.prisma"), "utf8");
    const block = schema.slice(schema.indexOf("enum EntryType"), schema.indexOf("}", schema.indexOf("enum EntryType")));
    const members = [...block.matchAll(/^\s+([A-Z_]+)$/gm)].map((m) => m[1]);
    expect(members.sort()).toEqual(["CAPITAL_CONTRIBUTION", "EXPENSE", "OWNER_DRAW"]);
  });
});
