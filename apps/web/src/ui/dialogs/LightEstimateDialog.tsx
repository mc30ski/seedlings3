"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import AddressAutocomplete from "@/src/ui/components/AddressAutocomplete";

type WorkerLite = {
  id: string;
  displayName?: string | null;
  email?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  myId?: string;
};

export default function LightEstimateDialog({ open, onOpenChange, onCreated, myId }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [contactFirstName, setContactFirstName] = useState("");
  const [contactLastName, setContactLastName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [estimateAddress, setEstimateAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [proposalAmount, setProposalAmount] = useState("");
  const [saving, setSaving] = useState(false);

  // Assignee picker
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [selectValue, setSelectValue] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    reset();
    (async () => {
      try {
        const list = await apiGet<WorkerLite[]>("/api/admin/users?role=WORKER&approved=true");
        setWorkers(Array.isArray(list) ? list : []);
      } catch {
        setWorkers([]);
      }
    })();
  }, [open]);

  const availableWorkers = useMemo(
    () => workers.filter((w) => !assigneeIds.includes(w.id)),
    [workers, assigneeIds]
  );

  const workerItems = useMemo(
    () => availableWorkers.map((w) => ({ label: w.displayName ?? w.email ?? w.id, value: w.id })),
    [availableWorkers]
  );

  const workerCollection = useMemo(
    () => createListCollection({ items: workerItems }),
    [workerItems]
  );

  function addSelected() {
    setAssigneeIds((prev) => [...prev, ...selectValue.filter((id) => !prev.includes(id))]);
    setSelectValue([]);
  }

  function removeAssignee(userId: string) {
    setAssigneeIds((prev) => prev.filter((id) => id !== userId));
  }

  function workerLabel(userId: string): string {
    const w = workers.find((w) => w.id === userId);
    return w?.displayName ?? w?.email ?? userId;
  }

  function reset() {
    setTitle("");
    setDate("");
    setContactFirstName("");
    setContactLastName("");
    setContactPhone("");
    setPhoneError("");
    setContactEmail("");
    setEmailError("");
    setEstimateAddress("");
    setNotes("");
    setProposalAmount("");
    setAssigneeIds(myId ? [myId] : []);
    setSelectValue([]);
  }

  function validatePhone(val: string) {
    if (!val.trim()) { setPhoneError(""); return; }
    const digits = val.replace(/\D/g, "");
    if (digits.length < 10) { setPhoneError("Phone must be at least 10 digits"); return; }
    setPhoneError("");
  }

  function validateEmail(val: string) {
    if (!val.trim()) { setEmailError(""); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim())) { setEmailError("Invalid email format"); return; }
    setEmailError("");
  }

  async function handleSave() {
    if (!title.trim() || !date) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        startAt: date,
        assigneeUserIds: assigneeIds,
      };
      const fullName = [contactFirstName.trim(), contactLastName.trim()].filter(Boolean).join(" ");
      if (fullName) body.contactName = fullName;
      if (contactPhone.trim()) body.contactPhone = contactPhone.trim();
      if (contactEmail.trim()) body.contactEmail = contactEmail.trim();
      if (estimateAddress.trim()) body.estimateAddress = estimateAddress.trim();
      if (notes.trim()) body.notes = notes.trim();
      if (proposalAmount.trim()) {
        const parsed = parseFloat(proposalAmount);
        if (!isNaN(parsed)) body.proposalAmount = parsed;
      }

      await apiPost("/api/admin/light-estimates", body);
      publishInlineMessage({ type: "SUCCESS", text: "Light estimate created." });
      reset();
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to create light estimate.", err) });
    }
    setSaving(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) reset();
        onOpenChange(e.open);
      }}
      initialFocusEl={() => cancelRef.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>New Estimate (Stand-alone)</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {/* Title */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Title *</Text>
                  <input
                    type="text"
                    placeholder="e.g., Smith backyard cleanup"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                    autoFocus
                  />
                </Box>

                {/* Date */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Date *</Text>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                  />
                </Box>

                {/* Contact Name */}
                <HStack gap={2}>
                  <Box flex="1">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>First Name</Text>
                    <input
                      type="text"
                      placeholder="First name"
                      value={contactFirstName}
                      onChange={(e) => setContactFirstName(e.target.value)}
                      style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                    />
                  </Box>
                  <Box flex="1">
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Last Name</Text>
                    <input
                      type="text"
                      placeholder="Last name"
                      value={contactLastName}
                      onChange={(e) => setContactLastName(e.target.value)}
                      style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                    />
                  </Box>
                </HStack>

                {/* Contact Phone */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Contact Phone</Text>
                  <input
                    type="tel"
                    placeholder="(555) 123-4567"
                    value={contactPhone}
                    onChange={(e) => {
                      setContactPhone(e.target.value);
                      validatePhone(e.target.value);
                    }}
                    onBlur={() => validatePhone(contactPhone)}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: `1px solid ${phoneError ? "#e53e3e" : "#ccc"}`, borderRadius: "6px" }}
                  />
                  {phoneError && <Text fontSize="xs" color="red.500" mt={0.5}>{phoneError}</Text>}
                </Box>

                {/* Contact Email */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Contact Email</Text>
                  <input
                    type="email"
                    placeholder="email@example.com"
                    value={contactEmail}
                    onChange={(e) => {
                      setContactEmail(e.target.value);
                      validateEmail(e.target.value);
                    }}
                    onBlur={() => validateEmail(contactEmail)}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: `1px solid ${emailError ? "#e53e3e" : "#ccc"}`, borderRadius: "6px" }}
                  />
                  {emailError && <Text fontSize="xs" color="red.500" mt={0.5}>{emailError}</Text>}
                </Box>

                {/* Address */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Address</Text>
                  <AddressAutocomplete
                    value={estimateAddress}
                    onChange={setEstimateAddress}
                    placeholder="Start typing an address..."
                  />
                </Box>

                {/* Notes */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Notes</Text>
                  <textarea
                    placeholder="Additional details (optional)"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={3}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px", resize: "vertical" }}
                  />
                </Box>

                {/* Proposal Amount */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Proposal Amount</Text>
                  <input
                    type="number"
                    placeholder="e.g., 250.00"
                    value={proposalAmount}
                    onChange={(e) => setProposalAmount(e.target.value)}
                    step="0.01"
                    min="0"
                    style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                  />
                </Box>

                {/* Assignee Picker */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Assignees</Text>
                  {assigneeIds.length > 0 && (
                    <VStack align="stretch" gap={1} mb={2}>
                      {assigneeIds.map((uid) => (
                        <HStack key={uid} px={2} py={1} rounded="md" borderWidth="1px" justify="space-between">
                          <Text fontSize="sm">{workerLabel(uid)}</Text>
                          <Button size="xs" variant="ghost" px="1" minW="0" onClick={() => removeAssignee(uid)}>
                            <X size={14} />
                          </Button>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                  <HStack gap={2} align="flex-end">
                    <Box flex="1">
                      <Select.Root
                        collection={workerCollection}
                        value={selectValue}
                        onValueChange={(e) => setSelectValue(e.value)}
                        multiple
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText
                              placeholder={
                                availableWorkers.length === 0
                                  ? "All workers assigned"
                                  : "Select workers"
                              }
                            />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {workerItems.map((it) => (
                              <Select.Item key={it.value} item={it.value}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                                <Select.ItemIndicator />
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                    </Box>
                    <Button size="sm" onClick={addSelected} disabled={selectValue.length === 0}>
                      Add
                    </Button>
                  </HStack>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" gap={2}>
                <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button
                  colorPalette="blue"
                  disabled={!title.trim() || !date || saving || !!phoneError || !!emailError}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Spinner size="sm" /> : "Create Estimate"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
