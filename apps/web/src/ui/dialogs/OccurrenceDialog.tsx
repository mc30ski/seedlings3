"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
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
import { apiGet, apiDelete, apiPatch, apiPost, apiPut } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import JobTagPicker, { jobTagLabel as _jobTagLabel, JOB_TAGS, type JobTagConfig } from "@/src/ui/components/JobTagPicker";
import JobPropertyPhotosPicker from "@/src/ui/components/JobPropertyPhotosPicker";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { JOB_KIND, JOB_OCCURRENCE_STATUS } from "@/src/lib/types";
import { validNextStatuses } from "@/src/lib/jobTransitions";

const workflowItems = [
  { label: "Repeating Job", value: "STANDARD" },
  { label: "One-Off Job", value: "ONE_OFF" },
];
const workflowCollection = createListCollection({ items: workflowItems });
import { bizDateKey, bizToLocalInputValue, bizParseLocalInputValue } from "@/src/lib/dates";
import { prettyStatus } from "@/src/lib/labels";

function toDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  // ET-anchored — see lib/dates.ts header on bizDateKey for the rationale.
  return bizDateKey(iso);
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: "CREATE" | "UPDATE";
  // CREATE
  jobId?: string;
  /** Property ID — for showing property photo instruction picker */
  propertyId?: string | null;
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
  defaultJobTags?: string[] | null;
  isAdmin?: boolean;
  /** Pre-selected assignees (carried from previous occurrence) */
  defaultAssignees?: { userId: string; displayName?: string | null }[];
  // optional overrides
  createEndpoint?: string;
  createBody?: Record<string, unknown>;
  title?: string;
  submitLabel?: string;
  defaultWorkflow?: string;
  /** Occurrence title (used for estimates) */
  defaultOccTitle?: string | null;
  /** Occurrence-level frequency override (for pre-populating in edit mode) */
  defaultFrequencyDays?: number | null;
  /** Job's frequencyDays — used to warn if "Repeating" is selected without frequency */
  jobFrequencyDays?: number | null;
  /** Existing add-on services (for UPDATE mode) */
  /** Estimate-specific fields */
  defaultContactName?: string | null;
  defaultContactPhone?: string | null;
  defaultContactEmail?: string | null;
  defaultEstimateAddress?: string | null;
  defaultProposalAmount?: number | null;
  defaultProposalNotes?: string | null;
  /** Dynamic job tags from settings */
  jobTagsConfig?: JobTagConfig[] | null;
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
  propertyId,
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
  defaultJobTags,
  isAdmin,
  defaultAssignees,
  defaultWorkflow,
  defaultOccTitle,
  defaultFrequencyDays,
  jobFrequencyDays,
  createEndpoint,
  createBody,
  title,
  submitLabel,
  preventOutsideClose,
  defaultContactName,
  defaultContactPhone,
  defaultContactEmail,
  defaultEstimateAddress,
  defaultProposalAmount,
  defaultProposalNotes,
  jobTagsConfig,
  deferSave,
  onSaved,
  onBack,
}: Props) {
  const jobTagLabel = (tag: string) => _jobTagLabel(tag, jobTagsConfig ?? undefined);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const dlgErr = useDialogError();
  /** Saved add-on awaiting a delete confirmation. */
  const [status, setStatus] = useState("");
  // Destructive-transition confirm: changing CLOSED → SCHEDULED / PENDING_PAYMENT
  // triggers the server's revert cascade in services/jobs.ts (deletes the
  // confirmed Payment, ghost-cancels the auto-created next occurrence, and
  // resets paymentRequestSentAt — which is irreversible without manual
  // recovery). Prompt before submitting. ARCHIVED is excluded since the
  // server guard treats it as a non-destructive transition.
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [kind, setKind] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [notes, setNotes] = useState("");
  const [price, setPrice] = useState("");
  const [estimatedMinutes, setEstimatedMinutes] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [completedAt, setCompletedAt] = useState("");
  const [occTitle, setOccTitle] = useState("");
  const [workflow, setWorkflow] = useState(defaultWorkflow ?? "STANDARD");
  // Tasks, reminders, events, followups, and announcements aren't service
  const [isTentative, setIsTentative] = useState(false);
  const [isAdminOnly, setIsAdminOnly] = useState(false);
  const [occFrequencyDays, setOccFrequencyDays] = useState("");
  const [freqError, setFreqError] = useState("");
  const [jobType, setJobType] = useState("");
  const [jobTags, setJobTags] = useState<string[]>([]);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [estimateAddress, setEstimateAddress] = useState("");
  const [proposalAmount, setProposalAmount] = useState("");
  const [proposalNotes, setProposalNotes] = useState("");
  const [propertyPhotoIds, setPropertyPhotoIds] = useState<string[] | null>(null);
  // Job-level default guidance description — on a NEW occurrence it's included
  // by default but can be de-selected so this instance is created without it.
  const [jobGuidanceNote, setJobGuidanceNote] = useState<string | null>(null);
  const [includeGuidanceNote, setIncludeGuidanceNote] = useState(true);

  // Inline expenses. Custom rows create a paired BusinessExpense on save;
  // inventory rows create a SupplyHold + Expense pair via the supply-holds
  // endpoint. `fromInventory` flags rows already loaded from the DB; new
  // inventory rows carry `pendingHold` until they're POSTed on save.

  type WorkerItem = { id: string; displayName?: string | null; email?: string | null };
  const [workers, setWorkers] = useState<WorkerItem[]>([]);
  const [selectedAssignees, setSelectedAssignees] = useState<Set<string>>(new Set());

  // ET-anchored — see bizToLocalInputValue / bizParseLocalInputValue in
  // lib/dates.ts for the rationale. Browser-local round-tripping makes the
  // displayed and submitted times disagree for any operator outside ET.
  function toDateTimeLocal(iso: string | null | undefined): string {
    return iso ? bizToLocalInputValue(iso) : "";
  }

  // Initialize form every time dialog opens
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setStatus(defaultStatus ?? "");
      setKind(defaultKind ?? "");
      // New occurrences default both dates to today so the workflow's
      // Final Step is one click away from "Create Everything" — admins
      // almost always mean "today" anyway, and an empty start used to
      // block submit with a warning toast.
      setStartAt(mode === "UPDATE" || defaultStartAt ? toDateInput(defaultStartAt) : toDateInput(new Date().toISOString()));
      setEndAt(mode === "UPDATE" || defaultEndAt ? toDateInput(defaultEndAt) : toDateInput(new Date().toISOString()));
      setNotes(defaultNotes ?? "");
      setPrice(defaultPrice != null ? defaultPrice.toFixed(2) : "");
      setEstimatedMinutes(defaultEstimatedMinutes != null ? String(defaultEstimatedMinutes) : "");
      setStartedAt(toDateTimeLocal(defaultStartedAt));
      setCompletedAt(toDateTimeLocal(defaultCompletedAt));
      setOccTitle(defaultOccTitle ?? "");
      setWorkflow(defaultWorkflow ?? "STANDARD");
      setIsTentative(false);
      setIsAdminOnly(defaultIsAdminOnly ?? (mode === "CREATE" ? true : false));
      setJobType(defaultJobType ?? "");
      setJobTags(defaultJobTags ?? []);
      setOccFrequencyDays(defaultFrequencyDays != null ? String(defaultFrequencyDays) : "");
      setContactName(defaultContactName ?? "");
      setContactPhone(defaultContactPhone ?? "");
      setContactEmail(defaultContactEmail ?? "");
      setEstimateAddress(defaultEstimateAddress ?? "");
      setProposalAmount(defaultProposalAmount != null ? defaultProposalAmount.toFixed(2) : "");
      setProposalNotes(defaultProposalNotes ?? "");
      setSelectedAssignees(new Set((defaultAssignees ?? []).map((a) => a.userId)));
    }
    prevOpenRef.current = open;
  });

  useEffect(() => {
    if (!open) return;
    apiGet<WorkerItem[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
    // Load the job's default guidance description so a NEW occurrence can
    // inherit it (de-selectable). UPDATE occurrences keep their own.
    if (mode === "CREATE" && jobId) {
      setIncludeGuidanceNote(true);
      apiGet<{ guidanceNote?: string | null }>(`/api/admin/jobs/${jobId}`)
        .then((j) => setJobGuidanceNote(j?.guidanceNote ?? null))
        .catch(() => setJobGuidanceNote(null));
    } else {
      setJobGuidanceNote(null);
    }
    // Load supplies (worker-readable list — works for any role) for the
    // inline inventory picker. Filters out archived; computes available =
    // onHand − active holds server-side.
  }, [open]);

  async function handleSave(bypassRevertConfirm = false) {
    dlgErr.clear();
    if (!startAt) {
      publishInlineMessage({ type: "WARNING", text: "Please select a start date." });
      return;
    }
    // Mirror the server-side revert guard in services/jobs.ts: a transition
    // FROM CLOSED to anything other than CLOSED/ARCHIVED will delete the
    // payment + ghost-cancel the next occurrence. Prompt the operator
    // before submitting so an accidental dropdown selection can't silently
    // destroy an already-paid record (the exact failure mode we shipped a
    // fix for on the server, but this guard belongs at the UI too).
    if (
      !bypassRevertConfirm &&
      mode === "UPDATE" &&
      defaultStatus === "CLOSED" &&
      status &&
      status !== "CLOSED" &&
      status !== "ARCHIVED"
    ) {
      setRevertConfirmOpen(true);
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
        title: occTitle.trim() || undefined,
        notes: notesVal ?? undefined,
        price: priceVal ?? undefined,
        estimatedMinutes: estimatedMinutes !== "" ? Number(estimatedMinutes) : undefined,
        ...(selectedAssignees.size > 0 ? { assigneeUserIds: Array.from(selectedAssignees) } : {}),
        workflow,
        ...(isTentative ? { isTentative: true } : {}),
        ...(isAdminOnly ? { isAdminOnly: true } : {}),
        ...(jobType ? { jobType } : {}),
        ...(jobTags.length > 0 ? { jobTags } : {}),
        // Job default guidance description: send it (or explicit null to
        // opt this occurrence out) only when the job actually has one.
        ...(mode === "CREATE" && jobGuidanceNote
          ? { guidanceNote: includeGuidanceNote ? jobGuidanceNote : null }
          : {}),
        ...(occFrequencyDays !== "" ? { frequencyDays: Number(occFrequencyDays) } : {}),
        ...(workflow === "ESTIMATE" ? {
          contactName: contactName.trim() || undefined,
          contactPhone: contactPhone.trim() || undefined,
          contactEmail: contactEmail.trim() || undefined,
          estimateAddress: estimateAddress.trim() || undefined,
          proposalAmount: proposalAmount !== "" ? Number(proposalAmount) : undefined,
          proposalNotes: proposalNotes.trim() || undefined,
        } : {}),
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
        const newOccId = created?.id;
        // NO CHARGE CREATION HERE. Charges used to be posted one at a
        // time after the occurrence came back, with every failure swallowed
        // to console.error — so a charge could silently not exist while the
        // operator watched it in a list. Add them from the job card, where
        // one shared dialog handles them with real error reporting.
        // Save property photo selections if changed
        if (newOccId && propertyPhotoIds !== null) {
          try {
            await apiPut(`/api/admin/occurrences/${newOccId}/property-photos`, { propertyPhotoIds });
          } catch (err) { console.error("Failed to save property photos:", err); }
        }
        // NO ADD-ON CREATION HERE — see the note in the body.
        publishInlineMessage({ type: "SUCCESS", text: "Occurrence created." });
      } else {
        const body: Record<string, unknown> = {
          startAt: startAtIso,
          endAt: endAtIso,
          title: occTitle.trim() || null,
          notes: notesVal,
          price: priceVal,
          estimatedMinutes: estimatedMinutes !== "" ? Number(estimatedMinutes) : null,
        };
        if (status) body.status = status;
        if (kind) body.kind = kind;
        if (isAdmin) {
          // Only send startedAt/completedAt if they differ from defaults to avoid accidental overwrite.
          // Parse the datetime-local inputs as ET wall-clock (see
          // bizParseLocalInputValue) so the round-trip through the
          // ET-displayed input is consistent.
          const newStartedAt = startedAt ? bizParseLocalInputValue(startedAt) : null;
          const newCompletedAt = completedAt ? bizParseLocalInputValue(completedAt) : null;
          const origStartedAt = defaultStartedAt ? new Date(defaultStartedAt).toISOString() : null;
          const origCompletedAt = defaultCompletedAt ? new Date(defaultCompletedAt).toISOString() : null;
          if (newStartedAt !== origStartedAt) body.startedAt = newStartedAt;
          if (newCompletedAt !== origCompletedAt) body.completedAt = newCompletedAt;
        }
        body.isAdminOnly = isAdminOnly;
        body.jobType = jobType || null;
        body.jobTags = jobTags.length > 0 ? jobTags : null;
        body.frequencyDays = occFrequencyDays !== "" ? Number(occFrequencyDays) : null;
        if (workflow === "ESTIMATE") {
          body.contactName = contactName.trim() || null;
          body.contactPhone = contactPhone.trim() || null;
          body.contactEmail = contactEmail.trim() || null;
          body.estimateAddress = estimateAddress.trim() || null;
          body.proposalAmount = proposalAmount !== "" ? Number(proposalAmount) : null;
          body.proposalNotes = proposalNotes.trim() || null;
        }
        await apiPatch(`/api/admin/occurrences/${occurrenceId}`, body);
        // NO CHARGE CREATION HERE either — and note the `catch {}` this
        // replaced: a failed charge vanished with no message at all.
        // Save property photo selections if changed
        if (occurrenceId && propertyPhotoIds !== null) {
          try {
            await apiPut(`/api/admin/occurrences/${occurrenceId}/property-photos`, { propertyPhotoIds });
          } catch (err) { console.error("Failed to save property photos:", err); }
        }
        publishInlineMessage({ type: "SUCCESS", text: "Occurrence updated." });
      }
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      dlgErr.setError(getErrorMessage(
        mode === "CREATE" ? "Create occurrence failed." : "Update occurrence failed.",
        err
      ));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
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
                {/* Estimates are created via the dedicated EstimateDialog */}
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
                    <Box p={2} bg={!occFrequencyDays && !jobFrequencyDays ? "red.50" : "yellow.50"} borderWidth="1px" borderColor={!occFrequencyDays && !jobFrequencyDays ? "red.200" : "yellow.200"} borderRadius="md" mt={freqError ? 1 : 2}>
                      <Text fontSize="xs" color={!occFrequencyDays && !jobFrequencyDays ? "red.700" : "yellow.800"}>
                        {occFrequencyDays !== ""
                          ? `This occurrence will repeat every ${occFrequencyDays} days, overriding the job's ${jobFrequencyDays ? `default of ${jobFrequencyDays} days` : "frequency (not set)"}.`
                          : jobFrequencyDays
                          ? `No override set — will use the job's default frequency of ${jobFrequencyDays} days.`
                          : "⚠ The parent job has no frequency set. Enter a frequency above to enable creating this occurrence."}
                      </Text>
                    </Box>
                  </div>
                )}
                {mode === "UPDATE" && (() => {
                  // Filter the status dropdown to only valid transitions
                  // for the occurrence's CURRENT status (defaultStatus,
                  // not the in-flight `status` state — otherwise the list
                  // would shift every time the user picks a new option).
                  // The server enforces the same table; this just avoids
                  // letting the user pick a value it will reject.
                  const allowedStatuses = validNextStatuses(workflow, defaultStatus ?? null, !!isAdmin);
                  return (
                    <div>
                      <Text mb="1">Status</Text>
                      <NativeSelect.Root>
                        <NativeSelect.Field
                          value={status}
                          onChange={(e) => setStatus(e.target.value)}
                        >
                          {allowedStatuses.map((s) => (
                            <option key={s} value={s}>{s === "CLOSED" ? "Closed" : prettyStatus(s)}</option>
                          ))}
                        </NativeSelect.Field>
                      </NativeSelect.Root>
                    </div>
                  );
                })()}
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
                  <Text mb="1">Job Tags</Text>
                  <JobTagPicker
                    selected={jobTags}
                    onChange={setJobTags}
                    customNote={jobType}
                    onCustomNoteChange={setJobType}
                    tagsConfig={jobTagsConfig}
                  />
                </div>
                {/* Instructions are managed via the Manage Instructions dialog */}
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
                        // Preserve the duration between start and end. Use
                        // noon UTC anchors so the day math is DST-stable;
                        // bizDateKey then renders the result in ET.
                        const diffMs = new Date(endAt + "T12:00:00Z").getTime() - new Date(oldStart + "T12:00:00Z").getTime();
                        const newEnd = new Date(new Date(val + "T12:00:00Z").getTime() + diffMs);
                        setEndAt(bizDateKey(newEnd));
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
                <div>
                  <Text mb="1">Price</Text>
                  <CurrencyInput
                    value={price}
                    onChange={setPrice}
                  />
                </div>
                <div>
                  <Text mb="1">Est. minutes</Text>
                  <Input
                    type="number"
                    value={estimatedMinutes}
                    onChange={(e) => setEstimatedMinutes(e.target.value)}
                    placeholder="e.g. 45"
                    min={1}
                  />
                  <Box px={2} py={1} mt={1} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" rounded="md">
                    <Text fontSize="2xs" color="yellow.700">Enter the time as if one person were completing the job alone. The app will automatically adjust the estimate when multiple workers are assigned.</Text>
                  </Box>
                </div>
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
                {/* INVOICE CHARGES ARE NOT EDITED HERE.
                    In CREATE mode this never worked properly: charges were
                    local state posted one-by-one after the occurrence came
                    back, with failures swallowed to console.error.

                    In UPDATE mode it duplicated the job card, which does the
                    same job through the shared ManageInvoiceChargesDialog —
                    the only surface that collects the client-visible detail
                    and "what we paid", and the only one that renders the
                    ledger-link picker.

                    A charge belongs to a visit that exists. Create the
                    occurrence, then add charges from its card.
                    See docs/features/job-materials.md. */}
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

                {mode === "CREATE" && jobGuidanceNote && (
                  <Box mt={2} borderWidth="1px" borderColor="blue.200" bg="blue.50" borderRadius="md" p={2}>
                    <Checkbox.Root
                      checked={includeGuidanceNote}
                      onCheckedChange={(e) => setIncludeGuidanceNote(!!e.checked)}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label fontSize="xs" fontWeight="semibold">
                        Include the job's default guidance description
                      </Checkbox.Label>
                    </Checkbox.Root>
                    <Text fontSize="xs" color="fg.muted" mt={1} whiteSpace="pre-wrap">
                      {jobGuidanceNote}
                    </Text>
                  </Box>
                )}

                {propertyId && (
                  <Box mt={2}>
                    <JobPropertyPhotosPicker
                      jobId={jobId ?? ""}
                      propertyId={propertyId}
                      occurrenceId={mode === "UPDATE" ? occurrenceId : undefined}
                      onSelectionChange={setPropertyPhotoIds}
                    />
                  </Box>
                )}

                {/* ADD-ON SERVICES ARE NOT EDITED HERE.
                    In CREATE mode this never worked: `addons` was local state
                    posted one at a time after the occurrence came back, with
                    every failure swallowed to console.error — so a service
                    added before hitting Create could silently not exist while
                    the operator watched it in a list.

                    In UPDATE mode it duplicated the job card, which adds
                    services through the shared ManageAddonsDialog — the only
                    surface that collects the client-visible detail.

                    A service belongs to a visit that exists. */}
              </VStack>
            </Dialog.Body>

            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
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
                {/* Never silently disable the submit. handleSave already
                    validates startAt and (for STANDARD) frequency and shows a
                    warning toast — disabling here just suppressed that
                    feedback, leaving users staring at a non-responsive button
                    (see the "Create Everything" silent-failure regression). */}
                <Button onClick={() => void handleSave()} loading={busy} disabled={busy}>
                  {submitLabel ?? (mode === "CREATE" ? "Create" : "Save")}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
    <ConfirmDialog
      open={revertConfirmOpen}
      title="Revert this paid job?"
      message={
        status === "PENDING_PAYMENT"
          ? "Changing status from Closed to Awaiting Payment will DELETE the recorded payment (and its worker splits), and remove the auto-created next occurrence if it hasn't been started. The original payment request token will also be reactivated. This is the same effect as the Revert Payment button — proceed only if you actually mean to undo the collection."
          : "Changing status from Closed to a pre-payment state will DELETE the recorded payment (and its worker splits), and remove the auto-created next occurrence if it hasn't been started. Proceed only if you mean to undo the collection."
      }
      warning="The payment row, splits, and (if untouched) the next-occurrence ghost will all be removed. This cannot be undone from the UI."
      confirmLabel="Yes, revert and delete payment"
      confirmColorPalette="red"
      onConfirm={() => {
        setRevertConfirmOpen(false);
        void handleSave(true);
      }}
      onCancel={() => setRevertConfirmOpen(false)}
    />
    </>
  );
}
