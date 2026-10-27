/**
 * Report migrations that FAILED on a previous run and are still blocking.
 *
 * READ-ONLY. It prints; it never resolves anything. Clearing a failure is a
 * decision, and `script.db.prod.sh` asks for it explicitly.
 *
 * WHY THIS EXISTS. `prisma migrate status` does not mention a failed
 * migration at all — it lists it under "not yet applied", exactly like one
 * that has never been attempted. So the operator sees a normal-looking
 * pending list, runs deploy, and gets P3018 with no warning that the
 * database was already wedged. This closes that gap: the promote script
 * asks here first and shows the real error before anything runs.
 *
 * A FAILED ROW IS NOT A PARTIAL WRITE. Postgres rolls a failing migration's
 * transaction back whole, so nothing from it is in the database. What
 * remains is the ledger row saying it was attempted, which is what refuses
 * every later migration until it is resolved.
 *
 *   npx tsx scripts/failed-migrations.ts          # human
 *   npx tsx scripts/failed-migrations.ts --porcelain
 *
 * `--porcelain` emits one tab-separated record per failure for the shell:
 *     name <TAB> first line of the database error
 * and exits 0 whether or not any were found — "none" is an answer, not an
 * error. Exit 2 means it could not tell (no connection), which a caller
 * must not read as "all clear".
 */
import { PrismaClient } from "@prisma/client";

type Row = { migration_name: string; logs: string | null; started_at: Date | null };

(async () => {
  const porcelain = process.argv.includes("--porcelain");
  const prisma = new PrismaClient();
  try {
    // started but never finished, and not already resolved as rolled back.
    const rows = await prisma.$queryRawUnsafe<Row[]>(`
      SELECT migration_name, logs, started_at
        FROM "_prisma_migrations"
       WHERE finished_at IS NULL
         AND rolled_back_at IS NULL
       ORDER BY started_at`);

    if (porcelain) {
      for (const r of rows) {
        // PREFER THE DATABASE'S OWN `ERROR:` LINE. Prisma's log begins with
        // a generic preamble ("A migration failed to apply...") that is the
        // same for every failure and says nothing about the cause; taking
        // the first non-empty line therefore printed boilerplate where the
        // operator needed the reason. Fall back only if there is no ERROR:.
        const lines = (r.logs ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
        const first =
          lines.find((l) => l.startsWith("ERROR:")) ??
          lines.find((l) => !l.startsWith("A migration failed") && !l.startsWith("Migration name:") && !l.startsWith("Database error")) ??
          lines[0] ?? "(no error recorded)";
        process.stdout.write(`${r.migration_name}\t${first.replace(/\t/g, " ")}\n`);
      }
      process.exit(0);
    }

    if (rows.length === 0) {
      console.log("No failed migrations. The ledger is clean.");
      process.exit(0);
    }
    console.log(`${rows.length} migration(s) failed on a previous run and are blocking:\n`);
    for (const r of rows) {
      console.log(`  ${r.migration_name}`);
      console.log(`    attempted: ${r.started_at?.toISOString() ?? "unknown"}`);
      for (const l of (r.logs ?? "(no error recorded)").split("\n").slice(0, 8)) {
        if (l.trim()) console.log(`    ${l.trim()}`);
      }
      console.log("");
    }
    process.exit(0);
  } catch (err) {
    // NOT exit 1: a caller distinguishing "none found" from "could not look"
    // needs them to differ, and treating a connection failure as "clean"
    // would wave a wedged database through.
    console.error(`Could not read the migration ledger: ${(err as Error).message}`);
    process.exit(2);
  } finally {
    await prisma.$disconnect();
  }
})();
