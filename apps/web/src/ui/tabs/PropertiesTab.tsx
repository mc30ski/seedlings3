"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card, // ← namespace
  HStack,
  Input,
  Spacer,
  Text,
  VStack,
  Badge,
  Select, // ← namespace (for Select.Root, etc.)
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiGet, apiDelete, apiPost } from "@/src/lib/api";
import InlineMessage, {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import PropertyDialog, {
  type PropertyShape,
} from "@/src/ui/dialogs/PropertyDialog";
import PropertyPOCPicker from "@/src/ui/components/PropertyPOCPicker";

type RoleMode = "worker" | "admin";
type PropertyStatus = "PENDING" | "ACTIVE" | "ARCHIVED";
type PropertyKind = "SINGLE" | "AGGREGATE_SITE";

type Props = { role?: RoleMode };
type ClientLite = { id: string; displayName: string };

export default function PropertiesTab({ role = "worker" }: Props) {
  const isAdmin = role === "admin";

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string[]>(["ALL"]);
  const [kind, setKind] = useState<string[]>(["ALL"]);
  const [clientFilter, setClientFilter] = useState<string[]>(["ALL"]);
  const [clients, setClients] = useState<ClientLite[]>([]);

  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PropertyShape | null>(null);

  // collections
  const statusItems = useMemo(
    () =>
      ["ALL", "PENDING", "ACTIVE", "ARCHIVED"].map((s) => ({
        label: s,
        value: s,
      })),
    []
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );

  const kindItems = useMemo(
    () =>
      ["ALL", "SINGLE", "AGGREGATE_SITE"].map((s) => ({ label: s, value: s })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );

  const clientItems = useMemo(
    () =>
      [{ label: "ALL", value: "ALL" }].concat(
        clients.map((c) => ({ label: c.displayName || c.id, value: c.id }))
      ),
    [clients]
  );
  const clientCollection = useMemo(
    () => createListCollection({ items: clientItems }),
    [clientItems]
  );

  async function load() {
    setLoading(true);
    try {
      const base = isAdmin ? "/api/admin/properties" : "/api/properties";
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (status[0] && status[0] !== "ALL") params.set("status", status[0]);
      if (kind[0] && kind[0] !== "ALL") params.set("kind", kind[0]);
      if (clientFilter[0] && clientFilter[0] !== "ALL")
        params.set("clientId", clientFilter[0]);

      const res: unknown = await apiGet(
        `${base}${params.toString() ? `?${params}` : ""}`
      );

      // Accept either a raw array or a paginated envelope
      const list: any[] = Array.isArray(res)
        ? res
        : Array.isArray((res as any)?.items)
          ? (res as any).items
          : [];

      setItems(list);
    } catch (err) {
      publishInlineMessage({
        scope: "properties",
        type: "ERROR",
        text: getErrorMessage("Failed to load properties", err),
      });
      setItems([]); // ensure array on error
    } finally {
      setLoading(false);
    }
  }

  // Load clients list for the filter + dialog
  useEffect(() => {
    const loadClients = async () => {
      try {
        const path = isAdmin
          ? "/api/admin/clients?limit=500"
          : "/api/clients?limit=500";

        const res: unknown = await apiGet(path);

        // normalize to an array (supports either raw array or { items: [...] })
        const list: any[] = Array.isArray(res)
          ? res
          : Array.isArray((res as any)?.items)
            ? (res as any).items
            : [];

        setClients(
          list.map((c: any) => ({
            id: c.id,
            displayName: c.displayName ?? "",
          }))
        );
      } catch {
        setClients([]);
      }
    };
    void loadClients();
  }, [isAdmin]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status, kind, clientFilter, isAdmin]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(p: any) {
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

  async function archive(p: any) {
    try {
      await apiPost(`/api/admin/properties/${p.id}/archive`, {});
      publishInlineMessage({
        scope: "properties",
        type: "SUCCESS",
        text: "Property archived.",
        autoHideMs: 2000,
      });
      void load();
    } catch (err) {
      publishInlineMessage({
        scope: "properties",
        type: "ERROR",
        text: getErrorMessage("Archive failed", err),
      });
    }
  }
  async function unarchive(p: any) {
    try {
      await apiPost(`/api/admin/properties/${p.id}/unarchive`, {});
      publishInlineMessage({
        scope: "properties",
        type: "SUCCESS",
        text: "Property unarchived.",
        autoHideMs: 2000,
      });
      void load();
    } catch (err) {
      publishInlineMessage({
        scope: "properties",
        type: "ERROR",
        text: getErrorMessage("Unarchive failed", err),
      });
    }
  }
  async function remove(p: any) {
    try {
      await apiDelete(`/api/admin/properties/${p.id}`);
      publishInlineMessage({
        scope: "properties",
        type: "SUCCESS",
        text: "Property deleted.",
        autoHideMs: 2000,
      });
      void load();
    } catch (err) {
      publishInlineMessage({
        scope: "properties",
        type: "ERROR",
        text: getErrorMessage("Delete failed", err),
      });
    }
  }

  return (
    <Box w="full">
      <InlineMessage scope="properties" />

      {/* Toolbar */}
      <HStack mb={3} gap={3}>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search properties (name, address, city…) "
        />
        <Select.Root
          collection={statusCollection}
          value={status}
          onValueChange={(e) => setStatus(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
        >
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="Status" />
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

        <Select.Root
          collection={clientCollection}
          value={clientFilter}
          onValueChange={(e) => setClientFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
        >
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder="Client" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {clientItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>

        <Spacer />
        {isAdmin && <Button onClick={openCreate}>New Property</Button>}
      </HStack>

      {/* List */}
      <VStack align="stretch" gap={3}>
        {!loading && items.length === 0 && (
          <Box p="8" textAlign="center" color="fg.muted">
            No properties found.
          </Box>
        )}

        {items.map((p: any) => (
          <Card.Root key={p.id} variant="subtle">
            <Card.Header pb="2">
              <HStack gap={3}>
                <Text fontWeight="semibold">{p.displayName}</Text>
                <Badge>{p.status}</Badge>
                <Badge variant="outline">{p.kind}</Badge>
                <Spacer />
                {isAdmin && (
                  <HStack gap={2}>
                    {p.status !== "ARCHIVED" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(p)}
                      >
                        Edit
                      </Button>
                    ) : null}
                    {p.status === "ACTIVE" || p.status === "PENDING" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => archive(p)}
                      >
                        Archive
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => unarchive(p)}
                      >
                        Unarchive
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="red"
                      onClick={() => remove(p)}
                    >
                      Delete
                    </Button>
                  </HStack>
                )}
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

                {isAdmin && (
                  <PropertyPOCPicker
                    propertyId={p.id}
                    clientId={p.clientId}
                    currentContactId={p.pointOfContactId ?? null}
                    onChanged={() => void load()}
                  />
                )}
              </VStack>
            </Card.Body>
          </Card.Root>
        ))}
      </VStack>

      {/* Create/Update dialog */}
      {isAdmin && (
        <PropertyDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          mode={editing ? "update" : "create"}
          role={isAdmin ? "admin" : "worker"}
          initialProperty={editing ?? undefined}
          scope="properties"
          onSaved={() => void load()}
        />
      )}
    </Box>
  );
}
