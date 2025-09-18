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
  // Split off hash
  const hashIdx = url.indexOf("#");
  const hash = hashIdx !== -1 ? url.slice(hashIdx) : "";
  const noHash = hashIdx !== -1 ? url.slice(0, hashIdx) : url;

  // Split off query
  const qIdx = noHash.indexOf("?");
  const query = qIdx !== -1 ? noHash.slice(qIdx) : "";
  const base = qIdx !== -1 ? noHash.slice(0, qIdx) : noHash;

  // Find where the path starts
  let pathStart = 0;
  const schemeIdx = base.indexOf("://");
  if (schemeIdx !== -1) {
    const firstSlash = base.indexOf("/", schemeIdx + 3);
    pathStart = firstSlash !== -1 ? firstSlash : base.length;
  } else if (base.startsWith("//")) {
    const firstSlash = base.indexOf("/", 2);
    pathStart = firstSlash !== -1 ? firstSlash : base.length;
  } else if (base.startsWith("/")) {
    pathStart = 0; // relative path like "/api/v1"
  } else {
    const firstSlash = base.indexOf("/");
    pathStart = firstSlash !== -1 ? firstSlash : base.length; // "example.com/api/.."
  }

  const before = base.slice(0, pathStart);
  const path = base.slice(pathStart);

  // Remove only the first "/api" as a path segment (not in "campaign", etc.)
  const newPath = path.replace(/\/api(?=\/|$)/, "");

  return before + newPath + query + hash;
}

export default async function handler(req, res) {
  // On Vercel we run the built output
  const mod = await import(new URL("../dist/app.js", import.meta.url).href);
  const buildApp = mod.buildApp || mod.default?.buildApp || mod.default;
  const app = await buildApp();
  await app.ready();

  // Normalize: strip a single leading "/api" so Fastify sees the expected paths.
  const orig = req.url || "/";
  const s = stripFirstApi(orig);
  req.url = s;

  console
    .log(
      "STRIP",
      orig,
      s
    )
    (await app)
    .routing(req, res);
}
