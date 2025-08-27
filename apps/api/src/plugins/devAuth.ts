import fp from "fastify-plugin";

export type AuthUser = { clerkUserId: string } & (
  | { id: string; isApproved: boolean; roles: string[] }
  | {}
);

export default fp(async (app) => {
  app.decorateRequest("auth", null);
  app.addHook("preHandler", async (req) => {
    const auth = req.headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) return; // public routes can exist
    const token = auth.slice("Bearer ".length);
    if (token.startsWith("dev-mock:")) {
      const clerkUserId = token.substring("dev-mock:".length);
      (req as any).auth = { clerkUserId };
    }
  });
});
