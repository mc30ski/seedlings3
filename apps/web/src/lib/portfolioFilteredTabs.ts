// ─────────────────────────────────────────────────────────────────────────────
// WHICH TABS THE PORTFOLIO FILTER ACTUALLY TOUCHES.
//
// Read by TWO things that must never disagree: the purple strip, which
// says whether the tab you are on is narrowed, and the tab row, which
// marks the tabs that would be. One list, one import.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tabs whose endpoints actually narrow.
 *
 * MEASURED, not assumed: these are the tabs whose endpoints call
 * `portfolioWhere` / `portfolioWhereVia` in `apps/api`. Ten other route
 * files IMPORT those helpers and never call them, which is why reading the
 * imports gives the wrong answer — check the call sites.
 *
 * This matters because the strip renders ONCE, above the tab row, so it
 * speaks for whatever is underneath it. Saying "showing Durham only" over
 * a Ledger that is showing the whole company is not a small inaccuracy —
 * it is the dangerous direction. The reader takes the company's number for
 * the portfolio's and concludes the month was extraordinary.
 *
 * Keep in step with the API. A tab that GAINS portfolio filtering and is
 * not moved into this set will under-claim, which is the safe direction of
 * wrong but still wrong.
 */
export const FILTERED_TABS = new Set([
  "jobs",        // GET /jobs, /jobs/archived, /occurrences, /board, change requests
  "services",    // same occurrence endpoints
  "clients",     // GET /clients
  "properties",  // GET /properties, /properties/points
  "payments",    // GET /payments, /payments/pending, /payment-requests/outstanding
  "collections", // the same payment endpoints
  "statistics",  // GET /statistics
  "home",        // GET /dashboard-summary/aggregate, /operations
  "tasks",       // the pending-approval and outstanding-request panels
  "displays",    // GET /photos for the board
]);

/** Everything the strip must NOT claim to be filtering. */
export function tabIsFiltered(tab?: string | null): boolean {
  return !!tab && FILTERED_TABS.has(tab);
}

/**
 * Of those, the ones showing MONEY — where the filter has two possible
 * meanings and the reader has to be told which one is in force.
 *
 * Everything else the filter touches asks "what is in here now", which has
 * one answer. Only money is timestamped, so only money can be read two
 * ways: everything these properties have ever earned, or only what they
 * earned while in this portfolio.
 *
 * SAID HERE RATHER THAN ONLY ON THE CARDS. The INSIGHTS note carries it
 * too, but not every money tab has an INSIGHTS card — Payments does not —
 * and a label that is sometimes absent is the failure this is against.
 * The strip is on every tab, so the strip is where the guarantee lives.
 *
 * A subset of FILTERED_TABS by construction: a tab the filter does not
 * touch has no basis to report.
 */
export const MONEY_TABS = new Set(["payments", "collections", "statistics", "home", "tasks"]);

export function tabShowsMoney(tab?: string | null): boolean {
  return !!tab && tabIsFiltered(tab) && MONEY_TABS.has(tab);
}


/**
 * Is anything actually being narrowed right now?
 *
 * A grant that filters NOTHING — somebody recorded as leading a portfolio
 * who also holds everything company-wide — must not light anything up.
 * They lead it on paper and see the whole business, so a loud warning
 * would be a false one, every day, until they stopped reading it.
 */
export function portfolioIsNarrowing(opts: {
  lensSet: boolean;
  grantCount: number;
  /** `false` when every capability the grant carries is also held globally. */
  narrows?: boolean;
}): boolean {
  if (opts.lensSet) return true;
  return opts.grantCount > 0 && opts.narrows !== false;
}
