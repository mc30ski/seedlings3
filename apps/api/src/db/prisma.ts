import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

// Neon docs recommend the `ws` package as the WebSocket implementation
// in Node.js. See @neondatabase/serverless/CONFIG.md.
neonConfig.webSocketConstructor = ws;

// WORKAROUND for @neondatabase/serverless issue #209 ("pipelineConnect
// silently hangs for payloads in ~32KB–42KB range on pool reconnection")
// — open bug as of 2026-04, reproducible on Vercel with Neon Postgres.
// With the default `pipelineConnect: "password"`, the driver bundles
// the startup + auth + first query into a single pipelined burst;
// serialized payloads that fall in a specific 32K-window trigger a
// buffer boundary condition that leaves the client waiting forever
// for a response Neon never sends. This is the intermittent-across-
// endpoints hang pattern we've been chasing: whichever request happens
// to serialize into the bad size range on a pool reconnection hangs
// until the function times out. Disabling pipelining costs one extra
// round-trip on connection setup and eliminates the hang.
neonConfig.pipelineConnect = false;

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient({ adapter });
if (process.env.NODE_ENV !== "production") g.prisma = prisma;
