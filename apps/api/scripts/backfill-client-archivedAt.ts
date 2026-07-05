// One-off backfill: populate `Client.archivedAt` on rows that were
// archived through `Client.archive` before the fix landed. The historical
// bug: `Client.archive` set `status = ARCHIVED` but never populated
// `archivedAt` (the field was declared as TODO). The duplicate-clients
// audit at admin.ts:3887 filters `archivedAt: null`, so it silently
// classified every archived Client as active — leading to false-positive
// duplicate flags in the operator dashboard.
//
// Safe to run any time; idempotent. Only touches rows where
// `status = 'ARCHIVED' AND archivedAt IS NULL`. Uses `updatedAt` as the
// timestamp (the least-lossy signal we have for "when was this archived"
// — the audit log carries the true event but denormalizing helps every
// downstream query stay simple).
//
// Usage:
//   npx tsx scripts/backfill-client-archivedAt.ts          # dry-run
//   npx tsx scripts/backfill-client-archivedAt.ts --apply  # write

import { prisma } from "../src/db/prisma";

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.client.findMany({
    where: { status: "ARCHIVED", archivedAt: null },
    select: { id: true, displayName: true, updatedAt: true },
    orderBy: { updatedAt: "asc" },
  });

  if (rows.length === 0) {
    console.log("No Clients need backfill — every ARCHIVED row already has archivedAt set.");
    return;
  }

  console.log(`Found ${rows.length} archived Client(s) missing archivedAt:`);
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(30)}  ${r.updatedAt.toISOString()}  ${r.displayName}`);
  }

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to write.");
    return;
  }

  // One UPDATE per row so the audit-log query at admin.ts:3887 sees the
  // right timestamp per row. Batch update via updateMany would set them
  // all to `now()` which would misrepresent history.
  let updated = 0;
  for (const r of rows) {
    await prisma.client.update({
      where: { id: r.id },
      data: { archivedAt: r.updatedAt },
    });
    updated++;
  }
  console.log(`\nBackfilled ${updated} row(s). archivedAt now equals updatedAt on each.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
