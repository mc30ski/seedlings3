"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  createListCollection,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { Plus, Users, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type UserBrief = {
  id: string;
  displayName?: string | null;
  email?: string | null;
  workerType?: string | null;
};

type EquipmentBrief = {
  id: string;
  shortDesc?: string | null;
  type?: string | null;
  brand?: string | null;
  model?: string | null;
  status?: string | null;
  retiredAt?: string | null;
};

type CollectionBrief = {
  id: string;
  name: string;
  description?: string | null;
};

type GroupMember = {
  id: string;
  userId: string;
  role: string;
  equipmentCostPercent: number | null;
  user: UserBrief;
};

type PreferredEquipment = {
  id: string;
  equipmentId: string | null;
  equipmentCollectionId: string | null;
  equipment: EquipmentBrief | null;
  equipmentCollection: CollectionBrief | null;
};

type Group = {
  id: string;
  name: string;
  description: string | null;
  claimerUserId: string;
  archivedAt: string | null;
  claimer: UserBrief;
  members: GroupMember[];
  preferredEquipment: PreferredEquipment[];
};

function userLabel(u: UserBrief): string {
  return u.displayName || u.email || u.id;
}

function equipmentLabel(e: EquipmentBrief): string {
  if (e.shortDesc) return e.shortDesc;
  const parts = [e.brand, e.model].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (e.type) return e.type;
  return e.id.slice(-6);
}

/**
 * Long-form label for preferred-equipment chips. Two pieces of equipment
 * with the same shortDesc (e.g., "Push mower") can otherwise look identical
 * on the chip — append brand/model and the last 4 of the id so the admin can
 * tell which is which at a glance.
 */
function equipmentChipLabel(e: EquipmentBrief): string {
  const primary = e.shortDesc || [e.brand, e.model].filter(Boolean).join(" ") || e.type || "Equipment";
  const brandModel = [e.brand, e.model].filter(Boolean).join(" ");
  const extras: string[] = [];
  if (e.shortDesc && brandModel && !e.shortDesc.toLowerCase().includes(brandModel.toLowerCase())) {
    extras.push(brandModel);
  }
  if (e.type) extras.push(e.type);
  extras.push(`#${e.id.slice(-4)}`);
  return extras.length > 0 ? `${primary} · ${extras.join(" · ")}` : primary;
}

export default function AdminGroupsTab() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<Group | null>(null);

  // User and equipment lists, fetched once.
  const [users, setUsers] = useState<UserBrief[]>([]);
  const [equipment, setEquipment] = useState<EquipmentBrief[]>([]);
  const [collections, setCollections] = useState<CollectionBrief[]>([]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (includeArchived) params.set("includeArchived", "true");
      const qs = params.toString();
      const [list, workersList, equipList, colList] = await Promise.all([
        apiGet<Group[]>(`/api/admin/groups${qs ? `?${qs}` : ""}`),
        apiGet<UserBrief[]>("/api/workers"),
        apiGet<EquipmentBrief[]>("/api/equipment/all"),
        apiGet<CollectionBrief[]>("/api/admin/equipment-collections"),
      ]);
      setGroups(Array.isArray(list) ? list : []);
      setUsers(Array.isArray(workersList) ? workersList : []);
      setEquipment(Array.isArray(equipList) ? equipList : []);
      setCollections(Array.isArray(colList) ? colList : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Load failed.", err) });
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived]);

  async function doArchive(g: Group) {
    try {
      if (g.archivedAt) {
        await apiPost(`/api/admin/groups/${g.id}/unarchive`);
        publishInlineMessage({ type: "SUCCESS", text: `${g.name} unarchived.` });
      } else {
        await apiPost(`/api/admin/groups/${g.id}/archive`);
        publishInlineMessage({ type: "SUCCESS", text: `${g.name} archived.` });
      }
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Operation failed.", err) });
    }
  }

  return (
    <Box w="full" pb={8}>
      <HStack mb={3} gap={2} wrap="wrap">
        <Text fontSize="lg" fontWeight="semibold">Groups</Text>
        <Badge size="sm" colorPalette="gray" variant="subtle">{groups.length}</Badge>
        <Box flex="1" />
        <Button size="sm" variant="outline" onClick={() => setIncludeArchived(!includeArchived)}>
          {includeArchived ? "Hide archived" : "Show archived"}
        </Button>
        <Button size="sm" colorPalette="blue" onClick={() => setCreating(true)}>
          <Plus size={14} /> New Group
        </Button>
      </HStack>
      <Text fontSize="xs" color="fg.muted" mb={3}>
        A Group is a saved crew — one claimer plus workers/observers. When a group is assigned to a job, every member is added at once;
        the group claimer can claim jobs on behalf of the whole crew. Equipment rented on behalf of a group is split among workers.
      </Text>

      {loading ? (
        <Box textAlign="center" py={6}><Spinner /></Box>
      ) : groups.length === 0 ? (
        <Card.Root variant="outline">
          <Card.Body p={4}>
            <Text fontSize="sm" color="fg.muted">No groups yet. Click <b>New Group</b> to create your first crew.</Text>
          </Card.Body>
        </Card.Root>
      ) : (
        <VStack align="stretch" gap={2}>
          {groups.map((g) => (
            <Card.Root key={g.id} variant="outline" opacity={g.archivedAt ? 0.6 : 1}>
              <Card.Body p={3}>
                <VStack align="stretch" gap={2}>
                  <VStack align="start" gap={1} flex="1" minW={0}>
                    <HStack gap={2} wrap="wrap">
                      <Text fontWeight="semibold">{g.name}</Text>
                      <Badge size="sm" colorPalette="gray">{g.members.length + 1} member{g.members.length === 0 ? "" : "s"}</Badge>
                      {g.archivedAt && <Badge size="sm" colorPalette="gray">Archived</Badge>}
                    </HStack>
                    {g.description && (
                      <Text fontSize="xs" color="fg.muted">{g.description}</Text>
                    )}
                    <HStack gap={1.5} wrap="wrap" mt={1}>
                      <Badge size="sm" colorPalette="teal" variant="solid">
                        Claimer: {userLabel(g.claimer)}
                      </Badge>
                      {g.members.map((m) => (
                        <Badge
                          key={m.id}
                          size="sm"
                          colorPalette={m.role === "observer" ? "gray" : "blue"}
                          variant="subtle"
                        >
                          {userLabel(m.user)}{m.role === "observer" ? " (observer)" : ""}
                          {m.equipmentCostPercent != null ? ` · ${m.equipmentCostPercent}%` : ""}
                        </Badge>
                      ))}
                    </HStack>
                    {g.preferredEquipment.length > 0 && (
                      <Box mt={1.5}>
                        <Text fontSize="xs" color="fg.muted" mb={0.5}>Preferred equipment:</Text>
                        <HStack gap={1} wrap="wrap">
                          {g.preferredEquipment.map((p) => (
                            <Badge
                              key={p.id}
                              size="sm"
                              colorPalette={p.equipmentCollectionId ? "purple" : "cyan"}
                              variant="subtle"
                              cursor="pointer"
                              _hover={{ opacity: 0.8 }}
                              title={p.equipmentCollectionId ? "Open this collection on the Equipment tab" : "Open this equipment on the Equipment tab"}
                              onClick={() => {
                                try {
                                  if (p.equipmentCollectionId) {
                                    window.sessionStorage.setItem("highlightCollectionId", p.equipmentCollectionId);
                                  } else if (p.equipmentId) {
                                    window.sessionStorage.setItem("equipmentHighlightId", p.equipmentId);
                                  }
                                } catch {}
                                window.dispatchEvent(
                                  new CustomEvent("navigate:adminTab", { detail: { tab: "equipment" } }),
                                );
                              }}
                            >
                              {p.equipmentCollection
                                ? `${p.equipmentCollection.name} (kit)`
                                : p.equipment
                                  ? equipmentChipLabel(p.equipment)
                                  : "—"}
                            </Badge>
                          ))}
                        </HStack>
                      </Box>
                    )}
                  </VStack>
                  <HStack gap={2} pt={2} borderTopWidth="1px" borderColor="gray.200">
                    <Button size="sm" variant="outline" onClick={() => setEditing(g)} disabled={!!g.archivedAt}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette={g.archivedAt ? "blue" : "gray"}
                      onClick={() => setConfirmArchive(g)}
                    >
                      {g.archivedAt ? "Unarchive" : "Archive"}
                    </Button>
                  </HStack>
                </VStack>
              </Card.Body>
            </Card.Root>
          ))}
        </VStack>
      )}

      {(editing || creating) && (
        <GroupEditor
          initial={editing}
          users={users}
          equipment={equipment}
          collections={collections}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={async () => { setEditing(null); setCreating(false); await load(); }}
        />
      )}

      <ConfirmDialog
        open={!!confirmArchive}
        title={confirmArchive?.archivedAt ? "Unarchive group?" : "Archive group?"}
        message={
          confirmArchive?.archivedAt
            ? `Unarchive "${confirmArchive?.name}"? It will reappear in pickers.`
            : `Archive "${confirmArchive?.name}"? It will be hidden from active pickers but historical occurrences and rentals stay intact.`
        }
        confirmLabel={confirmArchive?.archivedAt ? "Unarchive" : "Archive"}
        confirmColorPalette={confirmArchive?.archivedAt ? "blue" : "orange"}
        onConfirm={() => {
          if (confirmArchive) void doArchive(confirmArchive);
          setConfirmArchive(null);
        }}
        onCancel={() => setConfirmArchive(null)}
      />
    </Box>
  );
}

// ─── Filterable single-select ──────────────────────────────────────────────
// Chakra v3's Select.Root has no built-in typeahead. For the Group editor's
// user / equipment / collection pickers the lists can run into the hundreds,
// so we wrap an input with a manually-filtered popover (matches the
// AdminRoutesTab worker picker pattern). 2-option lists (worker/observer)
// continue to use Select.Root since search would be wasted clicks.

type FSOption = { value: string; label: string };
type FSProps = {
  options: FSOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "xs" | "sm";
  inDialog?: boolean; // when true, dropdown uses absolute positioning + closes on outside click only
};

function FilterableSelect({ options, value, onChange, placeholder, size = "sm" }: FSProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const lc = search.toLowerCase();
  const filtered = search
    ? options.filter((o) => o.label.toLowerCase().includes(lc))
    : options;
  // Soft cap to keep the popover responsive on huge lists.
  const limited = filtered.slice(0, 100);

  return (
    <Box ref={wrapRef} position="relative" w="full">
      <Input
        ref={inputRef}
        size={size}
        placeholder={selected?.label ?? placeholder ?? "Select…"}
        value={open ? search : selected?.label ?? ""}
        onChange={(e) => { setSearch(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { setOpen(true); setSearch(""); }}
      />
      {open && (
        <Box
          // Absolute positioning instead of fixed: the popover scrolls with
          // the Dialog body (the parent has overflow:auto). Fixed-positioned
          // popovers desync when the dialog scrolls.
          position="absolute"
          top="100%"
          left="0"
          right="0"
          mt="1"
          zIndex={9999}
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          rounded="md"
          shadow="lg"
        >
          <Box maxH="250px" overflowY="auto">
            {limited.map((o) => (
              <Box
                key={o.value}
                px="3"
                py="1.5"
                fontSize="sm"
                cursor="pointer"
                bg={value === o.value ? "blue.50" : undefined}
                _hover={{ bg: "gray.100" }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(o.value);
                  setOpen(false);
                  setSearch("");
                }}
              >
                <HStack gap={2}>
                  <Text flex="1">{o.label}</Text>
                  {value === o.value && <Text color="blue.500" fontWeight="bold">✓</Text>}
                </HStack>
              </Box>
            ))}
            {filtered.length === 0 && (
              <Text fontSize="xs" color="fg.muted" px="3" py="2">No matches</Text>
            )}
            {filtered.length > limited.length && (
              <Text fontSize="xs" color="fg.muted" px="3" py="2">
                {filtered.length - limited.length} more — keep typing to narrow.
              </Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ─── Editor dialog ─────────────────────────────────────────────────────────

type EditorProps = {
  initial: Group | null; // null = creating new
  users: UserBrief[];
  equipment: EquipmentBrief[];
  collections: CollectionBrief[];
  onClose: () => void;
  onSaved: () => Promise<void>;
};

type DraftMember = {
  userId: string;
  role: string; // "worker" | "observer"
  equipmentCostPercent: number | null;
};

function GroupEditor({ initial, users, equipment, collections, onClose, onSaved }: EditorProps) {
  const isNew = !initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [claimerUserId, setClaimerUserId] = useState(initial?.claimerUserId ?? "");
  const [members, setMembers] = useState<DraftMember[]>(
    (initial?.members ?? []).map((m) => ({
      userId: m.userId,
      role: m.role,
      equipmentCostPercent: m.equipmentCostPercent,
    })),
  );
  const [preferred, setPreferred] = useState<PreferredEquipment[]>(initial?.preferredEquipment ?? []);
  const [saving, setSaving] = useState(false);
  const [addUserId, setAddUserId] = useState("");
  const [addUserRole, setAddUserRole] = useState<"worker" | "observer">("worker");
  const [prefEquipId, setPrefEquipId] = useState("");
  const [prefCollectionId, setPrefCollectionId] = useState("");

  const userMap = useMemo(() => {
    const m = new Map<string, UserBrief>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);

  // Chakra Select collections — one per dropdown. Items rebuild when their
  // source list or eligibility filter changes so adding/removing a member
  // updates the "add member" options without stale entries.
  const claimerCollection = useMemo(
    () => createListCollection({ items: users.map((u) => ({ label: userLabel(u), value: u.id })) }),
    [users],
  );
  const addMemberCollection = useMemo(
    () => createListCollection({
      items: users
        .filter((u) => u.id !== claimerUserId && !members.some((m) => m.userId === u.id))
        .map((u) => ({ label: userLabel(u), value: u.id })),
    }),
    [users, claimerUserId, members],
  );
  const roleCollection = useMemo(
    () => createListCollection({
      items: [
        { label: "Worker", value: "worker" },
        { label: "Observer", value: "observer" },
      ],
    }),
    [],
  );
  const equipmentCollection = useMemo(
    () => createListCollection({
      items: equipment.filter((e) => !e.retiredAt).map((e) => ({ label: equipmentChipLabel(e), value: e.id })),
    }),
    [equipment],
  );
  const collectionsCollection = useMemo(
    () => createListCollection({
      items: collections.map((c) => ({ label: c.name, value: c.id })),
    }),
    [collections],
  );

  // Workers (claimer + role="worker" members) for percent calculation.
  const workerCount = 1 + members.filter((m) => m.role !== "observer").length;
  const customPercents = members.some((m) => m.equipmentCostPercent != null);
  // Always include the claimer's implicit percent in the sum (null = even share).
  // For "any worker has percent → all must have percent" we use NaN as "missing".
  const claimerPercent = customPercents ? (members.find((m) => m.userId === claimerUserId)?.equipmentCostPercent ?? null) : null;
  // (Claimer's percent is stored on draft as a member row if and only if they're in members — claimer is implicit so we expose a separate slot.)
  const [claimerPercentDraft, setClaimerPercentDraft] = useState<number | null>(null);
  // Sum of percents (claimer + worker members) for display.
  const percentSum =
    (claimerPercentDraft ?? 0) +
    members.filter((m) => m.role !== "observer").reduce((s, m) => s + (m.equipmentCostPercent ?? 0), 0);
  const percentMode = customPercents || claimerPercentDraft != null;
  const percentValid = !percentMode || Math.abs(percentSum - 100) < 0.01;

  function addMember() {
    if (!addUserId) return;
    if (addUserId === claimerUserId) {
      publishInlineMessage({ type: "WARNING", text: "Claimer is already implicitly a member." });
      return;
    }
    if (members.some((m) => m.userId === addUserId)) {
      publishInlineMessage({ type: "WARNING", text: "Already in the group." });
      return;
    }
    setMembers((prev) => [
      ...prev,
      { userId: addUserId, role: addUserRole, equipmentCostPercent: null },
    ]);
    setAddUserId("");
  }

  function removeMember(userId: string) {
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
  }

  async function save() {
    if (!name.trim()) {
      publishInlineMessage({ type: "WARNING", text: "Name is required." });
      return;
    }
    if (!claimerUserId) {
      publishInlineMessage({ type: "WARNING", text: "Pick a claimer." });
      return;
    }
    if (percentMode && !percentValid) {
      publishInlineMessage({
        type: "WARNING",
        text: `Equipment cost percents must sum to 100 (currently ${percentSum.toFixed(2)}).`,
      });
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const created = await apiPost<Group>("/api/admin/groups", {
          name: name.trim(),
          description: description.trim() || null,
          claimerUserId,
          members: members.map((m) => ({
            userId: m.userId,
            role: m.role,
            equipmentCostPercent: m.equipmentCostPercent,
          })),
        });
        // Apply preferred equipment after create.
        for (const p of preferred) {
          await apiPost(`/api/admin/groups/${created.id}/preferred-equipment`, {
            equipmentId: p.equipmentId,
            equipmentCollectionId: p.equipmentCollectionId,
          });
        }
      } else {
        await apiPatch(`/api/admin/groups/${initial!.id}`, {
          name: name.trim(),
          description: description.trim() || null,
          claimerUserId,
        });
        // Sync members: figure out adds / removes / patches.
        const before = new Map(initial!.members.map((m) => [m.userId, m]));
        const after = new Map(members.map((m) => [m.userId, m]));
        // Removes
        for (const u of before.keys()) {
          if (!after.has(u)) {
            await apiDelete(`/api/admin/groups/${initial!.id}/members/${u}`);
          }
        }
        // Adds / patches
        for (const m of members) {
          const existing = before.get(m.userId);
          if (!existing) {
            await apiPost(`/api/admin/groups/${initial!.id}/members`, m);
          } else if (
            existing.role !== m.role ||
            existing.equipmentCostPercent !== m.equipmentCostPercent
          ) {
            await apiPatch(`/api/admin/groups/${initial!.id}/members/${m.userId}`, {
              role: m.role,
              equipmentCostPercent: m.equipmentCostPercent,
            });
          }
        }
        // Sync preferred equipment by id (preferred items are immutable, so it's add/remove only).
        const beforeIds = new Set(initial!.preferredEquipment.map((p) => p.id));
        const afterIds = new Set(preferred.map((p) => p.id).filter(Boolean));
        for (const id of beforeIds) {
          if (!afterIds.has(id)) {
            await apiDelete(`/api/admin/groups/preferred-equipment/${id}`);
          }
        }
        for (const p of preferred) {
          if (!p.id) {
            await apiPost(`/api/admin/groups/${initial!.id}/preferred-equipment`, {
              equipmentId: p.equipmentId,
              equipmentCollectionId: p.equipmentCollectionId,
            });
          }
        }
      }
      publishInlineMessage({ type: "SUCCESS", text: isNew ? "Group created." : "Group saved." });
      await onSaved();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
      // Close the editor on save failure so the inline error toast isn't
      // hidden behind the dialog backdrop. The user can re-open and try
      // again once they've addressed whatever blocked it (e.g. waiting
      // for in-flight work to finish).
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg" maxH="85vh" overflowY="auto">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>{isNew ? "New Group" : `Edit ${initial!.name}`}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Name *</Text>
                  <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alpha Crew" />
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Description</Text>
                  <Textarea size="sm" rows={2} value={description ?? ""} onChange={(e) => setDescription(e.target.value)} placeholder="Optional — what this crew is for, when it works together, etc." />
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Claimer *</Text>
                  <FilterableSelect
                    options={claimerCollection.items.map((it) => ({ value: it.value, label: it.label }))}
                    value={claimerUserId}
                    onChange={setClaimerUserId}
                    placeholder="— pick claimer —"
                  />
                  <Text fontSize="xs" color="fg.muted" mt={1}>
                    Only the claimer can claim jobs on behalf of the group. They're always counted as a worker for equipment cost splits.
                  </Text>
                </Box>

                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Members</Text>
                  <HStack gap={2} mb={2} wrap="wrap">
                    <Box flex={1} minW="180px">
                      <FilterableSelect
                        options={addMemberCollection.items.map((it) => ({ value: it.value, label: it.label }))}
                        value={addUserId}
                        onChange={setAddUserId}
                        placeholder="— add member —"
                      />
                    </Box>
                    <Box minW="120px">
                      <Select.Root
                        collection={roleCollection}
                        value={[addUserRole]}
                        onValueChange={(e) => setAddUserRole((e.value?.[0] as any) ?? "worker")}
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger w="full">
                            <Select.ValueText placeholder="Role" />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {roleCollection.items.map((it) => (
                              <Select.Item key={it.value} item={it.value}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                    </Box>
                    <Button size="sm" onClick={addMember} disabled={!addUserId}>Add</Button>
                  </HStack>

                  {/* Claimer slot (implicit member) */}
                  {claimerUserId && (
                    <HStack gap={2} p={1.5} bg="teal.50" rounded="sm" mb={1} wrap="wrap">
                      <Badge size="sm" colorPalette="teal" variant="solid">Claimer</Badge>
                      <Text fontSize="sm" fontWeight="medium">{userLabel(userMap.get(claimerUserId) ?? { id: claimerUserId })}</Text>
                      <Box flex="1" />
                      {percentMode && (
                        <HStack gap={1}>
                          <Input
                            size="xs"
                            type="number"
                            min={0}
                            max={100}
                            step={0.01}
                            value={claimerPercentDraft ?? ""}
                            onChange={(e) => setClaimerPercentDraft(e.target.value === "" ? null : Number(e.target.value))}
                            w="80px"
                            placeholder="%"
                          />
                          <Text fontSize="xs">%</Text>
                        </HStack>
                      )}
                    </HStack>
                  )}

                  {members.length === 0 ? (
                    <Text fontSize="xs" color="fg.muted">No additional members yet.</Text>
                  ) : (
                    <VStack align="stretch" gap={1}>
                      {members.map((m) => {
                        const u = userMap.get(m.userId);
                        return (
                          <HStack key={m.userId} gap={2} p={1.5} bg="gray.50" rounded="sm" wrap="wrap">
                            <Badge size="sm" colorPalette={m.role === "observer" ? "gray" : "blue"} variant="subtle">
                              {m.role === "observer" ? "Observer" : "Worker"}
                            </Badge>
                            <Text fontSize="sm">{userLabel(u ?? { id: m.userId })}</Text>
                            <Box flex="1" />
                            <Box minW="110px">
                              <Select.Root
                                collection={roleCollection}
                                value={[m.role]}
                                onValueChange={(e) =>
                                  setMembers((prev) =>
                                    prev.map((x) => (x.userId === m.userId ? { ...x, role: e.value?.[0] ?? "worker" } : x)),
                                  )
                                }
                                size="xs"
                                positioning={{ strategy: "fixed", hideWhenDetached: true }}
                              >
                                <Select.Control>
                                  <Select.Trigger w="full">
                                    <Select.ValueText />
                                  </Select.Trigger>
                                </Select.Control>
                                <Select.Positioner>
                                  <Select.Content>
                                    {roleCollection.items.map((it) => (
                                      <Select.Item key={it.value} item={it.value}>
                                        <Select.ItemText>{it.label}</Select.ItemText>
                                      </Select.Item>
                                    ))}
                                  </Select.Content>
                                </Select.Positioner>
                              </Select.Root>
                            </Box>
                            {m.role !== "observer" && (
                              <HStack gap={1}>
                                <Input
                                  size="xs"
                                  type="number"
                                  min={0}
                                  max={100}
                                  step={0.01}
                                  value={m.equipmentCostPercent ?? ""}
                                  onChange={(e) =>
                                    setMembers((prev) =>
                                      prev.map((x) =>
                                        x.userId === m.userId
                                          ? { ...x, equipmentCostPercent: e.target.value === "" ? null : Number(e.target.value) }
                                          : x,
                                      ),
                                    )
                                  }
                                  w="80px"
                                  placeholder="%"
                                />
                                <Text fontSize="xs">%</Text>
                              </HStack>
                            )}
                            <Button size="xs" variant="ghost" colorPalette="red" onClick={() => removeMember(m.userId)}>
                              <X size={12} />
                            </Button>
                          </HStack>
                        );
                      })}
                    </VStack>
                  )}

                  {percentMode && (
                    <HStack gap={2} mt={2} fontSize="xs">
                      <Text fontWeight="semibold">Equipment cost sum:</Text>
                      <Text color={percentValid ? "green.700" : "red.700"} fontWeight="semibold">
                        {percentSum.toFixed(2)} / 100
                      </Text>
                      {!percentValid && <Badge size="sm" colorPalette="red" variant="solid">Must equal 100</Badge>}
                    </HStack>
                  )}
                  <Box mt={2} p={2} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                    <Text fontSize="xs" fontWeight="semibold" mb={1}>How the equipment cost split works</Text>
                    <Text fontSize="xs" color="fg.muted">
                      When this group reserves equipment, the rental cost (days × daily rate) is charged at <Text as="span" fontWeight="semibold">return time</Text>, then split among the group's <Text as="span" fontWeight="semibold">workers</Text> (claimer + non-observer members). Each worker's share appears as a deduction on their payout — observers are excluded and never charged.
                    </Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      <Text as="span" fontWeight="semibold">Default (all blank):</Text> the cost splits evenly. If 4 workers rent a mower for 2 days at $50/day, each worker is charged $25.
                    </Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      <Text as="span" fontWeight="semibold">Custom (any filled):</Text> every worker must have a percent and they must sum to exactly 100. Each worker is charged that % of the rental. e.g., on a $100 rental with shares 50/30/20, those three workers pay $50, $30, $20.
                    </Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      The split is snapshotted at return time — changing percents later doesn't affect already-returned rentals.
                    </Text>
                  </Box>
                </Box>

                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Preferred Equipment</Text>
                  <Text fontSize="xs" color="fg.muted" mb={2}>
                    Suggestions that show up on this group's claimed jobs. Display-only — never auto-reserves.
                  </Text>
                  <HStack gap={2} wrap="wrap" mb={2}>
                    <Box flex={1} minW="180px">
                      <FilterableSelect
                        options={equipmentCollection.items.map((it) => ({ value: it.value, label: it.label }))}
                        value={prefEquipId}
                        onChange={(v) => { setPrefEquipId(v); setPrefCollectionId(""); }}
                        placeholder="— add individual equipment —"
                      />
                    </Box>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (!prefEquipId) return;
                        const eq = equipment.find((e) => e.id === prefEquipId);
                        if (!eq) return;
                        setPreferred((prev) => [
                          ...prev,
                          { id: "", equipmentId: eq.id, equipmentCollectionId: null, equipment: eq, equipmentCollection: null },
                        ]);
                        setPrefEquipId("");
                      }}
                      disabled={!prefEquipId}
                    >
                      Add
                    </Button>
                  </HStack>
                  <HStack gap={2} wrap="wrap" mb={2}>
                    <Box flex={1} minW="180px">
                      <FilterableSelect
                        options={collectionsCollection.items.map((it) => ({ value: it.value, label: it.label }))}
                        value={prefCollectionId}
                        onChange={(v) => { setPrefCollectionId(v); setPrefEquipId(""); }}
                        placeholder="— add equipment collection —"
                      />
                    </Box>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (!prefCollectionId) return;
                        const col = collections.find((c) => c.id === prefCollectionId);
                        if (!col) return;
                        setPreferred((prev) => [
                          ...prev,
                          { id: "", equipmentId: null, equipmentCollectionId: col.id, equipment: null, equipmentCollection: col },
                        ]);
                        setPrefCollectionId("");
                      }}
                      disabled={!prefCollectionId}
                    >
                      Add
                    </Button>
                  </HStack>

                  {preferred.length === 0 ? (
                    <Text fontSize="xs" color="fg.muted">No preferred equipment yet.</Text>
                  ) : (
                    <HStack gap={1.5} wrap="wrap">
                      {preferred.map((p, idx) => (
                        <Badge
                          key={p.id || `new-${idx}`}
                          size="sm"
                          colorPalette={p.equipmentCollectionId ? "purple" : "cyan"}
                          variant="subtle"
                          cursor="pointer"
                          onClick={() => setPreferred((prev) => prev.filter((_, i) => i !== idx))}
                          title="Click to remove"
                        >
                          {p.equipmentCollection
                            ? `${p.equipmentCollection.name} (kit)`
                            : p.equipment
                              ? equipmentChipLabel(p.equipment)
                              : "—"}
                          {" ×"}
                        </Badge>
                      ))}
                    </HStack>
                  )}
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                <Button colorPalette="blue" onClick={save} loading={saving} disabled={!name.trim() || !claimerUserId}>
                  {isNew ? "Create" : "Save"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
