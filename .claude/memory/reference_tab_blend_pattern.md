---
name: reference-tab-blend-pattern
description: Canonical capability-driven tab pattern. ONE tab per feature; what it renders comes from entitlements, never from a role or from which shell mounted it. Read before touching any tab.
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-10-17T00:00:00.000Z
---

# One tab per feature, built from entitlements

**This file described the opposite pattern until 2026-10-17.** It
prescribed a `scope` of three role booleans, a `purpose` prop, three mounts
per tab in the shell, and a "critical rule" about one role flag not falling
back to another. All of it is
deleted. Every identifier it named is gone from the codebase. If you are
reading an older copy, discard it — it will walk you into rebuilding the
thing that was removed.

## The rule

There is **one tab per feature**. It decides what to show from the
capabilities the signed-in person holds. It does not know, and must not
ask, which shell or role the reader arrived through.

```tsx
type XxxTabProps = TabPropsType & { scope?: Scope };   // Scope = { can }

export default function XxxTab({ me, scope }: XxxTabProps) {
  const effScope = scope ?? { can: () => false };      // FAIL CLOSED
  const canViewX   = effScope.can("x.view");
  const canManageX = effScope.can("x.manage");
}
```

`Scope` ([apps/web/src/lib/scope.ts](apps/web/src/lib/scope.ts)) has
**one field**, `can`. G1 fails the build if a file declares the shape
inline; G2 covers fail-closed defaults.

## Name a flag for the capability, never for a role

Binding `scope.can("supplies.view")` to a name like "show the staff extras"
is still the bug, just quieter: the name claims a rank, so the next person
hangs a control off it that actually needs `supplies.manage`. Name it
`canViewSupplies` — after the capability it asked for, and nothing else.
A confidently wrong name is worse than the honest role flag it replaced,
because nothing about it reads as suspicious.

Corollary: **never blanket-rename.** Converting one role flag to one
capability across a file produced 23 sites in JobsTab where the name said
`settings.manage` and the control needed `schedule.manage`. Convert site
by site, each against
[docs/features/permissions-ROUTE-MAP.md](docs/features/permissions-ROUTE-MAP.md).

## Which capability? The one its own route is guarded on

A control's gate is the entitlement the endpoint it calls requires — read
off the route map, not guessed. Mismatches found this way were real bugs:
the wage field was gated "super" while `PATCH /users/:id` checks
`payroll.manage`; three delete buttons said *"You must be someone with `settings.manage` Admin"*
while `DELETE /jobs/:x` is `schedule.manage`. G15 enforces the agreement.

## Which TABS exist is also a capability question

[apps/web/src/lib/tabRequirements.ts](apps/web/src/lib/tabRequirements.ts)
`TAB_REQUIREMENTS` maps each tab id to the entitlements that open it, with
an `ALWAYS` sentinel for the two that need none. A tab with no entitlement
for the active role does not render. There is one staff tab list
(`StaffTabs`) and two shells, `client` and `staff`.

## Perspectives narrow; they never grant

A perspective is a named SUBSET of what someone already holds, offered
only if they hold that role or one inheriting it. Picked in `RoleChip`,
sent as `X-Perspective`, applied server-side — `/api/me` returns a
NARROWED capability set. Because every tab reads that set, taking a
perspective shrinks both the tab list and the contents of each tab.

## Still true, carried over

- **Two gates for a sensitive figure.** The capability (may they see it)
  AND a presence check on the field (did the server send it). A
  server projection must narrow per kind — `fieldsFor` read
  `admin ? ADMIN : ALL`, making "everything" the else-branch, which
  silently handed `worker` a caller with `settings.manage` projection. Never let "everything"
  be a fall-through default. See `docs/features/payroll.md`.
- **View-as picker** lives inside the section it scopes, backed by
  `usePersistedState<string[]>("xxxTab_viewAsIds", [])`, one id stored
  via `slice(-1)`. Mutations route through the `*-for` endpoints with a
  `{ userId }` body. The old role-prefixed URL and the
  `superGuard`/`adminGuard` names are both GONE — paths are named for the
  resource and each requires an entitlement. See
  [[reference-capabilities-model]].
- **Section framing**: Insights — orange Card.Root, `BarChart3` icon,
  UPPERCASE title, no chip. Others — outlined Box, `borderWidth="1px"`,
  `size={14}` icon + UPPERCASE title + optional count Badge + chevron.
  Collapsible via a persisted `<pfx>_xxxCollapsed`; header `mb` → 0 when
  closed.
- **Icons**: Insights `BarChart3` · Team Usage `Users` · Your Usage
  `User` · Collections `Package` · Equipment `LayoutGrid` · Client
  Requests `Inbox`.

## Dead — do not reintroduce

The `purpose` prop · the surface-flag factory and its capability map ·
every boolean named for worker, admin or super · every `show*Extras` flag ·
per-role tab lists · the staff action bands · role-suffixed
`explainerId` keys · role-suffixed persisted-state prefixes · `hasRole()`.

If you are about to write an identifier containing "admin", "super" or
"worker" to mean "may do X", that is the thing this file exists to stop.

Related: [[reference-capabilities-model]], [[reference-tab-ordering]],
[[feedback-names-carry-meaning]].
