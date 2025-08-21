import fastify from "fastify";
import cors from "@fastify/cors";

const app = fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => {
    // Allow local dev and any origin if not set
    cb(null, true);
  },
});

// Optional Clerk JWT verification (no-op if key not set)
import { verifyToken } from "@clerk/clerk-sdk-node";

app.addHook("preHandler", async (req, reply) => {
  // Skip auth for health and hello routes in this starter
  const openRoutes = ["/healthz", "/hello"];
  if (openRoutes.includes(req.routerPath ?? "")) return;

  const key = process.env.CLERK_JWT_VERIFICATION_KEY;
  if (!key) return; // allow through if not configured yet

  const authHeader = req.headers["authorization"];
  const token = authHeader?.replace("Bearer ", "");
  if (!token) {
    reply.code(401).send({ error: "Missing token" });
    return;
  }
  try {
    await verifyToken(token, { jwtKey: key });
  } catch (e) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

app.get("/healthz", async () => ({ ok: true }));
app.get("/hello", async () => ({ message: "Hello World from API." }));

const port = Number(process.env.PORT || 8080);
app.listen({ host: "0.0.0.0", port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
