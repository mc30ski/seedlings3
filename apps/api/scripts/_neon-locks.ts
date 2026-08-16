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
  console.log("=== ACTIVE CONNECTIONS ===");
  const activity = await prisma.$queryRaw<any[]>`
    SELECT
      pid,
      state,
      wait_event_type,
      wait_event,
      state_change,
      xact_start,
      query_start,
      EXTRACT(EPOCH FROM (now() - COALESCE(xact_start, query_start)))::int as elapsed_sec,
      substring(query for 200) as query_excerpt
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
    ORDER BY COALESCE(xact_start, query_start) NULLS LAST
  `;
  for (const row of activity) {
    console.log(
      `  pid=${row.pid}  state=${row.state}  wait=${row.wait_event_type ?? "-"}/${row.wait_event ?? "-"}  elapsed=${row.elapsed}  q="${(row.query_excerpt ?? "").replace(/\s+/g, " ").slice(0, 100)}"`
    );
  }

  console.log("");
  console.log("=== BLOCKED QUERIES ===");
  const blocked = await prisma.$queryRaw<any[]>`
    SELECT
      blocked.pid AS blocked_pid,
      blocked.state AS blocked_state,
      substring(blocked.query for 120) AS blocked_query,
      blocking.pid AS blocking_pid,
      substring(blocking.query for 120) AS blocking_query,
      blocking.state AS blocking_state,
      EXTRACT(EPOCH FROM (now() - blocked.xact_start))::int AS blocked_for_sec
    FROM pg_stat_activity blocked
    JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
    WHERE blocked.datname = current_database()
  `;
  if (blocked.length === 0) console.log("  (none — no blocked queries right now)");
  else for (const row of blocked) console.log(`  ${JSON.stringify(row)}`);

  console.log("");
  console.log("=== LONG-RUNNING TRANSACTIONS (>30s) ===");
  const longRunning = await prisma.$queryRaw<any[]>`
    SELECT
      pid,
      state,
      xact_start,
      EXTRACT(EPOCH FROM (now() - xact_start))::int AS elapsed_sec,
      substring(query for 200) AS query_excerpt,
      wait_event_type,
      wait_event
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND xact_start IS NOT NULL
      AND now() - xact_start > interval '30 seconds'
      AND pid <> pg_backend_pid()
  `;
  if (longRunning.length === 0) console.log("  (none)");
  else for (const row of longRunning) console.log(`  ${JSON.stringify(row)}`);

  console.log("");
  console.log("=== LOCKS ON User table ===");
  const locks = await prisma.$queryRaw<any[]>`
    SELECT
      l.pid,
      l.locktype,
      l.mode,
      l.granted,
      c.relname,
      substring(a.query for 200) as query_excerpt,
      a.state,
      EXTRACT(EPOCH FROM (now() - a.xact_start))::int AS xact_age_sec
    FROM pg_locks l
    LEFT JOIN pg_class c ON c.oid = l.relation
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE c.relname IN ('User', 'UserRole', 'AuditEvent', 'PushSubscription')
       OR l.locktype = 'transactionid'
  `;
  if (locks.length === 0) console.log("  (none)");
  else for (const row of locks) console.log(`  ${JSON.stringify(row)}`);

  await prisma.$disconnect();
})();
