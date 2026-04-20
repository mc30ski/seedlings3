"use client";

import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Switch,
  Text,
  VStack,
} from "@chakra-ui/react";
import { X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
import { bizDateKey, clientLabel, fmtDate, jobTypeLabel } from "@/src/lib/lib";
import { type WorkerOccurrence } from "@/src/lib/types";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type EditTask = {
  id: string;
  title?: string | null;
  notes?: string | null;
  startAt?: string | null;
  isHighPriority?: boolean;
  linkedOccurrenceId?: string | null;
  linkedOccurrence?: {
    id: string;
    startAt?: string | null;
    status: string;
    workflow?: string;
    jobType?: string | null;
    job?: { id: string; property: { id: string; displayName: string; client?: { displayName?: string } } } | null;
  } | null;
};

type OccItem = {
  id: string;
  propertyName: string;
  clientName: string;
  workflow: string;
  jobType: string;
  date: string;
  status: string;
  price: number | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  editTask?: EditTask | null;
  mode?: "task" | "reminder";
};

export default function TaskDialog({ open, onOpenChange, onCreated, editTask, mode = "task" }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => bizDateKey(new Date()));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [isHighPriority, setIsHighPriority] = useState(false);
  const isEdit = !!editTask;

  // Occurrence linking
  const [occSearch, setOccSearch] = useState("");
  const [occurrences, setOccurrences] = useState<OccItem[]>([]);
  const [selectedOcc, setSelectedOcc] = useState<OccItem | null>(null);
  const [showOccResults, setShowOccResults] = useState(false);

  useEffect(() => {
    if (!open) return;
    apiGet<WorkerOccurrence[]>(`/api/occurrences?from=${bizDateKey(new Date())}`)
      .then((list) => {
        const items: OccItem[] = (Array.isArray(list) ? list : [])
          .filter((o) => o.workflow !== "TASK" && o.workflow !== "REMINDER" && o.job)
          .map((o) => ({
            id: o.id,
            propertyName: o.job?.property?.displayName ?? "",
            clientName: o.job?.property?.client?.displayName ?? "",
            workflow: o.workflow ?? "STANDARD",
            jobType: (o as any).jobType ?? "",
            date: o.startAt ?? "",
            status: o.status,
            price: o.price ?? null,
          }));
        setOccurrences(items);
      })
      .catch(() => setOccurrences([]));

    if (editTask) {
      setTitle(editTask.title ?? "");
      setDate(editTask.startAt ? bizDateKey(editTask.startAt) : bizDateKey(new Date()));
      setNotes(editTask.notes ?? "");
      setIsHighPriority(editTask.isHighPriority ?? false);
      if (editTask.linkedOccurrence) {
        const lo = editTask.linkedOccurrence;
        setSelectedOcc({
          id: lo.id,
          propertyName: lo.job?.property?.displayName ?? "",
          clientName: lo.job?.property?.client?.displayName ?? "",
          workflow: lo.workflow ?? "STANDARD",
          jobType: lo.jobType ?? "",
          date: lo.startAt ?? "",
          status: lo.status,
          price: null,
        });
      } else {
        setSelectedOcc(null);
      }
    } else {
      setTitle("");
      setDate(bizDateKey(new Date()));
      setNotes("");
      setSelectedOcc(null);
    }
    setOccSearch("");
    setShowOccResults(false);
  }, [open, editTask]);

  const filteredOccs = occSearch.trim()
    ? occurrences.filter((o) => {
        const q = occSearch.toLowerCase();
        return (
          o.propertyName.toLowerCase().includes(q) ||
          o.clientName.toLowerCase().includes(q) ||
          o.jobType.toLowerCase().includes(q)
        );
      }).slice(0, 10)
    : occurrences.slice(0, 10);

  function reset() {
    setTitle("");
    setDate(bizDateKey(new Date()));
    setNotes("");
    setIsHighPriority(false);
    setOccSearch("");
    setSelectedOcc(null);
    setShowOccResults(false);
  }

  function workflowLabel(wf: string): string {
    if (wf === "ONE_OFF") return "One-off";
    if (wf === "ESTIMATE") return "Estimate";
    return "Repeating";
  }

  const isReminder = mode === "reminder";
  const entityLabel = isReminder ? "Reminder" : "Task";
  const apiBase = isReminder ? "/api/standalone-reminders" : "/api/tasks";

  async function handleSave() {
    if (!title.trim() || !date) return;
    setSaving(true);
    try {
      if (isEdit) {
        await apiPatch(`${apiBase}/${editTask!.id}`, {
          title: title.trim(),
          startAt: date + "T09:00:00",
          notes: notes.trim() || null,
          linkedOccurrenceId: selectedOcc?.id || null,
          ...(isReminder ? { isHighPriority } : {}),
        });
        publishInlineMessage({ type: "SUCCESS", text: `${entityLabel} updated.` });
      } else {
        await apiPost(apiBase, {
          title: title.trim(),
          startAt: date + "T09:00:00",
          notes: notes.trim() || undefined,
          linkedOccurrenceId: selectedOcc?.id || undefined,
          ...(isReminder ? { isHighPriority } : {}),
        });
        publishInlineMessage({ type: "SUCCESS", text: `${entityLabel} created.` });
      }
      reset();
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage(isEdit ? `Failed to update ${entityLabel.toLowerCase()}.` : `Failed to create ${entityLabel.toLowerCase()}.`, err) });
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
              <Dialog.Title>{isEdit ? `Edit ${entityLabel}` : `New ${entityLabel}`}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {isReminder && (
                  <HStack justify="space-between" align="center">
                    <Text fontSize="sm" fontWeight="medium">High Priority</Text>
                    <Switch.Root checked={isHighPriority} onCheckedChange={(e) => setIsHighPriority(e.checked)} colorPalette="red" size="sm">
                      <Switch.HiddenInput />
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Root>
                  </HStack>
                )}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Title *</Text>
                  <input
                    type="text"
                    placeholder="e.g., Buy mulch for Harrington"
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
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Link to Job Occurrence <Text as="span" fontSize="xs" color="fg.muted" fontWeight="normal">(optional)</Text></Text>
                  {selectedOcc ? (
                    <HStack gap={2} p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="md">
                      <VStack align="start" gap={0.5} flex="1" minW={0}>
                        <Text fontSize="sm" fontWeight="medium">{selectedOcc.propertyName}</Text>
                        <HStack gap={1} fontSize="xs" wrap="wrap">
                          {selectedOcc.clientName && <Text color="fg.muted">{clientLabel(selectedOcc.clientName)}</Text>}
                          <Badge colorPalette={selectedOcc.workflow === "ONE_OFF" ? "cyan" : selectedOcc.workflow === "ESTIMATE" ? "purple" : "blue"} variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                            {workflowLabel(selectedOcc.workflow)}
                          </Badge>
                          {selectedOcc.jobType && <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">{jobTypeLabel(selectedOcc.jobType)}</Badge>}
                          {selectedOcc.date && <Text color="fg.muted">{fmtDate(selectedOcc.date)}</Text>}
                        </HStack>
                      </VStack>
                      <Button size="xs" variant="ghost" px="1" minW="0" onClick={() => setSelectedOcc(null)}>
                        <X size={14} />
                      </Button>
                    </HStack>
                  ) : (
                    <Box position="relative">
                      <input
                        type="text"
                        placeholder="Search by property, client, or job type..."
                        value={occSearch}
                        onChange={(e) => { setOccSearch(e.target.value); setShowOccResults(true); }}
                        onFocus={() => setShowOccResults(true)}
                        style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                      />
                      {showOccResults && filteredOccs.length > 0 && (
                        <Box
                          position="absolute"
                          top="100%"
                          left="0"
                          right="0"
                          zIndex={10}
                          bg="white"
                          borderWidth="1px"
                          borderColor="gray.200"
                          rounded="md"
                          shadow="md"
                          maxH="250px"
                          overflowY="auto"
                          mt="1"
                        >
                          {filteredOccs.map((o) => (
                            <Box
                              key={o.id}
                              px={3}
                              py={2}
                              cursor="pointer"
                              _hover={{ bg: "blue.50" }}
                              borderBottomWidth="1px"
                              borderColor="gray.100"
                              onClick={() => {
                                setSelectedOcc(o);
                                setOccSearch("");
                                setShowOccResults(false);
                              }}
                            >
                              <Text fontSize="sm" fontWeight="medium">{o.propertyName}</Text>
                              <HStack gap={1} fontSize="xs" wrap="wrap" mt={0.5}>
                                {o.clientName && <Text color="fg.muted">{clientLabel(o.clientName)}</Text>}
                                <Badge colorPalette={o.workflow === "ONE_OFF" ? "cyan" : o.workflow === "ESTIMATE" ? "purple" : "blue"} variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                                  {workflowLabel(o.workflow)}
                                </Badge>
                                {o.jobType && <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">{jobTypeLabel(o.jobType)}</Badge>}
                                {o.date && <Text color="fg.muted">{fmtDate(o.date)}</Text>}
                                <Badge colorPalette={o.status === "SCHEDULED" ? "green" : o.status === "COMPLETED" ? "gray" : "blue"} variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                                  {o.status}
                                </Badge>
                              </HStack>
                            </Box>
                          ))}
                        </Box>
                      )}
                      {showOccResults && occSearch.trim() && filteredOccs.length === 0 && (
                        <Box position="absolute" top="100%" left="0" right="0" zIndex={10} bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="md" mt="1" p={3}>
                          <Text fontSize="xs" color="fg.muted">No occurrences found</Text>
                        </Box>
                      )}
                    </Box>
                  )}
                  <Text fontSize="xs" color="fg.muted" mt={1}>Optional — link this {entityLabel.toLowerCase()} to a specific job occurrence</Text>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" gap={2}>
                <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button
                  colorPalette={isReminder ? "purple" : "blue"}
                  disabled={!title.trim() || !date || saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Spinner size="sm" /> : isEdit ? `Save ${entityLabel}` : `Create ${entityLabel}`}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
