import { services } from "../services";
import { prisma } from "../db/prisma";

/**
 * Helpers shared by the resource route files.
 *
 * The route layer is split by RESOURCE, one file per domain. These few
 * helpers belong to no single domain, so they live here rather than being
 * duplicated or arbitrarily assigned to one of them.
 */

/** The caller's own User.id, resolved from the verified Clerk token. */
export async function currentUserId(req: any) {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

/**
 * Whether a claimer can still edit a visit's billables — expenses and add-on
 * services.
 *
 * Editable through completion and while the visit sits in PENDING_PAYMENT
 * *before* payment is committed: claimers reconcile the evening before
 * sending the client their payment request. It locks once a payment request
 * has gone out or a payment exists, because changing the total after the
 * client has been quoted is how an invoice stops matching what was promised.
 */
export function occInEditableState(occ: {
  status: string;
  payment?: { id: string } | null;
  paymentRequestSentAt?: Date | null;
}): boolean {
  switch (occ.status) {
    case "SCHEDULED":
    case "IN_PROGRESS":
    case "PAUSED":
    case "COMPLETED":
      return true;
    case "PENDING_PAYMENT":
      return !occ.payment && !occ.paymentRequestSentAt;
    default:
      return false;
  }
}

/**
 * Next date in a recurring-expense cadence.
 *
 * date-handling-allow: recurrence — this is the documented exception in
 * docs/DATE_HANDLING.md. A cadence steps WALL-CLOCK months and years, not a
 * count of days, so `etAddDays` answers a different question: "the 1st of
 * next month" is not "31 days from now". The month-overflow clamp below is
 * why it cannot be expressed as day arithmetic at all.
 */
export function nextRecurrenceDate(d: Date, cadence: string): Date {
  const out = new Date(d);
  if (cadence === "WEEKLY") {
    out.setDate(out.getDate() + 7);
    return out;
  }
  const day = out.getDate();
  out.setDate(1);
  if (cadence === "MONTHLY") out.setMonth(out.getMonth() + 1);
  else if (cadence === "QUARTERLY") out.setMonth(out.getMonth() + 3);
  else if (cadence === "ANNUALLY") out.setFullYear(out.getFullYear() + 1);
  const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, last));
  return out;
}

/**
 * Attach current doc + version metadata to DocumentSyncQueue rows for
 * the Sync Status panel. Batch-fetches so a 500-row queue doesn't N+1.
 *
 * Key subtlety: a DELETE_DOCUMENT_VERSION task exists AFTER the version
 * row has been hard-deleted from the DB, so we can't join. The
 * `originalFilename` + `sizeBytes` fields on the row's payload are the
 * only surviving reference and are read here.
 */
export async function enrichSyncTasks(
  rows: Array<{
    id: string;
    taskType: string;
    documentId: string | null;
    versionId: string | null;
    payload: unknown;
    state: string;
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
    nextAttemptAt: Date;
  }>,
) {
  const docIds = Array.from(
    new Set(rows.map((r) => r.documentId).filter((v): v is string => !!v)),
  );
  const versionIds = Array.from(
    new Set(rows.map((r) => r.versionId).filter((v): v is string => !!v)),
  );
  const [docs, versions] = await Promise.all([
    docIds.length
      ? prisma.companyDocument.findMany({
          where: { id: { in: docIds } },
          select: {
            id: true,
            title: true,
            type: true,
            description: true,
            restricted: true,
            expiresAt: true,
            archivedAt: true,
            currentVersionId: true,
            _count: { select: { versions: true } },
          },
        })
      : Promise.resolve([] as any[]),
    versionIds.length
      ? prisma.companyDocumentVersion.findMany({
          where: { id: { in: versionIds } },
          select: {
            id: true,
            originalFilename: true,
            sizeBytes: true,
            contentType: true,
            uploadedAt: true,
          },
        })
      : Promise.resolve([] as any[]),
  ]);
  const docById = new Map(docs.map((d) => [d.id, d]));
  const versionById = new Map(versions.map((v) => [v.id, v]));

  return rows.map((r) => {
    const doc = r.documentId ? docById.get(r.documentId) ?? null : null;
    const version = r.versionId ? versionById.get(r.versionId) ?? null : null;
    const payload = (r.payload ?? null) as Record<string, unknown> | null;
    return {
      id: r.id,
      taskType: r.taskType,
      documentId: r.documentId,
      versionId: r.versionId,
      state: r.state,
      attempts: r.attempts,
      lastError: r.lastError,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      nextAttemptAt: r.nextAttemptAt,
      // Doc-level detail (null when doc no longer exists, e.g. after
      // hard delete — MOVE_TO_DELETED handles that case).
      documentTitle: doc?.title ?? null,
      documentType: doc?.type ?? null,
      documentArchived: !!doc?.archivedAt,
      documentDescription: doc?.description ?? null,
      documentRestricted: doc?.restricted ?? null,
      documentExpiresAt: doc?.expiresAt ?? null,
      documentCurrentVersionId: doc?.currentVersionId ?? null,
      documentVersionCount: doc?._count?.versions ?? null,
      // Version-level detail. UPLOAD/DELETE tasks care about this.
      // DELETE tasks: version is gone from DB by the time the worker
      // runs — payload carries the filename as a fallback.
      versionOriginalFilename:
        version?.originalFilename ??
        (typeof payload?.originalFilename === "string" ? payload.originalFilename : null),
      versionSizeBytes:
        version?.sizeBytes ??
        (typeof payload?.sizeBytes === "number" ? payload.sizeBytes : null),
      versionContentType: version?.contentType ?? null,
      versionUploadedAt: version?.uploadedAt ?? null,
      // MOVE_TO_DELETED specifics — hard-deleted doc's title lives here.
      payloadTitle:
        typeof payload?.title === "string" ? payload.title : null,
      payloadVersionCount:
        typeof payload?.versionCount === "number" ? payload.versionCount : null,
    };
  });
}
