# View-As Endpoints — the third-person /me rule

## Why this doc exists

We've shipped the same class of bug **three times**:

1. **Client "View as My Properties"** — Super viewing as a client didn't
   see the client's "My Properties" tab because `/api/me` returned
   Super's roles. Fixed by overlaying client identity in
   `services/users.ts::me()` when `req.impersonatedContact` is present.
2. **Workday-start spinner in Admin view-as** — Super clicking "Start" on
   another worker's workday sometimes spun forever. `/me/policies` (via
   `PolicyGateInterceptor`) returned Super's own compliance list, filtered
   to zero matches against the target's pending IDs, and hung. Fixed by
   short-circuiting POLICIES_REQUIRED interception when the URL carries a
   `viewAsUserId` query param.
3. **ComplianceBanner disabled in Admin view-as** — Super could not see
   from the Home tab that a target worker was blocked by a BLOCK-level
   policy. The banner had been *disabled* in view-as mode (`disabled={isViewingOther}`)
   rather than made view-as-aware. Fixed by teaching `/me/policies` to
   accept `?viewAsUserId=<id>` and rerouting the banner's fetch + copy
   accordingly.

Every one of these was a `/api/me/*` endpoint returning the CALLER's data
when the UI actually needed the TARGET worker's data. This doc + the
build gate at [`apps/api/src/services/view-as-endpoints-build-gate.test.ts`](../apps/api/src/services/view-as-endpoints-build-gate.test.ts)
make sure the fourth doesn't ship.

## The rule

**Every `GET /me/*` route registered with `workerGuard` must EITHER:**

- **Support view-as** — accept an optional `?viewAsUserId=<id>` query
  param and, when present + the caller has ADMIN or SUPER role, return
  the named worker's data instead of the caller's. Two blessed patterns:
  the shared helper `resolveWorkdayTarget(req, { allowImpersonationFor: "read" })`
  used by the workday routes, or the inline pattern established by
  `/me/policies`. See examples below.

- **OR declare itself self-service** — annotate the route with a
  `// view-as-allow: <reason>` comment on the line immediately above the
  `app.get(...)` call. The reason should explain why the endpoint is
  intentionally caller-scoped (e.g. push subscriptions belong to the
  caller's device; the alerts-badge count is for the caller's own
  notifications feed).

The build gate mechanically enforces one or the other. No third option.

## Mutations vs reads

**Mutations (POST / PATCH / PUT / DELETE) on `/me/*` are separate.** For
workday mutations, the `resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" })`
helper gates the impersonation to SUPER-only. For most other domains,
the rule of thumb is: mutations that alter a specific worker's record
should live under `/admin/...` (typed as an admin action) rather than
`/me/*?viewAsUserId=`. Policies is a case in point: `/me/policies` reads
support view-as, but the sign/acknowledge/upload endpoints are strictly
self-service — an admin acting on another worker's compliance uses the
`/admin/policies/*` routes (grant exception, upload on behalf, etc.).

If you're adding a new mutation and it's not obviously covered by the
existing pattern, check with the operator before extending the view-as
surface. The default is: reads support view-as, mutations don't.

## Blessed patterns

### Pattern A — `resolveWorkdayTarget` helper (workday routes)

Use this when there's already a helper in the file scope (see
`apps/api/src/routes/worker.ts` around the workday cluster). Handles the
role check and error 4xx uniformly:

```ts
app.get("/me/workday/today", workerGuard, async (req: any) => {
  const { targetUserId } = await resolveWorkdayTarget(req, {
    allowImpersonationFor: "read",
  });
  // ...use targetUserId instead of req.user.id
});
```

### Pattern B — inline (policies)

Preferred for one-off routes that don't share a helper. Copy the shape
of `/me/policies`:

```ts
app.get("/me/policies", workerGuard, async (req: any) => {
  const callerUid = await currentUserId(req);
  const { viewAsUserId } = (req.query || {}) as { viewAsUserId?: string };
  let targetUid = callerUid;
  if (viewAsUserId && viewAsUserId !== callerUid) {
    const caller = await prisma.user.findUnique({
      where: { id: callerUid },
      include: { roles: true },
    });
    const isAdmin = caller?.roles.some(
      (r: any) => r.role === "ADMIN" || r.role === "SUPER",
    );
    if (!isAdmin) {
      throw app.httpErrors.forbidden(
        "Admin or Super role required to view another worker's <thing>.",
      );
    }
    targetUid = viewAsUserId;
  }
  return services.<domain>.getViewFor(targetUid);
});
```

### Pattern C — annotated self-service

If the endpoint truly belongs to the caller (their own device, their own
notifications feed, their own preferences), annotate:

```ts
// view-as-allow: push subscriptions belong to the caller's device; no
// admin has any reason to enumerate someone else's subscriptions.
app.get("/me/push-subscriptions", async (req: any, reply) => { ... });
```

The annotation is on the **immediately preceding non-blank line**. The
scanner reads back up to 5 lines to allow for a wrapping comment block.

## Client side

When adding a client-side caller for a `/me/*` GET, decide up front
whether the component ever renders in view-as mode. If it does, the URL
must include the `?viewAsUserId=<id>` query param. See:

- [`ComplianceBanner.tsx`](../apps/web/src/ui/components/ComplianceBanner.tsx)
  builds the URL from a prop passed by `HomeTab`.
- [`workday.ts`](../apps/web/src/lib/workday.ts) `asQuery(opts)` helper
  is the canonical pattern for building a `?viewAsUserId=` suffix.

`api.ts`'s POLICIES_REQUIRED interception intentionally short-circuits
when the URL has a view-as param (see [`api.ts`](../apps/web/src/lib/api.ts))
— the pending policies belong to the target, not the caller, so
auto-opening the sign wizard would fail.

## When you find a fourth instance of this bug class

1. Fix the endpoint (Pattern A or B).
2. Add an e2e spec that would have caught it — usually a view-as
   navigation + assert-on-rendered-copy pair. See
   [`compliance-banner-view-as-admin.spec.ts`](../apps/web/tests/e2e/specs/compliance-banner-view-as-admin.spec.ts)
   for the shape.
3. If the build gate should have caught it and didn't, tighten the
   scanner. See notes in the gate file.
