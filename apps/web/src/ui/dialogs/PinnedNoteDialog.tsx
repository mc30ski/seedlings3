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
import { apiPatch } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

const PRESETS = [
  "Cut shorter",
  "Cut longer",
  "Skip backyard",
  "Skip front yard",
  "Bag clippings",
  "Double cut",
  "Edge only",
  "Blow only",
  "Watch for pet",
  "Gate code changed",
  "Client home — knock first",
  "Client not home — proceed",
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  currentNote?: string | null;
  currentRepeats?: boolean;
  onSaved?: (note: string | null, repeats: boolean) => void;
};

export default function PinnedNoteDialog({ open, onOpenChange, occurrenceId, currentNote, currentRepeats = true, onSaved }: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [note, setNote] = useState("");
  const [repeats, setRepeats] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setNote(currentNote ?? "");
      setRepeats(currentRepeats);
    }
  }, [open, currentNote, currentRepeats]);

  async function handleSave() {
    setSaving(true);
    try {
      const trimmed = note.trim() || null;
      await apiPatch(`/api/occurrences/${occurrenceId}/pinned-note`, { pinnedNote: trimmed, pinnedNoteRepeats: repeats });
      publishInlineMessage({ type: "SUCCESS", text: trimmed ? "Instruction saved." : "Instruction cleared." });
      onSaved?.(trimmed, repeats);
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to save instruction.", err) });
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    try {
      await apiPatch(`/api/occurrences/${occurrenceId}/pinned-note`, { pinnedNote: null, pinnedNoteRepeats: true });
      publishInlineMessage({ type: "SUCCESS", text: "Instruction cleared." });
      onSaved?.(null, true);
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to clear instruction.", err) });
    } finally {
      setSaving(false);
    }
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
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>📌 Pinned Instruction</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={2}>
                    Tap a preset or type a custom instruction. This will show prominently on the card and carry forward on repeating jobs.
                  </Text>
                  <Box display="flex" gap="6px" flexWrap="wrap" mb={3}>
                    {PRESETS.map((p) => (
                      <Badge
                        key={p}
                        size="sm"
                        variant={note === p ? "solid" : "outline"}
                        colorPalette={note === p ? "yellow" : "gray"}
                        cursor="pointer"
                        px="2"
                        py="0.5"
                        borderRadius="full"
                        onClick={() => setNote(note === p ? "" : p)}
                        userSelect="none"
                      >
                        {p}
                      </Badge>
                    ))}
                  </Box>
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Custom instruction</Text>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g., Trim hedges extra short near driveway"
                    rows={2}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px", resize: "vertical" }}
                  />
                </Box>
                <HStack justify="space-between" align="center">
                  <Box>
                    <Text fontSize="sm" fontWeight="medium">Carry forward</Text>
                    <Text fontSize="xs" color="fg.muted">Keep on future repeating occurrences</Text>
                  </Box>
                  <Switch.Root checked={repeats} onCheckedChange={(e) => setRepeats(e.checked)} colorPalette="blue" size="sm">
                    <Switch.HiddenInput />
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Root>
                </HStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="space-between" w="full">
                <Box>
                  {currentNote && (
                    <Button
                      size="sm"
                      variant="ghost"
                      colorPalette="red"
                      disabled={saving}
                      onClick={() => void handleClear()}
                    >
                      Clear
                    </Button>
                  )}
                </Box>
                <HStack gap={2}>
                  <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                  <Button
                    colorPalette="yellow"
                    disabled={saving}
                    onClick={() => void handleSave()}
                  >
                    {saving ? <Spinner size="sm" /> : "Save"}
                  </Button>
                </HStack>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
