---
name: patterns-legacy-reference
description: "Legacy long-form reference for tab/route/service code patterns. Predates the 2026-08-21 tab-blend refactor — prefer [[reference-tab-blend-pattern]] and [[reference-tab-ordering]] for current tab conventions."
metadata:
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:26:21.161Z
---

# Code Patterns — Seedlings3

**Historical note (2026-08-21):** The tab conventions below are the
pre-blend pattern (per-role tab files, `purpose` prop, old stubs).
Since the 2026-08-21 tab-blend refactor ([[project-tab-refactor-2026-08-21]]),
role-aware tabs use the additive-scope prop pattern documented in
[[reference-tab-blend-pattern]] and the canonical top-tab / sub-tab
ordering in [[reference-tab-ordering]]. Prefer those over this file for
new tab work. The Route/Service patterns below still apply.

## Web Tab Pattern (apps/web/src/ui/tabs/)

### Props
- Legacy tabs use `TabPropsType` = `{ me: Me | null; purpose: Role }` (Role = "WORKER"|"ADMIN"|"SUPER"). **Blended tabs now also accept a `scope: { isWorker, isAdmin, isSuper }` prop — see [[reference-tab-blend-pattern]].**
- Older stubs (Users, Activity, AuditLog) used `{ role: "worker" | "admin" }` — this was normalized during the 2026-08-21 blend refactor.

### Standard Tab Structure
```tsx
"use client";
// imports: Chakra (Box, Button, Card, HStack, VStack, Spacer, Text, Select, createListCollection)
// local: apiGet, apiPost, apiDelete, determineRoles, prettyStatus, XStatusColor
// types: TabPropsType, X_STATUS, X_KIND, type X
// components: publishInlineMessage, getErrorMessage, UnavailableNotice, LoadingCenter,
//             SearchWithClear, StatusBadge, StatusButton, DeleteDialog, XDialog

const kindStates = ["ALL", ...X_KIND] as const;
const statusStates = ["ALL", ...X_STATUS] as const;

export default function XTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isSuper, isAvail, forAdmin } = determineRoles(me, purpose);

  // Filter state
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");
  const [kind, setKind] = useState<string[]>(["ALL"]);

  // Data state
  const [items, setItems] = useState<X[]>([]);
  const [loading, setLoading] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<X | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  // Dropdown collection for kind filter
  const kindItems = useMemo(() => kindStates.map(s => ({ label: prettyStatus(s), value: s })), []);
  const kindCollection = useMemo(() => createListCollection({ items: kindItems }), [kindItems]);

  async function load(displayLoading = true) {
    setLoading(displayLoading);
    try {
      const base = forAdmin ? "/api/admin/x" : "/api/x";
      const list: X[] = await apiGet(base);
      setItems(list.sort((a, b) => a.displayName.localeCompare(b.displayName)));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load.", err) });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [forAdmin]);

  const filtered = useMemo(() => {
    let rows = items;
    if (kind[0] !== "ALL") rows = rows.filter(i => i.kind === kind[0]);
    if (status !== "ALL") rows = rows.filter(i => i.status === status);
    const qlc = q.trim().toLowerCase();
    if (qlc) rows = rows.filter(r => [r.displayName, ...otherFields].some(f => f.toLowerCase().includes(qlc)));
    return rows;
  }, [items, q, kind, status]);

  if (!isAvail) return <UnavailableNotice />;
  if (loading) return <LoadingCenter />;

  return (
    <Box w="full">
      {/* Filter bar */}
      <HStack mb={3} gap={3}>
        <SearchWithClear ref={inputRef} value={q} onChange={setQ} inputId="x-search" placeholder="Search…" />
        <Select.Root ...>...</Select.Root>
        <Spacer />
        {forAdmin && <Button onClick={openCreate}>New</Button>}
      </HStack>
      {/* Status toggle buttons */}
      <HStack mb={3} gap={2} wrap="wrap">
        {statusStates.map(s => (
          <Button key={s} size="sm" variant={status === s ? "solid" : "outline"} onClick={() => setStatus(s)}>
            {prettyStatus(s)}
          </Button>
        ))}
      </HStack>
      {/* List */}
      <VStack align="stretch" gap={3}>
        {!loading && filtered.length === 0 && <Box p="8" color="fg.muted">No items match.</Box>}
        {filtered.map(item => (
          <Card.Root key={item.id} variant="outline">
            <Card.Header pb="2">
              <HStack gap={3} justify="space-between" align="center">
                <HStack gap={3} flex="1" minW={0}>
                  <Text fontWeight="semibold">{item.displayName}</Text>
                  <StatusBadge status={item.status} palette={xStatusColor(item.status)} variant="subtle" />
                </HStack>
                <StatusBadge status={item.kind} palette="gray" variant="outline" />
              </HStack>
            </Card.Header>
            <Card.Body pt="0">...</Card.Body>
            {forAdmin && (
              <Card.Footer>
                <HStack gap={2} wrap="wrap" mb="2">
                  <StatusButton id="x-edit" itemId={item.id} label="Edit" onClick={...} variant="outline"
                    disabled={loading} busyId={statusButtonBusyId} setBusyId={setStatusButtonBusyId} />
                  {/* Conditional action buttons based on status */}
                </HStack>
              </Card.Footer>
            )}
          </Card.Root>
        ))}
      </VStack>
      {/* Dialogs at bottom */}
      {forAdmin && <XDialog open={dialogOpen} onOpenChange={setDialogOpen} mode={editing ? "UPDATE" : "CREATE"}
        role={forAdmin ? "ADMIN" : "WORKER"} initial={editing ?? undefined} onSaved={() => void load()} />}
      {forAdmin && <DeleteDialog toDelete={toDelete} cancel={() => setToDelete(null)}
        complete={async () => { if (!toDelete) return; await hardDelete(toDelete.id, toDelete.extra ?? ""); setToDelete(null); }} />}
    </Box>
  );
}
```

### Action Helpers
- `doAction(item, "Name", "domain", "action", "nameField", () => load(false))` — POST `/api/admin/{domain}/{id}/{action}`
- `doDelete(id, "Name", "domain", displayName, () => load(false))` — DELETE `/api/admin/{domain}/{id}`
- Direct `apiPost`/`apiDelete` for nested resources (e.g., contacts on a client)

### Types Pattern (apps/web/src/lib/types.ts)
```ts
export const X_STATUS = ["ACTIVE", "ARCHIVED"] as const;
export type XStatus = (typeof X_STATUS)[number];

export type X = {
  id: string;
  status: XStatus;
  displayName: string;
  // ...fields
  createdAt?: string | null;
  updatedAt?: string | null;
};
```

## API Route Pattern (apps/api/src/routes/admin.ts)

```ts
const adminGuard = { preHandler: (req, reply) => app.requireRole(req, reply, RoleVal.ADMIN) };

// GET list
app.get("/admin/x", adminGuard, async (req: any) => {
  const { q, status, limit } = (req.query || {}) as { q?: string; status?: string; limit?: string };
  return services.x.list({ q, status: status as any, limit: limit ? Number(limit) : undefined });
});

// GET single
app.get("/admin/x/:id", adminGuard, async (req: any) => services.x.get(String(req.params.id)));

// POST create
app.post("/admin/x", adminGuard, async (req: any) =>
  services.x.create(await currentUserId(req), req.body));

// PATCH update
app.patch("/admin/x/:id", adminGuard, async (req: any) =>
  services.x.update(await currentUserId(req), String(req.params.id), req.body));

// POST action (status transitions)
app.post("/admin/x/:id/action", adminGuard, async (req: any) =>
  services.x.action(await currentUserId(req), String(req.params.id)));

// DELETE
app.delete("/admin/x/:id", adminGuard, async (req: any) =>
  services.x.hardDelete(await currentUserId(req), String(req.params.id)));
```

## API Service Pattern (apps/api/src/services/x.ts)

```ts
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { ServiceError } from "../lib/errors";

export const x = {
  async list(params?) {
    const where: any = {};
    // build where from params
    return prisma.x.findMany({ where, include: { ... }, orderBy: { ... } });
  },

  async get(id: string) {
    const item = await prisma.x.findUnique({ where: { id }, include: { ... } });
    if (!item) throw new ServiceError("NOT_FOUND", "X not found", 404);
    return item;
  },

  async create(currentUserId: string, body: any) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.x.create({ data: { ...body } });
      await writeAudit(tx, AUDIT.X.CREATED, currentUserId, { xRecord: { ...item } });
      return item;
    });
  },

  async update(currentUserId: string, id: string, body: any) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.x.update({ where: { id }, data: { ...body } });
      await writeAudit(tx, AUDIT.X.UPDATED, currentUserId, { xRecord: { ...item } });
      return item;
    });
  },

  async someAction(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.x.update({ where: { id }, data: { status: "NEW_STATUS" } });
      await writeAudit(tx, AUDIT.X.SOME_ACTION, currentUserId, { xRecord: { ...item } });
      return item;
    });
  },

  async hardDelete(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.x.delete({ where: { id } });
      await writeAudit(tx, AUDIT.X.DELETED, currentUserId, { xRecord: { ...item } });
      return { deleted: true };
    });
  },
};
```

## Tab Registration (pages/index.tsx)
- Tabs registered in `workerTabs` and `adminTabs` arrays
- Each tab: `{ value: "x", label: "X", icon: FiX, content: wrapWithInlineMessage(<XTab me={me} purpose="WORKER|ADMIN" />) }`
- Type references in `AdminTabs` and `WorkerTabs` union types in types.ts

## Notes on Existing Stubs (STALE — see 2026-08-21 refactor)

The notes below described the state before the tab-blend refactor. Current reality:

- UsersTab, ActivityTab, AuditTab (renamed from AuditLogTab) are all fully implemented; UsersTab got a `WorkerTeamRoster` sub-component in the blend refactor.
- JobsTab, PaymentsTab, ServicesTab are all shipped and non-trivial (JobsTab is ~9929 lines).
- Mobile app: still ignore for now.

For current tab status and the blended shape, see [[project-tab-refactor-2026-08-21]], [[reference-tab-blend-pattern]], and [[reference-tab-ordering]].
