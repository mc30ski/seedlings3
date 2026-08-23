---
name: feedback-never-build-while-dev-server-runs
description: Never run `next build` (or any build writing .next) while the web dev server or a Playwright run is live — it clobbers .next and silently poisons everything downstream.
metadata:
  type: feedback
---

**Never run `npx next build` in `apps/web` while the dev server is
running, and never while a Playwright suite is in flight.** Both the
dev server and the production build write to the same
`apps/web/.next` directory. The build replaces the dev server's
working state, and from that moment the dev server serves **HTTP 404
for every route**, including `/` and `/sign-in`.

**Why:** `next build` and `next dev` are not isolated — there is one
`.next` per app, no separate output dir by default.

**How to apply:**

- Before running `next build` locally: stop the dev server, or accept
  that you must restart it (and `rm -rf .next`) afterward.
- **Never** launch a build to "use the waiting time" while an e2e run
  is going. Playwright drives the dev server; killing it mid-run turns
  real results into garbage.
- Recovery: `kill <next dev pid>` → `rm -rf .next` → restart
  `npx next dev -p 3000` → wait for `/` to return 200 before re-running
  anything.

**The incident (2026-08-23, ~23:55 ET):** during the pre-push audit I
started `next build` while the full Playwright suite was at test ~62
of 68. The build landed mid-run and took the dev server down. The two
late-run tests (`reconcile-capex-subtotal-admin` #67, failing in 1.1s
with `Missing auth`; `workdays-didnt-work-mileage-surface-admin` #68,
"Didn't work" section not found) failed **because the app was dead**,
not because of any code defect. I then spent several cycles
diagnosing the mileage failure as a possible regression in the
`lib.ts` split before noticing `.next/BUILD_ID` was stamped with the
build time. Three subsequent runs were also invalid — `auth-setup`
could not reach `/sign-in`, so only 6 tests ran and everything else
reported bogus Clerk errors.

**Diagnostic tell:** if `auth-setup` fails with
`clerk.signIn` timing out at `/sign-in`, or specs fail with
`The Clerk Frontend API URL is required to bypass bot protection`,
check the web server first — `curl -o /dev/null -w '%{http_code}'
http://localhost:3000/`. A 404 there means the dev server is broken,
not the tests. Also check `stat .next/BUILD_ID` against the dev
server's start time.

See also [[feedback-run-tests-trigger]], [[reference-playwright-setup]].
