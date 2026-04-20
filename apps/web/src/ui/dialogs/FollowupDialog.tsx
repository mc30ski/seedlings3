"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Spinner,
  Switch,
  Text,
  VStack,
} from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
import { bizDateKey } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type ClientItem = { id: string; displayName: string };
type JobItem = { id: string; propertyName: string; clientName: string };

type EditFollowup = {
  id: string;
  title?: string | null;
  notes?: string | null;
  startAt?: string | null;
  frequencyDays?: number | null;
  followupClients?: { client: ClientItem }[];
  followupJobs?: { job: { id: string; property: { id: string; displayName: string; client?: { id: string; displayName: string } | null } } }[];
};

function freqToMode(days: number | null | undefined): { mode: "weekly" | "monthly" | "yearly" | "custom"; custom: string } {
  if (!days || days <= 0) return { mode: "weekly", custom: "14" };
  if (days === 7) return { mode: "weekly", custom: "14" };
  if (days === 30) return { mode: "monthly", custom: "14" };
  if (days === 365) return { mode: "yearly", custom: "14" };
  return { mode: "custom", custom: String(days) };
}

function modeToDays(mode: "weekly" | "monthly" | "yearly" | "custom", custom: string): number {
  if (mode === "weekly") return 7;
  if (mode === "monthly") return 30;
  if (mode === "yearly") return 365;
  const n = Number(custom);
  return isNaN(n) || n < 1 ? 7 : n;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  editFollowup?: EditFollowup | null;
};

export default function FollowupDialog({ open, onOpenChange, onCreated, editFollowup }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => bizDateKey(new Date()));
  const [notes, setNotes] = useState("");
  const [isRepeating, setIsRepeating] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"weekly" | "monthly" | "yearly" | "custom">("weekly");
  const [customDays, setCustomDays] = useState("14");
  const [saving, setSaving] = useState(false);
  const isEdit = !!editFollowup;

  // Client picker
  const [allClients, setAllClients] = useState<ClientItem[]>([]);
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const [clientSelectValue, setClientSelectValue] = useState<string[]>([]);

  // Job service picker
  const [allJobs, setAllJobs] = useState<JobItem[]>([]);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [jobSelectValue, setJobSelectValue] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;

    // Load clients and jobs
    (async () => {
      try {
        const [clients, jobs] = await Promise.all([
          apiGet<any[]>("/api/admin/clients"),
          apiGet<any[]>("/api/admin/jobs?status=ALL"),
        ]);
        setAllClients(
          (Array.isArray(clients) ? clients : []).map((c) => ({ id: c.id, displayName: c.displayName }))
        );
        setAllJobs(
          (Array.isArray(jobs) ? jobs : []).map((j) => ({
            id: j.id,
            propertyName: j.property?.displayName ?? "Unknown",
            clientName: j.property?.client?.displayName ?? "",
          }))
        );
      } catch {
        setAllClients([]);
        setAllJobs([]);
      }
    })();

    if (editFollowup) {
      setTitle(editFollowup.title ?? "");
      setDate(editFollowup.startAt ? bizDateKey(editFollowup.startAt) : bizDateKey(new Date()));
      setNotes(editFollowup.notes ?? "");
      const freq = editFollowup.frequencyDays;
      setIsRepeating(freq != null && freq > 0);
      const parsed = freqToMode(freq);
      setRepeatMode(parsed.mode);
      setCustomDays(parsed.custom);
      setSelectedClientIds(editFollowup.followupClients?.map((fc) => fc.client.id) ?? []);
      setSelectedJobIds(editFollowup.followupJobs?.map((fj) => fj.job.id) ?? []);
    } else {
      reset();
    }
    setClientSelectValue([]);
    setJobSelectValue([]);
  }, [open, editFollowup]);

  const availableClients = useMemo(
    () => allClients.filter((c) => !selectedClientIds.includes(c.id)),
    [allClients, selectedClientIds]
  );
  const clientItems = useMemo(
    () => availableClients.map((c) => ({ label: c.displayName, value: c.id })),
    [availableClients]
  );
  const clientCollection = useMemo(
    () => createListCollection({ items: clientItems }),
    [clientItems]
  );

  const availableJobs = useMemo(
    () => allJobs.filter((j) => !selectedJobIds.includes(j.id)),
    [allJobs, selectedJobIds]
  );
  const jobItems = useMemo(
    () => availableJobs.map((j) => ({
      label: `${j.propertyName}${j.clientName ? ` — ${j.clientName}` : ""}`,
      value: j.id,
    })),
    [availableJobs]
  );
  const jobCollection = useMemo(
    () => createListCollection({ items: jobItems }),
    [jobItems]
  );

  function clientLabel(id: string) {
    return allClients.find((c) => c.id === id)?.displayName ?? id;
  }
  function jobLabel(id: string) {
    const j = allJobs.find((j) => j.id === id);
    return j ? `${j.propertyName}${j.clientName ? ` — ${j.clientName}` : ""}` : id;
  }

  function reset() {
    setTitle("");
    setDate(bizDateKey(new Date()));
    setNotes("");
    setIsRepeating(false);
    setRepeatMode("weekly");
    setCustomDays("14");
    setSelectedClientIds([]);
    setSelectedJobIds([]);
    setClientSelectValue([]);
    setJobSelectValue([]);
  }

  async function handleSave() {
    if (!title.trim() || !date) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        startAt: date + "T09:00:00",
        notes: notes.trim() || null,
        frequencyDays: isRepeating ? modeToDays(repeatMode, customDays) : null,
        clientIds: selectedClientIds,
        jobIds: selectedJobIds,
      };

      if (isEdit) {
        await apiPatch(`/api/admin/followups/${editFollowup!.id}`, body);
        publishInlineMessage({ type: "SUCCESS", text: "Followup updated." });
      } else {
        await apiPost("/api/admin/followups", body);
        publishInlineMessage({ type: "SUCCESS", text: "Followup created." });
      }
      reset();
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to save followup.", err) });
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
              <Dialog.Title>{isEdit ? "Edit Followup" : "New Followup"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Title *</Text>
                  <input
                    type="text"
                    placeholder="e.g., Follow up on pricing with Smith"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                    autoFocus
                  />
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Date *</Text>
                  <DateInput value={date} onChange={setDate} />
                </Box>
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

                {/* Clients */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Clients <Text as="span" fontSize="xs" color="fg.muted" fontWeight="normal">(optional)</Text></Text>
                  {selectedClientIds.length > 0 && (
                    <VStack align="stretch" gap={1} mb={2}>
                      {selectedClientIds.map((id) => (
                        <HStack key={id} px={2} py={1} rounded="md" borderWidth="1px" borderColor="gray.200" justify="space-between">
                          <Text fontSize="sm">{clientLabel(id)}</Text>
                          <Button size="xs" variant="ghost" px="1" minW="0" onClick={() => setSelectedClientIds((prev) => prev.filter((c) => c !== id))}>
                            <X size={14} />
                          </Button>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                  <HStack gap={2}>
                    <Box flex="1">
                      <Select.Root
                        collection={clientCollection}
                        value={clientSelectValue}
                        onValueChange={(e) => setClientSelectValue(e.value)}
                        multiple
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText placeholder={availableClients.length === 0 ? "No clients available" : "Select clients"} />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {clientItems.map((it) => (
                              <Select.Item key={it.value} item={it.value}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                                <Select.ItemIndicator />
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                    </Box>
                    <Button size="sm" onClick={() => { setSelectedClientIds((prev) => [...prev, ...clientSelectValue.filter((id) => !prev.includes(id))]); setClientSelectValue([]); }} disabled={clientSelectValue.length === 0}>
                      Add
                    </Button>
                  </HStack>
                </Box>

                {/* Job Services */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Job Services <Text as="span" fontSize="xs" color="fg.muted" fontWeight="normal">(optional)</Text></Text>
                  {selectedJobIds.length > 0 && (
                    <VStack align="stretch" gap={1} mb={2}>
                      {selectedJobIds.map((id) => (
                        <HStack key={id} px={2} py={1} rounded="md" borderWidth="1px" borderColor="gray.200" justify="space-between">
                          <Text fontSize="sm">{jobLabel(id)}</Text>
                          <Button size="xs" variant="ghost" px="1" minW="0" onClick={() => setSelectedJobIds((prev) => prev.filter((j) => j !== id))}>
                            <X size={14} />
                          </Button>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                  <HStack gap={2}>
                    <Box flex="1">
                      <Select.Root
                        collection={jobCollection}
                        value={jobSelectValue}
                        onValueChange={(e) => setJobSelectValue(e.value)}
                        multiple
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText placeholder={availableJobs.length === 0 ? "No jobs available" : "Select job services"} />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {jobItems.map((it) => (
                              <Select.Item key={it.value} item={it.value}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                                <Select.ItemIndicator />
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                    </Box>
                    <Button size="sm" onClick={() => { setSelectedJobIds((prev) => [...prev, ...jobSelectValue.filter((id) => !prev.includes(id))]); setJobSelectValue([]); }} disabled={jobSelectValue.length === 0}>
                      Add
                    </Button>
                  </HStack>
                </Box>

                <HStack justify="space-between" align="center">
                  <Text fontSize="sm" fontWeight="medium">Repeating</Text>
                  <Switch.Root checked={isRepeating} onCheckedChange={(e) => setIsRepeating(e.checked)} colorPalette="blue" size="sm">
                    <Switch.HiddenInput />
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Root>
                </HStack>
                {isRepeating && (
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Repeat every</Text>
                    <HStack gap={2} wrap="wrap">
                      {([
                        { value: "weekly", label: "Week" },
                        { value: "monthly", label: "Month" },
                        { value: "yearly", label: "Year" },
                        { value: "custom", label: "Custom" },
                      ] as const).map((opt) => (
                        <Button
                          key={opt.value}
                          size="xs"
                          variant={repeatMode === opt.value ? "solid" : "outline"}
                          colorPalette={repeatMode === opt.value ? "blue" : "gray"}
                          onClick={() => setRepeatMode(opt.value)}
                        >
                          {opt.label}
                        </Button>
                      ))}
                    </HStack>
                    {repeatMode === "custom" && (
                      <HStack mt={2} gap={2} align="center">
                        <Input
                          type="number"
                          size="sm"
                          min={1}
                          w="80px"
                          value={customDays}
                          onChange={(e) => setCustomDays(e.target.value)}
                        />
                        <Text fontSize="sm" color="fg.muted">days</Text>
                      </HStack>
                    )}
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" gap={2}>
                <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button
                  colorPalette="red"
                  disabled={!title.trim() || !date || saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Spinner size="sm" /> : isEdit ? "Save Followup" : "Create Followup"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
