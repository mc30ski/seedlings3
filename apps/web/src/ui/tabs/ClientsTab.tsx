"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Heading,
  HStack,
  Separator,
  Stack,
  Text,
  VStack,
  Icon,
} from "@chakra-ui/react";
import { FiStar } from "react-icons/fi";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { prettyStatus, clientStatusColor } from "@/src/lib/lib";
import type { Me, TabRolePropType } from "@/src/lib/types";
import ClientDialog, { type Client } from "@/src/ui/dialogs/ClientDialog";
import ContactDialog, { type Contact } from "@/src/ui/dialogs/ContactDialog";
import DeleteDialog, {
  type ToDeleteProps,
} from "@/src/ui/dialogs/DeleteDialog";
import SearchWithClear from "@/src/ui/components/SearchWithClear";

// Filter type for this page
type FilterType =
  | "all"
  | "individual"
  | "household"
  | "organization"
  | "community";

function mailLink(to: string, subject: string, body: string) {
  return (
    <a
      href={`mailto:${to}?subject=${subject}&body=${body}`}
      style={{
        textDecoration: "underline",
        color: "#2563eb",
        cursor: "pointer",
        outline: "none",
      }}
    >
      {to}
    </a>
  );
}

function callLink(to: string) {
  return (
    <a
      href={`tel:${to}`}
      style={{
        textDecoration: "underline",
        color: "#2563eb",
        cursor: "pointer",
        outline: "none",
      }}
      aria-label={`Call ${to}`}
    >
      {to}
    </a>
  );
}

export default function ClientsTab({ role = "worker" }: TabRolePropType) {
  const isAdmin = role === "admin";
  const [tabRole, _setTabRole] = useState(role);
  const [loading, setLoading] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [contactMode, setContactMode] = useState<"create" | "update">("create");
  const [contactClientId, setContactClientId] = useState<string>("");
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [items, setItems] = useState<Client[]>([]);
  const [filter, setFilter] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("all");

  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);
  const [toDeleteContact, setToDeleteContact] = useState<ToDeleteProps | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, meResp] = await Promise.all([
        await (isAdmin
          ? apiGet<Client[]>("/api/admin/clients")
          : apiGet<Client[]>("/api/clients")),
        apiGet<Me>("/api/me"),
      ]);

      setItems(data);
      setMe(meResp);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load clients", err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(c: any) {
    const uiClient: Client = {
      id: c.id,
      status: c.status ?? "ACTIVE",
      displayName: c.displayName ?? "",
      type: c.type ?? "INDIVIDUAL",
      notesInternal: c.notesInternal ?? "",
    };
    setEditing(uiClient);
    setDialogOpen(true);
  }

  const filtered = useMemo(() => {
    const t1 = filter.trim().toLowerCase();
    const t2 = filterType.trim().toUpperCase();
    if (!t1 && !t2) return items;
    let filteredItems = [...items];
    if (t2) {
      filteredItems = filteredItems.filter((c) => {
        return t2 === "ALL" || c.type === t2;
      });
    }
    if (t1) {
      filteredItems = filteredItems.filter((c) => {
        const name = (c.displayName ?? "").toLowerCase();
        const notes = (c.notesInternal ?? "").toLowerCase();
        const anyContact = (c.contacts ?? []).some((ct) =>
          //TODO:
          //[ct.name, ct.preferredName, ct.email, ct.phone, ct.role]
          [ct.firstName, ct.email, ct.phone, ct.role]
            .filter(Boolean)
            .some((v) => (v as string).toLowerCase().includes(t1))
        );
        return (
          name.includes(t1) || (notes.includes(t1) && isAdmin) || anyContact
        );
      });
    }
    return filteredItems;
  }, [items, filter, filterType]);

  async function deleteClient(id: string) {
    try {
      await apiDelete(`/api/admin/clients/${id}`);
      await load();
      publishInlineMessage({
        type: "SUCCESS",
        text: "Client deleted.",
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Delete client failed", err),
      });
    }
  }

  function openAddContact(clientId: string) {
    setContactClientId(clientId);
    setEditingContact(null);
    setContactMode("create");
    setContactDialogOpen(true);
  }

  function openEditContact(clientId: string, ct: any) {
    const uiContact: Contact = {
      id: ct.id,
      clientId,
      firstName: ct.firstName ?? "",
      lastName: ct.lastName ?? "",
      email: ct.email ?? "",
      phone: ct.phone ?? "",
      role: ct.role ?? null,
      isPrimary: !!ct.isPrimary,
      active: ct.active ?? true,
    };
    setContactClientId(clientId);
    setEditingContact(uiContact);
    setContactMode("update");
    setContactDialogOpen(true);
  }

  async function deleteContact(clientId: string, contactId: string) {
    try {
      await apiDelete(`/api/admin/clients/${clientId}/contacts/${contactId}`);
      publishInlineMessage({
        type: "SUCCESS",
        text: "Contact deleted.",
      });
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Delete contact failed", err),
      });
    }
  }

  function tabTitle(role: string, status: string) {
    return "All Clients";
  }

  if (role !== "admin" && role !== "worker") {
    return <UnavailableNotice />;
  }

  return (
    <Box w="full">
      {loading && <LoadingCenter />}
      <HStack mb={3}>
        <SearchWithClear
          value={filter}
          onChange={setFilter}
          inputId="clients-search"
          placeholder="Search…"
        />
        {isAdmin && <Button onClick={openCreate}>New</Button>}
      </HStack>
      <Stack mb={4}>
        <HStack gap={2} wrap="wrap">
          <Button
            size="sm"
            variant={filterType === "all" ? "solid" : "outline"}
            onClick={() => setFilterType("all")}
          >
            All
          </Button>
          <Button
            size="sm"
            variant={filterType === "individual" ? "solid" : "outline"}
            onClick={() => setFilterType("individual")}
          >
            Individual
          </Button>
          <Button
            size="sm"
            variant={filterType === "household" ? "solid" : "outline"}
            onClick={() => setFilterType("household")}
          >
            Household
          </Button>
          <Button
            size="sm"
            variant={filterType === "community" ? "solid" : "outline"}
            onClick={() => setFilterType("community")}
          >
            Community
          </Button>
          <Button
            size="sm"
            variant={filterType === "organization" ? "solid" : "outline"}
            onClick={() => setFilterType("organization")}
          >
            Organization
          </Button>
        </HStack>
      </Stack>
      {/* Separator */}
      <Box h="1px" bg="gray.200" mb={3} />
      <Heading size="md" mb={3}>
        {tabTitle(tabRole, "")}
      </Heading>
      {!loading && filtered.length === 0 && (
        <Text>No clients or contacts match the current filters.</Text>
      )}
      {filtered.map((item) => (
        <Box key={item.id} borderWidth="1px" borderRadius="lg" p={3} mb={3}>
          <HStack align="start" gap="2">
            <VStack alignItems="start" gap={1} flex="1">
              <Heading size="sm">{item.displayName}</Heading>
              <HStack gap="2" wrap="wrap">
                <Badge colorPalette={clientStatusColor(item.type)}>
                  {prettyStatus(item.type)}
                </Badge>
              </HStack>
              {isAdmin && item.notesInternal && (
                <Text mt={1} fontSize="sm" color="fg.muted">
                  {item.notesInternal}
                </Text>
              )}
            </VStack>
            {isAdmin && (
              <HStack gap="2">
                <Button variant="outline" onClick={() => openEdit(item)}>
                  Edit
                </Button>
                <Button
                  variant="outline"
                  colorPalette="red"
                  onClick={() =>
                    void setToDelete({
                      id: item.id,
                      title: "Delete client and contacts?",
                      summary: item.displayName,
                      disabled: me?.roles?.includes("SUPER") ? false : true,
                      details: (
                        <Text color="red.500">
                          You must be a Super Admin to delete.
                        </Text>
                      ),
                    })
                  }
                >
                  Delete
                </Button>
              </HStack>
            )}
          </HStack>
          {isAdmin && (
            <HStack gap={2}>
              <Button
                mt={2}
                size="sm"
                variant="subtle"
                onClick={() => openAddContact(item.id)}
              >
                Add contact
              </Button>
            </HStack>
          )}
          <Separator my={3} />
          <Stack gap="2" mt={2}>
            {(item.contacts ?? []).length === 0 && (
              <Text fontSize="sm" color="fg.muted">
                No contacts added.
              </Text>
            )}
            {(item.contacts ?? [])
              .toSorted(
                (a, b) =>
                  +(b.isPrimary ?? false) - +(a.isPrimary ?? false) ||
                  +(b.active ?? false) - +(a.active ?? false)
              )
              .filter((ct) => {
                return isAdmin || ct.active;
              })
              .map((ct) => (
                <HStack
                  key={ct.id}
                  opacity={ct.active ? 1.0 : 0.5}
                  justify="space-between"
                  align="start"
                  borderWidth="1px"
                  borderRadius="md"
                  bg="gray.100"
                  p={2}
                >
                  <Box>
                    {!ct.active && (
                      <Text fontSize="sm" color="fg.muted">
                        INACTIVE
                      </Text>
                    )}
                    {ct.isPrimary ? (
                      <HStack gap="2">
                        <Icon as={FiStar} boxSize="4" />
                        <Text fontWeight="medium">
                          {`${ct.firstName} ${ct.lastName}`}
                        </Text>
                      </HStack>
                    ) : (
                      <Text fontWeight="medium">
                        {`${ct.firstName} ${ct.lastName}`}
                      </Text>
                    )}
                    <Text fontSize="sm" color="fg.muted">
                      {ct.role}
                    </Text>
                    <Text fontSize="sm" color="fg.muted">
                      {mailLink(ct.email ?? "", "", "")}
                    </Text>
                    <Text fontSize="sm" color="fg.muted">
                      {callLink(ct.phone ?? "")}
                    </Text>
                  </Box>

                  {isAdmin && (
                    <HStack gap="2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEditContact(item.id, ct)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        colorPalette="red"
                        onClick={() =>
                          void setToDeleteContact({
                            id: item.id,
                            child: ct.id,
                            title: "Delete contact from client?",
                            summary: `${ct.firstName} ${ct.lastName}`,
                            disabled: me?.roles?.includes("SUPER")
                              ? false
                              : true,
                            details: (
                              <Text color="red.500">
                                You must be a Super Admin to delete.
                              </Text>
                            ),
                          })
                        }
                      >
                        Delete
                      </Button>
                    </HStack>
                  )}
                </HStack>
              ))}
          </Stack>
        </Box>
      ))}

      <ClientDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={editing ? "update" : "create"}
        initialClient={editing ?? undefined}
        onSaved={() => void load()}
        actionLabel={editing ? "Save" : "Create"}
      />

      <ContactDialog
        open={contactDialogOpen}
        onOpenChange={setContactDialogOpen}
        mode={contactMode}
        clientId={contactClientId}
        initialContact={editingContact ?? undefined}
        onSaved={() => void load()}
        actionLabel={contactMode === "create" ? "Create" : "Save"}
      />

      <DeleteDialog
        toDelete={toDelete}
        cancel={() => void setToDelete(null)}
        complete={async () => {
          await deleteClient(toDelete?.id ?? "");
          setToDelete(null);
        }}
      />

      <DeleteDialog
        toDelete={toDeleteContact}
        cancel={() => void setToDeleteContact(null)}
        complete={async () => {
          await deleteContact(
            toDeleteContact?.id ?? "",
            toDeleteContact?.child ?? ""
          );
          setToDeleteContact(null);
        }}
      />
    </Box>
  );
}
