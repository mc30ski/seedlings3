"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Spacer,
  Text,
  VStack,
  Select,
  Icon,
  Spinner,
  Accordion,
  createListCollection,
} from "@chakra-ui/react";
import { Filter, LayoutList, Plus, RefreshCw, X } from "lucide-react";
import { determineRoles, prettyStatus, clientStatusColor, clientLabel } from "@/src/lib/lib";
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
import { apiGet, apiDelete } from "@/src/lib/api";
import { MailLink, CallLink, MapLink } from "@/src/ui/helpers/Link";
import { FiStar, FiMapPin, FiUsers } from "react-icons/fi";

// Constant representing the kind states for this entity.
const kindStates = ["ALL", ...CLIENT_KIND] as const;

// Constant representing the status states for this entity.
const statusStates = ["ALL", ...CLIENT_STATUS] as const;

export default function ClientsTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isSuper, isAvail, isAdmin, forAdmin } = determineRoles(me, purpose);
  const pfx = purpose === "ADMIN" ? "aclients" : "wclients";
  const isTrainee = !forAdmin && me?.workerType === "TRAINEE";
  const [traineeClientIds, setTraineeClientIds] = useState<Set<string> | null>(null);

  // Variables for filtering the items.
  const [q, setQ] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(`${pfx}_status`, ["ALL"]);
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);

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

  // For trainees: fetch their assigned client IDs
  useEffect(() => {
    if (!isTrainee) { setTraineeClientIds(null); return; }
    apiGet<any[]>("/api/occurrences")
      .then((occs) => {
        const myId = me?.id;
        const ids = new Set<string>();
        for (const occ of occs) {
          if ((occ.assignees ?? []).some((a: any) => a.userId === myId)) {
            if (occ.job?.property?.client?.id) ids.add(occ.job.property.client.id);
          }
        }
        setTraineeClientIds(ids);
      })
      .catch(() => setTraineeClientIds(new Set()));
  }, [isTrainee, me?.id]);

  useEffect(() => {
    onEventSearchRun("propertyTabToClientTabSearch", setQ, inputRef, setHighlightId);
    onEventSearchRun("propertyTabToClientTabContactSearch", setQ, inputRef, setHighlightId);
    onEventSearchRun("jobsTabToClientsTabSearch", setQ, inputRef, setHighlightId);
    onEventSearchRun("paymentsTabToClientsTabSearch", setQ, inputRef, setHighlightId);
  }, []);

  // Filtered items based on search, kind or status.
  const filtered = useMemo(() => {
    // If navigated here by ID, show only that entity
    if (highlightId) {
      const exact = items.find((r) => r.id === highlightId);
      if (exact) return [exact];
    }

    // Trainees: wait for filter data before showing anything
    if (isTrainee && !traineeClientIds) return [];

    let rows = items;

    // Trainees only see clients they are assigned to
    if (isTrainee && traineeClientIds) {
      rows = rows.filter((r) => traineeClientIds.has(r.id));
    }

    // Filter based on entity type.
    if (kind[0] !== "ALL") {
      rows = rows.filter((i) => i.type === kind[0]);
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
  }, [items, q, kind, statusFilter, highlightId, isTrainee, traineeClientIds]);

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
            No clients or contacts match current filters.
          </Box>
        )}
        {filtered.map((c: Client) => (
          <Card.Root key={c.id} variant="outline">
            <Card.Header py="3" px="4" pb="0">
              <HStack gap={3} justify="space-between" align="center">
                <Text fontSize="md" fontWeight="semibold" flex="1" minW={0}>{clientLabel(c.displayName)}</Text>
                <Box display="flex" gap={1} flexShrink={0} flexDirection={{ base: "column", md: "row" }} alignItems="flex-end">
                  {(c.contacts ?? []).some((ct: any) => !ct.email && !ct.phone && !ct.normalizedPhone) && (
                    <Badge size="xs" colorPalette="red" variant="subtle">Missing contact info</Badge>
                  )}
                  <StatusBadge
                    status={c.status}
                    palette={clientStatusColor(c.status)}
                    variant="subtle"
                  />
                  <StatusBadge status={c.type} palette="gray" variant="outline" />
                </Box>
              </HStack>
            </Card.Header>
            {c.notesInternal && (
              <Card.Body py="3" px="4" pt="1" pb="0">
                <Text fontSize="xs" color="fg.muted">
                  {c.notesInternal}
                </Text>
              </Card.Body>
            )}
            <Card.Footer py="3" px="4" pt="2">
              <HStack gap={2} wrap="wrap" w="full">
                {forAdmin && (
                  <>
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
                            const hasContacts = (c.contacts?.length ?? 0) > 0;

                            let hasProperties = false;
                            if (!hasContacts) {
                              try {
                                const props = await apiGet<any[]>(
                                  `/api/admin/properties?clientId=${c.id}&limit=500`
                                );
                                hasProperties = Array.isArray(props) && props.length > 0;
                              } catch { /* proceed; server will guard */ }
                            }

                            const hasDeps = hasContacts || hasProperties;
                            const superRequired = !isSuper;

                            void setToDelete({
                              id: c.id,
                              title: "Delete client?",
                              summary: c.displayName,
                              disabled: hasDeps || superRequired,
                              details: hasContacts ? (
                                <Text color="red.500">
                                  This client has associated contacts. Delete all contacts before deleting the client.
                                </Text>
                              ) : hasProperties ? (
                                <Text color="red.500">
                                  This client has associated properties. Delete all properties before deleting the client.
                                </Text>
                              ) : superRequired ? (
                                <Text color="red.500">
                                  You must be a Super Admin to delete.
                                </Text>
                              ) : undefined,
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
                      Contacts ({c.contacts?.length ?? 0})
                    </Accordion.ItemTrigger>
                    <Accordion.ItemContent>
                      <Accordion.ItemBody>
                        <VStack mt={2}>
                          {(c as any)?.contacts?.length === 0 && (
                            <Text fontSize="xs" color="fg.muted">
                              No contacts added.
                            </Text>
                          )}
                          {(c as any)?.contacts
                            ?.toSorted(
                              (a: any, b: any) =>
                                +(b.isPrimary ?? false) -
                                +(a.isPrimary ?? false)
                            )
                            .filter(
                              (ct: any) => isAdmin || ct.status === "ACTIVE"
                            )
                            .map((ct: any) => {
                              return forAdmin || ct.status === "ACTIVE" ? (
                                <VStack
                                  align="start"
                                  w="100%"
                                  borderWidth="1px"
                                  borderRadius="md"
                                  gap={0}
                                  p={3}
                                >
                                  <HStack w="100%" wrap="wrap">
                                    <Text fontWeight="medium">
                                      {ct.firstName}{ct.nickname ? ` "${ct.nickname}"` : ""}{ct.lastName ? ` ${ct.lastName}` : ""}
                                    </Text>
                                    {ct.isPrimary && (
                                      <Icon as={FiStar} boxSize="4" />
                                    )}
                                    <StatusBadge
                                      status={ct.status}
                                      palette={clientStatusColor(ct.status)}
                                      variant="subtle"
                                    />
                                    {!ct.lastName && (
                                      <Badge size="xs" colorPalette="orange" variant="subtle">No last name</Badge>
                                    )}
                                    {!ct.email && !ct.phone && !ct.normalizedPhone && (
                                      <Badge size="xs" colorPalette="red" variant="subtle">No contact info</Badge>
                                    )}
                                    {ct.email && !ct.phone && !ct.normalizedPhone && (
                                      <Badge size="xs" colorPalette="orange" variant="subtle">No phone</Badge>
                                    )}
                                    {!ct.email && (ct.phone || ct.normalizedPhone) && (
                                      <Badge size="xs" colorPalette="orange" variant="subtle">No email</Badge>
                                    )}
                                    <Spacer />
                                    <StatusBadge
                                      status={ct.role}
                                      palette="gray"
                                      variant="outline"
                                    />
                                  </HStack>
                                  {ct.email && (
                                    <Text fontSize="xs" color="fg.muted">
                                      <MailLink
                                        to={ct.email}
                                        subject=""
                                        body=""
                                      />
                                    </Text>
                                  )}
                                  {(ct.normalizedPhone || ct.phone) && (
                                    <Text fontSize="xs" color="fg.muted">
                                      <CallLink
                                        to={ct.normalizedPhone ?? ct.phone ?? ""}
                                      />
                                    </Text>
                                  )}
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
                          {forAdmin && (
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => openContactCreate(c.id)}
                              disabled={loading}
                            >
                              <Plus size={14} />
                              Add Contact
                            </Button>
                          )}
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
                      Properties ({(c as any)?.properties?.length ?? 0})
                    </Accordion.ItemTrigger>
                    <Accordion.ItemContent>
                      <Accordion.ItemBody>
                        <VStack mt={2}>
                          {(c as any)?.properties?.length === 0 && (
                            <Text fontSize="xs" color="fg.muted">
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
                                  <Text
                                    fontWeight="medium"
                                    color="blue.600"
                                    cursor="pointer"
                                    _hover={{ textDecoration: "underline" }}
                                    onClick={() => openEventSearch(
                                      "clientTabToPropertiesTabSearch",
                                      p.displayName,
                                      forAdmin,
                                      p.id,
                                    )}
                                  >
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
      </Box>

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
