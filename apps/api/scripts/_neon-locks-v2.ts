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
  console.log(`=== NOW: ${new Date().toISOString()} ===`);
  console.log("");

  // Count everything by state
  const counts = await prisma.$queryRaw<any[]>`
    SELECT state, wait_event_type, wait_event, COUNT(*)::int as n,
      MAX(EXTRACT(EPOCH FROM (now() - COALESCE(xact_start, query_start)))::int) as oldest_sec
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
    GROUP BY state, wait_event_type, wait_event
    ORDER BY n DESC
  `;
  console.log("Session counts:");
  for (const c of counts) {
    console.log(`  n=${String(c.n).padStart(3)}  state=${(c.state ?? "-").padEnd(24)}  wait=${c.wait_event_type ?? "-"}/${c.wait_event ?? "-"}  oldest=${c.oldest_sec ?? "-"}s`);
  }

  console.log("");
  console.log("Total connections:", counts.reduce((s, c) => s + Number(c.n), 0));

  // Who is stuck idle in transaction?
  console.log("");
  console.log("=== IDLE IN TRANSACTION ===");
  const idle = await prisma.$queryRaw<any[]>`
    SELECT
      pid,
      application_name,
      client_addr::text AS client_addr,
      backend_start,
      xact_start,
      EXTRACT(EPOCH FROM (now() - xact_start))::int AS tx_age_sec,
      EXTRACT(EPOCH FROM (now() - state_change))::int AS idle_sec,
      substring(query for 200) AS query_excerpt
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'idle in transaction'
      AND pid <> pg_backend_pid()
    ORDER BY xact_start ASC NULLS LAST
  `;
  if (idle.length === 0) console.log("  (none)");
  else for (const r of idle) console.log(`  pid=${r.pid}  from=${r.client_addr ?? "-"}  app=${r.application_name ?? "-"}  tx_age=${r.tx_age_sec}s  idle=${r.idle_sec}s  q=${(r.query_excerpt ?? "").replace(/\s+/g, " ").slice(0, 150)}`);

  // What's blocked and by whom?
  console.log("");
  console.log("=== BLOCKED CHAIN ===");
  const blocked = await prisma.$queryRaw<any[]>`
    SELECT
      blocked.pid AS blocked_pid,
      blocked.application_name AS blocked_app,
      blocked.client_addr::text AS blocked_addr,
      EXTRACT(EPOCH FROM (now() - blocked.query_start))::int AS blocked_for_sec,
      blocking.pid AS blocking_pid,
      blocking.state AS blocking_state,
      blocking.application_name AS blocking_app,
      blocking.client_addr::text AS blocking_addr,
      EXTRACT(EPOCH FROM (now() - blocking.state_change))::int AS blocking_state_age_sec
    FROM pg_stat_activity blocked
    JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
    WHERE blocked.datname = current_database()
    LIMIT 20
  `;
  if (blocked.length === 0) console.log("  (nothing blocked right now)");
  else for (const r of blocked) console.log(`  blocked pid=${r.blocked_pid} (${r.blocked_for_sec}s, from ${r.blocked_addr})  ← by  pid=${r.blocking_pid} (${r.blocking_state}, ${r.blocking_state_age_sec}s, from ${r.blocking_addr})`);

  await prisma.$disconnect();
})();
