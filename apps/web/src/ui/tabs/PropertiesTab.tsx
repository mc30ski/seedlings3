"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import {
  Box,
  Button,
  Card,
  HStack,
  Spacer,
  Text,
  VStack,
  Select,
  createListCollection,
} from "@chakra-ui/react";
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
import { MapLink } from "@/src/ui/helpers/Link";

// Constant representing the kind states for this entity.
const kindStates = ["ALL", ...PROPERTY_KIND] as const;

// Constant representing the status states for this entity.
const statusStates = ["ALL", ...PROPERTY_STATUS] as const;

export default function PropertiesTab({
  me,
  purpose = "WORKER",
}: TabPropsType) {
  const { isSuper, isAvail, forAdmin } = determineRoles(me, purpose);

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");
  const [kind, setKind] = useState<string[]>(["ALL"]);

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
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
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
          .filter((i) => forAdmin || i.status === "ACTIVE")
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

  // Used to pre-populate the search with information
  useEffect(() => {
    const onRun = (ev: Event) => {
      const { q } = (ev as CustomEvent<{ q?: string }>).detail || {};
      if (typeof q === "string") {
        setQ(q);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    };
    window.addEventListener("clientPropertySearch:run", onRun as EventListener);
    return () =>
      window.removeEventListener(
        "clientPropertySearch:run",
        onRun as EventListener
      );
  }, []);

  // Filtered items based on search, kind or status.
  const filtered = useMemo(() => {
    let rows = items;

    // Filter based on entity type.
    if (kind[0] !== "ALL") {
      rows = rows.filter((i) => i.kind === kind[0]);
    }

    // Filter based on entity status.
    if (status !== "ALL") {
      rows = rows.filter((i) => i.status === status);
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

    return rows;
  }, [items, q, kind, status]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function openEdit(p: Property) {
    setEditing(p);
    setDialogOpen(true);
  }

  async function approve(p: Property) {
    try {
      await apiPost(`/api/admin/properties/${p.id}/approve`, {});
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Property '${p.displayName}' approved and made active.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          `Property '${p.displayName}' approved failed.`,
          err
        ),
      });
    }
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
          err
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
          err
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
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(`Property '${displayName}' delete failed.`, err),
      });
    }
  }

  if (!isAvail) return <UnavailableNotice />;
  if (loading) return <LoadingCenter />;

  return (
    <Box w="full">
      <HStack mb={3} gap={3}>
        <SearchWithClear
          ref={inputRef}
          value={q}
          onChange={setQ}
          inputId="properties-search"
          placeholder="Search…"
        />
        <Select.Root
          collection={kindCollection}
          value={kind}
          onValueChange={(e) => setKind(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
        >
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="Kind" />
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
        <Spacer />
        {forAdmin && <Button onClick={openCreate}>New</Button>}
      </HStack>
      <HStack mb={3} gap={2} wrap="wrap">
        {statusStates
          .map((s) => ({
            label: prettyStatus(s),
            val: s,
          }))
          .map(({ label, val }) => (
            <Button
              key={val}
              size="sm"
              variant={status === val ? "solid" : "outline"}
              onClick={() => {
                setStatus(val);
              }}
            >
              {label}
            </Button>
          ))}
      </HStack>
      <VStack align="stretch" gap={3}>
        {!loading && filtered.length === 0 && (
          <Box p="8" color="fg.muted">
            No properties match current filters.
          </Box>
        )}
        {filtered.map((p: Property) => {
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
            <Card.Root key={p.id} variant="outline">
              <Card.Header pb="2">
                <HStack gap={3} justify="space-between" align="center">
                  <HStack gap={3} flex="1" minW={0}>
                    <Text fontWeight="semibold">{p.displayName}</Text>
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
                  <MapLink address={address} />
                  <Text fontSize="sm">
                    Client: <b>{p.client?.displayName ?? p.clientId}</b>
                  </Text>
                  <Text fontSize="sm">
                    Default contact:{" "}
                    <b>
                      {p.pointOfContactId
                        ? `${p.pointOfContact.firstName} ${p.pointOfContact.lastName}`
                        : "None"}
                    </b>
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
                    {p.status === "PENDING" && (
                      <StatusButton
                        id={"properties-pending"}
                        itemId={p.id}
                        label={"Approve"}
                        onClick={async () => {
                          await approve(p);
                        }}
                        variant={"outline"}
                        disabled={loading}
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {p.status === "ACTIVE" || p.status === "PENDING" ? (
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
                          void setToDelete({
                            id: p.id,
                            title: "Delete property?",
                            summary: p.displayName,
                            disabled: !isSuper,
                            details: (
                              <Text color="red.500">
                                You must be a Super Admin to delete.
                              </Text>
                            ),
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
          );
        })}
      </VStack>

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
