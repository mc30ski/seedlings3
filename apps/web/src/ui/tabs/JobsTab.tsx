"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSwipe } from "@/src/lib/useSwipe";
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
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { AlertTriangle, Archive, Ban, Bell, BellOff, Calendar, CalendarRange, CheckCircle2, ChevronDown, ChevronUp, CircleDollarSign, Copy, Filter, Hand, Heart, Info, LayoutList, Link2, List, Mail, Maximize2, MessageCircle, Phone, Pin, PinOff, Play, RefreshCw, Share2, Star, Tag, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { getLocation } from "@/src/lib/geo";
import { determineRoles, occurrenceStatusColor, prettyStatus, clientLabel, fmtDate, fmtDateTime, fmtDateWeekday, bizDateKey, jobTypeLabel } from "@/src/lib/lib";
import { type TabPropsType, type WorkerOccurrence, JOB_OCCURRENCE_STATUS, JOB_KIND } from "@/src/lib/types";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import StatusButton from "@/src/ui/components/StatusButton";
import AddAssigneeDialog from "@/src/ui/dialogs/AddAssigneeDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import SendReceiptDialog from "@/src/ui/dialogs/SendReceiptDialog";
import { type ReceiptData } from "@/src/lib/receipt";
import AcceptPaymentDialog from "@/src/ui/dialogs/AcceptPaymentDialog";
import ManageExpensesDialog from "@/src/ui/dialogs/ManageExpensesDialog";
import { MapLink, TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch, navigateToProfile } from "@/src/lib/bus";
import { type DatePreset, computeDatesFromPreset, PRESET_LABELS } from "@/src/lib/datePresets";
import OccurrencePhotos from "@/src/ui/components/OccurrencePhotos";
import { jobTagLabel } from "@/src/ui/components/JobTagPicker";
import { parseAdminTags, adminTagLabel, adminTagColor } from "@/src/ui/components/AdminTagPicker";
import TruncatedText from "@/src/ui/components/TruncatedText";
import { useOffline } from "@/src/lib/offline";
import { enqueueAction } from "@/src/lib/offlineQueue";
import TaskDialog from "@/src/ui/dialogs/TaskDialog";
import ClaimAgreementDialog from "@/src/ui/dialogs/ClaimAgreementDialog";
import InsuranceUploadDialog from "@/src/ui/dialogs/InsuranceUploadDialog";
import CompleteJobDialog from "@/src/ui/dialogs/CompleteJobDialog";
import OccurrenceDialog from "@/src/ui/dialogs/OccurrenceDialog";
import LightEstimateDialog from "@/src/ui/dialogs/LightEstimateDialog";
import EventDialog from "@/src/ui/dialogs/EventDialog";
import FollowupDialog from "@/src/ui/dialogs/FollowupDialog";
import AnnouncementDialog from "@/src/ui/dialogs/AnnouncementDialog";
import PinnedNoteDialog from "@/src/ui/dialogs/PinnedNoteDialog";

function localDate(d: Date): string {
  return bizDateKey(d);
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function actualMinutes(occ: { startedAt?: string | null; completedAt?: string | null }): number | null {
  if (!occ.startedAt || !occ.completedAt) return null;
  return (new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000;
}

function parseJobTags(occ: any): string[] {
  if (!occ.jobTags) return [];
  if (Array.isArray(occ.jobTags)) return occ.jobTags;
  try { return JSON.parse(occ.jobTags); } catch { return []; }
}

const statusStates = ["ALL", "UNCLAIMED", ...JOB_OCCURRENCE_STATUS.filter((s) => s !== "ARCHIVED" && s !== "CANCELED")] as const;

const quickDateItemsBase = [
  { label: "Now", value: "now" },
  { label: "This week", value: "thisWeek" },
  { label: "This month", value: "thisMonth" },
  { label: "Yesterday", value: "yesterday" },
  { label: "Last week", value: "lastWeek" },
  { label: "Last month", value: "lastMonth" },
];

const kindStates = ["ALL", ...JOB_KIND] as const;

type OccComment = {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { id: string; displayName?: string | null; email?: string | null };
};

type JobsTabProps = TabPropsType & {
  /** When set, filter occurrences to only those assigned to these users */
  viewAsUserIds?: string[];
  /** Simulated worker type when admin is impersonating (for UI behavior like hiding tentative) */
  viewAsWorkerType?: string | null;
  /** Extra UI rendered inline in the search bar row */
  headerSlot?: React.ReactNode;
  /** Extra UI rendered below the search bar row (e.g. selected worker badges) */
  headerBelowSlot?: React.ReactNode;
  /** Called when the "Clear" badge is clicked, to reset external filters (e.g. View as) */
  onClearAll?: () => void;
};

export default function JobsTab({ me, purpose = "WORKER", viewAsUserIds, viewAsWorkerType, headerSlot, headerBelowSlot, onClearAll }: JobsTabProps) {
  const { isAvail, forAdmin, isAdmin, isSuper } = determineRoles(me, purpose);
  const { isOffline } = useOffline();

  function shareOccurrenceLink(occId: string) {
    const url = `${window.location.origin}/?occ=${occId}${forAdmin ? "&view=admin" : ""}`;
    navigator.clipboard.writeText(url).then(() => {
      publishInlineMessage({ type: "SUCCESS", text: "Link copied to clipboard." });
    }).catch(() => {
      publishInlineMessage({ type: "ERROR", text: "Failed to copy link." });
    });
  }
  const myId = viewAsUserIds?.length === 1 ? viewAsUserIds[0] : me?.id || "";
  const pfx = purpose === "ADMIN" ? "ajobs" : "wjobs";

  const [q, setQ] = useState("");
  const [compact, setCompact] = usePersistedState(`${pfx}_compact`, true);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);

  const kindItems = useMemo(
    () => kindStates.map((s) => ({ label: s === "ALL" ? "All Kinds" : prettyStatus(s), value: s })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );
  const [typeFilter, setTypeFilter] = usePersistedState<string[]>(`${pfx}_type`, ["ALL"]);
  const typeItems = useMemo(
    () => [
      { label: "All Types", value: "ALL" },
      { label: "One-off", value: "ONE_OFF" },
      { label: "Estimate", value: "ESTIMATE" },
      { label: "Tentative", value: "TENTATIVE" },
      { label: "Task", value: "TASK" },
      { label: "Reminder", value: "REMINDER" },
      { label: "Event", value: "EVENT" },
      { label: "Followup", value: "FOLLOWUP" },
      { label: "Announcement", value: "ANNOUNCEMENT" },
    ],
    []
  );
  const typeCollection = useMemo(
    () => createListCollection({ items: typeItems }),
    [typeItems]
  );

  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(`${pfx}_status`, ["ALL"]);
  const statusItems = useMemo(
    () => statusStates.map((s) => ({ label: s === "ALL" ? "All Statuses" : s === "UNCLAIMED" ? "Unclaimed" : prettyStatus(s), value: s })),
    []
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );
  const [showCanceled, setShowCanceled] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");
  const [showInfoDialog, setShowInfoDialog] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return !localStorage.getItem("seedlings_jobs_infoDismissed");
    } catch { return false; }
  });
  const [calFeedStep, setCalFeedStep] = useState<"closed" | "confirm" | "result">("closed");
  const [calFeedUrl, setCalFeedUrl] = useState<string | null>(null);
  const [calFeedLoading, setCalFeedLoading] = useState(false);
  const [overdueCount, setOverdueCount] = useState(0);
  const [highValueThreshold, setHighValueThreshold] = useState(200);
  const [commissionPercent, setCommissionPercent] = useState(0);
  const [marginPercent, setMarginPercent] = useState(0);

  // Build a rich label for offline queue entries
  function queueLabel(occ: WorkerOccurrence | undefined, action: string, detail?: string): string {
    const property = occ?.job?.property?.displayName;
    const tags = occ ? parseJobTags(occ) : [];
    const tagStr = tags.length > 0 ? tags.map(jobTagLabel).join(", ") : null;
    const hasCustom = !!(occ as any)?.jobType;
    const jobType = [tagStr, hasCustom ? "Custom" : null].filter(Boolean).join(", ") || occ?.kind;
    const date = occ?.startAt ? bizDateKey(occ.startAt) : null;
    const parts = [action];
    if (property) parts.push(property);
    else if (occ?.title) parts.push(occ.title);
    else parts.push("Job");
    if (jobType) parts.push(`(${jobType})`);
    if (date) parts.push(`· ${date}`);
    if (detail) parts.push(`· ${detail}`);
    return parts.join(" ");
  }

  // Pinned occurrences (worker only)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const isWorkerView = purpose === "WORKER";

  useEffect(() => {
    if (!isWorkerView) return;
    apiGet<string[]>("/api/occurrences/pinned")
      .then((ids) => setPinnedIds(new Set(Array.isArray(ids) ? ids : [])))
      .catch(() => {});
  }, [isWorkerView]);

  async function togglePin(occId: string) {
    const wasPinned = pinnedIds.has(occId);
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (wasPinned) next.delete(occId);
      else next.add(occId);
      return next;
    });
    if (isOffline) {
      const occ = items.find((o) => o.id === occId);
      await enqueueAction(wasPinned ? "UNPIN" : "PIN", occId, queueLabel(occ, wasPinned ? "Unpin" : "Pin"), {});
      publishInlineMessage({ type: "INFO", text: `${wasPinned ? "Unpin" : "Pin"} queued for sync.` });
      return;
    }
    try {
      await apiPost(`/api/occurrences/${occId}/${wasPinned ? "unpin" : "pin"}`);
    } catch (err) {
      setPinnedIds((prev) => {
        const next = new Set(prev);
        if (wasPinned) next.add(occId);
        else next.delete(occId);
        return next;
      });
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Pin failed.", err) });
    }
  }

  // Liked occurrences (worker only)
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isWorkerView) return;
    apiGet<string[]>("/api/occurrences/liked")
      .then((ids) => setLikedIds(new Set(Array.isArray(ids) ? ids : [])))
      .catch(() => {});
  }, [isWorkerView]);

  async function toggleLike(occId: string) {
    const wasLiked = likedIds.has(occId);
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (wasLiked) next.delete(occId);
      else next.add(occId);
      return next;
    });
    if (isOffline) {
      const occ = items.find((o) => o.id === occId);
      await enqueueAction(wasLiked ? "UNLIKE" : "LIKE", occId, queueLabel(occ, wasLiked ? "Unlike" : "Like"), {});
      publishInlineMessage({ type: "INFO", text: `${wasLiked ? "Unlike" : "Like"} queued for sync.` });
      return;
    }
    try {
      await apiPost(`/api/occurrences/${occId}/${wasLiked ? "unlike" : "like"}`);
    } catch (err) {
      setLikedIds((prev) => {
        const next = new Set(prev);
        if (wasLiked) next.add(occId);
        else next.delete(occId);
        return next;
      });
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Like failed.", err) });
    }
  }

  // Photo viewer (for compact card thumbnails)
  const [viewerPhotos, setViewerPhotos] = useState<{ id: string; url: string }[]>([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  // Global keyboard handler for photo viewer
  const viewerPhotosRef = useRef(viewerPhotos);
  viewerPhotosRef.current = viewerPhotos;
  useEffect(() => {
    if (viewerPhotos.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      const len = viewerPhotosRef.current.length;
      if (e.key === "ArrowLeft") { e.preventDefault(); setViewerIndex((i) => Math.max(i - 1, 0)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); setViewerIndex((i) => Math.min(i + 1, len - 1)); }
      else if (e.key === "Escape") { setViewerPhotos([]); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewerPhotos.length > 0]);

  // Task dialog
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [filterJobId, setFilterJobId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<any>(null);

  // Standalone reminder dialog
  const [standaloneReminderDialogOpen, setStandaloneReminderDialogOpen] = useState(false);
  const [editingReminder, setEditingReminder] = useState<any>(null);

  // Event dialog
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<any>(null);

  // Followup dialog
  const [followupDialogOpen, setFollowupDialogOpen] = useState(false);
  const [editingFollowup, setEditingFollowup] = useState<any>(null);

  // Announcement dialog
  const [announcementDialogOpen, setAnnouncementDialogOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<any>(null);

  // Pinned note dialog
  const [pinnedNoteDialogOpen, setPinnedNoteDialogOpen] = useState(false);
  const [pinnedNoteOcc, setPinnedNoteOcc] = useState<any>(null);

  // Light estimate & convert dialogs
  const [lightEstDialogOpen, setLightEstDialogOpen] = useState(false);
  const [editingLightEstimate, setEditingLightEstimate] = useState<WorkerOccurrence | null>(null);
  const [pendingEstimateConvert, setPendingEstimateConvert] = useState<any>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!createMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) setCreateMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [createMenuOpen]);

  // Reminder dialog state
  const [reminderDialogOccId, setReminderDialogOccId] = useState<string | null>(null);
  const [reminderDate, setReminderDate] = useState("");
  const [reminderNote, setReminderNote] = useState("");

  async function setReminder(occId: string, remindAt: string, note: string) {
    if (isOffline) {
      const occ = items.find((o) => o.id === occId);
      await enqueueAction("SET_REMINDER", occId, queueLabel(occ, "Set reminder", note ? `"${note.slice(0, 40)}"` : undefined), { remindAt, note: note || undefined });
      publishInlineMessage({ type: "INFO", text: "Reminder queued for sync." });
      return;
    }
    try {
      await apiPost(`/api/occurrences/${occId}/reminder`, { remindAt, note: note || undefined });
      publishInlineMessage({ type: "SUCCESS", text: "Reminder set." });
      await load(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to set reminder.", err) });
    }
  }

  async function clearReminder(occId: string) {
    try {
      await apiPost(`/api/occurrences/${occId}/reminder/clear`);
      publishInlineMessage({ type: "SUCCESS", text: "Reminder cleared." });
      await load(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to clear reminder.", err) });
    }
  }

  // Reschedule state
  const [startJobOcc, setStartJobOcc] = useState<WorkerOccurrence | null>(null);
  const [startJobTime, setStartJobTime] = useState("");
  const [rescheduleOcc, setRescheduleOcc] = useState<WorkerOccurrence | null>(null);
  const [rescheduleNotify, setRescheduleNotify] = useState<{ message: string; phone?: string | null; email?: string | null } | null>(null);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [receiptContact, setReceiptContact] = useState<{ phone?: string | null; email?: string | null }>({});
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleReason, setRescheduleReason] = useState("");
  const [rescheduleBusy, setRescheduleBusy] = useState(false);

  async function submitReschedule() {
    if (!rescheduleOcc || !rescheduleDate) return;
    if (!forAdmin && !rescheduleReason.trim()) return;
    setRescheduleBusy(true);
    try {
      const patchData: any = { startAt: rescheduleDate + "T09:00:00Z" };
      if (rescheduleOcc.startAt && rescheduleOcc.endAt) {
        const duration = new Date(rescheduleOcc.endAt).getTime() - new Date(rescheduleOcc.startAt).getTime();
        patchData.endAt = new Date(new Date(rescheduleDate + "T09:00:00Z").getTime() + duration).toISOString();
      }
      if (forAdmin) {
        // Admin uses the admin endpoint — no comment requirement enforced server-side
        await apiPatch(`/api/admin/occurrences/${rescheduleOcc.id}`, patchData);
        // Still post the comment since the user filled it in
        if (rescheduleReason.trim()) {
          await apiPost(`/api/occurrences/${rescheduleOcc.id}/comments`, { body: `Rescheduled: ${rescheduleReason.trim()}` });
        }
      } else {
        // Worker uses the reschedule endpoint (claimer-only, comment required)
        await apiPost(`/api/occurrences/${rescheduleOcc.id}/reschedule`, { ...patchData, comment: rescheduleReason.trim() });
      }
      publishInlineMessage({ type: "SUCCESS", text: `Job rescheduled to ${fmtDate(rescheduleDate + "T12:00:00Z")}.` });

      // Build notify message
      const clientName = rescheduleOcc.job?.property?.client?.displayName ?? "Client";
      const property = rescheduleOcc.job?.property?.displayName ?? "";
      const newDateStr = fmtDate(rescheduleDate + "T12:00:00Z");
      const reason = rescheduleReason.trim();
      const notifyMsg = `Hi ${clientName}, this is Seedlings Lawn Care. Your service at ${property} has been rescheduled to ${newDateStr}.${reason ? ` Reason: ${reason}.` : ""} Please let us know if you have any questions. Thank you!`;
      const poc = rescheduleOcc.job?.property?.pointOfContact;

      setRescheduleOcc(null);
      setRescheduleDate("");
      setRescheduleReason("");

      setRescheduleNotify({
        message: notifyMsg,
        phone: poc?.phone,
        email: poc?.email,
      });

      await load(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Reschedule failed.", err) });
    } finally {
      setRescheduleBusy(false);
    }
  }

  // Listen for navigation from Reminders tab
  const [highlightOccId, setHighlightOccId] = useState<string | null>(null);
  useEffect(() => {
    const onRun = (ev: Event) => {
      const { q: searchQ, entityId } = (ev as CustomEvent<{ q?: string; entityId?: string }>).detail || {};
      setOverdueActive(false);
      if (entityId) {
        // entityId is "occId|startAt"
        const sepIdx = entityId.indexOf("|");
        const occId = sepIdx >= 0 ? entityId.slice(0, sepIdx) : entityId;
        const startAt = sepIdx >= 0 ? entityId.slice(sepIdx + 1) : "";
        setHighlightOccId(occId);
        setExpandedCards(new Set([occId]));
        setQ("");
        setDatePreset(null);
        // Set a 7-day window around the occurrence date
        if (startAt) {
          const occDate = new Date(startAt);
          const from = new Date(occDate);
          from.setDate(from.getDate() - 3);
          const to = new Date(occDate);
          to.setDate(to.getDate() + 3);
          setDateFrom(bizDateKey(from));
          setDateTo(bizDateKey(to));
        } else {
          // No date — use recent
          const d = new Date();
          d.setDate(d.getDate() - 7);
          setDateFrom(bizDateKey(d));
          setDateTo("");
        }
      } else if (typeof searchQ === "string") {
        setQ(searchQ);
        setHighlightOccId(null);
      }
    };
    window.addEventListener("remindersToJobsTabSearch:run", onRun as EventListener);
    return () => window.removeEventListener("remindersToJobsTabSearch:run", onRun as EventListener);
  }, []);

  // Listen for navigation from Services tab → specific occurrence
  useEffect(() => {
    const onNav = (ev: Event) => {
      const { entityId } = (ev as CustomEvent<{ q?: string; entityId?: string }>).detail || {};
      if (!entityId) return;
      // entityId is "occId|startAt"
      const sepIdx = entityId.indexOf("|");
      const occId = sepIdx >= 0 ? entityId.slice(0, sepIdx) : entityId;
      const startAt = sepIdx >= 0 ? entityId.slice(sepIdx + 1) : "";
      setHighlightOccId(occId);
      setExpandedCards(new Set([occId]));
      setFilterJobId(null);
      setQ("");
      setOverdueActive(false);
      setDatePreset(null);
      if (startAt) {
        const occDate = new Date(startAt);
        const from = new Date(occDate); from.setDate(from.getDate() - 3);
        const to = new Date(occDate); to.setDate(to.getDate() + 3);
        setDateFrom(bizDateKey(from));
        setDateTo(bizDateKey(to));
        void load(true, { from: bizDateKey(from), to: bizDateKey(to) }, occId);
      }
    };
    window.addEventListener("open:servicesTabToJobsTabSearch", onNav as EventListener);
    return () => window.removeEventListener("open:servicesTabToJobsTabSearch", onNav as EventListener);
  }, []);

  // Check for "show overdue" flag from header badge — on mount and via event
  const applyOverdue = useCallback(() => {
    setQ("");
    setHighlightOccId(null);
    setFilterJobId(null);
    setKind(["ALL"]);
    setStatusFilter(["ALL"]);
    setTypeFilter(["ALL"]);
    setVipOnly(false);
    setLikedOnly(false);
    setShowCanceled(false);
    setShowArchived(false);
    setDatePreset(null);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const overdueTo = localDate(yesterday);
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 60);
    const overdueFrom = localDate(monthAgo);
    setDateFrom(overdueFrom);
    setDateTo(overdueTo);
    setOverdueActive(true);
    void load(true, { from: overdueFrom, to: overdueTo });
  }, []);

  useEffect(() => {
    if (!forAdmin) return;
    try {
      const flag = localStorage.getItem("seedlings_adminJobs_showOverdue");
      if (flag) {
        localStorage.removeItem("seedlings_adminJobs_showOverdue");
        applyOverdue();
      }
    } catch {}
    const onShowOverdue = () => applyOverdue();
    window.addEventListener("adminJobs:showOverdue", onShowOverdue);
    return () => window.removeEventListener("adminJobs:showOverdue", onShowOverdue);
  }, [forAdmin]);

  const [datePreset, setDatePreset] = usePersistedState<DatePreset>(`${pfx}_datePreset`, "now");
  const presetDates = useMemo(() => computeDatesFromPreset(datePreset), [datePreset]);
  const [dateFrom, setDateFrom] = usePersistedState(`${pfx}_dateFrom`, presetDates.from);
  const [dateTo, setDateTo] = usePersistedState(`${pfx}_dateTo`, presetDates.to);
  const [quickDate, setQuickDate] = useState<string[]>([]);
  const [overdueActive, setOverdueActive] = useState(false);
  const [vipOnly, setVipOnly] = useState(false);
  const [likedOnly, setLikedOnly] = useState(false);
  const presetBeforeOverdueRef = useRef<DatePreset>(datePreset);

  // Daily reset for worker tab — clear filters and set time frame to "Now" on the first render of a new day
  useEffect(() => {
    if (forAdmin) return;
    const key = `${pfx}_lastUsedDate`;
    try {
      const lastDate = localStorage.getItem(key);
      const today = new Date().toISOString().slice(0, 10);
      if (!lastDate || lastDate !== today) {
        // New day — reset filters
        setDatePreset("now");
        const nowDates = computeDatesFromPreset("now");
        setDateFrom(nowDates.from);
        setDateTo(nowDates.to);
        setKind(["ALL"]);
        setTypeFilter(["ALL"]);
        setStatusFilter(["ALL"]);
        setOverdueActive(false);
        setVipOnly(false);
        setLikedOnly(false);
        setQ("");
        setHighlightOccId(null);
        setFilterJobId(null);
      }
      localStorage.setItem(key, today);
    } catch {}
  }, []);

  // Re-apply preset dates when preset changes (e.g., on mount or when user selects a preset)
  useEffect(() => {
    if (overdueActive) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const monthAgo = new Date();
      monthAgo.setDate(monthAgo.getDate() - 60);
      const { from, to, clamped } = clampWorkerDates(localDate(monthAgo), localDate(yesterday));
      setDateFrom(from);
      setDateTo(to);
      if (clamped) publishInlineMessage({ type: "WARNING", text: "Date range limited to 2 months." });
    } else if (datePreset) {
      const d = computeDatesFromPreset(datePreset);
      const { from, to, clamped } = clampWorkerDates(d.from, d.to);
      setDateFrom(from);
      setDateTo(to);
      if (clamped) publishInlineMessage({ type: "WARNING", text: "Date range limited to 2 months." });
    }
  }, [datePreset, overdueActive]);

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

  const [manageOpen, setManageOpen] = useState(false);
  const [agreementDialogOpen, setAgreementDialogOpen] = useState(false);
  const [pendingClaimOccId, setPendingClaimOccId] = useState<string | null>(null);
  const [insuranceDialogOpen, setInsuranceDialogOpen] = useState(false);
  const isTrainee = viewAsWorkerType !== undefined ? viewAsWorkerType === "TRAINEE" : me?.workerType === "TRAINEE";
  const [manageOccurrence, setManageOccurrence] = useState<WorkerOccurrence | null>(null);
  const [completeDialogOcc, setCompleteDialogOcc] = useState<WorkerOccurrence | null>(null);
  const [photoPromptOccId, setPhotoPromptOccId] = useState<string | null>(null);

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
  const [acceptPaymentOcc, setAcceptPaymentOcc] = useState<WorkerOccurrence | null>(null);

  const [expenseDialogOccId, setExpenseDialogOccId] = useState<string | null>(null);

  // Comments
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
      if (next.has(occId)) {
        next.delete(occId);
      } else {
        next.add(occId);
        if (!commentsCache[occId]) void loadComments(occId);
      }
      return next;
    });
  }

  async function postComment(occId: string) {
    const body = (commentDraft[occId] ?? "").trim();
    if (!body) return;
    if (isOffline) {
      const occ = items.find((o) => o.id === occId);
      await enqueueAction("POST_COMMENT", occId, queueLabel(occ, "Comment", `"${body.slice(0, 50)}${body.length > 50 ? "…" : ""}"`), { body });
      setCommentDraft((prev) => ({ ...prev, [occId]: "" }));
      setItems((prev) => prev.map((o) => o.id === occId ? { ...o, _count: { ...o._count, photos: o._count?.photos ?? 0, comments: (o._count?.comments ?? 0) + 1 } } : o));
      publishInlineMessage({ type: "INFO", text: "Comment queued for sync." });
      return;
    }
    setCommentBusy(true);
    try {
      await apiPost(`/api/occurrences/${occId}/comments`, { body });
      setCommentDraft((prev) => ({ ...prev, [occId]: "" }));
      await loadComments(occId);
      // Update the count in items
      setItems((prev) => prev.map((o) => o.id === occId ? { ...o, _count: { ...o._count, photos: o._count?.photos ?? 0, comments: (o._count?.comments ?? 0) + 1 } } : o));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to post comment.", err) });
    } finally {
      setCommentBusy(false);
    }
  }

  async function editComment(commentId: string, occId: string, body: string) {
    setCommentBusy(true);
    try {
      await apiPatch(`/api/occurrences/comments/${commentId}`, { body });
      setCommentEditing(null);
      await loadComments(occId);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to edit comment.", err) });
    } finally {
      setCommentBusy(false);
    }
  }

  async function deleteComment(commentId: string, occId: string) {
    setCommentBusy(true);
    try {
      await apiDelete(`/api/occurrences/comments/${commentId}`);
      await loadComments(occId);
      setItems((prev) => prev.map((o) => o.id === occId ? { ...o, _count: { ...o._count, photos: o._count?.photos ?? 0, comments: Math.max(0, (o._count?.comments ?? 1) - 1) } } : o));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete comment.", err) });
    } finally {
      setCommentBusy(false);
    }
  }

  // Prompt to create occurrence after accepting estimate
  const [promptOccJobId, setPromptOccJobId] = useState<string | null>(null);
  const [promptOccDefaults, setPromptOccDefaults] = useState<{ notes?: string | null; price?: number | null; estimatedMinutes?: number | null }>({});

  async function deleteExpense(expenseId: string) {
    try {
      await apiDelete(`/api/expenses/${expenseId}`);
      publishInlineMessage({ type: "SUCCESS", text: "Expense deleted." });
      void load(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to delete expense.", err),
      });
    }
  }

  // Workers limited to 2-month date range — clamp and return adjusted dates
  function clampWorkerDates(from: string, to: string): { from: string; to: string; clamped: boolean } {
    if (forAdmin) return { from, to, clamped: false };
    const maxMs = 62 * 86400000; // ~2 months
    if (from && to) {
      const fromDate = new Date(from + "T00:00:00");
      const toDate = new Date(to + "T00:00:00");
      if (toDate.getTime() - fromDate.getTime() > maxMs) {
        return { from: bizDateKey(new Date(toDate.getTime() - maxMs)), to, clamped: true };
      }
    } else if (!from && to) {
      return { from: bizDateKey(new Date(new Date(to + "T00:00:00").getTime() - maxMs)), to, clamped: true };
    } else if (from && !to) {
      return { from, to: bizDateKey(new Date(new Date(from + "T00:00:00").getTime() + maxMs)), clamped: true };
    }
    return { from, to, clamped: false };
  }

  async function load(displayLoading = true, overrideDates?: { from?: string; to?: string }, keepOccId?: string) {
    setLoading(displayLoading);
    try {
      const qs = new URLSearchParams();
      const rawFrom = overrideDates?.from ?? dateFrom;
      const rawTo = overrideDates?.to ?? dateTo;
      const { from: qFrom, to: qTo } = clampWorkerDates(rawFrom, rawTo);

      if (qFrom) qs.set("from", qFrom);
      if (qTo) qs.set("to", qTo);
      if (keepOccId) qs.set("includeOccId", keepOccId);
      const url = `/api/occurrences${qs.toString() ? `?${qs}` : ""}`;
      let list = await apiGet<WorkerOccurrence[]>(url);
      if (!Array.isArray(list)) list = [];
      if (viewAsUserIds?.length) {
        // Admin "View as" — show ONLY jobs the selected worker(s) are assigned to
        const idSet = new Set(viewAsUserIds);
        list = list.filter((occ) => {
          if (occ.workflow === "ANNOUNCEMENT") return true;
          const assignees = occ.assignees ?? [];
          return assignees.some((a) => idSet.has(a.userId));
        });
      } else if (!forAdmin && myId) {
        if (isTrainee) {
          // Trainees only see jobs they are assigned to (no unassigned/claimable)
          list = list.filter((occ) => {
            const assignees = occ.assignees ?? [];
            return assignees.some((a) => a.userId === myId);
          });
        } else {
          // Worker view — show only my jobs + unassigned (claimable) + announcements + highlighted occurrence
          // Events and Followups are team-scoped: only visible to assignees
          list = list.filter((occ) => {
            if (keepOccId && occ.id === keepOccId) return true;
            // Announcements are universally visible
            if (occ.workflow === "ANNOUNCEMENT") return true;
            const assignees = occ.assignees ?? [];
            // Events and Followups: only show if user is an assignee
            if (occ.workflow === "EVENT" || occ.workflow === "FOLLOWUP") {
              return assignees.some((a) => a.userId === myId);
            }
            return assignees.length === 0 || assignees.some((a) => a.userId === myId);
          });
        }
      }
      setItems(list);
      window.dispatchEvent(new CustomEvent("seedlings3:jobs-changed"));
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
    // Fetch high-value threshold setting
    apiGet<any[]>("/api/settings")
      .then((list: any) => {
        if (!Array.isArray(list)) return;
        const s = list.find((r: any) => r.key === "HIGH_VALUE_JOB_THRESHOLD");
        if (s?.value) setHighValueThreshold(Number(s.value));
        const c = list.find((r: any) => r.key === "CONTRACTOR_PLATFORM_FEE_PERCENT");
        if (c?.value) setCommissionPercent(Number(c.value));
        const m = list.find((r: any) => r.key === "EMPLOYEE_BUSINESS_MARGIN_PERCENT");
        if (m?.value) setMarginPercent(Number(m.value));
      })
      .catch(() => {});
  }, [dateFrom, dateTo, viewAsUserIds, isTrainee]);

  // Re-fetch data after offline queue syncs
  const loadRef = useRef(load);
  const loadCommentsRef = useRef(loadComments);
  const commentsOpenForRef = useRef(commentsOpenFor);
  loadRef.current = load;
  loadCommentsRef.current = loadComments;
  commentsOpenForRef.current = commentsOpenFor;

  useEffect(() => {
    const handler = () => {
      void loadRef.current(false);
      for (const occId of commentsOpenForRef.current) {
        void loadCommentsRef.current(occId);
      }
    };
    window.addEventListener("offlineQueue:processed", handler);
    return () => window.removeEventListener("offlineQueue:processed", handler);
  }, []);

  // Check for Begin Work Day workflow date override
  useEffect(() => {
    try {
      const d = localStorage.getItem("seedlings_beginWorkday_jobsDate");
      if (d) {
        localStorage.removeItem("seedlings_beginWorkday_jobsDate");
        setDatePreset("today");
        setDateFrom(d);
        setDateTo(d);
      }
    } catch {}
  }, []);

  // Check for unclaimed badge navigation
  const applyUnclaimed = useCallback(() => {
    setQ("");
    setHighlightOccId(null);
    setFilterJobId(null);
    setKind(["ALL"]);
    setTypeFilter(["ALL"]);
    setVipOnly(false);
    setLikedOnly(false);
    setShowCanceled(false);
    setShowArchived(false);
    setOverdueActive(false);
    setStatusFilter(["UNCLAIMED"]);
    const d = computeDatesFromPreset("overdueAndNext3");
    setDatePreset(null);
    setDateFrom(d.from);
    setDateTo(d.to);
    void load(true, { from: d.from, to: d.to });
  }, []);

  useEffect(() => {
    try {
      const flag = localStorage.getItem("seedlings_adminJobs_showUnclaimed");
      if (flag) {
        localStorage.removeItem("seedlings_adminJobs_showUnclaimed");
        applyUnclaimed();
      }
    } catch {}
    const onShowUnclaimed = () => applyUnclaimed();
    window.addEventListener("adminJobs:showUnclaimed", onShowUnclaimed);
    return () => window.removeEventListener("adminJobs:showUnclaimed", onShowUnclaimed);
  }, [applyUnclaimed]);

  // Show announcements (from header badge click)
  const applyAnnouncements = useCallback(() => {
    setQ("");
    setHighlightOccId(null);
    setFilterJobId(null);
    setKind(["ALL"]);
    setStatusFilter(["ALL"]);
    setOverdueActive(false);
    setVipOnly(false);
    setLikedOnly(false);
    setShowCanceled(false);
    setShowArchived(false);
    setTypeFilter(["ANNOUNCEMENT"]);
    const todayStr = localDate(new Date());
    setDatePreset(null);
    setDateFrom(todayStr);
    setDateTo(todayStr);
    void load(true, { from: todayStr, to: todayStr });
  }, []);

  useEffect(() => {
    try {
      const flag = localStorage.getItem("seedlings_adminJobs_showAnnouncements");
      if (flag) {
        localStorage.removeItem("seedlings_adminJobs_showAnnouncements");
        applyAnnouncements();
      }
    } catch {}
    const onShow = () => applyAnnouncements();
    window.addEventListener("adminJobs:showAnnouncements", onShow);
    return () => window.removeEventListener("adminJobs:showAnnouncements", onShow);
  }, [applyAnnouncements]);

  // Deep-link: highlight a specific occurrence (from calendar feed URL or share link)
  useEffect(() => {
    (window as any).__jobsTabReady = true;
    const handler = (e: Event) => {
      const occId = (e as CustomEvent<{ occId: string }>).detail?.occId;
      if (!occId) return;
      setHighlightOccId(occId);
      setExpandedCards(new Set([occId]));
      setFilterJobId(null);
      setQ("");
      setOverdueActive(false);
      setDatePreset(null);
      // Use a very wide date range to ensure we find the occurrence regardless of when it was scheduled
      // For admin, no clamping. For worker, clampWorkerDates will cap at ~2 months so we also pass keepOccId.
      const from = new Date(); from.setFullYear(from.getFullYear() - 1);
      const to = new Date(); to.setFullYear(to.getFullYear() + 1);
      const fromStr = bizDateKey(from);
      const toStr = bizDateKey(to);
      setDateFrom(fromStr);
      setDateTo(toStr);
      void load(true, { from: fromStr, to: toStr }, occId);
    };
    window.addEventListener("jobsTab:highlightOcc", handler);
    return () => {
      (window as any).__jobsTabReady = false;
      window.removeEventListener("jobsTab:highlightOcc", handler);
    };
  }, []);

  async function refreshOverdueCount() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      let list = await apiGet<WorkerOccurrence[]>(
        `/api/occurrences?to=${localDate(yesterday)}`
      );
      if (!Array.isArray(list)) list = [];

      // Apply the same visibility filtering as load()
      if (viewAsUserIds?.length) {
        const idSet = new Set(viewAsUserIds);
        list = list.filter((occ) => {
          const assignees = occ.assignees ?? [];
          if (isTrainee) return assignees.some((a) => idSet.has(a.userId));
          return assignees.length === 0 || assignees.some((a) => idSet.has(a.userId));
        });
      } else if (!forAdmin && myId) {
        if (isTrainee) {
          list = list.filter((occ) => (occ.assignees ?? []).some((a) => a.userId === myId));
        } else {
          list = list.filter((occ) => {
            const assignees = occ.assignees ?? [];
            return assignees.length === 0 || assignees.some((a) => a.userId === myId);
          });
        }
      }

      const overdueExcludeCount = new Set(["COMPLETED", "CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"]);
      const todayKey = bizDateKey(new Date());
      const count = list.filter((o) => {
        if (o.workflow === "ANNOUNCEMENT") return false;
        return o.startAt && !overdueExcludeCount.has(o.status as string) && bizDateKey(o.startAt) < todayKey;
      }).length;
      setOverdueCount(count);
    } catch {
      // silently ignore
    }
  }

  useEffect(() => {
    void refreshOverdueCount();
  }, [items]);

  async function claim(occurrenceId: string) {
    // All workers must accept payout terms before claiming
    if (!agreementDialogOpen) {
      setPendingClaimOccId(occurrenceId);
      setAgreementDialogOpen(true);
      return;
    }

    try {
      await apiPost(`/api/occurrences/${occurrenceId}/claim`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Job claimed." });
      await load(false);
    } catch (err: any) {
      const code = err?.code ?? "";
      if (code === "CONTRACTOR_AGREEMENT_REQUIRED") {
        setPendingClaimOccId(occurrenceId);
        setAgreementDialogOpen(true);
      } else if (code === "INSURANCE_REQUIRED") {
        publishInlineMessage({
          type: "ERROR",
          text: "This is a high-value job that requires valid insurance. Upload your insurance certificate to claim it.",
        });
        setInsuranceDialogOpen(true);
      } else if (code === "WORKER_TYPE_REQUIRED") {
        publishInlineMessage({
          type: "ERROR",
          text: "Your worker type hasn't been assigned yet. Some jobs are restricted until assigned by your administrator.",
        });
      } else {
        publishInlineMessage({
          type: "ERROR",
          text: getErrorMessage("Claim failed.", err),
        });
      }
    }
  }

  async function unclaim(occurrenceId: string) {
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/unclaim`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Job unclaimed." });
      await load(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Unclaim failed.", err),
      });
    }
  }

  async function completeEstimate(occurrenceId: string, comments: string) {
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/submit-proposal`, {
        proposalNotes: comments || undefined,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Estimate completed." });
      await load(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Complete estimate failed.", err) });
    }
  }

  async function updateStatus(occ: WorkerOccurrence, action: "start" | "complete", notes?: string, recordLocation = true) {
    if (isOffline) {
      const label = queueLabel(occ, action === "start" ? "Start job" : "Complete job");
      const body: Record<string, unknown> = {};
      if (notes) body.notes = notes;
      body.lat = null;
      body.lng = null;
      const actionType = action === "start" ? "START_JOB" : "COMPLETE_JOB";
      await enqueueAction(actionType as any, occ.id, label, body);
      if (action === "start") {
        setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, status: "IN_PROGRESS" as any, startedAt: new Date().toISOString() } : o));
        publishInlineMessage({ type: "INFO", text: "Job started (queued for sync)." });
      } else {
        setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, status: "COMPLETED" as any, completedAt: new Date().toISOString() } : o));
        publishInlineMessage({ type: "INFO", text: "Job completed (queued for sync)." });
      }
      return;
    }
    try {
      const loc = recordLocation ? await getLocation() : null;
      const body: Record<string, unknown> = {};
      if (notes) body.notes = notes;
      if (loc) { body.lat = loc.lat; body.lng = loc.lng; }
      await apiPost(`/api/occurrences/${occ.id}/${action}`, body);
      await load(false);

      publishInlineMessage({
        type: "SUCCESS",
        text: action === "start" ? "Job started." : action === "complete" ? "Job completed." : "Job marked as pending payment.",
      });
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Action failed.", err),
      });
    }
  }

  const filtered = useMemo(() => {
    let rows = items;
    // Enforce date range — items outside the range should not appear in the feed
    // Exception: pinned and liked items (they have their own sections / filter)
    if (dateFrom || dateTo) {
      rows = rows.filter((occ) => {
        // Pinned and liked items bypass date filter (shown in dedicated sections)
        if (pinnedIds.has(occ.id) || likedIds.has(occ.id)) return true;
        const day = occ.startAt ? bizDateKey(occ.startAt) : null;
        if (!day) return true; // no date — include
        if (dateFrom && day < dateFrom) return false;
        if (dateTo && day > dateTo) return false;
        return true;
      });
    }
    // Trainees should not see tentative jobs
    if (isTrainee) rows = rows.filter((occ) => !occ.isTentative);
    if (kind[0] !== "ALL") rows = rows.filter((occ) => occ.kind === kind[0]);
    const tf = typeFilter[0];
    if (tf === "ONE_OFF") rows = rows.filter((occ) => occ.isOneOff);
    else if (tf === "ESTIMATE") rows = rows.filter((occ) => occ.isEstimate);
    else if (tf === "TENTATIVE") rows = rows.filter((occ) => occ.isTentative);
    else if (tf === "TASK") rows = rows.filter((occ) => occ.workflow === "TASK");
    else if (tf === "REMINDER") rows = rows.filter((occ) => occ.workflow === "REMINDER");
    else if (tf === "EVENT") rows = rows.filter((occ) => occ.workflow === "EVENT");
    else if (tf === "FOLLOWUP") rows = rows.filter((occ) => occ.workflow === "FOLLOWUP");
    else if (tf === "ANNOUNCEMENT") rows = rows.filter((occ) => occ.workflow === "ANNOUNCEMENT");
    const sf = statusFilter[0];
    if (sf !== "ALL") {
      rows = rows.filter((occ) => {
        const hasAssignees = (occ.assignees ?? []).length > 0;
        if (sf === "UNCLAIMED") return !hasAssignees;
        return occ.status === sf;
      });
    } else {
      if (!showCanceled) rows = rows.filter((occ) => occ.status !== "CANCELED");
      if (!showArchived) rows = rows.filter((occ) => occ.status !== "ARCHIVED");
    }
    if (overdueActive) {
      const overdueExclude = new Set(["COMPLETED", "CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"]);
      const todayKey = bizDateKey(new Date());
      rows = rows.filter((occ) =>
        occ.workflow !== "ANNOUNCEMENT" &&
        !overdueExclude.has(occ.status) &&
        occ.startAt && bizDateKey(occ.startAt) < todayKey
      );
    }
    if (vipOnly) {
      rows = rows.filter((occ) => !!(occ.job?.property?.client as any)?.isVip);
    }
    if (likedOnly) {
      rows = rows.filter((occ) => likedIds.has(occ.id));
    }
    // If navigated to a specific occurrence, show only that one (bypass all filters)
    if (highlightOccId) {
      // Search in items first, then in all loaded data (the highlight may have been filtered out by worker visibility)
      const exact = items.find((occ) => occ.id === highlightOccId);
      if (exact) return [exact];
      // Not found — the occurrence might not be in the current date range or visibility filter
      // Return empty to trigger a "no results" state rather than showing unrelated items
      return [];
    }
    // If filtering by a linked job
    if (filterJobId) {
      rows = rows.filter((occ) => occ.jobId === filterJobId);
    }
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((occ) =>
        [
          occ.title,
          occ.job?.property?.displayName,
          occ.job?.property?.street1,
          occ.job?.property?.city,
          occ.job?.property?.state,
          occ.job?.property?.client?.displayName,
          (occ.job?.property as any)?.pointOfContact?.firstName,
          (occ.job?.property as any)?.pointOfContact?.lastName,
          (occ.job?.property as any)?.pointOfContact?.nickname,
          occ.status,
          occ.notes,
          occ.contactName ?? "",
          occ.estimateAddress ?? "",
          ...(occ.assignees ?? []).map((a) => a.user?.displayName ?? a.user?.email),
        ]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(qlc))
      );
    }
    rows.sort((a, b) => {
      // Pinned items first (worker view only)
      if (isWorkerView) {
        const aPin = pinnedIds.has(a.id) ? 0 : 1;
        const bPin = pinnedIds.has(b.id) ? 0 : 1;
        if (aPin !== bPin) return aPin - bPin;
      }
      const da = (a._isReminderGhost && a._ghostDate) ? a._ghostDate : (a.startAt ?? "");
      const db = (b._isReminderGhost && b._ghostDate) ? b._ghostDate : (b.startAt ?? "");
      return da < db ? -1 : da > db ? 1 : 0;
    });
    return rows;
  }, [items, q, kind, statusFilter, typeFilter, overdueActive, vipOnly, likedOnly, likedIds, isTrainee, highlightOccId, filterJobId, pinnedIds, isWorkerView, dateFrom, dateTo, showCanceled, showArchived]);

  const dayGroups = useMemo(() => {
    const groups: { key: string; label: string; items: WorkerOccurrence[] }[] = [];
    const todayKey = bizDateKey(new Date());

    const dayLabel = (dateKey: string) => {
      // dateKey is YYYY-MM-DD in ET
      const d = new Date(dateKey + "T12:00:00Z"); // noon UTC avoids day-boundary issues
      const todayD = new Date(todayKey + "T12:00:00Z");
      const diff = Math.round((d.getTime() - todayD.getTime()) / 86400000);
      if (diff === 0) return "Today";
      if (diff === -1) return "Yesterday";
      if (diff === 1) return "Tomorrow";
      const dayName = fmtDateWeekday(d);
      if (diff >= 2 && diff <= 6) return dayName;
      if (diff <= -2 && diff >= -6) return `Last ${dayName}`;
      return fmtDateWeekday(d, { year: d.getFullYear() !== todayD.getFullYear() });
    };

    // Separate pinned and reminder-due items into their own groups (worker view only)
    const pinnedGroup: WorkerOccurrence[] = [];
    const reminderDueGroup: WorkerOccurrence[] = [];
    const pinnedIds_ = new Set(pinnedIds);
    const reminderDueIds = new Set<string>();
    const rest: WorkerOccurrence[] = [];

    if (isWorkerView) {
      for (const occ of filtered) {
        const isPinned = pinnedIds_.has(occ.id);
        const isOverdueStandaloneReminder = occ.workflow === "REMINDER" && occ.status === "SCHEDULED" && occ.startAt && bizDateKey(occ.startAt) <= todayKey;
        const hasReminderDue = (occ.reminder && bizDateKey(occ.reminder.remindAt) <= todayKey) || isOverdueStandaloneReminder;
        const hasReminder = !!occ.reminder;
        if (isPinned) {
          pinnedGroup.push(occ);
          // Add a ghost in the regular feed at its natural date — only if within date range
          const occDay = occ.startAt ? bizDateKey(occ.startAt) : null;
          if (occDay && (!dateFrom || occDay >= dateFrom) && (!dateTo || occDay <= dateTo)) {
            rest.push({ ...occ, _isPinnedGhost: true } as any);
          }
        } else if (hasReminderDue) {
          reminderDueGroup.push(occ);
          reminderDueIds.add(occ.id);
        } else {
          rest.push(occ);
          // Future reminders — add a ghost at the reminder date if it's a different ET day than the occurrence AND within date range
          if (hasReminder) {
            const remKey = bizDateKey(occ.reminder!.remindAt);
            const occKey = occ.startAt ? bizDateKey(occ.startAt) : "";
            if (remKey !== occKey && (!dateFrom || remKey >= dateFrom) && (!dateTo || remKey <= dateTo)) {
              rest.push({ ...occ, _isReminderGhost: true, _ghostDate: remKey } as any);
            }
          }
        }
      }
    } else {
      rest.push(...filtered);
    }

    if (pinnedGroup.length > 0) {
      groups.push({ key: "pinned", label: `Pinned (${pinnedGroup.length})`, items: pinnedGroup });
    }
    if (reminderDueGroup.length > 0) {
      groups.push({ key: "reminders-due", label: `Reminders Due (${reminderDueGroup.length})`, items: reminderDueGroup });
    }

    // Compute date key for each item, then sort by it to prevent duplicate day groups
    function occDateKey(occ: any): string {
      if ((occ._isReminderGhost || occ._isPinnedGhost) && occ._ghostDate) {
        return typeof occ._ghostDate === "string" && occ._ghostDate.length === 10
          ? occ._ghostDate
          : bizDateKey(occ._ghostDate);
      }
      return occ.startAt ? bizDateKey(occ.startAt) : "no-date";
    }

    rest.sort((a, b) => {
      const da = occDateKey(a);
      const db = occDateKey(b);
      return da < db ? -1 : da > db ? 1 : 0;
    });

    // Group into day sections using a Map to guarantee no duplicates
    const dayMap = new Map<string, WorkerOccurrence[]>();
    const dayOrder: string[] = [];
    for (const occ of rest) {
      const key = occDateKey(occ);
      if (!dayMap.has(key)) {
        dayMap.set(key, []);
        dayOrder.push(key);
      }
      dayMap.get(key)!.push(occ);
    }
    for (const key of dayOrder) {
      const items = dayMap.get(key)!;
      // Sort within day: high priority reminders first, then by startAt
      items.sort((a, b) => {
        const aHigh = a.workflow === "REMINDER" && (a as any).isHighPriority ? 0 : 1;
        const bHigh = b.workflow === "REMINDER" && (b as any).isHighPriority ? 0 : 1;
        if (aHigh !== bHigh) return aHigh - bHigh;
        return (a.startAt ?? "").localeCompare(b.startAt ?? "");
      });
      groups.push({
        key,
        label: key === "no-date" ? "Unscheduled" : dayLabel(key),
        items,
      });
    }

    // Sort within each day group: ghosts first, then reminders, then regular
    const cardSortOrder = (occ: any): number => {
      if (occ._isPinnedGhost) return 0;
      if (occ._isReminderGhost) return 1;
      if (occ.reminder) return 2;
      if (occ.workflow === "REMINDER") return 3;
      if (occ.workflow === "TASK") return 4;
      if (occ.workflow === "ESTIMATE") return 5;
      return 6;
    };
    for (const group of groups) {
      if (group.key === "pinned" || group.key === "reminders-due") continue;
      group.items.sort((a, b) => {
        const oa = cardSortOrder(a);
        const ob = cardSortOrder(b);
        if (oa !== ob) return oa - ob;
        // Within same type, sort by startAt
        const da = a.startAt ?? "";
        const db = b.startAt ?? "";
        return da < db ? -1 : da > db ? 1 : 0;
      });
    }
    return groups;
  }, [filtered, pinnedIds, isWorkerView]);

  if (!isAvail) return <UnavailableNotice />;

  return (
    <Box w="full">
      <HStack mb={2} gap={2} wrap="nowrap">
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-100)" }}>
          <RefreshCw size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          px="2"
          flexShrink={0}
          onClick={() => { setCompact((v) => !v); setExpandedCards(new Set()); }}
          css={{
            background: !compact ? "var(--chakra-colors-gray-200)" : "var(--chakra-colors-gray-100)",
            color: !compact ? "var(--chakra-colors-gray-700)" : undefined,
          }}
          title={compact ? "Expand all cards" : "Collapse all cards"}
        >
          <Maximize2 size={14} />
        </Button>
        <SearchWithClear
          value={q}
          onChange={(v) => setQ(v)}
          inputId="jobs-search"
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
        <Box position="relative" flexShrink={0} ref={createMenuRef}>
          <Button
            size="sm"
            variant="solid"
            bg="black"
            color="white"
            px="3"
            disabled={isOffline}
            title={isOffline ? "Requires internet" : undefined}
            onClick={() => {
              setCreateMenuOpen((v) => !v);
            }}
          >
            +
          </Button>
          {createMenuOpen && (
            <VStack
              position="absolute"
              top="100%"
              right="0"
              mt={1}
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              rounded="md"
              shadow="lg"
              zIndex={10}
              p={1}
              gap={0}
              minW="150px"
            >
              <Button
                size="sm"
                variant="ghost"
                w="full"
                justifyContent="start"
                onClick={() => { setCreateMenuOpen(false); setEditingTask(null); setTaskDialogOpen(true); }}
              >
                Task
              </Button>
              <Button
                size="sm"
                variant="ghost"
                w="full"
                justifyContent="start"
                onClick={() => { setCreateMenuOpen(false); setEditingReminder(null); setStandaloneReminderDialogOpen(true); }}
              >
                Reminder
              </Button>
              {(isAdmin || isSuper) && (
                <Button
                  size="sm"
                  variant="ghost"
                  w="full"
                  justifyContent="start"
                  onClick={() => { setCreateMenuOpen(false); setEditingEvent(null); setEventDialogOpen(true); }}
                >
                  Event
                </Button>
              )}
              {(isAdmin || isSuper) && (
                <Button
                  size="sm"
                  variant="ghost"
                  w="full"
                  justifyContent="start"
                  onClick={() => { setCreateMenuOpen(false); setEditingFollowup(null); setFollowupDialogOpen(true); }}
                >
                  Followup
                </Button>
              )}
              {(isAdmin || isSuper) && (
                <Button
                  size="sm"
                  variant="ghost"
                  w="full"
                  justifyContent="start"
                  onClick={() => { setCreateMenuOpen(false); setEditingAnnouncement(null); setAnnouncementDialogOpen(true); }}
                >
                  Announcement
                </Button>
              )}
              {(isAdmin || isSuper) && (
                <Button
                  size="sm"
                  variant="ghost"
                  w="full"
                  justifyContent="start"
                  onClick={() => { setCreateMenuOpen(false); setEditingLightEstimate(null); setLightEstDialogOpen(true); }}
                >
                  Estimate
                </Button>
              )}
            </VStack>
          )}
        </Box>
      </HStack>
      {!filtersOpen && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1" align="center">
          {datePreset && (
            <Badge size="sm" colorPalette="green" variant="subtle">
              {PRESET_LABELS[datePreset] ?? datePreset}
            </Badge>
          )}
          {!datePreset && (dateFrom || dateTo) && (
            <Badge size="sm" colorPalette={dateFrom === dateTo && dateFrom === bizDateKey(new Date()) ? "green" : "gray"} variant="subtle">
              {dateFrom === dateTo && dateFrom === bizDateKey(new Date()) ? "Today" : "Custom dates"}
            </Badge>
          )}
          {headerBelowSlot}
          {overdueActive && (
            <Badge size="sm" colorPalette="red" variant="subtle">Overdue</Badge>
          )}
          {kind[0] !== "ALL" && (
            <Badge size="sm" colorPalette="blue" variant="subtle">
              {kindItems.find((i) => i.value === kind[0])?.label}
            </Badge>
          )}
          {statusFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette={statusFilter[0] === "UNCLAIMED" ? "yellow" : "purple"} variant="subtle">
              {statusItems.find((i) => i.value === statusFilter[0])?.label}
            </Badge>
          )}
          {typeFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette={
              typeFilter[0] === "ANNOUNCEMENT" ? "purple"
              : typeFilter[0] === "FOLLOWUP" ? "red"
              : typeFilter[0] === "EVENT" ? "yellow"
              : typeFilter[0] === "REMINDER" ? "purple"
              : typeFilter[0] === "TASK" ? "blue"
              : "orange"
            } variant="subtle">
              {typeItems.find((i) => i.value === typeFilter[0])?.label}
            </Badge>
          )}
          {vipOnly && <Badge size="sm" colorPalette="yellow" variant="subtle">VIP</Badge>}
          {likedOnly && <Badge size="sm" colorPalette="red" variant="subtle">Liked</Badge>}
          {showCanceled && <Badge size="sm" colorPalette="red" variant="subtle">+ Canceled</Badge>}
          {showArchived && <Badge size="sm" colorPalette="gray" variant="solid">+ Archived</Badge>}
          {highlightOccId && <Badge size="sm" colorPalette="teal" variant="subtle">Filtered to 1 occurrence</Badge>}
          {!highlightOccId && filterJobId && <Badge size="sm" colorPalette="teal" variant="subtle">Filtered to job</Badge>}
          {q && <Badge size="sm" colorPalette="gray" variant="subtle">"{q}"</Badge>}
          {!(kind[0] === "ALL" && statusFilter[0] === "ALL" && typeFilter[0] === "ALL" && !overdueActive && !vipOnly && !likedOnly && !showCanceled && !showArchived && !highlightOccId && !filterJobId && !q && !viewAsUserIds?.length && datePreset) && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setKind(["ALL"]);
                setStatusFilter(["ALL"]);
                setTypeFilter(["ALL"]);
                setOverdueActive(false);
                setVipOnly(false);
                setLikedOnly(false);
                setShowCanceled(false);
                setShowArchived(false);
                setQ("");
                setHighlightOccId(null);
                setFilterJobId(null);
                const defaultPreset = forAdmin ? "thisWeek" : "now";
                const d = computeDatesFromPreset(defaultPreset);
                setDatePreset(defaultPreset);
                setDateFrom(d.from);
                setDateTo(d.to);
                void load(true, { from: d.from, to: d.to });
                onClearAll?.();
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      {filtersOpen && <>
      {headerSlot && (
        <HStack mb={2} gap={2} wrap="nowrap">
          {headerSlot}
        </HStack>
      )}
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
          collection={statusCollection}
          value={statusFilter}
          onValueChange={(e) => setStatusFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: statusFilter[0] !== "ALL" ? "var(--chakra-colors-purple-200)" : "var(--chakra-colors-purple-100)", border: statusFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-purple-400)" : "1px solid transparent", borderRadius: "6px" }}>
              <Filter size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {statusItems.map((it) => (
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
        {isWorkerView && (
          <Button
            size="sm"
            variant={likedOnly ? "solid" : "outline"}
            px="2"
            onClick={() => setLikedOnly(!likedOnly)}
            css={likedOnly ? {
              background: "var(--chakra-colors-red-100)",
              color: "var(--chakra-colors-red-600)",
              border: "1px solid var(--chakra-colors-red-400)",
              "&:hover": { background: "var(--chakra-colors-red-200)" },
            } : undefined}
            title="Show liked only"
          >
            <Heart size={14} fill={likedOnly ? "currentColor" : "none"} />
          </Button>
        )}
        {forAdmin && (
          <Button
            size="sm"
            variant={showCanceled ? "solid" : "outline"}
            px="2"
            onClick={() => setShowCanceled(!showCanceled)}
            css={showCanceled ? {
              background: "var(--chakra-colors-red-100)",
              color: "var(--chakra-colors-red-700)",
              border: "1px solid var(--chakra-colors-red-300)",
              "&:hover": { background: "var(--chakra-colors-red-200)" },
            } : undefined}
            title={showCanceled ? "Hide canceled" : "Show canceled"}
          >
            <Ban size={14} />
          </Button>
        )}
        {forAdmin && (
          <Button
            size="sm"
            variant={showArchived ? "solid" : "outline"}
            px="2"
            onClick={() => setShowArchived(!showArchived)}
            css={showArchived ? {
              background: "var(--chakra-colors-gray-200)",
              color: "var(--chakra-colors-gray-700)",
              border: "1px solid var(--chakra-colors-gray-400)",
              "&:hover": { background: "var(--chakra-colors-gray-300)" },
            } : undefined}
            title={showArchived ? "Hide archived" : "Show archived"}
          >
            <Archive size={14} />
          </Button>
        )}
        <Box flex="1" />
        {isWorkerView && (
          <Button
            size="sm"
            variant="ghost"
            px="2"
            title="Subscribe to calendar feed"
            onClick={() => {
              setCalFeedStep("confirm");
              setCalFeedUrl(null);
            }}
          >
            <Calendar size={14} />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowInfoDialog(true)}
          px="2"
          title="How jobs work"
        >
          <Info size={14} />
        </Button>
      </HStack>

      <HStack mb={2} gap={2} align="center">
        <DateInput
          value={dateFrom}
          onChange={(val) => {
            let newTo = dateTo;
            if (newTo && val && val > newTo) newTo = val;
            const { from, to, clamped } = clampWorkerDates(val, newTo);
            setDateFrom(from);
            setDateTo(to);
            setDatePreset(null);
            setOverdueActive(false);
            if (clamped) publishInlineMessage({ type: "WARNING", text: "Date range limited to 2 months." });
          }}
        />
        <Text fontSize="sm">–</Text>
        <DateInput
          value={dateTo}
          onChange={(val) => {
            let newFrom = dateFrom;
            if (newFrom && val && val < newFrom) newFrom = val;
            const { from, to, clamped } = clampWorkerDates(newFrom, val);
            setDateFrom(from);
            setDateTo(to);
            setDatePreset(null);
            setOverdueActive(false);
            if (clamped) publishInlineMessage({ type: "WARNING", text: "Date range limited to 2 months." });
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
              setDatePreset(presetBeforeOverdueRef.current ?? (forAdmin ? "thisWeek" : "now"));
            } else {
              presetBeforeOverdueRef.current = datePreset;
              const yesterday = new Date();
              yesterday.setDate(yesterday.getDate() - 1);
              setDatePreset(null);
              setDateFrom("");
              setDateTo(localDate(yesterday));
              setStatusFilter(["ALL"]);
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
          {overdueCount > 0 && (
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
      {(kind[0] !== "ALL" || statusFilter[0] !== "ALL" || typeFilter[0] !== "ALL" || overdueActive || vipOnly || likedOnly || showCanceled || showArchived || highlightOccId || filterJobId || datePreset || dateFrom || dateTo) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          {datePreset && (
            <Badge size="sm" colorPalette="green" variant="subtle">
              {PRESET_LABELS[datePreset] ?? datePreset}
            </Badge>
          )}
          {!datePreset && (dateFrom || dateTo) && (
            <Badge size="sm" colorPalette={dateFrom === dateTo && dateFrom === bizDateKey(new Date()) ? "green" : "gray"} variant="subtle">
              {dateFrom === dateTo && dateFrom === bizDateKey(new Date()) ? "Today" : "Custom dates"}
            </Badge>
          )}
          {headerBelowSlot}
          {overdueActive && (
            <Badge size="sm" colorPalette="red" variant="subtle">
              Overdue
            </Badge>
          )}
          {kind[0] !== "ALL" && (
            <Badge size="sm" colorPalette="blue" variant="subtle">
              {kindItems.find((i) => i.value === kind[0])?.label}
            </Badge>
          )}
          {statusFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette={statusFilter[0] === "UNCLAIMED" ? "yellow" : "purple"} variant="subtle">
              {statusItems.find((i) => i.value === statusFilter[0])?.label}
            </Badge>
          )}
          {typeFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette={
              typeFilter[0] === "ANNOUNCEMENT" ? "purple"
              : typeFilter[0] === "FOLLOWUP" ? "red"
              : typeFilter[0] === "EVENT" ? "yellow"
              : typeFilter[0] === "REMINDER" ? "purple"
              : typeFilter[0] === "TASK" ? "blue"
              : "orange"
            } variant="subtle">
              {typeItems.find((i) => i.value === typeFilter[0])?.label}
            </Badge>
          )}
          {vipOnly && (
            <Badge size="sm" colorPalette="yellow" variant="subtle">
              VIP
            </Badge>
          )}
          {likedOnly && (
            <Badge size="sm" colorPalette="red" variant="subtle">
              Liked
            </Badge>
          )}
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
          {highlightOccId && (
            <Badge size="sm" colorPalette="teal" variant="subtle">
              Filtered to 1 occurrence
            </Badge>
          )}
          {!highlightOccId && filterJobId && (
            <Badge size="sm" colorPalette="teal" variant="subtle">
              Filtered to job
            </Badge>
          )}
          {!(kind[0] === "ALL" && statusFilter[0] === "ALL" && typeFilter[0] === "ALL" && !overdueActive && !vipOnly && !likedOnly && !showCanceled && !showArchived && !highlightOccId && !filterJobId && !q && !viewAsUserIds?.length && datePreset) && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setKind(["ALL"]);
                setStatusFilter(["ALL"]);
                setTypeFilter(["ALL"]);
                setOverdueActive(false);
                setVipOnly(false);
                setLikedOnly(false);
                setShowCanceled(false);
                setShowArchived(false);
                setQ("");
                setHighlightOccId(null);
                setFilterJobId(null);
                const defaultPreset = forAdmin ? "thisWeek" : "now";
                const d = computeDatesFromPreset(defaultPreset);
                setDatePreset(defaultPreset);
                setDateFrom(d.from);
                setDateTo(d.to);
                void load(true, { from: d.from, to: d.to });
                onClearAll?.();
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      </>}

      {loading && items.length === 0 && <LoadingCenter />}

      <Box position="relative">
        {loading && items.length > 0 && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
        <VStack align="stretch" gap={3}>
          {forAdmin && !viewAsUserIds?.length && (
            <Box px={3} py={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md">
              <Text fontSize="xs" color="yellow.800">Showing all jobs for all workers, including unclaimed.</Text>
            </Box>
          )}
          {forAdmin && viewAsUserIds && viewAsUserIds.length > 0 && (
            <Box px={3} py={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md">
              <Text fontSize="xs" color="yellow.800">
                Filtered to jobs assigned to the selected worker{viewAsUserIds.length > 1 ? "s" : ""}. Unclaimed and unrelated jobs are hidden.
              </Text>
            </Box>
          )}
          {dayGroups.length === 0 && (
            <Box p="4" color="fg.muted" fontSize="sm">
              {isOffline
                ? "You're offline. No cached data available for this date range. Adjust your dates or reconnect to load more."
                : highlightOccId
                ? "This occurrence is no longer available or assigned to you."
                : "No job occurrences match current filters."}
            </Box>
          )}
          {isOffline && dayGroups.length > 0 && (
            <Box p={3} bg="orange.50" borderWidth="1px" borderColor="orange.200" borderRadius="md" mt={2}>
              <Text fontSize="xs" color="orange.800">
                You're viewing cached data. Some occurrences may not be available offline. You can still: pin/unpin, like/unlike, set reminders, post comments, start jobs, complete jobs, dismiss reminders, and upload photos — these will sync when you reconnect. Other actions require an internet connection.
              </Text>
            </Box>
          )}

          {dayGroups.map((group) => (
            <Box key={group.key} data-group={group.key}>
              <HStack
                gap={3}
                align="center"
                my={2}
                cursor="pointer"
                onClick={() => setCollapsedGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                })}
                _hover={{ opacity: 0.7 }}
              >
                <Box flex="1" borderBottomWidth="2px" borderColor="gray.300" />
                <HStack gap={1.5} align="center">
                  <Text fontSize="sm" fontWeight="bold" color="gray.600" whiteSpace="nowrap" textTransform="uppercase" letterSpacing="wide">
                    {group.label}
                  </Text>
                  <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="1.5" fontSize="2xs" lineHeight="1">
                    {group.items.length}
                  </Badge>
                  <Text fontSize="xs" color="gray.400">{collapsedGroups.has(group.key) ? "▶" : "▼"}</Text>
                </HStack>
                <Box flex="1" borderBottomWidth="2px" borderColor="gray.300" />
              </HStack>
              {!collapsedGroups.has(group.key) && <VStack align="stretch" gap={3}>
          {group.items.map((occ, occIdx) => {
            const assignees = occ.assignees ?? [];
            const myAssignee = assignees.find((a) => a.userId === myId);
            const isObserver = myAssignee?.role === "observer";
            const isAssignedToMe = !!myId && assignees.some((a) => a.userId === myId);
            const isActiveAssignee = isAssignedToMe && !isObserver;
            const isUnassigned = assignees.filter((a) => a.role !== "observer").length === 0;
            const isAssignedToOthers = !isUnassigned && !isAssignedToMe;

            const isClaimer = !!myAssignee && !isObserver && myAssignee.assignedById === myId;

            const isTentative = !!occ.isTentative;

            const isEstimateOcc = occ.workflow === "ESTIMATE" || occ.isEstimate;
            const isAcceptedEstimate = isEstimateOcc && occ.status === "ACCEPTED";
            const isRejectedEstimate = isEstimateOcc && occ.status === "REJECTED";
            const isClosed = occ.status === "CLOSED" || occ.status === "ARCHIVED";
            const isAdminOnlyOcc = !!occ.isAdminOnly;
            const needsConfirmation = !!(occ.jobId) && occ.status === "SCHEDULED" && !(occ as any).isClientConfirmed &&
              (occ.workflow === "STANDARD" || occ.workflow === "ONE_OFF" || occ.workflow === "ESTIMATE" || !occ.workflow);
            const isConfirmed = !!(occ as any).isClientConfirmed;
            const isTask = occ.workflow === "TASK";
            const isReminder = occ.workflow === "REMINDER";
            const isEvent = occ.workflow === "EVENT";
            const isFollowup = occ.workflow === "FOLLOWUP";
            const isAnnouncement = occ.workflow === "ANNOUNCEMENT";
            const isHighPriority = isReminder && !!(occ as any).isHighPriority;
            const isTaskOrReminder = isTask || isReminder || isEvent || isFollowup || isAnnouncement;
            const isLightEstimate = isEstimateOcc && !occ.jobId;
            const isGhost = !!occ._isReminderGhost;
            const isVipClient = !!(occ.job?.property?.client as any)?.isVip;
            const vipReason = (occ.job?.property?.client as any)?.vipReason;
            const isPinned = isWorkerView && pinnedIds.has(occ.id);

            // Ghost reminder cards — render a simplified card
            const ghostHighPriority = !!(occ as any).isHighPriority;
            if (isGhost) {
              return (
                <Card.Root
                  key={`ghost-${occ.id}-${occIdx}`}
                  variant="outline"
                  borderColor={ghostHighPriority ? "purple.500" : "purple.300"}
                  borderWidth={ghostHighPriority ? "2px" : "1px"}
                  bg={ghostHighPriority ? "purple.100" : "purple.50"}
                  css={{
                    borderLeft: ghostHighPriority ? "4px dashed var(--chakra-colors-purple-600)" : "4px dashed var(--chakra-colors-purple-400)",
                    borderStyle: "dashed",
                    opacity: ghostHighPriority ? 1 : 0.8,
                  }}
                >
                  <Card.Body py="3" px="4">
                    <VStack align="start" gap={1}>
                      <HStack gap={2} align="center">
                        <Bell size={14} style={{ color: "var(--chakra-colors-purple-600)" }} />
                        <Badge colorPalette="purple" variant="solid" fontSize="xs" px="2" borderRadius="full">Reminder</Badge>
                        {ghostHighPriority && <Badge colorPalette="red" variant="solid" fontSize="xs" px="2" borderRadius="full">High Priority</Badge>}
                        {occ.reminder?.note && (
                          <Text fontSize="xs" color="purple.700">— {occ.reminder.note.length > 50 ? occ.reminder.note.slice(0, 50) + "…" : occ.reminder.note}</Text>
                        )}
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        {occ.job?.property?.displayName ?? occ.title ?? "Job"}
                        {occ.job?.property?.client?.displayName && ` — ${clientLabel(occ.job.property.client.displayName)}`}
                        {parseJobTags(occ).length > 0 && ` · ${parseJobTags(occ).map(jobTagLabel).join(", ")}`}
                        {(occ as any).jobType && ` · Custom`}
                        {occ.startAt && ` · Scheduled: ${fmtDate(occ.startAt)}`}
                      </Text>
                      <Button
                        size="xs"
                        variant="outline"
                        colorPalette="purple"
                        onClick={() => {
                          setHighlightOccId(occ.id);
                          setExpandedCards(new Set([occ.id]));
                          setFilterJobId(null);
                          setQ("");
                          if (occ.startAt) {
                            const d = new Date(occ.startAt);
                            const from = new Date(d); from.setDate(from.getDate() - 3);
                            const to = new Date(d); to.setDate(to.getDate() + 3);
                            setDatePreset(null);
                            setDateFrom(bizDateKey(from));
                            setDateTo(bizDateKey(to));
                            void load(true, { from: bizDateKey(from), to: bizDateKey(to) }, occ.id);
                          }
                        }}
                      >
                        View Original
                      </Button>
                    </VStack>
                  </Card.Body>
                </Card.Root>
              );
            }

            // Pinned ghost cards — a reference in the regular feed, same color as original card type
            if (occ._isPinnedGhost) {
              const ghostIsTask = occ.workflow === "TASK";
              const ghostIsReminder = occ.workflow === "REMINDER";
              const ghostIsEstimate = occ.workflow === "ESTIMATE" || occ.isEstimate;
              const ghostIsTentative = !!occ.isTentative;
              const ghostIsAssigned = !!myId && (occ.assignees ?? []).some((a: any) => a.userId === myId);
              const ghostColor = ghostIsReminder ? "purple"
                : ghostIsTask ? "blue"
                : ghostIsEstimate ? "pink"
                : ghostIsTentative ? "orange"
                : ghostIsAssigned ? "teal"
                : "gray";
              return (
                <Card.Root
                  key={`pin-ghost-${occ.id}-${occIdx}`}
                  variant="outline"
                  borderColor={`${ghostColor}.300`}
                  bg={`${ghostColor}.50`}
                  css={{
                    borderLeft: `4px dashed var(--chakra-colors-${ghostColor}-400)`,
                    borderStyle: "dashed",
                    opacity: 0.8,
                  }}
                >
                  <Card.Body py="3" px="4">
                    <VStack align="start" gap={1}>
                      <HStack gap={2} align="center">
                        <Pin size={14} fill="currentColor" style={{ color: `var(--chakra-colors-${ghostColor}-600)` }} />
                        <Badge colorPalette={ghostColor} variant="solid" fontSize="xs" px="2" borderRadius="full">Pinned</Badge>
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        {ghostIsTask ? (occ.title || "Task") : ghostIsReminder ? (occ.title || "Reminder") : (occ.job?.property?.displayName ?? "Job")}
                        {occ.job?.property?.client?.displayName && ` — ${clientLabel(occ.job.property.client.displayName)}`}
                        {parseJobTags(occ).length > 0 && ` · ${parseJobTags(occ).map(jobTagLabel).join(", ")}`}
                        {(occ as any).jobType && ` · Custom`}
                        {occ.startAt && ` · Scheduled: ${fmtDate(occ.startAt)}`}
                      </Text>
                      <Button
                        size="xs"
                        variant="outline"
                        colorPalette={ghostColor}
                        onClick={() => {
                          setHighlightOccId(occ.id);
                          setExpandedCards(new Set([occ.id]));
                          setFilterJobId(null);
                          setQ("");
                        }}
                      >
                        View Pinned
                      </Button>
                    </VStack>
                  </Card.Body>
                </Card.Root>
              );
            }

            // Card color theme — bg and border derive from the same base color
            const isPendingPayment = occ.status === "PENDING_PAYMENT";
            const isInProgressOthers = occ.status === "IN_PROGRESS" && isAssignedToOthers;
            const cardColorBase = isAnnouncement ? "announce"
              : isFollowup ? (isClosed ? "followup-closed" : "followup")
              : isEvent ? (isClosed ? "event-closed" : "event")
              : (isClosed || isAcceptedEstimate || isRejectedEstimate) ? "gray"
              : isReminder ? "purple"
              : isTask ? "blue"
              : isTentative ? "orange"
              : isEstimateOcc ? "pink"
              : isPendingPayment ? "green"
              : isAssignedToMe ? "teal"
              : isInProgressOthers ? "teal"
              : isAssignedToOthers ? "gray"
              : isUnassigned ? "yellow"
              : null;
            const cardBg = isHighPriority ? "purple.100"
              : cardColorBase === "announce" ? "purple.200"
              : cardColorBase === "followup-closed" ? "red.100"
              : cardColorBase === "followup" ? "red.200"
              : cardColorBase === "event-closed" ? "yellow.100"
              : cardColorBase === "event" ? "yellow.200"
              : cardColorBase === "gray" && (isAssignedToOthers || isClosed || isAcceptedEstimate) ? "gray.50"
              : cardColorBase === "yellow" ? "yellow.50"
              : cardColorBase === "green" ? "green.100"
              : cardColorBase && cardColorBase !== "gray" ? `${cardColorBase}.50`
              : undefined;
            const cardBorderColor = isHighPriority ? "purple.500"
              : cardColorBase === "announce" ? "purple.400"
              : cardColorBase === "followup-closed" ? "red.300"
              : cardColorBase === "followup" ? "red.400"
              : cardColorBase === "event-closed" ? "yellow.300"
              : cardColorBase === "event" ? "yellow.400"
              : !cardColorBase || (isClosed || isAcceptedEstimate || isRejectedEstimate) ? "gray.200"
              : cardColorBase === "green" ? "green.400"
              : `${cardColorBase}.300`;
            const isInProgress = occ.status === "IN_PROGRESS";
            const cardBorderWidth = isHighPriority ? "2px" : isInProgress ? "2px" : "1px";

            // Comment badge color: darker shade of card bg
            const commentBadgeBg = (isClosed || isAcceptedEstimate || isRejectedEstimate) && !isAnnouncement && !isEvent && !isFollowup ? "gray.200"
              : isAnnouncement ? "purple.200"
              : isFollowup ? "red.200"
              : isEvent ? "yellow.200"
              : isReminder ? "purple.200"
              : isTask ? "blue.200"
              : isTentative ? "orange.200"
              : isEstimateOcc ? "pink.200"
              : isAssignedToMe ? "teal.200"
              : isAssignedToOthers ? "gray.300"
              : "gray.200";
            const commentBadgeColor = (isClosed || isAcceptedEstimate || isRejectedEstimate) && !isAnnouncement && !isEvent && !isFollowup ? "gray.700"
              : isAnnouncement ? "purple.700"
              : isFollowup ? "red.700"
              : isEvent ? "yellow.700"
              : isReminder ? "purple.700"
              : isTask ? "blue.700"
              : isTentative ? "orange.700"
              : isEstimateOcc ? "pink.700"
              : isAssignedToMe ? "teal.700"
              : isAssignedToOthers ? "gray.700"
              : "gray.700";

            const isCardCompact = compact && !expandedCards.has(occ.id);
            const toggleCard = compact
              ? () => setExpandedCards((prev) => {
                  const next = new Set(prev);
                  if (next.has(occ.id)) next.delete(occ.id);
                  else next.add(occ.id);
                  return next;
                })
              : undefined;

            return (
              <Card.Root
                key={occ.id}
                variant="outline"
                borderColor={cardBorderColor}
                borderWidth={cardBorderWidth}
                bg={cardBg}
                overflow="hidden"
                css={{
                  ...(compact ? { cursor: "pointer", "& a, & button": { pointerEvents: "auto" } } : {}),
                  ...(isHighPriority ? { borderLeft: "4px solid var(--chakra-colors-purple-600)" } : isReminder ? { borderLeft: "4px solid var(--chakra-colors-purple-400)" } : isAnnouncement ? { borderLeft: "4px solid var(--chakra-colors-purple-400)", ...(isClosed ? { opacity: 0.7 } : {}) } : (isFollowup && !isClosed) ? { borderLeft: "4px solid var(--chakra-colors-red-400)" } : (isFollowup && isClosed) ? { borderLeft: "4px solid var(--chakra-colors-red-300)", opacity: 0.7 } : (isEvent && !isClosed) ? { borderLeft: "4px solid var(--chakra-colors-yellow-400)" } : (isEvent && isClosed) ? { borderLeft: "4px solid var(--chakra-colors-yellow-300)", opacity: 0.7 } : isTask ? { borderLeft: "4px solid var(--chakra-colors-blue-400)" } : {}),
                }}
                onClick={(e: any) => {
                  if (!toggleCard) return;
                  const el = e.target as HTMLElement;
                  if (el?.closest?.("a, button")) return;
                  toggleCard();
                }}
              >
                {/* Client confirmation banner — expanded cards only, above title */}
                {!isCardCompact && needsConfirmation && (
                  <Box mx="4" mt="3" px="3" py="2" bg="orange.50" borderWidth="1px" borderColor="orange.300" borderRadius="md">
                    <Text fontSize="xs" fontWeight="semibold" color="orange.700">⚠ Client confirmation required before starting</Text>
                  </Box>
                )}
                {(isAdmin || isSuper) && !isCardCompact && !isTaskOrReminder && occ.jobId && (
                  <Box px="4" pt="3" pb="0">
                    <Button
                      size="xs"
                      variant="solid"
                      colorPalette="blue"
                      onClick={() =>
                        openEventSearch(
                          "jobsTabToServicesTabSearch",
                          occ.job?.property?.displayName ?? "",
                          true,
                          `${occ.job?.id}:${occ.id}`,
                        )
                      }
                    >
                      Manage in Services
                    </Button>
                  </Box>
                )}
                {(isAdmin || isSuper) && !isCardCompact && !isTaskOrReminder && !occ.jobId && isEstimateOcc && (
                  <Box px="4" pt="3" pb="0">
                    <Text fontSize="xs" color="orange.600">Stand-alone estimate — not yet linked to a Job Service</Text>
                  </Box>
                )}
                <Card.Header py="3" px="4" pb="0" display="block">
                  {isCardCompact ? (
                    /* ── COMPACT HEADER: responsive — stacked on mobile, side-by-side on desktop ── */
                    <Box display="flex" flexDirection="column" gap={1}>
                      <HStack gap={1} justifyContent="space-between" alignItems="center">
                        {/* Quick action icon */}
                        {!isTrainee && !isTentative && (() => {
                          if (needsConfirmation && (isClaimer || (forAdmin && (isAdmin || isSuper)))) {
                            return (
                              <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="orange.400" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "orange.500" }} title="Confirm Client" onClick={(e: any) => {
                                e.stopPropagation();
                                setConfirmAction({
                                  title: "Confirm Client?",
                                  message: "Have you confirmed with the client that this job is good to go?",
                                  confirmLabel: "Yes, Confirmed",
                                  colorPalette: "orange",
                                  onConfirm: async () => {
                                    try {
                                      await apiPost(`/api/occurrences/${occ.id}/confirm`);
                                      setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, isClientConfirmed: true } as any : o));
                                      publishInlineMessage({ type: "SUCCESS", text: "Client confirmed." });
                                    } catch (err) { publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to confirm.", err) }); }
                                  },
                                });
                              }}><CheckCircle2 size={12} /></Box>
                            );
                          }
                          if (!isTaskOrReminder && occ.status === "SCHEDULED" && !needsConfirmation && (isClaimer || (forAdmin && (isAdmin || isSuper)))) {
                            return (
                              <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="blue.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "blue.600" }} title="Start Job" onClick={(e: any) => {
                                e.stopPropagation();
                                if (isOffline) {
                                  void (async () => {
                                    await enqueueAction("START_JOB", occ.id, queueLabel(occ, "Start job"), { notes: undefined, lat: null, lng: null });
                                    setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, status: "IN_PROGRESS" as any, startedAt: new Date().toISOString() } : o));
                                    publishInlineMessage({ type: "INFO", text: "Job started (queued for sync)." });
                                  })();
                                  return;
                                }
                                const now = new Date();
                                const pad = (n: number) => String(n).padStart(2, "0");
                                setStartJobTime(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`);
                                setStartJobOcc(occ);
                              }}><Play size={12} /></Box>
                            );
                          }
                          if (!isTaskOrReminder && occ.status === "IN_PROGRESS" && (isClaimer || (forAdmin && (isAdmin || isSuper))) && !isEstimateOcc) {
                            return (
                              <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="blue.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "blue.600" }} title="Complete Job" onClick={(e: any) => {
                                e.stopPropagation();
                                setCompleteDialogOcc(occ);
                              }}><CheckCircle2 size={12} /></Box>
                            );
                          }
                          if (!isTaskOrReminder && occ.status === "PENDING_PAYMENT" && !isEstimateOcc && (isClaimer || (forAdmin && (isAdmin || isSuper)))) {
                            return (
                              <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="green.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "green.600" }} title="Accept Payment" onClick={(e: any) => {
                                e.stopPropagation();
                                setAcceptPaymentOcc(occ);
                                setAcceptPaymentOpen(true);
                              }}><CircleDollarSign size={12} /></Box>
                            );
                          }
                          if (isUnassigned && !isAdminOnlyOcc && !isTaskOrReminder) {
                            const isContractor = me?.workerType === "CONTRACTOR";
                            const jobDate = occ.startAt ? new Date(occ.startAt) : null;
                            const daysAhead = jobDate ? Math.ceil((jobDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)) : 0;
                            const contractorBlocked = isContractor && daysAhead > 2;
                            if (contractorBlocked || isTrainee) return null;
                            return (
                              <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="yellow.400" color="yellow.900" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "yellow.500" }} title="Claim" onClick={(e: any) => {
                                e.stopPropagation();
                                void claim(occ.id);
                              }}><Hand size={12} /></Box>
                            );
                          }
                          return null;
                        })()}
                        <Text fontSize="sm" fontWeight="semibold" minW={0} flex="1" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                          {isReminder ? (
                            <>{occ.title || "Reminder"}</>
                          ) : isEvent || isFollowup || isAnnouncement ? (
                            <>{occ.title || (isFollowup ? "Followup" : isAnnouncement ? "Announcement" : "Event")}</>
                          ) : isTask ? (
                            <>{occ.title || "Task"}</>
                          ) : isLightEstimate ? (
                            <>
                              {occ.title || "Light Estimate"}
                              {occ.contactName && (
                                <Text as="span" color="fg.muted" fontWeight="normal"> — {occ.contactName}</Text>
                              )}
                            </>
                          ) : (
                            <>
                              {isVipClient && <span title={vipReason || "VIP Client"} style={{ cursor: "help" }}>⭐ </span>}
                              {occ.job?.property?.displayName}
                              {occ.job?.property?.client?.displayName && (
                                <Text as="span" color="fg.muted" fontWeight="normal"> — {clientLabel(occ.job.property.client.displayName)}</Text>
                              )}
                              {isEstimateOcc && occ.title && (
                                <Text as="span" color="fg.muted" fontWeight="normal"> · {occ.title}</Text>
                              )}
                            </>
                          )}
                        </Text>
                        <HStack gap={1} flexShrink={0}>
                          {/* Quick contact */}
                          {(() => {
                            const poc = (occ.job?.property as any)?.pointOfContact;
                            const phone = poc?.phone;
                            const email = poc?.email;
                            if (phone) return (
                              <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); window.open(`tel:${phone}`, "_self"); }} title={`Call ${phone}`}>
                                <Phone size={14} color="var(--chakra-colors-green-500)" />
                              </Button>
                            );
                            if (email) return (
                              <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); window.open(`mailto:${email}`, "_self"); }} title={`Email ${email}`}>
                                <Mail size={14} color="var(--chakra-colors-blue-500)" />
                              </Button>
                            );
                            return null;
                          })()}
                          {isWorkerView && (
                            <>
                              <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); void toggleLike(occ.id); }} title={likedIds.has(occ.id) ? "Unlike" : "Like"}>
                                <Heart size={14} fill={likedIds.has(occ.id) ? "var(--chakra-colors-red-500)" : "none"} color="var(--chakra-colors-red-500)" />
                              </Button>
                              <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); void togglePin(occ.id); }} title={pinnedIds.has(occ.id) ? "Unpin" : "Pin"}>
                                {pinnedIds.has(occ.id) ? <Pin size={14} fill="currentColor" /> : <Pin size={14} />}
                              </Button>
                            </>
                          )}
                          <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); shareOccurrenceLink(occ.id); }} title="Share link">
                            <Share2 size={14} />
                          </Button>
                        </HStack>
                      </HStack>
                      {isLightEstimate && occ.estimateAddress && (
                        <Box fontSize="xs" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap"><MapLink address={occ.estimateAddress} /></Box>
                      )}
                      <HStack gap={1} flexShrink={0} alignItems="center" wrap="wrap">
                        <Box display="flex" gap={1} flexWrap="wrap" alignItems="center">
                          {isTentative ? (
                            <StatusBadge status="Tentative" palette="orange" variant="solid" />
                          ) : occ.status !== "SCHEDULED" ? (
                            <StatusBadge
                              status={occ.status}
                              palette={occurrenceStatusColor(occ.status)}
                              variant="solid"
                            />
                          ) : null}
                          {isReminder && <StatusBadge status="Reminder" palette="purple" variant="solid" />}
                          {isHighPriority && <StatusBadge status="High Priority" palette="red" variant="solid" />}
                          {isTask && <StatusBadge status="Task" palette="blue" variant="solid" />}
                          {isEvent && (() => {
                            const freq = (occ as any).frequencyDays;
                            const freqLabel = !freq ? "One-off" : freq === 7 ? "Weekly" : freq === 30 ? "Monthly" : freq === 365 ? "Yearly" : `${freq}d`;
                            return <StatusBadge status={`Event · ${freqLabel}`} palette="yellow" variant="solid" />;
                          })()}
                          {isFollowup && (() => {
                            const freq = (occ as any).frequencyDays;
                            const freqLabel = !freq ? "One-off" : freq === 7 ? "Weekly" : freq === 30 ? "Monthly" : freq === 365 ? "Yearly" : `${freq}d`;
                            return <StatusBadge status={`Followup · ${freqLabel}`} palette="red" variant="solid" />;
                          })()}
                          {isAnnouncement && <StatusBadge status="Announcement" palette="purple" variant="solid" />}
                          {isTask && (
                            <Badge fontSize="xs" px="1.5" borderRadius="full" variant="subtle" colorPalette="blue">Personal</Badge>
                          )}
                          {isReminder && (
                            <Badge fontSize="xs" px="1.5" borderRadius="full" variant="subtle" colorPalette="purple">Personal</Badge>
                          )}
                          {isEvent && (
                            <Badge fontSize="xs" px="1.5" borderRadius="full" variant="subtle" colorPalette="yellow">Team</Badge>
                          )}
                          {isFollowup && (
                            <Badge fontSize="xs" px="1.5" borderRadius="full" variant="subtle" colorPalette="red">Team</Badge>
                          )}
                          {isAnnouncement && (
                            <Badge fontSize="xs" px="1.5" borderRadius="full" variant="subtle" colorPalette="purple">Everyone</Badge>
                          )}
                          {!isTaskOrReminder && (occ.workflow === "STANDARD" || (!occ.workflow && !occ.isEstimate && !occ.isOneOff)) && (() => {
                            const freq = occ.frequencyDays ?? (occ.job as any)?.frequencyDays;
                            return <StatusBadge status={freq ? `Repeating · ${freq}d` : "Repeating"} palette="blue" variant="subtle" />;
                          })()}
                          {(occ.workflow === "ESTIMATE" || occ.isEstimate) && <StatusBadge status="Estimate" palette="pink" variant="solid" />}
                          {!isTaskOrReminder && (occ.workflow === "ONE_OFF" || occ.isOneOff) && <StatusBadge status="One-off" palette="cyan" variant="solid" />}
                          {isAdminOnlyOcc && <StatusBadge status="Administered" palette="red" variant="outline" />}
                          {needsConfirmation && <StatusBadge status="Unconfirmed" palette="orange" variant="solid" />}
                          {isConfirmed && occ.status === "SCHEDULED" && !isTaskOrReminder && <Badge colorPalette="green" variant="subtle" fontSize="2xs" px="1.5" py="0" borderRadius="full" lineHeight="1.4">Confirmed</Badge>}
                                                    {occ.linkGroupId && (
                            <Badge colorPalette="purple" variant="outline" fontSize="xs" px="1.5" borderRadius="full">
                              <Link2 size={10} style={{ marginRight: 3 }} /> Linked
                            </Badge>
                          )}
                          {(occ.price ?? 0) >= highValueThreshold && <span title="Only employees or insured contractors can claim this job" style={{ display: "flex" }}><StatusBadge status="Insured Only" palette="yellow" variant="solid" /></span>}
                          {isWorkerView && occ.reminder && (
                            <Badge
                              colorPalette={bizDateKey(occ.reminder.remindAt) <= bizDateKey(new Date()) ? "orange" : "gray"}
                              variant="subtle" fontSize="xs" borderRadius="full" px="2"
                              cursor={occ.reminder.note ? "pointer" : undefined}
                              onClick={occ.reminder.note ? (e: any) => {
                                e.stopPropagation();
                                navigator.clipboard.writeText(occ.reminder!.note!);
                                publishInlineMessage({ type: "SUCCESS", text: "Copied!" });
                              } : undefined}
                              title={occ.reminder.note ? `${occ.reminder.note} (click to copy)` : undefined}
                            >
                              <Bell size={10} style={{ marginRight: 3 }} />
                              {fmtDate(occ.reminder.remindAt)}{occ.reminder.note ? ` — ${occ.reminder.note.length > 30 ? occ.reminder.note.slice(0, 30) + "…" : occ.reminder.note}` : ""}
                            </Badge>
                          )}
                        </Box>
                      </HStack>
                    </Box>
                    ) : (
                      /* ── EXPANDED HEADER: responsive — stacked on mobile, side-by-side on desktop ── */
                      <Box display="flex" flexDirection="column" gap="4px" w="full">
                        <HStack justifyContent="space-between" alignItems="center">
                          <Text fontSize="md" fontWeight="semibold" minW={0} flex="1">
                            {isReminder ? (
                              <>{occ.title || "Reminder"}</>
                            ) : isEvent || isFollowup || isAnnouncement ? (
                              <>{occ.title || (isAnnouncement ? "Announcement" : isFollowup ? "Followup" : "Event")}</>
                            ) : isTask ? (
                              <>{occ.title || "Task"}</>
                            ) : isLightEstimate ? (
                              <>
                                {occ.title || "Light Estimate"}
                                {occ.contactName && (
                                  <Text as="span" color="fg.muted" fontWeight="normal"> — {occ.contactName}</Text>
                                )}
                              </>
                            ) : (
                              <>
                                {isVipClient && <span title={vipReason || "VIP Client"} style={{ cursor: "help" }}>⭐ </span>}
                                {occ.job?.property?.displayName}
                                {occ.job?.property?.client?.displayName && (
                                  <> — {clientLabel(occ.job.property.client.displayName)}</>
                                )}
                              </>
                            )}
                          </Text>
                          <HStack gap={1} flexShrink={0}>
                            {/* Quick contact */}
                            {(() => {
                              const poc = (occ.job?.property as any)?.pointOfContact;
                              const phone = poc?.phone;
                              const email = poc?.email;
                              if (phone) return (
                                <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); window.open(`tel:${phone}`, "_self"); }} title={`Call ${phone}`}>
                                  <Phone size={14} color="var(--chakra-colors-green-500)" />
                                </Button>
                              );
                              if (email) return (
                                <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); window.open(`mailto:${email}`, "_self"); }} title={`Email ${email}`}>
                                  <Mail size={14} color="var(--chakra-colors-blue-500)" />
                                </Button>
                              );
                              return null;
                            })()}
                            {isWorkerView && (
                              <>
                                <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); void toggleLike(occ.id); }} title={likedIds.has(occ.id) ? "Unlike" : "Like"}>
                                  <Heart size={14} fill={likedIds.has(occ.id) ? "var(--chakra-colors-red-500)" : "none"} color="var(--chakra-colors-red-500)" />
                                </Button>
                                <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); void togglePin(occ.id); }} title={pinnedIds.has(occ.id) ? "Unpin" : "Pin"}>
                                  {pinnedIds.has(occ.id) ? <Pin size={14} fill="currentColor" /> : <Pin size={14} />}
                                </Button>
                              </>
                            )}
                            <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); shareOccurrenceLink(occ.id); }} title="Share link">
                              <Share2 size={14} />
                            </Button>
                          </HStack>
                        </HStack>
                        {isEstimateOcc && occ.title && !isLightEstimate && (
                          <Text fontSize="sm" color="fg.muted">{occ.title}</Text>
                        )}
                        {((!isLightEstimate && !isTaskOrReminder) || (isTaskOrReminder && occ.linkedOccurrence) || (isVipClient && vipReason)) && (
                        <VStack align="start" gap={0} flex="1" minW={0}>
                            {isTaskOrReminder && occ.linkedOccurrence && (
                              <Box fontSize="xs">
                                <Text color="fg.muted" mb={0.5}>Linked occurrence:</Text>
                                <a
                                  href="#"
                                  style={{ color: "var(--chakra-colors-blue-600)", textDecoration: "underline" }}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const lo = occ.linkedOccurrence!;
                                    setHighlightOccId(lo.id);
                                    setExpandedCards(new Set([lo.id]));
                                    setFilterJobId(null);
                                    setQ("");
                                    // Ensure date range includes the linked occurrence
                                    if (lo.startAt) {
                                      const d = new Date(lo.startAt);
                                      const from = new Date(d); from.setDate(from.getDate() - 3);
                                      const to = new Date(d); to.setDate(to.getDate() + 3);
                                      setDatePreset(null);
                                      setDateFrom(bizDateKey(from));
                                      setDateTo(bizDateKey(to));
                                      void load(true, { from: bizDateKey(from), to: bizDateKey(to) }, lo.id);
                                    } else {
                                      void load(true, undefined, lo.id);
                                    }
                                  }}
                                >
                                  {occ.linkedOccurrence.job?.property?.displayName ?? "Job"}
                                  {occ.linkedOccurrence.job?.property?.client?.displayName && ` — ${clientLabel(occ.linkedOccurrence.job.property.client.displayName)}`}
                                  {parseJobTags(occ.linkedOccurrence).length > 0 && ` · ${parseJobTags(occ.linkedOccurrence).map(jobTagLabel).join(", ")}`}
                                  {occ.linkedOccurrence.jobType && ` · Custom`}
                                  {occ.linkedOccurrence.startAt && ` · ${fmtDate(occ.linkedOccurrence.startAt)}`}
                                </a>
                              </Box>
                            )}
                            {!isTaskOrReminder && (
                            <Box fontSize="sm">
                              <MapLink address={[
                                  occ.job?.property?.street1,
                                  occ.job?.property?.city,
                                  occ.job?.property?.state,
                                ]
                                  .filter(Boolean)
                                  .join(", ")} />
                            </Box>
                            )}
                            <HStack gap={3} fontSize="xs">
                              {!isTaskOrReminder && occ.job?.property?.displayName && (
                                <TextLink
                                  text="View Property"
                                  onClick={() =>
                                    openEventSearch(
                                      "jobsTabToPropertiesTabSearch",
                                      occ.job?.property?.displayName ?? "",
                                      forAdmin,
                                      occ.job?.property?.id,
                                    )
                                  }
                                />
                              )}
                              {!isTaskOrReminder && occ.job?.property?.client?.displayName && (
                                <TextLink
                                  text="View Client"
                                  onClick={() =>
                                    openEventSearch(
                                      "jobsTabToClientsTabSearch",
                                      occ.job?.property?.client?.displayName ?? "",
                                      forAdmin,
                                      occ.job?.property?.client?.id,
                                    )
                                  }
                                />
                              )}
                            </HStack>
                            {isVipClient && vipReason && (
                              <Text fontSize="xs" color="yellow.700" fontWeight="medium">⭐ VIP: {vipReason}</Text>
                            )}
                          </VStack>
                        )}
                        <HStack gap={1} flexWrap="wrap" mt={1}>
                          {isTentative ? (
                            <StatusBadge status="Tentative" palette="orange" variant="solid" />
                          ) : occ.status !== "SCHEDULED" ? (
                            <StatusBadge
                              status={occ.status}
                              palette={occurrenceStatusColor(occ.status)}
                              variant="solid"
                            />
                          ) : null}
                          {isReminder && <StatusBadge status="Reminder" palette="purple" variant="solid" />}
                          {isHighPriority && <StatusBadge status="High Priority" palette="red" variant="solid" />}
                          {isTask && <StatusBadge status="Task" palette="blue" variant="solid" />}
                          {isEvent && (() => {
                            const freq = (occ as any).frequencyDays;
                            const freqLabel = !freq ? "One-off" : freq === 7 ? "Weekly" : freq === 30 ? "Monthly" : freq === 365 ? "Yearly" : `${freq}d`;
                            return <StatusBadge status={`Event · ${freqLabel}`} palette="yellow" variant="solid" />;
                          })()}
                          {isFollowup && (() => {
                            const freq = (occ as any).frequencyDays;
                            const freqLabel = !freq ? "One-off" : freq === 7 ? "Weekly" : freq === 30 ? "Monthly" : freq === 365 ? "Yearly" : `${freq}d`;
                            return <StatusBadge status={`Followup · ${freqLabel}`} palette="red" variant="solid" />;
                          })()}
                          {isAnnouncement && <StatusBadge status="Announcement" palette="purple" variant="solid" />}
                          {!isTaskOrReminder && (occ.workflow === "STANDARD" || (!occ.workflow && !occ.isEstimate && !occ.isOneOff)) && (() => {
                            const freq = occ.frequencyDays ?? (occ.job as any)?.frequencyDays;
                            return <StatusBadge status={freq ? `Repeating · ${freq}d` : "Repeating"} palette="blue" variant="subtle" />;
                          })()}
                          {(occ.workflow === "ESTIMATE" || occ.isEstimate) && <StatusBadge status="Estimate" palette="pink" variant="solid" />}
                          {!isTaskOrReminder && (occ.workflow === "ONE_OFF" || occ.isOneOff) && <StatusBadge status="One-off" palette="cyan" variant="solid" />}
                          {isAdminOnlyOcc && <StatusBadge status="Administered" palette="red" variant="outline" />}
                        </HStack>
                      </Box>
                    )}
                </Card.Header>

                {isCardCompact ? (
                  <Card.Body py="3" px="4" pt="1" overflow="hidden">
                    <VStack align="start" gap={1} fontSize="xs">
                      {/* Elapsed time for IN_PROGRESS */}
                      {occ.status === "IN_PROGRESS" && occ.startedAt && (() => {
                        const elapsed = Math.round((Date.now() - new Date(occ.startedAt).getTime()) / 60000);
                        const h = Math.floor(elapsed / 60);
                        const m = elapsed % 60;
                        const elapsedStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
                        const est = occ.estimatedMinutes;
                        const over = est && elapsed > est;
                        return (
                          <Text fontSize="xs" fontWeight="semibold" color={over ? "red.500" : "blue.600"}>
                            Started {elapsedStr} ago{est ? ` / ${est >= 60 ? `${Math.floor(est / 60)}h ${est % 60}m` : `${est}m`} est.` : ""}{over ? " — over estimate" : ""}
                          </Text>
                        );
                      })()}
                      {/* Event time */}
                      {isEvent && occ.startAt && (() => {
                        const d = new Date(occ.startAt);
                        const h = d.getHours(); const m = d.getMinutes();
                        if (h === 9 && m === 0) return null;
                        return (
                          <Text fontSize="sm" fontWeight="bold" color="#B45309">
                            {d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                          </Text>
                        );
                      })()}
                      {/* Followup attachments (compact) */}
                      {isFollowup && ((occ as any).followupClients?.length > 0 || (occ as any).followupJobs?.length > 0) && (
                        <Box display="flex" gap="4px" flexWrap="wrap">
                          {(occ as any).followupClients?.map((fc: any) => (
                            <Badge key={fc.client.id} colorPalette="red" variant="subtle" fontSize="xs" px="2" borderRadius="full" cursor={forAdmin ? "pointer" : undefined} onClick={forAdmin ? (e: any) => { e.stopPropagation(); openEventSearch("jobsTabToClientsTabSearch", fc.client.displayName, forAdmin, fc.client.id); } : undefined}>
                              {fc.client.displayName}
                            </Badge>
                          ))}
                          {(occ as any).followupJobs?.map((fj: any) => (
                            <Badge key={fj.job.id} colorPalette="red" variant="subtle" fontSize="xs" px="2" borderRadius="full" cursor={forAdmin ? "pointer" : undefined} onClick={forAdmin ? (e: any) => { e.stopPropagation(); openEventSearch("jobsTabToServicesTabSearch", fj.job.property?.displayName ?? "", true, `${fj.job.id}:`); } : undefined}>
                              {fj.job.property?.displayName ?? "Job"}{fj.job.property?.client?.displayName ? ` — ${fj.job.property.client.displayName}` : ""}
                            </Badge>
                          ))}
                        </Box>
                      )}
                      {/* Job tags */}
                      {!isTaskOrReminder && (parseJobTags(occ).length > 0 || (occ as any).jobType) && (
                        <Box display="flex" gap="4px" flexWrap="wrap">
                          {parseJobTags(occ).map((tag: string) => (
                            <Badge key={tag} colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                              {jobTagLabel(tag)}
                            </Badge>
                          ))}
                          {(occ as any).jobType && (
                            <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                              Custom
                            </Badge>
                          )}
                        </Box>
                      )}
                      {/* Admin client tags */}
                      {forAdmin && !isTaskOrReminder && (() => {
                        const tags = parseAdminTags((occ.job?.property?.client as any)?.adminTags);
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
                      {/* Price / payout / time */}
                      {(() => { const displayPrice = (occ.price || null) ?? (occ.proposalAmount || null); return (
                      <Box display="flex" gap={2} flexWrap="wrap" alignItems="center">
                        {displayPrice != null && (
                          <Badge colorPalette="green" variant="solid" fontSize="xs" px="2" py="0.5" borderRadius="full">
                            ${displayPrice.toFixed(2)}{isEstimateOcc ? " (proposal)" : ""}
                          </Badge>
                        )}
                        {occ.payment && (
                          <Badge bg="green.700" color="white" fontSize="xs" px="2" py="0.5" borderRadius="full">
                            Paid: ${(occ.payment as any).amountPaid.toFixed(2)}
                          </Badge>
                        )}
                        {displayPrice != null && !occ.payment && (() => {
                          const expTotal = (occ.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                          const net = displayPrice - expTotal;
                          const isEmp = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE";
                          const isCon = me?.workerType === "CONTRACTOR" || !me?.workerType;
                          const pct = isEmp ? marginPercent : isCon ? commissionPercent : 0;
                          const deduction = Math.round(net * pct) / 100;
                          const payout = net - deduction;
                          return pct > 0 ? (
                            <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                              Payout: ${payout.toFixed(2)}
                            </Badge>
                          ) : null;
                        })()}
                        {(() => {
                          const actual = actualMinutes(occ);
                          const workerCount = (occ.assignees ?? []).filter((a) => a.role !== "observer").length;
                          const adjEst = occ.estimatedMinutes && workerCount > 1 ? Math.round(occ.estimatedMinutes / workerCount) : occ.estimatedMinutes;
                          if (actual != null && adjEst) {
                            const color = actual <= adjEst ? "green.600" : "red.600";
                            return <Text color={color} fontWeight="medium">{formatDuration(actual)}</Text>;
                          }
                          if (adjEst != null) return <Text color="fg.muted">{formatDuration(adjEst)}{workerCount > 1 ? ` (${workerCount} workers)` : ""}</Text>;
                          return null;
                        })()}
                      </Box>
                      ); })()}
                    </VStack>
                    <HStack mt={1} justify="space-between" align="center">
                      {!isUnassigned ? (
                        <Text fontSize="xs" fontWeight="semibold" color="teal.700">
                          {assignees.map((a) => {
                            const name = a.user?.displayName ?? a.user?.email ?? a.userId;
                            const isCl = a.assignedById === a.userId && a.role !== "observer";
                            const role = isCl ? "Claimer - Lead Worker" : a.role === "observer" ? "Observer" : "Worker";
                            return `${name} (${role})`;
                          }).join(", ")}
                        </Text>
                      ) : occ.status !== "ARCHIVED" ? (
                        <Text fontSize="xs" fontWeight="semibold" color="orange.500">
                          {(isEvent || isFollowup || isAnnouncement) ? null : isTentative ? "Tentative — awaiting confirmation" : isAdminOnlyOcc ? "Unassigned — admin must assign" : "Unclaimed"}
                        </Text>
                      ) : <Box />}
                      {(occ._count?.comments ?? 0) > 0 && (
                        <Badge
                          variant="solid"
                          fontSize="xs"
                          px="2"
                          borderRadius="full"
                          cursor="pointer"
                          flexShrink={0}
                          bg={commentBadgeBg}
                          color={commentBadgeColor}
                          onClick={(e: any) => {
                            e.stopPropagation();
                            if (isCardCompact) setExpandedCards((prev) => { const next = new Set(prev); next.add(occ.id); return next; });
                            setCommentsOpenFor((prev) => { const next = new Set(prev); next.add(occ.id); if (!commentsCache[occ.id]) void loadComments(occ.id); return next; });
                            setTimeout(() => {
                              const el = document.querySelector(`[data-comments="${occ.id}"]`);
                              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                            }, 150);
                          }}
                        >
                          <MessageCircle size={11} style={{ marginRight: 3 }} />
                          {occ._count?.comments}
                        </Badge>
                      )}
                    </HStack>
                    {!isTaskOrReminder && (occ.photos ?? []).length > 0 && (
                      <Box display="flex" gap={1} mt={1} flexWrap="wrap">
                        {(occ.photos ?? []).map((p, idx) => (
                          <img
                            key={p.id}
                            src={p.url}
                            alt=""
                            style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, cursor: "pointer" }}
                            onClick={async (e) => {
                              e.stopPropagation();
                              // Show preview photos immediately, then load all
                              setViewerPhotos(occ.photos ?? []);
                              setViewerIndex(idx);
                              try {
                                const allPhotos = await apiGet<{ id: string; url: string; contentType?: string | null }[]>(
                                  forAdmin ? `/api/admin/occurrences/${occ.id}/photos` : `/api/occurrences/${occ.id}/photos`
                                );
                                if (Array.isArray(allPhotos) && allPhotos.length > (occ.photos ?? []).length) {
                                  setViewerPhotos(allPhotos);
                                }
                              } catch {}
                            }}
                          />
                        ))}
                      </Box>
                    )}
                  </Card.Body>
                ) : (
                <Card.Body pt="2" px="4">
                  <VStack align="start" gap={2} w="full">
                    {/* Elapsed time for IN_PROGRESS (expanded) */}
                    {occ.status === "IN_PROGRESS" && occ.startedAt && (() => {
                      const elapsed = Math.round((Date.now() - new Date(occ.startedAt).getTime()) / 60000);
                      const h = Math.floor(elapsed / 60);
                      const m = elapsed % 60;
                      const elapsedStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
                      const est = occ.estimatedMinutes;
                      const over = est && elapsed > est;
                      return (
                        <Text fontSize="sm" fontWeight="semibold" color={over ? "red.500" : "blue.600"}>
                          Started {elapsedStr} ago{est ? ` / ${est >= 60 ? `${Math.floor(est / 60)}h ${est % 60}m` : `${est}m`} est.` : ""}{over ? " — over estimate" : ""}
                        </Text>
                      );
                    })()}
                    {/* Event time — prominent */}
                    {isEvent && occ.startAt && (() => {
                      const d = new Date(occ.startAt);
                      const h = d.getHours(); const m = d.getMinutes();
                      if (h === 9 && m === 0) return null;
                      return (
                        <Text fontSize="md" fontWeight="bold" color="#B45309">
                          {d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        </Text>
                      );
                    })()}
                    {isLightEstimate && occ.estimateAddress && (
                      <Box fontSize="xs"><MapLink address={occ.estimateAddress} /></Box>
                    )}
                    <HStack gap={1} flexWrap="wrap" alignItems="center">
                      {occ.linkGroupId && (
                        <Badge colorPalette="purple" variant="outline" fontSize="xs" px="1.5" borderRadius="full">
                          <Link2 size={10} style={{ marginRight: 3 }} /> Linked
                        </Badge>
                      )}
                      {(occ.price ?? 0) >= highValueThreshold && (
                        <span title="Only employees or insured contractors can claim this job" style={{ display: "flex" }}>
                          <StatusBadge status="Insured Only" palette="yellow" variant="solid" />
                        </span>
                      )}
                      {isWorkerView && occ.reminder && (
                        <HStack gap={1}>
                          <Badge
                            colorPalette={bizDateKey(occ.reminder.remindAt) <= bizDateKey(new Date()) ? "orange" : "gray"}
                            variant="subtle" fontSize="xs" borderRadius="full" px="2"
                          >
                            <Bell size={10} style={{ marginRight: 3 }} />
                            {fmtDate(occ.reminder.remindAt)}{occ.reminder.note ? ` — ${occ.reminder.note.length > 30 ? occ.reminder.note.slice(0, 30) + "…" : occ.reminder.note}` : ""}
                          </Badge>
                          {occ.reminder.note && (
                            <Button size="xs" variant="ghost" px="1" minW="0"
                              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(occ.reminder!.note!); publishInlineMessage({ type: "SUCCESS", text: "Copied!" }); }}
                              title="Copy reminder note"
                            >
                              <Copy size={12} style={{ display: "block" }} />
                            </Button>
                          )}
                        </HStack>
                      )}
                    </HStack>
                    {occ.startAt && (
                      <Text fontSize="xs">
                        {fmtDate(occ.startAt)}
                        {occ.endAt && fmtDate(occ.endAt) !== fmtDate(occ.startAt)
                          ? ` – ${fmtDate(occ.endAt)}`
                          : ""}
                      </Text>
                    )}
                    {isLightEstimate && (occ.contactName || occ.contactPhone || occ.contactEmail) && (
                      <Box p={2} bg="pink.50" rounded="md" fontSize="xs">
                        {occ.contactName && <Text><strong>Contact:</strong> {occ.contactName}</Text>}
                        {occ.contactPhone && <Text><strong>Phone:</strong> {occ.contactPhone}</Text>}
                        {occ.contactEmail && <Text><strong>Email:</strong> {occ.contactEmail}</Text>}
                      </Box>
                    )}
                    {(parseJobTags(occ).length > 0 || (occ as any).jobType) && (
                      <Box display="flex" gap="4px" flexWrap="wrap">
                        {parseJobTags(occ).map((tag: string) => (
                          <Badge key={tag} colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                            {jobTagLabel(tag)}
                          </Badge>
                        ))}
                        {(occ as any).jobType && (
                          <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                            {jobTypeLabel((occ as any).jobType)}
                          </Badge>
                        )}
                      </Box>
                    )}
                    {((occ.price || null) ?? (occ.proposalAmount || null)) != null && (
                      <Badge colorPalette="green" variant="solid" fontSize="sm" px="3" py="0.5" borderRadius="full">
                        ${((occ.price || null) ?? (occ.proposalAmount || null))!.toFixed(2)}{isEstimateOcc ? " (proposal)" : ""}
                      </Badge>
                    )}
                    {occ.payment && (
                      <HStack gap={1}>
                        <Badge bg="green.700" color="white" fontSize="sm" px="3" py="0.5" borderRadius="full">
                          Paid: ${(occ.payment as any).amountPaid.toFixed(2)}
                        </Badge>
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="teal"
                          px="2"
                          onClick={(e) => {
                            e.stopPropagation();
                            const poc = occ.job?.property?.pointOfContact;
                            setReceiptContact({ phone: poc?.phone, email: poc?.email });
                            setReceiptData({
                              businessName: "Seedlings Lawn Care",
                              clientName: occ.job?.property?.client?.displayName ?? "Client",
                              propertyAddress: [occ.job?.property?.street1, occ.job?.property?.city, occ.job?.property?.state].filter(Boolean).join(", "),
                              jobType: [parseJobTags(occ).length > 0 ? parseJobTags(occ).map(jobTagLabel).join(", ") : null, (occ as any).jobType ? `Custom: ${(occ as any).jobType}` : null].filter(Boolean).join(" · ") || occ.kind || "Lawn Care",
                              serviceDate: occ.startAt ? fmtDate(occ.startAt) : "—",
                              completedDate: occ.completedAt ? fmtDate(occ.completedAt) : "—",
                              amount: (occ.payment as any).amountPaid,
                              method: (occ.payment as any).method ?? "CASH",
                              workers: (occ.assignees ?? []).filter((a) => a.role !== "observer").map((a) => a.user?.displayName ?? ""),
                              receiptId: occ.id.slice(-8).toUpperCase(),
                            });
                            setReceiptDialogOpen(true);
                          }}
                          title="Send receipt"
                        >
                          Receipt
                        </Button>
                      </HStack>
                    )}
                    {((occ.price || null) ?? (occ.proposalAmount || null)) != null && !occ.payment && (() => {
                      const displayPrice = ((occ.price || null) ?? (occ.proposalAmount || null))!;
                      const expTotal = (occ.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                      const net = displayPrice - expTotal;
                      const isEmp = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE";
                      const isCon = me?.workerType === "CONTRACTOR" || !me?.workerType;
                      const pct = isEmp ? marginPercent : isCon ? commissionPercent : 0;
                      const deduction = Math.round(net * pct) / 100;
                      const payout = net - deduction;
                      const label = isEmp ? "margin" : "commission";
                      const activeAssignees = (occ.assignees ?? []).filter((a) => a.role !== "observer");
                      const perPerson = activeAssignees.length > 1 ? Math.round(payout / activeAssignees.length * 100) / 100 : null;
                      return (
                        <Box fontSize="xs" color="fg.muted" mt={0.5}>
                          {pct > 0 && (
                            <>
                              <HStack gap={2}>
                                <Text>Est. payout:</Text>
                                <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                                  ${payout.toFixed(2)}
                                </Badge>
                              </HStack>
                              <Text fontSize="xs" color="fg.muted">
                                ${displayPrice.toFixed(2)}{expTotal > 0 ? ` − $${expTotal.toFixed(2)} exp` : ""} − ${deduction.toFixed(2)} {label} ({pct}%)
                              </Text>
                            </>
                          )}
                          {perPerson != null && (
                            <Text fontSize="xs" color="fg.muted" mt={pct > 0 ? 0.5 : 0}>
                              ~${perPerson.toFixed(2)}/person if split evenly ({activeAssignees.length} workers)
                            </Text>
                          )}
                        </Box>
                      );
                    })()}
                    {(occ.estimatedMinutes != null || (occ.startedAt && occ.completedAt)) && (() => {
                      const workerCount = (occ.assignees ?? []).filter((a) => a.role !== "observer").length;
                      const adjEst = occ.estimatedMinutes && workerCount > 1 ? Math.round(occ.estimatedMinutes / workerCount) : occ.estimatedMinutes;
                      return (
                      <HStack fontSize="xs" gap={2}>
                        {adjEst != null && (
                          <Text color="fg.muted">Est: {formatDuration(adjEst)}{workerCount > 1 ? ` (${workerCount} workers)` : ""}</Text>
                        )}
                        {(() => {
                          const actual = actualMinutes(occ);
                          if (actual == null) return null;
                          const color = adjEst
                            ? actual <= adjEst ? "green.600" : "red.600"
                            : "fg.muted";
                          return <Text color={color} fontWeight="medium">Actual: {formatDuration(actual)}</Text>;
                        })()}
                      </HStack>
                      );
                    })()}
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
                    {/* Followup attachments */}
                    {isFollowup && ((occ as any).followupClients?.length > 0 || (occ as any).followupJobs?.length > 0) && (
                      <Box p={2} bg="red.50" rounded="md" fontSize="xs">
                        {(occ as any).followupClients?.length > 0 && (
                          <Box mb={(occ as any).followupJobs?.length > 0 ? 1 : 0}>
                            <Text fontWeight="medium" mb={0.5}>Clients:</Text>
                            <Box display="flex" gap="4px" flexWrap="wrap">
                              {(occ as any).followupClients.map((fc: any) => (
                                <Badge key={fc.client.id} colorPalette="red" variant="subtle" fontSize="xs" px="2" borderRadius="full" cursor={forAdmin ? "pointer" : undefined} _hover={forAdmin ? { opacity: 0.8 } : undefined} onClick={forAdmin ? () => openEventSearch("jobsTabToClientsTabSearch", fc.client.displayName, forAdmin, fc.client.id) : undefined}>
                                  {fc.client.displayName}
                                </Badge>
                              ))}
                            </Box>
                          </Box>
                        )}
                        {(occ as any).followupJobs?.length > 0 && (
                          <Box>
                            <Text fontWeight="medium" mb={0.5}>Job Services:</Text>
                            <Box display="flex" gap="4px" flexWrap="wrap">
                              {(occ as any).followupJobs.map((fj: any) => (
                                <Badge key={fj.job.id} colorPalette="red" variant="subtle" fontSize="xs" px="2" borderRadius="full" cursor={forAdmin ? "pointer" : undefined} _hover={forAdmin ? { opacity: 0.8 } : undefined} onClick={forAdmin ? () => openEventSearch("jobsTabToServicesTabSearch", fj.job.property?.displayName ?? "", true, `${fj.job.id}:`) : undefined}>
                                  {fj.job.property?.displayName ?? "Job"}{fj.job.property?.client?.displayName ? ` — ${fj.job.property.client.displayName}` : ""}
                                </Badge>
                              ))}
                            </Box>
                          </Box>
                        )}
                      </Box>
                    )}
                    {/* Admin client tags (expanded) */}
                    {forAdmin && !isTaskOrReminder && (() => {
                      const tags = parseAdminTags((occ.job?.property?.client as any)?.adminTags);
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
                    {(() => {
                      // Split notes: lines starting with "Accepted:" are accept comments
                      const raw = occ.notes ?? "";
                      const lines = raw.split("\n");
                      const acceptLines = lines.filter((l) => l.startsWith("Accepted:"));
                      const otherLines = lines.filter((l) => !l.startsWith("Accepted:")).join("\n").trim();
                      const acceptComment = acceptLines.map((l) => l.replace(/^Accepted:\s*/, "")).join("\n").trim();
                      return (
                        <>
                          {otherLines && (
                            <HStack gap={1} align="center">
                              <TruncatedText color="fg.muted">{otherLines}</TruncatedText>
                              {isTaskOrReminder && (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  px="1"
                                  minW="0"
                                  flexShrink={0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(otherLines);
                                    publishInlineMessage({ type: "SUCCESS", text: "Copied!" });
                                  }}
                                  title="Copy notes"
                                >
                                  <Copy size={12} style={{ display: "block" }} />
                                </Button>
                              )}
                            </HStack>
                          )}
                          {occ.proposalNotes && (
                            <Box p={2} bg="purple.50" rounded="sm" mt={1}>
                              <Text fontSize="xs" fontWeight="medium" color="purple.700">Completed:</Text>
                              <TruncatedText color="purple.600">{occ.proposalNotes}</TruncatedText>
                              {occ.proposalAmount != null && occ.proposalAmount > 0 && (
                                <Text fontSize="xs" color="purple.600" mt={0.5}>Amount: ${occ.proposalAmount.toFixed(2)}</Text>
                              )}
                            </Box>
                          )}
                          {(occ.status === "ACCEPTED" || acceptComment) && (
                            <Box p={2} bg="green.50" rounded="sm" mt={1}>
                              <Text fontSize="xs" fontWeight="medium" color="green.700">Accepted{acceptComment ? ":" : ""}</Text>
                              {acceptComment && <TruncatedText color="green.600">{acceptComment}</TruncatedText>}
                            </Box>
                          )}
                        </>
                      );
                    })()}
                    {occ.rejectionReason && (
                      <Box p={2} bg="red.50" rounded="sm" mt={1}>
                        <Text fontSize="xs" fontWeight="medium" color="red.700">Rejected:</Text>
                        <TruncatedText color="red.600">{occ.rejectionReason}</TruncatedText>
                      </Box>
                    )}
                    {occ.status === "REJECTED" && !occ.rejectionReason && (
                      <Box p={2} bg="red.50" rounded="sm" mt={1}>
                        <Text fontSize="xs" fontWeight="medium" color="red.700">Rejected</Text>
                      </Box>
                    )}
                    {forAdmin && occ.generatedEstimateBreakdown && (
                      <Box p={2} bg="gray.50" rounded="sm" mt={1} borderWidth="1px" borderColor="gray.200">
                        <HStack gap={1} mb={1}>
                          <Text fontSize="xs" fontWeight="medium" color="gray.700">Cost Breakdown</Text>
                          <Badge size="sm" colorPalette="orange" variant="subtle">Internal</Badge>
                        </HStack>
                        <TruncatedText color="gray.600" whiteSpace="pre-wrap">{occ.generatedEstimateBreakdown}</TruncatedText>
                      </Box>
                    )}
                    {forAdmin && occ.generatedEstimate && (
                      <Box p={2} bg="blue.50" rounded="sm" mt={1}>
                        <HStack justify="space-between" mb={1}>
                          <HStack gap={1}>
                            <Text fontSize="xs" fontWeight="medium" color="blue.700">Client Message</Text>
                            <Badge size="sm" colorPalette="orange" variant="subtle">AI Generated</Badge>
                          </HStack>
                          <Button
                            size="xs"
                            variant="ghost"
                            colorPalette="blue"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(occ.generatedEstimate!);
                              publishInlineMessage({ type: "SUCCESS", text: "Client message copied to clipboard." });
                            }}
                          >
                            Copy
                          </Button>
                        </HStack>
                        <TruncatedText color="blue.600" whiteSpace="pre-wrap">{occ.generatedEstimate}</TruncatedText>
                      </Box>
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

                    {!isUnassigned && (
                      <VStack align="start" gap={0}>
                        {assignees.map((a) => {
                          const isClaimer = a.assignedById === a.userId;
                          const isMe = a.userId === myId;
                          return (
                            <Text
                              key={a.userId}
                              fontSize="xs"
                              fontWeight={isMe ? "semibold" : "normal"}
                              color={isMe ? "teal.600" : "fg.muted"}
                            >
                              <span
                                style={{ cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }}
                                onClick={(e) => { e.stopPropagation(); navigateToProfile(a.userId, !!forAdmin); }}
                              >
                                {a.user?.displayName ?? a.user?.email ?? a.userId}
                              </span>
                              {a.user?.workerType ? ` · ${a.user.workerType === "CONTRACTOR" ? "1099" : a.user.workerType === "TRAINEE" ? "Trainee" : "W-2"}` : ""}
                              {isMe ? " (you)" : ""}
                              {isClaimer ? " · Claimer - Lead Worker" : a.role === "observer" ? " · Observer" : " · Worker"}
                            </Text>
                          );
                        })}
                      </VStack>
                    )}
                    {isUnassigned && !isEvent && !isFollowup && !isAnnouncement && occ.status !== "ARCHIVED" && (
                      <Text fontSize="xs" color="orange.500" fontWeight="medium">
                        {isTentative
                          ? "Unclaimed — tentative, awaiting admin confirmation"
                          : isAdminOnlyOcc
                          ? "Unclaimed — administered, must be assigned by an admin"
                          : "Unclaimed — available to claim"}
                      </Text>
                    )}
                    {occ.payment && (() => {
                      const pay = occ.payment as any;
                      const expTotal = (occ.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                      const fee = pay.platformFeeAmount ?? 0;
                      const margin = pay.businessMarginAmount ?? 0;
                      const splitTotal = (pay.splits ?? []).reduce((s: number, sp: any) => s + sp.amount, 0);
                      const feeableSplitTotal = (pay.splits ?? []).filter((sp: any) => sp.user?.workerType !== "EMPLOYEE" && sp.user?.workerType !== "TRAINEE").reduce((s: number, sp: any) => s + sp.amount, 0);
                      const employeeSplitTotal = (pay.splits ?? []).filter((sp: any) => sp.user?.workerType === "EMPLOYEE" || sp.user?.workerType === "TRAINEE").reduce((s: number, sp: any) => s + sp.amount, 0);
                      return (
                        <Box mt={1} p={2} bg="green.50" rounded="sm">
                          <Text fontSize="xs" fontWeight="medium" color="green.700">
                            Paid: ${pay.amountPaid.toFixed(2)} via {prettyStatus(pay.method)}
                          </Text>
                          {pay.note && (
                            <Text fontSize="xs" color="green.600">{pay.note}</Text>
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

                    {/* Expenses */}
                    {occ.expenses && occ.expenses.length > 0 && (
                      <Box mt={1} p={1} bg="orange.50" rounded="sm" w="full">
                        <Text fontSize="xs" fontWeight="medium" color="orange.700">
                          Expenses: ${occ.expenses.reduce((s, e) => s + e.cost, 0).toFixed(2)}
                        </Text>
                        <VStack align="start" gap={0} mt={0.5}>
                          {occ.expenses.map((exp) => (
                            <HStack key={exp.id} gap={1} w="full">
                              <Text fontSize="xs" color="orange.600" flex="1">
                                ${exp.cost.toFixed(2)} — {exp.description}
                              </Text>
                              {isClaimer && occ.status !== "CLOSED" && (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  colorPalette="red"
                                  disabled={isOffline}
                                  onClick={() => deleteExpense(exp.id)}
                                >
                                  ✕
                                </Button>
                              )}
                            </HStack>
                          ))}
                        </VStack>
                      </Box>
                    )}
                    {!isTaskOrReminder && ((occ._count?.photos ?? 0) > 0 || isActiveAssignee) && (
                      <OccurrencePhotos
                        occurrenceId={occ.id}
                        isAdmin={forAdmin}
                        canUpload={isActiveAssignee}
                        photoCount={occ._count?.photos ?? 0}
                      />
                    )}

                    {occ.linkGroupId && (() => {
                      // Find other occurrences in the same link group from the loaded items
                      const linked = items.filter((o) => o.linkGroupId === occ.linkGroupId && o.id !== occ.id);
                      if (linked.length === 0) return null;
                      return (
                        <Box mt={1} p={2} bg="purple.50" rounded="md">
                          <Text fontSize="xs" fontWeight="medium" color="purple.700">
                            <Link2 size={10} style={{ display: "inline", verticalAlign: "middle", marginRight: 3 }} />
                            Linked occurrences:
                          </Text>
                          <HStack gap={1} mt={1} wrap="wrap">
                            {linked.map((lo) => (
                              <Badge
                                key={lo.id}
                                colorPalette="purple"
                                variant="subtle"
                                fontSize="xs"
                                px="2"
                                borderRadius="full"
                                cursor="pointer"
                                onClick={(e: any) => {
                                  e.stopPropagation();
                                  // Clear first to force re-render even if clicking back to a previous highlight
                                  setHighlightOccId(null);
                                  requestAnimationFrame(() => {
                                    setHighlightOccId(lo.id);
                                    setExpandedCards(new Set([lo.id]));
                                    setFilterJobId(null);
                                    setQ("");
                                  });
                                }}
                              >
                                {lo.startAt ? fmtDate(lo.startAt) : "No date"}
                                {lo.job?.property?.displayName ? ` · ${lo.job.property.displayName}` : ""}
                                {parseJobTags(lo).length > 0 && ` · ${parseJobTags(lo).map(jobTagLabel).join(", ")}`}{(lo as any).jobType && ` · Custom`}
                              </Badge>
                            ))}
                          </HStack>
                        </Box>
                      );
                    })()}

                    {/* Comments section */}
                    <Box w="full" mt={2} data-comments={occ.id}>
                      <Badge
                        variant="solid"
                        fontSize="xs"
                        px="2"
                        borderRadius="full"
                        cursor="pointer"
                        bg={commentBadgeBg}
                        color={commentBadgeColor}
                        onClick={(e: any) => { e.stopPropagation(); toggleComments(occ.id); }}
                      >
                        <MessageCircle size={11} style={{ marginRight: 3 }} />
                        Comments ({occ._count?.comments ?? 0}) {commentsOpenFor.has(occ.id) ? "▼" : "▶"}
                      </Badge>
                      {commentsOpenFor.has(occ.id) && (
                        <VStack align="stretch" gap={2} mt={2}>
                          {(commentsCache[occ.id] ?? []).length === 0 && !commentBusy && (
                            <Text fontSize="xs" color="fg.muted">No comments yet.</Text>
                          )}
                          {(commentsCache[occ.id] ?? []).map((c) => (
                            <Box key={c.id} p={2} bg={commentBadgeBg} color={commentBadgeColor} rounded="md" fontSize="xs">
                              <HStack justifyContent="space-between" alignItems="center">
                                <Text fontWeight="semibold">
                                  {c.author.displayName ?? c.author.email ?? "Unknown"}
                                </Text>
                                <Text color="fg.muted" fontSize="xs">{fmtDateTime(c.createdAt)}</Text>
                              </HStack>
                              {commentEditing?.id === c.id ? (
                                <VStack align="stretch" gap={1} mt={1}>
                                  <input
                                    type="text"
                                    value={commentEditing.body}
                                    onChange={(e) => setCommentEditing({ id: c.id, body: e.target.value })}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{ fontSize: "12px", padding: "4px 8px", border: "1px solid #ccc", borderRadius: 4, width: "100%" }}
                                  />
                                  <HStack gap={1}>
                                    <Button size="xs" variant="solid" colorPalette="blue" disabled={isOffline || commentBusy || !commentEditing.body.trim()} onClick={(e: any) => { e.stopPropagation(); void editComment(c.id, occ.id, commentEditing.body); }}>
                                      Save
                                    </Button>
                                    <Button size="xs" variant="ghost" onClick={(e: any) => { e.stopPropagation(); setCommentEditing(null); }}>
                                      Cancel
                                    </Button>
                                  </HStack>
                                </VStack>
                              ) : (
                                <>
                                  <Text mt={1}>{c.body}</Text>
                                  <HStack gap={1} mt={1}>
                                    {c.author.id === myId && (
                                      <Button size="xs" variant="ghost" disabled={isOffline} onClick={(e: any) => { e.stopPropagation(); setCommentEditing({ id: c.id, body: c.body }); }}>
                                        Edit
                                      </Button>
                                    )}
                                    {(c.author.id === myId || isClaimer || (forAdmin && (isAdmin || isSuper))) && (
                                      <Button size="xs" variant="ghost" colorPalette="red" disabled={isOffline || commentBusy} onClick={(e: any) => { e.stopPropagation(); void deleteComment(c.id, occ.id); }}>
                                        Delete
                                      </Button>
                                    )}
                                  </HStack>
                                </>
                              )}
                            </Box>
                          ))}
                          {/* New comment input */}
                          <HStack gap={1} mt={1}>
                            <input
                              type="text"
                              placeholder="Write a comment…"
                              value={commentDraft[occ.id] ?? ""}
                              onChange={(e) => setCommentDraft((prev) => ({ ...prev, [occ.id]: e.target.value }))}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); void postComment(occ.id); } }}
                              style={{ flex: 1, fontSize: "12px", padding: "4px 8px", border: "1px solid #ccc", borderRadius: 4 }}
                            />
                            <Button size="xs" variant="solid" colorPalette="blue" disabled={commentBusy || !(commentDraft[occ.id] ?? "").trim()} onClick={(e: any) => { e.stopPropagation(); void postComment(occ.id); }}>
                              Post
                            </Button>
                          </HStack>
                        </VStack>
                      )}
                    </Box>
                  </VStack>
                </Card.Body>
                )}

                {!isCardCompact && !isTrainee && (isUnassigned || isActiveAssignee || (forAdmin && (isAdmin || isSuper))) && !isTentative && (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS" || occ.status === "PENDING_PAYMENT" || occ.status === "PROPOSAL_SUBMITTED") && (
                  <Card.Footer py="3" px="4" pt="0">
                    <VStack align="start" gap={2} mb="2">
                    {/* Confirm client — must happen before Start */}
                    {needsConfirmation && (isClaimer || (forAdmin && (isAdmin || isSuper))) && (
                      <Button
                        size="sm"
                        variant="solid"
                        colorPalette="orange"
                        disabled={isOffline}
                        onClick={() => {
                          setConfirmAction({
                            title: "Confirm Client?",
                            message: "Have you confirmed with the client that this job is good to go?",
                            confirmLabel: "Yes, Confirmed",
                            colorPalette: "orange",
                            onConfirm: async () => {
                              try {
                                await apiPost(`/api/occurrences/${occ.id}/confirm`);
                                setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, isClientConfirmed: true } as any : o));
                                publishInlineMessage({ type: "SUCCESS", text: "Client confirmed." });
                              } catch (err) {
                                publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to confirm.", err) });
                              }
                            },
                          });
                        }}
                      >
                        Confirm Client
                      </Button>
                    )}
                    {/* Primary action — Start / Complete / Accept Payment */}
                    {(isClaimer || forAdmin) && !isTaskOrReminder && occ.status === "SCHEDULED" && !isTentative && !needsConfirmation && (
                      <Button
                        size="sm"
                        variant="solid"
                        colorPalette="blue"
                        onClick={() => {
                          if (isOffline) {
                            void (async () => {
                              await enqueueAction("START_JOB", occ.id, queueLabel(occ, "Start job"), { notes: undefined, lat: null, lng: null });
                              setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, status: "IN_PROGRESS" as any, startedAt: new Date().toISOString() } : o));
                              publishInlineMessage({ type: "INFO", text: "Job started (queued for sync)." });
                            })();
                            return;
                          }
                          const now = new Date();
                          const pad = (n: number) => String(n).padStart(2, "0");
                          setStartJobTime(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`);
                          setStartJobOcc(occ);
                        }}
                      >
                        Start Job
                      </Button>
                    )}
                    {(isClaimer || forAdmin) && occ.status === "IN_PROGRESS" && (occ.workflow !== "ESTIMATE" && !occ.isEstimate) && (
                      <Button size="sm" variant="solid" colorPalette="blue" onClick={() => setCompleteDialogOcc(occ)}>
                        Complete Job
                      </Button>
                    )}
                    {(isClaimer || forAdmin) && occ.status === "IN_PROGRESS" && (occ.workflow === "ESTIMATE" || occ.isEstimate) && (
                      <Button
                        size="sm"
                        variant="solid"
                        colorPalette="blue"
                        disabled={isOffline}
                        onClick={() => setConfirmAction({
                          title: "Complete Estimate?",
                          message: "Add any comments about this estimate (optional):",
                          confirmLabel: "Complete",
                          colorPalette: "purple",
                          inputLabel: "Comments",
                          inputPlaceholder: "Notes about this estimate...",
                          inputOptional: true,
                          inputDefaultValue: occ.proposalNotes ?? "",
                          onConfirm: (comments: string) => void completeEstimate(occ.id, comments),
                        })}
                      >
                        Complete Estimate
                      </Button>
                    )}
                    {(isClaimer || forAdmin) && occ.status === "PENDING_PAYMENT" && occ.workflow !== "ESTIMATE" && !occ.isEstimate && (<>
                      {occ.workflow === "STANDARD" && !occ.isOneOff && !occ.frequencyDays && !(occ.job as any)?.frequencyDays && (
                        <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md">
                          <Text fontSize="xs" color="yellow.800">
                            This is a repeating job but has no frequency set. Accepting payment will NOT create a next occurrence.
                          </Text>
                        </Box>
                      )}
                      <Button
                        size="sm"
                        variant="solid"
                        colorPalette="green"
                        disabled={isOffline}
                        onClick={() => { setAcceptPaymentOcc(occ); setAcceptPaymentOpen(true); }}
                      >
                        Accept Payment
                      </Button>
                    </>)}
                    {(isClaimer || forAdmin) && occ.status === "PROPOSAL_SUBMITTED" && (occ.workflow === "ESTIMATE" || occ.isEstimate) && (
                      <HStack gap={2}>
                        <Button
                          size="sm"
                          variant="solid"
                          colorPalette="blue"
                          disabled={isOffline}
                          onClick={() => setConfirmAction({
                            title: "Accept Estimate?",
                            message: "Add a comment:",
                            confirmLabel: "Accept",
                            colorPalette: "green",
                            inputPlaceholder: "Comment...",
                            inputLabel: "Comment",
                            onConfirm: async (comment: string) => {
                              try {
                                const result = await apiPost<{ accepted: boolean; jobId: string; occurrence: any }>(`/api/occurrences/${occ.id}/accept-estimate`, { comment: comment || undefined });
                                publishInlineMessage({ type: "SUCCESS", text: "Estimate accepted." });
                                await load(false);
                                if (!result.jobId) {
                                  setPendingEstimateConvert({
                                    occurrenceId: occ.id,
                                    contactName: occ.contactName,
                                    contactPhone: occ.contactPhone,
                                    contactEmail: occ.contactEmail,
                                    estimateAddress: occ.estimateAddress,
                                    proposalAmount: occ.proposalAmount,
                                    proposalNotes: occ.proposalNotes,
                                    title: occ.title,
                                    estimatedMinutes: occ.estimatedMinutes,
                                  });
                                } else if (result.jobId) {
                                  setPromptOccDefaults({
                                    notes: result.occurrence?.notes ?? null,
                                    price: result.occurrence?.price ?? null,
                                    estimatedMinutes: result.occurrence?.estimatedMinutes ?? null,
                                  });
                                  setPromptOccJobId(result.jobId);
                                }
                              } catch (err: any) {
                                publishInlineMessage({ type: "ERROR", text: getErrorMessage("Accept failed.", err) });
                              }
                            },
                          })}
                        >
                          Accept Estimate
                        </Button>
                        <Button
                          size="sm"
                          variant="solid"
                          colorPalette="red"
                          disabled={isOffline}
                          onClick={() => setConfirmAction({
                            title: "Reject Estimate?",
                            message: "Add a reason:",
                            confirmLabel: "Reject",
                            colorPalette: "red",
                            inputPlaceholder: "Reason...",
                            inputLabel: "Reason",
                            onConfirm: async (reason: string) => {
                              try {
                                await apiPost(`/api/occurrences/${occ.id}/reject-estimate`, { reason: reason || undefined });
                                publishInlineMessage({ type: "SUCCESS", text: "Estimate rejected." });
                                await load(false);
                              } catch (err: any) {
                                publishInlineMessage({ type: "ERROR", text: getErrorMessage("Reject failed.", err) });
                              }
                            },
                          })}
                        >
                          Reject Estimate
                        </Button>
                      </HStack>
                    )}
                    {isTask && occ.status === "SCHEDULED" && (
                      <Button
                        size="sm"
                        variant="solid"
                        colorPalette="blue"
                        disabled={isOffline}
                        title={isOffline ? "Requires internet" : undefined}
                        onClick={async () => {
                          try {
                            await apiPost(`/api/tasks/${occ.id}/close`);
                            publishInlineMessage({ type: "SUCCESS", text: "Task completed." });
                            await load(false);
                          } catch (err) {
                            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to complete task.", err) });
                          }
                        }}
                      >
                        Complete
                      </Button>
                    )}
                    {isUnassigned && !isAdminOnlyOcc && !isTaskOrReminder && (() => {
                      const isContractor = me?.workerType === "CONTRACTOR";
                      const jobDate = occ.startAt ? new Date(occ.startAt) : null;
                      const now = new Date();
                      const daysAhead = jobDate ? Math.ceil((jobDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 0;
                      const contractorBlocked = isContractor && daysAhead > 2;
                      if (contractorBlocked) {
                        return (
                          <Text fontSize="xs" color="orange.500">
                            Contractors can only claim jobs within 2 days. This job is {daysAhead} days out.
                          </Text>
                        );
                      }
                      return (
                        <Button
                          size="sm"
                          variant="solid"
                          colorPalette="yellow"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={() => void claim(occ.id)}
                        >
                          Claim
                        </Button>
                      );
                    })()}
                    <HStack gap={2} wrap="wrap">
                      {/* Task edit/delete buttons */}
                      {isTask && occ.status === "SCHEDULED" && (<>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={() => {
                            setEditingTask(occ);
                            setTaskDialogOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          colorPalette="red"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={async () => {
                            setConfirmAction({
                              title: "Delete Task?",
                              message: `Are you sure you want to delete "${occ.title}"?`,
                              confirmLabel: "Delete",
                              colorPalette: "red",
                              onConfirm: async () => {
                                try {
                                  await apiDelete(`/api/tasks/${occ.id}`);
                                  publishInlineMessage({ type: "SUCCESS", text: "Task deleted." });
                                  await load(false);
                                } catch (err) {
                                  publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete task.", err) });
                                }
                              },
                            });
                          }}
                        >
                          Delete
                        </Button>
                      </>)}
                      {/* Reminder dismiss/edit/delete buttons */}
                      {isReminder && occ.status === "SCHEDULED" && (<>
                        <Button
                          size="sm"
                          variant="solid"
                          colorPalette="purple"
                          onClick={async () => {
                            if (isOffline) {
                              await enqueueAction("DISMISS_REMINDER", occ.id, queueLabel(occ, "Dismiss reminder"), {});
                              setItems((prev) => prev.filter((o) => o.id !== occ.id));
                              publishInlineMessage({ type: "INFO", text: "Dismiss queued for sync." });
                              return;
                            }
                            try {
                              await apiPost(`/api/standalone-reminders/${occ.id}/dismiss`);
                              publishInlineMessage({ type: "SUCCESS", text: "Reminder dismissed." });
                              await load(false);
                            } catch (err) {
                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to dismiss reminder.", err) });
                            }
                          }}
                        >
                          Dismiss
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={() => {
                            setEditingReminder(occ);
                            setStandaloneReminderDialogOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          colorPalette="red"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={async () => {
                            setConfirmAction({
                              title: "Delete Reminder?",
                              message: `Are you sure you want to delete "${occ.title}"?`,
                              confirmLabel: "Delete",
                              colorPalette: "red",
                              onConfirm: async () => {
                                try {
                                  await apiDelete(`/api/standalone-reminders/${occ.id}`);
                                  publishInlineMessage({ type: "SUCCESS", text: "Reminder deleted." });
                                  await load(false);
                                } catch (err) {
                                  publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete reminder.", err) });
                                }
                              },
                            });
                          }}
                        >
                          Delete
                        </Button>
                      </>)}
                      {/* Event complete/edit/delete buttons — admin only */}
                      {isEvent && occ.status === "SCHEDULED" && (isAdmin || isSuper) && (<>
                        <Button
                          size="sm"
                          variant="solid"
                          colorPalette="yellow"
                          disabled={isOffline}
                          onClick={async () => {
                            try {
                              await apiPost(`/api/admin/events/${occ.id}/complete`);
                              publishInlineMessage({ type: "SUCCESS", text: "Event completed." });
                              await load(false);
                            } catch (err) {
                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to complete event.", err) });
                            }
                          }}
                        >
                          Complete
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isOffline}
                          onClick={() => {
                            setEditingEvent(occ);
                            setEventDialogOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          colorPalette="red"
                          disabled={isOffline}
                          onClick={() => {
                            setConfirmAction({
                              title: "Delete Event?",
                              message: `Are you sure you want to delete "${occ.title}"?`,
                              confirmLabel: "Delete",
                              colorPalette: "red",
                              onConfirm: async () => {
                                try {
                                  await apiDelete(`/api/admin/events/${occ.id}`);
                                  publishInlineMessage({ type: "SUCCESS", text: "Event deleted." });
                                  await load(false);
                                } catch (err) {
                                  publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete event.", err) });
                                }
                              },
                            });
                          }}
                        >
                          Delete
                        </Button>
                      </>)}
                      {/* Followup complete/edit/delete buttons — admin only */}
                      {isFollowup && occ.status === "SCHEDULED" && (isAdmin || isSuper) && (<>
                        <Button
                          size="sm"
                          variant="solid"
                          colorPalette="red"
                          disabled={isOffline}
                          onClick={async () => {
                            try {
                              await apiPost(`/api/admin/followups/${occ.id}/complete`);
                              publishInlineMessage({ type: "SUCCESS", text: "Followup completed." });
                              await load(false);
                            } catch (err) {
                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to complete followup.", err) });
                            }
                          }}
                        >
                          Complete
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isOffline}
                          onClick={() => {
                            setEditingFollowup(occ);
                            setFollowupDialogOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          colorPalette="red"
                          disabled={isOffline}
                          onClick={() => {
                            setConfirmAction({
                              title: "Delete Followup?",
                              message: `Are you sure you want to delete "${occ.title}"?`,
                              confirmLabel: "Delete",
                              colorPalette: "red",
                              onConfirm: async () => {
                                try {
                                  await apiDelete(`/api/admin/followups/${occ.id}`);
                                  publishInlineMessage({ type: "SUCCESS", text: "Followup deleted." });
                                  await load(false);
                                } catch (err) {
                                  publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete followup.", err) });
                                }
                              },
                            });
                          }}
                        >
                          Delete
                        </Button>
                      </>)}
                      {/* Announcement complete/edit/delete buttons — admin only */}
                      {isAnnouncement && forAdmin && (isAdmin || isSuper) && (<>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isOffline}
                          onClick={() => {
                            setEditingAnnouncement(occ);
                            setAnnouncementDialogOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          colorPalette="red"
                          disabled={isOffline}
                          onClick={() => {
                            setConfirmAction({
                              title: "Delete Announcement?",
                              message: `Are you sure you want to delete "${occ.title}"?`,
                              confirmLabel: "Delete",
                              colorPalette: "red",
                              onConfirm: async () => {
                                try {
                                  await apiDelete(`/api/admin/announcements/${occ.id}`);
                                  publishInlineMessage({ type: "SUCCESS", text: "Announcement deleted." });
                                  await load(false);
                                } catch (err) {
                                  publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete announcement.", err) });
                                }
                              },
                            });
                          }}
                        >
                          Delete
                        </Button>
                      </>)}
                      {/* Light estimate edit/delete */}
                      {isLightEstimate && (isClaimer || isAdmin || isSuper) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={() => {
                            setEditingLightEstimate(occ);
                            setLightEstDialogOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                      )}
                      {isLightEstimate && (isClaimer || isAdmin || isSuper) && (
                        <Button
                          size="sm"
                          variant="outline"
                          colorPalette="red"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={() => {
                            setConfirmAction({
                              title: "Delete Estimate?",
                              message: `Are you sure you want to delete "${occ.title}"?`,
                              confirmLabel: "Delete",
                              colorPalette: "red",
                              onConfirm: async () => {
                                try {
                                  await apiDelete(`/api/light-estimates/${occ.id}`);
                                  publishInlineMessage({ type: "SUCCESS", text: "Estimate deleted." });
                                  await load(false);
                                } catch (err) {
                                  publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete estimate.", err) });
                                }
                              },
                            });
                          }}
                        >
                          Delete
                        </Button>
                      )}
                      {(isClaimer || forAdmin) && !isTaskOrReminder && occ.status === "SCHEDULED" && !isTentative && !isOffline && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRescheduleOcc(occ);
                            setRescheduleDate(occ.startAt ? bizDateKey(occ.startAt) : bizDateKey(new Date()));
                            setRescheduleReason("");
                          }}
                        >
                          Reschedule
                        </Button>
                      )}
                      {forAdmin && (occ.workflow === "ESTIMATE" || occ.isEstimate) && (
                        <StatusButton
                          id="occ-generate-estimate"
                          itemId={occ.id}
                          label={occ.generatedEstimate ? "Regenerate Estimate" : "Generate Estimate"}
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={async () => {
                            try {
                              publishInlineMessage({ type: "WARNING", text: "Generating AI estimate — please review before sending to the client." });
                              const res = await apiPost<{ estimate: string; breakdown?: string }>(`/api/admin/occurrences/${occ.id}/generate-estimate`);
                              publishInlineMessage({ type: "SUCCESS", text: "AI estimate generated. Review carefully before sharing with the client." });
                              // Update the occurrence in local state
                              setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, generatedEstimate: res.estimate, generatedEstimateBreakdown: res.breakdown ?? null } : o));
                            } catch (err: any) {
                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Estimate generation failed.", err) });
                            }
                          }}
                          variant="outline"
                          colorPalette="blue"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {!isAnnouncement && (isClaimer || (forAdmin && (isAdmin || isSuper))) && occ.status !== "PENDING_PAYMENT" && (
                        <StatusButton
                          id="occ-manage-team"
                          itemId={occ.id}
                          label="Manage Team"
                          onClick={async () => {
                            setManageOccurrence(occ);
                            setManageOpen(true);
                          }}
                          variant="outline"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {!isTaskOrReminder && (isClaimer || (forAdmin && (isAdmin || isSuper))) && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={isOffline}
                          onClick={() => {
                            setPinnedNoteOcc(occ);
                            setPinnedNoteDialogOpen(true);
                          }}
                        >
                          📌 {(occ as any).pinnedNote ? "Edit Instruction" : "Add Instruction"}
                        </Button>
                      )}
                      {isClaimer && !isTaskOrReminder && (
                        <StatusButton
                          id="occ-add-expense"
                          itemId={occ.id}
                          label="Expenses"
                          onClick={async () => setExpenseDialogOccId(occ.id)}
                          variant="outline"
                          colorPalette="orange"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isClaimer && !isTaskOrReminder && occ.status !== "PENDING_PAYMENT" && (
                        <StatusButton
                          id="occ-unclaim"
                          itemId={occ.id}
                          label="Unclaim"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={async () => setConfirmAction({
                            title: "Unclaim Job?",
                            message: "Are you sure you want to unclaim this job?",
                            confirmLabel: "Unclaim",
                            colorPalette: "red",
                            onConfirm: () => void unclaim(occ.id),
                          })}
                          variant="outline"
                          colorPalette="red"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isWorkerView && !occ.reminder && (
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="orange"
                          onClick={() => {
                            setReminderDialogOccId(occ.id);
                            setReminderDate("");
                            setReminderNote("");
                          }}
                        >
                          <Bell size={12} /> Set Reminder
                        </Button>
                      )}
                      {isWorkerView && occ.reminder && (
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="gray"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={() => void clearReminder(occ.id)}
                        >
                          <BellOff size={12} /> Clear Reminder
                        </Button>
                      )}
                    </HStack>
                    </VStack>
                  </Card.Footer>
                )}

                {/* Secondary footer: task/reminder reopen + reminder buttons when the regular footer doesn't show */}
                {(isWorkerView || ((isAdmin || isSuper) && isTaskOrReminder)) && !isCardCompact && !(
                  !isTrainee && (isUnassigned || isActiveAssignee || (forAdmin && (isAdmin || isSuper))) && !isTentative &&
                  (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS" || occ.status === "PENDING_PAYMENT" || occ.status === "PROPOSAL_SUBMITTED")
                ) && (
                  <Card.Footer py="3" px="4" pt="0">
                    <HStack gap={2} wrap="wrap">
                      {/* Task reopen */}
                      {isTask && occ.status === "CLOSED" && (
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="blue"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={async () => {
                            try {
                              await apiPost(`/api/tasks/${occ.id}/reopen`);
                              publishInlineMessage({ type: "SUCCESS", text: "Task reopened." });
                              await load(false);
                            } catch (err) {
                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to reopen task.", err) });
                            }
                          }}
                        >
                          Reopen Task
                        </Button>
                      )}
                      {/* Reminder reopen */}
                      {isReminder && occ.status === "CLOSED" && (
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="purple"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={async () => {
                            try {
                              await apiPost(`/api/standalone-reminders/${occ.id}/reopen`);
                              publishInlineMessage({ type: "SUCCESS", text: "Reminder reopened." });
                              await load(false);
                            } catch (err) {
                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to reopen reminder.", err) });
                            }
                          }}
                        >
                          Reopen Reminder
                        </Button>
                      )}
                      {!occ.reminder ? (
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="orange"
                          onClick={() => {
                            setReminderDialogOccId(occ.id);
                            setReminderDate("");
                            setReminderNote("");
                          }}
                        >
                          <Bell size={12} /> Set Reminder
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="gray"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={() => void clearReminder(occ.id)}
                        >
                          <BellOff size={12} /> Clear Reminder
                        </Button>
                      )}
                    </HStack>
                  </Card.Footer>
                )}
                {/* Pinned instruction banner — bottom of card */}
                {(occ as any).pinnedNote && (
                  <Box mx="4" mb="3" mt="0" px="3" py="1.5" bg="yellow.100" borderWidth="1px" borderColor="yellow.400" borderRadius="md">
                    <Text fontSize="xs" fontWeight="semibold" color="yellow.700">
                      📌 {(occ as any).pinnedNote}
                      {!(occ as any).pinnedNoteRepeats && <Text as="span" fontWeight="normal" fontStyle="italic"> (this time only)</Text>}
                    </Text>
                  </Box>
                )}
              </Card.Root>
            );
          })}
              </VStack>}
            </Box>
          ))}
        </VStack>
      </Box>

      {manageOccurrence && (
        <AddAssigneeDialog
          open={manageOpen}
          onOpenChange={(open) => {
            setManageOpen(open);
            if (!open) void load(false);
          }}
          occurrenceId={manageOccurrence.id}
          myId={me?.id || ""}
          currentAssignees={(manageOccurrence.assignees ?? []).map((a) => ({
            userId: a.userId,
            role: a.role,
            user: a.user,
          }))}
          onChanged={() => void load(false)}
          isAdmin={forAdmin && (isAdmin || isSuper)}
        />
      )}


      {/* Photo viewer for compact card thumbnails */}
      {viewerPhotos.length > 0 && (
        <Box
          position="fixed"
          inset="0"
          zIndex={10000}
          bg="blackAlpha.800"
          display="flex"
          alignItems="center"
          justifyContent="center"
          onClick={() => setViewerPhotos([])}
          onTouchStart={(e) => { (e.currentTarget as any)._touchX = e.touches[0].clientX; }}
          onTouchEnd={(e) => {
            const dx = e.changedTouches[0].clientX - ((e.currentTarget as any)._touchX ?? 0);
            if (Math.abs(dx) > 50) {
              e.stopPropagation();
              if (dx < 0) setViewerIndex((i) => Math.min(i + 1, viewerPhotos.length - 1));
              else setViewerIndex((i) => Math.max(i - 1, 0));
            }
          }}
        >
          {viewerIndex > 0 && (
            <Box
              position="absolute" left="3" top="50%" transform="translateY(-50%)"
              color="white" fontSize="2xl" cursor="pointer" p={2}
              onClick={(e) => { e.stopPropagation(); setViewerIndex((i) => i - 1); }}
              userSelect="none"
            >
              ◀
            </Box>
          )}
          <img
            src={viewerPhotos[viewerIndex]?.url}
            alt="Photo"
            style={{ maxWidth: "90vw", maxHeight: "85vh", objectFit: "contain", borderRadius: "8px" }}
            onClick={(e) => e.stopPropagation()}
          />
          {viewerIndex < viewerPhotos.length - 1 && (
            <Box
              position="absolute" right="3" top="50%" transform="translateY(-50%)"
              color="white" fontSize="2xl" cursor="pointer" p={2}
              onClick={(e) => { e.stopPropagation(); setViewerIndex((i) => i + 1); }}
              userSelect="none"
            >
              ▶
            </Box>
          )}
          <Text position="absolute" bottom="4" color="whiteAlpha.700" fontSize="sm">
            {viewerIndex + 1} / {viewerPhotos.length}
          </Text>
        </Box>
      )}

      <TaskDialog
        open={taskDialogOpen}
        onOpenChange={(o) => { setTaskDialogOpen(o); if (!o) setEditingTask(null); }}
        onCreated={() => void load(false)}
        editTask={editingTask}
      />

      <TaskDialog
        open={standaloneReminderDialogOpen}
        onOpenChange={(o) => { setStandaloneReminderDialogOpen(o); if (!o) setEditingReminder(null); }}
        onCreated={() => void load(false)}
        editTask={editingReminder}
        mode="reminder"
      />

      <EventDialog
        open={eventDialogOpen}
        onOpenChange={(o) => { setEventDialogOpen(o); if (!o) setEditingEvent(null); }}
        onCreated={() => void load(false)}
        editEvent={editingEvent}
      />

      {pinnedNoteOcc && (
        <PinnedNoteDialog
          open={pinnedNoteDialogOpen}
          onOpenChange={(o) => { setPinnedNoteDialogOpen(o); if (!o) setPinnedNoteOcc(null); }}
          occurrenceId={pinnedNoteOcc.id}
          currentNote={(pinnedNoteOcc as any).pinnedNote}
          currentRepeats={(pinnedNoteOcc as any).pinnedNoteRepeats ?? true}
          onSaved={(note, repeats) => {
            setItems((prev) => prev.map((o) => o.id === pinnedNoteOcc.id ? { ...o, pinnedNote: note, pinnedNoteRepeats: repeats } as any : o));
          }}
        />
      )}

      <AnnouncementDialog
        open={announcementDialogOpen}
        onOpenChange={(o) => { setAnnouncementDialogOpen(o); if (!o) setEditingAnnouncement(null); }}
        onCreated={() => void load(false)}
        editAnnouncement={editingAnnouncement}
      />

      <FollowupDialog
        open={followupDialogOpen}
        onOpenChange={(o) => { setFollowupDialogOpen(o); if (!o) setEditingFollowup(null); }}
        onCreated={() => void load(false)}
        editFollowup={editingFollowup}
      />

      {/* Pre-dialog before launching New Job Setup from accepted light estimate */}
      <ConfirmDialog
        open={!!pendingEstimateConvert}
        title="Create Job Service"
        message="This estimate has been accepted. The New Job Service workflow will now guide you through creating a Client, Property, and Job — pre-filled with details from this estimate."
        confirmLabel="Continue"
        confirmColorPalette="green"
        onConfirm={() => {
          const data = pendingEstimateConvert;
          setPendingEstimateConvert(null);
          window.dispatchEvent(new CustomEvent("trigger:newJobSetupFromEstimate", { detail: data }));
        }}
        onCancel={() => setPendingEstimateConvert(null)}
      />

      <LightEstimateDialog
        open={lightEstDialogOpen}
        onOpenChange={(open) => { setLightEstDialogOpen(open); if (!open) setEditingLightEstimate(null); }}
        onCreated={() => void load(false)}
        myId={me?.id}
        editEstimate={editingLightEstimate}
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

      {/* Set Reminder Dialog */}
      <Dialog.Root open={!!reminderDialogOccId} onOpenChange={(e) => { if (!e.open) setReminderDialogOccId(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm">
              <Dialog.Header>
                <Dialog.Title>Set Reminder</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Text fontSize="sm" color="fg.muted">When should you be reminded?</Text>
                  <HStack gap={2} wrap="wrap">
                    {[
                      { label: "Tomorrow", days: 1 },
                      { label: "In 3 days", days: 3 },
                      { label: "In 1 week", days: 7 },
                      { label: "In 2 weeks", days: 14 },
                      { label: "In 1 month", days: 30 },
                    ].map((opt) => (
                      <Button
                        key={opt.days}
                        size="xs"
                        variant={reminderDate === localDate((() => { const d = new Date(); d.setDate(d.getDate() + opt.days); return d; })()) ? "solid" : "outline"}
                        colorPalette="orange"
                        onClick={() => {
                          const d = new Date();
                          d.setDate(d.getDate() + opt.days);
                          setReminderDate(localDate(d));
                        }}
                      >
                        {opt.label}
                      </Button>
                    ))}
                  </HStack>
                  <HStack gap={2} align="center">
                    <Text fontSize="sm" flexShrink={0}>Or pick a date:</Text>
                    <DateInput value={reminderDate} onChange={setReminderDate} />
                  </HStack>
                  <Box>
                    <Text fontSize="sm" mb={1}>Note (optional)</Text>
                    <input
                      type="text"
                      placeholder="e.g., Follow up with client on pricing"
                      value={reminderNote}
                      onChange={(e) => setReminderNote(e.target.value)}
                      style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                    />
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="ghost" onClick={() => setReminderDialogOccId(null)}>Cancel</Button>
                <Button
                  colorPalette="orange"
                  disabled={!reminderDate}
                  onClick={() => {
                    if (reminderDialogOccId && reminderDate) {
                      void setReminder(reminderDialogOccId, reminderDate + "T13:00:00Z", reminderNote);
                      setReminderDialogOccId(null);
                    }
                  }}
                >
                  Set Reminder
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Start Job dialog */}
      <Dialog.Root open={!!startJobOcc} onOpenChange={(e) => { if (!e.open) setStartJobOcc(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm">
              <Dialog.Header>
                <Dialog.Title>Start Job</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Start time</Text>
                    <input
                      type="datetime-local"
                      value={startJobTime}
                      onChange={(e) => setStartJobTime(e.target.value)}
                      style={{ width: "100%", padding: "6px 10px", fontSize: "16px", border: "1px solid #ccc", borderRadius: "6px" }}
                    />
                  </Box>
                  {startJobOcc?.startAt && bizDateKey(startJobOcc.startAt) !== bizDateKey(new Date()) && (
                    <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" rounded="md">
                      <Text fontSize="xs" color="yellow.700">
                        This job is scheduled for {fmtDate(startJobOcc.startAt)}. Starting it now will update the date.
                      </Text>
                    </Box>
                  )}
                  <Text fontSize="sm" color="fg.muted">Are you currently on-site at the job location?</Text>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <VStack w="full" gap={2}>
                  <Button
                    colorPalette="blue"
                    w="full"
                    disabled={!startJobTime}
                    onClick={async () => {
                      if (!startJobOcc) return;
                      try {
                        const startedAt = new Date(startJobTime).toISOString();
                        const occDate = startJobOcc.startAt ? bizDateKey(startJobOcc.startAt) : "";
                        const todayDate = bizDateKey(new Date());
                        const isEarly = occDate && occDate !== todayDate;
                        const body: Record<string, unknown> = { startedAt };
                        if (isEarly) body.updateStartAt = true;
                        try {
                          const loc = await getLocation();
                          if (loc) { body.lat = loc.lat; body.lng = loc.lng; }
                        } catch {}
                        await apiPost(`/api/occurrences/${startJobOcc.id}/start`, body);
                        publishInlineMessage({ type: "SUCCESS", text: "Job started with location recorded." });
                        setStartJobOcc(null);
                        await load(false);
                      } catch (err) {
                        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Start failed.", err) });
                      }
                    }}
                  >
                    Yes — record location & start
                  </Button>
                  <Button
                    variant="outline"
                    w="full"
                    disabled={!startJobTime}
                    onClick={async () => {
                      if (!startJobOcc) return;
                      try {
                        const startedAt = new Date(startJobTime).toISOString();
                        const occDate = startJobOcc.startAt ? bizDateKey(startJobOcc.startAt) : "";
                        const todayDate = bizDateKey(new Date());
                        const isEarly = occDate && occDate !== todayDate;
                        const body: Record<string, unknown> = { startedAt };
                        if (isEarly) body.updateStartAt = true;
                        await apiPost(`/api/occurrences/${startJobOcc.id}/start`, body);
                        publishInlineMessage({ type: "SUCCESS", text: "Job started." });
                        setStartJobOcc(null);
                        await load(false);
                      } catch (err) {
                        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Start failed.", err) });
                      }
                    }}
                  >
                    No — start without location
                  </Button>
                  <Button variant="ghost" w="full" onClick={() => setStartJobOcc(null)}>Cancel</Button>
                </VStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Reschedule dialog */}
      <Dialog.Root open={!!rescheduleOcc} onOpenChange={(e) => { if (!e.open) setRescheduleOcc(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm">
              <Dialog.Header>
                <Dialog.Title>Reschedule Job</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Text fontSize="sm" color="fg.muted">
                    {forAdmin
                      ? "Move this job to a new date."
                      : "Move this job to a new date (within 2 days of today). A comment explaining the reason is required."
                    }
                  </Text>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>New date</Text>
                    <HStack gap={2} wrap="wrap">
                      {[
                        { label: "Today", days: 0 },
                        { label: "Tomorrow", days: 1 },
                        { label: "In 2 days", days: 2 },
                      ].map((opt) => {
                        const d = new Date();
                        d.setDate(d.getDate() + opt.days);
                        const val = bizDateKey(d);
                        return (
                          <Button
                            key={opt.days}
                            size="xs"
                            variant={rescheduleDate === val ? "solid" : "outline"}
                            colorPalette="blue"
                            onClick={() => setRescheduleDate(val)}
                          >
                            {opt.label}
                          </Button>
                        );
                      })}
                    </HStack>
                    <HStack gap={2} align="center" mt={2}>
                      <Text fontSize="sm" flexShrink={0}>Or pick:</Text>
                      <DateInput value={rescheduleDate} onChange={setRescheduleDate} min={bizDateKey(new Date())} />
                    </HStack>
                  </Box>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Reason {forAdmin ? "(optional)" : "(required)"}</Text>
                    <input
                      type="text"
                      placeholder="e.g., Rain forecast, client requested change"
                      value={rescheduleReason}
                      onChange={(e) => setRescheduleReason(e.target.value)}
                      style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                    />
                  </Box>
                  {rescheduleDate === (rescheduleOcc?.startAt ? bizDateKey(rescheduleOcc.startAt) : "") && (
                    <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
                      <Text fontSize="xs" color="yellow.700">This is the same date as currently scheduled.</Text>
                    </Box>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="ghost" onClick={() => setRescheduleOcc(null)}>Cancel</Button>
                <Button
                  colorPalette="blue"
                  disabled={!rescheduleDate || (!forAdmin && !rescheduleReason.trim()) || rescheduleBusy || rescheduleDate === (rescheduleOcc?.startAt ? bizDateKey(rescheduleOcc.startAt) : "")}
                  loading={rescheduleBusy}
                  onClick={submitReschedule}
                >
                  Reschedule
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Reschedule notify dialog */}
      <Dialog.Root open={!!rescheduleNotify} onOpenChange={(e) => { if (!e.open) setRescheduleNotify(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm" mx="4">
              <Dialog.Header>
                <Dialog.Title>Notify Client</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Text fontSize="sm" color="fg.muted">
                    The job has been rescheduled. Let the client know about the change:
                  </Text>
                  <Box p={3} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="md">
                    <Text fontSize="xs" color="blue.800">{rescheduleNotify?.message}</Text>
                  </Box>
                  <VStack align="stretch" gap={2}>
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="gray"
                      onClick={() => {
                        if (rescheduleNotify?.message) {
                          navigator.clipboard.writeText(rescheduleNotify.message);
                          publishInlineMessage({ type: "SUCCESS", text: "Copied!" });
                        }
                      }}
                    >
                      <Copy size={14} /> Copy Message
                    </Button>
                    {rescheduleNotify?.phone && (
                      <Button
                        size="sm"
                        variant="outline"
                        colorPalette="green"
                        overflow="hidden"
                        onClick={() => {
                          window.open(`sms:${rescheduleNotify!.phone}?body=${encodeURIComponent(rescheduleNotify!.message)}`, "_self");
                        }}
                      >
                        <MessageCircle size={14} style={{ flexShrink: 0 }} /> <Text lineClamp={1}>Text to {rescheduleNotify.phone}</Text>
                      </Button>
                    )}
                    {rescheduleNotify?.email && (
                      <Button
                        size="sm"
                        variant="outline"
                        colorPalette="blue"
                        overflow="hidden"
                        onClick={() => {
                          const subject = encodeURIComponent("Schedule Change — Seedlings Lawn Care");
                          window.open(`mailto:${rescheduleNotify!.email}?subject=${subject}&body=${encodeURIComponent(rescheduleNotify!.message)}`, "_self");
                        }}
                      >
                        <Mail size={14} style={{ flexShrink: 0 }} /> <Text lineClamp={1}>Email to {rescheduleNotify.email}</Text>
                      </Button>
                    )}
                  </VStack>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="ghost" onClick={() => setRescheduleNotify(null)}>Done</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <ManageExpensesDialog
        open={!!expenseDialogOccId}
        onOpenChange={(o) => { if (!o) { setExpenseDialogOccId(null); void load(false); } }}
        occurrenceId={expenseDialogOccId ?? ""}
        onChanged={() => void load(false)}
      />

      <SendReceiptDialog
        open={receiptDialogOpen}
        onOpenChange={setReceiptDialogOpen}
        data={receiptData}
        contactPhone={receiptContact.phone}
        contactEmail={receiptContact.email}
      />

      {acceptPaymentOcc && (
        <AcceptPaymentDialog
          open={acceptPaymentOpen}
          onOpenChange={(o) => {
            setAcceptPaymentOpen(o);
            if (!o) setAcceptPaymentOcc(null);
          }}
          endpoint={`/api/occurrences/${acceptPaymentOcc.id}/accept-payment`}
          defaultAmount={acceptPaymentOcc.price}
          totalExpenses={(acceptPaymentOcc.expenses ?? []).reduce((s, e) => s + e.cost, 0)}
          commissionPercent={commissionPercent}
          marginPercent={marginPercent}
          assignees={(acceptPaymentOcc.assignees ?? []).filter((a) => a.role !== "observer").map((a) => ({
            userId: a.userId,
            displayName: a.user?.displayName ?? a.user?.email,
            workerType: a.user?.workerType,
          }))}
          onAccepted={(result: any) => {
            void load(false);
            if (result?.nextOccurrence) {
              const nextDate = result.nextOccurrence.startAt
                ? fmtDate(result.nextOccurrence.startAt)
                : "upcoming";
              const freq = result.nextOccurrence.frequencyDays ?? acceptPaymentOcc?.frequencyDays ?? (acceptPaymentOcc?.job as any)?.frequencyDays;
              publishInlineMessage({
                type: "SUCCESS",
                text: `Payment accepted. Next occurrence scheduled for ${nextDate}${freq ? ` (every ${freq} days)` : ""}.`,
              });
            } else if (
              acceptPaymentOcc?.workflow === "STANDARD" &&
              !acceptPaymentOcc?.isOneOff
            ) {
              publishInlineMessage({
                type: "WARNING",
                text: "Payment accepted, but no next occurrence was created. This repeating job has no frequency set on the job or occurrence.",
              });
            }
            setAcceptPaymentOcc(null);
          }}
        />
      )}
      <InsuranceUploadDialog
        open={insuranceDialogOpen}
        onOpenChange={setInsuranceDialogOpen}
        onUploaded={() => {
          // Refresh me data by reloading the page — simplest approach
          window.location.reload();
        }}
      />
      <ClaimAgreementDialog
        open={agreementDialogOpen}
        onOpenChange={setAgreementDialogOpen}
        me={me}
        occurrence={pendingClaimOccId ? items.find((o) => o.id === pendingClaimOccId) ?? null : null}
        commissionPercent={commissionPercent}
        marginPercent={marginPercent}
        onAgreed={async () => {
          if (pendingClaimOccId) {
            await claim(pendingClaimOccId);
            setPendingClaimOccId(null);
          }
        }}
      />
      {completeDialogOcc && (
        <CompleteJobDialog
          open={!!completeDialogOcc}
          onOpenChange={(o) => { if (!o) setCompleteDialogOcc(null); }}
          occurrenceId={completeDialogOcc.id}
          occurrencePrice={completeDialogOcc.price}
          startedAt={completeDialogOcc.startedAt}
          onCompleted={(completedAt) => {
            setCompleteDialogOcc(null);
            const occToComplete = completeDialogOcc;
            const completeWithLocation = async (recordLoc: boolean) => {
              try {
                const body: Record<string, unknown> = {};
                if (completedAt) body.completedAt = completedAt;
                if (recordLoc) {
                  const loc = await getLocation();
                  if (loc) { body.lat = loc.lat; body.lng = loc.lng; }
                }
                await apiPost(`/api/occurrences/${occToComplete.id}/complete`, body);
                publishInlineMessage({ type: "SUCCESS", text: "Job completed." });
                await load(false);
                // Prompt for photos after completion
                setPhotoPromptOccId(occToComplete.id);
              } catch (err) {
                publishInlineMessage({ type: "ERROR", text: getErrorMessage("Complete failed.", err) });
              }
            };
            setConfirmAction({
              title: "Record Location?",
              message: "Are you currently on-site at the job location?",
              confirmLabel: "Yes — record location & complete",
              colorPalette: "blue",
              onConfirm: () => void completeWithLocation(true),
              cancelLabel: "No — complete without location",
              onCancelAction: () => void completeWithLocation(false),
            });
          }}
        />
      )}

      {/* Photo prompt after job completion */}
      <Dialog.Root open={!!photoPromptOccId} onOpenChange={(e) => { if (!e.open) setPhotoPromptOccId(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Add Photos?</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm" color="fg.muted" mb={3}>
                  Job completed! Want to upload any photos of the work?
                </Text>
                {photoPromptOccId && (
                  <OccurrencePhotos
                    occurrenceId={photoPromptOccId}
                    canUpload
                    isAdmin={forAdmin && (isAdmin || isSuper)}
                  />
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setPhotoPromptOccId(null)}>
                    Skip
                  </Button>
                  <Button colorPalette="blue" onClick={() => { setPhotoPromptOccId(null); void load(false); }}>
                    Done
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <Dialog.Root open={showInfoDialog} onOpenChange={(e) => { if (!e.open) setShowInfoDialog(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg" maxH="80vh" overflowY="auto">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>How Jobs Work</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={4}>
                  <Box>
                    <Text fontWeight="bold" fontSize="md" mb={1}>Occurrence Types</Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>Each type has a different workflow and visibility scope.</Text>
                  </Box>

                  {/* ── Job Types ── */}
                  <Box>
                    <Text fontWeight="semibold" fontSize="sm" color="fg.muted" mb={1}>Job Types</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="blue.300" bg="blue.50">
                    <Badge colorPalette="blue" variant="subtle" mb={1}>Repeating</Badge>
                    <Text fontSize="sm">A recurring job on a schedule (e.g., every 14 days). Workers can claim it, or an admin can assign a team. When payment is accepted, the next occurrence is automatically created using the Job Service's default team. If no default team is set, the next occurrence is left unassigned (claimable).</Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>Flow: Scheduled → Claim/Assign → Start → Complete → Accept Payment → Next auto-created</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="cyan.300" bg="cyan.50">
                    <Badge colorPalette="cyan" variant="solid" mb={1}>One-Off</Badge>
                    <Text fontSize="sm">A single job that does not repeat. No next occurrence is created after payment.</Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>Flow: Scheduled → Claim/Assign → Start → Complete → Accept Payment → Done</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="pink.300" bg="pink.50">
                    <Badge colorPalette="pink" variant="solid" mb={1}>Estimate</Badge>
                    <Text fontSize="sm">A site visit to assess work. Estimates are administered by default — they must be assigned by an admin. After starting and completing, the claimer or admin can accept or reject with comments. Estimates can be standalone (lightweight) or linked to a Job Service.</Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>Flow: Assign → Start → Complete → Accept or Reject</Text>
                  </Box>

                  {/* ── Personal Types ── */}
                  <Box mt={2}>
                    <HStack gap={2} mb={1}>
                      <Text fontWeight="semibold" fontSize="sm" color="fg.muted">Personal</Text>
                      <Badge fontSize="xs" px="1.5" borderRadius="full" variant="subtle" colorPalette="gray">Only you</Badge>
                    </HStack>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="blue.300" bg="blue.50">
                    <Badge colorPalette="blue" variant="solid" mb={1}>Task</Badge>
                    <Text fontSize="sm">A personal to-do item (e.g., "Call client about pricing"). Only visible to you. Can be completed directly — no start/complete workflow. Can optionally link to a job occurrence for context.</Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>Flow: Scheduled → Complete</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="purple.300" bg="purple.50">
                    <Badge colorPalette="purple" variant="solid" mb={1}>Reminder</Badge>
                    <Text fontSize="sm">A personal reminder only visible to you (e.g., "Pick up supplies"). Appears in the Planning tab when due. Can be dismissed and reopened. Supports high-priority mode for a more prominent card.</Text>
                  </Box>

                  {/* ── Team Types ── */}
                  <Box mt={2}>
                    <HStack gap={2} mb={1}>
                      <Text fontWeight="semibold" fontSize="sm" color="fg.muted">Team</Text>
                      <Badge fontSize="xs" px="1.5" borderRadius="full" variant="subtle" colorPalette="gray">Assigned members only</Badge>
                    </HStack>
                    <Text fontSize="xs" color="fg.muted" mb={1}>Visible on the Worker Jobs tab only to people added via Manage Team. Admins always see them on the Admin Jobs tab.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="yellow.400" bg="yellow.200">
                    <Badge colorPalette="yellow" variant="solid" mb={1}>Event</Badge>
                    <Text fontSize="sm">A team-scoped occurrence (e.g., "Weekly team meeting", "Equipment inspection"). Created by admins only. Can set an optional exact time. Can be one-off or repeating — repeating events auto-create the next instance when completed. Only admins can edit and complete. Becomes overdue if not completed by its date.</Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>Flow: Scheduled → Complete (admin) → Next auto-created (if repeating)</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="red.400" bg="red.200">
                    <Badge colorPalette="red" variant="solid" mb={1}>Followup</Badge>
                    <Text fontSize="sm">A team-scoped follow-up (e.g., "Follow up on Thompson pricing"). Created by admins only. Can optionally attach one or more clients and/or job services — clicking them navigates to the relevant tab. Can be one-off or repeating. Only admins can edit and complete. Becomes overdue if not completed by its date.</Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>Flow: Scheduled → Complete (admin) → Next auto-created (if repeating)</Text>
                  </Box>

                  {/* ── Everyone ── */}
                  <Box mt={2}>
                    <HStack gap={2} mb={1}>
                      <Text fontWeight="semibold" fontSize="sm" color="fg.muted">Everyone</Text>
                      <Badge fontSize="xs" px="1.5" borderRadius="full" variant="subtle" colorPalette="gray">All workers & admins</Badge>
                    </HStack>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="purple.400" bg="purple.200">
                    <Badge colorPalette="purple" variant="solid" mb={1}>Announcement</Badge>
                    <Text fontSize="sm">A company-wide notice visible to all workers and admins (e.g., "Office closed Friday", "New mulch supplier"). Created by admins only. Announcements are never completed — they remain in the timeline and naturally fall back over time. Only admins can edit or delete them. No Manage Team or overdue tracking.</Text>
                  </Box>

                  <Box mt={2}>
                    <Text fontWeight="bold" fontSize="md" mb={1}>Key Concepts</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="teal.300">
                    <Text fontWeight="semibold" fontSize="sm" mb={1}>Claimer</Text>
                    <Text fontSize="sm">The first worker assigned to a job becomes the claimer. Only the claimer can start, complete, and accept payment. Other team members are workers or observers. To change the claimer, use Manage Team.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="teal.300">
                    <Text fontWeight="semibold" fontSize="sm" mb={1}>Default Team</Text>
                    <Text fontSize="sm">A Job Service can have a default team. When a new occurrence is auto-created (after payment on a repeating job), the default team is assigned. One-time team swaps on individual occurrences don't affect the defaults.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="blue.300">
                    <Text fontWeight="semibold" fontSize="sm" mb={1}>Reschedule</Text>
                    <Text fontSize="sm">The claimer can reschedule a job within 2 days of today. A reason is required and posted as a comment. Admins can reschedule without restrictions from the Job Services tab.</Text>
                  </Box>

                  <Box mt={2}>
                    <Text fontWeight="bold" fontSize="md" mb={1}>Flags</Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>These flags modify the behavior of any occurrence type.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="red.300">
                    <Badge bg="red.200" color="red.700" border="1px solid" borderColor="red.300" mb={1}>Administered</Badge>
                    <Text fontSize="sm">Cannot be claimed by workers — an admin must assign the team. Once assigned, the claimer can start, complete, and manage it normally. Estimates are administered by default.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="orange.300">
                    <Badge colorPalette="orange" variant="solid" mb={1}>Tentative</Badge>
                    <Text fontSize="sm">Cannot be claimed or started until an admin confirms it. Used when scheduling is uncertain or needs client approval.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="yellow.400">
                    <Badge colorPalette="yellow" variant="solid" mb={1}>Insured Only</Badge>
                    <Text fontSize="sm">High-value jobs above a configured threshold. Contractors must have valid insurance to claim or be assigned.</Text>
                  </Box>

                  <Box mt={2}>
                    <Text fontWeight="bold" fontSize="md" mb={1}>Card Colors</Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>Card background colors indicate the state at a glance.</Text>
                  </Box>

                  <VStack align="stretch" gap={1}>
                    <HStack p={2} bg="teal.50" borderWidth="1px" borderColor="teal.300" rounded="md" gap={2}>
                      <Badge colorPalette="teal" variant="solid" fontSize="xs" flexShrink={0}>Teal</Badge>
                      <Text fontSize="xs">Assigned to you, or someone is actively working (in progress)</Text>
                    </HStack>
                    <HStack p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md" gap={2}>
                      <Badge colorPalette="yellow" variant="solid" fontSize="xs" flexShrink={0}>Yellow</Badge>
                      <Text fontSize="xs">Unassigned — available to claim</Text>
                    </HStack>
                    <HStack p={2} bg="green.100" borderWidth="1px" borderColor="green.400" rounded="md" gap={2}>
                      <Badge colorPalette="green" variant="solid" fontSize="xs" flexShrink={0}>Green</Badge>
                      <Text fontSize="xs">Pending payment — job complete, awaiting payment</Text>
                    </HStack>
                    <HStack p={2} bg="orange.50" borderWidth="1px" borderColor="orange.300" rounded="md" gap={2}>
                      <Badge colorPalette="orange" variant="solid" fontSize="xs" flexShrink={0}>Orange</Badge>
                      <Text fontSize="xs">Tentative — not yet confirmed</Text>
                    </HStack>
                    <HStack p={2} bg="pink.50" borderWidth="1px" borderColor="pink.300" rounded="md" gap={2}>
                      <Badge colorPalette="pink" variant="solid" fontSize="xs" flexShrink={0}>Pink</Badge>
                      <Text fontSize="xs">Estimate</Text>
                    </HStack>
                    <HStack p={2} bg="blue.50" borderWidth="1px" borderColor="blue.300" rounded="md" gap={2}>
                      <Badge colorPalette="blue" variant="solid" fontSize="xs" flexShrink={0}>Blue</Badge>
                      <Text fontSize="xs">Task</Text>
                    </HStack>
                    <HStack p={2} bg="purple.50" borderWidth="1px" borderColor="purple.300" rounded="md" gap={2}>
                      <Badge colorPalette="purple" variant="solid" fontSize="xs" flexShrink={0}>Purple</Badge>
                      <Text fontSize="xs">Reminder</Text>
                    </HStack>
                    <HStack p={2} bg="#C4B5FD" borderWidth="1px" borderColor="#6D28D9" rounded="md" gap={2}>
                      <Badge colorPalette="purple" variant="solid" fontSize="xs" flexShrink={0}>Violet</Badge>
                      <Text fontSize="xs">Announcement — universally visible</Text>
                    </HStack>
                    <HStack p={2} bg="#FECACA" borderWidth="1px" borderColor="#BE123C" rounded="md" gap={2}>
                      <Badge colorPalette="red" variant="solid" fontSize="xs" flexShrink={0}>Rose</Badge>
                      <Text fontSize="xs">Followup — team-scoped, with attached clients/jobs</Text>
                    </HStack>
                    <HStack p={2} bg="#FDE68A" borderWidth="1px" borderColor="#D97706" rounded="md" gap={2}>
                      <Badge colorPalette="yellow" variant="solid" fontSize="xs" flexShrink={0}>Amber</Badge>
                      <Text fontSize="xs">Event — team-scoped, admin-managed</Text>
                    </HStack>
                    <HStack p={2} bg="gray.50" borderWidth="1px" borderColor="gray.200" rounded="md" gap={2}>
                      <Badge colorPalette="gray" variant="subtle" fontSize="xs" flexShrink={0}>Gray</Badge>
                      <Text fontSize="xs">Assigned to others, or closed/completed</Text>
                    </HStack>
                  </VStack>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      try { localStorage.removeItem("seedlings_jobs_infoDismissed"); } catch {}
                      setShowInfoDialog(false);
                    }}
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      try { localStorage.setItem("seedlings_jobs_infoDismissed", "1"); } catch {}
                      setShowInfoDialog(false);
                    }}
                  >
                    Don't show again
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
      {/* Prompt to create occurrence after accepting estimate */}
      {promptOccJobId && (
        <OccurrenceDialog
          open
          onOpenChange={(open) => {
            if (!open) setPromptOccJobId(null);
          }}
          mode="CREATE"
          jobId={promptOccJobId}
          isAdmin={forAdmin}
          defaultPrice={promptOccDefaults.price}
          defaultEstimatedMinutes={promptOccDefaults.estimatedMinutes}
          defaultNotes={promptOccDefaults.notes}
          title="Create First Occurrence"
          submitLabel="Create"
          createEndpoint={forAdmin ? `/api/admin/jobs/${promptOccJobId}/occurrences` : undefined}
          onSaved={() => {
            setPromptOccJobId(null);
            publishInlineMessage({ type: "SUCCESS", text: "Occurrence created." });
            void load(false);
          }}
        />
      )}

      {/* Calendar Feed Dialog */}
      <Dialog.Root open={calFeedStep !== "closed"} onOpenChange={(e) => { if (!e.open) setCalFeedStep("closed"); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="md" mx={4}>
              <Dialog.Header>
                <Dialog.Title>{calFeedStep === "confirm" ? "Create Calendar Feed" : "Calendar Feed URL"}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {calFeedStep === "confirm" && (
                  <VStack align="stretch" gap={3}>
                    <Text fontSize="sm">This will create a calendar subscription URL with the filters below locked in. To tailor what appears in your calendar, adjust the filters on the Jobs tab before creating a feed.</Text>
                    <HStack gap={1} wrap="wrap">
                      {kind[0] !== "ALL" ? (
                        <Badge size="sm" colorPalette="blue" variant="subtle">{kindItems.find((i) => i.value === kind[0])?.label}</Badge>
                      ) : (
                        <Badge size="sm" colorPalette="gray" variant="subtle">All Kinds</Badge>
                      )}
                      {statusFilter[0] !== "ALL" ? (
                        <Badge size="sm" colorPalette={statusFilter[0] === "UNCLAIMED" ? "yellow" : "purple"} variant="subtle">{statusItems.find((i) => i.value === statusFilter[0])?.label}</Badge>
                      ) : (
                        <Badge size="sm" colorPalette="gray" variant="subtle">All Statuses</Badge>
                      )}
                      {typeFilter[0] !== "ALL" ? (
                        <Badge size="sm" colorPalette="orange" variant="subtle">{typeItems.find((i) => i.value === typeFilter[0])?.label}</Badge>
                      ) : (
                        <Badge size="sm" colorPalette="gray" variant="subtle">All Types</Badge>
                      )}
                      {vipOnly && <Badge size="sm" colorPalette="yellow" variant="subtle">VIP</Badge>}
                      {likedOnly && <Badge size="sm" colorPalette="red" variant="subtle">Liked</Badge>}
                    </HStack>
                    <Text fontSize="sm">The feed will show a rolling window of your assigned and claimable jobs: 2 weeks past and 2 months ahead.</Text>
                    <Box p={3} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md">
                      <Text fontSize="xs" fontWeight="medium" color="yellow.800">Staleness warning</Text>
                      <Text fontSize="xs" color="yellow.700" mt={1}>
                        Calendar apps refresh feeds on their own schedule. Google Calendar updates roughly every 12 hours. Apple Calendar is faster (~15 minutes). Changes to your jobs may not appear immediately in your calendar.
                      </Text>
                    </Box>
                    <Text fontSize="xs" color="fg.muted">
                      You can manage and revoke feeds anytime from your{" "}
                      <Text as="span" color="blue.600" cursor="pointer" textDecoration="underline" onClick={() => {
                        setCalFeedStep("closed");
                        window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "profile" } }));
                      }}>Profile</Text>.
                    </Text>
                  </VStack>
                )}
                {calFeedStep === "result" && calFeedLoading && (
                  <VStack py={4}><Spinner /></VStack>
                )}
                {calFeedStep === "result" && !calFeedLoading && calFeedUrl && (
                  <VStack align="stretch" gap={3}>
                    <Text fontSize="sm">Copy this URL and add it to your calendar app (Google Calendar, Apple Calendar, Outlook, etc.):</Text>
                    <Box p={3} bg="gray.50" borderWidth="1px" borderRadius="md" fontSize="xs" wordBreak="break-all" fontFamily="mono">
                      {calFeedUrl}
                    </Box>
                    <Button
                      size="sm"
                      colorPalette="blue"
                      onClick={() => {
                        navigator.clipboard.writeText(calFeedUrl);
                        publishInlineMessage({ type: "SUCCESS", text: "URL copied to clipboard!" });
                      }}
                    >
                      Copy URL
                    </Button>
                    <Text fontSize="xs" color="fg.muted">
                      Paste this URL into your calendar app under "Subscribe" or "Add by URL". You can manage and revoke feeds from your{" "}
                      <Text as="span" color="blue.600" cursor="pointer" textDecoration="underline" onClick={() => {
                        setCalFeedStep("closed");
                        window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "profile" } }));
                      }}>Profile</Text>.
                    </Text>
                  </VStack>
                )}
              </Dialog.Body>
              <Dialog.Footer gap={2}>
                {calFeedStep === "confirm" && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setCalFeedStep("closed")}>Cancel</Button>
                    <Button
                      size="sm"
                      colorPalette="blue"
                      loading={calFeedLoading}
                      disabled={isOffline}
                      title={isOffline ? "Requires internet" : undefined}
                      onClick={async () => {
                        setCalFeedLoading(true);
                        setCalFeedStep("result");
                        try {
                          const filters = {
                            kind: kind[0],
                            statusFilter: statusFilter[0],
                            typeFilter: typeFilter[0],
                            vipOnly,
                            likedOnly,
                          };
                          const label = [
                            "Seedlings Jobs",
                            kind[0] !== "ALL" ? kindItems.find((i) => i.value === kind[0])?.label : null,
                            statusFilter[0] !== "ALL" ? statusItems.find((i) => i.value === statusFilter[0])?.label : null,
                            typeFilter[0] !== "ALL" ? typeItems.find((i) => i.value === typeFilter[0])?.label : null,
                            vipOnly ? "VIP" : null,
                            likedOnly ? "Liked" : null,
                          ].filter(Boolean).join(" — ");
                          const res = await apiPost<{ token: string }>("/api/calendar-feeds", { filters, label });
                          const base = window.location.origin;
                          setCalFeedUrl(`${base}/api/_proxy/api/public/calendar/${res.token}.ics`);
                        } catch (err) {
                          publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to create feed.", err) });
                          setCalFeedStep("closed");
                        } finally {
                          setCalFeedLoading(false);
                        }
                      }}
                    >
                      Create Feed
                    </Button>
                  </>
                )}
                {calFeedStep === "result" && !calFeedLoading && (
                  <Button size="sm" variant="ghost" onClick={() => setCalFeedStep("closed")}>Done</Button>
                )}
              </Dialog.Footer>
              <Dialog.CloseTrigger />
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}
