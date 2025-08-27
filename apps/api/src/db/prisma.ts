import { PrismaClient } from "@prisma/client";

// Safe, singleton Prisma client factory—so you don’t open a new DB connection every time your code hot-reloads.
// Gives the Node global object a typed optional prisma property. This lets us stash a PrismaClient on the process-global object.

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Reduce noise in prod (only errors), but include warnings in dev (e.g., deprecations).
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });

// In development, store the created client on global so subsequent hot reloads reuse the same instance (and connection pool).
// In production, we don’t set global.prisma—each process gets its own clean instance, which is what you want under a normal server or container.
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
