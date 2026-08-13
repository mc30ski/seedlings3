import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";

// Setting keys that are VISIBLE in the Settings tab but NOT editable via the
// generic PATCH /admin/settings/:key endpoint. These are auto-managed values
// (server-generated secrets, computed state) with a dedicated mutation flow
// elsewhere. The value still appears in the Settings tab (rendered by a
// specialized card that surfaces the metadata + a dedicated action button
// instead of a free-text input) so operators can see the state exists +
// trigger the intended flow — they just can't misclick a text field into a
// broken state, and the API won't accept a bare PATCH either.
//
// Dedicated mutation flows:
//   PROMOTION_HMAC_SECRET → POST /super/promotions/rotate-hmac-secret
//                           (rendered as a "Rotate" button in Settings tab)
export const PROTECTED_SETTING_KEYS = new Set<string>([
  "PROMOTION_HMAC_SECRET",
]);

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
