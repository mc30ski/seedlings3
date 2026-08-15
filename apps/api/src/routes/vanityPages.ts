import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Role as RoleVal } from "@prisma/client";
import { services } from "../services";
import {
  listVanityPages,
  getVanityPageById,
  createVanityPage,
  updateVanityPage,
  deleteVanityPage,
  setDefaultVanityPage,
  setVanityStartupAnimation,
  reorderVanityPages,
  getVanityPageImageUploadUrl,
  confirmVanityPageImageUpload,
  clearVanityPageImage,
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

  // Animation settings — one flag today (show history stack under the
  // typing line). Persisted as a Setting row so the value survives
  // deploys and is shared org-wide.
  //
  // Setting key: VANITY_STARTUP_ANIMATION_SHOW_HISTORY (string "true" /
  // "false"). Default treated as true when the row is missing.
  app.get("/super/vanity/animation-settings", superGuard, async () => {
    const { prisma } = await import("../db/prisma");
    const row = await prisma.setting.findUnique({
      where: { key: "VANITY_STARTUP_ANIMATION_SHOW_HISTORY" },
    });
    return { showHistory: row?.value !== "false" };
  });

  app.patch(
    "/super/vanity/animation-settings",
    superGuard,
    async (req: any, reply: any) => {
      const uid = await currentUserId(req);
      const body = (req.body ?? {}) as { showHistory?: unknown };
      const value = body.showHistory === false ? "false" : "true";
      const { prisma } = await import("../db/prisma");
      // Setting.updatedById records who made the change; Setting.updatedAt
      // is Prisma-auto-managed. Together these give a full audit trail
      // visible in the generic Settings tab.
      await prisma.setting.upsert({
        where: { key: "VANITY_STARTUP_ANIMATION_SHOW_HISTORY" },
        create: {
          key: "VANITY_STARTUP_ANIMATION_SHOW_HISTORY",
          value,
          section: "vanity",
          description:
            "When true, the app's startup typing animation stacks previously-shown vanity slugs as a muted history below the current line. When false, the history is hidden and only the current line renders.",
          updatedById: uid,
        },
        update: { value, updatedById: uid },
      });
      return { showHistory: value === "true" };
    },
  );

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

  // Delete. Refuses when other rows alias this one — the response
  // carries the dependent slugs so the UI can name them in the block
  // dialog.
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
      if (err?.code === "ALIASED_BY_OTHERS") {
        return reply.code(409).send({
          error: "aliased_by_others",
          detail: err.message,
          dependents: err.dependents ?? [],
        });
      }
      return reply.code(500).send({ error: "delete_failed", detail: String(err?.message ?? err) });
    }
  });

  // Set the default flag on a specific row (clears every other row's
  // flag in the same tx). Called by the per-row default toggle on the
  // Vanity URLs tab.
  app.patch(
    "/super/vanity/:id/default",
    superGuard,
    async (req: any, reply: any) => {
      const uid = await currentUserId(req);
      try {
        const row = await setDefaultVanityPage({ id: String(req.params.id), actorUserId: uid });
        return row;
      } catch (err: any) {
        if (err?.code === "NOT_FOUND") {
          return reply.code(404).send({ error: "not_found" });
        }
        if (err?.code === "NOT_LANDING") {
          return reply.code(409).send({ error: "not_landing", detail: err.message });
        }
        return reply.code(500).send({ error: "set_default_failed", detail: String(err?.message ?? err) });
      }
    },
  );

  // Toggle the per-row startup-animation flag. Called by the
  // sparkles button on the Vanity URLs tab. Payload: { enabled: bool }.
  app.patch(
    "/super/vanity/:id/startup-animation",
    superGuard,
    async (req: any, reply: any) => {
      const uid = await currentUserId(req);
      const body = (req.body ?? {}) as { enabled?: unknown };
      const enabled = body.enabled === true;
      try {
        const row = await setVanityStartupAnimation({
          id: String(req.params.id),
          enabled,
          actorUserId: uid,
        });
        return row;
      } catch (err: any) {
        if (err?.code === "NOT_FOUND") {
          return reply.code(404).send({ error: "not_found" });
        }
        return reply.code(500).send({ error: "update_failed", detail: String(err?.message ?? err) });
      }
    },
  );

  // Bulk reorder — payload = { orderedIds: [id1, id2, …] } listing
  // every current row in the desired display order. Stamps each with
  // sortOrder = 10, 20, 30… so future inserts have room between rows.
  app.patch(
    "/super/vanity/reorder",
    superGuard,
    async (req: any, reply: any) => {
      const uid = await currentUserId(req);
      const body = (req.body ?? {}) as { orderedIds?: unknown };
      const ids = Array.isArray(body.orderedIds)
        ? body.orderedIds.filter((s): s is string => typeof s === "string")
        : [];
      try {
        await reorderVanityPages({ actorUserId: uid, orderedIds: ids });
        return { reordered: true };
      } catch (err: any) {
        if (err?.code === "INCOMPLETE_ORDER") {
          return reply.code(400).send({ error: "incomplete_order", detail: err.message });
        }
        return reply.code(500).send({ error: "reorder_failed", detail: String(err?.message ?? err) });
      }
    },
  );

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

  // Remove the hero image from a vanity page (operator action).
  // Row's imageR2Key is nulled; R2 object is best-effort deleted.
  app.delete(
    "/super/vanity/:id/image",
    superGuard,
    async (req: any, reply: any) => {
      const uid = await currentUserId(req);
      const id = String(req.params.id);
      try {
        await clearVanityPageImage({ vanityPageId: id, actorUserId: uid });
        return { cleared: true };
      } catch (err: any) {
        if (err?.code === "NOT_FOUND") {
          return reply.code(404).send({ error: "not_found" });
        }
        return reply
          .code(500)
          .send({ error: "clear_image_failed", detail: String(err?.message ?? err) });
      }
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
