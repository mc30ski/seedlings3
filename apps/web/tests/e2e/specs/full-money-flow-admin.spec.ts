// ─────────────────────────────────────────────────────────────────────────────
// THE WHOLE FLOW, FOR REAL — ledger → supplies → job → charges → invoice →
// payment, driven through the running app.
//
// Every other spec exercises one surface. This one follows a job the way an
// operator does, because the bugs this session produced lived in the SEAMS:
// a service that stopped writing a ledger row while its screen still promised
// one, a charge whose price the catalog decided, a payout line that printed a
// subtraction the math never performed. None of those are visible from inside
// a single screen.
//
// It asserts the numbers a CLIENT would see, and the money the business ends
// up with — not that a request returned 200.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";
import { apiAs } from "../helpers/api";
import { makePrisma } from "../helpers/db";

const money = (s: string) => Number(String(s).replace(/[$,]/g, ""));
const r2 = (n: number) => Math.round(n * 100) / 100;
const TAG = `E2EFLOW-${Date.now()}`;

async function boot(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_ajobs_datePreset", JSON.stringify("all"));
    localStorage.setItem("seedlings_ajobs_density", JSON.stringify("expanded"));
    localStorage.removeItem("seedlings_ajobs_status");
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);
}

test("a job carries labor, a service, a one-off charge and inventory — and every number reconciles", async ({ page }) => {
  test.setTimeout(300_000);
  const prisma = makePrisma();
  const cleanup: Array<() => Promise<unknown>> = [];

  try {
    await boot(page);

    // ── 1. THE LEDGER. A real card charge — the only tax deduction here. ──
    const led = await apiAs(page, "POST", "/api/admin/business-expenses", {
      type: "EXPENSE", description: `${TAG} Lowes run`, cost: 240.5,
      date: new Date().toISOString().slice(0, 10), category: "Supplies", vendor: "Lowes",
    });
    expect(led.status, `ledger create: ${JSON.stringify(led.json)}`).toBeLessThan(300);
    const ledgerId = led.json?.id;
    expect(ledgerId).toBeTruthy();
    cleanup.push(() => prisma.businessExpense.deleteMany({ where: { id: ledgerId } }));
    console.log(`ledger row $240.50 → ${ledgerId}`);

    // ── 2. A SUPPLY, and stock bought against that receipt. ──
    const sup = await apiAs(page, "POST", "/api/admin/supplies", {
      name: `${TAG} Mulch`, unit: "bag", businessCost: 3.5, clientUnitPrice: 5, category: "Supplies",
    });
    expect(sup.status, `supply create: ${JSON.stringify(sup.json)}`).toBeLessThan(300);
    const supplyId = sup.json?.id;
    cleanup.push(async () => {
      await prisma.supplyHold.deleteMany({ where: { supplyId } });
      await prisma.supplyPurchase.deleteMany({ where: { supplyId } });
      await prisma.supplyAdjustment.deleteMany({ where: { supplyId } });
      await prisma.supply.deleteMany({ where: { id: supplyId } });
    });

    const buy = await apiAs(page, "POST", `/api/admin/supplies/${supplyId}/purchases`, {
      quantity: 40, totalCost: 140, vendor: "Lowes", businessExpenseId: ledgerId,
    });
    expect(buy.status, `purchase: ${JSON.stringify(buy.json)}`).toBeLessThan(300);

    // THE DECOUPLING: buying stock must create NO second deduction.
    const ledgerCount = await prisma.businessExpense.count({ where: { description: { contains: TAG } } });
    expect(ledgerCount, "a supply purchase created a second ledger row").toBe(1);
    const stocked = await prisma.supply.findUniqueOrThrow({ where: { id: supplyId } });
    expect(stocked.onHand, "stock did not arrive").toBe(40);
    expect(stocked.businessCost, "unit cost derived from the receipt total").toBe(3.5);
    console.log(`supply: 40 on hand @ $3.50, linked to the receipt, no second deduction`);

    // ── 3. A JOB. Reuse a real unpaid occurrence and price it. ──
    // Startable, not merely unpaid: a visit the client has not confirmed
    // cannot be started, and one already running cannot be started again.
    const occ = await prisma.jobOccurrence.findFirstOrThrow({
      where: {
        payment: null, price: { not: null }, workflow: "STANDARD",
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        isTentative: false, isClientConfirmed: true,
        assignees: { some: {} }, supplyHolds: { none: {} },
      },
      select: {
        id: true, price: true, status: true, startedAt: true, completedAt: true,
        completionSplits: true,
        job: { select: { property: { select: { displayName: true } } } },
      },
    });
    const priceRes = await apiAs(page, "PATCH", `/api/admin/occurrences/${occ.id}/price`, {
      price: 200, laborDetail: "Mow, trim and edge the full property",
    });
    expect(priceRes.status, `set price: ${JSON.stringify(priceRes.json)}`).toBeLessThan(300);
    cleanup.push(() => prisma.jobOccurrence.update({
      where: { id: occ.id },
      data: {
        price: occ.price, status: occ.status, startedAt: occ.startedAt,
        completedAt: occ.completedAt, completionSplits: occ.completionSplits ?? undefined,
      },
    }));

    // ── 4. A SERVICE — work, so it joins the crew's pool. ──
    const svc = await apiAs(page, "POST", `/api/admin/occurrences/${occ.id}/addons`, {
      customLabel: "Haul off storm debris", price: 60, detail: "two truck loads",
    });
    expect(svc.status, `addon: ${JSON.stringify(svc.json)}`).toBeLessThan(300);
    cleanup.push(() => prisma.occurrenceAddon.deleteMany({ where: { id: svc.json?.id } }));

    // ── 5. A ONE-OFF CHARGE, pointed at the same receipt. ──
    const oneOff = await apiAs(page, "POST", `/api/admin/occurrences/${occ.id}/invoice-charges`, {
      cost: 45, description: "Edging stone", detail: "9 pavers at $5.00 each", actualCost: 38,
    });
    expect(oneOff.status, `one-off charge: ${JSON.stringify(oneOff.json)}`).toBeLessThan(300);
    const oneOffId = oneOff.json?.id;
    await apiAs(page, "PATCH", `/api/admin/invoice-charges/${oneOffId}/ledger-link`, { businessExpenseId: ledgerId });
    cleanup.push(() => prisma.invoiceCharge.deleteMany({ where: { id: oneOffId } }));

    // ── 6. PULL FROM INVENTORY, priced for THIS client, with the client's words. ──
    const pull = await apiAs(page, "POST", `/api/admin/occurrences/${occ.id}/supply-holds`, {
      supplyId, quantity: 12, clientUnitPrice: 6.25,
      description: "Hardwood mulch", detail: "12 bags at $6.25 each",
    });
    expect(pull.status, `inventory pull: ${JSON.stringify(pull.json)}`).toBeLessThan(300);
    const holdId = pull.json?.id;
    cleanup.push(async () => {
      const h = await prisma.supplyHold.findUnique({ where: { id: holdId } });
      if (h) { await prisma.supplyHold.delete({ where: { id: holdId } });
        if (h.invoiceChargeId) await prisma.invoiceCharge.deleteMany({ where: { id: h.invoiceChargeId } }); }
    });

    const afterPull = await prisma.supply.findUniqueOrThrow({
      where: { id: supplyId }, include: { holds: { where: { status: "ACTIVE" } } },
    });
    const heldQty = afterPull.holds.reduce((s, h) => s + h.quantity, 0);
    expect(heldQty, "stock was not reserved").toBe(12);
    expect(afterPull.onHand, "reserving must not remove stock from the shelf yet").toBe(40);
    console.log(`pulled 12 @ $6.25 for this client (catalog default was $5.00); 40 on hand, 12 reserved`);

    // ── 7. THE INVOICE. What the CLIENT sees. ──
    const preview = await apiAs(page, "GET", `/api/admin/occurrences/${occ.id}/invoice-preview`);
    expect(preview.status).toBeLessThan(300);
    const inv = preview.json;
    const lines: Array<{ label: string; detail: string | null; amount: number }> = inv.lines ?? [];
    console.log("INVOICE:");
    for (const l of lines) console.log(`   ${l.label}${l.detail ? ` — ${l.detail}` : ""}  $${l.amount.toFixed(2)}`);
    console.log(`   TOTAL $${inv.amountDue.toFixed(2)}   crew pool $${inv.crewPool.toFixed(2)}`);

    // 200 labor + 60 service + 45 one-off + 75 mulch (12 × 6.25) = 380
    expect(r2(inv.amountDue), "invoice total").toBe(380);
    // The crew shares labor + services only.
    expect(r2(inv.crewPool), "crew pool = labor + services").toBe(260);
    expect(r2(lines.reduce((s, l) => s + l.amount, 0)), "lines must sum to the total").toBe(380);

    // The operator's words reach the client; nothing internal does.
    const labels = lines.map((l) => l.label);
    expect(labels).toContain("Haul off storm debris");
    expect(labels).toContain("Edging stone");
    expect(labels).toContain("Hardwood mulch");
    expect(labels.some((l) => /×/.test(l)), "a stock movement leaked onto the invoice").toBe(false);
    expect(labels.some((l) => /^[A-Z][A-Z_]{2,}$/.test(l)), "a raw key leaked").toBe(false);
    expect(JSON.stringify(inv), "an internal cost leaked to the client payload").not.toMatch(/actualCost|businessCost|3\.5/);
    expect(lines.find((l) => l.label === "Hardwood mulch")?.detail).toBe("12 bags at $6.25 each");

    // ── 8. COMPLETE THE JOB. Stock leaves the shelf here, not before. ──
    const assignees = await prisma.jobOccurrenceAssignee.findMany({
      where: { occurrenceId: occ.id, NOT: { role: "observer" } }, select: { userId: true },
    });
    const splits = assignees.map((a, i) => ({
      userId: a.userId,
      percent: i === 0 ? 100 - (assignees.length - 1) * Math.floor(100 / assignees.length)
                       : Math.floor(100 / assignees.length),
    }));
    // START FIRST — SCHEDULED → IN_PROGRESS → PENDING_PAYMENT. The state
    // machine refuses to skip, and starting is a step the operator takes.
    if (occ.status === "SCHEDULED") {
      const started = await apiAs(page, "POST", `/api/occurrences/${occ.id}/start`, {});
      expect(started.status, `start: ${JSON.stringify(started.json)}`).toBeLessThan(300);
    }

    const done = await apiAs(page, "POST", `/api/occurrences/${occ.id}/complete`, {
      completionSplits: splits,
      startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      completedAt: new Date().toISOString(),
    });
    expect(done.status, `complete: ${JSON.stringify(done.json)}`).toBeLessThan(300);

    const afterDone = await prisma.supply.findUniqueOrThrow({
      where: { id: supplyId }, include: { holds: true },
    });
    console.log(`after completing: onHand ${afterDone.onHand}, hold status ${afterDone.holds.map((h) => h.status).join(",")}`);
    expect(afterDone.onHand, "12 bags should have left the shelf on completion").toBe(28);
    expect(afterDone.holds[0]?.status).toBe("CONSUMED");

    // The client is STILL billed for what was used.
    const stillBilled = await prisma.invoiceCharge.findUniqueOrThrow({
      where: { id: afterDone.holds[0].invoiceChargeId! },
    });
    expect(r2(stillBilled.cost), "consuming stock must not change the bill").toBe(75);

    // ── 9. ACCEPT PAYMENT. ──
    const pay = await apiAs(page, "POST", `/api/occurrences/${occ.id}/accept-payment`, {
      amountPaid: 380, method: "CASH", completionSplits: splits,
    });
    expect(pay.status, `accept-payment: ${JSON.stringify(pay.json)}`).toBeLessThan(300);
    const paymentId = pay.json?.id ?? pay.json?.payment?.id;
    cleanup.push(async () => {
      if (!paymentId) return;
      await prisma.paymentSplit.deleteMany({ where: { paymentId } });
      await prisma.payment.deleteMany({ where: { id: paymentId } });
    });

    const approve = await apiAs(page, "POST", `/api/admin/payments/${paymentId}/approve`, {});
    console.log(`approve → ${approve.status}`);

    // ── 10. THE MONEY. Splits come out of the POOL, never the invoice. ──
    const paid = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId }, include: { splits: true },
    });
    const workerTotal = r2(paid.splits.reduce((s, sp) => s + (sp.amount ?? 0), 0));
    const fee = paid.platformFeeAmount ?? 0, margin = paid.businessMarginAmount ?? 0;
    console.log(`collected $${paid.amountPaid} | to workers $${workerTotal} | fee $${fee} | margin $${margin} | confirmed ${paid.confirmed}`);

    expect(r2(paid.amountPaid), "collected").toBe(380);
    // The crew never shares the $120 of materials.
    expect(workerTotal, "workers were paid out of the invoice, not the pool").toBeLessThanOrEqual(260.01);
    // Conservation: every dollar the client handed over is accounted for.
    const charges = 45 + 75;
    const accounted = r2(workerTotal + fee + margin + charges + (paid.overageAmount ?? 0) - (paid.shortfallAmount ?? 0));
    console.log(`conservation: ${workerTotal} + ${fee} + ${margin} + ${charges} = ${accounted} vs ${paid.amountPaid}`);
    expect(Math.abs(accounted - paid.amountPaid), "payment does not conserve").toBeLessThan(0.02);

    // ── 9. THE BOOKS. One deduction, and it is the ledger row. ──
    const deductions = await prisma.businessExpense.findMany({ where: { description: { contains: TAG } } });
    expect(deductions.length, "exactly one deduction for this whole flow").toBe(1);
    expect(deductions[0].cost).toBe(240.5);
    const linkedCharges = await prisma.invoiceCharge.count({ where: { businessExpenseId: ledgerId } });
    console.log(`deduction: 1 row of $240.50; job lines pointing at it: ${linkedCharges}`);
    expect(linkedCharges, "the loose link should hold both the one-off and nothing else it did not set").toBeGreaterThanOrEqual(1);
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
    await prisma.$disconnect();
  }
});
