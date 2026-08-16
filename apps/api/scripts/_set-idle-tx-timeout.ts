import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;
neonConfig.pipelineConnect = false;

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

// Sets a database-level guard so ANY session that's been "idle in
// transaction" for more than 15 seconds gets automatically terminated
// by Postgres. This is the belt-and-suspenders backstop for the
// fire-and-forget-transaction bug: even if application code accidentally
// strands a transaction (Vercel container recycle, etc.), Postgres will
// clean it up in 15s max — instead of holding row locks for many minutes.
//
// Applied to the database (ALTER DATABASE), so it persists across all
// future connections. Idempotent — safe to run multiple times.

(async () => {
  // Get database name
  const [{ dbname }] = await prisma.$queryRaw<{ dbname: string }[]>`
    SELECT current_database()::text as dbname
  `;
  console.log(`Setting idle_in_transaction_session_timeout=15000 on database "${dbname}"`);
  // 15000ms = 15 seconds. Prisma parameterized query doesn't work for
  // identifiers, so we escape the db name manually. Since we got it
  // from current_database() this is safe.
  const safe = dbname.replace(/"/g, '""');
  await prisma.$executeRawUnsafe(
    `ALTER DATABASE "${safe}" SET idle_in_transaction_session_timeout = 15000`,
  );
  console.log("done. New connections will inherit the setting.");
  console.log("");
  console.log("Note: existing connections are UNAFFECTED. Run _kill-stuck-tx.ts to clean current ones.");
  await prisma.$disconnect();
})();
