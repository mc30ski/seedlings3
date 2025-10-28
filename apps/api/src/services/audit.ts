import { prisma } from "../db/prisma";
import type { ServicesAudit } from "../types/services";

export const audit: ServicesAudit = {
  async list(params) {
    const where: any = {};
    if (params.actorUserId) where.actorUserId = params.actorUserId;
    if (params.action) where.action = params.action;
    if (params.from || params.to) {
      where.createdAt = {
        gte: params.from ? new Date(params.from) : undefined,
        lte: params.to ? new Date(params.to) : undefined,
      };
    }
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 50;
    const [items, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditEvent.count({ where }),
    ]);
    return { items, total };
  },
};
