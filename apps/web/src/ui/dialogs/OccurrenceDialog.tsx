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
import { JOB_KIND, JOB_OCCURRENCE_STATUS, JOB_TYPE_OPTIONS } from "@/src/lib/types";

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
  defaultIsAdminOnly?: boolean;
  defaultJobType?: string | null;
  isAdmin?: boolean;
  /** Pre-selected assignees (carried from previous occurrence) */
  defaultAssignees?: { userId: string; displayName?: string | null }[];
  // optional overrides
  createEndpoint?: string;
  createBody?: Record<string, unknown>;
  title?: string;
  submitLabel?: string;
  defaultWorkflow?: string;
  /** Occurrence-level frequency override (for pre-populating in edit mode) */
  defaultFrequencyDays?: number | null;
  /** Job's frequencyDays — used to warn if "Repeating" is selected without frequency */
  jobFrequencyDays?: number | null;
  showOneOff?: boolean; // @deprecated — workflow dropdown replaces this
  preventOutsideClose?: boolean;
  deferSave?: boolean;
  onSaved?: (data?: any) => void;
  onBack?: () => void;
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
  defaultIsAdminOnly,
  defaultJobType,
  isAdmin,
  defaultAssignees,
  defaultWorkflow,
  defaultFrequencyDays,
  jobFrequencyDays,
  createEndpoint,
  createBody,
  title,
  submitLabel,
  preventOutsideClose,
  deferSave,
  onSaved,
  onBack,
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
  const [workflow, setWorkflow] = useState(defaultWorkflow ?? "ESTIMATE");
  const [isTentative, setIsTentative] = useState(false);
  const [isAdminOnly, setIsAdminOnly] = useState(false);
  const [occFrequencyDays, setOccFrequencyDays] = useState("");
  const [freqError, setFreqError] = useState("");
  const [jobType, setJobType] = useState("");

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

  // Initialize form once when dialog opens — use ref to prevent re-init on re-renders
  const initRef = useRef<string | null>(null);
  const openKey = open ? `${mode}-${occurrenceId ?? jobId ?? "new"}` : null;
  if (openKey && initRef.current !== openKey) {
    initRef.current = openKey;
    // Synchronous state init (runs once per dialog open, not in useEffect)
    // React batches these setState calls during render
    setStatus(defaultStatus ?? "");
    setKind(defaultKind ?? "");
    setStartAt(mode === "UPDATE" || defaultStartAt ? toDateInput(defaultStartAt) : "");
    setEndAt(mode === "UPDATE" || defaultEndAt ? toDateInput(defaultEndAt) : "");
    setNotes(defaultNotes ?? "");
    setPrice(defaultPrice != null ? defaultPrice.toFixed(2) : "");
    setEstimatedMinutes(defaultEstimatedMinutes != null ? String(defaultEstimatedMinutes) : "");
    setStartedAt(toDateTimeLocal(defaultStartedAt));
    setCompletedAt(toDateTimeLocal(defaultCompletedAt));
    setWorkflow(defaultWorkflow ?? "ESTIMATE");
    setIsTentative(false);
    setIsAdminOnly(defaultIsAdminOnly ?? (mode === "CREATE" ? true : false));
    setJobType(defaultJobType ?? "");
    setOccFrequencyDays(defaultFrequencyDays != null ? String(defaultFrequencyDays) : "");
    setExpenses([]);
    setNewExpCost("");
    setNewExpDesc("");
    setSelectedAssignees(new Set((defaultAssignees ?? []).map((a) => a.userId)));
  }
  if (!open && initRef.current) {
    initRef.current = null;
  }

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
    const effectiveFreq = occFrequencyDays !== "" ? Number(occFrequencyDays) : jobFrequencyDays;
    if (workflow === "STANDARD" && !effectiveFreq) {
      setFreqError("Repeating job requires a frequency. Set it on the Job or enter a frequency override above.");
      publishInlineMessage({ type: "WARNING", text: "Repeating job requires a frequency." });
      return;
    }
    setFreqError("");
    setBusy(true);
    try {
      const startAtIso = startAt + "T12:00:00Z";
      const endAtIso = endAt ? endAt + "T12:00:00Z" : null;
      const priceVal = price !== "" ? Number(price) : null;
      const notesVal = notes.trim() || null;

      const occPayload = {
        ...createBody,
        startAt: startAtIso,
        endAt: endAtIso ?? undefined,
        notes: notesVal ?? undefined,
        price: priceVal ?? undefined,
        estimatedMinutes: estimatedMinutes !== "" ? Number(estimatedMinutes) : undefined,
        ...(selectedAssignees.size > 0 ? { assigneeUserIds: Array.from(selectedAssignees) } : {}),
        workflow,
        ...(isTentative ? { isTentative: true } : {}),
        ...(isAdminOnly ? { isAdminOnly: true } : {}),
        ...(jobType ? { jobType } : {}),
        ...(occFrequencyDays !== "" ? { frequencyDays: Number(occFrequencyDays) } : {}),
      };

      if (deferSave) {
        onSaved?.(occPayload);
        onOpenChange(false);
        setBusy(false);
        return;
      }

      if (mode === "CREATE") {
        const endpoint = createEndpoint ?? `/api/admin/jobs/${jobId}/occurrences`;
        const created = await apiPost<{ id: string }>(endpoint, occPayload);
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
          // Only send startedAt/completedAt if they differ from defaults to avoid accidental overwrite
          const newStartedAt = startedAt ? new Date(startedAt).toISOString() : null;
          const newCompletedAt = completedAt ? new Date(completedAt).toISOString() : null;
          const origStartedAt = defaultStartedAt ? new Date(defaultStartedAt).toISOString() : null;
          const origCompletedAt = defaultCompletedAt ? new Date(defaultCompletedAt).toISOString() : null;
          if (newStartedAt !== origStartedAt) body.startedAt = newStartedAt;
          if (newCompletedAt !== origCompletedAt) body.completedAt = newCompletedAt;
        }
        body.isAdminOnly = isAdminOnly;
        body.jobType = jobType || null;
        body.frequencyDays = occFrequencyDays !== "" ? Number(occFrequencyDays) : null;
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

            <Dialog.Body style={{ maxHeight: "70vh", overflowY: "auto" }}>
              <VStack align="stretch" gap={3}>
                {mode === "CREATE" && (
                  <div>
                    <Text mb="1">Type</Text>
                    <Select.Root
                      collection={workflowCollection}
                      value={[workflow]}
                      onValueChange={(e) => {
                        const wf = e.value[0] ?? "STANDARD";
                        setWorkflow(wf);
                        if (mode === "CREATE") setIsAdminOnly(wf === "ESTIMATE");
                      }}
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
                {workflow === "STANDARD" && (
                  <div>
                    <Text mb="1">Frequency (days)</Text>
                    <input
                      type="number"
                      value={occFrequencyDays}
                      onChange={(e) => { setOccFrequencyDays(e.target.value); setFreqError(""); }}
                      placeholder="e.g. 14"
                      min="1"
                      style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                    />
                    {freqError && (
                      <Box p={2} bg="red.50" borderWidth="1px" borderColor="red.200" borderRadius="md" mt={2}>
                        <Text fontSize="xs" color="red.700">{freqError}</Text>
                      </Box>
                    )}
                    <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md" mt={freqError ? 1 : 2}>
                      <Text fontSize="xs" color="yellow.800">
                        {occFrequencyDays !== ""
                          ? `This occurrence will repeat every ${occFrequencyDays} days, overriding the job's ${jobFrequencyDays ? `default of ${jobFrequencyDays} days` : "frequency (not set)"}.`
                          : jobFrequencyDays
                          ? `No override set — will use the job's default frequency of ${jobFrequencyDays} days.`
                          : "The parent job has no frequency set. Set one here to make this occurrence repeat on its own schedule."}
                      </Text>
                    </Box>
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
                  <Text mb="1">Job Type</Text>
                  <select
                    value={jobType}
                    onChange={(e) => setJobType(e.target.value)}
                    style={{
                      width: "100%",
                      fontSize: "0.875rem",
                      padding: "0.4rem 0.5rem",
                      borderRadius: "0.375rem",
                      border: "1px solid var(--chakra-colors-border)",
                      background: "var(--chakra-colors-bg)",
                      color: "var(--chakra-colors-fg)",
                    }}
                  >
                    {JOB_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Text mb="1">Start date *</Text>
                  <Input
                    type="date"
                    value={startAt}
                    onChange={(e) => {
                      const val = e.target.value;
                      const oldStart = startAt;
                      setStartAt(val);
                      if (!endAt || !oldStart) {
                        setEndAt(val);
                      } else {
                        // Preserve the duration between start and end
                        const diffMs = new Date(endAt + "T12:00:00Z").getTime() - new Date(oldStart + "T12:00:00Z").getTime();
                        const newEnd = new Date(new Date(val + "T12:00:00Z").getTime() + diffMs);
                        setEndAt(newEnd.toISOString().slice(0, 10));
                      }
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
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                        <Text>Started at</Text>
                      </div>
                      {startedAt ? (
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <input
                            type="datetime-local"
                            value={startedAt}
                            onChange={(e) => setStartedAt(e.target.value)}
                            style={{ flex: 1, padding: "6px 8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "14px" }}
                          />
                          <button
                            type="button"
                            onClick={() => setStartedAt("")}
                            style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid #e53e3e", color: "#e53e3e", background: "white", cursor: "pointer", fontSize: "13px", whiteSpace: "nowrap" }}
                          >
                            Clear
                          </button>
                        </div>
                      ) : (
                        <Text fontSize="sm" color="fg.muted" fontStyle="italic">Not set</Text>
                      )}
                    </div>
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                        <Text>Completed at</Text>
                      </div>
                      {completedAt ? (
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <input
                            type="datetime-local"
                            value={completedAt}
                            onChange={(e) => setCompletedAt(e.target.value)}
                            style={{ flex: 1, padding: "6px 8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "14px" }}
                          />
                          <button
                            type="button"
                            onClick={() => setCompletedAt("")}
                            style={{ padding: "4px 10px", borderRadius: "6px", border: "1px solid #e53e3e", color: "#e53e3e", background: "white", cursor: "pointer", fontSize: "13px", whiteSpace: "nowrap" }}
                          >
                            Clear
                          </button>
                        </div>
                      ) : (
                        <Text fontSize="sm" color="fg.muted" fontStyle="italic">Not set</Text>
                      )}
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
                <Checkbox.Root
                  checked={isAdminOnly}
                  onCheckedChange={(e) => setIsAdminOnly(!!e.checked)}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>Administered (workers cannot claim, must be assigned)</Checkbox.Label>
                </Checkbox.Root>
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                {onBack && <Button variant="outline" onClick={onBack}>Back</Button>}
                <Button
                  variant="ghost"
                  ref={cancelRef}
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button onClick={handleSave} loading={busy} disabled={!startAt || (workflow === "STANDARD" && !occFrequencyDays && !jobFrequencyDays)}>
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
