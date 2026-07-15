import "dotenv/config";
import { prisma } from "../src/db/prisma";

async function main() {
  const uid = "cmexiwrfs003kvdysrjteo2hy"; // MICHAEL_ID
  const now = new Date();
  const start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  const rows = await prisma.jobOccurrenceAssignee.findMany({
    where: {
      userId: uid,
      OR: [{ role: null }, { role: { not: "observer" } }],
      occurrence: {
        completedAt: { gte: start, lte: now },
        status: { notIn: ["CANCELED", "ARCHIVED"] as any },
      },
    },
    include: {
      occurrence: { select: { id: true, workflow: true, price: true, completedAt: true, status: true } },
    },
  });
  console.log(`Michael has ${rows.length} completed non-observer assignments in last year:`);
  const workflows = new Map<string, number>();
  for (const r of rows) {
    workflows.set(r.occurrence.workflow ?? "null", (workflows.get(r.occurrence.workflow ?? "null") ?? 0) + 1);
  }
  for (const [wf, count] of workflows) console.log(`  ${wf}: ${count}`);
  const stdCount = rows.filter((r) => ["STANDARD", "ONE_OFF"].includes(r.occurrence.workflow ?? "")).length;
  console.log(`\nSTANDARD/ONE_OFF only: ${stdCount}`);

  const wds = await prisma.workerWorkday.findMany({
    where: { userId: uid, endedAt: { not: null, gte: start } },
  });
  let ms = 0;
  for (const w of wds) ms += w.endedAt!.getTime() - w.startedAt.getTime() - w.totalPausedMs;
  console.log(`Workdays: ${wds.length}, hours: ${(ms / 3600000).toFixed(2)}`);
  await prisma.$disconnect();
}
main();
