# Compliance — Feature Reference

> **Purpose.** Give every worker (employee, contractor, trainee) a paper
> trail proving they've read, signed, and — where applicable — uploaded
> the documents the business requires (handbook, vehicle policy, insurance
> proof, driver's license, etc.). The system enforces at three levels
> (BLOCK / WARN / INFO), supports version control with 2-eyes publish, and
> gives admins an exception mechanism for edge cases.
>
> This document is the **canonical spec** for how compliance is supposed
> to work. If code and doc disagree, one of them is wrong — fix both, in
> the same PR. The Playwright suite at `apps/web/tests/e2e/specs/compliance-banner-*.spec.ts`
> asserts many of the promises below actually hold in a real browser.

## Data model

```
PolicyDocument                 One row per policy (e.g., "Handbook v3")
  ├── currentVersion:          The version workers see + sign right now
  ├── versions[]:              Full version history (Draft → Published)
  ├── targetWorkerTypes:       Which worker types must sign
  ├── enforcement:             BLOCK | WARN | INFO
  ├── workerAction:            SIGN | SIGN_AND_UPLOAD | ACKNOWLEDGE | NONE
  ├── resignTrigger:           ONE_TIME | DAYS_SINCE_SIGN | ANNIVERSARY
  ├── requiresWorkerUpload:    Does the worker upload a file?
  └── archivedAt:              Soft-delete timestamp

PolicyDocumentVersion          One row per revision of a policy
  ├── versionNumber:           Monotonic per-policy
  ├── contentDigest:           SHA-256 of the exact bytes served
  ├── status:                  DRAFT | SUBMITTED | APPROVED | PUBLISHED | ROLLED_BACK
  ├── forcesResign:            Publish-time decision — invalidate old sigs?
  ├── graceUntil:              Grace deadline after force-resign
  └── {created,submitted,approved,published,rolledBack}{At,ById}: audit trail

PolicySignature                Immutable — revoke-and-replace only
  ├── userId:                  Whose compliance this proves
  ├── signedByUserId:          Who actually clicked (self OR admin-on-behalf)
  ├── onBehalfOfUserId:        Set only when signedByUserId != userId
  ├── contentDigestAtSign:     Exactly what was signed (pinned at write)
  ├── typedNameRaw + Normalized: Both stored — raw for audit, normalized for compare
  ├── workerActionAtSign:      Copy of policy.workerAction at sign time
  ├── uploadStatus:            NONE | PENDING_REVIEW | APPROVED | REJECTED
  └── {revoked,uploadReviewed}{At,ById,Reason}: audit trail

PolicyException                Time-bounded excuse from a specific policy
  ├── userId + policyDocumentId
  ├── grantedById + reason
  ├── expiresAt:               Hard cutoff
  └── revokedAt + revokedById: Admin can rescind early

PolicyReadingProgress          Per-page dwell tracking for PDFs
  └── pageNumber + firstViewedAt + totalDwellMs
```

## Enforcement levels

| Level | Blocks worker actions? | Shown in banner? | Shown in alerts? | Shown on Profile |
|-------|------------------------|------------------|------------------|------------------|
| BLOCK | Yes (start workday, claim equipment, etc.) | **Red banner** | Yes | Red chip on Users tab |
| WARN  | No | **Orange banner** (when only WARN/INFO pending) | Yes | Orange badge |
| INFO  | No | Same orange banner | Yes | Neutral badge |

BLOCK actions are enforced by `PolicyGateInterceptor` (client-side, at
the button click) AND by API guards (`RESERVE_EQUIPMENT` for
equipment.requiredPolicyIds, workday-start guard, etc.).

## Worker actions

| Action | What the worker does | Backend side effect |
|--------|----------------------|---------------------|
| SIGN | Types their name exactly | `PolicySignature` created with `typedNameRaw + Normalized` |
| SIGN_AND_UPLOAD | Types name + uploads a file | Same, plus `uploadR2Key + uploadDigest + uploadStatus=PENDING_REVIEW` |
| ACKNOWLEDGE | Clicks "I acknowledge" (no typing) | `PolicySignature` with `workerActionAtSign=ACKNOWLEDGE`, `typedNameRaw=null` |
| NONE | Worker never sees it | Admin uploads on behalf; `PolicySignature` with `signedByUserId=admin`, `onBehalfOfUserId=worker` |

**Name-match validation** — for SIGN/SIGN_AND_UPLOAD, the client and
server both normalize the typed name (NFD → strip diacritics + smart
quotes → lowercase → collapse whitespace) and compare against the
worker's displayName. Server-side is authoritative; client-side is UX
only. Submit is disabled until they match — no toast, just an inline
red/green hint.

## Version lifecycle (2-eyes)

```
DRAFT ──submit──▶ SUBMITTED ──approve──▶ APPROVED ──publish──▶ PUBLISHED
  │                    │                                            │
  └── rollback ────────┴──── rollback ────────────────────────── rolled_back
```

- **DRAFT → SUBMITTED**: same-actor allowed (author submits their own draft)
- **SUBMITTED → APPROVED**: different actor required (2-eyes)
- **APPROVED → PUBLISHED**: different actor required (2-eyes)
- **Publish choices**: `forcesResign: false` (typo fix — sigs still count) OR `forcesResign: true` (rewrite — old sigs go stale, workers must re-sign). Zero-grace publish requires the publisher to type `APPROVE`.

Once a version reaches PUBLISHED, its `contentMarkdown` / `contentR2Key`
/ `contentDigest` are immutable. Never edit — publish a new version.

## Enforcement paths in the UI

The compliance state surfaces to workers in four places:

1. **Home tab compliance banner** ([`apps/web/src/ui/components/ComplianceBanner.tsx`](../../apps/web/src/ui/components/ComplianceBanner.tsx))
   - Red when ≥1 BLOCK pending, orange when only WARN/INFO pending, silent when cleared.
   - Positioned below `HomeBanners` (admin announcements) + the push-notification enablement card.
   - Hidden while impersonating (`disabled={isViewingOther}`).
   - Refetches on `policies:signed` and `policies:changed` events.

2. **PolicyGateInterceptor** ([`apps/web/src/ui/components/PolicyGateInterceptor.tsx`](../../apps/web/src/ui/components/PolicyGateInterceptor.tsx))
   - Listens for `policies:required` custom events (dispatched by ComplianceBanner + button click failures).
   - Fetches current pending list, opens `PolicySignWizard` with the required IDs.

3. **Alerts dropdown badge** — count from `/api/me/policies/count`, refreshed on the same events.

4. **Profile → WorkerComplianceSection** — full per-policy view with status chips, history, and per-signature details.

## Copy rules

The banner subtitle is one of:

| Situation | Copy |
|-----------|------|
| 1 BLOCK, 0 recommended | "You have 1 required document to sign before you can start work." |
| N BLOCK, 0 recommended | "You have N required documents to sign before you can start work." |
| N BLOCK + M recommended | "You have N required + M recommended documents to sign." |
| 0 BLOCK, 1 recommended | "You have 1 recommended document to sign when you get a chance." |
| 0 BLOCK, M recommended | "You have M recommended documents to sign when you get a chance." |
| 0 pending | (banner not rendered) |

## Color + animation

| Severity | Card bg | Border | Icon | Buttons | Pulse animation |
|----------|---------|--------|------|---------|-----------------|
| BLOCK    | `red.50` | `red.300` | red | `colorPalette="red"` | `seedlings-pulse-red` |
| WARN/INFO only | `orange.50` | `orange.300` | orange | `colorPalette="orange"` | `seedlings-pulse-orange` |

Pulse keyframes are defined in [`apps/web/src/styles/globals.css`](../../apps/web/src/styles/globals.css)
alongside the workday-strip pulses. Cadence is 2.5s ease-in-out infinite
across all three colors so the visual language is consistent.

## Custom events (client-side)

These are the `CustomEvent` names the UI dispatches to keep state
in-sync across independent components. All are `window`-level.

| Event | Emitted by | Handled by | What it means |
|-------|------------|------------|---------------|
| `policies:required` | ComplianceBanner "Sign now", gated actions | PolicyGateInterceptor | Open the sign wizard for pending policies |
| `policies:signed` | PolicySignWizard after each successful sign | ComplianceBanner, index.tsx counts | Refresh — a signature was just written |
| `policies:changed` | Admin operations (grant exception, publish v2, etc.) | ComplianceBanner, index.tsx counts | Refresh — server-side state changed |
| `navigate:profile` | ComplianceBanner "View profile" | index.tsx | Switch top tab → worker/Profile |

## Exception mechanism

Admins can grant a `PolicyException` for a specific worker + policy with
an `expiresAt` and `reason`. While active (`expiresAt > now AND revokedAt IS NULL`):

- The policy does **not** appear in `required[]` for that worker
- The BLOCK enforcement is lifted (equipment claims, workday start, etc.)
- The Profile view shows an "Exception granted" chip with expiry

An expired or revoked exception is a no-op — the policy re-appears in
`required[]` immediately.

## Auto-grace extension (dormancy)

If a worker's grace period expired within the last **7 days** on any
published version, they get a one-time **24-hour catch-up** window
automatically. Idempotent per (user, policy) via a marker in
`reason` — never grants a second one. Prevents dormant returners from
getting hard-blocked the instant they open the app.

Implementation: `services.policies._maybeGrantAutoGraceExtensions()`
runs at the top of `getWorkerPoliciesView`.

## Content-digest pinning

Every `PolicySignature` stores a `contentDigestAtSign` — the exact
SHA-256 of the version's bytes at sign time. This means:

- Even if a version's stored content is somehow altered later (shouldn't
  happen for PUBLISHED, but defense in depth), the signature still proves
  what the worker actually agreed to.
- The compliance predicate compares `signature.contentDigestAtSign` to
  `currentVersion.contentDigest`. If they match, the worker is current.
  If they differ (or the version pointer moved past what they signed),
  they're pending.

## Where invariants are enforced

| Invariant | Enforcement |
|-----------|-------------|
| Signatures are immutable (revoke-and-replace only) | Schema comment + service layer never runs UPDATE on signature fields except `revoked*` |
| Published version content is immutable | Service layer refuses to update `content*` on PUBLISHED rows |
| 2-eyes on Approve + Publish | `policies-build-gate.test.ts` |
| Active exception suppresses `required[]` | `policies-build-gate.test.ts` + Playwright edge spec |
| Banner renders below HomeBanners | Playwright mainline spec |
| Red vs orange severity + pulse animation | Playwright edge spec |
| Sign now button opens wizard via `policies:required` event | Playwright edge spec |
| Auto-grace grants at most once per (user, policy) | Reason marker check in `_maybeGrantAutoGraceExtensions` |

## Testing

**Backend build gate** — [`apps/api/src/services/policies-build-gate.test.ts`](../../apps/api/src/services/policies-build-gate.test.ts)
runs on every API build. Locks 2-eyes lifecycle, signature immutability,
exception semantics, worker-type targeting, digest-pinning invariants.

**Backend unit** — pure predicates in `computeComplianceState` are unit
tested against a broad matrix of (state, exception, version, digest)
combinations.

**Frontend e2e** — [`apps/web/tests/e2e/specs/compliance-banner-*.spec.ts`](../../apps/web/tests/e2e/specs/)
30 Playwright tests across three files (mainline, edge, deep). Run with:

```bash
cd apps/web && npx playwright test --project=employee
```

Auth uses Clerk sign-in tokens (backend SDK → ticket → browser redeem)
so no passwords are stored anywhere. Storage state cached to
`playwright/.auth/*.json` (gitignored).

## Known limitations / non-goals

- **Wizard doesn't re-fetch on open** — if an admin deletes/archives a
  policy while a worker's wizard is open, the wizard shows the stale
  snapshot. Not currently blocking; users hitting this can close and
  reopen.
- **Signature revocation is admin-only** — workers can't revoke a
  self-signature. Intentional — audit integrity.
- **No push notification for neglected compliance** — the Home banner +
  alerts dropdown + tasks page are the only reminders. Push was proposed
  but not built.

## Recent changes worth knowing about

- **Exception + no-sig fallback bug** (fixed in `policies.ts:getWorkerPoliciesView`) —
  the `required[]` filter's "no signature yet" fallback previously
  ignored active exceptions. A worker with a granted exception on a
  policy they'd never signed would still see the banner. Fixed by
  short-circuiting on `hasActiveException` before the fallback path.
  Caught by the Playwright edge spec.
- **Home-tab banner** (this project) — Added `ComplianceBanner`
  component to the worker Home tab, below `HomeBanners` and the push-
  notification card. Red for BLOCK, orange for WARN-only, silent when
  clear. Pulses. "View profile" + "Sign now" buttons.
