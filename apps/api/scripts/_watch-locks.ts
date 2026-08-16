import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;
neonConfig.pipelineConnect = false;

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

// Polls pg_stat_activity every 5 seconds. Prints a heartbeat every
// minute. Prints an ALERT any time it sees an idle-in-transaction
// session, so we can catch a new zombie the moment it appears.

const seenPids = new Set<number>();
let ticksSinceBanner = 0;

async function tick() {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  try {
    const rows = await prisma.$queryRaw<{
      pid: number;
      age_sec: number;
      idle_sec: number;
      query_excerpt: string;
    }[]>`
      SELECT
        pid,
        EXTRACT(EPOCH FROM (now() - xact_start))::int AS age_sec,
        EXTRACT(EPOCH FROM (now() - state_change))::int AS idle_sec,
        substring(query for 200) AS query_excerpt
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'idle in transaction'
        AND xact_start IS NOT NULL
    `;
    const blockedCountRow = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    const blocked = blockedCountRow[0]?.n ?? 0;
    if (rows.length > 0 || blocked > 0) {
      for (const r of rows) {
        const seenBefore = seenPids.has(r.pid);
        seenPids.add(r.pid);
        const tag = seenBefore ? "STILL" : "NEW  ";
        console.log(`${ts}  ${tag} idle-in-tx pid=${r.pid} tx_age=${r.age_sec}s idle=${r.idle_sec}s blocked_now=${blocked} q="${(r.query_excerpt ?? "").replace(/\s+/g, " ").slice(0, 120)}"`);
      }
      if (rows.length === 0 && blocked > 0) {
        console.log(`${ts}  BLOCKED queries=${blocked} but no idle-in-tx (transient lock)`);
      }
      ticksSinceBanner = 0;
    } else {
      if (ticksSinceBanner === 0 || ticksSinceBanner >= 12) {
        console.log(`${ts}  ok (no idle-in-tx, no blocked queries)`);
        ticksSinceBanner = 0;
      }
      ticksSinceBanner++;
    }
  } catch (err: any) {
    console.log(`${ts}  ERROR ${err?.message}`);
  }
}

(async () => {
  console.log("watching prod pg_stat_activity every 5s. ctrl-c to stop.");
  console.log("each ALERT = new stuck idle-in-transaction session (== the bug is not fully fixed)");
  console.log("");
  await tick();
  setInterval(() => { void tick(); }, 5000);
})();
