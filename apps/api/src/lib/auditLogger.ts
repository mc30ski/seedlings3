import { Prisma, PrismaClient } from "@prisma/client";
import type { AuditTuple } from "./auditActions";
import { toActionString } from "./auditActions";

export async function writeAudit(
  tx: PrismaClient | Prisma.TransactionClient,
  [scope, verb]: AuditTuple,
  // Who invoked the action. `null` allowed for anonymous / client-self
  // flows (e.g. clicking an unsubscribe link in an email — no signed-in
  // Clerk session). AuditEvent.actorUserId is nullable in the schema.
  initiatingUserId: string | null,
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
