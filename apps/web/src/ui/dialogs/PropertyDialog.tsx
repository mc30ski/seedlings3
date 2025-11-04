"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
import { prettyStatus } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Mode = "create" | "update";
type RoleMode = "worker" | "admin";

type PropertyStatus = "PENDING" | "ACTIVE" | "ARCHIVED";
type PropertyKind = "SINGLE" | "AGGREGATE_SITE";

type ClientLite = { id: string; displayName: string };
type ContactLite = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
};

export type PropertyShape = {
  id: string;
  clientId: string;
  displayName: string;
  status: PropertyStatus;
  kind: PropertyKind;
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  accessNotes?: string | null;
  pointOfContactId?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  role: RoleMode;

  // When creating from a Client context, pass clientId to pre-select
  defaultClientId?: string;

  // When updating, pass the current property
  initialProperty?: PropertyShape | null;

  // Callback after successful save
  onSaved?: (saved: any) => void;
};

export default function PropertyDialog({
  open,
  onOpenChange,
  mode,
  role,
  defaultClientId,
  initialProperty,
  onSaved,
}: Props) {
  const isAdmin = role === "admin";
  const [busy, setBusy] = useState(false);

  // clients (for selection)
  const [clients, setClients] = useState<ClientLite[]>([]);
  // contacts for currently selected client
  const [contacts, setContacts] = useState<ContactLite[]>([]);

  // --- form state
  const [clientValue, setClientValue] = useState<string[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [statusValue, setStatusValue] = useState<string[]>(["PENDING"]);
  const [kindValue, setKindValue] = useState<string[]>(["SINGLE"]);

  const [street1, setStreet1] = useState("");
  const [street2, setStreet2] = useState("");
  const [city, setCity] = useState("");
  const [stateValue, setStateValue] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("USA");
  const [accessNotes, setAccessNotes] = useState("");

  const [pocValue, setPocValue] = useState<string[]>(["NONE"]);

  const clientItems = useMemo(() => {
    const items = clients.map((c) => ({
      label: c.displayName || c.id,
      value: c.id,
    }));
    const current = clientValue[0];
    if (current && !items.some((i) => i.value === current)) {
      items.unshift({ label: current, value: current });
    }
    return items;
  }, [clients, clientValue]);
  const clientCollection = useMemo(
    () => createListCollection({ items: clientItems }),
    [clientItems]
  );

  const statusItems = useMemo(
    () =>
      (["PENDING", "ACTIVE", "ARCHIVED"] as PropertyStatus[]).map((s) => ({
        label: prettyStatus(s),
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
      (["SINGLE", "AGGREGATE_SITE"] as PropertyKind[]).map((s) => ({
        label: prettyStatus(s),
        value: s,
      })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );

  const contactItems = useMemo(() => {
    const base = [{ label: "— None —", value: "NONE" }];
    const mapped = contacts.map((ct) => ({
      label: `${ct.firstName ?? ""} ${ct.lastName ?? ""}`.trim() || ct.id,
      value: ct.id,
    }));
    // keep currently selected POC even if not in fetched list
    const current = pocValue[0];
    if (
      current &&
      current !== "NONE" &&
      !mapped.some((i) => i.value === current)
    ) {
      mapped.unshift({ label: current, value: current });
    }
    return base.concat(mapped);
  }, [contacts, pocValue]);
  const contactCollection = useMemo(
    () => createListCollection({ items: contactItems }),
    [contactItems]
  );

  // load clients list when dialog opens
  useEffect(() => {
    if (!open) return;

    (async () => {
      try {
        const path = isAdmin
          ? "/api/admin/clients?limit=500"
          : "/api/clients?limit=500";

        const res: unknown = await apiGet(path);

        // normalize into an array
        const list: ClientLite[] = Array.isArray(res)
          ? (res as any[])
          : Array.isArray((res as any)?.items)
            ? ((res as any).items as any[])
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
    })();
  }, [open, isAdmin]);

  // seed form when opening/switching modes/records
  useEffect(() => {
    if (!open) return;
    if (mode === "update" && initialProperty) {
      setClientValue([initialProperty.clientId]);
      setDisplayName(initialProperty.displayName ?? "");
      setStatusValue([initialProperty.status ?? "PENDING"]);
      setKindValue([initialProperty.kind ?? "SINGLE"]);
      setStreet1(initialProperty.street1 ?? "");
      setStreet2(initialProperty.street2 ?? "");
      setCity(initialProperty.city ?? "");
      setStateValue(initialProperty.state ?? "");
      setPostalCode(initialProperty.postalCode ?? "");
      setCountry(initialProperty.country ?? "USA");
      setAccessNotes(initialProperty.accessNotes ?? "");
      setPocValue([initialProperty.pointOfContactId ?? "NONE"]);
    } else {
      setClientValue(defaultClientId ? [defaultClientId] : []);
      setDisplayName("");
      setStatusValue(["PENDING"]);
      setKindValue(["SINGLE"]);
      setStreet1("");
      setStreet2("");
      setCity("");
      setStateValue("");
      setPostalCode("");
      setCountry("USA");
      setAccessNotes("");
      setPocValue(["NONE"]);
    }
  }, [open, mode, initialProperty, defaultClientId]);

  // load contacts whenever selected client changes
  useEffect(() => {
    const cid = clientValue[0];
    if (!cid) {
      setContacts([]);
      setPocValue(["NONE"]);
      return;
    }

    (async () => {
      try {
        const path = isAdmin
          ? `/api/admin/clients/${cid}`
          : `/api/clients/${cid}`;
        const res: unknown = await apiGet(path);

        // Normalize various server shapes into an array
        const contactsRaw: unknown =
          (res as any)?.contacts ??
          (res as any)?.data?.contacts ??
          (res as any)?.item?.contacts;

        const list: any[] = Array.isArray(contactsRaw)
          ? (contactsRaw as any[])
          : [];

        setContacts(
          list.map((ct) => ({
            id: ct.id,
            firstName: ct.firstName ?? "",
            lastName: ct.lastName ?? "",
            email: ct.email ?? null,
            phone: ct.phone ?? null,
          }))
        );

        // If currently selected POC isn’t in the new list, reset to NONE
        const selected = pocValue[0];
        if (
          selected &&
          selected !== "NONE" &&
          !list.some((c) => c.id === selected)
        ) {
          setPocValue(["NONE"]);
        }
      } catch {
        setContacts([]);
        setPocValue(["NONE"]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientValue, isAdmin]);

  async function handleSave() {
    const cid = clientValue[0];
    if (!cid) {
      publishInlineMessage({
        type: "WARNING",
        text: "Please select a client.",
      });
      return;
    }
    if (!displayName.trim()) {
      publishInlineMessage({
        type: "WARNING",
        text: "Please enter a property name.",
      });
      return;
    }
    if (
      !street1.trim() ||
      !city.trim() ||
      !stateValue.trim() ||
      !postalCode.trim() ||
      !country.trim()
    ) {
      publishInlineMessage({
        type: "WARNING",
        text: "Address is incomplete.",
      });
      return;
    }

    const payload = {
      clientId: cid,
      displayName: displayName.trim(),
      status: (statusValue[0] as PropertyStatus) ?? "PENDING",
      kind: (kindValue[0] as PropertyKind) ?? "SINGLE",
      street1: street1.trim(),
      street2: street2.trim() || null,
      city: city.trim(),
      state: stateValue.trim(),
      postalCode: postalCode.trim(),
      country: country.trim(),
      accessNotes: accessNotes.trim() || null,
      pointOfContactId: pocValue[0] === "NONE" ? null : pocValue[0],
    };

    setBusy(true);
    try {
      let saved;
      if (mode === "create") {
        saved = await apiPost("/api/admin/properties", payload);
        publishInlineMessage({
          type: "SUCCESS",
          text: `Property “${payload.displayName}” created.`,
        });
      } else {
        if (!initialProperty?.id) throw new Error("Missing property id");
        saved = await apiPatch(
          `/api/admin/properties/${initialProperty.id}`,
          payload
        );
        publishInlineMessage({
          type: "SUCCESS",
          text: `Property “${payload.displayName}” updated.`,
        });
      }
      onSaved?.(saved);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          mode === "create"
            ? "Create property failed"
            : "Update property failed",
          err
        ),
      });
    } finally {
      onOpenChange(false);
      setBusy(false);
    }
  }

  function ableToSave() {
    return (
      clientValue &&
      clientValue.length > 0 &&
      displayName &&
      statusValue &&
      kindValue &&
      street1 &&
      city &&
      stateValue &&
      postalCode &&
      country
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => onOpenChange(e.open)}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            mx="4"
            maxW="lg"
            w="full"
            rounded="2xl"
            p="4"
            shadow="lg"
          >
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>
                {mode === "create" ? "Create Property" : "Update Property"}
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <HStack justify="space-between">
                    <Text mb="1">Client *</Text>
                    {!isAdmin && <Badge colorPalette="gray">Read-only</Badge>}
                  </HStack>
                  <Select.Root
                    collection={clientCollection}
                    value={clientValue}
                    onValueChange={(e) => setClientValue(e.value)}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    disabled={!isAdmin && mode === "update"}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Select a client" />
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
                </div>
                <div>
                  <Text mb="1">Property name *</Text>
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g., Main House"
                  />
                </div>
                <HStack gap={3}>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Status *</Text>
                    <Select.Root
                      collection={statusCollection}
                      value={statusValue}
                      onValueChange={(e) => setStatusValue(e.value)}
                      size="sm"
                      positioning={{
                        strategy: "fixed",
                        hideWhenDetached: true,
                      }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select status" />
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
                  </div>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Kind *</Text>
                    <Select.Root
                      collection={kindCollection}
                      value={kindValue}
                      onValueChange={(e) => setKindValue(e.value)}
                      size="sm"
                      positioning={{
                        strategy: "fixed",
                        hideWhenDetached: true,
                      }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select kind" />
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
                  </div>
                </HStack>
                <div>
                  <Text mb="1">Address *</Text>
                  <Input
                    value={street1}
                    onChange={(e) => setStreet1(e.target.value)}
                    placeholder="Street 1"
                    mb="2"
                  />
                  <Input
                    value={street2}
                    onChange={(e) => setStreet2(e.target.value)}
                    placeholder="Street 2 (optional)"
                    mb="2"
                  />
                  <HStack gap={3}>
                    <Input
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      placeholder="City"
                    />
                    <Input
                      value={stateValue}
                      onChange={(e) => setStateValue(e.target.value)}
                      placeholder="State"
                    />
                  </HStack>
                  <HStack gap={3} mt="2">
                    <Input
                      value={postalCode}
                      onChange={(e) => setPostalCode(e.target.value)}
                      placeholder="Postal code"
                    />
                    <Input
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      placeholder="Country"
                    />
                  </HStack>
                </div>
                <div>
                  <Text mb="1">Default contact</Text>
                  <Select.Root
                    collection={contactCollection}
                    value={pocValue}
                    onValueChange={(e) => setPocValue(e.value)}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    disabled={!clientValue[0]}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Select a contact" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {contactItems.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </div>
                <div>
                  <Text mb="1">Access notes</Text>
                  <Textarea
                    value={accessNotes}
                    onChange={(e) => setAccessNotes(e.target.value)}
                    placeholder="Gate codes, parking, dogs, etc."
                    rows={3}
                  />
                </div>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  loading={busy}
                  disabled={!ableToSave()}
                >
                  {mode === "create" ? "Create" : "Save"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
