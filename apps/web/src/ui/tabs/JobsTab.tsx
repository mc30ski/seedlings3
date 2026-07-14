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
import { AlertCircle, AlertTriangle, Archive, Ban, Bell, BellOff, Calendar, CalendarRange, CheckCircle2, ChevronDown, ChevronUp, CircleDollarSign, Clock, Copy, Eye, Filter, Hand, Heart, Info, LayoutList, Link2, List, Mail, Maximize2, MessageCircle, MoreHorizontal, Pause, Phone, Pin, PinOff, Play, RefreshCw, Repeat, Share2, Star, Tag, Users, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import {
  useWorkdayGate,
  useTeamWorkdayDialog,
  type NotReadyTeammate,
} from "@/src/ui/dialogs/WorkdayRequiredDialog";
import ImpersonationWarning from "@/src/ui/components/ImpersonationWarning";
import WorkdayStrip from "@/src/ui/components/WorkdayStrip";
import MileageStrip from "@/src/ui/components/MileageStrip";
import RepeatingPauseInfoLine from "@/src/ui/components/RepeatingPauseInfoLine";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { projectViewerPayout, projectTeamPayoutsForOcc, perWorkerShare, rateForViewer } from "@/src/lib/paymentMath";
import { buildMailtoHref, buildSmsHref, fetchCommsCc } from "@/src/lib/comms";
import { getLocation } from "@/src/lib/geo";
import { determineRoles, occurrenceStatusColor, prettyStatus, clientLabel, fmtDate, fmtDateTime, fmtDateWeekday, fmtDateOpts, fmtTimeOpts, bizDateKey, bizToday, bizYesterday, bizAddDays, bizAddYears, bizYearOf, bizDaysBetween, bizInstantFromEtParts, bizToLocalInputValue, bizParseLocalInputValue, jobTypeLabel } from "@/src/lib/lib";
import { usePaymentMethodLabels } from "@/src/lib/usePaymentMethodLabels";
import { useBranding } from "@/src/lib/useBranding";
import { type TabPropsType, type WorkerOccurrence, JOB_OCCURRENCE_STATUS, JOB_KIND } from "@/src/lib/types";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import HolidayChip from "@/src/ui/components/HolidayChip";
import ClientRequestsSection from "@/src/ui/components/ClientRequestsSection";
import StatusButton from "@/src/ui/components/StatusButton";
import AddAssigneeDialog from "@/src/ui/dialogs/AddAssigneeDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import SendReceiptDialog from "@/src/ui/dialogs/SendReceiptDialog";
import { type ReceiptData } from "@/src/lib/receipt";
import AcceptPaymentDialog from "@/src/ui/dialogs/AcceptPaymentDialog";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import ManageExpensesDialog from "@/src/ui/dialogs/ManageExpensesDialog";
import PricingGuideDialog from "@/src/ui/dialogs/PricingGuideDialog";
import { MapLink, TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch, navigateToProfile, bumpTitleBarEarnings } from "@/src/lib/bus";
import { suggestedEquipment, parseEquipmentKindsConfig, type EquipmentKindConfig } from "@/src/lib/equipmentSuggestions";
import { type DatePreset, computeDatesFromPreset, PRESET_LABELS } from "@/src/lib/datePresets";
import OccurrencePhotos from "@/src/ui/components/OccurrencePhotos";
import OccurrenceInstructions, { InstructionsBadge } from "@/src/ui/components/OccurrenceInstructions";
import PaymentCommsButtons from "@/src/ui/components/PaymentCommsButtons";
import { jobTagLabel as _jobTagLabel, JOB_TAGS, parseServiceTypesConfig, pricingJobTags, DEFAULT_SERVICE_TYPES, type ServiceTypeConfig } from "@/src/ui/components/JobTagPicker";
import { parseAdminTags, adminTagLabel, adminTagColor } from "@/src/ui/components/AdminTagPicker";
import TruncatedText from "@/src/ui/components/TruncatedText";
import { useOffline } from "@/src/lib/offline";
import { enqueueAction } from "@/src/lib/offlineQueue";
import TaskDialog from "@/src/ui/dialogs/TaskDialog";
import ClaimAgreementDialog from "@/src/ui/dialogs/ClaimAgreementDialog";
import CompleteJobDialog from "@/src/ui/dialogs/CompleteJobDialog";
import OccurrenceDialog from "@/src/ui/dialogs/OccurrenceDialog";
import EstimateDialog from "@/src/ui/dialogs/EstimateDialog";
import EventDialog from "@/src/ui/dialogs/EventDialog";
import FollowupDialog from "@/src/ui/dialogs/FollowupDialog";
import AnnouncementDialog from "@/src/ui/dialogs/AnnouncementDialog";
import PinnedNoteDialog from "@/src/ui/dialogs/PinnedNoteDialog";
import {
  DEFAULT_TIMELINE_CATEGORIES,
  categoryLabel as timelineCategoryLabel,
  parseTimelineCategoriesConfig,
  type TimelineCategoryConfig,
} from "@/src/ui/components/TimelineCategoryPicker";
import {
  DEFAULT_DOCUMENT_TYPES,
  documentTypeLabel,
  parseDocumentTypesConfig,
  type DocumentTypeConfig,
} from "@/src/ui/components/DocumentTypePicker";

// `localDate` removed — use `bizDateKey` directly (single canonical
// helper from @/src/lib/lib). See docs/DATE_HANDLING.md.

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function effectiveMinutes(occ: {
  startedAt?: string | null;
  completedAt?: string | null;
  pausedAt?: string | null;
  totalPausedMs?: number | null;
  status?: string;
}): number | null {
  if (!occ.startedAt) return null;
  const startMs = new Date(occ.startedAt).getTime();
  const paused = occ.totalPausedMs ?? 0;
  let endMs: number;
  if (occ.status === "PAUSED" && occ.pausedAt) endMs = new Date(occ.pausedAt).getTime();
  else if (occ.completedAt) endMs = new Date(occ.completedAt).getTime();
  else endMs = Date.now();
  // Clamp to 0 to avoid showing negative durations when data is invalid
  // (e.g., completedAt before startedAt). The backend Hours-this-week sum also clamps,
  // so the per-card display stays consistent with the tile total.
  return Math.max(0, (endMs - startMs - paused) / 60000);
}

function assigneeSortOrder(a: { assignedById?: string | null; userId: string; role?: string | null }): number {
  const isClaimer = a.assignedById === a.userId && a.role !== "observer";
  if (isClaimer) return 0;
  if (a.role === "observer") return 2;
  return 1;
}

/**
 * Returns a preset contact message based on occurrence state, or null if no message is appropriate.
 */
function getQuickMessage(occ: any, contactName: string | null): { label: string; body: string } | null {
  const name = contactName ?? "there";
  const dateStr = occ.startAt ? fmtDateOpts(occ.startAt, { weekday: "long", month: "long", day: "numeric" }) : "your upcoming appointment";
  // Property address joined into "street, city, state" form. Empty string
  // when no address is on file so the message just omits the location clause
  // instead of rendering an awkward "at ." segment.
  const prop = occ.job?.property;
  const addressStr = [prop?.street1, prop?.city, prop?.state].filter(Boolean).join(", ");
  const atAddress = addressStr ? ` at ${addressStr}` : "";

  // Unconfirmed — needs client confirmation. Previously gated on
  // isClaimed so unclaimed jobs hid the Request Confirmation button.
  // That's wrong for the Admin Jobs tab where an admin routinely
  // confirms unclaimed jobs on the client's behalf and still wants
  // the messaging affordance. The message copy doesn't depend on
  // anyone being claimed — it's "we have your appointment scheduled,
  // please confirm" — so the gate doesn't earn its keep.
  if (occ.status === "SCHEDULED" && occ.jobId && !(occ as any).isClientConfirmed) {
    return {
      label: "Request Confirmation",
      body: `Hi ${name}, this is Seedlings Lawn Care. We have your lawn service scheduled for ${dateStr}${atAddress}. Could you please confirm this works for you? Or let us know if you need to reschedule.`,
    };
  }

  // Pending payment
  if (occ.status === "PENDING_PAYMENT") {
    const amount = totalPrice(occ);
    const amountStr = amount != null ? ` of $${amount.toFixed(2)}` : "";
    return {
      label: "Request Payment",
      body: `Hi ${name}, this is Seedlings Lawn Care. Your lawn service on ${dateStr}${atAddress} has been completed. A payment${amountStr} is due at your earliest convenience. Please let us know if you have any questions. Thank you!`,
    };
  }

  return null;
}

function addonTotal(occ: any): number {
  return (occ.addons ?? []).reduce((s: number, a: any) => s + (a.price ?? 0), 0);
}

// Whether the claimer can still edit a job's billables (expenses, add-on
// services). They keep full edit access through completion and while the
// occurrence sits in PENDING_PAYMENT *before* payment is committed —
// claimers routinely reconcile the evening before sending the client their
// payment request. Editing locks the moment payment is committed: a request
// was sent to the client (paymentRequestSentAt) or a payment was
// recorded/accepted (a Payment row exists). CLOSED and terminal states are
// always frozen — admins do retroactive edits via the Services tab.
function occInEditableState(occ: any): boolean {
  switch (occ?.status) {
    case "SCHEDULED":
    case "IN_PROGRESS":
    case "PAUSED":
    case "COMPLETED":
      return true;
    case "PENDING_PAYMENT":
      return !occ.payment && !occ.paymentRequestSentAt;
    default:
      return false;
  }
}

function totalPrice(occ: any): number | null {
  const base = (occ.price || null) ?? (occ.proposalAmount || null);
  if (base == null) return addonTotal(occ) > 0 ? addonTotal(occ) : null;
  return base + addonTotal(occ);
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
  /** Display name of the impersonated worker — only meaningful when
   *  viewAsUserIds has exactly one entry. Used by mutation-confirm
   *  dialogs to surface the ImpersonationWarning. */
  viewAsDisplayName?: string | null;
  /** Extra UI rendered inline in the search bar row */
  headerSlot?: React.ReactNode;
  /** Extra UI rendered below the search bar row (e.g. selected worker badges) */
  headerBelowSlot?: React.ReactNode;
  /** Called when the "Clear" badge is clicked, to reset external filters (e.g. View as) */
  onClearAll?: () => void;
};

export default function JobsTab({ me, purpose = "WORKER", viewAsUserIds, viewAsWorkerType, viewAsDisplayName, headerSlot, headerBelowSlot, onClearAll }: JobsTabProps) {
  const { isAvail, forAdmin, isAdmin: hasAdminRole, isSuper: hasSuperRole } = determineRoles(me, purpose);
  // Tab-aware role gates. The Worker Jobs tab (`purpose === "WORKER"`)
  // is strictly a worker UI — admin and super capabilities (estimates,
  // manage-in-services, reset-job, per-occurrence overrides, payment
  // reconciliation tools, etc.) only surface when the actor is on the
  // Admin Jobs tab (`forAdmin`). Without this gate, every condition in
  // the file like `(isAdmin || isSuper) && …` would render admin
  // controls on the worker tab whenever the signed-in user happened to
  // have those roles — which is exactly the role-leak we're closing.
  //
  // Use these throughout the file; the raw `hasAdminRole` /
  // `hasSuperRole` are kept so the (very rare) places that need to know
  // "does the actor TRULY have super, regardless of which tab they're
  // on" can opt in explicitly.
  const isAdmin = forAdmin && hasAdminRole;
  const isSuper = forAdmin && hasSuperRole;
  const { isOffline } = useOffline();
  // Workday gate — wraps job-start actions with the "you need an active
  // workday" check. Renders its own dialog at the bottom of the tree.
  // Worker-purpose only — admins acting on jobs aren't bound by the gate
  // (matches the server-side bypass in services/jobs.ts).
  const workdayGate = useWorkdayGate();
  const teamWorkdayDialog = useTeamWorkdayDialog();

  // Inspect a thrown error from a job-start call. If it's the
  // backend TEAM_WORKDAY_NOT_ACTIVE 409 (a teammate hasn't clocked
  // in), surface the rich modal listing the names and return true
  // so the caller skips the generic toast. Otherwise return false
  // and let the caller render the toast as before.
  function handleTeamWorkdayError(err: any): boolean {
    if (err?.code !== "TEAM_WORKDAY_NOT_ACTIVE") return false;
    const raw = err?.details?.notReady;
    if (!Array.isArray(raw)) return false;
    const list: NotReadyTeammate[] = raw
      .map((r: any) => ({
        userId: String(r?.userId ?? ""),
        name: String(r?.name ?? "(unnamed)"),
      }))
      .filter((r) => r.userId);
    if (list.length === 0) return false;
    teamWorkdayDialog.show(list);
    return true;
  }
  const useWorkdayGuard = purpose === "WORKER" && !forAdmin;
  // Effective viewAs name for the ImpersonationWarning blocks rendered
  // inside mutation dialogs. Only meaningful when admin is viewing a
  // single worker; otherwise null. Role-impersonation (X-Impersonate-As)
  // still fires its own banner via ImpersonationWarning even when this
  // is null.
  const effectiveViewAsName =
    forAdmin && viewAsUserIds?.length === 1 ? (viewAsDisplayName ?? null) : null;
  // Method labels resolved from PAYMENT_METHODS taxonomy (single source of
  // truth — edit in Super → Settings, no code change here).
  const { labelFor: methodLabel } = usePaymentMethodLabels();
  const { businessName } = useBranding();

  function shareOccurrenceLink(occId: string, startAt?: string | null) {
    // Embed the occurrence's startAt so the recipient's JobsTab can anchor its
    // date range on the job — without it, a worker's 60-day clamp can hide
    // future jobs (e.g. tomorrow) when the default range is "today".
    const at = startAt ? `&at=${encodeURIComponent(startAt)}` : "";
    const url = `${window.location.origin}/?occ=${occId}${at}${forAdmin ? "&view=admin" : ""}`;
    navigator.clipboard.writeText(url).then(() => {
      publishInlineMessage({ type: "SUCCESS", text: "Link copied to clipboard." });
    }).catch(() => {
      publishInlineMessage({ type: "ERROR", text: "Failed to copy link." });
    });
  }
  const myId = viewAsUserIds?.length === 1 ? viewAsUserIds[0] : me?.id || "";
  const pfx = purpose === "ADMIN" ? "ajobs" : "wjobs";

  const [q, setQ] = useState("");
  // Card density: three levels.
  //   ultra  — single-row scan view, ~32px tall
  //   semi   — compact card (default)
  //   expanded — full detail view
  // The global density (`cardDensity`) sets the default for every card.
  // `cardOverrides` is a per-card override Map — clicking a card cycles
  // its mode (ultra → semi → expanded → ultra…) independently of the
  // global setting. Switching the global density clears all overrides.
  type CardDensity = "ultra" | "semi" | "expanded";
  const [cardDensity, setCardDensity] = usePersistedState<CardDensity>(`${pfx}_density`, "semi");
  // Backward-compat shim: a few legacy spots still read `compact`. Treat
  // anything but "expanded" as compact for those checks.
  const compact = cardDensity !== "expanded";

  // Cycle order matches the segmented toggle (left→right): ultra → semi
  // → expanded → ultra. Used by per-card click handlers.
  const CARD_DENSITY_CYCLE: CardDensity[] = ["ultra", "semi", "expanded"];
  const nextDensity = (m: CardDensity): CardDensity => {
    const i = CARD_DENSITY_CYCLE.indexOf(m);
    return CARD_DENSITY_CYCLE[(i + 1) % CARD_DENSITY_CYCLE.length];
  };
  const [cardOverrides, setCardOverrides] = useState<Map<string, CardDensity>>(new Map());
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
      { label: "Jobs", value: "JOBS" },
      { label: "One-off", value: "ONE_OFF" },
      { label: "Estimate", value: "ESTIMATE" },
      { label: "Tentative", value: "TENTATIVE" },
      { label: "Task", value: "TASK" },
      { label: "Reminder", value: "REMINDER" },
      { label: "Event", value: "EVENT" },
      { label: "Followup", value: "FOLLOWUP" },
      { label: "Announcement", value: "ANNOUNCEMENT" },
      { label: "Notices", value: "NOTICES" },
      // Admin-only: foreign rows from the Timeline tab (activities) and
      // Documents (per-day expirations). Read-only in this feed.
      ...(forAdmin ? [
        { label: "Activity", value: "ACTIVITY" },
        { label: "Doc expiration", value: "DOC_EXPIRATION" },
      ] : []),
    ],
    [forAdmin]
  );
  const typeCollection = useMemo(
    () => createListCollection({ items: typeItems }),
    [typeItems]
  );

  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(`${pfx}_status`, ["ALL"]);
  const statusItems = useMemo(
    () => [
      ...statusStates.map((s) => ({ label: s === "ALL" ? "All Statuses" : s === "UNCLAIMED" ? "Unclaimed" : prettyStatus(s), value: s as string })),
      { label: "Finished", value: "FINISHED" },
    ].map((s) => ({ label: s.label, value: s.value })),
    []
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );
  const [showCanceled, setShowCanceled] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Filter: show only occurrences currently paused as a repeating
  // service (status = STREAM_PAUSED). When on, everything else hides.
  // Respects the date range so paused rows outside the window aren't
  // pulled in — matches the tab's other filter semantics.
  const [pausedRepeatingOnly, setPausedRepeatingOnly] = useState(false);
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(false);
  // Admin-only foreign rows — Timeline activities + doc expirations — that
  // mix into the date-bucketed feed alongside jobs. Activities slot at their
  // nextDueDate and stick around as overdue until completed. Doc expirations
  // appear ONLY on the day matching expiresAt (no overdue carryover here —
  // overdue docs are surfaced in the Timeline tab + title-bar pill).
  type ActivityForeignRow = {
    kind: "activity";
    id: string;
    title: string;
    description: string | null;
    category: string | null;
    rrule: string | null;
    nextDueDate: string;
    adminHidden: boolean;
  };
  type DocExpirationForeignRow = {
    kind: "doc_expiration";
    documentId: string;
    title: string;
    type: string;
    expiresAt: string;
    adminHidden: boolean;
  };
  type ForeignRow = ActivityForeignRow | DocExpirationForeignRow;
  const [foreignRows, setForeignRows] = useState<ForeignRow[]>([]);
  // Label lookups for the foreign rows' category / type fields — pulled from
  // the configurable taxonomies so cards display the admin-defined label,
  // not the raw enum key (e.g., "Taxes" instead of "TAXES").
  const [timelineCategories, setTimelineCategories] = useState<TimelineCategoryConfig[]>(DEFAULT_TIMELINE_CATEGORIES);
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeConfig[]>(DEFAULT_DOCUMENT_TYPES);
  useEffect(() => {
    if (!forAdmin) return;
    (async () => {
      try {
        const settings = await apiGet<{ key: string; value: string }[]>("/api/admin/settings");
        if (!Array.isArray(settings)) return;
        const tc = settings.find((s) => s.key === "TIMELINE_CATEGORIES");
        const dt = settings.find((s) => s.key === "DOCUMENT_TYPES");
        const tcp = parseTimelineCategoriesConfig(tc?.value);
        const dtp = parseDocumentTypesConfig(dt?.value);
        if (tcp) setTimelineCategories(tcp);
        if (dtp) setDocumentTypes(dtp);
      } catch {}
    })();
  }, [forAdmin]);
  // Live tick — re-render every minute so "X actual" elapsed time updates while the page is open.
  // (Once a job is completed, effectiveMinutes() uses completedAt and stops counting naturally.)
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");
  // Info dialog is opt-in only — opens when the user taps the (i) button.
  // Used to auto-open on first visit (gated by a localStorage dismiss flag);
  // that behavior was removed because surprise modals were getting in the
  // way for returning users on every fresh device / browser session.
  const [showInfoDialog, setShowInfoDialog] = useState(false);
  const [calFeedStep, setCalFeedStep] = useState<"closed" | "confirm" | "result">("closed");
  const [calFeedUrl, setCalFeedUrl] = useState<string | null>(null);
  const [calFeedLoading, setCalFeedLoading] = useState(false);
  const [overdueCount, setOverdueCount] = useState(0);
  const [highValueThreshold, setHighValueThreshold] = useState(200);
  // Decimal form (0.3 = 30%). Drives both the visual "⚠ X% over estimate"
  // warning below and gates the payroll-approval API. Loaded from Setting
  // HOURS_APPROVAL_VARIANCE_THRESHOLD_PERCENT (stored as a whole number).
  const [hoursVarianceThreshold, setHoursVarianceThreshold] = useState(0.3);
  const [commissionPercent, setCommissionPercent] = useState(0);
  const [marginPercent, setMarginPercent] = useState(0);
  const [serviceTypes, setServiceTypes] = useState<ServiceTypeConfig[]>(DEFAULT_SERVICE_TYPES);
  const [equipmentKinds, setEquipmentKinds] = useState<EquipmentKindConfig[]>([]);
  // Equipment collections — for surfacing the job's "recommended kits" on
  // expanded cards. Loaded once; lookup by collectionId.
  type CollectionLite = { id: string; name: string; items: { equipmentId: string; equipment: { status?: string | null; retiredAt?: string | null } }[] };
  const [equipmentCollections, setEquipmentCollections] = useState<CollectionLite[]>([]);
  const jobTagLabel = (tag: string) => _jobTagLabel(tag, serviceTypes);

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
      publishInlineMessage({ type: "SUCCESS", text: wasPinned ? "Unpinned" : "Pinned", icon: Pin, autoHideMs: 1500 });
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

  // Groups the signed-in worker is the claimer of — used to show a
  // "Claim for [Group]" chooser on the Claim button.
  type ClaimerGroup = { id: string; name: string; members: { userId: string; role: string }[] };
  const [groupsAsClaimer, setGroupsAsClaimer] = useState<ClaimerGroup[]>([]);
  useEffect(() => {
    if (!isWorkerView) return;
    apiGet<ClaimerGroup[]>("/api/me/groups-as-claimer")
      .then((list) => setGroupsAsClaimer(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [isWorkerView]);
  const [claimChooserOccId, setClaimChooserOccId] = useState<string | null>(null);

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
      publishInlineMessage({ type: "SUCCESS", text: wasLiked ? "Unliked" : "Liked", icon: Heart, autoHideMs: 1500 });
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
        setCardOverrides(new Map([[occId, "expanded"]]));
        setQ("");
        setDatePreset(null);
        // Set a 7-day window around the occurrence date (ET-anchored).
        if (startAt) {
          const occKey = bizDateKey(startAt);
          setDateFrom(bizAddDays(occKey, -3));
          setDateTo(bizAddDays(occKey, 3));
        } else {
          // No date — use last 7 days.
          setDateFrom(bizAddDays(bizToday(), -7));
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
      setCardOverrides(new Map([[occId, "expanded"]]));
      setFilterJobId(null);
      setQ("");
      setOverdueActive(false);
      setDatePreset(null);
      if (startAt) {
        const occKey = bizDateKey(startAt);
        const fromKey = bizAddDays(occKey, -3);
        const toKey = bizAddDays(occKey, 3);
        setDateFrom(fromKey);
        setDateTo(toKey);
        void load(true, { from: fromKey, to: toKey }, occId);
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
    const overdueTo = bizYesterday();
    const overdueFrom = bizAddDays(bizToday(), -60);
    setDateFrom(overdueFrom);
    setDateTo(overdueTo);
    setOverdueActive(true);
    setUnapprovedHoursActive(false);
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

  // "Estimate follow-ups" header alert → filter to ESTIMATE/PROPOSAL_SUBMITTED
  // visits from 4 weeks ago through 1 week ago. Same shape as applyOverdue:
  // reset everything, then narrow.
  const applyEstimateFollowups = useCallback(() => {
    setQ("");
    setHighlightOccId(null);
    setFilterJobId(null);
    setKind(["ALL"]);
    setStatusFilter(["PROPOSAL_SUBMITTED"]);
    setTypeFilter(["ESTIMATE"]);
    setVipOnly(false);
    setLikedOnly(false);
    setShowCanceled(false);
    setShowArchived(false);
    setDatePreset(null);
    setOverdueActive(false);
    setUnapprovedHoursActive(false);
    const today = bizToday();
    const from = bizAddDays(today, -28);
    const to = bizAddDays(today, -7);
    setDateFrom(from);
    setDateTo(to);
    void load(true, { from, to });
  }, []);

  useEffect(() => {
    if (!forAdmin) return;
    try {
      const flag = localStorage.getItem("seedlings_adminJobs_showEstimateFollowups");
      if (flag) {
        localStorage.removeItem("seedlings_adminJobs_showEstimateFollowups");
        applyEstimateFollowups();
      }
    } catch {}
    const onShow = () => applyEstimateFollowups();
    window.addEventListener("adminJobs:showEstimateFollowups", onShow);
    return () => window.removeEventListener("adminJobs:showEstimateFollowups", onShow);
  }, [forAdmin, applyEstimateFollowups]);

  // "Hours awaiting approval" title-bar alert → wide date range (last 90
  // days) + unapprovedHoursActive flag. Window is generous so admins can
  // catch late-arriving outliers; the flag-based filter is what actually
  // narrows the view.
  const applyUnapprovedHours = useCallback(() => {
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
    setOverdueActive(false);
    const to = bizToday();
    const from = bizAddDays(to, -90);
    setDateFrom(from);
    setDateTo(to);
    setUnapprovedHoursActive(true);
    void load(true, { from, to });
  }, []);

  useEffect(() => {
    if (!forAdmin) return;
    try {
      const flag = localStorage.getItem("seedlings_adminJobs_showUnapprovedHours");
      if (flag) {
        localStorage.removeItem("seedlings_adminJobs_showUnapprovedHours");
        applyUnapprovedHours();
      }
    } catch {}
    const onShow = () => applyUnapprovedHours();
    window.addEventListener("adminJobs:showUnapprovedHours", onShow);
    return () => window.removeEventListener("adminJobs:showUnapprovedHours", onShow);
  }, [forAdmin, applyUnapprovedHours]);

  // Worker-only "peek at others" toggle. When on, the load filter is
  // relaxed to include jobs assigned to other workers (not just mine +
  // unassigned + announcements). Every occurrence surfaced only because
  // of this toggle gets tagged with `_isPeek = true` at load-time, and
  // every action-render branch on those cards is short-circuited so
  // peek-mode is read-only. Off by default. Not available to trainees
  // (their scope is intentionally narrower — see `isTrainee` below).
  // Not shown on the Admin Jobs tab (admins already see everything).
  const [peekOthers, setPeekOthers] = usePersistedState<boolean>("wjobs_peekOthers", false);

  const [datePreset, setDatePreset] = usePersistedState<DatePreset>(`${pfx}_datePreset`, "now");
  const presetDates = useMemo(() => computeDatesFromPreset(datePreset), [datePreset]);
  const [dateFrom, setDateFrom] = usePersistedState(`${pfx}_dateFrom`, presetDates.from);
  const [dateTo, setDateTo] = usePersistedState(`${pfx}_dateTo`, presetDates.to);
  const [quickDate, setQuickDate] = useState<string[]>([]);
  const [overdueActive, setOverdueActive] = useState(false);
  // "Hours awaiting approval" focused mode — entered via the title-bar
  // alert. Narrows visible rows to completed STANDARD/ONE_OFF occurrences
  // whose hoursApprovedAt is null. Reset by Clear / preset / overdue toggle.
  const [unapprovedHoursActive, setUnapprovedHoursActive] = useState(false);

  // Listen for external filter requests (e.g., from HomeTab tiles).
  // Semantics: clear all filters first, then apply only the values present in the event.
  // This way, adding new filters in the future won't accidentally leak across taps.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      // Reset all "what's shown" filters to defaults
      setStatusFilter(["ALL"]);
      setTypeFilter(["ALL"]);
      setKind(["ALL"]);
      setOverdueActive(false);
      setVipOnly(false);
      setLikedOnly(false);
      setQ("");
      setHighlightOccId(null);
      setFilterJobId(null);
      const defaultPreset: DatePreset = "now";
      const defaultDates = computeDatesFromPreset(defaultPreset);
      setDatePreset(defaultPreset);
      setDateFrom(defaultDates.from);
      setDateTo(defaultDates.to);

      // Apply explicit overrides from the event detail
      if (typeof detail.status === "string") setStatusFilter([detail.status]);
      if (typeof detail.type === "string") setTypeFilter([detail.type]);
      if (typeof detail.kind === "string") setKind([detail.kind]);
      if (typeof detail.datePreset === "string") {
        const dp = detail.datePreset as DatePreset;
        setDatePreset(dp);
        const dates = computeDatesFromPreset(dp);
        setDateFrom(dates.from);
        setDateTo(dates.to);
      }
      // Explicit from/to override the preset (so callers can pass exact ranges).
      if (typeof detail.dateFrom === "string" || typeof detail.dateTo === "string") {
        setDatePreset(null);
        if (typeof detail.dateFrom === "string") setDateFrom(detail.dateFrom);
        if (typeof detail.dateTo === "string") setDateTo(detail.dateTo);
      }
      if (detail.overdue === true) setOverdueActive(true);
      if (detail.vipOnly === true) setVipOnly(true);
      if (detail.likedOnly === true) setLikedOnly(true);
      if (typeof detail.q === "string") setQ(detail.q);
    };
    window.addEventListener("jobs:applyFilter", handler as EventListener);
    return () => window.removeEventListener("jobs:applyFilter", handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // localStorage handoff for cross-tab navigations that need to apply a
  // filter on landing (e.g. clicking a Jobs Overview metric card on the
  // Super Operations tab). The dispatching tab writes a JSON-encoded filter
  // payload, then dispatches navigate:adminTab with remount=true — this
  // tab unmounts and remounts, and we replay the filter via the existing
  // jobs:applyFilter handler above. localStorage is necessary because the
  // event-based path would race the remount (the listener isn't yet
  // registered when the dispatching tab fires the event). Key is consumed
  // on read.
  useEffect(() => {
    let raw: string | null = null;
    try { raw = localStorage.getItem("seedlings_jobs_pendingFilter"); } catch {}
    if (!raw) return;
    try { localStorage.removeItem("seedlings_jobs_pendingFilter"); } catch {}
    try {
      const detail = JSON.parse(raw);
      // Defer one tick so the handler effect above has definitely registered
      // its listener by the time we dispatch (effects run in declaration
      // order on mount, but being explicit costs us nothing).
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("jobs:applyFilter", { detail }));
      }, 0);
    } catch {
      /* malformed payload — ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [vipOnly, setVipOnly] = useState(false);
  const [likedOnly, setLikedOnly] = useState(false);
  const presetBeforeOverdueRef = useRef<DatePreset>(datePreset);

  // Daily reset for worker tab — clear filters and set time frame to "Now" on the first render of a new day
  useEffect(() => {
    if (forAdmin) return;
    const key = `${pfx}_lastUsedDate`;
    try {
      const lastDate = localStorage.getItem(key);
      const today = bizToday();
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

  // Re-apply preset dates when preset changes (e.g., on mount or when user selects a preset).
  // Worker date clamp is silently applied; no inline warning — the cap is intentional, not an error.
  useEffect(() => {
    if (overdueActive) {
      const { from, to } = clampWorkerDates(
        bizAddDays(bizToday(), -60),
        bizYesterday(),
      );
      setDateFrom(from);
      setDateTo(to);
    } else if (datePreset) {
      const d = computeDatesFromPreset(datePreset);
      const { from, to } = clampWorkerDates(d.from, d.to);
      setDateFrom(from);
      setDateTo(to);
    }
  }, [datePreset, overdueActive]);

  const quickDateItems = useMemo(
    () =>
      forAdmin
        ? [...quickDateItemsBase, { label: "This year", value: "thisYear" }, { label: "All time", value: "all" }]
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
  // Group id stashed alongside pendingClaimOccId so a "claim for group" action
  // that's interrupted by the contractor-agreement dialog resumes with the
  // group context, not as a solo claim.
  const [pendingClaimGroupId, setPendingClaimGroupId] = useState<string | null>(null);
  const isTrainee = viewAsWorkerType !== undefined ? viewAsWorkerType === "TRAINEE" : me?.workerType === "TRAINEE";
  // Peek is only active when: the toggle is on, we're on the worker
  // tab (never admin), and the current viewer isn't a trainee.
  const peekActive = peekOthers && isWorkerView && !isTrainee;
  const [manageOccurrence, setManageOccurrence] = useState<WorkerOccurrence | null>(null);
  const [completeDialogOcc, setCompleteDialogOcc] = useState<WorkerOccurrence | null>(null);
  // Admin-only "Reset Job" confirm. Holds the occurrence the admin
  // wants to reset; null when no confirm is open. Wired through
  // ConfirmDialog so an accidental thumb tap doesn't wipe time tracking.
  const [resetJobOcc, setResetJobOcc] = useState<WorkerOccurrence | null>(null);
  const [contactMenuOcc, setContactMenuOcc] = useState<string | null>(null);
  const [actionMenuOcc, setActionMenuOcc] = useState<string | null>(null);
  const [quickActionMenuOcc, setQuickActionMenuOcc] = useState<string | null>(null);
  // Open id for the "Job hours awaiting review" chip dropdown — null when closed.
  const [hoursMenuOcc, setHoursMenuOcc] = useState<string | null>(null);
  const [quickDateMenuOpen, setQuickDateMenuOpen] = useState(false);
  const [editTimeOcc, setEditTimeOcc] = useState<WorkerOccurrence | null>(null);
  // Open occurrence id for the Review-hours dialog. Cleared on Cancel /
  // Approve / Done. Stays set across an intermediate Edit-time dialog
  // open — the review dialog stays mounted underneath (stacked via the
  // Chakra Portal). Each render reads the latest occurrence from `items`,
  // so when edit-time saves and closes, the visible review reflects the
  // new times / approval state.
  const [reviewHoursOccId, setReviewHoursOccId] = useState<string | null>(null);
  const [editTimeForm, setEditTimeForm] = useState<{ startedAt: string; completedAt: string; offHours: string; offMinutes: string }>({ startedAt: "", completedAt: "", offHours: "0", offMinutes: "0" });
  useEffect(() => {
    if (!editTimeOcc) return;
    // ET-anchored datetime-local converter via the canonical helper —
    // see bizToLocalInputValue in lib/lib.ts. Browser-local round-trip
    // was the bug here previously.
    const toLocal = (iso?: string | null) =>
      iso ? bizToLocalInputValue(iso) : "";
    const offMs = editTimeOcc.totalPausedMs ?? 0;
    const offMinTotal = Math.max(0, Math.round(offMs / 60000));
    setEditTimeForm({
      startedAt: toLocal(editTimeOcc.startedAt),
      completedAt: toLocal(editTimeOcc.completedAt),
      offHours: String(Math.floor(offMinTotal / 60)),
      offMinutes: String(offMinTotal % 60),
    });
  }, [editTimeOcc]);
  const [busyOccId, setBusyOccId] = useState<string | null>(null);
  const [addAddonOcc, setAddAddonOcc] = useState<WorkerOccurrence | null>(null);
  const [addonTag, setAddonTag] = useState<string>("");
  const [addonCustomLabel, setAddonCustomLabel] = useState("");
  const [addonPrice, setAddonPrice] = useState("");
  const [addonBusy, setAddonBusy] = useState(false);
  // Pricing entries (with jobTags bindings) — loaded when the add-on
  // dialog is open so we can show an inline reference price next to the
  // price input when the selected tag matches one of the entry's tags.
  type PricingHintEntry = { key: string; parsedValue: { label: string; amount: number; unit: string; jobTags?: string[] | null; jobTag?: string | null } | null };
  const [pricingHints, setPricingHints] = useState<PricingHintEntry[]>([]);
  const [pricingGuideOpen, setPricingGuideOpen] = useState(false);
  useEffect(() => {
    if (!addAddonOcc) return;
    apiGet<PricingHintEntry[]>(forAdmin ? "/api/admin/pricing" : "/api/pricing")
      .then((list) => setPricingHints(Array.isArray(list) ? list : []))
      .catch(() => setPricingHints([]));
  }, [addAddonOcc, forAdmin]);
  const addonHintEntry = useMemo(() => {
    if (!addonTag) return null;
    return pricingHints.find((p) => pricingJobTags(p.parsedValue).includes(addonTag)) ?? null;
  }, [pricingHints, addonTag]);
  const [photoPromptOccId, setPhotoPromptOccId] = useState<string | null>(null);

  // Close quick action menu on outside click
  useEffect(() => {
    if (!quickActionMenuOcc) return;
    const close = () => setQuickActionMenuOcc(null);
    const timer = setTimeout(() => document.addEventListener("click", close), 50);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [quickActionMenuOcc]);

  useEffect(() => {
    if (!contactMenuOcc) return;
    const close = () => setContactMenuOcc(null);
    const timer = setTimeout(() => document.addEventListener("click", close), 50);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [contactMenuOcc]);

  // Pre-fetched payment-request message for the currently-open contact
  // dropdown. The Request Payment shortcut in the dropdown uses this
  // (instead of the local fallback in getQuickMessage) so the SMS/email
  // contains the same body + invoice link as the inline Request Payment
  // button on the expanded card. Cleared when the dropdown closes.
  const [dropdownPayMsg, setDropdownPayMsg] = useState<{
    occurrenceId: string;
    smsBody: string;
    emailSubject: string;
    emailBody: string;
  } | null>(null);
  useEffect(() => {
    if (!contactMenuOcc) { setDropdownPayMsg(null); return; }
    const occ = items.find((o) => o.id === contactMenuOcc);
    if (!occ || occ.status !== "PENDING_PAYMENT") { setDropdownPayMsg(null); return; }
    if (dropdownPayMsg?.occurrenceId === contactMenuOcc) return; // already loaded
    let cancelled = false;
    apiGet<{ smsBody: string; emailSubject: string; emailBody: string }>(
      `/api/occurrences/${contactMenuOcc}/comms-handoff`,
    )
      .then((d) => {
        if (cancelled) return;
        setDropdownPayMsg({
          occurrenceId: contactMenuOcc,
          smsBody: d.smsBody,
          emailSubject: d.emailSubject,
          emailBody: d.emailBody,
        });
      })
      .catch(() => { /* leave null — the local fallback in getQuickMessage covers us */ });
    return () => { cancelled = true; };
  }, [contactMenuOcc, items, dropdownPayMsg]);

  useEffect(() => {
    if (!actionMenuOcc) return;
    const close = () => setActionMenuOcc(null);
    const timer = setTimeout(() => document.addEventListener("click", close), 50);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [actionMenuOcc]);

  useEffect(() => {
    if (!hoursMenuOcc) return;
    const close = () => setHoursMenuOcc(null);
    const timer = setTimeout(() => document.addEventListener("click", close), 50);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [hoursMenuOcc]);

  useEffect(() => {
    if (!quickDateMenuOpen) return;
    const close = () => setQuickDateMenuOpen(false);
    const timer = setTimeout(() => document.addEventListener("click", close), 50);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [quickDateMenuOpen]);

  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    /** Optional richer JSX body — replaces `message` text when set. */
    messageNode?: React.ReactNode;
    confirmLabel: string;
    colorPalette: string;
    onConfirm: ((inputValue: string, amountValue?: string) => void) | (() => void);
    inputPlaceholder?: string;
    inputLabel?: string;
    inputOptional?: boolean;
    inputDefaultValue?: string;
    amountLabel?: string;
    amountPlaceholder?: string;
    amountDefaultValue?: string;
    /** Tags to drive the pricing reference panel (Complete Estimate flow). */
    pricingReferenceTags?: string[];
    cancelLabel?: string;
    onCancelAction?: () => void;
    warning?: string;
    secondaryActionFirst?: boolean;
    /** Per-action impersonation override — name of the worker on whose
     *  behalf this specific admin action is happening (e.g. the claimer
     *  of the job being mutated). Used when the tab-level
     *  effectiveViewAsName is null (admin not viewing-as a single
     *  worker) but the action still affects a particular worker's
     *  record. Passed straight through to ConfirmDialog's viewAsName. */
    viewAsName?: string | null;
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
  const [promptOccDefaults, setPromptOccDefaults] = useState<{ notes?: string | null; price?: number | null; estimatedMinutes?: number | null; jobTags?: string[] | null; jobType?: string | null }>({});

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

  // Workers limited to ~2-month date range — clamp and return adjusted dates.
  // String-based math only: the previous `new Date(from + "T00:00:00")` parsed
  // the YYYY-MM-DD in the BROWSER's local timezone, so a worker in PST got a
  // window shifted by 8 hours and the millisecond clamp could drop / add an
  // extra day at the boundary. bizDaysBetween + bizAddDays keep everything
  // anchored to ET regardless of where the worker's device clock is.
  function clampWorkerDates(from: string, to: string): { from: string; to: string; clamped: boolean } {
    if (forAdmin) return { from, to, clamped: false };
    const MAX_DAYS = 62;
    if (from && to) {
      if (bizDaysBetween(from, to) > MAX_DAYS) {
        return { from: bizAddDays(to, -MAX_DAYS), to, clamped: true };
      }
    } else if (!from && to) {
      return { from: bizAddDays(to, -MAX_DAYS), to, clamped: true };
    } else if (from && !to) {
      return { from, to: bizAddDays(from, MAX_DAYS), clamped: true };
    }
    return { from, to, clamped: false };
  }

  // Load sequence guard — prevents stale async results from overwriting newer ones.
  const loadSeqRef = useRef(0);

  async function load(displayLoading = true, overrideDates?: { from?: string; to?: string }, keepOccId?: string) {
    const seq = ++loadSeqRef.current;
    setLoading(displayLoading);
    try {
      const qs = new URLSearchParams();
      const rawFrom = overrideDates?.from ?? dateFrom;
      const rawTo = overrideDates?.to ?? dateTo;
      const { from: qFrom, to: qTo } = clampWorkerDates(rawFrom, rawTo);

      if (qFrom) qs.set("from", qFrom);
      if (qTo) qs.set("to", qTo);
      if (keepOccId) qs.set("includeOccId", keepOccId);
      // When admin is impersonating a single worker, ask the API to attach that
      // worker's reminders/pins/likes instead of the admin's. Without this the DUE
      // filter (which keys off attached reminders) would show the admin's reminders
      // on the worker's jobs — usually nothing matches.
      if (forAdmin && viewAsUserIds?.length === 1) {
        qs.set("viewAsUserId", viewAsUserIds[0]);
      }
      const url = `/api/occurrences${qs.toString() ? `?${qs}` : ""}`;
      let list = await apiGet<WorkerOccurrence[]>(url);
      // If a newer load() started while this one was in flight, drop these results.
      if (seq !== loadSeqRef.current) return;
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
          // Trainees only see jobs they are assigned to (no unassigned/
          // claimable). Timeline events (workflow=EVENT) are admin-only —
          // hidden even if the trainee was somehow assigned. Backend
          // /occurrences also enforces this; the frontend filter is a
          // belt-and-suspenders guard.
          list = list.filter((occ) => {
            if (occ.workflow === "EVENT") return false;
            const assignees = occ.assignees ?? [];
            return assignees.some((a) => a.userId === myId);
          });
        } else {
          // Worker view — show only my jobs + unassigned (claimable) +
          // announcements + highlighted occurrence. Timeline events
          // (workflow=EVENT) are admin-only and hidden entirely.
          // Followups remain team-scoped: visible to assignees only.
          //
          // When `peekActive`, we ALSO keep occurrences assigned to
          // OTHER workers (not me + not unassigned + not announcements)
          // and tag them with `_isPeek = true`. Downstream renders
          // treat peek cards as strictly view-only.
          list = list.filter((occ) => {
            if (keepOccId && occ.id === keepOccId) return true;
            // Events are admin-only Timeline items — hide from all
            // non-admin workers regardless of assignment.
            if (occ.workflow === "EVENT") return false;
            // Announcements are universally visible
            if (occ.workflow === "ANNOUNCEMENT") return true;
            const assignees = occ.assignees ?? [];
            // Followups: only show if user is an assignee (peek does
            // NOT expand this — followups are team-scoped by design).
            if (occ.workflow === "FOLLOWUP") {
              return assignees.some((a) => a.userId === myId);
            }
            const mineOrOpen = assignees.length === 0 || assignees.some((a) => a.userId === myId);
            if (mineOrOpen) return true;
            // Peek: show others' assigned jobs. Server has already
            // stripped financials on these and set `_peekRedacted =
            // true`; the per-card renderer uses that flag as the
            // isPeek signal — no client-side tagging needed here.
            return peekActive;
          });
        }
      }
      // Re-check seq before mutating state in case state-deriving filters above were async.
      if (seq !== loadSeqRef.current) return;
      setItems(list);
      // Admin-only: pull Timeline activities + doc expirations and mix them
      // into the feed. Failures are non-fatal — the main jobs view still
      // renders if the timeline endpoint is unhappy.
      //
      // SUPPRESS this fetch when the admin is "viewing as" another user —
      // the whole point of that mode is to mirror what the selected worker
      // sees, and non-admin workers never see Timeline activities or doc
      // expirations. Without this guard, an admin viewing as a worker
      // would still see admin-only Timeline rows mixed into the feed,
      // contradicting the view-as semantics.
      if (forAdmin && !viewAsUserIds?.length) {
        try {
          type UpcomingApiRow =
            | {
                kind: "event";
                id: string;
                title: string;
                description: string | null;
                category: string | null;
                rrule: string | null;
                nextDate: string;
                adminHidden: boolean;
              }
            | {
                kind: "document_expiration";
                documentId: string;
                title: string;
                type: string;
                nextDate: string;
                adminHidden: boolean;
              };
          // Super uses /super/ — includes adminHidden Timeline activities
          // and documents (which only super admins can create/view). Admin
          // uses /admin/ — the same endpoint with adminHidden filtered out
          // server-side. The title-bar alert count at pages/index.tsx
          // already follows this same split; keep both surfaces in sync.
          const timelineEndpoint = isSuper
            ? "/api/super/timeline/upcoming?includeDocs=1"
            : "/api/admin/timeline/upcoming?includeDocs=1";
          const fr = await apiGet<UpcomingApiRow[]>(timelineEndpoint);
          if (seq !== loadSeqRef.current) return;
          const rows: ForeignRow[] = (Array.isArray(fr) ? fr : []).map((r) =>
            r.kind === "event"
              ? {
                  kind: "activity" as const,
                  id: r.id,
                  title: r.title,
                  description: r.description,
                  category: r.category,
                  rrule: r.rrule,
                  nextDueDate: r.nextDate,
                  adminHidden: r.adminHidden,
                }
              : {
                  kind: "doc_expiration" as const,
                  documentId: r.documentId,
                  title: r.title,
                  type: r.type,
                  expiresAt: r.nextDate,
                  adminHidden: r.adminHidden,
                },
          );
          setForeignRows(rows);
        } catch {
          setForeignRows([]);
        }
      } else {
        setForeignRows([]);
      }
      // NB: don't dispatch `seedlings3:jobs-changed` here — load() is a
      // read-only fetch, not a mutation, and JobsTab listens for the same
      // event itself (to refresh after other tabs mutate). Firing here
      // creates an infinite load → event → load loop. Real mutation
      // handlers (e.g. resetJob) fire the event themselves.
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load jobs.", err),
      });
      setItems([]);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
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
        const hv = list.find((r: any) => r.key === "HOURS_APPROVAL_VARIANCE_THRESHOLD_PERCENT");
        if (hv?.value) {
          const pct = Number(hv.value);
          if (Number.isFinite(pct) && pct >= 0) setHoursVarianceThreshold(pct / 100);
        }
        const c = list.find((r: any) => r.key === "CONTRACTOR_PLATFORM_FEE_PERCENT");
        if (c?.value) setCommissionPercent(Number(c.value));
        const m = list.find((r: any) => r.key === "EMPLOYEE_BUSINESS_MARGIN_PERCENT");
        if (m?.value) setMarginPercent(Number(m.value));
        const st = list.find((r: any) => r.key === "SERVICE_TYPES");
        if (st?.value) { const parsed = parseServiceTypesConfig(st.value); if (parsed) setServiceTypes(parsed); }
        const ek = list.find((r: any) => r.key === "EQUIPMENT_KINDS");
        if (ek?.value) { const parsed = parseEquipmentKindsConfig(ek.value); if (parsed) setEquipmentKinds(parsed); }
      })
      .catch(() => {});
    apiGet<CollectionLite[]>("/api/equipment-collections")
      .then((list) => setEquipmentCollections(Array.isArray(list) ? list : []))
      .catch(() => setEquipmentCollections([]));
  }, [dateFrom, dateTo, viewAsUserIds, isTrainee, peekActive]);

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

  // Re-fetch when another tab (e.g. admin Services edits an
  // occurrence's startedAt / completedAt / status) signals that job
  // data changed. Without this, the JobsTab card stays on its stale
  // snapshot — e.g. still shows "Complete Job" even though an admin
  // just cleared the start time on Services.
  useEffect(() => {
    const handler = () => { void loadRef.current(false); };
    window.addEventListener("seedlings3:jobs-changed", handler);
    // The admin Jobs feed mixes Timeline activities + doc-expiration rows
    // in via foreignRows (see load() below). When the operator adds /
    // edits / completes a Timeline activity from the Timeline tab or
    // updates a document, that surface must refresh so the new row
    // appears in the feed without a hard reload.
    window.addEventListener("seedlings3:timeline-changed", handler);
    window.addEventListener("seedlings3:documents-changed", handler);
    return () => {
      window.removeEventListener("seedlings3:jobs-changed", handler);
      window.removeEventListener("seedlings3:timeline-changed", handler);
      window.removeEventListener("seedlings3:documents-changed", handler);
    };
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
    const todayStr = bizDateKey(new Date());
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

  // Apply the highlight: clear filters, set a date range covering the occurrence,
  // fetch with includeOccId. Shared by both the legacy event listener (OAuth
  // deep-link path) and the localStorage handoff from in-app "View →" links.
  //
  // When an anchor date is known, set the date filter to that single day —
  // the recipient sees a Custom range pinned to the job's date instead of
  // their default ("Now"). Without an anchor (older share links), fall back
  // to a wide range so includeOccId can still locate the row.
  function applyHighlight(occId: string, anchorAt?: string | null) {
    setHighlightOccId(occId);
    setCardOverrides(new Map([[occId, "expanded"]]));
    setFilterJobId(null);
    setQ("");
    setOverdueActive(false);
    setDatePreset(null);
    let fromStr: string;
    let toStr: string;
    if (anchorAt) {
      const day = bizDateKey(new Date(anchorAt));
      fromStr = day;
      toStr = day;
    } else {
      // ET-anchored ±1 year window via the canonical helpers.
      fromStr = bizAddYears(bizToday(), -1);
      toStr = bizAddYears(bizToday(), 1);
    }
    setDateFrom(fromStr);
    setDateTo(toStr);
    void load(true, { from: fromStr, to: toStr }, occId);
  }

  // Deep-link: highlight a specific occurrence (from calendar feed URL or share link)
  useEffect(() => {
    (window as any).__jobsTabReady = true;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ occId: string; anchorAt?: string | null }>).detail;
      const occId = detail?.occId;
      if (!occId) return;
      applyHighlight(occId, detail?.anchorAt ?? null);
    };
    window.addEventListener("jobsTab:highlightOcc", handler);
    return () => {
      (window as any).__jobsTabReady = false;
      window.removeEventListener("jobsTab:highlightOcc", handler);
    };
  }, []);


  // In-app handoff: RemindersTab's "View →" links pre-write `<occId>|<startAt>`
  // to localStorage and force a remount. This effect runs once on every fresh
  // mount, consumes the key, and applies the highlight with a narrow date range
  // anchored on startAt — that prevents clampWorkerDates from clobbering the
  // range. The OAuth deep-link path keeps using the event listener above.
  useEffect(() => {
    let pending: string | null = null;
    try { pending = localStorage.getItem("seedlings_jobs_pendingHighlight"); } catch {}
    if (!pending) return;
    try { localStorage.removeItem("seedlings_jobs_pendingHighlight"); } catch {}
    const sepIdx = pending.indexOf("|");
    const occId = sepIdx >= 0 ? pending.slice(0, sepIdx) : pending;
    const anchor = sepIdx >= 0 ? pending.slice(sepIdx + 1) : "";
    applyHighlight(occId, anchor || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshOverdueCount() {
    try {
      let list = await apiGet<WorkerOccurrence[]>(
        `/api/occurrences?to=${bizYesterday()}`
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

  async function claim(occurrenceId: string, groupId?: string | null) {
    // All workers must accept payout terms before claiming. The agreement
    // dialog interrupts the flow on first use; we stash both the occurrence
    // id AND the group id so the resumed claim still goes to the group
    // (not silently downgraded to a solo claim).
    if (!agreementDialogOpen) {
      setPendingClaimOccId(occurrenceId);
      setPendingClaimGroupId(groupId ?? null);
      setAgreementDialogOpen(true);
      return;
    }

    setBusyOccId(occurrenceId);
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/claim`, groupId ? { groupId } : {});
      publishInlineMessage({ type: "SUCCESS", text: groupId ? "Job claimed for group." : "Job claimed." });
      bumpTitleBarEarnings();
      await load(false);
    } catch (err: any) {
      const code = err?.code ?? "";
      if (code === "CONTRACTOR_AGREEMENT_REQUIRED") {
        setPendingClaimOccId(occurrenceId);
        setPendingClaimGroupId(groupId ?? null);
        setAgreementDialogOpen(true);
      } else if (code === "POLICIES_REQUIRED") {
        // The compliance-policy system throws this when one or more
        // required policies (insurance, safety SOP, etc.) are unsigned
        // or expired. Slice 3 wires the reactive sign wizard here.
        publishInlineMessage({
          type: "ERROR",
          text: "Compliance policies are outstanding. Open the Compliance section to sign before claiming this job.",
        });
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
    setBusyOccId(null);
  }

  async function unclaim(occurrenceId: string) {
    setBusyOccId(occurrenceId);
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/unclaim`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Job unclaimed." });
      bumpTitleBarEarnings();
      await load(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Unclaim failed.", err),
      });
    }
    setBusyOccId(null);
  }

  async function completeEstimate(occurrenceId: string, comments: string, amount?: string) {
    setBusyOccId(occurrenceId);
    try {
      const proposalAmount = amount && amount.trim() !== "" ? parseFloat(amount) : null;
      await apiPost(`/api/occurrences/${occurrenceId}/submit-proposal`, {
        proposalNotes: comments || undefined,
        ...(proposalAmount != null && !Number.isNaN(proposalAmount) ? { proposalAmount } : {}),
      });
      publishInlineMessage({ type: "SUCCESS", text: "Estimate completed." });
      await load(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Complete estimate failed.", err) });
    }
    setBusyOccId(null);
  }

  async function updateStatus(occ: WorkerOccurrence, action: "start" | "complete", notes?: string, recordLocation = true) {
    setBusyOccId(occ.id);
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
      setBusyOccId(null);
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
    setBusyOccId(null);
  }

  // Single source of truth for the "Confirm Client?" dialog. Rendered as a
  // tri-action prompt: confirm the client, request confirmation (deep-link
  // SMS/email), or cancel. Used by every Confirm-Client entry point (ultra,
  // semi, expanded card) so the experience stays identical across densities.
  function openConfirmClientDialog(occ: WorkerOccurrence) {
    // Prefer the property's pointOfContact ONLY when they have a phone
    // or email — otherwise fall back to any active client contact that
    // does. The old `directPoc ?? fallbackPoc` short-circuited as soon
    // as a pointOfContact existed, even one with no contact info; so a
    // property where the designated POC is the owner (no phone/email)
    // but a secondary contact (e.g. spouse, neighbor) has a phone would
    // still hide the Request Confirmation button. Fix: gate the
    // preference on `directPoc` actually being reachable.
    const directPoc = (occ.job?.property as any)?.pointOfContact;
    const directPocReachable = !!(directPoc?.phone || directPoc?.email);
    const clientContacts: any[] = (occ.job?.property as any)?.client?.contacts ?? [];
    const fallbackPoc = clientContacts.find((c) => c?.phone || c?.email) ?? null;
    // If the POC has comms info → use POC.
    // Else if any contact has comms info → use that contact.
    // Else fall back to POC (just for name display; canRequest will be false).
    const poc = directPocReachable ? directPoc : (fallbackPoc ?? directPoc);
    const pocPhone: string | null = poc?.phone ?? null;
    const pocEmail: string | null = poc?.email ?? null;
    const pocName: string | null = poc?.firstName
      ? `${poc.firstName}${poc.lastName ? ` ${poc.lastName}` : ""}`
      : null;
    const quick = getQuickMessage(occ, pocName);
    const canRequest = !!(quick && (pocPhone || pocEmail));

    // Per-action impersonation: when the admin is taking this action on
    // Admin Jobs, name the worker on whose behalf it's happening. Falls
    // back through (a) the tab-level viewAs name (if admin is viewing-as
    // one worker), then (b) the job's claimer, then (c) the first active
    // non-observer assignee. Workers on the Worker Jobs tab confirm
    // their own jobs — no impersonation, so this is null.
    let actionViewAsName: string | null = effectiveViewAsName;
    if (!actionViewAsName && forAdmin) {
      const activeAssignees = (occ.assignees ?? []).filter((a: any) => a.role !== "observer");
      const claimer = activeAssignees.find((a: any) => a.assignedById === a.userId);
      const target = claimer ?? activeAssignees[0] ?? null;
      const name = target?.user?.displayName ?? target?.user?.email ?? null;
      if (name) actionViewAsName = name;
    }

    // Dialog body — always informative, regardless of whether the
    // Request Confirmation messaging branch is reachable. Previously
    // this was empty when no contact info existed, leaving a
    // title-only dialog with no context for the admin to decide.
    const propertyLabel = (occ.job?.property as any)?.displayName ?? "this property";
    const clientLabel_ = (occ.job?.property as any)?.client?.displayName ?? null;
    const propertyAndClient = clientLabel_ ? `${propertyLabel} — ${clientLabel_}` : propertyLabel;
    const dateStr = occ.startAt
      ? fmtDateOpts(occ.startAt, { weekday: "long", month: "long", day: "numeric" })
      : "this upcoming appointment";
    const bodyText = `Mark the client as having confirmed the ${dateStr} appointment for ${propertyAndClient}. Confirm only if the client has actually approved.`;

    // Safety warning — also always shown. When the messaging branch is
    // available we steer the admin to the "Request Confirmation" path;
    // otherwise we surface the same advisory + how to add contact info.
    const baseWarning = "Only confirm if the client has approved the appointment. Starting a job without the client's go-ahead can cause issues.";
    const warningText = canRequest
      ? `${baseWarning} If you haven't heard back yet, tap "Request Confirmation" to send them a message.`
      : `${baseWarning} No phone or email is on file for this property — add a contact via the Clients tab if you need to message them.`;

    setConfirmAction({
      title: "Confirm Client?",
      message: bodyText,
      confirmLabel: "Yes, Confirmed",
      colorPalette: "orange",
      viewAsName: actionViewAsName,
      warning: warningText,
      onConfirm: async () => {
        setBusyOccId(occ.id);
        try {
          await apiPost(`/api/occurrences/${occ.id}/confirm`);
          setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, isClientConfirmed: true } as any : o));
          publishInlineMessage({ type: "SUCCESS", text: "Client confirmed." });
        } catch (err) {
          publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to confirm.", err) });
        }
        setBusyOccId(null);
      },
      ...(canRequest
        ? {
            cancelLabel: "Request Confirmation",
            onCancelAction: async () => {
              const cc = await fetchCommsCc();
              if (pocPhone) {
                window.open(buildSmsHref({ to: pocPhone, body: quick!.body, ccPhones: cc.phones }), "_self");
              } else if (pocEmail) {
                window.open(buildMailtoHref({ to: pocEmail, subject: "Seedlings Lawn Care", body: quick!.body, ccEmails: cc.emails }), "_self");
              }
            },
            secondaryActionFirst: true,
          }
        : {}),
    });
  }

  // Single entry point for starting a job. Online: opens the Start Job dialog
  // with the time pre-filled to "now". Offline: enqueues a START_JOB action,
  // optimistically flips the card to IN_PROGRESS, surfaces a queued-for-sync
  // toast. Used by every density (ultra, semi, expanded) so the behavior is
  // identical everywhere — including the busy-indicator handling.
  function openStartJobDialog(occ: WorkerOccurrence) {
    // Two-stage gate. Skipped for admin views and offline (offline
    // still queues; the server enforces when sync runs). Cancel from
    // either dialog throws a recognized error which we silently swallow.
    //
    //   Stage 1 (claimer): withWorkday blocks until THE ACTOR confirms
    //                      or starts their own workday.
    //   Stage 2 (team):    once the claimer is on the clock, the
    //                      server-backed team-workday-check returns
    //                      any teammates who AREN'T ready. If any,
    //                      the team-not-ready dialog opens and the
    //                      time picker stays closed — the user
    //                      shouldn't have to type a start time only
    //                      to be rejected after submitting.
    //   Only when both stages pass do we open the time picker.
    if (useWorkdayGuard && !isOffline) {
      void workdayGate.withWorkday(async () => {
        // Stage 2 — pre-check teammates' workday state. Server-side
        // /start gate remains in place as defense in depth.
        try {
          const check = await apiGet<{ notReady: NotReadyTeammate[] }>(
            `/api/occurrences/${occ.id}/team-workday-check`,
          );
          if (Array.isArray(check?.notReady) && check.notReady.length > 0) {
            teamWorkdayDialog.show(check.notReady);
            return;
          }
        } catch {
          // Fail-open: if the pre-check errors (network blip, etc.)
          // fall through to the time picker. The /start endpoint
          // still enforces the gate and the reactive
          // handleTeamWorkdayError catch will surface the dialog
          // afterward.
        }
        openStartJobDialogInner(occ);
      }).catch((err: any) => {
        if (err?.message !== "GATE_CANCELLED") throw err;
      });
      return;
    }
    openStartJobDialogInner(occ);
  }

  function openStartJobDialogInner(occ: WorkerOccurrence) {
    if (isOffline) {
      void (async () => {
        setBusyOccId(occ.id);
        try {
          await enqueueAction("START_JOB", occ.id, queueLabel(occ, "Start job"), { notes: undefined, lat: null, lng: null });
          setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, status: "IN_PROGRESS" as any, startedAt: new Date().toISOString() } : o));
          publishInlineMessage({ type: "INFO", text: "Job started (queued for sync)." });
        } finally {
          setBusyOccId(null);
        }
      })();
      return;
    }
    // ET-anchored datetime-local string so a worker outside ET sees
    // (and submits) the time their team is operating on, not the time
    // on their device clock.
    setStartJobTime(bizToLocalInputValue(new Date()));
    setStartJobOcc(occ);
  }

  async function pauseJob(occ: WorkerOccurrence) {
    setBusyOccId(occ.id);
    if (isOffline) {
      await enqueueAction("PAUSE_JOB" as any, occ.id, queueLabel(occ, "Pause job"), {});
      setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, status: "PAUSED" as any, pausedAt: new Date().toISOString() } : o));
      publishInlineMessage({ type: "INFO", text: "Job paused (queued for sync)." });
      setBusyOccId(null);
      return;
    }
    try {
      await apiPost(`/api/occurrences/${occ.id}/pause`);
      setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, status: "PAUSED" as any, pausedAt: new Date().toISOString() } : o));
      publishInlineMessage({ type: "SUCCESS", text: "Job paused." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to pause.", err) });
    }
    setBusyOccId(null);
  }

  // Shared approve-hours handler. Returns after the server confirms the
  // mutation and the local items array has been patched with the response.
  // Callers should await this before closing any dialog so the user doesn't
  // see a flash of stale "needs review" state on the card after click.
  async function approveHoursAction(occ: WorkerOccurrence) {
    setBusyOccId(occ.id);
    try {
      // Pull hoursApprovedAt/hoursApprovedById from the server response —
      // optimistically using `new Date()` would drift from the DB and
      // could even fail to clear the chip if a re-fetch interleaved.
      const updated = await apiPost<{ id: string; hoursApprovedAt?: string; hoursApprovedById?: string }>(
        `/api/admin/occurrences/${occ.id}/approve-hours`,
        {},
      );
      setItems((prev) => prev.map((o) =>
        o.id === occ.id
          ? {
              ...o,
              hoursApprovedAt: updated?.hoursApprovedAt ?? new Date().toISOString(),
              hoursApprovedById: updated?.hoursApprovedById ?? null,
            } as any
          : o,
      ));
      window.dispatchEvent(new CustomEvent("seedlings3:jobs-changed"));
      publishInlineMessage({ type: "SUCCESS", text: "Hours approved for payroll." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to approve hours.", err) });
      throw err;
    } finally {
      setBusyOccId(null);
    }
  }

  // Opens the Review-hours dialog. The dialog itself reads the latest
  // occurrence from `items` each render, so an intermediate edit-time save
  // is reflected automatically when the user returns to it.
  function openApproveHoursDialog(occ: WorkerOccurrence) {
    setReviewHoursOccId(occ.id);
  }

  async function resumeJob(occ: WorkerOccurrence) {
    // Workday gate — resuming a job is forward-direction work; treat it
    // like Start. Skipped for admin and offline (server is the backstop).
    if (useWorkdayGuard && !isOffline) {
      try {
        await workdayGate.withWorkday(async () => {
          await resumeJobInner(occ);
        });
      } catch (err: any) {
        if (err?.message === "GATE_CANCELLED") return;
        throw err;
      }
      return;
    }
    await resumeJobInner(occ);
  }

  async function resumeJobInner(occ: WorkerOccurrence) {
    setBusyOccId(occ.id);
    if (isOffline) {
      await enqueueAction("RESUME_JOB" as any, occ.id, queueLabel(occ, "Resume job"), {});
      const addedPause = occ.pausedAt ? Date.now() - new Date(occ.pausedAt).getTime() : 0;
      setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, status: "IN_PROGRESS" as any, pausedAt: null, totalPausedMs: (o.totalPausedMs ?? 0) + addedPause } : o));
      publishInlineMessage({ type: "INFO", text: "Job resumed (queued for sync)." });
      setBusyOccId(null);
      return;
    }
    try {
      await apiPost(`/api/occurrences/${occ.id}/resume`);
      const addedPause = occ.pausedAt ? Date.now() - new Date(occ.pausedAt).getTime() : 0;
      setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, status: "IN_PROGRESS" as any, pausedAt: null, totalPausedMs: (o.totalPausedMs ?? 0) + addedPause } : o));
      publishInlineMessage({ type: "SUCCESS", text: "Job resumed." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to resume.", err) });
    }
    setBusyOccId(null);
  }

  // Admin-only "Reset Job" — clears start/complete timestamps and any
  // accrued time tracking, reverts status to SCHEDULED, and wipes any
  // payment row that snuck in (handled by updateOccurrence's existing
  // revert branch). The scheduled date (startAt) is intentionally
  // untouched. Server-side handles the actual state transitions: we
  // just PATCH startedAt=null and the auto-revert logic in jobs.ts
  // does the rest. See services/jobs.ts:updateOccurrence.
  async function resetJob(occ: WorkerOccurrence) {
    setBusyOccId(occ.id);
    try {
      await apiPatch(`/api/admin/occurrences/${occ.id}`, { startedAt: null });
      await load(false);
      publishInlineMessage({ type: "SUCCESS", text: "Job reset to Scheduled." });
      window.dispatchEvent(new CustomEvent("seedlings3:jobs-changed"));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to reset job.", err) });
    }
    setBusyOccId(null);
  }

  const filtered = useMemo(() => {
    let rows = items;
    // Enforce date range — items outside the range should not appear in the feed.
    // Exception: pinned, liked, and ACTIONABLE reminded items bypass the date filter so
    // they're never hidden in the default view. The bypass is suppressed when the user
    // explicitly picked "JOBS" type — they want jobs scheduled in this date range only,
    // not pinned/reminded items from other dates leaking through.
    const reminderBypassFinished = new Set(["COMPLETED", "CLOSED", "PENDING_PAYMENT", "ARCHIVED", "CANCELED"]);
    const allowDateBypass = typeFilter[0] !== "JOBS";
    if (dateFrom || dateTo) {
      rows = rows.filter((occ) => {
        // Pins are explicit "always show this" markers — they bypass the date
        // window. Likes are just bookmarks; they should still respect filters.
        if (allowDateBypass && pinnedIds.has(occ.id)) return true;
        if (allowDateBypass && (occ as any).reminder && !reminderBypassFinished.has(occ.status as string)) return true;
        // A reminder/pinned ghost is placed on its ghost date (the reminder's
        // remindAt), not the underlying occurrence's startAt — so a reminder
        // set on a job from another date surfaces in the range that contains
        // the reminder date. Mirrors the day-grouping logic below. Without
        // this, a reminder on a completed (past-dated) job stays pinned to
        // that past date and never appears in a future range like "this week".
        const ghostDate = (occ as any)._ghostDate;
        const isGhost = ((occ as any)._isReminderGhost || (occ as any)._isPinnedGhost) && ghostDate;
        // Each row's "presence" in the date range is decided by every
        // meaningful date stamped on the occurrence — its scheduled
        // start AND (when present) its completion date. This way a job
        // scheduled 5/30 but completed 5/31 shows under both "Last
        // week" (matches via startAt) and "Yesterday" (matches via
        // completedAt). The visual grouping below stays on startAt so
        // the section header still reads 5/30; only inclusion changes.
        const candidates: string[] = [];
        if (isGhost) {
          candidates.push(
            typeof ghostDate === "string" && ghostDate.length === 10
              ? ghostDate
              : bizDateKey(ghostDate),
          );
        } else {
          if (occ.startAt) candidates.push(bizDateKey(occ.startAt));
          if ((occ as any).completedAt) candidates.push(bizDateKey((occ as any).completedAt));
          // An attached reminder makes the row "present" in the range
          // — but only on the WORKER view, where the dayGroups block
          // below adds a future ghost card at the reminder date and
          // suppresses the past-dated original. In ADMIN view there's
          // no ghost machinery: the row would pass the filter via the
          // reminder date but get grouped at its natural startAt,
          // leaking observer-only / past jobs into the visible window
          // (e.g. an admin's reminder on a completed observer job
          // from 9 days ago appearing under "Wed Jun 10" inside a
          // "this week" filter). Admins browsing by date want jobs
          // whose actual scheduled / completed date is in range.
          if (isWorkerView && (occ as any).reminder?.remindAt) {
            candidates.push(bizDateKey((occ as any).reminder.remindAt));
          }
        }
        if (candidates.length === 0) return true; // no date — include
        return candidates.some((day) => {
          if (dateFrom && day < dateFrom) return false;
          if (dateTo && day > dateTo) return false;
          return true;
        });
      });
    }
    // Trainees should not see tentative jobs
    if (isTrainee) rows = rows.filter((occ) => !occ.isTentative);
    if (kind[0] !== "ALL") rows = rows.filter((occ) => occ.kind === kind[0]);
    const tf = typeFilter[0];
    // "JOBS" = real jobs only (STANDARD / ONE_OFF / ESTIMATE / untyped legacy). Used by
    // tile click-throughs (Today's jobs, Tomorrow's plan, etc.) so the feed matches the
    // dashboard count instead of also showing tasks/reminders/events. Also strips ghost
    // reminder cards the API injects (occurrences from other dates pulled in because
    // they have a reminder attached) — those aren't "jobs scheduled today".
    if (tf === "JOBS") {
      rows = rows.filter((occ) => {
        if ((occ as any)._isReminderGhost) return false;
        const w = occ.workflow;
        return w === "STANDARD" || w === "ONE_OFF" || w === "ESTIMATE" || !w;
      });
    }
    else if (tf === "ONE_OFF") rows = rows.filter((occ) => occ.isOneOff);
    else if (tf === "ESTIMATE") rows = rows.filter((occ) => occ.isEstimate);
    else if (tf === "TENTATIVE") rows = rows.filter((occ) => occ.isTentative);
    else if (tf === "TASK") rows = rows.filter((occ) => occ.workflow === "TASK");
    else if (tf === "REMINDER") rows = rows.filter((occ) => occ.workflow === "REMINDER");
    else if (tf === "EVENT") rows = rows.filter((occ) => occ.workflow === "EVENT");
    else if (tf === "FOLLOWUP") rows = rows.filter((occ) => occ.workflow === "FOLLOWUP");
    else if (tf === "ANNOUNCEMENT") rows = rows.filter((occ) => occ.workflow === "ANNOUNCEMENT");
    else if (tf === "NOTICES") rows = rows.filter((occ) => occ.workflow === "ANNOUNCEMENT" || occ.workflow === "FOLLOWUP" || occ.workflow === "EVENT");
    else if (tf === "ACTIVITY" || tf === "DOC_EXPIRATION") {
      // Foreign-only filter — strip every real job/task/reminder row. The
      // matching foreign rows (activities or doc expirations) are appended
      // further down respecting the same `tf`.
      rows = [];
    }
    else if (tf === "DUE") {
      const todayKey = bizDateKey(new Date());
      // A reminder attached to an already-finished job is stale (the work is done) —
      // exclude those so the DUE list only shows actionable items.
      const finishedStatuses = new Set(["COMPLETED", "CLOSED", "PENDING_PAYMENT", "ARCHIVED", "CANCELED"]);
      rows = rows.filter((occ) => {
        // TASK-workflow occurrences not yet done
        if (occ.workflow === "TASK" && (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS")) return true;
        // Any occurrence with a Reminder whose remindAt is today or earlier — but only
        // if the underlying occurrence is still actionable (not completed/closed/etc).
        if (occ.reminder && bizDateKey(occ.reminder.remindAt) <= todayKey && !finishedStatuses.has(occ.status as string)) return true;
        return false;
      });
    }
    const sf = statusFilter[0];
    if (sf !== "ALL") {
      rows = rows.filter((occ) => {
        const hasAssignees = (occ.assignees ?? []).length > 0;
        if (sf === "UNCLAIMED") {
          // Only claimable work counts as "unclaimed". Reminders/tasks/events/
          // announcements/followups have no claim semantics and would otherwise
          // pollute the feed since they default to no assignees.
          if ((occ as any)._isReminderGhost) return false;
          const w = occ.workflow;
          const claimable = w === "STANDARD" || w === "ONE_OFF" || w === "ESTIMATE" || !w;
          // "Unclaimed" = no NON-OBSERVER assignee. An observer is just
          // watching — they haven't claimed the work. Must match the chip's
          // count source (`/admin/operations` jobsUnclaimed) which uses the
          // same predicate; otherwise the title-bar "N Unclaimed" badge and
          // the page list disagree on observer-only jobs (badge counts them,
          // page hides them — looks like "the chip lied" to the operator).
          const hasNonObserverAssignee = (occ.assignees ?? []).some((a) => a.role !== "observer");
          return claimable && !hasNonObserverAssignee;
        }
        if (sf === "FINISHED") {
          // FINISHED = completed *real jobs* (STANDARD/ONE_OFF/ESTIMATE) only. Tasks,
          // reminders, events, follow-ups, and announcements have their own lifecycles
          // and aren't meaningful here — and Hours/Earnings tiles point at this filter,
          // so including non-job workflows would inflate what looks like "finished work."
          const w = occ.workflow;
          const isJob = w === "STANDARD" || w === "ONE_OFF" || w === "ESTIMATE" || !w;
          return isJob && (occ.status === "COMPLETED" || occ.status === "CLOSED" || occ.status === "PENDING_PAYMENT");
        }
        return occ.status === sf;
      });
    } else {
      if (!showCanceled) rows = rows.filter((occ) => occ.status !== "CANCELED");
      if (!showArchived) rows = rows.filter((occ) => occ.status !== "ARCHIVED");
    }
    if (pausedRepeatingOnly) {
      // When on, narrow to only repeating-paused occurrences. The tab's
      // date range still applies (upstream), so this shows paused rows
      // within the selected window rather than the app-wide set.
      rows = rows.filter((occ) => (occ.status as string) === "STREAM_PAUSED");
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
    if (unapprovedHoursActive) {
      rows = rows.filter((occ) =>
        (occ.workflow === "STANDARD" || occ.workflow === "ONE_OFF") &&
        !!occ.completedAt &&
        !(occ as any).hoursApprovedAt
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

    // Admin-only: inject Timeline activities + doc expirations into the feed
    // as WorkerOccurrence-shaped ghosts. The renderer short-circuits on the
    // `_foreignKind` marker to render a distinct (read-only) card. Activities
    // slot at their nextDueDate; doc expirations only appear on their exact
    // expiry date (no overdue carryover).
    //
    // Foreign rows are skipped when:
    //  - The hours-approval review flow is active (focused on unapproved job
    //    occurrences only).
    //  - A status filter is in effect that excludes "ALL". Foreign rows have
    //    no JobOccurrence status (they aren't job occurrences), so any
    //    restricted status filter — e.g. "UNCLAIMED" from the title-bar
    //    Unclaimed alert — should not be polluted with Timeline cards.
    const statusFilterIsRestricted =
      statusFilter.length > 0 && !statusFilter.includes("ALL");
    if (forAdmin && foreignRows.length > 0 && !unapprovedHoursActive && !statusFilterIsRestricted) {
      const tf = typeFilter[0];
      const showActivities = tf === "ALL" || tf === "ACTIVITY";
      const showDocs = tf === "ALL" || tf === "DOC_EXPIRATION";
      const qlc = q.trim().toLowerCase();
      const todayKey = bizDateKey(new Date());
      for (const f of foreignRows) {
        if (f.kind === "activity") {
          if (!showActivities) continue;
          const day = bizDateKey(f.nextDueDate);
          if (dateFrom && day < dateFrom) continue;
          if (dateTo && day > dateTo) continue;
          if (qlc && !f.title.toLowerCase().includes(qlc) && !(f.description ?? "").toLowerCase().includes(qlc)) continue;
          rows.push({
            id: `__activity_${f.id}`,
            startAt: f.nextDueDate,
            _foreignKind: "activity",
            _foreignPayload: f,
          } as any);
        } else {
          if (!showDocs) continue;
          // Single-day pinning: doc expirations only surface on the exact
          // calendar date matching expiresAt. No overdue carryover here.
          const day = bizDateKey(f.expiresAt);
          if (day !== todayKey && (dateFrom && day < dateFrom)) continue;
          if (dateTo && day > dateTo) continue;
          if (qlc && !f.title.toLowerCase().includes(qlc)) continue;
          rows.push({
            id: `__doc_${f.documentId}`,
            startAt: f.expiresAt,
            _foreignKind: "doc_expiration",
            _foreignPayload: f,
          } as any);
        }
      }
    }

    return rows;
  }, [items, q, kind, statusFilter, typeFilter, overdueActive, unapprovedHoursActive, vipOnly, likedOnly, likedIds, isTrainee, highlightOccId, filterJobId, pinnedIds, isWorkerView, dateFrom, dateTo, showCanceled, showArchived, pausedRepeatingOnly, forAdmin, foreignRows]);

  const dayGroups = useMemo(() => {
    const groups: { key: string; label: string; items: WorkerOccurrence[] }[] = [];
    const todayKey = bizDateKey(new Date());

    const dayLabel = (dateKey: string) => {
      // dateKey is YYYY-MM-DD in ET. bizDaysBetween does the string math
      // through UTC-noon anchors (DST-immune) — no need for the manual
      // noon-UTC dance below.
      const d = new Date(dateKey + "T12:00:00Z"); // for fmtDateWeekday display
      const diff = bizDaysBetween(todayKey, dateKey);
      if (diff === 0) return "Today";
      if (diff === -1) return "Yesterday";
      if (diff === 1) return "Tomorrow";
      const dayName = fmtDateWeekday(d);
      if (diff >= 2 && diff <= 6) return dayName;
      if (diff <= -2 && diff >= -6) return `Last ${dayName}`;
      // String math on the YYYY-MM-DD key avoids any Date-vs-Date
      // year drift across DST / timezone boundaries.
      return fmtDateWeekday(d, { year: bizYearOf(dateKey) !== bizYearOf(todayKey) });
    };

    // Separate pinned and reminder-due items into their own groups (worker view only).
    // When the user is filtering by UNCLAIMED they're looking for claimable work, so
    // suppress the Reminders Due group and future-reminder ghost cards entirely —
    // otherwise unclaimed jobs that happen to have reminders attached get rendered
    // as reminder-themed visuals and look like reminders in the feed.
    const pinnedGroup: WorkerOccurrence[] = [];
    const reminderDueGroup: WorkerOccurrence[] = [];
    const pinnedIds_ = new Set(pinnedIds);
    const reminderDueIds = new Set<string>();
    const rest: WorkerOccurrence[] = [];
    // When the user is viewing UNCLAIMED or filtered to JOBS, suppress reminder-themed
    // visuals (Reminders Due group + future-reminder ghost cards) — those reframe regular
    // jobs as reminders, which is wrong for these views.
    const suppressReminderVisuals = statusFilter[0] === "UNCLAIMED" || typeFilter[0] === "JOBS";

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
        } else if (hasReminderDue && !suppressReminderVisuals) {
          reminderDueGroup.push(occ);
          reminderDueIds.add(occ.id);
        } else {
          // Suppress the original card when only its reminder pulled
          // the row through the date filter — i.e. the natural startAt
          // (and completedAt) are outside the range and what's actually
          // in range is the future reminder date. Without this, an
          // Observer's reminder on a completed past job would render
          // the past completed card in the visible window alongside
          // its future ghost.
          const naturalOccKey = occ.startAt ? bizDateKey(occ.startAt) : null;
          const naturalCompletedKey = (occ as any).completedAt ? bizDateKey((occ as any).completedAt) : null;
          const occInRange =
            (!naturalOccKey && !naturalCompletedKey)
            || (naturalOccKey != null && (!dateFrom || naturalOccKey >= dateFrom) && (!dateTo || naturalOccKey <= dateTo))
            || (naturalCompletedKey != null && (!dateFrom || naturalCompletedKey >= dateFrom) && (!dateTo || naturalCompletedKey <= dateTo));
          if (occInRange) rest.push(occ);
          // Future reminders — add a ghost at the reminder date if it's a
          // different ET day than the occurrence AND within date range.
          // Skip when `occ` is ITSELF an API-built reminder ghost (its
          // underlying occurrence fell outside the loaded range) — cloning
          // it here would render the same reminder twice.
          if (hasReminder && !suppressReminderVisuals && !(occ as any)._isReminderGhost) {
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

    // Sort within each day group: ghosts first, then by type order
    const cardSortOrder = (occ: any): number => {
      if (occ._isPinnedGhost) return 0;
      if (occ._isReminderGhost) return 1;
      if (occ.workflow === "ANNOUNCEMENT") return 2;
      if (occ.workflow === "EVENT") return 3;
      if (occ.workflow === "TASK") return 4;
      if (occ.workflow === "FOLLOWUP") return 5;
      if (occ.workflow === "REMINDER" || occ.reminder) return 6;
      if (occ.workflow === "ESTIMATE") return 7;
      return 8; // STANDARD + ONE_OFF (jobs)
    };
    for (const group of groups) {
      if (group.key === "pinned" || group.key === "reminders-due") continue;
      group.items.sort((a, b) => {
        const oa = cardSortOrder(a);
        const ob = cardSortOrder(b);
        if (oa !== ob) return oa - ob;
        // High-priority reminders first within reminder group
        if (a.workflow === "REMINDER" && b.workflow === "REMINDER") {
          const aHigh = (a as any).isHighPriority ? 0 : 1;
          const bHigh = (b as any).isHighPriority ? 0 : 1;
          if (aHigh !== bHigh) return aHigh - bHigh;
        }
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
      {/* Workday strip — same Start / Pause / Resume / End controls
          surfaced on the Worker Home tab. Mounted here so workers can
          clock in / out without bouncing back to Home before opening
          their job list. Worker-only: not rendered on Admin Jobs (where
          purpose is "ADMIN"/"SUPER" and there's no personal workday to
          act on). Mileage strip embedded so the same "one card, two
          zones" experience carries across tabs — see HomeTab for the
          canonical rendering + the mileageSlot contract. Hidden while
          admin views another worker (viewAsUserIds) since the mileage
          belongs to the current viewer, not the viewed worker. */}
      {isWorkerView && (
        <WorkdayStrip
          mileageSlot={
            (viewAsUserIds?.length ?? 0) > 0 ? null : <MileageStrip embedded />
          }
        />
      )}
      <HStack mb={2} gap={2} wrap="nowrap">
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-100)", border: "1px solid var(--chakra-colors-gray-300)", borderRadius: "6px" }}>
          <RefreshCw size={14} />
        </Button>
        {/* Team view toggle — worker-only, non-trainee. Icon-only to
            fit the compact button row. Purple on-state ties visually
            to the per-card peek chip + footer. */}
        {isWorkerView && !isTrainee && (
          <Button
            size="sm"
            variant="ghost"
            px="2"
            flexShrink={0}
            onClick={() => setPeekOthers(!peekOthers)}
            css={peekOthers ? {
              background: "var(--chakra-colors-purple-100)",
              color: "var(--chakra-colors-purple-800)",
              border: "1px solid var(--chakra-colors-purple-400)",
              borderRadius: "6px",
              "&:hover": { background: "var(--chakra-colors-purple-200)" },
            } : {
              background: "var(--chakra-colors-gray-100)",
              border: "1px solid var(--chakra-colors-gray-300)",
              borderRadius: "6px",
            }}
            title={peekOthers
              ? "Hide teammates' jobs"
              : "Show teammates' jobs (view-only)"}
          >
            <Users size={14} />
          </Button>
        )}
        {/* Density cycle button — icon reflects current density; clicking
            advances to the next (ultra → semi → expanded → ultra) and
            clears all per-card overrides. */}
        {(() => {
          const meta: Record<CardDensity, { icon: React.ReactNode; label: string }> = {
            ultra: { icon: <List size={14} />, label: "Ultra-compact" },
            semi: { icon: <LayoutList size={14} />, label: "Semi-compact" },
            expanded: { icon: <Maximize2 size={14} />, label: "Expanded" },
          };
          const next = nextDensity(cardDensity);
          return (
            <Button
              size="sm"
              variant="ghost"
              px="2"
              flexShrink={0}
              onClick={() => {
                setCardDensity(next);
                setCardOverrides(new Map());
              }}
              css={{
                background: "var(--chakra-colors-gray-100)",
                color: "var(--chakra-colors-gray-700)",
                border: "1px solid var(--chakra-colors-gray-300)",
                borderRadius: "6px",
              }}
              title={`${meta[cardDensity].label} — click for ${meta[next].label.toLowerCase()}`}
            >
              {meta[cardDensity].icon}
            </Button>
          );
        })()}
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
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowInfoDialog(true)}
          px="2"
          flexShrink={0}
          title="How jobs work"
          css={{
            background: "var(--chakra-colors-gray-100)",
            border: "1px solid var(--chakra-colors-gray-300)",
            borderRadius: "6px",
          }}
        >
          <Info size={14} />
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
            </VStack>
          )}
        </Box>
      </HStack>
      {/* Admin "View as" worker selector — sits below the filter toolbar.
          Worker mode doesn't pass headerSlot, so this row collapses. */}
      {headerSlot && (
        <HStack mb={2} gap={2} wrap="nowrap" pl="1" align="center">
          {headerSlot}
        </HStack>
      )}
      {!filtersOpen && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1" align="center">
          <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
            <Badge
              size="sm"
              colorPalette="green"
              variant="subtle"
              cursor="pointer"
              onClick={() => setQuickDateMenuOpen((v) => !v)}
            >
              {datePreset ? (PRESET_LABELS[datePreset] ?? datePreset)
                : (dateFrom || dateTo) ? (dateFrom === dateTo && dateFrom === bizDateKey(new Date()) ? "Today" : "Custom dates")
                : "Now"}
              {" "}<Box as="span" display="inline-flex" alignItems="center" justifyContent="center" w="14px" h="14px" borderRadius="full" bg="green.500" color="white" verticalAlign="middle"><ChevronDown size={9} /></Box>
            </Badge>
            {quickDateMenuOpen && (
              <VStack
                position="fixed"
                bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px"
                ref={(el: HTMLDivElement | null) => {
                  if (el && el.parentElement) {
                    const rect = el.parentElement.getBoundingClientRect();
                    el.style.top = `${rect.bottom + 4}px`;
                    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 148))}px`;
                  }
                }}
              >
                {quickDateItems.map((it) => (
                  <Button
                    key={it.value}
                    size="xs"
                    variant={datePreset === it.value ? "solid" : "ghost"}
                    colorPalette={datePreset === it.value ? "green" : undefined}
                    w="full"
                    justifyContent="start"
                    onClick={() => {
                      setQuickDateMenuOpen(false);
                      const val = it.value as DatePreset;
                      if (val === "all") {
                        setConfirmAction({
                          title: "Load All Data",
                          message: "This will load all occurrences for all time. This may be slow. Are you sure?",
                          confirmLabel: "Load All",
                          colorPalette: "orange",
                          onConfirm: () => { setDatePreset("all"); setOverdueActive(false); setUnapprovedHoursActive(false); },
                        });
                        return;
                      }
                      setDatePreset(val);
                      setOverdueActive(false);
                    }}
                  >
                    {it.label}
                  </Button>
                ))}
              </VStack>
            )}
          </Box>
          {peekActive && (
            <Badge
              size="sm"
              colorPalette="purple"
              variant="subtle"
              cursor="pointer"
              onClick={() => setPeekOthers(false)}
              title="Click to hide teammates' jobs"
            >
              <Users size={10} style={{ marginRight: 4 }} />
              Team view
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
          {pausedRepeatingOnly && <Badge size="sm" colorPalette="purple" variant="solid">Paused repeating only</Badge>}
          {highlightOccId && <Badge size="sm" colorPalette="teal" variant="subtle">Filtered to 1 occurrence</Badge>}
          {!highlightOccId && filterJobId && <Badge size="sm" colorPalette="teal" variant="subtle">Filtered to job</Badge>}
          {q && <Badge size="sm" colorPalette="gray" variant="subtle">"{q}"</Badge>}
          {!(kind[0] === "ALL" && statusFilter[0] === "ALL" && typeFilter[0] === "ALL" && !overdueActive && !vipOnly && !likedOnly && !showCanceled && !showArchived && !pausedRepeatingOnly && !highlightOccId && !filterJobId && !q && !viewAsUserIds?.length && datePreset && !peekActive) && (
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
                setUnapprovedHoursActive(false);
                setVipOnly(false);
                setLikedOnly(false);
                setShowCanceled(false);
                setShowArchived(false);
                setPeekOthers(false);
                setQ("");
                setHighlightOccId(null);
                setFilterJobId(null);
                const defaultPreset = forAdmin ? "thisWeek" : "now";
                const d = computeDatesFromPreset(defaultPreset);
                setDatePreset(defaultPreset);
                setDateFrom(d.from);
                setDateTo(d.to);
                setFiltersOpen(false);
                void load(true, { from: d.from, to: d.to });
                onClearAll?.();
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      {filtersOpen && <Box borderWidth="1px" borderColor="gray.300" borderRadius="md" bg="gray.100" p={2} pb={0} mb={2} css={{ "& button": { borderColor: "var(--chakra-colors-gray-400)" } }}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: kind[0] !== "ALL" ? "var(--chakra-colors-blue-200)" : "var(--chakra-colors-blue-100)", border: kind[0] !== "ALL" ? "1px solid var(--chakra-colors-blue-400)" : "1px solid var(--chakra-colors-blue-300)", borderRadius: "6px" }}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: statusFilter[0] !== "ALL" ? "var(--chakra-colors-purple-200)" : "var(--chakra-colors-purple-100)", border: statusFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-purple-400)" : "1px solid var(--chakra-colors-purple-300)", borderRadius: "6px" }}>
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
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: typeFilter[0] !== "ALL" ? "var(--chakra-colors-orange-200)" : "var(--chakra-colors-orange-100)", border: typeFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-orange-400)" : "1px solid var(--chakra-colors-orange-300)", borderRadius: "6px" }}>
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
        <Button
          size="sm"
          variant={overdueActive ? "solid" : "outline"}
          px="2"
          onClick={() => {
            if (overdueActive) {
              setOverdueActive(false);
              setDatePreset(presetBeforeOverdueRef.current ?? (forAdmin ? "thisWeek" : "now"));
            } else {
              presetBeforeOverdueRef.current = datePreset;
              setDatePreset(null);
              setDateFrom("");
              setDateTo(bizYesterday());
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
          title="Show overdue"
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
        {forAdmin && (
          <Button
            size="sm"
            variant={pausedRepeatingOnly ? "solid" : "outline"}
            px="2"
            onClick={() => setPausedRepeatingOnly(!pausedRepeatingOnly)}
            css={pausedRepeatingOnly ? {
              background: "var(--chakra-colors-purple-100)",
              color: "var(--chakra-colors-purple-800)",
              border: "1px solid var(--chakra-colors-purple-400)",
              "&:hover": { background: "var(--chakra-colors-purple-200)" },
            } : undefined}
            title={pausedRepeatingOnly ? "Show all occurrences" : "Show only paused repeating"}
          >
            <Repeat size={14} />
            <Text as="span" fontSize="xs" ml={1}>Paused</Text>
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
      </HStack>
      {(kind[0] !== "ALL" || statusFilter[0] !== "ALL" || typeFilter[0] !== "ALL" || overdueActive || vipOnly || likedOnly || showCanceled || showArchived || highlightOccId || filterJobId || datePreset || dateFrom || dateTo || peekActive) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
            <Badge
              size="sm"
              colorPalette="green"
              variant="subtle"
              cursor="pointer"
              onClick={() => setQuickDateMenuOpen((v) => !v)}
            >
              {datePreset ? (PRESET_LABELS[datePreset] ?? datePreset)
                : (dateFrom || dateTo) ? (dateFrom === dateTo && dateFrom === bizDateKey(new Date()) ? "Today" : "Custom dates")
                : "Now"}
              {" "}<Box as="span" display="inline-flex" alignItems="center" justifyContent="center" w="14px" h="14px" borderRadius="full" bg="green.500" color="white" verticalAlign="middle"><ChevronDown size={9} /></Box>
            </Badge>
            {quickDateMenuOpen && (
              <VStack
                position="fixed"
                bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px"
                ref={(el: HTMLDivElement | null) => {
                  if (el && el.parentElement) {
                    const rect = el.parentElement.getBoundingClientRect();
                    el.style.top = `${rect.bottom + 4}px`;
                    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 148))}px`;
                  }
                }}
              >
                {quickDateItems.map((it) => (
                  <Button
                    key={it.value}
                    size="xs"
                    variant={datePreset === it.value ? "solid" : "ghost"}
                    colorPalette={datePreset === it.value ? "green" : undefined}
                    w="full"
                    justifyContent="start"
                    onClick={() => {
                      setQuickDateMenuOpen(false);
                      const val = it.value as DatePreset;
                      if (val === "all") {
                        setConfirmAction({
                          title: "Load All Data",
                          message: "This will load all occurrences for all time. This may be slow. Are you sure?",
                          confirmLabel: "Load All",
                          colorPalette: "orange",
                          onConfirm: () => { setDatePreset("all"); setOverdueActive(false); setUnapprovedHoursActive(false); },
                        });
                        return;
                      }
                      setDatePreset(val);
                      setOverdueActive(false);
                    }}
                  >
                    {it.label}
                  </Button>
                ))}
              </VStack>
            )}
          </Box>
          {peekActive && (
            <Badge
              size="sm"
              colorPalette="purple"
              variant="subtle"
              cursor="pointer"
              onClick={() => setPeekOthers(false)}
              title="Click to hide teammates' jobs"
            >
              <Users size={10} style={{ marginRight: 4 }} />
              Team view
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
          {!(kind[0] === "ALL" && statusFilter[0] === "ALL" && typeFilter[0] === "ALL" && !overdueActive && !vipOnly && !likedOnly && !showCanceled && !showArchived && !pausedRepeatingOnly && !highlightOccId && !filterJobId && !q && !viewAsUserIds?.length && datePreset && !peekActive) && (
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
                setUnapprovedHoursActive(false);
                setVipOnly(false);
                setLikedOnly(false);
                setShowCanceled(false);
                setShowArchived(false);
                setPeekOthers(false);
                setQ("");
                setHighlightOccId(null);
                setFilterJobId(null);
                const defaultPreset = forAdmin ? "thisWeek" : "now";
                const d = computeDatesFromPreset(defaultPreset);
                setDatePreset(defaultPreset);
                setDateFrom(d.from);
                setDateTo(d.to);
                setFiltersOpen(false);
                void load(true, { from: d.from, to: d.to });
                onClearAll?.();
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      </Box>}

      {loading && items.length === 0 && <LoadingCenter />}

      <Box position="relative">
        {loading && items.length > 0 && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
        <VStack align="stretch" gap={3}>
          {forAdmin && <ClientRequestsSection />}
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
                  <HolidayChip dateKey={group.key} />
                  {/* Route → / Plan → chips — inline with the section header
                      so they don't burn a whole row. Tightened padding + 2xs
                      font to match the count badge so the centered header
                      stays on one line. */}
                  {isWorkerView && group.label === "Today" && group.items.some((o) => (o.workflow === "STANDARD" || o.workflow === "ONE_OFF" || o.workflow === "ESTIMATE") && (o.assignees ?? []).some((a) => a.userId === myId)) && (
                    <Badge
                      size="sm"
                      variant="solid"
                      bg="blue.400"
                      color="white"
                      px="2"
                      py="0.5"
                      borderRadius="full"
                      cursor="pointer"
                      fontSize="2xs"
                      lineHeight="1.3"
                      whiteSpace="nowrap"
                      _hover={{ opacity: 0.85 }}
                      onClick={(e: any) => {
                        e.stopPropagation();
                        try {
                          // ET-anchored "today" so a worker checking late
                          // evening doesn't land tomorrow's route preview.
                          localStorage.setItem("seedlings_preview_targetDate", JSON.stringify(bizToday()));
                        } catch {}
                        window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "routes", autoAnalyze: true } }));
                      }}
                    >
                      Route →
                    </Badge>
                  )}
                  {isWorkerView && group.label === "Tomorrow" && group.items.some((o) => (o.workflow === "STANDARD" || o.workflow === "ONE_OFF" || o.workflow === "ESTIMATE") && (o.assignees ?? []).some((a) => a.userId === myId)) && (
                    <Badge
                      size="sm"
                      variant="solid"
                      bg="blue.400"
                      color="white"
                      px="2"
                      py="0.5"
                      borderRadius="full"
                      cursor="pointer"
                      fontSize="2xs"
                      lineHeight="1.3"
                      whiteSpace="nowrap"
                      _hover={{ opacity: 0.85 }}
                      onClick={(e: any) => {
                        e.stopPropagation();
                        window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "reminders" } }));
                      }}
                    >
                      Plan →
                    </Badge>
                  )}
                  <Text fontSize="xs" color="gray.400">{collapsedGroups.has(group.key) ? "▶" : "▼"}</Text>
                </HStack>
                <Box flex="1" borderBottomWidth="2px" borderColor="gray.300" />
              </HStack>
              {!collapsedGroups.has(group.key) && <VStack align="stretch" gap={3}>
          {group.items.map((occ, occIdx) => {
            // Admin-only foreign rows (Timeline activities + doc expirations)
            // short-circuit here with a distinct, read-only render. The rest
            // of this giant callback assumes a WorkerOccurrence shape and
            // would error on the synthetic ghosts otherwise. Foreign rows
            // respect the same ultra/semi/expanded density model as jobs:
            //   - global density via cardDensity, per-card override via
            //     cardOverrides, click cycles through ultra → semi → expanded.
            if ((occ as any)._foreignKind === "activity") {
              const p = (occ as any)._foreignPayload as ActivityForeignRow;
              // Calendar-day diff (DST-safe). `p.nextDueDate` is a
              // YYYY-MM-DD or ISO string from the API.
              const dueDays = bizDaysBetween(bizToday(), bizDateKey(p.nextDueDate));
              const isOverdue = dueDays < 0;
              const dueLabel = isOverdue
                ? `overdue ${-dueDays} ${-dueDays === 1 ? "day" : "days"}`
                : dueDays === 0 ? "today"
                : dueDays === 1 ? "tomorrow"
                : `in ${dueDays} days`;
              const fMode: CardDensity = cardOverrides.get(occ.id) ?? cardDensity;
              const fToggle = () =>
                setCardOverrides((prev) => {
                  const next = new Map(prev);
                  next.set(occ.id, nextDensity(fMode));
                  return next;
                });
              const openTimeline = (e?: React.MouseEvent) => {
                e?.stopPropagation();
                try {
                  localStorage.setItem("seedlings_deeplink_event", p.id);
                  localStorage.setItem("seedlings_deeplink_event_ts", String(Date.now()));
                } catch {}
                window.dispatchEvent(new CustomEvent("navigate:adminTab", { detail: { tab: "timeline" } }));
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent("timelineTab:applyDeepLink", { detail: { eventId: p.id } }));
                }, 250);
              };
              if (fMode === "ultra") {
                return (
                  <Card.Root
                    key={occ.id}
                    variant="outline"
                    overflow="hidden"
                    cursor="pointer"
                    onClick={fToggle}
                    css={{ borderLeft: `4px solid var(--chakra-colors-${isOverdue ? "red" : "purple"}-500)` }}
                  >
                    <HStack px="3" py="1" gap={2} minH="32px" align="center" fontSize="xs">
                      <Badge colorPalette="purple" variant="solid" fontSize="xs" px="1.5" borderRadius="full" flexShrink={0}>
                        Timeline
                      </Badge>
                      <Text fontWeight="semibold" lineClamp={1} flex="1" minW={0}>
                        {p.title}
                      </Text>
                      <Badge size="xs" colorPalette={isOverdue ? "red" : "purple"} variant="subtle" px="1.5" flexShrink={0}>
                        {dueLabel}
                      </Badge>
                    </HStack>
                  </Card.Root>
                );
              }
              return (
                <Card.Root key={occ.id} variant="outline" borderLeftWidth="4px" borderLeftColor={isOverdue ? "red.500" : "purple.500"} cursor="pointer" onClick={fToggle}>
                  <Card.Body p={2}>
                    <HStack justify="space-between" align="start" gap={2}>
                      <VStack align="start" gap={0.5} flex="1" minW={0}>
                        <HStack gap={1.5} wrap="nowrap" align="center" minW={0}>
                          <Badge size="sm" colorPalette="purple" variant="solid" px="2" borderRadius="full" flexShrink={0}>
                            Timeline
                          </Badge>
                          <Text fontSize="sm" fontWeight="semibold" lineClamp={2} minW={0}>
                            {p.title}
                          </Text>
                        </HStack>
                        <HStack gap={1.5} wrap="wrap" fontSize="xs" color="fg.muted">
                          <Badge size="xs" colorPalette={isOverdue ? "red" : "purple"} variant="subtle" px="1.5">
                            {dueLabel}
                          </Badge>
                          {p.rrule && (
                            <Badge size="xs" colorPalette="gray" variant="subtle" px="1.5">recurring</Badge>
                          )}
                          {p.adminHidden && (
                            <Badge size="xs" colorPalette="red" variant="subtle" px="1.5">Super-only</Badge>
                          )}
                        </HStack>
                      </VStack>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="purple"
                        flexShrink={0}
                        onClick={openTimeline}
                      >
                        Open in Timeline →
                      </Button>
                    </HStack>
                    {/* Description only shown in fully-expanded mode to match
                        how job cards reveal extra detail on expand. */}
                    {fMode === "expanded" && p.description && (
                      <Text fontSize="xs" color="fg.muted" mt={1}>{p.description}</Text>
                    )}
                    {fMode === "expanded" && p.category && (
                      <Text fontSize="xs" color="fg.subtle" mt={1}>
                        Category: {timelineCategoryLabel(p.category, timelineCategories)}
                      </Text>
                    )}
                  </Card.Body>
                </Card.Root>
              );
            }
            if ((occ as any)._foreignKind === "doc_expiration") {
              const p = (occ as any)._foreignPayload as DocExpirationForeignRow;
              const fMode: CardDensity = cardOverrides.get(occ.id) ?? cardDensity;
              const fToggle = () =>
                setCardOverrides((prev) => {
                  const next = new Map(prev);
                  next.set(occ.id, nextDensity(fMode));
                  return next;
                });
              const openDocs = (e?: React.MouseEvent) => {
                e?.stopPropagation();
                try {
                  localStorage.setItem("seedlings_deeplink_document", p.documentId);
                  localStorage.setItem("seedlings_deeplink_document_ts", String(Date.now()));
                } catch {}
                window.dispatchEvent(new CustomEvent("navigate:adminTab", { detail: { tab: "documents" } }));
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent("documentsTab:applyDeepLink", { detail: { docId: p.documentId } }));
                }, 250);
              };
              if (fMode === "ultra") {
                return (
                  <Card.Root
                    key={occ.id}
                    variant="outline"
                    overflow="hidden"
                    cursor="pointer"
                    onClick={fToggle}
                    css={{ borderLeft: "4px solid var(--chakra-colors-red-500)" }}
                  >
                    <HStack px="3" py="1" gap={2} minH="32px" align="center" fontSize="xs">
                      <Badge colorPalette="red" variant="solid" fontSize="xs" px="1.5" borderRadius="full" flexShrink={0}>
                        Doc expires
                      </Badge>
                      <Text fontWeight="semibold" lineClamp={1} flex="1" minW={0}>
                        {p.title}
                      </Text>
                    </HStack>
                  </Card.Root>
                );
              }
              return (
                <Card.Root key={occ.id} variant="outline" borderLeftWidth="4px" borderLeftColor="red.500" cursor="pointer" onClick={fToggle}>
                  <Card.Body p={2}>
                    <HStack justify="space-between" align="start" gap={2}>
                      <VStack align="start" gap={0.5} flex="1" minW={0}>
                        <HStack gap={1.5} wrap="nowrap" align="center" minW={0}>
                          <Badge size="sm" colorPalette="red" variant="solid" px="2" borderRadius="full" flexShrink={0}>
                            Document expires today
                          </Badge>
                          <Text fontSize="sm" fontWeight="semibold" lineClamp={2} minW={0}>
                            {p.title}
                          </Text>
                        </HStack>
                        {p.adminHidden && (
                          <Badge size="xs" colorPalette="red" variant="subtle" px="1.5">Super-only</Badge>
                        )}
                      </VStack>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        flexShrink={0}
                        onClick={openDocs}
                      >
                        Open in Documents →
                      </Button>
                    </HStack>
                    {fMode === "expanded" && p.type && (
                      <Text fontSize="xs" color="fg.subtle" mt={1}>
                        Type: {documentTypeLabel(p.type, documentTypes)}
                      </Text>
                    )}
                  </Card.Body>
                </Card.Root>
              );
            }
            const assignees = occ.assignees ?? [];
            const myAssignee = assignees.find((a) => a.userId === myId);
            const isObserver = myAssignee?.role === "observer";
            const isAssignedToMe = !!myId && assignees.some((a) => a.userId === myId);
            const isActiveAssignee = isAssignedToMe && !isObserver;
            const isUnassigned = assignees.filter((a) => a.role !== "observer").length === 0;
            const isAssignedToOthers = !isUnassigned && !isAssignedToMe;

            const isClaimer = !!myAssignee && !isObserver && myAssignee.assignedById === myId;

            // Peek mode is a WORKER-tab-only concept: on the worker
            // view, cards for jobs the current user isn't assigned to
            // are surfaced by the "Team" toggle and rendered read-
            // only. On the Admin Jobs tab this concept doesn't apply
            // — admins see and act on everyone's jobs normally, so
            // `isPeek` stays false regardless of assignment.
            const isPeek =
              isWorkerView &&
              (isAssignedToOthers || !!(occ as any)._peekRedacted);

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

            // Per-card density: explicit per-card override wins; else the
            // global cardDensity. Ghost cards key their override separately
            // (`ghost:<id>`) so a ghost and its real occurrence — which share
            // an id — don't toggle each other. `isCardCompact` keeps its
            // legacy meaning ("anything but expanded"); cardMode is the
            // precise three-state value the ultra branches use.
            const cardKey = (occ._isReminderGhost || occ._isPinnedGhost)
              ? `ghost:${occ.id}`
              : occ.id;
            const cardMode: CardDensity = cardOverrides.get(cardKey) ?? cardDensity;
            const isCardCompact = cardMode !== "expanded";
            // Click cycles this card ultra → semi → expanded → ultra,
            // independent of the global density.
            const toggleCard = () => {
              setCardOverrides((prev) => {
                const next = new Map(prev);
                next.set(cardKey, nextDensity(cardMode));
                return next;
              });
            };

            // Ghost reminder cards — a reference card on the reminder's
            // date. Three visual states like regular cards:
            //   ultra    — single scan row
            //   semi     — title strip + minimal body + action buttons
            //   expanded — same as semi PLUS a full reminder-details
            //              panel (untruncated note + reminder time).
            const ghostHighPriority = !!(occ as any).isHighPriority;
            if (isGhost) {
              const ghostBorderColor = ghostHighPriority ? "purple.500" : "purple.300";
              const ghostBg = ghostHighPriority ? "purple.100" : "purple.50";
              const ghostCss = {
                borderLeft: ghostHighPriority
                  ? "4px dashed var(--chakra-colors-purple-600)"
                  : "4px dashed var(--chakra-colors-purple-400)",
                borderStyle: "dashed",
                opacity: ghostHighPriority ? 1 : 0.8,
              };
              const ghostProp =
                (occ.job?.property?.displayName ?? occ.title ?? "Job") +
                (occ.job?.property?.client?.displayName
                  ? ` — ${clientLabel(occ.job.property.client.displayName)}`
                  : "");
              if (cardMode === "ultra") {
                return (
                  <Card.Root
                    key={`ghost-${occ.id}-${occIdx}`}
                    variant="outline"
                    overflow="hidden"
                    borderColor={ghostBorderColor}
                    borderWidth={ghostHighPriority ? "2px" : "1px"}
                    bg={ghostBg}
                    cursor="pointer"
                    onClick={toggleCard}
                    css={ghostCss}
                  >
                    {/* Same row shape used by Timeline / Doc-expiration / Job
                        ultra rows so every density-ultra card lands at the
                        same vertical height (32px). HStack lives directly
                        inside Card.Root — no Card.Body — to avoid the extra
                        body padding the other ultra paths skip. */}
                    <HStack px="3" py="1" gap={2} h="44px" align="center" fontSize="xs">
                      <Bell size={13} style={{ color: "var(--chakra-colors-purple-600)", flexShrink: 0 }} />
                      <Badge colorPalette="purple" variant="solid" fontSize="xs" px="1.5" borderRadius="full" flexShrink={0}>Reminder</Badge>
                      {ghostHighPriority && <Badge colorPalette="red" variant="solid" fontSize="xs" px="1.5" borderRadius="full" flexShrink={0}>!</Badge>}
                      <Text fontWeight="medium" flex="1" minW={0} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                        {ghostProp}
                        {occ.reminder?.note ? ` · ${occ.reminder.note}` : ""}
                      </Text>
                      {occ.reminder?.remindAt && (
                        <Text color="purple.600" flexShrink={0}>{fmtDate(occ.reminder.remindAt)}</Text>
                      )}
                    </HStack>
                  </Card.Root>
                );
              }
              return (
                <Card.Root
                  key={`ghost-${occ.id}-${occIdx}`}
                  variant="outline"
                  borderColor={ghostBorderColor}
                  borderWidth={ghostHighPriority ? "2px" : "1px"}
                  bg={ghostBg}
                  css={ghostCss}
                >
                  <Card.Body py="2" px="3">
                    <VStack align="start" gap={1}>
                      {/* Title row = the tap target for the density cycle.
                          Same darker-strip pattern as regular cards: bleeds
                          past Card.Body's px="3" py="2" via negative
                          margins so the strip is flush with the card
                          edges. Body content below is inert. */}
                      <HStack
                        gap={2}
                        align="center"
                        mx="-3"
                        mt="-2"
                        mb={1}
                        px="3"
                        py="2"
                        w="calc(100% + 24px)"
                        bg="blackAlpha.100"
                        cursor="pointer"
                        userSelect="none"
                        _hover={{ bg: "blackAlpha.200" }}
                        onClick={(e: any) => {
                          const el = e.target as HTMLElement;
                          if (el?.closest?.("a, button")) return;
                          toggleCard();
                        }}
                      >
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
                        {(occ.addons ?? []).length > 0 && ` + ${(occ.addons ?? []).map((a: any) => a.tag ? jobTagLabel(a.tag) : a.customLabel).join(", ")}`}
                        {(occ as any).jobType && ` · ${(occ as any).jobType}`}
                        {occ.startAt && ` · Scheduled: ${fmtDate(occ.startAt)}`}
                      </Text>
                      {/* Fully-expanded ghost card adds a reminder-details
                          panel: explicit "set for" date + untruncated note.
                          Click on the title strip again collapses back to
                          ultra; this is the 3rd state of the density cycle. */}
                      {cardMode === "expanded" && occ.reminder && (
                        <Box
                          w="full"
                          px="3"
                          py="2"
                          bg="purple.100"
                          borderRadius="md"
                          borderWidth="1px"
                          borderColor="purple.200"
                        >
                          <Text fontSize="2xs" fontWeight="semibold" color="purple.800" textTransform="uppercase" letterSpacing="wide" mb={1}>
                            Reminder details
                          </Text>
                          {occ.reminder.remindAt && (
                            <Text fontSize="xs" color="purple.700">
                              Set for {fmtDate(occ.reminder.remindAt)}
                            </Text>
                          )}
                          {occ.reminder.note && (
                            <Text fontSize="sm" color="purple.900" mt={1} whiteSpace="pre-wrap">
                              {occ.reminder.note}
                            </Text>
                          )}
                        </Box>
                      )}
                      <HStack gap={2} wrap="wrap">
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="purple"
                          onClick={(e: any) => {
                            e.stopPropagation();
                            setHighlightOccId(occ.id);
                            setCardOverrides(new Map([[occ.id, "expanded"]]));
                            setFilterJobId(null);
                            setQ("");
                            if (occ.startAt) {
                              const occKey = bizDateKey(occ.startAt);
                              const fromKey = bizAddDays(occKey, -3);
                              const toKey = bizAddDays(occKey, 3);
                              setDatePreset(null);
                              setDateFrom(fromKey);
                              setDateTo(toKey);
                              void load(true, { from: fromKey, to: toKey }, occ.id);
                            }
                          }}
                        >
                          View Original
                        </Button>
                        {/* Reschedule the reminder itself — opens the
                         *  same dialog used elsewhere, pre-filled with
                         *  the current reminder's date and note.
                         *  Reminders are per-user, so if it appears on
                         *  this user's feed it's their own. */}
                        {occ.reminder && (
                          <Button
                            size="xs"
                            variant="outline"
                            colorPalette="orange"
                            onClick={(e: any) => {
                              e.stopPropagation();
                              setReminderDialogOccId(occ.id);
                              setReminderDate(bizDateKey(occ.reminder!.remindAt));
                              setReminderNote(occ.reminder!.note ?? "");
                            }}
                          >
                            <Bell size={12} /> Reschedule
                          </Button>
                        )}
                      </HStack>
                    </VStack>
                  </Card.Body>
                </Card.Root>
              );
            }

            // Pinned ghost cards — a reference in the regular feed, same
            // color as the original card type. Mirrors the reminder-ghost
            // density model:
            //   ultra    — single scan row
            //   semi     — title strip + body + "View Pinned" button
            //   expanded — same as semi PLUS a pinned-details panel
            // Tap the title strip to cycle ultra → semi → expanded → ultra.
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
              const pinTitle = ghostIsTask ? (occ.title || "Task")
                : ghostIsReminder ? (occ.title || "Reminder")
                : (occ.job?.property?.displayName ?? "Job");
              const pinClient = occ.job?.property?.client?.displayName
                ? ` — ${clientLabel(occ.job.property.client.displayName)}`
                : "";
              const pinTags = parseJobTags(occ).length > 0
                ? ` · ${parseJobTags(occ).map(jobTagLabel).join(", ")}`
                : "";
              const pinAddons = (occ.addons ?? []).length > 0
                ? ` + ${(occ.addons ?? []).map((a: any) => a.tag ? jobTagLabel(a.tag) : a.customLabel).join(", ")}`
                : "";
              const pinCss = {
                borderLeft: `4px dashed var(--chakra-colors-${ghostColor}-400)`,
                borderStyle: "dashed",
                opacity: 0.8,
              };
              if (cardMode === "ultra") {
                return (
                  <Card.Root
                    key={`pin-ghost-${occ.id}-${occIdx}`}
                    variant="outline"
                    overflow="hidden"
                    borderColor={`${ghostColor}.300`}
                    bg={`${ghostColor}.50`}
                    cursor="pointer"
                    onClick={toggleCard}
                    css={pinCss}
                  >
                    <HStack px="3" py="1" gap={2} h="44px" align="center" fontSize="xs">
                      <Pin size={13} fill="currentColor" style={{ color: `var(--chakra-colors-${ghostColor}-600)`, flexShrink: 0 }} />
                      <Badge colorPalette={ghostColor} variant="solid" fontSize="xs" px="1.5" borderRadius="full" flexShrink={0}>Pinned</Badge>
                      <Text fontWeight="medium" flex="1" minW={0} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                        {pinTitle}{pinClient}
                      </Text>
                    </HStack>
                  </Card.Root>
                );
              }
              return (
                <Card.Root
                  key={`pin-ghost-${occ.id}-${occIdx}`}
                  variant="outline"
                  borderColor={`${ghostColor}.300`}
                  bg={`${ghostColor}.50`}
                  css={pinCss}
                >
                  <Card.Body py="2" px="3">
                    <VStack align="start" gap={1}>
                      {/* Title strip — the tap target for the density cycle.
                          Same darker-strip pattern as the reminder ghost:
                          bleeds past Card.Body padding via negative margins
                          so the strip is flush with the card edges. */}
                      <HStack
                        gap={2}
                        align="center"
                        mx="-3"
                        mt="-2"
                        mb={1}
                        px="3"
                        py="2"
                        w="calc(100% + 24px)"
                        bg="blackAlpha.100"
                        cursor="pointer"
                        userSelect="none"
                        _hover={{ bg: "blackAlpha.200" }}
                        onClick={(e: any) => {
                          const el = e.target as HTMLElement;
                          if (el?.closest?.("a, button")) return;
                          toggleCard();
                        }}
                      >
                        <Pin size={14} fill="currentColor" style={{ color: `var(--chakra-colors-${ghostColor}-600)` }} />
                        <Badge colorPalette={ghostColor} variant="solid" fontSize="xs" px="2" borderRadius="full">Pinned</Badge>
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        {pinTitle}{pinClient}{pinTags}{pinAddons}
                        {(occ as any).jobType && ` · ${(occ as any).jobType}`}
                        {occ.startAt && ` · Scheduled: ${fmtDate(occ.startAt)}`}
                      </Text>
                      {/* Fully-expanded ghost card adds a pinned-details
                          panel: status, full schedule date, untruncated
                          notes. Click the title strip again to collapse
                          back to ultra; this is the 3rd state of the
                          density cycle. */}
                      {cardMode === "expanded" && (
                        <Box
                          w="full"
                          px="3"
                          py="2"
                          bg={`${ghostColor}.100`}
                          borderRadius="md"
                          borderWidth="1px"
                          borderColor={`${ghostColor}.200`}
                        >
                          <Text fontSize="2xs" fontWeight="semibold" color={`${ghostColor}.800`} textTransform="uppercase" letterSpacing="wide" mb={1}>
                            Pinned details
                          </Text>
                          <VStack align="stretch" gap={1}>
                            {/* Full address — semi only shows the property
                                display name; this surfaces the street. */}
                            {occ.job?.property?.street1 && (
                              <Text fontSize="xs" color={`${ghostColor}.700`}>
                                📍 {occ.job.property.street1}
                                {occ.job.property.city && `, ${occ.job.property.city}`}
                                {occ.job.property.state && ` ${occ.job.property.state}`}
                              </Text>
                            )}
                            {/* Assignees — who else is on this occurrence.
                                Useful to know before you tap View Pinned. */}
                            {(occ.assignees ?? []).length > 0 && (
                              <Text fontSize="xs" color={`${ghostColor}.700`}>
                                👥 {(occ.assignees ?? []).map((a) =>
                                  a.user?.displayName || a.user?.email || "Worker"
                                ).join(", ")}
                              </Text>
                            )}
                            {/* Status — meaningful for non-default values. */}
                            {occ.status && occ.status !== "SCHEDULED" && (
                              <Text fontSize="xs" color={`${ghostColor}.700`}>
                                · {occ.status.replace(/_/g, " ").toLowerCase()}
                              </Text>
                            )}
                            {/* Price — when the job's value is set. */}
                            {(occ.price ?? 0) > 0 && (
                              <Text fontSize="xs" color={`${ghostColor}.700`}>
                                💰 ${occ.price?.toFixed(2)}
                              </Text>
                            )}
                            {/* Per-occurrence instructions — pinned notes
                                often live here (PinnedNoteDialog writes to
                                this list). Strip presets so this panel only
                                shows the custom notes the user actually
                                added on top. */}
                            {(occ.instructions ?? []).filter((i) => !i.isPreset).length > 0 && (
                              <Box mt={1}>
                                <Text fontSize="2xs" fontWeight="semibold" color={`${ghostColor}.700`} textTransform="uppercase" mb={0.5}>
                                  Notes
                                </Text>
                                <VStack align="stretch" gap={0.5}>
                                  {(occ.instructions ?? []).filter((i) => !i.isPreset).map((inst) => (
                                    <Text key={inst.id} fontSize="xs" color={`${ghostColor}.900`} whiteSpace="pre-wrap">
                                      • {inst.text}
                                    </Text>
                                  ))}
                                </VStack>
                              </Box>
                            )}
                          </VStack>
                        </Box>
                      )}
                      <Button
                        size="xs"
                        variant="outline"
                        colorPalette={ghostColor}
                        onClick={(e: any) => {
                          e.stopPropagation();
                          setHighlightOccId(occ.id);
                          setCardOverrides(new Map([[occ.id, "expanded"]]));
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
            const isPaused = occ.status === "PAUSED";
            const isInProgressOthers = occ.status === "IN_PROGRESS" && isAssignedToOthers;
            const cardColorBase = isAnnouncement ? "announce"
              : isFollowup ? (isClosed ? "followup-closed" : "followup")
              : isEvent ? (isClosed ? "event-closed" : "event")
              : (isClosed || isAcceptedEstimate || isRejectedEstimate) ? "gray"
              : isPaused ? "paused"
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
              : cardColorBase === "paused" ? "orange.100"
              : cardColorBase === "announce" ? "purple.200"
              : cardColorBase === "followup-closed" ? "red.100"
              : cardColorBase === "followup" ? "red.200"
              : cardColorBase === "event-closed" ? "yellow.100"
              : cardColorBase === "event" ? "yellow.200"
              // Completed / closed-out jobs (closed, accepted estimate, rejected estimate)
              // fall back to the default white card bg so they read as "done — moved on".
              // Unconfirmed jobs assigned to other workers keep the gray.50 fill, which
              // is what the operator scans for as "waiting on someone else's action".
              // Both states previously resolved to gray.50 and were indistinguishable.
              : cardColorBase === "gray" && (isClosed || isAcceptedEstimate || isRejectedEstimate) ? undefined
              : cardColorBase === "gray" && isAssignedToOthers ? "gray.100"
              : cardColorBase === "yellow" ? "yellow.50"
              : cardColorBase === "green" ? "green.100"
              : cardColorBase && cardColorBase !== "gray" ? `${cardColorBase}.50`
              : undefined;
            const cardBorderColor = isHighPriority ? "purple.500"
              : cardColorBase === "paused" ? "orange.400"
              : cardColorBase === "announce" ? "purple.400"
              : cardColorBase === "followup-closed" ? "red.300"
              : cardColorBase === "followup" ? "red.400"
              : cardColorBase === "event-closed" ? "yellow.300"
              : cardColorBase === "event" ? "yellow.400"
              : !cardColorBase || (isClosed || isAcceptedEstimate || isRejectedEstimate) ? "gray.200"
              : cardColorBase === "green" ? "green.400"
              : `${cardColorBase}.300`;
            const isInProgress = occ.status === "IN_PROGRESS";
            const cardBorderWidth = isHighPriority ? "2px" : (isInProgress || isPaused) ? "2px" : "1px";

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

            // Context-dependent quick-action button (Confirm Client / Start /
            // Pause-Complete menu / Resume / Accept Payment / Claim / etc.)
            // Renders the same circular button used in the semi-card header,
            // and the ultra row reuses it in place of the status dot.
            //
            // Confirm Client is checked BEFORE the isTentative gate — a
            // tentative job that needs client confirmation still has to
            // surface that affordance on collapsed/ultra cards (parity with
            // the expanded-card action row).
            // Peek mode is strictly view-only — never render the quick
            // action affordance on other workers' cards.
            const quickActionButton = isTrainee || isPeek ? null : (() => {
              if (needsConfirmation && (isClaimer || forAdmin)) {
                return (
                  <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="orange.400" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "orange.500" }} title="Confirm Client" onClick={(e: any) => {
                    e.stopPropagation();
                    openConfirmClientDialog(occ);
                  }}><CheckCircle2 size={12} /></Box>
                );
              }
              if (isTentative) return null;
              if (!isTaskOrReminder && occ.status === "SCHEDULED" && !needsConfirmation && (isClaimer || forAdmin)) {
                return (
                  <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="blue.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "blue.600" }} title={isEstimateOcc ? "Start Estimate" : "Start Job"} onClick={(e: any) => {
                    e.stopPropagation();
                    openStartJobDialog(occ);
                  }}><Play size={12} /></Box>
                );
              }
              if (!isTaskOrReminder && occ.status === "IN_PROGRESS" && (isClaimer || forAdmin) && !isEstimateOcc) {
                return (
                  <Box position="relative" flexShrink={0}>
                    <Box as="button" w="22px" h="22px" minW="22px" borderRadius="full" bg="blue.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "blue.600" }} title="Pause / Complete" onClick={(e: any) => {
                      e.stopPropagation();
                      setQuickActionMenuOcc((prev) => prev === occ.id ? null : occ.id);
                    }}><CheckCircle2 size={12} /></Box>
                    {quickActionMenuOcc === occ.id && (
                      <VStack
                        position="fixed"
                        bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="120px"
                        onClick={(e: any) => e.stopPropagation()}
                        ref={(el: HTMLDivElement | null) => {
                          if (el && el.parentElement) {
                            const rect = el.parentElement.getBoundingClientRect();
                            el.style.top = `${rect.bottom + 4}px`;
                            el.style.left = `${Math.max(8, Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))}px`;
                          }
                        }}
                      >
                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setQuickActionMenuOcc(null); void pauseJob(occ); }}>
                          <Pause size={12} /> Pause
                        </Button>
                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setQuickActionMenuOcc(null); setCompleteDialogOcc(occ); }}>
                          <CheckCircle2 size={12} /> Complete
                        </Button>
                      </VStack>
                    )}
                  </Box>
                );
              }
              if (!isTaskOrReminder && occ.status === "IN_PROGRESS" && isEstimateOcc && (isClaimer || forAdmin)) {
                return (
                  <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="purple.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "purple.600" }} title="Complete Estimate" onClick={(e: any) => {
                    e.stopPropagation();
                    setConfirmAction({
                      title: "Complete Estimate?",
                      message: "Add any comments about this estimate (optional):",
                      confirmLabel: "Complete",
                      colorPalette: "purple",
                      inputLabel: "Comments",
                      inputPlaceholder: "Notes about this estimate...",
                      inputOptional: true,
                      inputDefaultValue: occ.proposalNotes ?? "",
                      amountLabel: "Proposal Amount ($) — optional",
                      amountPlaceholder: "0.00",
                      amountDefaultValue: occ.proposalAmount != null ? Number(occ.proposalAmount).toFixed(2) : "",
                      pricingReferenceTags: [...parseJobTags(occ), ...((occ.addons ?? []) as any[]).map((a: any) => a.tag).filter(Boolean)],
                      onConfirm: (comments: string, amount?: string) => void completeEstimate(occ.id, comments, amount),
                    });
                  }}><CheckCircle2 size={12} /></Box>
                );
              }
              if (!isTaskOrReminder && occ.status === "PROPOSAL_SUBMITTED" && isEstimateOcc && (isClaimer || forAdmin)) {
                return (
                  <Box position="relative" flexShrink={0}>
                    <Box as="button" w="22px" h="22px" minW="22px" borderRadius="full" bg="green.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "green.600" }} title="Accept / Reject Estimate" onClick={(e: any) => {
                      e.stopPropagation();
                      setQuickActionMenuOcc((prev) => prev === occ.id ? null : occ.id);
                    }}><CheckCircle2 size={12} /></Box>
                    {quickActionMenuOcc === occ.id && (
                      <VStack
                        position="fixed"
                        bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px"
                        onClick={(e: any) => e.stopPropagation()}
                        ref={(el: HTMLDivElement | null) => {
                          if (el && el.parentElement) {
                            const rect = el.parentElement.getBoundingClientRect();
                            el.style.top = `${rect.bottom + 4}px`;
                            el.style.left = `${Math.max(8, Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))}px`;
                          }
                        }}
                      >
                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => {
                          setQuickActionMenuOcc(null);
                          setConfirmAction({
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
                                  const rawTags = result.occurrence?.jobTags;
                                  setPromptOccDefaults({
                                    notes: result.occurrence?.notes ?? null,
                                    price: result.occurrence?.price ?? null,
                                    estimatedMinutes: result.occurrence?.estimatedMinutes ?? null,
                                    jobTags: rawTags ? (Array.isArray(rawTags) ? rawTags : (() => { try { return JSON.parse(rawTags); } catch { return null; } })()) : null,
                                    jobType: result.occurrence?.jobType ?? null,
                                  });
                                  setPromptOccJobId(result.jobId);
                                }
                              } catch (err: any) {
                                publishInlineMessage({ type: "ERROR", text: getErrorMessage("Accept failed.", err) });
                              }
                            },
                          });
                        }}>
                          <CheckCircle2 size={12} /> Accept
                        </Button>
                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => {
                          setQuickActionMenuOcc(null);
                          setConfirmAction({
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
                          });
                        }}>
                          <X size={12} /> Reject
                        </Button>
                      </VStack>
                    )}
                  </Box>
                );
              }
              if (!isTaskOrReminder && occ.status === "PAUSED" && (isClaimer || forAdmin)) {
                return (
                  <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="orange.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "orange.600" }} title="Resume Job" onClick={(e: any) => {
                    e.stopPropagation();
                    void resumeJob(occ);
                  }}><Play size={12} /></Box>
                );
              }
              if (!isTaskOrReminder && occ.status === "PENDING_PAYMENT" && !isEstimateOcc && (isClaimer || forAdmin)) {
                // Mirror the three-state logic of the full-width button block
                // below (open / requestInFlight / pendingPayment). Only show
                // the shortcut icon in the "open" state — once a Payment row
                // exists (pendingPayment) or a Request was sent
                // (requestInFlight), the shortcut isn't actionable anymore.
                const pendingPayment = occ.payment && occ.payment.confirmed === false;
                const requestInFlight = !pendingPayment && !!occ.paymentRequestSentAt;
                const open = !pendingPayment && !requestInFlight;
                if (open) {
                  return (
                    <Box as="button" flexShrink={0} w="22px" h="22px" minW="22px" borderRadius="full" bg="green.500" color="white" display="flex" alignItems="center" justifyContent="center" _hover={{ bg: "green.600" }} title="Initiate Payment" onClick={(e: any) => {
                      e.stopPropagation();
                      setAcceptPaymentOcc(occ);
                      setAcceptPaymentOpen(true);
                    }}><CircleDollarSign size={12} /></Box>
                  );
                }
                return null;
              }
              if (isUnassigned && !isAdminOnlyOcc && !isTaskOrReminder) {
                const isContractor = me?.workerType === "CONTRACTOR";
                // ET calendar-day diff (DST-safe). Contractor lockout
                // rule is "jobs more than 2 ET days away".
                const daysAhead = occ.startAt ? bizDaysBetween(bizToday(), bizDateKey(occ.startAt)) : 0;
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
            })();

            // "More actions" dropdown — extracted into a JSX variable so the
            // ultra, semi, and expanded title rows all render the same button
            // + menu without code duplication. Body uses position:fixed and
            // computes coords from its parent Box; renders wherever it's used.
            const moreActionsMenu = isPeek ? null : (
              <Box position="relative">
                <Button variant="ghost" size="xs" px="1" minW="0" onClick={(e) => { e.stopPropagation(); setActionMenuOcc((v) => v === occ.id ? null : occ.id); }} title="More actions">
                  <MoreHorizontal size={16} />
                </Button>
                {actionMenuOcc === occ.id && (
                  <VStack
                    position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px" align="stretch"
                    ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))}px`; } }}
                    onClick={(e: any) => e.stopPropagation()}
                  >
                    {isWorkerView && (
                      <>
                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setActionMenuOcc(null); void toggleLike(occ.id); }}>
                          <Heart size={14} fill={likedIds.has(occ.id) ? "var(--chakra-colors-red-500)" : "none"} color="var(--chakra-colors-red-500)" />
                          <Box as="span" ml={2}>{likedIds.has(occ.id) ? "Unlike" : "Like"}</Box>
                        </Button>
                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setActionMenuOcc(null); void togglePin(occ.id); }}>
                          <Pin size={14} fill={pinnedIds.has(occ.id) ? "currentColor" : "none"} />
                          <Box as="span" ml={2}>{pinnedIds.has(occ.id) ? "Unpin" : "Pin"}</Box>
                        </Button>
                      </>
                    )}
                    {(() => {
                      // Editable through completion and unfinalized
                      // PENDING_PAYMENT; frozen once payment is
                      // requested/accepted (see occInEditableState).
                      const isActive = occInEditableState(occ);
                      const hasAnyPriv =
                        forAdmin ||
                        !!me?.privileges?.canPullInventory ||
                        !!me?.privileges?.canChargeBusinessExpenses;
                      // Admin/Super always pass — they can manage expenses on any job (e.g.
                      // adding a custom expense on behalf of a contractor who lacks the
                      // "Charge business expenses" privilege). Workers must be the claimer
                      // AND have at least one expense-related privilege.
                      // Followups are coordination items, not billable jobs — no expenses.
                      const canManage = isActive && !isFollowup && (forAdmin || isAdmin || isSuper || (isClaimer && hasAnyPriv));
                      if (!canManage) return null;
                      return (
                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setActionMenuOcc(null); setExpenseDialogOccId(occ.id); }}>
                          <CircleDollarSign size={14} />
                          <Box as="span" ml={2}>{occ.expenses && occ.expenses.length > 0 ? "Manage expenses" : "Add expense"}</Box>
                        </Button>
                      );
                    })()}
                    {/* Reminder — set / reschedule. Always available in
                        the worker view because reminders are per-user
                        and any worker (including Observers, who don't
                        have access to the footer action rows on
                        completed jobs) needs a way to add their own.
                        Server route is workerGuard with no observer
                        check — UI was the only gate. */}
                    {isWorkerView && (
                      <Button
                        size="xs"
                        variant="ghost"
                        w="full"
                        justifyContent="start"
                        onClick={() => {
                          setActionMenuOcc(null);
                          setReminderDialogOccId(occ.id);
                          setReminderDate(occ.reminder ? bizDateKey(occ.reminder.remindAt) : "");
                          setReminderNote(occ.reminder?.note ?? "");
                        }}
                      >
                        <Bell size={14} />
                        <Box as="span" ml={2}>{occ.reminder ? "Reschedule reminder" : "Set reminder"}</Box>
                      </Button>
                    )}
                    {/* Clear reminder — only shown when one already exists. */}
                    {isWorkerView && occ.reminder && (
                      <Button
                        size="xs"
                        variant="ghost"
                        w="full"
                        justifyContent="start"
                        disabled={isOffline}
                        title={isOffline ? "Requires internet" : undefined}
                        onClick={() => {
                          setActionMenuOcc(null);
                          void clearReminder(occ.id);
                        }}
                      >
                        <BellOff size={14} />
                        <Box as="span" ml={2}>Clear reminder</Box>
                      </Button>
                    )}
                    <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setActionMenuOcc(null); shareOccurrenceLink(occ.id, occ.startAt); }}>
                      <Share2 size={14} />
                      <Box as="span" ml={2}>Share link</Box>
                    </Button>
                  </VStack>
                )}
              </Box>
            );

            return (
              <Card.Root
                key={occ.id}
                variant="outline"
                borderColor={cardBorderColor}
                borderWidth={cardBorderWidth}
                bg={cardBg}
                overflow="hidden"
                position="relative"
                css={{
                  // Ultra (mini) cards are tap-anywhere to expand — keeps
                  // discoverability of the density cycle and matches prior
                  // behavior. Semi + expanded cards are NOT tap-anywhere
                  // (too easy to bump while scrolling); their Card.Header
                  // is the dedicated title-bar toggle instead.
                  cursor: cardMode === "ultra" ? "pointer" : "default",
                  "& a, & button": { pointerEvents: "auto" },
                  ...(isHighPriority ? { borderLeft: "4px solid var(--chakra-colors-purple-600)" } : isReminder ? { borderLeft: "4px solid var(--chakra-colors-purple-400)" } : isAnnouncement ? { borderLeft: "4px solid var(--chakra-colors-purple-400)", ...(isClosed ? { opacity: 0.7 } : {}) } : (isFollowup && !isClosed) ? { borderLeft: "4px solid var(--chakra-colors-red-400)" } : (isFollowup && isClosed) ? { borderLeft: "4px solid var(--chakra-colors-red-300)", opacity: 0.7 } : (isEvent && !isClosed) ? { borderLeft: "4px solid var(--chakra-colors-yellow-400)" } : (isEvent && isClosed) ? { borderLeft: "4px solid var(--chakra-colors-yellow-300)", opacity: 0.7 } : isTask ? { borderLeft: "4px solid var(--chakra-colors-blue-400)" } : {}),
                  // Peek rows fade back so they visually recede from
                  // the operator's own actionable rows. Applied last
                  // so it overrides any subtler category-based opacity
                  // (closed followup 0.7 etc) — peek should always
                  // read as "not yours" first.
                  ...(isPeek ? { opacity: 0.6 } : {}),
                  // Green pulse for IN_PROGRESS jobs — same animation
                  // the workday strip uses so "actively running work"
                  // reads the same on Home and on the Jobs timeline.
                  // Peek rows get the MUTED variant (half alpha,
                  // tighter spread) so a teammate's active job
                  // whispers "in progress" instead of competing with
                  // the operator's own actionable rows.
                  ...(isInProgress ? {
                    animation: isPeek
                      ? "seedlings-pulse-green-muted 2.5s ease-in-out infinite"
                      : "seedlings-pulse-green 2.5s ease-in-out infinite",
                  } : {}),
                }}
                onClick={cardMode === "ultra" ? (e: any) => {
                  if (!toggleCard) return;
                  const el = e.target as HTMLElement;
                  if (el?.closest?.("a, button")) return;
                  toggleCard();
                } : undefined}
              >
                {/* Loading overlay */}
                {busyOccId === occ.id && (
                  <Box position="absolute" inset="0" bg="whiteAlpha.700" zIndex="1" display="flex" alignItems="center" justifyContent="center" borderRadius="inherit">
                    <Spinner size="sm" />
                  </Box>
                )}
                {cardMode === "ultra" ? (
                  /* ── ULTRA: single-row scan layout. Click anywhere on the
                       row (other than the action menu) to expand into the
                       full card. Status dot + property + claimer + date. */
                  (() => {
                    const propertyName = occ.job?.property?.displayName ?? null;
                    const clientName = occ.job?.property?.client?.displayName ?? null;
                    const titleText = propertyName
                      ? `${propertyName}${clientName ? ` — ${clientName}` : ""}`
                      : (occ.title ?? "(untitled)");
                    // Show the active lead's name regardless of how they got
                    // assigned. "Lead" = the claimer (self-assigned) if there
                    // is one, else just the first active assignee. Always a
                    // name — the previous "1 assigned" fallback was missing
                    // info that's right there on the row.
                    const activeAssignees = assignees.filter((a: any) => a.role !== "observer");
                    const lead = activeAssignees.find((a: any) => a.assignedById === a.userId) ?? activeAssignees[0];
                    const others = Math.max(0, activeAssignees.length - 1);
                    // Group-claimed: show just the group name + crew size. Workers
                    // can expand the card to see who's on it.
                    const ultraGroup = (occ as any).assignedGroup as { name: string } | null | undefined;
                    // Lead name shrunk to first-initial + last-name on the
                    // ultra row to claw back horizontal space ("Mike Wanderski"
                    // → "M. Wanderski"). Single-word names and email fallbacks
                    // pass through unchanged.
                    const leadDisplay = (() => {
                      const raw = lead?.user?.displayName ?? lead?.user?.email ?? "";
                      const parts = raw.trim().split(/\s+/).filter(Boolean);
                      if (parts.length < 2) return raw;
                      return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
                    })();
                    const assigneeText = ultraGroup
                      ? `${ultraGroup.name} (${activeAssignees.length})`
                      : !lead
                        ? "Unassigned"
                        : `${leadDisplay}${others > 0 ? ` +${others}` : ""}`;
                    // Date/time intentionally omitted: the surrounding group
                    // header already shows the date (via fmtDateWeekday) and
                    // no other per-card view in this tab carries a time.
                    // Event-specific start times stay in the semi/expanded
                    // body where they exist today.
                    // Job total — price + addons (or proposalAmount). Same
                    // helper the semi/expanded card uses, so the number
                    // shown here matches what they see when they expand.
                    const total = totalPrice(occ);
                    return (
                      <HStack
                        px="3"
                        py="1"
                        gap={2}
                        // Fixed height (not minH) so every ultra row lands
                        // at the same visual height regardless of content —
                        // task rows without a $ badge, job rows with one,
                        // and peek rows all read as a uniform stripe.
                        // 44px accommodates the tallest content inside
                        // (Badge is ~22px, $/assignee stripe is ~24px)
                        // without clipping.
                        h="44px"
                        align="center"
                        fontSize="xs"
                      >
                        {/* Quick action icon if one is available; otherwise
                            an invisible spacer so every row's text aligns
                            at the same x-coordinate. The CSS overrides
                            shrink the (22px in semi) action button down to
                            18px specifically in the ultra row.
                            Selectors target the action button at depth 1
                            (direct) and depth 2 (wrapped in a position:
                            relative div for menu positioning, e.g. the
                            IN_PROGRESS Pause/Complete and Estimate
                            Accept/Reject buttons). The wrapper's menu items
                            are at depth 3 and stay full-size. */}
                        {quickActionButton ? (
                          <Box
                            flexShrink={0}
                            w="18px"
                            h="18px"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                            css={{
                              "& > button, & > div > button": {
                                width: "18px !important",
                                minWidth: "18px !important",
                                height: "18px !important",
                              },
                              "& > button svg, & > div > button svg": {
                                width: "10px",
                                height: "10px",
                              },
                            }}
                          >
                            {quickActionButton}
                          </Box>
                        ) : (
                          <Box flexShrink={0} w="18px" h="18px" />
                        )}
                        {/* Instructions indicator — bold yellow alert-circle
                            shown when this occurrence has one or more
                            special instructions, so workers see at a glance
                            that there's something to read before they start. */}
                        {(((occ as any).instructions ?? []).length > 0) && (
                          <Box
                            flexShrink={0}
                            display="inline-flex"
                            alignItems="center"
                            title={`${((occ as any).instructions as any[]).length} special instruction${((occ as any).instructions as any[]).length === 1 ? "" : "s"}`}
                          >
                            <AlertCircle
                              size={16}
                              color="var(--chakra-colors-yellow-900)"
                              fill="var(--chakra-colors-yellow-400)"
                              strokeWidth={2.5}
                            />
                          </Box>
                        )}
                        {isObserver && (
                          <Box flexShrink={0} display="inline-flex" alignItems="center" title="You're an observer">
                            <Eye size={14} color="var(--chakra-colors-blue-500)" />
                          </Box>
                        )}
                        {isPeek && (
                          <Box flexShrink={0} display="inline-flex" alignItems="center" title="Another worker's job — view only">
                            <Users size={14} color="var(--chakra-colors-purple-500)" />
                          </Box>
                        )}
                        <Text
                          flex="1"
                          minW={0}
                          truncate
                          color="fg"
                          fontSize="2xs"
                          fontWeight={isHighPriority ? "semibold" : "normal"}
                        >
                          {titleText}
                        </Text>
                        {total != null && !isObserver && (
                          <Box
                            flexShrink={0}
                            px="1"
                            py="0"
                            borderRadius="md"
                            bg="green.100"
                            color="green.800"
                            fontSize="2xs"
                            fontWeight="bold"
                            lineHeight="1.3"
                          >
                            ${Math.round(total).toLocaleString()}
                          </Box>
                        )}
                        <Text
                          flexShrink={0}
                          fontSize="2xs"
                          color={isUnassigned ? "orange.600" : "fg.muted"}
                          maxW="140px"
                          truncate
                        >
                          {assigneeText}
                        </Text>
                        {/* "..." menu on the ultra row too — same affordances
                            (Like / Pin / Add expense / Share link) without
                            having to expand the card first. */}
                        {moreActionsMenu}
                      </HStack>
                    );
                  })()
                ) : (
                <>
                {/* "Client confirmation required" banner moved into the
                    Card.Header (under the title row). "Manage in Services"
                    and the "Stand-alone estimate" note moved into the
                    Card.Footer action button row (in front of Claim, etc.). */}
                {/* Only the title row (first HStack inside each branch)
                    gets the darker bg + toggle click. Status badges /
                    chips below sit on the regular card bg so they're not
                    visually tied to the tap target. Ultra cards skip
                    Card.Header entirely and keep tap-anywhere behavior
                    on Card.Root. */}
                <Card.Header py="2" px="3" pb="0" display="block">
                  {isCardCompact ? (
                    /* ── COMPACT HEADER: responsive — stacked on mobile, side-by-side on desktop ── */
                    <Box display="flex" flexDirection="column" gap={1}>
                      {/* Title row = the tap target. Negative mx/mt bleed
                          past Card.Header's px="3" py="2" so the darker
                          strip is flush with the card edges. mb={1}
                          replaces the parent Box's gap so badges sit on
                          regular card bg below. */}
                      <HStack
                        gap={1}
                        justifyContent="space-between"
                        alignItems="center"
                        mx="-3"
                        mt="-2"
                        mb={1}
                        px="3"
                        py="2"
                        bg="blackAlpha.100"
                        cursor="pointer"
                        userSelect="none"
                        _hover={{ bg: "blackAlpha.200" }}
                        onClick={(e: any) => {
                          const el = e.target as HTMLElement;
                          if (el?.closest?.("a, button")) return;
                          toggleCard();
                        }}
                      >
                        {/* Quick action icon — extracted to quickActionButton above */}
                        {quickActionButton}
                        {likedIds.has(occ.id) && (
                          <Box flexShrink={0} display="flex" alignItems="center" title="Liked">
                            <Heart size={14} fill="var(--chakra-colors-red-500)" color="var(--chakra-colors-red-500)" />
                          </Box>
                        )}
                        {isObserver && (
                          <Box flexShrink={0} display="flex" alignItems="center" title="You're an observer">
                            <Eye size={14} color="var(--chakra-colors-blue-500)" />
                          </Box>
                        )}
                        {isPeek && (
                          <Box flexShrink={0} display="flex" alignItems="center" title="Another worker's job — view only">
                            <Users size={14} color="var(--chakra-colors-purple-500)" />
                          </Box>
                        )}
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
                          {/* Quick contact dropdown */}
                          {(() => {
                            const poc = (occ.job?.property as any)?.pointOfContact;
                            const phone = poc?.phone;
                            const email = poc?.email;
                            const name = poc?.firstName ? `${poc.firstName}${poc.lastName ? ` ${poc.lastName}` : ""}` : null;
                            if (!phone && !email) return null;
                            return (
                              <Box position="relative">
                                <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); setContactMenuOcc((v) => v === occ.id ? null : occ.id); }} title={name ? `Contact ${name}` : "Contact client"}>
                                  <MessageCircle size={14} color="var(--chakra-colors-green-500)" />
                                </Button>
                                {contactMenuOcc === occ.id && (
                                  <VStack
                                    position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="150px"
                                    ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))}px`; } }}
                                    onClick={(e: any) => e.stopPropagation()}
                                  >
                                    {name && <Text fontSize="xs" fontWeight="semibold" color="fg.muted" px="2" py="1">{name}</Text>}
                                    {phone && (
                                      <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setContactMenuOcc(null); window.open(`sms:${phone}`, "_self"); }}>
                                        <MessageCircle size={12} /> Text {phone}
                                      </Button>
                                    )}
                                    {email && (
                                      <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setContactMenuOcc(null); window.open(`mailto:${email}`, "_self"); }}>
                                        <Mail size={12} /> Email {email}
                                      </Button>
                                    )}
                                    {phone && (
                                      <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setContactMenuOcc(null); window.open(`tel:${phone}`, "_self"); }}>
                                        <Phone size={12} /> Call {phone}
                                      </Button>
                                    )}
                                    {(() => {
                                      const msg = getQuickMessage(occ, name);
                                      if (!msg) return null;
                                      // For PENDING_PAYMENT, prefer the server-prepared message
                                      // (includes the invoice link). Falls back to the local
                                      // message if the fetch hasn't completed yet.
                                      const useHandoff = occ.status === "PENDING_PAYMENT" && dropdownPayMsg?.occurrenceId === occ.id;
                                      const smsBody = useHandoff ? dropdownPayMsg.smsBody : msg.body;
                                      const emailSubject = useHandoff ? dropdownPayMsg.emailSubject : "Seedlings Lawn Care";
                                      const emailBody = useHandoff ? dropdownPayMsg.emailBody : msg.body;
                                      return (
                                        <Button size="xs" variant="ghost" w="full" justifyContent="start" colorPalette="blue" mt="1" pt="1.5" style={{ borderTop: "1px solid #cbd5e0" }} onClick={async () => {
                                            setContactMenuOcc(null);
                                            const cc = await fetchCommsCc();
                                            if (phone) {
                                              window.open(buildSmsHref({ to: phone, body: smsBody, ccPhones: cc.phones }), "_self");
                                              if (useHandoff) apiPost(`/api/occurrences/${occ.id}/comms-handoff`, { channel: "sms" }).catch(() => {});
                                            } else if (email) {
                                              window.open(buildMailtoHref({ to: email, subject: emailSubject, body: emailBody, ccEmails: cc.emails }), "_self");
                                              if (useHandoff) apiPost(`/api/occurrences/${occ.id}/comms-handoff`, { channel: "email" }).catch(() => {});
                                            }
                                          }}>
                                            <MessageCircle size={12} /> {msg.label}
                                          </Button>
                                      );
                                    })()}
                                  </VStack>
                                )}
                              </Box>
                            );
                          })()}
                          {moreActionsMenu}
                        </HStack>
                      </HStack>
                      {/* Client confirmation banner — sits directly under
                          the title row, above status badges. Same callout
                          shape as before, just relocated. */}
                      {needsConfirmation && (
                        <Box px="4" py="3" my={2} bg="orange.50" borderWidth="1px" borderColor="orange.300" borderRadius="md">
                          <Text fontSize="xs" fontWeight="semibold" color="orange.700">⚠ Client confirmation required before starting</Text>
                        </Box>
                      )}
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
                          {/* Three-state badges for PENDING_PAYMENT —
                           *  mirrors the action-button logic in this
                           *  card so the chip and the disabled state of
                           *  the button always agree:
                           *    - Payment row exists, not confirmed →
                           *      "Awaiting admin approval"
                           *    - No payment row, but request was sent →
                           *      "Awaiting client payment"
                           *    - Neither → no extra chip (just the
                           *      Pending_Payment status badge above) */}
                          {occ.status === "PENDING_PAYMENT" && !!occ.payment && occ.payment.confirmed === false && (
                            <StatusBadge status="Awaiting admin approval" palette="orange" variant="solid" />
                          )}
                          {occ.status === "PENDING_PAYMENT" && !occ.payment && !!occ.paymentRequestSentAt && (
                            <StatusBadge status="Awaiting client payment" palette="purple" variant="solid" />
                          )}
                          {/* Payroll-hours review chip — completed STANDARD/ONE_OFF
                              jobs whose hours haven't been admin-reviewed yet.
                              Sticky across status changes (including CLOSED) so
                              it doesn't get forgotten between payroll runs. For
                              admin/super the chip is a dropdown trigger (chevron
                              inside) that opens a one-item menu — Review Hours —
                              which surfaces the confirm dialog with Edit/Approve
                              choices. Workers see the chip as a passive label. */}
                          {(occ.workflow === "STANDARD" || occ.workflow === "ONE_OFF") &&
                            occ.completedAt && !occ.hoursApprovedAt && (
                            (isAdmin || isSuper) ? (
                              <Box position="relative" display="inline-flex">
                                <Box
                                  as="button"
                                  display="inline-flex"
                                  alignItems="center"
                                  gap="1"
                                  px="2"
                                  py="0.5"
                                  borderRadius="full"
                                  bg="orange.100"
                                  color="orange.800"
                                  fontSize="xs"
                                  fontWeight="medium"
                                  cursor="pointer"
                                  _hover={{ bg: "orange.200" }}
                                  onClick={(e: any) => {
                                    e.stopPropagation();
                                    setHoursMenuOcc((v) => v === occ.id ? null : occ.id);
                                  }}
                                >
                                  Job hours awaiting review
                                  <ChevronDown size={12} />
                                </Box>
                                {hoursMenuOcc === occ.id && (
                                  <VStack
                                    position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px" align="stretch"
                                    ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`; } }}
                                    onClick={(e: any) => e.stopPropagation()}
                                  >
                                    <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setHoursMenuOcc(null); openApproveHoursDialog(occ); }}>
                                      Review Hours
                                    </Button>
                                  </VStack>
                                )}
                              </Box>
                            ) : (
                              <StatusBadge status="Job hours awaiting review" palette="orange" variant="subtle" />
                            )
                          )}
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
                          {isConfirmed && occ.status === "SCHEDULED" && !isTaskOrReminder && <StatusBadge status="Confirmed" palette="green" variant="subtle" />}
                          {occ.linkGroupId && (
                            <Badge colorPalette="purple" variant="outline" fontSize="xs" px="1.5" borderRadius="full">
                              <Link2 size={10} style={{ marginRight: 3 }} /> Linked
                            </Badge>
                          )}
                          {(occ.price ?? 0) >= highValueThreshold && <Box as="span" display="inline-flex" alignItems="center" title="Only employees or insured contractors can claim this job"><StatusBadge status="Insured Only" palette="yellow" variant="solid" /></Box>}
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
                        {/* Info line for repeating-paused occurrences.
                            Hidden when the occurrence isn't paused. */}
                        <RepeatingPauseInfoLine occ={occ as any} />
                      </HStack>
                    </Box>
                    ) : (
                      /* ── EXPANDED HEADER: responsive — stacked on mobile, side-by-side on desktop ── */
                      <Box display="flex" flexDirection="column" gap="4px" w="full">
                        {/* Title row = the tap target. See compact branch
                            for box-model rationale on the negative margins. */}
                        <HStack
                          justifyContent="space-between"
                          alignItems="center"
                          mx="-3"
                          mt="-2"
                          mb={1}
                          px="3"
                          py="2"
                          bg="blackAlpha.100"
                          cursor="pointer"
                          userSelect="none"
                          _hover={{ bg: "blackAlpha.200" }}
                          onClick={(e: any) => {
                            const el = e.target as HTMLElement;
                            if (el?.closest?.("a, button")) return;
                            toggleCard();
                          }}
                        >
                          {/* Quick action icon — mirrors the compact title
                              row so the primary affordance stays in the
                              title bar regardless of density. */}
                          {quickActionButton}
                          {likedIds.has(occ.id) && (
                            <Box flexShrink={0} display="flex" alignItems="center" title="Liked">
                              <Heart size={16} fill="var(--chakra-colors-red-500)" color="var(--chakra-colors-red-500)" />
                            </Box>
                          )}
                          {isObserver && (
                            <Box flexShrink={0} display="flex" alignItems="center" title="You're an observer">
                              <Eye size={16} color="var(--chakra-colors-blue-500)" />
                            </Box>
                          )}
                          {isPeek && (
                            <Box flexShrink={0} display="flex" alignItems="center" title="Another worker's job — view only">
                              <Users size={16} color="var(--chakra-colors-purple-500)" />
                            </Box>
                          )}
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
                            {/* Quick contact dropdown */}
                            {(() => {
                              const poc = (occ.job?.property as any)?.pointOfContact;
                              const phone = poc?.phone;
                              const email = poc?.email;
                              const name = poc?.firstName ? `${poc.firstName}${poc.lastName ? ` ${poc.lastName}` : ""}` : null;
                              if (!phone && !email) return null;
                              return (
                                <Box position="relative">
                                  <Button variant="ghost" size="xs" px="0" minW="0" onClick={(e) => { e.stopPropagation(); setContactMenuOcc((v) => v === occ.id ? null : occ.id); }} title={name ? `Contact ${name}` : "Contact client"}>
                                    <MessageCircle size={14} color="var(--chakra-colors-green-500)" />
                                  </Button>
                                  {contactMenuOcc === occ.id && (
                                    <VStack
                                      position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="150px"
                                      ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))}px`; } }}
                                      onClick={(e: any) => e.stopPropagation()}
                                    >
                                      {name && <Text fontSize="xs" fontWeight="semibold" color="fg.muted" px="2" py="1">{name}</Text>}
                                      {phone && (
                                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setContactMenuOcc(null); window.open(`sms:${phone}`, "_self"); }}>
                                          <MessageCircle size={12} /> Text {phone}
                                        </Button>
                                      )}
                                      {email && (
                                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setContactMenuOcc(null); window.open(`mailto:${email}`, "_self"); }}>
                                          <Mail size={12} /> Email {email}
                                        </Button>
                                      )}
                                      {phone && (
                                        <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setContactMenuOcc(null); window.open(`tel:${phone}`, "_self"); }}>
                                          <Phone size={12} /> Call {phone}
                                        </Button>
                                      )}
                                      {(() => {
                                        const msg = getQuickMessage(occ, name);
                                        if (!msg) return null;
                                        // For PENDING_PAYMENT, prefer the server-prepared
                                        // message (includes the invoice link). Falls back to
                                        // the local message if the fetch hasn't completed.
                                        const useHandoff = occ.status === "PENDING_PAYMENT" && dropdownPayMsg?.occurrenceId === occ.id;
                                        const smsBody = useHandoff ? dropdownPayMsg.smsBody : msg.body;
                                        const emailSubject = useHandoff ? dropdownPayMsg.emailSubject : "Seedlings Lawn Care";
                                        const emailBody = useHandoff ? dropdownPayMsg.emailBody : msg.body;
                                        return (
                                            <Button size="xs" variant="ghost" w="full" justifyContent="start" colorPalette="blue" mt="1" pt="1.5" style={{ borderTop: "1px solid #cbd5e0" }} onClick={async () => {
                                              setContactMenuOcc(null);
                                              const cc = await fetchCommsCc();
                                              if (phone) {
                                                window.open(buildSmsHref({ to: phone, body: smsBody, ccPhones: cc.phones }), "_self");
                                                if (useHandoff) apiPost(`/api/occurrences/${occ.id}/comms-handoff`, { channel: "sms" }).catch(() => {});
                                              } else if (email) {
                                                window.open(buildMailtoHref({ to: email, subject: emailSubject, body: emailBody, ccEmails: cc.emails }), "_self");
                                                if (useHandoff) apiPost(`/api/occurrences/${occ.id}/comms-handoff`, { channel: "email" }).catch(() => {});
                                              }
                                            }}>
                                              <MessageCircle size={12} /> {msg.label}
                                            </Button>
                                        );
                                      })()}
                                    </VStack>
                                  )}
                                </Box>
                              );
                            })()}
                            {moreActionsMenu}
                          </HStack>
                        </HStack>
                        {/* Client confirmation banner — under the title row,
                            above sub-title and status badges. */}
                        {needsConfirmation && (
                          <Box px="4" py="3" my={2} bg="orange.50" borderWidth="1px" borderColor="orange.300" borderRadius="md">
                            <Text fontSize="xs" fontWeight="semibold" color="orange.700">⚠ Client confirmation required before starting</Text>
                          </Box>
                        )}
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
                                    setCardOverrides(new Map([[lo.id, "expanded"]]));
                                    setFilterJobId(null);
                                    setQ("");
                                    // Ensure date range includes the linked occurrence
                                    if (lo.startAt) {
                                      const occKey = bizDateKey(lo.startAt);
                                      const fromKey = bizAddDays(occKey, -3);
                                      const toKey = bizAddDays(occKey, 3);
                                      setDatePreset(null);
                                      setDateFrom(fromKey);
                                      setDateTo(toKey);
                                      void load(true, { from: fromKey, to: toKey }, lo.id);
                                    } else {
                                      void load(true, undefined, lo.id);
                                    }
                                  }}
                                >
                                  {occ.linkedOccurrence.job?.property?.displayName ?? "Job"}
                                  {occ.linkedOccurrence.job?.property?.client?.displayName && ` — ${clientLabel(occ.linkedOccurrence.job.property.client.displayName)}`}
                                  {parseJobTags(occ.linkedOccurrence).length > 0 && ` · ${parseJobTags(occ.linkedOccurrence).map(jobTagLabel).join(", ")}`}
                                  {occ.linkedOccurrence.jobType && ` · ${occ.linkedOccurrence.jobType}`}
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
                          {/* Three-state badges for PENDING_PAYMENT —
                           *  mirrors the action-button logic in this
                           *  card so the chip and the disabled state of
                           *  the button always agree:
                           *    - Payment row exists, not confirmed →
                           *      "Awaiting admin approval"
                           *    - No payment row, but request was sent →
                           *      "Awaiting client payment"
                           *    - Neither → no extra chip (just the
                           *      Pending_Payment status badge above) */}
                          {occ.status === "PENDING_PAYMENT" && !!occ.payment && occ.payment.confirmed === false && (
                            <StatusBadge status="Awaiting admin approval" palette="orange" variant="solid" />
                          )}
                          {occ.status === "PENDING_PAYMENT" && !occ.payment && !!occ.paymentRequestSentAt && (
                            <StatusBadge status="Awaiting client payment" palette="purple" variant="solid" />
                          )}
                          {/* Payroll-hours review chip — completed STANDARD/ONE_OFF
                              jobs whose hours haven't been admin-reviewed yet.
                              Sticky across status changes (including CLOSED) so
                              it doesn't get forgotten between payroll runs. For
                              admin/super the chip is a dropdown trigger (chevron
                              inside) that opens a one-item menu — Review Hours —
                              which surfaces the confirm dialog with Edit/Approve
                              choices. Workers see the chip as a passive label. */}
                          {(occ.workflow === "STANDARD" || occ.workflow === "ONE_OFF") &&
                            occ.completedAt && !occ.hoursApprovedAt && (
                            (isAdmin || isSuper) ? (
                              <Box position="relative" display="inline-flex">
                                <Box
                                  as="button"
                                  display="inline-flex"
                                  alignItems="center"
                                  gap="1"
                                  px="2"
                                  py="0.5"
                                  borderRadius="full"
                                  bg="orange.100"
                                  color="orange.800"
                                  fontSize="xs"
                                  fontWeight="medium"
                                  cursor="pointer"
                                  _hover={{ bg: "orange.200" }}
                                  onClick={(e: any) => {
                                    e.stopPropagation();
                                    setHoursMenuOcc((v) => v === occ.id ? null : occ.id);
                                  }}
                                >
                                  Job hours awaiting review
                                  <ChevronDown size={12} />
                                </Box>
                                {hoursMenuOcc === occ.id && (
                                  <VStack
                                    position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px" align="stretch"
                                    ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`; } }}
                                    onClick={(e: any) => e.stopPropagation()}
                                  >
                                    <Button size="xs" variant="ghost" w="full" justifyContent="start" onClick={() => { setHoursMenuOcc(null); openApproveHoursDialog(occ); }}>
                                      Review Hours
                                    </Button>
                                  </VStack>
                                )}
                              </Box>
                            ) : (
                              <StatusBadge status="Job hours awaiting review" palette="orange" variant="subtle" />
                            )
                          )}
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
                          {needsConfirmation && <StatusBadge status="Unconfirmed" palette="orange" variant="solid" />}
                          {isConfirmed && occ.status === "SCHEDULED" && !isTaskOrReminder && <StatusBadge status="Confirmed" palette="green" variant="subtle" />}
                          {(occ.price ?? 0) >= highValueThreshold && <Box as="span" display="inline-flex" alignItems="center" title="Only employees or insured contractors can claim this job"><StatusBadge status="Insured Only" palette="yellow" variant="solid" /></Box>}
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
                        </HStack>
                        {/* Info line for repeating-paused occurrences.
                            Hidden when the occurrence isn't paused. */}
                        <RepeatingPauseInfoLine occ={occ as any} />
                      </Box>
                    )}
                </Card.Header>

                {/* Peek strip — renders at the top of the card body
                    (immediately below the title bar) whenever the
                    card is a "view-only, someone else's job" row.
                    Only reachable in semi/expanded density; the ultra
                    branch returned earlier and surfaces the same info
                    via the small Users chip in the title bar.
                    Prominent purple pill so the read-only nature is
                    impossible to miss + names the actual assignees.
                    Zero interactive elements. */}
                {isPeek && (
                  <Box px="3" pt="2">
                    <HStack
                      gap={2}
                      align="center"
                      px={2}
                      py={1.5}
                      borderRadius="md"
                      bg="purple.50"
                      borderWidth="1px"
                      borderColor="purple.200"
                    >
                      <Users size={12} color="var(--chakra-colors-purple-500)" style={{ flexShrink: 0 }} />
                      <Text fontSize="xs" color="purple.900" lineClamp={1} flex={1} minW={0}>
                        {(() => {
                          const workerAssignees = (occ.assignees ?? [])
                            .filter((a) => (a.role ?? "") !== "observer")
                            .map((a) => a.user?.displayName || a.user?.email || "Unknown");
                          const names = workerAssignees.length === 0
                            ? "unassigned"
                            : workerAssignees.length <= 2
                              ? workerAssignees.join(" & ")
                              : `${workerAssignees.slice(0, 2).join(", ")} +${workerAssignees.length - 2}`;
                          return `View only · assigned to ${names}`;
                        })()}
                      </Text>
                    </HStack>
                  </Box>
                )}

                {/* Resolved client-request note — visible to workers
                 *  and admins so they know the latest exchange with the
                 *  client. Same note that the client sees on their My
                 *  Properties card. Falls off naturally on the next
                 *  recurring occurrence. */}
                {(() => {
                  const cr = (occ as any).changeRequests?.[0];
                  if (!cr?.resolutionNote) return null;
                  const verb = cr.kind === "RESCHEDULE" ? "Reschedule" : "Skip";
                  const action = cr.status === "DENIED" ? "dismissed" : "approved";
                  return (
                    <Box mx="4" mt="2" p="2" bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="md">
                      <Text fontSize="xs" fontWeight="semibold" color="blue.800">
                        {verb} request {action} — note to client
                      </Text>
                      <Text fontSize="sm" color="blue.900" mt={0.5}>
                        {cr.resolutionNote}
                      </Text>
                    </Box>
                  );
                })()}

                {isCardCompact ? (
                  <Card.Body py="2" px="3" pt="1" overflow="hidden">
                    <VStack align="start" gap={1} fontSize="xs">
                      {/* Event time */}
                      {isEvent && occ.startAt && (
                        <Text fontSize="sm" fontWeight="bold" color="#B45309">
                          {fmtTimeOpts(occ.startAt, { hour: "numeric", minute: "2-digit" })}
                        </Text>
                      )}
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
                      {/* Job tags + addon badges */}
                      {!isTaskOrReminder && (parseJobTags(occ).length > 0 || (occ as any).jobType || (occ.addons ?? []).length > 0) && (
                        <Box display="flex" gap="4px" flexWrap="wrap">
                          {parseJobTags(occ).map((tag: string) => (
                            <Badge key={tag} colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                              {jobTagLabel(tag)}
                            </Badge>
                          ))}
                          {(occ.addons ?? []).map((addon: any) => (
                            <Badge key={addon.id} fontSize="xs" px="2" borderRadius="full" bg="gray.200" color="gray.700">
                              +{addon.tag ? jobTagLabel(addon.tag) : addon.customLabel}
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
                      {/* Worker(s) — surfaced above the price/payout row to
                          match the fully-expanded card. For group-claimed
                          jobs we collapse to a single purple chip; the full
                          roster only shows when the user expands the card. */}
                      {(occ as any).assignedGroup ? (
                        <Badge size="sm" colorPalette="purple" variant="solid" borderRadius="full" px="2">
                          Group: {(occ as any).assignedGroup.name} ({(occ.assignees ?? []).filter((a: any) => a.role !== "observer").length})
                        </Badge>
                      ) : !isUnassigned ? (
                        <Text fontSize="xs" fontWeight="semibold" color="teal.700">
                          {[...assignees].sort((a, b) => assigneeSortOrder(a) - assigneeSortOrder(b)).map((a) => {
                            const name = a.user?.displayName ?? a.user?.email ?? a.userId;
                            const isCl = a.assignedById === a.userId && a.role !== "observer";
                            const role = isCl ? "Claimer - Lead Worker" : a.role === "observer" ? "Observer" : "Worker";
                            return `${name} (${role})`;
                          }).join(", ")}
                        </Text>
                      ) : occ.status !== "ARCHIVED" && !(isEvent || isFollowup || isAnnouncement) ? (
                        <Text fontSize="xs" fontWeight="semibold" color="orange.500">
                          {isTentative ? "Tentative — awaiting confirmation" : isAdminOnlyOcc ? "Unassigned — admin must assign" : "Unclaimed"}
                        </Text>
                      ) : null}
                      {/* Price / payout / time */}
                      {(() => { const basePrice = (occ.price || null) ?? (occ.proposalAmount || null); const addonsAmt = addonTotal(occ); const displayPrice = totalPrice(occ); return (
                      <Box display="flex" gap={2} flexWrap="wrap" alignItems="center">
                        {displayPrice != null && (
                          <Badge colorPalette="green" variant="solid" fontSize="xs" px="2" py="0.5" borderRadius="full">
                            ${displayPrice.toFixed(2)}{addonsAmt > 0 ? ` ($${(basePrice ?? 0).toFixed(2)} + $${addonsAmt.toFixed(2)})` : ""}{isEstimateOcc ? " (proposal)" : ""}
                          </Badge>
                        )}
                        {occ.payment && (
                          <Badge bg="green.700" color="white" fontSize="xs" px="2" py="0.5" borderRadius="full">
                            Paid: ${(occ.payment as any).amountPaid.toFixed(2)}
                          </Badge>
                        )}
                        {displayPrice != null && !occ.payment && (() => {
                          // Payout PROJECTION (no Payment row yet).
                          // Centralized in lib/paymentMath.ts.
                          //
                          // Two cases:
                          //   1. JOB IS ASSIGNED → project from the assignee(s)'
                          //      worker types. An admin viewing a contractor's
                          //      job sees the contractor's projection, not the
                          //      admin's own. For multi-worker crews, sum
                          //      across all active assignees.
                          //   2. JOB IS UNCLAIMED → fall back to the viewer's
                          //      worker type ("if I claim this, my payout").
                          //      Preserves the unclaimed-job affordance for
                          //      workers browsing available work.
                          const activeAssignees = (occ.assignees ?? []).filter((a) => a.role !== "observer");
                          const isUnclaimed = activeAssignees.length === 0;
                          const rates = { contractorFeePercent: commissionPercent, employeeMarginPercent: marginPercent };
                          const payout = isUnclaimed
                            ? projectViewerPayout(occ as any, me, rates)
                            : projectTeamPayoutsForOcc(occ as any, rates);
                          if (payout <= 0) return null;
                          // Label varies by case:
                          //   • Unclaimed → "Est. owner earnings" / "Payout (if you claim)"
                          //   • Single assignee → "<name>'s payout" (or "Owner Earnings" if owner)
                          //   • Multi → "Workers payout"
                          const single = !isUnclaimed && activeAssignees.length === 1 ? activeAssignees[0] : null;
                          const singleIsOwner = !!single?.user && (single.user as any).isOwner;
                          const label = isUnclaimed
                            ? me?.isOwner
                              ? "Est. owner earnings (if claimed)"
                              : "Payout (if you claim)"
                            : single
                              ? singleIsOwner
                                ? "Owner Earnings"
                                : `${single.user?.displayName ?? "Worker"}'s payout`
                              : "Workers payout";
                          const palette = isUnclaimed
                            ? me?.isOwner ? "purple" : "green"
                            : singleIsOwner ? "purple" : "green";
                          return (
                            <Badge colorPalette={palette} variant="subtle" fontSize="xs" px="2" borderRadius="full">
                              {label}: ${payout.toFixed(2)}
                            </Badge>
                          );
                        })()}
                        {!isTaskOrReminder && !isEstimateOcc && !isEvent && !isFollowup && !isAnnouncement && (() => {
                          const actual = effectiveMinutes(occ);
                          const workerCount = Math.max(1, (occ.assignees ?? []).filter((a) => a.role !== "observer").length);
                          const adjEst = occ.estimatedMinutes && workerCount > 1 ? Math.round(occ.estimatedMinutes / workerCount) : occ.estimatedMinutes;
                          const medianPersonMin = (occ as any).medianDurationMinutes as number | undefined;
                          const median = medianPersonMin != null ? Math.round(medianPersonMin / workerCount) : undefined;
                          const canEdit = (isClaimer || isActiveAssignee || forAdmin) && !!occ.completedAt;
                          const isPaused = occ.status === "PAUSED";
                          const parts: string[] = [];
                          if (actual != null) parts.push(`${formatDuration(actual)} actual${workerCount > 1 ? ` (${workerCount} workers)` : ""}`);
                          if (adjEst != null) parts.push(`${formatDuration(adjEst)} est.${workerCount > 1 ? ` (${workerCount} workers)` : ""}`);
                          if (occ.workflow === "STANDARD" && median != null) {
                            parts.push(`${formatDuration(median)} avg${workerCount > 1 ? ` (${workerCount} workers)` : ""}`);
                          }
                          if (isPaused) parts.push("paused");
                          if (parts.length === 0) return null;
                          const color = isPaused ? "orange.600" : occ.completedAt && actual != null && adjEst ? (actual <= adjEst ? "green.600" : "red.600") : "fg.muted";
                          return (
                            <Text color={color} fontWeight="medium" cursor={canEdit ? "pointer" : undefined} textDecoration={canEdit ? "underline" : undefined} onClick={canEdit ? (e: any) => { e.stopPropagation(); setEditTimeOcc(occ); } : undefined}>
                              {parts.join(" · ")}
                            </Text>
                          );
                        })()}
                      </Box>
                      ); })()}
                    </VStack>
                    <HStack mt={1} justify="flex-end" align="center">
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
                            if (isCardCompact) setCardOverrides((prev) => { const next = new Map(prev); next.set(occ.id, "expanded"); return next; });
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
                    {/* Warning: next occurrence not created */}
                    {occ.payment?.nextOccurrenceSkipReason && occ.payment.nextOccurrenceSkipReason !== "one_off" && (
                      <Box w="full" p={2} bg="red.50" borderWidth="1px" borderColor="red.300" borderRadius="md">
                        <Text fontSize="xs" fontWeight="bold" color="red.700">
                          ⚠️ Next occurrence was NOT auto-created
                        </Text>
                        <Text fontSize="xs" color="red.600">
                          {occ.payment.nextOccurrenceSkipReason === "no_frequency_set" && "No repeat frequency is set on the job or occurrence."}
                          {occ.payment.nextOccurrenceSkipReason === "job_paused" && "The job service is paused."}
                          {occ.payment.nextOccurrenceSkipReason === "duplicate_exists" && "A scheduled occurrence already exists on the next date."}
                          {occ.payment.nextOccurrenceSkipReason === "occurrence_or_job_not_found" && "Could not find the job service."}
                        </Text>
                      </Box>
                    )}
                    {/* Event time — prominent */}
                    {isEvent && occ.startAt && (
                      <Text fontSize="md" fontWeight="bold" color="#B45309">
                        {fmtTimeOpts(occ.startAt, { hour: "numeric", minute: "2-digit" })}
                      </Text>
                    )}
                    {isLightEstimate && occ.estimateAddress && (
                      <Box fontSize="xs"><MapLink address={occ.estimateAddress} /></Box>
                    )}
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
                    {(parseJobTags(occ).length > 0 || (occ as any).jobType || (occ.addons ?? []).length > 0) && (
                      <Box display="flex" gap="4px" flexWrap="wrap">
                        {parseJobTags(occ).map((tag: string) => (
                          <Badge key={tag} colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                            {jobTagLabel(tag)}
                          </Badge>
                        ))}
                        {(occ.addons ?? []).map((addon: any) => (
                          <Badge key={addon.id} fontSize="xs" px="2" borderRadius="full" bg="gray.200" color="gray.700">
                            +{addon.tag ? jobTagLabel(addon.tag) : addon.customLabel}
                          </Badge>
                        ))}
                        {(occ as any).jobType && (
                          <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                            {jobTypeLabel((occ as any).jobType)}
                          </Badge>
                        )}
                      </Box>
                    )}
                    {/* Group chip — present when the occurrence was claimed
                        on behalf of a group or admin-attached a group. */}
                    {(occ as any).assignedGroup && (
                      <Badge size="sm" colorPalette="purple" variant="solid" borderRadius="full" px="2">
                        Group: {(occ as any).assignedGroup.name} ({(occ.assignees ?? []).filter((a: any) => a.role !== "observer").length})
                      </Badge>
                    )}
                    {/* Worker(s) — surfaced above the money/payout panel so
                        you see who's on the job before the price breakdown. */}
                    {!isUnassigned && (
                      <VStack align="start" gap={0}>
                        {[...assignees].sort((a, b) => assigneeSortOrder(a) - assigneeSortOrder(b)).map((a) => {
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
                    {(totalPrice(occ) != null || occ.payment || ((occ.price || null) ?? (occ.proposalAmount || null)) != null) && (
                      <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={2} bg="gray.50" fontSize="xs">
                        <VStack align="start" gap={1}>
                          {totalPrice(occ) != null && (() => { const basePrice = (occ.price || null) ?? (occ.proposalAmount || null); const addonsAmt = addonTotal(occ); return (
                            <Badge colorPalette="green" variant="solid" fontSize="sm" px="3" py="0.5" borderRadius="full">
                              ${totalPrice(occ)!.toFixed(2)}{addonsAmt > 0 ? ` ($${(basePrice ?? 0).toFixed(2)} + $${addonsAmt.toFixed(2)})` : ""}{isEstimateOcc ? " (proposal)" : ""}
                            </Badge>
                          ); })()}
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
                                    businessName,
                                    clientName: occ.job?.property?.client?.displayName ?? "Client",
                                    propertyAddress: [occ.job?.property?.street1, occ.job?.property?.city, occ.job?.property?.state].filter(Boolean).join(", "),
                                    jobType: [parseJobTags(occ).length > 0 ? parseJobTags(occ).map(jobTagLabel).join(", ") : null, (occ as any).jobType ? `Custom: ${(occ as any).jobType}` : null].filter(Boolean).join(" · ") || occ.kind || "Lawn Care",
                                    serviceDate: occ.startAt ? fmtDate(occ.startAt) : "—",
                                    completedDate: occ.completedAt ? fmtDate(occ.completedAt) : "—",
                                    amount: (occ.payment as any).amountPaid,
                                    methodLabel: methodLabel((occ.payment as any).method ?? "CASH"),
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
                            // Expanded per-worker payout PROJECTION (no
                            // Payment row yet). For assigned jobs we project
                            // each assignee's payout using THEIR worker type
                            // — admin viewing a contractor's job sees the
                            // contractor's projection, not the admin's. For
                            // unclaimed jobs we fall back to the viewer's
                            // projection ("if I claim, my payout").
                            const basePrice = ((occ.price || null) ?? (occ.proposalAmount || null))!;
                            const addonsAmt = addonTotal(occ);
                            const displayPriceVal = basePrice + addonsAmt;
                            const expTotal = (occ.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                            const net = Math.max(0, displayPriceVal - expTotal);
                            const activeAssignees = (occ.assignees ?? []).filter((a) => a.role !== "observer");
                            const rates = { contractorFeePercent: commissionPercent, employeeMarginPercent: marginPercent };
                            const isUnclaimed = activeAssignees.length === 0;

                            if (isUnclaimed) {
                              // "If you claim this" projection — viewer's
                              // worker type drives the rate. Matches the
                              // chip's unclaimed-case behavior above.
                              const viewerRate = rateForViewer(me as any, rates);
                              if (viewerRate <= 0) return null;
                              const share = perWorkerShare(occ as any);
                              const myPayout = projectViewerPayout(occ as any, me, rates);
                              const myDeduction = Math.round((share - myPayout) * 100) / 100;
                              const viewerLabel = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE" ? "margin" : "commission";
                              return (
                                <Box fontSize="xs" color="fg.muted">
                                  <HStack gap={2}>
                                    <Text>{me?.isOwner ? "Est. owner earnings (if claimed):" : "Payout if you claim:"}</Text>
                                    <Badge colorPalette={me?.isOwner ? "purple" : "green"} variant="subtle" fontSize="xs" px="2" borderRadius="full">
                                      ${myPayout.toFixed(2)}
                                    </Badge>
                                  </HStack>
                                  <Text fontSize="xs" color="fg.muted">
                                    ${displayPriceVal.toFixed(2)}{expTotal > 0 ? ` − $${expTotal.toFixed(2)} exp` : ""} − ${myDeduction.toFixed(2)} {viewerLabel} ({viewerRate}%)
                                  </Text>
                                </Box>
                              );
                            }

                            // Assigned case: per-worker breakdown using each
                            // assignee's own worker type. share is identical
                            // for every assignee (equal split of `net`).
                            const sharePerWorker = net / activeAssignees.length;
                            const rows = activeAssignees.map((a) => {
                              const wt = a.user?.workerType ?? null;
                              const isEmpClass = wt === "EMPLOYEE" || wt === "TRAINEE";
                              const ratePct = isEmpClass ? marginPercent : commissionPercent;
                              const deduction = Math.round(sharePerWorker * (ratePct / 100) * 100) / 100;
                              const payout = Math.round(Math.max(0, sharePerWorker - deduction) * 100) / 100;
                              return {
                                userId: a.userId,
                                name: a.user?.displayName ?? a.user?.email ?? a.userId,
                                workerType: wt,
                                isOwner: !!(a.user as any)?.isOwner,
                                share: Math.round(sharePerWorker * 100) / 100,
                                deduction,
                                deductionLabel: isEmpClass ? "margin" : "commission",
                                ratePct,
                                payout,
                              };
                            });
                            const totalPayout = rows.reduce((s, r) => s + r.payout, 0);
                            const workerCount = activeAssignees.length;
                            const headlineLabel = workerCount === 1
                              ? (rows[0].isOwner ? `Est. ${rows[0].name}'s owner earnings:` : `Est. ${rows[0].name}'s payout:`)
                              : "Est. workers' payout:";
                            const headlinePalette = workerCount === 1 && rows[0].isOwner ? "purple" : "green";
                            return (
                              <Box fontSize="xs" color="fg.muted">
                                <HStack gap={2}>
                                  <Text>{headlineLabel}</Text>
                                  <Badge colorPalette={headlinePalette} variant="subtle" fontSize="xs" px="2" borderRadius="full">
                                    ${totalPayout.toFixed(2)}
                                  </Badge>
                                </HStack>
                                {workerCount > 1 && expTotal > 0 && (
                                  <Text fontSize="xs" color="fg.muted">
                                    ${displayPriceVal.toFixed(2)} − ${expTotal.toFixed(2)} exp = ${net.toFixed(2)} net
                                  </Text>
                                )}
                                {workerCount > 1 ? (
                                  <VStack align="start" gap={0} mt={0.5}>
                                    {rows.map((r) => (
                                      <Text key={r.userId} fontSize="xs" color="fg.muted">
                                        {r.name}: ${r.share.toFixed(2)} share − ${r.deduction.toFixed(2)} {r.deductionLabel} ({r.ratePct}%) = ${r.payout.toFixed(2)}
                                      </Text>
                                    ))}
                                  </VStack>
                                ) : (
                                  <Text fontSize="xs" color="fg.muted">
                                    ${displayPriceVal.toFixed(2)}{expTotal > 0 ? ` − $${expTotal.toFixed(2)} exp` : ""} − ${rows[0].deduction.toFixed(2)} {rows[0].deductionLabel} ({rows[0].ratePct}%)
                                  </Text>
                                )}
                              </Box>
                            );
                          })()}
                        </VStack>
                      </Box>
                    )}
                    {!isTaskOrReminder && !isEstimateOcc && !isEvent && !isFollowup && !isAnnouncement && (occ.estimatedMinutes != null || occ.startedAt || (occ as any).medianDurationMinutes != null) && (() => {
                      const workerCount = Math.max(1, (occ.assignees ?? []).filter((a) => a.role !== "observer").length);
                      const adjEst = occ.estimatedMinutes && workerCount > 1 ? Math.round(occ.estimatedMinutes / workerCount) : occ.estimatedMinutes;
                      const actual = effectiveMinutes(occ);
                      const medianPersonMin = (occ as any).medianDurationMinutes as number | undefined;
                      // medianDurationMinutes is stored as person-minutes. Display as wall-clock for current team size.
                      const median = medianPersonMin != null ? Math.round(medianPersonMin / workerCount) : undefined;
                      const hasData = adjEst != null || actual != null || median != null || occ.startedAt;
                      if (!hasData) return null;
                      const estDiscrepancy = actual != null && adjEst ? Math.abs(actual - adjEst) / adjEst : 0;
                      const avgDiscrepancy = actual != null && median ? Math.abs(actual - median) / median : 0;
                      return (
                        <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={2} bg="gray.50" fontSize="xs">
                          <VStack align="start" gap={1}>
                            <HStack gap={3} wrap="wrap">
                              {actual != null && (
                                <Text color={occ.status === "PAUSED" ? "orange.600" : occ.completedAt && adjEst ? (actual <= adjEst ? "green.600" : "red.600") : "fg.default"} fontWeight="semibold">
                                  Actual: {formatDuration(actual)}{workerCount > 1 ? ` (${workerCount} workers)` : ""}{occ.status === "PAUSED" ? " (paused)" : ""}
                                </Text>
                              )}
                              {adjEst != null && (
                                <Text color="fg.muted">
                                  <Text as="span" fontWeight="semibold">Est:</Text> {formatDuration(adjEst)}{workerCount > 1 ? ` (${workerCount} workers)` : ""}
                                </Text>
                              )}
                              {(occ.workflow === "STANDARD") && (
                                <Text color="fg.muted">
                                  <Text as="span" fontWeight="semibold">Avg:</Text> {median != null ? `${formatDuration(median)}${workerCount > 1 ? ` (${workerCount} workers)` : ""}` : "n/a"}
                                </Text>
                              )}
                            </HStack>
                            {occ.completedAt && actual != null && estDiscrepancy > hoursVarianceThreshold && adjEst && (
                              <Text color="orange.600" fontWeight="medium">
                                ⚠ {Math.round(estDiscrepancy * 100)}% {actual > adjEst ? "over" : "under"} estimate —{" "}
                                <Box as="span" textDecoration="underline" cursor="pointer" onClick={(e: any) => { e.stopPropagation(); setEditTimeOcc(occ); }}>Edit time</Box>
                              </Text>
                            )}
                            {occ.completedAt && actual != null && avgDiscrepancy > hoursVarianceThreshold && median && !( estDiscrepancy > hoursVarianceThreshold && adjEst) && (
                              <Text color="orange.600" fontWeight="medium">
                                ⚠ {Math.round(avgDiscrepancy * 100)}% {actual > median ? "above" : "below"} average —{" "}
                                <Box as="span" textDecoration="underline" cursor="pointer" onClick={(e: any) => { e.stopPropagation(); setEditTimeOcc(occ); }}>Edit time</Box>
                              </Text>
                            )}
                            {occ.startedAt && (
                              <Text color="fg.muted">Started: {fmtDateTime(occ.startedAt)}{occ.completedAt ? ` · Completed: ${fmtDateTime(occ.completedAt)}` : ""}</Text>
                            )}
                          </VStack>
                        </Box>
                      );
                    })()}
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
                            Paid: ${pay.amountPaid.toFixed(2)} via {methodLabel(pay.method)}
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
                    {/* Add-on services */}
                    {(occ.addons ?? []).length > 0 && (() => {
                      // Removal allowed for claimer / admin / super while the
                      // job is still editable (through completion and
                      // unfinalized PENDING_PAYMENT). Removed add-ons are
                      // hard-deleted (no carry-forward to next occurrence
                      // exists anyway, so there's nothing to reconcile).
                      const isActive = occInEditableState(occ);
                      const canRemove = isActive && (forAdmin || isAdmin || isSuper || isClaimer);
                      return (
                      <Box mt={1} p={1} bg="green.50" rounded="sm" w="full" borderWidth="1px" borderColor="green.200">
                        <Text fontSize="xs" fontWeight="medium" color="green.700">
                          Add-ons: +${addonTotal(occ).toFixed(2)}
                        </Text>
                        <VStack align="start" gap={0} mt={0.5}>
                          {(occ.addons ?? []).map((addon: any) => (
                            <HStack key={addon.id} gap={1} align="center">
                              <Text fontSize="xs" color="green.600">
                                +${addon.price.toFixed(2)} — {addon.tag ? jobTagLabel(addon.tag) : addon.customLabel}
                              </Text>
                              {canRemove && (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  colorPalette="red"
                                  px="1"
                                  minW="auto"
                                  title="Remove this service"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      await apiDelete(`/api/${forAdmin ? "admin/" : ""}occurrences/${occ.id}/addons/${addon.id}`);
                                      setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, addons: (o.addons ?? []).filter((a: any) => a.id !== addon.id) } : o));
                                      publishInlineMessage({ type: "SUCCESS", text: "Service removed." });
                                    } catch (err) {
                                      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to remove service.", err) });
                                    }
                                  }}
                                >
                                  <X size={11} />
                                </Button>
                              )}
                            </HStack>
                          ))}
                        </VStack>
                      </Box>
                      );
                    })()}
                    {/* Expenses */}
                    {occ.expenses && occ.expenses.length > 0 && (
                      <Box mt={1} p={1} bg="red.50" rounded="sm" w="full" borderWidth="1px" borderColor="red.200">
                        <Text fontSize="xs" fontWeight="medium" color="red.700">
                          Expenses: −${occ.expenses.reduce((s, e) => s + e.cost, 0).toFixed(2)}
                        </Text>
                        <VStack align="start" gap={0} mt={0.5}>
                          {occ.expenses.map((exp) => {
                            // Inventory-backed expenses are paired with a SupplyHold
                            // server-side; everything else is a custom out-of-pocket /
                            // company-card expense. Tag both so the worker knows
                            // which path the row came from at a glance.
                            const fromInventory = !!(exp as any).supplyHold;
                            return (
                              <HStack key={exp.id} gap={1.5} align="center" wrap="wrap">
                                <Text fontSize="xs" color="red.600">
                                  −${exp.cost.toFixed(2)} — {exp.description}
                                </Text>
                                {fromInventory ? (
                                  <Badge size="sm" colorPalette="blue" variant="subtle" borderRadius="full" px="2" fontSize="2xs">
                                    Inventory
                                  </Badge>
                                ) : (
                                  <Badge size="sm" colorPalette="orange" variant="subtle" borderRadius="full" px="2" fontSize="2xs">
                                    Custom Expense
                                  </Badge>
                                )}
                              </HStack>
                            );
                          })}
                        </VStack>
                      </Box>
                    )}
                    {/* Suggested gear — equipment kinds (blue) + collections
                        (purple) + group preferred (teal) folded into a single
                        panel. Buttons keep their original palette so the kinds
                        remain visually distinct while sharing one section. */}
                    {!isTaskOrReminder && (() => {
                      const allTags = [...parseJobTags(occ), ...((occ.addons ?? []) as any[]).map((a: any) => a.tag).filter(Boolean)];
                      const suggestions = suggestedEquipment(serviceTypes, allTags, equipmentKinds);
                      const recIds: string[] = ((occ.job as any)?.recommendedCollections ?? []).map((r: any) => r.collectionId);
                      const recs = recIds
                        .map((id) => equipmentCollections.find((c) => c.id === id))
                        .filter(Boolean) as CollectionLite[];
                      // Group preferred equipment: only surfaces when the
                      // occurrence is group-claimed. Display-only — clicking
                      // jumps to the equipment/collection like the other chips.
                      const groupPref = ((occ as any).assignedGroup?.preferredEquipment ?? []) as Array<{
                        id: string;
                        equipmentId: string | null;
                        equipmentCollectionId: string | null;
                        equipment: { id: string; shortDesc?: string | null; brand?: string | null; model?: string | null; type?: string | null } | null;
                        equipmentCollection: { id: string; name: string } | null;
                      }>;
                      if (suggestions.length === 0 && recs.length === 0 && groupPref.length === 0) return null;
                      // Every chip click sets the Equipment tab's "Reserve
                      // as:" hint explicitly — to the assigned group's id
                      // when the viewer is its claimer, otherwise to ""
                      // (Just me). Always writing the hint prevents stale
                      // persisted picker state from a previous session
                      // bleeding into a solo job's flow.
                      const occGroup = (occ as any).assignedGroup as { id: string; claimerUserId: string } | null | undefined;
                      const useGroup = !!(occGroup && me?.id === occGroup.claimerUserId);
                      const setReserveAs = () => {
                        try {
                          window.sessionStorage.setItem(
                            "reserveAsGroupId",
                            useGroup ? occGroup!.id : "",
                          );
                        } catch {}
                      };
                      return (
                        <Box mt={1} p={2} bg="gray.50" borderWidth="1px" borderColor="gray.200" borderRadius="md">
                          <Text fontSize="xs" fontWeight="semibold" color="gray.700" mb={1}>Suggested Equipment & Collections</Text>
                          <HStack gap={1.5} wrap="wrap">
                            {suggestions.map((s) => (
                              <Button
                                key={`eq-${s.equipmentKind}`}
                                size="xs"
                                variant="solid"
                                colorPalette="blue"
                                px="2"
                                borderRadius="full"
                                fontWeight="medium"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setReserveAs();
                                  window.sessionStorage.setItem("equipmentKindFilter", s.equipmentKind);
                                  openEventSearch("jobsToEquipmentKindFilter", " ", forAdmin, s.equipmentKind);
                                }}
                              >
                                {s.label} →
                              </Button>
                            ))}
                            {recs.map((c) => {
                              const total = c.items.length;
                              const available = c.items.filter((i) => !i.equipment.retiredAt && i.equipment.status === "AVAILABLE").length;
                              return (
                                <Button
                                  key={`col-${c.id}`}
                                  size="xs"
                                  variant="solid"
                                  colorPalette="purple"
                                  px="2"
                                  borderRadius="full"
                                  fontWeight="medium"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setReserveAs();
                                    // Send the worker to the Equipment tab where the collections strip
                                    // is rendered with a Reserve button. Highlights via session flag.
                                    try { window.sessionStorage.setItem("highlightCollectionId", c.id); } catch {}
                                    window.dispatchEvent(new CustomEvent(forAdmin ? "navigate:adminTab" : "navigate:workerTab", { detail: { tab: "equipment" } }));
                                  }}
                                >
                                  {c.name} ({available}/{total}) →
                                </Button>
                              );
                            })}
                            {groupPref.map((gp) => {
                              const isCol = !!gp.equipmentCollectionId;
                              const label = isCol
                                ? `${gp.equipmentCollection?.name ?? "—"} (group kit)`
                                : (gp.equipment?.shortDesc
                                    || [gp.equipment?.brand, gp.equipment?.model].filter(Boolean).join(" ")
                                    || gp.equipment?.type
                                    || "—");
                              return (
                                <Button
                                  key={`gp-${gp.id}`}
                                  size="xs"
                                  variant="solid"
                                  colorPalette="teal"
                                  px="2"
                                  borderRadius="full"
                                  fontWeight="medium"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setReserveAs();
                                    if (isCol && gp.equipmentCollectionId) {
                                      try { window.sessionStorage.setItem("highlightCollectionId", gp.equipmentCollectionId); } catch {}
                                      window.dispatchEvent(new CustomEvent(forAdmin ? "navigate:adminTab" : "navigate:workerTab", { detail: { tab: "equipment" } }));
                                    } else if (gp.equipmentId) {
                                      try { window.sessionStorage.setItem("equipmentHighlightId", gp.equipmentId); } catch {}
                                      window.dispatchEvent(new CustomEvent(forAdmin ? "navigate:adminTab" : "navigate:workerTab", { detail: { tab: "equipment" } }));
                                    }
                                  }}
                                  title={`Preferred by the group${isCol ? " — kit" : ""}`}
                                >
                                  {label} ★
                                </Button>
                              );
                            })}
                          </HStack>
                        </Box>
                      );
                    })()}
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
                                    setCardOverrides(new Map([[lo.id, "expanded"]]));
                                    setFilterJobId(null);
                                    setQ("");
                                  });
                                }}
                              >
                                {lo.startAt ? fmtDate(lo.startAt) : "No date"}
                                {lo.job?.property?.displayName ? ` · ${lo.job.property.displayName}` : ""}
                                {parseJobTags(lo).length > 0 && ` · ${parseJobTags(lo).map(jobTagLabel).join(", ")}`}{(lo as any).jobType && ` · ${(lo as any).jobType}`}
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

                {/* Action footer — admin/super always see it (so tentative
                    jobs can be confirmed, rescheduled, team-changed before
                    client confirmation). Workers/observers see it only on
                    non-tentative jobs since the start/complete affordances
                    don't apply until the client has confirmed. */}
                {!isCardCompact && !isTrainee && !isPeek && (isUnassigned || isActiveAssignee || (forAdmin && (isAdmin || isSuper))) && (!isTentative || (forAdmin && (isAdmin || isSuper))) && (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS" || (occ.status as string) === "PAUSED" || occ.status === "PENDING_PAYMENT" || occ.status === "CLOSED" || occ.status === "PROPOSAL_SUBMITTED") && (
                  <Card.Footer py="2" px="3" pt="0">
                    {/* HStack (not VStack) so Manage in Services lands on
                        the same row as the per-status primary action
                        (Claim / Confirm Client / Start Job / Complete /
                        etc.). wrap="wrap" lets buttons flow onto a second
                        line on narrow screens. */}
                    <HStack align="start" gap={2} mb="2" wrap="wrap">
                    {/* Admin-only Services shortcut — sits at the start of
                        the action row so it reads as "manage this job"
                        alongside the per-occurrence Claim/Start/etc.
                        actions. */}
                    {(isAdmin || isSuper) && !isTaskOrReminder && occ.jobId && (
                      <Button
                        size="sm"
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
                    )}
                    {(isAdmin || isSuper) && !isTaskOrReminder && !occ.jobId && isEstimateOcc && (
                      <Text fontSize="xs" color="orange.600">Stand-alone estimate — not yet linked to a Job Service</Text>
                    )}
                    {/* Approve payroll hours — admin/super only, surfaces when
                        an outlier completion left hoursApprovedAt = null. Opens
                        a confirm dialog with an "Edit Time" secondary
                        action so the admin can adjust before approving. */}
                    {(isAdmin || isSuper) &&
                      (occ.workflow === "STANDARD" || occ.workflow === "ONE_OFF") &&
                      occ.completedAt && !occ.hoursApprovedAt && (
                      <Button
                        size="sm"
                        variant="solid"
                        colorPalette="orange"
                        disabled={busyOccId === occ.id}
                        onClick={(e: any) => {
                          e.stopPropagation();
                          openApproveHoursDialog(occ);
                        }}
                      >
                        Review Hours
                      </Button>
                    )}
                    {/* Confirm client — must happen before Start */}
                    {needsConfirmation && (isClaimer || forAdmin) && (
                      <Button
                        size="sm"
                        variant="solid"
                        colorPalette="orange"
                        disabled={isOffline}
                        onClick={() => openConfirmClientDialog(occ)}
                      >
                        Confirm Client
                      </Button>
                    )}
                    {/* Primary action — Start / Complete / Accept Payment.
                        Server enforces claimer-only (jobs.ts updateOccurrenceStatus),
                        so we mirror that here instead of showing buttons that 403. */}
                    {(isClaimer || forAdmin) && !isTaskOrReminder && occ.status === "SCHEDULED" && !isTentative && !needsConfirmation && (
                      <Button
                        size="sm"
                        variant="solid"
                        colorPalette="blue"
                        loading={busyOccId === occ.id}
                        onClick={() => openStartJobDialog(occ)}
                      >
                        {isEstimateOcc ? "Start Estimate" : "Start Job"}
                      </Button>
                    )}
                    {/* Stale-time cleanup — when an admin previously flipped
                     *  status back without going through Reset Job, the
                     *  startedAt/completedAt fields can linger on a SCHEDULED
                     *  card. Surface Reset Job so the admin can clear it. */}
                    {forAdmin && (isAdmin || isSuper) && occ.status === "SCHEDULED" && (occ.startedAt || occ.completedAt) && (
                      <Button size="sm" variant="outline" colorPalette="red" disabled={busyOccId === occ.id} onClick={() => setResetJobOcc(occ)}>
                        Reset Job
                      </Button>
                    )}
                    {(isClaimer || forAdmin) && occ.status === "IN_PROGRESS" && (occ.workflow !== "ESTIMATE" && !occ.isEstimate) && (
                      <HStack gap={2} wrap="wrap">
                        <Button size="sm" variant="solid" colorPalette="blue" disabled={busyOccId === occ.id} onClick={() => setCompleteDialogOcc(occ)}>
                          Complete Job
                        </Button>
                        <Button size="sm" variant="outline" colorPalette="orange" loading={busyOccId === occ.id} onClick={() => void pauseJob(occ)}>
                          Pause
                        </Button>
                        {/* Admin-only "Reset Job" — clears time tracking
                         *  and reverts the occurrence to SCHEDULED so it
                         *  can be started over. Scheduled date is
                         *  preserved. */}
                        {forAdmin && (isAdmin || isSuper) && (
                          <Button size="sm" variant="outline" colorPalette="red" disabled={busyOccId === occ.id} onClick={() => setResetJobOcc(occ)}>
                            Reset Job
                          </Button>
                        )}
                      </HStack>
                    )}
                    {(isClaimer || forAdmin) && (occ.status as string) === "PAUSED" && (occ.workflow !== "ESTIMATE" && !occ.isEstimate) && (
                      <HStack gap={2} wrap="wrap">
                        <Button size="sm" variant="solid" colorPalette="orange" loading={busyOccId === occ.id} onClick={() => void resumeJob(occ)}>
                          Resume
                        </Button>
                        <Button size="sm" variant="solid" colorPalette="blue" disabled={busyOccId === occ.id} onClick={() => setCompleteDialogOcc(occ)}>
                          Complete Job
                        </Button>
                        {forAdmin && (isAdmin || isSuper) && (
                          <Button size="sm" variant="outline" colorPalette="red" disabled={busyOccId === occ.id} onClick={() => setResetJobOcc(occ)}>
                            Reset Job
                          </Button>
                        )}
                      </HStack>
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
                          amountLabel: "Proposal Amount ($) — optional",
                          amountPlaceholder: "0.00",
                          amountDefaultValue: occ.proposalAmount != null ? Number(occ.proposalAmount).toFixed(2) : "",
                          pricingReferenceTags: [...parseJobTags(occ), ...((occ.addons ?? []) as any[]).map((a: any) => a.tag).filter(Boolean)],
                          onConfirm: (comments: string, amount?: string) => void completeEstimate(occ.id, comments, amount),
                        })}
                      >
                        Complete Estimate
                      </Button>
                    )}
                    {(isClaimer || isActiveAssignee || forAdmin) && occ.status === "PENDING_PAYMENT" && occ.workflow !== "ESTIMATE" && !occ.isEstimate && (<>
                      {occ.workflow === "STANDARD" && !occ.isOneOff && !occ.frequencyDays && !(occ.job as any)?.frequencyDays && (
                        <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.200" borderRadius="md">
                          <Text fontSize="xs" color="yellow.800">
                            This is a repeating job but has no frequency set. Accepting payment will NOT create a next occurrence.
                          </Text>
                        </Box>
                      )}
                      {(() => {
                        // Show the most-recent of: rejection (admin rejected a
                        // self-reported payment) or revert (admin undid an
                        // already-approved payment). Either way the card user
                        // wants to know: previous attempt didn't stick.
                        const rejAt = occ.lastPaymentRejectedAt ? new Date(occ.lastPaymentRejectedAt).getTime() : 0;
                        const revAt = occ.lastPaymentRevertedAt ? new Date(occ.lastPaymentRevertedAt).getTime() : 0;
                        if (!rejAt && !revAt) return null;
                        const isRevert = revAt >= rejAt;
                        const label = isRevert ? "Last payment reverted" : "Last payment rejected";
                        const when = isRevert ? occ.lastPaymentRevertedAt : occ.lastPaymentRejectedAt;
                        const reason = isRevert ? occ.lastPaymentRevertReason : occ.lastPaymentRejectionReason;
                        return (
                          <Box p={2} bg="red.50" borderWidth="1px" borderColor="red.200" borderLeftWidth="4px" borderLeftColor="red.500" borderRadius="md">
                            <Text fontSize="xs" fontWeight="semibold" color="red.800">
                              {label}{when ? ` on ${fmtDate(when)}` : ""}
                            </Text>
                            {reason && (
                              <Text fontSize="xs" color="red.700">
                                Reason: {reason}
                              </Text>
                            )}
                          </Box>
                        );
                      })()}
                      {(() => {
                        // Three states for the PENDING_PAYMENT actions:
                        //   1. Awaiting approval — Payment row exists and
                        //      is unconfirmed. Both action buttons hidden;
                        //      a chip says "Awaiting admin approval".
                        //   2. Request in flight — no Payment row, but the
                        //      Request Payment path was committed (worker
                        //      tap or server auto-send). Show only the
                        //      PaymentCommsButtons component (Re-send +
                        //      Cancel) — Accept Payment hidden.
                        //   3. Open — no Payment row, no request sent yet.
                        //      Show both Request Payment and Accept Payment.
                        const pendingPayment = occ.payment && occ.payment.confirmed === false;
                        const requestInFlight = !pendingPayment && !!occ.paymentRequestSentAt;
                        const open = !pendingPayment && !requestInFlight;
                        if (pendingPayment) {
                          return (
                            <Box p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" borderLeftWidth="4px" borderLeftColor="blue.500" borderRadius="md">
                              <Text fontSize="xs" fontWeight="semibold" color="blue.800">
                                Awaiting admin approval
                              </Text>
                              <Text fontSize="xs" color="blue.700">
                                ${(occ.payment!.amountPaid ?? 0).toFixed(2)} via {occ.payment!.method}
                                {occ.payment!.collectedBy?.displayName ? ` — reported by ${occ.payment!.collectedBy.displayName}` : " — reported by client"}
                              </Text>
                            </Box>
                          );
                        }
                        // Open: single "Take Payment" button → unified
                        //   dialog with Request Payment and Accept
                        //   Payment Now actions in the footer.
                        // In flight: PaymentCommsButtons renders Re-send
                        //   + Cancel Request. Accept Payment Now is not
                        //   available until the request is canceled.
                        if (open) {
                          return (
                            <HStack gap={2} wrap="wrap">
                              <Button
                                size="sm"
                                variant="solid"
                                colorPalette="green"
                                disabled={isOffline}
                                onClick={() => { setAcceptPaymentOcc(occ); setAcceptPaymentOpen(true); }}
                              >
                                Initiate Payment
                              </Button>
                            </HStack>
                          );
                        }
                        return (
                          <HStack gap={2} wrap="wrap">
                            <PaymentCommsButtons
                              occurrenceId={occ.id}
                              requestSentAt={occ.paymentRequestSentAt}
                              onRequestCanceled={() => void load(false)}
                            />
                          </HStack>
                        );
                      })()}
                      {/* Admin-only "Reset Job" — covers the accidentally-
                       *  completed case. Only shown when there's no Payment
                       *  row yet (paid jobs go through Revert Payment). */}
                      {forAdmin && (isAdmin || isSuper) && !occ.payment && (
                        <Button size="sm" variant="outline" colorPalette="red" disabled={busyOccId === occ.id} onClick={() => setResetJobOcc(occ)}>
                          Reset Job
                        </Button>
                      )}
                    </>)}
                    {(isClaimer || isActiveAssignee || forAdmin) && occ.status === "PROPOSAL_SUBMITTED" && (occ.workflow === "ESTIMATE" || occ.isEstimate) && (
                      // w="full" forces this HStack onto its own row inside
                      // the wrap="wrap" parent — otherwise the Accept/Reject
                      // pair packs next to the "Stand-alone estimate" warning
                      // text on wide screens, which reads as cramped/unclear.
                      <HStack gap={2} w="full">
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
                                  const rawTags = result.occurrence?.jobTags;
                                  setPromptOccDefaults({
                                    notes: result.occurrence?.notes ?? null,
                                    price: result.occurrence?.price ?? null,
                                    estimatedMinutes: result.occurrence?.estimatedMinutes ?? null,
                                    jobTags: rawTags ? (Array.isArray(rawTags) ? rawTags : (() => { try { return JSON.parse(rawTags); } catch { return null; } })()) : null,
                                    jobType: result.occurrence?.jobType ?? null,
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
                        loading={busyOccId === occ.id}
                        onClick={async () => {
                          setBusyOccId(occ.id);
                          try {
                            await apiPost(`/api/tasks/${occ.id}/close`);
                            publishInlineMessage({ type: "SUCCESS", text: "Task completed." });
                            await load(false);
                          } catch (err) {
                            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to complete task.", err) });
                          }
                          setBusyOccId(null);
                        }}
                      >
                        Complete
                      </Button>
                    )}
                    {isUnassigned && !isAdminOnlyOcc && !isTaskOrReminder && (() => {
                      const isContractor = me?.workerType === "CONTRACTOR";
                      // ET calendar-day diff (DST-safe).
                      const daysAhead = occ.startAt ? bizDaysBetween(bizToday(), bizDateKey(occ.startAt)) : 0;
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
                          onClick={() => {
                            // If the worker is the claimer of any active group,
                            // open the chooser so they can pick "Just me" vs
                            // "For [Group]". Otherwise go straight to solo claim.
                            if (groupsAsClaimer.length > 0) {
                              setClaimChooserOccId(occ.id);
                            } else {
                              void claim(occ.id);
                            }
                          }}
                        >
                          Claim{groupsAsClaimer.length > 0 ? " ▾" : ""}
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
                          loading={busyOccId === occ.id}
                          onClick={async () => {
                            setBusyOccId(occ.id);
                            try {
                              await apiPost(`/api/admin/events/${occ.id}/complete`);
                              publishInlineMessage({ type: "SUCCESS", text: "Event completed." });
                              await load(false);
                            } catch (err) {
                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to complete event.", err) });
                            }
                            setBusyOccId(null);
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
                          loading={busyOccId === occ.id}
                          onClick={async () => {
                            setBusyOccId(occ.id);
                            try {
                              await apiPost(`/api/admin/followups/${occ.id}/complete`);
                              publishInlineMessage({ type: "SUCCESS", text: "Followup completed." });
                              await load(false);
                            } catch (err) {
                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to complete followup.", err) });
                            }
                            setBusyOccId(null);
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
                      {/* Reschedule — workers/claimer only when not tentative
                          (no point rescheduling a job whose client hasn't
                          confirmed); admin/super can reschedule regardless. */}
                      {(isClaimer || isActiveAssignee || forAdmin) && !isTaskOrReminder && occ.status === "SCHEDULED" && (!isTentative || (forAdmin && (isAdmin || isSuper))) && !isOffline && (
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
                      {/* Manage Team — two paths:
                          (1) Pre-start: claimer OR admin/super, before the
                              job has started. Original behavior.
                          (2) Post-completion in PENDING_PAYMENT: admin/super
                              only. Used to correct the as-built team when
                              a listed worker didn't actually work (e.g.
                              sick day). Backend blocks if any Payment row
                              already exists — operator must reject/revert
                              the payment first. Snapshot fields
                              (completionSplits, promisedPayouts) are auto-
                              cleared by setOccurrenceAssignees so the next
                              "Initiate Payment" regenerates them against
                              the corrected team. */}
                      {!isAnnouncement && (
                        ((isClaimer || (forAdmin && (isAdmin || isSuper))) && !occ.startedAt)
                        || (forAdmin && (isAdmin || isSuper) && occ.status === "PENDING_PAYMENT" && !occ.payment)
                      ) && (
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
                      {!isTaskOrReminder && (isClaimer || isActiveAssignee || (forAdmin && (isAdmin || isSuper))) && (
                        <StatusButton
                          id="occ-pinned-note"
                          itemId={occ.id}
                          label="Manage Instructions"
                          disabled={isOffline}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={async () => {
                            setPinnedNoteOcc(occ);
                            setPinnedNoteDialogOpen(true);
                          }}
                          variant="outline"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {/* Add / Manage expenses — claimer (any privilege) or
                          admin/super. Dialog itself gates Custom vs Inventory
                          toggles based on the resolved privileges from /me.
                          Only surfaces while the occurrence is in an active
                          state; admins do retroactive edits via Services. */}
                      {(() => {
                        const isActive = occInEditableState(occ);
                        const hasAnyPriv =
                          forAdmin ||
                          !!me?.privileges?.canPullInventory ||
                          !!me?.privileges?.canChargeBusinessExpenses;
                        // Admin/Super always pass — they can manage expenses on any job (e.g.
                        // adding a custom expense on behalf of a contractor who lacks the
                        // "Charge business expenses" privilege). Workers must be the claimer
                        // AND have at least one expense-related privilege.
                        // Followups are coordination items, not billable jobs — no expenses.
                        const canManage = isActive && !isFollowup && (forAdmin || isAdmin || isSuper || (isClaimer && hasAnyPriv));
                        if (!canManage) return null;
                        const hasExpenses = (occ.expenses?.length ?? 0) > 0;
                        return (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => { e.stopPropagation(); setExpenseDialogOccId(occ.id); }}
                          >
                            {hasExpenses ? "Manage Expenses" : "Add Expense"}
                          </Button>
                        );
                      })()}
                      {/* Add Service (add-on) — claimer / admin / super, only
                          on real jobs that are active. Tasks, reminders, and
                          events don't carry add-ons. Mirrors the gating used
                          on Add Expense so workers see both side-by-side. */}
                      {(() => {
                        const isActive = occInEditableState(occ);
                        const canAdd =
                          isActive
                          && !isTaskOrReminder
                          && (forAdmin || isAdmin || isSuper || isClaimer);
                        if (!canAdd) return null;
                        return (
                          <Button
                            size="sm"
                            variant="outline"
                            colorPalette="teal"
                            onClick={(e) => { e.stopPropagation(); setAddAddonOcc(occ); }}
                          >
                            Add Service
                          </Button>
                        );
                      })()}
                      {isClaimer && !isTaskOrReminder && occ.status === "SCHEDULED" && (
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
                      {(isWorkerView || forAdmin) && !occ.reminder && (
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
                      {(isWorkerView || forAdmin) && occ.reminder && (
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
                      {(isClaimer || forAdmin || isAdmin || isSuper) && occ.startedAt && !isTaskOrReminder && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={(e: any) => { e.stopPropagation(); setEditTimeOcc(occ); }}
                        >
                          <Clock size={12} /> Edit Time
                        </Button>
                      )}
                    </HStack>
                    </HStack>
                  </Card.Footer>
                )}

                {/* Secondary footer: task/reminder reopen + reminder buttons when the regular footer doesn't show */}
                {(isWorkerView || forAdmin || ((isAdmin || isSuper) && isTaskOrReminder)) && !isCardCompact && !isPeek && !(
                  !isTrainee && (isUnassigned || isActiveAssignee || (forAdmin && (isAdmin || isSuper))) && !isTentative &&
                  (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS" || (occ.status as string) === "PAUSED" || occ.status === "PENDING_PAYMENT" || occ.status === "CLOSED" || occ.status === "PROPOSAL_SUBMITTED")
                ) && (
                  <Card.Footer py="2" px="3" pt="0">
                    <HStack gap={2} wrap="wrap">
                      {/* Task reopen */}
                      {isTask && occ.status === "CLOSED" && (
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="blue"
                          disabled={isOffline}
                          loading={busyOccId === occ.id}
                          title={isOffline ? "Requires internet" : undefined}
                          onClick={async () => {
                            setBusyOccId(occ.id);
                            try {
                              await apiPost(`/api/tasks/${occ.id}/reopen`);
                              publishInlineMessage({ type: "SUCCESS", text: "Task reopened." });
                              await load(false);
                            } catch (err) {
                              publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to reopen task.", err) });
                            }
                            setBusyOccId(null);
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
                {/* Guidance + Instructions — collapsed: inline wrapping row, expanded: full-width banner.
                    On the semi card we render the full OccurrenceInstructions
                    component (defaultExpanded={false}) so the Guidance pill is
                    clickable and reveals the photos + description inline —
                    same flow as the fully-expanded card, just starts collapsed. */}
                {isCardCompact ? (
                  ((occ.propertyPhotos ?? []).length > 0 || ((occ as any).instructions ?? []).length > 0) && (
                    <VStack mx="3" mb="2" mt="0" align="stretch" gap="1">
                      {(occ.propertyPhotos ?? []).length > 0 && (
                        <Box>
                          <OccurrenceInstructions
                            occurrenceId={occ.id}
                            count={(occ.propertyPhotos ?? []).length}
                            guidanceNote={(occ as any).guidanceNote ?? null}
                            defaultExpanded={false}
                          />
                        </Box>
                      )}
                      {((occ as any).instructions ?? []).length > 0 && (
                        <Box px="3" py="1.5" bg="yellow.100" borderWidth="1px" borderColor="yellow.400" borderRadius="md">
                          <VStack align="stretch" gap="0.5">
                            {((occ as any).instructions as { id: string; text: string; repeats: boolean }[]).map((inst) => (
                              <HStack key={inst.id} gap="1.5" align="center">
                                <AlertCircle
                                  size={18}
                                  color="var(--chakra-colors-yellow-900)"
                                  fill="var(--chakra-colors-yellow-400)"
                                  strokeWidth={2.5}
                                />
                                <Text fontSize="xs" fontWeight="semibold" color="yellow.700" flex="1">
                                  {inst.text}
                                </Text>
                                {inst.repeats && (
                                  <Box display="inline-flex" alignItems="center" title="Carries forward">
                                    <Repeat size={12} color="var(--chakra-colors-yellow-700)" />
                                  </Box>
                                )}
                              </HStack>
                            ))}
                          </VStack>
                        </Box>
                      )}
                    </VStack>
                  )
                ) : (
                  <>
                    {((occ.propertyPhotos ?? []).length > 0 || (occ as any).guidanceNote) && (
                      <Box mx="3" mb="2" mt="0">
                        <OccurrenceInstructions
                          occurrenceId={occ.id}
                          count={(occ.propertyPhotos ?? []).length}
                          guidanceNote={(occ as any).guidanceNote ?? null}
                        />
                      </Box>
                    )}
                    {((occ as any).instructions ?? []).length > 0 && (
                      <Box mx="3" mb="2" mt="0" px="3" py="1.5" bg="yellow.100" borderWidth="1px" borderColor="yellow.400" borderRadius="md">
                        <VStack align="stretch" gap="0.5">
                          {((occ as any).instructions as { id: string; text: string; repeats: boolean }[]).map((inst) => (
                            <HStack key={inst.id} gap="1.5" align="center">
                              <AlertCircle
                                size={18}
                                color="var(--chakra-colors-yellow-900)"
                                fill="var(--chakra-colors-yellow-400)"
                                strokeWidth={2.5}
                              />
                              <Text fontSize="xs" fontWeight="semibold" color="yellow.700" flex="1">
                                {inst.text}
                              </Text>
                              {inst.repeats && (
                                <Box display="inline-flex" alignItems="center" title="Carries forward">
                                  <Repeat size={12} color="var(--chakra-colors-yellow-700)" />
                                </Box>
                              )}
                            </HStack>
                          ))}
                        </VStack>
                      </Box>
                    )}
                  </>
                )}
                </>
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
            // CRITICAL: assignedById is the ONLY signal the dialog
            // uses to identify the claimer (an assignee with
            // assignedById === userId = self-claimed). Without it,
            // TeamMemberList's getClaimerUserId falls back to
            // "first non-observer wins," which can mislabel the
            // claimer when the assignees array order doesn't match
            // claim order.
            assignedById: (a as any).assignedById,
            role: a.role,
            user: a.user,
          }))}
          assignedGroup={(manageOccurrence as any).assignedGroup ?? null}
          onChanged={() => void load(false)}
          isAdmin={forAdmin && (isAdmin || isSuper)}
          isClaimer={!!(me?.id && (manageOccurrence.assignees ?? []).some((a: any) => a.userId === me.id && a.assignedById === me.id && a.role !== "observer"))}
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
          currentInstructions={(pinnedNoteOcc as any).instructions ?? []}
          isRepeating={pinnedNoteOcc.workflow === "STANDARD" || (!pinnedNoteOcc.workflow && !pinnedNoteOcc.isOneOff && !pinnedNoteOcc.isEstimate)}
          onSaved={(instructions) => {
            setItems((prev) => prev.map((o) => o.id === pinnedNoteOcc.id ? { ...o, instructions } as any : o));
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

      {/* Admin "Reset Job" confirmation — wipes time tracking and
       *  reverts to SCHEDULED. Per project policy, every destructive
       *  mutation goes through a ConfirmDialog. */}
      <ConfirmDialog
        open={!!resetJobOcc}
        title="Reset this job?"
        message=""
        warning="This clears the start/complete times and any tracked work time, then puts the job back to Scheduled so it can be started over. The scheduled date isn't changed. If a payment was recorded, it will also be removed."
        confirmLabel="Reset job"
        confirmColorPalette="red"
        onConfirm={() => { const occ = resetJobOcc!; setResetJobOcc(null); void resetJob(occ); }}
        onCancel={() => setResetJobOcc(null)}
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

      <EstimateDialog
        open={lightEstDialogOpen}
        onOpenChange={(open) => { setLightEstDialogOpen(open); if (!open) setEditingLightEstimate(null); }}
        onCreated={() => void load(false)}
        myId={me?.id}
        editEstimate={editingLightEstimate}
        jobTagsConfig={serviceTypes}
      />
      {/* Review hours for payroll. Stays mounted while the edit-time
          dialog is open (Chakra's portal handles z-index stacking) so we
          don't have to worry about onCancel firing on unmount — when
          edit-time saves and closes, this dialog is already in place and
          re-renders against the freshly-updated `items` row. */}
      {reviewHoursOccId && (() => {
        const occ = items.find((o) => o.id === reviewHoursOccId);
        if (!occ) return null;
        const approved = !!(occ as any).hoursApprovedAt;
        const workerCount = Math.max(1, (occ.assignees ?? []).filter((a: any) => a.role !== "observer").length);
        const adjEst = occ.estimatedMinutes && workerCount > 1
          ? Math.round(occ.estimatedMinutes / workerCount)
          : occ.estimatedMinutes;
        const actual = effectiveMinutes(occ);
        const fmt = (m: number | null | undefined) => {
          if (m == null) return "—";
          const h = Math.floor(m / 60);
          const mm = Math.round(m % 60);
          return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
        };
        const variance = (actual != null && adjEst)
          ? Math.round(Math.abs(actual - adjEst) / adjEst * 100)
          : null;
        const isOver = (actual != null && adjEst != null) ? actual > adjEst : false;
        const property = occ.job?.property?.displayName ?? "(no property)";
        const messageNode = (
          <VStack align="stretch" gap={3}>
            <Text fontSize="sm" color="fg.muted">{property}</Text>
            {approved ? (
              <Box p={3} bg="green.50" borderWidth="2px" borderColor="green.400" rounded="md">
                <Text fontSize="sm" fontWeight="semibold" color="green.800" mb={1}>
                  ✓ Hours within variance — auto-approved
                </Text>
                {actual != null && adjEst != null && (
                  <Text fontSize="xs" color="green.700">
                    Actual: {fmt(actual)} · Estimate: {fmt(adjEst)}{workerCount > 1 ? ` (per worker · ${workerCount} workers)` : ""}
                    {variance != null ? ` · ${variance}% ${isOver ? "over" : "under"}` : ""}
                  </Text>
                )}
              </Box>
            ) : variance != null && actual != null && adjEst != null ? (
              <Box p={3} bg="orange.50" borderWidth="2px" borderColor="orange.400" rounded="md">
                <Text fontSize="sm" fontWeight="semibold" color="orange.800" mb={1}>
                  ⚠ Time discrepancy: {variance}% {isOver ? "over" : "under"} estimate
                </Text>
                <Text fontSize="xs" color="orange.700">
                  Actual: {fmt(actual)} · Estimate: {fmt(adjEst)}{workerCount > 1 ? ` (per worker · ${workerCount} workers)` : ""}
                </Text>
              </Box>
            ) : (
              <Box p={3} bg="gray.50" borderWidth="1px" borderColor="gray.300" rounded="md">
                <Text fontSize="xs" color="fg.muted">
                  No estimate baseline — hours require explicit review before payroll.
                </Text>
                {actual != null && (
                  <Text fontSize="sm" fontWeight="semibold" color="fg.default" mt={1}>
                    Actual: {fmt(actual)}{workerCount > 1 ? ` (${workerCount} workers)` : ""}
                  </Text>
                )}
              </Box>
            )}
            <Text fontSize="xs" color="fg.muted">
              {approved
                ? "These hours will be included in the next W-2 payroll export."
                : "Approved hours will go to the next W-2 payroll export. If they look wrong, edit time first — the row auto-approves when the corrected time falls within the variance threshold."}
            </Text>
          </VStack>
        );
        return (
          <ConfirmDialog
            open={true}
            title="Review hours for payroll"
            message=""
            messageNode={messageNode}
            confirmLabel={approved ? "Done" : "Approve Time"}
            confirmColorPalette={approved ? "green" : "orange"}
            cancelLabel={approved ? "Close" : "Edit Time"}
            onConfirm={() => {
              if (approved) {
                setReviewHoursOccId(null);
                return;
              }
              // Fire-and-await: don't close until the server confirms and
              // the items array is patched with the new hoursApprovedAt.
              // approveHoursAction re-throws on failure, in which case the
              // dialog stays open so the user can retry.
              void (async () => {
                try {
                  await approveHoursAction(occ);
                  setReviewHoursOccId(null);
                } catch {
                  // Toast already raised inside approveHoursAction.
                }
              })();
            }}
            onCancel={() => setReviewHoursOccId(null)}
            onCancelAction={approved ? undefined : () => { setEditTimeOcc(occ); }}
            secondaryActionFirst={!approved}
            keepOpenOnCancelAction
          />
        );
      })()}
      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.title ?? ""}
        message={confirmAction?.message ?? ""}
        messageNode={confirmAction?.messageNode}
        confirmLabel={confirmAction?.confirmLabel}
        confirmColorPalette={confirmAction?.colorPalette}
        inputPlaceholder={confirmAction?.inputPlaceholder}
        inputLabel={confirmAction?.inputLabel}
        inputOptional={confirmAction?.inputOptional}
        inputDefaultValue={confirmAction?.inputDefaultValue}
        amountLabel={confirmAction?.amountLabel}
        amountPlaceholder={confirmAction?.amountPlaceholder}
        amountDefaultValue={confirmAction?.amountDefaultValue}
        pricingReferenceTags={confirmAction?.pricingReferenceTags}
        pricingEndpoint={forAdmin ? "/api/admin/pricing" : "/api/pricing"}
        cancelLabel={confirmAction?.cancelLabel}
        onCancelAction={confirmAction?.onCancelAction}
        warning={confirmAction?.warning}
        secondaryActionFirst={confirmAction?.secondaryActionFirst}
        viewAsName={confirmAction?.viewAsName !== undefined ? confirmAction.viewAsName : effectiveViewAsName}
        onConfirm={(inputValue: string, amountValue?: string) => {
          if (confirmAction?.inputPlaceholder || confirmAction?.amountLabel) {
            (confirmAction!.onConfirm as (v: string, a?: string) => void)(inputValue, amountValue);
          } else {
            (confirmAction?.onConfirm as () => void)();
          }
          setConfirmAction(null);
        }}
        onCancel={() => setConfirmAction(null)}
      />

      {/* Set / Reschedule Reminder Dialog. The title flips based on
       *  whether the occurrence already has a reminder — same dialog
       *  body handles both create and update via the upsert endpoint. */}
      <Dialog.Root open={!!reminderDialogOccId} onOpenChange={(e) => { if (!e.open) setReminderDialogOccId(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm">
              <Dialog.Header>
                <Dialog.Title>
                  {(() => {
                    const target = reminderDialogOccId ? items.find((o) => o.id === reminderDialogOccId) : null;
                    return target?.reminder ? "Reschedule Reminder" : "Set Reminder";
                  })()}
                </Dialog.Title>
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
                        variant={reminderDate === bizAddDays(bizToday(), opt.days) ? "solid" : "outline"}
                        colorPalette="orange"
                        onClick={() => {
                          setReminderDate(bizAddDays(bizToday(), opt.days));
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
                  {(() => {
                    const target = reminderDialogOccId ? items.find((o) => o.id === reminderDialogOccId) : null;
                    return target?.reminder ? "Save Reminder" : "Set Reminder";
                  })()}
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
                <Dialog.Title>{startJobOcc?.workflow === "ESTIMATE" || startJobOcc?.isEstimate ? "Start Estimate" : "Start Job"}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <ImpersonationWarning viewAsName={effectiveViewAsName} />
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
                      setBusyOccId(startJobOcc.id);
                      setStartJobOcc(null);
                      try {
                        // ET-anchored parse — see bizParseLocalInputValue.
                        const startedAt = bizParseLocalInputValue(startJobTime);
                        const occDate = startJobOcc.startAt ? bizDateKey(startJobOcc.startAt) : "";
                        const todayDate = bizDateKey(new Date());
                        // Strictly future-dated only. Past-dated (catch-up
                        // starts where the work was actually done before
                        // today) must NOT rewrite startAt — that would
                        // erase the scheduled date and break per-day
                        // filtering, earnings bucketing, and next-occurrence
                        // cadence anchoring.
                        const isEarly = occDate && occDate > todayDate;
                        const body: Record<string, unknown> = { startedAt };
                        if (isEarly) body.updateStartAt = true;
                        try {
                          const loc = await getLocation();
                          if (loc) { body.lat = loc.lat; body.lng = loc.lng; }
                        } catch {}
                        await apiPost(`/api/occurrences/${startJobOcc.id}/start`, body);
                        publishInlineMessage({ type: "SUCCESS", text: "Job started with location recorded." });
                        bumpTitleBarEarnings();
                        await load(false);
                      } catch (err) {
                        if (!handleTeamWorkdayError(err)) {
                          publishInlineMessage({ type: "ERROR", text: getErrorMessage("Start failed.", err) });
                        }
                      }
                      setBusyOccId(null);
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
                      setBusyOccId(startJobOcc.id);
                      setStartJobOcc(null);
                      try {
                        // ET-anchored parse — see bizParseLocalInputValue.
                        const startedAt = bizParseLocalInputValue(startJobTime);
                        const occDate = startJobOcc.startAt ? bizDateKey(startJobOcc.startAt) : "";
                        const todayDate = bizDateKey(new Date());
                        // Strictly future-dated only. Past-dated (catch-up
                        // starts where the work was actually done before
                        // today) must NOT rewrite startAt — that would
                        // erase the scheduled date and break per-day
                        // filtering, earnings bucketing, and next-occurrence
                        // cadence anchoring.
                        const isEarly = occDate && occDate > todayDate;
                        const body: Record<string, unknown> = { startedAt };
                        if (isEarly) body.updateStartAt = true;
                        await apiPost(`/api/occurrences/${startJobOcc.id}/start`, body);
                        publishInlineMessage({ type: "SUCCESS", text: "Job started." });
                        bumpTitleBarEarnings();
                        await load(false);
                      } catch (err) {
                        if (!handleTeamWorkdayError(err)) {
                          publishInlineMessage({ type: "ERROR", text: getErrorMessage("Start failed.", err) });
                        }
                      }
                      setBusyOccId(null);
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
                <ImpersonationWarning viewAsName={effectiveViewAsName} />
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
                        const val = bizAddDays(bizToday(), opt.days);
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
                <ImpersonationWarning viewAsName={effectiveViewAsName} />
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
                        onClick={async () => {
                          const cc = await fetchCommsCc();
                          window.open(buildSmsHref({ to: rescheduleNotify!.phone!, body: rescheduleNotify!.message, ccPhones: cc.phones }), "_self");
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
                        onClick={async () => {
                          const cc = await fetchCommsCc();
                          window.open(buildMailtoHref({ to: rescheduleNotify!.email!, subject: "Schedule Change — Seedlings Lawn Care", body: rescheduleNotify!.message, ccEmails: cc.emails }), "_self");
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

      {/* Claim chooser — appears when the worker is the claimer of one or
          more groups. Picks "Just me" vs "For [Group]" before invoking claim. */}
      <Dialog.Root open={!!claimChooserOccId} onOpenChange={(e) => { if (!e.open) setClaimChooserOccId(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Claim this job</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <ImpersonationWarning viewAsName={effectiveViewAsName} />
                <VStack align="stretch" gap={2}>
                  <Text fontSize="sm" color="fg.muted">
                    You can claim solo, or claim for a group you lead — the whole crew gets added at once.
                  </Text>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const id = claimChooserOccId;
                      setClaimChooserOccId(null);
                      if (id) void claim(id);
                    }}
                  >
                    Just me
                  </Button>
                  {groupsAsClaimer.map((g) => (
                    <Button
                      key={g.id}
                      size="sm"
                      variant="solid"
                      colorPalette="blue"
                      onClick={() => {
                        const id = claimChooserOccId;
                        setClaimChooserOccId(null);
                        if (id) void claim(id, g.id);
                      }}
                    >
                      Claim for {g.name} ({g.members.length + 1})
                    </Button>
                  ))}
                </VStack>
              </Dialog.Body>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <ManageExpensesDialog
        open={!!expenseDialogOccId}
        onOpenChange={(o) => { if (!o) { setExpenseDialogOccId(null); void load(false); } }}
        occurrenceId={expenseDialogOccId ?? ""}
        isAdmin={forAdmin}
        disableInventory={(() => {
          // Tasks, reminders, events, followups, announcements: no inventory.
          const occ = items.find((o) => o.id === expenseDialogOccId);
          const wf = (occ as any)?.workflow;
          return wf === "TASK" || wf === "REMINDER" || wf === "EVENT" || wf === "FOLLOWUP" || wf === "ANNOUNCEMENT";
        })()}
        privileges={
          forAdmin
            ? { canPullInventory: true, canChargeBusinessExpenses: true }
            : (me?.privileges ?? { canPullInventory: false, canChargeBusinessExpenses: false })
        }
        viewAsName={effectiveViewAsName}
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
          occurrenceId={acceptPaymentOcc.id}
          defaultAmount={totalPrice(acceptPaymentOcc)}
          basePrice={acceptPaymentOcc.price ?? null}
          addonsTotal={addonTotal(acceptPaymentOcc)}
          totalExpenses={(acceptPaymentOcc.expenses ?? []).reduce((s, e) => s + e.cost, 0)}
          commissionPercent={commissionPercent}
          marginPercent={marginPercent}
          isSuper={isSuper}
          allowAllMethods={forAdmin}
          viewAsName={effectiveViewAsName}
          assignees={(acceptPaymentOcc.assignees ?? []).filter((a) => a.role !== "observer").map((a) => ({
            userId: a.userId,
            displayName: a.user?.displayName ?? a.user?.email,
            workerType: a.user?.workerType,
            isClaimer: a.assignedById === a.userId,
          }))}
          completionSplits={(acceptPaymentOcc as any).completionSplits ?? null}
          onAccepted={async (result: any) => {
            if (acceptPaymentOcc) setBusyOccId(acceptPaymentOcc.id);
            await load(false);
            setBusyOccId(null);
            // Both Accept Now (creates a Payment row) and Request Payment
            // (persists completionSplits + promisedPayouts) can change the
            // signed-in worker's earnings — refresh the title bar.
            bumpTitleBarEarnings();
            void result;
            setAcceptPaymentOcc(null);
          }}
        />
      )}
      {/* InsuranceUploadDialog was removed with the compliance-policy
          migration. The reactive sign wizard (Slice 3) mounts here. */}
      {/* Pricing guide popup — opened from the "View pricing guide" chip
          in the add-on dialog. Picks back into addonPrice when the user
          taps a row. Pre-filters by the selected service type (if any),
          since that's almost always what the worker is shopping for —
          they can clear the search to see everything. */}
      <PricingGuideDialog
        open={pricingGuideOpen}
        onOpenChange={setPricingGuideOpen}
        endpoint={forAdmin ? "/api/admin/pricing" : "/api/pricing"}
        initialSearch={addonTag ? jobTagLabel(addonTag) : ""}
        onPick={(amount) => setAddonPrice(String(amount))}
      />

      <ClaimAgreementDialog
        open={agreementDialogOpen}
        onOpenChange={setAgreementDialogOpen}
        me={me}
        occurrence={pendingClaimOccId ? items.find((o) => o.id === pendingClaimOccId) ?? null : null}
        commissionPercent={commissionPercent}
        marginPercent={marginPercent}
        group={(() => {
          // Active workers = claimer (always a worker) + non-observer
          // members. Observers don't share in the payout.
          if (!pendingClaimGroupId) return null;
          const g = groupsAsClaimer.find((x) => x.id === pendingClaimGroupId);
          if (!g) return null;
          const workerMembers = g.members.filter((m) => m.role !== "observer").length;
          return {
            id: g.id,
            name: g.name,
            activeWorkerCount: 1 + workerMembers,
          };
        })()}
        onAgreed={async () => {
          if (pendingClaimOccId) {
            const occId = pendingClaimOccId;
            const groupId = pendingClaimGroupId;
            setPendingClaimOccId(null);
            setPendingClaimGroupId(null);
            await claim(occId, groupId);
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
          estimatedMinutes={completeDialogOcc.estimatedMinutes}
          totalPausedMs={completeDialogOcc.totalPausedMs}
          pausedAt={completeDialogOcc.pausedAt}
          existingCompletedAt={completeDialogOcc.completedAt}
          workerCount={(completeDialogOcc.assignees ?? []).filter((a) => a.role !== "observer").length}
          assignees={completeDialogOcc.assignees}
          workflow={completeDialogOcc.workflow}
          pointOfContact={completeDialogOcc.job?.property?.pointOfContact ?? null}
          viewAsName={effectiveViewAsName}
          onCompleted={(completedAt, startedAt, totalPausedMs, completionSplits) => {
            setCompleteDialogOcc(null);
            const occToComplete = completeDialogOcc;
            void (async () => {
              setBusyOccId(occToComplete.id);
              try {
                const body: Record<string, unknown> = {};
                if (completedAt) body.completedAt = completedAt;
                if (startedAt) body.startedAt = startedAt;
                if (totalPausedMs != null) body.totalPausedMs = totalPausedMs;
                if (completionSplits && completionSplits.length > 0) body.completionSplits = completionSplits;
                await apiPost(`/api/occurrences/${occToComplete.id}/complete`, body);
                publishInlineMessage({ type: "SUCCESS", text: "Job completed." });
                bumpTitleBarEarnings();
                await load(false);
                // Prompt for photos after completion
                setPhotoPromptOccId(occToComplete.id);
              } catch (err) {
                publishInlineMessage({ type: "ERROR", text: getErrorMessage("Complete failed.", err) });
              }
              setBusyOccId(null);
            })();
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
                  <Button colorPalette="blue" onClick={() => { setPhotoPromptOccId(null); void load(false); }}>
                    Done
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Add Service Dialog */}
      <Dialog.Root open={!!addAddonOcc} onOpenChange={(e) => { if (!e.open) { setAddAddonOcc(null); setAddonTag(""); setAddonCustomLabel(""); setAddonPrice(""); } }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Add Service</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <ImpersonationWarning viewAsName={effectiveViewAsName} />
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>Service type</Text>
                    <Box display="flex" gap="4px" flexWrap="wrap">
                      {serviceTypes.map((t) => (
                        <Badge
                          key={t.key}
                          size="sm"
                          colorPalette={addonTag === t.key ? "teal" : "gray"}
                          variant={addonTag === t.key ? "solid" : "outline"}
                          cursor="pointer"
                          px="2"
                          borderRadius="full"
                          onClick={() => { setAddonTag(addonTag === t.key ? "" : t.key); setAddonCustomLabel(""); }}
                        >
                          {t.label}
                        </Badge>
                      ))}
                    </Box>
                  </Box>
                  {!addonTag && (
                    <Box>
                      <Text fontSize="xs" fontWeight="medium" mb={1}>Or custom service</Text>
                      <input
                        type="text"
                        value={addonCustomLabel}
                        onChange={(e) => setAddonCustomLabel(e.target.value)}
                        placeholder="e.g., Remove fallen branch"
                        style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "14px" }}
                      />
                    </Box>
                  )}
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>Price *</Text>
                    <CurrencyInput
                      value={addonPrice}
                      onChange={setAddonPrice}
                      size="sm"
                    />
                    <HStack gap={2} mt={1.5} wrap="wrap">
                      {addonHintEntry?.parsedValue && (
                        <Badge
                          size="sm"
                          colorPalette="gray"
                          variant="subtle"
                          borderRadius="full"
                          px="2"
                          cursor="pointer"
                          title="Tap to use as the price"
                          onClick={() => setAddonPrice(String(addonHintEntry.parsedValue!.amount))}
                        >
                          Ref: ${addonHintEntry.parsedValue.amount.toFixed(2)} / {addonHintEntry.parsedValue.unit} · {addonHintEntry.parsedValue.label}
                        </Badge>
                      )}
                      <Badge
                        size="sm"
                        colorPalette="blue"
                        variant="outline"
                        borderRadius="full"
                        px="2"
                        cursor="pointer"
                        onClick={() => setPricingGuideOpen(true)}
                      >
                        View pricing guide ↗
                      </Badge>
                    </HStack>
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setAddAddonOcc(null)}>Cancel</Button>
                  <Button
                    colorPalette="teal"
                    loading={addonBusy}
                    disabled={!addonPrice || Number(addonPrice) <= 0 || (!addonTag && !addonCustomLabel.trim())}
                    onClick={async () => {
                      if (!addAddonOcc) return;
                      setAddonBusy(true);
                      try {
                        const created = await apiPost<{ id: string; tag?: string; customLabel?: string; price: number }>(
                          `/api/${forAdmin ? "admin/" : ""}occurrences/${addAddonOcc.id}/addons`,
                          {
                            tag: addonTag || undefined,
                            customLabel: addonCustomLabel.trim() || undefined,
                            price: Number(addonPrice),
                          },
                        );
                        setItems((prev) => prev.map((o) => o.id === addAddonOcc.id ? { ...o, addons: [...(o.addons ?? []), created] } : o));
                        publishInlineMessage({ type: "SUCCESS", text: "Service added." });
                        setAddAddonOcc(null);
                        setAddonTag("");
                        setAddonCustomLabel("");
                        setAddonPrice("");
                      } catch (err) {
                        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to add service.", err) });
                      }
                      setAddonBusy(false);
                    }}
                  >
                    Add
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Edit Time Dialog */}
      <Dialog.Root open={!!editTimeOcc} onOpenChange={(e) => { if (!e.open) setEditTimeOcc(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Edit Work Time</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <ImpersonationWarning viewAsName={effectiveViewAsName} />
                {editTimeOcc && (() => {
                  const startMs = editTimeForm.startedAt ? new Date(editTimeForm.startedAt).getTime() : NaN;
                  const endMs = editTimeForm.completedAt ? new Date(editTimeForm.completedAt).getTime() : NaN;
                  const offH = parseInt(editTimeForm.offHours || "0", 10) || 0;
                  const offM = parseInt(editTimeForm.offMinutes || "0", 10) || 0;
                  const offMinTotal = Math.max(0, offH * 60 + offM);
                  const offMs = offMinTotal * 60000;
                  const spanMs = !isNaN(startMs) && !isNaN(endMs) ? endMs - startMs : null;
                  const endBeforeStart = spanMs != null && spanMs < 0;
                  const offTooLarge = spanMs != null && spanMs >= 0 && offMs > spanMs;
                  const durationMin = spanMs != null && spanMs >= 0 ? Math.max(0, Math.round((spanMs - offMs) / 60000)) : null;
                  return (
                    <VStack align="stretch" gap={3}>
                      <Box>
                        <Text fontSize="sm" fontWeight="medium" mb={1}>Start time</Text>
                        <input
                          type="datetime-local"
                          value={editTimeForm.startedAt}
                          onChange={(e) => setEditTimeForm((p) => ({ ...p, startedAt: e.target.value }))}
                          style={{ width: "100%", padding: "6px 10px", fontSize: "16px", border: "1px solid #ccc", borderRadius: "6px" }}
                        />
                      </Box>
                      <Box>
                        <Text fontSize="sm" fontWeight="medium" mb={1}>End time</Text>
                        <input
                          type="datetime-local"
                          value={editTimeForm.completedAt}
                          onChange={(e) => setEditTimeForm((p) => ({ ...p, completedAt: e.target.value }))}
                          style={{ width: "100%", padding: "6px 10px", fontSize: "16px", border: "1px solid #ccc", borderRadius: "6px" }}
                        />
                      </Box>
                      <Box>
                        <Text fontSize="sm" fontWeight="medium" mb={1}>Off-the-clock (Paused) time</Text>
                        <HStack gap={2}>
                          <Box flex="1">
                            <Text fontSize="xs" color="fg.muted" mb={1}>Hours</Text>
                            <input
                              type="number"
                              min={0}
                              value={editTimeForm.offHours}
                              onChange={(e) => setEditTimeForm((p) => ({ ...p, offHours: e.target.value }))}
                              style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "14px" }}
                            />
                          </Box>
                          <Box flex="1">
                            <Text fontSize="xs" color="fg.muted" mb={1}>Minutes</Text>
                            <input
                              type="number"
                              min={0}
                              max={59}
                              value={editTimeForm.offMinutes}
                              onChange={(e) => setEditTimeForm((p) => ({ ...p, offMinutes: e.target.value }))}
                              style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "14px" }}
                            />
                          </Box>
                        </HStack>
                      </Box>
                      {endBeforeStart && (
                        <Text fontSize="xs" color="red.500">End time cannot be before start time.</Text>
                      )}
                      {offTooLarge && (
                        <Text fontSize="xs" color="red.500">Off-the-clock time exceeds the span between start and end.</Text>
                      )}
                      {durationMin != null && !endBeforeStart && !offTooLarge && (
                        <Text fontSize="sm" color="fg.muted">Working time: <Text as="span" fontWeight="semibold" color="fg.default">{formatDuration(durationMin)}</Text></Text>
                      )}
                    </VStack>
                  );
                })()}
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full" gap={2}>
                  <Button variant="ghost" onClick={() => setEditTimeOcc(null)}>Cancel</Button>
                  <Button
                    colorPalette="blue"
                    disabled={(() => {
                      if (!editTimeForm.startedAt || !editTimeForm.completedAt) return true;
                      const s = new Date(editTimeForm.startedAt).getTime();
                      const e = new Date(editTimeForm.completedAt).getTime();
                      if (isNaN(s) || isNaN(e) || e < s) return true;
                      const offH = parseInt(editTimeForm.offHours || "0", 10) || 0;
                      const offM = parseInt(editTimeForm.offMinutes || "0", 10) || 0;
                      const offMs = (offH * 60 + offM) * 60000;
                      if (offMs > (e - s)) return true;
                      return false;
                    })()}
                    onClick={async () => {
                      // ET-anchored parse of datetime-local strings —
                      // see bizParseLocalInputValue in lib/lib.ts.
                      const startedAtIso = editTimeForm.startedAt ? bizParseLocalInputValue(editTimeForm.startedAt) : null;
                      const completedAtIso = editTimeForm.completedAt ? bizParseLocalInputValue(editTimeForm.completedAt) : null;
                      const offH = parseInt(editTimeForm.offHours || "0", 10) || 0;
                      const offM = parseInt(editTimeForm.offMinutes || "0", 10) || 0;
                      const totalPausedMs = (offH * 60 + offM) * 60000;
                      try {
                        // Capture the server response so we can pull through
                        // hoursApprovedAt — the /time route re-evaluates the
                        // variance approval, and the Review dialog reads
                        // this field to decide between "Done" and "Approve".
                        const updated = await apiPatch<any>(`/api/occurrences/${editTimeOcc!.id}/time`, {
                          startedAt: startedAtIso,
                          completedAt: completedAtIso,
                          totalPausedMs,
                        });
                        setItems((prev) => prev.map((o) => o.id === editTimeOcc!.id ? {
                          ...o,
                          startedAt: startedAtIso ?? undefined,
                          completedAt: completedAtIso ?? undefined,
                          totalPausedMs,
                          hoursApprovedAt: updated?.hoursApprovedAt ?? null,
                          hoursApprovedById: updated?.hoursApprovedById ?? null,
                        } as any : o));
                        publishInlineMessage({ type: "SUCCESS", text: "Time updated." });
                      } catch (err) { publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed.", err) }); }
                      setEditTimeOcc(null);
                    }}
                  >
                    Save
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

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="orange.300">
                    <Badge colorPalette="orange" variant="solid" mb={1}>Unconfirmed</Badge>
                    <Text fontSize="sm">The client has not yet confirmed the appointment. Workers can still claim and start the job, but the card shows an orange "Unconfirmed" badge as a heads-up. The claimer or an admin can mark it confirmed, which removes the badge. Newly auto-created occurrences start unconfirmed by default.</Text>
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
                    size="sm"
                    onClick={() => setShowInfoDialog(false)}
                  >
                    Close
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
          defaultJobTags={promptOccDefaults.jobTags}
          defaultJobType={promptOccDefaults.jobType}
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
      {/* Workday gate dialog — rendered last so it overlays anything else
          that happens to be open. The hook's `withWorkday` opens it when
          a worker tries to start/resume a job without an active workday. */}
      {workdayGate.dialog}
      {teamWorkdayDialog.dialog}
    </Box>
  );
}
