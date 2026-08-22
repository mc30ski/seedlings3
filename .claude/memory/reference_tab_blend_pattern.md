---
name: reference-tab-blend-pattern
description: Canonical additive-scope prop pattern used across every blended role-aware tab. Read before touching any tab that renders differently for Worker / Admin / Super.
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:06:52.035Z
---

# Additive-scope tab pattern

Every role-aware tab in `apps/web/src/ui/tabs/` follows the same
additive-scope pattern. **Gold-standard reference**: [InventoryTab.tsx](apps/web/src/ui/tabs/InventoryTab.tsx). Sister
tabs on the same pattern: `ClientsTab`, `PropertiesTab`, `UsersTab`,
`AdminGroupsTab`, `PaymentsTab`, `PricingTab`, `SuppliesTab`,
`CollectionsTab`, `VehiclesTab`, `JobsTab` (partial), `HomeTab`.

## Prop shape

```ts
type XxxTabProps = TabPropsType & {
  /** Additive scope — capabilities ADD as you climb the ladder. */
  scope?: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
};

export default function XxxTab({ me, purpose = "WORKER", scope }: XxxTabProps) {
  const { isSuper: hasSuperRole, isAvail, forAdmin } = determineRoles(me, purpose);

  // Effective scope: prefer the additive prop; fall back to a scope
  // derived from `purpose` for any callsite still on the old shape.
  const effScope = scope ?? {
    isWorker: purpose === "WORKER",
    isAdmin: purpose === "ADMIN" || purpose === "SUPER",
    isSuper: purpose === "SUPER",
  };

  // AUTHORITATIVE — scope prop drives visibility, NOT the role.
  const showWorkerExtras = effScope.isWorker;
  const showAdminExtras = effScope.isAdmin || effScope.isSuper;
  const showSuperExtras = effScope.isSuper && hasSuperRole;
  // ... rest of tab
}
```

## THE CRITICAL RULE (bug fixed on Inventory, then propagated)

**`showSuperExtras` must NOT fall back to `forAdmin ||`**. A user with
both admin + super roles viewing the Admin top-tab must NOT see Super
buttons — that's what the Super top-tab is for. The scope prop is
authoritative. If you see `showSuperExtras = forAdmin || …` anywhere
in a blended tab, that's the bug. The Inventory audit specifically
fixed this class of leakage; JobsTab had a dead copy that was removed.

## Shell wiring — every mount site passes scope

In `apps/web/pages/index.tsx`, every mount of a blended tab passes
`scope` in addition to any legacy `purpose` prop:

```tsx
// Worker mount
scope={{ isWorker: scopeIsWorker, isAdmin: false, isSuper: false }}
// Admin mount
scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: false }}
// Super mount
scope={{ isWorker: scopeIsWorker, isAdmin: scopeIsAdmin, isSuper: scopeIsSuper }}
```

The shell computes `scopeIsWorker/scopeIsAdmin/scopeIsSuper` once (see
pages/index.tsx L~171-173) from `topTab` + the user's underlying roles.

## Persisted-state prefix convention

Where a tab uses `usePersistedState` with role-scoped keys, the prefix
keys off `showAdminExtras`, not raw `purpose`:

```ts
const pfx = showAdminExtras ? "aXxx" : "wXxx";
```

## Role-labeled action bands (card footers)

For tabs whose cards have per-role action buttons (Inventory does
this), the footer splits into up to three visually-labeled bands:

- **Worker band** — no leading badge; buttons stand alone. Under
  view-as, prefixed with a cyan `Acting as <name>` chip instead.
- **Admin band** — purple `Admin` badge lead.
- **Super band** — orange `Super` + Zap-icon badge lead.

Bands use `borderTopWidth="1px"`, `bg="blackAlpha.50"`, subtle
divider. Reference: `CardActionBands` in InventoryTab and
`ElevatedActionRow` in JobsTab.parts.

## View-as picker convention

Admin (and super) can select a worker to act on their behalf. Picker
lives inside the specific section it scopes (e.g. the Equipment
section — NOT at the tab level), backed by
`usePersistedState<string[]>("xxxTab_viewAsIds", [])`. Store one id
in the array (multi-select-shaped for reuse of `AdminViewAsSelector`,
but `slice(-1)` on onChange so clicking a new worker replaces the
old one).

Mutations under view-as route through `/api/super/*-for` endpoints
with `{ userId }` body. Those endpoints were loosened from
`superGuard` to `adminGuard` so admins can drive them via view-as.
Sensitive worker-side pre-checks (e.g. compliance) are skipped under
view-as — the server enforces on the picked worker.

## Section framing convention (across tabs)

- **Insights** (Super only, on Inventory / Home / Jobs / Collections
  / Vehicles) — orange Card.Root: `bg="orange.50"`,
  `borderColor="orange.200"`, header row has `BarChart3` icon +
  UPPERCASE "INSIGHTS" text + chevron. NO chip badge on the header.
- **Other sections** (Team Usage, Your Usage, Collections, Equipment,
  etc.) — outlined Box: `borderWidth="1px" borderColor="gray.300"
  borderRadius="md" p={3}`, mt={3}. Header row: `size={14}` icon +
  UPPERCASE title + optional count Badge + chevron.
- Sections are collapsible via a persisted `<pfx>_xxxCollapsed`
  boolean. Header `mb` collapses to `0` when the section is closed so
  a closed section reads as a single tight bar.

## Common icons on section headers (established convention)

- Insights → `BarChart3`
- Team Usage → `Users`
- Your Usage → `User`
- Collections → `Package`
- Equipment → `LayoutGrid`
- Client Requests → `Inbox`
