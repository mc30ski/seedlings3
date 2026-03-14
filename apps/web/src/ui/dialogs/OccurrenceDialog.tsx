"use client";

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  HStack,
  Input,
  NativeSelect,
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
import { JOB_KIND, JOB_OCCURRENCE_STATUS } from "@/src/lib/types";
import { prettyStatus } from "@/src/lib/lib";

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
  defaultStatus?: string | null;
  defaultKind?: string | null;
  // shared pre-populated values
  defaultName?: string | null;
  defaultStartAt?: string | null;
  defaultEndAt?: string | null;
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
  defaultStatus,
  defaultKind,
  defaultName,
  defaultStartAt,
  defaultEndAt,
  defaultNotes,
  defaultPrice,
  onSaved,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [name, setName] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [notes, setNotes] = useState("");
  const [price, setPrice] = useState("");

  useEffect(() => {
    if (!open) return;
    setStatus(defaultStatus ?? "");
    setKind(defaultKind ?? "");
    setName(defaultName ?? "");
    setStartAt(mode === "UPDATE" ? toDateInput(defaultStartAt) : "");
    setEndAt(mode === "UPDATE" ? toDateInput(defaultEndAt) : "");
    setNotes(defaultNotes ?? "");
    setPrice(defaultPrice != null ? defaultPrice.toFixed(2) : "");
  }, [open, mode, defaultStatus, defaultKind, defaultName, defaultStartAt, defaultEndAt, defaultNotes, defaultPrice]);

  async function handleSave() {
    if (!startAt) {
      publishInlineMessage({ type: "WARNING", text: "Please select a start date." });
      return;
    }
    setBusy(true);
    try {
      const startAtIso = new Date(startAt + "T00:00:00").toISOString();
      const endAtIso = endAt ? new Date(endAt + "T00:00:00").toISOString() : null;
      const priceVal = price !== "" ? Number(price) : null;
      const notesVal = notes.trim() || null;

      const nameVal = name.trim() || null;

      if (mode === "CREATE") {
        await apiPost(`/api/admin/jobs/${jobId}/occurrences`, {
          name: nameVal ?? undefined,
          startAt: startAtIso,
          endAt: endAtIso ?? undefined,
          notes: notesVal ?? undefined,
          price: priceVal ?? undefined,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Occurrence created." });
      } else {
        const body: Record<string, unknown> = {
          name: nameVal,
          startAt: startAtIso,
          endAt: endAtIso,
          notes: notesVal,
          price: priceVal,
        };
        if (status) body.status = status;
        if (kind) body.kind = kind;
        await apiPatch(`/api/admin/occurrences/${occurrenceId}`, body);
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
                {mode === "UPDATE" && (
                  <div>
                    <Text mb="1">Status</Text>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                      >
                        {JOB_OCCURRENCE_STATUS.map((s) => (
                          <option key={s} value={s}>{prettyStatus(s)}</option>
                        ))}
                      </NativeSelect.Field>
                    </NativeSelect.Root>
                  </div>
                )}
                {mode === "UPDATE" && (
                  <div>
                    <Text mb="1">Kind</Text>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={kind}
                        onChange={(e) => setKind(e.target.value)}
                      >
                        {JOB_KIND.map((k) => (
                          <option key={k} value={k}>{prettyStatus(k)}</option>
                        ))}
                      </NativeSelect.Field>
                    </NativeSelect.Root>
                  </div>
                )}
                <div>
                  <Text mb="1">Name</Text>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Occurrence name…"
                  />
                </div>
                <div>
                  <Text mb="1">Start date *</Text>
                  <Input
                    type="date"
                    value={startAt}
                    onChange={(e) => {
                      const val = e.target.value;
                      setStartAt(val);
                      if (!endAt) setEndAt(val);
                      else if (endAt && val && val > endAt) setEndAt(val);
                    }}
                  />
                </div>
                <div>
                  <Text mb="1">End date</Text>
                  <Input
                    type="date"
                    value={endAt}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (startAt && val && val < startAt) {
                        setEndAt(val);
                        setStartAt(val);
                      } else {
                        setEndAt(val);
                      }
                    }}
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
                <Button onClick={handleSave} loading={busy} disabled={!startAt}>
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
