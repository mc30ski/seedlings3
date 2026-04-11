"use client";

import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiGet, apiPost, apiPatch } from "@/src/lib/api";
import { bizDateKey, clientLabel } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type JobItem = {
  id: string;
  status: string;
  property: { id: string; displayName: string; client?: { displayName?: string } };
};

type EditTask = {
  id: string;
  title?: string | null;
  notes?: string | null;
  startAt?: string | null;
  jobId?: string | null;
  job?: { id: string; property: { id: string; displayName: string; client?: { displayName?: string } } } | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  editTask?: EditTask | null;
};

export default function TaskDialog({ open, onOpenChange, onCreated, editTask }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => bizDateKey(new Date()));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const isEdit = !!editTask;

  // Job association
  const [jobSearch, setJobSearch] = useState("");
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobItem | null>(null);
  const [showJobResults, setShowJobResults] = useState(false);

  useEffect(() => {
    if (!open) return;
    apiGet<JobItem[]>("/api/jobs")
      .then((list) => setJobs(Array.isArray(list) ? list : []))
      .catch(() => setJobs([]));

    if (editTask) {
      setTitle(editTask.title ?? "");
      setDate(editTask.startAt ? bizDateKey(editTask.startAt) : bizDateKey(new Date()));
      setNotes(editTask.notes ?? "");
      if (editTask.job) {
        setSelectedJob({
          id: editTask.job.id,
          status: "",
          property: editTask.job.property,
        });
      } else {
        setSelectedJob(null);
      }
    } else {
      setTitle("");
      setDate(bizDateKey(new Date()));
      setNotes("");
      setSelectedJob(null);
    }
    setJobSearch("");
    setShowJobResults(false);
  }, [open, editTask]);

  const filteredJobs = jobSearch.trim()
    ? jobs.filter((j) => {
        const q = jobSearch.toLowerCase();
        return (
          j.property.displayName.toLowerCase().includes(q) ||
          (j.property.client?.displayName ?? "").toLowerCase().includes(q)
        );
      }).slice(0, 8)
    : jobs.slice(0, 8);

  function reset() {
    setTitle("");
    setDate(bizDateKey(new Date()));
    setNotes("");
    setJobSearch("");
    setSelectedJob(null);
    setShowJobResults(false);
  }

  async function handleSave() {
    if (!title.trim() || !date) return;
    setSaving(true);
    try {
      if (isEdit) {
        await apiPatch(`/api/tasks/${editTask!.id}`, {
          title: title.trim(),
          startAt: date + "T09:00:00",
          notes: notes.trim() || null,
          jobId: selectedJob?.id || null,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Task updated." });
      } else {
        await apiPost("/api/tasks", {
          title: title.trim(),
          startAt: date + "T09:00:00",
          notes: notes.trim() || undefined,
          jobId: selectedJob?.id || undefined,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Task created." });
      }
      reset();
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage(isEdit ? "Failed to update task." : "Failed to create task.", err) });
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
          <Dialog.Content maxW="sm">
            <Dialog.Header>
              <Dialog.Title>{isEdit ? "Edit Task" : "New Task"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
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
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Link to Job</Text>
                  {selectedJob ? (
                    <HStack gap={2} p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="md">
                      <VStack align="start" gap={0} flex="1" minW={0}>
                        <Text fontSize="sm" fontWeight="medium">{selectedJob.property.displayName}</Text>
                        {selectedJob.property.client?.displayName && (
                          <Text fontSize="xs" color="fg.muted">{clientLabel(selectedJob.property.client.displayName)}</Text>
                        )}
                      </VStack>
                      <Button size="xs" variant="ghost" px="1" minW="0" onClick={() => setSelectedJob(null)}>
                        <X size={14} />
                      </Button>
                    </HStack>
                  ) : (
                    <Box position="relative">
                      <input
                        type="text"
                        placeholder="Search by property or client name..."
                        value={jobSearch}
                        onChange={(e) => { setJobSearch(e.target.value); setShowJobResults(true); }}
                        onFocus={() => setShowJobResults(true)}
                        style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                      />
                      {showJobResults && filteredJobs.length > 0 && (
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
                          maxH="200px"
                          overflowY="auto"
                          mt="1"
                        >
                          {filteredJobs.map((j) => (
                            <Box
                              key={j.id}
                              px={3}
                              py={2}
                              cursor="pointer"
                              _hover={{ bg: "blue.50" }}
                              onClick={() => {
                                setSelectedJob(j);
                                setJobSearch("");
                                setShowJobResults(false);
                              }}
                            >
                              <Text fontSize="sm">{j.property.displayName}</Text>
                              {j.property.client?.displayName && (
                                <Text fontSize="xs" color="fg.muted">{clientLabel(j.property.client.displayName)}</Text>
                              )}
                            </Box>
                          ))}
                        </Box>
                      )}
                      {showJobResults && jobSearch.trim() && filteredJobs.length === 0 && (
                        <Box position="absolute" top="100%" left="0" right="0" zIndex={10} bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="md" mt="1" p={3}>
                          <Text fontSize="xs" color="fg.muted">No jobs found</Text>
                        </Box>
                      )}
                    </Box>
                  )}
                  <Text fontSize="xs" color="fg.muted" mt={1}>Optional — link this task to an existing job</Text>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" gap={2}>
                <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button
                  colorPalette="blue"
                  disabled={!title.trim() || !date || saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Spinner size="sm" /> : isEdit ? "Save Changes" : "Create Task"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
