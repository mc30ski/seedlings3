"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Select,
  Text,
  Spinner,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { AlertTriangle, CalendarRange, Filter, Layers, LayoutList, Plus, RefreshCw, Tag, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { getLocation } from "@/src/lib/geo";
import {
  determineRoles,
  jobStatusColor,
  occurrenceStatusColor,
  prettyStatus,
  clientLabel,
} from "@/src/lib/lib";
import {
  type TabPropsType,
  JOB_KIND,
  JOB_STATUS,
  JOB_OCCURRENCE_STATUS,
  type JobListItem,
  type JobDetail,
  type JobOccurrenceFull,
} from "@/src/lib/types";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import StatusButton from "@/src/ui/components/StatusButton";
import JobDialog from "@/src/ui/dialogs/JobDialog";
import OccurrenceDialog from "@/src/ui/dialogs/OccurrenceDialog";
import AssigneeDialog from "@/src/ui/dialogs/AssigneeDialog";
import DeleteDialog, { type ToDeleteProps } from "@/src/ui/dialogs/DeleteDialog";
import ScheduleNextDialog from "@/src/ui/dialogs/ScheduleNextDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import AcceptPaymentDialog from "@/src/ui/dialogs/AcceptPaymentDialog";
import AddExpenseDialog from "@/src/ui/dialogs/AddExpenseDialog";
import { MapLink, TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch, onEventSearchRun } from "@/src/lib/bus";
import { type DatePreset, computeDatesFromPreset, PRESET_LABELS } from "@/src/lib/datePresets";
import OccurrencePhotos from "@/src/ui/components/OccurrencePhotos";
import { type JobOccurrenceAssigneeWithUser } from "@/src/lib/types";

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const kindStates = ["ALL", ...JOB_KIND] as const;
const jobStatusStates = ["ALL", ...JOB_STATUS] as const;
const occStatusStates = ["ALL", "UNCLAIMED", ...JOB_OCCURRENCE_STATUS.filter((s) => s !== "ARCHIVED")] as const;

const quickDateItemsBase = [
  { label: "Today", value: "today" },
  { label: "Next 3 days", value: "next3" },
  { label: "Next week", value: "nextWeek" },
  { label: "Next month", value: "nextMonth" },
  { label: "Future", value: "future" },
  { label: "Recent & Future", value: "recent" },
  { label: "Yesterday", value: "yesterday" },
  { label: "Last week", value: "lastWeek" },
];

export default function ServicesTab({
  me,
  purpose = "ADMIN",
}: TabPropsType) {
  const { isAvail, forAdmin, isSuper } = determineRoles(me, purpose);
  const inputRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [kind, setKind] = usePersistedState<string[]>("services_kind", ["ALL"]);
  const [jobStatusFilter, setJobStatusFilter] = usePersistedState<string[]>("services_jobStatus", ["ALL"]);
  const [occStatusFilter, setOccStatusFilter] = usePersistedState<string[]>("services_occStatus", ["ALL"]);
  const [typeFilter, setTypeFilter] = usePersistedState<string[]>("services_type", ["ALL"]);

  const [overdueActive, setOverdueActive] = usePersistedState("services_overdue", false);
  const [overdueCount, setOverdueCount] = useState(0);
  const presetBeforeOverdueRef = useRef<DatePreset>("nextMonth");
  const [datePreset, setDatePreset] = usePersistedState<DatePreset>("services_datePreset", "nextMonth");
  const presetDates = useMemo(() => computeDatesFromPreset(datePreset), [datePreset]);
  const [dateFrom, setDateFrom] = useState(presetDates.from);
  const [dateTo, setDateTo] = useState(presetDates.to);
  const [quickDate, setQuickDate] = useState<string[]>([]);

  useEffect(() => {
    if (datePreset) {
      const d = computeDatesFromPreset(datePreset);
      setDateFrom(d.from);
      setDateTo(d.to);
    }
  }, [datePreset]);

  const quickDateItems = useMemo(
    () =>
      forAdmin
        ? [...quickDateItemsBase, { label: "All time", value: "all" }]
        : quickDateItemsBase,
    [forAdmin]
  );
  const quickDateCollection = useMemo(
    () => createListCollection({ items: quickDateItems }),
    [quickDateItems]
  );

  const kindItems = useMemo(
    () => kindStates.map((s) => ({ label: prettyStatus(s), value: s })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );
  const jobStatusItems = useMemo(
    () => jobStatusStates.map((s) => ({ label: prettyStatus(s), value: s })),
    []
  );
  const jobStatusCollection = useMemo(
    () => createListCollection({ items: jobStatusItems }),
    [jobStatusItems]
  );
  const typeItems = useMemo(
    () => [
      { label: "All Types", value: "ALL" },
      { label: "One-off", value: "ONE_OFF" },
      { label: "Estimate", value: "ESTIMATE" },
      { label: "Tentative", value: "TENTATIVE" },
    ],
    []
  );
  const typeCollection = useMemo(
    () => createListCollection({ items: typeItems }),
    [typeItems]
  );

  const occStatusItems = useMemo(
    () => occStatusStates.map((s) => ({ label: s === "UNCLAIMED" ? "Unclaimed" : prettyStatus(s), value: s })),
    []
  );
  const occStatusCollection = useMemo(
    () => createListCollection({ items: occStatusItems }),
    [occStatusItems]
  );
  const [items, setItems] = useState<JobListItem[]>([]);
  const [loading, setLoading] = useState(false);

  const [jobDetails, setJobDetails] = useState<Record<string, JobDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});

  const [jobDialogOpen, setJobDialogOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<JobListItem | null>(null);

  const [occurrenceDialogOpen, setOccurrenceDialogOpen] = useState(false);
  const [promptOccurrenceOpen, setPromptOccurrenceOpen] = useState(false);
  const [occurrenceJobId, setOccurrenceJobId] = useState<string>("");
  const [occurrenceDefaultNotes, setOccurrenceDefaultNotes] = useState<string | null>(null);
  const [occurrenceDefaultPrice, setOccurrenceDefaultPrice] = useState<number | null>(null);
  const [occurrenceDefaultEstMins, setOccurrenceDefaultEstMins] = useState<number | null>(null);
  const [occurrenceJobHasFrequency, setOccurrenceJobHasFrequency] = useState(false);

  const [editOccurrenceDialogOpen, setEditOccurrenceDialogOpen] = useState(false);
  const [editingOccurrence, setEditingOccurrence] = useState<JobOccurrenceFull | null>(null);
  const [editOccurrenceJobId, setEditOccurrenceJobId] = useState<string>("");

  const [assigneeDialogOpen, setAssigneeDialogOpen] = useState(false);
  const [assigneeOccurrenceId, setAssigneeOccurrenceId] = useState<string>("");
  const [assigneeCurrentAssignees, setAssigneeCurrentAssignees] = useState<JobOccurrenceAssigneeWithUser[]>([]);
  const [assigneeJobId, setAssigneeJobId] = useState<string>("");

  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  type DeleteTarget = ToDeleteProps & { deleteType: "archived-job" | "archived-occurrence"; jobId?: string };
  const [toDelete, setToDelete] = useState<DeleteTarget | null>(null);

  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    colorPalette: string;
    onConfirm: ((inputValue: string) => void) | (() => void);
    inputPlaceholder?: string;
    inputLabel?: string;
  } | null>(null);

  const [acceptPaymentOpen, setAcceptPaymentOpen] = useState(false);
  const [acceptPaymentOcc, setAcceptPaymentOcc] = useState<JobOccurrenceFull | null>(null);
  const [expenseDialogOccId, setExpenseDialogOccId] = useState<string | null>(null);
  const [expenseDialogJobId, setExpenseDialogJobId] = useState<string | null>(null);
  const [acceptPaymentJobId, setAcceptPaymentJobId] = useState<string>("");

  const [scheduleNextOpen, setScheduleNextOpen] = useState(false);
  const [scheduleNextData, setScheduleNextData] = useState<{
    jobId: string;
    frequencyDays: number;
    closedOccurrence: { startAt?: string | null; endAt?: string | null; notes?: string | null; price?: number | null };
  } | null>(null);

  async function load(displayLoading = true) {
    setLoading(displayLoading);
    try {
      const list = await apiGet<JobListItem[]>("/api/admin/jobs?status=ALL");
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load jobs.", err),
      });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function refreshOverdueCount() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const list = await apiGet<{ id: string; status: string }[]>(
        `/api/occurrences?to=${localDate(yesterday)}`
      );
      const count = (Array.isArray(list) ? list : []).filter(
        (o) => o.status !== "CLOSED" && o.status !== "ARCHIVED"
      ).length;
      setOverdueCount(count);
    } catch {
      // silently ignore
    }
  }

  useEffect(() => {
    void refreshOverdueCount();
  }, [items]);

  useEffect(() => {
    onEventSearchRun("paymentsTabToServicesTabSearch", setQ, inputRef, setHighlightId);
  }, []);

  async function loadDetail(jobId: string, force = false) {
    if (!force && (jobDetails[jobId] || detailLoading[jobId])) return;
    setDetailLoading((prev) => ({ ...prev, [jobId]: true }));
    try {
      const detail = await apiGet<JobDetail>(`/api/admin/jobs/${jobId}`);
      setJobDetails((prev) => ({ ...prev, [jobId]: detail }));
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load job details.", err),
      });
    } finally {
      setDetailLoading((prev) => ({ ...prev, [jobId]: false }));
    }
  }

  function toggleExpand(jobId: string) {
    const next = !expandedMap[jobId];
    setExpandedMap((prev) => ({ ...prev, [jobId]: next }));
    if (next) void loadDetail(jobId);
  }

  async function patchJobStatus(job: JobListItem, newStatus: string) {
    try {
      await apiPatch(`/api/admin/jobs/${job.id}`, { status: newStatus });
      await load(false);
      publishInlineMessage({
        type: "SUCCESS",
        text: `Job status updated to ${prettyStatus(newStatus)}.`,
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Update job failed.", err),
      });
    }
  }

  async function patchOccurrenceStatus(occurrenceId: string, jobId: string, newStatus: string, notes?: string) {
    // Capture occurrence data before the API call for schedule-next prompt
    const detail = jobDetails[jobId];
    const occ = detail?.occurrences.find((o) => o.id === occurrenceId);
    const job = items.find((j) => j.id === jobId);
    try {
      const payload: Record<string, unknown> = { status: newStatus };
      if (notes) payload.notes = notes;
      if (newStatus === "IN_PROGRESS" || newStatus === "PENDING_PAYMENT" || newStatus === "CLOSED") {
        const loc = await getLocation();
        if (loc) {
          if (newStatus === "IN_PROGRESS") { payload.startLat = loc.lat; payload.startLng = loc.lng; }
          else { payload.completeLat = loc.lat; payload.completeLng = loc.lng; }
        }
      }
      await apiPatch(`/api/admin/occurrences/${occurrenceId}`, payload);
      void loadDetail(jobId, true);
      publishInlineMessage({ type: "SUCCESS", text: "Occurrence updated." });

      // Prompt to schedule next occurrence if job has a frequency (skip for one-off)
      if (newStatus === "CLOSED" && job?.frequencyDays && occ && !occ.isOneOff) {
        setScheduleNextData({
          jobId,
          frequencyDays: job.frequencyDays,
          closedOccurrence: {
            startAt: occ.startAt,
            endAt: occ.endAt,
            notes: occ.notes,
            price: occ.price,
          },
        });
        setScheduleNextOpen(true);
      }
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Update occurrence failed.", err),
      });
    }
  }

  async function toggleTentative(occurrenceId: string, jobId: string, currentlyTentative: boolean) {
    try {
      await apiPatch(`/api/admin/occurrences/${occurrenceId}`, { isTentative: !currentlyTentative });
      void loadDetail(jobId, true);
      publishInlineMessage({
        type: "SUCCESS",
        text: currentlyTentative ? "Occurrence confirmed." : "Occurrence marked as tentative.",
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Update occurrence failed.", err),
      });
    }
  }

  async function deleteJob(jobId: string) {
    try {
      await apiDelete(`/api/admin/jobs/${jobId}`);
      await load(false);
      publishInlineMessage({ type: "SUCCESS", text: "Job deleted." });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Delete job failed.", err),
      });
    }
  }

  async function openDeleteJobDialog(job: JobListItem) {
    // Ensure detail is loaded so we can check occurrence count
    let detail = jobDetails[job.id];
    if (!detail) {
      try {
        detail = await apiGet<JobDetail>(`/api/admin/jobs/${job.id}`);
        setJobDetails((prev) => ({ ...prev, [job.id]: detail! }));
      } catch {
        // proceed without detail; API will guard server-side
      }
    }

    const occurrenceCount = detail?.occurrences.length ?? 0;
    const hasOccurrences = occurrenceCount > 0;
    const superRequired = !isSuper;

    setToDelete({
      deleteType: "archived-job",
      id: job.id,
      title: "Delete job?",
      summary: job.property?.displayName ?? job.id,
      disabled: hasOccurrences || superRequired,
      details: hasOccurrences ? (
        <Text color="red.500">
          This job has {occurrenceCount} occurrence{occurrenceCount !== 1 ? "s" : ""}. Delete all job occurrences before deleting the job.
        </Text>
      ) : superRequired ? (
        <Text color="red.500">You must be a Super Admin to delete.</Text>
      ) : undefined,
    });
  }

  async function archiveJob(jobId: string) {
    try {
      await apiPost(`/api/admin/jobs/${jobId}/archive`);
      await load(false);
      publishInlineMessage({ type: "SUCCESS", text: "Job archived." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Archive job failed.", err) });
    }
  }

  async function deleteOccurrence(occurrenceId: string, jobId: string) {
    try {
      await apiDelete(`/api/admin/occurrences/${occurrenceId}`);
      void loadDetail(jobId, true);
      publishInlineMessage({ type: "SUCCESS", text: "Occurrence deleted." });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Delete occurrence failed.", err),
      });
    }
  }

  async function archiveOccurrence(occurrenceId: string, jobId: string) {
    try {
      await apiPost(`/api/admin/occurrences/${occurrenceId}/archive`);
      void loadDetail(jobId, true);
      publishInlineMessage({ type: "SUCCESS", text: "Occurrence archived." });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Archive occurrence failed.", err),
      });
    }
  }

  const filtered = useMemo(() => {
    // If navigated here by ID, show only that entity
    if (highlightId) {
      const exact = items.find((r) => r.id === highlightId);
      if (exact) return [exact];
    }

    let rows = items;
    const jsf = jobStatusFilter[0];
    if (jsf !== "ALL") rows = rows.filter((i) => i.status === jsf);
    if (kind[0] !== "ALL") rows = rows.filter((i) => i.kind === kind[0]);
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((r) =>
        [r.property?.displayName, r.property?.client?.displayName, r.property?.street1, r.property?.city, r.property?.state, r.kind, r.status, r.notes]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(qlc))
      );
    }
    return rows;
  }, [items, q, kind, jobStatusFilter]);

  if (!isAvail) return <UnavailableNotice />;
  if (loading && items.length === 0) return <LoadingCenter />;

  return (
    <Box w="full">
      <HStack mb={3} gap={2}>
        <SearchWithClear
          ref={inputRef}
          value={q}
          onChange={(v) => { setQ(v); setHighlightId(null); }}
          inputId="services-search"
          placeholder="Search…"
        />
        <Select.Root
          collection={kindCollection}
          value={kind}
          onValueChange={(e) => setKind(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-blue-100)", borderRadius: "6px" }}>
              <LayoutList size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {kindItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={jobStatusCollection}
          value={jobStatusFilter}
          onValueChange={(e) => setJobStatusFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-purple-100)", borderRadius: "6px" }}>
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {jobStatusItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={occStatusCollection}
          value={occStatusFilter}
          onValueChange={(e) => setOccStatusFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-teal-100)", borderRadius: "6px" }}>
              <Layers size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {occStatusItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Select.Root
          collection={typeCollection}
          value={typeFilter}
          onValueChange={(e) => setTypeFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-orange-100)", borderRadius: "6px" }}>
              <Tag size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {typeItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Button
          size="sm"
          variant="ghost"
          px="2"
          minW="0"
          disabled={kind[0] === "ALL" && jobStatusFilter[0] === "ALL" && occStatusFilter[0] === "ALL" && typeFilter[0] === "ALL" && !overdueActive}
          onClick={() => {
            setKind(["ALL"]);
            setJobStatusFilter(["ALL"]);
            setOccStatusFilter(["ALL"]);
            setTypeFilter(["ALL"]);
            setOverdueActive(false);
            setDatePreset("nextMonth");
          }}
        >
          <X size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          loading={loading}
          px="2"
        >
          <RefreshCw size={14} />
        </Button>
        {forAdmin && (
          <Button
            size="sm"
            px="2"
            minW="0"
            variant="solid"
            bg="black"
            color="white"
            onClick={() => {
              setEditingJob(null);
              setJobDialogOpen(true);
            }}
          >
            <Plus size={16} strokeWidth={2.5} />
          </Button>
        )}
      </HStack>

      <HStack mb={3} gap={2} align="center">
        <DateInput
          value={dateFrom}
          onChange={(val) => {
            setDateFrom(val);
            setDatePreset(null);
            setOverdueActive(false);
            if (dateTo && val && val > dateTo) setDateTo(val);
          }}
        />
        <Text fontSize="sm">–</Text>
        <DateInput
          value={dateTo}
          onChange={(val) => {
            setDateTo(val);
            setDatePreset(null);
            setOverdueActive(false);
            if (dateFrom && val && val < dateFrom) setDateFrom(val);
          }}
        />
        <Select.Root
          collection={quickDateCollection}
          value={quickDate}
          onValueChange={(e) => {
            setQuickDate(e.value);
            const val = e.value[0] as DatePreset;
            if (!val) return;
            if (val === "all") {
              setConfirmAction({
                title: "Load All Data",
                message:
                  "This will load all occurrences for all time. This may be slow. Are you sure?",
                confirmLabel: "Load All",
                colorPalette: "orange",
                onConfirm: () => {
                  setDatePreset("all");
                },
              });
              requestAnimationFrame(() => setQuickDate([]));
              return;
            }
            setDatePreset(val);
            setOverdueActive(false);
            requestAnimationFrame(() => setQuickDate([]));
          }}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2">
              <CalendarRange size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {quickDateItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        <Button
          size="sm"
          variant={overdueActive ? "solid" : "ghost"}
          px="2"
          onClick={() => {
            if (overdueActive) {
              setOverdueActive(false);
              setDatePreset(presetBeforeOverdueRef.current ?? "nextMonth");
            } else {
              presetBeforeOverdueRef.current = datePreset;
              const yesterday = new Date();
              yesterday.setDate(yesterday.getDate() - 1);
              setDatePreset(null);
              setDateFrom("");
              setDateTo(localDate(yesterday));
              setOccStatusFilter(["ALL"]);
              setOverdueActive(true);
            }
          }}
          css={overdueActive ? {
            background: "var(--chakra-colors-red-100)",
            color: "var(--chakra-colors-red-700)",
            border: "1px solid var(--chakra-colors-red-400)",
            "&:hover": { background: "var(--chakra-colors-red-200)" },
          } : undefined}
        >
          <AlertTriangle size={14} color="var(--chakra-colors-red-500)" />
          {!overdueActive && overdueCount > 0 && (
            <Badge
              size="xs"
              colorPalette="red"
              variant="solid"
              borderRadius="full"
              px="1.5"
              fontSize="2xs"
              lineHeight="1"
              minW="0"
            >
              {overdueCount}
            </Badge>
          )}
        </Button>
      </HStack>

      {(kind[0] !== "ALL" || jobStatusFilter[0] !== "ALL" || occStatusFilter[0] !== "ALL" || typeFilter[0] !== "ALL" || overdueActive || datePreset) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          {datePreset && (
            <Badge size="sm" colorPalette="green" variant="subtle">
              {PRESET_LABELS[datePreset] ?? datePreset}
            </Badge>
          )}
          {!datePreset && !overdueActive && (dateFrom || dateTo) && (
            <Badge size="sm" colorPalette="gray" variant="subtle">
              Custom dates
            </Badge>
          )}
          {overdueActive && (
            <Badge size="sm" colorPalette="red" variant="solid">
              Overdue
            </Badge>
          )}
          {kind[0] !== "ALL" && (
            <Badge size="sm" colorPalette="blue" variant="solid">
              {kindItems.find((i) => i.value === kind[0])?.label}
            </Badge>
          )}
          {jobStatusFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="purple" variant="solid">
              {jobStatusItems.find((i) => i.value === jobStatusFilter[0])?.label}
            </Badge>
          )}
          {occStatusFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="teal" variant="solid">
              {occStatusItems.find((i) => i.value === occStatusFilter[0])?.label}
            </Badge>
          )}
          {typeFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="orange" variant="solid">
              {typeItems.find((i) => i.value === typeFilter[0])?.label}
            </Badge>
          )}
        </HStack>
      )}

      <Box position="relative">
        {loading && items.length > 0 && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
      <VStack align="stretch" gap={3}>
        {filtered.length === 0 && (
          <Box p="8" color="fg.muted">
            No jobs match current filters.
          </Box>
        )}

        {filtered.map((job) => {
          const expanded = !!expandedMap[job.id];
          const detail = jobDetails[job.id];
          const isLoadingDetail = !!detailLoading[job.id];
          const osf = occStatusFilter[0];
          const tf = typeFilter[0];
          const visibleOccs = detail
            ? detail.occurrences.filter((o: JobOccurrenceFull) => {
                if (o.startAt) {
                  const d = o.startAt.slice(0, 10);
                  if (dateFrom && d < dateFrom) return false;
                  if (dateTo && d > dateTo) return false;
                }
                if (tf === "ONE_OFF" && !o.isOneOff) return false;
                if (tf === "ESTIMATE" && !o.isEstimate) return false;
                if (tf === "TENTATIVE" && !o.isTentative) return false;
                if (overdueActive && (o.status === "CLOSED" || o.status === "ARCHIVED")) return false;
                if (osf === "ALL") return true;
                const isUnclaimed = o.assignees.length === 0;
                if (osf === "UNCLAIMED") return isUnclaimed;
                return o.status === osf;
              })
            : [];

          return (
            <Card.Root key={job.id} variant="outline">
              <Card.Header py="3" px="4" pb="0">
                <HStack gap={3} justify="space-between" align="start">
                  <VStack align="start" gap={0} flex="1" minW={0}>
                    <Text fontSize="md" fontWeight="semibold">
                      {job.property?.displayName ?? job.propertyId}
                      {job.property?.client?.displayName && (
                        <> — {clientLabel(job.property.client.displayName)}</>
                      )}
                    </Text>
                    <HStack gap={3} fontSize="xs">
                      {job.property?.displayName && (
                        <TextLink
                          text="View Property"
                          onClick={() =>
                            openEventSearch(
                              "jobsTabToPropertiesTabSearch",
                              job.property?.displayName ?? "",
                              forAdmin,
                            )
                          }
                        />
                      )}
                    </HStack>
                  </VStack>
                  <Box display="flex" gap={1} flexShrink={0} flexDirection={{ base: "column", md: "row" }} alignItems="flex-end">
                    <StatusBadge
                      status={job.status}
                      palette={jobStatusColor(job.status)}
                      variant="subtle"
                    />
                    <StatusBadge status={job.kind} palette="gray" variant="outline" />
                  </Box>
                </HStack>
                {(job.property?.street1 || job.property?.city) && (
                  <Box mt="1" fontSize="sm">
                    <MapLink address={[job.property.street1, job.property.city, job.property.state].filter(Boolean).join(", ")} />
                  </Box>
                )}
              </Card.Header>

              <Card.Body py="3" px="4" pt="0">
                <VStack align="start" gap={0} mb={2}>
                  <Text fontSize="xs" color="fg.muted">
                    Default price:{" "}
                    {job.defaultPrice != null ? (
                      <b>${job.defaultPrice.toFixed(2)}</b>
                    ) : (
                      <span>Not set</span>
                    )}
                  </Text>
                  {job.estimatedMinutes != null && (
                    <Text fontSize="xs" color="fg.muted">
                      Est. duration: {job.estimatedMinutes >= 60
                        ? `${Math.floor(job.estimatedMinutes / 60)}h ${job.estimatedMinutes % 60}m`
                        : `${job.estimatedMinutes}m`}
                    </Text>
                  )}
                  {job.frequencyDays && (
                    <Text fontSize="xs" color="fg.muted">
                      Frequency: every {job.frequencyDays} day{job.frequencyDays !== 1 ? "s" : ""}
                    </Text>
                  )}
                  {job.notes && (
                    <Text fontSize="xs" color="fg.muted">
                      {job.notes}
                    </Text>
                  )}
                </VStack>
                {(detail ? detail.occurrences.length === 0 : (job.occurrenceCount ?? 0) === 0) ? (
                  <Text fontSize="xs" color="fg.muted">No occurrences</Text>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => toggleExpand(job.id)}
                  >
                    {expanded
                      ? `Hide occurrences (${detail ? detail.occurrences.length : (job.occurrenceCount ?? 0)}) ▲`
                      : `Show occurrences (${detail ? detail.occurrences.length : (job.occurrenceCount ?? 0)}) ▼`}
                  </Button>
                )}

                {expanded && (
                  <Box mt={2}>
                    {isLoadingDetail && !detail && (
                      <Text fontSize="xs" color="fg.muted">
                        Loading…
                      </Text>
                    )}
                    {detail && detail.occurrences.length === 0 && (
                      <Text fontSize="xs" color="fg.muted">
                        No occurrences.
                      </Text>
                    )}
                    {detail && detail.occurrences.length > 0 && visibleOccs.length === 0 && (
                      <Text fontSize="xs" color="fg.muted">
                        No occurrences match the current status filters.
                      </Text>
                    )}
                    {detail && visibleOccs.map((occ: JobOccurrenceFull) => (
                      <Box
                        key={occ.id}
                        p={2}
                        borderWidth="1px"
                        rounded="md"
                        mb={2}
                      >
                        <HStack justify="space-between" align="center">
                          <VStack align="start" gap={0}>
                            <Text fontSize="xs" fontWeight="medium">
                              {occ.startAt
                                ? new Date(occ.startAt).toLocaleDateString()
                                : "—"}
                            </Text>
                            {occ.assignees.length === 0 ? (
                              <Text fontSize="xs" color="orange.500" fontWeight="medium">
                                Unclaimed — available to pick up
                              </Text>
                            ) : (
                              <VStack align="start" gap={0}>
                                {occ.assignees.map((a) => {
                                  const isClaimer = a.assignedById === a.userId;
                                  return (
                                    <Text
                                      key={a.userId}
                                      fontSize="xs"
                                      fontWeight={isClaimer ? "medium" : "normal"}
                                      color={isClaimer ? "teal.700" : "fg.muted"}
                                    >
                                      {a.user.displayName ?? a.user.email ?? a.userId}
                                      {isClaimer ? " · Claimer" : ""}
                                    </Text>
                                  );
                                })}
                              </VStack>
                            )}
                            <Text fontSize="xs" color="fg.muted">
                              Price:{" "}
                              {occ.price != null ? (
                                <b>${occ.price.toFixed(2)}</b>
                              ) : (
                                <span>Not set</span>
                              )}
                            </Text>
                            {(occ.estimatedMinutes != null || (occ.startedAt && occ.completedAt)) && (
                              <HStack fontSize="xs" gap={2}>
                                {occ.estimatedMinutes != null && (
                                  <Text color="fg.muted">Est: {occ.estimatedMinutes >= 60 ? `${Math.floor(occ.estimatedMinutes / 60)}h ${occ.estimatedMinutes % 60}m` : `${occ.estimatedMinutes}m`}</Text>
                                )}
                                {occ.startedAt && occ.completedAt && (() => {
                                  const actual = (new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000;
                                  const fmt = actual >= 60 ? `${Math.floor(actual / 60)}h ${Math.round(actual % 60)}m` : `${Math.round(actual)}m`;
                                  const color = occ.estimatedMinutes
                                    ? actual <= occ.estimatedMinutes ? "green.600" : "red.600"
                                    : "fg.muted";
                                  return <Text color={color} fontWeight="medium">Actual: {fmt}</Text>;
                                })()}
                              </HStack>
                            )}
                            {occ.startedAt && (
                              <Text fontSize="xs" color="fg.muted">
                                Start Time: {new Date(occ.startedAt).toLocaleString()}
                              </Text>
                            )}
                            {occ.completedAt && (
                              <Text fontSize="xs" color="fg.muted">
                                Complete Time: {new Date(occ.completedAt).toLocaleString()}
                              </Text>
                            )}
                            {occ.notes && (
                              <Text fontSize="xs" color="fg.muted">
                                {occ.notes}
                              </Text>
                            )}
                            {(occ.startLat != null || occ.completeLat != null) && (
                              <VStack align="start" gap={0} fontSize="xs" color="fg.muted">
                                {occ.startLat != null && occ.startLng != null && (
                                  <a href={`https://maps.google.com/?q=${occ.startLat},${occ.startLng}`} target="_blank" rel="noopener" style={{ color: "var(--chakra-colors-blue-600)" }}>
                                    Start Location: {occ.startLat.toFixed(4)}, {occ.startLng.toFixed(4)}
                                  </a>
                                )}
                                {occ.completeLat != null && occ.completeLng != null && (
                                  <a href={`https://maps.google.com/?q=${occ.completeLat},${occ.completeLng}`} target="_blank" rel="noopener" style={{ color: "var(--chakra-colors-blue-600)" }}>
                                    Complete Location: {occ.completeLat.toFixed(4)}, {occ.completeLng.toFixed(4)}
                                  </a>
                                )}
                              </VStack>
                            )}
                            {(occ as any).proposalAmount != null && (
                              <Box mt={1} p={1} bg="purple.50" rounded="sm">
                                <Text fontSize="xs" fontWeight="medium" color="purple.700">
                                  Proposal: ${(occ as any).proposalAmount.toFixed(2)}
                                </Text>
                                {(occ as any).proposalNotes && (
                                  <Text fontSize="xs" color="purple.600">{(occ as any).proposalNotes}</Text>
                                )}
                              </Box>
                            )}
                            {(occ as any).rejectionReason && (
                              <Box mt={1} p={1} bg="red.50" rounded="sm">
                                <Text fontSize="xs" color="red.700">
                                  Rejected: {(occ as any).rejectionReason}
                                </Text>
                              </Box>
                            )}
                            {occ.payment && (
                              <Box mt={1} p={1} bg="green.50" rounded="sm">
                                <Text fontSize="xs" fontWeight="medium" color="green.700">
                                  Paid: ${occ.payment.amountPaid.toFixed(2)} via {prettyStatus(occ.payment.method)}
                                </Text>
                                {occ.payment.note && (
                                  <Text fontSize="xs" color="green.600">{occ.payment.note}</Text>
                                )}
                                {occ.payment.splits && occ.payment.splits.length > 1 && (
                                  <VStack align="start" gap={0} mt={0.5}>
                                    {occ.payment.splits.map((sp: any) => (
                                      <Text key={sp.userId} fontSize="xs" color="green.600">
                                        {sp.user?.displayName ?? sp.userId}: ${sp.amount.toFixed(2)}
                                      </Text>
                                    ))}
                                  </VStack>
                                )}
                                {(occ.payment as any).platformFeeAmount != null && (occ.payment as any).platformFeeAmount > 0 && (
                                  <Text fontSize="xs" color="orange.600" mt={0.5}>
                                    Platform fee ({(occ.payment as any).platformFeePercent}%): −${(occ.payment as any).platformFeeAmount.toFixed(2)}
                                  </Text>
                                )}
                              </Box>
                            )}

                            {occ.expenses && occ.expenses.length > 0 && (
                              <Box mt={1} p={1} bg="orange.50" rounded="sm">
                                <Text fontSize="xs" fontWeight="medium" color="orange.700">
                                  Expenses: ${occ.expenses.reduce((s: number, e: any) => s + e.cost, 0).toFixed(2)}
                                </Text>
                                <VStack align="start" gap={0} mt={0.5}>
                                  {occ.expenses.map((exp: any) => (
                                    <HStack key={exp.id} gap={1} w="full">
                                      <Text fontSize="xs" color="orange.600" flex="1">
                                        ${exp.cost.toFixed(2)} — {exp.description}
                                      </Text>
                                      {forAdmin && (
                                        <Button
                                          size="xs"
                                          variant="ghost"
                                          colorPalette="red"
                                          onClick={async () => {
                                            try {
                                              await apiDelete(`/api/admin/expenses/${exp.id}`);
                                              publishInlineMessage({ type: "SUCCESS", text: "Expense deleted." });
                                              void loadDetail(job.id, true);
                                            } catch (err: any) {
                                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete expense failed.", err) });
                                            }
                                          }}
                                        >
                                          ✕
                                        </Button>
                                      )}
                                    </HStack>
                                  ))}
                                </VStack>
                              </Box>
                            )}
                            {(occ as any)._count?.photos > 0 && (
                              <OccurrencePhotos
                                occurrenceId={occ.id}
                                isAdmin={forAdmin}
                                photoCount={(occ as any)._count?.photos ?? 0}
                              />
                            )}
                          </VStack>
                          <VStack gap={1} align="end">
                            <StatusBadge
                              status={occ.status}
                              palette={occurrenceStatusColor(occ.status)}
                              variant="subtle"
                            />
                            {occ.isTentative && (
                              <StatusBadge
                                status="Tentative"
                                palette="orange"
                                variant="subtle"
                              />
                            )}
                            {occ.isEstimate && (
                              <StatusBadge
                                status="Estimate"
                                palette="purple"
                                variant="subtle"
                              />
                            )}
                            {occ.isOneOff && (
                              <StatusBadge
                                status="One-off"
                                palette="gray"
                                variant="subtle"
                              />
                            )}
                          </VStack>
                        </HStack>

                        {forAdmin && (
                          <HStack gap={2} mt={2} wrap="wrap">
                            <StatusButton
                              id="occ-edit"
                              itemId={occ.id}
                              label="Edit"
                              onClick={async () => {
                                setEditingOccurrence(occ);
                                setEditOccurrenceJobId(job.id);
                                setEditOccurrenceDialogOpen(true);
                              }}
                              variant="outline"
                              busyId={statusButtonBusyId}
                              setBusyId={setStatusButtonBusyId}
                            />
                            {occ.status === "PROPOSAL_SUBMITTED" && (
                              <StatusButton
                                id="occ-accept-proposal"
                                itemId={occ.id}
                                label="Accept Proposal"
                                onClick={async () => {
                                  try {
                                    await apiPost(`/api/admin/occurrences/${occ.id}/accept-proposal`);
                                    publishInlineMessage({ type: "SUCCESS", text: "Proposal accepted. New job occurrence created." });
                                    void loadDetail(job.id, true);
                                  } catch (err: any) {
                                    publishInlineMessage({ type: "ERROR", text: getErrorMessage("Accept failed.", err) });
                                  }
                                }}
                                variant="solid"
                                colorPalette="green"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "PROPOSAL_SUBMITTED" && (
                              <StatusButton
                                id="occ-reject-proposal"
                                itemId={occ.id}
                                label="Reject Proposal"
                                onClick={async () => {
                                  try {
                                    await apiPost(`/api/admin/occurrences/${occ.id}/reject-proposal`, { reason: "Rejected by admin" });
                                    publishInlineMessage({ type: "SUCCESS", text: "Proposal rejected." });
                                    void loadDetail(job.id, true);
                                  } catch (err: any) {
                                    publishInlineMessage({ type: "ERROR", text: getErrorMessage("Reject failed.", err) });
                                  }
                                }}
                                variant="outline"
                                colorPalette="red"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "SCHEDULED" && (
                              <StatusButton
                                id="occ-tentative"
                                itemId={occ.id}
                                label={occ.isTentative ? "Confirm" : "Mark Tentative"}
                                onClick={async () => void toggleTentative(occ.id, job.id, !!occ.isTentative)}
                                variant="outline"
                                colorPalette={occ.isTentative ? "green" : "orange"}
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status !== "PENDING_PAYMENT" && occ.status !== "CLOSED" && occ.status !== "ARCHIVED" && (
                              <StatusButton
                                id="occ-assignees"
                                itemId={occ.id}
                                label="Manage Team"
                                onClick={async () => {
                                  setAssigneeOccurrenceId(occ.id);
                                  setAssigneeCurrentAssignees(occ.assignees);
                                  setAssigneeJobId(job.id);
                                  setAssigneeDialogOpen(true);
                                }}
                                variant="outline"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "SCHEDULED" && (
                              <StatusButton
                                id="occ-start"
                                itemId={occ.id}
                                label="Start"
                                onClick={async () => setConfirmAction({
                                  title: "Start Occurrence?",
                                  message: "Are you sure you want to start this occurrence?",
                                  confirmLabel: "Start",
                                  colorPalette: "blue",
                                  onConfirm: () => void patchOccurrenceStatus(occ.id, job.id, "IN_PROGRESS"),
                                })}
                                variant="outline"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "IN_PROGRESS" && (
                              <StatusButton
                                id="occ-complete"
                                itemId={occ.id}
                                label="Complete"
                                onClick={async () => setConfirmAction({
                                  title: occ.isEstimate ? "Complete Estimate?" : "Complete Occurrence?",
                                  message: occ.isEstimate
                                    ? "This estimate will be closed (no payment step)."
                                    : "Are you sure you want to mark this occurrence as complete?",
                                  confirmLabel: "Complete",
                                  colorPalette: "green",
                                  ...(occ.isEstimate
                                    ? {
                                        inputLabel: "Comment (required)",
                                        inputPlaceholder: "What happened and why is this estimate being completed?",
                                        onConfirm: (comment: string) => void patchOccurrenceStatus(occ.id, job.id, "CLOSED", comment),
                                      }
                                    : { onConfirm: () => void patchOccurrenceStatus(occ.id, job.id, "PENDING_PAYMENT") }),
                                })}
                                variant="outline"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "SCHEDULED" && (
                              <StatusButton
                                id="occ-cancel"
                                itemId={occ.id}
                                label="Cancel"
                                onClick={async () => {
                                  const dateLabel = occ.startAt
                                    ? new Date(occ.startAt).toLocaleDateString()
                                    : "unknown date";
                                  setToDelete({
                                    deleteType: "archived-occurrence",
                                    jobId: job.id,
                                    id: occ.id,
                                    title: "Cancel occurrence?",
                                    summary: `Occurrence on ${dateLabel} will be deleted.`,
                                    disabled: false,
                                  });
                                }}
                                variant="outline"
                                colorPalette="red"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "IN_PROGRESS" && (
                              <StatusButton
                                id="occ-cancel"
                                itemId={occ.id}
                                label="Cancel"
                                onClick={async () => {
                                  const dateLabel = occ.startAt
                                    ? new Date(occ.startAt).toLocaleDateString()
                                    : "unknown date";
                                  setToDelete({
                                    deleteType: "archived-occurrence",
                                    jobId: job.id,
                                    id: occ.id,
                                    title: "Cancel occurrence?",
                                    summary: `Occurrence on ${dateLabel} will be deleted.`,
                                    disabled: false,
                                  });
                                }}
                                variant="outline"
                                colorPalette="red"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "PENDING_PAYMENT" && (
                              <StatusButton
                                id="occ-accept-payment"
                                itemId={occ.id}
                                label="Accept Payment"
                                onClick={async () => {
                                  setAcceptPaymentOcc(occ);
                                  setAcceptPaymentJobId(job.id);
                                  setAcceptPaymentOpen(true);
                                }}
                                variant="outline"
                                colorPalette="green"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "CLOSED" && (
                              <StatusButton
                                id="occ-archive"
                                itemId={occ.id}
                                label="Archive"
                                onClick={async () => setConfirmAction({
                                  title: "Archive Occurrence?",
                                  message: "Are you sure you want to archive this occurrence?",
                                  confirmLabel: "Archive",
                                  colorPalette: "gray",
                                  onConfirm: () => void archiveOccurrence(occ.id, job.id),
                                })}
                                variant="outline"
                                colorPalette="gray"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status !== "ARCHIVED" && (
                              <StatusButton
                                id="occ-add-expense"
                                itemId={occ.id}
                                label="Add Expense"
                                onClick={async () => {
                                  setExpenseDialogOccId(occ.id);
                                  setExpenseDialogJobId(job.id);
                                }}
                                variant="outline"
                                colorPalette="orange"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            <StatusButton
                              id="occ-delete"
                              itemId={occ.id}
                              label="Delete"
                              onClick={async () => {
                                const dateLabel = occ.startAt
                                  ? new Date(occ.startAt).toLocaleDateString()
                                  : "unknown date";
                                setToDelete({
                                  deleteType: "archived-occurrence",
                                  jobId: job.id,
                                  id: occ.id,
                                  title: "Delete occurrence?",
                                  summary: `Occurrence on ${dateLabel}`,
                                  disabled: !isSuper,
                                  details: !isSuper ? (
                                    <Text color="red.500">You must be a Super Admin to delete.</Text>
                                  ) : undefined,
                                });
                              }}
                              variant="outline"
                              colorPalette="red"
                              busyId={statusButtonBusyId}
                              setBusyId={setStatusButtonBusyId}
                            />
                          </HStack>
                        )}
                      </Box>
                    ))}
                  </Box>
                )}
              </Card.Body>

              {forAdmin && (
                <Card.Footer py="3" px="4" pt="0">
                  <HStack gap={2} wrap="wrap">
                    <StatusButton
                      id="job-edit"
                      itemId={job.id}
                      label="Edit"
                      onClick={async () => {
                        setEditingJob(job);
                        setJobDialogOpen(true);
                      }}
                      variant="outline"
                      busyId={statusButtonBusyId}
                      setBusyId={setStatusButtonBusyId}
                    />
                    {job.status === "ACCEPTED" && (
                      <StatusButton
                        id="job-new-occurrence"
                        itemId={job.id}
                        label="+ Occurrence"
                        onClick={async () => {
                          setOccurrenceJobId(job.id);
                          setOccurrenceDefaultNotes(job.notes ?? null);
                          setOccurrenceDefaultPrice(job.defaultPrice ?? null);
                          setOccurrenceDefaultEstMins(job.estimatedMinutes ?? null);
                          setOccurrenceJobHasFrequency(!!job.frequencyDays);
                          setOccurrenceDialogOpen(true);
                        }}
                        variant="outline"
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {job.status === "PROPOSED" && (
                      <StatusButton
                        id="job-accept"
                        itemId={job.id}
                        label="Accept"
                        onClick={async () => patchJobStatus(job, "ACCEPTED")}
                        variant="outline"
                        colorPalette="green"
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {job.status === "ACCEPTED" && (
                      <StatusButton
                        id="job-archive"
                        itemId={job.id}
                        label="Archive"
                        onClick={async () => archiveJob(job.id)}
                        variant="outline"
                        colorPalette="gray"
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    <StatusButton
                      id="job-delete"
                      itemId={job.id}
                      label="Delete"
                      onClick={async () => openDeleteJobDialog(job)}
                      variant="outline"
                      colorPalette="red"
                      busyId={statusButtonBusyId}
                      setBusyId={setStatusButtonBusyId}
                    />
                  </HStack>
                </Card.Footer>
              )}
            </Card.Root>
          );
        })}
      </VStack>
      </Box>

      {forAdmin && (
        <JobDialog
          open={jobDialogOpen}
          onOpenChange={setJobDialogOpen}
          mode={editingJob ? "UPDATE" : "CREATE"}
          initial={editingJob}
          onSaved={(created) => {
            void load();
            if (created) {
              setOccurrenceJobId(created.id);
              setOccurrenceDefaultNotes(created.notes ?? null);
              setOccurrenceDefaultPrice(created.defaultPrice ?? null);
              setOccurrenceDefaultEstMins(created.estimatedMinutes ?? null);
              setOccurrenceJobHasFrequency(!!(created.frequencyDays));
              setPromptOccurrenceOpen(true);
            }
          }}
        />
      )}

      {forAdmin && (
        <ConfirmDialog
          open={promptOccurrenceOpen}
          title="Create First Occurrence?"
          message="Would you like to create the first occurrence for this job now?"
          confirmLabel="Yes, create"
          onConfirm={() => {
            setPromptOccurrenceOpen(false);
            setOccurrenceDialogOpen(true);
          }}
          onCancel={() => setPromptOccurrenceOpen(false)}
        />
      )}

      {forAdmin && (
        <OccurrenceDialog
          open={occurrenceDialogOpen}
          onOpenChange={setOccurrenceDialogOpen}
          jobId={occurrenceJobId}
          defaultNotes={occurrenceDefaultNotes}
          defaultPrice={occurrenceDefaultPrice}
          defaultEstimatedMinutes={occurrenceDefaultEstMins}
          isAdmin={forAdmin}
          showOneOff={occurrenceJobHasFrequency}
          onSaved={() => {
            if (occurrenceJobId) {
              setExpandedMap((prev) => ({ ...prev, [occurrenceJobId]: true }));
              void loadDetail(occurrenceJobId, true);
            }
          }}
        />
      )}

      {forAdmin && editingOccurrence && (
        <OccurrenceDialog
          open={editOccurrenceDialogOpen}
          onOpenChange={(open) => {
            setEditOccurrenceDialogOpen(open);
            if (!open) setEditingOccurrence(null);
          }}
          mode="UPDATE"
          occurrenceId={editingOccurrence.id}
          defaultStatus={editingOccurrence.status}
          defaultKind={editingOccurrence.kind}
          defaultStartAt={editingOccurrence.startAt}
          defaultEndAt={editingOccurrence.endAt}
          defaultNotes={editingOccurrence.notes}
          defaultPrice={editingOccurrence.price}
          defaultEstimatedMinutes={editingOccurrence.estimatedMinutes}
          defaultStartedAt={editingOccurrence.startedAt}
          defaultCompletedAt={editingOccurrence.completedAt}
          isAdmin={forAdmin}
          onSaved={() => {
            if (editOccurrenceJobId) void loadDetail(editOccurrenceJobId, true);
          }}
        />
      )}

      <DeleteDialog
        toDelete={toDelete}
        cancel={() => setToDelete(null)}
        complete={async () => {
          if (!toDelete) return;
          if (toDelete.deleteType === "archived-job") {
            await deleteJob(toDelete.id);
          } else {
            await deleteOccurrence(toDelete.id, toDelete.jobId!);
          }
          setToDelete(null);
        }}
      />

      {forAdmin && (
        <AssigneeDialog
          open={assigneeDialogOpen}
          onOpenChange={setAssigneeDialogOpen}
          occurrenceId={assigneeOccurrenceId}
          currentAssignees={assigneeCurrentAssignees}
          onChanged={() => {
            if (assigneeJobId) {
              void loadDetail(assigneeJobId, true);
            }
          }}
        />
      )}

      {scheduleNextData && (
        <ScheduleNextDialog
          open={scheduleNextOpen}
          onOpenChange={(o) => {
            setScheduleNextOpen(o);
            if (!o) setScheduleNextData(null);
          }}
          jobId={scheduleNextData.jobId}
          frequencyDays={scheduleNextData.frequencyDays}
          closedOccurrence={scheduleNextData.closedOccurrence}
          createEndpoint={`/api/admin/jobs/${scheduleNextData.jobId}/occurrences`}
          onCreated={(nextStartDate) => {
            if (nextStartDate && dateTo && nextStartDate > dateTo) {
              setDateTo(nextStartDate);
            }
            void loadDetail(scheduleNextData.jobId, true);
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.title ?? ""}
        message={confirmAction?.message ?? ""}
        confirmLabel={confirmAction?.confirmLabel}
        confirmColorPalette={confirmAction?.colorPalette}
        inputPlaceholder={confirmAction?.inputPlaceholder}
        inputLabel={confirmAction?.inputLabel}
        onConfirm={(inputValue: string) => {
          if (confirmAction?.inputPlaceholder) {
            (confirmAction.onConfirm as (v: string) => void)(inputValue);
          } else {
            (confirmAction?.onConfirm as () => void)();
          }
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />

      {acceptPaymentOcc && (
        <AcceptPaymentDialog
          open={acceptPaymentOpen}
          onOpenChange={(o) => {
            setAcceptPaymentOpen(o);
            if (!o) setAcceptPaymentOcc(null);
          }}
          endpoint={`/api/admin/occurrences/${acceptPaymentOcc.id}/accept-payment`}
          defaultAmount={acceptPaymentOcc.price}
          assignees={(acceptPaymentOcc.assignees ?? []).map((a) => ({
            userId: a.userId,
            displayName: a.user?.displayName ?? a.user?.email,
          }))}
          onAccepted={() => {
            const occ = acceptPaymentOcc;
            const jobId = acceptPaymentJobId;
            if (jobId) void loadDetail(jobId, true);
            // Prompt to schedule next if job has frequency and not one-off
            const job = items.find((j) => j.id === jobId);
            if (job?.frequencyDays && occ && !occ.isOneOff) {
              setScheduleNextData({
                jobId,
                frequencyDays: job.frequencyDays,
                closedOccurrence: {
                  startAt: occ.startAt,
                  endAt: occ.endAt,
                  notes: occ.notes,
                  price: occ.price,
                },
              });
              setScheduleNextOpen(true);
            }
            setAcceptPaymentOcc(null);
          }}
        />
      )}

      <AddExpenseDialog
        open={!!expenseDialogOccId}
        onOpenChange={(o) => { if (!o) { setExpenseDialogOccId(null); setExpenseDialogJobId(null); } }}
        endpoint={`/api/admin/occurrences/${expenseDialogOccId}/expenses`}
        onAdded={() => {
          if (expenseDialogJobId) void loadDetail(expenseDialogJobId, true);
          setExpenseDialogOccId(null);
          setExpenseDialogJobId(null);
        }}
      />
    </Box>
  );
}
