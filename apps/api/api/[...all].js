// apps/api/api/[...all].js
/*
export default async function handler(req, res) {
  // On Vercel we run the built output
  const mod = await import(new URL("../dist/app.js", import.meta.url).href);
  const buildApp = mod.buildApp || mod.default?.buildApp || mod.default;
  const app = await buildApp();
  await app.ready();
  // Hand off the Node request/response to Fastify
  app.server.emit("request", req, res);
}
*/

function stripFirstApi(url) {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/api/, "");
  return u.toString();
}

export default async function handler(req, res) {
  const app = appPromise ?? (appPromise = buildApp());
  await (await app).ready();

  // Normalize: strip a single leading "/api" so Fastify sees the expected paths.
  // e.g. "/api/healthz" -> "/healthz", "/api/v1/me" -> "/v1/me"
  const orig = req.url || "/";

  console.log("HERE", orig);

  const s = stripFirstApi(orig);

  console.log("HERE2", s);

  req.url = s;

  (await app).routing(req, res);
}
