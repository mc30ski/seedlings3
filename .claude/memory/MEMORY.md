# Seedlings3 – Lawn Care Service App

## Stack
- **Monorepo**: Turborepo + npm workspaces, Node 20
- **API**: Fastify 4 + Prisma 6 + Neon Postgres (serverless), deployed on Vercel
- **Web**: Next.js 14 + Chakra UI v3, deployed on Vercel
- **Mobile**: Expo 51 + React Native Paper (early prototype stage)
- **Auth**: Clerk (web uses `@clerk/nextjs`, API uses `@clerk/clerk-sdk-node`)
- **Deployment**: Vercel; `main` → Preview, `production` → Production

## Key Paths
- API entry: `apps/api/src/server.ts`, routes in `apps/api/src/routes/`
- Services: `apps/api/src/services/` (clients, jobs, equipment, users, etc.)
- Prisma schema: `apps/api/prisma/schema.prisma`
- Web pages: `apps/web/pages/index.tsx` (main dashboard with tabs)
- Web tabs: `apps/web/src/ui/tabs/`
- Web dialogs: `apps/web/src/ui/dialogs/`
- Web API layer: `apps/web/src/lib/api.ts`, `apps/web/src/lib/services.ts`
- Web types: `apps/web/src/lib/types.ts`
- Design tokens: `packages/tokens/`

## Domain Model
- **Client** → ClientContact (1:M), Property (1:M)
- **Property** → Job (1:M)
- **Job** → JobSchedule (1:1), JobOccurrence (1:M), JobAssigneeDefault (1:M)
- **JobOccurrence** → JobOccurrenceAssignee (1:M)
- **Equipment** → Checkout (1:M, with releasedAt lifecycle)
- **User** → UserRole (WORKER | ADMIN | SUPER)
- **AuditEvent**: tracks all mutations

## What's Implemented (updated 2026-08-21)
- Equipment management (checkout, reserve, release, maintenance, QR scanning) — Inventory tab
- User approval flow + role assignment — Users tab (blended: Worker sees `WorkerTeamRoster`)
- Client, Contact, Property CRUD (web + API)
- Job template + scheduling + occurrence generation (API + JobsTab — ~9929 LOC)
- Audit logging — AuditTab wired to `/api/admin/audit`
- Activity — ActivityTab wired to `/api/admin/users/:id/activity`
- Full financial system: payments, splits, reconciliation, exports (Reconcile tab replaces old Exports + P&L), taxes (see `docs/FINANCIAL_SYSTEM.md`)
- Per-job equipment billing, Business Start Date filter (Contractor Guaranteed Payout was REMOVED 2026-08-31)
- Crews (Group / GroupMember / CheckoutSplit)
- Compliance: policies + signatures + wizard + banner (worker + admin surfaces)
- Web dashboard: fully blended tabs across Worker / Admin / Super (see [[reference-tab-blend-pattern]] and [[reference-tab-ordering]])
- Auth (Clerk), RBAC decorators, auto-provisioning of new users, view-as impersonation

## What's Incomplete / TODO
### Web UI
- **Large-file compartmentalization** deferred (JobsTab ~9929 LOC, AdminComplianceTab ~3636 LOC, InventoryTab ~3868 LOC).
- **CompanyDocument → Google Drive backup**: designed, no code yet — see [[project-documents-gdrive-backup]].
- **Cross-tab auto-refresh**: `notifyEquipmentUpdated` emitted but no listeners in sibling tabs.

### API
- **Clerk satellite hostnames hardcoded** — planned move to `NEXT_PUBLIC_*` env vars, see [[project-clerk-satellite-hardcoded-hostnames]].
- Zod validation imported but not widely used.
- `ws` package still installed for Neon serverless (required); see [[project-neon-pipelineconnect-workaround]].

### Mobile
- Very early prototype; no Clerk auth integration
- AvailableScreen incomplete
- No navigation, no admin screen

## Notes
- [Tab-blend refactor completed 2026-08-21](project_tab_refactor_2026_08_21.md) — every role-aware tab converted to additive-scope pattern. Files renamed (EquipmentTab→InventoryTab), created (CollectionsTab, SignedPolicyViewDialog), deleted (WorkerCollectionsTab, AdminCollectionsTab, EquipmentUsageTab). MANY sections of the "What's Implemented / TODO" summary above are stale — read this memo before assuming any tab is a stub. Domain summary bullets pre-date the refactor.
- [Additive-scope tab pattern](reference_tab_blend_pattern.md) — canonical `scope: { isWorker, isAdmin, isSuper }` prop shape. **Critical rule: `showSuperExtras` must NOT fall back to `forAdmin ||`** or a super-role user viewing the Admin tab leaks super buttons. InventoryTab is the gold standard reference.
- [Tab ordering canonical](reference_tab_ordering.md) — top-tab order (Work → Equipment → Directory → Money → Records → Tools → System) + per-role sub-tab order + catMap dispatch rules. `superCatMap` bugs cause cross-tab jumps to land on the wrong category.
- [Worker sensitive-data guardrails](reference_worker_sensitive_data.md) — Users/Groups worker views must NEVER expose email, wage, roles, or cost-split percentages. Uses new `/api/me/team` + `/api/me/groups` sanitized endpoints; client also re-scrubs.
- [Worker Compliance UI](reference_worker_compliance_ui.md) — per-row Sign + batch "Sign all" + View-signed-document affordances on ProfileTab. New SignedPolicyViewDialog for re-viewing. Server payload was extended with content fields.
- [Prisma migrations are required — never use db push](feedback_prisma_migrations.md) — schema changes must go through `prisma migrate dev`. User has been burned by `db push` repeatedly.
- [Apply migration to dev immediately](feedback_apply_migration_to_dev_immediately.md) — never let code dependent on a new table land while the dev DB is still on the old schema. Retry `prisma migrate dev` / `deploy` the moment the DB is reachable.
- [Never edit an applied migration file](feedback_never_edit_applied_migrations.md) — once `migrate dev` has run the file, it is FROZEN. If a backfill / fix is needed, write a NEW migration. Editing produces checksum drift that breaks dev and can strand prod.
- [fmtDate() date-key off-by-one — FIXED at the runtime layer](feedback_fmtdate_eats_date_keys.md) — Every web date formatter now auto-routes YYYY-MM-DD strings through a UTC-noon anchor so the calendar day never rolls. Historical shipped bug now impossible for any caller. New style guideline: prefer `fmtDateKey(k)` / `fmtDateShort(d)` / `fmtDateLong(d)` at new callsites for clarity. Build gate now has 15 rules; retired the `fmtDate(*Key)` rule (redundant with runtime fix).
- [Branded date types — arithmetic-drift class of bug now compile-time impossible](feedback_date_branded_types.md) — Phase 2 shipped `EtDateKey` and `IsoInstant` brands. Producers return branded types; arithmetic/parse consumers require them. Passing a Prisma `startAt` (ISO datetime) to `bizAddDays` (expects date-key) is now a TypeScript error, not a silent regex-fail. ~30 files touched, ~65 boundary casts added, zero runtime behavior change. Complements the Phase 1 formatter auto-route.
- `apps/api/prisma/schema.prisma` (model + migration counts drift — check the file)
- Web API proxy: `pages/api/_proxy/[...path].ts` (adds Vercel bypass token)
- CORS: environment-aware origin allow-list in `apps/api/src/routes.ts`
- Pattern: soft deletes via `archivedAt`/`retiredAt` timestamps
- UsersTab, ActivityTab, AuditTab (formerly AuditLogTab) fully implemented; blended to the additive-scope pattern in the 2026-08-21 refactor.
- See `patterns.md` (legacy long-form reference) and `[[reference-tab-blend-pattern]]` (current) for tab structure.
- [Legacy code-pattern reference](patterns.md) — pre-blend tab/route/service template shapes; superseded for tab conventions but still useful for API route + service scaffolding.
- [Company contact email](project_company_email.md) — admin@seedlingslawncare.com is the company address; mike@wanderski.com is personal
- [Crews shipped](project_crews_roadmap.md) — Group/GroupMember/CheckoutSplit are live; group rentals split via writeCheckoutSplits at release time. Two policy quirks (employee-claimer = whole crew free; employees inside contractor-claimer crews currently get charged) — read the memo before touching equipment billing.
- [Guaranteed Payout REMOVED 2026-08-31](project_guaranteed_payout_removal.md) — feature deleted, columns + GuaranteedPayoutAdvance dropped. AuditVerb enum values intentionally kept (live rows). Don't reintroduce.
- [Tips feature — designed, NOT built](project_tips_feature_design.md) — overpayment→tip split, agreed spec. Was blocked on GP; now unblocked.
- [Payment math & reconciliation policy](project_payment_math.md) — per-worker fees applied to each split, employees+trainees made whole on underpay, contractors pro-rata; shortfall/overage tracked as internal reporting fields only (cash-basis, no Bad Debt Expense line).
- [Tax export integrity](project_tax_export_integrity.md) — QuickBooks/tax exports must pull ONLY raw cash-flow fields (Payment.amountPaid, PaymentSplit.amount, Expense.cost). Shortfall/overage/margin breakdowns are operator-dashboard fields only, never tax line items.
- [NEVER commit, push, or deploy — the user does all of it](feedback_never_push_without_permission.md) — HARD RULE. `git commit` included, unconditionally (2026-08-26: "I'll do commits and push to production always, you should not be doing that"). No standing auth, no urgency-as-permission, no hotfix exceptions. `FIX IT NOW` authorizes editing, NOT recording or publishing. Finish the edits, run the gates, report the file list, stop.
- [ALWAYS audit every mutation — table stakes](feedback_audit_every_mutation.md) — every state-changing mutation MUST write an AuditEvent, in the SAME edit as the mutation. A 2026-08-22 sweep found 158 unaudited mutations (46 HIGH); five services had ZERO coverage since they shipped (expenses, mileage, supplies, groups/Crews, vehicles). An ordinary cash payment wrote no audit row at all. Destructive paths must snapshot what they destroy BEFORE deleting.
- [Audit system mechanics](reference_audit_system.md) — `writeAudit(tx, AUDIT.SCOPE.VERB, actorUserId, meta)`; constants in `apps/api/src/lib/auditActions.ts`; **AuditScope/AuditVerb are Prisma enums so a new scope needs a migration**; HistoryTab hardcodes no scope list so new scopes appear automatically.
- [Memory is version-controlled, but the user commits it](feedback_commit_memory_by_design.md) — `.claude/memory/` is in the repo and tracked, so memory edits land in `git status`. Write them, then name them in the change summary. **Do not commit them** — that standing permission was revoked 2026-08-26.
- [Confirm dialogs are mandatory for mutations](feedback_confirm_dialogs.md) — every Approve/Reject/Adjust/Write off/Delete/Revert/etc. button needs a ConfirmDialog. Mobile-first; accidental taps are common. User has called this out multiple times.
- [NEVER use native `<select>` — always Chakra Select.Root](feedback_no_native_select.md) — every dropdown/picker in apps/web uses Chakra v3 `Select.Root` + `createListCollection` with `positioning={{ strategy: "fixed", hideWhenDetached: true }}`. The user has corrected this many times — don't write `<select>` or `<option>` anywhere.
- [User operates in NC](user_location_nc.md) — federal $7.25/hr applies, no higher state floor. Don't default jurisdiction-dependent settings to NJ/NY/CA examples.
- [New Setting rows → upsert dev DB directly](feedback_settings_dev_then_neon.md) — editing seed.ts isn't enough; run a one-off `prisma.setting.upsert` script so the row exists before the next reseed. User then copies to prod via Neon UI.
- [Reseed trigger phrases](feedback_reseed_phrases.md) — "reseed" = default, "reseed payment" = payments-active, "reseed payment clean" = payments-clean. Just run; don't ask which env.
- [Run tests trigger phrases](feedback_run_tests_trigger.md) — "run tests" / "run the test suite" / "run e2e" = run API build gate + Playwright e2e; report results concisely. Don't ask which subset.
- [Always seed dev myself](feedback_always_seed_dev.md) — when I touch seed.ts (new Setting, etc.), run `npm run db:seed` in dev BEFORE reporting done. I own dev seeding; user owns prod (via Neon UI).
- [Step-by-step walkthroughs — one step at a time](feedback_step_by_step_walkthroughs.md) — for UI walkthroughs / procedures, give ONE step and wait. Never dump the full numbered list. User has explicitly called this out.
- [Config-driven taxonomies](feedback_config_driven_taxonomies.md) — user-facing taxonomies should be JSON-settings driven, not DB enums; a method/option picker is never a "static use", convert it. PropertyKind/ContactRole flagged next.
- [Financial system spec](reference_financial_system_doc.md) — `docs/FINANCIAL_SYSTEM.md` is the canonical payments/taxes/expenses reference; read before financial work, update on intentional change.
- [Business Start Date filter](feature_business_start_date.md) — non-destructive money cleanup. When toggled on, pre-cutoff Payments/Expenses/Checkouts/AuditEvents hidden from every view & export. Use the helpers in `apps/api/src/lib/businessStartCutoff.ts` when adding any money-related query. Production-default OFF.
- [Equipment rental is income](project_equipment_rental_income.md) — `Checkout.rentalCost` charged to contractors is INCOME to the business (Admin summary adds it; worker view subtracts it; QB Income export includes it). Never treat it as a cost on the business side. **CURRENT STATE: `EQUIPMENT_BILLING_ENABLED` is OFF** — every release writes `rentalCost = 0`, absorbed into a higher `CONTRACTOR_PLATFORM_FEE_PERCENT` pending CPA sign-off on the NC sales-tax model. Policy below resumes verbatim when the toggle flips back on.
- [Per-job equipment billing](feature_per_job_equipment_billing.md) — Equipment can opt into per-job-with-daily-cap billing via `Equipment.equivalentJobs` (NULL = legacy flat daily). `Checkout.rentalCost` is now actual contractor billings, not notional. Don't reconstruct cost from `rentalDays × dailyRate`.
- [Payments build gate](feedback_payments_build_gate.md) — `apps/api/src/services/payments-build-gate.test.ts` invariants must run on every build (wired via `test:build-gate` script + `turbo.json` build.dependsOn test). Locks conservation laws, worker classification, aggregate identity, tax-export sources, GP flag. Don't relax without policy doc update. **There are FOURTEEN build gates, not two** (count them, don't trust a written number) — see [[reference-build-gates-roster]].
- [Build-gate roster](reference_build_gates_roster.md) — the gates in one place. **The roster itself drifted** (listed 8 of 14) — verify with `ls apps/api/src/services/*-build-gate.test.ts`. Newest: alert-ordering (dropdown vs Tasks order) and test-roster (guards the gate LIST — `test:build-gate` is a filter list, so a deleted/renamed gate silently stops running), including the three (`observer-filter`, `recurrence-series`, `promotions`) with no other coverage. observer-filter catches the Postgres `NULL != 'observer'` three-valued-logic bug; promotions is 66 tests guarding CAN-SPAM + Twilio segment billing + HMAC flavor isolation.
- [Run build gate after every change](feedback_run_build_gate_after_changes.md) — after ANY edit in apps/api/ (or payments-touching edit anywhere), run `cd apps/api && npm run test:build-gate` before reporting the task done. ~300ms, 74 tests. Don't skip; don't batch to end of session.
- [Exports/Reconcile default date range](feedback_exports_default_range.md) — Any Super Money export/reconcile date-range surface MUST default to THIS calendar week's Mon–Sun (week containing today), NOT rolling today-7. Original ExportsTab was subsumed by ReconcileTab in the 2026-08-21 refactor; preference applies to any successor surface.
- [Payroll — Gusto CSV import, three-tier visibility](reference_payroll.md) — Money → Payroll. Worker sees own rows full detail; Admin hours/gross/net only; Super everything + upload/match/archive. Spec at `docs/features/payroll.md`. Gotchas: rate columns aren't additive, blank ≠ zero, natural key excludes payDay, names never auto-matched.
- [NEVER connect imported payroll to the P&L estimate](feedback_payroll_estimate_actual_firewall.md) — one is ground truth from Gusto, the other a tunable estimate. User: "will cause problems over time". Bidirectional build-gate firewall.
- [Date handling — canonical reference + build-gate enforcement](reference_date_handling.md) — `docs/DATE_HANDLING.md` + helper files `apps/api/src/lib/dates.ts` and `apps/web/src/lib/dates.ts`. Forbidden patterns mechanically enforced via `apps/api/src/services/date-handling-build-gate.test.ts` — fails CI on `.toISOString().slice(0,10)`, `.toLocaleDateString(undefined,...)`, inline `Intl.DateTimeFormat`, `setDate(getDate()+n)`, `86_400_000`, etc. Per-line suppression via `// date-handling-allow: <reason>` for documented exceptions.
- [Feature specs pattern](reference_feature_specs.md) — `docs/features/<name>.md` is canonical per-feature spec, bound to backend build gate + Playwright e2e. Three exist today: `compliance.md`, `client-view-as.md`, `documents-gdrive-backup.md`.
- [Playwright + Clerk setup](reference_playwright_setup.md) — e2e infra at `apps/web/tests/e2e/`. Clerk sign-in tickets (no passwords), 5 seed users, DB helpers with `E2E_` scratch policies, `gotoWorkerHome` handles topTab default. Run `npx playwright test --project=employee`.
- [View-as endpoints — canonical reference + build-gate enforcement](reference_view_as_endpoints.md) — `docs/VIEW_AS_ENDPOINTS.md` + build gate `apps/api/src/services/view-as-endpoints-build-gate.test.ts`. Every `GET /me/*` route must accept `?viewAsUserId=<id>` (ADMIN/SUPER-gated) OR carry `// view-as-allow: <reason>` above the route. This class of bug has shipped three times — the gate makes a fourth mechanically impossible.
- [Names must carry their meaning — brevity is the wrong optimization](feedback_names_carry_meaning.md) — schema fields / exports / event names should encode the actual behavior, not a shorter approximation. `isAdminOnly` (means "workers cannot claim, must be assigned") caused a client-visibility bug because the name read as a visibility rule. Open rename: `isAdminOnly` → `requiresAdminAssignment` on `JobOccurrence`.
- [CompanyDocument → Google Drive backup — tabled mid-setup](project_documents_gdrive_backup.md) — design fully spec'd, no code yet, paused at Step 4 of Google Cloud setup (download service-account JSON key). Queue+worker architecture, service-account auth, `_deleted/` mirror, locked config-change, Timeline alerts on 3 consecutive failures. Full plan + build order in the file; resume there.
- [Clerk satellite hostnames hardcoded — tech debt](project_clerk_satellite_hardcoded_hostnames.md) — `apps/web/src/lib/clerkDomains.ts` hardcodes `PRIMARY_HOSTNAME` + `SATELLITE_HOSTNAMES` inconsistent with the "everything configurable" pattern used for promo domains. Plan: move to `NEXT_PUBLIC_APP_PRIMARY_HOST` + `NEXT_PUBLIC_APP_SATELLITE_HOSTS` env vars. Do NOT move to DB Settings (security + first-render constraints).
- [Multi-domain / auth changes — design first, don't patch incrementally](feedback_multi_domain_design_first.md) — for any auth flow, multi-domain, or Clerk config change, do a FULL design pass first. Read every touchpoint, trace the full user journey through OUR code, present the design, get sign-off, THEN implement in one pass. The 2026-08-13 Clerk satellite work was a series of reactive patches that eroded trust — don't repeat that pattern.
- [AppSplash finally stable — don't regress the vertical-drop fix](feedback_appsplash_stable_dont_regress.md) — 2026-08-15 combination (dvh/dvw overlay, portal to body, body-paint-white, phase state machine) works. Small residual flash acceptable per user. Any change to AppSplash requires design pass first.
- [Neon pipelineConnect=false workaround — issue #209](project_neon_pipelineconnect_workaround.md) — apps/api/src/db/prisma.ts sets `neonConfig.pipelineConnect=false` as workaround for open @neondatabase/serverless bug that hangs on 32-42KB payloads on pool reconnect. Do not remove until #209 is confirmed fixed. Do not add aggressive pool config either — it triggers more reconnects → more hangs.
- [Check current docs BEFORE diagnosing infra/framework/DB bugs](feedback_check_current_docs_before_diagnosing.md) — For any bug involving Vercel, serverless, Next.js, Fastify, or DB packages, WebFetch current docs + GitHub issues FIRST. Do NOT extrapolate from training data on fast-moving packages. Cost of skipping this: 2 days + hundreds in Vercel fees on the 2026-08-15 Neon hang saga.
- [Auth plugin MUST await recordSignInIfNew — never fire-and-forget](project_auth_plugin_must_await_recordsignin.md) — the two `recordSignInIfNew` calls in apps/api/src/plugins/auth.ts must be `await`ed. Fire-and-forget strands `$transaction` in "idle in transaction" on Neon, holds row lock on User, hangs every subsequent /api/me for ALL of the operator's devices until Neon times out the abandoned session. Actual root cause of the 2026-08-16 saga.
- [Never run `next build` while the dev server or an e2e run is live](feedback_never_build_while_dev_server_runs.md) — one shared `apps/web/.next`; the build clobbers it and the dev server 404s every route, silently poisoning any in-flight Playwright run. Diagnostic tell: `auth-setup` failing at `/sign-in`, or "Clerk Frontend API URL is required" errors → `curl` :3000 first.
- [Compliance e2e specs were passing-by-accident — RESOLVED 2026-08-23](project_compliance_banner_specs_dead.md) — `049b7ae` swapped ComplianceBanner→CompliancePromptBanner and dropped the testid, killing 33 specs. Fixed by adding `testId`/`dataAttrs` to CompactBanner + restoring view-as copy/CTA, plus a real bug: admins in Team view lost their own compliance banner. Three specs were also broken independently (dead localStorage key, rotted date literal, Clerk-token race). Read it before trusting any green e2e run.
- [Match test depth to the change](feedback_test_tier_by_change_size.md) — UI-only → `tsc` (~40s); component logic w/ coverage → those specs; API/money → build gate (seconds); schema/auth/cross-cutting or pre-push → full Playwright (~10 min). Check `grep -ln "<feature>" *.spec.ts` first: no hits means e2e can't speak to the change. Targeted `--project` runs DO work — the earlier "subsets break Clerk" claim was a misdiagnosis of a clobbered dev server.
- [Education guides feature](feature_education_guides.md) — Records → Guides for all roles; Draft→Pending→Published, Super-only publish + video, immutable assets. **R2 bucket + `R2_GUIDE_MEDIA_BUCKET_NAME` still unset** — media uploads 503 until then.
- [Resolve roles from req.user, never a DB lookup](feedback_role_resolution_from_req_user.md) — a fresh `prisma.user` read inside a role helper bypasses view-as and hands an impersonating Super their real powers. Fourth appearance of this bug class.
- [A split has two money bases — render the one that produced `amount`](feedback_money_card_two_bases.md) — actual-collected vs promised-invoice diverge on overpaid jobs; cards must reconcile to their own stated total. Dev seed now reproduces the production shape, and `money-card-math-admin.spec.ts` checks cards against themselves rather than against the DB.
- [Test users purged from production 2026-09-01](project_mark_baliff_purge.md) — Mark Baliff (748 rows) + Matthew Wanderski (16 rows) reassigned to the owner, not deleted; their splits sat on real client revenue. Explains the owner's ~96 splits. Open: David has W-2 wages but no Gusto record.
- [Local .env is TEST Clerk, even against the prod DB](reference_local_env_is_test_clerk.md) — `sk_test_` locally; prod Clerk keys live only in Vercel. Prove a key reaches the right instance before trusting a 404.
