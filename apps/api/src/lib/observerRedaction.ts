// Observer-role data redaction.
//
// An Observer is a user assigned to a JobOccurrence with `role = "observer"`.
// Per the project's RBAC design, observers (typically trainees or ride-along
// users) need to SEE the basic job — where, when, what, who their teammates
// are — so they know where to show up and can learn. They must NOT see:
//   • Financial details: payment amounts, splits, processor fees,
//     payment method, who collected the payment.
//   • Pricing: the job's price, addon prices, expense costs.
//   • Worker compensation snapshots: completionSplits / promisedPayouts
//     (these are payouts to individual workers and contain the same info
//     as PaymentSplit).
//   • Admin-only client context: vipReason, adminTags.
//
// The Prisma `include` blocks on `getOccurrencesByIds` and
// `listMyOccurrences` always pull these fields because regular workers
// (claimers, helpers, contractors) legitimately need them. Filtering at
// query time would require duplicating the include block; instead, we
// redact in code AFTER the fetch, per-occurrence, based on the caller's
// role on each occurrence.
//
// This file is the SINGLE source of truth for observer redaction. If a
// new sensitive field is added to the occurrence shape, add it here.

type Assignee = { userId: string; role: string | null };

/**
 * Return whether `callerUserId` is assigned to `occ` with role "observer"
 * (and ONLY that role — no separate non-observer entry). Pinned, liked,
 * or deep-linked viewers who are NOT assigned at all return false; their
 * data exposure is a separate concern handled at the route layer.
 */
export function isObserverOnlyAssignee(
  occ: { assignees?: Assignee[] | null } | null | undefined,
  callerUserId: string,
): boolean {
  if (!occ?.assignees) return false;
  const mine = occ.assignees.find((a) => a.userId === callerUserId);
  return !!mine && mine.role === "observer";
}

/**
 * Mutate `occ` in place, stripping every observer-sensitive field. The
 * caller has already determined this user IS observer-only on this
 * occurrence and is NOT an admin. Returns the same reference for
 * chaining.
 *
 * Why mutate instead of clone: these objects come straight from Prisma
 * and live for the duration of one request. Cloning the whole tree is
 * expensive and unnecessary; the redacted shape is what we want to
 * serialize.
 */
export function redactOccurrenceForObserver(occ: any): any {
  // Payment block — strip ALL financial detail. Keep `confirmed` and
  // `writtenOff` status booleans so the observer can see whether the
  // job is settled or still in flight (no dollar amounts).
  if (occ.payment) {
    occ.payment = {
      id: occ.payment.id ?? null,
      confirmed: occ.payment.confirmed ?? null,
      writtenOff: occ.payment.writtenOff ?? null,
      confirmedAt: occ.payment.confirmedAt ?? null,
    };
  }

  // Occurrence-level pricing and worker-payout snapshots.
  if ("price" in occ) occ.price = null;
  if ("proposalAmount" in occ) occ.proposalAmount = null;
  if ("completionSplits" in occ) occ.completionSplits = null;
  if ("promisedPayouts" in occ) occ.promisedPayouts = null;

  // Addon prices — observer sees the addon exists, not the dollar amount.
  if (Array.isArray(occ.addons)) {
    occ.addons = occ.addons.map((a: any) => ({
      ...a,
      price: null,
    }));
  }

  // Expense costs — observer sees the expense itemization (useful for
  // training: "we used 2 bags of mulch") but not the dollar amount.
  if (Array.isArray(occ.expenses)) {
    occ.expenses = occ.expenses.map((e: any) => ({
      ...e,
      cost: null,
      // businessExpense reveals vendor + category — leave those (educational).
    }));
  }

  // Admin-only client context.
  const client = occ.job?.property?.client;
  if (client) {
    if ("vipReason" in client) client.vipReason = null;
    if ("adminTags" in client) client.adminTags = [];
  }

  // Payment-related occurrence-level fields that surface in the JobsTab
  // banner (rejection reasons leak amounts in error text; revert reasons
  // sometimes contain dollar amounts the operator typed).
  if ("lastPaymentRejectionReason" in occ) occ.lastPaymentRejectionReason = null;
  if ("lastPaymentRevertReason" in occ) occ.lastPaymentRevertReason = null;

  // Set a hint flag the frontend can read to render the "observer view"
  // styling. NOT relied on for security (the redaction has already
  // happened); just a UI cue so the operator knows the data is partial.
  occ._observerRedacted = true;

  return occ;
}

/**
 * Convenience wrapper: for an array of occurrences, redact every one
 * where the caller is observer-only and the caller is NOT admin. Admins
 * always see everything regardless of their per-occurrence role.
 */
export function redactObserverFieldsForCaller(
  occurrences: any[],
  callerUserId: string,
  callerIsAdmin: boolean,
): any[] {
  if (callerIsAdmin) return occurrences;
  for (const occ of occurrences) {
    if (isObserverOnlyAssignee(occ, callerUserId)) {
      redactOccurrenceForObserver(occ);
    }
  }
  return occurrences;
}

// ─── Trainee redaction ────────────────────────────────────────────────
//
// A Trainee (User.workerType = "TRAINEE") is a paid worker, but the
// least-trusted classification. They earn (made-whole on underpay,
// same as Employees), but they cannot collect payments, claim jobs,
// or take stakeholder-level actions. The privacy line for Trainees:
// they SEE their own pay but NOT other workers' compensation.
//
// Per-occurrence stripping for a Trainee caller:
//   • payment.splits          → keep only their own row
//   • completionSplits        → keep only their own row
//   • promisedPayouts         → keep only their own row
//   • payment.processorFeeAmount, netReceived, processorFeeAmount  → null
//                                (these are business-internal numbers
//                                that reveal contractor margins)
//   • expenses[].cost         → null (reveals contractor compensation
//                                via the price - expenses identity)
//   • addons[].price          → kept (operational context)
//   • price, proposalAmount   → kept (operational context)
//   • client.vipReason        → kept (operational context — trainee
//                                needs to know to be extra careful)

/** Strip "other workers' compensation" fields from a single occurrence
 *  for a Trainee caller. Mutates in place. The caller has already
 *  verified the caller is a Trainee and is NOT an admin.
 */
export function redactOccurrenceForTrainee(occ: any, callerUserId: string): any {
  // Filter payment.splits to only the caller's own entry.
  if (occ.payment?.splits && Array.isArray(occ.payment.splits)) {
    occ.payment.splits = occ.payment.splits.filter((s: any) => s.userId === callerUserId);
  }
  // Strip processor-fee business-internal fields. amountPaid +
  // confirmedAt + method stay — those describe the client's payment
  // (already operational info), not internal worker compensation.
  if (occ.payment) {
    if ("processorFeeAmount" in occ.payment) occ.payment.processorFeeAmount = null;
    if ("netReceived" in occ.payment) occ.payment.netReceived = null;
  }
  // Filter completionSplits (locked-at-completion percent allocations)
  // and promisedPayouts (locked-at-completion net amounts) to only
  // the caller's entry.
  if (Array.isArray(occ.completionSplits)) {
    occ.completionSplits = occ.completionSplits.filter((r: any) => r.userId === callerUserId);
  }
  if (Array.isArray(occ.promisedPayouts)) {
    occ.promisedPayouts = occ.promisedPayouts.filter((r: any) => r.userId === callerUserId);
  }
  // Expense costs reveal the "what's left for workers" ratio. Hide.
  if (Array.isArray(occ.expenses)) {
    occ.expenses = occ.expenses.map((e: any) => ({ ...e, cost: null }));
  }
  // Hint flag for the frontend.
  occ._traineeRedacted = true;
  return occ;
}

/** For an array of occurrences, apply Trainee redaction when the caller
 *  has workerType = "TRAINEE" and is not an admin. Observers are handled
 *  by `redactObserverFieldsForCaller` separately — order: observer
 *  redaction first (heavier), then trainee redaction on what remains.
 *
 *  Admins always see everything regardless of workerType.
 */
export function redactTraineeFieldsForCaller(
  occurrences: any[],
  callerUserId: string,
  callerWorkerType: string | null | undefined,
  callerIsAdmin: boolean,
): any[] {
  if (callerIsAdmin) return occurrences;
  if (callerWorkerType !== "TRAINEE") return occurrences;
  for (const occ of occurrences) {
    // Don't double-redact observer rows (already stripped to a heavier
    // shape). The `_observerRedacted` hint set in
    // `redactOccurrenceForObserver` marks these.
    if (occ._observerRedacted) continue;
    redactOccurrenceForTrainee(occ, callerUserId);
  }
  return occurrences;
}

// ─── Peek redaction ────────────────────────────────────────────────────
//
// Powers the Worker Jobs "Team" toggle. When a worker turns Team on,
// the client shows occurrences assigned to OTHER workers alongside
// their own. Those cards are strictly view-only on the client, but
// the payload can still leak other workers' pay data (price, splits,
// payouts) since the observer/trainee redaction paths only fire when
// the caller has some assignment relationship to the occurrence.
//
// This helper closes the gap: for any occurrence that HAS assignees
// and the caller is NOT one of them (and not an admin), strip the
// same financial fields observer redaction strips. Unassigned /
// claimable jobs pass through unredacted because the worker
// legitimately needs to see the price to decide whether to claim.

/**
 * True when `occ` has ≥1 assignee AND `callerUserId` is not among them.
 * Announcements + unassigned/claimable jobs return false — those are
 * legitimately visible to any worker without redaction.
 */
export function isPeekingOccurrence(
  occ: { assignees?: Assignee[] | null } | null | undefined,
  callerUserId: string,
): boolean {
  const assignees = occ?.assignees ?? [];
  if (assignees.length === 0) return false;
  return !assignees.some((a) => a.userId === callerUserId);
}

/**
 * For an array of occurrences, strip financial detail from any where
 * the caller is a "peeker" (not an assignee, but the occ has
 * assignees). Reuses `redactOccurrenceForObserver` since the fields
 * to strip are the same — the difference is just which occurrences
 * qualify.
 *
 * IMPORTANT — no admin bypass here (unlike observer/trainee
 * redaction). The peek feature lives on the Worker Jobs tab and its
 * purpose is to give workers a view-only peek at teammates'
 * schedules WITHOUT exposing other workers' pay. Admins using the
 * Worker tab are opting into the worker experience; they see the
 * worker-view redaction alongside everyone else. Admins who need
 * the unredacted picture use the Admin Jobs tab, which hits
 * different endpoints and doesn't touch this helper.
 *
 * Chain order matters: observer redaction first (only affects occs
 * where caller IS an observer-only assignee), then trainee, then peek
 * (only affects occs where caller is NOT assigned at all — disjoint
 * sets, but the `_observerRedacted` guard keeps re-processing cheap).
 * Sets `_peekRedacted = true` as a UI hint.
 */
export function redactPeekFieldsForCaller(
  occurrences: any[],
  callerUserId: string,
): any[] {
  for (const occ of occurrences) {
    if (occ._observerRedacted) continue;
    if (isPeekingOccurrence(occ, callerUserId)) {
      redactOccurrenceForObserver(occ);
      occ._peekRedacted = true;
    }
  }
  return occurrences;
}
