"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  HStack,
  Input,
  NativeSelect,
  Portal,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
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
  defaultStartAt?: string | null;
  defaultEndAt?: string | null;
  defaultNotes?: string | null;
  defaultPrice?: number | null;
  defaultEstimatedMinutes?: number | null;
  defaultStartedAt?: string | null;
  defaultCompletedAt?: string | null;
  isAdmin?: boolean;
  /** Pre-selected assignees (carried from previous occurrence) */
  defaultAssignees?: { userId: string; displayName?: string | null }[];
  // optional overrides
  createEndpoint?: string;
  createBody?: Record<string, unknown>;
  title?: string;
  submitLabel?: string;
  showOneOff?: boolean; // @deprecated — workflow dropdown replaces this
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
  defaultStartAt,
  defaultEndAt,
  defaultNotes,
  defaultPrice,
  defaultEstimatedMinutes,
  defaultStartedAt,
  defaultCompletedAt,
  isAdmin,
  defaultAssignees,
  createEndpoint,
  createBody,
  title,
  submitLabel,
  showOneOff,
  onSaved,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [notes, setNotes] = useState("");
  const [price, setPrice] = useState("");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [completedAt, setCompletedAt] = useState("");
  const [workflow, setWorkflow] = useState("STANDARD");
  const [isTentative, setIsTentative] = useState(false);

  type WorkerItem = { id: string; displayName?: string | null; email?: string | null };
  const [workers, setWorkers] = useState<WorkerItem[]>([]);
  const [selectedAssignees, setSelectedAssignees] = useState<Set<string>>(new Set());

  function toDateTimeLocal(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  useEffect(() => {
    if (!open) return;
    setStatus(defaultStatus ?? "");
    setKind(defaultKind ?? "");
    setStartAt(mode === "UPDATE" || defaultStartAt ? toDateInput(defaultStartAt) : "");
    setEndAt(mode === "UPDATE" || defaultEndAt ? toDateInput(defaultEndAt) : "");
    setNotes(defaultNotes ?? "");
    setPrice(defaultPrice != null ? defaultPrice.toFixed(2) : "");
    setEstimatedMinutes(defaultEstimatedMinutes != null ? String(defaultEstimatedMinutes) : "");
    setStartedAt(toDateTimeLocal(defaultStartedAt));
    setCompletedAt(toDateTimeLocal(defaultCompletedAt));
    setWorkflow("STANDARD");
    setIsTentative(false);
    setSelectedAssignees(new Set((defaultAssignees ?? []).map((a) => a.userId)));
  }, [open, mode, defaultStatus, defaultKind, defaultStartAt, defaultEndAt, defaultNotes, defaultPrice, defaultEstimatedMinutes, defaultStartedAt, defaultCompletedAt, defaultAssignees]);

  useEffect(() => {
    if (!open) return;
    apiGet<WorkerItem[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [open]);

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

      if (mode === "CREATE") {
        const endpoint = createEndpoint ?? `/api/admin/jobs/${jobId}/occurrences`;
        await apiPost(endpoint, {
          ...createBody,
          startAt: startAtIso,
          endAt: endAtIso ?? undefined,
          notes: notesVal ?? undefined,
          price: priceVal ?? undefined,
          estimatedMinutes: estimatedMinutes !== "" ? Number(estimatedMinutes) : undefined,
          ...(selectedAssignees.size > 0 ? { assigneeUserIds: Array.from(selectedAssignees) } : {}),
          workflow,
          ...(isTentative ? { isTentative: true } : {}),
        });
        publishInlineMessage({ type: "SUCCESS", text: "Occurrence created." });
      } else {
        const body: Record<string, unknown> = {
          startAt: startAtIso,
          endAt: endAtIso,
          notes: notesVal,
          price: priceVal,
          estimatedMinutes: estimatedMinutes !== "" ? Number(estimatedMinutes) : null,
        };
        if (status) body.status = status;
        if (kind) body.kind = kind;
        if (isAdmin) {
          body.startedAt = startedAt ? new Date(startedAt).toISOString() : null;
          body.completedAt = completedAt ? new Date(completedAt).toISOString() : null;
        }
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
                {title ?? (mode === "CREATE" ? "New Occurrence" : "Edit Occurrence")}
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
                <HStack gap={3}>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Price</Text>
                    <CurrencyInput
                      value={price}
                      onChange={setPrice}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <Text mb="1">Est. minutes</Text>
                    <Input
                      type="number"
                      value={estimatedMinutes}
                      onChange={(e) => setEstimatedMinutes(e.target.value)}
                      placeholder="e.g. 45"
                      min={1}
                    />
                  </div>
                </HStack>
                {isAdmin && mode === "UPDATE" && (
                  <>
                    <div>
                      <Text mb="1">Started at</Text>
                      <Input
                        type="datetime-local"
                        value={startedAt}
                        onChange={(e) => setStartedAt(e.target.value)}
                      />
                    </div>
                    <div>
                      <Text mb="1">Completed at</Text>
                      <Input
                        type="datetime-local"
                        value={completedAt}
                        onChange={(e) => setCompletedAt(e.target.value)}
                      />
                    </div>
                  </>
                )}
                <div>
                  <Text mb="1">Notes</Text>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional notes…"
                    rows={2}
                  />
                </div>
                {mode === "CREATE" && workers.length > 0 && (
                  <div>
                    <Text mb="1">Assignees <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text></Text>
                    <VStack align="stretch" gap={1} maxH="150px" overflowY="auto">
                      {workers.map((w) => (
                        <Checkbox.Root
                          key={w.id}
                          checked={selectedAssignees.has(w.id)}
                          onCheckedChange={(e) => {
                            setSelectedAssignees((prev) => {
                              const next = new Set(prev);
                              e.checked ? next.add(w.id) : next.delete(w.id);
                              return next;
                            });
                          }}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                          <Checkbox.Label fontSize="sm">{w.displayName || w.email || w.id}</Checkbox.Label>
                        </Checkbox.Root>
                      ))}
                    </VStack>
                  </div>
                )}
                {mode === "CREATE" && (
                  <div>
                    <Text mb="1">Type</Text>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={workflow}
                        onChange={(e) => setWorkflow(e.target.value)}
                      >
                        <option value="STANDARD">Repeating Job</option>
                        <option value="ONE_OFF">One-Off Job</option>
                        <option value="ESTIMATE">Estimate</option>
                      </NativeSelect.Field>
                    </NativeSelect.Root>
                  </div>
                )}
                {mode === "CREATE" && (
                  <Checkbox.Root
                    checked={isTentative}
                    onCheckedChange={(e) => setIsTentative(!!e.checked)}
                  >
                    <Checkbox.HiddenInput />
                    <Checkbox.Control />
                    <Checkbox.Label>Tentative (must be confirmed before workers can claim)</Checkbox.Label>
                  </Checkbox.Root>
                )}
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
                  {submitLabel ?? (mode === "CREATE" ? "Create" : "Save")}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
