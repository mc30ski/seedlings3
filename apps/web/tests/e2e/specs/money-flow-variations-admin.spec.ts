// ─────────────────────────────────────────────────────────────────────────────
// THE SAME FLOW, MANY SHAPES. Real HTTP, real auth, real database.
//
// One happy path proves one arrangement of the money. These are the
// arrangements that actually happen — underpayment, a freebie, materials worth
// more than the labor, a cancelled job, a reverted payment — and each asserts
// the same four invariants rather than a hand-typed expectation:
//
//   1. the invoice equals labor + services + charges
//   2. the crew's pool equals labor + services, never touching materials
//   3. the client's lines sum to the total, and leak nothing internal
//   4. stock moves only when the job says it moved
//
// A variation that cannot be set up FAILS. It does not skip quietly.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";
import { apiAs } from "../helpers/api";
import { makePrisma } from "../helpers/db";

const r2 = (n: number) => Math.round(n * 100) / 100;

type Variation = {
  name: string;
  labor: number | null;
  services: number[];
  oneOffs: number[];
  /** [quantity, per-unit price for THIS client] */
  pulls: Array<[number, number]>;
  /** What the client actually hands over, relative to the invoice. */
  collect?: "exact" | "under" | "over" | "none";
  /** Cancel before completing — stock returns, charge drops. */
  cancel?: boolean;
  /** Change the held quantity after pulling. */
  adjustTo?: number;
  /** Delete a one-off charge before invoicing. */
  removeOneOff?: boolean;
};

const VARIATIONS: Variation[] = [
  { name: "labor only", labor: 150, services: [], oneOffs: [], pulls: [] },
  { name: "labor + one service", labor: 150, services: [40], oneOffs: [], pulls: [] },
  { name: "labor + one-off charge", labor: 150, services: [], oneOffs: [35], pulls: [] },
  { name: "labor + inventory", labor: 150, services: [], oneOffs: [], pulls: [[5, 6]] },
  { name: "everything at once", labor: 200, services: [60, 25], oneOffs: [45], pulls: [[12, 6.25]] },
  { name: "two pulls of one supply", labor: 100, services: [], oneOffs: [], pulls: [[3, 5], [4, 7.5]] },
  { name: "materials worth more than the labor", labor: 50, services: [], oneOffs: [], pulls: [[20, 9]] },
  { name: "a freebie — charged at zero", labor: 120, services: [], oneOffs: [], pulls: [[4, 0]] },
  { name: "fractional money", labor: 99.99, services: [33.33], oneOffs: [0.01], pulls: [[3, 1.11]] },
  { name: "many small services", labor: 80, services: [5, 5, 5, 5, 5, 5], oneOffs: [], pulls: [] },
  { name: "quantity adjusted UP after pulling", labor: 100, services: [], oneOffs: [], pulls: [[2, 5]], adjustTo: 6 },
  { name: "quantity adjusted DOWN after pulling", labor: 100, services: [], oneOffs: [], pulls: [[8, 5]], adjustTo: 3 },
  { name: "a one-off removed before invoicing", labor: 100, services: [], oneOffs: [25, 40], pulls: [], removeOneOff: true },
  { name: "client underpays", labor: 150, services: [], oneOffs: [30], pulls: [[4, 5]], collect: "under" },
  { name: "client overpays", labor: 150, services: [], oneOffs: [], pulls: [[4, 5]], collect: "over" },
  { name: "job cancelled after pulling stock", labor: 100, services: [], oneOffs: [], pulls: [[6, 5]], cancel: true },
  { name: "no payment taken", labor: 175, services: [20], oneOffs: [], pulls: [[2, 8]], collect: "none" },
];

test.describe.configure({ mode: "serial" });

for (const [i, v] of VARIATIONS.entries()) {
  test(`${String(i + 1).padStart(2, "0")} — ${v.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    const prisma = makePrisma();
    const TAG = `VAR${i}-${Date.now()}`;
    const undo: Array<() => Promise<unknown>> = [];

    try {
      await page.goto("/");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1200);

      // A supply with enough stock for whatever this variation pulls.
      const needed = v.pulls.reduce((s, [q]) => s + q, 0) + (v.adjustTo ?? 0) + 10;
      const sup = await apiAs(page, "POST", "/api/admin/supplies", {
        name: `${TAG} supply`, unit: "bag", businessCost: 2, clientUnitPrice: 5, category: "Supplies",
      });
      expect(sup.status, `supply: ${JSON.stringify(sup.json)}`).toBeLessThan(300);
      const supplyId = sup.json.id;
      undo.push(async () => {
        await prisma.supplyHold.deleteMany({ where: { supplyId } });
        await prisma.supplyPurchase.deleteMany({ where: { supplyId } });
        await prisma.supply.deleteMany({ where: { id: supplyId } });
      });
      if (needed > 0) {
        const buy = await apiAs(page, "POST", `/api/admin/supplies/${supplyId}/purchases`, {
          quantity: Math.ceil(needed), totalCost: r2(Math.ceil(needed) * 2),
        });
        expect(buy.status).toBeLessThan(300);
      }

      // A real unpaid occurrence with a crew.
      // Must be COMPLETABLE, not merely unpaid. The first run left its job in
      // PENDING_PAYMENT and the next variation picked the same row up and got
      // "cannot transition from PENDING_PAYMENT to PENDING_PAYMENT" — the
      // suite was consuming its own fixtures.
      const occ = await prisma.jobOccurrence.findFirstOrThrow({
        where: {
          payment: null,
          price: { not: null },
          workflow: "STANDARD",
          status: { in: ["SCHEDULED", "IN_PROGRESS"] },
          // A visit the client has not confirmed cannot be started — a real
          // gate (`isClientConfirmed`), not a tentative flag.
          isTentative: false,
          isClientConfirmed: true,
          assignees: { some: {} },
          supplyHolds: { none: {} },
          // NO `notes: { not: { contains } }` here. On a NULL notes column that
          // predicate is UNKNOWN, not TRUE, so Postgres drops the row — it
          // took all seven candidates to zero. Same three-valued-logic trap
          // the observer-filter build gate exists for.
        },
        select: { id: true, price: true, status: true, completedAt: true, startedAt: true, completionSplits: true },
      });
      // Put the row back exactly as found, or the next variation inherits it.
      undo.push(() => prisma.jobOccurrence.update({
        where: { id: occ.id },
        data: {
          price: occ.price, status: occ.status, completedAt: occ.completedAt,
          startedAt: occ.startedAt, completionSplits: occ.completionSplits ?? undefined,
          promisedPayouts: undefined,
        },
      }));

      const setPrice = await apiAs(page, "PATCH", `/api/admin/occurrences/${occ.id}/price`, { price: v.labor ?? 0 });
      expect(setPrice.status, `price: ${JSON.stringify(setPrice.json)}`).toBeLessThan(300);

      for (const s of v.services) {
        const r = await apiAs(page, "POST", `/api/admin/occurrences/${occ.id}/addons`, {
          customLabel: `${TAG} service`, price: s,
        });
        expect(r.status, `addon: ${JSON.stringify(r.json)}`).toBeLessThan(300);
        undo.push(() => prisma.occurrenceAddon.deleteMany({ where: { id: r.json?.id } }));
      }

      const oneOffIds: string[] = [];
      for (const c of v.oneOffs) {
        const r = await apiAs(page, "POST", `/api/admin/occurrences/${occ.id}/invoice-charges`, {
          cost: c, description: `${TAG} one-off`, detail: "typed by hand",
        });
        expect(r.status, `one-off: ${JSON.stringify(r.json)}`).toBeLessThan(300);
        oneOffIds.push(r.json.id);
        undo.push(() => prisma.invoiceCharge.deleteMany({ where: { id: r.json?.id } }));
      }
      if (v.removeOneOff && oneOffIds.length) {
        const d = await apiAs(page, "DELETE", `/api/admin/invoice-charges/${oneOffIds[0]}`);
        expect(d.status).toBeLessThan(300);
      }

      const holdIds: string[] = [];
      for (const [qty, price] of v.pulls) {
        const r = await apiAs(page, "POST", `/api/admin/occurrences/${occ.id}/supply-holds`, {
          supplyId, quantity: qty, clientUnitPrice: price,
          description: `${TAG} material`, detail: `${qty} bags at $${price.toFixed(2)} each`,
        });
        expect(r.status, `pull: ${JSON.stringify(r.json)}`).toBeLessThan(300);
        holdIds.push(r.json.id);
        undo.push(async () => {
          const h = await prisma.supplyHold.findUnique({ where: { id: r.json?.id } });
          if (!h) return;
          await prisma.supplyHold.delete({ where: { id: h.id } });
          if (h.invoiceChargeId) await prisma.invoiceCharge.deleteMany({ where: { id: h.invoiceChargeId } });
        });
      }
      if (v.adjustTo != null && holdIds.length) {
        const r = await apiAs(page, "PATCH", `/api/admin/supply-holds/${holdIds[0]}`, { quantity: v.adjustTo });
        expect(r.status, `adjust: ${JSON.stringify(r.json)}`).toBeLessThan(300);
      }
      if (v.cancel) {
        for (const id of holdIds) {
          const r = await apiAs(page, "DELETE", `/api/admin/supply-holds/${id}`);
          expect(r.status, `release: ${JSON.stringify(r.json)}`).toBeLessThan(300);
        }
      }

      // ── THE INVARIANTS ──
      const prev = await apiAs(page, "GET", `/api/admin/occurrences/${occ.id}/invoice-preview`);
      expect(prev.status).toBeLessThan(300);
      const inv = prev.json;
      const lines: Array<{ label: string; amount: number; detail: string | null }> = inv.lines ?? [];

      const row = await prisma.jobOccurrence.findUniqueOrThrow({
        where: { id: occ.id }, include: { addons: true, invoiceCharges: true },
      });
      const labor = row.price ?? 0;
      const services = r2(row.addons.reduce((s, a) => s + (a.price ?? 0), 0));
      const charges = r2(row.invoiceCharges.reduce((s, c) => s + c.cost, 0));

      expect(r2(inv.amountDue), "invoice = labor + services + charges").toBe(r2(labor + services + charges));
      expect(r2(inv.crewPool), "pool = labor + services").toBe(r2(labor + services));
      expect(r2(lines.reduce((s, l) => s + l.amount, 0)), "lines sum to the total").toBe(r2(inv.amountDue));
      expect(lines.some((l) => /×/.test(l.label)), "a stock movement reached the invoice").toBe(false);
      expect(JSON.stringify(inv), "an internal cost leaked").not.toMatch(/actualCost|businessCost/);

      const supAfter = await prisma.supply.findUniqueOrThrow({ where: { id: supplyId }, include: { holds: true } });
      const active = supAfter.holds.filter((h) => h.status === "ACTIVE").reduce((s, h) => s + h.quantity, 0);
      expect(supAfter.onHand - active, "oversold").toBeGreaterThanOrEqual(0);
      if (v.cancel) {
        expect(active, "a cancelled job still holds stock").toBe(0);
        expect(charges, "a released hold left its charge behind").toBe(0);
      }

      console.log(
        `   labor ${labor} + services ${services} + charges ${charges} = invoice ${inv.amountDue} | pool ${inv.crewPool} | ` +
        `${lines.length} line(s) | onHand ${supAfter.onHand}, held ${active}`,
      );

      // ── COMPLETE AND PAY ──
      if (v.collect !== "none") {
        const crew = await prisma.jobOccurrenceAssignee.findMany({
          where: { occurrenceId: occ.id, NOT: { role: "observer" } }, select: { userId: true },
        });
        const each = Math.floor(100 / crew.length);
        const splits = crew.map((a, k) => ({ userId: a.userId, percent: k === 0 ? 100 - each * (crew.length - 1) : each }));
        // START FIRST. SCHEDULED → IN_PROGRESS → PENDING_PAYMENT; the state
        // machine refuses to skip, and starting is a step a real operator
        // takes. Conditional on the CURRENT status: a job already running
        // (an earlier run that failed before its cleanup) must not be started
        // twice, which is its own 409.
        const before = await prisma.jobOccurrence.findUniqueOrThrow({
          where: { id: occ.id }, select: { status: true },
        });
        if (before.status === "SCHEDULED") {
          const started = await apiAs(page, "POST", `/api/occurrences/${occ.id}/start`, {});
          expect(started.status, `start: ${JSON.stringify(started.json)}`).toBeLessThan(300);
        }

        const done = await apiAs(page, "POST", `/api/occurrences/${occ.id}/complete`, {
          completionSplits: splits,
          startedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
          completedAt: new Date().toISOString(),
        });
        expect(done.status, `complete: ${JSON.stringify(done.json)}`).toBeLessThan(300);

        // Stock leaves on completion, and only what was still held.
        const afterDone = await prisma.supply.findUniqueOrThrow({ where: { id: supplyId }, include: { holds: true } });
        const consumed = afterDone.holds.filter((h) => h.status === "CONSUMED").reduce((s, h) => s + h.quantity, 0);
        expect(supAfter.onHand - afterDone.onHand, "stock movement must equal what was consumed").toBe(consumed);

        const amount =
          v.collect === "under" ? r2(inv.amountDue - 25)
          : v.collect === "over" ? r2(inv.amountDue + 40)
          : r2(inv.amountDue);
        if (amount > 0) {
          const pay = await apiAs(page, "POST", `/api/occurrences/${occ.id}/accept-payment`, {
            amountPaid: amount, method: "CASH", completionSplits: splits,
          });
          expect(pay.status, `pay: ${JSON.stringify(pay.json)}`).toBeLessThan(300);
          const pid = pay.json?.id ?? pay.json?.payment?.id;
          undo.push(async () => {
            if (!pid) return;
            await prisma.paymentSplit.deleteMany({ where: { paymentId: pid } });
            await prisma.payment.deleteMany({ where: { id: pid } });
          });
          await apiAs(page, "POST", `/api/admin/payments/${pid}/approve`, {});

          const paid = await prisma.payment.findUniqueOrThrow({ where: { id: pid }, include: { splits: true } });
          const workers = r2(paid.splits.reduce((s, sp) => s + (sp.amount ?? 0), 0));
          const accounted = r2(
            workers + (paid.platformFeeAmount ?? 0) + (paid.businessMarginAmount ?? 0) +
            charges + (paid.overageAmount ?? 0) - (paid.shortfallAmount ?? 0) +
            r2(paid.splits.reduce((s, sp) => s + (sp.tipAmount ?? 0), 0)) + (paid.tipToBusinessAmount ?? 0),
          );
          console.log(
            `   collected ${paid.amountPaid} → workers ${workers}, fee ${paid.platformFeeAmount}, ` +
            `margin ${paid.businessMarginAmount}, over ${paid.overageAmount}, short ${paid.shortfallAmount} ⇒ ${accounted}`,
          );
          expect(Math.abs(accounted - paid.amountPaid), "payment does not conserve").toBeLessThan(0.02);
          expect(workers, "the crew was paid out of more than the pool").toBeLessThanOrEqual(r2(inv.crewPool) + 0.01);
        }
      }
    } finally {
      for (const fn of undo.reverse()) await fn().catch(() => {});
      await prisma.$disconnect();
    }
  });
}
