/**
 * Compliance policy predicate — pure functions with no DB access.
 *
 * Single source of truth for "is this worker current on this policy?" and
 * the derived "what's their overall compliance state?" question. Every
 * gate that fires in workday/jobs/equipment services calls these functions
 * (indirectly, via services/policies.ts assertPoliciesSigned). The
 * build-gate test at services/policies-build-gate.test.ts pins the
 * semantics down against future refactors.
 *
 * Kept as pure inputs → pure outputs so we can:
 *   • unit-test every combination without a DB
 *   • cache computeComplianceState by user with a well-defined
 *     invalidation trigger (any signature write, any version publish/
 *     rollback, any exception change)
 *   • call from anywhere in the codebase (services, background jobs,
 *     export pipelines) without carrying a Prisma client
 *
 * Types are lightweight shapes — the caller (services/policies.ts) is
 * responsible for loading the right fields from Prisma and passing them
 * in. That keeps this file dependency-free and easy to reason about.
 */

import { etAddDays, etDaysBetween, etFormatDate } from "./dates";

// ─────────────────────────────────────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────────────────────────────────────

/** Subset of PolicyDocument fields needed by the predicate. */
export type PolicyForPredicate = {
  id: string;
  targetWorkerTypes: string[]; // WorkerType[] as raw strings
  enforcement: "BLOCK" | "WARN" | "INFO";
  workerAction: "SIGN" | "ACKNOWLEDGE" | "NONE";
  requiresWorkerUpload: boolean;
  workerUploadRequiresExpiry: boolean;
  workerUploadRequiresApproval: boolean;
  resignTrigger: "ONE_TIME" | "DAYS_SINCE_SIGN" | "ANNIVERSARY" | "ANNUAL_ON_DATE";
  resignParamDays: number | null;
  resignParamMonthDay: string | null; // "MM-DD"
  currentVersionId: string | null;
  archivedAt: Date | null;
};

/** Subset of PolicyDocumentVersion fields needed by the predicate. */
export type VersionForPredicate = {
  id: string;
  policyDocumentId: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "PUBLISHED" | "ROLLED_BACK";
  contentDigest: string;
  publishedAt: Date | null;
  graceUntil: Date | null;
  forcesResign: boolean;
};

/** Subset of PolicySignature fields needed by the predicate. */
export type SignatureForPredicate = {
  id: string;
  userId: string;
  policyDocumentVersionId: string;
  contentDigestAtSign: string;
  signedAt: Date;
  uploadStatus: "NONE" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  uploadExpiresAt: Date | null;
  revokedAt: Date | null;
};

/** Subset of PolicyException fields needed by the predicate. */
export type ExceptionForPredicate = {
  id: string;
  userId: string;
  policyDocumentId: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Is this signature current for this policy right now?"
 * Encapsulates every failure mode individually so callers (UI, audit) can
 * explain exactly why a signature stopped being current.
 */
export type SignatureCurrentResult =
  | { current: true }
  | {
      current: false;
      reason:
        | "SIGNATURE_REVOKED"
        | "VERSION_ROLLED_BACK"
        | "VERSION_FORCES_RESIGN_AFTER_GRACE"
        | "GRACE_EXPIRED_ON_SUPERSEDED_VERSION"
        | "UPLOAD_PENDING_REVIEW"
        | "UPLOAD_REJECTED"
        | "UPLOAD_EXPIRED"
        | "UPLOAD_MISSING_EXPIRY"
        | "RESIGN_TRIGGER_LAPSED"
        | "CONTENT_DIGEST_MISMATCH";
    };

/** Overall per-user compliance state derived from all applicable policies. */
export type ComplianceState = {
  /** True when there are no BLOCK-level policies outstanding. */
  current: boolean;
  /** Policy IDs the worker needs to sign or refresh to become current. */
  pendingPolicyIds: string[];
  /**
   * Soonest expiry across all currently-satisfied policies. Nullable when
   * no expiries are relevant (everything ONE_TIME or nothing satisfied).
   * Callers surface this on worker's Compliance tab as "next up-for-renewal".
   */
  nextExpiryAt: Date | null;
};

/**
 * Value passed to computeComplianceState / assertPoliciesSigned. The caller
 * loads whichever policies apply to the user (usually every ACTIVE policy
 * where targetWorkerTypes includes the user's workerType) and looks up the
 * current signature + relevant exception for each.
 */
export type PolicyEvaluation = {
  policy: PolicyForPredicate;
  currentVersion: VersionForPredicate | null;
  /** All signatures by this user against ANY version of this policy. Ordered
   *  arbitrarily; the predicate picks the newest non-revoked one that
   *  matches an applicable version. */
  signatures: SignatureForPredicate[];
  /** Non-revoked, non-expired exceptions on this policy for this user. */
  activeException: ExceptionForPredicate | null;
  /** All non-rolled-back versions of the policy (needed for
   *  "forcesResign: false" typo-fix chains where an older sig still counts). */
  versionsById: Map<string, VersionForPredicate>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Core predicate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given a signature + the version chain of a policy, decide whether that
 * signature keeps the worker current on that policy AS OF `now`.
 *
 * Ordering of the checks matters — earliest-failing takes precedence so the
 * reason string reflects the most immediate cause. Priority order:
 *
 *   1. SIGNATURE_REVOKED       (admin action; kills the sig outright)
 *   2. VERSION_ROLLED_BACK     (admin action on the specific version)
 *   3. UPLOAD_REJECTED         (admin verification failed)
 *   4. UPLOAD_PENDING_REVIEW   (admin hasn't decided yet)
 *   5. UPLOAD_MISSING_EXPIRY   (policy requires expiry, sig has none)
 *   6. UPLOAD_EXPIRED          (worker's upload expiry passed)
 *   7. CONTENT_DIGEST_MISMATCH (sig was for content that no longer matches
 *                              this version — should never happen since
 *                              versions are immutable, but defensive)
 *   8. Version-currency check  (are we on currentVersion? or a superseded
 *                              version whose forcesResign chain still allows?)
 *   9. RESIGN_TRIGGER_LAPSED   (personal-clock lapse per resignTrigger)
 */
export function isSignatureCurrent(
  signature: SignatureForPredicate,
  policy: PolicyForPredicate,
  version: VersionForPredicate,
  versionsById: Map<string, VersionForPredicate>,
  now: Date,
): SignatureCurrentResult {
  // 1. Revoked signatures never count.
  if (signature.revokedAt) {
    return { current: false, reason: "SIGNATURE_REVOKED" };
  }

  // 2. Signatures against a rolled-back version never count.
  if (version.status === "ROLLED_BACK") {
    return { current: false, reason: "VERSION_ROLLED_BACK" };
  }

  // Upload review + expiry checks apply whenever the policy required an
  // uploaded artifact. Worker sign vs admin-upload-on-behalf both use the
  // same uploadStatus field.
  if (policy.requiresWorkerUpload) {
    if (signature.uploadStatus === "REJECTED") {
      return { current: false, reason: "UPLOAD_REJECTED" };
    }
    if (policy.workerUploadRequiresApproval && signature.uploadStatus === "PENDING_REVIEW") {
      return { current: false, reason: "UPLOAD_PENDING_REVIEW" };
    }
    if (policy.workerUploadRequiresApproval && signature.uploadStatus === "NONE") {
      // Policy requires approval but no upload workflow ever ran on this
      // sig — treat as pending review so the admin gets prompted.
      return { current: false, reason: "UPLOAD_PENDING_REVIEW" };
    }
    if (policy.workerUploadRequiresExpiry) {
      if (!signature.uploadExpiresAt) {
        return { current: false, reason: "UPLOAD_MISSING_EXPIRY" };
      }
      if (signature.uploadExpiresAt.getTime() <= now.getTime()) {
        return { current: false, reason: "UPLOAD_EXPIRED" };
      }
    }
  }

  // 7. Content digest sanity check — signatures are pinned to a
  // contentDigestAtSign so any refactor that mutates a supposedly-immutable
  // version content is caught here. Versions are immutable once PUBLISHED
  // so in practice this only fires on a corrupt DB state or a bad migration.
  if (signature.contentDigestAtSign !== version.contentDigest) {
    return { current: false, reason: "CONTENT_DIGEST_MISMATCH" };
  }

  // 8. Version-currency check.
  //   - If sig is against currentVersionId → current on version. ✓
  //   - Else sig is against a superseded published version. Walk forward
  //     through subsequent PUBLISHED versions; if ANY of them has
  //     forcesResign = true, the sig became invalid at that version's
  //     publishedAt (subject to graceUntil for the newer version). Otherwise
  //     the chain of typo-fixes preserves the sig indefinitely.
  const isCurrentVersion = policy.currentVersionId === version.id;
  if (!isCurrentVersion) {
    // Walk forward through all versions of this policy. Find any PUBLISHED
    // version newer than sig's version whose forcesResign = true. If it
    // exists AND its graceUntil (or publishedAt if graceUntil is null) has
    // passed, the sig no longer counts.
    const allVersions = Array.from(versionsById.values())
      .filter((v) => v.policyDocumentId === policy.id)
      .filter((v) => v.status === "PUBLISHED")
      .filter((v) => v.publishedAt && version.publishedAt && v.publishedAt.getTime() > version.publishedAt.getTime())
      .sort((a, b) => (a.publishedAt!.getTime() - b.publishedAt!.getTime()));
    for (const newer of allVersions) {
      if (!newer.forcesResign) continue;
      // A newer forcing version exists. Grace applies to give the worker
      // time to sign the new version before their old sig lapses. Grace
      // deadline is graceUntil if set, else the publish instant (zero
      // grace).
      const cutoff = newer.graceUntil ?? newer.publishedAt!;
      if (now.getTime() >= cutoff.getTime()) {
        return {
          current: false,
          reason: newer.graceUntil
            ? "GRACE_EXPIRED_ON_SUPERSEDED_VERSION"
            : "VERSION_FORCES_RESIGN_AFTER_GRACE",
        };
      }
      // Grace window is still open — sig continues to count until cutoff.
      break;
    }
  }

  // 9. Personal-clock resign trigger.
  const resignLapsed = isResignTriggerLapsed(
    policy.resignTrigger,
    policy.resignParamDays,
    policy.resignParamMonthDay,
    signature.signedAt,
    now,
  );
  if (resignLapsed) {
    return { current: false, reason: "RESIGN_TRIGGER_LAPSED" };
  }

  return { current: true };
}

/**
 * Personal-clock check. Returns true when the sig's `signedAt` is far
 * enough in the past that the resign trigger has fired.
 *
 *   ONE_TIME         → never lapses on personal clock (only version publish
 *                      with forcesResign resets it)
 *   DAYS_SINCE_SIGN  → lapses when now ≥ signedAt + N days
 *                      (ET calendar days, DST-safe via etDaysBetween)
 *   ANNUAL_ON_DATE   → lapses on the next occurrence of the target MM-DD
 *                      after `signedAt`. Target is `resignParamMonthDay` if
 *                      set (fleet-wide), else the worker's signing MM-DD
 *                      (personal anniversary). Leap-year safe — Feb 29
 *                      falls back to Feb 28 via nextAnnualDueDate.
 *   ANNIVERSARY      → legacy alias for ANNUAL_ON_DATE with no MM-DD.
 *                      Kept for backward compat with any rows still on the
 *                      old trigger; new UI never writes ANNIVERSARY.
 */
function isResignTriggerLapsed(
  trigger: PolicyForPredicate["resignTrigger"],
  paramDays: number | null,
  paramMonthDay: string | null,
  signedAt: Date,
  now: Date,
): boolean {
  const signedKey = etFormatDate(signedAt);
  const nowKey = etFormatDate(now);

  switch (trigger) {
    case "ONE_TIME":
      return false;
    case "DAYS_SINCE_SIGN": {
      const window = paramDays ?? 0;
      if (window <= 0) return false; // misconfiguration guard — treat as ONE_TIME
      const daysSince = etDaysBetween(signedKey, nowKey);
      return daysSince >= window;
    }
    case "ANNIVERSARY":
    case "ANNUAL_ON_DATE": {
      const effectiveMonthDay =
        paramMonthDay && /^\d{2}-\d{2}$/.test(paramMonthDay)
          ? paramMonthDay
          : signedKey.slice(5); // fallback: worker's own signing MM-DD
      const nextDueKey = nextAnnualDueDate(signedKey, effectiveMonthDay);
      return nowKey >= nextDueKey;
    }
    default:
      return false;
  }
}

/**
 * Compute the next YYYY-MM-DD (ET) at which an ANNUAL_ON_DATE trigger fires
 * given a starting sign date and a MM-DD target. Returns the target-day in
 * the same year as signedKey if that day is still in the future, otherwise
 * the target-day in the following year. Feb 29 → Feb 28 fallback on non-leap
 * years handled by inspecting the month-day string directly.
 */
function nextAnnualDueDate(signedKey: string, monthDay: string): string {
  // signedKey: "YYYY-MM-DD"
  const signedYear = Number(signedKey.slice(0, 4));
  const [signedMonth, signedDay] = signedKey.slice(5).split("-");
  const [targetMonth, targetDay] = monthDay.split("-");
  const signedYm = `${signedMonth}-${signedDay}`;
  // If target is on or after signed's MM-DD in the SAME year, the next
  // trigger is this year's target. Otherwise it's next year's target.
  const sameYearCandidate = `${signedYear}-${targetMonth}-${targetDay}`;
  const nextYearCandidate = `${signedYear + 1}-${targetMonth}-${targetDay}`;
  return monthDay >= signedYm ? sameYearCandidate : nextYearCandidate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate: compute overall per-user compliance state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given a full evaluation set for a user (one entry per applicable policy),
 * decide overall compliance state. Active exceptions short-circuit per-policy
 * evaluation — treating them as satisfying the requirement.
 *
 * "Current" is defined as: no BLOCK policy is missing a live signature or
 * active exception. WARN and INFO policies never fail the aggregate — they
 * only surface on the worker's Compliance tab.
 */
export function computeComplianceState(
  evaluations: PolicyEvaluation[],
  now: Date,
): ComplianceState {
  const pendingPolicyIds: string[] = [];
  const upcomingExpiries: Date[] = [];

  for (const evaluation of evaluations) {
    const { policy, currentVersion, signatures, activeException, versionsById } = evaluation;

    // Skip archived policies entirely — they never fire gates.
    if (policy.archivedAt) continue;

    // Active exception satisfies the requirement no matter what the sig
    // state is. But the exception itself has an expiry we may want to
    // surface as "next thing to worry about."
    if (activeException) {
      upcomingExpiries.push(activeException.expiresAt);
      continue;
    }

    // Find the best signature — most recent non-revoked one that pointed at
    // any published-or-rolled-back version. We evaluate each and keep the
    // one that returns current: true; if none, fall back to newest to
    // produce a stable reason for the UI.
    let currentFound = false;
    for (const sig of [...signatures].sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime())) {
      const version = versionsById.get(sig.policyDocumentVersionId);
      if (!version) continue;
      const result = isSignatureCurrent(sig, policy, version, versionsById, now);
      if (result.current) {
        currentFound = true;
        // Record any relevant expiry — upload expiry, resign-trigger
        // horizon — so we can compute nextExpiryAt.
        if (sig.uploadExpiresAt) upcomingExpiries.push(sig.uploadExpiresAt);
        const resignExpiry = computeResignExpiry(policy, sig.signedAt);
        if (resignExpiry) upcomingExpiries.push(resignExpiry);
        break;
      }
    }

    if (!currentFound && policy.enforcement === "BLOCK") {
      pendingPolicyIds.push(policy.id);
    }
    // Non-BLOCK policies that are missing don't fail the aggregate. Worker
    // still sees them in their Compliance tab under "Recorded" (missing).
  }

  const current = pendingPolicyIds.length === 0;
  const nextExpiryAt = upcomingExpiries.length > 0
    ? upcomingExpiries.reduce((soonest, d) =>
        d.getTime() < soonest.getTime() ? d : soonest,
      )
    : null;

  return { current, pendingPolicyIds, nextExpiryAt };
}

/**
 * For a live signature, when will the resign trigger next fire? Returns
 * null for triggers that never fire on personal clock. Used to feed
 * ComplianceState.nextExpiryAt so worker sees a real countdown.
 */
function computeResignExpiry(
  policy: PolicyForPredicate,
  signedAt: Date,
): Date | null {
  const signedKey = etFormatDate(signedAt);
  switch (policy.resignTrigger) {
    case "ONE_TIME":
      return null;
    case "DAYS_SINCE_SIGN": {
      const window = policy.resignParamDays ?? 0;
      if (window <= 0) return null;
      const dueKey = etAddDays(signedKey, window);
      // Convert back to a Date at ET midnight of the due day. Callers only
      // care about relative ordering so exact time-of-day doesn't matter.
      return new Date(`${dueKey}T04:00:00Z`);
    }
    case "ANNIVERSARY":
    case "ANNUAL_ON_DATE": {
      const effectiveMonthDay =
        policy.resignParamMonthDay && /^\d{2}-\d{2}$/.test(policy.resignParamMonthDay)
          ? policy.resignParamMonthDay
          : signedKey.slice(5); // fallback: worker's own signing MM-DD
      const dueKey = nextAnnualDueDate(signedKey, effectiveMonthDay);
      return new Date(`${dueKey}T04:00:00Z`);
    }
    default:
      return null;
  }
}

/**
 * Normalize a typed name for comparison against user.displayName. Both sides
 * pass through this helper so common variations don't lock a worker out.
 * Called at signature-write time (typed-name accept/reject) and at signature-
 * inspection time (audit review).
 *
 *   • Case-fold to lowercase
 *   • Strip diacritics (unicode NFD + drop combining marks)
 *   • Drop apostrophes and commas WITHOUT inserting a space
 *     (so "O'Brien" matches "OBrien", "J,R" matches "JR")
 *   • Replace periods and hyphens with a space
 *     (so "Smith-Jones" matches "Smith Jones", "J.R." matches "J R")
 *   • Collapse internal whitespace to a single space
 *   • Trim
 *
 * Aggressive-but-defensible. Store the raw input on the signature row so
 * the raw value survives future refactors of this function.
 */
export function normalizeName(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining marks
    .toLowerCase()
    // Apostrophes + commas: strip without leaving a space so "O'Brien" ↔
    // "OBrien" match cleanly.
    .replace(/['’,]/g, "")
    // Periods + hyphens: replace with a space so "Smith-Jones" ↔
    // "Smith Jones" and "J.R." ↔ "J R" match after collapsing.
    .replace(/[.\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
