import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

// On Node 24 the `ws` package's WebSocket implementation exhibits a
// connect-then-hang symptom against Neon's WebSocket endpoint (queries
// never return, function invocations time out). Node 22+ ships a
// native WebSocket API that works with Neon directly. Prefer it when
// available; fall back to `ws` on runtimes that don't expose one
// (older Node, non-browser environments).
neonConfig.webSocketConstructor =
  (typeof globalThis !== "undefined" && (globalThis as any).WebSocket) || ws;

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") g.prisma = prisma;
