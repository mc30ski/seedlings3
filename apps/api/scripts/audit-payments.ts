// One-off audit: walk every Payment row in the DB and print its key
// reconciliation values + per-split breakdown. Used to diagnose why a
// summary line doesn't decompose against (margin + overage − shortfall).
// Usage: cd apps/api && npx tsx scripts/audit-payments.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const dollar = (n: number | null | undefined) =>
  n == null ? "(null)" : `$${n.toFixed(2)}`;

async function main() {
  const payments = await prisma.payment.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      occurrence: {
        select: {
          id: true,
          price: true,
          completionSplits: true,
          promisedPayouts: true,
          job: { select: { property: { select: { displayName: true, client: { select: { displayName: true } } } } } },
          expenses: { select: { cost: true } },
          assignees: { select: { userId: true, role: true, user: { select: { displayName: true, workerType: true } } } },
        },
      },
      splits: { include: { user: { select: { displayName: true, workerType: true } } } },
    },
  });

  console.log(`Found ${payments.length} Payment row(s).\n`);

  let totals = {
    amountPaid: 0,
    workerPayouts: 0,
    expenses: 0,
    revenue: 0,
    margin: 0,
    fee: 0,
    overage: 0,
    shortfall: 0,
  };

  for (const p of payments) {
    const client = p.occurrence?.job?.property?.client?.displayName ?? "(no client)";
    const property = p.occurrence?.job?.property?.displayName ?? "(no property)";
    const price = p.occurrence?.price ?? 0;
    const expenses = (p.occurrence?.expenses ?? []).reduce((s, e) => s + (e.cost ?? 0), 0);
    const workerPayouts = p.splits.reduce((s, sp) => s + sp.amount, 0);
    const revContribution = (p.amountPaid ?? 0) - workerPayouts - expenses;

    console.log("──────────────────────────────────────────────────────────────");
    console.log(`Payment ${p.id.slice(-8)} — ${client} / ${property}`);
    console.log(`  invoice price:           ${dollar(price)}`);
    console.log(`  amountPaid:              ${dollar(p.amountPaid)}`);
    console.log(`  confirmed:               ${p.confirmed}`);
    console.log(`  writtenOff:              ${p.writtenOff}`);
    console.log(`  adjustedFromAmount:      ${dollar(p.adjustedFromAmount)}`);
    console.log(`  platformFeePercent:      ${p.platformFeePercent ?? "(null)"}`);
    console.log(`  platformFeeAmount:       ${dollar(p.platformFeeAmount)}`);
    console.log(`  businessMarginPercent:   ${p.businessMarginPercent ?? "(null)"}`);
    console.log(`  businessMarginAmount:    ${dollar(p.businessMarginAmount)}`);
    console.log(`  overageAmount:           ${dollar(p.overageAmount)}`);
    console.log(`  shortfallAmount:         ${dollar(p.shortfallAmount)}`);
    console.log(`  expenses on occurrence:  ${dollar(expenses)}`);
    console.log(`  worker payouts (sum):    ${dollar(workerPayouts)}`);
    console.log(`  revenue contribution:    ${dollar(revContribution)}  (= amountPaid − payouts − expenses)`);

    // Verify identity: revContribution should equal (margin + fee + overage − shortfall)
    const decomposed = (p.businessMarginAmount ?? 0) + (p.platformFeeAmount ?? 0) + (p.overageAmount ?? 0) - (p.shortfallAmount ?? 0);
    const drift = Math.round((revContribution - decomposed) * 100) / 100;
    if (Math.abs(drift) >= 0.01) {
      console.log(`  ⚠️  IDENTITY DRIFT:    ${dollar(decomposed)} (decomposed) vs ${dollar(revContribution)} (actual). Off by ${dollar(drift)}`);
    } else {
      console.log(`  ✓ identity holds:        decomposes to ${dollar(decomposed)}`);
    }

    console.log(`  splits:`);
    for (const sp of p.splits) {
      console.log(`    - ${sp.user.displayName ?? sp.userId} (${sp.user.workerType ?? "null"}): amount=${dollar(sp.amount)} | gross=${dollar(sp.grossAmount)} rate=${sp.ratePercent ?? "(null)"}% fee=${dollar(sp.feeAmount)} net=${dollar(sp.netAmount)} topUp=${dollar(sp.topUpAmount)}`);
    }
    const cs = p.occurrence?.completionSplits as Array<{ userId: string; percent: number }> | null;
    if (Array.isArray(cs) && cs.length > 0) {
      console.log(`  completionSplits:        ${cs.map((s) => `${s.userId.slice(-6)}=${s.percent}%`).join(", ")}`);
    } else {
      console.log(`  completionSplits:        (none)`);
    }
    const pp = p.occurrence?.promisedPayouts as Array<{ userId: string; workerType: string | null; gross: number; fee: number; net: number }> | null;
    if (Array.isArray(pp) && pp.length > 0) {
      console.log(`  promisedPayouts:`);
      for (const row of pp) {
        console.log(`    - ${row.userId.slice(-6)} (${row.workerType ?? "null"}): gross=${dollar(row.gross)} fee=${dollar(row.fee)} net=${dollar(row.net)}`);
      }
    } else {
      console.log(`  promisedPayouts:         (none — legacy / pre-snapshot)`);
    }

    totals.amountPaid += p.amountPaid ?? 0;
    totals.workerPayouts += workerPayouts;
    totals.expenses += expenses;
    totals.revenue += revContribution;
    totals.margin += p.businessMarginAmount ?? 0;
    totals.fee += p.platformFeeAmount ?? 0;
    totals.overage += p.overageAmount ?? 0;
    totals.shortfall += p.shortfallAmount ?? 0;
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("AGGREGATE TOTALS");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Total amountPaid:         ${dollar(totals.amountPaid)}`);
  console.log(`  Total worker payouts:     ${dollar(totals.workerPayouts)}`);
  console.log(`  Total expenses:           ${dollar(totals.expenses)}`);
  console.log(`  Total Revenue:            ${dollar(totals.revenue)}  (= paid − payouts − expenses)`);
  console.log(`  Total business margin:    ${dollar(totals.margin)}`);
  console.log(`  Total platform fees:      ${dollar(totals.fee)}`);
  console.log(`  Total overage:            ${dollar(totals.overage)}`);
  console.log(`  Total shortfall:          ${dollar(totals.shortfall)}`);
  const decomposed = totals.margin + totals.fee + totals.overage - totals.shortfall;
  const drift = Math.round((totals.revenue - decomposed) * 100) / 100;
  console.log(`  Decomposed (m+f+o−sf):    ${dollar(decomposed)}`);
  if (Math.abs(drift) >= 0.01) {
    console.log(`  ⚠️  DRIFT: Total Revenue differs from decomposition by ${dollar(drift)}`);
  } else {
    console.log(`  ✓ Aggregate identity holds.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
