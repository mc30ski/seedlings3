// One-off — print the paymentRequestToken for any outstanding-invoice
// occurrence in the dev DB so you can hit /pay/{token} in the browser
// to test the Zelle modal end to end.

import { prisma } from "../src/db/prisma";

async function main() {
  const occs = await prisma.jobOccurrence.findMany({
    where: {
      status: "PENDING_PAYMENT" as any,
      paymentRequestToken: { not: null },
      payment: { is: null },
    },
    select: {
      id: true,
      paymentRequestToken: true,
      price: true,
      notes: true,
      job: {
        select: {
          property: { select: { displayName: true, client: { select: { displayName: true } } } },
        },
      },
    },
    take: 5,
    orderBy: { startAt: "desc" },
  });

  if (occs.length === 0) {
    console.log("No outstanding-invoice occurrences found. Reseed with `npx prisma db seed`.");
    return;
  }

  console.log("\nOpen any of these in your browser:\n");
  for (const o of occs) {
    const client = o.job?.property?.client?.displayName ?? "?";
    const prop = o.job?.property?.displayName ?? "?";
    console.log(`  http://localhost:3000/pay/${o.paymentRequestToken}`);
    console.log(`    ${client} · ${prop} · $${o.price ?? "?"} · ${o.notes ?? "(no notes)"}\n`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
