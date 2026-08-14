import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Role as RoleVal } from "@prisma/client";
import { services } from "../services";
import {
  listVanityPages,
  getVanityPageById,
  createVanityPage,
  updateVanityPage,
  deleteVanityPage,
  getVanityPageImageUploadUrl,
  confirmVanityPageImageUpload,
} from "../services/vanityPages";

// Super-only Vanity URL endpoints. All CRUD + image-upload URL flow
// lives here. Public read (for the Next.js dynamic route) is in
// routes/public.ts.

async function currentUserId(req: any): Promise<string> {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

export default async function vanityPagesRoutes(app: FastifyInstance) {
  const superGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.SUPER),
  };

  // List — sorted by default-first, then slug alpha. Editor renders the
  // default at the top so operator sees the fallback state at a glance.
  app.get("/super/vanity", superGuard, async () => {
    return listVanityPages();
  });

  // Single fetch for the edit form.
  app.get("/super/vanity/:id", superGuard, async (req: any, reply: any) => {
    const row = await getVanityPageById(String(req.params.id));
    if (!row) return reply.code(404).send({ error: "not_found" });
    return row;
  });

  // Create.
  app.post("/super/vanity", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    try {
      const created = await createVanityPage({
        actorUserId: uid,
        payload: req.body ?? {},
      });
      return created;
    } catch (err: any) {
      // Zod validation surfaces here via err.code === "VALIDATION" with
      // an issues array. Unique-constraint violation on slug surfaces
      // via Prisma with err.code "P2002" — translate to a clean 409.
      if (err?.code === "VALIDATION") {
        return reply.code(400).send({ error: "validation", detail: err.message, issues: err.issues });
      }
      if (err?.code === "P2002") {
        return reply.code(409).send({ error: "slug_taken", detail: "That slug is already in use." });
      }
      return reply.code(500).send({ error: "create_failed", detail: String(err?.message ?? err) });
    }
  });

  // Update.
  app.patch("/super/vanity/:id", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    try {
      const updated = await updateVanityPage({
        id: String(req.params.id),
        actorUserId: uid,
        payload: req.body ?? {},
      });
      return updated;
    } catch (err: any) {
      if (err?.code === "NOT_FOUND") {
        return reply.code(404).send({ error: "not_found" });
      }
      if (err?.code === "VALIDATION") {
        return reply.code(400).send({ error: "validation", detail: err.message, issues: err.issues });
      }
      if (err?.code === "P2002") {
        return reply.code(409).send({ error: "slug_taken", detail: "That slug is already in use." });
      }
      return reply.code(500).send({ error: "update_failed", detail: String(err?.message ?? err) });
    }
  });

  // Delete.
  app.delete("/super/vanity/:id", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    try {
      await deleteVanityPage({
        id: String(req.params.id),
        actorUserId: uid,
      });
      return { deleted: true };
    } catch (err: any) {
      if (err?.code === "NOT_FOUND") {
        return reply.code(404).send({ error: "not_found" });
      }
      if (err?.code === "CANNOT_DELETE_DEFAULT") {
        return reply.code(409).send({ error: "cannot_delete_default", detail: err.message });
      }
      return reply.code(500).send({ error: "delete_failed", detail: String(err?.message ?? err) });
    }
  });

  // ── R2 image upload flow ─────────────────────────────────────────────
  // Same pattern as PromotionLandingPage image upload — presigned URL
  // returned to the client, client PUTs the blob directly to R2, then
  // POSTs the confirmed key back so we persist it on the row.

  app.post(
    "/super/vanity/:id/image-upload-url",
    superGuard,
    async (req: any, reply: any) => {
      const id = String(req.params.id);
      const body = (req.body ?? {}) as { contentType?: string };
      const contentType = body.contentType || "image/jpeg";
      if (!/^image\//.test(contentType)) {
        return reply.code(400).send({ error: "invalid_content_type" });
      }
      const exists = await getVanityPageById(id);
      if (!exists) return reply.code(404).send({ error: "not_found" });
      const res = await getVanityPageImageUploadUrl({
        vanityPageId: id,
        contentType,
      });
      return { ...res, contentType };
    },
  );

  app.post(
    "/super/vanity/:id/confirm-image",
    superGuard,
    async (req: any, reply: any) => {
      const uid = await currentUserId(req);
      const id = String(req.params.id);
      const body = (req.body ?? {}) as { key?: string };
      if (!body.key) return reply.code(400).send({ error: "key_required" });
      const exists = await getVanityPageById(id);
      if (!exists) return reply.code(404).send({ error: "not_found" });
      await confirmVanityPageImageUpload({
        vanityPageId: id,
        key: body.key,
        actorUserId: uid,
      });
      return { ok: true };
    },
  );
}
