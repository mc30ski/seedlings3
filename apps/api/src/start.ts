import "dotenv/config";
import { buildApp } from "./app";

try {
  const app = await buildApp();
  await app.ready();

  console.log("MIKEW", "start.ts", "THIS IS RUN");

  const port = Number(process.env.PORT) || 8080;
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info({ port }, "API listening");
} catch (err) {
  console.error("FATAL: failed to start API", err);
  process.exit(1);
}
