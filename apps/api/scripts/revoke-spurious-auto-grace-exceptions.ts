// One-off data cleanup: revoke every active AUTO_GRACE_EXTENSION_24H
// PolicyException whose target worker already had a currently-valid
// signature at the time the exception was granted.
//
// Background: `_maybeGrantAutoGraceExtensions` in services/policies.ts
// used to grant a 24h exception to every worker whose targeted policy
// had a recently-expired grace window — WITHOUT checking whether the
// worker was already compliant. That over-grants exceptions and, worse,
// makes the sign matrix render "Exception" over the worker's actual
// signed status (matrix cell picks exception first — see
// services/policies.ts::getSignMatrix). The fix
// landed on 2026-07-11; this script cleans up rows created before it.
//
// Safe to re-run: only revokes exceptions that are (a) matching the
// auto-grace reason prefix, (b) still active, and (c) confirmed to have
// a currently-valid signature for the same (user, policy). Never
// touches manually-granted exceptions. Never touches sigs.
//
// Usage:
//   cd apps/api && npx tsx scripts/revoke-spurious-auto-grace-exceptions.ts
//   cd apps/api && npx tsx scripts/revoke-spurious-auto-grace-exceptions.ts --dry-run
//
// Dry-run prints the counts without writing anything. Production run
// requires --confirm to actually revoke (belt-and-suspenders for a
// destructive-looking op even though revoke is soft).

import { prisma } from "../src/db/prisma";
import {
  isSignatureCurrent,
  type PolicyForPredicate,
  type VersionForPredicate,
  type SignatureForPredicate,
} from "../src/lib/policyPredicate";

const AUTO_GRACE_REASON_PREFIX = "AUTO_GRACE_EXTENSION_24H";
const CLEANUP_REVOKE_REASON =
  "Spurious auto-grace — worker already had a currently-valid signature at grant time. Revoked by scripts/revoke-spurious-auto-grace-exceptions.ts on 2026-07-11.";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const confirm = process.argv.includes("--confirm");

  if (!dryRun && !confirm) {
    console.error(
      "Refusing to run without --dry-run or --confirm. Start with --dry-run to preview.",
    );
    process.exit(2);
  }

  const now = new Date();
  const candidates = await prisma.policyException.findMany({
    where: {
      reason: { startsWith: AUTO_GRACE_REASON_PREFIX },
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      userId: true,
      policyDocumentId: true,
      grantedById: true,
      expiresAt: true,
      grantedAt: true,
    },
    orderBy: { grantedAt: "asc" },
  });

  console.log(
    `Found ${candidates.length} active auto-grace exception(s) to evaluate.`,
  );
  if (candidates.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const affectedPolicyIds = Array.from(
    new Set(candidates.map((c) => c.policyDocumentId)),
  );
  const affectedUserIds = Array.from(new Set(candidates.map((c) => c.userId)));

  const policies = await prisma.policyDocument.findMany({
    where: { id: { in: affectedPolicyIds } },
    include: { versions: true },
  });
  const policyById = new Map(policies.map((p) => [p.id, p]));

  const signatures = await prisma.policySignature.findMany({
    where: {
      userId: { in: affectedUserIds },
      version: { policyDocumentId: { in: affectedPolicyIds } },
    },
    orderBy: { signedAt: "desc" },
  });
  const sigsByUserPolicy = new Map<string, typeof signatures>();
  const sigParentPolicyId = (versionId: string): string | null => {
    for (const p of policies) {
      if (p.versions.some((v) => v.id === versionId)) return p.id;
    }
    return null;
  };
  for (const s of signatures) {
    const parentId = sigParentPolicyId(s.policyDocumentVersionId);
    if (!parentId) continue;
    const key = `${s.userId}::${parentId}`;
    const arr = sigsByUserPolicy.get(key) ?? [];
    arr.push(s);
    sigsByUserPolicy.set(key, arr);
  }

  const toRevoke: Array<{
    id: string;
    userId: string;
    policyId: string;
    policyTitle: string;
    userDisplayName: string | null;
  }> = [];
  const toKeep: typeof toRevoke = [];

  const affectedUsers = await prisma.user.findMany({
    where: { id: { in: affectedUserIds } },
    select: { id: true, displayName: true },
  });
  const userDisplayNameById = new Map(
    affectedUsers.map((u) => [u.id, u.displayName]),
  );

  for (const exc of candidates) {
    const policy = policyById.get(exc.policyDocumentId);
    if (!policy) {
      // Policy was archived / deleted after the exception was granted;
      // the exception is orphaned. Leave it alone — script scope is
      // "already-compliant workers only".
      continue;
    }
    const key = `${exc.userId}::${exc.policyDocumentId}`;
    const sigs = sigsByUserPolicy.get(key) ?? [];
    const versionsById = new Map<string, VersionForPredicate>();
    for (const v of policy.versions) {
      versionsById.set(v.id, {
        id: v.id,
        policyDocumentId: v.policyDocumentId,
        status: v.status as VersionForPredicate["status"],
        contentDigest: v.contentDigest,
        publishedAt: v.publishedAt,
        graceUntil: v.graceUntil,
        forcesResign: v.forcesResign,
      });
    }
    const policyForPredicate: PolicyForPredicate = {
      id: policy.id,
      targetWorkerTypes: policy.targetWorkerTypes,
      enforcement: policy.enforcement as PolicyForPredicate["enforcement"],
      workerAction: policy.workerAction as PolicyForPredicate["workerAction"],
      requiresWorkerUpload: policy.requiresWorkerUpload,
      workerUploadRequiresExpiry: policy.workerUploadRequiresExpiry,
      workerUploadRequiresApproval: policy.workerUploadRequiresApproval,
      resignTrigger: policy.resignTrigger as PolicyForPredicate["resignTrigger"],
      resignParamDays: policy.resignParamDays,
      resignParamMonthDay: policy.resignParamMonthDay,
      currentVersionId: policy.currentVersionId,
      archivedAt: policy.archivedAt,
    };
    let hasCurrentSig = false;
    for (const sig of sigs) {
      const version = versionsById.get(sig.policyDocumentVersionId);
      if (!version) continue;
      const sigForPredicate: SignatureForPredicate = {
        id: sig.id,
        userId: sig.userId,
        policyDocumentVersionId: sig.policyDocumentVersionId,
        contentDigestAtSign: sig.contentDigestAtSign,
        signedAt: sig.signedAt,
        uploadStatus: sig.uploadStatus,
        uploadExpiresAt: sig.uploadExpiresAt,
        revokedAt: sig.revokedAt,
      };
      const result = isSignatureCurrent(
        sigForPredicate,
        policyForPredicate,
        version,
        versionsById,
        now,
      );
      if (result.current) {
        hasCurrentSig = true;
        break;
      }
    }
    const record = {
      id: exc.id,
      userId: exc.userId,
      policyId: exc.policyDocumentId,
      policyTitle: policy.title,
      userDisplayName: userDisplayNameById.get(exc.userId) ?? null,
    };
    if (hasCurrentSig) {
      toRevoke.push(record);
    } else {
      toKeep.push(record);
    }
  }

  console.log("");
  console.log(
    `Spurious (worker was already signed): ${toRevoke.length} — will be revoked.`,
  );
  console.log(
    `Legitimate (worker had no valid signature): ${toKeep.length} — will be left alone.`,
  );
  console.log("");

  if (toRevoke.length > 0) {
    console.log("Preview of exceptions to revoke:");
    for (const r of toRevoke.slice(0, 25)) {
      console.log(
        `  - ${r.userDisplayName ?? r.userId}  ×  ${r.policyTitle}  (exc ${r.id})`,
      );
    }
    if (toRevoke.length > 25) {
      console.log(`  … and ${toRevoke.length - 25} more.`);
    }
  }

  if (dryRun) {
    console.log("\n[dry-run] No writes performed.");
    return;
  }

  if (toRevoke.length === 0) {
    console.log("Nothing to revoke.");
    return;
  }

  console.log(`\nRevoking ${toRevoke.length} exception(s)…`);
  await prisma.policyException.updateMany({
    where: { id: { in: toRevoke.map((r) => r.id) } },
    data: {
      revokedAt: now,
      revokedReason: CLEANUP_REVOKE_REASON,
    },
  });
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
