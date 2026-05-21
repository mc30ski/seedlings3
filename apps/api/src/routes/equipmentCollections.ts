import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Role as RoleVal } from "@prisma/client";
import { prisma } from "../db/prisma";

/**
 * Equipment Collections — admin-defined groupings ("Mowing Kit", etc.) that
 * act as templates for default/recommended equipment on jobs and as a one-tap
 * checkout shortcut for workers. Soft-membership: same equipment can be in
 * multiple collections, retired pieces remain attached.
 *
 * Workers get read-only access (so they can see kits when checking out or
 * starting a job). Admin owns CRUD.
 */

export default async function equipmentCollectionsRoutes(app: FastifyInstance) {
  const adminGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.ADMIN),
  };
  const workerGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.WORKER),
  };

  // ── Worker (and admin) read access ───────────────────────────────
  // Returns all collections with their members. Each item carries `heldByMe`
  // — true when the requesting worker currently has an open checkout on that
  // piece — so the worker Collections tab can flag which kits they're using.
  app.get("/equipment-collections", workerGuard, async (req) => {
    const collections = await prisma.equipmentCollection.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        items: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: {
            equipment: {
              select: {
                id: true,
                shortDesc: true,
                type: true,
                brand: true,
                model: true,
                status: true,
                retiredAt: true,
              },
            },
          },
        },
      },
    });

    const myId = (req as any).user?.id as string | undefined;
    let heldEquipmentIds = new Set<string>();
    if (myId) {
      const equipmentIds = collections.flatMap((c) =>
        c.items.map((i) => i.equipmentId),
      );
      if (equipmentIds.length > 0) {
        const active = await prisma.checkout.findMany({
          where: {
            userId: myId,
            releasedAt: null,
            equipmentId: { in: equipmentIds },
          },
          select: { equipmentId: true },
        });
        heldEquipmentIds = new Set(active.map((c) => c.equipmentId));
      }
    }

    return collections.map((c) => ({
      ...c,
      items: c.items.map((i) => ({
        ...i,
        heldByMe: heldEquipmentIds.has(i.equipmentId),
      })),
    }));
  });

  // ── Admin CRUD ────────────────────────────────────────────────────

  app.get("/admin/equipment-collections", adminGuard, async () => {
    const collections = await prisma.equipmentCollection.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        items: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: {
            equipment: {
              select: {
                id: true,
                shortDesc: true,
                type: true,
                brand: true,
                model: true,
                status: true,
                retiredAt: true,
              },
            },
          },
        },
        _count: { select: { jobRecommendations: true } },
      },
    });
    return collections;
  });

  app.post("/admin/equipment-collections", adminGuard, async (req: any, reply) => {
    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return reply.code(400).send({ error: "name is required" });
    const equipmentIds: string[] = Array.isArray(b.equipmentIds)
      ? b.equipmentIds.map((x: any) => String(x))
      : [];

    const created = await prisma.equipmentCollection.create({
      data: {
        name: name.slice(0, 80),
        description: b.description ? String(b.description).slice(0, 1000) : null,
        sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : 100,
        items: equipmentIds.length > 0 ? {
          create: equipmentIds.map((id, idx) => ({ equipmentId: id, sortOrder: 100 + idx })),
        } : undefined,
      },
      include: {
        items: { include: { equipment: { select: { id: true, shortDesc: true, type: true, brand: true, model: true, status: true, retiredAt: true } } } },
      },
    });
    return created;
  });

  app.patch("/admin/equipment-collections/:id", adminGuard, async (req: any, reply) => {
    const id = String((req.params as any)?.id || "");
    const b = req.body || {};
    const data: any = {};
    if (typeof b.name === "string") data.name = b.name.trim().slice(0, 80);
    if ("description" in b) data.description = b.description ? String(b.description).slice(0, 1000) : null;
    if (typeof b.sortOrder === "number") data.sortOrder = b.sortOrder;
    if (Object.keys(data).length === 0 && !Array.isArray(b.equipmentIds)) {
      return reply.code(400).send({ error: "Nothing to update" });
    }

    try {
      // If equipmentIds is provided, replace the membership wholesale in a tx.
      if (Array.isArray(b.equipmentIds)) {
        const equipmentIds: string[] = b.equipmentIds.map((x: any) => String(x));
        await prisma.$transaction([
          prisma.equipmentCollectionItem.deleteMany({ where: { collectionId: id } }),
          ...(equipmentIds.length > 0
            ? [
                prisma.equipmentCollectionItem.createMany({
                  data: equipmentIds.map((eid, idx) => ({
                    collectionId: id,
                    equipmentId: eid,
                    sortOrder: 100 + idx,
                  })),
                  skipDuplicates: true,
                }),
              ]
            : []),
          ...(Object.keys(data).length > 0
            ? [prisma.equipmentCollection.update({ where: { id }, data })]
            : []),
        ]);
      } else if (Object.keys(data).length > 0) {
        await prisma.equipmentCollection.update({ where: { id }, data });
      }
      const fresh = await prisma.equipmentCollection.findUnique({
        where: { id },
        include: {
          items: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
            include: { equipment: { select: { id: true, shortDesc: true, type: true, brand: true, model: true, status: true, retiredAt: true } } },
          },
        },
      });
      if (!fresh) return reply.code(404).send({ error: "Not found" });
      return fresh;
    } catch (err: any) {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  app.delete("/admin/equipment-collections/:id", adminGuard, async (req: any, reply) => {
    const id = String((req.params as any)?.id || "");
    try {
      await prisma.equipmentCollection.delete({ where: { id } });
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  // ── Job → Recommended Collections ─────────────────────────────────
  // Replace the recommended-collections list for a given job. Used from the
  // Job edit dialog. Empty array clears recommendations.
  app.put("/admin/jobs/:id/recommended-collections", adminGuard, async (req: any, reply) => {
    const jobId = String((req.params as any)?.id || "");
    const b = req.body || {};
    const collectionIds: string[] = Array.isArray(b.collectionIds)
      ? b.collectionIds.map((x: any) => String(x))
      : [];

    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!job) return reply.code(404).send({ error: "Job not found" });

    await prisma.$transaction([
      prisma.jobRecommendedCollection.deleteMany({ where: { jobId } }),
      ...(collectionIds.length > 0
        ? [
            prisma.jobRecommendedCollection.createMany({
              data: collectionIds.map((cid, idx) => ({ jobId, collectionId: cid, sortOrder: 100 + idx })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    return { ok: true };
  });

  app.get("/admin/jobs/:id/recommended-collections", adminGuard, async (req: any) => {
    const jobId = String((req.params as any)?.id || "");
    return prisma.jobRecommendedCollection.findMany({
      where: { jobId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        collection: {
          include: {
            items: { include: { equipment: { select: { id: true, shortDesc: true, type: true, status: true } } } },
          },
        },
      },
    });
  });
}
