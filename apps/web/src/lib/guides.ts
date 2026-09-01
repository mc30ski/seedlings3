// Education-guide client — mirrors apps/api/src/services/guides.ts.
// Canonical spec: docs/features/education.md

import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";

export type GuideVersionStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "PUBLISHED"
  | "REJECTED"
  | "ROLLED_BACK";

export type GuideCategory = { key: string; label: string };

export type GuideListItem = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  categoryKey: string;
  tags: string[];
  isPublished: boolean;
  updatedAt: string;
  pendingVersionId?: string | null;
  draftVersionId?: string | null;
  rejectedVersionId?: string | null;
};

export type GuideVersion = {
  id: string;
  versionNumber: number;
  contentMarkdown: string;
  changeNote: string;
  status: GuideVersionStatus;
  createdAt: string;
  submittedAt: string | null;
  publishedAt: string | null;
  rejectedAt: string | null;
  rejectionNote: string | null;
  createdBy?: { displayName: string | null } | null;
  submittedBy?: { displayName: string | null } | null;
  publishedBy?: { displayName: string | null } | null;
  rejectedBy?: { displayName: string | null } | null;
};

export type GuideDetail = GuideListItem & {
  currentVersion: GuideVersion | null;
  versions?: GuideVersion[];
  createdBy?: { displayName: string | null } | null;
  archivedAt: string | null;
};

export type GuideAsset = {
  id: string;
  kind: "IMAGE" | "VIDEO";
  contentType: string;
  originalFilename: string;
  sizeBytes: number;
  altText: string | null;
  sizeOverride: boolean;
  uploadedAt: string;
  uploadedById: string;
  uploadedByName: string | null;
  canManage: boolean;
};

export type MediaLimits = {
  imageMaxBytes: number;
  videoMaxBytes: number;
  videoHardCeilingBytes: number;
  allowedTypes: string[];
  allowedEmbedDomains: string[];
};

export type PendingApproval = {
  id: string;
  versionNumber: number;
  changeNote: string;
  submittedAt: string | null;
  guide: { id: string; slug: string; title: string };
  submittedBy: { displayName: string | null } | null;
};

// ── Read (all roles) ────────────────────────────────────────────────────────

export async function fetchGuides(opts?: { q?: string; categoryKey?: string }) {
  const qs = new URLSearchParams();
  if (opts?.q) qs.set("q", opts.q);
  if (opts?.categoryKey) qs.set("categoryKey", opts.categoryKey);
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiGet<GuideListItem[]>(`/api/me/guides${suffix}`);
}

export const fetchGuideCategories = () =>
  apiGet<GuideCategory[]>("/api/me/guides/categories");

export const fetchGuide = (idOrSlug: string) =>
  apiGet<GuideDetail>(`/api/me/guides/${encodeURIComponent(idOrSlug)}`);

// ── Authoring (admin+) ──────────────────────────────────────────────────────

export const fetchMediaLimits = () => apiGet<MediaLimits>("/api/guides/limits");

/** A `guide:<slug>` cross-reference target, scoped to the caller's own
 *  visibility — a worker never gets a row for an unpublished guide. */
export type GuideLinkTarget = {
  slug: string;
  id: string;
  title: string;
  isPublished: boolean;
};

export const resolveGuideLinks = (slugs: string[]) =>
  apiGet<GuideLinkTarget[]>(
    `/api/me/guides/resolve?slugs=${encodeURIComponent(slugs.join(","))}`,
  );

/** Guides whose body links to this one. Admin+ — drives the warning shown
 *  before unpublishing or archiving. */
export const fetchInboundLinks = (idOrSlug: string) =>
  apiGet<Array<{ id: string; title: string; slug: string }>>(
    `/api/guides/${encodeURIComponent(idOrSlug)}/inbound-links`,
  );

/** Markdown for a cross-reference to another guide. */
export const guideLinkToken = (slug: string, label: string) =>
  `[${label}](guide:${slug})`;

export const createGuide = (input: {
  title: string;
  summary?: string | null;
  categoryKey: string;
  tags?: string[];
}) => apiPost<{ id: string; slug: string }>("/api/guides", input);

export const updateGuideMeta = (
  id: string,
  input: { title?: string; summary?: string | null; categoryKey?: string; tags?: string[] },
) => apiPatch<GuideListItem>(`/api/guides/${id}`, input);

export const saveDraft = (id: string, input: { contentMarkdown: string; changeNote?: string }) =>
  apiPost<GuideVersion>(`/api/guides/${id}/draft`, input);

export const submitForApproval = (versionId: string) =>
  apiPost<GuideVersion>(`/api/guides/versions/${versionId}/submit`, {});

// ── Review (super) ──────────────────────────────────────────────────────────

export const fetchPendingApprovals = () =>
  apiGet<PendingApproval[]>("/api/guides/pending-approvals");

export const fetchPendingApprovalCount = () =>
  apiGet<{ count: number }>("/api/guides/pending-approvals/count");

export const approveVersion = (versionId: string) =>
  apiPost<GuideVersion>(`/api/guides/versions/${versionId}/approve`, {});

export const rejectVersion = (versionId: string, note: string) =>
  apiPost<GuideVersion>(`/api/guides/versions/${versionId}/reject`, { note });

export const rollbackToVersion = (versionId: string) =>
  apiPost<{ ok: true }>(`/api/guides/versions/${versionId}/rollback`, {});

export const unpublishGuide = (id: string) =>
  apiPost<{ ok: true }>(`/api/guides/${id}/unpublish`, {});

export const setGuideArchived = (id: string, archived: boolean) =>
  apiPost<{ ok: true }>(`/api/guides/${id}/archive`, { archived });

export const purgeGuide = (id: string) => apiPost<{ ok: true }>(`/api/guides/${id}/purge`, {});

/** Throw away an unsubmitted draft. Returns whether the guide went with it —
 *  it does when the draft was the guide's only version. */
export const discardDraft = (versionId: string) =>
  apiDelete<{ guideDeleted: boolean }>(`/api/guides/versions/${versionId}`);

// ── Media ───────────────────────────────────────────────────────────────────

/** Paged — the library only ever grows, since assets are immutable and
 *  outlive the guides that referenced them. */
export type GuideAssetPage = {
  items: GuideAsset[];
  total: number;
  page: number;
  pageSize: number;
};

export const fetchAssets = (opts?: {
  kind?: "IMAGE" | "VIDEO";
  q?: string;
  page?: number;
  pageSize?: number;
}) => {
  const qs = new URLSearchParams();
  if (opts?.kind) qs.set("kind", opts.kind);
  if (opts?.q) qs.set("q", opts.q);
  if (opts?.page) qs.set("page", String(opts.page));
  if (opts?.pageSize) qs.set("pageSize", String(opts.pageSize));
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiGet<GuideAssetPage>(`/api/guides/assets${suffix}`);
};

export type PresignResult = {
  uploadUrl: string;
  r2Key: string;
  warning: string | null;
  requiresOverride: boolean;
};

export const presignAsset = (input: {
  filename: string;
  contentType: string;
  sizeBytes: number;
  guideId?: string | null;
  overrideSizeLimit?: boolean;
}) => apiPost<PresignResult>("/api/guides/assets/upload-url", input);

export const finalizeAsset = (input: {
  r2Key: string;
  contentType: string;
  originalFilename: string;
  altText?: string | null;
  guideId?: string | null;
}) => apiPost<GuideAsset>("/api/guides/assets/finalize", input);

export const fetchAssetReferences = (id: string) =>
  apiGet<Array<{ id: string; title: string; slug: string }>>(`/api/guides/assets/${id}/references`);

export const deleteAsset = (id: string) => apiDelete<{ ok: true }>(`/api/guides/assets/${id}`);

/** The markdown token an author inserts to reference in-app media. */
export const assetToken = (id: string) => `guide-asset:${id}`;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

/** Human label for a version's place in the workflow. */
export function statusLabel(s: GuideVersionStatus): string {
  return s === "PENDING_APPROVAL"
    ? "Pending approval"
    : s === "ROLLED_BACK"
      ? "Superseded"
      : s.charAt(0) + s.slice(1).toLowerCase();
}
