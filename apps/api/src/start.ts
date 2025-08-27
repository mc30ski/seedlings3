import { buildApp } from "./app";

async function main() {
  const app = buildApp();
  try {
    await app.ready();
    if (process.env.ROUTE_DUMP === "1") {
      // This will include: GET   /api/v1/version
      console.log(app.printRoutes());
    }
    await app.listen({
      port: Number(process.env.PORT) || 8080,
      host: "0.0.0.0",
    });
    console.log("API listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
