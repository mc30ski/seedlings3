"use client";

import { useEffect, useRef, useState } from "react";
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
  Select,
  Text,
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { apiGet, apiDelete, apiPatch, apiPost } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import { JOB_KIND, JOB_OCCURRENCE_STATUS } from "@/src/lib/types";

const workflowItems = [
  { label: "Estimate", value: "ESTIMATE" },
  { label: "Repeating Job", value: "STANDARD" },
  { label: "One-Off Job", value: "ONE_OFF" },
];
const workflowCollection = createListCollection({ items: workflowItems });
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
  preventOutsideClose?: boolean;
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
  preventOutsideClose,
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
  const [workflow, setWorkflow] = useState("ESTIMATE");
  const [isTentative, setIsTentative] = useState(false);

  // Inline expenses
  type InlineExpense = { id?: string; cost: number; description: string; isNew?: boolean };
  const [expenses, setExpenses] = useState<InlineExpense[]>([]);
  const [newExpCost, setNewExpCost] = useState("");
  const [newExpDesc, setNewExpDesc] = useState("");

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
    setWorkflow("ESTIMATE");
    setIsTentative(false);
    setExpenses([]);
    setNewExpCost("");
    setNewExpDesc("");
    setSelectedAssignees(new Set((defaultAssignees ?? []).map((a) => a.userId)));
  }, [open, mode, defaultStatus, defaultKind, defaultStartAt, defaultEndAt, defaultNotes, defaultPrice, defaultEstimatedMinutes, defaultStartedAt, defaultCompletedAt, defaultAssignees]);

  useEffect(() => {
    if (!open) return;
    apiGet<WorkerItem[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
    // Load existing expenses for UPDATE mode
    if (mode === "UPDATE" && occurrenceId && isAdmin) {
      apiGet<any[]>(`/api/admin/occurrences/${occurrenceId}/expenses`)
        .then((list) => setExpenses(
          (Array.isArray(list) ? list : []).map((e) => ({ id: e.id, cost: e.cost, description: e.description }))
        ))
        .catch(() => {});
    }
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
        const created = await apiPost<{ id: string }>(endpoint, {
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
        // Create any inline expenses against the new occurrence
        const newOccId = created?.id;
        if (newOccId && expenses.length > 0) {
          // Use admin endpoint if this dialog was opened in admin context
          const useAdmin = isAdmin || (createEndpoint ?? "").includes("/admin/");
          const expEndpoint = useAdmin
            ? `/api/admin/occurrences/${newOccId}/expenses`
            : `/api/occurrences/${newOccId}/expenses`;
          for (const exp of expenses) {
            try {
              await apiPost(expEndpoint, { cost: exp.cost, description: exp.description });
            } catch (err) {
              console.error("Failed to create expense:", err);
            }
          }
        }
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
        // Create new expenses, delete removed ones
        if (isAdmin && occurrenceId) {
          for (const exp of expenses) {
            if (exp.isNew) {
              try { await apiPost(`/api/admin/occurrences/${occurrenceId}/expenses`, { cost: exp.cost, description: exp.description }); } catch {}
            }
          }
        }
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
      closeOnInteractOutside={!preventOutsideClose}
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
                {mode === "CREATE" && (
                  <div>
                    <Text mb="1">Type</Text>
                    <Select.Root
                      collection={workflowCollection}
                      value={[workflow]}
                      onValueChange={(e) => setWorkflow(e.value[0] ?? "STANDARD")}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select type" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {workflowItems.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </div>
                )}
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
                <div>
                  <Text mb="1">Expenses <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text></Text>
                  {expenses.length > 0 && (
                    <VStack align="stretch" gap={1} mb={2}>
                      {expenses.map((exp, idx) => (
                        <HStack key={exp.id ?? `new-${idx}`} gap={2} fontSize="xs">
                          <Text color="orange.600" flex="1">
                            ${exp.cost.toFixed(2)} — {exp.description}
                          </Text>
                          <Button
                            size="xs"
                            variant="ghost"
                            colorPalette="red"
                            onClick={async () => {
                              if (exp.id && !exp.isNew && isAdmin) {
                                try {
                                  await apiDelete(`/api/admin/expenses/${exp.id}`);
                                } catch {}
                              }
                              setExpenses((prev) => prev.filter((_, i) => i !== idx));
                            }}
                          >
                            ✕
                          </Button>
                        </HStack>
                      ))}
                    </VStack>
                  )}
                  <HStack gap={2}>
                    <Box w="90px" flexShrink={0}>
                      <CurrencyInput
                        value={newExpCost}
                        onChange={setNewExpCost}
                        size="sm"
                        placeholder="Cost"
                      />
                    </Box>
                    <Input
                      value={newExpDesc}
                      onChange={(e) => setNewExpDesc(e.target.value)}
                      placeholder="Description"
                      size="sm"
                      flex="1"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="orange"
                      disabled={!newExpCost || !newExpDesc.trim()}
                      onClick={() => {
                        const cost = parseFloat(newExpCost);
                        if (isNaN(cost) || cost <= 0) return;
                        setExpenses((prev) => [...prev, { cost, description: newExpDesc.trim(), isNew: true }]);
                        setNewExpCost("");
                        setNewExpDesc("");
                      }}
                    >
                      Add
                    </Button>
                  </HStack>
                </div>
                {mode === "CREATE" && workers.length > 0 && (
                  <div>
                    <Text mb="1">Assignees <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text></Text>
                    <Select.Root
                      collection={createListCollection({
                        items: workers.map((w) => ({
                          label: w.displayName || w.email || w.id,
                          value: w.id,
                        })),
                      })}
                      value={Array.from(selectedAssignees)}
                      onValueChange={(e) => setSelectedAssignees(new Set(e.value))}
                      multiple
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Select assignees…" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content maxH="200px" overflowY="auto">
                          {workers.map((w) => (
                            <Select.Item key={w.id} item={w.id}>
                              <Select.ItemText>{w.displayName || w.email || w.id}</Select.ItemText>
                              <Select.ItemIndicator />
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                    {selectedAssignees.size > 0 && (
                      <HStack gap={1} mt={1} wrap="wrap">
                        {Array.from(selectedAssignees).map((id) => {
                          const w = workers.find((w) => w.id === id);
                          return (
                            <Badge
                              key={id}
                              size="sm"
                              colorPalette="blue"
                              variant="solid"
                              cursor="pointer"
                              onClick={() => setSelectedAssignees((prev) => {
                                const next = new Set(prev);
                                next.delete(id);
                                return next;
                              })}
                            >
                              {w?.displayName || w?.email || id} ✕
                            </Badge>
                          );
                        })}
                      </HStack>
                    )}
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
