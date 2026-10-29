# Seedlings3 – Lawn Care Service App

Index only. Detail lives in the linked topic files — open the one you need
rather than assuming from the hook. **Counts and line numbers rot; verify
against the repo.**

## Stack
- Turborepo + npm workspaces, Node 20. Vercel; `main` → Preview, `production` → Production.
- **API** `apps/api` — Fastify 4 · Prisma 6 · Neon Postgres (serverless) · `@clerk/clerk-sdk-node`
- **Web** `apps/web` — Next.js 14 (Pages Router) · Chakra UI v3 · `@clerk/nextjs`
- **No mobile app.** `apps/mobile` (Expo + RN Paper) was deleted 2026-10-11 —
  abandoned since 2025-10-13, two screens, never shipped. The approach was
  dropped, not paused: do not describe mobile as deferred or incomplete, and
  do not reintroduce an Expo workspace without asking.

## Key paths
- API: `src/server.ts`, `src/routes/`, `src/services/`, `prisma/schema.prisma`
- Web: `pages/index.tsx` (dashboard + all tabs), `src/ui/tabs/`, `src/ui/dialogs/`,
  `src/lib/api.ts`, `src/lib/types.ts`, `src/styles/themeTokens.ts`
- Proxy `pages/api/_proxy/[...path].ts` (adds Vercel bypass token) · CORS allow-list in `src/routes.ts`
- Shared: `packages/tokens/`, `packages/money/`

## Domain model
`Client` → ClientContact, Property → Job → JobOccurrence → JobOccurrenceAssignee.
`Job` carries its own recurrence (`frequencyDays`) — **there is no JobSchedule model.**
`Equipment` → Checkout (`releasedAt` lifecycle) · `User` → UserCustomRole → `CustomRole` (inheritable, keyed;
**the `Role` enum is deleted**) · Crews = Group/GroupMember/CheckoutSplit ·
`AuditEvent` on every mutation. Soft deletes via `archivedAt`/`retiredAt`.
Schema is large and moves — read it, don't recall it.

## Status
Broadly complete: equipment, clients/properties, jobs + occurrences, the full
financial system (payments, splits, reconcile, taxes, payroll), compliance,
crews, guides, promotions, forecasting, theming. One tab per feature, rendered from entitlements (2026-10-17).
**Known incomplete:** Zod imported in only 2 API files ·
`notifyEquipmentUpdated` dispatches `seedlings3:equipment-updated` with **no
listeners** · Clerk satellite hostnames still hardcoded · large tabs never
split (JobsTab ~11k LOC).

## Notes
- [Capabilities, not roles — the Role enum is DELETED](reference_capabilities_model.md) — `requires()` / `callerCan()` / `scope.can`. **Perspectives were UI-only until 2026-10-23** — two dropped fields hidden by `as never`; now enforced + recorded in the audit.
- [Client vs worker boundary — the payroll gate, not a client flag](reference_client_vs_worker_boundary.md) — a customer MAY also work for you; worker type FIRST, then grant. DB triggers + G45.
- [Role grant rules — one rung + anything else](reference_role_grant_rules.md) — `isLadderRung` not `isSystem`; promotion is one endpoint; `grant-role.ts` is the way back in.
- [Permissions / roles / areas — LARGELY BUILT](project_area_hierarchy_design.md) — pointer to `docs/features/permissions.md`. Four axes, 61 entitlements, custom roles, area tree. Models, routes, RolesTab and AreasTab all exist. **G13 and G25 built 2026-10-18 — no `it.todo` left in the permissions gate.** **Area scoping is now proven against real data (2026-10-22):** integration test + `districtLead`, the 10th Playwright persona (Durham-only Admin). **Area LENS shipped 2026-10-26** — `X-Area-Lens` → `principal.lensPath`; narrows every view from one header chip, intersected so it can never widen (G47).
- [Area → Portfolio — COMPLETE 2026-10-28, dev only](project_portfolios_design.md) — renamed everywhere incl. DB; many-to-many membership; occurrences remember the FULL SET, frozen at completion. **Dev fixture reshaped 2026-10-29 to production's 5-level shape (State→Market→District→Zone + Route/Book), with real overlap** — which exposed a live lens-picker bug. Nothing committed.
- [Portfolio tree for the real business — TREE not built, VOCABULARY shipped](project_area_tree_for_the_business.md) — Chapel Hill / Briar Chapel / Chatham from a 2026-10-27 prod analysis. **Tiers settled 2026-10-29**: State → Market → District → Zone nest; Route and Book cut across. Each carries a description, gated by G49.
- [UI work the backend changes oblige](project_ui_plan_from_backend_changes.md) — verified per consumer. **Latent crash: StatisticsTab reads omitted pay fields.** Guides/marketing gates now narrower than the API. Homeless-user problem proven by 4 zero-capability accounts.
- [Permissions UI — BUILT 2026-10-16, one pass](project_permissions_ui_build.md) — tabs/actions/help all capability-driven; roles + areas builders shipped. 3 open, one blocked on 3 Clerk accounts.
- [Permissions build — BACKEND DONE](project_permissions_build_state.md) — **no flag; the cord is cut.** 61 entitlements, 641 routes, rules numbered G1–G44 across 38 gate files. Deep audit 2026-10-13 fixed an area-grant escalation, a perspective bypass, an unowned photo delete, cron fail-open + 7 entitlement narrowings. **G15, G13 and G25 all built** — G15 in its own gate file; G13 and G25 added 2026-10-18.
- [DEFERRED WORK — read when starting related work](project_deferred_work.md) — postponed items w/ context and rough size.
- [Never commit, push, or deploy — the user does all of it](feedback_never_push_without_permission.md) — HARD RULE, `git commit` included. No exceptions, no urgency override.
- [Production IS reachable — its URL is COMMENTED OUT in `apps/api/.env`](reference_prod_db_url_is_commented_in_env.md) — `ep-noisy-feather` = prod, `ep-jolly-wildflower` = dev. Grep without a `^` anchor; I've twice wrongly said prod was unreachable.
- [Never write to the production database](feedback_never_write_production_db.md) — reads fine; every write is the user's. Validate prod config against `git show HEAD`, not the working tree.
- [Prisma migrations required — never db push](feedback_prisma_migrations.md) — schema changes go through `migrate dev`.
- [Migrate must bypass the Neon pooler](reference_migrate_needs_direct_url.md) — `directUrl`/`DIRECT_URL` added 2026-10-23. Set BOTH vars when overriding `DATABASE_URL`, or you migrate dev while the output says production.
- [Apply migrations to dev immediately](feedback_apply_migration_to_dev_immediately.md) — never let code land while dev DB is on the old schema.
- [No placeholder text in migrations](feedback_no_placeholder_text_in_migrations.md) — a user-facing label written by a migration is permanent; later passes refuse to overwrite it.
- [Never edit an applied migration](feedback_never_edit_applied_migrations.md) — frozen once run; write a NEW one. Editing causes checksum drift.
- [Always audit every mutation](feedback_audit_every_mutation.md) — every state change writes an AuditEvent in the SAME edit. Destructive paths snapshot first.
- [Audit system mechanics](reference_audit_system.md) — `writeAudit(tx, AUDIT.SCOPE.VERB, actor, meta)`. AuditScope/Verb are Prisma enums, so a new scope needs a migration.
- [Confirm dialogs are mandatory](feedback_confirm_dialogs.md) — every Approve/Reject/Adjust/Write-off/Delete/Revert needs one. Mobile-first; accidental taps are real.
- [The app does NOT poll](feedback_no_polling.md) — hard rule; one exception is /display once paired. Gated.
- [Never use native `<select>`](feedback_no_native_select.md) — always Chakra `Select.Root` + `createListCollection`.
- [Theming — 14 themes, test EVERY feature against all](reference_theming.md) — `_dark` misses 4 dark-grounded themes; raw hex/ramp never themes; `solid` is a fill, not an ink.
- [Header strip sets lineHeight:0](feedback_header_line_height_zero.md) — dropdowns inside it collapse to padding; measure row height, don't eyeball.
- [Verify exit codes — never pipe a check through `tail`](feedback_verify_exit_codes_not_pipe_tail.md) — `| tail` reports the pager's status; `apps/api` wasn't typechecking at all and it hid 4 shadowed functions.
- [Run the build gate after every change](feedback_run_build_gate_after_changes.md) — `cd apps/api && npm run test:build-gate` before reporting done.
- [Build-gate roster](reference_build_gates_roster.md) — roster drifts; verify with `ls apps/api/src/services/*-build-gate.test.ts`. The script is a FILTER list — a dead entry shrinks the run silently.
- [Payments build gate](feedback_payments_build_gate.md) — conservation laws, worker classification, tax-export sources. Don't relax without a policy-doc update.
- [E2E suite — GREEN as of 2026-10-22](project_e2e_preexisting_failures.md) — all 4 old root causes resolved; one environmental flake left (`money-flow-variations`, networkidle). Historical triage kept.
- [Never ship a red spec](feedback_never_ship_a_red_spec.md) — a failing e2e pre-deploy is a blocker; one called "flaky" took Ledger down in prod.
- [Match test depth to the change](feedback_test_tier_by_change_size.md) — UI-only → tsc; logic → those specs; API/money → build gate; schema/auth → full Playwright.
- [Never `next build` while dev server or e2e is live](feedback_never_build_while_dev_server_runs.md) — one shared `.next`; it 404s every route and poisons the run.
- [Never mutation-test source while the dev server runs](feedback_never_mutate_source_while_dev_server_runs.md) — a restored file still serves the broken chunk; verify the app, not the diff.
- [Backend API e2e suite — all 639 endpoints](reference_api_e2e_suite.md) — `--project=api`. Covers authz both ways, ownership, public, client-portal. Reads the `in-handler-scoped:` annotation. Use `--no-deps` while iterating or Clerk rate-limits.
- [Playwright + Clerk setup](reference_playwright_setup.md) — e2e at `apps/web/tests/e2e/`, sign-in tickets, 9 seed personas, `E2E_` scratch data.
- [E2E screen measurements need a render wait](feedback_e2e_inventory_measurement.md) — if the numbers improve through the run, you measured compilation. Warm first; never conflate "didn't render" with "empty".
- [E2E cold-compile race — fixed sleeps lose to `next dev`](feedback_e2e_cold_compile_race.md) — a spec failing 3/3 can still be a warm/cold artefact. Copy the file and run the copy before believing it.
- [E2E localStorage stamp race](feedback_e2e_localstorage_stamp_race.md) — stamp `seedlings_lastAppOpenedAt` too, or the first-open-of-the-day takeover drags the run to Work → Home.
- [Fixed sleeps on a loading list lie](feedback_e2e_fixed_sleeps_on_loading_lists.md) — JobsTab shows its empty state mid-fetch; use `waitForJobsListSettled` / `waitForSplashGone`.
- [Await the mutation response, not the optimistic render](feedback_e2e_await_the_mutation_response.md) — a navigation aborts the in-flight POST; read `trace.zip` for status -1.
- [Compliance e2e were passing-by-accident — RESOLVED](project_compliance_banner_specs_dead.md) — read before trusting any green compliance run.
- [Feature specs pattern](reference_feature_specs.md) — `docs/features/<name>.md` is the canonical per-feature spec, bound to a backend gate + Playwright suite. If code and doc disagree, fix both.
- [Date handling — canonical + gated](reference_date_handling.md) — every date op routes through `apps/{api,web}/src/lib/dates.ts`. Forbidden patterns fail CI.
- [fmtDate() date-key off-by-one — FIXED at runtime](feedback_fmtdate_eats_date_keys.md) — formatters auto-route YYYY-MM-DD through a UTC-noon anchor.
- [Branded date types](feedback_date_branded_types.md) — `EtDateKey` / `IsoInstant` make arithmetic drift a compile error.
- [Financial system spec](reference_financial_system_doc.md) — `docs/FINANCIAL_SYSTEM.md` is canonical; read before financial work.
- [Worker class — one place, never a negation](reference_worker_class.md) — `workerClass.ts` owns it. TRAINEE gone, UNPAID added. `!isW2` fails the build (G30); five copies of the rate rule found.
- [Payment math & reconciliation](project_payment_math.md) — per-worker fees per split; employees made whole; shortfall/overage are reporting-only.
- [A split has two money bases](feedback_money_card_two_bases.md) — actual-collected vs promised-invoice; a card must reconcile to its own stated total.
- [Tax export integrity](project_tax_export_integrity.md) — exports pull ONLY raw cash-flow fields. Margin/shortfall are dashboard-only, never tax lines.
- [Expenses vs charges vs supplies](reference_expenses_charges_supplies.md) — two-books model; the Ledger is the only deduction.
- [Business Start Date filter](feature_business_start_date.md) — hides pre-cutoff money from every view/export. Use `businessStartCutoff.ts` helpers. Prod default OFF.
- [Equipment rental is income](project_equipment_rental_income.md) — `Checkout.rentalCost` is INCOME. **`EQUIPMENT_BILLING_ENABLED` is currently OFF.**
- [Per-job equipment billing](feature_per_job_equipment_billing.md) — `Equipment.equivalentJobs` (NULL = flat daily). Don't reconstruct cost from days × rate.
- [Job-service pause REMOVED](project_pause_redesign.md) — it was archive under another name. Holding work = reason-coded pause on the repeating occurrence, with history. Unarchive is the way back.
- [Crews shipped](project_crews_roadmap.md) — splits written at release time. Two policy quirks — read before touching equipment billing.
- [Payroll — Gusto CSV, three-tier visibility](reference_payroll.md) — rate columns aren't additive, blank ≠ zero, names never auto-matched.
- [Never connect imported payroll to the P&L estimate](feedback_payroll_estimate_actual_firewall.md) — ground truth vs tunable estimate; bidirectional gate.
- [Exports/Reconcile default range](feedback_exports_default_range.md) — this calendar week Mon–Sun, never rolling today-7.
- [Guaranteed Payout REMOVED](project_guaranteed_payout_removal.md) — feature and columns dropped; AuditVerb values kept. Don't reintroduce.
- [Tips feature — designed, NOT built](project_tips_feature_design.md) — overpayment→tip split, spec agreed.
- [Forecast tool](project_forecast_tool.md) — Money → Forecast. Built, **never used by the user**. Migration applied to DEV only.
- [Resolve roles from req.user, never a DB lookup](feedback_role_resolution_from_req_user.md) — a fresh read bypasses view-as and restores real powers.
- [Claimer invariant — canonical + gated](reference_claimer_invariant.md) — an occurrence is UNCLAIMED or has exactly ONE claimer. "Workers, no claimer" = unstartable for everyone below admin, no button, no reason shown.
- [View-as endpoints — canonical + gated](reference_view_as_endpoints.md) — every `GET /me/*` takes `?viewAsUserId` or carries `// view-as-allow:`. Shipped 3×.
- [Client View-As was dead in the browser — REPAIRED 2026-10-18](project_client_view_as_shell_repair.md) — four reads of `isClientContact`; never read localStorage during render.
- [Worker sensitive-data guardrails](reference_worker_sensitive_data.md) — worker views must NEVER expose email, wage, roles or cost-split percentages.
- [Auth plugin MUST await recordSignInIfNew](project_auth_plugin_must_await_recordsignin.md) — fire-and-forget strands a Neon transaction and hangs every `/api/me`.
- [Local .env is TEST Clerk even against prod DB](reference_local_env_is_test_clerk.md) — prove a key reaches the right instance before trusting a 404.
- [Clerk satellite hostnames hardcoded](project_clerk_satellite_hardcoded_hostnames.md) — move to `NEXT_PUBLIC_*` env vars, not DB settings.
- [Multi-domain / auth — design first](feedback_multi_domain_design_first.md) — full design pass and sign-off before implementing; no reactive patching.
- [README holds operational procedures](reference_readme_holds_procedures.md) — QR generation, deploy steps. Grep it before saying something is undocumented.
- [Check current docs BEFORE diagnosing infra bugs](feedback_check_current_docs_before_diagnosing.md) — WebFetch docs + issues first. Don't extrapolate from training data.
- [Neon pipelineConnect=false workaround](project_neon_pipelineconnect_workaround.md) — issue #209; don't remove, don't add aggressive pool config.
- [Detached Prisma include bypasses TypeScript](reference_prisma_detached_include.md) — lift an include into a `const` and TS stops key-checking it.
- [ONE tab per feature, built from entitlements](reference_tab_blend_pattern.md) — `Scope` has one field, `can`. Surface flags and `purpose` are DELETED. Name a flag for its capability, never for a role.
- [A UI gate must name its own endpoint's capability](feedback_ui_gate_must_match_its_endpoint.md) — two silent 403s found 2026-10-19; `persona-sweep` is the oracle, one refusal at a time.
- [Tab ordering canonical](reference_tab_ordering.md) — top-tab order + per-role sub-tabs + catMap dispatch. superCatMap bugs cause cross-tab jumps.
- [Tab-blend refactor 2026-08-21](project_tab_refactor_2026_08_21.md) — read before assuming any tab is a stub; files renamed/created/deleted.
- [Worker Compliance UI](reference_worker_compliance_ui.md) — per-row Sign, batch Sign all, view signed doc on ProfileTab.
- [AppSplash stable — don't regress](feedback_appsplash_stable_dont_regress.md) — the 2026-08-15 combination works; any change needs a design pass first.
- [Education guides](feature_education_guides.md) — Records → Guides. R2 configured in DEV (11 objects, verified 2026-10-13); **Vercel Preview/Production unverified.**
- [Weather config — two systems, one key](reference_weather_config.md) — WeatherBar needs `WEATHER_API_KEY` (**never seeded**); hourly occurrence forecast is open-meteo, no key. Settings upserts preserve `value`. **Area lens now overrides the business address** — `Area.lat/lng`, operator-set.
- [Property parcel lookup](feature_property_parcel_lookup.md) — free county acreage + imagery, no API keys. Orange County publishes no addresses.
- [CompanyDocument → Google Drive backup](project_documents_gdrive_backup.md) — BUILT: services, models, 7 routes, cron, Sync Status panel. Google Cloud/OAuth config unverified.
- [Config-driven taxonomies](feedback_config_driven_taxonomies.md) — user-facing taxonomies are JSON settings, not DB enums.
- [Names must carry their meaning](feedback_names_carry_meaning.md) — a role-named boolean read as a visibility rule and hid clients' completed jobs in prod. Renamed to `mustBeAssigned` 2026-10-17.
- [Size findings to their real impact](feedback_dont_inflate_findings.md) — user reads length as self-justification. Own mistakes in two sentences.
- [Step-by-step walkthroughs — one step at a time](feedback_step_by_step_walkthroughs.md) — give ONE step and wait. Never dump the numbered list.
- [Reseed trigger phrases](feedback_reseed_phrases.md) — "reseed" / "reseed payment" / "reseed payment clean". Just run it.
- [Run tests trigger phrases](feedback_run_tests_trigger.md) — "run tests" = API build gate + Playwright e2e. Don't ask which subset.
- [Always seed dev myself](feedback_always_seed_dev.md) — touch seed.ts → run `npm run db:seed` before reporting done.
- [New Setting rows → upsert dev directly](feedback_settings_dev_then_neon.md) — seed.ts alone isn't enough; user copies to prod via Neon UI.
- [Memory is version-controlled, user commits it](feedback_commit_memory_by_design.md) — write memory edits, name them in the summary, don't commit.
- [Company contact email](project_company_email.md) — admin@seedlingslawncare.com is the company address.
- [User operates in NC](user_location_nc.md) — federal $7.25/hr, no higher state floor.
- [Test users purged from production](project_mark_baliff_purge.md) — Mark Baliff + Matthew Wanderski reassigned, not deleted. Open: David has W-2 wages, no Gusto record.
- [Legacy code-pattern reference](patterns.md) — pre-blend template shapes; superseded for tabs, still useful for API route/service scaffolding.
