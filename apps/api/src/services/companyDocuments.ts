import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { ServiceError } from "../lib/errors";
import {
  deleteObject,
  getDownloadUrl,
  getObjectText,
  getUploadUrl,
} from "../lib/r2";

// Helpers ----------------------------------------------------------------

const DEFAULT_MAX_MB = 25;

async function getMaxSizeBytes(): Promise<number> {
  const setting = await prisma.setting.findUnique({
    where: { key: "DOCUMENT_MAX_SIZE_MB" },
  });
  const mb = Number(setting?.value);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024;
}

function slugifyFilename(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 120) || "file";
}

function expirationStatus(expiresAt: Date | null): "active" | "expiring" | "expired" {
  if (!expiresAt) return "active";
  const now = Date.now();
  const diffMs = expiresAt.getTime() - now;
  if (diffMs < 0) return "expired";
  if (diffMs <= 30 * 24 * 60 * 60 * 1000) return "expiring";
  return "active";
}

// Service ----------------------------------------------------------------

export const companyDocuments = {
  /**
   * Lists documents. `adminHiddenVisible=false` hides admin-hidden docs (for
   * Admin viewers). Filters apply on the server so counts stay accurate.
   */
  async list(params: {
    adminHiddenVisible: boolean;
    type?: string;
    status?: "active" | "expiring" | "expired" | "archived" | "all";
    q?: string;
  }) {
    const where: any = {};
    if (!params.adminHiddenVisible) where.adminHidden = false;
    if (params.type) where.type = params.type;
    if (params.status === "archived") {
      where.archivedAt = { not: null };
    } else {
      // Hide archived unless explicitly requested
      where.archivedAt = null;
      if (params.status === "expired") {
        where.expiresAt = { lt: new Date() };
      } else if (params.status === "expiring") {
        const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        where.expiresAt = { gte: new Date(), lte: in30 };
      } else if (params.status === "active") {
        where.OR = [
          { expiresAt: null },
          { expiresAt: { gt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } },
        ];
      }
    }
    if (params.q) {
      const q = params.q.trim();
      if (q) where.OR = [
        ...(where.OR ?? []),
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    const rows = await prisma.companyDocument.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }],
      include: {
        currentVersion: true,
        createdBy: { select: { id: true, displayName: true, email: true } },
        _count: { select: { versions: true } },
      },
    });
    return rows.map((r: typeof rows[number]) => ({
      ...r,
      expirationStatus: expirationStatus(r.expiresAt),
    }));
  },

  async get(id: string, opts: { adminHiddenVisible: boolean }) {
    const doc = await prisma.companyDocument.findUnique({
      where: { id },
      include: {
        currentVersion: true,
        versions: {
          orderBy: { uploadedAt: "desc" },
          include: {
            uploadedBy: { select: { id: true, displayName: true, email: true } },
          },
        },
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    if (!doc) throw new ServiceError("NOT_FOUND", "Document not found.", 404);
    if (!opts.adminHiddenVisible && doc.adminHidden) {
      throw new ServiceError("NOT_FOUND", "Document not found.", 404);
    }
    return { ...doc, expirationStatus: expirationStatus(doc.expiresAt) };
  },

  /**
   * Create the document metadata. The first version is uploaded separately
   * via `initVersion`/`confirmVersion`.
   */
  async create(
    currentUserId: string,
    payload: {
      type: string;
      title: string;
      description?: string | null;
      expiresAt?: string | null;
      adminHidden?: boolean;
    },
  ) {
    if (!payload.type) throw new ServiceError("INVALID", "type is required.", 400);
    if (!payload.title?.trim()) throw new ServiceError("INVALID", "title is required.", 400);

    // Singleton-type enforcement: if the configured type is singleton, refuse
    // when an active document of that type already exists.
    const typeCfg = await getDocumentTypeConfig(payload.type);
    if (typeCfg?.singleton) {
      const existing = await prisma.companyDocument.findFirst({
        where: { type: payload.type, archivedAt: null },
        select: { id: true },
      });
      if (existing) {
        throw new ServiceError(
          "SINGLETON_CONFLICT",
          `Only one active "${typeCfg.label}" document is allowed.`,
          409,
        );
      }
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const doc = await tx.companyDocument.create({
        data: {
          type: payload.type,
          title: payload.title.trim(),
          description: payload.description?.trim() || null,
          expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
          adminHidden: !!payload.adminHidden,
          createdById: currentUserId,
        },
      });
      await writeAudit(tx, AUDIT.DOCUMENT.CREATED, currentUserId, {
        documentId: doc.id, type: doc.type, title: doc.title,
      });
      return doc;
    });
  },

  async update(
    currentUserId: string,
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      expiresAt?: string | null;
      adminHidden?: boolean;
    },
  ) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.companyDocument.findUnique({ where: { id } });
      if (!existing) throw new ServiceError("NOT_FOUND", "Document not found.", 404);

      const data: any = {};
      if (patch.title !== undefined) data.title = patch.title.trim();
      if (patch.description !== undefined) data.description = patch.description?.trim() || null;
      if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt ? new Date(patch.expiresAt) : null;
      if (patch.adminHidden !== undefined) data.adminHidden = !!patch.adminHidden;

      const updated = await tx.companyDocument.update({ where: { id }, data });
      await writeAudit(tx, AUDIT.DOCUMENT.UPDATED, currentUserId, {
        documentId: id, changed: Object.keys(data),
      });
      return updated;
    });
  },

  async archive(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const doc = await tx.companyDocument.findUnique({ where: { id } });
      if (!doc) throw new ServiceError("NOT_FOUND", "Document not found.", 404);
      if (doc.archivedAt) throw new ServiceError("ALREADY_ARCHIVED", "Already archived.", 409);
      const updated = await tx.companyDocument.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await writeAudit(tx, AUDIT.DOCUMENT.ARCHIVED, currentUserId, { documentId: id });
      return updated;
    });
  },

  async unarchive(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const doc = await tx.companyDocument.findUnique({ where: { id } });
      if (!doc) throw new ServiceError("NOT_FOUND", "Document not found.", 404);
      if (!doc.archivedAt) throw new ServiceError("NOT_ARCHIVED", "Not archived.", 409);
      // Singleton-type re-check: bringing back an archived doc must not
      // conflict with another active doc of the same singleton type.
      const typeCfg = await getDocumentTypeConfig(doc.type);
      if (typeCfg?.singleton) {
        const conflict = await tx.companyDocument.findFirst({
          where: { type: doc.type, archivedAt: null, id: { not: id } },
          select: { id: true },
        });
        if (conflict) {
          throw new ServiceError(
            "SINGLETON_CONFLICT",
            `Another active "${typeCfg.label}" document exists. Archive it first.`,
            409,
          );
        }
      }
      const updated = await tx.companyDocument.update({
        where: { id },
        data: { archivedAt: null },
      });
      await writeAudit(tx, AUDIT.DOCUMENT.UNARCHIVED, currentUserId, { documentId: id });
      return updated;
    });
  },

  /**
   * Hard delete a document and all its versions. Purges every R2 object.
   * Only soft-deleted (archived) documents are eligible — surface forces
   * the user through archive first.
   */
  async hardDelete(currentUserId: string, id: string) {
    const doc = await prisma.companyDocument.findUnique({
      where: { id },
      include: { versions: true },
    });
    if (!doc) throw new ServiceError("NOT_FOUND", "Document not found.", 404);
    if (!doc.archivedAt) {
      throw new ServiceError(
        "MUST_ARCHIVE_FIRST",
        "Archive the document before permanently deleting it.",
        409,
      );
    }

    // Best-effort R2 cleanup before DB delete. If a purge fails we still
    // proceed — orphan keys are recoverable from a separate sweep.
    for (const v of doc.versions) {
      await deleteObject(v.r2Key, "docs").catch(() => {});
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Null out the current pointer first to dodge the FK before cascade.
      await tx.companyDocument.update({
        where: { id },
        data: { currentVersionId: null },
      });
      await tx.companyDocument.delete({ where: { id } });
      await writeAudit(tx, AUDIT.DOCUMENT.DELETED, currentUserId, {
        documentId: id, type: doc.type, title: doc.title,
        versionCount: doc.versions.length,
      });
    });
    return { ok: true };
  },

  /**
   * Returns a presigned PUT URL plus the version row's id and r2 key.
   * Client uploads directly to R2, then calls `confirmVersion`.
   */
  async initVersion(
    currentUserId: string,
    documentId: string,
    payload: { filename: string; contentType: string; sizeBytes: number },
  ) {
    const doc = await prisma.companyDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new ServiceError("NOT_FOUND", "Document not found.", 404);
    if (doc.archivedAt) {
      throw new ServiceError("ARCHIVED", "Document is archived.", 409);
    }

    const maxBytes = await getMaxSizeBytes();
    if (payload.sizeBytes > maxBytes) {
      throw new ServiceError(
        "TOO_LARGE",
        `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`,
        413,
      );
    }

    const filename = slugifyFilename(payload.filename);
    const contentType = payload.contentType || "application/octet-stream";

    // Create the version row in "pending" state — we'll mark it current on
    // confirm. Storing the row first so we have a stable id for the R2 key.
    const version = await prisma.companyDocumentVersion.create({
      data: {
        documentId,
        // Placeholder — overwritten below once we know the version id.
        r2Key: `pending-${Date.now()}`,
        contentType,
        originalFilename: payload.filename,
        sizeBytes: payload.sizeBytes,
        uploadedById: currentUserId,
      },
    });

    const r2Key = `company/${documentId}/${version.id}/${filename}`;
    await prisma.companyDocumentVersion.update({
      where: { id: version.id },
      data: { r2Key },
    });

    const uploadUrl = await getUploadUrl(r2Key, contentType, 300, "docs");
    return { uploadUrl, versionId: version.id, r2Key };
  },

  async confirmVersion(
    currentUserId: string,
    documentId: string,
    versionId: string,
    payload: { expiresAt?: string | null },
  ) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const version = await tx.companyDocumentVersion.findUnique({
        where: { id: versionId },
      });
      if (!version || version.documentId !== documentId) {
        throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      }
      const doc = await tx.companyDocument.update({
        where: { id: documentId },
        data: {
          currentVersionId: versionId,
          ...(payload.expiresAt !== undefined
            ? { expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null }
            : {}),
        },
      });
      await writeAudit(tx, AUDIT.DOCUMENT.VERSION_ADDED, currentUserId, {
        documentId, versionId,
      });
      return doc;
    });
  },

  async restoreVersion(
    currentUserId: string,
    documentId: string,
    versionId: string,
  ) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const version = await tx.companyDocumentVersion.findUnique({
        where: { id: versionId },
      });
      if (!version || version.documentId !== documentId) {
        throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      }
      const updated = await tx.companyDocument.update({
        where: { id: documentId },
        data: { currentVersionId: versionId },
      });
      await writeAudit(tx, AUDIT.DOCUMENT.VERSION_RESTORED, currentUserId, {
        documentId, versionId,
      });
      return updated;
    });
  },

  async deleteVersion(
    currentUserId: string,
    documentId: string,
    versionId: string,
  ) {
    const version = await prisma.companyDocumentVersion.findUnique({
      where: { id: versionId },
      include: { document: { select: { currentVersionId: true } } },
    });
    if (!version || version.documentId !== documentId) {
      throw new ServiceError("NOT_FOUND", "Version not found.", 404);
    }
    if (version.document.currentVersionId === versionId) {
      throw new ServiceError(
        "IS_CURRENT",
        "Cannot delete the current version. Restore a different version first.",
        409,
      );
    }

    await deleteObject(version.r2Key, "docs").catch(() => {});
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.companyDocumentVersion.delete({ where: { id: versionId } });
      await writeAudit(tx, AUDIT.DOCUMENT.VERSION_DELETED, currentUserId, {
        documentId, versionId,
      });
    });
    return { ok: true };
  },

  /**
   * Returns a presigned GET URL for a version. `mode=view` sets
   * Content-Disposition: inline (browser renders if known type);
   * `mode=download` forces a download with the original filename. For
   * admin-hidden documents, writes an audit row capturing who fetched it.
   */
  async getVersionUrl(
    currentUserId: string,
    documentId: string,
    versionId: string,
    mode: "view" | "download",
    opts: { adminHiddenVisible: boolean },
  ) {
    const version = await prisma.companyDocumentVersion.findUnique({
      where: { id: versionId },
      include: { document: true },
    });
    if (!version || version.documentId !== documentId) {
      throw new ServiceError("NOT_FOUND", "Version not found.", 404);
    }
    if (!opts.adminHiddenVisible && version.document.adminHidden) {
      throw new ServiceError("NOT_FOUND", "Version not found.", 404);
    }

    const url = await getDownloadUrl(version.r2Key, 3600, "docs", {
      mode: mode === "view" ? "inline" : "attachment",
      filename: version.originalFilename,
    });

    if (version.document.adminHidden) {
      await writeAudit(
        prisma,
        mode === "view" ? AUDIT.DOCUMENT.VIEWED : AUDIT.DOCUMENT.DOWNLOADED,
        currentUserId,
        { documentId, versionId, mode },
      );
    }

    return { url };
  },

  /**
   * Return a version's raw text content — for in-app rendering of text
   * documents (markdown, plain text). Server-side R2 fetch, so no browser
   * CORS dependency. Rejects non-text content types so a binary is never
   * streamed as a string.
   */
  async getVersionText(
    currentUserId: string,
    documentId: string,
    versionId: string,
    opts: { adminHiddenVisible: boolean },
  ): Promise<{ text: string; contentType: string; originalFilename: string }> {
    const version = await prisma.companyDocumentVersion.findUnique({
      where: { id: versionId },
      include: { document: true },
    });
    if (!version || version.documentId !== documentId) {
      throw new ServiceError("NOT_FOUND", "Version not found.", 404);
    }
    if (!opts.adminHiddenVisible && version.document.adminHidden) {
      throw new ServiceError("NOT_FOUND", "Version not found.", 404);
    }

    // Only text-ish documents may be read as text. Markdown uploads can land
    // with a variety of content types, so accept by extension too.
    const ct = (version.contentType || "").toLowerCase();
    const name = (version.originalFilename || "").toLowerCase();
    const isText =
      ct.startsWith("text/") ||
      ct === "application/octet-stream" || // common for .md uploads
      name.endsWith(".md") ||
      name.endsWith(".markdown") ||
      name.endsWith(".txt");
    if (!isText) {
      throw new ServiceError("NOT_TEXT", "This document isn't a text file.", 400);
    }

    const text = await getObjectText(version.r2Key, "docs");

    if (version.document.adminHidden) {
      await writeAudit(prisma, AUDIT.DOCUMENT.VIEWED, currentUserId, {
        documentId,
        versionId,
        mode: "view-text",
      });
    }

    return {
      text,
      contentType: version.contentType,
      originalFilename: version.originalFilename,
    };
  },

  /** Counts for the title-bar pill. */
  async expirationCounts(opts: { adminHiddenVisible: boolean }) {
    const baseWhere: any = { archivedAt: null };
    if (!opts.adminHiddenVisible) baseWhere.adminHidden = false;

    const now = new Date();
    const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const [expired, expiring] = await Promise.all([
      prisma.companyDocument.count({
        where: { ...baseWhere, expiresAt: { lt: now } },
      }),
      prisma.companyDocument.count({
        where: { ...baseWhere, expiresAt: { gte: now, lte: in30 } },
      }),
    ]);
    return { expired, expiring };
  },
};

// Doc-type config helpers ------------------------------------------------

type DocumentTypeConfig = { key: string; label: string; singleton?: boolean };

async function getDocumentTypeConfig(typeKey: string): Promise<DocumentTypeConfig | null> {
  const setting = await prisma.setting.findUnique({
    where: { key: "DOCUMENT_TYPES" },
  });
  if (!setting?.value) return null;
  try {
    const arr = JSON.parse(setting.value);
    if (!Array.isArray(arr)) return null;
    return arr.find((t: any) => t?.key === typeKey) ?? null;
  } catch {
    return null;
  }
}

/**
 * Guard for the Settings save endpoint. Blocks a `singleton: false → true`
 * flip when multiple active docs of that type already exist.
 */
export async function validateDocumentTypesUpdate(newValue: string): Promise<void> {
  let next: DocumentTypeConfig[];
  try {
    next = JSON.parse(newValue);
  } catch {
    throw new ServiceError("INVALID_JSON", "DOCUMENT_TYPES must be valid JSON.", 400);
  }
  if (!Array.isArray(next)) {
    throw new ServiceError("INVALID_SHAPE", "DOCUMENT_TYPES must be an array.", 400);
  }

  for (const t of next) {
    if (t?.singleton) {
      const count = await prisma.companyDocument.count({
        where: { type: t.key, archivedAt: null },
      });
      if (count > 1) {
        throw new ServiceError(
          "SINGLETON_CONFLICT",
          `Type "${t.label}" has ${count} active documents; cannot mark as singleton until they're archived.`,
          409,
        );
      }
    }
  }
}
