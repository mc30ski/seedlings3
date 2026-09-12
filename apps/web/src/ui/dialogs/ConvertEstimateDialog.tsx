"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseAddressLine } from "@/src/lib/address";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Select,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";
import AddressSearchField from "@/src/ui/components/AddressSearchField";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  defaults: {
    contactName?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
    estimateAddress?: string | null;
    estimateStreet1?: string | null;
    estimateStreet2?: string | null;
    estimateCity?: string | null;
    estimateState?: string | null;
    estimatePostalCode?: string | null;
    proposalAmount?: number | null;
    proposalNotes?: string | null;
    title?: string | null;
    estimatedMinutes?: number | null;
  };
  onConverted?: () => void;
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  fontSize: "14px",
  border: "1px solid #ccc",
  borderRadius: "6px",
};

const clientTypeCollection = createListCollection({
  items: [
    { label: "Person", value: "PERSON" },
    { label: "Community", value: "COMMUNITY" },
  ],
});

const propertyTypeCollection = createListCollection({
  items: [
    { label: "Single", value: "SINGLE" },
    { label: "Aggregate Site", value: "AGGREGATE_SITE" },
  ],
});


function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export default function ConvertEstimateDialog({
  open,
  onOpenChange,
  occurrenceId,
  defaults,
  onConverted,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Client
  const [clientName, setClientName] = useState("");
  const [clientType, setClientType] = useState<string[]>(["PERSON"]);

  // Contact
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  // Property
  const [propertyName, setPropertyName] = useState("Home");
  // The SEARCH BOX's text — a query, not the address. Previously this was the
  // address, and every keystroke in it re-parsed and overwrote the fields
  // below, so correcting a city by hand was undone by touching the search.
  const [addressSearch, setAddressSearch] = useState("");
  const [street1, setStreet1] = useState("");
  const [street2, setStreet2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [propertyKind, setPropertyKind] = useState<string[]>(["SINGLE"]);

  // Job
  const [defaultPrice, setDefaultPrice] = useState("");
  const [isRepeating, setIsRepeating] = useState(false);
  const [frequencyDays, setFrequencyDays] = useState("7");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");
  const [jobNotes, setJobNotes] = useState("");

  const [saving, setSaving] = useState(false);
  const dlgErr = useDialogError();

  useEffect(() => {
    if (!open) return;
    // Pre-fill from defaults
    const name = defaults.contactName ?? "";
    setClientName(name);
    const { first, last } = splitName(name);
    setFirstName(first);
    setLastName(last);
    setPhone(defaults.contactPhone ?? "");
    setEmail(defaults.contactEmail ?? "");
    setPropertyName("Home");
    // THE PARTS FIRST. An estimate now stores its address as fields, so the
    // usual path here is a straight copy with no parsing at all — which is
    // the point: structured → string → structured is what silently truncated
    // "North Carolina" to "North" on 19 live properties.
    //
    // The parse survives only as the fallback for estimates created before
    // those columns existed (28 of them in production). Those rows have
    // nothing but the one-line string, and it is ZIP-anchored now, so a
    // multi-word state comes back whole.
    setAddressSearch("");
    const hasParts = !!(
      defaults.estimateStreet1 ?? defaults.estimateCity ??
      defaults.estimateState ?? defaults.estimatePostalCode
    );
    if (hasParts) {
      setStreet1(defaults.estimateStreet1 ?? "");
      setStreet2(defaults.estimateStreet2 ?? "");
      setCity(defaults.estimateCity ?? "");
      setState(defaults.estimateState ?? "");
      setPostalCode(defaults.estimatePostalCode ?? "");
    } else {
      const parsed = parseAddressLine(defaults.estimateAddress ?? "");
      setStreet1(parsed.street1);
      setStreet2("");
      setCity(parsed.city);
      setState(parsed.state);
      setPostalCode(parsed.postalCode);
    }
    setDefaultPrice(
      defaults.proposalAmount != null ? String(defaults.proposalAmount) : ""
    );
    setEstimatedMinutes(
      defaults.estimatedMinutes != null
        ? String(defaults.estimatedMinutes)
        : ""
    );
    setJobNotes(defaults.proposalNotes ?? "");
    setClientType(["PERSON"]);
    setPropertyKind(["SINGLE"]);
    setIsRepeating(false);
    setFrequencyDays("7");
  }, [open, defaults]);

  /** Only on picking a suggestion — never on freeform typing. Fields the
   *  suggestion does not carry are left as the operator left them. */
  function fillAddressFromSearch(placeName: string) {
    const parsed = parseAddressLine(placeName);
    setStreet1(parsed.street1);
    if (parsed.city) setCity(parsed.city);
    if (parsed.state) setState(parsed.state);
    if (parsed.postalCode) setPostalCode(parsed.postalCode);
  }

  async function handleSave() {
    dlgErr.clear();
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        occurrenceId,
        clientName: clientName.trim(),
        clientType: clientType[0] ?? "PERSON",
        contactFirstName: firstName.trim(),
        contactLastName: lastName.trim(),
        contactPhone: phone.trim() || undefined,
        contactEmail: email.trim() || undefined,
        propertyName: propertyName.trim() || "Home",
        street1: street1.trim(),
        street2: street2.trim() || null,
        city: city.trim(),
        state: state.trim(),
        postalCode: postalCode.trim(),
        country: "US",
        propertyKind: propertyKind[0] ?? "SINGLE",
        jobKind: "SINGLE_ADDRESS",
      };
      if (defaultPrice.trim()) {
        const parsed = parseFloat(defaultPrice);
        if (!isNaN(parsed)) body.defaultPrice = parsed;
      }
      body.frequencyDays = isRepeating && frequencyDays ? parseInt(frequencyDays, 10) : null;
      if (estimatedMinutes.trim()) {
        const parsed = parseInt(estimatedMinutes, 10);
        if (!isNaN(parsed)) body.estimatedMinutes = parsed;
      }
      if (jobNotes.trim()) body.jobNotes = jobNotes.trim();

      await apiPost("/api/admin/convert-light-estimate", body);
      publishInlineMessage({
        type: "SUCCESS",
        text: "Estimate converted to Job Service.",
      });
      onOpenChange(false);
      onConverted?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to convert estimate.", err));
    }
    setSaving(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
      initialFocusEl={() => cancelRef.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            mx="4"
            maxW="md"
            w="full"
            rounded="2xl"
            p="4"
            shadow="lg"
          >
            <Dialog.Header>
              <Dialog.Title>Convert Estimate to Job Service</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body overflowY="auto" maxH="70vh">
              <VStack align="stretch" gap={3}>
                {/* Info box */}
                <Box
                  bg="green.50"
                  border="1px solid"
                  borderColor="green.200"
                  rounded="md"
                  p={3}
                >
                  <Text fontSize="sm" color="green.700">
                    This will create a new Client, Property, and Job Service
                    from this estimate.
                  </Text>
                </Box>

                {/* ── Section 1: Client Info ── */}
                <Text fontWeight="semibold" fontSize="sm" mt={3} mb={1}>
                  Client Info
                </Text>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Client Name
                  </Text>
                  <input
                    type="text"
                    placeholder="Client name"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    style={inputStyle}
                  />
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Client Type
                  </Text>
                  <Select.Root
                    collection={clientTypeCollection}
                    value={clientType}
                    onValueChange={(e) => setClientType(e.value)}
                    size="sm"
                    positioning={{
                      strategy: "fixed",
                      hideWhenDetached: true,
                    }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Select type" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {clientTypeCollection.items.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                            <Select.ItemIndicator />
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </Box>

                {/* ── Section 2: Primary Contact ── */}
                <Text fontWeight="semibold" fontSize="sm" mt={3} mb={1}>
                  Primary Contact
                </Text>
                <HStack gap={2}>
                  <Box flex="1">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      First Name
                    </Text>
                    <input
                      type="text"
                      placeholder="First"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      style={inputStyle}
                    />
                  </Box>
                  <Box flex="1">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      Last Name
                    </Text>
                    <input
                      type="text"
                      placeholder="Last"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      style={inputStyle}
                    />
                  </Box>
                </HStack>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Phone
                  </Text>
                  <input
                    type="text"
                    placeholder="Phone number"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    style={inputStyle}
                  />
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Email
                  </Text>
                  <input
                    type="email"
                    placeholder="Email (optional)"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={inputStyle}
                  />
                </Box>

                {/* ── Section 3: Property ── */}
                <Text fontWeight="semibold" fontSize="sm" mt={3} mb={1}>
                  Property
                </Text>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Property Name
                  </Text>
                  <input
                    type="text"
                    placeholder="e.g., Home"
                    value={propertyName}
                    onChange={(e) => setPropertyName(e.target.value)}
                    style={inputStyle}
                  />
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Address
                  </Text>
                  <AddressSearchField
                    value={addressSearch}
                    onChange={setAddressSearch}
                    onSelect={fillAddressFromSearch}
                    label="Search to correct or fill in the address"
                  />
                </Box>
                <HStack gap={2}>
                  <Box flex="2">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      Street
                    </Text>
                    <input
                      type="text"
                      placeholder="Street"
                      value={street1}
                      onChange={(e) => setStreet1(e.target.value)}
                      style={inputStyle}
                    />
                  </Box>
                  <Box flex="1">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      Apt / Unit
                    </Text>
                    <input
                      type="text"
                      placeholder="Optional"
                      value={street2}
                      onChange={(e) => setStreet2(e.target.value)}
                      style={inputStyle}
                    />
                  </Box>
                </HStack>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    City
                  </Text>
                  <input
                    type="text"
                    placeholder="City"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    style={inputStyle}
                  />
                </Box>
                <HStack gap={2}>
                  <Box flex="1">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      State
                    </Text>
                    <input
                      type="text"
                      placeholder="State"
                      value={state}
                      onChange={(e) => setState(e.target.value)}
                      style={inputStyle}
                    />
                  </Box>
                  <Box flex="1">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      Postal Code
                    </Text>
                    <input
                      type="text"
                      placeholder="Zip"
                      value={postalCode}
                      onChange={(e) => setPostalCode(e.target.value)}
                      style={inputStyle}
                    />
                  </Box>
                </HStack>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Property Type
                  </Text>
                  <Select.Root
                    collection={propertyTypeCollection}
                    value={propertyKind}
                    onValueChange={(e) => setPropertyKind(e.value)}
                    size="sm"
                    positioning={{
                      strategy: "fixed",
                      hideWhenDetached: true,
                    }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Select type" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {propertyTypeCollection.items.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                            <Select.ItemIndicator />
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </Box>

                {/* ── Section 4: Job Details ── */}
                <Text fontWeight="semibold" fontSize="sm" mt={3} mb={1}>
                  Job Details
                </Text>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Default Price
                  </Text>
                  <CurrencyInput value={defaultPrice} onChange={setDefaultPrice} placeholder="250.00" size="sm" />
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Job Type</Text>
                  <HStack gap={2} mb={2}>
                    <Button
                      size="sm"
                      variant={!isRepeating ? "solid" : "outline"}
                      colorPalette={!isRepeating ? "cyan" : "gray"}
                      onClick={() => setIsRepeating(false)}
                    >
                      One-Off
                    </Button>
                    <Button
                      size="sm"
                      variant={isRepeating ? "solid" : "outline"}
                      colorPalette={isRepeating ? "blue" : "gray"}
                      onClick={() => setIsRepeating(true)}
                    >
                      Repeating
                    </Button>
                  </HStack>
                  {isRepeating && (
                    <Box>
                      <Text fontSize="xs" color="fg.muted" mb={1}>Repeat every (days)</Text>
                      <input
                        type="number"
                        value={frequencyDays}
                        onChange={(e) => setFrequencyDays(e.target.value)}
                        min="1"
                        placeholder="e.g., 7"
                        style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                      />
                    </Box>
                  )}
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Estimated Minutes
                  </Text>
                  <input
                    type="number"
                    placeholder="e.g., 60"
                    value={estimatedMinutes}
                    onChange={(e) => setEstimatedMinutes(e.target.value)}
                    min="0"
                    style={inputStyle}
                  />
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Job Notes
                  </Text>
                  <textarea
                    placeholder="Notes (optional)"
                    value={jobNotes}
                    onChange={(e) => setJobNotes(e.target.value)}
                    rows={3}
                    style={{
                      ...inputStyle,
                      resize: "vertical",
                    }}
                  />
                </Box>
              </VStack>
            </Dialog.Body>
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
            <Dialog.Footer>
              <HStack justify="flex-end" gap={2}>
                <Button
                  ref={cancelRef}
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  colorPalette="green"
                  disabled={!clientName.trim() || !firstName.trim() || saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Spinner size="sm" /> : "Create Job Service"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
