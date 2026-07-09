// ─────────────────────────────────────────────────────────────────────────────
// Compliance policy build gate
//
// PURPOSE
// Locks in the "is this signature current?" and "is this worker compliant?"
// invariants that every gate (workday start / job claim / vehicle reserve)
// depends on. Runs on every build (turbo.json build.dependsOn test). A
// failure means a worker could pass a gate they shouldn't (compliance
// violation risk) or fail a gate they should pass (worker locked out).
//
// SCOPE
// Pure-predicate tests on lib/policyPredicate.ts — no DB, no Prisma, no
// mocks. Every failure mode of isSignatureCurrent is covered by at least
// one test. computeComplianceState is covered by aggregate scenarios.
//
// INVARIANTS LOCKED IN (each describe block covers one axis):
//
//   A. Signature-revoked short-circuit — a revoked sig never counts
//   B. Rolled-back version — a sig against a rolled-back version never counts
//   C. Content digest mismatch — sig contentDigestAtSign vs version
//   D. Upload-review states (NONE / PENDING_REVIEW / APPROVED / REJECTED)
//      when policy requires approval
//   E. Upload-expiry when policy requires expiry
//   F. Version currency + forcesResign chain:
//      - Sig against currentVersionId is current
//      - Sig against superseded version with all forcesResign=false ahead:
//        current (typo-fix chain preserves)
//      - Sig against superseded version with a forcesResign=true ahead,
//        grace not yet expired: current
//      - Same, grace expired: not current
//   G. Resign triggers:
//      - ONE_TIME never lapses
//      - DAYS_SINCE_SIGN lapses after N days
//      - ANNIVERSARY lapses at 365 days
//      - ANNUAL_ON_DATE lapses at the next occurrence of MM-DD
//   H. computeComplianceState aggregate:
//      - Empty evaluation set → current=true, pending=[]
//      - Only WARN/INFO pending → current=true (only BLOCK gates)
//      - BLOCK pending → current=false, pending contains id
//      - Active exception satisfies requirement (short-circuits sig)
//      - Archived policies never fail the aggregate
//      - nextExpiryAt is MIN across all applicable expiries
//
// HOW TO USE THIS FILE
// - If a test breaks, the fix is almost never to relax the assertion. The
//   only legitimate reasons are (a) a documented policy change with a
//   memo, (b) refactoring the predicate signature (update tests + predicate
//   in the same commit).

import { describe, it, expect } from "vitest";
import {
  isSignatureCurrent,
  computeComplianceState,
  normalizeName,
  type PolicyForPredicate,
  type VersionForPredicate,
  type SignatureForPredicate,
  type ExceptionForPredicate,
  type PolicyEvaluation,
} from "../lib/policyPredicate";

// ─────────────────────────────────────────────────────────────────────────────
// Factories — keep the tests readable by pre-filling reasonable defaults
// ─────────────────────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<PolicyForPredicate> = {}): PolicyForPredicate {
  return {
    id: "policy-1",
    targetWorkerTypes: ["CONTRACTOR"],
    enforcement: "BLOCK",
    workerAction: "SIGN",
    requiresWorkerUpload: false,
    workerUploadRequiresExpiry: false,
    workerUploadRequiresApproval: false,
    resignTrigger: "ONE_TIME",
    resignParamDays: null,
    resignParamMonthDay: null,
    currentVersionId: "version-1",
    archivedAt: null,
    ...overrides,
  };
}

function makeVersion(overrides: Partial<VersionForPredicate> = {}): VersionForPredicate {
  return {
    id: "version-1",
    policyDocumentId: "policy-1",
    status: "PUBLISHED",
    contentDigest: "digest-1",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    graceUntil: null,
    forcesResign: false,
    ...overrides,
  };
}

function makeSignature(overrides: Partial<SignatureForPredicate> = {}): SignatureForPredicate {
  return {
    id: "sig-1",
    userId: "user-1",
    policyDocumentVersionId: "version-1",
    contentDigestAtSign: "digest-1",
    signedAt: new Date("2026-01-02T00:00:00Z"),
    uploadStatus: "NONE",
    uploadExpiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function makeException(overrides: Partial<ExceptionForPredicate> = {}): ExceptionForPredicate {
  return {
    id: "exc-1",
    userId: "user-1",
    policyDocumentId: "policy-1",
    expiresAt: new Date("2026-12-31T00:00:00Z"),
    revokedAt: null,
    ...overrides,
  };
}

/** Convenience — pack a policy + version + sig into an evaluation. */
function makeEvaluation(input: {
  policy: PolicyForPredicate;
  currentVersion: VersionForPredicate | null;
  signatures?: SignatureForPredicate[];
  activeException?: ExceptionForPredicate | null;
  additionalVersions?: VersionForPredicate[];
}): PolicyEvaluation {
  const versionsById = new Map<string, VersionForPredicate>();
  if (input.currentVersion) versionsById.set(input.currentVersion.id, input.currentVersion);
  for (const v of input.additionalVersions ?? []) versionsById.set(v.id, v);
  return {
    policy: input.policy,
    currentVersion: input.currentVersion,
    signatures: input.signatures ?? [],
    activeException: input.activeException ?? null,
    versionsById,
  };
}

const NOW = new Date("2026-07-06T00:00:00Z");

// ─────────────────────────────────────────────────────────────────────────────
// A. Signature-revoked short-circuit
// ─────────────────────────────────────────────────────────────────────────────

describe("A. Signature-revoked short-circuit", () => {
  it("a revoked signature is never current, regardless of everything else", () => {
    const policy = makePolicy();
    const version = makeVersion();
    const sig = makeSignature({ revokedAt: new Date("2026-02-01T00:00:00Z") });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("SIGNATURE_REVOKED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Rolled-back version
// ─────────────────────────────────────────────────────────────────────────────

describe("B. Rolled-back version", () => {
  it("a sig against a ROLLED_BACK version is not current", () => {
    const policy = makePolicy();
    const version = makeVersion({ status: "ROLLED_BACK" });
    const sig = makeSignature();
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("VERSION_ROLLED_BACK");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Content digest mismatch
// ─────────────────────────────────────────────────────────────────────────────

describe("C. Content digest mismatch", () => {
  it("a sig whose digest doesn't match the version digest is not current", () => {
    const policy = makePolicy();
    const version = makeVersion({ contentDigest: "digest-A" });
    const sig = makeSignature({ contentDigestAtSign: "digest-B" });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("CONTENT_DIGEST_MISMATCH");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Upload-review states (policy requires approval)
// ─────────────────────────────────────────────────────────────────────────────

describe("D. Upload-review states", () => {
  const policy = makePolicy({
    requiresWorkerUpload: true,
    workerUploadRequiresApproval: true,
  });

  it("PENDING_REVIEW is not current", () => {
    const version = makeVersion();
    const sig = makeSignature({ uploadStatus: "PENDING_REVIEW" });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("UPLOAD_PENDING_REVIEW");
  });

  it("REJECTED is not current", () => {
    const version = makeVersion();
    const sig = makeSignature({ uploadStatus: "REJECTED" });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("UPLOAD_REJECTED");
  });

  it("NONE (no upload flow ran) is treated as pending review", () => {
    const version = makeVersion();
    const sig = makeSignature({ uploadStatus: "NONE" });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("UPLOAD_PENDING_REVIEW");
  });

  it("APPROVED passes the upload check", () => {
    const version = makeVersion();
    const sig = makeSignature({ uploadStatus: "APPROVED" });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(true);
  });

  it("policies that don't require approval accept NONE upload status", () => {
    const noApprovalPolicy = makePolicy({
      requiresWorkerUpload: true,
      workerUploadRequiresApproval: false,
    });
    const version = makeVersion();
    const sig = makeSignature({ uploadStatus: "NONE" });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, noApprovalPolicy, version, versionsById, NOW);
    expect(result.current).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Upload-expiry
// ─────────────────────────────────────────────────────────────────────────────

describe("E. Upload-expiry", () => {
  const policy = makePolicy({
    requiresWorkerUpload: true,
    workerUploadRequiresExpiry: true,
  });

  it("null uploadExpiresAt on an expiry-required policy is not current", () => {
    const version = makeVersion();
    const sig = makeSignature({ uploadStatus: "APPROVED", uploadExpiresAt: null });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("UPLOAD_MISSING_EXPIRY");
  });

  it("past uploadExpiresAt is not current", () => {
    const version = makeVersion();
    const sig = makeSignature({
      uploadStatus: "APPROVED",
      uploadExpiresAt: new Date("2026-01-15T00:00:00Z"),
    });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("UPLOAD_EXPIRED");
  });

  it("future uploadExpiresAt passes the check", () => {
    const version = makeVersion();
    const sig = makeSignature({
      uploadStatus: "APPROVED",
      uploadExpiresAt: new Date("2027-01-15T00:00:00Z"),
    });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Version currency + forcesResign chain
// ─────────────────────────────────────────────────────────────────────────────

describe("F. Version currency + forcesResign chain", () => {
  it("sig against currentVersionId is current", () => {
    const policy = makePolicy({ currentVersionId: "version-1" });
    const version = makeVersion({ id: "version-1" });
    const sig = makeSignature({ policyDocumentVersionId: "version-1" });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(true);
  });

  it("sig against superseded version with all later versions forcesResign=false: current (typo-fix chain)", () => {
    const policy = makePolicy({ currentVersionId: "version-3" });
    const oldVersion = makeVersion({
      id: "version-1",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const midVersion = makeVersion({
      id: "version-2",
      publishedAt: new Date("2026-02-01T00:00:00Z"),
      forcesResign: false,
    });
    const currentVersion = makeVersion({
      id: "version-3",
      publishedAt: new Date("2026-03-01T00:00:00Z"),
      forcesResign: false,
    });
    const sig = makeSignature({ policyDocumentVersionId: "version-1" });
    const versionsById = new Map([
      [oldVersion.id, oldVersion],
      [midVersion.id, midVersion],
      [currentVersion.id, currentVersion],
    ]);
    const result = isSignatureCurrent(sig, policy, oldVersion, versionsById, NOW);
    expect(result.current).toBe(true);
  });

  it("sig against superseded version with newer forcesResign=true, grace not yet expired: current", () => {
    const policy = makePolicy({ currentVersionId: "version-2" });
    const oldVersion = makeVersion({
      id: "version-1",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newerVersion = makeVersion({
      id: "version-2",
      publishedAt: new Date("2026-06-01T00:00:00Z"),
      forcesResign: true,
      // Grace ends after NOW
      graceUntil: new Date("2027-01-01T00:00:00Z"),
    });
    const sig = makeSignature({ policyDocumentVersionId: "version-1" });
    const versionsById = new Map([
      [oldVersion.id, oldVersion],
      [newerVersion.id, newerVersion],
    ]);
    const result = isSignatureCurrent(sig, policy, oldVersion, versionsById, NOW);
    expect(result.current).toBe(true);
  });

  it("sig against superseded version with newer forcesResign=true, grace expired: not current", () => {
    const policy = makePolicy({ currentVersionId: "version-2" });
    const oldVersion = makeVersion({
      id: "version-1",
      publishedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const newerVersion = makeVersion({
      id: "version-2",
      publishedAt: new Date("2026-06-01T00:00:00Z"),
      forcesResign: true,
      // Grace ended before NOW
      graceUntil: new Date("2026-06-15T00:00:00Z"),
    });
    const sig = makeSignature({ policyDocumentVersionId: "version-1" });
    const versionsById = new Map([
      [oldVersion.id, oldVersion],
      [newerVersion.id, newerVersion],
    ]);
    const result = isSignatureCurrent(sig, policy, oldVersion, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) {
      expect(["GRACE_EXPIRED_ON_SUPERSEDED_VERSION", "VERSION_FORCES_RESIGN_AFTER_GRACE"]).toContain(result.reason);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Resign triggers
// ─────────────────────────────────────────────────────────────────────────────

describe("G. Resign triggers", () => {
  it("ONE_TIME never lapses on personal clock, even years later", () => {
    const policy = makePolicy({ resignTrigger: "ONE_TIME" });
    const version = makeVersion();
    const sig = makeSignature({ signedAt: new Date("2020-01-01T00:00:00Z") });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(true);
  });

  it("DAYS_SINCE_SIGN lapses after N days", () => {
    const policy = makePolicy({
      resignTrigger: "DAYS_SINCE_SIGN",
      resignParamDays: 90,
    });
    const version = makeVersion();
    // Signed way before NOW → lapsed
    const sig = makeSignature({ signedAt: new Date("2026-01-01T00:00:00Z") });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("RESIGN_TRIGGER_LAPSED");
  });

  it("DAYS_SINCE_SIGN within window is current", () => {
    const policy = makePolicy({
      resignTrigger: "DAYS_SINCE_SIGN",
      resignParamDays: 90,
    });
    const version = makeVersion();
    // NOW is 2026-07-06; signed 60 days before → still within 90-day window
    const sig = makeSignature({ signedAt: new Date("2026-05-07T00:00:00Z") });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(true);
  });

  it("ANNIVERSARY lapses at 365 days", () => {
    const policy = makePolicy({ resignTrigger: "ANNIVERSARY" });
    const version = makeVersion();
    // Signed over a year ago
    const sig = makeSignature({ signedAt: new Date("2025-01-01T00:00:00Z") });
    const versionsById = new Map([[version.id, version]]);
    const result = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(result.current).toBe(false);
    if (result.current === false) expect(result.reason).toBe("RESIGN_TRIGGER_LAPSED");
  });

  it("ANNUAL_ON_DATE lapses on the fixed calendar date", () => {
    const policy = makePolicy({
      resignTrigger: "ANNUAL_ON_DATE",
      resignParamMonthDay: "01-15",
    });
    const version = makeVersion();
    // NOTE: use mid-day UTC times so the ET calendar day matches the
    // literal date component (00:00Z is the previous ET day). Signed
    // 2026-01-16 (ET) → next 01-15 is 2027-01-15 → still current at
    // 2026-07-06.
    const sig = makeSignature({ signedAt: new Date("2026-01-16T15:00:00Z") });
    const versionsById = new Map([[version.id, version]]);
    const currentResult = isSignatureCurrent(sig, policy, version, versionsById, NOW);
    expect(currentResult.current).toBe(true);

    // Signed 2026-01-14 (ET) → next 01-15 is 2026-01-15 → lapsed by
    // 2026-07-06.
    const sigLapsed = makeSignature({ signedAt: new Date("2026-01-14T15:00:00Z") });
    const lapsedResult = isSignatureCurrent(sigLapsed, policy, version, versionsById, NOW);
    expect(lapsedResult.current).toBe(false);
    if (lapsedResult.current === false) expect(lapsedResult.reason).toBe("RESIGN_TRIGGER_LAPSED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. computeComplianceState aggregate
// ─────────────────────────────────────────────────────────────────────────────

describe("H. computeComplianceState aggregate", () => {
  it("empty evaluation set → current, no pending", () => {
    const result = computeComplianceState([], NOW);
    expect(result.current).toBe(true);
    expect(result.pendingPolicyIds).toEqual([]);
    expect(result.nextExpiryAt).toBeNull();
  });

  it("only WARN/INFO pending → current=true (only BLOCK gates)", () => {
    const warnPolicy = makePolicy({ id: "policy-warn", enforcement: "WARN" });
    const infoPolicy = makePolicy({ id: "policy-info", enforcement: "INFO" });
    const evaluations: PolicyEvaluation[] = [
      makeEvaluation({ policy: warnPolicy, currentVersion: makeVersion(), signatures: [] }),
      makeEvaluation({ policy: infoPolicy, currentVersion: makeVersion(), signatures: [] }),
    ];
    const result = computeComplianceState(evaluations, NOW);
    expect(result.current).toBe(true);
    expect(result.pendingPolicyIds).toEqual([]);
  });

  it("BLOCK pending → current=false, pending contains id", () => {
    const blockPolicy = makePolicy({ id: "policy-block", enforcement: "BLOCK" });
    const evaluations: PolicyEvaluation[] = [
      makeEvaluation({
        policy: blockPolicy,
        currentVersion: makeVersion({ id: "v1" }),
        signatures: [], // no sig
      }),
    ];
    const result = computeComplianceState(evaluations, NOW);
    expect(result.current).toBe(false);
    expect(result.pendingPolicyIds).toEqual(["policy-block"]);
  });

  it("active exception satisfies requirement even without a signature", () => {
    const blockPolicy = makePolicy({ id: "policy-block", enforcement: "BLOCK" });
    const evaluations: PolicyEvaluation[] = [
      makeEvaluation({
        policy: blockPolicy,
        currentVersion: makeVersion({ id: "v1" }),
        signatures: [],
        activeException: makeException({ policyDocumentId: "policy-block" }),
      }),
    ];
    const result = computeComplianceState(evaluations, NOW);
    expect(result.current).toBe(true);
    expect(result.pendingPolicyIds).toEqual([]);
  });

  it("archived policies never fail the aggregate", () => {
    const archivedPolicy = makePolicy({
      id: "policy-archived",
      enforcement: "BLOCK",
      archivedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const evaluations: PolicyEvaluation[] = [
      makeEvaluation({
        policy: archivedPolicy,
        currentVersion: makeVersion(),
        signatures: [],
      }),
    ];
    const result = computeComplianceState(evaluations, NOW);
    expect(result.current).toBe(true);
    expect(result.pendingPolicyIds).toEqual([]);
  });

  it("nextExpiryAt is MIN across all applicable expiries", () => {
    const p1 = makePolicy({
      id: "p1",
      requiresWorkerUpload: true,
      workerUploadRequiresExpiry: true,
    });
    const p2 = makePolicy({
      id: "p2",
      requiresWorkerUpload: true,
      workerUploadRequiresExpiry: true,
    });
    const earlierExpiry = new Date("2026-09-01T00:00:00Z");
    const laterExpiry = new Date("2026-12-01T00:00:00Z");
    const evaluations: PolicyEvaluation[] = [
      makeEvaluation({
        policy: p1,
        currentVersion: makeVersion({ id: "v1", contentDigest: "d1" }),
        signatures: [
          makeSignature({
            id: "sig-p1",
            policyDocumentVersionId: "v1",
            contentDigestAtSign: "d1",
            uploadStatus: "APPROVED",
            uploadExpiresAt: laterExpiry,
          }),
        ],
      }),
      makeEvaluation({
        policy: p2,
        currentVersion: makeVersion({ id: "v2", contentDigest: "d2" }),
        signatures: [
          makeSignature({
            id: "sig-p2",
            policyDocumentVersionId: "v2",
            contentDigestAtSign: "d2",
            uploadStatus: "APPROVED",
            uploadExpiresAt: earlierExpiry,
          }),
        ],
      }),
    ];
    const result = computeComplianceState(evaluations, NOW);
    expect(result.current).toBe(true);
    expect(result.nextExpiryAt?.getTime()).toBe(earlierExpiry.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. normalizeName — typed-name comparison
// ─────────────────────────────────────────────────────────────────────────────

describe("I. normalizeName", () => {
  it("case-insensitive comparison", () => {
    expect(normalizeName("Michael Wanderski")).toBe(normalizeName("michael wanderski"));
    expect(normalizeName("Michael Wanderski")).toBe(normalizeName("MICHAEL WANDERSKI"));
  });

  it("strips punctuation (periods, commas, hyphens, apostrophes)", () => {
    expect(normalizeName("Michael J. Wanderski")).toBe(normalizeName("Michael J Wanderski"));
    expect(normalizeName("O'Brien")).toBe(normalizeName("OBrien"));
    expect(normalizeName("Smith-Jones")).toBe(normalizeName("Smith Jones"));
  });

  it("collapses internal whitespace", () => {
    expect(normalizeName("Michael  Wanderski")).toBe(normalizeName("Michael Wanderski"));
    expect(normalizeName("  Michael Wanderski  ")).toBe(normalizeName("Michael Wanderski"));
  });

  it("strips diacritics for accented characters", () => {
    expect(normalizeName("José")).toBe(normalizeName("Jose"));
    expect(normalizeName("Renée")).toBe(normalizeName("Renee"));
  });

  it("mismatched names remain distinct after normalization", () => {
    expect(normalizeName("Michael Wanderski")).not.toBe(normalizeName("Michel Wanderski"));
    expect(normalizeName("Mike Wanderski")).not.toBe(normalizeName("Michael Wanderski"));
  });
});
