import type { FastifyInstance } from "fastify";

export default async function routeList(app: FastifyInstance) {
  app.get("/__routes", async (req, reply) => {
    const wantsJSON =
      (req.headers["accept"] ?? "").toString().includes("application/json") ||
      (req.query as any)?.format === "json";

    // If @fastify/routes is registered, prefer its structured list
    const listFn = (app as any).routes?.bind(app as any);
    if (wantsJSON && typeof listFn === "function") {
      // Normalize to simple JSON
      const rows = listFn().map((r: any) => ({
        method: Array.isArray(r.method) ? r.method : [r.method],
        url: r.url,
        prefix: r.prefix ?? "",
        constraints: r.constraints ?? undefined,
      }));
      return reply.send(rows);
    }

    // Fallback to ASCII tree from printRoutes() (convert box chars → ASCII)
    const ascii = toAsciiTree(app.printRoutes());
    return reply.type("text/plain").send(ascii);
  });
}

function toAsciiTree(s: string): string {
  return (
    s
      .replace(/├/g, "|")
      .replace(/└/g, "`")
      .replace(/│/g, "|")
      .replace(/─/g, "-")
      // remove any remaining non-ASCII so browsers never mojibake
      .replace(/[^\x00-\x7F]/g, "")
  );
}
