// apps/api/api/[...all].js
export default async function handler(req, res) {
  // On Vercel we run the built output
  const mod = await import(new URL("../dist/app.js", import.meta.url).href);
  const buildApp = mod.buildApp || mod.default?.buildApp || mod.default;
  const app = await buildApp();
  await app.ready();
  // Hand off the Node request/response to Fastify
  app.server.emit("request", req, res);
}
