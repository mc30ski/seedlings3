"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import type { Scope } from "@/src/lib/scope";
import { parseAddressLine } from "@/src/lib/address";
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
import AddressSearchField from "@/src/ui/components/AddressSearchField";
import {
  DialogMode,
  Property,
  PropertyStatus,
  PropertyKind,
  PROPERTY_KIND,
  PROPERTY_STATUS,
} from "@/src/lib/types";
import { prettyStatus, clientLabel } from "@/src/lib/labels";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";

type ClientLite = { id: string; displayName: string };
type ContactLite = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: DialogMode;
  /** What the viewer can do. Was `role: Surface` — a role name
   *  deciding whether fields were editable. */
  scope?: Scope;
  initial?: Property | null;
  onSaved?: (saved: Property) => void;

  // When creating from a Client context, pass clientId to pre-select
  defaultClientId?: string;
  preventOutsideClose?: boolean;
  deferSave?: boolean;
  /** When in deferred mode, provide the client directly instead of loading from API */
  deferredClient?: { id: string; displayName: string };
  /** When in deferred mode, provide the contact directly */
  deferredContact?: { firstName: string; lastName: string; email?: string | null; phone?: string | null };
  onBack?: () => void;
};

export default function PropertyDialog({
  open,
  onOpenChange,
  mode,
  scope,
  initial,
  onSaved,
  defaultClientId,
  preventOutsideClose,
  deferSave,
  deferredClient,
  deferredContact,
  onBack,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // The capability this dialog's writes actually require, not a
  // role name. Absent scope fails closed.
  const canManageClients = !!scope?.can("clients.manage");
  const [busy, setBusy] = useState(false);
  const dlgErr = useDialogError();

  // clients (for selection)
  const [clients, setClients] = useState<ClientLite[]>([]);
  // contacts for currently selected client
  const [contacts, setContacts] = useState<ContactLite[]>([]);

  // --- Form state
  const [statusValue, setStatusValue] = useState<string[]>(["ACTIVE"]);
  const [kindValue, setKindValue] = useState<string[]>([PROPERTY_KIND[0]]);

  const [clientValue, setClientValue] = useState<string[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [addressSearch, setAddressSearch] = useState("");
  const [street1, setStreet1] = useState("");

  function parseAddressIntoFields(placeName: string) {
    // Shared with the estimate-conversion form — see lib/address.ts. This
    // logic was correct here and WRONG there for months, because the two
    // screens each had their own copy and only one got fixed.
    const a = parseAddressLine(placeName);
    setStreet1(a.street1);
    if (a.city) setCity(a.city);
    if (a.state) setStateValue(a.state);
    if (a.postalCode) setPostalCode(a.postalCode);
    if (a.country) setCountry(a.country);
  }
  const [street2, setStreet2] = useState("");
  const [city, setCity] = useState("");
  const [stateValue, setStateValue] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("USA");
  const [accessNotes, setAccessNotes] = useState("");
  const [lotSize, setLotSize] = useState("");
  const [lotSizeUnit, setLotSizeUnit] = useState("sqft");

  const [pocValue, setPocValue] = useState<string[]>(["NONE"]);

  // ── TERRITORY ─────────────────────────────────────────────────────────
  //
  // A property's area decides whose rollups it appears in. Until now
  // nothing in the app set it: a property got one from the seed, or by
  // inheriting from a sibling when the client's other properties all
  // agreed, or not at all — and an untagged property is invisible to every
  // area-scoped reader, which is the silent-rows-missing failure the whole
  // area feature exists to avoid.
  const [areaValue, setAreaValue] = useState<string[]>(["INHERIT"]);
  const [areaOptions, setAreaOptions] = useState<Array<{ id: string; name: string; trail?: string[] }>>([]);
  // What it was when the dialog opened, so an UPDATE only retags when the
  // operator actually changed it.
  const initialAreaId = (initial as any)?.areaId ?? null;
  const mayRetag = !!scope?.can("areas.manage");

  const clientItems = useMemo(() => {
    const items = clients.map((c) => ({
      label: clientLabel(c.displayName) || c.id,
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

  const areaItems = useMemo(
    () => [
      // CREATE offers "work it out", which is the server's inherit-from-
      // the-client rule. UPDATE offers "none", which is a real choice to
      // remove a property from every territory.
      mode === "CREATE"
        ? { label: "Decide from this client's other properties", value: "INHERIT" }
        : { label: "No area", value: "NONE" },
      ...areaOptions.map((a) => ({
        // The chain, so two routes called "North" are distinguishable.
        label: a.trail?.length ? a.trail.join(" → ") : a.name,
        value: a.id,
      })),
    ],
    [areaOptions, mode],
  );
  const areaCollection = useMemo(
    () => createListCollection({ items: areaItems }),
    [areaItems],
  );

  const statusItems = useMemo(
    () =>
      PROPERTY_STATUS.map((s) => ({
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
      PROPERTY_KIND.map((s) => ({
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
  const lotUnitCollection = useMemo(
    () => createListCollection({
      items: [
        { label: "sq ft", value: "sqft" },
        { label: "acres", value: "acres" },
        { label: "hectares", value: "hectares" },
        { label: "sq m", value: "sqm" },
      ],
    }),
    [],
  );

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

  // load clients list when dialog opens
  // Load the areas on offer, and seed the picker from the property.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<{ areas: Array<{ id: string; name: string; trail?: string[] }> }>(
          "/api/me/areas",
        );
        if (!cancelled) setAreaOptions(res.areas ?? []);
      } catch {
        // No list means no picker — the rest of the dialog still works and
        // the server still applies its own inherit rule on create.
        if (!cancelled) setAreaOptions([]);
      }
    })();
    setAreaValue([initialAreaId ?? (mode === "CREATE" ? "INHERIT" : "NONE")]);
    return () => { cancelled = true; };
  }, [open, initialAreaId, mode]);

  useEffect(() => {
    if (!open) return;

    // In deferred mode with a deferred client, use that directly
    if (deferSave && deferredClient) {
      setClients([deferredClient]);
      setClientValue([deferredClient.id]);
      return;
    }

    (async () => {
      try {
        // One endpoint. This was a ternary whose two arms were the same
        // URL, left behind when the two client routes were merged into
        // one.
        const res: unknown = await apiGet("/api/clients?limit=500");

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
  }, [open, canManageClients]);

  // Seed form ONCE per open — see ContactDialog for the rationale.
  const prevOpenRefSeed = useRef(false);
  useEffect(() => {
    if (!open) { prevOpenRefSeed.current = false; return; }
    if (prevOpenRefSeed.current) return;
    prevOpenRefSeed.current = true;
    if (mode === "UPDATE" && initial) {
      setAddressSearch("");
      setKindValue([initial.kind ?? PROPERTY_KIND[0]]);
      setStatusValue([initial.status ?? PROPERTY_STATUS[0]]);
      setClientValue([initial.clientId ?? ""]);
      setDisplayName(initial.displayName ?? "");
      setStreet1(initial.street1 ?? "");
      setStreet2(initial.street2 ?? "");
      setCity(initial.city ?? "");
      setStateValue(initial.state ?? "");
      setPostalCode(initial.postalCode ?? "");
      setCountry(initial.country ?? "USA");
      setAccessNotes(initial.accessNotes ?? "");
      setLotSize((initial as any).lotSize != null ? String((initial as any).lotSize) : "");
      setLotSizeUnit((initial as any).lotSizeUnit ?? "sqft");
      setPocValue([initial.pointOfContactId ?? "NONE"]);
    } else {
      setAddressSearch((initial as any)?.estimateAddress ?? "");
      setKindValue([initial?.kind ?? PROPERTY_KIND[0]]);
      setStatusValue([initial?.status ?? PROPERTY_STATUS[0]]);
      setClientValue(defaultClientId ? [defaultClientId] : []);
      setDisplayName(initial?.displayName ?? "");
      setStreet1(initial?.street1 ?? "");
      setStreet2(initial?.street2 ?? "");
      setCity(initial?.city ?? "");
      setStateValue(initial?.state ?? "");
      setPostalCode(initial?.postalCode ?? "");
      setCountry("USA");
      setAccessNotes("");
      setLotSize("");
      setLotSizeUnit("sqft");
      setPocValue(["NONE"]);
    }
  }, [open]);

  // load contacts whenever selected client changes
  useEffect(() => {
    const cid = clientValue[0];
    if (!cid) {
      setContacts([]);
      setPocValue(["NONE"]);
      return;
    }

    // In deferred mode, use the deferred contact directly
    if (deferSave && deferredContact && cid === "__deferred__") {
      const ct = {
        id: "__deferred__",
        firstName: deferredContact.firstName,
        lastName: deferredContact.lastName,
        email: deferredContact.email ?? null,
        phone: deferredContact.phone ?? null,
      };
      setContacts([ct]);
      setPocValue([ct.id]);
      return;
    }

    (async () => {
      try {
        const path = `/api/clients/${cid}`;
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

        // If currently selected POC isn’t in the new list, reset
        const selected = pocValue[0];
        if (
          selected &&
          selected !== "NONE" &&
          !list.some((c) => c.id === selected)
        ) {
          // Auto-select primary contact if available
          const primary = list.find((c) => c.isPrimary);
          setPocValue([primary ? primary.id : "NONE"]);
        } else if (mode === "CREATE" && (!selected || selected === "NONE")) {
          // On create, pre-select the primary contact
          const primary = list.find((c) => c.isPrimary);
          if (primary) setPocValue([primary.id]);
        }
      } catch {
        setContacts([]);
        setPocValue(["NONE"]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientValue, canManageClients]);

  async function handleSave() {
    dlgErr.clear();
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
      kind: (kindValue[0] as PropertyKind) ?? PROPERTY_KIND[0],
      status: (statusValue[0] as PropertyStatus) ?? PROPERTY_STATUS[0],
      clientId: cid,
      displayName: displayName.trim(),
      street1: street1.trim(),
      street2: street2.trim() || null,
      city: city.trim(),
      state: stateValue.trim(),
      postalCode: postalCode.trim(),
      country: country.trim(),
      accessNotes: accessNotes.trim() || null,
      lotSize: lotSize !== "" ? Number(lotSize) : null,
      lotSizeUnit: lotSize !== "" ? lotSizeUnit : null,
      pointOfContactId: pocValue[0] === "NONE" ? null : pocValue[0],
      // ONLY ON CREATE. `properties.update` deliberately does not write
      // `areaId`: moving an existing property has consequences the plain
      // patch does not handle — future visits follow it, a retired area is
      // refused, and the audit records how many occurrences moved. That is
      // `PATCH /properties/:id/area`, called separately below.
      ...(mode === "CREATE" && areaValue[0] && areaValue[0] !== "INHERIT"
        ? { areaId: areaValue[0] }
        : {}),
    };

    if (deferSave) {
      onSaved?.(payload as any);
      onOpenChange(false);
      return;
    }

    setBusy(true);
    try {
      let saved: Property;
      if (mode === "CREATE") {
        saved = await apiPost<Property>("/api/properties", payload);
        publishInlineMessage({
          type: "SUCCESS",
          text: `Property "${payload.displayName}" created.`,
        });
      } else {
        if (!initial?.id) throw new Error("Missing property id");
        saved = await apiPatch<Property>(
          `/api/properties/${initial.id}`,
          payload
        );

        // MOVING AREA IS ITS OWN CALL, after the patch above.
        //
        // Not folded into it: the retag endpoint moves the property's
        // UNFINISHED visits with it and leaves completed ones where they
        // happened, refuses a retired area, and audits the count. Writing
        // `areaId` through the ordinary patch would skip all three and
        // quietly restate what past rollups reported.
        const chosenArea = areaValue[0] === "NONE" ? null : areaValue[0] ?? null;
        let moved = 0;
        if (mayRetag && chosenArea !== (initialAreaId ?? null)) {
          const res = await apiPatch<{ changed?: boolean; occurrencesRetagged?: number }>(
            `/api/properties/${initial.id}/area`,
            { areaId: chosenArea },
          );
          moved = res?.occurrencesRetagged ?? 0;
        }

        publishInlineMessage({
          type: "SUCCESS",
          text:
            moved > 0
              ? `Property "${payload.displayName}" updated. ${moved} scheduled visit${moved === 1 ? "" : "s"} moved with it.`
              : `Property "${payload.displayName}" updated.`,
        });
      }
      onSaved?.(saved);
    } catch (err) {
      dlgErr.setError(getErrorMessage(
        mode === "CREATE"
          ? "Create property failed"
          : "Update property failed",
        err
      ));
    } finally {
      onOpenChange(false);
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
      closeOnInteractOutside={!preventOutsideClose}
      initialFocusEl={() => cancelRef.current}
    >
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
                {mode === "CREATE" ? "Create Property" : "Update Property"}
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <HStack justify="space-between">
                    <Text mb="1">Client *</Text>
                    {!canManageClients && <Badge colorPalette="gray">Read-only</Badge>}
                  </HStack>
                  <Select.Root
                    collection={clientCollection}
                    value={clientValue}
                    onValueChange={(e) => setClientValue(e.value)}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    disabled={!canManageClients && mode === "UPDATE"}
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
                  <HStack gap={1} mt={1} wrap="wrap">
                    {[
                      "Main House",
                      "Rental Property",
                      "Vacation Home",
                      "Commercial",
                      "Office",
                      "Townhouse",
                      "Condo",
                      "Lot",
                      "Community",
                    ].map((preset) => (
                      <Button
                        key={preset}
                        size="xs"
                        variant={displayName === preset ? "solid" : "outline"}
                        colorPalette="gray"
                        onClick={() => setDisplayName(preset)}
                      >
                        {preset}
                      </Button>
                    ))}
                  </HStack>
                </div>
                {/* AREA. Above Status because it answers a question about
                    the property's place in the business, not its lifecycle,
                    and because it is the field nobody could set until now. */}
                {areaOptions.length > 0 && (
                  <div>
                    <Text mb="1">Area</Text>
                    <Select.Root
                      collection={areaCollection}
                      value={areaValue}
                      onValueChange={(e) => setAreaValue(e.value)}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      // Changing an existing property's area goes through the
                      // retag endpoint, which is `areas.manage`. Without it
                      // the field shows where the property is and refuses to
                      // move it, rather than offering a control whose save
                      // would be refused.
                      disabled={mode === "UPDATE" ? !mayRetag : !canManageClients}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select area" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {areaItems.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                    <Text fontSize="xs" color="fg.muted" mt="1">
                      {mode === "UPDATE" && !mayRetag
                        ? "Only somebody who manages areas can move a property."
                        : mode === "UPDATE"
                          ? "Moving it takes its scheduled visits along. Finished work stays where it happened."
                          : "Decides whose rollups this property appears in."}
                    </Text>
                  </div>
                )}
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
                      disabled={!canManageClients && mode === "UPDATE"}
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
                      disabled={!canManageClients && mode === "UPDATE"}
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
                  <AddressSearchField
                    value={addressSearch}
                    onChange={setAddressSearch}
                    onSelect={parseAddressIntoFields}
                  />
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
                    disabled={
                      !clientValue[0] || (!canManageClients && mode === "UPDATE")
                    }
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
                  <Text mb="1">Lot size</Text>
                  <HStack gap={2}>
                    <Input
                      type="number"
                      value={lotSize}
                      onChange={(e) => setLotSize(e.target.value)}
                      placeholder="e.g. 5000"
                      size="sm"
                      flex="1"
                    />
                    <Select.Root
                      collection={lotUnitCollection}
                      value={[lotSizeUnit]}
                      onValueChange={(e) => {
                        if (e.value[0]) setLotSizeUnit(e.value[0]);
                      }}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      css={{ width: "auto", flex: "0 0 auto" }}
                    >
                      <Select.Control>
                        <Select.Trigger w="auto" minW="0" px="2">
                          <Select.ValueText />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {lotUnitCollection.items.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </HStack>
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
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                {onBack && <Button variant="outline" onClick={onBack}>Back</Button>}
                <Button
                  variant="ghost"
                  ref={cancelRef}
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
                  {mode === "CREATE" ? "Create" : "Save"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
