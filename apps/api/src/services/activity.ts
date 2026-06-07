import { prisma } from "../db/prisma";
import { AuditTuple } from "../lib/auditActions";
import { AuditScope, AuditVerb } from "@prisma/client";
import { etMidnight, etToday, etAddDays } from "../lib/dates";
import type { AdminActivityUser, AdminActivityEvent } from "../types/services";
import type { ServicesActivity } from "../types/services";
import { toActionString } from "../lib/auditActions";

export const activity: ServicesActivity = {
  async listUserActivity() {
    const results: AdminActivityUser[] = [];

    const usersById = await prisma.user.findMany({
      where: {
        isApproved: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // ET-anchored 30-day cutoff for the activity report window.
    const since = etMidnight(etAddDays(etToday(), -30));

    for (const user of usersById) {
      const userEvents = await prisma.auditEvent.findMany({
        where: {
          actorUserId: user.id,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
      });

      const latest =
        userEvents.length === 0
          ? null
          : new Date(Math.max(...userEvents.map((e) => e.createdAt.getTime())));

      function convert([scope, verb]: AuditTuple, json: any) {
        const out: any = {};
        // Special case because there is no role record yet for an approved user.
        if (scope === AuditScope.USER && verb === AuditVerb.APPROVED) {
          out.role = "APPROVED";
        }
        if (json.roleRecord) {
          out.role = json.roleRecord.role;
        }
        if (json.userRecord) {
          out.email = json.userRecord.email;
        }
        if (json.equipmentRecord) {
          out.qrSlug = json.equipmentRecord.qrSlug;
          out.type = json.equipmentRecord.type;
          out.equipmentName = json.equipmentRecord.shortDesc;
          out.brand = json.equipmentRecord.brand;
          out.model = json.equipmentRecord.model;
        }
        return out;
      }

      const output: AdminActivityEvent[] = userEvents.map((e) => ({
        id: e.id,
        at: e.createdAt,
        type: toActionString([e.scope, e.verb]),
        details: convert([e.scope, e.verb], e.metadata),
      }));

      results.push({
        userId: user.id,
        displayName: user.displayName || undefined,
        email: user.email || undefined,
        lastActivityAt: latest,
        count: userEvents.length,
        events: output,
      });
    }

    return results;
  },
};
