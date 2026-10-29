"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Text,
  VStack,
  Spinner,
  Select,
  createListCollection,
} from "@chakra-ui/react";
import { Filter, LayoutList, MapPin, Plus, RefreshCw, X } from "lucide-react";
import { apiGet, apiDelete, apiPost } from "@/src/lib/api";
import TabExplainer, { Em, ExplainerText, CapabilitySection } from "@/src/ui/components/TabExplainer";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { prettyStatus, clientLabel } from "@/src/lib/labels";
import { scopeFromMe } from "@/src/lib/roles";
import { propertyStatusColor } from "@/src/lib/statusColors";
import {
  type TabPropsType,
  PROPERTY_KIND,
  PROPERTY_STATUS,
  type Property,
} from "@/src/lib/types";
import { openEventSearch, onEventSearchRun } from "@/src/lib/bus";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import StatusButton from "@/src/ui/components/StatusButton";
import DeleteDialog, {
  type ToDeleteProps,
} from "@/src/ui/dialogs/DeleteDialog";
import PropertyDialog from "@/src/ui/dialogs/PropertyDialog";
import PropertyPhotosManager from "@/src/ui/components/PropertyPhotosManager";
import { TextLink, MapLink } from "@/src/ui/helpers/Link";
import type { Scope } from "@/src/lib/scope";
import { isFieldCleared } from "../../lib/scope";
import { PortfolioBadges } from "@/src/lib/portfolios";

// Constant representing the kind states for this entity.
const kindStates = ["ALL", ...PROPERTY_KIND] as const;

// Constant representing the status states for this entity.
const statusStates = ["ALL", ...PROPERTY_STATUS] as const;

type PropertiesTabProps = TabPropsType & {
  /** What the caller may do, as capabilities.
   *  `clients.view`   → the property list (ACTIVE only without manage).
   *  `clients.manage` → CRUD, the photos manager, and delete.
   *  Absent fails closed — it grants nothing. */
  scope?: Scope;
};

export default function PropertiesTab({
  me,
  scope,
}: PropertiesTabProps) {

  // Effective scope: prefer the additive prop; fall back to a scope
  // derived from `purpose` for any callsite still on the old shape.
  const effScope = scope ?? {
    // Derived from CAPABILITIES, not from the shell that mounted
    // this tab. These three read `purpose` and so answered
    // "what may I do" with "where did you come from".
    ...scopeFromMe(me),
    
  };
  // Capabilities render additively AND are strictly governed by the
  // scope prop — not by the underlying role. A user with admin+super
  // roles viewing the *Admin* tab must NOT see management buttons.
  const canViewClients = effScope.can("clients.view");
  // What this gates, per the route map.
  const canManageClients = effScope.can("clients.manage");

  const pfx = canManageClients ? "aprops" : "wprops";
  // WHO SEES THE WHOLE BOOK. Three different people do, for three reasons:
  // they edit it (`clients.manage`), they work it (`work.claim`, via
  // isFieldCleared), or they watch it without doing either
  // (`clients.view-all`). The third was missing, so every read-only
  // oversight role was narrowed to "the customers you are assigned to" —
  // which, for somebody who works no visits, is none of them.
  const notFieldCleared =
    !canManageClients && !isFieldCleared(me) && !scope?.can?.("clients.view-all");
  const [restrictedPropertyIds, setRestrictedPropertyIds] = useState<Set<string> | null>(null);

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(`${pfx}_status`, ["ALL"]);
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);

  const [items, setItems] = useState<Property[]>([]);
  const [loading, setLoading] = useState(false);
  /** Has the first fetch finished? Not the same as `loading`, which starts
   *  false while the fetch is kicked off by an effect that runs after the
   *  first paint — so the empty state was announced before anything had
   *  been asked for. See the longer note in ClientsTab. */
  const [hasLoaded, setHasLoaded] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Property | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // Helper variable to disable other buttons while actions are in flight.
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  // Used to create the dropdown menus.
  const kindItems = useMemo(
    () => kindStates.map((s) => ({ label: s === "ALL" ? "All Kinds" : prettyStatus(s), value: s })),
    [],
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems],
  );

  const statusItems = useMemo(
    () => statusStates.map((s) => ({ label: s === "ALL" ? "All Statuses" : prettyStatus(s), value: s })),
    []
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );

  // Main function to load all the items from the API.
  async function load(displayLoading: boolean = true) {
    setLoading(displayLoading);
    try {
      const base = canManageClients ? "/api/properties" : "/api/properties";
      const list: Property[] = await apiGet(base);
      setItems(
        list
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .filter((i) => canManageClients || i.status === "ACTIVE"),
      );
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load properties.", err),
      });
      setItems([]);
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }

  // Loads all the items for the first time.
  useEffect(() => {
    void load();
  }, [canManageClients]);

  // For trainees: fetch their assigned property IDs
  useEffect(() => {
    if (!notFieldCleared) { setRestrictedPropertyIds(null); return; }
    apiGet<any[]>("/api/occurrences")
      .then((occs) => {
        const myId = me?.id;
        const ids = new Set<string>();
        for (const occ of occs) {
          if ((occ.assignees ?? []).some((a: any) => a.userId === myId)) {
            if (occ.job?.property?.id) ids.add(occ.job.property.id);
          }
        }
        setRestrictedPropertyIds(ids);
      })
      .catch(() => setRestrictedPropertyIds(new Set()));
  }, [notFieldCleared, me?.id]);

  useEffect(() => {
    // EVERY disposer is kept and run on unmount. These were fire-and-forget:
    // the return values were dropped, so each mount added listeners that the
    // next unmount never removed. They hold this render's setQ / setHighlightId
    // in closure, so after a remount a single cross-tab jump runs the handler
    // once per historical mount, the dead ones writing into unmounted state.
    const offs = [
      onEventSearchRun("clientTabToPropertiesTabSearch", setQ, inputRef, setHighlightId),
      onEventSearchRun("jobsTabToPropertiesTabSearch", setQ, inputRef, setHighlightId),
      onEventSearchRun("paymentsTabToPropertiesTabSearch", setQ, inputRef, setHighlightId),
      onEventSearchRun("areasTabToPropertiesTabSearch", setQ, inputRef, setHighlightId),
    ];
    return () => { for (const off of offs) off(); };
  }, []);

  // Filtered items based on search, kind or status.
  const filtered = useMemo(() => {
    // If navigated here by ID, show only that entity
    if (highlightId) {
      const exact = items.find((r) => r.id === highlightId);
      if (exact) return [exact];
    }

    // Trainees: wait for filter data before showing anything
    if (notFieldCleared && !restrictedPropertyIds) return [];

    let rows = items;

    // Trainees only see properties they are assigned to
    if (notFieldCleared && restrictedPropertyIds) {
      rows = rows.filter((r) => restrictedPropertyIds.has(r.id));
    }

    // Filter based on entity type.
    if (kind[0] !== "ALL") {
      rows = rows.filter((i) => i.kind === kind[0]);
    }

    // Filter based on entity status.
    const sf = statusFilter[0];
    if (sf !== "ALL") {
      rows = rows.filter((i) => i.status === sf);
    }

    // Filter based on free text.
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) => {
        const arr = [
          r.displayName || "",
          r.status || "",
          r.status || "",
          r.kind || "",
          r.street1 || "",
          r.street2 || "",
          r.city || "",
          r.state || "",
          r.postalCode || "",
          r.country || "",
          r.accessNotes || "",
          r.client?.displayName || "",
          r.pointOfContact?.firstName || "",
          r.pointOfContact?.lastName || "",
        ];
        return arr.map((i) => i.toLowerCase()).some((i) => i.includes(qlc));
      });
    }

    rows.sort((a, b) => {
      const ca = (a.client?.displayName ?? "").toLowerCase();
      const cb = (b.client?.displayName ?? "").toLowerCase();
      if (ca < cb) return -1;
      if (ca > cb) return 1;
      return (a.displayName ?? "").toLowerCase().localeCompare((b.displayName ?? "").toLowerCase());
    });

    return rows;
  }, [items, q, kind, statusFilter, highlightId, notFieldCleared, restrictedPropertyIds]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function openEdit(p: Property) {
    setEditing(p);
    setDialogOpen(true);
  }

  async function archive(p: Property) {
    try {
      await apiPost(`/api/properties/${p.id}/archive`, {});
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Property '${p.displayName}' archived.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          `Property '${p.displayName}' archive failed.`,
          err,
        ),
      });
    }
  }
  async function unarchive(p: Property) {
    try {
      await apiPost(`/api/properties/${p.id}/unarchive`, {});
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Property '${p.displayName}' unarchived.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          `Property '${p.displayName}' unarchive failed.`,
          err,
        ),
      });
    }
  }

  // Archive/unarchive cascade confirmation — matches ClientsTab shape.
  // Property.archive cascades to its Jobs; unarchive symmetrically
  // brings them back to ACCEPTED. Preview counts come from the server.
  const [archivePropertyConfirm, setArchivePropertyConfirm] = useState<
    | { property: Property; jobsToArchive: number }
    | null
  >(null);
  const [unarchivePropertyConfirm, setUnarchivePropertyConfirm] = useState<
    | { property: Property; jobsToUnarchive: number }
    | null
  >(null);

  async function openArchivePropertyConfirm(p: Property) {
    try {
      const preview = await apiGet<{ jobsToArchive: number }>(
        `/api/properties/${p.id}/archive-preview`,
      );
      setArchivePropertyConfirm({ property: p, ...preview });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Could not load archive preview.", err),
      });
    }
  }

  async function openUnarchivePropertyConfirm(p: Property) {
    try {
      const preview = await apiGet<{ jobsToUnarchive: number }>(
        `/api/properties/${p.id}/unarchive-preview`,
      );
      setUnarchivePropertyConfirm({ property: p, ...preview });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Could not load unarchive preview.", err),
      });
    }
  }
  async function hardDelete(id: string, displayName: string) {
    try {
      setLoading(true);
      await apiDelete(`/api/properties/${id}`);
      await load(true);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Property '${displayName}' deleted.`,
      });
    } catch (err) {
      setLoading(false);
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Property '${displayName}' delete failed.`, err),
      });
    }
  }

  // HOISTED ABOVE THE LOADING GATES ON PURPOSE.
  // The help panel is static copy — it does not depend on anything this tab
  // fetches. While it lived below the gates it was unmounted for the whole
  // fetch, and because the breadcrumb's (i) is driven by whichever explainer
  // is mounted, the icon blinked out and back on every visit to this tab.
  // Rendering it in the gate branches too keeps it mounted from the first
  // paint. Closed, it renders nothing, so the loading view is unchanged.
  const tabHelp = (
      <TabExplainer explainerId={`seedlings:propertiesTab:guideOpen:${canManageClients ? "admin" : "worker"}`}>
        <ExplainerText>
          Every place you service, each belonging to a client — where they are, who they
          belong to, and what is particular about each one. Properties are set up by whoever
              manages clients.
        </ExplainerText>
        <ExplainerText>
          The <Em>photos</Em> are the useful part: they are what a worker sees as guidance on
          the job — access, gate codes, the awkward corner that is easy to miss. Worth a look
          before a first visit.
        </ExplainerText>
        {canManageClients && (
          <CapabilitySection capability="clients.manage" scope={scope}>
            <ExplainerText>
              You can add and edit properties, and keep <Em>photos with descriptions</Em> — a
              picture of the gate code or the awkward corner earns its place. Archiving a
              property <Em>previews what it will affect</Em> first, so it is never blind.
            </ExplainerText>
          </CapabilitySection>
        )}
      </TabExplainer>
  );

  if (!canViewClients) return <>{tabHelp}<UnavailableNotice /></>;
  // Same two conditions as ClientsTab: the first paint has asked for
  // nothing yet, and the assigned-property set arrives on its own request.
  const scopeStillResolving = notFieldCleared && !restrictedPropertyIds;
  if (!hasLoaded || scopeStillResolving || (loading && items.length === 0)) {
    return <>{tabHelp}<LoadingCenter /></>;
  }

  return (
    <Box w="full">
      {tabHelp}
      <HStack mb={2} gap={2}>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-subtle)" }}>
          <RefreshCw size={14} />
        </Button>
        <SearchWithClear
          ref={inputRef}
          value={q}
          onChange={(v) => { setQ(v); setHighlightId(null); }}
          inputId="properties-search"
          placeholder="Search…"
        />
        <Select.Root
          collection={kindCollection}
          value={kind}
          onValueChange={(e) => setKind(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: kind[0] !== "ALL" ? "var(--chakra-colors-blue-muted)" : "var(--chakra-colors-blue-subtle)", border: kind[0] !== "ALL" ? "1px solid var(--chakra-colors-blue-strong)" : "1px solid var(--chakra-colors-blue-emphasized)", borderRadius: "6px" }}>
              <LayoutList size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {kindItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={statusCollection}
          value={statusFilter}
          onValueChange={(e) => setStatusFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: statusFilter[0] !== "ALL" ? "var(--chakra-colors-purple-muted)" : "var(--chakra-colors-purple-subtle)", border: statusFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-purple-strong)" : "1px solid var(--chakra-colors-purple-emphasized)", borderRadius: "6px" }}>
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {statusItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        {canManageClients && (
          <Button
            variant="solid"
            size="sm"
            px="2"
            minW="0"
            bg="black"
            color="white"
            onClick={openCreate}
          >
            <Plus size={16} strokeWidth={2.5} />
          </Button>
        )}
      </HStack>
      {(kind[0] !== "ALL" || statusFilter[0] !== "ALL") && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          {kind[0] !== "ALL" && (
            <Badge size="sm" colorPalette="blue" variant="subtle">
              {kindItems.find((i) => i.value === kind[0])?.label}
            </Badge>
          )}
          {statusFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="purple" variant="subtle">
              {statusItems.find((i) => i.value === statusFilter[0])?.label}
            </Badge>
          )}
          {!(kind[0] === "ALL" && statusFilter[0] === "ALL" && !q && !highlightId) && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setKind(["ALL"]);
                setStatusFilter(["ALL"]);
                setQ("");
                setHighlightId(null);
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      <Box position="relative">
        {loading && items.length > 0 && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Box position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)" zIndex="2">
            <Spinner size="lg" />
          </Box>
        </>)}
      <VStack align="stretch" gap={3}>
        {filtered.length === 0 && (
          <Box p="8" color="fg.muted">
            No properties match current filters.
          </Box>
        )}
        {filtered.map((p: Property, idx: number) => {
          const clientName = p.client?.displayName ? clientLabel(p.client.displayName) : "No Client";
          const prevClient = idx > 0 ? (filtered[idx - 1].client?.displayName ? clientLabel(filtered[idx - 1].client!.displayName) : "No Client") : null;
          const showHeader = clientName !== prevClient;

          const address = [
            p.street1,
            p.street2,
            p.city,
            p.state,
            p.postalCode,
            p.country,
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <Box key={p.id}>
              {showHeader && (
                <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mt={idx > 0 ? 4 : 0} mb={1}>
                  {clientName}
                </Text>
              )}
            <Card.Root variant="outline" borderColor={p.status === "ARCHIVED" ? "gray.emphasized" : (p.client as any)?.isVip ? "yellow.emphasized" : undefined} bg={p.status === "ARCHIVED" ? "gray.faint" : undefined}>
              <Card.Header py="2" px="3" pb="0">
                <VStack align="start" gap={1.5}>
                  <HStack gap={1} minW={0}>
                    {(p.client as any)?.isVip && <Text title={(p.client as any)?.vipReason || "VIP Client"} cursor="help">⭐</Text>}
                    <Text fontSize="md" fontWeight="semibold">{p.displayName}</Text>
                  </HStack>
                  <HStack gap={1} wrap="wrap">
                    <StatusBadge
                      status={p.status}
                      palette={propertyStatusColor(p.status)}
                      variant="subtle"
                    />
                    <StatusBadge
                      status={p.kind}
                      palette="gray"
                      variant="outline"
                    />
                    {(p as any).lotSize != null && (
                      <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                        {(p as any).lotSize.toLocaleString()} {(p as any).lotSizeUnit ?? "sqft"}
                      </Badge>
                    )}
                  </HStack>
                </VStack>
              </Card.Header>

              <Card.Body py="2" px="3" pt="1">
                <VStack align="start" gap={1.5}>
                  <HStack fontSize="sm" gap={2} align="center" wrap="wrap">
                    <MapLink address={address} />
                    {/* THE TERRITORY, beside the address it qualifies —
                        the same badge the job cards carry, so the two read
                        as the same fact. Visible on the card, not only
                        inside the editor: "which portfolio is this in" is a
                        question you ask while scanning a list, and having
                        to open each property to answer it is how a
                        mis-tagged one goes unnoticed.
                        OUTSIDE the MapLink: that opens a map of the
                        address, and a portfolio name is not part of one.
                        Absent when the property has no portfolio — and that
                        absence is INFORMATION, because an untagged
                        property is invisible to every portfolio-scoped reader. */}
                    <PortfolioBadges of={p} />
                  </HStack>
                  <HStack gap={4} fontSize="xs" wrap="wrap">
                    <Text>
                      Client:{" "}
                      <TextLink
                        text={clientLabel(p.client?.displayName) || p.clientId || ""}
                        onClick={() =>
                          openEventSearch(
                            "propertyTabToClientTabSearch",
                            p.client?.displayName,
                            
                            p.clientId,
                          )
                        }
                      />
                    </Text>
                    <Text>
                      Contact:{" "}
                      {p.pointOfContactId ? (
                        <TextLink
                          text={`${p.pointOfContact.firstName} ${p.pointOfContact.lastName}`}
                          onClick={() =>
                            openEventSearch(
                              "propertyTabToClientTabContactSearch",
                              `${p.pointOfContact.firstName} ${p.pointOfContact.lastName}`,
                              
                              p.clientId,
                            )
                          }
                        />
                      ) : (
                        <Text as="span" color="fg.muted">None</Text>
                      )}
                    </Text>
                  </HStack>
                  {(p as any).accessNotes && (
                    <Box p={2} bg="orange.faint" rounded="sm" w="full">
                      <Text fontSize="xs" fontWeight="medium" color="orange.fg">Access Notes</Text>
                      <Text fontSize="xs" color="orange.fg">{(p as any).accessNotes}</Text>
                    </Box>
                  )}
                </VStack>
              </Card.Body>
              <Card.Body py="2" px="3" pt="0">
                <PropertyPhotosManager propertyId={p.id} readOnly={!canManageClients} />
              </Card.Body>
              {canManageClients && (
                <Card.Footer py="2" px="3" pt="0">
                  <HStack gap={2} wrap="wrap">
                    <StatusButton
                      id={"properties-edit"}
                      itemId={p.id}
                      label={"Edit"}
                      onClick={async () => {
                        await openEdit(p);
                      }}
                      variant={"outline"}
                      disabled={loading}
                      busyId={statusButtonBusyId}
                      setBusyId={setStatusButtonBusyId}
                    />
                    {p.status === "ACTIVE" ? (
                      <StatusButton
                        id={"properties-archive"}
                        itemId={p.id}
                        label={"Archive"}
                        onClick={async () => {
                          await openArchivePropertyConfirm(p);
                        }}
                        variant={"outline"}
                        disabled={loading}
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    ) : (
                      <StatusButton
                        id={"properties-unarchive"}
                        itemId={p.id}
                        label={"Unarchive"}
                        onClick={async () => {
                          await openUnarchivePropertyConfirm(p);
                        }}
                        variant={"outline"}
                        disabled={loading}
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {p.status === "ARCHIVED" && (
                      <StatusButton
                        id={"properties-delete"}
                        itemId={p.id}
                        label={"Delete"}
                        onClick={async () => {
                          let hasJobs = false;
                          try {
                            const jobs = await apiGet<any[]>(
                              `/api/jobs?propertyId=${p.id}&limit=500`
                            );
                            hasJobs = Array.isArray(jobs) && jobs.length > 0;
                          } catch { /* proceed; server will guard */ }

                          const cannotDelete = !canManageClients;

                          void setToDelete({
                            id: p.id,
                            title: "Delete property?",
                            summary: p.displayName,
                            disabled: hasJobs || cannotDelete,
                            details: hasJobs ? (
                              <Text color="red.fg">
                                This property has associated jobs. Delete all jobs before deleting the property.
                              </Text>
                            ) : cannotDelete ? (
                              <Text color="red.fg">
                                You must be someone with settings authority Admin to delete.
                              </Text>
                            ) : undefined,
                            extra: p.displayName,
                          });
                        }}
                        variant={"outline"}
                        disabled={loading}
                        colorPalette={"red"}
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                  </HStack>
                </Card.Footer>
              )}
            </Card.Root>
            </Box>
          );
        })}
      </VStack>
      </Box>

      {canManageClients && (
        <PropertyDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          mode={editing ? "UPDATE" : "CREATE"}
          scope={effScope}
          initial={editing ?? undefined}
          onSaved={() => void load()}
        />
      )}
      {canManageClients && (
        <DeleteDialog
          toDelete={toDelete}
          cancel={() => setToDelete(null)}
          complete={async () => {
            if (!toDelete) return;
            await hardDelete(toDelete.id, toDelete.extra ?? "");
            setToDelete(null);
          }}
        />
      )}
      {archivePropertyConfirm && (
        <ConfirmDialog
          open
          title="Archive this property?"
          message={
            (() => {
              const { property, jobsToArchive } = archivePropertyConfirm;
              const cascade = jobsToArchive > 0
                ? ` This will also archive ${jobsToArchive} job${jobsToArchive === 1 ? "" : "s"}.`
                : "";
              return `Archive ${property.displayName}?${cascade} Historical data stays accessible.`;
            })()
          }
          confirmLabel="Archive"
          confirmColorPalette="red"
          onConfirm={async () => {
            const p = archivePropertyConfirm.property;
            setArchivePropertyConfirm(null);
            await archive(p);
          }}
          onCancel={() => setArchivePropertyConfirm(null)}
        />
      )}
      {unarchivePropertyConfirm && (
        <ConfirmDialog
          open
          title="Unarchive this property?"
          message={
            (() => {
              const { property, jobsToUnarchive } = unarchivePropertyConfirm;
              const cascade = jobsToUnarchive > 0
                ? ` This will also unarchive ${jobsToUnarchive} job${jobsToUnarchive === 1 ? "" : "s"} (returned to Accepted).`
                : "";
              return `Restore ${property.displayName} to active?${cascade}`;
            })()
          }
          confirmLabel="Unarchive"
          confirmColorPalette="green"
          onConfirm={async () => {
            const p = unarchivePropertyConfirm.property;
            setUnarchivePropertyConfirm(null);
            await unarchive(p);
          }}
          onCancel={() => setUnarchivePropertyConfirm(null)}
        />
      )}
    </Box>
  );
}
