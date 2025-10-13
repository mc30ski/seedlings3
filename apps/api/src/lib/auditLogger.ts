import { Prisma, PrismaClient } from "@prisma/client";
import type { AuditTuple } from "./auditActions";
import { toActionString } from "./auditActions";

export async function writeAudit(
  tx: PrismaClient | Prisma.TransactionClient,
  [scope, verb]: AuditTuple,
  initiatingUserId: string, // Who invoked the action.
  info: unknown
) {
  return tx.auditEvent.create({
    data: {
      scope,
      verb,
      action: toActionString([scope, verb]),
      actorUserId: initiatingUserId,
      metadata: info as any,
    },
  });
}
