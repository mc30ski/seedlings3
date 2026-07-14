// Quick diagnostic — is the setting on, and did any queue rows land
// from the recent doc upload?
import "dotenv/config";
import { prisma } from "../src/db/prisma";

async function main() {
  const setting = await prisma.setting.findUnique({ where: { key: "DOCUMENT_SYNC_ENABLED" } });
  console.log("DOCUMENT_SYNC_ENABLED =", setting?.value);

  const [pending, inProg, done, failed, total] = await Promise.all([
    prisma.documentSyncQueue.count({ where: { state: "PENDING" } }),
    prisma.documentSyncQueue.count({ where: { state: "IN_PROGRESS" } }),
    prisma.documentSyncQueue.count({ where: { state: "DONE" } }),
    prisma.documentSyncQueue.count({ where: { state: "FAILED" } }),
    prisma.documentSyncQueue.count(),
  ]);
  console.log(`Queue: total=${total} pending=${pending} inProg=${inProg} done=${done} failed=${failed}`);

  const recent = await prisma.documentSyncQueue.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, taskType: true, documentId: true, versionId: true, state: true, createdAt: true },
  });
  console.log("\n10 most recent queue rows:");
  for (const r of recent) {
    console.log(`  ${r.createdAt.toISOString()}  ${r.state.padEnd(11)}  ${r.taskType.padEnd(24)}  doc=${r.documentId ?? "-"}`);
  }

  // Look for the "Invoice 855D255E 0006" document
  const invoice = await prisma.companyDocument.findFirst({
    where: { title: { contains: "855D255E", mode: "insensitive" } },
    include: { versions: { orderBy: { uploadedAt: "desc" } } },
  });
  if (invoice) {
    console.log(`\nFound invoice doc: ${invoice.title} (${invoice.id})`);
    console.log(`  createdAt: ${invoice.createdAt.toISOString()}`);
    console.log(`  versions: ${invoice.versions.length}`);
    for (const v of invoice.versions) {
      console.log(`    ${v.id}  uploaded=${v.uploadedAt.toISOString()}  key=${v.r2Key}`);
    }
    const relatedTasks = await prisma.documentSyncQueue.findMany({
      where: { documentId: invoice.id },
    });
    console.log(`  Queue rows for this doc: ${relatedTasks.length}`);
    for (const t of relatedTasks) console.log(`    ${t.taskType} state=${t.state}`);
  } else {
    console.log("\nInvoice doc NOT found in DB.");
  }

  await prisma.$disconnect();
}
main();
