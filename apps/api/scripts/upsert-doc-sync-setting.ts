// One-off: seed the DOCUMENT_SYNC_ENABLED Setting row. Defaults OFF in
// dev so reseeds / local runs don't spam Drive. Flip to "true" here
// (or from the future Settings UI) to enable local sync.
import "dotenv/config";
import { prisma } from "../src/db/prisma";

async function main() {
  await prisma.setting.upsert({
    where: { key: "DOCUMENT_SYNC_ENABLED" },
    create: { key: "DOCUMENT_SYNC_ENABLED", value: "false" },
    update: {},
  });
  const row = await prisma.setting.findUnique({ where: { key: "DOCUMENT_SYNC_ENABLED" } });
  console.log("DOCUMENT_SYNC_ENABLED =", row?.value);
  await prisma.$disconnect();
}
main();
