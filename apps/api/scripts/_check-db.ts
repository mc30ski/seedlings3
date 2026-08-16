import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
neonConfig.webSocketConstructor = ws;
neonConfig.pipelineConnect = false;
const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
(async () => {
  const uid = "cmg2wvwqz0001jx04rb3ch2bq";  // prod Michael
  const now = new Date();
  const in14 = new Date(now.getTime() + 14 * 86400_000);
  const items = await prisma.jobOccurrence.findMany({
    where: {
      OR: [
        { assignees: { some: { userId: uid } } },
        { workflow: "ESTIMATE", startAt: { gte: now, lt: in14 } },
      ],
      startAt: { gte: now, lt: in14 },
    },
    select: {
      id: true, title: true, startAt: true, workflow: true, status: true, jobId: true,
      contactName: true, estimateAddress: true,
      assignees: { select: { userId: true, role: true, assignedById: true, user: { select: { displayName: true } } } },
    },
    orderBy: { startAt: "asc" },
  });
  console.log(`Michael's assignments OR ANY upcoming estimate, next 14 days: ${items.length}`);
  for (const it of items) {
    const asgn = it.assignees.length
      ? it.assignees.map((a) => `${a.user?.displayName ?? a.userId.slice(-6)}${a.assignedById === a.userId ? "*claimer" : ""}(${a.role ?? "null"})`).join(",")
      : "UNASSIGNED";
    console.log(`  ${it.startAt?.toISOString()}  [${it.workflow}]  ${it.status}  "${it.title ?? "(untitled)"}"  ${it.contactName ? `contact=${it.contactName}` : ""}  ${it.estimateAddress ? `addr=${it.estimateAddress}` : ""}  assignees=[${asgn}]`);
  }
  await prisma.$disconnect();
})();
