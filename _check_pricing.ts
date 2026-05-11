import { prisma } from "./src/db/prisma";
async function main() {
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: "pricing_" } }, orderBy: { key: "asc" } });
  console.log("Pricing entries:", rows.length);
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value);
      console.log(`  ${v.jobTag ?? "(no tag)"}\t$${v.amount}\t${v.label}`);
    } catch {}
  }
}
main().then(() => process.exit(0));
