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
import DateInput from "@/src/ui/components/DateInput";
import { apiPost, apiPatch } from "@/src/lib/api";
import { bizDateKey } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type EditAnnouncement = {
  id: string;
  title?: string | null;
  notes?: string | null;
  startAt?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  editAnnouncement?: EditAnnouncement | null;
};

export default function AnnouncementDialog({ open, onOpenChange, onCreated, editAnnouncement }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => bizDateKey(new Date()));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const isEdit = !!editAnnouncement;

  useEffect(() => {
    if (!open) return;
    if (editAnnouncement) {
      setTitle(editAnnouncement.title ?? "");
      setDate(editAnnouncement.startAt ? bizDateKey(editAnnouncement.startAt) : bizDateKey(new Date()));
      setNotes(editAnnouncement.notes ?? "");
    } else {
      reset();
    }
  }, [open, editAnnouncement]);

  function reset() {
    setTitle("");
    setDate(bizDateKey(new Date()));
    setNotes("");
  }

  async function handleSave() {
    if (!title.trim() || !date) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        startAt: new Date(date + "T09:00").toISOString(),
        notes: notes.trim() || null,
      };

      if (isEdit) {
        await apiPatch(`/api/admin/announcements/${editAnnouncement!.id}`, body);
        publishInlineMessage({ type: "SUCCESS", text: "Announcement updated." });
      } else {
        await apiPost("/api/admin/announcements", body);
        publishInlineMessage({ type: "SUCCESS", text: "Announcement created." });
      }
      reset();
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to save announcement.", err) });
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
              <Dialog.Title>{isEdit ? "Edit Announcement" : "New Announcement"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box px={3} py={2} bg="#DDD6FE" borderWidth="1px" borderColor="#6D28D9" borderRadius="md">
                  <Text fontSize="xs" color="#4C1D95" fontWeight="medium">
                    Everyone — visible to all workers and admins
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Title *</Text>
                  <input
                    type="text"
                    placeholder="e.g., Office closed Friday"
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
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" gap={2}>
                <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button
                  colorPalette="purple"
                  disabled={!title.trim() || !date || saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Spinner size="sm" /> : isEdit ? "Save Announcement" : "Create Announcement"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
