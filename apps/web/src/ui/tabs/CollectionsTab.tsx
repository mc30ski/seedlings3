"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Input,
  SimpleGrid,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { AlertTriangle, BarChart3, CheckCircle2, Plus, Search, Wrench, X, Zap } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

// ─── Types ────────────────────────────────────────────────────────

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

type CollectionItem = {
  id: string;
  equipmentId: string;
  equipment: EquipmentBrief;
  /** Worker-only — server flags kits the caller is currently holding. */
  heldByMe?: boolean;
};

type Collection = {
  id: string;
  name: string;
  description?: string | null;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
  items: CollectionItem[];
  /** Admin-only — count of Job rows recommending this kit. */
  _count?: { jobRecommendations: number };
};

// ─── Shared helpers ───────────────────────────────────────────────

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

// ─── Blended Collections tab ──────────────────────────────────────
// Same additive-scope model as InventoryTab:
//   scope.isWorker → read-only view + "You're using this" marker
//   scope.isAdmin  → adds Create/Edit/Delete + member editor modal
//   scope.isSuper  → adds Insights section (kits with retired members,
//                    availability heatmap, job coverage)
export default function CollectionsTab({
  scope,
}: {
  scope: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
}) {
  const showWorkerExtras = scope.isWorker;
  const showAdminExtras = scope.isAdmin || scope.isSuper;
  const showSuperExtras = scope.isSuper;

  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [allEquipment, setAllEquipment] = useState<EquipmentBrief[]>([]);
  const [editing, setEditing] = useState<Collection | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Collection | null>(null);

  async function load() {
    setLoading(true);
    try {
      // Admin+ hits the admin endpoint for the extra _count fields
      // that drive the Insights panel; worker-only hits the public
      // endpoint for the heldByMe flag on each item chip. The two
      // endpoints share a schema for everything else, so downstream
      // rendering is uniform.
      const collectionsPath = showAdminExtras
        ? "/api/admin/equipment-collections"
        : "/api/equipment-collections";
      const [list, equipment] = await Promise.all([
        apiGet<Collection[]>(collectionsPath),
        showAdminExtras
          ? apiGet<EquipmentBrief[]>("/api/equipment/all")
          : Promise.resolve([] as EquipmentBrief[]),
      ]);
      setCollections(Array.isArray(list) ? list : []);
      setAllEquipment(Array.isArray(equipment) ? equipment : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Load failed.", err) });
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [showAdminExtras]);

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
      items: [],
    });
  }

  // Nav dispatch scoped to the caller's tier so a super clicking a
  // chip lands on the super Inventory inner-tab (not the admin one).
  function openEquipment(equipmentId: string) {
    try {
      window.sessionStorage.setItem("equipmentHighlightId", equipmentId);
    } catch {}
    const eventName = showSuperExtras
      ? "navigate:superTab"
      : showAdminExtras
        ? "navigate:adminTab"
        : "navigate:workerTab";
    window.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { tab: "equipment", category: "Equipment" },
      }),
    );
  }

  return (
    <Box w="full">
      <VStack align="stretch" gap={3}>
        <HStack justify="space-between">
          <Text fontWeight="semibold">Equipment collections</Text>
          {showAdminExtras && (
            <Button size="sm" colorPalette="blue" onClick={startNew}>
              <Plus size={14} /> New collection
            </Button>
          )}
        </HStack>
        {!showAdminExtras && (
          <Text fontSize="xs" color="fg.muted">
            Kits your administrator has grouped together. View only — a
            green check marks kits you're currently using.
          </Text>
        )}

        {showSuperExtras && <CollectionsInsightsSection collections={collections} />}

        {loading ? (
          <Spinner size="sm" />
        ) : collections.length === 0 ? (
          <Card.Root variant="outline">
            <Card.Body py={6} textAlign="center">
              <Text color="fg.muted" fontSize="sm">
                {showAdminExtras
                  ? "No collections yet. Create your first kit to group equipment that gets used together."
                  : "No collections have been set up yet."}
              </Text>
            </Card.Body>
          </Card.Root>
        ) : (
          collections.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              showAdminExtras={showAdminExtras}
              onOpenEquipment={openEquipment}
              onEdit={() => setEditing(c)}
              onDelete={() => setConfirmDelete(c)}
            />
          ))
        )}
      </VStack>

      {showAdminExtras && editing && (
        <CollectionEditor
          collection={editing}
          allEquipment={allEquipment}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}

      {showAdminExtras && (
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
      )}
    </Box>
  );
}

// ─── Collection card ──────────────────────────────────────────────
// Renders one collection. Worker-only view uses the "using this"
// marker + stacked item rows; admin/super view uses the compact chip
// list + Edit/Delete controls. Item click opens the equipment on the
// appropriate Inventory tier via the parent's dispatch helper.
function CollectionCard({
  collection: c,
  showAdminExtras,
  onOpenEquipment,
  onEdit,
  onDelete,
}: {
  collection: Collection;
  showAdminExtras: boolean;
  onOpenEquipment: (equipmentId: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const usingIt = !showAdminExtras && c.items.some((it) => it.heldByMe);
  const jobCount = c._count?.jobRecommendations ?? 0;

  return (
    <Card.Root
      variant="outline"
      borderColor={usingIt ? "green.300" : undefined}
      bg={usingIt ? "green.50" : undefined}
    >
      <Card.Body py="3" px="3">
        <HStack justify="space-between" align="start" gap={3}>
          <VStack align="start" gap={1} flex={1} minW={0}>
            <HStack gap={2} flexWrap="wrap">
              <Text fontWeight="semibold">{c.name}</Text>
              <Badge size="sm" colorPalette="gray">
                {c.items.length} item{c.items.length === 1 ? "" : "s"}
              </Badge>
              {jobCount > 0 && (
                <Badge size="sm" colorPalette="blue">
                  Used by {jobCount} job{jobCount === 1 ? "" : "s"}
                </Badge>
              )}
              {usingIt && (
                <Badge size="sm" colorPalette="green">
                  <HStack gap={1}>
                    <CheckCircle2 size={12} />
                    <Text>You're using this</Text>
                  </HStack>
                </Badge>
              )}
            </HStack>
            {c.description && (
              <Text fontSize="xs" color="fg.muted">{c.description}</Text>
            )}
            {c.items.length > 0 && (
              showAdminExtras ? (
                <HStack flexWrap="wrap" gap={1.5} mt={1}>
                  {c.items.map((it) => (
                    <Badge
                      key={it.id}
                      size="sm"
                      colorPalette={it.equipment.retiredAt ? "gray" : "blue"}
                      variant="subtle"
                      cursor="pointer"
                      title={`Open ${equipmentLabel(it.equipment)} on the Inventory tab`}
                      onClick={() => onOpenEquipment(it.equipmentId)}
                    >
                      {equipmentLabel(it.equipment)}
                      {it.equipment.retiredAt && " (retired)"}
                    </Badge>
                  ))}
                </HStack>
              ) : (
                <VStack align="stretch" gap={1} mt={2} w="full">
                  {c.items.map((it) => (
                    <HStack
                      key={it.id}
                      justify="space-between"
                      gap={2}
                      px={2}
                      py={1.5}
                      borderRadius="md"
                      cursor="pointer"
                      bg={it.heldByMe ? "green.100" : "bg.subtle"}
                      _hover={{ bg: it.heldByMe ? "green.200" : "gray.100" }}
                      title={`Open ${equipmentLabel(it.equipment)} on the Inventory tab`}
                      onClick={() => onOpenEquipment(it.equipmentId)}
                    >
                      <HStack gap={1.5} minW={0}>
                        {it.heldByMe && (
                          <Box color="green.600" flexShrink={0}>
                            <CheckCircle2 size={14} />
                          </Box>
                        )}
                        <Text fontSize="sm" lineHeight="1.2">
                          {equipmentLabel(it.equipment)}
                          {it.equipment.retiredAt && " (retired)"}
                        </Text>
                      </HStack>
                      {statusBadge(it.equipment)}
                    </HStack>
                  ))}
                </VStack>
              )
            )}
          </VStack>
          {showAdminExtras && (
            <VStack gap={1}>
              <Button size="xs" variant="ghost" onClick={onEdit}>Edit</Button>
              <Button size="xs" variant="ghost" colorPalette="red" onClick={onDelete}>Delete</Button>
            </VStack>
          )}
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}

// ─── Super Insights ───────────────────────────────────────────────
// Fleet-view rollups computed entirely from the already-loaded
// collections list — no additional server calls. Three panels:
//   • Kits with issues     — collections containing retired members
//                            (admin should replace / remove).
//   • Availability heatmap — for each kit, live availability ratio
//                            so a super can spot "everything's out"
//                            at a glance.
//   • Job coverage         — kits ranked by how many jobs pin them,
//                            surfaces the most load-bearing kits.
function CollectionsInsightsSection({ collections }: { collections: Collection[] }) {
  const withRetired = useMemo(() => {
    return collections
      .map((c) => {
        const retired = c.items.filter((it) => !!it.equipment.retiredAt);
        return { c, retiredCount: retired.length };
      })
      .filter((x) => x.retiredCount > 0)
      .sort((a, b) => b.retiredCount - a.retiredCount);
  }, [collections]);

  const availability = useMemo(() => {
    return collections
      .map((c) => {
        const active = c.items.filter((it) => !it.equipment.retiredAt);
        const available = active.filter((it) => it.equipment.status === "AVAILABLE").length;
        const total = active.length;
        const ratio = total > 0 ? available / total : 0;
        return { c, available, total, ratio };
      })
      .sort((a, b) => a.ratio - b.ratio); // worst first
  }, [collections]);

  const byJobCoverage = useMemo(() => {
    return collections
      .map((c) => ({ c, count: c._count?.jobRecommendations ?? 0 }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [collections]);

  const hasAnyInsight = withRetired.length > 0 || availability.length > 0 || byJobCoverage.length > 0;
  if (!hasAnyInsight) return null;

  return (
    <Card.Root variant="outline" bg="orange.50" borderColor="orange.200">
      <Card.Body py={3} px={3}>
        <HStack gap={2} mb={2}>
          <Badge size="sm" variant="subtle" colorPalette="orange">
            <HStack gap={1}><Zap size={10} /><Text>Insights</Text></HStack>
          </Badge>
        </HStack>
        <SimpleGrid columns={{ base: 1, md: 3 }} gap={3}>
          {/* Kits with issues */}
          <InsightPanel
            title="Kits with issues"
            icon={<AlertTriangle size={14} color="var(--chakra-colors-red-600)" />}
            emptyText="No kits have retired members."
            rows={withRetired.slice(0, 5).map((x) => ({
              key: x.c.id,
              label: x.c.name,
              value: `${x.retiredCount} retired`,
              palette: "red",
            }))}
          />
          {/* Availability heatmap */}
          <InsightPanel
            title="Availability"
            icon={<Wrench size={14} color="var(--chakra-colors-orange-600)" />}
            emptyText="No kits configured."
            rows={availability.slice(0, 5).map((x) => ({
              key: x.c.id,
              label: x.c.name,
              value: x.total === 0 ? "empty" : `${x.available}/${x.total}`,
              palette: x.total === 0
                ? "gray"
                : x.ratio === 0
                  ? "red"
                  : x.ratio < 0.5
                    ? "yellow"
                    : "green",
            }))}
          />
          {/* Job coverage */}
          <InsightPanel
            title="Top by job coverage"
            icon={<BarChart3 size={14} color="var(--chakra-colors-blue-600)" />}
            emptyText="No kits are attached to any jobs yet."
            rows={byJobCoverage.slice(0, 5).map((x) => ({
              key: x.c.id,
              label: x.c.name,
              value: `${x.count} job${x.count === 1 ? "" : "s"}`,
              palette: "blue",
            }))}
          />
        </SimpleGrid>
      </Card.Body>
    </Card.Root>
  );
}

function InsightPanel(props: {
  title: string;
  icon: React.ReactNode;
  emptyText: string;
  rows: { key: string; label: string; value: string; palette: string }[];
}) {
  const { title, icon, emptyText, rows } = props;
  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" bg="white" p={2}>
      <HStack gap={1.5} mb={1.5}>
        {icon}
        <Text fontSize="xs" fontWeight="semibold" color="gray.700" textTransform="uppercase" letterSpacing="wide">
          {title}
        </Text>
      </HStack>
      {rows.length === 0 ? (
        <Text fontSize="xs" color="fg.muted" fontStyle="italic">{emptyText}</Text>
      ) : (
        <VStack align="stretch" gap={1}>
          {rows.map((r) => (
            <HStack key={r.key} justify="space-between" gap={2}>
              <Text fontSize="xs" lineClamp={1} title={r.label}>{r.label}</Text>
              <Badge size="xs" colorPalette={r.palette} variant="subtle" flexShrink={0}>
                {r.value}
              </Badge>
            </HStack>
          ))}
        </VStack>
      )}
    </Box>
  );
}

// ─── Collection editor modal (admin+) ─────────────────────────────
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
                    placeholder="Search…"
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
