// Print PAYMENT_METHODS setting to verify the Zelle QR was saved.

import { prisma } from "../src/db/prisma";

async function main() {
  const row = await prisma.setting.findUnique({
    where: { key: "PAYMENT_METHODS" },
  });
  if (!row) {
    console.log("No PAYMENT_METHODS setting row.");
    return;
  }
  const arr = JSON.parse(String(row.value));
  for (const m of arr) {
    const qrSize = m.payToTargetQrUrl
      ? `${Math.round((String(m.payToTargetQrUrl).length * 3) / 4 / 1024)} KB`
      : "—";
    console.log(
      `  ${m.label.padEnd(14)} key=${String(m.key).padEnd(10)} target=${String(m.payToTarget ?? "—").padEnd(28)} qr=${qrSize}`,
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
