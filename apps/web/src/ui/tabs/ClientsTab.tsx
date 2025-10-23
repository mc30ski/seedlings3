"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Heading,
  HStack,
  Input,
  Separator,
  Stack,
  Text,
  VStack,
  Spacer,
} from "@chakra-ui/react";

import InlineMessage, {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";

import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import type { TabRolePropType } from "@/src/lib/types";

import ClientDialog, { type Client } from "@/src/ui/components/ClientDialog";
import ContactDialog, { type Contact } from "@/src/ui/components/ContactDialog";

export default function ClientsTab({ role = "worker" }: TabRolePropType) {
  const isAdmin = role === "admin";

  const [loading, setLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);

  const [items, setItems] = useState<Client[]>([]);
  const [q, setQ] = useState("");

  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [contactMode, setContactMode] = useState<"create" | "update">("create");
  const [contactClientId, setContactClientId] = useState<string>("");
  const [editingContact, setEditingContact] = useState<Contact | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<Client[] | { items: Client[] }>(
        q.trim()
          ? `/api/clients?q=${encodeURIComponent(q.trim())}`
          : "/api/clients"
      );
      const list: Client[] = Array.isArray(data) ? data : (data?.items ?? []);
      setItems(list);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load clients", err),
      });
    } finally {
      setLoading(false);
    }
  }, [q]);

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
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter((c) => {
      const name = (c.displayName ?? "").toLowerCase();
      const notes = (c.notesInternal ?? "").toLowerCase();
      const anyContact = (c.contacts ?? []).some((ct) =>
        //TODO:
        //[ct.name, ct.preferredName, ct.email, ct.phone, ct.role]
        [ct.firstName, ct.email, ct.phone, ct.role]
          .filter(Boolean)
          .some((v) => (v as string).toLowerCase().includes(t))
      );
      return name.includes(t) || notes.includes(t) || anyContact;
    });
  }, [items, q]);

  async function deleteClient(id: string) {
    try {
      await apiDelete(`/api/admin/clients/${id}`);
      publishInlineMessage({
        type: "SUCCESS",
        text: "Client deleted.",
      });
      await load();
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
      role: ct.role ?? null, // must match your enum on the API
      isPrimary: !!ct.isPrimary,
      active: ct.active ?? true,
    };
    setContactClientId(clientId);
    setEditingContact(uiContact);
    setContactMode("update");
    setContactDialogOpen(true);
  }

  async function upsertContact(
    clientId: string,
    contact: Partial<Contact> & { id?: string }
  ) {
    try {
      if (contact.id) {
        await apiPatch(
          `/api/admin/clients/${clientId}/contacts/${contact.id}`,
          contact
        );
        publishInlineMessage({
          type: "SUCCESS",
          text: "Contact updated.",
        });
      } else {
        await apiPost(`/api/admin/clients/${clientId}/contacts`, contact);
        publishInlineMessage({
          type: "SUCCESS",
          text: "Contact created.",
        });
      }
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Save contact failed", err),
      });
    }
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

  if (role !== "admin" && role !== "worker") {
    return <UnavailableNotice />;
  }

  return (
    <Box w="full">
      <InlineMessage />

      <HStack mb={3}>
        <Input
          placeholder="Search clients or contacts…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          id="clients-search"
          maxW="420px"
        />
        <Spacer />
        {isAdmin && <Button onClick={openCreate}>New Client</Button>}
      </HStack>

      {loading && <LoadingCenter />}

      {!loading && filtered.length === 0 && (
        <Text color="fg.muted">No clients match the current filters.</Text>
      )}

      {!loading &&
        filtered.map((c) => (
          <Box key={c.id} borderWidth="1px" borderRadius="lg" p={3} mb={3}>
            <HStack align="start" gap="2">
              <VStack alignItems="start" gap={1} flex="1">
                <Heading size="sm">{c.displayName}</Heading>
                <HStack gap="2" wrap="wrap">
                  <Text fontSize="sm" color="fg.muted">
                    {c.type}
                  </Text>
                  {c.archivedAt && (
                    <Text fontSize="sm" color="fg.muted">
                      · archived
                    </Text>
                  )}
                </HStack>
                {isAdmin && c.notesInternal && (
                  <Text mt={1} fontSize="sm" color="fg.muted">
                    {c.notesInternal}
                  </Text>
                )}
              </VStack>

              {isAdmin && (
                <HStack gap="2">
                  <Button variant="outline" onClick={() => openEdit(c)}>
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    colorPalette="red"
                    onClick={() => void deleteClient(c.id)}
                  >
                    Delete
                  </Button>
                </HStack>
              )}
            </HStack>

            {isAdmin && (
              <Button
                mt={2}
                size="sm"
                variant="subtle"
                onClick={() => openAddContact(c.id)}
              >
                Add contact
              </Button>
            )}

            {/* Contacts */}
            {(c.contacts ?? []).length > 0 && <Separator my={3} />}

            <Stack gap="2" mt={2}>
              {(c.contacts ?? []).map((ct) => (
                <HStack
                  key={ct.id}
                  justify="space-between"
                  align="start"
                  borderWidth="1px"
                  borderRadius="md"
                  p={2}
                >
                  <Box>
                    <Text fontWeight="medium">
                      {/* TODO: ct.preferredName || */}
                      {ct.firstName || ct.email || ct.phone || "Unnamed"}
                    </Text>
                    <Text fontSize="sm" color="fg.muted">
                      {[ct.role, ct.email, ct.phone]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </Box>

                  {isAdmin && (
                    <HStack gap="2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEditContact(c.id, ct)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        colorPalette="red"
                        onClick={() => deleteContact(c.id, ct.id)}
                      >
                        Delete
                      </Button>
                    </HStack>
                  )}
                </HStack>
              ))}
            </Stack>

            {isAdmin && (
              <ClientDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                mode={editing ? "update" : "create"}
                initialClient={editing ?? undefined}
                scope="clients"
                onSaved={() => load()}
                actionLabel={editing ? "Save" : "Create"}
              />
            )}

            {isAdmin && (
              <ContactDialog
                open={contactDialogOpen}
                onOpenChange={setContactDialogOpen}
                mode={contactMode}
                clientId={contactClientId}
                initialContact={editingContact ?? undefined}
                scope="clients"
                onSaved={() => load()}
                actionLabel={contactMode === "create" ? "Create" : "Save"}
              />
            )}
          </Box>
        ))}
    </Box>
  );
}
