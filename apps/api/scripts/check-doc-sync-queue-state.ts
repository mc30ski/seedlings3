// What does the queue actually look like right now?
import "dotenv/config";
import { prisma } from "../src/db/prisma";

async function main() {
  const bystate: any[] = await prisma.$queryRawUnsafe(`
    SELECT state, COUNT(*)::int AS n
    FROM "DocumentSyncQueue"
    GROUP BY state
    ORDER BY state
  `);
  console.log("By state:");
  for (const r of bystate) console.log(`  ${r.state.padEnd(12)} ${r.n}`);

  const pendingOnly = await prisma.documentSyncQueue.count({ where: { state: "PENDING" } });
  const inProgOnly = await prisma.documentSyncQueue.count({ where: { state: "IN_PROGRESS" } });
  const both = await prisma.documentSyncQueue.count({
    where: { state: { in: ["PENDING", "IN_PROGRESS"] } },
  });
  console.log(`\nStatus endpoint counts:  pending=${pendingOnly}  inProgress=${inProgOnly}`);
  console.log(`Pending endpoint filter: state in (PENDING, IN_PROGRESS) → ${both}`);

  const rows = await prisma.documentSyncQueue.findMany({
    where: { state: { in: ["PENDING", "IN_PROGRESS"] } },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: 50,
    select: {
      id: true,
      taskType: true,
      documentId: true,
      state: true,
      attempts: true,
      createdAt: true,
      nextAttemptAt: true,
    },
  });
  console.log(`\nSample rows returned by the /pending query (${rows.length} of ${both}):`);
  for (const r of rows) {
    console.log(`  ${r.state.padEnd(11)}  ${r.taskType.padEnd(24)}  attempts=${r.attempts}  doc=${r.documentId ?? "-"}`);
  }
  await prisma.$disconnect();
}
main();
