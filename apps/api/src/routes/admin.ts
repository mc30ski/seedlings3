import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { getUploadUrl, getDownloadUrl, deleteObject } from "../lib/r2";
import { etMidnight, etEndOfDay } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { Role as RoleVal } from "@prisma/client";
import {
  JobKind,
  JobStatus,
  Cadence,
  JobOccurrenceStatus,
} from "@prisma/client";

async function currentUserId(req: any) {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

export default async function adminRoutes(app: FastifyInstance) {
  const adminGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.ADMIN),
  };
  const superGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.SUPER),
  };

  app.get("/admin/equipment", adminGuard, async () =>
    services.equipment.listAllAdmin()
  );

  app.post("/admin/equipment", adminGuard, async (req: any) =>
    services.equipment.create(await currentUserId(req), req.body)
  );

  app.patch("/admin/equipment/:id", adminGuard, async (req: any) =>
    services.equipment.update(await currentUserId(req), req.params.id, req.body)
  );

  app.post("/admin/equipment/:id/retire", adminGuard, async (req: any) =>
    services.equipment.retire(await currentUserId(req), req.params.id)
  );

  app.post("/admin/equipment/:id/unretire", adminGuard, async (req: any) =>
    services.equipment.unretire(await currentUserId(req), req.params.id)
  );

  app.delete("/admin/equipment/:id", adminGuard, async (req: any) =>
    services.equipment.hardDelete(await currentUserId(req), req.params.id)
  );

  app.post("/admin/equipment/:id/release", adminGuard, async (req: any) =>
    services.equipment.release(await currentUserId(req), req.params.id)
  );

  app.post(
    "/admin/equipment/:id/maintenance/start",
    adminGuard,
    async (req: any) =>
      services.equipment.maintenanceStart(
        await currentUserId(req),
        req.params.id
      )
  );

  app.post(
    "/admin/equipment/:id/maintenance/end",
    adminGuard,
    async (req: any) =>
      services.equipment.maintenanceEnd(await currentUserId(req), req.params.id)
  );

  app.get("/admin/holdings", adminGuard, async () => {
    return services.users.listHoldings();
  });

  app.get("/admin/audit", adminGuard, async (req: any) => {
    const q = (req.query || {}) as {
      page?: string;
      pageSize?: string;
      actorUserId?: string;
      action?: string;
      from?: string;
      to?: string;
    };
    const page = q.page ? Number(q.page) : 1;
    const pageSize = q.pageSize ? Number(q.pageSize) : 50;

    return services.audit.list({
      actorUserId: q.actorUserId || undefined,
      action: q.action || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      page,
      pageSize,
    });
  });

  app.get("/admin/users", adminGuard, async (req: any) => {
    const q = (req.query || {}) as {
      approved?: string; // "true" | "false"
      role?: RoleVal;
    };
    const approved =
      q.approved === "true" ? true : q.approved === "false" ? false : undefined;

    return services.users.list({
      approved,
      role: q.role,
    });
  });

  app.post("/admin/users/:id/approve", adminGuard, async (req: any) =>
    services.users.approve(await currentUserId(req), req.params.id)
  );

  app.post("/admin/users/:id/roles", adminGuard, async (req: any) => {
    const id = req.params.id as string;
    const role = String(req.body?.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "WORKER") {
      throw app.httpErrors.badRequest("Invalid role");
    }
    return services.users.addRole(
      await currentUserId(req),
      id,
      role as "ADMIN" | "WORKER"
    );
  });

  app.delete("/admin/users/:id/roles/:role", adminGuard, async (req: any) => {
    const id = req.params.id as string;
    const role = String(req.params.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "WORKER") {
      throw app.httpErrors.badRequest("Invalid role");
    }
    return services.users.removeRole(
      await currentUserId(req),
      id,
      role as "ADMIN" | "WORKER"
    );
  });

  app.delete("/admin/users/:id", adminGuard, async (req: any) => {
    // Hard delete a user (DB + Clerk)
    const targetId = String(req.params.id);
    const actorId = String(req.user?.id || "");
    return services.users.remove(await currentUserId(req), targetId, actorId);
  });

  app.get("/admin/users/pendingCount", adminGuard, async () => {
    return services.users.pendingApprovalCount();
  });

  app.get("/admin/activity", adminGuard, async (req: any) => {
    return services.activity.listUserActivity();
  });

  app.get("/admin/clients", adminGuard, async (req: any) => {
    const { q, status, limit } = (req.query || {}) as {
      q?: string;
      status?: "ACTIVE" | "PAUSED" | "ARCHIVED" | "ALL";
      limit?: string;
    };
    return services.clients.list({
      q,
      status: status as any,
      limit: limit ? Number(limit) : undefined,
    });
  });

  app.get("/admin/clients/:id", adminGuard, async (req: any) => {
    return services.clients.get(String(req.params.id));
  });

  app.post("/admin/clients", adminGuard, async (req: any) => {
    return services.clients.create(await currentUserId(req), req.body);
  });

  app.patch("/admin/clients/:id", adminGuard, async (req: any) => {
    return services.clients.update(
      await currentUserId(req),
      String(req.params.id),
      req.body
    );
  });

  app.post("/admin/clients/:id/pause", adminGuard, async (req: any) => {
    return services.clients.pause(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/clients/:id/unpause", adminGuard, async (req: any) => {
    return services.clients.unpause(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/clients/:id/archive", adminGuard, async (req: any) => {
    return services.clients.archive(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/clients/:id/unarchive", adminGuard, async (req: any) => {
    return services.clients.unarchive(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.delete("/admin/clients/:id", adminGuard, async (req: any) => {
    return services.clients.delete(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/clients/:id/contacts", adminGuard, async (req: any) => {
    return services.clients.addContact(
      await currentUserId(req),
      String(req.params.id),
      req.body
    );
  });

  app.patch(
    "/admin/clients/:id/contacts/:contactId",
    adminGuard,
    async (req: any) => {
      return services.clients.updateContact(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.contactId),
        req.body
      );
    }
  );

  app.post("/admin/contacts/:id/pause", adminGuard, async (req: any) => {
    return services.clients.pauseContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/contacts/:id/unpause", adminGuard, async (req: any) => {
    return services.clients.unpauseContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/contacts/:id/archive", adminGuard, async (req: any) => {
    return services.clients.archiveContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/contacts/:id/unarchive", adminGuard, async (req: any) => {
    return services.clients.unarchiveContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.delete(
    "/admin/clients/:id/contacts/:contactId",
    adminGuard,
    async (req: any) => {
      return services.clients.deleteContact(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.contactId)
      );
    }
  );

  app.post(
    "/admin/clients/:id/contacts/:contactId/primary",
    adminGuard,
    async (req: any) => {
      return services.clients.setPrimaryContact(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.contactId)
      );
    }
  );

  app.get("/admin/properties", adminGuard, async (req: any) => {
    const { q, clientId, status, kind, limit } = (req.query || {}) as {
      q?: string;
      clientId?: string;
      status?: "ACTIVE" | "PAUSED" | "ARCHIVED" | "ALL";
      kind?: string | "ALL";
      limit?: string;
    };
    const props = await services.properties.list({
      q,
      clientId,
      status: status as any,
      kind: (kind as any) ?? "ALL",
      limit: limit ? Number(limit) : undefined,
    });
    // Attach last 3 photos from most recent occurrence for each property
    const propIds = (Array.isArray(props) ? props : []).map((p: any) => p.id);
    if (propIds.length > 0) {
      const { getDownloadUrl } = await import("../lib/r2");
      const photos = await prisma.jobOccurrencePhoto.findMany({
        where: {
          occurrence: { job: { propertyId: { in: propIds } } },
        },
        select: {
          id: true, r2Key: true, contentType: true, createdAt: true,
          occurrence: { select: { job: { select: { propertyId: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
      const byProperty = new Map<string, any[]>();
      for (const p of photos) {
        const pid = p.occurrence.job?.propertyId;
        if (!pid) continue;
        if (!byProperty.has(pid)) byProperty.set(pid, []);
        const arr = byProperty.get(pid)!;
        if (arr.length < 3) arr.push(p);
      }
      for (const prop of (Array.isArray(props) ? props : []) as any[]) {
        const propPhotos = byProperty.get(prop.id) ?? [];
        prop.lastPhotos = await Promise.all(
          propPhotos.map(async (p: any) => ({
            id: p.id,
            url: await getDownloadUrl(p.r2Key),
            contentType: p.contentType,
          }))
        );
      }
    }
    return props;
  });

  app.get("/admin/properties/:id", adminGuard, async (req: any) => {
    return services.properties.get(String(req.params.id));
  });

  app.post("/admin/properties", adminGuard, async (req: any) => {
    return services.properties.create(await currentUserId(req), req.body);
  });

  app.patch("/admin/properties/:id", adminGuard, async (req: any) => {
    return services.properties.update(
      await currentUserId(req),
      String(req.params.id),
      req.body
    );
  });

  app.post("/admin/properties/:id/archive", adminGuard, async (req: any) => {
    return services.properties.archive(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/properties/:id/unarchive", adminGuard, async (req: any) => {
    return services.properties.unarchive(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.delete("/admin/properties/:id", adminGuard, async (req: any) => {
    return services.properties.hardDelete(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  // Primary contact for the property (optional)
  app.post(
    "/admin/properties/:id/primary-contact",
    adminGuard,
    async (req: any) => {
      const { contactId } = (req.body || {}) as { contactId?: string | null };
      return services.properties.setPrimaryContact(
        await currentUserId(req),
        String(req.params.id),
        contactId ?? null
      );
    }
  );

  // ── Property Photos ──────────────────────────────────────────────────────

  app.post("/admin/properties/:id/photos/upload-url", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const propertyId = String(req.params.id);
    const { fileName, contentType } = (req.body || {}) as { fileName?: string; contentType?: string };
    const name = fileName || `photo-${Date.now()}.jpg`;
    const ct = contentType || "image/jpeg";
    const key = `properties/${propertyId}/${Date.now()}-${name}`;
    const uploadUrl = await getUploadUrl(key, ct, 300, "property-photos");
    return { uploadUrl, key, contentType: ct };
  });

  app.post("/admin/properties/:id/photos/confirm", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const propertyId = String(req.params.id);
    const { key, fileName, contentType, description } = (req.body || {}) as {
      key: string; fileName?: string; contentType?: string; description?: string;
    };
    if (!key) throw app.httpErrors.badRequest("key is required");
    const count = await prisma.propertyPhoto.count({ where: { propertyId } });
    if (count >= 20) throw app.httpErrors.badRequest("Maximum 20 photos per property");
    return prisma.propertyPhoto.create({
      data: {
        propertyId,
        r2Key: key,
        fileName: fileName ?? null,
        contentType: contentType ?? null,
        description: description?.trim() || null,
        sortOrder: count,
        uploadedById: uid,
      },
    });
  });

  app.get("/admin/properties/:id/photos", adminGuard, async (req: any) => {
    const propertyId = String(req.params.id);
    const photos = await prisma.propertyPhoto.findMany({
      where: { propertyId },
      orderBy: { sortOrder: "asc" },
    });
    const withUrls = await Promise.all(
      photos.map(async (p) => ({
        ...p,
        url: await getDownloadUrl(p.r2Key, 86400, "property-photos"),
      }))
    );
    return withUrls;
  });

  app.patch("/admin/properties/:id/photos/:photoId", adminGuard, async (req: any) => {
    const photoId = String(req.params.photoId);
    const body = req.body || {};
    const data: any = {};
    if ("description" in body) data.description = body.description?.trim() || null;
    if ("sortOrder" in body) data.sortOrder = Number(body.sortOrder);
    return prisma.propertyPhoto.update({ where: { id: photoId }, data });
  });

  app.delete("/admin/properties/:id/photos/:photoId", adminGuard, async (req: any) => {
    const photoId = String(req.params.photoId);
    const photo = await prisma.propertyPhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");
    await deleteObject(photo.r2Key, "property-photos");
    await prisma.propertyPhoto.delete({ where: { id: photoId } });
    return { deleted: true };
  });

  // ── Equipment Photos ────────────────────────────────────────────────────

  app.post("/admin/equipment/:id/photos/upload-url", adminGuard, async (req: any) => {
    const equipmentId = String(req.params.id);
    const { fileName, contentType } = (req.body || {}) as { fileName?: string; contentType?: string };
    const name = fileName || `photo-${Date.now()}.jpg`;
    const ct = contentType || "image/jpeg";
    const key = `equipment/${equipmentId}/${Date.now()}-${name}`;
    const uploadUrl = await getUploadUrl(key, ct, 300, "equipment-photos");
    return { uploadUrl, key, contentType: ct };
  });

  app.post("/admin/equipment/:id/photos/confirm", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    const { key, fileName, contentType, description } = (req.body || {}) as {
      key: string; fileName?: string; contentType?: string; description?: string;
    };
    if (!key) throw app.httpErrors.badRequest("key is required");
    const count = await prisma.equipmentPhoto.count({ where: { equipmentId } });
    if (count >= 10) throw app.httpErrors.badRequest("Maximum 10 photos per equipment");
    return prisma.equipmentPhoto.create({
      data: {
        equipmentId,
        r2Key: key,
        fileName: fileName ?? null,
        contentType: contentType ?? null,
        description: description?.trim() || null,
        sortOrder: count,
        uploadedById: uid,
      },
    });
  });

  app.get("/admin/equipment/:id/photos", adminGuard, async (req: any) => {
    const equipmentId = String(req.params.id);
    const photos = await prisma.equipmentPhoto.findMany({
      where: { equipmentId },
      orderBy: { sortOrder: "asc" },
    });
    const withUrls = await Promise.all(
      photos.map(async (p) => ({
        ...p,
        url: await getDownloadUrl(p.r2Key, 86400, "equipment-photos"),
      }))
    );
    return withUrls;
  });

  app.patch("/admin/equipment/:id/photos/:photoId", adminGuard, async (req: any) => {
    const photoId = String(req.params.photoId);
    const body = req.body || {};
    const data: any = {};
    if ("description" in body) data.description = body.description?.trim() || null;
    if ("sortOrder" in body) data.sortOrder = Number(body.sortOrder);
    return prisma.equipmentPhoto.update({ where: { id: photoId }, data });
  });

  app.delete("/admin/equipment/:id/photos/:photoId", adminGuard, async (req: any) => {
    const photoId = String(req.params.photoId);
    const photo = await prisma.equipmentPhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");
    await deleteObject(photo.r2Key, "equipment-photos");
    await prisma.equipmentPhoto.delete({ where: { id: photoId } });
    return { deleted: true };
  });

  // ── Equipment Instructions (admin only) ─────────────────────────────────

  app.post("/admin/equipment/:id/instructions", adminGuard, async (req: any) => {
    const equipmentId = String(req.params.id);
    const { text, isPreset } = (req.body || {}) as { text: string; isPreset?: boolean };
    if (!text?.trim()) throw app.httpErrors.badRequest("text is required");
    const count = await prisma.equipmentInstruction.count({ where: { equipmentId } });
    return prisma.equipmentInstruction.create({
      data: { equipmentId, text: text.trim(), isPreset: !!isPreset, sortOrder: count },
    });
  });

  app.patch("/admin/equipment/:id/instructions/:instructionId", adminGuard, async (req: any) => {
    const instructionId = String(req.params.instructionId);
    const body = req.body || {};
    const data: any = {};
    if ("text" in body) data.text = String(body.text).trim();
    if ("sortOrder" in body) data.sortOrder = Number(body.sortOrder);
    return prisma.equipmentInstruction.update({ where: { id: instructionId }, data });
  });

  app.delete("/admin/equipment/:id/instructions/:instructionId", adminGuard, async (req: any) => {
    const instructionId = String(req.params.instructionId);
    await prisma.equipmentInstruction.delete({ where: { id: instructionId } });
    return { deleted: true };
  });

  // ── Job Service Default Property Photos ─────────────────────────────────

  app.get("/admin/jobs/:id/property-photos", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const links = await prisma.jobPropertyPhoto.findMany({
      where: { jobId },
      include: { propertyPhoto: true },
    });
    const withUrls = await Promise.all(
      links.map(async (l) => ({
        ...l,
        propertyPhoto: {
          ...l.propertyPhoto,
          url: await getDownloadUrl(l.propertyPhoto.r2Key, 86400, "property-photos"),
        },
      }))
    );
    return withUrls;
  });

  app.put("/admin/jobs/:id/property-photos", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const { propertyPhotoIds } = (req.body || {}) as { propertyPhotoIds: string[] };
    if (!Array.isArray(propertyPhotoIds)) throw app.httpErrors.badRequest("propertyPhotoIds must be an array");
    await prisma.jobPropertyPhoto.deleteMany({ where: { jobId } });
    if (propertyPhotoIds.length > 0) {
      await prisma.jobPropertyPhoto.createMany({
        data: propertyPhotoIds.map((propertyPhotoId) => ({ jobId, propertyPhotoId })),
        skipDuplicates: true,
      });
    }
    return { ok: true, count: propertyPhotoIds.length };
  });

  // ── Occurrence Property Photos (admin override) ─────────────────────────

  app.put("/admin/occurrences/:id/property-photos", adminGuard, async (req: any) => {
    const occurrenceId = String(req.params.id);
    const { propertyPhotoIds } = (req.body || {}) as { propertyPhotoIds: string[] };
    if (!Array.isArray(propertyPhotoIds)) throw app.httpErrors.badRequest("propertyPhotoIds must be an array");
    await prisma.occurrencePropertyPhoto.deleteMany({ where: { occurrenceId } });
    if (propertyPhotoIds.length > 0) {
      await prisma.occurrencePropertyPhoto.createMany({
        data: propertyPhotoIds.map((propertyPhotoId) => ({ occurrenceId, propertyPhotoId })),
        skipDuplicates: true,
      });
    }
    return { ok: true, count: propertyPhotoIds.length };
  });

  // ── Occurrence Add-on Services ───────────────────────────────────────────

  app.post("/admin/occurrences/:id/addons", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const { tag, customLabel, price } = (req.body || {}) as { tag?: string; customLabel?: string; price: number };
    if (price == null || price <= 0) throw app.httpErrors.badRequest("price is required and must be positive");
    if (!tag && !customLabel) throw app.httpErrors.badRequest("Either tag or customLabel is required");
    return prisma.occurrenceAddon.create({
      data: {
        occurrenceId,
        tag: tag || null,
        customLabel: customLabel?.trim() || null,
        price: Number(price),
        createdById: uid,
      },
    });
  });

  app.delete("/admin/occurrences/:id/addons/:addonId", adminGuard, async (req: any) => {
    const addonId = String(req.params.addonId);
    await prisma.occurrenceAddon.delete({ where: { id: addonId } });
    return { deleted: true };
  });

  // Jobs: list / get / create / update

  app.get("/admin/jobs", adminGuard, async (req: any) => {
    const { q, propertyId, status, kind, limit, from, to } = (req.query || {}) as {
      q?: string;
      propertyId?: string;
      status?: "PROPOSED" | "ACCEPTED" | "ALL";
      kind?: "ENTIRE_SITE" | "SINGLE_ADDRESS" | "ALL";
      limit?: string;
      from?: string;
      to?: string;
    };

    return services.jobs.list({
      q,
      propertyId,
      status: (status as any) ?? "ALL",
      kind: (kind as any) ?? "ALL",
      limit: limit ? Number(limit) : undefined,
      from,
      to,
    });
  });

  app.get("/admin/jobs/:id", adminGuard, async (req: any) => {
    return services.jobs.get(String(req.params.id));
  });

  app.post("/admin/jobs", adminGuard, async (req: any) => {
    const body = req.body || {};
    const propertyId = String(body.propertyId || "");
    const kind = String(body.kind || "").toUpperCase();
    const status = String(body.status || "").toUpperCase();

    if (!propertyId) throw app.httpErrors.badRequest("propertyId is required");
    if (kind !== "ENTIRE_SITE" && kind !== "SINGLE_ADDRESS") {
      throw app.httpErrors.badRequest("Invalid kind");
    }
    if (status && status !== "PROPOSED" && status !== "ACCEPTED" && status !== "PAUSED") {
      throw app.httpErrors.badRequest("Invalid status");
    }

    let frequencyDays: number | null = null;
    if (body.frequencyDays != null) {
      frequencyDays = Math.round(Number(body.frequencyDays));
      if (!Number.isFinite(frequencyDays) || frequencyDays < 1) {
        throw app.httpErrors.badRequest("frequencyDays must be a positive integer");
      }
    }

    return services.jobs.create(await currentUserId(req), {
      propertyId,
      kind: kind as JobKind,
      status: (status as JobStatus) || undefined,
      frequencyDays,
      description: body.description != null ? String(body.description) : null,
      notes: body.notes != null ? String(body.notes) : null,
      defaultPrice: body.defaultPrice != null ? Number(body.defaultPrice) : null,
      estimatedMinutes: body.estimatedMinutes != null ? Math.round(Number(body.estimatedMinutes)) : null,
    } as any);
  });

  app.patch("/admin/jobs/:id", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const body = req.body || {};

    const patch: any = {};
    if (body.propertyId != null) patch.propertyId = String(body.propertyId);

    if (body.kind != null) {
      const kind = String(body.kind || "").toUpperCase();
      if (kind !== "ENTIRE_SITE" && kind !== "SINGLE_ADDRESS") {
        throw app.httpErrors.badRequest("Invalid kind");
      }
      patch.kind = kind as JobKind;
    }

    if (body.status != null) {
      const status = String(body.status || "").toUpperCase();
      if (status !== "PROPOSED" && status !== "ACCEPTED" && status !== "PAUSED") {
        throw app.httpErrors.badRequest("Invalid status");
      }
      patch.status = status as JobStatus;
    }

    if ("frequencyDays" in body) {
      if (body.frequencyDays != null) {
        const fd = Math.round(Number(body.frequencyDays));
        if (!Number.isFinite(fd) || fd < 1) throw app.httpErrors.badRequest("frequencyDays must be a positive integer");
        patch.frequencyDays = fd;
      } else {
        patch.frequencyDays = null;
      }
    }
    if ("description" in body) patch.description = body.description != null ? String(body.description) : null;
    if ("notes" in body) patch.notes = body.notes != null ? String(body.notes) : null;
    if ("defaultPrice" in body) patch.defaultPrice = body.defaultPrice != null ? Number(body.defaultPrice) : null;
    if ("estimatedMinutes" in body) patch.estimatedMinutes = body.estimatedMinutes != null ? Math.round(Number(body.estimatedMinutes)) : null;

    return services.jobs.update(await currentUserId(req), id, patch);
  });

  // Default assignees for a job
  // Legacy bulk-replace (kept for backwards compatibility)
  app.put("/admin/jobs/:id/default-assignees", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const body = req.body || {};
    const userIds: string[] = Array.isArray(body.userIds) ? body.userIds.map(String) : [];

    await prisma.$transaction(async (tx) => {
      await tx.jobAssigneeDefault.deleteMany({ where: { jobId } });
      if (userIds.length > 0) {
        await tx.jobAssigneeDefault.createMany({
          data: userIds.map((uid) => ({ jobId, userId: uid })),
          skipDuplicates: true,
        });
      }
    });

    return { updated: true };
  });

  // Per-member default crew management (mirrors occurrence assignee endpoints)

  app.post("/admin/jobs/:id/default-assignees/add", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const { userId, role } = (req.body || {}) as { userId?: string; role?: string | null };
    if (!userId) throw app.httpErrors.badRequest("userId is required");

    const validRole = role === "observer" ? "observer" : null;

    const existing = await prisma.jobAssigneeDefault.findUnique({
      where: { jobId_userId: { jobId, userId } },
    });
    if (existing) {
      // Reactivate if inactive, or update role if it changed
      if (!existing.active || existing.role !== validRole) {
        await prisma.jobAssigneeDefault.update({
          where: { id: existing.id },
          data: { active: true, role: validRole },
        });
      }
      return { added: true };
    }

    await prisma.jobAssigneeDefault.create({
      data: { jobId, userId, role: validRole, active: true },
    });
    return { added: true };
  });

  app.delete("/admin/jobs/:id/default-assignees/:userId", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const userId = String(req.params.userId);

    const existing = await prisma.jobAssigneeDefault.findUnique({
      where: { jobId_userId: { jobId, userId } },
    });
    if (!existing) throw app.httpErrors.notFound("Not found");

    await prisma.jobAssigneeDefault.delete({ where: { id: existing.id } });
    return { removed: true };
  });

  app.patch("/admin/jobs/:id/default-assignees/:userId/role", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const userId = String(req.params.userId);
    const { role } = (req.body || {}) as { role?: string | null };

    const existing = await prisma.jobAssigneeDefault.findUnique({
      where: { jobId_userId: { jobId, userId } },
    });
    if (!existing) throw app.httpErrors.notFound("Not found");

    const validRole = role === "observer" ? "observer" : null;
    await prisma.jobAssigneeDefault.update({
      where: { id: existing.id },
      data: { role: validRole },
    });
    return { updated: true };
  });

  // Reassign the default-team claimer. Promotes the chosen user to first
  // (lowest sortOrder). If they were an observer, also clears that role so
  // they qualify as the claimer.
  app.post("/admin/jobs/:id/default-assignees/:userId/make-claimer", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const userId = String(req.params.userId);

    const existing = await prisma.jobAssigneeDefault.findUnique({
      where: { jobId_userId: { jobId, userId } },
    });
    if (!existing) throw app.httpErrors.notFound("Not found");

    // Find the lowest sortOrder currently in this job's defaults; we want
    // the claimer strictly less.
    const lowest = await prisma.jobAssigneeDefault.findFirst({
      where: { jobId },
      orderBy: { sortOrder: "asc" },
      select: { sortOrder: true },
    });
    const newSortOrder = (lowest?.sortOrder ?? 100) - 1;

    await prisma.jobAssigneeDefault.update({
      where: { id: existing.id },
      data: { sortOrder: newSortOrder, role: null, active: true },
    });
    return { updated: true };
  });

  // Job schedule: upsert schedule + generate occurrences

  app.put("/admin/jobs/:id/schedule", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const body = req.body || {};

    // autoRenew required for upsert in our service plan
    const autoRenew = !!body.autoRenew;

    const patch: any = { autoRenew };

    if (body.cadence != null) {
      const cadence = String(body.cadence || "").toUpperCase();
      if (
        cadence !== "WEEKLY" &&
        cadence !== "BIWEEKLY" &&
        cadence !== "MONTHLY"
      ) {
        throw app.httpErrors.badRequest("Invalid cadence");
      }
      patch.cadence = cadence as Cadence;
    }

    if (body.interval != null) {
      const interval = Number(body.interval);
      if (!Number.isFinite(interval) || interval < 1) {
        throw app.httpErrors.badRequest("interval must be >= 1");
      }
      patch.interval = interval;
    }

    if (body.dayOfWeek != null) {
      const dayOfWeek = Number(body.dayOfWeek);
      if (!Number.isFinite(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        throw app.httpErrors.badRequest("dayOfWeek must be 0-6");
      }
      patch.dayOfWeek = dayOfWeek;
    }

    if (body.dayOfMonth != null) {
      const dayOfMonth = Number(body.dayOfMonth);
      if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
        throw app.httpErrors.badRequest("dayOfMonth must be 1-31");
      }
      patch.dayOfMonth = dayOfMonth;
    }

    if (body.preferredStartHour != null) {
      const h = Number(body.preferredStartHour);
      if (!Number.isFinite(h) || h < 0 || h > 23) {
        throw app.httpErrors.badRequest("preferredStartHour must be 0-23");
      }
      patch.preferredStartHour = h;
    }

    if (body.preferredEndHour != null) {
      const h = Number(body.preferredEndHour);
      if (!Number.isFinite(h) || h < 0 || h > 23) {
        throw app.httpErrors.badRequest("preferredEndHour must be 0-23");
      }
      patch.preferredEndHour = h;
    }

    if (body.horizonDays != null) {
      const d = Number(body.horizonDays);
      if (!Number.isFinite(d) || d < 1 || d > 365) {
        throw app.httpErrors.badRequest("horizonDays must be 1-365");
      }
      patch.horizonDays = d;
    }

    if (body.active != null) patch.active = !!body.active;

    return services.jobs.upsertSchedule(await currentUserId(req), jobId, patch);
  });

  app.post(
    "/admin/jobs/:id/occurrences/generate",
    adminGuard,
    async (req: any) => {
      return services.jobs.generateOccurrences(
        await currentUserId(req),
        String(req.params.id)
      );
    }
  );

  // Occurrences: create one-off + set assignees + patch occurrence (kind/status/times)

  // Create a one-off occurrence from a job template
  app.post("/admin/jobs/:id/occurrences", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const body = req.body || {};

    const input: any = {};

    if (body.kind != null) {
      const kind = String(body.kind || "").toUpperCase();
      if (kind !== "ENTIRE_SITE" && kind !== "SINGLE_ADDRESS") {
        throw app.httpErrors.badRequest("Invalid kind");
      }
      input.kind = kind as JobKind;
    }

    if (body.workflow != null) {
      const wf = String(body.workflow).toUpperCase();
      if (wf === "STANDARD" || wf === "ONE_OFF" || wf === "ESTIMATE") input.workflow = wf;
    }
    if (body.isOneOff != null) input.isOneOff = !!body.isOneOff;
    if (body.isTentative != null) input.isTentative = !!body.isTentative;
    if (body.isEstimate != null) input.isEstimate = !!body.isEstimate;
    if (body.isAdminOnly != null) input.isAdminOnly = !!body.isAdminOnly;
    if ("jobType" in body) input.jobType = body.jobType || null;
    if ("jobTags" in body) input.jobTags = body.jobTags ? JSON.stringify(body.jobTags) : null;
    if ("pinnedNote" in body) input.pinnedNote = body.pinnedNote ? String(body.pinnedNote).trim() : null;
    if ("pinnedNoteRepeats" in body) input.pinnedNoteRepeats = !!body.pinnedNoteRepeats;
    // Dates: accept ISO strings; service should parse/validate
    if (body.startAt != null) input.startAt = body.startAt;
    if (body.endAt != null) input.endAt = body.endAt;
    if (body.notes != null) input.notes = body.notes;
    if (body.price != null) input.price = Number(body.price);
    if (body.estimatedMinutes != null) input.estimatedMinutes = Math.round(Number(body.estimatedMinutes));

    if (body.frequencyDays != null) {
      const fd = Math.round(Number(body.frequencyDays));
      if (!Number.isFinite(fd) || fd < 1) throw app.httpErrors.badRequest("frequencyDays must be a positive integer");
      input.frequencyDays = fd;
    }

    if (body.title != null) input.title = String(body.title).trim() || null;

    if (body.assigneeUserIds != null) {
      if (!Array.isArray(body.assigneeUserIds)) {
        throw app.httpErrors.badRequest("assigneeUserIds must be an array");
      }
      input.assigneeUserIds = body.assigneeUserIds.map(String);
    }

    // Validate: repeating occurrences must have a frequency somewhere
    if (input.workflow === "STANDARD") {
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { frequencyDays: true } });
      const effectiveFreq = input.frequencyDays ?? job?.frequencyDays;
      if (!effectiveFreq) {
        throw app.httpErrors.badRequest("Repeating job occurrence requires a frequency. Set it on the job or on this occurrence.");
      }
    }

    return services.jobs.createOccurrence(
      await currentUserId(req),
      jobId,
      input
    );
  });

  // Replace assignees for an occurrence (workers-only enforced in service)
  app.put(
    "/admin/occurrences/:occurrenceId/assignees",
    adminGuard,
    async (req: any) => {
      const occurrenceId = String(req.params.occurrenceId);
      const body = req.body || {};
      const ids = body.assigneeUserIds;

      if (!Array.isArray(ids)) {
        throw app.httpErrors.badRequest("assigneeUserIds must be an array");
      }

      return services.jobs.setOccurrenceAssignees(
        await currentUserId(req),
        occurrenceId,
        {
          assigneeUserIds: ids.map(String),
          assignedById: await currentUserId(req),
        }
      );
    }
  );

  // Admin: add individual assignee
  app.post("/admin/occurrences/:id/add-assignee", adminGuard, async (req: any) => {
    const body = req.body || {};
    const targetUserId = String(body.userId ?? "");
    if (!targetUserId) throw app.httpErrors.badRequest("userId is required");
    const role = body.role ? String(body.role) : null;
    return services.jobs.adminAddOccurrenceAssignee(
      await currentUserId(req),
      String(req.params.id),
      targetUserId,
      role
    );
  });

  // Admin: remove individual assignee
  app.delete("/admin/occurrences/:id/assignees/:userId", adminGuard, async (req: any) => {
    return services.jobs.adminRemoveOccurrenceAssignee(
      await currentUserId(req),
      String(req.params.id),
      String(req.params.userId)
    );
  });

  app.post("/admin/occurrences/:id/reassign-claimer", adminGuard, async (req: any) => {
    const userId = (req.body?.userId ?? "").trim();
    if (!userId) throw app.httpErrors.badRequest("userId is required");
    return services.jobs.reassignClaimer(
      await currentUserId(req),
      String(req.params.id),
      userId
    );
  });

  app.patch("/admin/occurrences/:id/assignees/:userId/role", adminGuard, async (req: any) => {
    const newRole = req.body?.role === "observer" ? "observer" : null;
    return services.jobs.changeAssigneeRole(
      await currentUserId(req),
      String(req.params.id),
      String(req.params.userId),
      newRole
    );
  });

  // ── Occurrence Linking ──

  // Link two occurrences (must share the same jobId)
  app.post("/admin/occurrences/:id/link", adminGuard, async (req: any) => {
    const occId = String(req.params.id);
    const targetId = String(req.body?.targetOccurrenceId ?? "");
    if (!targetId) throw app.httpErrors.badRequest("targetOccurrenceId is required");

    const [occ, target] = await Promise.all([
      prisma.jobOccurrence.findUnique({ where: { id: occId }, include: { job: { select: { propertyId: true } } } }),
      prisma.jobOccurrence.findUnique({ where: { id: targetId }, include: { job: { select: { propertyId: true } } } }),
    ]);
    if (!occ || !target) throw app.httpErrors.notFound("Occurrence not found");
    // Allow linking across jobs if they share the same property
    const occPropertyId = occ.job?.propertyId;
    const targetPropertyId = target.job?.propertyId;
    if (occPropertyId && targetPropertyId && occPropertyId !== targetPropertyId) {
      throw app.httpErrors.badRequest("Occurrences must belong to jobs on the same property");
    }
    if (occId === targetId) throw app.httpErrors.badRequest("Cannot link an occurrence to itself");

    // Determine group ID: merge existing groups or create new
    const crypto = require("crypto");
    let groupId = occ.linkGroupId ?? target.linkGroupId ?? crypto.randomUUID();

    // If both have different groups, merge them (move target's group to occ's group)
    if (occ.linkGroupId && target.linkGroupId && occ.linkGroupId !== target.linkGroupId) {
      await prisma.jobOccurrence.updateMany({
        where: { linkGroupId: target.linkGroupId },
        data: { linkGroupId: occ.linkGroupId },
      });
      groupId = occ.linkGroupId;
    }

    // Set groupId on both
    await prisma.jobOccurrence.updateMany({
      where: { id: { in: [occId, targetId] } },
      data: { linkGroupId: groupId },
    });

    // Sync dates — the source occurrence's startAt becomes the group date
    if (occ.startAt) {
      const syncUpdates: any = { startAt: occ.startAt };
      // Sync all other occurrences in the group to the source date
      const allInGroup = await prisma.jobOccurrence.findMany({
        where: { linkGroupId: groupId, id: { not: occId } },
      });
      for (const l of allInGroup) {
        const updates: any = { startAt: occ.startAt };
        if (l.startAt && l.endAt) {
          const duration = l.endAt.getTime() - l.startAt.getTime();
          updates.endAt = new Date(occ.startAt.getTime() + duration);
        }
        await prisma.jobOccurrence.update({ where: { id: l.id }, data: updates });
      }
    }

    return { ok: true, linkGroupId: groupId };
  });

  // Unlink an occurrence from its group
  app.post("/admin/occurrences/:id/unlink", adminGuard, async (req: any) => {
    const occId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occId } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (!occ.linkGroupId) return { ok: true };

    const groupId = occ.linkGroupId;
    await prisma.jobOccurrence.update({ where: { id: occId }, data: { linkGroupId: null } });

    // If only 1 occurrence left in the group, remove the group from it too
    const remaining = await prisma.jobOccurrence.count({ where: { linkGroupId: groupId } });
    if (remaining === 1) {
      await prisma.jobOccurrence.updateMany({ where: { linkGroupId: groupId }, data: { linkGroupId: null } });
    }

    return { ok: true };
  });

  // Get linked occurrences for an occurrence
  app.get("/admin/occurrences/:id/linked", adminGuard, async (req: any) => {
    const occId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occId } });
    if (!occ?.linkGroupId) return [];
    return prisma.jobOccurrence.findMany({
      where: { linkGroupId: occ.linkGroupId, id: { not: occId } },
      select: {
        id: true, title: true, startAt: true, endAt: true, status: true, workflow: true, jobType: true, price: true,
        job: { select: { property: { select: { displayName: true, client: { select: { displayName: true } } } } } },
      },
      orderBy: { startAt: "asc" },
    });
  });

  // Patch an occurrence (optional but very useful for admin UI)
  app.patch(
    "/admin/occurrences/:occurrenceId",
    adminGuard,
    async (req: any) => {
      const occurrenceId = String(req.params.occurrenceId);
      const body = req.body || {};

      const patch: any = {};

      if (body.kind != null) {
        const kind = String(body.kind || "").toUpperCase();
        if (kind !== "ENTIRE_SITE" && kind !== "SINGLE_ADDRESS") {
          throw app.httpErrors.badRequest("Invalid kind");
        }
        patch.kind = kind as JobKind;
      }

      if (body.status != null) {
        const st = String(body.status || "").toUpperCase();
        const ok =
          st === "SCHEDULED" ||
          st === "IN_PROGRESS" ||
          st === "COMPLETED" ||
          st === "PENDING_PAYMENT" ||
          st === "PROPOSAL_SUBMITTED" ||
          st === "ACCEPTED" ||
          st === "REJECTED" ||
          st === "CLOSED" ||
          st === "CANCELED" ||
          st === "ARCHIVED" ||
          st === "PAUSED";
        if (!ok) throw app.httpErrors.badRequest("Invalid occurrence status");
        patch.status = st as JobOccurrenceStatus;
      }

      if ("startAt" in body) patch.startAt = body.startAt || null;
      if ("endAt" in body) patch.endAt = body.endAt || null;
      if ("notes" in body) patch.notes = body.notes;
      if ("price" in body) patch.price = body.price != null ? Number(body.price) : null;
      if ("estimatedMinutes" in body) patch.estimatedMinutes = body.estimatedMinutes != null ? Math.round(Number(body.estimatedMinutes)) : null;
      if ("totalPausedMs" in body) patch.totalPausedMs = body.totalPausedMs != null ? Math.max(0, Math.round(Number(body.totalPausedMs))) : 0;
      if ("isTentative" in body) patch.isTentative = !!body.isTentative;
      if ("isEstimate" in body) patch.isEstimate = !!body.isEstimate;
      if ("isAdminOnly" in body) patch.isAdminOnly = !!body.isAdminOnly;
      if ("isClientConfirmed" in body) patch.isClientConfirmed = !!body.isClientConfirmed;
      if ("pinnedNote" in body) patch.pinnedNote = body.pinnedNote ? String(body.pinnedNote).trim() : null;
      if ("pinnedNoteRepeats" in body) patch.pinnedNoteRepeats = !!body.pinnedNoteRepeats;
      if ("jobType" in body) patch.jobType = body.jobType || null;
      if ("jobTags" in body) patch.jobTags = body.jobTags ? JSON.stringify(body.jobTags) : null;
      if ("startedAt" in body) patch.startedAt = body.startedAt || null;
      if ("completedAt" in body) patch.completedAt = body.completedAt || null;
      if ("startLat" in body) patch.startLat = body.startLat != null ? Number(body.startLat) : null;
      if ("startLng" in body) patch.startLng = body.startLng != null ? Number(body.startLng) : null;
      if ("completeLat" in body) patch.completeLat = body.completeLat != null ? Number(body.completeLat) : null;
      if ("completeLng" in body) patch.completeLng = body.completeLng != null ? Number(body.completeLng) : null;
      if ("title" in body) patch.title = body.title || null;
      if ("contactName" in body) patch.contactName = body.contactName || null;
      if ("contactPhone" in body) patch.contactPhone = body.contactPhone || null;
      if ("contactEmail" in body) patch.contactEmail = body.contactEmail || null;
      if ("estimateAddress" in body) patch.estimateAddress = body.estimateAddress || null;
      if ("proposalAmount" in body) patch.proposalAmount = body.proposalAmount != null ? Number(body.proposalAmount) : null;
      if ("frequencyDays" in body) {
        if (body.frequencyDays != null) {
          const fd = Math.round(Number(body.frequencyDays));
          if (!Number.isFinite(fd) || fd < 1) throw app.httpErrors.badRequest("frequencyDays must be a positive integer");
          patch.frequencyDays = fd;
        } else {
          patch.frequencyDays = null;
        }
      }

      if ("jobId" in body) patch.jobId = body.jobId || null;

      // You’ll want to implement services.jobs.updateOccurrence(...) OR do prisma here.
      return services.jobs.updateOccurrence(
        await currentUserId(req),
        occurrenceId,
        patch,
        { isAdmin: true }
      );
    }
  );

  // List archived jobs (paginated)
  app.get("/admin/jobs/archived", adminGuard, async (req: any) => {
    const { page, pageSize } = (req.query || {}) as {
      page?: string;
      pageSize?: string;
    };
    return services.jobs.listArchivedJobs({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  });

  // Archive an accepted job
  app.post("/admin/jobs/:id/archive", adminGuard, async (req: any) => {
    return services.jobs.archiveJob(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  // Delete a proposed job permanently
  app.delete("/admin/jobs/:id", adminGuard, async (req: any) => {
    return services.jobs.deleteJob(String(req.params.id));
  });

  // Archive a completed occurrence
  app.post(
    "/admin/occurrences/:occurrenceId/archive",
    adminGuard,
    async (req: any) => {
      return services.jobs.archiveOccurrence(
        await currentUserId(req),
        String(req.params.occurrenceId)
      );
    }
  );

  // Delete a canceled occurrence permanently
  app.delete(
    "/admin/occurrences/:occurrenceId",
    adminGuard,
    async (req: any) => {
      const occurrenceId = String(req.params.occurrenceId);
      return services.jobs.deleteOccurrence(occurrenceId);
    }
  );

  // Accept payment for an occurrence (admin)
  app.post(
    "/admin/occurrences/:occurrenceId/accept-payment",
    adminGuard,
    async (req: any) => {
      const uid = await currentUserId(req);
      const body = req.body || {};
      return services.payments.createPayment(uid, {
        occurrenceId: String(req.params.occurrenceId),
        amountPaid: Number(body.amountPaid),
        method: String(body.method || "CASH"),
        note: body.note ? String(body.note) : null,
        splits: Array.isArray(body.splits) ? body.splits : [],
      });
    }
  );

  // Recalculate payment splits based on current assignees
  app.post("/admin/occurrences/:occurrenceId/recalculate-splits", adminGuard, async (req: any) => {
    return services.payments.recalculateSplits(String(req.params.occurrenceId));
  });

  // Force-create next occurrence (admin) — bypasses duplicate guard
  app.post("/admin/occurrences/:occurrenceId/force-next", adminGuard, async (req: any) => {
    return services.payments.forceCreateNextOccurrence(
      await currentUserId(req),
      String(req.params.occurrenceId)
    );
  });

  // Update a payment (admin)
  app.patch("/admin/payments/:paymentId", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const input: any = {};
    if (body.amountPaid !== undefined) input.amountPaid = Number(body.amountPaid);
    if (body.method !== undefined) input.method = String(body.method);
    if ("note" in body) input.note = body.note ? String(body.note) : null;
    if (body.splits !== undefined) {
      if (!Array.isArray(body.splits)) throw app.httpErrors.badRequest("splits must be an array");
      input.splits = body.splits.map((sp: any) => ({
        userId: String(sp.userId),
        amount: Number(sp.amount),
      }));
    }
    return services.payments.updatePayment(uid, String(req.params.paymentId), input);
  });

  // Delete a payment (admin)
  app.delete("/admin/payments/:paymentId", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    await services.payments.deletePayment(uid, String(req.params.paymentId));
    return { ok: true };
  });

  // List all payments (admin)
  app.get("/admin/payments", adminGuard, async (req: any) => {
    const { from, to, userId, method } = (req.query || {}) as {
      from?: string;
      to?: string;
      userId?: string;
      method?: string;
    };
    return services.payments.listAllPayments({ from, to, userId, method });
  });

  app.get("/admin/payments/equipment-charges", adminGuard, async (req: any) => {
    const { from, to, userId } = (req.query || {}) as { from?: string; to?: string; userId?: string };
    return services.equipment.listEquipmentCharges({ from, to, userId });
  });

  // ── Admin Expenses ──

  app.get("/admin/occurrences/:occurrenceId/expenses", adminGuard, async (req: any) => {
    return services.expenses.listExpensesByOccurrence(String(req.params.occurrenceId));
  });

  app.post("/admin/occurrences/:occurrenceId/expenses", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    return services.expenses.adminAddExpense(uid, String(req.params.occurrenceId), {
      cost: Number(body.cost),
      description: String(body.description ?? ""),
      category: body.category != null ? String(body.category) : null,
      vendor: body.vendor != null ? String(body.vendor) : null,
      date: body.date != null ? String(body.date) : null,
    });
  });

  app.delete("/admin/expenses/:id", adminGuard, async (req: any) => {
    return services.expenses.adminDeleteExpense(String(req.params.id));
  });

  // ── Estimate Proposal Actions ──

  app.post("/admin/occurrences/:occurrenceId/accept-proposal", adminGuard, async (req: any) => {
    const occurrenceId = String(req.params.occurrenceId);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: { job: { select: { id: true, defaultPrice: true, estimatedMinutes: true } }, assignees: true },
    });

    const isEstimate = (occ as any).workflow === "ESTIMATE" || (occ as any).isEstimate;
    if (!isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be accepted.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be accepted after the team has completed them.");
    }

    // Accept the estimate with optional comment
    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: "ACCEPTED",
        notes: body.comment ? `${occ.notes ? occ.notes + "\n" : ""}Accepted: ${String(body.comment)}` : occ.notes,
      },
    });

    // Return job info so frontend can prompt to create occurrence
    return {
      accepted: true,
      jobId: occ.jobId,
      occurrence: {
        kind: occ.kind,
        startAt: occ.startAt?.toISOString() ?? null,
        endAt: occ.endAt?.toISOString() ?? null,
        notes: (occ as any).proposalNotes ?? occ.notes ?? null,
        price: (occ as any).proposalAmount ?? occ.price ?? null,
        estimatedMinutes: occ.estimatedMinutes ?? null,
        jobTags: (occ as any).jobTags ?? null,
        jobType: (occ as any).jobType ?? null,
        assignees: occ.assignees.map((a) => ({ userId: a.userId })),
      },
    };
  });

  app.post("/admin/occurrences/:occurrenceId/reject-proposal", adminGuard, async (req: any) => {
    const occurrenceId = String(req.params.occurrenceId);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } });

    const isEstimate = (occ as any).workflow === "ESTIMATE" || (occ as any).isEstimate;
    if (!isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be rejected.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be rejected after the team has completed them.");
    }

    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: "REJECTED",
        rejectionReason: body.reason ? String(body.reason) : null,
      },
    });

    return { rejected: true };
  });

  // ── Generate AI Estimate ──

  app.post("/admin/occurrences/:occurrenceId/generate-estimate", adminGuard, async (req: any) => {
    const occurrenceId = String(req.params.occurrenceId);

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: {
        job: {
          include: {
            property: {
              include: {
                client: {
                  include: {
                    contacts: { where: { status: "ACTIVE" }, orderBy: { isPrimary: "desc" } },
                  },
                },
                pointOfContact: true,
              },
            },
          },
        },
        assignees: { include: { user: { select: { displayName: true } } } },
        expenses: true,
      },
    });

    const prop = occ.job?.property;
    const client = prop?.client;
    const contact = prop?.pointOfContact ?? client?.contacts?.[0];
    const contactName = contact?.firstName ?? client?.displayName ?? "Valued Customer";

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw app.httpErrors.serviceUnavailable("Estimate generation is not configured. Add ANTHROPIC_API_KEY.");
    }

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const ai = new Anthropic({ apiKey });

    const jobTypeLabel = occ.jobType
      ? occ.jobType.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase())
      : "Lawn Care Service";

    // Fetch pricing guide for AI context
    const pricingSettings = await prisma.setting.findMany({
      where: { key: { startsWith: "pricing_" } },
    });
    const pricingGuide = pricingSettings.map((s: any) => {
      try {
        const v = JSON.parse(s.value);
        return `- ${v.label}: $${v.amount} ${v.unit} — ${v.description}`;
      } catch { return null; }
    }).filter(Boolean).join("\n");

    const details = [
      `Client: ${contactName}`,
      `Property: ${prop?.displayName ?? "N/A"}`,
      `Address: ${[prop?.street1, prop?.city, prop?.state, prop?.postalCode].filter(Boolean).join(", ")}`,
      prop?.lotSize ? `Property size: ${prop.lotSize} ${prop.lotSizeUnit ?? "sqft"}` : null,
      `Service type: ${jobTypeLabel}`,
      occ.estimatedMinutes ? `Estimated time: ${occ.estimatedMinutes} minutes` : null,
      occ.price != null ? `Quoted price: $${occ.price.toFixed(2)}` : null,
      occ.job?.frequencyDays ? `Frequency: every ${occ.job.frequencyDays} days` : "One-time service",
      occ.notes ? `Notes: ${occ.notes}` : null,
      occ.proposalNotes ? `Team notes: ${occ.proposalNotes}` : null,
      occ.proposalAmount != null ? `Team proposed amount: $${occ.proposalAmount.toFixed(2)}` : null,
      occ.expenses?.length ? `Expenses: ${occ.expenses.map((e: any) => `$${e.amount.toFixed(2)} (${e.description})`).join(", ")}` : null,
      prop?.accessNotes ? `Access notes: ${prop.accessNotes}` : null,
    ].filter(Boolean).join("\n");

    const prompt = `You are estimating a lawn care job for Seedlings Lawn Care. Produce two outputs as JSON.

Job info:
${details}
${pricingGuide ? `\nCompany pricing guide (use these rates as your baseline):\n${pricingGuide}\n` : ""}
STEP 1 — INTERNAL BREAKDOWN (for business eyes only):
- Use the company pricing guide rates as your baseline where applicable
- Use the address to determine local market rates for the area (materials, labor, delivery)
- If the notes contain measurements, square footage, material quantities (e.g. yards of mulch), use those exact numbers
- Itemize: materials (with per-unit costs), delivery, labor (hours × rate), additional services
- Show subtotal of costs
- Add 20% business margin (covers overhead, insurance, taxes, profit)
- Show final client-facing price
- If upgrade options are mentioned, calculate those too with the same margin
- Be specific with numbers and sources of rates

STEP 2 — CLIENT MESSAGE:
- Address client as ${contactName}
- Plain text only, no markdown, no subject line
- State the total price clearly as a single number — do NOT itemize costs or mention margin
- Briefly list what's included in the service
- If the notes mention upgrade options (e.g. thicker depth), mention the approximate price for that too
- Add one line: final price may vary slightly based on actual conditions on-site
- NEVER offer discounts or reduced pricing
- End with a short invite to confirm
- Sign off as "Seedlings Lawn Care"
- Keep it concise

Respond ONLY with valid JSON in this exact format:
{"breakdown": "the internal cost breakdown text", "message": "the client-facing message text"}
12. Do NOT use markdown formatting — plain text only`;

    try {
      const response = await ai.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");

      // Parse JSON response
      let message = text;
      let breakdown = "";
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          message = parsed.message || text;
          breakdown = parsed.breakdown || "";
        }
      } catch {}

      // Save to the occurrence
      await prisma.jobOccurrence.update({
        where: { id: occurrenceId },
        data: {
          generatedEstimate: message,
          generatedEstimateBreakdown: breakdown,
        },
      });

      return { estimate: message, breakdown };
    } catch (err: any) {
      throw app.httpErrors.internalServerError(`Estimate generation failed: ${err.message}`);
    }
  });

  // ── Worker Type & Compliance ──

  app.get("/admin/users/:id", adminGuard, async (req: any) => {
    const userId = String(req.params.id);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true, email: true, phone: true, firstName: true, lastName: true, displayName: true, workerType: true, homeBaseAddress: true, availableDays: true, availableHoursPerDay: true,
        isApproved: true, insuranceExpiresAt: true, contractorAgreedAt: true, w9Collected: true,
      },
    });
    return user;
  });

  app.patch("/admin/users/:id/worker-type", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const userId = String(req.params.id);
    const body = req.body || {};
    if (body.workerType === null || body.workerType === "") {
      await services.users.setWorkerType(uid, userId, null);
      return { ok: true };
    }
    const wt = String(body.workerType).toUpperCase();
    if (wt !== "EMPLOYEE" && wt !== "CONTRACTOR" && wt !== "TRAINEE") {
      throw app.httpErrors.badRequest("workerType must be EMPLOYEE, CONTRACTOR, or TRAINEE");
    }
    await services.users.setWorkerType(uid, userId, wt);
    return { ok: true };
  });

  app.patch("/admin/users/:id/w9", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const userId = String(req.params.id);
    const body = req.body || {};
    await services.users.setW9Collected(uid, userId, !!body.collected);
    return { ok: true };
  });

  // Per-user privilege overrides. Body shape:
  //   { canPullInventory?: true|false|null, canChargeBusinessExpenses?: true|false|null }
  // null = clear override (use workerType default); true/false = explicit grant/deny;
  // omit a key to leave it alone. Audit captures before/after.
  app.patch("/admin/users/:id/privileges", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const userId = String(req.params.id);
    const body = req.body || {};
    const overrides: { canPullInventory?: boolean | null; canChargeBusinessExpenses?: boolean | null } = {};
    function readTri(key: "canPullInventory" | "canChargeBusinessExpenses") {
      if (!(key in body)) return;
      const v = body[key];
      if (v === null || v === true || v === false) {
        overrides[key] = v;
        return;
      }
      throw app.httpErrors.badRequest(`${key} must be true, false, or null`);
    }
    readTri("canPullInventory");
    readTri("canChargeBusinessExpenses");
    await services.users.setPrivilegeOverrides(uid, userId, overrides);
    return { ok: true };
  });

  app.patch("/admin/users/:id/home-base", adminGuard, async (req: any) => {
    const userId = String(req.params.id);
    const body = req.body || {};
    await prisma.user.update({
      where: { id: userId },
      data: { homeBaseAddress: body.address != null ? String(body.address).trim() || null : null },
    });
    return { ok: true };
  });

  app.get("/admin/users/:id/earnings-summary", adminGuard, async (req: any) => {
    const userId = String(req.params.id);
    const now = new Date();
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay()); startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const splits = await prisma.paymentSplit.findMany({
      where: { userId },
      include: { payment: { select: { createdAt: true, method: true } } },
    });

    let thisWeek = 0, thisMonth = 0, thisYear = 0, allTime = 0;
    const byMethod: Record<string, number> = {};
    let jobCount = 0;

    for (const sp of splits) {
      allTime += sp.amount;
      const d = sp.payment.createdAt;
      if (d >= startOfWeek) thisWeek += sp.amount;
      if (d >= startOfMonth) thisMonth += sp.amount;
      if (d >= startOfYear) thisYear += sp.amount;
      byMethod[sp.payment.method] = (byMethod[sp.payment.method] ?? 0) + sp.amount;
      jobCount++;
    }

    return {
      thisWeek: Math.round(thisWeek * 100) / 100,
      thisMonth: Math.round(thisMonth * 100) / 100,
      thisYear: Math.round(thisYear * 100) / 100,
      allTime: Math.round(allTime * 100) / 100,
      jobCount,
      byMethod,
    };
  });

  app.patch("/admin/users/:id/profile", adminGuard, async (req: any) => {
    const userId = String(req.params.id);
    const body = req.body || {};
    const data: any = {};
    if (body.homeBaseAddress !== undefined) data.homeBaseAddress = body.homeBaseAddress ? String(body.homeBaseAddress).trim() : null;
    if (body.availableDays !== undefined) data.availableDays = Array.isArray(body.availableDays) ? JSON.stringify(body.availableDays) : null;
    if (body.availableHoursPerDay !== undefined) data.availableHoursPerDay = body.availableHoursPerDay != null ? Number(body.availableHoursPerDay) : null;
    if (body.phone !== undefined) data.phone = body.phone ? String(body.phone).trim() : null;
    if (body.firstName !== undefined) data.firstName = body.firstName ? String(body.firstName).trim() : null;
    if (body.lastName !== undefined) data.lastName = body.lastName ? String(body.lastName).trim() : null;
    if (body.displayName !== undefined) data.displayName = body.displayName ? String(body.displayName).trim() : null;
    await prisma.user.update({ where: { id: userId }, data });
    return { ok: true };
  });

  // ── Worker Statistics ──

  app.get("/admin/statistics", adminGuard, async (req: any) => {
    const from = req.query?.from as string | undefined;
    const to = req.query?.to as string | undefined;

    const dateFilter: any = {};
    if (from) dateFilter.gte = etMidnight(from);
    if (to) dateFilter.lte = etEndOfDay(to);
    const hasDate = from || to;

    // Get all closed occurrences with assignees, payment splits, timing
    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["CLOSED", "PENDING_PAYMENT"] },
        ...(hasDate ? { completedAt: dateFilter } : {}),
      },
      select: {
        id: true,
        status: true,
        kind: true,
        startedAt: true,
        completedAt: true,
        estimatedMinutes: true,
        price: true,
        workflow: true,
        isEstimate: true,
        startAt: true,
        assignees: {
          select: {
            userId: true,
            user: { select: { id: true, displayName: true, email: true, workerType: true } },
          },
        },
        payment: {
          select: {
            amountPaid: true,
            method: true,
            platformFeeAmount: true,
            businessMarginAmount: true,
            splits: {
              select: { userId: true, amount: true },
            },
          },
        },
        expenses: {
          select: { cost: true },
        },
        job: {
          select: {
            property: { select: { id: true, displayName: true, city: true } },
          },
        },
      },
      orderBy: { completedAt: "desc" },
    });

    // Get all workers
    const workers = await prisma.user.findMany({
      where: {
        isApproved: true,
        roles: { some: { role: "WORKER" } },
      },
      select: { id: true, displayName: true, email: true, workerType: true },
    });

    // Build per-worker stats
    type WorkerStat = {
      userId: string;
      displayName: string;
      workerType: string | null;
      jobsCompleted: number;
      totalEarnings: number;
      totalExpenses: number;
      netEarnings: number;
      totalActualMinutes: number;
      totalEstimatedMinutes: number;
      jobsWithTiming: number;
      avgActualMinutes: number;
      avgEstimatedMinutes: number;
      efficiencyPercent: number | null; // estimated/actual * 100
      propertiesServiced: number;
      paymentMethods: Record<string, number>;
      jobsByDay: Record<string, number>; // YYYY-MM-DD -> count
    };

    const statsMap = new Map<string, WorkerStat>();

    for (const w of workers) {
      statsMap.set(w.id, {
        userId: w.id,
        displayName: w.displayName ?? w.email ?? w.id,
        workerType: w.workerType,
        jobsCompleted: 0,
        totalEarnings: 0,
        totalExpenses: 0,
        netEarnings: 0,
        totalActualMinutes: 0,
        totalEstimatedMinutes: 0,
        jobsWithTiming: 0,
        avgActualMinutes: 0,
        avgEstimatedMinutes: 0,
        efficiencyPercent: null,
        propertiesServiced: 0,
        paymentMethods: {},
        jobsByDay: {},
      });
    }

    const propertySetMap = new Map<string, Set<string>>();

    for (const occ of occurrences) {
      if (occ.workflow === "ESTIMATE" || occ.isEstimate) continue;

      const actualMinutes = occ.startedAt && occ.completedAt
        ? Math.round((new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000)
        : null;

      const expenseTotal = occ.expenses.reduce((s, e) => s + e.cost, 0);
      const dayKey = occ.completedAt ? occ.completedAt.toISOString().slice(0, 10) : null;
      const propId = occ.job?.property?.id;

      for (const a of occ.assignees) {
        let stat = statsMap.get(a.userId);
        if (!stat) continue;

        stat.jobsCompleted++;

        // Earnings from splits
        const split = occ.payment?.splits.find((s) => s.userId === a.userId);
        if (split) {
          const splitRatio = occ.payment && occ.payment.splits.length > 0
            ? split.amount / occ.payment.splits.reduce((s, sp) => s + sp.amount, 0)
            : 1;
          const expenseShare = expenseTotal * splitRatio;
          stat.totalEarnings += split.amount;
          stat.totalExpenses += expenseShare;
          stat.netEarnings += split.amount - expenseShare;
        }

        // Timing
        if (actualMinutes != null && actualMinutes > 0) {
          stat.totalActualMinutes += actualMinutes;
          stat.jobsWithTiming++;
        }
        if (occ.estimatedMinutes) {
          stat.totalEstimatedMinutes += occ.estimatedMinutes;
        }

        // Payment method
        if (occ.payment?.method) {
          stat.paymentMethods[occ.payment.method] = (stat.paymentMethods[occ.payment.method] || 0) + 1;
        }

        // Jobs by day
        if (dayKey) {
          stat.jobsByDay[dayKey] = (stat.jobsByDay[dayKey] || 0) + 1;
        }

        // Properties
        if (propId) {
          if (!propertySetMap.has(a.userId)) propertySetMap.set(a.userId, new Set());
          propertySetMap.get(a.userId)!.add(propId);
        }
      }
    }

    // Finalize averages
    const results: WorkerStat[] = [];
    for (const stat of statsMap.values()) {
      stat.propertiesServiced = propertySetMap.get(stat.userId)?.size ?? 0;
      if (stat.jobsWithTiming > 0) {
        stat.avgActualMinutes = Math.round(stat.totalActualMinutes / stat.jobsWithTiming);
      }
      if (stat.jobsCompleted > 0 && stat.totalEstimatedMinutes > 0) {
        stat.avgEstimatedMinutes = Math.round(stat.totalEstimatedMinutes / stat.jobsCompleted);
      }
      if (stat.totalActualMinutes > 0 && stat.totalEstimatedMinutes > 0) {
        stat.efficiencyPercent = Math.round((stat.totalEstimatedMinutes / stat.totalActualMinutes) * 100);
      }
      stat.totalEarnings = Math.round(stat.totalEarnings * 100) / 100;
      stat.totalExpenses = Math.round(stat.totalExpenses * 100) / 100;
      stat.netEarnings = Math.round(stat.netEarnings * 100) / 100;
      results.push(stat);
    }

    // Sort by jobs completed desc
    results.sort((a, b) => b.jobsCompleted - a.jobsCompleted);

    // Days with jobs for "jobs per day" calc
    const allDays = new Set<string>();
    for (const stat of results) {
      for (const d of Object.keys(stat.jobsByDay)) allDays.add(d);
    }

    return {
      workers: results,
      totalOccurrences: occurrences.filter((o) => o.workflow !== "ESTIMATE" && !o.isEstimate).length,
      daysInRange: allDays.size,
    };
  });

  // ── Admin Photos ──

  // List photos across all jobs with optional date range
  app.get("/admin/photos", adminGuard, async (req: any) => {
    const { from, to } = (req.query || {}) as { from?: string; to?: string };

    const where: any = {};
    if (from || to) {
      where.occurrence = { startAt: {} };
      if (from) where.occurrence.startAt.gte = etMidnight(from);
      if (to) where.occurrence.startAt.lte = etEndOfDay(to);
    }

    const photos = await prisma.jobOccurrencePhoto.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        uploadedBy: { select: { id: true, displayName: true } },
        occurrence: {
          select: {
            id: true,
            startAt: true,
            status: true,
            jobType: true,
            job: {
              select: {
                id: true,
                kind: true,
                property: {
                  select: { id: true, displayName: true, street1: true, city: true, state: true },
                },
              },
            },
          },
        },
      },
    });

    return Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        fileName: p.fileName,
        contentType: p.contentType,
        uploadedBy: p.uploadedBy,
        createdAt: p.createdAt,
        url: await getDownloadUrl(p.r2Key),
        occurrence: {
          id: p.occurrence.id,
          startAt: p.occurrence.startAt,
          status: p.occurrence.status,
          jobType: p.occurrence.jobType,
          property: p.occurrence.job?.property
            ? {
                displayName: p.occurrence.job.property.displayName,
                address: [p.occurrence.job.property.street1, p.occurrence.job.property.city, p.occurrence.job.property.state].filter(Boolean).join(", "),
              }
            : null,
        },
      }))
    );
  });

  app.get("/admin/occurrences/:occurrenceId/photos", adminGuard, async (req: any) => {
    const occurrenceId = String(req.params.occurrenceId);

    const photos = await prisma.jobOccurrencePhoto.findMany({
      where: { occurrenceId },
      orderBy: { createdAt: "asc" },
      include: { uploadedBy: { select: { id: true, displayName: true } } },
    });

    return Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        fileName: p.fileName,
        contentType: p.contentType,
        uploadedBy: p.uploadedBy,
        createdAt: p.createdAt,
        url: await getDownloadUrl(p.r2Key),
      }))
    );
  });

  app.delete("/admin/photos/:id", adminGuard, async (req: any) => {
    const photoId = String(req.params.id);

    const photo = await prisma.jobOccurrencePhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");

    await deleteObject(photo.r2Key);
    await prisma.jobOccurrencePhoto.delete({ where: { id: photoId } });

    return { ok: true };
  });

  // ── Operations Dashboard ──

  app.get("/admin/operations", adminGuard, async (req: any) => {
    const { from, to } = (req.query || {}) as { from?: string; to?: string };
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    const dateFrom = from ? etMidnight(from) : etMidnight(todayKey);
    const dateTo = to ? etEndOfDay(to) : etEndOfDay(todayKey);

    // Jobs summary
    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        workflow: { notIn: ["TASK"] },
        OR: [
          { startAt: { gte: dateFrom, lte: dateTo } },
          { completedAt: { gte: dateFrom, lte: dateTo } },
        ],
      },
      include: {
        assignees: { select: { userId: true, role: true } },
        payment: { include: { splits: true } },
        expenses: true,
      },
    });

    const jobsScheduled = occurrences.filter((o) => o.status === "SCHEDULED").length;
    const jobsInProgress = occurrences.filter((o) => o.status === "IN_PROGRESS").length;
    const jobsCompleted = occurrences.filter((o) => o.status === "CLOSED" || o.status === "PENDING_PAYMENT").length;
    const jobsCanceled = occurrences.filter((o) => o.status === "CANCELED").length;

    const todayMidnight = etMidnight(todayKey);
    const jobsOverdue = occurrences.filter((o) =>
      o.status === "SCHEDULED" && o.startAt && o.startAt < todayMidnight
    ).length;

    const nonJobWorkflows = new Set(["ESTIMATE", "TASK", "REMINDER", "EVENT", "FOLLOWUP", "ANNOUNCEMENT"]);
    const jobsUnclaimed = occurrences.filter((o) =>
      o.status === "SCHEDULED" &&
      !nonJobWorkflows.has(o.workflow ?? "") &&
      !o.isEstimate &&
      o.assignees.filter((a) => a.role !== "observer").length === 0
    ).length;

    // Financial summary
    const paidOccs = occurrences.filter((o) => o.payment);
    const totalRevenue = paidOccs.reduce((s, o) => s + (o.payment?.amountPaid ?? 0), 0);
    const totalExpenses = occurrences.reduce((s, o) => s + o.expenses.reduce((es, e) => es + e.cost, 0), 0);
    const netRevenue = totalRevenue - totalExpenses;
    const totalPlatformFees = paidOccs.reduce((s, o) => s + (o.payment?.platformFeeAmount ?? 0), 0);
    const totalBusinessMargin = paidOccs.reduce((s, o) => s + (o.payment?.businessMarginAmount ?? 0), 0);
    const avgJobPrice = jobsCompleted > 0 ? totalRevenue / jobsCompleted : 0;

    const paymentsByMethod: Record<string, number> = {};
    for (const o of paidOccs) {
      const m = o.payment?.method ?? "OTHER";
      paymentsByMethod[m] = (paymentsByMethod[m] ?? 0) + (o.payment?.amountPaid ?? 0);
    }

    // Team summary
    const workers = await prisma.user.findMany({
      where: { isApproved: true, roles: { some: { role: "WORKER" } } },
      select: { id: true, displayName: true, workerType: true },
    });

    const workersByType: Record<string, number> = {};
    for (const w of workers) {
      const t = w.workerType ?? "UNASSIGNED";
      workersByType[t] = (workersByType[t] ?? 0) + 1;
    }

    // Top workers by jobs completed in range
    const workerJobCounts = new Map<string, { name: string; jobs: number; earnings: number }>();
    for (const o of occurrences.filter((oc) => oc.status === "CLOSED" || oc.status === "PENDING_PAYMENT")) {
      for (const a of o.assignees.filter((as_) => as_.role !== "observer")) {
        const existing = workerJobCounts.get(a.userId) ?? { name: "", jobs: 0, earnings: 0 };
        existing.jobs++;
        const split = o.payment?.splits?.find((sp) => sp.userId === a.userId);
        if (split) existing.earnings += split.amount;
        workerJobCounts.set(a.userId, existing);
      }
    }
    // Fill in names
    for (const w of workers) {
      const wc = workerJobCounts.get(w.id);
      if (wc) wc.name = w.displayName ?? "Unknown";
    }
    const topWorkers = [...workerJobCounts.values()]
      .sort((a, b) => b.jobs - a.jobs)
      .slice(0, 5);

    const workersWithJobs = new Set(occurrences.flatMap((o) => o.assignees.filter((a) => a.role !== "observer").map((a) => a.userId)));
    const workersIdle = workers.filter((w) => !workersWithJobs.has(w.id)).length;

    // Equipment summary
    const equipmentCounts = await prisma.equipment.groupBy({
      by: ["status"],
      where: { retiredAt: null },
      _count: true,
    });
    const eqMap: Record<string, number> = {};
    let totalEquipment = 0;
    for (const ec of equipmentCounts) {
      eqMap[ec.status] = ec._count;
      totalEquipment += ec._count;
    }

    // Estimates summary
    const estimates = await prisma.jobOccurrence.groupBy({
      by: ["status"],
      where: {
        workflow: "ESTIMATE",
        startAt: { gte: dateFrom, lte: dateTo },
      },
      _count: true,
    });
    const estMap: Record<string, number> = {};
    for (const e of estimates) estMap[e.status] = e._count;

    // Client summary
    const clientCounts = await prisma.client.groupBy({
      by: ["status"],
      _count: true,
    });
    const clientMap: Record<string, number> = {};
    for (const cc of clientCounts) clientMap[cc.status] = cc._count;
    const vipClients = await prisma.client.count({ where: { isVip: true, status: "ACTIVE" } });

    // Recent audit events
    const recentAudit = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { actor: { select: { displayName: true } } },
    });

    // Unclaimed jobs list (for inline display)
    const unclaimedList = occurrences
      .filter((o) =>
        o.status === "SCHEDULED" &&
        !nonJobWorkflows.has(o.workflow ?? "") &&
        !o.isEstimate &&
        o.assignees.filter((a) => a.role !== "observer").length === 0
      )
      .sort((a, b) => (a.startAt?.getTime() ?? 0) - (b.startAt?.getTime() ?? 0));

    // Fetch property/client data for unclaimed jobs
    const unclaimedJobIds = [...new Set(unclaimedList.map((o) => o.jobId).filter(Boolean))] as string[];
    const unclaimedJobs = unclaimedJobIds.length > 0
      ? await prisma.job.findMany({
          where: { id: { in: unclaimedJobIds } },
          include: { property: { select: { displayName: true, street1: true, city: true, state: true, client: { select: { displayName: true } } } } },
        })
      : [];
    const jobMap = new Map(unclaimedJobs.map((j) => [j.id, j]));

    const unclaimedItems = unclaimedList.map((o) => {
      const job = o.jobId ? jobMap.get(o.jobId) : null;
      return {
        id: o.id,
        jobId: o.jobId,
        startAt: o.startAt?.toISOString() ?? null,
        jobType: o.jobType,
        price: o.price,
        property: job?.property?.displayName ?? null,
        client: job?.property?.client?.displayName ?? null,
        address: [job?.property?.street1, job?.property?.city, job?.property?.state].filter(Boolean).join(", "),
      };
    });

    // Per-worker stats for comparison
    const allWorkerStats = workers.map((w) => {
      const wJobs = occurrences.filter((o) =>
        (o.status === "CLOSED" || o.status === "PENDING_PAYMENT") &&
        o.assignees.some((a) => a.userId === w.id && a.role !== "observer")
      );
      const totalEarnings = wJobs.reduce((s, o) => {
        const split = o.payment?.splits?.find((sp) => sp.userId === w.id);
        return s + (split?.amount ?? 0);
      }, 0);
      const totalExpensesW = wJobs.reduce((s, o) => {
        const occExpenses = o.expenses.reduce((es, e) => es + e.cost, 0);
        const assigneeCount = o.assignees.filter((a) => a.role !== "observer").length;
        return s + (assigneeCount > 0 ? occExpenses / assigneeCount : 0);
      }, 0);
      const totalActualMin = wJobs.reduce((s, o) => {
        if (o.startedAt && o.completedAt) {
          return s + (o.completedAt.getTime() - o.startedAt.getTime()) / 60000;
        }
        return s;
      }, 0);
      const totalEstMin = wJobs.reduce((s, o) => s + (o.estimatedMinutes ?? 0), 0);
      const scheduledJobs = occurrences.filter((o) =>
        o.status === "SCHEDULED" &&
        o.assignees.some((a) => a.userId === w.id && a.role !== "observer")
      ).length;

      return {
        id: w.id,
        name: w.displayName ?? "Unknown",
        workerType: w.workerType,
        jobsCompleted: wJobs.length,
        scheduledJobs,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        totalExpenses: Math.round(totalExpensesW * 100) / 100,
        netEarnings: Math.round((totalEarnings - totalExpensesW) * 100) / 100,
        totalActualMinutes: Math.round(totalActualMin),
        totalEstimatedMinutes: Math.round(totalEstMin),
        efficiency: totalActualMin > 0 ? Math.round((totalEstMin / totalActualMin) * 100) : 0,
      };
    }).sort((a, b) => b.jobsCompleted - a.jobsCompleted);

    return {
      jobs: {
        scheduled: jobsScheduled,
        inProgress: jobsInProgress,
        completed: jobsCompleted,
        canceled: jobsCanceled,
        overdue: jobsOverdue,
        unclaimed: jobsUnclaimed,
      },
      financial: {
        totalRevenue,
        totalExpenses,
        netRevenue,
        totalPlatformFees,
        totalBusinessMargin,
        avgJobPrice,
        paymentsByMethod,
      },
      team: {
        activeWorkers: workers.length,
        workersByType,
        topWorkers,
        workersWithJobs: workersWithJobs.size,
        workersIdle,
      },
      equipment: {
        total: totalEquipment,
        available: eqMap["AVAILABLE"] ?? 0,
        checkedOut: eqMap["CHECKED_OUT"] ?? 0,
        reserved: eqMap["RESERVED"] ?? 0,
        inMaintenance: eqMap["MAINTENANCE"] ?? 0,
      },
      estimates: {
        pending: estMap["PROPOSAL_SUBMITTED"] ?? 0,
        accepted: estMap["ACCEPTED"] ?? 0,
        rejected: estMap["REJECTED"] ?? 0,
      },
      clients: {
        active: clientMap["ACTIVE"] ?? 0,
        paused: clientMap["PAUSED"] ?? 0,
        archived: clientMap["ARCHIVED"] ?? 0,
        vip: vipClients,
      },
      unclaimedItems,
      workerStats: allWorkerStats,
      recentAudit: recentAudit.map((a) => ({
        id: a.id,
        scope: a.scope,
        verb: a.verb,
        action: a.action,
        actorName: a.actor?.displayName ?? "System",
        createdAt: a.createdAt,
        metadata: a.metadata,
      })),
    };
  });

  // ── Settings ──

  app.get("/admin/settings", adminGuard, async () => {
    return services.settings.getAll();
  });

  app.patch("/admin/settings/:key", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const key = String(req.params.key);
    const body = req.body || {};
    if (body.value === undefined) throw app.httpErrors.badRequest("value is required");
    return services.settings.set(uid, key, String(body.value));
  });

  // ── Tasks ──

  app.post("/admin/tasks", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createTask(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      linkedOccurrenceId: body.linkedOccurrenceId ? String(body.linkedOccurrenceId) : undefined,
    });
  });

  // ── Light Estimates ──

  app.post("/admin/light-estimates", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createLightEstimate(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      contactName: body.contactName ? String(body.contactName).trim() : undefined,
      contactPhone: body.contactPhone ? String(body.contactPhone).trim() : undefined,
      contactEmail: body.contactEmail ? String(body.contactEmail).trim() : undefined,
      estimateAddress: body.estimateAddress ? String(body.estimateAddress).trim() : undefined,
      proposalAmount: body.proposalAmount != null ? Number(body.proposalAmount) : undefined,
      proposalNotes: body.proposalNotes ? String(body.proposalNotes) : undefined,
      jobTags: Array.isArray(body.jobTags) ? JSON.stringify(body.jobTags) : undefined,
      jobType: body.jobType ? String(body.jobType).trim() : undefined,
      assigneeUserIds: Array.isArray(body.assigneeUserIds) ? body.assigneeUserIds.map(String) : undefined,
      jobId: body.jobId ? String(body.jobId) : undefined,
    });
  });

  app.delete("/admin/light-estimates/:id", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Estimate not found");
    if (occ.jobId) throw app.httpErrors.badRequest("This estimate is linked to a job — delete it from the Job Service instead");
    if (occ.workflow !== "ESTIMATE") throw app.httpErrors.badRequest("Not a stand-alone estimate");
    await prisma.jobOccurrence.delete({ where: { id } });
    return { deleted: true };
  });

  // ── Events (admin-only shared occurrences) ──
  app.post("/admin/events", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createEvent(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      frequencyDays: body.frequencyDays != null ? Number(body.frequencyDays) : null,
    });
  });

  app.patch("/admin/events/:id", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Event not found");
    if (occ.workflow !== "EVENT") throw app.httpErrors.badRequest("Not an event");
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.frequencyDays !== undefined) data.frequencyDays = body.frequencyDays != null ? Number(body.frequencyDays) : null;
    return prisma.jobOccurrence.update({ where: { id }, data });
  });

  app.post("/admin/events/:id/complete", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.completeEvent(uid, String(req.params.id));
  });

  app.delete("/admin/events/:id", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Event not found");
    if (occ.workflow !== "EVENT") throw app.httpErrors.badRequest("Not an event");
    await prisma.jobOccurrence.delete({ where: { id } });
    return { deleted: true };
  });

  // ── Followups (admin-only, with optional client/job attachments) ──
  app.post("/admin/followups", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createFollowup(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      frequencyDays: body.frequencyDays != null ? Number(body.frequencyDays) : null,
      clientIds: Array.isArray(body.clientIds) ? body.clientIds : [],
      jobIds: Array.isArray(body.jobIds) ? body.jobIds : [],
    });
  });

  app.patch("/admin/followups/:id", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Followup not found");
    if (occ.workflow !== "FOLLOWUP") throw app.httpErrors.badRequest("Not a followup");
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.frequencyDays !== undefined) data.frequencyDays = body.frequencyDays != null ? Number(body.frequencyDays) : null;
    await prisma.jobOccurrence.update({ where: { id }, data });

    // Replace client/job attachments if provided
    if (Array.isArray(body.clientIds)) {
      await prisma.followupClient.deleteMany({ where: { occurrenceId: id } });
      if (body.clientIds.length > 0) {
        await prisma.followupClient.createMany({
          data: body.clientIds.map((clientId: string) => ({ occurrenceId: id, clientId })),
        });
      }
    }
    if (Array.isArray(body.jobIds)) {
      await prisma.followupJob.deleteMany({ where: { occurrenceId: id } });
      if (body.jobIds.length > 0) {
        await prisma.followupJob.createMany({
          data: body.jobIds.map((jobId: string) => ({ occurrenceId: id, jobId })),
        });
      }
    }

    return prisma.jobOccurrence.findUnique({ where: { id } });
  });

  app.post("/admin/followups/:id/complete", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.completeFollowup(uid, String(req.params.id));
  });

  app.delete("/admin/followups/:id", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Followup not found");
    if (occ.workflow !== "FOLLOWUP") throw app.httpErrors.badRequest("Not a followup");
    await prisma.jobOccurrence.delete({ where: { id } });
    return { deleted: true };
  });

  // ── Announcements (admin-only, universally visible) ──
  app.post("/admin/announcements", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createAnnouncement(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      frequencyDays: body.frequencyDays != null ? Number(body.frequencyDays) : null,
    });
  });

  app.patch("/admin/announcements/:id", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Announcement not found");
    if (occ.workflow !== "ANNOUNCEMENT") throw app.httpErrors.badRequest("Not an announcement");
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.frequencyDays !== undefined) data.frequencyDays = body.frequencyDays != null ? Number(body.frequencyDays) : null;
    return prisma.jobOccurrence.update({ where: { id }, data });
  });

  app.post("/admin/announcements/:id/complete", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.completeAnnouncement(uid, String(req.params.id));
  });

  app.delete("/admin/announcements/:id", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Announcement not found");
    if (occ.workflow !== "ANNOUNCEMENT") throw app.httpErrors.badRequest("Not an announcement");
    await prisma.jobOccurrence.delete({ where: { id } });
    return { deleted: true };
  });

  app.post("/admin/occurrences/:id/link-to-job", adminGuard, async (req: any) => {
    const occId = String(req.params.id);
    const jobId = String(req.body?.jobId ?? "");
    if (!jobId) throw app.httpErrors.badRequest("jobId is required");
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occId } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    await prisma.jobOccurrence.update({
      where: { id: occId },
      data: { jobId, kind: "SINGLE_ADDRESS" },
    });
    return { ok: true };
  });

  app.post("/admin/convert-light-estimate", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const occurrenceId = String(body.occurrenceId ?? "");
    if (!occurrenceId) throw app.httpErrors.badRequest("occurrenceId is required");

    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (occ.jobId) throw app.httpErrors.badRequest("This estimate is already linked to a job");

    return prisma.$transaction(async (tx) => {
      // Create client
      const client = await tx.client.create({
        data: {
          type: body.clientType ?? "PERSON",
          displayName: String(body.clientName ?? occ.contactName ?? "New Client").trim(),
          notesInternal: body.clientNotes ? String(body.clientNotes) : null,
        },
      });

      // Create primary contact
      const nameParts = (occ.contactName ?? "").trim().split(/\s+/);
      const firstName = body.contactFirstName ?? nameParts[0] ?? "";
      const lastName = body.contactLastName ?? nameParts.slice(1).join(" ") ?? "";
      const contact = await tx.clientContact.create({
        data: {
          clientId: client.id,
          firstName: String(firstName).trim(),
          lastName: String(lastName).trim(),
          email: body.contactEmail ?? occ.contactEmail ?? null,
          phone: body.contactPhone ?? occ.contactPhone ?? null,
          role: "OWNER",
          isPrimary: true,
        },
      });

      // Create property
      const property = await tx.property.create({
        data: {
          clientId: client.id,
          displayName: body.propertyName ?? "Property",
          street1: body.street1 ?? null,
          city: body.city ?? null,
          state: body.state ?? null,
          postalCode: body.postalCode ?? null,
          country: body.country ?? "US",
          kind: body.propertyKind ?? "SINGLE",
          pointOfContactId: contact.id,
        },
      });

      // Create job
      const job = await tx.job.create({
        data: {
          propertyId: property.id,
          kind: body.jobKind ?? "SINGLE_ADDRESS",
          status: "ACCEPTED",
          defaultPrice: occ.proposalAmount ?? body.defaultPrice ?? null,
          estimatedMinutes: occ.estimatedMinutes ?? body.estimatedMinutes ?? null,
          notes: occ.proposalNotes ?? body.jobNotes ?? null,
          frequencyDays: body.frequencyDays ?? null,
        },
      });

      // Link the job to client
      await tx.jobClient.create({ data: { jobId: job.id, clientId: client.id, role: "owner" } });
      await tx.jobContact.create({ data: { jobId: job.id, clientContactId: contact.id, role: "decision_maker" } });

      // Link the occurrence to the new job
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { jobId: job.id, kind: body.jobKind ?? "SINGLE_ADDRESS" },
      });

      // Audit
      await tx.auditEvent.create({
        data: {
          scope: "JOB",
          verb: "CREATED",
          actorUserId: uid,
          metadata: {
            jobId: job.id,
            clientId: client.id,
            propertyId: property.id,
            convertedFrom: occurrenceId,
            note: "Converted from light estimate",
          },
        },
      });

      return {
        ok: true,
        clientId: client.id,
        propertyId: property.id,
        jobId: job.id,
        contactId: contact.id,
      };
    });
  });

  // ── Pricing ──

  app.get("/admin/pricing", adminGuard, async () => {
    const rows = await prisma.setting.findMany({
      where: { key: { startsWith: "pricing_" } },
      include: { updatedBy: { select: { id: true, displayName: true } } },
      orderBy: { key: "asc" },
    });
    return rows.map((r: any) => {
      try {
        return { ...r, parsedValue: JSON.parse(r.value) };
      } catch {
        return { ...r, parsedValue: null };
      }
    });
  });

  app.post("/admin/pricing", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.label) throw app.httpErrors.badRequest("label is required");
    if (body.amount == null) throw app.httpErrors.badRequest("amount is required");
    if (!body.unit) throw app.httpErrors.badRequest("unit is required");

    // Generate key from label
    const key = "pricing_" + String(body.label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

    // Check for duplicate
    const existing = await prisma.setting.findUnique({ where: { key } });
    if (existing) throw app.httpErrors.conflict("A pricing entry with a similar name already exists");

    const value = JSON.stringify({
      label: String(body.label),
      description: body.description ? String(body.description) : "",
      unit: String(body.unit),
      amount: Number(body.amount),
      sortOrder: body.sortOrder != null ? Number(body.sortOrder) : 100,
    });

    return services.settings.set(uid, key, value);
  });

  app.patch("/admin/pricing/:key", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const key = String(req.params.key);
    if (!key.startsWith("pricing_")) throw app.httpErrors.badRequest("Invalid pricing key");

    const existing = await prisma.setting.findUnique({ where: { key } });
    if (!existing) throw app.httpErrors.notFound("Pricing entry not found");

    let current: any = {};
    try { current = JSON.parse(existing.value); } catch {}

    const body = req.body || {};
    const value = JSON.stringify({
      label: body.label != null ? String(body.label) : current.label,
      description: body.description != null ? String(body.description) : current.description,
      unit: body.unit != null ? String(body.unit) : current.unit,
      amount: body.amount != null ? Number(body.amount) : current.amount,
      sortOrder: body.sortOrder != null ? Number(body.sortOrder) : current.sortOrder,
    });

    return services.settings.set(uid, key, value);
  });

  app.delete("/admin/pricing/:key", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const key = String(req.params.key);
    if (!key.startsWith("pricing_")) throw app.httpErrors.badRequest("Invalid pricing key");

    await writeAudit(prisma, AUDIT.SETTING.UPDATED, uid, { key, action: "deleted" });
    await prisma.setting.delete({ where: { key } });
    return { ok: true };
  });

  // ── System Audit ──
  app.post("/admin/system-audit", superGuard, async (req: any) => {
    const checks = (req.body?.checks ?? []) as string[];
    type AuditIssue = { id?: string; description: string; clientId?: string; jobId?: string; occurrenceId?: string };
    const results: { check: string; label: string; issues: AuditIssue[] }[] = [];

    // 1. Duplicate client names
    if (checks.includes("duplicate_clients")) {
      const clients = await prisma.client.findMany({
        where: { archivedAt: null },
        select: { id: true, displayName: true, status: true },
      });
      const nameMap = new Map<string, typeof clients>();
      for (const c of clients) {
        const key = c.displayName.trim().toLowerCase();
        if (!nameMap.has(key)) nameMap.set(key, []);
        nameMap.get(key)!.push(c);
      }
      const issues: AuditIssue[] = [];
      for (const [, group] of nameMap) {
        if (group.length > 1) {
          issues.push({
            id: group[0].id,
            clientId: group[0].id,
            description: `"${group[0].displayName}" appears ${group.length} times (statuses: ${group.map((c) => c.status).join(", ")})`,
          });
        }
      }
      results.push({ check: "duplicate_clients", label: "Duplicate Client Names", issues });
    }

    // 2. Duplicate properties
    if (checks.includes("duplicate_properties")) {
      const properties = await prisma.property.findMany({
        where: { archivedAt: null },
        select: { id: true, displayName: true, street1: true, city: true, state: true, clientId: true, client: { select: { displayName: true } } },
      });
      const addrMap = new Map<string, typeof properties>();
      for (const p of properties) {
        const key = [p.street1, p.city, p.state].filter(Boolean).join("|").toLowerCase().trim();
        if (!key) continue;
        if (!addrMap.has(key)) addrMap.set(key, []);
        addrMap.get(key)!.push(p);
      }
      const issues: AuditIssue[] = [];
      for (const [, group] of addrMap) {
        if (group.length > 1) {
          issues.push({
            id: group[0].id,
            clientId: (group[0] as any).clientId,
            description: `"${group[0].displayName}" (${(group[0] as any).client?.displayName ?? "?"}) at "${group[0].street1}, ${group[0].city}" — ${group.length} duplicates`,
          });
        }
      }
      results.push({ check: "duplicate_properties", label: "Duplicate Properties", issues });
    }

    // 3. Duplicate service jobs (same property + kind)
    if (checks.includes("duplicate_jobs")) {
      const jobs = await prisma.job.findMany({
        where: { status: { not: "ARCHIVED" } },
        select: { id: true, propertyId: true, kind: true, status: true, property: { select: { displayName: true, client: { select: { displayName: true } } } } },
      });
      const jobMap = new Map<string, typeof jobs>();
      for (const j of jobs) {
        const key = `${j.propertyId}|${j.kind}`;
        if (!jobMap.has(key)) jobMap.set(key, []);
        jobMap.get(key)!.push(j);
      }
      const issues: AuditIssue[] = [];
      for (const [, group] of jobMap) {
        if (group.length > 1) {
          const active = group.filter((j) => j.status === "ACTIVE");
          if (active.length > 1) {
            const clientName = (group[0].property as any)?.client?.displayName ?? "";
            issues.push({
              id: group[0].id,
              jobId: group[0].id,
              description: `${group[0].property?.displayName ?? "Unknown"}${clientName ? ` (${clientName})` : ""} has ${active.length} active ${group[0].kind} jobs`,
            });
          }
        }
      }
      results.push({ check: "duplicate_jobs", label: "Duplicate Service Jobs", issues });
    }

    // 4. Duplicate repeating occurrences (same job, similar date, both SCHEDULED)
    if (checks.includes("duplicate_occurrences")) {
      const occs = await prisma.jobOccurrence.findMany({
        where: {
          status: "SCHEDULED",
          workflow: "STANDARD",
          jobId: { not: null },
          startAt: { not: null },
        },
        select: { id: true, jobId: true, startAt: true, kind: true, job: { select: { property: { select: { displayName: true, client: { select: { displayName: true } } } } } } },
        orderBy: { startAt: "asc" },
      });
      const jobOccs = new Map<string, typeof occs>();
      for (const o of occs) {
        if (!o.jobId) continue;
        if (!jobOccs.has(o.jobId)) jobOccs.set(o.jobId, []);
        jobOccs.get(o.jobId)!.push(o);
      }
      const issues: AuditIssue[] = [];
      for (const [, group] of jobOccs) {
        for (let i = 0; i < group.length - 1; i++) {
          const a = group[i];
          const b = group[i + 1];
          if (!a.startAt || !b.startAt) continue;
          const diffDays = Math.abs(b.startAt.getTime() - a.startAt.getTime()) / 86400000;
          if (diffDays <= 2) {
            const clientName = (a.job?.property as any)?.client?.displayName ?? "";
            issues.push({
              id: a.id,
              jobId: a.jobId!,
              occurrenceId: a.id,
              description: `${a.job?.property?.displayName ?? "Unknown"}${clientName ? ` (${clientName})` : ""}: two SCHEDULED occurrences ${diffDays < 1 ? "same day" : `${Math.round(diffDays)}d apart`} (${a.startAt.toISOString().slice(0, 10)} & ${b.startAt.toISOString().slice(0, 10)})`,
            });
          }
        }
      }
      results.push({ check: "duplicate_occurrences", label: "Duplicate Repeating Occurrences", issues });
    }

    // 5. Missing next repeating occurrence (completed in last 2 months, no SCHEDULED sibling)
    if (checks.includes("missing_next_occurrence")) {
      const twoMonthsAgo = new Date();
      twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
      const closed = await prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["CLOSED", "COMPLETED"] },
          workflow: "STANDARD",
          jobId: { not: null },
          completedAt: { gte: twoMonthsAgo },
        },
        select: { id: true, jobId: true, startAt: true, completedAt: true, job: { select: { property: { select: { displayName: true, client: { select: { displayName: true } } } }, frequencyDays: true, status: true } } },
        orderBy: { completedAt: "desc" },
      });
      // For each job, check if there's at least one SCHEDULED occurrence
      const jobIds = [...new Set(closed.map((o) => o.jobId).filter(Boolean))] as string[];
      const scheduled = await prisma.jobOccurrence.findMany({
        where: {
          jobId: { in: jobIds },
          status: "SCHEDULED",
          workflow: "STANDARD",
        },
        select: { jobId: true },
      });
      const hasScheduled = new Set(scheduled.map((o) => o.jobId));
      // Check which jobs have a PENDING_PAYMENT occurrence (next will auto-create on payment)
      const pendingPayment = await prisma.jobOccurrence.findMany({
        where: { jobId: { in: jobIds }, status: "PENDING_PAYMENT" },
        select: { jobId: true },
      });
      const hasPending = new Set(pendingPayment.map((o) => o.jobId));
      const issues: AuditIssue[] = [];
      const seen = new Set<string>();
      for (const o of closed) {
        if (!o.jobId || hasScheduled.has(o.jobId) || seen.has(o.jobId)) continue;
        if (o.job?.status === "ARCHIVED" || o.job?.status === "PAUSED") continue;
        if (!o.job?.frequencyDays || o.job.frequencyDays <= 0) continue;
        seen.add(o.jobId);
        const clientName = (o.job?.property as any)?.client?.displayName ?? "";
        const isPending = hasPending.has(o.jobId);
        issues.push({
          id: o.id,
          jobId: o.jobId,
          occurrenceId: o.id,
          description: isPending
            ? `${o.job?.property?.displayName ?? "Unknown"}${clientName ? ` (${clientName})` : ""}: awaiting payment — next occurrence will auto-create when payment is accepted (freq: ${o.job?.frequencyDays}d). Not a problem yet.`
            : `${o.job?.property?.displayName ?? "Unknown"}${clientName ? ` (${clientName})` : ""}: completed ${o.completedAt?.toISOString().slice(0, 10) ?? "?"} but no next SCHEDULED occurrence found (freq: ${o.job?.frequencyDays}d)`,
        });
      }
      results.push({ check: "missing_next_occurrence", label: "Missing Next Repeating Occurrence", issues });
    }

    // 6. Time estimate mismatch on repeating jobs (avg actual differs from estimate by >25%)
    if (checks.includes("time_estimate_mismatch")) {
      const jobs = await prisma.job.findMany({
        where: {
          status: "ACCEPTED",
          frequencyDays: { gt: 0 },
          estimatedMinutes: { not: null, gt: 0 },
        },
        select: {
          id: true,
          estimatedMinutes: true,
          property: { select: { displayName: true, client: { select: { displayName: true } } } },
        },
      });
      const jobIds = jobs.map((j) => j.id);
      const completedOccs = jobIds.length > 0 ? await prisma.jobOccurrence.findMany({
        where: {
          jobId: { in: jobIds },
          status: { in: ["CLOSED", "COMPLETED", "PENDING_PAYMENT"] },
          startedAt: { not: null },
          completedAt: { not: null },
        },
        select: {
          jobId: true,
          startedAt: true,
          completedAt: true,
          totalPausedMs: true,
          assignees: { select: { role: true } },
        },
        orderBy: { completedAt: "desc" },
      }) : [];
      // Group person-minutes (wall-clock × team size) by jobId, last 8 each.
      // Stored as person-minutes so the median is comparable across runs with
      // different team sizes; consumers divide by current team size for display.
      const byJob: Record<string, number[]> = {};
      for (const o of completedOccs) {
        if (!o.jobId) continue;
        if (!byJob[o.jobId]) byJob[o.jobId] = [];
        if (byJob[o.jobId].length >= 8) continue;
        if (!o.startedAt || !o.completedAt) continue;
        const wallclockMin = (new Date(o.completedAt).getTime() - new Date(o.startedAt).getTime() - (o.totalPausedMs ?? 0)) / 60000;
        if (wallclockMin <= 0) continue;
        const teamSize = Math.max(1, ((o as any).assignees ?? []).filter((a: any) => a.role !== "observer").length);
        byJob[o.jobId].push(wallclockMin * teamSize);
      }
      const fmtDur = (m: number) => {
        const h = Math.floor(m / 60); const mm = Math.round(m % 60);
        return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
      };
      const issues: AuditIssue[] = [];
      for (const job of jobs) {
        const durations = byJob[job.id] ?? [];
        // Need ≥3 completed occurrences to call it an "average"
        if (durations.length < 3) continue;
        const sorted = [...durations].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        const est = job.estimatedMinutes!;
        const discrepancy = Math.abs(median - est) / est;
        if (discrepancy <= 0.25) continue;
        const isOver = median > est;
        const propertyName = (job.property as any)?.displayName ?? "Unknown";
        const clientName = (job.property as any)?.client?.displayName ?? "";
        issues.push({
          jobId: job.id,
          description: `${propertyName}${clientName ? ` (${clientName})` : ""}: ${Math.round(discrepancy * 100)}% ${isOver ? "over" : "under"} estimate — avg actual ${fmtDur(median)} vs ${fmtDur(est)} est. (${durations.length} occurrences)`,
        });
      }
      results.push({ check: "time_estimate_mismatch", label: "Time Estimate Mismatch", issues });
    }

    if (checks.includes("unclaimed_no_guidance")) {
      // Unclaimed (no assignees) SCHEDULED real jobs with no guidance — guidance is
      // defined as at least one OccurrencePropertyPhoto whose underlying PropertyPhoto
      // has a non-empty description (the photo+description pattern that explains how
      // to do the job).
      const occurrences = await prisma.jobOccurrence.findMany({
        where: {
          status: "SCHEDULED",
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          isAdminOnly: false,
          assignees: { none: {} },
        },
        include: {
          job: {
            include: {
              property: { select: { displayName: true, client: { select: { displayName: true } } } },
            },
          },
          propertyPhotos: {
            include: { propertyPhoto: { select: { description: true } } },
          },
        },
      });
      const issues: AuditIssue[] = [];
      for (const occ of occurrences) {
        const hasGuidance = (occ.propertyPhotos ?? []).some(
          (pp) => !!pp.propertyPhoto?.description?.trim(),
        );
        if (hasGuidance) continue;
        const propertyName = (occ.job?.property as any)?.displayName ?? "Unknown property";
        const clientName = (occ.job?.property as any)?.client?.displayName ?? "";
        issues.push({
          jobId: occ.jobId ?? undefined,
          occurrenceId: occ.id,
          description: `${propertyName}${clientName ? ` (${clientName})` : ""}: unclaimed and no guidance (photos with descriptions) set.`,
        });
      }
      results.push({ check: "unclaimed_no_guidance", label: "Unclaimed Jobs Without Guidance", issues });
    }

    return { results };
  });

  // ── Client Change Requests (admin) ──

  app.get("/admin/change-requests", adminGuard, async (req: any) => {
    const status = (req.query?.status as string | undefined)?.toUpperCase();
    const where: any = {};
    if (status && ["PENDING", "APPROVED", "DENIED", "CANCELED"].includes(status)) {
      where.status = status;
    } else {
      where.status = "PENDING";
    }
    return prisma.occurrenceChangeRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        occurrence: {
          select: {
            id: true, startAt: true, status: true, kind: true, jobType: true,
            job: { select: { property: { select: { id: true, displayName: true, client: { select: { id: true, displayName: true } } } } } },
          },
        },
        requestedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
  });

  app.post("/admin/change-requests/:id/approve", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const uid = await currentUserId(req);
    const body = req.body || {};
    return prisma.$transaction(async (tx) => {
      const cr = await tx.occurrenceChangeRequest.findUnique({
        where: { id },
        include: { occurrence: true },
      });
      if (!cr) throw app.httpErrors.notFound("Request not found.");
      if (cr.status !== "PENDING") throw app.httpErrors.badRequest("Already resolved.");
      // Apply the change.
      if (cr.kind === "RESCHEDULE") {
        if (!cr.proposedStartAt) throw app.httpErrors.badRequest("No proposed time on this request.");
        const orig = cr.occurrence.startAt ? new Date(cr.occurrence.startAt).getTime() : null;
        const origEnd = cr.occurrence.endAt ? new Date(cr.occurrence.endAt).getTime() : null;
        const newStart = cr.proposedStartAt;
        const newEnd = orig != null && origEnd != null ? new Date(newStart.getTime() + (origEnd - orig)) : null;
        await tx.jobOccurrence.update({
          where: { id: cr.occurrenceId },
          data: { startAt: newStart, ...(newEnd ? { endAt: newEnd } : {}) },
        });
      } else if (cr.kind === "SKIP") {
        await tx.jobOccurrence.update({
          where: { id: cr.occurrenceId },
          data: { status: "CANCELED" },
        });
      }
      const updated = await tx.occurrenceChangeRequest.update({
        where: { id },
        data: {
          status: "APPROVED",
          resolvedById: uid,
          resolvedAt: new Date(),
          resolutionNote: body.note ? String(body.note).trim() : null,
        },
      });
      return updated;
    });
  });

  app.post("/admin/change-requests/:id/deny", adminGuard, async (req: any) => {
    const id = String(req.params.id);
    const uid = await currentUserId(req);
    const body = req.body || {};
    const cr = await prisma.occurrenceChangeRequest.findUnique({ where: { id } });
    if (!cr) throw app.httpErrors.notFound("Request not found.");
    if (cr.status !== "PENDING") throw app.httpErrors.badRequest("Already resolved.");
    return prisma.occurrenceChangeRequest.update({
      where: { id },
      data: {
        status: "DENIED",
        resolvedById: uid,
        resolvedAt: new Date(),
        resolutionNote: body.note ? String(body.note).trim() : null,
      },
    });
  });

  app.get("/admin/change-requests/pending-count", adminGuard, async (_req: any) => {
    const count = await prisma.occurrenceChangeRequest.count({ where: { status: "PENDING" } });
    return { count };
  });

  // ── Business Expenses (super only) ──

  app.get("/admin/business-expenses", superGuard, async (req: any) => {
    const q = (req.query || {}) as {
      from?: string;
      to?: string;
      category?: string;
      q?: string;
      limit?: string;
      offset?: string;
      all?: string;
    };
    const where: any = {};
    if (q.from || q.to) {
      where.date = {};
      if (q.from) where.date.gte = new Date(q.from);
      if (q.to) {
        const t = new Date(q.to);
        t.setHours(23, 59, 59, 999);
        where.date.lte = t;
      }
    }
    if (q.category) where.category = q.category;
    if (q.q && q.q.trim()) {
      const term = q.q.trim();
      where.OR = [
        { description: { contains: term, mode: "insensitive" } },
        { vendor: { contains: term, mode: "insensitive" } },
        { notes: { contains: term, mode: "insensitive" } },
      ];
    }

    // Pagination — limit/offset, applied to the same `where` filter so the
    // page is a slice of the filtered set. `all=true` bypasses the page cap;
    // used by the CSV export so the file contains every matching row.
    const all = q.all === "true";
    const rawLimit = Number(q.limit ?? "20");
    const rawOffset = Number(q.offset ?? "0");
    // Hard ceiling so a malicious or buggy caller can't ask for the whole
    // table when in paged mode. The export path uses `all=true` instead.
    const limit = all ? undefined : Math.min(Math.max(1, isNaN(rawLimit) ? 20 : rawLimit), 200);
    const offset = all ? 0 : Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

    const include = {
      createdBy: { select: { id: true, displayName: true, email: true } },
      equipment: { select: { id: true, shortDesc: true, brand: true, model: true, qrSlug: true } },
      occurrence: {
        select: {
          id: true,
          startAt: true,
          job: {
            select: {
              id: true,
              property: {
                select: { id: true, displayName: true, client: { select: { displayName: true } } },
              },
            },
          },
        },
      },
      supplyPurchase: {
        select: {
          id: true,
          quantity: true,
          unitCost: true,
          supply: { select: { id: true, name: true, unit: true } },
        },
      },
    } as const;

    const [rows, total] = await Promise.all([
      prisma.businessExpense.findMany({
        where,
        orderBy: { date: "desc" },
        include,
        ...(limit !== undefined ? { take: limit } : {}),
        ...(offset > 0 ? { skip: offset } : {}),
      }),
      prisma.businessExpense.count({ where }),
    ]);

    return { rows, total };
  });

  // Schedule C-aligned categories. Anything outside this list is rejected so
  // the column stays clean for tax-software import. Existing rows with legacy
  // free-text values are not touched — admin can recategorize via the UI.
  const SCHEDULE_C_CATEGORIES = new Set([
    "Advertising",
    "Car and truck expenses",
    "Contract labor",
    "Depreciation",
    "Insurance",
    "Legal and professional services",
    "Office expense",
    "Rent or lease — vehicles/equipment",
    "Rent or lease — other business property",
    "Repairs and maintenance",
    "Supplies",
    "Taxes and licenses",
    "Travel",
    "Meals",
    "Utilities",
    "Other",
  ]);

  app.post("/admin/business-expenses", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (!b.description?.trim()) throw app.httpErrors.badRequest("description is required");
    if (b.cost == null || isNaN(Number(b.cost))) throw app.httpErrors.badRequest("cost is required");
    if (!b.date) throw app.httpErrors.badRequest("date is required");
    const trimmedCategory = b.category ? String(b.category).trim() : null;
    if (trimmedCategory && !SCHEDULE_C_CATEGORIES.has(trimmedCategory)) {
      throw app.httpErrors.badRequest(`Invalid category: "${trimmedCategory}". Must be a Schedule C line.`);
    }
    const equipmentId = b.equipmentId ? String(b.equipmentId) : null;
    if (equipmentId) {
      const exists = await prisma.equipment.findUnique({ where: { id: equipmentId }, select: { id: true } });
      if (!exists) throw app.httpErrors.badRequest(`Equipment not found: ${equipmentId}`);
    }
    const recurrence = b.recurrence ? String(b.recurrence).toUpperCase() : null;
    if (recurrence && !["WEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY"].includes(recurrence)) {
      throw app.httpErrors.badRequest("recurrence must be WEEKLY, MONTHLY, QUARTERLY, or ANNUALLY");
    }
    return prisma.businessExpense.create({
      data: {
        createdById: uid,
        description: String(b.description).trim(),
        cost: Number(b.cost),
        date: new Date(String(b.date)),
        category: trimmedCategory,
        vendor: b.vendor ? String(b.vendor).trim() : null,
        invoiceNumber: b.invoiceNumber ? String(b.invoiceNumber).trim() : null,
        notes: b.notes ? String(b.notes).trim() : null,
        equipmentId,
        recurrence: recurrence as any,
      },
    });
  });

  app.patch("/admin/business-expenses/:id", superGuard, async (req: any) => {
    const id = String(req.params.id);
    const b = req.body || {};
    const data: any = {};
    if ("description" in b) data.description = String(b.description ?? "").trim();
    if ("cost" in b) data.cost = Number(b.cost);
    if ("date" in b) data.date = b.date ? new Date(String(b.date)) : null;
    if ("category" in b) {
      const trimmedCategory = b.category ? String(b.category).trim() : null;
      if (trimmedCategory && !SCHEDULE_C_CATEGORIES.has(trimmedCategory)) {
        throw app.httpErrors.badRequest(`Invalid category: "${trimmedCategory}". Must be a Schedule C line.`);
      }
      data.category = trimmedCategory;
    }
    if ("vendor" in b) data.vendor = b.vendor ? String(b.vendor).trim() : null;
    if ("invoiceNumber" in b) data.invoiceNumber = b.invoiceNumber ? String(b.invoiceNumber).trim() : null;
    if ("notes" in b) data.notes = b.notes ? String(b.notes).trim() : null;
    if ("equipmentId" in b) {
      const equipmentId = b.equipmentId ? String(b.equipmentId) : null;
      if (equipmentId) {
        const exists = await prisma.equipment.findUnique({ where: { id: equipmentId }, select: { id: true } });
        if (!exists) throw app.httpErrors.badRequest(`Equipment not found: ${equipmentId}`);
      }
      data.equipmentId = equipmentId;
    }
    if ("recurrence" in b) {
      const r = b.recurrence ? String(b.recurrence).toUpperCase() : null;
      if (r && !["WEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY"].includes(r)) {
        throw app.httpErrors.badRequest("recurrence must be WEEKLY, MONTHLY, QUARTERLY, or ANNUALLY");
      }
      data.recurrence = r;
    }

    // If this BE is the tax-ledger pair of a job-level Expense, mirror
    // cost/description so the worker's payout deduction stays in sync with
    // the ledger. Other fields (category/vendor/date/etc) live only on the BE.
    const linkedExpense = await prisma.expense.findFirst({
      where: { businessExpenseId: id },
      select: { id: true },
    });
    // If this BE is paired with a SupplyPurchase (step-3), edits to
    // cost/quantity-effecting fields must be routed through the Supplies tab
    // — direct editing here would desync the SupplyPurchase row, the per-unit
    // cost stored on the Supply, and onHand. Block cost/description edits in
    // that case; tax-only fields (vendor, invoiceNumber, notes, date) are
    // safe to edit directly on the BE.
    const linkedSupplyPurchase = await prisma.supplyPurchase.findFirst({
      where: { businessExpenseId: id },
      select: { id: true, supply: { select: { name: true } } },
    });
    if (linkedSupplyPurchase && ("cost" in data || "description" in data)) {
      throw app.httpErrors.badRequest(
        `This expense is linked to a supply purchase (${linkedSupplyPurchase.supply.name}). To change cost or description, edit the purchase from the Supplies tab.`,
      );
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.businessExpense.update({ where: { id }, data });
      if (linkedExpense) {
        const expenseSync: any = {};
        if ("cost" in data) expenseSync.cost = data.cost;
        if ("description" in data) expenseSync.description = data.description;
        if (Object.keys(expenseSync).length > 0) {
          await tx.expense.update({ where: { id: linkedExpense.id }, data: expenseSync });
        }
      }
      return updated;
    });
  });

  app.delete("/admin/business-expenses/:id", superGuard, async (req: any) => {
    const id = String(req.params.id);
    // Cascade: if this BE is paired with a job-level Expense, delete the
    // Expense too. Otherwise the schema's ON DELETE SET NULL would leave the
    // Expense in place — still reducing the worker's payout but no longer
    // appearing in the tax ledger.
    const linkedExpense = await prisma.expense.findFirst({
      where: { businessExpenseId: id },
      select: { id: true },
    });
    // If paired with a SupplyPurchase (step-3), reverse inventory and remove
    // the SupplyPurchase row first — schema FK is Restrict so the BE delete
    // would otherwise fail. Block if reversing would push onHand negative.
    const linkedSupplyPurchase = await prisma.supplyPurchase.findFirst({
      where: { businessExpenseId: id },
      include: { supply: true },
    });
    if (linkedSupplyPurchase) {
      const newOnHand = linkedSupplyPurchase.supply.onHand - linkedSupplyPurchase.quantity;
      if (newOnHand < 0) {
        throw app.httpErrors.conflict(
          `Cannot delete: reversing this purchase would push ${linkedSupplyPurchase.supply.name} stock to ${newOnHand}. Adjust inventory first.`,
        );
      }
    }
    await prisma.$transaction(async (tx) => {
      if (linkedExpense) {
        await tx.expense.delete({ where: { id: linkedExpense.id } });
      }
      if (linkedSupplyPurchase) {
        await tx.supply.update({
          where: { id: linkedSupplyPurchase.supplyId },
          data: { onHand: { decrement: linkedSupplyPurchase.quantity } },
        });
        await tx.supplyPurchase.delete({ where: { id: linkedSupplyPurchase.id } });
      }
      await tx.businessExpense.delete({ where: { id } });
    });
    return { deleted: true };
  });

  /**
   * Compare what the business "earns" (contractor platform fees + employee margins
   * captured on payments) vs what the business spends (BusinessExpense rows),
   * across the standard buckets. Net = earnings - expenses.
   */
  app.get("/admin/business-expenses/vs-revenue", superGuard, async (_req: any) => {
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay()); startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const [payments, expenses, rentals] = await Promise.all([
      prisma.payment.findMany({
        select: { createdAt: true, platformFeeAmount: true, businessMarginAmount: true },
      }),
      prisma.businessExpense.findMany({
        select: { date: true, cost: true },
      }),
      prisma.checkout.findMany({
        where: { rentalCost: { not: null }, releasedAt: { not: null } },
        select: { releasedAt: true, rentalCost: true },
      }),
    ]);

    type Bucket = { platformFees: number; businessMargin: number; equipmentRentals: number; expenses: number };
    const empty = (): Bucket => ({ platformFees: 0, businessMargin: 0, equipmentRentals: 0, expenses: 0 });
    const today = empty(), thisWeek = empty(), thisMonth = empty(), thisYear = empty(), allTime = empty();

    for (const p of payments) {
      const fee = p.platformFeeAmount ?? 0;
      const margin = p.businessMarginAmount ?? 0;
      allTime.platformFees += fee;
      allTime.businessMargin += margin;
      if (p.createdAt >= startOfToday) { today.platformFees += fee; today.businessMargin += margin; }
      if (p.createdAt >= startOfWeek)  { thisWeek.platformFees += fee; thisWeek.businessMargin += margin; }
      if (p.createdAt >= startOfMonth) { thisMonth.platformFees += fee; thisMonth.businessMargin += margin; }
      if (p.createdAt >= startOfYear)  { thisYear.platformFees += fee; thisYear.businessMargin += margin; }
    }
    for (const r of rentals) {
      const cost = r.rentalCost ?? 0;
      const at = r.releasedAt!;
      allTime.equipmentRentals += cost;
      if (at >= startOfToday) today.equipmentRentals += cost;
      if (at >= startOfWeek)  thisWeek.equipmentRentals += cost;
      if (at >= startOfMonth) thisMonth.equipmentRentals += cost;
      if (at >= startOfYear)  thisYear.equipmentRentals += cost;
    }
    for (const e of expenses) {
      allTime.expenses += e.cost;
      if (e.date >= startOfToday) today.expenses += e.cost;
      if (e.date >= startOfWeek)  thisWeek.expenses += e.cost;
      if (e.date >= startOfMonth) thisMonth.expenses += e.cost;
      if (e.date >= startOfYear)  thisYear.expenses += e.cost;
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    const finalize = (b: Bucket) => {
      const earnings = b.platformFees + b.businessMargin + b.equipmentRentals;
      return {
        platformFees: round(b.platformFees),
        businessMargin: round(b.businessMargin),
        equipmentRentals: round(b.equipmentRentals),
        earnings: round(earnings),
        expenses: round(b.expenses),
        net: round(earnings - b.expenses),
      };
    };

    return {
      today: finalize(today),
      thisWeek: finalize(thisWeek),
      thisMonth: finalize(thisMonth),
      thisYear: finalize(thisYear),
      allTime: finalize(allTime),
    };
  });

  // Summary: totals by today, week, month, year, all time + grouped by category for current period
  app.get("/admin/business-expenses/summary", superGuard, async (req: any) => {
    const q = (req.query || {}) as { from?: string; to?: string };
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay()); startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const where: any = {};
    if (q.from || q.to) {
      where.date = {};
      if (q.from) where.date.gte = new Date(q.from);
      if (q.to) {
        const t = new Date(q.to);
        t.setHours(23, 59, 59, 999);
        where.date.lte = t;
      }
    }
    const all = await prisma.businessExpense.findMany({ where, select: { date: true, cost: true, category: true } });
    let today = 0, thisWeek = 0, thisMonth = 0, thisYear = 0, total = 0;
    const byCategory: Record<string, number> = {};
    for (const e of all) {
      total += e.cost;
      if (e.date >= startOfToday) today += e.cost;
      if (e.date >= startOfWeek) thisWeek += e.cost;
      if (e.date >= startOfMonth) thisMonth += e.cost;
      if (e.date >= startOfYear) thisYear += e.cost;
      const cat = e.category || "(Uncategorized)";
      byCategory[cat] = (byCategory[cat] ?? 0) + e.cost;
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      today: round(today),
      thisWeek: round(thisWeek),
      thisMonth: round(thisMonth),
      thisYear: round(thisYear),
      total: round(total),
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, round(v)])),
      count: all.length,
    };
  });

  // Recurring-expense suggestions. Groups freestanding (non-job, non-supply)
  // BEs flagged with a recurrence by (description, vendor); for each group
  // the most recent row drives the next-expected date. Anything overdue or
  // due within the lead-window appears as a suggestion to record.
  app.get("/admin/business-expenses/due-soon", superGuard, async (_req: any) => {
    // Same-day-of-month math with end-of-month clamping (Jan 31 + 1mo → Feb 28).
    function nextDate(d: Date, cadence: string): Date {
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
      const lastDay = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
      out.setDate(Math.min(day, lastDay));
      return out;
    }

    const LEAD_DAYS = 7; // suggest 0–7 days before the expected next date
    const now = new Date();
    const horizon = new Date(now); horizon.setDate(horizon.getDate() + LEAD_DAYS);

    // Pull all flagged rows. Exclude BEs paired with a job-Expense or
    // SupplyPurchase — those are event-driven, not calendar-driven.
    const rows = await prisma.businessExpense.findMany({
      where: {
        recurrence: { not: null },
        occurrenceId: null,
        supplyPurchase: { is: null },
      },
      orderBy: { date: "desc" },
      select: {
        id: true, date: true, cost: true, description: true, category: true,
        vendor: true, invoiceNumber: true, notes: true, equipmentId: true,
        recurrence: true, recurrenceSkippedUntil: true,
      },
    });

    // Group by (description, vendor); the first row hit (most recent) wins.
    const seen = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      const key = `${(r.description || "").trim().toLowerCase()}::${(r.vendor || "").trim().toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, r);
    }

    const suggestions = Array.from(seen.values())
      .map((latest) => {
        const cadence = String(latest.recurrence);
        const baseNext = nextDate(latest.date, cadence);
        // Skip marker advances the "next expected" by one cadence past the
        // skipped date. Each click of Skip stores the date being skipped.
        const expected =
          latest.recurrenceSkippedUntil && latest.recurrenceSkippedUntil >= baseNext
            ? nextDate(latest.recurrenceSkippedUntil, cadence)
            : baseNext;
        return { latest, expected };
      })
      .filter(({ expected }) => expected <= horizon)
      .sort((a, b) => a.expected.getTime() - b.expected.getTime())
      .map(({ latest, expected }) => ({
        // Pre-fill payload — what the dialog needs to open with everything
        // populated. Cost and date are editable; description/vendor/category
        // copy as-is.
        nextExpectedDate: expected.toISOString().slice(0, 10),
        overdueDays: Math.max(0, Math.floor((now.getTime() - expected.getTime()) / 86400000)),
        recurrence: latest.recurrence,
        prefill: {
          description: latest.description,
          cost: latest.cost,
          category: latest.category,
          vendor: latest.vendor,
          invoiceNumber: null, // invoice numbers are usually unique per period
          notes: null, // notes typically don't repeat
          equipmentId: latest.equipmentId,
          recurrence: latest.recurrence,
        },
        // Reference info for the UI
        latestId: latest.id,
        latestDate: latest.date.toISOString().slice(0, 10),
        latestCost: latest.cost,
      }));

    return suggestions;
  });

  // Skip the current expected instance of a recurring BE — the next reminder
  // moves forward by one cadence period. Body: { skipDate: "YYYY-MM-DD" }
  // (the expected date the user is dismissing). Stored on the most recent
  // row of the series; the due-soon endpoint advances past it.
  app.post("/admin/business-expenses/:id/skip-recurrence", superGuard, async (req: any) => {
    const id = String(req.params.id);
    const b = req.body || {};
    const be = await prisma.businessExpense.findUnique({
      where: { id },
      select: { id: true, recurrence: true },
    });
    if (!be) throw app.httpErrors.notFound("Business expense not found.");
    if (!be.recurrence) {
      throw app.httpErrors.badRequest("This expense isn't flagged as recurring.");
    }
    const skipDateStr = String(b.skipDate ?? "").trim();
    if (!skipDateStr) throw app.httpErrors.badRequest("skipDate is required.");
    const skipDate = new Date(skipDateStr);
    if (isNaN(skipDate.getTime())) {
      throw app.httpErrors.badRequest("skipDate is not a valid date.");
    }
    return prisma.businessExpense.update({
      where: { id },
      data: { recurrenceSkippedUntil: skipDate },
      select: { id: true, recurrenceSkippedUntil: true },
    });
  });

  // ── Full Data Export ──

  app.get("/admin/export", adminGuard, async (_req: any, reply: any) => {

    const [
      users,
      userRoles,
      equipment,
      checkouts,
      clients,
      clientContacts,
      properties,
      jobs,
      jobContacts,
      jobClients,
      jobSchedules,
      jobOccurrences,
      jobAssigneeDefaults,
      jobOccurrenceAssignees,
      payments,
      paymentSplits,
      expenses,
      auditEvents,
    ] = await Promise.all([
      prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.userRole.findMany(),
      prisma.equipment.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.checkout.findMany(),
      prisma.client.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.clientContact.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.property.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.job.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.jobContact.findMany(),
      prisma.jobClient.findMany(),
      prisma.jobSchedule.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.jobOccurrence.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.jobAssigneeDefault.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.jobOccurrenceAssignee.findMany(),
      prisma.payment.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.paymentSplit.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.expense.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.auditEvent.findMany({ orderBy: { createdAt: "asc" } }),
    ]);

    const data = {
      exportedAt: new Date().toISOString(),
      users,
      userRoles,
      equipment,
      checkouts,
      clients,
      clientContacts,
      properties,
      jobs,
      jobContacts,
      jobClients,
      jobSchedules,
      jobOccurrences,
      jobAssigneeDefaults,
      jobOccurrenceAssignees,
      payments,
      paymentSplits,
      expenses,
      auditEvents,
    };

    const filename = `seedlings-export-${new Date().toISOString().slice(0, 10)}.json`;
    reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(JSON.stringify(data, null, 2));
  });

  // ── Human-Readable Summary Export ──

  app.get("/admin/export-summary", adminGuard, async (_req: any) => {

    const clients = await prisma.client.findMany({
      orderBy: { displayName: "asc" },
      include: {
        contacts: { orderBy: { isPrimary: "desc" } },
        properties: {
          orderBy: { displayName: "asc" },
          include: {
            pointOfContact: true,
            jobs: {
              orderBy: { createdAt: "asc" },
              include: {
                schedule: true,
                defaultAssignees: { include: { user: true } },
                occurrences: {
                  orderBy: { startAt: "asc" },
                  include: {
                    assignees: { include: { user: true } },
                    payment: true,
                    expenses: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const users = await prisma.user.findMany({
      orderBy: { displayName: "asc" },
      include: { roles: true },
    });

    const equipment = await prisma.equipment.findMany({
      orderBy: { brand: "asc" },
      include: {
        checkouts: {
          orderBy: { checkedOutAt: "desc" },
          take: 5,
          include: { user: true },
        },
      },
    });

    const lines: string[] = [];
    const hr = "=".repeat(80);
    const sr = "-".repeat(60);
    const date = (d: Date | string | null | undefined) =>
      d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";
    const money = (n: number | null | undefined) =>
      n != null ? `$${n.toFixed(2)}` : "—";

    lines.push(`SEEDLINGS LAWN CARE — DATA SUMMARY`);
    lines.push(`Exported: ${new Date().toLocaleString("en-US")}`);
    lines.push(hr);
    lines.push("");

    // ── Users ──
    lines.push("TEAM MEMBERS");
    lines.push(sr);
    for (const u of users) {
      const roles = u.roles.map((r: any) => r.role).join(", ") || "No role";
      lines.push(`  ${u.displayName || u.email || u.id}  (${roles})`);
      if (u.email) lines.push(`    Email: ${u.email}`);
      if (u.phone) lines.push(`    Phone: ${u.phone}`);
      if (u.workerType) lines.push(`    Type: ${u.workerType}`);
      if (u.homeBaseAddress) lines.push(`    Home base: ${u.homeBaseAddress}`);
      lines.push(`    Approved: ${u.isApproved ? "Yes" : "No"}  Joined: ${date(u.createdAt)}`);
    }
    lines.push("");

    // ── Equipment ──
    lines.push("EQUIPMENT");
    lines.push(sr);
    for (const eq of equipment) {
      const eqName = [eq.brand, eq.model].filter(Boolean).join(" ") || eq.shortDesc || eq.id;
      lines.push(`  ${eqName}  [${eq.status}]${eq.type ? "  Type: " + eq.type : ""}`);
      if (eq.shortDesc) lines.push(`    Desc: ${eq.shortDesc}`);
      if (eq.issues) lines.push(`    Issues: ${eq.issues}`);
    }
    lines.push("");

    // ── Clients → Properties → Jobs → Occurrences ──
    lines.push("CLIENTS, PROPERTIES & JOBS");
    lines.push(hr);
    for (const client of clients) {
      lines.push("");
      lines.push(`CLIENT: ${client.displayName}  [${client.status}]  (${client.type})`);
      if ((client as any).isVip) lines.push(`  VIP: Yes${(client as any).vipReason ? " — " + (client as any).vipReason : ""}`);
      if (client.notesInternal) lines.push(`  Notes: ${client.notesInternal}`);
      lines.push(`  Created: ${date(client.createdAt)}`);

      // Contacts
      if (client.contacts.length > 0) {
        lines.push(`  Contacts:`);
        for (const c of client.contacts) {
          const primary = c.isPrimary ? " (PRIMARY)" : "";
          const status = (c as any).status && (c as any).status !== "ACTIVE" ? `  [${(c as any).status}]` : "";
          lines.push(`    - ${c.firstName} ${c.lastName}${primary}${c.role ? " [" + c.role + "]" : ""}${status}`);
          if (c.phone) lines.push(`      Phone: ${c.phone}`);
          if (c.email) lines.push(`      Email: ${c.email}`);
          if ((c as any).nickname) lines.push(`      Nickname: ${(c as any).nickname}`);
        }
      }

      // Properties
      for (const prop of client.properties) {
        lines.push("");
        lines.push(`  PROPERTY: ${prop.displayName}  [${prop.status}]  (${(prop as any).kind ?? ""})`);
        lines.push(`    Address: ${prop.street1}${prop.street2 ? ", " + prop.street2 : ""}, ${prop.city}, ${prop.state} ${prop.postalCode}${(prop as any).country ? " " + (prop as any).country : ""}`);
        if ((prop as any).lotSize) lines.push(`    Lot: ${(prop as any).lotSize} ${(prop as any).lotSizeUnit ?? ""}`);
        if (prop.accessNotes) lines.push(`    Access: ${prop.accessNotes}`);
        if (prop.pointOfContact) {
          const poc = prop.pointOfContact;
          lines.push(`    Point of Contact: ${poc.firstName} ${poc.lastName}${poc.phone ? "  Phone: " + poc.phone : ""}${poc.email ? "  Email: " + poc.email : ""}`);
        }

        // Jobs
        for (const job of prop.jobs) {
          lines.push("");
          lines.push(`    JOB: ${job.kind}  [${job.status}]${job.frequencyDays ? "  Every " + job.frequencyDays + " days" : ""}${job.defaultPrice != null ? "  Default price: " + money(job.defaultPrice) : ""}`);
          if (job.notes) lines.push(`      Notes: ${job.notes}`);

          // Schedule
          if (job.schedule) {
            const s = job.schedule;
            lines.push(`      Schedule: ${s.cadence || "custom"}${s.autoRenew ? " (auto-renew)" : ""}${s.active ? "" : " [INACTIVE]"}  Horizon: ${s.horizonDays} days`);
          }

          // Default assignees
          if (job.defaultAssignees.length > 0) {
            lines.push(`      Default crew: ${job.defaultAssignees.map((a: any) => a.user.displayName || a.user.email).join(", ")}`);
          }

          // Occurrences
          if (job.occurrences.length > 0) {
            lines.push(`      Occurrences (${job.occurrences.length}):`);
            for (const occ of job.occurrences) {
              const flags = [
                occ.isOneOff && "one-off",
                occ.isEstimate && "estimate",
                occ.isTentative && "tentative",
              ].filter(Boolean).join(", ");
              const crew = occ.assignees.map((a: any) => a.user.displayName || a.user.email).join(", ");
              lines.push(`        ${date(occ.startAt)}  [${occ.status}]${flags ? "  (" + flags + ")" : ""}  ${money(occ.price)}${crew ? "  Crew: " + crew : ""}`);
              if (occ.notes) lines.push(`          Notes: ${occ.notes}`);
              if (occ.payment) {
                const p = occ.payment;
                lines.push(`          Payment: ${money(p.amountPaid)} via ${p.method} on ${date(p.createdAt)}`);
              }
              if (occ.expenses.length > 0) {
                for (const ex of occ.expenses) {
                  lines.push(`          Expense: ${money(ex.cost)} — ${ex.description || "no description"}`);
                }
              }
            }
          }
        }
      }
      lines.push(sr);
    }

    const text = lines.join("\n");
    return { text };
  });

  // ── Supplies (super only) ──
  //
  // Catalog + purchases + adjustments. The history endpoint returns a unified
  // timeline (purchases, holds, adjustments) for one supply, which the UI
  // renders as a single chronological feed.

  // Read endpoints are adminGuard so admins can view inventory + per-job hold
  // breakdown on their Inventory tab. Mutations stay superGuard below.
  app.get("/admin/supplies", adminGuard, async (req: any) => {
    const q = (req.query || {}) as { includeArchived?: string; q?: string };
    return services.supplies.list({
      includeArchived: q.includeArchived === "true",
      q: q.q,
      includeHoldDetails: true,
    });
  });

  app.get("/admin/supplies/:id", adminGuard, async (req: any) => {
    const row = await services.supplies.getById(String(req.params.id));
    if (!row) throw app.httpErrors.notFound("Supply not found");
    return row;
  });

  app.post("/admin/supplies", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.create(uid, {
      name: String(b.name ?? ""),
      description: b.description != null ? String(b.description) : null,
      unit: String(b.unit ?? ""),
      upc: b.upc != null ? String(b.upc) : null,
      category: b.category != null ? String(b.category) : null,
      businessCost: b.businessCost != null ? Number(b.businessCost) : null,
      jobPayoutCost: Number(b.jobPayoutCost ?? 0),
    });
  });

  app.patch("/admin/supplies/:id", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    const input: any = {};
    if ("name" in b) input.name = String(b.name);
    if ("description" in b) input.description = b.description != null ? String(b.description) : null;
    if ("unit" in b) input.unit = String(b.unit);
    if ("upc" in b) input.upc = b.upc != null ? String(b.upc) : null;
    if ("category" in b) input.category = b.category != null ? String(b.category) : null;
    if ("businessCost" in b) input.businessCost = b.businessCost != null ? Number(b.businessCost) : null;
    if ("jobPayoutCost" in b) input.jobPayoutCost = Number(b.jobPayoutCost);
    return services.supplies.update(uid, String(req.params.id), input);
  });

  app.post("/admin/supplies/:id/archive", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.supplies.archive(uid, String(req.params.id));
  });

  app.post("/admin/supplies/:id/unarchive", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.supplies.unarchive(uid, String(req.params.id));
  });

  app.post("/admin/supplies/:id/purchases", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.recordPurchase(uid, String(req.params.id), {
      quantity: Number(b.quantity),
      unitCost: Number(b.unitCost),
      date: b.date != null ? String(b.date) : null,
      vendor: b.vendor != null ? String(b.vendor) : null,
      invoiceNumber: b.invoiceNumber != null ? String(b.invoiceNumber) : null,
      notes: b.notes != null ? String(b.notes) : null,
    });
  });

  app.delete("/admin/supplies/purchases/:purchaseId", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.supplies.reversePurchase(uid, String(req.params.purchaseId));
  });

  app.post("/admin/supplies/:id/adjustments", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.recordAdjustment(uid, String(req.params.id), {
      delta: Number(b.delta),
      reason: String(b.reason ?? ""),
    });
  });

  app.get("/admin/supplies/:id/history", adminGuard, async (req: any) => {
    return services.supplies.listHistory(String(req.params.id));
  });

  // ── Receipt photo on a BusinessExpense ──
  //
  // Optional. Same shape regardless of which "step" the BE came from
  // (freestanding, job-Expense pair, or supply-purchase pair). Pattern:
  //   1. Client requests presigned PUT URL with content type
  //   2. Client uploads directly to R2
  //   3. Client tells server the upload is done; server saves the key
  //   4. To view, client requests a presigned GET URL (short-lived)

  app.post(
    "/admin/business-expenses/:id/receipt/upload-url",
    superGuard,
    async (req: any) => {
      const id = String(req.params.id);
      const b = req.body || {};
      const fileName = String(b.fileName ?? "receipt").trim();
      const contentType = String(b.contentType ?? "image/jpeg");
      if (!/^image\/|^application\/pdf$/.test(contentType)) {
        throw app.httpErrors.badRequest("Receipt must be an image or PDF.");
      }
      const exists = await prisma.businessExpense.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) throw app.httpErrors.notFound("Business expense not found.");
      // Key includes the BE id so the finalize step can verify ownership and
      // so orphaned objects are easy to spot.
      const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
      const key = `receipts/${id}/${Date.now()}-${safeName}`;
      const uploadUrl = await getUploadUrl(key, contentType, 300, "receipts");
      return { uploadUrl, key, contentType, fileName: safeName };
    },
  );

  app.post(
    "/admin/business-expenses/:id/receipt",
    superGuard,
    async (req: any) => {
      const id = String(req.params.id);
      const b = req.body || {};
      const key = String(b.key ?? "");
      const fileName = String(b.fileName ?? "");
      const contentType = String(b.contentType ?? "");
      // Reject keys that don't belong to this BE — prevents a caller from
      // pointing a different BE at someone else's already-uploaded object.
      if (!key.startsWith(`receipts/${id}/`)) {
        throw app.httpErrors.badRequest("Receipt key does not belong to this expense.");
      }
      // If the BE already had a receipt, delete the old object first.
      const prev = await prisma.businessExpense.findUnique({
        where: { id },
        select: { receiptR2Key: true },
      });
      if (!prev) throw app.httpErrors.notFound("Business expense not found.");
      if (prev.receiptR2Key && prev.receiptR2Key !== key) {
        await deleteObject(prev.receiptR2Key, "receipts").catch(() => {});
      }
      return prisma.businessExpense.update({
        where: { id },
        data: {
          receiptR2Key: key,
          receiptFileName: fileName || null,
          receiptContentType: contentType || null,
          receiptUploadedAt: new Date(),
        },
        select: {
          id: true,
          receiptR2Key: true,
          receiptFileName: true,
          receiptContentType: true,
          receiptUploadedAt: true,
        },
      });
    },
  );

  app.get(
    "/admin/business-expenses/:id/receipt-url",
    superGuard,
    async (req: any) => {
      const id = String(req.params.id);
      const be = await prisma.businessExpense.findUnique({
        where: { id },
        select: { receiptR2Key: true, receiptContentType: true, receiptFileName: true },
      });
      if (!be) throw app.httpErrors.notFound("Business expense not found.");
      if (!be.receiptR2Key) throw app.httpErrors.notFound("No receipt uploaded.");
      const url = await getDownloadUrl(be.receiptR2Key, 3600, "receipts");
      return { url, contentType: be.receiptContentType, fileName: be.receiptFileName };
    },
  );

  app.delete(
    "/admin/business-expenses/:id/receipt",
    superGuard,
    async (req: any) => {
      const id = String(req.params.id);
      const be = await prisma.businessExpense.findUnique({
        where: { id },
        select: { receiptR2Key: true },
      });
      if (!be) throw app.httpErrors.notFound("Business expense not found.");
      if (be.receiptR2Key) {
        await deleteObject(be.receiptR2Key, "receipts").catch(() => {});
      }
      await prisma.businessExpense.update({
        where: { id },
        data: {
          receiptR2Key: null,
          receiptFileName: null,
          receiptContentType: null,
          receiptUploadedAt: null,
        },
      });
      return { deleted: true };
    },
  );

  // UPC lookup: tries the internal Supply table first, then the keyless
  // UPCitemdb trial endpoint as a best-effort fallback (rate-limited per IP,
  // ~100/day — fine for our scale). Returns both fields so the UI can decide
  // whether to open Buy More (existing match) or Add Supply (prefill).
  app.get("/admin/supplies/upc-lookup", superGuard, async (req: any) => {
    const code = String((req.query?.code ?? "")).trim();
    if (!code) throw app.httpErrors.badRequest("Missing 'code' query parameter.");

    const matchExisting = await prisma.supply.findFirst({
      where: { upc: code, archivedAt: null },
      select: { id: true, name: true, unit: true, jobPayoutCost: true, businessCost: true, onHand: true, category: true },
    });

    let lookup: { found: boolean; title?: string; brand?: string; description?: string } | null = null;
    if (!matchExisting) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 5000);
        const r = await fetch(
          `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`,
          { signal: ac.signal },
        );
        clearTimeout(t);
        if (r.ok) {
          const data: any = await r.json();
          const item = data?.items?.[0];
          if (item?.title) {
            lookup = {
              found: true,
              title: String(item.title),
              brand: item.brand ? String(item.brand) : undefined,
              description: item.description ? String(item.description) : undefined,
            };
          } else {
            lookup = { found: false };
          }
        } else {
          lookup = { found: false };
        }
      } catch {
        // Timeout or network error — degrade gracefully to "not found"
        lookup = { found: false };
      }
    }

    return { code, matchExisting, lookup };
  });

  // Admin parity for adding/removing supply holds on an occurrence (same as
  // the worker route, for admin-only flows like editing on behalf of a
  // worker). Uses adminGuard rather than superGuard since this is occurrence
  // management, not catalog management.
  app.post("/admin/occurrences/:occurrenceId/supply-holds", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.addHold(uid, String(req.params.occurrenceId), {
      supplyId: String(b.supplyId ?? ""),
      quantity: Number(b.quantity),
    });
  });

  app.delete("/admin/supply-holds/:holdId", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.supplies.removeHold(uid, String(req.params.holdId));
  });
}
