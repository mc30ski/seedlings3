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
import { Filter, LayoutList, Plus, RefreshCw, X } from "lucide-react";
import { apiGet, apiDelete, apiPost } from "@/src/lib/api";
import {
  determineRoles,
  propertyStatusColor,
  prettyStatus,
} from "@/src/lib/lib";
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
import { TextLink, MapLink } from "@/src/ui/helpers/Link";

// Constant representing the kind states for this entity.
const kindStates = ["ALL", ...PROPERTY_KIND] as const;

// Constant representing the status states for this entity.
const statusStates = ["ALL", ...PROPERTY_STATUS] as const;

export default function PropertiesTab({
  me,
  purpose = "WORKER",
}: TabPropsType) {
  const { isSuper, isAvail, forAdmin } = determineRoles(me, purpose);
  const pfx = purpose === "ADMIN" ? "aprops" : "wprops";

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(`${pfx}_status`, ["ALL"]);
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);

  const [items, setItems] = useState<Property[]>([]);
  const [loading, setLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Property | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // Helper variable to disable other buttons while actions are in flight.
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  // Used to create the dropdown menus.
  const kindItems = useMemo(
    () => kindStates.map((s) => ({ label: prettyStatus(s), value: s })),
    [],
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems],
  );

  const statusItems = useMemo(
    () => statusStates.map((s) => ({ label: prettyStatus(s), value: s })),
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
      const base = forAdmin ? "/api/admin/properties" : "/api/properties";
      const list: Property[] = await apiGet(base);
      setItems(
        list
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .filter((i) => forAdmin || i.status === "ACTIVE"),
      );
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load properties.", err),
      });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  // Loads all the items for the first time.
  useEffect(() => {
    void load();
  }, [forAdmin]);

  useEffect(() => {
    onEventSearchRun("clientTabToPropertiesTabSearch", setQ, inputRef, setHighlightId);
    onEventSearchRun("jobsTabToPropertiesTabSearch", setQ, inputRef, setHighlightId);
    onEventSearchRun("paymentsTabToPropertiesTabSearch", setQ, inputRef, setHighlightId);
  }, []);

  // Filtered items based on search, kind or status.
  const filtered = useMemo(() => {
    // If navigated here by ID, show only that entity
    if (highlightId) {
      const exact = items.find((r) => r.id === highlightId);
      if (exact) return [exact];
    }

    let rows = items;

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
  }, [items, q, kind, statusFilter]);

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
      await apiPost(`/api/admin/properties/${p.id}/archive`, {});
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
      await apiPost(`/api/admin/properties/${p.id}/unarchive`, {});
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
  async function hardDelete(id: string, displayName: string) {
    try {
      setLoading(true);
      await apiDelete(`/api/admin/properties/${id}`);
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

  if (!isAvail) return <UnavailableNotice />;
  if (loading && items.length === 0) return <LoadingCenter />;

  return (
    <Box w="full">
      <HStack mb={2} gap={2}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-blue-100)", borderRadius: "6px" }}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-purple-100)", borderRadius: "6px" }}>
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
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          disabled={kind[0] === "ALL" && statusFilter[0] === "ALL"}
          onClick={() => {
            setKind(["ALL"]);
            setStatusFilter(["ALL"]);
          }}
        >
          <X size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          onClick={() => void load()}
          loading={loading}
        >
          <RefreshCw size={14} />
        </Button>
        {forAdmin && (
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
            <Badge size="sm" colorPalette="blue" variant="solid">
              {kindItems.find((i) => i.value === kind[0])?.label}
            </Badge>
          )}
          {statusFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="purple" variant="solid">
              {statusItems.find((i) => i.value === statusFilter[0])?.label}
            </Badge>
          )}
        </HStack>
      )}
      <Box position="relative">
        {loading && items.length > 0 && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
      <VStack align="stretch" gap={3}>
        {filtered.length === 0 && (
          <Box p="8" color="fg.muted">
            No properties match current filters.
          </Box>
        )}
        {filtered.map((p: Property, idx: number) => {
          const clientName = p.client?.displayName ?? "No Client";
          const prevClient = idx > 0 ? (filtered[idx - 1].client?.displayName ?? "No Client") : null;
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
            <Card.Root variant="outline">
              <Card.Header pb="2">
                <HStack gap={3} justify="space-between" align="center">
                  <HStack gap={3} flex="1" minW={0}>
                    <Text fontSize="md" fontWeight="semibold">{p.displayName}</Text>
                    <StatusBadge
                      status={p.status}
                      palette={propertyStatusColor(p.status)}
                      variant="subtle"
                    />
                  </HStack>
                  <StatusBadge
                    status={p.kind}
                    palette="gray"
                    variant="outline"
                  />
                </HStack>
              </Card.Header>

              <Card.Body pt="0">
                <VStack align="start" gap={1}>
                  <Box fontSize="sm">
                    <MapLink address={address} />
                  </Box>
                  <Text fontSize="xs">
                    Client:{" "}
                    <TextLink
                      text={p.client?.displayName ?? p.clientId}
                      onClick={() =>
                        openEventSearch(
                          "propertyTabToClientTabSearch",
                          p.client?.displayName,
                          forAdmin,
                          p.clientId,
                        )
                      }
                    />
                  </Text>
                  <Text fontSize="xs">
                    Default contact:{" "}
                    {p.pointOfContactId ? (
                      <TextLink
                        text={`${p.pointOfContact.firstName} ${p.pointOfContact.lastName}`}
                        onClick={() =>
                          openEventSearch(
                            "propertyTabToClientTabContactSearch",
                            `${p.pointOfContact.firstName} ${p.pointOfContact.lastName}`,
                            forAdmin,
                            p.clientId,
                          )
                        }
                      />
                    ) : (
                      "None"
                    )}
                  </Text>
                </VStack>
              </Card.Body>
              {forAdmin && (
                <Card.Footer>
                  <HStack gap={2} wrap="wrap" mb="2">
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
                          await archive(p);
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
                          await unarchive(p);
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
                              `/api/admin/jobs?propertyId=${p.id}&limit=500`
                            );
                            hasJobs = Array.isArray(jobs) && jobs.length > 0;
                          } catch { /* proceed; server will guard */ }

                          const superRequired = !isSuper;

                          void setToDelete({
                            id: p.id,
                            title: "Delete property?",
                            summary: p.displayName,
                            disabled: hasJobs || superRequired,
                            details: hasJobs ? (
                              <Text color="red.500">
                                This property has associated jobs. Delete all jobs before deleting the property.
                              </Text>
                            ) : superRequired ? (
                              <Text color="red.500">
                                You must be a Super Admin to delete.
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

      {forAdmin && (
        <PropertyDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          mode={editing ? "UPDATE" : "CREATE"}
          role={forAdmin ? "ADMIN" : "WORKER"}
          initial={editing ?? undefined}
          onSaved={() => void load()}
        />
      )}
      {forAdmin && (
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
    </Box>
  );
}
