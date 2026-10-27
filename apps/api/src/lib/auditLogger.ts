import { Prisma, PrismaClient } from "@prisma/client";
import type { AuditTuple } from "./auditActions";
import { toActionString } from "./auditActions";
import { currentRequestAuditContext } from "./requestContext";

/**
 * THE VIEW THE ACTOR WAS IN, recorded alongside what they did.
 *
 * A perspective narrows somebody to a subset of what they hold, so "who
 * did this" and "what were they looking at when they did it" are different
 * questions and the trail could only answer the first. The confirm dialog
 * even told operators the audit log "flags this action as impersonated",
 * which was false — nothing about a perspective reached the row.
 *
 * MERGED, NEVER OVERWRITING. It is added under its own key and only when a
 * perspective is actually in force, so no existing metadata shape changes
 * and a row without the key means "no perspective", not "not recorded".
 * Non-object metadata is left exactly as the caller passed it.
 */
function withPerspective(info: unknown): unknown {
  const ctx = currentRequestAuditContext();
  const p = ctx?.perspective;
  if (!p) return info;
  if (info === null || typeof info !== "object" || Array.isArray(info)) return info;
  return { ...(info as Record<string, unknown>), viewedAs: { roleId: p.roleId, name: p.name ?? null } };
}

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
      metadata: withPerspective(info) as any,
    },
  });
}
