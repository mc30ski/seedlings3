import { FastifyInstance } from "fastify";
import { verifyToken } from "@clerk/backend";

function bearer(req: any): string | null {
  const h = req.headers?.authorization ?? "";
  if (typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

export default async function debugRoutes(app: FastifyInstance) {
  app.get("/debug/auth", async (req) => {
    const token = bearer(req);
    const secret = process.env.CLERK_SECRET_KEY;
    let tokenValid = false;
    let payload: any = null;

    if (token && secret) {
      try {
        payload = await verifyToken(token, { secretKey: secret });
        tokenValid = true;
      } catch (e) {
        tokenValid = false;
      }
    }

    return {
      hasAuthHeader: !!token,
      tokenValid,
      clerkUserIdFromReq: req.auth?.clerkUserId ?? null,
      subFromPayload: payload?.sub ?? null,
    };
  });

  app.get("/debug/whoami", async (req) => ({
    hasAuthHeader: !!req.headers.authorization,
    auth: (req as any).auth ?? null,
    user: (req as any).user ?? null,
  }));
}
