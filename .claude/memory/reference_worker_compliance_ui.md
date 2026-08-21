---
name: reference-worker-compliance-ui
description: "Worker's Compliance section on ProfileTab — per-row Sign, batch \"Sign all\", and View-signed-document affordances. Reference before touching WorkerComplianceSection or the /api/me/policies response shape."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:08:27.532Z
---

# Worker Compliance section

Lives at `apps/web/src/ui/components/WorkerComplianceSection.tsx`,
mounted on ProfileTab when `isSelf`. Renders three sub-lists from
`GET /api/me/policies`:

1. **REQUIRED NOW** — outstanding policies the worker must sign or
   acknowledge.
2. **AWAITING REVIEW** — policies where the worker uploaded an
   artifact that admin still needs to approve.
3. **RECORDED ON FILE** — everything the worker has signed
   historically (including revoked/rejected as a paper trail).

## Sign flows (2026-08-21 UX)

- **Header "Sign all" button** — opens `PolicySignWizard` with all
  required policies queued. Batch mode.
- **Per-row Sign button** — each `RequiredRow` has its own Sign
  button (bottom-right of the row, matches the enforcement color).
  Opens the wizard scoped to just that one policy. Worker picks
  order; not forced through the batch.
- Both flows share the same completion handler: reload
  `/api/me/policies` + dispatch `policies:signed` event.

The Sign buttons across BLOCK (red) and WARN (orange) tiers are the
SAME width — the parent VStack uses `align="end"` with `minW="14"`
on the Button so the width doesn't track the badge above it
(Required = 8 chars, Recommended = 11 chars would otherwise cause
different button widths under `align="stretch"`).

## Signed-document viewer (2026-08-21)

- **Per-row View button** on RECORDED ON FILE rows — opens
  `SignedPolicyViewDialog` (new file at
  `apps/web/src/ui/dialogs/SignedPolicyViewDialog.tsx`). Shows the
  policy title, version, signed-on date, and the exact content the
  worker agreed to.
- Content rendering:
  - MARKDOWN policies → inline via `<PolicyMarkdown>`.
  - PDF policies → button that fetches a presigned URL from
    `/api/me/policies/download?r2Key=…` and opens it in a new tab.
- Row's View button is hidden when there's no viewable content
  (e.g. archived policy with wiped version, or PENDING_REVIEW with
  no r2Key).

## Server payload (must include content fields)

`services.policies.getWorkerPoliciesView(userId)` returns history
rows that include the version's `contentFormat`, `contentMarkdown`,
`contentR2Key`, `contentFileName`, `contentContentType` — these
power the View action. The signature-fetch include on the version
join was extended for this reason. If you edit that service, keep
the content fields on the history rows or the View action will
silently disappear.

## Cross-tab wiring

- `policies:signed` custom event — fired after every successful
  sign/replace/cancel. Listeners: alerts dropdown badge, tasks-page
  compliance badge. Belt-and-suspenders: individual signs dispatch,
  and the wizard's onCompleted also dispatches at close.
- `policies:required` custom event (from `PolicyGateInterceptor`) —
  fired when the reserve/checkout flow hits a policy gate.
  Consumed by the reactive sign wizard.
