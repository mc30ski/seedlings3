/**
 * HOW A PERSON IS PAID — the one place that decides.
 *
 * Worker type is a TAX AND EMPLOYMENT FACT, never a permission. What someone
 * may do comes from their roles; this answers only how money reaches them.
 *
 * WHY THIS MODULE EXISTS
 * 97 comparisons across 27 files each decided this independently, and the
 * critical one was a NEGATION:
 *
 *     isFeeable = workerType !== "EMPLOYEE"        // "therefore a contractor"
 *
 * That reads the question as binary. Add a third worker type and everyone
 * holding it silently lands in the contractor-fee branch — an unpaid family
 * member charged a share of equipment fees, discovered at tax time if at all.
 *
 * So every predicate here is POSITIVE (`=== "1099"`, never `!== "EMPLOYEE"`),
 * and `classify` is an exhaustive switch: a fourth worker type becomes a
 * COMPILE ERROR here rather than a default somewhere else.
 *
 * G30 fails the build on any `workerType` comparison outside this file.
 */

/** EMPLOYEE and CONTRACTOR are paid. UNPAID is not — a family member or
 *  observer with real access to the app and no place in payroll. */
export const WORKER_TYPES = ["EMPLOYEE", "CONTRACTOR", "UNPAID"] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

/**
 * Runtime validation, so a hand-written list of string comparisons is never
 * the thing deciding what is settable.
 *
 * Two routes validated worker type with their own `wt !== "EMPLOYEE" && wt
 * !== "CONTRACTOR" && wt !== <a third value>` chains. When the enum changed those
 * chains still COMPILED — they compare strings — so they went on accepting a
 * worker type the database had dropped and refusing the one it had gained.
 * The UI offered UNPAID and the API answered 400.
 */
export function isWorkerType(v: unknown): v is WorkerType {
  return typeof v === "string" && (WORKER_TYPES as readonly string[]).includes(v);
}

/** What the money system does with this person. */
export type PayClass =
  /** W-2. Made whole on a write-off; carries no contractor fee. */
  | "w2"
  /** 1099. Carries the contractor fee; not made whole. */
  | "contractor"
  /** Never appears in a split, a wage, a payroll row or a tax export. */
  | "unpaid"
  /** No worker type yet. Not on payroll, and not cleared to act either. */
  | "unclassified";

/**
 * The single decision. Exhaustive on purpose — the `never` check means
 * adding a worker type without considering its pay treatment will not
 * compile.
 */
export function classify(workerType: WorkerType | null | undefined): PayClass {
  switch (workerType) {
    case "EMPLOYEE":
      return "w2";
    case "CONTRACTOR":
      return "contractor";
    case "UNPAID":
      return "unpaid";
    case null:
    case undefined:
      return "unclassified";
    default: {
      const exhaustive: never = workerType;
      throw new Error(`Unhandled worker type: ${String(exhaustive)}`);
    }
  }
}

/** W-2: made whole on a write-off, no contractor fee. */
export const isW2 = (wt: WorkerType | null | undefined) => classify(wt) === "w2";

/**
 * Carries the contractor fee.
 *
 * POSITIVE by design. The old form — "not an employee" — is what would charge
 * an unpaid person a fee the moment a third type existed.
 */
export const isFeeable = (wt: WorkerType | null | undefined) => classify(wt) === "contractor";

/** Appears in payroll at all. False for unpaid AND for unclassified. */
export const isPaid = (wt: WorkerType | null | undefined) => {
  const c = classify(wt);
  return c === "w2" || c === "contractor";
};

/** Must never reach a split, a wage, a payroll row or a tax export (G33). */
export const isUnpaid = (wt: WorkerType | null | undefined) => classify(wt) === "unpaid";

export type Rates = { employeeMarginPercent: number; contractorFeePercent: number };

/**
 * The rate applied to this person's share.
 *
 * THROWS for unpaid and unclassified rather than defaulting. There is no
 * correct rate for someone who is not paid, and a silent default is how an
 * unpaid family member ends up charged a contractor fee. A crash is
 * recoverable; a wrong figure in a 1099 is not.
 *
 * Callers must exclude unpaid people from splits BEFORE reaching this — if
 * this throws, the bug is upstream.
 */
export function rateFor(wt: WorkerType | null | undefined, rates: Rates): number {
  const c = classify(wt);
  switch (c) {
    case "w2":
      return rates.employeeMarginPercent;
    case "contractor":
      return rates.contractorFeePercent;
    case "unpaid":
      throw new Error(
        "rateFor() was handed an UNPAID worker. They must never appear in a " +
          "payment split — exclude them upstream rather than giving them a rate.",
      );
    case "unclassified":
      throw new Error(
        "rateFor() was handed a user with no worker type. Nobody should reach " +
          "a payout calculation before it is decided how they are paid.",
      );
  }
}

/**
 * The rate to SHOW, where `rateFor` is the rate to PAY.
 *
 * Identical for the two paid classes. The difference is the other two:
 * `rateFor` throws, because inventing a rate for a payout is how a wrong
 * figure reaches a 1099. A projection cannot throw — a dashboard must render
 * — so it shows 0, which reads as "nothing projected for you" rather than
 * quietly applying somebody else's rate.
 *
 * WHY THIS EXISTS: five separate places had grown their own
 * `wt === "CONTRACTOR" ? fee : margin`, in two admin stats blocks, a worker
 * projection route, the web preview and the forecast. Every one of them gave
 * an UNPAID person the 30% EMPLOYEE margin and an untyped person the same —
 * a number with no basis, shown as fact. Five copies of a rule is five
 * chances to miss one when the rule changes, and this is the sixth.
 */
export function rateForProjection(
  wt: WorkerType | null | undefined,
  rates: Rates,
): number {
  switch (classify(wt)) {
    case "w2":
      return rates.employeeMarginPercent;
    case "contractor":
      return rates.contractorFeePercent;
    case "unpaid":
    case "unclassified":
      return 0;
  }
}
