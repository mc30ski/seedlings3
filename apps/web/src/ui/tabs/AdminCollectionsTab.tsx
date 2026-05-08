"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Input,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { Plus, Search, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type EquipmentBrief = {
  id: string;
  qrSlug?: string | null;
  shortDesc?: string | null;
  type?: string | null;
  brand?: string | null;
  model?: string | null;
  status?: string | null;
  retiredAt?: string | null;
};

type Collection = {
  id: string;
  name: string;
  description?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  items: { id: string; equipmentId: string; equipment: EquipmentBrief }[];
  _count?: { jobRecommendations: number };
};

function equipmentLabel(e: EquipmentBrief): string {
  if (e.shortDesc) return e.shortDesc;
  const parts = [e.brand, e.model].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (e.type) return e.type;
  return e.id.slice(-6);
}

function statusBadge(e: EquipmentBrief) {
  if (e.retiredAt) return <Badge size="sm" colorPalette="gray">Retired</Badge>;
  if (e.status === "AVAILABLE") return <Badge size="sm" colorPalette="green">Available</Badge>;
  if (e.status === "CHECKED_OUT") return <Badge size="sm" colorPalette="blue">Checked out</Badge>;
  if (e.status === "RESERVED") return <Badge size="sm" colorPalette="yellow">Reserved</Badge>;
  if (e.status === "MAINTENANCE") return <Badge size="sm" colorPalette="orange">Maintenance</Badge>;
  return null;
}

export default function AdminCollectionsTab() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [allEquipment, setAllEquipment] = useState<EquipmentBrief[]>([]);
  const [editing, setEditing] = useState<Collection | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Collection | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [list, equipment] = await Promise.all([
        apiGet<Collection[]>("/api/admin/equipment-collections"),
        apiGet<EquipmentBrief[]>("/api/equipment/all"),
      ]);
      setCollections(Array.isArray(list) ? list : []);
      setAllEquipment(Array.isArray(equipment) ? equipment : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Load failed.", err) });
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  async function remove(id: string) {
    try {
      await apiDelete(`/api/admin/equipment-collections/${id}`);
      await load();
      publishInlineMessage({ type: "SUCCESS", text: "Collection deleted." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  function startNew() {
    setEditing({
      id: "",
      name: "",
      description: "",
      sortOrder: 100,
      createdAt: "",
      updatedAt: "",
      items: [],
    });
  }

  return (
    <Box w="full">
      <VStack align="stretch" gap={3}>
        <HStack justify="space-between">
          <Text fontWeight="semibold">Equipment collections</Text>
          <Button size="sm" colorPalette="blue" onClick={startNew}>
            <Plus size={14} /> New collection
          </Button>
        </HStack>

        {loading ? (
          <Spinner size="sm" />
        ) : collections.length === 0 ? (
          <Card.Root variant="outline">
            <Card.Body py={6} textAlign="center">
              <Text color="fg.muted" fontSize="sm">
                No collections yet. Create your first kit to group equipment that gets used together.
              </Text>
            </Card.Body>
          </Card.Root>
        ) : (
          collections.map((c) => (
            <Card.Root key={c.id} variant="outline">
              <Card.Body py="3" px="3">
                <HStack justify="space-between" align="start" gap={3}>
                  <VStack align="start" gap={1} flex={1} minW={0}>
                    <HStack gap={2}>
                      <Text fontWeight="semibold">{c.name}</Text>
                      <Badge size="sm" colorPalette="gray">{c.items.length} item{c.items.length === 1 ? "" : "s"}</Badge>
                      {(c._count?.jobRecommendations ?? 0) > 0 && (
                        <Badge size="sm" colorPalette="blue">Used by {c._count!.jobRecommendations} job{c._count!.jobRecommendations === 1 ? "" : "s"}</Badge>
                      )}
                    </HStack>
                    {c.description && (
                      <Text fontSize="xs" color="fg.muted">{c.description}</Text>
                    )}
                    {c.items.length > 0 && (
                      <HStack flexWrap="wrap" gap={1.5} mt={1}>
                        {c.items.map((it) => (
                          <Badge
                            key={it.id}
                            size="sm"
                            colorPalette={it.equipment.retiredAt ? "gray" : "blue"}
                            variant="subtle"
                            cursor="pointer"
                            title={`Open ${equipmentLabel(it.equipment)} on the Equipment tab`}
                            onClick={() => {
                              try {
                                window.sessionStorage.setItem(
                                  "equipmentHighlightId",
                                  it.equipmentId,
                                );
                              } catch {}
                              window.dispatchEvent(
                                new CustomEvent("navigate:adminTab", {
                                  detail: { tab: "equipment" },
                                }),
                              );
                            }}
                          >
                            {equipmentLabel(it.equipment)}
                            {it.equipment.retiredAt && " (retired)"}
                          </Badge>
                        ))}
                      </HStack>
                    )}
                  </VStack>
                  <VStack gap={1}>
                    <Button size="xs" variant="ghost" onClick={() => setEditing(c)}>Edit</Button>
                    <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setConfirmDelete(c)}>Delete</Button>
                  </VStack>
                </HStack>
              </Card.Body>
            </Card.Root>
          ))
        )}
      </VStack>

      {editing && (
        <CollectionEditor
          collection={editing}
          allEquipment={allEquipment}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete collection?"
        message={confirmDelete ? `Delete "${confirmDelete.name}"? Equipment in the collection is unaffected — only the grouping is removed.` : ""}
        confirmLabel="Delete"
        confirmColorPalette="red"
        onConfirm={async () => {
          const c = confirmDelete;
          setConfirmDelete(null);
          if (c) await remove(c.id);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </Box>
  );
}

// ── Collection editor modal ───────────────────────────────────────
function CollectionEditor(props: {
  collection: Collection;
  allEquipment: EquipmentBrief[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { collection, allEquipment, onClose, onSaved } = props;
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(collection.items.map((i) => i.equipmentId));
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // Show non-retired first, then retired (since collections can include retired
  // pieces but we don't want to push admins toward them). Active members of
  // the collection come first regardless so admin can review what's in it.
  const sortedEquipment = useMemo(() => {
    const memberSet = new Set(memberIds);
    const arr = [...allEquipment];
    arr.sort((a, b) => {
      const aMember = memberSet.has(a.id);
      const bMember = memberSet.has(b.id);
      if (aMember !== bMember) return aMember ? -1 : 1;
      const aRetired = !!a.retiredAt;
      const bRetired = !!b.retiredAt;
      if (aRetired !== bRetired) return aRetired ? 1 : -1;
      return equipmentLabel(a).localeCompare(equipmentLabel(b));
    });
    return arr;
  }, [allEquipment, memberIds]);

  const filteredEquipment = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedEquipment;
    return sortedEquipment.filter((e) => {
      const haystack = [
        equipmentLabel(e),
        e.brand,
        e.model,
        e.type,
        e.qrSlug,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [sortedEquipment, search]);

  const toggleMember = (id: string) => {
    setMemberIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        equipmentIds: memberIds,
      };
      if (collection.id) {
        await apiPatch(`/api/admin/equipment-collections/${collection.id}`, payload);
      } else {
        await apiPost("/api/admin/equipment-collections", payload);
      }
      publishInlineMessage({ type: "SUCCESS", text: "Collection saved." });
      await onSaved();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Box position="fixed" inset={0} bg="rgba(0,0,0,0.4)" zIndex={1000} display="flex" alignItems="center" justifyContent="center" p={4}>
      <Box bg="white" borderRadius="md" p={4} maxW="640px" w="full" maxH="90vh" overflowY="auto" boxShadow="lg">
        <HStack justify="space-between" mb={3}>
          <Text fontWeight="semibold">{collection.id ? "Edit collection" : "New collection"}</Text>
          <Button size="xs" variant="ghost" onClick={onClose}><X size={14} /></Button>
        </HStack>
        <VStack align="stretch" gap={3}>
          <Box>
            <Text fontSize="xs" color="fg.muted" mb={1}>Name *</Text>
            <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mowing Kit" />
          </Box>
          <Box>
            <Text fontSize="xs" color="fg.muted" mb={1}>Description</Text>
            <Textarea size="sm" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What this kit is for, when to use it…" />
          </Box>

          <Box>
            <HStack justify="space-between" mb={1}>
              <Text fontSize="xs" color="fg.muted">Members ({memberIds.length})</Text>
              {memberIds.length > 0 && (
                <Button size="xs" variant="ghost" onClick={() => setMemberIds([])}>Clear all</Button>
              )}
            </HStack>
            <Box borderWidth="1px" borderRadius="md" p={2} bg="bg.subtle">
              <HStack gap={2} mb={2}>
                <Box flex={1} display="flex" alignItems="center" borderWidth="1px" borderRadius="md" px={2} bg="white">
                  <Search size={14} />
                  <Input
                    variant="outline"
                    size="sm"
                    border="none"
                    pl={2}
                    placeholder="Search equipment..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </Box>
              </HStack>
              <VStack align="stretch" gap={1} maxH="320px" overflowY="auto">
                {filteredEquipment.map((e) => {
                  const checked = memberIds.includes(e.id);
                  const brandModel = [e.brand, e.model].filter(Boolean).join(" ");
                  // Primary label (the descriptive name), with brandModel and
                  // qrSlug as secondary info to disambiguate similar pieces.
                  const primary = e.shortDesc || brandModel || e.type || e.id.slice(-6);
                  // Show brand+model on the second line only if it isn't already
                  // the primary text.
                  const secondary = brandModel && brandModel !== primary ? brandModel : null;
                  return (
                    <HStack
                      key={e.id}
                      px={2} py={1.5}
                      borderRadius="md"
                      cursor="pointer"
                      bg={checked ? "blue.50" : undefined}
                      _hover={{ bg: checked ? "blue.100" : "gray.50" }}
                      onClick={() => toggleMember(e.id)}
                      align="start"
                    >
                      <Box mt="2px"><input type="checkbox" readOnly checked={checked} /></Box>
                      <VStack align="start" gap={0} flex={1} minW={0}>
                        <Text fontSize="sm" fontWeight="medium" lineHeight="1.2">{primary}</Text>
                        <HStack gap={2} fontSize="xs" color="fg.muted" flexWrap="wrap">
                          {secondary && <Text>{secondary}</Text>}
                          {e.type && <Text>· {e.type}</Text>}
                          {e.qrSlug && <Text fontFamily="mono">· {e.qrSlug}</Text>}
                        </HStack>
                      </VStack>
                      {statusBadge(e)}
                    </HStack>
                  );
                })}
                {filteredEquipment.length === 0 && (
                  <Text fontSize="xs" color="fg.muted" textAlign="center" py={2}>No matches.</Text>
                )}
              </VStack>
            </Box>
          </Box>

          <HStack justify="flex-end" gap={2}>
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" colorPalette="blue" loading={saving} disabled={!name.trim()} onClick={save}>Save</Button>
          </HStack>
        </VStack>
      </Box>
    </Box>
  );
}
