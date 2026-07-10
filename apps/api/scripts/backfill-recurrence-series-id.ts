// One-off backfill: give every existing recurring BusinessExpense row a
// shared `recurrenceSeriesId` grouped by the legacy implicit key —
// (type, trimmed+lowercased description, trimmed+lowercased vendor).
//
// After this runs, all rows that USED to collide on the implicit key
// share an explicit series id. From then on, the /admin/business-expenses
// create route mints a fresh id on new-from-scratch inserts and copies
// the source's id when a Record-flow insert names a `sourceExpenseId`.
//
// Idempotent: skips rows that already have a `recurrenceSeriesId`.
// Safe to re-run.
//
// Usage:
//   cd apps/api && npx tsx scripts/backfill-recurrence-series-id.ts --dry-run
//   cd apps/api && npx tsx scripts/backfill-recurrence-series-id.ts --confirm
//
// Dry-run prints how many groups and rows would be affected. Confirm
// actually writes.

import { prisma } from "../src/db/prisma";
import { randomUUID } from "crypto";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");
  if (!dryRun && !confirm) {
    console.error("Refusing to run without --dry-run or --confirm. Start with --dry-run.");
    process.exit(2);
  }

  // Load every row with a recurrence set and no series id yet. A
  // one-off (recurrence: null) doesn't need a series id.
  const rows = await prisma.businessExpense.findMany({
    where: {
      recurrence: { not: null },
      recurrenceSeriesId: null,
    },
    select: {
      id: true,
      type: true,
      description: true,
      vendor: true,
    },
  });

  console.log(`Found ${rows.length} recurring row(s) without a series id.`);
  if (rows.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  // Group by the legacy implicit key. Every group gets a fresh UUID.
  // Trim + lowercase mirrors what the /due-soon endpoint currently does
  // so the backfilled groups match the buckets the operator has been
  // seeing in the "Due to record" panel.
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.type}::${(r.description || "").trim().toLowerCase()}::${(r.vendor || "").trim().toLowerCase()}`;
    const arr = groups.get(key) ?? [];
    arr.push(r.id);
    groups.set(key, arr);
  }

  console.log(`→ ${groups.size} distinct series will be created.`);
  if (dryRun) {
    let sample = 0;
    for (const [key, ids] of groups) {
      if (sample++ >= 10) break;
      console.log(`  ${ids.length.toString().padStart(3)} row(s) → key ${key.slice(0, 60)}${key.length > 60 ? "…" : ""}`);
    }
    if (groups.size > 10) {
      console.log(`  … and ${groups.size - 10} more series.`);
    }
    console.log("\n[dry-run] No writes performed.");
    return;
  }

  let updated = 0;
  for (const ids of groups.values()) {
    const seriesId = randomUUID();
    const res = await prisma.businessExpense.updateMany({
      where: { id: { in: ids } },
      data: { recurrenceSeriesId: seriesId },
    });
    updated += res.count;
  }
  console.log(`Wrote ${groups.size} series id(s) across ${updated} row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
