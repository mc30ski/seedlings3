/**
 * One-off upsert for the new PAYMENT_FROM_OPTIONS setting. Mirrors the
 * seed value so the row exists in dev (and can be copy-pasted into
 * prod via the Neon UI) before the next reseed.
 *
 * Run: npx tsx scripts/upsert-payment-from-options.ts
 */
import { prisma } from "../src/db/prisma";

const VALUE = JSON.stringify([
  { label: "Chase business card" },
  { label: "Chase business checking" },
  { label: "Owner cash" },
  { label: "Owner personal card" },
  { label: "Venmo balance" },
  { label: "Zelle (bank transfer)" },
]);

const DESCRIPTION =
  "Presets for the 'Payment From' picker in the Super → Money → Ledger Add Expense dialog. Each entry is a free-form label (e.g., 'Chase business card', 'Owner cash'). Operator can still leave the field blank or pick 'Other' and type a custom value. Used for matching expense rows to bank/card statements at month-end.";

async function main() {
  await prisma.setting.upsert({
    where: { key: "PAYMENT_FROM_OPTIONS" },
    create: { key: "PAYMENT_FROM_OPTIONS", value: VALUE, description: DESCRIPTION, section: "catalogs" },
    update: { value: VALUE, description: DESCRIPTION, section: "catalogs" },
  });
  console.log("PAYMENT_FROM_OPTIONS upserted.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
