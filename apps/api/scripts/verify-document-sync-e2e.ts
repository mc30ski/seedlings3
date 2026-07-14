// End-to-end sanity check for the CompanyDocument → Drive sync feature.
// Enables sync, runs a backfill against whatever CompanyDocuments exist
// in the dev DB, drains the queue, and lists the Drive folder state.
//
// Usage:
//   cd apps/api && npx tsx scripts/verify-document-sync-e2e.ts
//
// Restores the sync-enabled setting to its previous value on exit so a
// dev machine doesn't get flipped on unintentionally.
import "dotenv/config";
import { prisma } from "../src/db/prisma";
import { runSync } from "../src/services/documentSyncWorker";
import { ensureFolder, listChildren } from "../src/lib/driveClient";

async function main() {
  const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) {
    console.error("Missing GOOGLE_DRIVE_ROOT_FOLDER_ID");
    process.exit(1);
  }

  // 1. Flip sync on (remember prior value).
  const prior = await prisma.setting.findUnique({ where: { key: "DOCUMENT_SYNC_ENABLED" } });
  const priorValue = prior?.value ?? "false";
  await prisma.setting.upsert({
    where: { key: "DOCUMENT_SYNC_ENABLED" },
    create: { key: "DOCUMENT_SYNC_ENABLED", value: "true" },
    update: { value: "true" },
  });
  console.log("Sync enabled (was:", priorValue + ")");

  try {
    // 2. Enqueue backfill tasks for every existing doc + version.
    const docs = await prisma.companyDocument.findMany({
      select: { id: true, title: true, versions: { select: { id: true } } },
    });
    console.log(`\nFound ${docs.length} document(s):`);
    for (const d of docs) console.log(`  - ${d.title} (${d.id}) — ${d.versions.length} version(s)`);

    const rows: Array<{ taskType: string; documentId: string | null; versionId: string | null }> = [];
    for (const d of docs) {
      rows.push({ taskType: "SYNC_DOCUMENT_METADATA", documentId: d.id, versionId: null });
      for (const v of d.versions) {
        rows.push({ taskType: "UPLOAD_DOCUMENT_VERSION", documentId: d.id, versionId: v.id });
      }
    }
    rows.push({ taskType: "SYNC_TAXONOMY", documentId: null, versionId: null });
    if (rows.length > 0) {
      await prisma.documentSyncQueue.createMany({ data: rows });
    }
    console.log(`\nEnqueued ${rows.length} task(s).`);

    // 3. Drain the queue.
    console.log("\nRunning worker...");
    const result = await runSync({ maxTasks: 1000 });
    console.log("  processed:", result.processed);
    console.log("  succeeded:", result.succeeded);
    console.log("  skipped:  ", result.skipped);
    console.log("  failed:   ", result.failed);
    for (const err of result.errors) {
      console.log(`    ERROR [${err.taskType}] ${err.taskId}: ${err.error}`);
    }

    // 4. Show Drive folder state.
    console.log("\nDrive folder state:");
    const companyDocs = await ensureFolder("CompanyDocuments", rootId);
    const topLevel = await listChildren(companyDocs);
    for (const f of topLevel) {
      console.log(`  ${f.name} [${f.mimeType.replace("application/vnd.google-apps.", "")}]`);
      if (f.mimeType === "application/vnd.google-apps.folder") {
        const inner = await listChildren(f.id);
        for (const g of inner) {
          console.log(`    ${g.name} [${g.mimeType.replace("application/vnd.google-apps.", "")}]`);
          if (g.mimeType === "application/vnd.google-apps.folder") {
            const inner2 = await listChildren(g.id);
            for (const h of inner2) {
              console.log(`      ${h.name} [${h.mimeType.replace("application/vnd.google-apps.", "")}]`);
            }
          }
        }
      }
    }

    // 5. Final DB state summary.
    const stateRows = await prisma.documentSyncState.count();
    const pending = await prisma.documentSyncQueue.count({ where: { state: "PENDING" } });
    const failed = await prisma.documentSyncQueue.count({ where: { state: "PENDING", attempts: { gte: 3 } } });
    console.log("\nDB summary:");
    console.log("  DocumentSyncState rows:", stateRows);
    console.log("  Queue pending:         ", pending);
    console.log("  Queue in-failure-loop: ", failed);

    if (result.failed === 0 && pending === 0) {
      console.log("\n🎉 End-to-end sync working.");
    } else {
      console.log("\n⚠️  Errors occurred. Check output above.");
    }
  } finally {
    // Restore the prior enabled state.
    await prisma.setting.upsert({
      where: { key: "DOCUMENT_SYNC_ENABLED" },
      create: { key: "DOCUMENT_SYNC_ENABLED", value: priorValue },
      update: { value: priorValue },
    });
    console.log(`\nSync setting restored to "${priorValue}".`);
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
