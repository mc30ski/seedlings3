import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";

export const settings = {
  async getAll() {
    return prisma.setting.findMany({
      include: { updatedBy: { select: { id: true, displayName: true } } },
      orderBy: { key: "asc" },
    });
  },

  async get(key: string) {
    return prisma.setting.findUnique({ where: { key } });
  },

  async getValue(key: string, fallback: string): Promise<string> {
    const row = await prisma.setting.findUnique({ where: { key } });
    return row?.value ?? fallback;
  },

  async set(actorUserId: string, key: string, value: string) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.setting.upsert({
        where: { key },
        update: { value, updatedById: actorUserId },
        create: { key, value, updatedById: actorUserId },
      });

      await writeAudit(tx, AUDIT.SETTING.UPDATED, actorUserId, {
        key,
        value,
      });

      return updated;
    });
  },
};
