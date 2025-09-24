import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";

function readBearer(req: any): string | null {
  const h = req.headers?.authorization ?? "";
  if (typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

function readCookie(name: string, cookieHeader?: string): string | null {
  const h = cookieHeader || "";
  if (!h) return null;
  const parts = h.split(";").map((s) => s.trim());
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

// TODO: Does this endpoint need an auth guard?

export default async function meRoutes(app: FastifyInstance) {
  app.get("/me", async (req: FastifyRequest, reply: FastifyReply) => {
    // Acquire a token from header or cookie
    const authHeader = readBearer(req);
    const cookieToken = readCookie("__session", req.headers?.cookie as string);
    const token = authHeader || cookieToken;

    if (!token) {
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "Missing token (header/cookie)",
      });
    } else {
      return services.users.me(token);
    }
  });
}
