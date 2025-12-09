import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AuditTuple } from "../lib/auditActions";

export async function action<T>(
  currentUserId: string,
  id: string,
  table: string,
  state: T,
  audit: AuditTuple
) {
  let record = null;

  await prisma.$transaction(async (tx) => {
    record = await (tx as any)[table].update({
      where: { id },
      data: { status: state, updatedAt: new Date() },
    });
    await writeAudit(tx, audit, currentUserId, {
      id: id,
      record: record,
    });
  });
  return record;
}
