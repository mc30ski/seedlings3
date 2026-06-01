import { prisma } from "../db/prisma";
import type { ServicesAudit } from "../types/services";
import { etMidnight, etEndOfDay } from "../lib/dates";
import { cutoffWhere } from "../lib/businessStartCutoff";

export const audit: ServicesAudit = {
  async list(params) {
    const where: any = {};
    if (params.actorUserId) where.actorUserId = params.actorUserId;
    if (params.action) where.action = params.action;
    if (params.from || params.to) {
      where.createdAt = {
        gte: params.from ? etMidnight(params.from) : undefined,
        lte: params.to ? etEndOfDay(params.to) : undefined,
      };
    }
    // Business Start Date filter — pre-cutoff audit events hidden. Super can
    // toggle the reveal header to see historical actions. See
    // lib/businessStartCutoff.ts.
    const cutoff = params.cutoff ?? null;
    if (cutoff) {
      const existingGte = where.createdAt?.gte;
      where.createdAt = {
        ...(where.createdAt ?? {}),
        gte: existingGte && existingGte > cutoff ? existingGte : cutoff,
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
