import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
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
  assetUrlByRef,
  guidesReferencing,
  resolveGuideLinks,
  guidesLinkingTo,
  deleteAsset,
  type GuideViewer,
} from "../services/guides";
import { makeGuards } from "../lib/routeGuards";
import { callerCan } from "../lib/callerCan";

// ─────────────────────────────────────────────────────────────────────────────
// Education guide routes. Canonical spec: docs/features/education.md.
//
// THE PERMISSION MATRIX IS ENFORCED HERE AND IN services/guides.ts, never
// in the client:
//   `content.view`    -> read PUBLISHED only
//   `content.manage`  -> + author drafts, submit for approval, manage OWN
//                        images
//   `content.approve` -> + approve/publish/reject/rollback/archive/purge,
//                        ALL media, and the only tier that may upload video
//
// A reader's list query is scoped by `currentVersionId is not null`, so an
// unapproved guide cannot be returned at all — hiding it client-side would
// leave the draft body in the payload.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Highest role the caller EFFECTIVELY holds.
 *
 * Reads `req.user`, which `requireApproved` attaches with the
 * impersonation-adjusted capability set — so someone who holds
 * `content.approve` while viewing as somebody who does not is a reader here
 * too, exactly as they are on every other surface. An independent
 * `prisma.user` lookup would restore their powers and make the whole view-as
 * feature lie about this tab.
 */
function guideViewer(req: any): GuideViewer {
  const me = req.user as { id: string } | undefined;
  const userId = me?.id;
  if (!userId) throw new Error("guideViewer called before requireApproved");
  // Derived from CAPABILITIES, not roles — and the two authoring tiers stay
  // SEPARATE capabilities, which is the whole point.
  //
  // An earlier pass collapsed both authoring tiers onto `content.manage` and
  // called it deliberate. It was not: education.md says "Holders of
  // `content.manage` cannot publish their own work, deliberately", and the
  // effect was that anyone who could author could also approve a pending
  // version, roll back a live guide, purge one, and upload video. The
  // service-level checks below (`viewer.kind !== "approver"`) were all still
  // correct — they were simply being handed "approver" for everybody who
  // could author.
  //
  // `content.approve` is the publishing authority; `content.manage` is
  // authoring. Keeping them distinct is what makes submit -> approve a
  // review step rather than a formality.
  if (callerCan(req, "content.approve")) return { kind: "approver", userId };
  if (callerCan(req, "content.manage")) return { kind: "author", userId };
  return { kind: "reader", userId };
}

export default async function guideRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  // These three must stay THREE entitlements. `content.approve` once
  // resolved to the same entitlement as `content.manage`, which made every
  // route needing approval reachable by anyone who could author, while the
  // guard names still claimed otherwise.
  const req_contentManage = requires("content.manage");
  const req_contentApprove = requires("content.approve");
  const req_contentView = requires("content.view");
  // ── Read surfaces (any approved caller) ────────────────────────────────

  // view-as-allow: the guide catalog is identical for every worker — there
  // is no per-user state to impersonate, so ?viewAsUserId would be a
  // parameter that changes nothing.
  app.get("/me/guides", approvedUser, async (req: any) => {
    const viewer = guideViewer(req);
    return listGuides(viewer, {
      q: typeof req.query?.q === "string" ? req.query.q : undefined,
      categoryKey:
        typeof req.query?.categoryKey === "string" ? req.query.categoryKey : undefined,
    });
  });

  // view-as-allow: see /me/guides — catalog metadata, no per-user state.
  app.get("/me/guides/categories", approvedUser, async () => listCategories());

  /**
   * Resolve `guide:<slug>` cross-reference tokens.
   *
   * Scoped by the caller's own visibility, so a worker cannot use a link
   * in an approved guide to discover an unapproved one.
   */
  // view-as-allow: resolves catalog metadata, identical for every worker.
  app.get("/me/guides/resolve", approvedUser, async (req: any) => {
    const viewer = guideViewer(req);
    const raw = typeof req.query?.slugs === "string" ? req.query.slugs : "";
    return resolveGuideLinks(viewer, raw.split(",").filter(Boolean));
  });

  // view-as-allow: see /me/guides — a single guide's content is the same
  // for every worker.
  app.get("/me/guides/:idOrSlug", approvedUser, async (req: any) => {
    const viewer = guideViewer(req);
    return getGuide(viewer, String(req.params.idOrSlug));
  });

  /** Signed URL for an in-app image or video. Any signed-in worker. */
  // view-as-allow: media is catalog content, identical for every worker.
  app.get("/me/guides/assets/:id/url", approvedUser, async (req: any) => {
    const viewer = guideViewer(req);
    return { url: await assetUrl(viewer, String(req.params.id)) };
  });

  // Resolve a markdown reference — `guide-asset:<id>` OR a bare filename like
  // `grass-id-chart.png`. The name form is what authors actually write; the id
  // form stays so existing bodies keep working.
  //
  // view-as-allow: media visibility follows the GUIDE's published state, which
  // is identical for every worker — there is no per-user state to impersonate,
  // exactly as for /me/guides/assets/:id/url above.
  //
  // GET with repeated `?ref=` params, NOT a POST body: every /me/ route is
  // read-only and the build gate enforces it. Repeated params rather than one
  // comma-joined value because a filename may legally contain a comma.
  //
  // Batched so a guide with six images is one round trip instead of six.
  app.get("/me/guides/assets/resolve", approvedUser, async (req: any) => {
    const viewer = guideViewer(req);
    const raw = (req.query ?? {}).ref;
    const refs: string[] = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
      .slice(0, 50)
      .map((r: any) => String(r));
    const out: Record<string, { id: string; url: string } | null> = {};
    await Promise.all(
      refs.map(async (ref) => {
        try {
          out[ref] = await assetUrlByRef(viewer, ref);
        } catch {
          // An unresolvable reference is a rendering problem, not a request
          // failure — the rest of the guide is still worth reading, and the
          // renderer shows a warning in place of the image.
          out[ref] = null;
        }
      }),
    );
    return { assets: out };
  });

  // ── Authoring (admin+) ─────────────────────────────────────────────────

  app.get("/guides/limits", req_contentView, async () => mediaLimits());

  app.post("/guides", req_contentManage, async (req: any) => {
    const viewer = guideViewer(req);
    return createGuide(viewer, req.body ?? {});
  });

  app.patch("/guides/:id", req_contentManage, async (req: any) => {
    const viewer = guideViewer(req);
    return updateGuideMeta(viewer, String(req.params.id), req.body ?? {});
  });

  app.post("/guides/:id/draft", req_contentManage, async (req: any) => {
    const viewer = guideViewer(req);
    return saveDraft(viewer, String(req.params.id), req.body ?? {});
  });

  // DELETE rather than POST /discard: it removes a resource and is
  // idempotent-ish (a second call 404s), which is what DELETE means.
  app.delete("/guides/versions/:versionId", req_contentManage, async (req: any) => {
    const viewer = guideViewer(req);
    return discardDraft(viewer, String(req.params.versionId));
  });

  app.post("/guides/versions/:versionId/submit", req_contentManage, async (req: any) => {
    const viewer = guideViewer(req);
    return submitForApproval(
      viewer,
      String(req.params.versionId),
      typeof req.body?.changeNote === "string" ? req.body.changeNote : undefined,
    );
  });

  // ── Review queue (super) ───────────────────────────────────────────────

  // `content.approve`, AND NOT BECAUSE OF THE ENTITLEMENT'S COPY.
  //
  // I moved these two to `content.view` on 2026-10-13 because that
  // entitlement's one-line copy said "See guides awaiting approval…". That was
  // wrong on two counts: `docs/features/education.md`'s capability table gives
  // Approve / publish / send back on `content.approve` alone, and
  // `adminrole-guides.spec.ts` asserts in so many words that someone with `content.manage` gets 403
  // from these exact paths. A one-line description does not outrank a feature
  // spec plus an explicit test. The COPY was the defect; it has been fixed.
  app.get("/guides/pending-approvals", req_contentApprove, async () => listPendingApprovals());
  app.get("/guides/pending-approvals/count", req_contentApprove, async () => ({
    count: await pendingApprovalCount(),
  }));

  app.post("/guides/versions/:versionId/approve", req_contentApprove, async (req: any) => {
    const viewer = guideViewer(req);
    return approveAndPublish(viewer, String(req.params.versionId));
  });

  app.post("/guides/versions/:versionId/reject", req_contentApprove, async (req: any) => {
    const viewer = guideViewer(req);
    return rejectVersion(viewer, String(req.params.versionId), String(req.body?.note ?? ""));
  });

  app.post("/guides/versions/:versionId/rollback", req_contentApprove, async (req: any) => {
    const viewer = guideViewer(req);
    await rollbackTo(viewer, String(req.params.versionId));
    return { ok: true };
  });

  app.post("/guides/:id/unpublish", req_contentApprove, async (req: any) => {
    const viewer = guideViewer(req);
    await unpublish(viewer, String(req.params.id));
    return { ok: true };
  });

  app.post("/guides/:id/archive", req_contentApprove, async (req: any) => {
    const viewer = guideViewer(req);
    await setArchived(viewer, String(req.params.id), req.body?.archived !== false);
    return { ok: true };
  });

  /**
   * Permanent delete. `content.approve`, archived-only, and the client gates it
   * behind a typed confirmation — the audit snapshot written by the
   * service is the only record that survives.
   */
  app.post("/guides/:id/purge", req_contentApprove, async (req: any) => {
    const viewer = guideViewer(req);
    await purge(viewer, String(req.params.id));
    return { ok: true };
  });

  // ── Media library ──────────────────────────────────────────────────────

  app.get("/guides/assets", req_contentView, async (req: any) => {
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
  app.post("/guides/assets/upload-url", req_contentManage, async (req: any) => {
    const viewer = guideViewer(req);
    return presignAssetUpload(viewer, req.body ?? {});
  });

  app.post("/guides/assets/finalize", req_contentManage, async (req: any) => {
    const viewer = guideViewer(req);
    return finalizeAsset(viewer, req.body ?? {});
  });

  /** Guides that link TO this one — drives the unpublish/archive warning. */
  app.get("/guides/:idOrSlug/inbound-links", req_contentView, async (req: any) => {
    return guidesLinkingTo(String(req.params.idOrSlug));
  });

  app.get("/guides/assets/:id/references", req_contentView, async (req: any) => {
    return guidesReferencing(String(req.params.id));
  });

  app.delete("/guides/assets/:id", req_contentManage, async (req: any) => {
    const viewer = guideViewer(req);
    await deleteAsset(viewer, String(req.params.id));
    return { ok: true };
  });
}
