---
name: reference_api_e2e_suite
description: "The backend API e2e suite — what it covers, what it deliberately does not, and the annotation it reads"
metadata:
  node_type: memory
  type: reference
  modified: 2026-10-13T00:00:00.000Z
---

**`apps/web/tests/e2e/api/` + Playwright project `api`.** Built 2026-10-13 to
cover the backend surface, which the 67 UI specs only exercised incidentally.

Run it alone: `npx playwright test --project=api`. Add `--no-deps` to reuse
the existing sign-in states — **do that while iterating.** Re-running
`auth-setup` signs 9 personas in each time, and ~8 runs in 20 minutes earned a
transient `ClerkAPIResponseError`. That error is rate limiting, not a code
failure; verify with a direct `createSignInToken` call before chasing it.

## The files
- `helpers/endpoints.ts` — parses `apps/api/src/routes/*.ts` AT RUN TIME into
  the 639-endpoint inventory, bucketed exactly as
  `apps/api/scripts/build-route-map.ts` buckets it (entitlement 496 / ownership 103 /
  public 24 / client-portal 10 / system 6). **Not a committed fixture** — a
  generated list goes stale the moment a route lands, and the point of the
  suite is that it cannot silently stop covering something.
- `helpers/personas.ts` — each persona's capability set READ FROM THE DB with
  inheritance flattened, plus `pickPair()`: the LEAST-privileged holder (if it
  admits them it admits everyone above) and the MOST-privileged non-holder (so
  a refusal is attributable to that entitlement, not to being powerless).
- `api/authz-matrix.spec.ts` — one test per entitlement, both directions.
- `api/surface.spec.ts` — ownership, public, client-portal, and reads.
- `api/coverage.spec.ts` — fails if an endpoint lands in a bucket no spec
  drives. This is what keeps "full coverage" true after today.

## What it adds over `apps/api/scripts/_entitlement-probe.ts`
The probe stubs `requireApproved` and injects a synthetic principal
in-process. It cannot exercise the Next proxy, CORS, `plugins/auth.ts`
verifying a real Clerk JWT, `plugins/rbac.ts` reading grants out of Postgres,
or `plugins/clientImpersonation.ts` — and an impersonation hole has already
shipped that only an e2e caught. **Keep both**: the probe is seconds, the e2e
is minutes and real.

Proof they differ: three routes (`/occurrences/:id/pause`, `/resume`,
`/unclaim`) the probe sees as "allowed" correctly return 403 to a real
contractor, because the probe's synthetic caller never reaches the ownership
lookup. The probe used to call those annotations stale; it no longer judges
them.

## `// in-handler-scoped: <reason>`
A route whose real rule is NARROWER than its guard (claimer-only, "you must be
on this visit") carries this annotation above its declaration. Both the probe
and the e2e parse it from the route source — **one source of truth, at the
callsite**, like `view-as-allow` and `claimer-invariant-allow`. It started as
a hardcoded list in the probe, which was a second source of truth about
authorization sitting in a diagnostic script.

The e2e **verifies** the annotation rather than trusting it: an annotated route
must still 403 for a bare entitlement holder. If it starts admitting them the
annotation is stale and is excusing a widening nobody reviewed.

The parser walks UP from the declaration and **stops at the previous route** —
without that, one route's note also covered the next one, and it wrongly
claimed `GET /occurrences/pinned` was scoped.

## What it deliberately does NOT assert
- **Mutations in the allow direction only prove the guard admitted them.**
  Every `:param` becomes a value matching no row and bodies are empty, so a
  write that passes the guard fails on lookup or validation. Verified: these
  runs create no rows and no audit events. Real write flows are the UI specs'
  job.
- **Ownership routes are not asserted to be 403-free.** `approvedUser` admits
  any approved caller and the HANDLER scopes per row, so 403 is correct for
  someone else's row — 11 routes do exactly that. The assertions are
  "reachable (not 401)" and "does not crash".
- **`clientGuard` does not mean "clients only"** — it only resolves a Clerk
  identity. A team member gets `{ linked: false }` and empty arrays, so the
  assertion is "no client rows come back", not "refused".
- **Public ≠ no credential.** `/public/display/board` and the three display
  photo routes need a paired-DEVICE token and must 401 without one; the
  pairing handshake is genuinely open.
- **400 is a real answer.** 15 path-parameterless reads require QUERY
  parameters (the CSV exports, the P&L, `/weather`, the lookups). A 400 is the
  endpoint saying what it needs. 134 reads return 2xx.
- **System/cron routes are not driven** — hitting them would fire the job.
  Their auth is unit-tested by G42.

## Bugs it found on the first run
- **P2003 (foreign key) was unmapped**, so nine ownership routes returned 500:
  pin/like a visit or equipment, dismiss a banner, patch mileage, send a
  payment-request email. All the same shape — a join row referencing something
  archived or deleted while it was still on screen. Now 404
  `REFERENCED_RECORD_NOT_FOUND` in `plugins/errorMapper.ts`.
- **Bare `throw new Error(...)` becomes a 500**, because the mapper keys on
  `statusCode`. Fixed in `editEntryByDriver` (404/403/409) and
  `generateTokenForOccurrence` (404). **There are ~148 more bare Errors in
  `apps/api/src/services/` against 530 `ServiceError`s** — a systemic class,
  not re-statused wholesale because each needs the right code.

See also [[project_permissions_build_state]], [[reference_playwright_setup]],
[[feedback_never_ship_a_red_spec]].
