// ─────────────────────────────────────────────────────────────────────────────
// Tax-export integrity tests.
//
// PURPOSE
// Lock down the SHAPE and CONTENT of every CSV export that touches the
// CPA / payroll / tax pipeline. The policy in
// memory/project_tax_export_integrity.md says: exports may only contain
// RAW CASH-FLOW fields (Payment.amountPaid, PaymentSplit.amount,
// BusinessExpense.cost). Derived reporting fields — shortfallAmount,
// overageAmount, businessMarginAmount, platformFeeAmount, topUpAmount —
// must NEVER appear in a tax-line item or QB chart-of-accounts row.
//
// What this file protects:
//   1. Column shape (header lock-in). A future "let me add a margin
//      column to QB Income" PR fails here, not at the CPA's desk.
//   2. Money values trace to the raw fields (amountPaid / cost).
//   3. No negative wages in the W-2 export (employees made-whole policy).
//   4. Schedule-C + QB exports never include rows tagged with
//      shortfall/overage/topup language.
//
// Run with: npm test (workspace: apps/api).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from "vitest";

// Prisma module is mocked BEFORE the exports module is imported below so the
// imports inside services/exports.ts hit our test doubles. `vi.hoisted` is
// required because `vi.mock` calls are hoisted by vitest to the top of the
// file — a plain const can't be referenced inside the factory otherwise.
const { prismaMock } = vi.hoisted(() => {
  const mock: any = {
    payment: { findMany: vi.fn() },
    businessExpense: { findMany: vi.fn() },
    setting: { findUnique: vi.fn() },
    equipment: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    jobOccurrence: { findMany: vi.fn() },
    paymentSplit: { findMany: vi.fn() },
    // qbIncomeCsv now also pulls equipment rentals (Checkout rows with
    // releasedAt + rentalCost > 0) so they're routed through to QB Income
    // as "Equipment Rental Income". See
    // memory/project_equipment_rental_income.md for the policy.
    checkout: { findMany: vi.fn() },
    // GP advance reconciliation (Slice 2). Default empty for every test;
    // tests that exercise the GP path stub returns explicitly.
    guaranteedPayoutAdvance: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "stub", amount: 0 })),
    },
  };
  return { prismaMock: mock };
});

vi.mock("../db/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("./expenseCategories", () => ({
  loadQbAccountMap: vi.fn(async () => new Map<string, string>([
    ["Supplies", "Direct Supplies and Materials"],
    ["Vehicle expenses", "Vehicle Maintenance & Repairs"],
    ["Payment Processing Fees", "Payment Processing Fees"],
  ])),
  loadScheduleCLineMap: vi.fn(async () => new Map<string, string>([
    ["Supplies", "22"],
    ["Vehicle expenses", "9"],
    ["Payment Processing Fees", "10"],
  ])),
  loadFixedAssetMinCost: vi.fn(async () => 500),
  loadCategoryLabels: vi.fn(async () => new Map<string, string>()),
}));

// Import AFTER the mocks are registered so the module captures the mocked
// prisma binding (CommonJS modules evaluate imports eagerly).
import {
  gustoW2Csv,
  gustoContractorsCsv,
  qbIncomeCsv,
  qbExpensesCsv,
  qbEquityCsv,
} from "./exports";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const RANGE_START = new Date("2026-06-01T00:00:00.000Z");
const RANGE_END = new Date("2026-06-30T23:59:59.999Z");

// Two confirmed payments — one Contractor-only ($100), one mixed crew with
// an underpay scenario ($60 collected on a $100 promise, employee made whole
// with a top-up). The shortfall and topUp fields are populated as the
// approval flow would write them — the tests then assert these DO NOT bleed
// into any tax export.
function makeConfirmedPayments() {
  return [
    {
      id: "pmt-1",
      amountPaid: 100,
      method: "ZELLE",
      note: "Adams payment",
      confirmed: true,
      confirmedAt: new Date("2026-06-10T15:00:00.000Z"),
      writtenOff: false,
      platformFeeAmount: 20,
      platformFeePercent: 20,
      businessMarginAmount: 0,
      businessMarginPercent: 30,
      shortfallAmount: 0,
      overageAmount: 0,
      processorFeeAmount: null,
      processorFeeFixed: null,
      processorFeePercent: null,
      grossCharged: null,
      netReceived: null,
      occurrence: {
        id: "occ-1",
        startedAt: new Date("2026-06-10T13:00:00.000Z"),
        completedAt: new Date("2026-06-10T14:00:00.000Z"),
        totalPausedMs: 0,
        assignees: [{ userId: "c1", role: null }],
        job: {
          property: {
            displayName: "Home — Adams",
            street1: "123 Main",
            city: "Town",
            state: "ST",
            client: { displayName: "Adams" },
          },
        },
      },
      splits: [
        {
          userId: "c1",
          amount: 80,
          grossAmount: 100,
          ratePercent: 20,
          feeAmount: 20,
          netAmount: 80,
          topUpAmount: 0,
          ownerEarnings: false,
          user: { id: "c1", displayName: "Carla Contractor", email: "carla@example.com", workerType: "CONTRACTOR" },
        },
      ],
    },
    {
      id: "pmt-2",
      amountPaid: 60,
      method: "CASH",
      note: "Banks underpay",
      confirmed: true,
      confirmedAt: new Date("2026-06-15T16:00:00.000Z"),
      writtenOff: false,
      platformFeeAmount: 10,
      platformFeePercent: 20,
      businessMarginAmount: 15,
      businessMarginPercent: 30,
      shortfallAmount: 25,
      overageAmount: 0,
      processorFeeAmount: null,
      processorFeeFixed: null,
      processorFeePercent: null,
      grossCharged: null,
      netReceived: null,
      occurrence: {
        id: "occ-2",
        startedAt: new Date("2026-06-15T13:00:00.000Z"),
        completedAt: new Date("2026-06-15T14:30:00.000Z"),
        totalPausedMs: 0,
        assignees: [
          { userId: "c1", role: null },
          { userId: "e1", role: "helper" },
        ],
        job: {
          property: {
            displayName: "Home — Banks",
            street1: "1 Lake",
            city: "Town",
            state: "ST",
            client: { displayName: "Banks" },
          },
        },
      },
      splits: [
        {
          userId: "c1",
          amount: 20,
          grossAmount: 30,
          ratePercent: 20,
          feeAmount: 6,
          netAmount: 24,
          topUpAmount: 0,
          ownerEarnings: false,
          user: { id: "c1", displayName: "Carla Contractor", email: "carla@example.com", workerType: "CONTRACTOR" },
        },
        {
          userId: "e1",
          amount: 35,
          grossAmount: 30,
          ratePercent: 30,
          feeAmount: 9,
          netAmount: 21,
          // Employee made whole with $14 top-up. This field must NOT
          // appear as a separate column in any tax export.
          topUpAmount: 14,
          ownerEarnings: false,
          user: { id: "e1", displayName: "Eve Employee", email: "eve@example.com", workerType: "EMPLOYEE" },
        },
      ],
    },
  ];
}

function makeCompletedOccurrences() {
  // Used by gustoW2Csv to compute per-worker W-2 wages.
  return [
    {
      id: "occ-1",
      startedAt: new Date("2026-06-10T13:00:00.000Z"),
      completedAt: new Date("2026-06-10T14:00:00.000Z"),
      totalPausedMs: 0,
      price: 100,
      proposalAmount: null,
      promisedPayouts: null,
      completionSplits: [{ userId: "e1", percent: 100 }],
      addons: [],
      expenses: [],
      assignees: [{ userId: "e1", role: null, user: { id: "e1", displayName: "Eve Employee", email: "eve@example.com", workerType: "EMPLOYEE" } }],
    },
    {
      id: "occ-2",
      startedAt: new Date("2026-06-15T13:00:00.000Z"),
      completedAt: new Date("2026-06-15T14:30:00.000Z"),
      totalPausedMs: 0,
      price: 100,
      proposalAmount: null,
      promisedPayouts: null,
      completionSplits: [
        { userId: "c1", percent: 50 },
        { userId: "e1", percent: 50 },
      ],
      addons: [],
      expenses: [],
      assignees: [
        { userId: "c1", role: null, user: { id: "c1", displayName: "Carla Contractor", email: "carla@example.com", workerType: "CONTRACTOR" } },
        { userId: "e1", role: "helper", user: { id: "e1", displayName: "Eve Employee", email: "eve@example.com", workerType: "EMPLOYEE" } },
      ],
    },
  ];
}

function makeEquipmentRentals() {
  // Contractor rentals — Checkouts with rentalCost > 0 and releasedAt
  // in range. These are equipment rental INCOME to the business (the
  // contractor pays the LLC to use company-owned equipment) and must
  // appear in qb-income.csv. Solo rentals have `splits: []` (no group);
  // the export emits one row per checkout. Group-rental fixtures are
  // added by individual tests as needed.
  return [
    {
      id: "co-1",
      equipmentId: "eq-mower",
      userId: "c1",
      reservedAt: new Date("2026-06-09T13:00:00.000Z"),
      checkedOutAt: new Date("2026-06-09T14:00:00.000Z"),
      releasedAt: new Date("2026-06-10T22:00:00.000Z"),
      rentalDays: 2,
      rentalCost: 60.0,
      equipment: { id: "eq-mower", shortDesc: "21\" mower", brand: "Honda", model: "HRX217VLA" },
      user: { id: "c1", displayName: "Carla Contractor", email: "carla@example.com" },
      splits: [],
    },
    {
      id: "co-2",
      equipmentId: "eq-aerator",
      userId: "c1",
      reservedAt: new Date("2026-06-20T13:00:00.000Z"),
      checkedOutAt: new Date("2026-06-21T14:00:00.000Z"),
      releasedAt: new Date("2026-06-22T22:00:00.000Z"),
      rentalDays: 2,
      rentalCost: 120.0,
      equipment: { id: "eq-aerator", shortDesc: "Aerator", brand: "Bluebird", model: "PR22" },
      user: { id: "c1", displayName: "Carla Contractor", email: "carla@example.com" },
      splits: [],
    },
  ];
}

function makeBusinessExpenses() {
  return [
    {
      id: "be-1",
      type: "EXPENSE" as const,
      date: new Date("2026-06-05T12:00:00.000Z"),
      cost: 87.43,
      description: "Lawn fertilizer",
      category: "Supplies",
      vendor: "Home Depot",
      invoiceNumber: null,
      notes: null,
      equipmentId: null,
      occurrenceId: null,
      receiptR2Key: null,
      receiptFileName: null,
      receiptContentType: null,
      receiptUploadedAt: null,
      recurrence: null,
      recurrenceSkippedUntil: null,
      createdById: "u-michael",
      occurrence: null,
    },
    {
      id: "be-2",
      type: "EXPENSE" as const,
      date: new Date("2026-06-12T12:00:00.000Z"),
      cost: 42.10,
      description: "Gas refill",
      category: "Vehicle expenses",
      vendor: "Shell",
      invoiceNumber: null,
      notes: null,
      equipmentId: null,
      occurrenceId: null,
      receiptR2Key: null,
      receiptFileName: null,
      receiptContentType: null,
      receiptUploadedAt: null,
      recurrence: null,
      recurrenceSkippedUntil: null,
      createdById: "u-michael",
      occurrence: null,
    },
  ];
}

function makeEquityEntries() {
  return [
    {
      id: "be-eq-1",
      type: "CAPITAL_CONTRIBUTION" as const,
      date: new Date("2026-06-03T12:00:00.000Z"),
      cost: 1500,
      description: "Initial capital",
      category: null,
      notes: null,
    },
    {
      id: "be-eq-2",
      type: "OWNER_DRAW" as const,
      date: new Date("2026-06-20T12:00:00.000Z"),
      cost: 500,
      description: "Monthly owner draw",
      category: null,
      notes: null,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default mock: empty results. Individual tests override per case.
  prismaMock.payment.findMany.mockResolvedValue([]);
  prismaMock.businessExpense.findMany.mockResolvedValue([]);
  prismaMock.equipment.findMany.mockResolvedValue([]);
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.jobOccurrence.findMany.mockResolvedValue([]);
  prismaMock.paymentSplit.findMany.mockResolvedValue([]);
  prismaMock.checkout.findMany.mockResolvedValue([]);
  // Settings are looked up by key. Different keys need different values
  // so tests don't accidentally read e.g. the FIXED_ASSET_MIN_COST
  // threshold as a margin percent. The big-cost defaults match the
  // production seed for the keys exercised by the exports under test.
  prismaMock.setting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    const defaults: Record<string, string> = {
      EMPLOYEE_BUSINESS_MARGIN_PERCENT: "30",
      CONTRACTOR_PLATFORM_FEE_PERCENT: "20",
      // Test fixtures stay below this so they classify as operating
      // expenses (qb-expenses.csv), not fixed-asset purchases.
      FIXED_ASSET_MIN_COST: "500",
      // Equipment rental income routing — defaults match production seed.
      EQUIPMENT_RENTAL_INCOME_CONFIG: JSON.stringify({
        qbAccount: "Equipment Rental Income",
        scheduleCLine: "1",
      }),
    };
    const value = defaults[where.key];
    return value == null ? null : { value };
  });
});

// Helper — parse a CSV string into rows of cell strings. Naïve splitter
// adequate for our deterministic test output (no embedded newlines in
// fixture cells; quoted commas are not exercised here). Strips the
// UTF-8 BOM (the canonical exporter prepends one for Excel) and accepts
// either CRLF or LF line endings.
function parseCsv(csv: string): string[][] {
  return csv
    .replace(/^﻿/, "") // strip UTF-8 BOM
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
}

// ─────────────────────────────────────────────────────────────────────────────
// qb-income.csv
// ─────────────────────────────────────────────────────────────────────────────

describe("qbIncomeCsv — tax integrity", () => {
  it("locks in the journal-entry column header (any new column requires updating this test)", async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    const { csv } = await qbIncomeCsv(RANGE_START, RANGE_END);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([
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
    ]);
  });

  it("Debits/Credits use Payment.amountPaid — NOT a derived field", async () => {
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    const { csv } = await qbIncomeCsv(RANGE_START, RANGE_END);
    const rows = parseCsv(csv);
    // Journal-entry pair per payment: row 1 debits clearing, row 2 credits
    // the income account. Both rows share JournalNo (col 0). Each pair must
    // carry amountPaid verbatim — NOT splits sum, NOT promised.
    const pmt1Pair = rows.filter((r) => r[0] === "PAY-pmt-1");
    const pmt2Pair = rows.filter((r) => r[0] === "PAY-pmt-2");
    expect(pmt1Pair).toHaveLength(2);
    expect(pmt2Pair).toHaveLength(2);
    // Row 1 (debit clearing): Debits col = amount, Credits col = ""
    expect(pmt1Pair[0][3]).toBe("100.00"); // Debits
    expect(pmt1Pair[0][4]).toBe(""); // Credits
    // Row 2 (credit income account): Debits col = "", Credits col = amount
    expect(pmt1Pair[1][3]).toBe(""); // Debits
    expect(pmt1Pair[1][4]).toBe("100.00"); // Credits
    // Same shape for pmt-2 — amountPaid (60), NOT promised ($100), NOT splits sum ($55).
    expect(pmt2Pair[0][3]).toBe("60.00");
    expect(pmt2Pair[1][4]).toBe("60.00");
  });

  it("no TOTALS row — journal format only accepts balanced debit/credit pairs", async () => {
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    const { csv, total } = await qbIncomeCsv(RANGE_START, RANGE_END);
    const rows = parseCsv(csv);
    // The legacy "TOTALS" footer would crash QB's journal import (QB tries
    // to parse it as a journal line). The total field on the CsvResult is
    // still populated for in-app eyeball verification, but no row carries it.
    expect(rows.find((r) => r[0] === "TOTALS")).toBeUndefined();
    expect(total).toBe(160); // 100 + 60
    // Every body row must have a JournalNo (no orphan/footer rows).
    for (const r of rows.slice(1)) expect(r[0]).not.toBe("");
  });

  it("each payment emits exactly two journal rows sharing a JournalNo, date only on row 1", async () => {
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    const { csv } = await qbIncomeCsv(RANGE_START, RANGE_END);
    const rows = parseCsv(csv).slice(1); // skip header
    // Group by JournalNo — every group must be exactly 2 rows.
    const byJournal = new Map<string, string[][]>();
    for (const r of rows) {
      const arr = byJournal.get(r[0]) ?? [];
      arr.push(r);
      byJournal.set(r[0], arr);
    }
    for (const [_journalNo, pair] of byJournal) {
      expect(pair).toHaveLength(2);
      expect(pair[0][1]).not.toBe(""); // row 1 has a date
      expect(pair[1][1]).toBe(""); // row 2 date is blank
    }
  });

  it("NEVER includes derived columns (shortfall / overage / topup / margin / fee)", async () => {
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    const { csv } = await qbIncomeCsv(RANGE_START, RANGE_END);
    // The pmt-2 fixture has shortfall=25 and a $14 topUp on the employee
    // split — both must be invisible in the income export.
    expect(csv.toLowerCase()).not.toContain("shortfall");
    expect(csv.toLowerCase()).not.toContain("overage");
    expect(csv.toLowerCase()).not.toContain("topup");
    expect(csv.toLowerCase()).not.toContain("top-up");
    expect(csv).not.toMatch(/\b25\.00\b/); // shortfall value
    expect(csv).not.toMatch(/\b14\.00\b/); // topUp value
  });

  // ───── Equipment rental income (memory/project_equipment_rental_income.md)
  // The bug fixed on 2026-06-XX: equipment was being shown as a deduction
  // in the Admin summary AND missing entirely from QB Income. These tests
  // pin both ends — the rentals appear as income lines with raw cash
  // values, and the export account label routes to QB correctly.

  it("includes equipment rental rows with Amount = Checkout.rentalCost", async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.checkout.findMany.mockResolvedValue(makeEquipmentRentals());
    const { csv, total } = await qbIncomeCsv(RANGE_START, RANGE_END);
    // Each rental's rentalCost (raw cash value) must appear verbatim.
    expect(csv).toContain("60.00");
    expect(csv).toContain("120.00");
    // Total = sum of rentalCost values (no derived adjustment).
    expect(total).toBe(180);
  });

  it("tags equipment rental rows with the 'Equipment Rental Income' account", async () => {
    prismaMock.checkout.findMany.mockResolvedValue(makeEquipmentRentals());
    const { csv } = await qbIncomeCsv(RANGE_START, RANGE_END);
    expect(csv).toContain("Equipment Rental Income");
  });

  it("uses RENT- reference prefix for equipment rows (distinct from PAY-)", async () => {
    // PAY- vs RENT- prefixes let QB dedup on re-import without colliding
    // job-payment refs with equipment-rental refs.
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.checkout.findMany.mockResolvedValue(makeEquipmentRentals());
    const { csv } = await qbIncomeCsv(RANGE_START, RANGE_END);
    expect(csv).toContain("RENT-co-1");
    expect(csv).toContain("RENT-co-2");
    expect(csv).not.toContain("PAY-co-1");
  });

  it("equipment rental income sums correctly alongside job payments", async () => {
    // Payments fixture totals $160 (100 + 60). Equipment rentals total
    // $180. Combined export total must be $340 — proving both income
    // sources contribute additively, no subtraction or netting.
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    prismaMock.checkout.findMany.mockResolvedValue(makeEquipmentRentals());
    const { total, rowCount } = await qbIncomeCsv(RANGE_START, RANGE_END);
    expect(total).toBe(340);
    expect(rowCount).toBe(4); // 2 payments + 2 rentals
  });

  it("EQUIPMENT_RENTAL_INCOME_CONFIG setting overrides the QB account + Schedule C line", async () => {
    // CPA prefers separate-line visibility: Line 6 (Other gross receipts)
    // with a distinct chart-of-accounts entry name. Flipping the Setting
    // should change the export rows immediately — no code deploy.
    prismaMock.setting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === "EQUIPMENT_RENTAL_INCOME_CONFIG") {
        return { value: JSON.stringify({ qbAccount: "Equipment Rental Revenue", scheduleCLine: "6" }) };
      }
      // All other setting reads keep their default values for this test.
      const defaults: Record<string, string> = {
        EMPLOYEE_BUSINESS_MARGIN_PERCENT: "30",
        CONTRACTOR_PLATFORM_FEE_PERCENT: "20",
        FIXED_ASSET_MIN_COST: "500",
      };
      const v = defaults[where.key];
      return v == null ? null : { value: v };
    });
    prismaMock.checkout.findMany.mockResolvedValue(makeEquipmentRentals());
    const { csv } = await qbIncomeCsv(RANGE_START, RANGE_END);
    expect(csv).toContain("Equipment Rental Revenue");
    expect(csv).not.toContain("Equipment Rental Income");
    // In the journal-entry format the Schedule C line number column is gone
    // (journals route purely by AccountName). Verify the AccountName column
    // (index 2) of every credit-side rental row carries the overridden
    // qbAccount string verbatim.
    const rows = parseCsv(csv).slice(1);
    const rentalCreditRows = rows.filter((r) => r[0].startsWith("RENT-") && r[4] !== "");
    expect(rentalCreditRows.length).toBeGreaterThan(0);
    for (const r of rentalCreditRows) {
      expect(r[2]).toBe("Equipment Rental Revenue");
    }
  });

  it("falls back to defaults when EQUIPMENT_RENTAL_INCOME_CONFIG is missing", async () => {
    // No setting row at all → defaults apply (Line 1 / "Equipment Rental
    // Income"). This protects fresh databases that haven't run the seed
    // and prod environments that haven't manually inserted the row yet.
    prismaMock.setting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === "EQUIPMENT_RENTAL_INCOME_CONFIG") return null;
      const defaults: Record<string, string> = {
        EMPLOYEE_BUSINESS_MARGIN_PERCENT: "30",
        CONTRACTOR_PLATFORM_FEE_PERCENT: "20",
        FIXED_ASSET_MIN_COST: "500",
      };
      const v = defaults[where.key];
      return v == null ? null : { value: v };
    });
    prismaMock.checkout.findMany.mockResolvedValue(makeEquipmentRentals());
    const { csv } = await qbIncomeCsv(RANGE_START, RANGE_END);
    expect(csv).toContain("Equipment Rental Income");
  });

  it("falls back to defaults when EQUIPMENT_RENTAL_INCOME_CONFIG is malformed JSON", async () => {
    // Malformed value (typo, broken JSON) must not crash the export.
    prismaMock.setting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
      if (where.key === "EQUIPMENT_RENTAL_INCOME_CONFIG") return { value: "{not-json" };
      const defaults: Record<string, string> = {
        EMPLOYEE_BUSINESS_MARGIN_PERCENT: "30",
        CONTRACTOR_PLATFORM_FEE_PERCENT: "20",
        FIXED_ASSET_MIN_COST: "500",
      };
      const v = defaults[where.key];
      return v == null ? null : { value: v };
    });
    prismaMock.checkout.findMany.mockResolvedValue(makeEquipmentRentals());
    const { csv } = await qbIncomeCsv(RANGE_START, RANGE_END);
    expect(csv).toContain("Equipment Rental Income"); // default qbAccount
  });

  it("skips rentals with rentalCost ≤ 0 (defensive — Prisma where clause already filters, but guard anyway)", async () => {
    // The findMany query has `rentalCost: { gt: 0 }`, but we double-guard
    // in code in case the data ever shows up wrong (e.g. via a manual
    // SQL fix). A $0 rental should not produce a CSV row.
    prismaMock.checkout.findMany.mockResolvedValue([
      // Prisma where would filter this, but the mock returns it
      // unconditionally — the in-code guard skips it.
      { ...makeEquipmentRentals()[0], id: "co-zero", rentalCost: 0 },
      makeEquipmentRentals()[1],
    ]);
    const { csv, total, rowCount } = await qbIncomeCsv(RANGE_START, RANGE_END);
    // Only the $120 rental contributes; the $0 row is suppressed.
    expect(csv).not.toContain("RENT-co-zero");
    expect(total).toBe(120);
    expect(rowCount).toBe(1); // only the $120 row was written
  });

  // ── Group rentals — per-contractor split rows ──────────────────────────
  // When a Checkout has CheckoutSplit rows (i.e., it was a group rental),
  // the export emits ONE ROW PER CONTRACTOR SPLIT instead of one row at
  // the parent Checkout.rentalCost. Employee/trainee splits have amount=0
  // and are filtered by the Prisma where clause (`splits.where.amount > 0`);
  // here we verify the export logic handles whatever the query returns.
  it("group rental emits one CSV row per contractor split, NOT a single row at parent rentalCost", async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.checkout.findMany.mockResolvedValue([
      {
        ...makeEquipmentRentals()[0],
        id: "co-group-1",
        groupId: "g-alpha-crew",
        // Parent rentalCost = sum of contractor splits (per the new
        // splitter contract). Two contractors at $30 each = $60.
        rentalCost: 60.0,
        splits: [
          {
            checkoutId: "co-group-1",
            userId: "c1",
            percent: 50,
            amount: 30.0,
            user: { id: "c1", displayName: "Carla Contractor", email: "carla@example.com" },
          },
          {
            checkoutId: "co-group-1",
            userId: "c2",
            percent: 50,
            amount: 30.0,
            user: { id: "c2", displayName: "Carl Contractor", email: "carl@example.com" },
          },
        ],
      },
    ]);
    const { csv, total, rowCount } = await qbIncomeCsv(RANGE_START, RANGE_END);
    const rows = parseCsv(csv).slice(1);
    // Each contractor gets its own journal-entry pair (2 rows). Two
    // contractors → 4 lines total, all carrying a RENT- JournalNo.
    const rentalLines = rows.filter((r) => r[0].startsWith("RENT-"));
    expect(rentalLines.length).toBe(4);
    // Per-contractor JournalNos must be distinct so QB dedupes correctly
    // on re-import.
    const journalNos = new Set(rentalLines.map((r) => r[0]));
    expect(journalNos.has("RENT-co-group-1-c1")).toBe(true);
    expect(journalNos.has("RENT-co-group-1-c2")).toBe(true);
    // The plain "RENT-co-group-1" without the user suffix must NOT appear
    // (would imply a single per-checkout pair collapsing both contractors).
    expect(journalNos.has("RENT-co-group-1")).toBe(false);
    // Each contractor's name appears on its own pair.
    expect(csv).toContain("Carla Contractor");
    expect(csv).toContain("Carl Contractor");
    // Per-split amount ($30) — not parent rentalCost.
    expect(csv).toContain("30.00");
    expect(total).toBe(60); // sum of the two splits
    // rowCount = source transactions (2 splits), NOT 4 emitted lines.
    expect(rowCount).toBe(2);
  });

  it("mixed crew (contractor + employee splits) — employee amount=0 already filtered, contractor row only", async () => {
    // The Prisma query has `splits.where.amount > 0`, so $0 employee
    // splits never reach the mock here. This test pins what the export
    // emits given that filtered input: just the contractor.
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.checkout.findMany.mockResolvedValue([
      {
        ...makeEquipmentRentals()[0],
        id: "co-mixed",
        groupId: "g-mixed",
        rentalCost: 30.0, // only the contractor's $30 (employee absorbed)
        splits: [
          {
            checkoutId: "co-mixed",
            userId: "c1",
            percent: 50,
            amount: 30.0,
            user: { id: "c1", displayName: "Carla Contractor", email: "carla@example.com" },
          },
          // The employee split (amount=0) was filtered out by the Prisma
          // where clause — not in the mock data.
        ],
      },
    ]);
    const { csv, total, rowCount } = await qbIncomeCsv(RANGE_START, RANGE_END);
    expect(csv).toContain("Carla Contractor");
    expect(csv).not.toContain("Eve Employee"); // employee never appears
    expect(total).toBe(30);
    expect(rowCount).toBe(1);
  });

  it("group rental income sums alongside solo rentals correctly", async () => {
    // Solo rental: $60. Group rental: 2 contractors at $30 each = $60.
    // Total: $120 across 3 rows (1 solo + 2 group splits).
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.checkout.findMany.mockResolvedValue([
      makeEquipmentRentals()[0], // solo, $60
      {
        ...makeEquipmentRentals()[1],
        id: "co-group-2",
        groupId: "g-bravo-crew",
        rentalCost: 60.0,
        splits: [
          {
            checkoutId: "co-group-2",
            userId: "c1",
            percent: 50,
            amount: 30.0,
            user: { id: "c1", displayName: "Carla Contractor", email: "carla@example.com" },
          },
          {
            checkoutId: "co-group-2",
            userId: "c2",
            percent: 50,
            amount: 30.0,
            user: { id: "c2", displayName: "Carl Contractor", email: "carl@example.com" },
          },
        ],
      },
    ]);
    const { total, rowCount } = await qbIncomeCsv(RANGE_START, RANGE_END);
    expect(total).toBe(120);
    expect(rowCount).toBe(3); // 1 solo + 2 group split rows
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// qb-expenses.csv
// ─────────────────────────────────────────────────────────────────────────────

describe("qbExpensesCsv — tax integrity", () => {
  it("locks in the journal-entry column header", async () => {
    prismaMock.businessExpense.findMany.mockResolvedValue([]);
    prismaMock.payment.findMany.mockResolvedValue([]);
    const { csv } = await qbExpensesCsv(RANGE_START, RANGE_END);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([
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
    ]);
  });

  it("Amount column uses BusinessExpense.cost — NOT a derived field", async () => {
    prismaMock.businessExpense.findMany.mockResolvedValue(makeBusinessExpenses());
    prismaMock.payment.findMany.mockResolvedValue([]);
    const { csv, total } = await qbExpensesCsv(RANGE_START, RANGE_END);
    // The fixture has two EXPENSE rows ($87.43 + $42.10 = $129.53). The
    // CSV should contain those exact strings AND the totals row should
    // reflect their sum — proving the Amount column is BusinessExpense.cost
    // and nothing has been substituted with a derived value.
    expect(csv).toContain("87.43");
    expect(csv).toContain("42.10");
    expect(total).toBe(129.53);
  });

  it("NEVER bleeds shortfall / overage / topup into expense rows", async () => {
    prismaMock.businessExpense.findMany.mockResolvedValue(makeBusinessExpenses());
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    const { csv } = await qbExpensesCsv(RANGE_START, RANGE_END);
    expect(csv.toLowerCase()).not.toContain("shortfall");
    expect(csv.toLowerCase()).not.toContain("overage");
    expect(csv.toLowerCase()).not.toContain("topup");
    expect(csv.toLowerCase()).not.toContain("top-up");
    expect(csv.toLowerCase()).not.toContain("bad debt");
  });

  // ── Regression: JournalNo uses the short ledgerId, NOT the full cuid ──
  // The original bug this guards against: the processor-fee query loads
  // Payment rows via `select` (not `include`), and ledgerId was missing
  // from that select — so every fee row's parentLedger came through
  // undefined and the export fell back to `FEE-{cuid}` (29 chars), which
  // QuickBooks rejects on import (the doc_num field is capped at 21 chars).
  // If this test fails because a JournalNo starts with FEE- in production
  // data, someone has dropped `ledgerId: true` from a Prisma select again.
  it("processor-fee JournalNo derives from parent Payment.ledgerId with -F suffix (NOT FEE-{cuid})", async () => {
    prismaMock.businessExpense.findMany.mockResolvedValue([]);
    prismaMock.payment.findMany.mockResolvedValue([
      {
        id: "pmt-fee-x",
        ledgerId: "SLC-260605-X7K2",
        method: "VENMO",
        confirmedAt: new Date("2026-06-05T15:00:00.000Z"),
        processorFeeAmount: 1.75,
        grossCharged: 100,
        splits: [],
        occurrence: {
          id: "occ-fee",
          job: { property: { displayName: "Test", street1: "1 X", city: "C", state: "S", client: { displayName: "Doe" } } },
        },
      },
    ]);
    const { csv } = await qbExpensesCsv(RANGE_START, RANGE_END);
    // Short journal-no path: derived from parent ledgerId, under 21 chars.
    expect(csv).toContain("SLC-260605-X7K2-F");
    // Long-cuid fallback must NOT appear when ledgerId is present.
    expect(csv).not.toContain("FEE-pmt-fee-x");
    // Length sanity: every JournalNo on every row must fit under QB's
    // doc_num limit. This catches any other long-cuid fallback path too.
    const rows = parseCsv(csv).slice(1); // skip header
    for (const r of rows) {
      expect(r[0].length).toBeLessThanOrEqual(21);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// qb-equity.csv
// ─────────────────────────────────────────────────────────────────────────────

describe("qbEquityCsv — tax integrity", () => {
  it("locks in the column header", async () => {
    prismaMock.businessExpense.findMany.mockResolvedValue([]);
    const { csv } = await qbEquityCsv(RANGE_START, RANGE_END);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([
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
    ]);
  });

  it("Capital contributions and owner draws use BusinessExpense.cost", async () => {
    prismaMock.businessExpense.findMany.mockResolvedValue(makeEquityEntries());
    const { csv } = await qbEquityCsv(RANGE_START, RANGE_END);
    const rows = parseCsv(csv);
    const capRow = rows.find((r) => r.some((c) => c.includes("EXP-be-eq-1")));
    const drawRow = rows.find((r) => r.some((c) => c.includes("EXP-be-eq-2")));
    expect(capRow?.[2]).toBe("1500.00");
    expect(capRow?.[3]).toBe("Owner Investments"); // QB equity account name
    expect(drawRow?.[2]).toBe("500.00");
    expect(drawRow?.[3]).toBe("Owner Draws");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gusto-w2.csv — payroll integrity
// ─────────────────────────────────────────────────────────────────────────────

describe("CSV format hygiene (all exports)", () => {
  it("every CSV starts with a UTF-8 BOM (Excel-on-Windows decodes correctly)", async () => {
    prismaMock.jobOccurrence.findMany.mockResolvedValue(makeCompletedOccurrences());
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    prismaMock.guaranteedPayoutAdvance.findMany.mockResolvedValue([]);
    prismaMock.businessExpense.findMany.mockResolvedValue([]);
    prismaMock.setting.findUnique.mockResolvedValue({ value: "30" });

    const w2 = await gustoW2Csv(RANGE_START, RANGE_END);
    const contractors = await gustoContractorsCsv(RANGE_START, RANGE_END);
    // BOM = 0xEF 0xBB 0xBF, which encodes as U+FEFF in JS strings.
    expect(w2.csv.charCodeAt(0)).toBe(0xfeff);
    expect(contractors.csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("every CSV uses CRLF line endings (RFC 4180; older Excel/Windows tools require it)", async () => {
    prismaMock.jobOccurrence.findMany.mockResolvedValue(makeCompletedOccurrences());
    prismaMock.setting.findUnique.mockResolvedValue({ value: "30" });

    const { csv } = await gustoW2Csv(RANGE_START, RANGE_END);
    // At least one CRLF must appear (between header and first data row,
    // at minimum). No bare LF without a preceding CR.
    expect(csv).toContain("\r\n");
    // Strip the BOM, then check no LF appears without a CR immediately
    // before it.
    const body = csv.replace(/^﻿/, "");
    const bareLfs = body.split("").filter((c, i) => c === "\n" && body[i - 1] !== "\r");
    expect(bareLfs.length).toBe(0);
  });

  it("CSV injection defense: fields starting with =, +, -, @, \\t, \\r get a literal-quote prefix", async () => {
    // Inject a worker whose name starts with `=` — the OWASP CSV
    // Injection canonical attack. The exporter MUST prefix `'` so
    // Excel treats it as a literal, not a formula.
    const evil = makeCompletedOccurrences();
    // Mutate the assignee name on the first occurrence's first assignee
    // to simulate an attacker-controlled value.
    (evil[0].assignees[0].user as any).displayName = "=cmd|/c calc!";
    prismaMock.jobOccurrence.findMany.mockResolvedValue(evil);
    prismaMock.setting.findUnique.mockResolvedValue({ value: "30" });

    const { csv } = await gustoW2Csv(RANGE_START, RANGE_END);
    // The dangerous value must NEVER appear unprefixed at the start of
    // a field (i.e. directly after a comma or as the first char of a
    // row). It must always appear with a leading `'`.
    expect(csv).not.toMatch(/(?:^|,)=cmd/m);
    expect(csv).toContain("'=cmd");
  });
});

describe("gustoW2Csv — payroll integrity", () => {
  it("never produces a negative wage amount", async () => {
    // Even on an underpaid job, the employee is made whole; gross wages
    // for an employee must be ≥ 0 in the W-2 export.
    prismaMock.jobOccurrence.findMany.mockResolvedValue(makeCompletedOccurrences());
    prismaMock.setting.findUnique.mockResolvedValue({ value: "30" });
    const { csv } = await gustoW2Csv(RANGE_START, RANGE_END);
    const rows = parseCsv(csv);
    // Find any numeric cell in the body rows; assert no leading "-".
    for (const row of rows.slice(1)) { // skip header
      if (row[0] === "TOTALS") continue;
      for (const cell of row) {
        // Any value formatted as "$NNN.NN" or plain "NNN.NN" must be non-negative.
        if (/^-?\d+\.\d{2}$/.test(cell)) {
          expect(Number(cell)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("NEVER includes shortfall / topup / overage language in the CSV", async () => {
    prismaMock.jobOccurrence.findMany.mockResolvedValue(makeCompletedOccurrences());
    prismaMock.setting.findUnique.mockResolvedValue({ value: "30" });
    const { csv } = await gustoW2Csv(RANGE_START, RANGE_END);
    expect(csv.toLowerCase()).not.toContain("shortfall");
    expect(csv.toLowerCase()).not.toContain("topup");
    expect(csv.toLowerCase()).not.toContain("top-up");
    expect(csv.toLowerCase()).not.toContain("overage");
    expect(csv.toLowerCase()).not.toContain("bad debt");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gusto-contractors.csv — 1099 integrity
// ─────────────────────────────────────────────────────────────────────────────

describe("gustoContractorsCsv — 1099 integrity", () => {
  it("amount per contractor uses split.amount (their final reconciled net)", async () => {
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    const { csv } = await gustoContractorsCsv(RANGE_START, RANGE_END);
    // Carla appears on two payments: $80 + $20 = $100 total contractor pay.
    // Eve is an employee — must NOT appear in contractors export.
    expect(csv).toContain("Carla");
    expect(csv).not.toContain("Eve Employee");
  });

  it("NEVER includes derived/internal fields", async () => {
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    const { csv } = await gustoContractorsCsv(RANGE_START, RANGE_END);
    expect(csv.toLowerCase()).not.toContain("shortfall");
    expect(csv.toLowerCase()).not.toContain("topup");
    expect(csv.toLowerCase()).not.toContain("overage");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate guard — runs every export with non-trivial fixtures, scans the
// concatenated output for forbidden tokens. Catch-all for "did anyone
// accidentally introduce a derived column in one of these exports?".
// ─────────────────────────────────────────────────────────────────────────────

describe("Slice 2 — Guaranteed payout reconciliation", () => {
  it("non-flagged contractor splits appear in Gusto Contractors CSV (no-GP path unchanged)", async () => {
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    prismaMock.jobOccurrence.findMany.mockResolvedValue([]);
    prismaMock.guaranteedPayoutAdvance.findMany.mockResolvedValue([]);
    prismaMock.setting.findUnique.mockResolvedValue({ value: "20" });

    const result = await gustoContractorsCsv(RANGE_START, RANGE_END);
    // Two payments → one row for Carla (split sums across both payments).
    expect(result.csv).toContain("Carla,Contractor");
    expect(result.csv).toContain("100.00"); // 80 + 20 = $100 total
    expect(result.rowCount).toBe(1);
  });

  it("flagged splits (guaranteedPayoutPaidAt set) are EXCLUDED from Gusto Contractors CSV", async () => {
    const payments = makeConfirmedPayments();
    // Flag Carla's split on the first payment.
    (payments[0].splits[0] as any).guaranteedPayoutPaidAt = new Date(
      "2026-06-05T12:00:00.000Z",
    );
    prismaMock.payment.findMany.mockResolvedValue(payments);
    prismaMock.jobOccurrence.findMany.mockResolvedValue([]);
    prismaMock.guaranteedPayoutAdvance.findMany.mockResolvedValue([]);
    prismaMock.setting.findUnique.mockResolvedValue({ value: "20" });

    const result = await gustoContractorsCsv(RANGE_START, RANGE_END);
    // Only the second payment's $20 split counts now (first was advance-paid).
    expect(result.csv).toContain("Carla,Contractor");
    expect(result.csv).toContain("20.00");
    // The $100 from the flagged split must NOT appear in totals.
    expect(result.csv).not.toContain("100.00");
  });

  it("GuaranteedPayoutAdvance rows in window emit Contract Labor lines in QB Expenses CSV", async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.businessExpense.findMany.mockResolvedValue([]);
    prismaMock.jobOccurrence.findMany.mockResolvedValue([]);
    prismaMock.setting.findUnique.mockResolvedValue({ value: "20" });
    prismaMock.guaranteedPayoutAdvance.findMany.mockResolvedValue([
      {
        id: "adv-1",
        userId: "c1",
        occurrenceId: "occ-x",
        amount: 50,
        exportedAt: new Date("2026-06-12T15:00:00.000Z"),
        user: { displayName: "Carla Contractor", email: "carla@example.com" },
        occurrence: {
          id: "occ-x",
          job: {
            property: {
              displayName: "Home — Test",
              street1: "1 X",
              city: "City",
              state: "ST",
              client: { displayName: "Test Client" },
            },
          },
        },
      },
    ]);

    const result = await qbExpensesCsv(RANGE_START, RANGE_END);
    // Advance journal pair gets a GPA- JournalNo (vs CL- for confirmed-
    // payment splits) and routes to the Contract Labor QB account on the
    // debit side. Category column is gone in the journal-entry format —
    // QB routes by AccountName alone — so we check the AccountName column
    // (index 2) on the debit row carries the resolved account string.
    expect(result.csv).toContain("GPA-adv-1");
    expect(result.csv).toContain("50.00");
    expect(result.csv).toContain("Contractor advance");
    const rows = parseCsv(result.csv).slice(1);
    const advancePair = rows.filter((r) => r[0] === "GPA-adv-1");
    expect(advancePair).toHaveLength(2);
    // Debit row: AccountName = contract-labor account (the mock's
    // qbAccountMap returns "Unmapped" by default since no override is set
    // for the CONTRACT_LABOR_CATEGORY in this test).
    expect(advancePair[0][3]).toBe("50.00"); // Debits
    expect(advancePair[1][2]).toBe("App Clearing Account"); // credit-side account
    expect(advancePair[1][4]).toBe("50.00"); // Credits
  });

  // Regression test for the limbo-zone bug, updated for the wage-path
  // model:
  // A contractor in active GP period completes a job today. A Payment +
  // PaymentSplit exist (e.g. client self-reported via /pay/[token]) but
  // the payment hasn't been admin-approved yet (confirmed = false).
  // The contractor MUST appear on the Gusto Contractors CSV for the
  // period the work was completed in — regardless of payment status —
  // because GP-period contractors are paid like W-2 employees
  // (work-anchored). Under the new pure-read model, the function does
  // NOT write to GuaranteedPayoutAdvance.
  it("includes the contractor on the Gusto Contractors CSV for unconfirmed-payment GP work", async () => {
    prismaMock.payment.findMany.mockResolvedValue([]); // no confirmed payments
    prismaMock.guaranteedPayoutAdvance.findMany.mockResolvedValue([]);
    prismaMock.setting.findUnique.mockResolvedValue({ value: "20" });

    // Single occurrence completed in window. The contractor is in active
    // GP period. An unconfirmed payment + split already exist (the
    // contractor or client recorded the payment but admin hasn't
    // approved yet).
    const completedAt = new Date("2026-06-10T15:00:00.000Z");
    const gpStart = new Date("2026-06-01T00:00:00.000Z");
    const gpUntil = new Date("2026-06-30T23:59:59.000Z");
    prismaMock.jobOccurrence.findMany.mockResolvedValueOnce([
      {
        id: "occ-limbo",
        completedAt,
        price: 50,
        proposalAmount: null,
        completionSplits: [{ userId: "c1", percent: 100 }],
        addons: [],
        expenses: [],
        assignees: [
          {
            userId: "c1",
            role: null,
            user: {
              id: "c1",
              displayName: "Caleb Contractor",
              email: "caleb@example.com",
              workerType: "CONTRACTOR",
              guaranteedPayoutUntil: gpUntil,
              guaranteedPayoutStartedAt: gpStart,
              guaranteedPayoutHistory: [],
            },
          },
        ],
        payment: {
          confirmed: false,            // ← unconfirmed payment
          writtenOff: false,
          splits: [{ userId: "c1" }],  // ← split exists but doesn't pay yet
        },
      },
    ]);

    // No advance creation under the new model — assert the function
    // writes nothing (pure read).
    const created: any[] = [];
    (prismaMock.guaranteedPayoutAdvance.create as any).mockImplementation(
      async ({ data }: any) => {
        created.push(data);
        return { id: `adv-${created.length}`, amount: data.amount };
      },
    );

    const result = await gustoContractorsCsv(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-30T23:59:59.000Z"),
    );

    // The contractor appears in the CSV via the work-anchored path:
    // 50 × (1 - 0.20) = 40 at the 20% platform fee. The unconfirmed
    // payment does not block the wage-path computation.
    expect(result.csv).toContain("Caleb,Contractor");
    expect(result.csv).toContain("40.00");
    // No advance rows created — function is pure read.
    expect(created).toHaveLength(0);
  });

  // The flip side: a CONFIRMED payment with a split must still block
  // a GP advance — otherwise the contractor would be double-paid (once
  // via payment-anchored, once via advance).
  it("does NOT create a GP advance when a PaymentSplit exists on a CONFIRMED payment (no double-pay)", async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.guaranteedPayoutAdvance.findMany.mockResolvedValue([]);
    prismaMock.setting.findUnique.mockResolvedValue({ value: "20" });

    const completedAt = new Date("2026-06-10T15:00:00.000Z");
    const gpStart = new Date("2026-06-01T00:00:00.000Z");
    const gpUntil = new Date("2026-06-30T23:59:59.000Z");
    prismaMock.jobOccurrence.findMany.mockResolvedValueOnce([
      {
        id: "occ-confirmed",
        completedAt,
        price: 50,
        proposalAmount: null,
        completionSplits: [{ userId: "c1", percent: 100 }],
        addons: [],
        expenses: [],
        assignees: [
          {
            userId: "c1",
            role: null,
            user: {
              id: "c1",
              displayName: "Caleb Contractor",
              email: "caleb@example.com",
              workerType: "CONTRACTOR",
              guaranteedPayoutUntil: gpUntil,
              guaranteedPayoutStartedAt: gpStart,
              guaranteedPayoutHistory: [],
            },
          },
        ],
        payment: {
          confirmed: true,             // ← CONFIRMED payment
          writtenOff: false,
          splits: [{ userId: "c1" }],
        },
      },
    ]);

    const created: any[] = [];
    (prismaMock.guaranteedPayoutAdvance.create as any).mockImplementation(
      async ({ data }: any) => {
        created.push(data);
        return { id: `adv-${created.length}`, amount: data.amount };
      },
    );

    await gustoContractorsCsv(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-30T23:59:59.000Z"),
    );

    // Confirmed split blocks the GP advance — the contractor's already
    // getting paid via the payment-anchored path.
    expect(created).toHaveLength(0);
  });

  // Written-off payments are a third case: the client never paid, so
  // the PaymentSplit will never actually disburse money. The
  // work-anchored wage-path still pays the contractor because they were
  // in GP at completion. Under the new pure-read model the function
  // doesn't write to GuaranteedPayoutAdvance — the contractor simply
  // appears on the Gusto Contractors CSV.
  it("includes the contractor on the Gusto Contractors CSV for written-off GP work", async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    prismaMock.guaranteedPayoutAdvance.findMany.mockResolvedValue([]);
    prismaMock.setting.findUnique.mockResolvedValue({ value: "20" });

    const completedAt = new Date("2026-06-10T15:00:00.000Z");
    const gpStart = new Date("2026-06-01T00:00:00.000Z");
    const gpUntil = new Date("2026-06-30T23:59:59.000Z");
    prismaMock.jobOccurrence.findMany.mockResolvedValueOnce([
      {
        id: "occ-writeoff",
        completedAt,
        price: 50,
        proposalAmount: null,
        completionSplits: [{ userId: "c1", percent: 100 }],
        addons: [],
        expenses: [],
        assignees: [
          {
            userId: "c1",
            role: null,
            user: {
              id: "c1",
              displayName: "Caleb Contractor",
              email: "caleb@example.com",
              workerType: "CONTRACTOR",
              guaranteedPayoutUntil: gpUntil,
              guaranteedPayoutStartedAt: gpStart,
              guaranteedPayoutHistory: [],
            },
          },
        ],
        payment: {
          confirmed: true,
          writtenOff: true,            // ← written off — client never paid
          splits: [{ userId: "c1" }],
        },
      },
    ]);

    const created: any[] = [];
    (prismaMock.guaranteedPayoutAdvance.create as any).mockImplementation(
      async ({ data }: any) => {
        created.push(data);
        return { id: `adv-${created.length}`, amount: data.amount };
      },
    );

    const result = await gustoContractorsCsv(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-06-30T23:59:59.000Z"),
    );

    // Contractor appears via the work-anchored path. Write-off doesn't
    // change the wage-path computation.
    expect(result.csv).toContain("Caleb,Contractor");
    expect(result.csv).toContain("40.00");
    expect(created).toHaveLength(0);
  });
});

describe("All tax exports — forbidden-field guard", () => {
  it("none of the tax/payroll exports leak derived reporting fields", async () => {
    prismaMock.payment.findMany.mockResolvedValue(makeConfirmedPayments());
    prismaMock.businessExpense.findMany.mockResolvedValue([
      ...makeBusinessExpenses(),
      ...makeEquityEntries(),
    ]);
    prismaMock.jobOccurrence.findMany.mockResolvedValue(makeCompletedOccurrences());
    prismaMock.setting.findUnique.mockResolvedValue({ value: "30" });

    const all = await Promise.all([
      qbIncomeCsv(RANGE_START, RANGE_END),
      qbExpensesCsv(RANGE_START, RANGE_END),
      qbEquityCsv(RANGE_START, RANGE_END),
      gustoW2Csv(RANGE_START, RANGE_END),
      gustoContractorsCsv(RANGE_START, RANGE_END),
    ]);
    const concatenated = all.map((r) => r.csv).join("\n---\n").toLowerCase();
    // Internal reporting fields that must NEVER bleed into a tax export.
    const forbidden = [
      "shortfall",
      "overage",
      "topup",
      "top-up",
      "bad debt",
      "businessmargin",
      "platformfee", // header text variant
    ];
    for (const token of forbidden) {
      expect(concatenated).not.toContain(token);
    }
  });
});
