---
name: reference-worker-sensitive-data
description: "Data-exposure guardrails for Worker views on Users and Groups tabs. Never expose email, phone, wage, roles, privilege flags, or cost-split percentages to workers."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:07:34.348Z
---

# Worker sensitive-data guardrails

The Users + Groups tabs are blended across all three roles per the
additive-scope pattern. Worker views must NEVER see:

- Email addresses
- Phone numbers
- Hourly wage / rate
- Role labels (WORKER / ADMIN / SUPER)
- Privilege flags / approval state
- Cost-split percentages (Group equipmentCostPercent)
- Deletion / moderation / edit controls

## Server-side endpoints (defense layer 1)

- **`GET /api/me/team`** (`apps/api/src/routes/worker.ts:1622-1629`,
  `workerGuard`) — returns ONLY `{id, displayName, workerType}` for
  approved workers. Consumed by `WorkerTeamRoster` in UsersTab.
  Never widen this endpoint — `/api/workers` is admin-shaped and
  workers must not call it.
- **`GET /api/me/groups`** (`apps/api/src/routes/worker.ts:1592-1614`,
  `workerGuard`) — returns crews the caller is on with `{id, name,
  claimerId, myRole, members:[{userId, displayName, role}]}`. NO
  percentages, NO emails. Consumed by `WorkerMyCrews` in
  AdminGroupsTab.

## Client-side scrubbing (defense layer 2)

Both `WorkerTeamRoster` (UsersTab) and `WorkerMyCrews`
(AdminGroupsTab) explicitly re-scrub payloads even though the
endpoints already sanitize. Belt-and-suspenders — if a future server
change accidentally widens a payload, the worker UI still won't
render sensitive fields.

## What the Worker view actually shows

**Users tab (Worker)** — "Team roster": display name + worker-type
badge (Contractor / Employee / Trainee). Search box, card list. No
other data. Worker-type is intentionally visible per user preference.

**Groups tab (Worker)** — "My Groups" (labeled "My Groups", NOT
"My Crews" — user requested consistent naming): crew name + Claimer
or Member badge for the caller + fellow-member name chips. Cost-split
percentages never rendered.

## Do NOT

- Do NOT add fields to `/api/me/team` or `/api/me/groups` without
  explicit sign-off — every field exposed to worker is a compliance
  concern (this is an employer/employee relationship).
- Do NOT reuse `/api/workers` (admin endpoint) for worker-facing
  code. It returns email; workers must not have that data.
- Do NOT let worker mount pass `scope.isAdmin` or `scope.isSuper` —
  the extras derivations are additive; any leak of admin-scope from
  the shell would flip on the admin UI.
