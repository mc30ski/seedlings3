"use client";

import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Switch,
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
  frequencyDays?: number | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  editAnnouncement?: EditAnnouncement | null;
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

export default function AnnouncementDialog({ open, onOpenChange, onCreated, editAnnouncement }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => bizDateKey(new Date()));
  const [notes, setNotes] = useState("");
  const [isRepeating, setIsRepeating] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"weekly" | "monthly" | "yearly" | "custom">("weekly");
  const [customDays, setCustomDays] = useState("14");
  const [saving, setSaving] = useState(false);
  const isEdit = !!editAnnouncement;

  useEffect(() => {
    if (!open) return;
    if (editAnnouncement) {
      setTitle(editAnnouncement.title ?? "");
      setDate(editAnnouncement.startAt ? bizDateKey(editAnnouncement.startAt) : bizDateKey(new Date()));
      setNotes(editAnnouncement.notes ?? "");
      const freq = editAnnouncement.frequencyDays;
      setIsRepeating(freq != null && freq > 0);
      const parsed = freqToMode(freq);
      setRepeatMode(parsed.mode);
      setCustomDays(parsed.custom);
    } else {
      reset();
    }
  }, [open, editAnnouncement]);

  function reset() {
    setTitle("");
    setDate(bizDateKey(new Date()));
    setNotes("");
    setIsRepeating(false);
    setRepeatMode("weekly");
    setCustomDays("14");
  }

  async function handleSave() {
    if (!title.trim() || !date) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        startAt: new Date(date + "T09:00").toISOString(),
        notes: notes.trim() || null,
        frequencyDays: isRepeating ? modeToDays(repeatMode, customDays) : null,
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
