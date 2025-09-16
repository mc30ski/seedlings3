// apps/api/api/[...all].ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../dist/app.js";

const g = globalThis as unknown as { _app?: Promise<FastifyInstance> };

async function getApp(): Promise<FastifyInstance> {
  if (!g._app) {
    g._app = (async () => {
      const app = await buildApp(); // works if buildApp is sync OR async
      await app.ready(); // Fastify .ready() is on the instance
      return app;
    })();
  }
  return g._app;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse
) {
  const app = await getApp();
  app.server.emit("request", req, res);
}
