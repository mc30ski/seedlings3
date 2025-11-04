"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  HStack,
  Spacer,
  Text,
  VStack,
  Select,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { Me, Role, hasRole } from "@/src/lib/types";
import { apiGet, apiDelete, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import PropertyDialog, {
  type PropertyShape,
} from "@/src/ui/dialogs/PropertyDialog";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { propertyStatusColor, prettyStatus } from "@/src/lib/lib";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import DeleteDialog, {
  type ToDeleteProps,
} from "@/src/ui/dialogs/DeleteDialog";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import StatusButton from "@/src/ui/components/StatusButton";

// Constant representing the kind states for this entity.
const kindStates = ["ALL", "SINGLE", "AGGREGATE_SITE"] as const;

// Constant representing the status states for this entity.
const statusStates = [
  ["ALL", "All"],
  ["PENDING", "Pending"],
  ["ACTIVE", "Active"],
  ["ARCHIVED", "Archived"],
] as const;

type TabPropsType = {
  me: Me | null;
  purpose: Role;
};

export default function PropertiesTab({
  me,
  purpose = "WORKER",
}: TabPropsType) {
  const isWorker = hasRole(me?.roles, "WORKER");
  const isAdmin = hasRole(me?.roles, "ADMIN");
  const isSuper = hasRole(me?.roles, "SUPER");
  const isAvail = isAdmin || isWorker;
  const forAdmin = purpose === "ADMIN" && isAdmin;

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");
  const [kind, setKind] = useState<string[]>(["ALL"]);

  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PropertyShape | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);

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
      const list: any[] = await apiGet(base);
      setItems(
        list
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .filter((i) => forAdmin || i.status === "ACTIVE")
      );
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load properties", err),
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
        const arr = [r.displayName || ""];
        return arr.map((i) => i.toLowerCase()).some((i) => i.includes(qlc));
      });
    }

    return rows;
  }, [items, q, kind, status]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function openEdit(p: any) {
    const shape: PropertyShape = {
      id: p.id,
      clientId: p.clientId,
      displayName: p.displayName,
      status: p.status,
      kind: p.kind,
      street1: p.street1,
      street2: p.street2 ?? null,
      city: p.city,
      state: p.state,
      postalCode: p.postalCode,
      country: p.country,
      accessNotes: p.accessNotes ?? "",
      pointOfContactId: p.pointOfContactId ?? null,
    };
    setEditing(shape);
    setDialogOpen(true);
  }

  async function approve(p: any) {
    try {
      await apiPost(`/api/admin/properties/${p.id}/approve`, {});
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: "Property approved and made active.",
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Approved failed", err),
      });
    }
  }
  async function archive(p: any) {
    try {
      await apiPost(`/api/admin/properties/${p.id}/archive`, {});
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: "Property archived.",
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Archive failed", err),
      });
    }
  }
  async function unarchive(p: any) {
    try {
      await apiPost(`/api/admin/properties/${p.id}/unarchive`, {});
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: "Property unarchived.",
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Unarchive failed", err),
      });
    }
  }
  async function hardDelete(id: string) {
    try {
      setLoading(true);
      await apiDelete(`/api/admin/properties/${id}`);
      await load(true);
      publishInlineMessage({
        type: "SUCCESS",
        text: "Property deleted.",
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Delete failed", err),
      });
    }
  }

  if (!isAvail) return <UnavailableNotice />;
  if (loading) return <LoadingCenter />;

  return (
    <Box w="full">
      <HStack mb={3} gap={3}>
        <SearchWithClear
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
        {statusStates.map(([val, label]) => (
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
        {filtered.map((p: any) => (
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
                <StatusBadge status={p.kind} palette="gray" variant="outline" />
              </HStack>
            </Card.Header>
            <Card.Body pt="0">
              <VStack align="start" gap={1}>
                <Text fontSize="sm" color="fg.muted">
                  {p.street1}
                  {p.street2 ? `, ${p.street2}` : ""}, {p.city}, {p.state}{" "}
                  {p.postalCode}, {p.country}
                </Text>
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
        ))}
      </VStack>

      {forAdmin && (
        <PropertyDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          mode={editing ? "update" : "create"}
          role={forAdmin ? "admin" : "worker"}
          initialProperty={editing ?? undefined}
          onSaved={() => void load()}
        />
      )}
      {forAdmin && (
        <DeleteDialog
          toDelete={toDelete}
          cancel={() => setToDelete(null)}
          complete={async () => {
            if (!toDelete) return;
            await hardDelete(toDelete.id);
            setToDelete(null);
          }}
        />
      )}
    </Box>
  );
}
