import "dotenv/config";
import Fastify from "fastify";
import { registerRoutes } from "./routes";

// trustProxy: honor X-Forwarded-For / X-Forwarded-Proto ONLY when the
// hop count matches — for Vercel this is 1 (edge → API function).
// Without this, req.ip returns the immediate socket peer (loopback in
// serverless), rate limits bucket everyone into the same key, and any
// client can spoof its address by sending X-Forwarded-For themselves.
// See docs: https://www.fastify.io/docs/latest/Reference/Server/#trustproxy
const app = Fastify({ logger: true, trustProxy: 1 });

// Register routes only once
registerRoutes(app);

const port = process.env.PORT || 8080;

app
  .listen({ port: Number(port), host: "0.0.0.0" })
  .then(() => console.log(`Server running at http://localhost:${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
