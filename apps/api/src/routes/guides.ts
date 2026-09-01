import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Role as RoleVal } from "@prisma/client";
import {
  listCategories,
  mediaLimits,
  listGuides,
  getGuide,
  listPendingApprovals,
  pendingApprovalCount,
  createGuide,
  discardDraft,
  updateGuideMeta,
  saveDraft,
  submitForApproval,
  approveAndPublish,
  rejectVersion,
  unpublish,
  rollbackTo,
  setArchived,
  purge,
  presignAssetUpload,
  finalizeAsset,
  listAssets,
  assetUrl,
  guidesReferencing,
  resolveGuideLinks,
  guidesLinkingTo,
  deleteAsset,
  type GuideViewer,
} from "../services/guides";

// ─────────────────────────────────────────────────────────────────────────────
// Education guide routes. Canonical spec: docs/features/education.md.
//
// THE PERMISSION MATRIX IS ENFORCED HERE AND IN services/guides.ts, never
// in the client:
//   worker -> read PUBLISHED only
//   admin  -> + author drafts, submit for approval, manage OWN images
//   super  -> + approve/publish/reject/rollback/archive/purge, ALL media,
//             and the only role that may upload video
//
// A worker's list query is scoped by `currentVersionId is not null`, so an
// unapproved guide cannot be returned at all — hiding it client-side would
// leave the draft body in the payload.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Highest role the caller EFFECTIVELY holds.
 *
 * Reads `req.user`, which `requireApproved` attaches with the
 * impersonation-adjusted roles array — so a Super using "view as Worker"
 * is a worker here too, exactly as they are on every other surface. An
 * independent `prisma.user` lookup would restore their powers and make
 * the whole view-as feature lie about this tab.
 */
function guideViewer(req: any): GuideViewer {
  const me = req.user as { id: string; roles?: RoleVal[] } | undefined;
  const userId = me?.id;
  if (!userId) throw new Error("guideViewer called before requireApproved");
  const roles = new Set(me?.roles ?? []);
  if (roles.has(RoleVal.SUPER)) return { kind: "super", userId };
  if (roles.has(RoleVal.ADMIN)) return { kind: "admin", userId };
  return { kind: "worker", userId };
}

export default async function guideRoutes(app: FastifyInstance) {
  const workerGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.WORKER),
  };
  const adminGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.ADMIN),
  };
  const superGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.SUPER),
  };

  // ── Read surfaces (all roles) ──────────────────────────────────────────

  // view-as-allow: the guide catalog is identical for every worker — there
  // is no per-user state to impersonate, so ?viewAsUserId would be a
  // parameter that changes nothing.
  app.get("/me/guides", workerGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return listGuides(viewer, {
      q: typeof req.query?.q === "string" ? req.query.q : undefined,
      categoryKey:
        typeof req.query?.categoryKey === "string" ? req.query.categoryKey : undefined,
    });
  });

  // view-as-allow: see /me/guides — catalog metadata, no per-user state.
  app.get("/me/guides/categories", workerGuard, async () => listCategories());

  /**
   * Resolve `guide:<slug>` cross-reference tokens.
   *
   * Scoped by the caller's own visibility, so a worker cannot use a link
   * in an approved guide to discover an unapproved one.
   */
  // view-as-allow: resolves catalog metadata, identical for every worker.
  app.get("/me/guides/resolve", workerGuard, async (req: any) => {
    const viewer = guideViewer(req);
    const raw = typeof req.query?.slugs === "string" ? req.query.slugs : "";
    return resolveGuideLinks(viewer, raw.split(",").filter(Boolean));
  });

  // view-as-allow: see /me/guides — a single guide's content is the same
  // for every worker.
  app.get("/me/guides/:idOrSlug", workerGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return getGuide(viewer, String(req.params.idOrSlug));
  });

  /** Signed URL for an in-app image or video. Any signed-in worker. */
  // view-as-allow: media is catalog content, identical for every worker.
  app.get("/me/guides/assets/:id/url", workerGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return { url: await assetUrl(viewer, String(req.params.id)) };
  });

  // ── Authoring (admin+) ─────────────────────────────────────────────────

  app.get("/guides/limits", adminGuard, async () => mediaLimits());

  app.post("/guides", adminGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return createGuide(viewer, req.body ?? {});
  });

  app.patch("/guides/:id", adminGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return updateGuideMeta(viewer, String(req.params.id), req.body ?? {});
  });

  app.post("/guides/:id/draft", adminGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return saveDraft(viewer, String(req.params.id), req.body ?? {});
  });

  // DELETE rather than POST /discard: it removes a resource and is
  // idempotent-ish (a second call 404s), which is what DELETE means.
  app.delete("/guides/versions/:versionId", adminGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return discardDraft(viewer, String(req.params.versionId));
  });

  app.post("/guides/versions/:versionId/submit", adminGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return submitForApproval(viewer, String(req.params.versionId));
  });

  // ── Review queue (super) ───────────────────────────────────────────────

  app.get("/guides/pending-approvals", superGuard, async () => listPendingApprovals());
  app.get("/guides/pending-approvals/count", superGuard, async () => ({
    count: await pendingApprovalCount(),
  }));

  app.post("/guides/versions/:versionId/approve", superGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return approveAndPublish(viewer, String(req.params.versionId));
  });

  app.post("/guides/versions/:versionId/reject", superGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return rejectVersion(viewer, String(req.params.versionId), String(req.body?.note ?? ""));
  });

  app.post("/guides/versions/:versionId/rollback", superGuard, async (req: any) => {
    const viewer = guideViewer(req);
    await rollbackTo(viewer, String(req.params.versionId));
    return { ok: true };
  });

  app.post("/guides/:id/unpublish", superGuard, async (req: any) => {
    const viewer = guideViewer(req);
    await unpublish(viewer, String(req.params.id));
    return { ok: true };
  });

  app.post("/guides/:id/archive", superGuard, async (req: any) => {
    const viewer = guideViewer(req);
    await setArchived(viewer, String(req.params.id), req.body?.archived !== false);
    return { ok: true };
  });

  /**
   * Permanent delete. Super only, archived-only, and the client gates it
   * behind a typed confirmation — the audit snapshot written by the
   * service is the only record that survives.
   */
  app.post("/guides/:id/purge", superGuard, async (req: any) => {
    const viewer = guideViewer(req);
    await purge(viewer, String(req.params.id));
    return { ok: true };
  });

  // ── Media library ──────────────────────────────────────────────────────

  app.get("/guides/assets", adminGuard, async (req: any) => {
    const viewer = guideViewer(req);
    const n = (v: unknown) => {
      const parsed = Number(v);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
    };
    return listAssets(viewer, {
      kind: req.query?.kind === "VIDEO" ? "VIDEO" : req.query?.kind === "IMAGE" ? "IMAGE" : undefined,
      q: typeof req.query?.q === "string" ? req.query.q : undefined,
      page: n(req.query?.page),
      pageSize: n(req.query?.pageSize),
    });
  });

  /**
   * Presign a direct-to-R2 upload.
   *
   * Direct upload is what makes video possible at all — routing bytes
   * through the API would hit the serverless request-body limit. It also
   * means the size the browser declares here is advisory; the true size is
   * read back from R2 in /finalize.
   */
  app.post("/guides/assets/upload-url", adminGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return presignAssetUpload(viewer, req.body ?? {});
  });

  app.post("/guides/assets/finalize", adminGuard, async (req: any) => {
    const viewer = guideViewer(req);
    return finalizeAsset(viewer, req.body ?? {});
  });

  /** Guides that link TO this one — drives the unpublish/archive warning. */
  app.get("/guides/:idOrSlug/inbound-links", adminGuard, async (req: any) => {
    return guidesLinkingTo(String(req.params.idOrSlug));
  });

  app.get("/guides/assets/:id/references", adminGuard, async (req: any) => {
    return guidesReferencing(String(req.params.id));
  });

  app.delete("/guides/assets/:id", adminGuard, async (req: any) => {
    const viewer = guideViewer(req);
    await deleteAsset(viewer, String(req.params.id));
    return { ok: true };
  });
}
