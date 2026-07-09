# Client View-As — Feature Reference

> **Purpose.** Let a Super temporarily see the app exactly as a specific
> client sees it, using the client's own data. Solves the "client says
> their invoice isn't in their portal — I have no way to verify" support
> gap without giving the operator the client's password or degrading the
> audit trail.
>
> Read-only by design. Enforced at the API layer, not just in the UI.
>
> This document is the canonical spec. Playwright coverage in
> `apps/web/tests/e2e/specs/client-view-as-*.spec.ts` (see Testing below)
> holds this spec's promises to real browser behavior.

## Model

- **Actor**: a real Super user with a valid Clerk session. Never anyone
  else.
- **Target**: a specific `ClientContact` row that has a `clerkUserId`
  (has logged in at least once). The picker refuses to select contacts
  without a Clerk account.
- **Effective identity during a session**: the target contact's
  `clerkUserId`. Every read-side client-facing endpoint returns the
  data that contact would see when logged in.
- **Real identity**: the Super's actual `clerkUserId`. Preserved on the
  request under `req.auth.clerkUserId` for audit code that wants the
  real actor.

## Data flow

```
Super clicks "View as" on a client card
   ↓
GET /api/admin/clients/:id/impersonatable-contacts   (super-only)
   ↓
Picker dialog (or auto-select if only one clerk-linked contact)
   ↓
setClientImpersonation({contactId, contactName, clientName}) in localStorage
   ↓
Hard page reload with the header attached to every subsequent request
   ↓
X-Impersonate-Client-Contact: <contactId> on every API call
   ↓
plugins/clientImpersonation.ts (onRequest hook):
   • Verify caller is really SUPER (silent no-op if not)
   • Resolve ClientContact → get clerkUserId
   • Refuse if method is not GET/HEAD/OPTIONS → 403 IMPERSONATION_READONLY
   • Attach req.effectiveClerkUserId = target's clerkUserId
   ↓
routes/client.ts's clientGuard overwrites req.auth.clerkUserId with the
effective ID so all downstream client routes see the target's data
   ↓
Super sees the client's own portal, all reads pass through cleanly, all
writes 403 before touching business logic
```

## Enforcement layers

**Backend — [`apps/api/src/plugins/clientImpersonation.ts`](../../apps/api/src/plugins/clientImpersonation.ts)**

- Registered after `rbac` in the `/api` prefix
- `onRequest` hook checks the header. If not SUPER, silent no-op — no
  4xx that would leak the feature's existence.
- Refuses invalid target IDs with `IMPERSONATION_TARGET_INVALID` (400)
  when the caller is a real SUPER — the frontend can surface a specific
  error ("this contact has never logged in").
- Refuses any non-GET method with `IMPERSONATION_READONLY` (403). No
  per-endpoint checks needed — the plugin blocks blanket.

**Route-level — [`apps/api/src/routes/client.ts`](../../apps/api/src/routes/client.ts)**

- `clientGuard` swaps `req.auth.clerkUserId` to the effective (target's)
  Clerk ID inside its preHandler. Every client route body reads
  `req.auth.clerkUserId` unchanged; they transparently see the
  impersonated identity without needing per-route edits.

**Admin picker endpoint — [`apps/api/src/routes/admin.ts`](../../apps/api/src/routes/admin.ts)**

- `GET /admin/clients/:id/impersonatable-contacts` (super-only) returns
  every ClientContact for the client with a `hasClerkAccount` boolean.
  Frontend picker uses this to render the "which contact?" dialog.
  Contacts without Clerk accounts are still returned so the picker can
  explain why they can't be selected.

## Frontend

**Storage**: `localStorage["seedlings_impersonateClientContact"]` — a
JSON blob `{ contactId, contactName, clientName }`. Read via
`getClientImpersonation()`, written via `setClientImpersonation()`.

**Header attachment** — [`apps/web/src/lib/api.ts`](../../apps/web/src/lib/api.ts)
`attachImpersonateHeader` sends `X-Impersonate-Client-Contact` on every
request when the localStorage key is set.

**Enter session** — [`apps/web/src/ui/components/ViewAsClientButton.tsx`](../../apps/web/src/ui/components/ViewAsClientButton.tsx)
- Purple "View as" button on each client card in `ClientsTab`, shown
  only when `isSuper && forAdmin`.
- On click: fetches `/api/admin/clients/:id/impersonatable-contacts`,
  handles three cases (zero / one / multiple).
- Multiple-contact picker preselects the primary contact, marks it with
  a "Primary" chip, disables non-Clerk contacts with inline explanation.

**Persistent banner** — [`apps/web/src/ui/components/ImpersonationBanner.tsx`](../../apps/web/src/ui/components/ImpersonationBanner.tsx)
- Purple sticky banner at the top of every page while a client
  view-as session is active.
- Copy: *"Read-only preview: viewing as [contact] on behalf of [client]"*.
- "Exit view-as" button clears the storage entry and hard-reloads.

## What Super sees

- Client mode UI (`topTab = "client"`)
- The client's Home page, Activity feed, Community tab
- The client's invoices/payment requests (this is what solves the
  original use case)
- Everything the client themselves would see when logged in

## What Super CANNOT do while impersonating

- **Any mutation.** POST, PUT, PATCH, DELETE all return 403.
- Approve or reject a payment request as the client
- Update the client's contact info
- Trigger any client-side workflow that would write to the DB
- See super/admin/worker screens — impersonation forces client mode

## Multi-contact clients

When a Client has more than one ClientContact with a Clerk account
(e.g. Harrington Estate has both James and Eleanor), the picker shows
all clerk-linked contacts sorted primary-first with a "Primary" chip on
the primary. Super picks one; the impersonation targets that specific
contact.

For the "James is a contact on multiple Clients" case: Clerk's identity
is what the backend swaps, so viewing as James for Harrington Estate
still shows him ALL his linked clients — same as when James himself
logs in. If Super wants to see only one client's data, that's what the
existing admin Client detail view is for; impersonation is specifically
"what the client sees when they log in".

## No-account clients

If a Client has zero ClientContacts with a `clerkUserId`, clicking
"View as" surfaces an inline error: "[Client Name] has no contact with
a login. Nothing to view as." The picker never opens.

## Audit + safety notes

- The header is stripped/ignored for any non-Super caller. A regular
  admin sending a forged header is silently ignored (no 4xx to leak
  feature existence).
- The real actor's Clerk ID is preserved on `req.auth.clerkUserId` for
  the impersonated read-path — audit code that wants the real actor
  can access it. In practice no client-facing route writes audit rows,
  because writes are refused entirely.
- Exit is manual — no auto-timeout, no auto-exit on tab switch. The
  persistent banner is visible on every page as a permanent reminder
  and one-tap exit.
- Two impersonation flavors (role + client) are independent stores.
  If a Super somehow has both active, the client banner takes
  precedence — it's the more constrained mode.

## Testing

**e2e** — `apps/web/tests/e2e/specs/client-view-as-*.spec.ts`. Covers:

- Positive: Super enters view-as → landing on client Home → sees client data
- Read-only enforcement: POST from within a session is 403'd
- Multi-contact picker: primary preselected + marked
- No-Clerk-account clients: button shows inline error
- Exit: banner button clears session + hard reloads
- Non-Super callers: header silently ignored (regression guard)

## Non-goals

- **Active mode** — deliberately excluded for now. Super doesn't act as
  the client for real. If the operator needs to pay/approve on behalf
  of a client, that's a separate proxy-action feature that would go
  through admin routes with explicit audit attribution.
- **Auto-exit** — no time-based exit, no auto-exit on tab switch. Kept
  simple; the banner is the exit affordance.
- **Impersonating Super/Admin/Worker accounts** — that's what
  role impersonation is for. Client view-as is specifically for the
  client-facing portal.
