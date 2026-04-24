"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Portal,
  Select,
  Text,
  Spinner,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { AlertTriangle, Archive, Ban, CalendarRange, ChevronDown, ChevronUp, Filter, Layers, LayoutList, Link2, Maximize2, MessageCircle, Plus, RefreshCw, Star, Tag, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { getLocation } from "@/src/lib/geo";
import {
  determineRoles,
  jobStatusColor,
  occurrenceStatusColor,
  prettyStatus,
  clientLabel,
  fmtDate,
  fmtDateTime,
  bizDateKey,
  jobTypeLabel,
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
import { jobTagLabel } from "@/src/ui/components/JobTagPicker";
import { parseAdminTags, adminTagLabel, adminTagColor } from "@/src/ui/components/AdminTagPicker";
import AssigneeDialog from "@/src/ui/dialogs/AssigneeDialog";
import DefaultCrewDialog from "@/src/ui/dialogs/DefaultCrewDialog";
import DeleteDialog, { type ToDeleteProps } from "@/src/ui/dialogs/DeleteDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import AcceptPaymentDialog from "@/src/ui/dialogs/AcceptPaymentDialog";
import AddExpenseDialog from "@/src/ui/dialogs/AddExpenseDialog";
import { MapLink, TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch, onEventSearchRun, navigateToProfile } from "@/src/lib/bus";
import { type DatePreset, computeDatesFromPreset, PRESET_LABELS } from "@/src/lib/datePresets";
import OccurrencePhotos from "@/src/ui/components/OccurrencePhotos";
import TruncatedText from "@/src/ui/components/TruncatedText";
import { type JobOccurrenceAssigneeWithUser } from "@/src/lib/types";

function localDate(d: Date): string {
  return bizDateKey(d);
}

function parseJobTags(occ: any): string[] {
  if (!occ?.jobTags) return [];
  if (Array.isArray(occ.jobTags)) return occ.jobTags;
  try { return JSON.parse(occ.jobTags); } catch { return []; }
}

const kindStates = ["ALL", ...JOB_KIND] as const;
const jobStatusStates = ["ALL", ...JOB_STATUS] as const;
const occStatusStates = ["ALL", "UNCLAIMED", ...JOB_OCCURRENCE_STATUS.filter((s) => s !== "ARCHIVED" && s !== "CANCELED")] as const;

const quickDateItemsBase = [
  { label: "Now", value: "now" },
  { label: "This week", value: "thisWeek" },
  { label: "This month", value: "thisMonth" },
  { label: "Yesterday", value: "yesterday" },
  { label: "Last week", value: "lastWeek" },
  { label: "Last month", value: "lastMonth" },
];

export default function ServicesTab({
  me,
  purpose = "ADMIN",
}: TabPropsType) {
  const { isAvail, forAdmin, isSuper } = determineRoles(me, purpose);
  const inputRef = useRef<HTMLInputElement>(null);

  const [q, setQ] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [quickDateMenuOpen, setQuickDateMenuOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [highlightOccId, setHighlightOccId] = useState<string | null>(null);
  const [flashOccId, setFlashOccId] = useState<string | null>(null);
  const [kind, setKind] = usePersistedState<string[]>("services_kind", ["ALL"]);
  const [jobStatusFilter, setJobStatusFilter] = usePersistedState<string[]>("services_jobStatus", ["ALL"]);
  const [occStatusFilter, setOccStatusFilter] = usePersistedState<string[]>("services_occStatus", ["ALL"]);
  const [typeFilter, setTypeFilter] = usePersistedState<string[]>("services_type", ["ALL"]);

  const [showCanceled, setShowCanceled] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [overdueActive, setOverdueActive] = usePersistedState("services_overdue", false);
  const [vipOnly, setVipOnly] = useState(false);
  const [overdueCount, setOverdueCount] = useState(0);
  const presetBeforeOverdueRef = useRef<DatePreset>("thisMonth");
  const [datePreset, setDatePreset] = usePersistedState<DatePreset>("services_datePreset", "thisMonth");
  const presetDates = useMemo(() => computeDatesFromPreset(datePreset), [datePreset]);
  const [dateFrom, setDateFrom] = usePersistedState("services_dateFrom", presetDates.from);
  const [dateTo, setDateTo] = usePersistedState("services_dateTo", presetDates.to);
  const [quickDate, setQuickDate] = useState<string[]>([]);

  useEffect(() => {
    if (overdueActive) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      setDateFrom("");
      setDateTo(localDate(yesterday));
    } else if (datePreset) {
      const d = computeDatesFromPreset(datePreset);
      setDateFrom(d.from);
      setDateTo(d.to);
    }
  }, [datePreset, overdueActive]);

  useEffect(() => {
    if (!quickDateMenuOpen) return;
    const close = () => setQuickDateMenuOpen(false);
    const timer = setTimeout(() => document.addEventListener("click", close), 50);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [quickDateMenuOpen]);

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
    () => kindStates.map((s) => ({ label: s === "ALL" ? "All Kinds" : prettyStatus(s), value: s })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );
  const jobStatusItems = useMemo(
    () => jobStatusStates.map((s) => ({ label: s === "ALL" ? "All Job Statuses" : prettyStatus(s), value: s })),
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
    () => occStatusStates.map((s) => ({ label: s === "ALL" ? "All Occ. Statuses" : s === "UNCLAIMED" ? "Unclaimed" : prettyStatus(s), value: s })),
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
  const [showAllOccs, setShowAllOccs] = useState<Set<string>>(new Set());

  const [jobDialogOpen, setJobDialogOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<JobListItem | null>(null);

  const [occurrenceDialogOpen, setOccurrenceDialogOpen] = useState(false);
  const [promptOccurrenceOpen, setPromptOccurrenceOpen] = useState(false);
  const [occurrenceJobId, setOccurrenceJobId] = useState<string>("");
  const [occurrenceDefaultNotes, setOccurrenceDefaultNotes] = useState<string | null>(null);
  const [occurrenceDefaultPrice, setOccurrenceDefaultPrice] = useState<number | null>(null);
  const [occurrenceDefaultEstMins, setOccurrenceDefaultEstMins] = useState<number | null>(null);
  const [occurrenceJobHasFrequency, setOccurrenceJobHasFrequency] = useState(false);
  const [occurrenceJobFreqDays, setOccurrenceJobFreqDays] = useState<number | null>(null);
  const [occurrenceDefaultAssignees, setOccurrenceDefaultAssignees] = useState<{ userId: string; displayName?: string | null }[]>([]);
  const [occurrenceDefaultWorkflow, setOccurrenceDefaultWorkflow] = useState<string | undefined>(undefined);

  // Comments
  type OccComment = { id: string; body: string; createdAt: string; updatedAt: string; author: { id: string; displayName?: string | null; email?: string | null } };
  const [commentsOpenFor, setCommentsOpenFor] = useState<Set<string>>(new Set());
  const [commentsCache, setCommentsCache] = useState<Record<string, OccComment[]>>({});
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [commentEditing, setCommentEditing] = useState<{ id: string; body: string } | null>(null);
  const [commentBusy, setCommentBusy] = useState(false);

  async function loadComments(occId: string) {
    try {
      const list = await apiGet<OccComment[]>(`/api/occurrences/${occId}/comments`);
      setCommentsCache((prev) => ({ ...prev, [occId]: Array.isArray(list) ? list : [] }));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load comments.", err) });
    }
  }

  function toggleComments(occId: string) {
    setCommentsOpenFor((prev) => {
      const next = new Set(prev);
      if (next.has(occId)) { next.delete(occId); } else { next.add(occId); if (!commentsCache[occId]) void loadComments(occId); }
      return next;
    });
  }

  async function postComment(occId: string) {
    const body = (commentDraft[occId] ?? "").trim();
    if (!body) return;
    setCommentBusy(true);
    try {
      await apiPost(`/api/occurrences/${occId}/comments`, { body });
      setCommentDraft((prev) => ({ ...prev, [occId]: "" }));
      await loadComments(occId);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to post comment.", err) });
    } finally { setCommentBusy(false); }
  }

  async function editComment(commentId: string, occId: string, body: string) {
    setCommentBusy(true);
    try {
      await apiPatch(`/api/occurrences/comments/${commentId}`, { body });
      setCommentEditing(null);
      await loadComments(occId);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to edit comment.", err) });
    } finally { setCommentBusy(false); }
  }

  async function deleteComment(commentId: string, occId: string) {
    setCommentBusy(true);
    try {
      await apiDelete(`/api/occurrences/comments/${commentId}`);
      await loadComments(occId);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete comment.", err) });
    } finally { setCommentBusy(false); }
  }

  const [editOccurrenceDialogOpen, setEditOccurrenceDialogOpen] = useState(false);
  const [editingOccurrence, setEditingOccurrence] = useState<JobOccurrenceFull | null>(null);
  const [editOccurrenceJobId, setEditOccurrenceJobId] = useState<string>("");

  const [assigneeDialogOpen, setAssigneeDialogOpen] = useState(false);
  const [defaultCrewDialogOpen, setDefaultCrewDialogOpen] = useState(false);
  const [defaultCrewJobId, setDefaultCrewJobId] = useState<string>("");
  const [defaultCrewCurrent, setDefaultCrewCurrent] = useState<any[]>([]);
  const [assigneeOccurrenceId, setAssigneeOccurrenceId] = useState<string>("");
  const [assigneeCurrentAssignees, setAssigneeCurrentAssignees] = useState<JobOccurrenceAssigneeWithUser[]>([]);
  const [assigneeJobId, setAssigneeJobId] = useState<string>("");
  const [assigneeHasPayment, setAssigneeHasPayment] = useState(false);

  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");
  const [commissionPercent, setCommissionPercent] = useState(0);
  const [marginPercent, setMarginPercent] = useState(0);

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
    inputOptional?: boolean;
    inputDefaultValue?: string;
    cancelLabel?: string;
    onCancelAction?: () => void;
  } | null>(null);

  const [acceptPaymentOpen, setAcceptPaymentOpen] = useState(false);
  const [acceptPaymentOcc, setAcceptPaymentOcc] = useState<JobOccurrenceFull | null>(null);
  const [expenseDialogOccId, setExpenseDialogOccId] = useState<string | null>(null);
  const [expenseDialogJobId, setExpenseDialogJobId] = useState<string | null>(null);
  const [acceptPaymentJobId, setAcceptPaymentJobId] = useState<string>("");

  const [linkPickerOccId, setLinkPickerOccId] = useState<string | null>(null);
  const [linkPickerJobId, setLinkPickerJobId] = useState<string | null>(null);
  const [linkPickerPropertyId, setLinkPickerPropertyId] = useState<string | null>(null);

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
    apiGet<any[]>("/api/admin/settings")
      .then((list) => {
        if (!Array.isArray(list)) return;
        const c = list.find((r: any) => r.key === "CONTRACTOR_PLATFORM_FEE_PERCENT");
        if (c?.value) setCommissionPercent(Number(c.value));
        const m = list.find((r: any) => r.key === "EMPLOYEE_BUSINESS_MARGIN_PERCENT");
        if (m?.value) setMarginPercent(Number(m.value));
      })
      .catch(() => {});
  }, []);

  async function refreshOverdueCount() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const list = await apiGet<{ id: string; status: string }[]>(
        `/api/occurrences?to=${localDate(yesterday)}`
      );
      const count = (Array.isArray(list) ? list : []).filter(
        (o) => o.status !== "COMPLETED" && o.status !== "CLOSED" && o.status !== "ARCHIVED" && o.status !== "CANCELED" && o.status !== "REJECTED" && o.status !== "ACCEPTED"
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

  // Navigate from Admin Jobs tab → specific occurrence
  useEffect(() => {
    return onEventSearchRun("jobsTabToServicesTabSearch", setQ, inputRef, (id) => {
      if (!id) { setHighlightId(null); setHighlightOccId(null); setFlashOccId(null); return; }
      // entityId is encoded as "jobId:occurrenceId"
      const [jobId, occId] = id.split(":");
      setHighlightId(jobId || null);
      setHighlightOccId(occId || null);
      setFlashOccId(occId || null);
      // Clear date preset so all occurrences for this job are visible
      setDatePreset(null);
      setDateFrom("");
      setDateTo("");
      if (jobId) {
        // Auto-expand the job, show all occurrences, and load its detail
        setExpandedMap((prev) => ({ ...prev, [jobId]: true }));
        setShowAllOccs((prev) => { const next = new Set(prev); next.add(jobId); return next; });
        void loadDetail(jobId, true);
      }
    });
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

  async function patchOccurrenceStatus(occurrenceId: string, jobId: string, newStatus: string, notes?: string, recordLocation = true) {
    // Capture occurrence data before the API call for schedule-next prompt
    const detail = jobDetails[jobId];
    const occ = detail?.occurrences.find((o) => o.id === occurrenceId);
    const job = items.find((j) => j.id === jobId);
    try {
      const payload: Record<string, unknown> = { status: newStatus };
      if (notes) payload.notes = notes;
      if (recordLocation && (newStatus === "IN_PROGRESS" || newStatus === "PENDING_PAYMENT" || newStatus === "CLOSED")) {
        const loc = await getLocation();
        if (loc) {
          if (newStatus === "IN_PROGRESS") { payload.startLat = loc.lat; payload.startLng = loc.lng; }
          else { payload.completeLat = loc.lat; payload.completeLng = loc.lng; }
        }
      }
      await apiPatch(`/api/admin/occurrences/${occurrenceId}`, payload);
      void loadDetail(jobId, true);
      window.dispatchEvent(new CustomEvent("seedlings3:jobs-changed"));
      publishInlineMessage({ type: "SUCCESS", text: "Occurrence updated." });

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
      window.dispatchEvent(new CustomEvent("seedlings3:jobs-changed"));
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
      window.dispatchEvent(new CustomEvent("seedlings3:jobs-changed"));
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
    if (!showArchived) rows = rows.filter((i) => i.status !== "ARCHIVED");
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
    if (vipOnly) {
      rows = rows.filter((r) => !!(r.property?.client as any)?.isVip);
    }
    return rows;
  }, [items, q, kind, jobStatusFilter, showArchived]);

  if (!isAvail) return <UnavailableNotice />;
  if (loading && items.length === 0) return <LoadingCenter />;

  return (
    <Box w="full">
      <HStack mb={2} gap={2}>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-100)" }}>
          <RefreshCw size={14} />
        </Button>
        <SearchWithClear
          ref={inputRef}
          value={q}
          onChange={(v) => setQ(v)}
          inputId="services-search"
          placeholder="Search…"
        />
        <Button
          size="sm"
          variant="ghost"
          px="2"
          flexShrink={0}
          onClick={() => setFiltersOpen((v) => !v)}
          title={filtersOpen ? "Collapse filters" : "Expand filters"}
          css={{
            background: filtersOpen ? "var(--chakra-colors-blue-100)" : "var(--chakra-colors-gray-100)",
            border: filtersOpen ? "1px solid var(--chakra-colors-blue-300)" : "1px solid var(--chakra-colors-gray-300)",
            borderRadius: "6px",
          }}
        >
          <Filter size={14} />
          {filtersOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </Button>
        {forAdmin && (
          <Button
            size="sm"
            px="2"
            minW="0"
            variant="solid"
            bg="black"
            color="white"
            flexShrink={0}
            onClick={() => {
              setEditingJob(null);
              setJobDialogOpen(true);
            }}
          >
            <Plus size={16} strokeWidth={2.5} />
          </Button>
        )}
      </HStack>
      {!filtersOpen && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
            <Badge size="sm" colorPalette="green" variant="subtle" cursor="pointer" onClick={() => setQuickDateMenuOpen((v) => !v)}>
              {datePreset ? (PRESET_LABELS[datePreset] ?? datePreset) : (dateFrom || dateTo) ? (dateFrom === dateTo && dateFrom === bizDateKey(new Date()) ? "Today" : "Custom dates") : "Now"}
              {" "}<Box as="span" display="inline-flex" alignItems="center" justifyContent="center" w="14px" h="14px" borderRadius="full" bg="green.500" color="white" verticalAlign="middle"><ChevronDown size={9} /></Box>
            </Badge>
            {quickDateMenuOpen && (
              <VStack position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px"
                ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 148))}px`; } }}>
                {quickDateItems.map((it) => (
                  <Button key={it.value} size="xs" variant={datePreset === it.value ? "solid" : "ghost"} colorPalette={datePreset === it.value ? "green" : undefined} w="full" justifyContent="start"
                    onClick={() => { setQuickDateMenuOpen(false); const val = it.value as DatePreset; if (val === "all") { setConfirmAction({ title: "Load All Data", message: "This will load all occurrences for all time. This may be slow. Are you sure?", confirmLabel: "Load All", colorPalette: "orange", onConfirm: () => { setDatePreset("all"); setOverdueActive(false); } }); return; } setDatePreset(val); setOverdueActive(false); }}>
                    {it.label}
                  </Button>
                ))}
              </VStack>
            )}
          </Box>
          {overdueActive && (
            <Badge size="sm" colorPalette="red" variant="solid">Overdue</Badge>
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
          {vipOnly && <Badge size="sm" colorPalette="yellow" variant="subtle">VIP</Badge>}
          {showCanceled && <Badge size="sm" colorPalette="red" variant="subtle">+ Canceled</Badge>}
          {showArchived && <Badge size="sm" colorPalette="gray" variant="solid">+ Archived</Badge>}
          {highlightId && <Badge size="sm" colorPalette="teal" variant="subtle">Filtered to 1 job service</Badge>}
          {q && <Badge size="sm" colorPalette="gray" variant="subtle">"{q}"</Badge>}
          {!(kind[0] === "ALL" && jobStatusFilter[0] === "ALL" && occStatusFilter[0] === "ALL" && typeFilter[0] === "ALL" && !overdueActive && !vipOnly && !showCanceled && !showArchived && !highlightId && !q && datePreset) && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setKind(["ALL"]);
                setJobStatusFilter(["ALL"]);
                setOccStatusFilter(["ALL"]);
                setTypeFilter(["ALL"]);
                setOverdueActive(false);
                setVipOnly(false);
                setShowCanceled(false);
                setShowArchived(false);
                setHighlightId(null);
                setHighlightOccId(null);
                setFlashOccId(null);
                setDatePreset("thisMonth");
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      {filtersOpen && <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" bg="gray.50" p={2} mb={2}>
      <HStack mb={2} gap={1} wrap="nowrap" pl="1">
        <Select.Root
          collection={kindCollection}
          value={kind}
          onValueChange={(e) => setKind(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: kind[0] !== "ALL" ? "var(--chakra-colors-blue-200)" : "var(--chakra-colors-blue-100)", border: kind[0] !== "ALL" ? "1px solid var(--chakra-colors-blue-400)" : "1px solid transparent", borderRadius: "6px" }}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: jobStatusFilter[0] !== "ALL" ? "var(--chakra-colors-purple-200)" : "var(--chakra-colors-purple-100)", border: jobStatusFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-purple-400)" : "1px solid transparent", borderRadius: "6px" }}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: occStatusFilter[0] !== "ALL" ? "var(--chakra-colors-teal-200)" : "var(--chakra-colors-teal-100)", border: occStatusFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-teal-400)" : "1px solid transparent", borderRadius: "6px" }}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: typeFilter[0] !== "ALL" ? "var(--chakra-colors-orange-200)" : "var(--chakra-colors-orange-100)", border: typeFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-orange-400)" : "1px solid transparent", borderRadius: "6px" }}>
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
          variant={vipOnly ? "solid" : "outline"}
          px="2"
          onClick={() => setVipOnly(!vipOnly)}
          css={vipOnly ? {
            background: "var(--chakra-colors-yellow-100)",
            color: "var(--chakra-colors-yellow-800)",
            border: "1px solid var(--chakra-colors-yellow-400)",
            "&:hover": { background: "var(--chakra-colors-yellow-200)" },
          } : undefined}
        >
          <Star size={14} fill={vipOnly ? "var(--chakra-colors-yellow-500)" : "none"} color={vipOnly ? "var(--chakra-colors-yellow-500)" : undefined} />
        </Button>
        <Button
          size="sm"
          variant={showCanceled ? "solid" : "outline"}
          px="2"
          onClick={() => setShowCanceled(!showCanceled)}
          title={showCanceled ? "Hide canceled" : "Show canceled"}
          css={showCanceled ? {
            background: "var(--chakra-colors-red-100)",
            color: "var(--chakra-colors-red-700)",
            border: "1px solid var(--chakra-colors-red-300)",
            "&:hover": { background: "var(--chakra-colors-red-200)" },
          } : undefined}
        >
          <Ban size={14} />
        </Button>
        <Button
          size="sm"
          variant={showArchived ? "solid" : "outline"}
          px="2"
          onClick={() => setShowArchived(!showArchived)}
          title={showArchived ? "Hide archived" : "Show archived"}
          css={showArchived ? {
            background: "var(--chakra-colors-gray-200)",
            color: "var(--chakra-colors-gray-700)",
            border: "1px solid var(--chakra-colors-gray-400)",
            "&:hover": { background: "var(--chakra-colors-gray-300)" },
          } : undefined}
        >
          <Archive size={14} />
        </Button>
      </HStack>

      <HStack mb={2} gap={2} align="center">
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
              setDatePreset(presetBeforeOverdueRef.current ?? "thisMonth");
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

      {(kind[0] !== "ALL" || jobStatusFilter[0] !== "ALL" || occStatusFilter[0] !== "ALL" || typeFilter[0] !== "ALL" || overdueActive || vipOnly || showCanceled || showArchived || datePreset || dateFrom || dateTo || highlightId) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
            <Badge size="sm" colorPalette="green" variant="subtle" cursor="pointer" onClick={() => setQuickDateMenuOpen((v) => !v)}>
              {datePreset ? (PRESET_LABELS[datePreset] ?? datePreset) : (dateFrom || dateTo) ? (dateFrom === dateTo && dateFrom === bizDateKey(new Date()) ? "Today" : "Custom dates") : "Now"}
              {" "}<Box as="span" display="inline-flex" alignItems="center" justifyContent="center" w="14px" h="14px" borderRadius="full" bg="green.500" color="white" verticalAlign="middle"><ChevronDown size={9} /></Box>
            </Badge>
            {quickDateMenuOpen && (
              <VStack position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px"
                ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 148))}px`; } }}>
                {quickDateItems.map((it) => (
                  <Button key={it.value} size="xs" variant={datePreset === it.value ? "solid" : "ghost"} colorPalette={datePreset === it.value ? "green" : undefined} w="full" justifyContent="start"
                    onClick={() => { setQuickDateMenuOpen(false); const val = it.value as DatePreset; if (val === "all") { setConfirmAction({ title: "Load All Data", message: "This will load all occurrences for all time. This may be slow. Are you sure?", confirmLabel: "Load All", colorPalette: "orange", onConfirm: () => { setDatePreset("all"); setOverdueActive(false); } }); return; } setDatePreset(val); setOverdueActive(false); }}>
                    {it.label}
                  </Button>
                ))}
              </VStack>
            )}
          </Box>
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
          {vipOnly && <Badge size="sm" colorPalette="yellow" variant="subtle">VIP</Badge>}
          {showCanceled && (
            <Badge size="sm" colorPalette="red" variant="subtle">
              + Canceled
            </Badge>
          )}
          {showArchived && (
            <Badge size="sm" colorPalette="gray" variant="solid">
              + Archived
            </Badge>
          )}
          {highlightId && (
            <Badge size="sm" colorPalette="teal" variant="subtle">
              Filtered to 1 job service
            </Badge>
          )}
          {!(kind[0] === "ALL" && jobStatusFilter[0] === "ALL" && occStatusFilter[0] === "ALL" && typeFilter[0] === "ALL" && !overdueActive && !vipOnly && !showCanceled && !showArchived && !highlightId && datePreset) && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setKind(["ALL"]);
                setJobStatusFilter(["ALL"]);
                setOccStatusFilter(["ALL"]);
                setTypeFilter(["ALL"]);
                setOverdueActive(false);
                setVipOnly(false);
                setShowCanceled(false);
                setShowArchived(false);
                setHighlightId(null);
                setHighlightOccId(null);
                setFlashOccId(null);
                setDatePreset("thisMonth");
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      </Box>}
      <HStack mb={2} gap={2} px={1} wrap="wrap">
        {(() => {
          const accepted = items.filter((j) => j.status === "ACCEPTED").length;
          const proposed = items.filter((j) => j.status === "PROPOSED").length;
          const paused = items.filter((j) => j.status === "PAUSED").length;
          const archived = items.filter((j) => j.status === "ARCHIVED").length;
          return (
            <>
              <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">{accepted} Active</Badge>
              <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="2" borderRadius="full">{proposed} Proposed</Badge>
              <Badge colorPalette="yellow" variant="subtle" fontSize="xs" px="2" borderRadius="full">{paused} Paused</Badge>
              <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">{archived} Archived</Badge>
            </>
          );
        })()}
      </HStack>

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
                // Always show the highlighted occurrence
                if (highlightOccId && o.id === highlightOccId) return true;
                if (!showArchived && o.status === "ARCHIVED") return false;
                if (!showCanceled && o.status === "CANCELED") return false;
                if (!showAllOccs.has(job.id) && o.startAt) {
                  const d = bizDateKey(o.startAt);
                  if (dateFrom && d < dateFrom) return false;
                  if (dateTo && d > dateTo) return false;
                }
                if (tf === "ONE_OFF" && !o.isOneOff) return false;
                if (tf === "ESTIMATE" && !o.isEstimate) return false;
                if (tf === "TENTATIVE" && !o.isTentative) return false;
                if (overdueActive && (new Set(["COMPLETED", "CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"])).has(o.status)) return false;
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
                      {(job.property?.client as any)?.isVip && <span title={(job.property?.client as any)?.vipReason || "VIP Client"} style={{ cursor: "help" }}>⭐ </span>}
                      {job.property?.displayName ?? job.propertyId}
                      {job.property?.client?.displayName && (
                        <> — {clientLabel(job.property.client.displayName)}</>
                      )}
                    </Text>
                    {(job.property?.client as any)?.isVip && (job.property?.client as any)?.vipReason && (
                      <Text fontSize="xs" color="yellow.700" fontWeight="medium">VIP: {(job.property?.client as any).vipReason}</Text>
                    )}
                    {forAdmin && (() => {
                      const tags = parseAdminTags((job.property?.client as any)?.adminTags);
                      if (tags.length === 0) return null;
                      return (
                        <Box display="flex" gap="4px" flexWrap="wrap">
                          {tags.map((tag: string) => (
                            <Badge key={tag} colorPalette={adminTagColor(tag)} variant="solid" fontSize="xs" px="2" borderRadius="full">
                              ⚠ {adminTagLabel(tag)}
                            </Badge>
                          ))}
                        </Box>
                      );
                    })()}
                    <HStack gap={3} fontSize="xs">
                      {job.property?.displayName && (
                        <TextLink
                          text="View Property"
                          onClick={() =>
                            openEventSearch(
                              "jobsTabToPropertiesTabSearch",
                              job.property?.displayName ?? "",
                              forAdmin,
                              job.property?.id,
                            )
                          }
                        />
                      )}
                      {job.property?.client?.displayName && (
                        <TextLink
                          text="View Client"
                          onClick={() =>
                            openEventSearch(
                              "jobsTabToClientsTabSearch",
                              job.property?.client?.displayName ?? "",
                              forAdmin,
                              job.property?.client?.id,
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
                  <Text fontSize="xs" color={job.frequencyDays ? "fg.muted" : "orange.500"}>
                    {job.frequencyDays
                      ? `Default frequency: every ${job.frequencyDays} day${job.frequencyDays !== 1 ? "s" : ""}`
                      : "Default frequency: not set"}
                  </Text>
                  {job.notes && (
                    <TruncatedText>{job.notes}</TruncatedText>
                  )}
                  {detail?.defaultAssignees && detail.defaultAssignees.length > 0 ? (
                    <Text fontSize="xs" color="teal.600">
                      Default team: {detail.defaultAssignees.map((a, i) => (
                        <span key={a.userId}>
                          {i > 0 && ", "}
                          <span
                            style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}
                            onClick={(e) => { e.stopPropagation(); navigateToProfile(a.userId, !!forAdmin); }}
                          >
                            {a.user?.displayName ?? a.user?.email ?? a.userId}
                          </span>
                        </span>
                      ))}
                    </Text>
                  ) : (
                    <Text fontSize="xs" color="fg.muted">Default team: not set</Text>
                  )}
                  {((job as any).assigneeCount > 0 || (detail?.defaultAssignees && detail.defaultAssignees.length > 0)) && (
                    <Box px={2} py={1} mt={1} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" rounded="md">
                      <Text fontSize="2xs" color="yellow.700">
                        The default team is automatically assigned to each new occurrence. If a team member is swapped for a single occurrence, the default team is restored on the next one.
                      </Text>
                    </Box>
                  )}
                </VStack>
                {forAdmin && (
                  <HStack gap={2} wrap="wrap" mt={2}>
                    <StatusButton
                      id="job-edit"
                      itemId={job.id}
                      label="Edit Job"
                      onClick={async () => {
                        setEditingJob(job);
                        setJobDialogOpen(true);
                      }}
                      variant="outline"
                      busyId={statusButtonBusyId}
                      setBusyId={setStatusButtonBusyId}
                    />
                    <StatusButton
                      id="job-default-crew"
                      itemId={job.id}
                      label="Default Team"
                      onClick={async () => {
                        setDefaultCrewJobId(job.id);
                        setDefaultCrewCurrent(detail?.defaultAssignees ?? []);
                        setDefaultCrewDialogOpen(true);
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
                          setOccurrenceJobFreqDays(job.frequencyDays ?? null);
                          setOccurrenceDefaultAssignees(
                            (detail?.defaultAssignees ?? []).map((a) => ({
                              userId: a.userId,
                              displayName: a.user?.displayName ?? a.user?.email ?? null,
                            }))
                          );
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
                        id="job-pause"
                        itemId={job.id}
                        label="Pause"
                        onClick={async () => patchJobStatus(job, "PAUSED")}
                        variant="outline"
                        colorPalette="yellow"
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {job.status === "PAUSED" && (
                      <StatusButton
                        id="job-resume"
                        itemId={job.id}
                        label="Resume"
                        onClick={async () => patchJobStatus(job, "ACCEPTED")}
                        variant="outline"
                        colorPalette="green"
                        busyId={statusButtonBusyId}
                        setBusyId={setStatusButtonBusyId}
                      />
                    )}
                    {(job.status === "ACCEPTED" || job.status === "PAUSED") && (
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
                )}

                {(detail ? detail.occurrences.length === 0 : (job.occurrenceCount ?? 0) === 0) ? (
                  <Text fontSize="xs" color="fg.muted">No occurrences</Text>
                ) : (
                  <HStack gap={1} mt={2}>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => toggleExpand(job.id)}
                    >
                      {expanded
                        ? `Hide occurrences (${visibleOccs.length} of ${detail ? detail.occurrences.length : (job.occurrenceCount ?? 0)}) ▲`
                        : `Show occurrences (${job.occurrenceCount ?? 0}) ▼`}
                    </Button>
                    {expanded && detail && detail.occurrences.length > visibleOccs.length && !showAllOccs.has(job.id) && (
                      <Button
                        variant="outline"
                        size="xs"
                        colorPalette="blue"
                        onClick={() => setShowAllOccs((prev) => { const next = new Set(prev); next.add(job.id); return next; })}
                      >
                        Show All
                      </Button>
                    )}
                    {expanded && showAllOccs.has(job.id) && (
                      <Button
                        variant="ghost"
                        size="xs"
                        colorPalette="gray"
                        onClick={() => setShowAllOccs((prev) => { const next = new Set(prev); next.delete(job.id); return next; })}
                      >
                        Date Filter
                      </Button>
                    )}
                  </HStack>
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
                        borderWidth={flashOccId === occ.id ? "2px" : "1px"}
                        borderColor={flashOccId === occ.id ? "blue.400" : undefined}
                        bg={flashOccId === occ.id ? "blue.50" : "gray.100"}
                        rounded="md"
                        mb={2}
                        ref={highlightOccId === occ.id ? (el: HTMLDivElement | null) => {
                          if (el) {
                            requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "center" }));
                            setTimeout(() => setFlashOccId(null), 3000);
                          }
                        } : undefined}
                      >
                        <VStack align="start" gap={0} w="full" overflow="hidden">
                          <VStack align="start" gap={0} w="full">
                            <Text fontSize="xs" fontWeight="medium">
                              {occ.startAt
                                ? fmtDate(occ.startAt)
                                : "—"}
                              {parseJobTags(occ).length > 0 && (
                                <> · {parseJobTags(occ).map(jobTagLabel).join(", ")}</>
                              )}
                              {(occ as any).jobType && (
                                <> · Custom</>
                              )}
                            </Text>
                            {occ.assignees.length === 0 ? (
                              <Text fontSize="xs" color="orange.500" fontWeight="medium">
                                {occ.isTentative
                                  ? "Unclaimed — tentative, awaiting admin confirmation"
                                  : (occ as any).isAdminOnly
                                  ? "Unclaimed — administered, must be assigned by an admin"
                                  : "Unclaimed — available to claim"}
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
                                      <span
                                        style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}
                                        onClick={(e) => { e.stopPropagation(); navigateToProfile(a.userId, !!forAdmin); }}
                                      >
                                        {a.user.displayName ?? a.user.email ?? a.userId}
                                      </span>
                                      {isClaimer ? " · Claimer" : a.role === "observer" ? " · Observer" : " · Worker"}
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
                            {occ.payment && (
                              <Text fontSize="xs" color="green.700" fontWeight="medium">
                                Paid: ${(occ.payment as any).amountPaid.toFixed(2)} via {prettyStatus((occ.payment as any).method)}
                              </Text>
                            )}
                            {occ.price != null && occ.status !== "CLOSED" && occ.status !== "ARCHIVED" && (() => {
                              const expTotal = (occ.expenses ?? []).reduce((s: number, e: any) => s + e.cost, 0);
                              const assignees = (occ.assignees ?? []).filter((a: any) => a.role !== "observer");
                              const net = occ.price! - expTotal;
                              const hasContractors = assignees.some((a: any) => a.user?.workerType !== "EMPLOYEE" && a.user?.workerType !== "TRAINEE");
                              const hasEmployees = assignees.some((a: any) => a.user?.workerType === "EMPLOYEE" || a.user?.workerType === "TRAINEE");
                              const commission = hasContractors && commissionPercent > 0 ? Math.round(net * commissionPercent) / 100 : 0;
                              const margin = hasEmployees && marginPercent > 0 ? Math.round(net * marginPercent) / 100 : 0;
                              const totalPayout = Math.max(0, occ.price! - expTotal - commission - margin);

                              return (
                                <Box fontSize="xs" color="fg.muted" mt={0.5}>
                                  <HStack gap={2}>
                                    <Text>Est. payout:</Text>
                                    <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                                      ${totalPayout.toFixed(2)}
                                    </Badge>
                                  </HStack>
                                  <Text fontSize="xs" color="fg.muted">
                                    ${occ.price!.toFixed(2)}{expTotal > 0 ? ` − $${expTotal.toFixed(2)} exp` : ""}{commission > 0 ? ` − $${commission.toFixed(2)} commission (${commissionPercent}%)` : ""}{margin > 0 ? ` − $${margin.toFixed(2)} margin (${marginPercent}%)` : ""}
                                  </Text>
                                  {assignees.length > 0 && (
                                    <VStack align="start" gap={0.5} mt={1}>
                                      {assignees.map((a: any) => {
                                        const perPerson = Math.round(totalPayout / assignees.length * 100) / 100;
                                        return (
                                          <HStack key={a.userId} gap={1} wrap="wrap">
                                            <Text color="fg.muted">
                                              <span
                                                style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}
                                                onClick={(e) => { e.stopPropagation(); navigateToProfile(a.userId, !!forAdmin); }}
                                              >
                                                {a.user?.displayName ?? a.user?.email ?? a.userId}
                                              </span>:
                                            </Text>
                                            <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">
                                              ${perPerson.toFixed(2)}
                                            </Badge>
                                          </HStack>
                                        );
                                      })}
                                    </VStack>
                                  )}
                                </Box>
                              );
                            })()}
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
                                Start Time: {fmtDateTime(occ.startedAt)}
                              </Text>
                            )}
                            {occ.completedAt && (
                              <Text fontSize="xs" color="fg.muted">
                                Complete Time: {fmtDateTime(occ.completedAt)}
                              </Text>
                            )}
                            {(() => {
                              const raw = occ.notes ?? "";
                              const lines = raw.split("\n");
                              const acceptLines = lines.filter((l) => l.startsWith("Accepted:"));
                              const otherLines = lines.filter((l) => !l.startsWith("Accepted:")).join("\n").trim();
                              const acceptComment = acceptLines.map((l) => l.replace(/^Accepted:\s*/, "")).join("\n").trim();
                              return (
                                <>
                                  {otherLines && (
                                    <TruncatedText>{otherLines}</TruncatedText>
                                  )}
                                  {(occ as any).proposalNotes && (
                                    <Box mt={1} p={1} bg="purple.50" rounded="sm">
                                      <Text fontSize="xs" fontWeight="medium" color="purple.700">Completed:</Text>
                                      <TruncatedText color="purple.600">{(occ as any).proposalNotes}</TruncatedText>
                                      {(occ as any).proposalAmount != null && (
                                        <Text fontSize="xs" color="purple.600" mt={0.5}>Amount: ${(occ as any).proposalAmount.toFixed(2)}</Text>
                                      )}
                                    </Box>
                                  )}
                                  {(occ.status === "ACCEPTED" || acceptComment) && (
                                    <Box mt={1} p={1} bg="green.50" rounded="sm">
                                      <Text fontSize="xs" fontWeight="medium" color="green.700">Accepted{acceptComment ? ":" : ""}</Text>
                                      {acceptComment && <TruncatedText color="green.600">{acceptComment}</TruncatedText>}
                                    </Box>
                                  )}
                                  {(occ as any).rejectionReason && (
                                    <Box mt={1} p={1} bg="red.50" rounded="sm">
                                      <Text fontSize="xs" fontWeight="medium" color="red.700">Rejected:</Text>
                                      <TruncatedText color="red.600">{(occ as any).rejectionReason}</TruncatedText>
                                    </Box>
                                  )}
                                  {occ.status === "REJECTED" && !(occ as any).rejectionReason && (
                                    <Box mt={1} p={1} bg="red.50" rounded="sm">
                                      <Text fontSize="xs" fontWeight="medium" color="red.700">Rejected</Text>
                                    </Box>
                                  )}
                                </>
                              );
                            })()}
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
                            {occ.payment && (() => {
                              const pay = occ.payment as any;
                              const expTotal = (occ.expenses ?? []).reduce((s: number, e: any) => s + e.cost, 0);
                              const fee = pay.platformFeeAmount ?? 0;
                              const margin = pay.businessMarginAmount ?? 0;
                              return (
                                <Box mt={1} p={2} bg="green.50" rounded="sm">
                                  <Text fontSize="xs" fontWeight="medium" color="green.700">
                                    Paid: ${pay.amountPaid.toFixed(2)} via {prettyStatus(pay.method)}
                                  </Text>
                                  {pay.note && (
                                    <TruncatedText color="green.600">{pay.note}</TruncatedText>
                                  )}
                                  {(pay.splits ?? []).length > 0 && (
                                    <VStack align="start" gap={1} mt={1}>
                                      {(pay.splits ?? []).map((sp: any) => (
                                        <HStack key={sp.userId} gap={2} align="center" fontSize="xs">
                                          <Text fontWeight="medium" color="green.700">
                                            {sp.user?.displayName ?? sp.user?.email ?? sp.userId}
                                          </Text>
                                          <Badge colorPalette="green" variant="solid" fontSize="xs" px="2" borderRadius="full">
                                            ${sp.amount.toFixed(2)}
                                          </Badge>
                                        </HStack>
                                      ))}
                                      {(expTotal > 0 || fee > 0 || margin > 0) && (
                                        <Box fontSize="xs" color="fg.muted" mt={0.5}>
                                          {expTotal > 0 && <Text>Expenses: ${expTotal.toFixed(2)}</Text>}
                                          {fee > 0 && <Text>Commission ({pay.platformFeePercent}%): ${fee.toFixed(2)}</Text>}
                                          {margin > 0 && <Text>Margin ({pay.businessMarginPercent}%): ${margin.toFixed(2)}</Text>}
                                        </Box>
                                      )}
                                    </VStack>
                                  )}
                                </Box>
                              );
                            })()}

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
                                      {forAdmin && !["COMPLETED", "PENDING_PAYMENT", "CLOSED", "ARCHIVED"].includes(occ.status) && (
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
                            {/* Comments */}
                            <Box>
                              <Badge
                                variant="subtle"
                                colorPalette="gray"
                                fontSize="xs"
                                px="2"
                                borderRadius="full"
                                cursor="pointer"
                                onClick={() => toggleComments(occ.id)}
                              >
                                <MessageCircle size={11} style={{ marginRight: 3 }} />
                                Comments ({(occ as any)._count?.comments ?? 0}) {commentsOpenFor.has(occ.id) ? "▼" : "▶"}
                              </Badge>
                              {commentsOpenFor.has(occ.id) && (
                                <VStack align="stretch" gap={2} mt={2}>
                                  {(commentsCache[occ.id] ?? []).length === 0 && !commentBusy && (
                                    <Text fontSize="xs" color="fg.muted">No comments yet.</Text>
                                  )}
                                  {(commentsCache[occ.id] ?? []).map((c) => (
                                    <Box key={c.id} p={2} bg="gray.100" rounded="md" fontSize="xs">
                                      <HStack justifyContent="space-between" alignItems="center">
                                        <Text fontWeight="semibold">{c.author.displayName ?? c.author.email ?? "Unknown"}</Text>
                                        <Text color="fg.muted" fontSize="xs">{fmtDateTime(c.createdAt)}</Text>
                                      </HStack>
                                      {commentEditing?.id === c.id ? (
                                        <VStack align="stretch" gap={1} mt={1}>
                                          <input
                                            type="text"
                                            value={commentEditing.body}
                                            onChange={(e) => setCommentEditing({ id: c.id, body: e.target.value })}
                                            style={{ fontSize: "12px", padding: "4px 8px", border: "1px solid #ccc", borderRadius: 4, width: "100%" }}
                                          />
                                          <HStack gap={1}>
                                            <Button size="xs" variant="solid" colorPalette="blue" disabled={commentBusy || !commentEditing.body.trim()} onClick={() => void editComment(c.id, occ.id, commentEditing.body)}>Save</Button>
                                            <Button size="xs" variant="ghost" onClick={() => setCommentEditing(null)}>Cancel</Button>
                                          </HStack>
                                        </VStack>
                                      ) : (
                                        <>
                                          <Text mt={1}>{c.body}</Text>
                                          <HStack gap={1} mt={1}>
                                            {c.author.id === me?.id && (
                                              <Button size="xs" variant="ghost" onClick={() => setCommentEditing({ id: c.id, body: c.body })}>Edit</Button>
                                            )}
                                            {(c.author.id === me?.id || forAdmin) && (
                                              <Button size="xs" variant="ghost" colorPalette="red" disabled={commentBusy} onClick={() => void deleteComment(c.id, occ.id)}>Delete</Button>
                                            )}
                                          </HStack>
                                        </>
                                      )}
                                    </Box>
                                  ))}
                                  <HStack gap={1} mt={1}>
                                    <input
                                      type="text"
                                      placeholder="Write a comment…"
                                      value={commentDraft[occ.id] ?? ""}
                                      onChange={(e) => setCommentDraft((prev) => ({ ...prev, [occ.id]: e.target.value }))}
                                      onKeyDown={(e) => { if (e.key === "Enter") void postComment(occ.id); }}
                                      style={{ flex: 1, fontSize: "12px", padding: "4px 8px", border: "1px solid #ccc", borderRadius: 4 }}
                                    />
                                    <Button size="xs" variant="solid" colorPalette="blue" disabled={commentBusy || !(commentDraft[occ.id] ?? "").trim()} onClick={() => void postComment(occ.id)}>Post</Button>
                                  </HStack>
                                </VStack>
                              )}
                            </Box>
                            {occ.linkGroupId && detail && (() => {
                              const linked = detail.occurrences.filter(
                                (o) => o.linkGroupId === occ.linkGroupId && o.id !== occ.id
                              );
                              if (linked.length === 0) return null;
                              return (
                                <Box mt={1} p={1} bg="purple.50" rounded="sm">
                                  <Text fontSize="xs" fontWeight="medium" color="purple.700">
                                    <Link2 size={10} style={{ display: "inline", verticalAlign: "middle", marginRight: 3 }} />
                                    Linked occurrences:
                                  </Text>
                                  <HStack gap={1} mt={0.5} wrap="wrap">
                                    {linked.map((lo) => (
                                      <Badge
                                        key={lo.id}
                                        colorPalette="purple"
                                        variant="subtle"
                                        fontSize="xs"
                                        px="2"
                                        borderRadius="full"
                                        cursor="pointer"
                                        onClick={() => {
                                          setHighlightOccId(lo.id);
                                          setFlashOccId(lo.id);
                                        }}
                                      >
                                        {lo.startAt ? fmtDate(lo.startAt) : "No date"} · {prettyStatus(lo.status)}
                                        {parseJobTags(lo).length > 0 && <> · {parseJobTags(lo).map(jobTagLabel).join(", ")}</>}
                                        {(lo as any).jobType && <> · Custom</>}
                                      </Badge>
                                    ))}
                                  </HStack>
                                </Box>
                              );
                            })()}
                          </VStack>
                          <HStack gap={1} wrap="wrap" mt={1}>
                            {occ.isTentative ? (
                              <StatusBadge status="Tentative" palette="orange" variant="solid" />
                            ) : occ.status !== "SCHEDULED" ? (
                              <StatusBadge
                                status={occ.status}
                                palette={occurrenceStatusColor(occ.status)}
                                variant="subtle"
                              />
                            ) : null}
                            {(occ.workflow === "STANDARD" || (!occ.workflow && !occ.isEstimate && !occ.isOneOff)) && (() => {
                              const freq = (occ as any).frequencyDays ?? (job as any).frequencyDays;
                              return <StatusBadge status={freq ? `Repeating · ${freq}d` : "Repeating"} palette="blue" variant="outline" />;
                            })()}
                            {(occ.workflow === "ESTIMATE" || occ.isEstimate) && (
                              <StatusBadge status="Estimate" palette="pink" variant="solid" />
                            )}
                            {(occ.workflow === "ONE_OFF" || occ.isOneOff) && (
                              <StatusBadge status="One-off" palette="cyan" variant="solid" />
                            )}
                            {(occ as any).isAdminOnly && (
                              <StatusBadge status="Administered" palette="red" variant="outline" />
                            )}
                            {occ.linkGroupId && (
                              <Badge colorPalette="purple" variant="outline" fontSize="xs" px="1.5" borderRadius="full">
                                <Link2 size={10} style={{ marginRight: 3 }} /> Linked
                              </Badge>
                            )}
                          </HStack>
                        </VStack>

                        {forAdmin && (
                          <HStack gap={2} mt={2} wrap="wrap">
                            <Button
                              size="xs"
                              variant="solid"
                              colorPalette="blue"
                              onClick={() =>
                                openEventSearch(
                                  "servicesTabToJobsTabSearch",
                                  "",
                                  true,
                                  `${occ.id}|${occ.startAt ?? ""}`,
                                )
                              }
                            >
                              View in Jobs
                            </Button>
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
                            {(occ.workflow === "ESTIMATE" || occ.isEstimate) && occ.status === "PROPOSAL_SUBMITTED" && (
                              <StatusButton
                                id="occ-accept-proposal"
                                itemId={occ.id}
                                label="Accept Estimate"
                                onClick={async () => setConfirmAction({
                                  title: "Accept Estimate?",
                                  message: "Add a comment (optional):",
                                  confirmLabel: "Accept",
                                  colorPalette: "green",
                                  inputPlaceholder: "Comment...",
                                  inputLabel: "Comment",
                                  inputOptional: true,
                                  onConfirm: async (comment: string) => {
                                    try {
                                      const result = await apiPost<{ accepted: boolean; jobId: string; occurrence: any }>(`/api/admin/occurrences/${occ.id}/accept-proposal`, { comment: comment || undefined });
                                      publishInlineMessage({ type: "SUCCESS", text: "Estimate accepted." });
                                      void loadDetail(job.id, true);
                                      // Prompt to create occurrence
                                      if (result.jobId) {
                                        setOccurrenceJobId(result.jobId);
                                        setOccurrenceDefaultNotes(result.occurrence?.notes ?? null);
                                        setOccurrenceDefaultPrice(result.occurrence?.price ?? null);
                                        setOccurrenceDefaultEstMins(result.occurrence?.estimatedMinutes ?? null);
                                        setOccurrenceJobHasFrequency(false);
                                        setOccurrenceJobFreqDays(null);
                                        setOccurrenceDefaultWorkflow("STANDARD");
                                        setPromptOccurrenceOpen(true);
                                      }
                                    } catch (err: any) {
                                      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Accept failed.", err) });
                                    }
                                  },
                                })}
                                variant="solid"
                                colorPalette="green"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {(occ.workflow === "ESTIMATE" || occ.isEstimate) && occ.status === "PROPOSAL_SUBMITTED" && (
                              <StatusButton
                                id="occ-reject-proposal"
                                itemId={occ.id}
                                label="Reject Estimate"
                                onClick={async () => setConfirmAction({
                                  title: "Reject Estimate?",
                                  message: "Add a reason (optional):",
                                  confirmLabel: "Reject",
                                  colorPalette: "red",
                                  inputPlaceholder: "Reason...",
                                  inputLabel: "Reason",
                                  inputOptional: true,
                                  onConfirm: async (reason: string) => {
                                    try {
                                      await apiPost(`/api/admin/occurrences/${occ.id}/reject-proposal`, { reason: reason || undefined });
                                      publishInlineMessage({ type: "SUCCESS", text: "Estimate rejected." });
                                      void loadDetail(job.id, true);
                                    } catch (err: any) {
                                      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Reject failed.", err) });
                                    }
                                  },
                                })}
                                variant="outline"
                                colorPalette="red"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {(occ.status === "SCHEDULED" || occ.isTentative) && (
                              <StatusButton
                                id="occ-tentative"
                                itemId={occ.id}
                                label={occ.isTentative ? "Clear Tentative" : "Mark Tentative"}
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
                                  setAssigneeHasPayment(!!occ.payment);
                                  setAssigneeDialogOpen(true);
                                }}
                                variant="outline"
                                busyId={statusButtonBusyId}
                                setBusyId={setStatusButtonBusyId}
                              />
                            )}
                            {occ.status === "SCHEDULED" && !occ.isTentative && (
                              <StatusButton
                                id="occ-start"
                                itemId={occ.id}
                                label="Start"
                                onClick={async () => setConfirmAction({
                                  title: "Start Occurrence?",
                                  message: "Are you currently on-site at the job location?",
                                  confirmLabel: "Yes — record location & start",
                                  colorPalette: "blue",
                                  onConfirm: () => void patchOccurrenceStatus(occ.id, job.id, "IN_PROGRESS", undefined, true),
                                  cancelLabel: "No — start without location",
                                  onCancelAction: () => void patchOccurrenceStatus(occ.id, job.id, "IN_PROGRESS", undefined, false),
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
                                onClick={async () => {
                                  if (occ.isEstimate) {
                                    setConfirmAction({
                                      title: "Complete Estimate?",
                                      message: "This estimate will be closed (no payment step).",
                                      confirmLabel: "Complete",
                                      colorPalette: "green",
                                      inputLabel: "Comment (required)",
                                      inputPlaceholder: "What happened and why is this estimate being completed?",
                                      onConfirm: (comment: string) => void patchOccurrenceStatus(occ.id, job.id, "CLOSED", comment),
                                    });
                                  } else {
                                    setConfirmAction({
                                      title: "Complete Occurrence?",
                                      message: "Are you currently on-site at the job location?",
                                      confirmLabel: "Yes — record location & complete",
                                      colorPalette: "green",
                                      onConfirm: () => void patchOccurrenceStatus(occ.id, job.id, "PENDING_PAYMENT", undefined, true),
                                      cancelLabel: "No — complete without location",
                                      onCancelAction: () => void patchOccurrenceStatus(occ.id, job.id, "PENDING_PAYMENT", undefined, false),
                                    });
                                  }
                                }}
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
                                    ? fmtDate(occ.startAt)
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
                                    ? fmtDate(occ.startAt)
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
                            {occ.jobId && (
                              <StatusButton
                                id="occ-link"
                                itemId={occ.id}
                                label={occ.linkGroupId ? "Unlink" : "Link to..."}
                                onClick={async () => {
                                  if (occ.linkGroupId) {
                                    await apiPost(`/api/admin/occurrences/${occ.id}/unlink`);
                                    publishInlineMessage({ type: "SUCCESS", text: "Occurrence unlinked." });
                                    void loadDetail(job.id, true);
                                  } else {
                                    setLinkPickerOccId(occ.id);
                                    setLinkPickerJobId(job.id);
                                    setLinkPickerPropertyId(job.propertyId);
                                  }
                                }}
                                variant="outline"
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
                                  ? fmtDate(occ.startAt)
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
              setOccurrenceJobFreqDays(created.frequencyDays ?? null);
              setOccurrenceDefaultWorkflow("STANDARD");
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
          jobFrequencyDays={occurrenceJobFreqDays}
          defaultAssignees={occurrenceDefaultAssignees}
          defaultWorkflow={occurrenceDefaultWorkflow}
          onSaved={() => {
            setOccurrenceDefaultWorkflow(undefined);
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
          defaultIsAdminOnly={(editingOccurrence as any).isAdminOnly}
          defaultJobType={(editingOccurrence as any).jobType}
          defaultJobTags={(() => { const raw = (editingOccurrence as any).jobTags; if (!raw) return null; if (Array.isArray(raw)) return raw; try { return JSON.parse(raw); } catch { return null; } })()}
          defaultPinnedNote={(editingOccurrence as any).pinnedNote}
          defaultPinnedNoteRepeats={(editingOccurrence as any).pinnedNoteRepeats ?? true}
          defaultWorkflow={editingOccurrence.workflow}
          defaultOccTitle={(editingOccurrence as any).title ?? null}
          defaultFrequencyDays={(editingOccurrence as any).frequencyDays ?? null}
          isAdmin={forAdmin}
          jobFrequencyDays={editOccurrenceJobId ? (items.find((j) => j.id === editOccurrenceJobId) as any)?.frequencyDays ?? null : null}
          onSaved={() => {
            if (editOccurrenceJobId) void loadDetail(editOccurrenceJobId, true);
            void load(false);
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
          hasPayment={assigneeHasPayment}
          onChanged={() => {
            if (assigneeJobId) {
              void loadDetail(assigneeJobId, true);
            }
          }}
        />
      )}

      <DefaultCrewDialog
        open={defaultCrewDialogOpen}
        onOpenChange={setDefaultCrewDialogOpen}
        jobId={defaultCrewJobId}
        currentAssignees={defaultCrewCurrent}
        onChanged={() => {
          if (defaultCrewJobId) void loadDetail(defaultCrewJobId, true);
        }}
      />


      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.title ?? ""}
        message={confirmAction?.message ?? ""}
        confirmLabel={confirmAction?.confirmLabel}
        confirmColorPalette={confirmAction?.colorPalette}
        inputPlaceholder={confirmAction?.inputPlaceholder}
        inputLabel={confirmAction?.inputLabel}
        inputOptional={confirmAction?.inputOptional}
        inputDefaultValue={confirmAction?.inputDefaultValue}
        cancelLabel={confirmAction?.cancelLabel}
        onCancelAction={confirmAction?.onCancelAction}
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
          totalExpenses={(acceptPaymentOcc.expenses ?? []).reduce((s: number, e: any) => s + e.cost, 0)}
          commissionPercent={commissionPercent}
          marginPercent={marginPercent}
          assignees={(acceptPaymentOcc.assignees ?? []).filter((a: any) => a.role !== "observer").map((a: any) => ({
            userId: a.userId,
            displayName: a.user?.displayName ?? a.user?.email,
            workerType: a.user?.workerType,
          }))}
          onAccepted={(result) => {
            const jobId = acceptPaymentJobId;
            if (jobId) void loadDetail(jobId, true);
            window.dispatchEvent(new CustomEvent("seedlings3:jobs-changed"));
            if (result?.nextOccurrence) {
              publishInlineMessage({ type: "SUCCESS", text: `Next occurrence auto-scheduled for ${fmtDate(result.nextOccurrence.startAt)}.` });
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

      {/* Link Picker Dialog */}
      <Dialog.Root
        open={!!linkPickerOccId}
        onOpenChange={(e) => { if (!e.open) { setLinkPickerOccId(null); setLinkPickerJobId(null); setLinkPickerPropertyId(null); } }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop zIndex={1500} />
          <Dialog.Positioner zIndex={1600} paddingInline="4" paddingBlock="6">
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Link Occurrence</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm" mb={3}>Select an occurrence from this property to link with:</Text>
                <VStack align="stretch" gap={2} maxH="400px" overflowY="auto">
                  {(() => {
                    // Collect all occurrences from all jobs on the same property
                    const allOccs: { occ: any; jobLabel: string; jobId: string }[] = [];
                    if (linkPickerPropertyId) {
                      for (const job of items) {
                        if (job.propertyId !== linkPickerPropertyId) continue;
                        const detail = jobDetails[job.id];
                        if (!detail) {
                          // Load detail for this job if not loaded
                          void loadDetail(job.id);
                          continue;
                        }
                        for (const o of detail.occurrences) {
                          if (o.id === linkPickerOccId) continue;
                          allOccs.push({
                            occ: o,
                            jobLabel: job.property?.displayName ?? "Job",
                            jobId: job.id,
                          });
                        }
                      }
                    }
                    if (allOccs.length === 0) {
                      return <Text fontSize="sm" color="fg.muted">No other occurrences on this property.</Text>;
                    }
                    return allOccs.map(({ occ: o, jobLabel, jobId: jId }) => (
                      <Box
                        key={o.id}
                        p={2}
                        borderWidth="1px"
                        rounded="md"
                        cursor="pointer"
                        _hover={{ bg: "purple.50", borderColor: "purple.300" }}
                        onClick={async () => {
                          try {
                            const result = await apiPost<{ linkGroupId: string; _linkedUpdated?: string[] }>(
                              `/api/admin/occurrences/${linkPickerOccId}/link`,
                              { targetOccurrenceId: o.id }
                            );
                            let msg = "Occurrences linked.";
                            if (result._linkedUpdated && result._linkedUpdated.length > 0) {
                              msg += ` ${result._linkedUpdated.length} linked occurrence(s) were also updated.`;
                            }
                            publishInlineMessage({ type: "SUCCESS", text: msg });
                            if (linkPickerJobId) void loadDetail(linkPickerJobId, true);
                            if (jId !== linkPickerJobId) void loadDetail(jId, true);
                          } catch (err: any) {
                            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Link failed.", err) });
                          }
                          setLinkPickerOccId(null);
                          setLinkPickerJobId(null);
                          setLinkPickerPropertyId(null);
                        }}
                      >
                        <HStack justify="space-between">
                          <VStack align="start" gap={0}>
                            <Text fontSize="sm" fontWeight="medium">
                              {o.startAt ? fmtDate(o.startAt) : "No date"}
                              {parseJobTags(o).length > 0 && <> · {parseJobTags(o).map(jobTagLabel).join(", ")}</>}
                              {(o as any).jobType && <> · Custom</>}
                            </Text>
                            <Text fontSize="xs" color="fg.muted">
                              {prettyStatus(o.status)}
                              {o.price != null && <> · ${o.price.toFixed(2)}</>}
                              {jId !== linkPickerJobId && <> · {jobLabel}</>}
                            </Text>
                          </VStack>
                          <StatusBadge
                            status={o.status}
                            palette={occurrenceStatusColor(o.status)}
                            variant="subtle"
                          />
                        </HStack>
                      </Box>
                    ));
                  })()}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="ghost"
                  onClick={() => { setLinkPickerOccId(null); setLinkPickerJobId(null); setLinkPickerPropertyId(null); }}
                >
                  Cancel
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}
