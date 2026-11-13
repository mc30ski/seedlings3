// ─────────────────────────────────────────────────────────────────────────────
// WHICH TABS THE PORTFOLIO FILTER ACTUALLY TOUCHES — AND BY WHICH ROUTE IN.
//
// Read by TWO things that must never disagree: the purple strip, which
// says whether the tab you are on is narrowed, and the tab row, which
// marks the tabs that would be. One table, one import.
//
// THIS WAS A SET OF TAB NAMES, and a name cannot answer the question.
// There are two ways to be narrowed and they are not the same event:
//
//   a LENS  — you picked a portfolio from the header chip. A view setting,
//             with an × to clear it.
//   a GRANT — your role was granted INSIDE a portfolio, so that is simply
//             what your access is. No × is offered; there is nothing to
//             switch off.
//
// Most tabs obey both, so one boolean was right for them. `performance`
// obeys ONE: `GET /reports/portfolio-performance` passes `ignoreLens`
// deliberately — the tab exists to compare portfolios side by side, and a
// lens that collapsed it to one would leave nothing to compare — while a
// grant still applies, because that is access rather than preference. With
// a single list there was no entry that was true for both readers:
// omitting it told a grant-limited lead the whole business was in front of
// them, and listing it would have told a lens-holder their lens had
// narrowed a tab that ignored it. So the table now says which kind each tab
// responds to, and the caller supplies which kind is in force.
//
// A THIRD SHAPE, for a tab that is company-wide with one narrowed panel
// inside it: `{ part }` names the panel. The strip stays quiet for those —
// their figures ARE the company's — but it stops claiming the tab is
// wholly company-wide, which is the sentence that was false.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much of a tab a given kind of narrowing takes away.
 *
 *   true        — the tab's own lists and totals narrow
 *   false       — this kind of narrowing does not reach the tab at all
 *   { part }    — the tab is company-wide APART FROM the named panel
 */
export type Narrowed = boolean | { part: string };

/** Which kinds of narrowing are in force for this reader, right now. */
export type NarrowingInForce = {
  /** A portfolio is selected in the header chip. */
  lens: boolean;
  /** This reader's access is confined to a portfolio by a grant, and that
   *  grant actually takes something away — see `portfolioIsNarrowing`. */
  grant: boolean;
};

/**
 * The tabs a portfolio reaches, and how.
 *
 * MEASURED, not assumed: an entry exists only where the tab's endpoints
 * call `portfolioWhere` / `portfolioWhereVia` (or the occurrence and
 * payment variants) in `apps/api`. Ten other route files IMPORT those
 * helpers and never call them, which is why reading the imports gives the
 * wrong answer — check the call sites.
 *
 * This matters because the strip renders ONCE, above the tab row, so it
 * speaks for whatever is underneath it. Saying "showing Durham only" over
 * a Ledger that is showing the whole company is not a small inaccuracy —
 * it is the dangerous direction. The reader takes the company's number for
 * the portfolio's and concludes the month was extraordinary.
 *
 * KEEP IN STEP WITH THE API, IN BOTH DIRECTIONS. Under-claiming was
 * described here as "the safe direction of wrong". It is not, and Repeating
 * proved it: a tab that filters and is missing from this table does not go
 * quiet — the strip prints "— this tab shows the whole business" over rows
 * the filter has already removed. That is the same lie as overclaiming,
 * told the other way round, and it is worse in one respect: overclaiming
 * makes a reader distrust a number they can go and check, while this one
 * tells them there is nothing to check.
 *
 * A tab with no entry here is one the filter never touches. G50 in
 * `permissions-build-gate.test.ts` fails the build if that is untrue.
 */
export const TAB_NARROWING: Record<string, { grant: Narrowed; lens: Narrowed }> = {
  // GET /jobs, /jobs/archived, /occurrences, /board, change requests
  jobs: { grant: true, lens: true },
  // the same occurrence endpoints
  services: { grant: true, lens: true },
  // GET /repeating-streams, which narrows BOTH its rootings — the live
  // occurrences through `job.property` and the dormant streams through
  // `property`. Missing from this table until 2026-11-12, which is how the
  // strip came to say "this tab shows the whole business" above a table the
  // filter had just shortened.
  repeating: { grant: true, lens: true },
  clients: { grant: true, lens: true },      // GET /clients
  properties: { grant: true, lens: true },   // GET /properties, /properties/points
  // GET /payments, /payments/pending, /payment-requests/outstanding
  payments: { grant: true, lens: true },
  collections: { grant: true, lens: true },  // the same payment endpoints
  statistics: { grant: true, lens: true },   // GET /statistics
  // GET /dashboard-summary/aggregate, /operations
  home: { grant: true, lens: true },
  // the pending-approval and outstanding-request panels
  tasks: { grant: true, lens: true },
  displays: { grant: true, lens: true },     // GET /photos for the board

  // ── Narrowed by a grant, DELIBERATELY DEAF TO A LENS ────────────────────
  // GET /reports/portfolio-performance passes `ignoreLens: true`. The tab
  // puts portfolios side by side, so a lens narrowing it to one would empty
  // the comparison it exists to draw; a grant still applies, because a
  // grant is what you may see rather than what you chose to look at. This
  // is the entry the table's shape exists for.
  performance: { grant: true, lens: false },

  // ── Company-wide, with ONE narrowed panel inside ────────────────────────
  // The tree and the assignments come from /portfolios, which never
  // narrows. Only the property picker in the filing dialog reads
  // /properties, so the tab's own content is the company's and one control
  // in it is not.
  portfolios: {
    grant: { part: "the property picker" },
    lens: { part: "the property picker" },
  },
  // Equipment itself is shared across the business. Its Insights panel
  // alone reads /operations, whose figures come from occurrences and
  // therefore do narrow — which is why the popover's "still company-wide"
  // line is true of the equipment and not of that one leaderboard.
  equipment: {
    grant: { part: "the Insights panel" },
    lens: { part: "the Insights panel" },
  },
};

/**
 * What this reader loses on this tab, given what is in force.
 *
 * STRONGEST APPLICABLE WINS. A grant-limited lead who ALSO picks a lens is
 * narrowed by both, and if either takes the whole tab the whole tab is
 * gone — so `true` beats a `{ part }`, and a part beats nothing.
 */
export function tabNarrowing(
  tab: string | null | undefined,
  inForce: NarrowingInForce,
): Narrowed {
  if (!tab) return false;
  const entry = TAB_NARROWING[tab];
  if (!entry) return false;
  const applies: Narrowed[] = [];
  if (inForce.lens) applies.push(entry.lens);
  if (inForce.grant) applies.push(entry.grant);
  if (applies.some((n) => n === true)) return true;
  const part = applies.find((n) => typeof n === "object");
  return part ?? false;
}

/**
 * Is the whole of this tab narrowed?
 *
 * The question the strip's loud state and the tab row's marker both ask.
 * A tab whose figures are the company's with one narrowed panel answers
 * NO — marking it would say its numbers are a portfolio's, which is the
 * overclaim.
 */
export function tabIsFiltered(
  tab: string | null | undefined,
  inForce: NarrowingInForce,
): boolean {
  return tabNarrowing(tab, inForce) === true;
}

/**
 * The one panel that narrows on an otherwise company-wide tab, or null.
 *
 * The strip uses this instead of flatly claiming the tab is the whole
 * business — which is the sentence that was wrong on Equipment and
 * Portfolios, in the small.
 */
export function tabNarrowedPart(
  tab: string | null | undefined,
  inForce: NarrowingInForce,
): string | null {
  const n = tabNarrowing(tab, inForce);
  return typeof n === "object" ? n.part : null;
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
 * A subset of the fully-narrowed tabs by construction: a tab the filter
 * does not touch has no basis to report.
 */
export const MONEY_TABS = new Set(["payments", "collections", "statistics", "home", "tasks"]);

export function tabShowsMoney(
  tab: string | null | undefined,
  inForce: NarrowingInForce,
): boolean {
  return !!tab && tabIsFiltered(tab, inForce) && MONEY_TABS.has(tab);
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
  return grantIsNarrowing(opts);
}

/**
 * The GRANT half of the above, on its own — which is what
 * `NarrowingInForce.grant` wants. Separated because the two halves answer
 * different questions and a caller that conflated them would mark a
 * lens-only reader's tabs as grant-narrowed.
 */
export function grantIsNarrowing(opts: {
  grantCount: number;
  narrows?: boolean;
}): boolean {
  return opts.grantCount > 0 && opts.narrows !== false;
}
