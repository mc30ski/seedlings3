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
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { bizDateKey } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import AddressAutocomplete from "@/src/ui/components/AddressAutocomplete";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import JobTagPicker from "@/src/ui/components/JobTagPicker";

type WorkerLite = {
  id: string;
  displayName?: string | null;
  email?: string | null;
};

type JobListItem = {
  id: string;
  kind: string;
  status: string;
  property?: { displayName?: string; client?: { displayName?: string } } | null;
};

type EditEstimate = {
  id: string;
  title?: string | null;
  startAt?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  estimateAddress?: string | null;
  notes?: string | null;
  proposalAmount?: number | null;
  jobId?: string | null;
  jobTags?: string | string[] | null;
  jobType?: string | null;
  assignees?: { userId: string; user?: { id: string; displayName?: string | null; email?: string | null } }[];
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  myId?: string;
  editEstimate?: EditEstimate | null;
};

export default function LightEstimateDialog({ open, onOpenChange, onCreated, myId, editEstimate }: Props) {
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
  const [jobTags, setJobTags] = useState<string[]>([]);
  const [jobTagNote, setJobTagNote] = useState("");

  // Optional Job Service link
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string[]>([]);

  // Assignee picker
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [selectValue, setSelectValue] = useState<string[]>([]);

  const isEdit = !!editEstimate;

  useEffect(() => {
    if (!open) return;
    if (editEstimate) {
      setTitle(editEstimate.title ?? "");
      setDate(editEstimate.startAt ? bizDateKey(editEstimate.startAt) : "");
      const name = editEstimate.contactName ?? "";
      const parts = name.split(/\s+/);
      setContactFirstName(parts[0] ?? "");
      setContactLastName(parts.slice(1).join(" ") ?? "");
      setContactPhone(editEstimate.contactPhone ?? "");
      setContactEmail(editEstimate.contactEmail ?? "");
      setEstimateAddress(editEstimate.estimateAddress ?? "");
      setNotes(editEstimate.notes ?? "");
      setProposalAmount(editEstimate.proposalAmount != null ? String(editEstimate.proposalAmount) : "");
      setPhoneError("");
      setEmailError("");
      setAssigneeIds(editEstimate.assignees?.map((a) => a.userId) ?? []);
      setSelectValue([]);
      setSelectedJobId(editEstimate.jobId ? [editEstimate.jobId] : []);
      const rawTags = editEstimate.jobTags;
      if (Array.isArray(rawTags)) {
        setJobTags(rawTags);
      } else if (typeof rawTags === "string" && rawTags) {
        try { setJobTags(JSON.parse(rawTags)); } catch { setJobTags([]); }
      } else {
        setJobTags([]);
      }
      setJobTagNote(editEstimate.jobType ?? "");
    } else {
      reset();
    }
    (async () => {
      try {
        const [workerList, jobList] = await Promise.all([
          apiGet<WorkerLite[]>("/api/admin/users?role=WORKER&approved=true"),
          apiGet<JobListItem[]>("/api/admin/jobs?status=ALL"),
        ]);
        setWorkers(Array.isArray(workerList) ? workerList : []);
        setJobs(Array.isArray(jobList) ? jobList : []);
      } catch {
        setWorkers([]);
        setJobs([]);
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
    setSelectedJobId([]);
    setJobTags([]);
    setJobTagNote("");
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
        startAt: date + "T12:00:00Z",
        assigneeUserIds: assigneeIds,
      };
      const fullName = [contactFirstName.trim(), contactLastName.trim()].filter(Boolean).join(" ");
      if (selectedJobId[0]) body.jobId = selectedJobId[0];
      if (fullName) body.contactName = fullName;
      if (contactPhone.trim()) body.contactPhone = contactPhone.trim();
      if (contactEmail.trim()) body.contactEmail = contactEmail.trim();
      if (estimateAddress.trim()) body.estimateAddress = estimateAddress.trim();
      if (notes.trim()) body.notes = notes.trim();
      if (proposalAmount.trim()) {
        const parsed = parseFloat(proposalAmount);
        if (!isNaN(parsed)) body.proposalAmount = parsed;
      }
      if (jobTags.length > 0) body.jobTags = jobTags;
      if (jobTagNote.trim()) body.jobType = jobTagNote.trim();

      if (isEdit) {
        await apiPatch(`/api/admin/occurrences/${editEstimate!.id}`, body);
        publishInlineMessage({ type: "SUCCESS", text: "Estimate updated." });
      } else {
        await apiPost("/api/admin/light-estimates", body);
        publishInlineMessage({ type: "SUCCESS", text: "Estimate created." });
      }
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
              <Dialog.Title>{isEdit ? "Edit Estimate" : "New Estimate"}</Dialog.Title>
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

                {/* Optional Job Service link */}
                {!selectedJobId[0] && (
                  <Box p={3} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md">
                    <Text fontSize="xs" color="yellow.800">
                      You can optionally link to an existing Job Service below. If the estimate is accepted without one, you'll be prompted to create a Client, Property, and Job Service.
                    </Text>
                  </Box>
                )}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Job Service (optional)</Text>
                  <Select.Root
                    collection={createListCollection({
                      items: [
                        { label: "None — standalone estimate", value: "" },
                        ...jobs.map((j) => ({
                          label: `${j.property?.displayName ?? "Unknown"} — ${j.property?.client?.displayName ?? ""}`.trim(),
                          value: j.id,
                        })),
                      ],
                    })}
                    value={selectedJobId}
                    onValueChange={(e) => setSelectedJobId(e.value)}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="None — standalone estimate" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        <Select.Item item="">
                          <Select.ItemText>None — standalone estimate</Select.ItemText>
                        </Select.Item>
                        {jobs.map((j) => (
                          <Select.Item key={j.id} item={j.id}>
                            <Select.ItemText>
                              {j.property?.displayName ?? "Unknown"} — {j.property?.client?.displayName ?? ""}
                            </Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                  <Text fontSize="xs" color="fg.muted" mt={1}>
                    Link to an existing Job Service. When accepted, it will create an occurrence under that job instead of starting the New Job workflow.
                  </Text>
                </Box>

                {/* Job Tags */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Job Tags</Text>
                  <JobTagPicker
                    selected={jobTags}
                    onChange={setJobTags}
                    customNote={jobTagNote}
                    onCustomNoteChange={setJobTagNote}
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
                  <CurrencyInput value={proposalAmount} onChange={setProposalAmount} placeholder="250.00" size="sm" />
                </Box>

                {/* Assignee Picker — only for create, not edit */}
                {!isEdit && (
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Assignees</Text>
                  {assigneeIds.length > 0 && (
                    <VStack align="stretch" gap={1} mb={2}>
                      {assigneeIds.map((uid) => (
                        <HStack key={uid} px={2} py={1} rounded="md" borderWidth="1px" borderColor={uid === myId ? "teal.200" : "gray.200"} bg={uid === myId ? "teal.50" : undefined} justify="space-between">
                          <Text fontSize="sm">{workerLabel(uid)}{uid === myId ? " (you)" : ""}</Text>
                          {uid !== myId && (
                            <Button size="xs" variant="ghost" px="1" minW="0" onClick={() => removeAssignee(uid)}>
                              <X size={14} />
                            </Button>
                          )}
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
                )}
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
                  {saving ? <Spinner size="sm" /> : isEdit ? "Save Estimate" : "Create Estimate"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
