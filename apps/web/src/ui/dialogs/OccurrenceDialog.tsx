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
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import JobTagPicker, { jobTagLabel as _jobTagLabel, JOB_TAGS, type JobTagConfig } from "@/src/ui/components/JobTagPicker";
import JobPropertyPhotosPicker from "@/src/ui/components/JobPropertyPhotosPicker";
import { JOB_KIND, JOB_OCCURRENCE_STATUS } from "@/src/lib/types";
import { validNextStatuses } from "@/src/lib/jobTransitions";

const workflowItems = [
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
  defaultAddons?: { id: string; tag?: string | null; customLabel?: string | null; price: number }[];
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
  defaultAddons,
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
  const [status, setStatus] = useState("");
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
  // work — they don't touch inventory. Hide the inventory picker entirely
  // on those workflows (server enforces too).
  const inventoryEligible =
    workflow !== "TASK" &&
    workflow !== "REMINDER" &&
    workflow !== "EVENT" &&
    workflow !== "FOLLOWUP" &&
    workflow !== "ANNOUNCEMENT";
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
  const [addons, setAddons] = useState<{ id: string; tag?: string | null; customLabel?: string | null; price: number }[]>([]);
  const [addonTag, setAddonTag] = useState("");
  const [addonCustomLabel, setAddonCustomLabel] = useState("");
  const [addonPrice, setAddonPrice] = useState("");

  // Inline expenses. Custom rows create a paired BusinessExpense on save;
  // inventory rows create a SupplyHold + Expense pair via the supply-holds
  // endpoint. `fromInventory` flags rows already loaded from the DB; new
  // inventory rows carry `pendingHold` until they're POSTed on save.
  type InlineExpense = {
    id?: string;
    cost: number;
    description: string;
    category: string;
    isNew?: boolean;
    fromInventory?: boolean;
    pendingHold?: { supplyId: string; quantity: number; unit: string };
  };
  const [expenses, setExpenses] = useState<InlineExpense[]>([]);
  const [newExpCost, setNewExpCost] = useState("");
  const [newExpDesc, setNewExpDesc] = useState("");
  const [newExpCategory, setNewExpCategory] = useState("Supplies");

  // "Custom" vs "From inventory" mode toggle for the inline add row.
  const [addMode, setAddMode] = useState<"custom" | "inventory">("custom");
  type SupplyOption = {
    id: string;
    name: string;
    unit: string;
    jobPayoutCost: number;
    available: number;
  };
  const [suppliesAvail, setSuppliesAvail] = useState<SupplyOption[]>([]);
  const [pickedSupplyId, setPickedSupplyId] = useState("");
  const [pickedQty, setPickedQty] = useState("");
  const supplyCollection = useMemo(
    () =>
      createListCollection({
        items: suppliesAvail.map((s) => ({
          label: `${s.name} — ${s.available} ${s.unit} avail @ $${s.jobPayoutCost.toFixed(2)}/${s.unit}`,
          value: s.id,
        })),
      }),
    [suppliesAvail],
  );
  const pickedSupply = useMemo(
    () => suppliesAvail.find((s) => s.id === pickedSupplyId) ?? null,
    [suppliesAvail, pickedSupplyId],
  );
  const expenseCategoryItems = useMemo(
    () => [
      { label: "Advertising (line 8)", value: "Advertising" },
      { label: "Car and truck expenses (line 9)", value: "Car and truck expenses" },
      { label: "Contract labor (line 11)", value: "Contract labor" },
      { label: "Depreciation (line 13)", value: "Depreciation" },
      { label: "Insurance (line 15)", value: "Insurance" },
      { label: "Legal and professional services (line 17)", value: "Legal and professional services" },
      { label: "Office expense (line 18)", value: "Office expense" },
      { label: "Rent or lease — vehicles/equipment (line 20a)", value: "Rent or lease — vehicles/equipment" },
      { label: "Rent or lease — other business property (line 20b)", value: "Rent or lease — other business property" },
      { label: "Repairs and maintenance (line 21)", value: "Repairs and maintenance" },
      { label: "Supplies (line 22)", value: "Supplies" },
      { label: "Taxes and licenses (line 23)", value: "Taxes and licenses" },
      { label: "Travel (line 24a)", value: "Travel" },
      { label: "Meals (line 24b)", value: "Meals" },
      { label: "Utilities (line 25)", value: "Utilities" },
      { label: "Other (line 27a)", value: "Other" },
    ],
    [],
  );
  const expenseCategoryCollection = useMemo(() => createListCollection({ items: expenseCategoryItems }), [expenseCategoryItems]);

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
      setExpenses([]);
      setNewExpCost("");
      setNewExpDesc("");
      setAddMode("custom");
      setPickedSupplyId("");
      setPickedQty("");
      setAddons(defaultAddons ?? []);
      setAddonTag("");
      setAddonCustomLabel("");
      setAddonPrice("");
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
    apiGet<any[]>("/api/supplies")
      .then((list) => {
        if (!Array.isArray(list)) return setSuppliesAvail([]);
        setSuppliesAvail(
          list
            .filter((s) => !s.archivedAt)
            .map((s) => ({
              id: s.id,
              name: s.name,
              unit: s.unit,
              jobPayoutCost: Number(s.jobPayoutCost ?? 0),
              available: Number(s.available ?? 0),
            })),
        );
      })
      .catch(() => setSuppliesAvail([]));
    // Load existing expenses for UPDATE mode
    if (mode === "UPDATE" && occurrenceId && isAdmin) {
      apiGet<any[]>(`/api/admin/occurrences/${occurrenceId}/expenses`)
        .then((list) => setExpenses(
          (Array.isArray(list) ? list : []).map((e) => ({
            id: e.id,
            cost: e.cost,
            description: e.description,
            // Read from the linked BusinessExpense if present (set when the
            // worker logged the expense post-MVP-2). Falls back to "Supplies".
            category: e.businessExpense?.category ?? "Supplies",
            fromInventory: !!e.supplyHold,
          }))
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
        // Create any inline expenses against the new occurrence
        const newOccId = created?.id;
        if (newOccId && expenses.length > 0) {
          // Use admin endpoint if this dialog was opened in admin context
          const useAdmin = isAdmin || (createEndpoint ?? "").includes("/admin/");
          const expEndpoint = useAdmin
            ? `/api/admin/occurrences/${newOccId}/expenses`
            : `/api/occurrences/${newOccId}/expenses`;
          const holdsEndpointNew = useAdmin
            ? `/api/admin/occurrences/${newOccId}/supply-holds`
            : `/api/occurrences/${newOccId}/supply-holds`;
          for (const exp of expenses) {
            try {
              if (exp.pendingHold) {
                await apiPost(holdsEndpointNew, {
                  supplyId: exp.pendingHold.supplyId,
                  quantity: exp.pendingHold.quantity,
                });
              } else {
                await apiPost(expEndpoint, { cost: exp.cost, description: exp.description, category: exp.category });
              }
            } catch (err) {
              console.error("Failed to create expense:", err);
            }
          }
        }
        // Save property photo selections if changed
        if (newOccId && propertyPhotoIds !== null) {
          try {
            await apiPut(`/api/admin/occurrences/${newOccId}/property-photos`, { propertyPhotoIds });
          } catch (err) { console.error("Failed to save property photos:", err); }
        }
        // Save add-on services
        if (newOccId && addons.length > 0) {
          for (const addon of addons) {
            try {
              await apiPost(`/api/admin/occurrences/${newOccId}/addons`, {
                tag: addon.tag || undefined,
                customLabel: addon.customLabel || undefined,
                price: addon.price,
              });
            } catch (err) { console.error("Failed to create addon:", err); }
          }
        }
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
        // Create new expenses (custom or inventory), delete removed ones
        if (isAdmin && occurrenceId) {
          for (const exp of expenses) {
            if (exp.isNew) {
              try {
                if (exp.pendingHold) {
                  await apiPost(`/api/admin/occurrences/${occurrenceId}/supply-holds`, {
                    supplyId: exp.pendingHold.supplyId,
                    quantity: exp.pendingHold.quantity,
                  });
                } else {
                  await apiPost(`/api/admin/occurrences/${occurrenceId}/expenses`, { cost: exp.cost, description: exp.description, category: exp.category });
                }
              } catch {}
            }
          }
        }
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
                <div>
                  <Text mb="1">Expenses <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text></Text>
                  <Box mb={2} p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" borderRadius="md">
                    <Text fontSize="xs" color="blue.800">
                      Each expense added here is also recorded as a business expense (categorized for
                      Schedule C) and should be paid on the company account. Default category is{" "}
                      <Text as="span" fontWeight="semibold">Supplies</Text> — change per row if it fits a different tax line.
                    </Text>
                  </Box>
                  {expenses.length > 0 && (
                    <VStack align="stretch" gap={1} mb={2}>
                      {expenses.map((exp, idx) => (
                        <HStack key={exp.id ?? `new-${idx}`} gap={2} fontSize="xs">
                          <Text color="orange.600" flex="1">
                            ${exp.cost.toFixed(2)} — {exp.description}
                            {exp.fromInventory ? (
                              <Text as="span" color="blue.600" ml={1}>· Inventory</Text>
                            ) : (
                              <Text as="span" color="fg.muted" ml={1}>· {exp.category}</Text>
                            )}
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
                  {inventoryEligible && (
                    <HStack gap={1} mb={2} wrap="wrap">
                      <Button
                        size="xs"
                        variant={addMode === "custom" ? "solid" : "outline"}
                        onClick={() => setAddMode("custom")}
                      >
                        Custom
                      </Button>
                      <Button
                        size="xs"
                        variant={addMode === "inventory" ? "solid" : "outline"}
                        colorPalette={addMode === "inventory" ? "blue" : "gray"}
                        onClick={() => setAddMode("inventory")}
                        disabled={suppliesAvail.length === 0}
                        title={suppliesAvail.length === 0 ? "No supplies in inventory yet" : "Pull from inventory"}
                      >
                        From inventory
                      </Button>
                    </HStack>
                  )}
                  {inventoryEligible && addMode === "inventory" ? (
                    <VStack align="stretch" gap={2}>
                      <Select.Root
                        collection={supplyCollection}
                        value={pickedSupplyId ? [pickedSupplyId] : []}
                        onValueChange={(e) => setPickedSupplyId(e.value?.[0] ?? "")}
                        size="sm"
                        positioning={{ strategy: "fixed", hideWhenDetached: true }}
                      >
                        <Select.Control>
                          <Select.Trigger w="full">
                            <Select.ValueText placeholder="Pick a supply…" />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {supplyCollection.items.map((it) => (
                              <Select.Item key={it.value} item={it.value}>
                                <Select.ItemText>{it.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select.Root>
                      <HStack gap={2}>
                        <Box w="80px" flexShrink={0}>
                          <Input
                            type="number"
                            min={1}
                            step={1}
                            value={pickedQty}
                            onChange={(e) => setPickedQty(e.target.value)}
                            size="sm"
                            placeholder="Qty"
                          />
                        </Box>
                        <Box flex="1">
                          {pickedSupply && pickedQty && Number(pickedQty) > 0 && (
                            <Text fontSize="xs" color="fg.muted">
                              {Number(pickedQty)} {pickedSupply.unit} × ${pickedSupply.jobPayoutCost.toFixed(2)} = ${(Number(pickedQty) * pickedSupply.jobPayoutCost).toFixed(2)}
                              <Text as="span" color={Number(pickedQty) > pickedSupply.available ? "red.600" : "fg.muted"} ml={1}>
                                ({pickedSupply.available} available)
                              </Text>
                            </Text>
                          )}
                        </Box>
                        <Button
                          size="sm"
                          variant="outline"
                          colorPalette="blue"
                          disabled={
                            !pickedSupplyId ||
                            !pickedQty ||
                            !Number.isInteger(Number(pickedQty)) ||
                            Number(pickedQty) <= 0 ||
                            !!(pickedSupply && Number(pickedQty) > pickedSupply.available)
                          }
                          onClick={() => {
                            if (!pickedSupply) return;
                            const qty = Math.round(Number(pickedQty));
                            const cost = Math.round(qty * pickedSupply.jobPayoutCost * 100) / 100;
                            setExpenses((prev) => [
                              ...prev,
                              {
                                cost,
                                description: `${pickedSupply.name} × ${qty} ${pickedSupply.unit}`,
                                category: "Supplies",
                                isNew: true,
                                fromInventory: true,
                                pendingHold: { supplyId: pickedSupply.id, quantity: qty, unit: pickedSupply.unit },
                              },
                            ]);
                            // Optimistically reduce available so user can't double-add past stock
                            setSuppliesAvail((prev) =>
                              prev.map((s) => (s.id === pickedSupply.id ? { ...s, available: s.available - qty } : s)),
                            );
                            setPickedSupplyId("");
                            setPickedQty("");
                          }}
                        >
                          Add
                        </Button>
                      </HStack>
                    </VStack>
                  ) : (
                  <VStack align="stretch" gap={2}>
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
                    </HStack>
                    <HStack gap={2}>
                      <Box flex="1">
                        <Select.Root
                          collection={expenseCategoryCollection}
                          value={[newExpCategory]}
                          onValueChange={(e) => setNewExpCategory(e.value?.[0] ?? "Supplies")}
                          size="sm"
                          positioning={{ strategy: "fixed", hideWhenDetached: true }}
                        >
                          <Select.Control>
                            <Select.Trigger w="full">
                              <Select.ValueText placeholder="Supplies (line 22)" />
                            </Select.Trigger>
                          </Select.Control>
                          <Select.Positioner>
                            <Select.Content>
                              {expenseCategoryItems.map((it) => (
                                <Select.Item key={it.value} item={it.value}>
                                  <Select.ItemText>{it.label}</Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Positioner>
                        </Select.Root>
                      </Box>
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="orange"
                      disabled={!newExpCost || !newExpDesc.trim()}
                      onClick={() => {
                        const cost = parseFloat(newExpCost);
                        if (isNaN(cost) || cost <= 0) return;
                        setExpenses((prev) => [...prev, { cost, description: newExpDesc.trim(), category: newExpCategory, isNew: true }]);
                        setNewExpCost("");
                        setNewExpDesc("");
                        setNewExpCategory("Supplies");
                      }}
                    >
                      Add
                    </Button>
                    </HStack>
                  </VStack>
                  )}
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

                {/* Add-on services — not for estimates */}
                {workflow !== "ESTIMATE" && (
                  <Box mt={2} borderWidth="1px" borderColor="gray.200" borderRadius="md" p={2} bg="gray.50">
                    <VStack align="start" gap={2}>
                      <Text fontSize="xs" fontWeight="semibold" color="fg.muted">Add-on Services</Text>
                      {addons.map((addon) => (
                        <HStack key={addon.id} justify="space-between" w="full" fontSize="xs">
                          <Text>{addon.tag ? jobTagLabel(addon.tag) : addon.customLabel}</Text>
                          <HStack gap={2}>
                            <Text fontWeight="semibold">+${addon.price.toFixed(2)}</Text>
                            <Button size="xs" variant="ghost" colorPalette="red" px="1" minW="0" onClick={async () => {
                              if (mode === "UPDATE" && addon.id && !addon.id.startsWith("_new_")) {
                                try {
                                  await apiDelete(`/api/admin/occurrences/${occurrenceId}/addons/${addon.id}`);
                                } catch {}
                              }
                              setAddons((prev) => prev.filter((a) => a.id !== addon.id));
                            }}>
                              <X size={10} />
                            </Button>
                          </HStack>
                        </HStack>
                      ))}
                      <Box w="full">
                        <Text fontSize="xs" fontWeight="medium" mb={1}>Add a service</Text>
                        <Box display="flex" gap="4px" flexWrap="wrap" mb={2}>
                          {(() => {
                            const usedTags = new Set([...jobTags, ...addons.map((a) => a.tag).filter(Boolean) as string[]]);
                            const allTags = (jobTagsConfig ?? JOB_TAGS.map((k) => ({ key: k, label: jobTagLabel(k) }))).map((t) => typeof t === "string" ? t : t.key);
                            return allTags.filter((tag) => !usedTags.has(tag));
                          })().map((tag) => (
                            <Badge
                              key={tag}
                              size="sm"
                              colorPalette={addonTag === tag ? "blue" : "gray"}
                              variant={addonTag === tag ? "solid" : "outline"}
                              cursor="pointer"
                              px="2"
                              borderRadius="full"
                              onClick={() => { setAddonTag(addonTag === tag ? "" : tag); setAddonCustomLabel(""); }}
                            >
                              {jobTagLabel(tag)}
                            </Badge>
                          ))}
                        </Box>
                        {!addonTag && (
                          <Box mb={2}>
                            <input
                              type="text"
                              value={addonCustomLabel}
                              onChange={(e) => setAddonCustomLabel(e.target.value)}
                              placeholder="Or custom service..."
                              style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "13px" }}
                            />
                          </Box>
                        )}
                        <HStack gap={2}>
                          <Box flex="1">
                            <CurrencyInput value={addonPrice} onChange={setAddonPrice} size="sm" />
                          </Box>
                          <Button
                            size="xs"
                            colorPalette="blue"
                            disabled={!addonPrice || Number(addonPrice) <= 0 || (!addonTag && !addonCustomLabel.trim())}
                            onClick={async () => {
                              const newAddon = {
                                id: `_new_${Date.now()}`,
                                tag: addonTag || null,
                                customLabel: addonCustomLabel.trim() || null,
                                price: Number(addonPrice),
                              };
                              // If UPDATE mode, save immediately to API
                              if (mode === "UPDATE" && occurrenceId) {
                                try {
                                  const created = await apiPost<any>(`/api/admin/occurrences/${occurrenceId}/addons`, {
                                    tag: addonTag || undefined,
                                    customLabel: addonCustomLabel.trim() || undefined,
                                    price: Number(addonPrice),
                                  });
                                  setAddons((prev) => [...prev, created]);
                                } catch (err) {
                                  publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed.", err) });
                                  return;
                                }
                              } else {
                                setAddons((prev) => [...prev, newAddon]);
                              }
                              setAddonTag("");
                              setAddonCustomLabel("");
                              setAddonPrice("");
                            }}
                          >
                            + Add
                          </Button>
                        </HStack>
                      </Box>
                    </VStack>
                  </Box>
                )}
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
                {/* Never silently disable the submit. handleSave already
                    validates startAt and (for STANDARD) frequency and shows a
                    warning toast — disabling here just suppressed that
                    feedback, leaving users staring at a non-responsive button
                    (see the "Create Everything" silent-failure regression). */}
                <Button onClick={handleSave} loading={busy} disabled={busy}>
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
