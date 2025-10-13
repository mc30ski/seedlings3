import { Prisma, PrismaClient } from "@prisma/client";
import type { AuditTuple } from "./auditActions";
import { toActionString } from "./auditActions";

//TODO: Why is equipmentId at the top? Really, it should be the ID of whatever entity it is (e.g. equipment, client, job, etc.). Need to rework this later.
// For now, will use equipmentId for both equipmentId and userId (the user that was affected).

export async function writeAudit(
  tx: PrismaClient | Prisma.TransactionClient,
  [scope, verb]: AuditTuple,
  initiatingUserId: string, // Who invoked the action.
  entityEffectedId: string | undefined, // The entity ID that was modified (e.g. equipment, user, job, client)
  info: unknown
) {
  return tx.auditEvent.create({
    data: {
      scope,
      verb,
      action: toActionString([scope, verb]),
      actorUserId: initiatingUserId,
      equipmentId: entityEffectedId,
      metadata: info as any,
    },
  });
}
