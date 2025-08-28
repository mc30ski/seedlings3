import type { FastifyInstance, HTTPMethods } from "fastify";

type Row = { method: string[]; path: string };

export default async function routeList(app: FastifyInstance) {
  // capture routes as they’re registered
  const rows: Row[] = [];

  app.addHook("onRoute", (opts) => {
    const methods = Array.isArray(opts.method)
      ? (opts.method as string[])
      : [opts.method as HTTPMethods];

    // opts.url is the final path on this instance (includes prefix when applicable)
    const path = (opts.url || "/").replace(/\/{2,}/g, "/");
    rows.push({ method: methods.map(String), path });
  });

  // always-on, human-readable route list
  app.get("/__routes", async (req, reply) => {
    const wantsJSON =
      String(req.headers.accept ?? "").includes("application/json") ||
      (req.query as any)?.format === "json";

    // sort by path then method for stable output
    const sorted = rows
      .map((r) => ({ ...r, method: [...r.method].sort() }))
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          a.method.join(",").localeCompare(b.method.join(","))
      );

    if (wantsJSON) {
      return reply.send(sorted);
    }

    const lines = sorted.map(
      (r) => `${r.method.join(",").padEnd(12)} ${r.path}`
    );
    reply.type("text/plain; charset=utf-8").send(lines.join("\n"));
  });
}
