// One-off: add the `plSection` field to every row in the live
// EXPENSE_CATEGORIES setting. Idempotent — running it again on a fully
// migrated taxonomy is a no-op.
//
// Why this script exists:
//   The EXPENSE_CATEGORIES JSON taxonomy in the live DB predates the
//   plSection field. The validator + loader default missing values to
//   EXCLUDE_FROM_PNL at read time — categories without plSection vanish
//   from the P&L Report until they're explicitly classified. Running this
//   script seeds reasonable defaults for the standard seed categories so
//   the P&L works out of the box.
//
// What this script does:
//   • Reads the current EXPENSE_CATEGORIES JSON value
//   • Walks each row; if plSection is missing or invalid, assigns it:
//       - "COGS" for "Supplies"
//       - "OPERATING_EXPENSE" for every other category WITH a non-null
//         qbAccount (these are actively mapped → should appear on P&L)
//       - "EXCLUDE_FROM_PNL" for categories with qbAccount = null (these
//         are placeholders the operator hasn't fully set up yet)
//   • Preserves every other field (label, scheduleCLine, qbAccount,
//     selectable) verbatim — never overwrites qbAccount values the
//     operator has tuned via Settings UI / direct Neon edits
//   • Writes the updated JSON back to the same setting
//
// Usage (dev):
//   cd apps/api && npx tsx scripts/add-plsection-to-expense-categories.ts
//
// For prod: same command pointed at the prod DATABASE_URL, OR copy the
// dev-side JSON value into the prod setting via Neon's SQL Editor — the
// JSON shape is identical post-migration.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Categories that roll into Cost of Goods Sold on the P&L. Everything else
// with a non-null qbAccount becomes Operating Expense; categories with a
// null qbAccount become EXCLUDE_FROM_PNL (they're placeholders the operator
// hasn't fully set up yet and shouldn't pollute the report). Keep COGS_LABELS
// in sync with the seed file's plSection assignments.
const COGS_LABELS = new Set<string>([
  "Supplies",
]);

const VALID_SECTIONS = new Set(["COGS", "OPERATING_EXPENSE", "EXCLUDE_FROM_PNL"]);

async function main() {
  const row = await prisma.setting.findUnique({
    where: { key: "EXPENSE_CATEGORIES" },
  });
  if (!row) {
    console.error("EXPENSE_CATEGORIES setting not found — nothing to migrate.");
    process.exit(1);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(row.value);
  } catch (e) {
    console.error("EXPENSE_CATEGORIES is not valid JSON:", e);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error("EXPENSE_CATEGORIES must be a JSON array; found:", typeof parsed);
    process.exit(1);
  }

  let changed = 0;
  const updated = parsed.map((r: any) => {
    if (!r || typeof r !== "object") return r;
    const existing = typeof r.plSection === "string" ? r.plSection : undefined;
    if (existing && VALID_SECTIONS.has(existing)) {
      return r; // already migrated for this row
    }
    const label = typeof r.label === "string" ? r.label : "";
    const hasQbAccount = typeof r.qbAccount === "string" && r.qbAccount.trim() !== "";
    let plSection: string;
    if (COGS_LABELS.has(label)) {
      plSection = "COGS";
    } else if (hasQbAccount) {
      plSection = "OPERATING_EXPENSE";
    } else {
      // No QB account routing → assume the category isn't actively used.
      // Operator can flip to OPERATING_EXPENSE in Settings if they decide
      // to track it on the P&L later.
      plSection = "EXCLUDE_FROM_PNL";
    }
    changed += 1;
    return { ...r, plSection };
  });

  if (changed === 0) {
    console.log("All rows already have a valid plSection — no changes needed.");
    return;
  }

  const value = JSON.stringify(updated);
  await prisma.setting.update({
    where: { key: "EXPENSE_CATEGORIES" },
    data: { value },
  });

  console.log(`Updated ${changed} row${changed === 1 ? "" : "s"} with plSection.`);
  console.log("New value:");
  console.log(value);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
