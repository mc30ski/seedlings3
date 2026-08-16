import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;
neonConfig.pipelineConnect = false;

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function ping(label: string) {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1 as ok`;
    console.log(`  ${label.padEnd(10)}  ${Date.now() - start}ms  OK`);
  } catch (err: any) {
    console.log(`  ${label.padEnd(10)}  ${Date.now() - start}ms  FAIL: ${err?.message}`);
  }
}

(async () => {
  console.log("Pinging Neon prod with SELECT 1, 20 times, 3s apart");
  console.log("First ping = cold-start wake time. Subsequent = warm query time.");
  console.log("");
  for (let i = 1; i <= 20; i++) {
    await ping(`ping ${i}`);
    if (i < 20) await new Promise((r) => setTimeout(r, 3000));
  }
  await prisma.$disconnect();
})();
