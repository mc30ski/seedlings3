import Fastify, { type FastifyInstance } from "fastify";
import cors, { type FastifyCorsOptions } from "@fastify/cors";

const app: FastifyInstance = Fastify({ logger: true });

const corsOptions: FastifyCorsOptions = {
  // Allow curl/server-to-server (no origin) and any origins listed in WEB_ORIGIN
  // e.g. WEB_ORIGIN="https://your-web.vercel.app,https://your-preview.vercel.app"
  origin: (
    origin: string | undefined,
    cb: (err: Error | null, allow: boolean) => void
  ) => {
    const allowed = (process.env.WEB_ORIGIN ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!origin || allowed.includes(origin)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
};

await app.register(cors, corsOptions);

app.get("/healthz", async () => ({ ok: true }));

app.get("/hello", async () => ({ message: "Hello World from API." }));

const port = Number(process.env.PORT ?? 8080);
const host = "0.0.0.0";

try {
  await app.listen({ port, host });
  app.log.info(`listening on http://localhost:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
