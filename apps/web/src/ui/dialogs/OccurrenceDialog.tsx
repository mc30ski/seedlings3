"use client";

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { apiPost } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  onSaved?: () => void;
};

export default function OccurrenceDialog({
  open,
  onOpenChange,
  jobId,
  onSaved,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setWindowStart("");
    setWindowEnd("");
    setNotes("");
  }, [open]);

  async function handleSave() {
    if (!windowStart) {
      publishInlineMessage({ type: "WARNING", text: "Please select a start date." });
      return;
    }
    setBusy(true);
    try {
      await apiPost(`/api/admin/jobs/${jobId}/occurrences`, {
        windowStart: new Date(windowStart + "T00:00:00").toISOString(),
        windowEnd: windowEnd ? new Date(windowEnd + "T00:00:00").toISOString() : undefined,
        notes: notes.trim() || undefined,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Occurrence created." });
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Create occurrence failed.", err),
      });
    } finally {
      setBusy(false);
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
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>New Occurrence</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <Text mb="1">Window start *</Text>
                  <Input
                    type="date"
                    value={windowStart}
                    onChange={(e) => setWindowStart(e.target.value)}
                  />
                </div>
                <div>
                  <Text mb="1">Window end</Text>
                  <Input
                    type="date"
                    value={windowEnd}
                    onChange={(e) => setWindowEnd(e.target.value)}
                  />
                </div>
                <div>
                  <Text mb="1">Notes</Text>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional notes…"
                    rows={2}
                  />
                </div>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  variant="ghost"
                  ref={cancelRef}
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button onClick={handleSave} loading={busy} disabled={!windowStart}>
                  Create
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
