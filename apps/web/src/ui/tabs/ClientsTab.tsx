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
  Icon,
  Accordion,
  createListCollection,
} from "@chakra-ui/react";
import { determineRoles, prettyStatus, clientStatusColor } from "@/src/lib/lib";
import {
  type TabPropsType,
  type Client,
  type Contact,
  CLIENT_KIND,
  CLIENT_STATUS,
} from "@/src/lib/types";
import { doAction, doDelete } from "@/src/lib/services";
import { openEventSearch, onEventSearchRun } from "@/src/lib/bus";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import ClientDialog from "@/src/ui/dialogs/ClientDialog";
import ContactDialog from "@/src/ui/dialogs/ContactDialog";
import DeleteDialog, {
  type ToDeleteProps,
} from "@/src/ui/dialogs/DeleteDialog";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import StatusButton from "@/src/ui/components/StatusButton";
import { useRouter } from "next/navigation";
import { apiGet, apiDelete } from "@/src/lib/api";
import { MailLink, CallLink, MapLink } from "@/src/ui/helpers/Link";
import { FiStar, FiMapPin, FiUsers } from "react-icons/fi";

// Constant representing the kind states for this entity.
const kindStates = ["ALL", ...CLIENT_KIND] as const;

// Constant representing the status states for this entity.
const statusStates = ["ALL", ...CLIENT_STATUS] as const;

export default function ClientsTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isSuper, isAvail, isAdmin, forAdmin } = determineRoles(me, purpose);

  const router = useRouter();

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("ALL");
  const [kind, setKind] = useState<string[]>(["ALL"]);

  const [items, setItems] = useState<Client[]>([]);
  const [loading, setLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [toDelete, setToDelete] = useState<ToDeleteProps | null>(null);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [contactEditing, setContactEditing] = useState<Contact | null>(null);
  const [contactClientId, setContactClientId] = useState("");
  const [toDeleteContact, setToDeleteContact] = useState<ToDeleteProps | null>(
    null
  );

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
      const base = forAdmin ? "/api/admin/clients" : "/api/clients";
      const list: Client[] = await apiGet(base);
      setItems(
        list
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .filter((i) => forAdmin || i.status === "ACTIVE")
      );
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load clients.", err),
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
    onEventSearchRun("propertyTabToClientTabSearch", setQ, inputRef);
    onEventSearchRun("propertyTabToClientTabContactSearch", setQ, inputRef);
  }, []);

  // Filtered items based on search, kind or status.
  const filtered = useMemo(() => {
    let rows = items;

    // Filter based on entity type.
    if (kind[0] !== "ALL") {
      rows = rows.filter((i) => i.type === kind[0]);
    }

    // Filter based on entity status.
    if (status !== "ALL") {
      rows = rows.filter((i) => i.status === status);
    }

    // Filter based on free text.
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) => {
        const haystack: string[] = [r.displayName || "", r.notesInternal || ""];

        // Add contact fields into the search haystack
        for (const ct of r.contacts ?? []) {
          haystack.push(
            ct.firstName || "",
            ct.lastName || "",
            `${ct.firstName || ""} ${ct.lastName || ""}`,
            ct.email || "",
            ct.phone || "",
            ct.role || ""
          );
        }

        return haystack.some((value) => value.toLowerCase().includes(qlc));
      });
    }

    return rows;
  }, [items, q, kind, status]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  async function openEdit(c: Client) {
    setEditing(c);
    setDialogOpen(true);
  }

  function openContactCreate(clientId: string) {
    setContactClientId(clientId);
    setContactEditing(null);
    setContactDialogOpen(true);
  }

  async function openContactEdit(clientId: string, c: Contact) {
    setContactClientId(clientId);
    setContactEditing(c);
    setContactDialogOpen(true);
  }

  async function takeAction(c: Client, action: string) {
    return await doAction(
      c,
      "Client",
      "clients",
      action,
      "displayName",
      async () => await load(false)
    );
  }

  async function takeActionContact(c: Contact, action: string) {
    return await doAction(
      c,
      "Contact",
      "contacts",
      action,
      "email",
      async () => await load(false)
    );
  }

  async function deleteAction(id: string, displayName: string) {
    return await doDelete(
      id,
      "Client",
      "clients",
      displayName,
      async () => await load(false)
    );
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
            No clients or contacts match current filters.
          </Box>
        )}
        {filtered.map((c: Client) => (
          <Card.Root key={c.id} variant="outline">
            <Card.Header pb="2">
              <HStack gap={3} justify="space-between" align="center">
                <HStack gap={3} flex="1" minW={0}>
                  <Text fontWeight="semibold">{c.displayName}</Text>
                  <StatusBadge
                    status={c.status}
                    palette={clientStatusColor(c.status)}
                    variant="subtle"
                  />
                </HStack>
                <StatusBadge status={c.type} palette="gray" variant="outline" />
              </HStack>
            </Card.Header>
            <Card.Body pt="0">
              <VStack align="start" gap={1}>
                <Text fontSize="sm" color="fg.muted">
                  {c.notesInternal ?? ""}
                </Text>
              </VStack>
            </Card.Body>
            <Card.Footer>
              <HStack gap={2} wrap="wrap" mb="2" w="full">
                {forAdmin && (
                  <>
                    <StatusButton
                      id={"client-addcontact"}
                      itemId={c.id}
                      label={"Add"}
                      onClick={async () => openContactCreate(c.id)}
                      variant={"solid"}
                      disabled={loading}
                      busyId={statusButtonBusyId}
                      setBusyId={setStatusButtonBusyId}
                    />
                    <StatusButton
                      id={"client-edit"}
                      itemId={c.id}
                      label={"Edit"}
                      onClick={async () => {
                        await openEdit(c);
                      }}
                      variant={"outline"}
                      disabled={loading}
                      busyId={statusButtonBusyId}
                      setBusyId={setStatusButtonBusyId}
                    />
                    {c.status === "ACTIVE" && (
                      <StatusButton
                        id={"client-paused"}
                        itemId={c.id}
                        label={"Pause"}
                        onClick={async () => await takeAction(c, "pause")}
                        variant={"outline"}
                        disabled={loading}
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {c.status === "PAUSED" && (
                      <StatusButton
                        id={"client-unpaused"}
                        itemId={c.id}
                        label={"Unpause"}
                        onClick={async () => await takeAction(c, "unpause")}
                        variant={"outline"}
                        disabled={loading}
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {c.status === "PAUSED" && (
                      <StatusButton
                        id={"client-archive"}
                        itemId={c.id}
                        label={"Archive"}
                        onClick={async () => await takeAction(c, "archive")}
                        variant={"subtle"}
                        disabled={loading}
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {c.status === "ARCHIVED" && (
                      <>
                        <StatusButton
                          id={"client-unarchive"}
                          itemId={c.id}
                          label={"Unarchive"}
                          onClick={async () => await takeAction(c, "unarchive")}
                          variant={"outline"}
                          disabled={loading}
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                        <StatusButton
                          id={"client-delete"}
                          itemId={c.id}
                          label={"Delete"}
                          onClick={async () => {
                            void setToDelete({
                              id: c.id,
                              title:
                                "Delete client and and all related contacts?",
                              summary: c.displayName,
                              disabled: !isSuper,
                              details: (
                                <Text color="red.500">
                                  You must be a Super Admin to delete.
                                </Text>
                              ),
                              extra: c.displayName,
                            });
                          }}
                          variant={"outline"}
                          disabled={loading}
                          colorPalette={"red"}
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      </>
                    )}
                  </>
                )}
                <Accordion.Root collapsible w="full">
                  <Accordion.Item key={"contacts_" + c.id} value={"Contacts"}>
                    <Accordion.ItemTrigger>
                      <Icon as={FiUsers} boxSize="3" />
                      Contacts
                    </Accordion.ItemTrigger>
                    <Accordion.ItemContent>
                      <Accordion.ItemBody>
                        <VStack mt={2}>
                          {(c as any)?.contacts?.length === 0 && (
                            <Text fontSize="sm" color="fg.muted">
                              No contacts added.
                            </Text>
                          )}
                          {(c as any)?.contacts
                            ?.toSorted(
                              (a: any, b: any) =>
                                +(b.isPrimary ?? false) -
                                  +(a.isPrimary ?? false) ||
                                +(b.active ?? false) - +(a.active ?? false)
                            )
                            .filter((ct: any) => isAdmin || ct.active)
                            .map((ct: any) => {
                              return forAdmin || ct.active ? (
                                <VStack
                                  opacity={ct.active ? 1.0 : 0.5}
                                  align="start"
                                  w="100%"
                                  borderWidth="1px"
                                  borderRadius="md"
                                  gap={0}
                                  p={3}
                                >
                                  <HStack w="100%">
                                    {ct.isPrimary && (
                                      <Icon as={FiStar} boxSize="4" />
                                    )}
                                    <Text fontWeight="medium">
                                      {`${ct.firstName} ${ct.lastName}`}
                                    </Text>
                                    <StatusBadge
                                      status={ct.status}
                                      palette={clientStatusColor(ct.status)}
                                      variant="subtle"
                                    />
                                    <Spacer />
                                    <StatusBadge
                                      status={ct.role}
                                      palette="gray"
                                      variant="outline"
                                    />
                                  </HStack>
                                  <Text fontSize="sm" color="fg.muted">
                                    <MailLink
                                      to={ct.email}
                                      subject=""
                                      body=""
                                    />
                                  </Text>
                                  <Text fontSize="sm" color="fg.muted">
                                    <CallLink
                                      to={ct.normalizedPhone ?? ct.phone ?? ""}
                                    />
                                  </Text>
                                  {forAdmin && (
                                    <HStack gap={2} mt={3}>
                                      <StatusButton
                                        id={"contact-edit"}
                                        itemId={ct.id}
                                        label={"Edit"}
                                        onClick={async () => {
                                          await openContactEdit(c.id, ct);
                                        }}
                                        variant={"outline"}
                                        disabled={loading}
                                        busyId={statusButtonBusyId}
                                        setBusyId={setStatusButtonBusyId}
                                      />
                                      {ct.status === "ACTIVE" && (
                                        <StatusButton
                                          id={"contact-paused"}
                                          itemId={ct.id}
                                          label={"Pause"}
                                          onClick={async () =>
                                            await takeActionContact(ct, "pause")
                                          }
                                          variant={"outline"}
                                          disabled={loading}
                                          busyId={statusButtonBusyId}
                                          setBusyId={setStatusButtonBusyId}
                                        />
                                      )}
                                      {ct.status === "PAUSED" && (
                                        <StatusButton
                                          id={"contact-unpaused"}
                                          itemId={ct.id}
                                          label={"Unpause"}
                                          onClick={async () =>
                                            await takeActionContact(
                                              ct,
                                              "unpause"
                                            )
                                          }
                                          variant={"outline"}
                                          disabled={loading}
                                          busyId={statusButtonBusyId}
                                          setBusyId={setStatusButtonBusyId}
                                        />
                                      )}
                                      {ct.status === "PAUSED" && (
                                        <StatusButton
                                          id={"contact-archive"}
                                          itemId={ct.id}
                                          label={"Archive"}
                                          onClick={async () =>
                                            await takeActionContact(
                                              ct,
                                              "archive"
                                            )
                                          }
                                          variant={"subtle"}
                                          disabled={loading}
                                          busyId={statusButtonBusyId}
                                          setBusyId={setStatusButtonBusyId}
                                        />
                                      )}
                                      {ct.status === "ARCHIVED" && (
                                        <>
                                          <StatusButton
                                            id={"contact-unarchive"}
                                            itemId={ct.id}
                                            label={"Unarchive"}
                                            onClick={async () =>
                                              await takeActionContact(
                                                ct,
                                                "unarchive"
                                              )
                                            }
                                            variant={"outline"}
                                            disabled={loading}
                                            busyId={statusButtonBusyId}
                                            setBusyId={setStatusButtonBusyId}
                                          />
                                          <StatusButton
                                            id={"contact-delete"}
                                            itemId={ct.id}
                                            label={"Delete"}
                                            onClick={async () => {
                                              void setToDeleteContact({
                                                id: c.id,
                                                child: ct.id,
                                                title:
                                                  "Delete contact from client?",
                                                summary: `${ct.firstName} ${ct.lastName}`,
                                                disabled: me?.roles?.includes(
                                                  "SUPER"
                                                )
                                                  ? false
                                                  : true,
                                                details: (
                                                  <Text color="red.500">
                                                    You must be a Super Admin to
                                                    delete.
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
                                        </>
                                      )}
                                    </HStack>
                                  )}
                                </VStack>
                              ) : undefined;
                            })}
                        </VStack>
                      </Accordion.ItemBody>
                    </Accordion.ItemContent>
                  </Accordion.Item>
                </Accordion.Root>
                <Accordion.Root collapsible w="full">
                  <Accordion.Item
                    key={"properties_" + c.id}
                    value={"Properties"}
                  >
                    <Accordion.ItemTrigger>
                      <Icon as={FiMapPin} boxSize="3" />
                      Properties
                    </Accordion.ItemTrigger>
                    <Accordion.ItemContent>
                      <Accordion.ItemBody>
                        <VStack mt={2}>
                          {(c as any)?.properties?.length === 0 && (
                            <Text fontSize="sm" color="fg.muted">
                              No properties added.
                            </Text>
                          )}
                          {(c as any)?.properties.map((p: any) => {
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

                            return forAdmin || p.status === "ACTIVE" ? (
                              <VStack
                                opacity={p.status === "ACTIVE" ? 1.0 : 0.5}
                                align="start"
                                w="100%"
                                borderWidth="1px"
                                borderRadius="md"
                                gap={0}
                                p={3}
                              >
                                <HStack w="100%">
                                  <Text fontWeight="medium">
                                    {p.displayName}
                                  </Text>
                                  <Spacer />
                                  <StatusBadge
                                    status={p.kind}
                                    palette="gray"
                                    variant="outline"
                                  />
                                </HStack>
                                <MapLink address={address} />
                              </VStack>
                            ) : null;
                          })}
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              openEventSearch(
                                "clientTabToPropertiesTabSearch",
                                c.displayName,
                                forAdmin
                              )
                            }
                          >
                            View all
                          </Button>
                        </VStack>
                      </Accordion.ItemBody>
                    </Accordion.ItemContent>
                  </Accordion.Item>
                </Accordion.Root>
              </HStack>
            </Card.Footer>
          </Card.Root>
        ))}
      </VStack>

      {forAdmin && (
        <ClientDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          mode={editing ? "UPDATE" : "CREATE"}
          role={forAdmin ? "ADMIN" : "WORKER"}
          initial={editing ?? undefined}
          onSaved={() => void load()}
        />
      )}
      {forAdmin && (
        <ContactDialog
          open={contactDialogOpen}
          onOpenChange={setContactDialogOpen}
          mode={contactEditing ? "UPDATE" : "CREATE"}
          role={forAdmin ? "ADMIN" : "WORKER"}
          initial={contactEditing ?? undefined}
          onSaved={() => void load()}
          clientId={contactClientId}
        />
      )}
      {forAdmin && (
        <DeleteDialog
          toDelete={toDelete}
          cancel={() => void setToDelete(null)}
          complete={async () => {
            if (!toDelete) return;
            await deleteAction(toDelete.id, toDelete.extra ?? "");
            setToDelete(null);
          }}
        />
      )}
      {forAdmin && (
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
      )}
    </Box>
  );
}
