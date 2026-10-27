import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

/**
 * Direct DB access for e2e tests — same connection pattern as the API uses,
 * but scoped to a fresh client per test file so we don't hold pooled
 * connections during a run.
 *
 * This lives apart from `db.ts` on purpose. `db.ts` carries the seed-user id
 * map, and `auth/auth.setup.ts` is what POPULATES that map — so if the setup
 * had to import `db.ts` to get a client, it would depend on the very thing it
 * exists to produce. Keeping the factory side-effect-free breaks that cycle.
 */
export function makePrisma() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing — check apps/api/.env");
  if (!url.includes("jolly-wildflower")) {
    throw new Error("SAFETY: e2e tests must run against the dev DB (jolly-wildflower). Refusing.");
  }
  const adapter = new PrismaNeon({ connectionString: url });
  return new PrismaClient({ adapter });
}
