// ─────────────────────────────────────────────────────────────────────────────
// MONEY BASIS — which question a portfolio-filtered money figure answers.
//
// The portfolio filter means two different things depending on the surface,
// and until this existed nothing on screen said which:
//
//   · Properties, Clients and Jobs filter on membership AS IT IS NOW.
//   · Payments and Statistics filtered on membership AS IT WAS when the
//     visit completed.
//
// Both are legitimate. Tag 35 properties into a new zone and the property
// list says 35 immediately while the money says $50, because that work was
// earned before the zone existed. Neither number is wrong; they answer
// different questions in one panel.
//
//   "today"     — everything these properties have ever earned, regardless
//                 of when they joined the portfolio. Moves with the
//                 property. THE DEFAULT, because it is what every other
//                 tab means by the same filter.
//   "happened"  — only what was earned while the property was in this
//                 portfolio. Never moves when you reorganise. The honest
//                 basis once somebody's pay or review depends on a
//                 territory's number.
//
// NEITHER BASIS WRITES ANYTHING. Both read data that already exists: the
// occurrence's own frozen membership for "happened", the property's
// current membership for "today". Switching is a reading choice, and that
// is the whole reason this is a header and not a migration. A backfill
// that moved completed visits onto their new portfolio was designed,
// built and deleted on 2026-10-29 in favour of this.
//
// IT IS NOT AN AUTHORITY FACT, so it is deliberately NOT on `Principal`.
// `can()` must never see it. It changes which ROWS match, never which
// portfolios a caller may ask about — the intersection in portfolioScope
// is untouched, and a basis cannot widen anything.
//
// Policy, defaults and open questions: docs/features/portfolio-money-basis.md
// ─────────────────────────────────────────────────────────────────────────────

export const MONEY_BASIS_HEADER = "x-money-basis";

export type MoneyBasis = "happened" | "today";

/**
 * The basis for this request.
 *
 * DEFAULTS TO "today" ON ANYTHING UNRECOGNISED, including absent. Every
 * caller that predates this header — a cron job, a script, an old tab left
 * open — gets the default rather than the other answer, and there is no
 * input that produces a 4xx. A reporting preference must never be able to
 * fail a request.
 */
export function parseMoneyBasis(
  value: string | string[] | undefined | null,
): MoneyBasis {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  return raw === "happened" ? "happened" : "today";
}
