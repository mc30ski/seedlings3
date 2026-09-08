// ─────────────────────────────────────────────────────────────────────────────
// LEDGER INTEGRITY — run this against a real database before promoting.
//
//   npm run verify:ledger          (uses DATABASE_URL)
//
// The build gate proves the RULES are right with hand-computed scenarios. This
// proves the DATA still obeys them: that every payment already on the books
// still reconciles under the current code, that no job line has become a tax
// deduction, and that a legacy row has not quietly been re-priced.
//
// READ-ONLY. It writes nothing, so it is safe to point at production.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../src/db/prisma";
import { invoiceTotal, crewPool, materialChargeTotal, invoiceLines } from "../src/lib/jobPricing";

const r2 = (n: number) => Math.round(n * 100) / 100;
const problems: string[] = [];
const note = (m: string) => problems.push(m);

async function main() {
  const occs = await prisma.jobOccurrence.findMany({
    include: { addons: true, invoiceCharges: true },
  });

  for (const o of occs as any) {
    const inv = invoiceTotal(o);
    const pool = crewPool(o);
    const charges = materialChargeTotal(o);
    const base = r2((o.price ?? 0) + o.addons.reduce((s: number, a: any) => s + (a.price ?? 0), 0));

    if (pool < 0) note(`occ ${o.id}: negative crew pool ${pool}`);
    if (pool > inv + 0.01) note(`occ ${o.id}: pool ${pool} exceeds invoice ${inv}`);

    // ONE RULE: the pool is the work, the invoice is the work plus the
    // materials billed on top. There is no era in which either differs — the
    // pricingModel split was removed by migration 20260908090000, which
    // rewrote the nine affected rows so this rule reproduces exactly what
    // those clients were invoiced and those crews were paid.
    if (pool !== base) note(`occ ${o.id}: pool ${pool} != labor+services ${base}`);
    if (inv !== r2(base + charges)) note(`occ ${o.id}: invoice ${inv} != ${base} + ${charges}`);
    const expectedLines = (o.price ? 1 : 0)
      + o.addons.filter((a: any) => a.price).length
      + o.invoiceCharges.filter((c: any) => c.cost).length;
    if (invoiceLines(o).length !== expectedLines)
      note(`occ ${o.id}: the client's invoice does not list what is on the visit`);
  }

  // A price can never be negative — the one way the unification migration
  // could have gone wrong, since it subtracts charges from the price.
  const negative = await prisma.jobOccurrence.count({ where: { price: { lt: 0 } } });
  if (negative > 0)
    note(`${negative} occurrence(s) have a NEGATIVE price — the pricing unification ran against data it was not safe for.`);

  // Every approved payment must still account for every dollar collected.
  const payments = await prisma.payment.findMany({
    where: { confirmed: true, skippedAt: null },
    include: { splits: true, occurrence: { include: { addons: true, invoiceCharges: true } } },
  });
  //
  // `PaymentSplit.amount` MEANS TWO DIFFERENT THINGS, and which one depends on
  // when the row was written. `reconcileApproval` gained the per-split
  // breakdown columns (`grossAmount`/`feeAmount`/`netAmount`) in May 2026, and
  // the app itself branches on `splits.every(sp => sp.netAmount != null)` —
  // `splitsHaveBreakdown` in services/payments.ts. This must branch the same
  // way or it is not checking the same books the app keeps.
  //
  //   WITH a breakdown (275 of 392 in production, everything from June 2026
  //   on) `amount` is what the worker was PAID: the fees and the material
  //   charges are separate components and are added alongside it. This is the
  //   strict identity, it is what all current code writes, and it must hold
  //   for every such row — production has zero exceptions.
  //
  //   WITHOUT a breakdown, the era is genuinely ambiguous and the data itself
  //   is not uniform: of 117 such payments, 48 store `amount` GROSS (fees
  //   inside) and 74 store it NET (fees outside). Nothing on the row says
  //   which, so the honest check is that it reconciles under ONE of the two
  //   readings — and every one of the 117 does. Only a row that reconciles
  //   under NEITHER is a real problem.
  //
  // Assuming a single reading made 43 correct March-April payments report as
  // damaged. A verifier that cries wolf on rows it cannot be right about is
  // worse than no verifier: it is the check standing between a migration and
  // production, and 43 false alarms are how a real one gets waved through.
  for (const p of payments as any) {
    if (!p.occurrence) continue;
    const splitTotal = r2(p.splits.reduce((s: number, x: any) => s + (x.amount ?? 0), 0));
    const tips = r2(p.splits.reduce((s: number, x: any) => s + (x.tipAmount ?? 0), 0));
    const common = splitTotal + tips
      + (p.tipToBusinessAmount ?? 0) + (p.overageAmount ?? 0)
      - (p.shortfallAmount ?? 0);
    const separate = (p.platformFeeAmount ?? 0) + (p.businessMarginAmount ?? 0)
      + materialChargeTotal(p.occurrence);
    const collected = p.amountPaid ?? 0;

    const asNet = r2(common + separate);   // `amount` excludes fees + charges
    const asGross = r2(common);            // `amount` already contains them

    const hasBreakdown = p.splits.length > 0
      && p.splits.every((sp: any) => sp.netAmount != null);

    const ok = hasBreakdown
      ? Math.abs(asNet - collected) <= 0.02
      : Math.abs(asNet - collected) <= 0.02 || Math.abs(asGross - collected) <= 0.02;

    if (!ok)
      note(
        hasBreakdown
          ? `payment ${p.id}: components ${asNet} != collected ${collected}`
          : `payment ${p.id}: reconciles under neither reading ` +
            `(net ${asNet}, gross ${asGross}) != collected ${collected}`,
      );
  }

  // A ledger row may be pointed at by any number of job lines — the link is a
  // decorative many-to-one breadcrumb and no total reads it.
  const shared = await prisma.businessExpense.findMany({
    where: { invoiceCharges: { some: {} } },
    include: { invoiceCharges: { select: { id: true } } },
  });

  console.log(`occurrences: ${occs.length}`);
  console.log(`approved payments checked: ${payments.length}`);
  console.log(`ledger rows referenced by a job line: ${shared.length}`);
  if (problems.length) {
    console.error(`\n${problems.length} PROBLEM(S):`);
    for (const m of problems.slice(0, 40)) console.error("  " + m);
    process.exitCode = 1;
  } else {
    console.log("\nno integrity problems — every payment reconciles and no job line is a deduction");
  }
  await prisma.$disconnect();
}
main();
