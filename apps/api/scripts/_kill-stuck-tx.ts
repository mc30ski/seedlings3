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
  // Aggressive cleanup: kill EVERY idle-in-transaction session,
  // regardless of age. Also kill anything blocked waiting on tuple/
  // transactionid locks — those are queries queued behind zombies.
  // Loops until nothing left. Only safe because our app should NEVER
  // have an intentional long-lived idle-in-transaction session.
  let totalKilled = 0;
  for (let pass = 1; pass <= 20; pass++) {
    const targets = await prisma.$queryRaw<
      { pid: number; age_sec: number; state: string }[]
    >`
      SELECT pid, EXTRACT(EPOCH FROM (now() - xact_start))::int as age_sec, state
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'idle in transaction'
        AND xact_start IS NOT NULL
    `;
    if (targets.length === 0) {
      console.log(`pass ${pass}: 0 stuck. done.`);
      break;
    }
    console.log(`pass ${pass}: killing ${targets.length}`);
    for (const t of targets) {
      await prisma.$queryRaw<{ ok: boolean }[]>`SELECT pg_terminate_backend(${t.pid}) as ok`;
      totalKilled++;
    }
    // Give the queue a moment to advance and expose the next batch.
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`total killed: ${totalKilled}`);
  await prisma.$disconnect();
})();
