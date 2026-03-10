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
import { apiPatch, apiPost } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";

function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: "CREATE" | "UPDATE";
  // CREATE
  jobId?: string;
  // UPDATE
  occurrenceId?: string;
  // shared pre-populated values
  defaultWindowStart?: string | null;
  defaultWindowEnd?: string | null;
  defaultNotes?: string | null;
  defaultPrice?: number | null;
  onSaved?: () => void;
};

export default function OccurrenceDialog({
  open,
  onOpenChange,
  mode = "CREATE",
  jobId,
  occurrenceId,
  defaultWindowStart,
  defaultWindowEnd,
  defaultNotes,
  defaultPrice,
  onSaved,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [price, setPrice] = useState("");

  useEffect(() => {
    if (!open) return;
    setWindowStart(mode === "UPDATE" ? toDateInput(defaultWindowStart) : "");
    setWindowEnd(mode === "UPDATE" ? toDateInput(defaultWindowEnd) : "");
    setNotes(defaultNotes ?? "");
    setPrice(defaultPrice != null ? defaultPrice.toFixed(2) : "");
  }, [open, mode, defaultWindowStart, defaultWindowEnd, defaultNotes, defaultPrice]);

  async function handleSave() {
    if (!windowStart) {
      publishInlineMessage({ type: "WARNING", text: "Please select a start date." });
      return;
    }
    setBusy(true);
    try {
      const windowStartIso = new Date(windowStart + "T00:00:00").toISOString();
      const windowEndIso = windowEnd ? new Date(windowEnd + "T00:00:00").toISOString() : null;
      const priceVal = price !== "" ? Number(price) : null;
      const notesVal = notes.trim() || null;

      if (mode === "CREATE") {
        await apiPost(`/api/admin/jobs/${jobId}/occurrences`, {
          windowStart: windowStartIso,
          windowEnd: windowEndIso ?? undefined,
          notes: notesVal ?? undefined,
          price: priceVal ?? undefined,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Occurrence created." });
      } else {
        await apiPatch(`/api/admin/occurrences/${occurrenceId}`, {
          windowStart: windowStartIso,
          windowEnd: windowEndIso,
          notes: notesVal,
          price: priceVal,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Occurrence updated." });
      }
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(
          mode === "CREATE" ? "Create occurrence failed." : "Update occurrence failed.",
          err
        ),
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
              <Dialog.Title>
                {mode === "CREATE" ? "New Occurrence" : "Edit Occurrence"}
              </Dialog.Title>
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
                  <Text mb="1">Price</Text>
                  <CurrencyInput
                    value={price}
                    onChange={setPrice}
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
                  {mode === "CREATE" ? "Create" : "Save"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
