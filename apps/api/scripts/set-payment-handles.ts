// One-off: upsert Zelle / Venmo handles into the Setting table.
// Safe to run repeatedly — only touches the two keys.
// Usage: cd apps/api && npx tsx scripts/set-payment-handles.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MICHAEL_ID = "cmexiwrfs003kvdysrjteo2hy"; // matches seed.ts

const settings = [
  {
    key: "ZELLE_ADDRESS",
    value: "seedlingslawncare",
    description: "Email or phone clients use to send Zelle payments.",
  },
  {
    key: "VENMO_BUSINESS_HANDLE",
    value: "SeedlingsLawnCare",
    description: "@handle clients use to send Venmo payments (no @ prefix).",
  },
];

async function main() {
  for (const s of settings) {
    const result = await prisma.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value, description: s.description, updatedById: MICHAEL_ID },
      update: { value: s.value, description: s.description, updatedById: MICHAEL_ID },
    });
    console.log(`Set ${result.key} = ${result.value}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
