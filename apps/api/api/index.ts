// api/index.ts
import Fastify from "fastify";
import type { IncomingMessage, ServerResponse } from "http";
import { registerRoutes } from "../src/routes";

// Keep a single Fastify instance across invocations (warm starts)
declare global {
  // eslint-disable-next-line no-var
  var __fastify__: import("fastify").FastifyInstance | undefined;
  // eslint-disable-next-line no-var
  var __routesRegistered__: boolean | undefined;
}

const app =
  globalThis.__fastify__ ??
  (globalThis.__fastify__ = Fastify({ logger: false }));

if (!globalThis.__routesRegistered__) {
  // Register routes exactly once
  registerRoutes(app);
  globalThis.__routesRegistered__ = true;
}

// Vercel Node.js Runtime handler
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
) {
  await app.ready();
  app.server.emit("request", req, res);
}
