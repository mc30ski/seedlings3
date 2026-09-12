---
name: project-forecast-tool
description: "Super → Money → Forecast: advisory pay-structure simulator. Built 2026-09-02, works end to end. State, decisions, known defects and what's left."
metadata: 
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-10T00:00:00.000Z
---

Pay-structure simulator at **Super → Money → Forecast**. Pick a window of real jobs, move levers (margin, hourly base, prices, volume, cost inflation, crew composition), see what the books AND every named worker's hourly rate would have looked like. Grew out of the 2026-09-02 analysis that found labor at 70.6% of revenue against 37.9% opex.

**ADVISORY.** Writes no Setting, no Payment, no payroll row. Gated.

## Where the code is

| Piece | Path |
| --- | --- |
| Shared pure math | `packages/money/` — `payoutMath.ts` (moved out of `services/payments.ts`) + `forecastModel.ts` |
| API service / routes | `apps/api/src/services/forecast.ts`, `src/routes/forecast.ts` (Super-gated) |
| Cost behavior setting | `apps/api/src/services/costBehavior.ts` |
| Web | `apps/web/src/lib/forecast.ts`, `src/ui/tabs/ForecastTab.tsx` + `.parts.tsx` |
| Gates | `services/forecast-build-gate.test.ts` (35), `services/settings-section-build-gate.test.ts` (8) |

`apps/api/tsup.config.ts` was also recreated — it had been broken since `39c7edb` (pointed at removed entrypoints), so `npm run build` failed. Now builds `src/server.ts` to CJS with `noExternal: [/^@repo\//]`.

## Decisions worth not relitigating

- **Payout math is shared, not duplicated.** The simulator calls the same `computeBreakdown` that writes real PaymentSplit rows; a gate asserts it owns no split arithmetic. `packages/money` is dependency-free (WorkerType is a local string union) so it bundles into both the browser and Fastify.
- **Simulation runs client-side** through that same module, so slider drags are instant and can't drift from the server.
- **Cost behavior is its own setting** (`EXPENSE_COST_BEHAVIOR`), NOT a field on `EXPENSE_CATEGORIES`. Putting it there took production down — see [[feedback-never-write-production-db]]. A bad value here degrades the forecast to `VARIABLE` defaults and cannot reach the ledger. **`statutoryKind` IS on `EXPENSE_CATEGORIES`** (added 2026-09-10) — the opposite call, and deliberate: it is a property of the category itself, and a missing value degrades to `null` rather than to a wrong behavior. The deploy order is what matters, not the location: code first, then config.
- **Costs are amortized over their coverage, income is not** (2026-09-10). A row with a `recurrence` is charged to a window by overlapping coverage, not by payment date, so a 3-month window carries ~¼ of an annual policy. The cash-basis toggle was REMOVED rather than defaulted — "why would forecasting ever make sense on cash basis" — and the blue explainer says outright that this is not full accrual because revenue is still cash-collected.
- **Workers comp is derived, never typed.** Tag a category `statutoryKind: WORKERS_COMP` in Settings and raising the comp rate automatically removes that window's amortized premium before re-deriving comp from wages. The old hand-entered `workersCompInExpenses` field is retired (`migrateAssumptions` strips it from saved blobs). The offset is summed off the RESOLVED cost lines inside `simulate`, not off a baseline scalar, so it can never remove more than the scenario carries. The double-count warning now fires only when NOTHING is tagged — zero dollars and zero tags are different problems.
- **In the Forecast, a recurring row is never a capital purchase.** `isFixedAsset` is cost-only by design (right for the QB export), and that broke the moment costs were amortized: the prod `2026-08-10 · $928 · ANNUALLY` comp premium cleared the $500 threshold, so the full ticket was recorded as the category's capital slice while `amount` held only the coverage share — and `excludeFixedAssets` (ON by default) subtracted one from the other, reporting Insurance as a large NEGATIVE cost. Scoped to the forecast; the P&L and QB fixed-asset export keep their policy.
- **Firewall respected.** Employer tax comes from `payrollTaxEstimates`, never imported Gusto rows — gated, same reasoning as [[feedback-payroll-estimate-actual-firewall]].
- **Hiring has two modes and the tool makes you pick.** `ADDED_CAPACITY` (new revenue, assumes you can sell it) vs `SUBSTITUTION` (same revenue, different cost). Conflating them is the easiest way to make the tool lie.
- **Owner labor is off by default** — the owner has never actually drawn (zero `OWNER_DRAW` rows ever), so the cash view excludes it.

## Deploy checklist

1. ~~`prisma migrate deploy`~~ — **DONE.** `20260902172341_add_forecast_and_cost_behavior` is applied to prod; verified 2026-09-10 (the `Forecast` table exists and holds the "Summer 2026" scenario). The `statutoryKind` work needs NO migration — it lives inside the `EXPENSE_CATEGORIES` Setting's JSON value, not in a column.
2. Production settings are already in place: `WORKERS_COMP_PERCENT_OF_WAGES` (=12) and `EXPENSE_COST_BEHAVIOR` (18 categories) — the user ran the SQL themselves on 2026-09-02.
3. The deploy also carries the `vanity` Settings section fix, which moves two startup-animation settings out of "Other".

## Known defects / gaps (from a self-audit the user asked for)

- **No leak-finding.** The tool changes rates well and cannot show *where money leaks*. Absent: price-band economics (sub-$45 jobs return $59/labor-hr vs $100 in the $60–80 band), the 11 jobs that collected $0, fully-loaded cost per clocked hour. These were the report's best findings and the tool reproduces 2 of its 6.
- **No break-even solver.** Agreed in design, never built. "What price gets me 15% with nobody under $22/hr" has to be hunted with sliders.
- **Rate card is one flat $/job** — a $289 one-off pays the same as a $50 mow. The report recommended a card by job type/size.
- **`VARIABLE` and `PER_JOB` now behave identically** (both follow the volume multiplier). Kept as separate tags because they mean different things and would diverge if job COUNT and job SIZE ever become separate levers.
- **No month dimension.** One aggregate per window. Costs cash timing ("does November clear payroll?") and forces volume to be a flat scalar rather than a seasonal curve. Medium, not critical — choosing the base window covers most of the seasonality question.
- **No export**, no `docs/features/forecast.md`. There ARE e2e specs now (`forecast-money-table-admin`, `forecast-saved-window-admin`, `settings-statutory-kind-admin`); the earlier "Playwright nav kept failing" was a stamping race, not a Playwright limitation — see [[feedback-e2e-localstorage-stamp-race]].
- Dead schema: `Forecast.compareFrom` / `compareTo` are stored and never read.

## Two bugs already found and fixed by actually running it

- Comparison replayed every saved scenario against the *currently loaded* window while labelling each row with its own — spring's label over summer's numbers. Now fetches each scenario's own baseline; skips a row rather than substituting.
- `VARIABLE` costs scaled by revenue, so a price increase inflated the fuel bill for driving identical routes. Now follows job volume, with a separate `costInflationPercent` lever the user asked for.

## Artifacts

- Original analysis that motivated it: https://claude.ai/code/artifact/2bed508f-2206-480b-b0b9-2a53500b029a
- Self-audit with role lenses + fix order: https://claude.ai/code/artifact/f32ff540-21cb-448a-ba3c-6a24833fe9af

## Still open after the 2026-09-10 session

- **Production `EXPENSE_CATEGORIES` config change is the user's to run via Neon**, and only AFTER this code deploys. Split Insurance into `Insurance — workers comp` (tag WORKERS_COMP) + `Insurance — general liability` (tag GENERAL_LIABILITY), KEEPING the plain `Insurance` label as the catch-all so the 7 existing insurance ledger rows aren't orphaned. Then retag those rows.
- `apps/api/diag-real.ts` was a scratch file picked up in commit `6d8c40f`; deleted 2026-09-12.

## Where it left off

**The user has not used the tool yet.** They asked to context-switch on 2026-09-02 after a rough session. Next step is theirs: open the tab, use it, report what's actually wrong. Their list will beat the audit's. Don't start building from the fix-order list without them.
