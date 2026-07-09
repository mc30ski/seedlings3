import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { createHash, randomUUID } from "crypto";

neonConfig.webSocketConstructor = ws;

/**
 * Direct DB access for e2e tests — same connection pattern as the API
 * uses, but scoped to a fresh client per test file so we don't hold
 * pooled connections during test run.
 */
export function makePrisma() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing — check apps/api/.env");
  if (!url.includes("jolly-wildflower")) {
    throw new Error("SAFETY: e2e tests must run against the dev DB (jolly-wildflower). Refusing.");
  }
  const adapter = new PrismaNeon({ connectionString: url });
  return new PrismaClient({ adapter });
}

// Seed user IDs (match apps/api/prisma/seed.ts). Never modified — pre-existing
// Clerk-linked accounts we own.
export const USERS = {
  employee:   "cmnrz00fd002d5abyyr88byen",
  contractor: "cmnrylyaz000s5abyeyg77m4x",
  trainee:    "cmnrzapcl003g5abybrzttuxs",
  admin:      "cmnry8iih000k5acx7hf27aay",
  super:      "cmexiwrfs003kvdysrjteo2hy",
} as const;

/** Reset a worker's workday state for today so tests can exercise the
 *  "NOT_STARTED → Start workday" gate flow. Also nukes any dangling prior
 *  workdays so `assertWorkdayActiveOrPrompt` gives us a clean slate.
 *
 *  Uses the ET-anchored date key so it lines up with the app's own
 *  `workdayDate` field. */
/** Create a scratch approved WORKER-role user with NO workerType set —
 *  exactly the shape the unclassified-worker warning is meant to surface.
 *  Returns the created user's ID. Caller is responsible for cleanup via
 *  `deleteScratchUser`. Uses a random Clerk ID and a random email to
 *  avoid collisions across parallel test runs (should be @unique). */
export async function createScratchUnclassifiedWorker(
  prisma: PrismaClient,
  opts: { displayName?: string } = {},
): Promise<string> {
  const uid = randomUUID();
  const user = await prisma.user.create({
    data: {
      clerkUserId: `user_test_unclassified_${uid.replace(/-/g, "").slice(0, 20)}`,
      email: `test-unclassified-${uid.slice(0, 8)}@example.test`,
      displayName: opts.displayName ?? `Test Unclassified ${uid.slice(0, 6)}`,
      isApproved: true,
      // workerType intentionally omitted (null).
      roles: {
        create: [{ role: "WORKER" }],
      },
    },
  });
  return user.id;
}

/** Cleanup counterpart to `createScratchUnclassifiedWorker`. Deletes the
 *  user + their UserRole rows. Safe to call even if the user's already
 *  been deleted. */
export async function deleteScratchUser(prisma: PrismaClient, userId: string) {
  // UserRole and other relations cascade via schema onDelete: Cascade
  // where applicable, so a straight delete works.
  await prisma.user.deleteMany({ where: { id: userId } });
}

export async function resetWorkdayState(prisma: PrismaClient, userId: string) {
  // Compute today's ET date the same way the server does — via Intl in
  // America/New_York — so the workdayDate string we delete matches what
  // the app writes.
  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  await prisma.workerWorkday.deleteMany({
    where: {
      userId,
      // Delete today AND anything still open — the "openPrior" list
      // returned by the server would otherwise block the gate check.
      OR: [{ workdayDate: etDate }, { endedAt: null }],
    },
  });
}

/**
 * Wipe all PolicySignatures + PolicyExceptions for a user so we start
 * from a clean "worker has never touched anything" state. Idempotent.
 */
export async function resetWorkerCompliance(prisma: PrismaClient, userId: string) {
  await prisma.policySignature.deleteMany({ where: { userId } });
  await prisma.policyException.deleteMany({ where: { userId } });
}

/**
 * Create a scratch PolicyDocument + a single published version. Returns
 * both IDs. All fields defaulted; only the enforcement + workerType
 * targeting is configurable via opts.
 */
export async function createScratchPolicy(
  prisma: PrismaClient,
  opts: {
    keyPrefix: string;
    title: string;
    enforcement: "BLOCK" | "WARN" | "INFO";
    targetWorkerTypes?: Array<"EMPLOYEE" | "CONTRACTOR" | "TRAINEE">;
    workerAction?: "SIGN" | "ACKNOWLEDGE" | "NONE";
    requiresWorkerUpload?: boolean;
    workerUploadRequiresApproval?: boolean;
    graceUntil?: Date | null;
    createdByUserId: string;
  },
) {
  const key = `${opts.keyPrefix}_${Date.now()}_${randomUUID().slice(0, 6)}`.toUpperCase();
  const content = `# ${opts.title}\n\nTest policy body for e2e coverage.`;
  const contentDigest = createHash("sha256").update(content).digest("hex");

  const policy = await prisma.policyDocument.create({
    data: {
      key,
      title: opts.title,
      description: `E2E scratch policy: ${opts.title}`,
      enforcement: opts.enforcement,
      targetWorkerTypes: opts.targetWorkerTypes ?? ["EMPLOYEE", "CONTRACTOR", "TRAINEE"],
      workerAction: opts.workerAction ?? "SIGN",
      requiresWorkerUpload: opts.requiresWorkerUpload ?? false,
      workerUploadRequiresApproval: opts.workerUploadRequiresApproval ?? false,
      resignTrigger: "ONE_TIME",
      createdById: opts.createdByUserId,
      sortOrder: 999,
    },
  });

  const version = await prisma.policyDocumentVersion.create({
    data: {
      policyDocumentId: policy.id,
      versionNumber: 1,
      status: "PUBLISHED",
      contentFormat: "MARKDOWN",
      contentMarkdown: content,
      contentDigest,
      changeNote: "Initial version (E2E)",
      createdById: opts.createdByUserId,
      submittedById: opts.createdByUserId,
      approvedById: opts.createdByUserId,
      publishedById: opts.createdByUserId,
      submittedAt: new Date(),
      approvedAt: new Date(),
      publishedAt: new Date(),
      graceUntil: opts.graceUntil ?? null,
    },
  });

  await prisma.policyDocument.update({
    where: { id: policy.id },
    data: { currentVersionId: version.id },
  });

  return { policyId: policy.id, versionId: version.id, contentDigest };
}

/**
 * Delete any scratch PolicyDocuments created for tests. Matches on the
 * key prefix we use for scratch policies (E2E_) so we never touch the
 * real seeded policies.
 */
export async function cleanupScratchPolicies(prisma: PrismaClient) {
  // Cascade order: null the currentVersion pointer, drop signatures + exceptions
  // + reading-progress + versions that reference the doc, then the doc itself.
  const scratchDocs = await prisma.policyDocument.findMany({
    where: { key: { startsWith: "E2E_" } },
    select: { id: true },
  });
  if (scratchDocs.length === 0) return;
  const docIds = scratchDocs.map((d) => d.id);

  await prisma.policyDocument.updateMany({
    where: { id: { in: docIds } },
    data: { currentVersionId: null },
  });
  const versionIds = (
    await prisma.policyDocumentVersion.findMany({
      where: { policyDocumentId: { in: docIds } },
      select: { id: true },
    })
  ).map((v) => v.id);
  if (versionIds.length > 0) {
    await prisma.policySignature.deleteMany({ where: { policyDocumentVersionId: { in: versionIds } } });
    await prisma.policyReadingProgress.deleteMany({ where: { policyDocumentVersionId: { in: versionIds } } });
  }
  await prisma.policyException.deleteMany({ where: { policyDocumentId: { in: docIds } } });
  await prisma.policyDocumentVersion.deleteMany({ where: { policyDocumentId: { in: docIds } } });
  await prisma.policyDocument.deleteMany({ where: { id: { in: docIds } } });
}

/**
 * Grant a PolicyException so a worker temporarily doesn't need to sign
 * a specific policy. Used to test the "exception clears the banner"
 * scenario.
 */
export async function grantException(
  prisma: PrismaClient,
  opts: {
    userId: string;
    policyDocumentId: string;
    grantedByUserId: string;
    expiresInDays?: number;
    reason?: string;
  },
) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (opts.expiresInDays ?? 30));
  return prisma.policyException.create({
    data: {
      userId: opts.userId,
      policyDocumentId: opts.policyDocumentId,
      grantedById: opts.grantedByUserId,
      reason: opts.reason ?? "E2E test exception",
      expiresAt,
    },
  });
}

/**
 * Insert a completed signature so the worker looks like they've already
 * signed the policy. Sets contentDigestAtSign to the current version's
 * digest so the predicate marks them current.
 */
export async function signPolicyDirect(
  prisma: PrismaClient,
  opts: {
    userId: string;
    policyDocumentVersionId: string;
    contentDigestAtSign: string;
    workerActionAtSign?: "SIGN" | "ACKNOWLEDGE";
  },
) {
  return prisma.policySignature.create({
    data: {
      userId: opts.userId,
      policyDocumentVersionId: opts.policyDocumentVersionId,
      signedByUserId: opts.userId,
      contentDigestAtSign: opts.contentDigestAtSign,
      typedNameRaw: "Test Worker",
      typedNameNormalized: "test worker",
      workerActionAtSign: opts.workerActionAtSign ?? "SIGN",
      uploadStatus: "NONE",
    },
  });
}
