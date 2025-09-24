import "dotenv/config";
import Fastify from "fastify";
import { registerRoutes } from "./routes";

const app = Fastify({ logger: true });

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
