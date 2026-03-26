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
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { AlertTriangle, CalendarRange, Filter, LayoutList, List, Maximize2, RefreshCw, Tag, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiGet, apiPost, apiDelete } from "@/src/lib/api";
import { getLocation } from "@/src/lib/geo";
import { determineRoles, occurrenceStatusColor, prettyStatus, clientLabel } from "@/src/lib/lib";
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
import ScheduleNextDialog from "@/src/ui/dialogs/ScheduleNextDialog";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import AcceptPaymentDialog from "@/src/ui/dialogs/AcceptPaymentDialog";
import AddExpenseDialog from "@/src/ui/dialogs/AddExpenseDialog";
import { MapLink, TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch } from "@/src/lib/bus";
import { type DatePreset, computeDatesFromPreset, PRESET_LABELS } from "@/src/lib/datePresets";
import OccurrencePhotos from "@/src/ui/components/OccurrencePhotos";
import ContractorAgreementDialog from "@/src/ui/dialogs/ContractorAgreementDialog";
import InsuranceUploadDialog from "@/src/ui/dialogs/InsuranceUploadDialog";

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

const statusStates = ["ALL", "UNCLAIMED", ...JOB_OCCURRENCE_STATUS.filter((s) => s !== "ARCHIVED")] as const;

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

const kindStates = ["ALL", ...JOB_KIND] as const;

type JobsTabProps = TabPropsType & {
  /** When set, filter occurrences to only those assigned to these users */
  viewAsUserIds?: string[];
  /** Extra UI rendered above the filter bar (e.g. worker selector) */
  headerSlot?: React.ReactNode;
};

export default function JobsTab({ me, purpose = "WORKER", viewAsUserIds, headerSlot }: JobsTabProps) {
  const { isAvail, forAdmin } = determineRoles(me, purpose);
  const myId = viewAsUserIds?.length === 1 ? viewAsUserIds[0] : me?.id || "";
  const pfx = purpose === "ADMIN" ? "ajobs" : "wjobs";

  const [q, setQ] = useState("");
  const [compact, setCompact] = usePersistedState(`${pfx}_compact`, false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [kind, setKind] = usePersistedState<string[]>(`${pfx}_kind`, ["ALL"]);

  const kindItems = useMemo(
    () => kindStates.map((s) => ({ label: prettyStatus(s), value: s })),
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
    ],
    []
  );
  const typeCollection = useMemo(
    () => createListCollection({ items: typeItems }),
    [typeItems]
  );

  const [statusFilter, setStatusFilter] = usePersistedState<string[]>(`${pfx}_status`, ["ALL"]);
  const statusItems = useMemo(
    () => statusStates.map((s) => ({ label: s === "UNCLAIMED" ? "Unclaimed" : prettyStatus(s), value: s })),
    []
  );
  const statusCollection = useMemo(
    () => createListCollection({ items: statusItems }),
    [statusItems]
  );
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");
  const [overdueCount, setOverdueCount] = useState(0);

  const [datePreset, setDatePreset] = usePersistedState<DatePreset>(`${pfx}_datePreset`, "nextMonth");
  const presetDates = useMemo(() => computeDatesFromPreset(datePreset), [datePreset]);
  const [dateFrom, setDateFrom] = useState(presetDates.from);
  const [dateTo, setDateTo] = useState(presetDates.to);
  const [quickDate, setQuickDate] = useState<string[]>([]);
  const [overdueActive, setOverdueActive] = usePersistedState(`${pfx}_overdue`, false);
  const presetBeforeOverdueRef = useRef<DatePreset>(datePreset);

  // Re-apply preset dates when preset changes (e.g., on mount or when user selects a preset)
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

  const [manageOpen, setManageOpen] = useState(false);
  const [agreementDialogOpen, setAgreementDialogOpen] = useState(false);
  const [pendingClaimOccId, setPendingClaimOccId] = useState<string | null>(null);
  const [insuranceDialogOpen, setInsuranceDialogOpen] = useState(false);
  const isTrainee = me?.workerType === "TRAINEE";
  const [manageOccurrence, setManageOccurrence] = useState<WorkerOccurrence | null>(null);

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
  const [acceptPaymentOcc, setAcceptPaymentOcc] = useState<WorkerOccurrence | null>(null);

  const [scheduleNextOpen, setScheduleNextOpen] = useState(false);
  const [scheduleNextData, setScheduleNextData] = useState<{
    jobId: string;
    frequencyDays: number;
    closedOccurrence: { startAt?: string | null; endAt?: string | null; notes?: string | null; price?: number | null; estimatedMinutes?: number | null; assignees?: { userId: string; displayName?: string | null }[] };
  } | null>(null);

  const [expenseDialogOccId, setExpenseDialogOccId] = useState<string | null>(null);

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

  async function load(displayLoading = true) {
    setLoading(displayLoading);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      const url = `/api/occurrences${qs.toString() ? `?${qs}` : ""}`;
      let list = await apiGet<WorkerOccurrence[]>(url);
      if (!Array.isArray(list)) list = [];
      if (viewAsUserIds?.length) {
        // Admin "View as" — show only selected workers' jobs + unassigned
        const idSet = new Set(viewAsUserIds);
        list = list.filter((occ) => {
          const assignees = occ.assignees ?? [];
          return assignees.length === 0 || assignees.some((a) => idSet.has(a.userId));
        });
      } else if (!forAdmin && myId) {
        // Worker view — show only my jobs + unassigned (claimable)
        list = list.filter((occ) => {
          const assignees = occ.assignees ?? [];
          return assignees.length === 0 || assignees.some((a) => a.userId === myId);
        });
      }
      setItems(list);
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
  }, [dateFrom, dateTo, viewAsUserIds]);

  async function refreshOverdueCount() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const list = await apiGet<WorkerOccurrence[]>(
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

  async function claim(occurrenceId: string) {
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/claim`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Job claimed." });
      await load(false);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes("CONTRACTOR_AGREEMENT_REQUIRED") || msg.includes("contractor agreement")) {
        setPendingClaimOccId(occurrenceId);
        setAgreementDialogOpen(true);
      } else if (msg.includes("INSURANCE_REQUIRED") || msg.includes("valid insurance")) {
        publishInlineMessage({
          type: "ERROR",
          text: "This is a high-value job that requires valid insurance. Upload your insurance certificate to claim it.",
        });
        setInsuranceDialogOpen(true);
      } else if (msg.includes("WORKER_TYPE_REQUIRED") || msg.includes("worker type")) {
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

  async function submitProposal(occurrenceId: string, amount: string) {
    try {
      const proposalAmount = parseFloat(amount);
      if (isNaN(proposalAmount) || proposalAmount <= 0) {
        publishInlineMessage({ type: "WARNING", text: "Please enter a valid proposal amount." });
        return;
      }
      await apiPost(`/api/occurrences/${occurrenceId}/submit-proposal`, { proposalAmount });
      publishInlineMessage({ type: "SUCCESS", text: "Proposal submitted." });
      await load(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Submit proposal failed.", err) });
    }
  }

  async function updateStatus(occ: WorkerOccurrence, action: "start" | "complete", notes?: string) {
    try {
      const loc = await getLocation();
      const body: Record<string, unknown> = {};
      if (notes) body.notes = notes;
      if (loc) { body.lat = loc.lat; body.lng = loc.lng; }
      await apiPost(`/api/occurrences/${occ.id}/${action}`, body);
      await load(false);

      // For estimates, "complete" goes straight to CLOSED — prompt schedule next
      if (action === "complete" && occ.isEstimate && occ.job?.frequencyDays && !occ.isOneOff) {
        publishInlineMessage({ type: "SUCCESS", text: "Estimate completed." });
        setScheduleNextData({
          jobId: occ.job.id,
          frequencyDays: occ.job.frequencyDays,
          closedOccurrence: {
            startAt: occ.startAt,
            endAt: occ.endAt,
            notes: occ.notes,
            price: occ.price,
            estimatedMinutes: occ.estimatedMinutes,
            assignees: (occ.assignees ?? []).map((a) => ({ userId: a.userId, displayName: a.user?.displayName })),
          },
        });
        setScheduleNextOpen(true);
      } else {
        publishInlineMessage({
          type: "SUCCESS",
          text: action === "start" ? "Job started." : "Job marked as pending payment.",
        });
      }
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Action failed.", err),
      });
    }
  }

  const filtered = useMemo(() => {
    let rows = items;
    if (kind[0] !== "ALL") rows = rows.filter((occ) => occ.kind === kind[0]);
    const tf = typeFilter[0];
    if (tf === "ONE_OFF") rows = rows.filter((occ) => occ.isOneOff);
    else if (tf === "ESTIMATE") rows = rows.filter((occ) => occ.isEstimate);
    else if (tf === "TENTATIVE") rows = rows.filter((occ) => occ.isTentative);
    const sf = statusFilter[0];
    if (sf !== "ALL") {
      rows = rows.filter((occ) => {
        const hasAssignees = (occ.assignees ?? []).length > 0;
        if (sf === "UNCLAIMED") return !hasAssignees;
        return occ.status === sf;
      });
    }
    if (overdueActive) {
      rows = rows.filter((occ) => occ.status !== "CLOSED" && occ.status !== "ARCHIVED");
    }
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((occ) =>
        [
          occ.job?.property?.displayName,
          occ.job?.property?.street1,
          occ.job?.property?.city,
          occ.job?.property?.state,
          occ.job?.property?.client?.displayName,
          occ.status,
          occ.notes,
          ...(occ.assignees ?? []).map((a) => a.user?.displayName ?? a.user?.email),
        ]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(qlc))
      );
    }
    rows.sort((a, b) => {
      const da = a.startAt ?? "";
      const db = b.startAt ?? "";
      return da < db ? -1 : da > db ? 1 : 0;
    });
    return rows;
  }, [items, q, kind, statusFilter, typeFilter, overdueActive]);

  const dayGroups = useMemo(() => {
    const groups: { key: string; label: string; items: WorkerOccurrence[] }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // day labels are relative to today

    const dayLabel = (dateStr: string) => {
      const d = new Date(dateStr + "T00:00:00");
      const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
      if (diff === 0) return "Today";
      if (diff === -1) return "Yesterday";
      if (diff === 1) return "Tomorrow";
      const dayName = d.toLocaleDateString(undefined, { weekday: "long" });
      if (diff >= 2 && diff <= 6) return dayName;
      if (diff <= -2 && diff >= -6) return `Last ${dayName}`;
      return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
    };

    let current: (typeof groups)[number] | null = null;
    for (const occ of filtered) {
      const dateKey = occ.startAt?.slice(0, 10) ?? "no-date";
      if (!current || current.key !== dateKey) {
        current = {
          key: dateKey,
          label: dateKey === "no-date" ? "Unscheduled" : dayLabel(dateKey),
          items: [],
        };
        groups.push(current);
      }
      current.items.push(occ);
    }
    return groups;
  }, [filtered]);

  if (!isAvail) return <UnavailableNotice />;

  return (
    <Box w="full">
      {headerSlot}
      <HStack mb={3} gap={2}>
        <SearchWithClear
          value={q}
          onChange={setQ}
          inputId="jobs-search"
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
          collection={statusCollection}
          value={statusFilter}
          onValueChange={(e) => setStatusFilter(e.value)}
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
          disabled={kind[0] === "ALL" && statusFilter[0] === "ALL" && typeFilter[0] === "ALL" && !overdueActive}
          onClick={() => {
            setKind(["ALL"]);
            setStatusFilter(["ALL"]);
            setTypeFilter(["ALL"]);
            setOverdueActive(false);
            setDatePreset("nextMonth");
          }}
        >
          <X size={14} />
        </Button>
        <Button
          size="sm"
          variant={compact ? "solid" : "ghost"}
          px="2"
          onClick={() => { setCompact((v) => !v); setExpandedCards(new Set()); }}
          css={compact ? {
            background: "var(--chakra-colors-gray-200)",
            color: "var(--chakra-colors-gray-700)",
          } : undefined}
        >
          {compact ? <Maximize2 size={14} /> : <List size={14} />}
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

      {(kind[0] !== "ALL" || statusFilter[0] !== "ALL" || typeFilter[0] !== "ALL" || overdueActive || datePreset) && (
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
          {statusFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="purple" variant="solid">
              {statusItems.find((i) => i.value === statusFilter[0])?.label}
            </Badge>
          )}
          {typeFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="orange" variant="solid">
              {typeItems.find((i) => i.value === typeFilter[0])?.label}
            </Badge>
          )}
        </HStack>
      )}

      {loading && items.length === 0 && <LoadingCenter />}

      <Box position="relative">
        {loading && items.length > 0 && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
        <VStack align="stretch" gap={3}>
          {dayGroups.length === 0 && (
            <Box p="8" color="fg.muted">
              No job occurrences match current filters.
            </Box>
          )}

          {dayGroups.map((group) => (
            <Box key={group.key}>
              <HStack gap={2} align="center" my={1}>
                <Box flex="1" borderBottomWidth="1px" borderColor="border.muted" />
                <Text fontSize="xs" fontWeight="semibold" color="fg.muted" whiteSpace="nowrap">
                  {group.label}
                </Text>
                <Box flex="1" borderBottomWidth="1px" borderColor="border.muted" />
              </HStack>
              <VStack align="stretch" gap={3}>
          {group.items.map((occ) => {
            const assignees = occ.assignees ?? [];
            const isAssignedToMe = !!myId && assignees.some((a) => a.userId === myId);
            const isUnassigned = assignees.length === 0;
            const isAssignedToOthers = !isUnassigned && !isAssignedToMe;

            const myAssignee = assignees.find((a) => a.userId === myId);
            const isClaimer = !!myAssignee && myAssignee.assignedById === myId;

            const isTentative = !!occ.isTentative;

            const cardBorderColor = isTentative
              ? "orange.300"
              : isAssignedToMe ? "teal.400" : "gray.200";
            const cardBg = isTentative
              ? "orange.50"
              : isAssignedToMe
              ? "teal.50"
              : isAssignedToOthers
              ? "gray.50"
              : undefined;

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
                bg={cardBg}
                css={compact ? { cursor: "pointer", "& a, & button": { pointerEvents: "auto" } } : undefined}
                onClick={(e: any) => {
                  if (!toggleCard) return;
                  const el = e.target as HTMLElement;
                  if (el?.closest?.("a, button")) return;
                  toggleCard();
                }}
              >
                <Card.Header py="3" px="4" pb="0">
                  <HStack gap={3} justify="space-between" align="center">
                    <VStack align="start" gap={0} flex="1" minW={0}>
                      <Text fontSize={isCardCompact ? "sm" : "md"} fontWeight="semibold">
                        {occ.job?.property?.client?.displayName && (
                          <>{clientLabel(occ.job.property.client.displayName)} — </>
                        )}
                        {occ.job?.property?.displayName}
                      </Text>
                      {!isCardCompact && (
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
                      {!isCardCompact && (
                        <HStack gap={3} fontSize="xs">
                          {occ.job?.property?.displayName && (
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
                          {occ.job?.property?.client?.displayName && (
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
                      )}
                    </VStack>
                    {isCardCompact ? (
                      <HStack gap={1} flexShrink={0}>
                        <StatusBadge
                          status={occ.status}
                          palette={occurrenceStatusColor(occ.status)}
                          variant="solid"
                        />
                        {isTentative && <StatusBadge status="Tentative" palette="orange" variant="solid" />}
                        {(occ.workflow === "ESTIMATE" || occ.isEstimate) && <StatusBadge status="Estimate" palette="purple" variant="solid" />}
                        {(occ.workflow === "ONE_OFF" || occ.isOneOff) && <StatusBadge status="One-off" palette="gray" variant="solid" />}
                        {(occ.price ?? 0) >= 200 && <span title="Only employees or insured contractors can claim this job"><StatusBadge status="Insured Only" palette="red" variant="outline" /></span>}
                      </HStack>
                    ) : (
                      <Box display="flex" gap={1} flexShrink={0} flexDirection={{ base: "column", md: "row" }} alignItems="flex-end">
                        <StatusBadge
                          status={occ.status}
                          palette={occurrenceStatusColor(occ.status)}
                          variant="solid"
                        />
                        {isTentative && (
                          <StatusBadge
                            status="Tentative"
                            palette="orange"
                            variant="solid"
                          />
                        )}
                        {(occ.workflow === "ESTIMATE" || occ.isEstimate) && (
                          <StatusBadge
                            status="Estimate"
                            palette="purple"
                            variant="solid"
                          />
                        )}
                        {(occ.workflow === "ONE_OFF" || occ.isOneOff) && (
                          <StatusBadge
                            status="One-off"
                            palette="gray"
                            variant="solid"
                          />
                        )}
                        {(occ.price ?? 0) >= 200 && (
                          <span title="Only employees or insured contractors can claim this job">
                            <StatusBadge
                              status="Insured Only"
                              palette="red"
                              variant="outline"
                            />
                          </span>
                        )}
                      </Box>
                    )}
                  </HStack>
                </Card.Header>

                {isCardCompact ? (
                  <Card.Body py="3" px="4" pt="0">
                    <HStack gap={2} fontSize="xs">
                      {occ.price != null && (
                        <Text fontWeight="medium">${occ.price.toFixed(2)}</Text>
                      )}
                      {(() => {
                        const actual = actualMinutes(occ);
                        if (actual != null && occ.estimatedMinutes) {
                          const color = actual <= occ.estimatedMinutes ? "green.600" : "red.600";
                          return <Text color={color} fontWeight="medium">{formatDuration(actual)}</Text>;
                        }
                        if (occ.estimatedMinutes != null) return <Text color="fg.muted">{formatDuration(occ.estimatedMinutes)}</Text>;
                        return null;
                      })()}
                      {!isUnassigned && (
                        <Text color="fg.muted">
                          {assignees.map((a) => a.user?.displayName ?? a.user?.email ?? a.userId).join(", ")}
                        </Text>
                      )}
                      {isUnassigned && occ.status !== "ARCHIVED" && (
                        <Text color="orange.500" fontWeight="medium">
                          {isTentative ? "Tentative" : "Unclaimed"}
                        </Text>
                      )}
                    </HStack>
                  </Card.Body>
                ) : (
                <Card.Body pt="0">
                  <VStack align="start" gap={1}>
                    {occ.startAt && (
                      <Text fontSize="xs">
                        {new Date(occ.startAt).toLocaleDateString()}
                        {occ.endAt && new Date(occ.endAt).toLocaleDateString() !== new Date(occ.startAt).toLocaleDateString()
                          ? ` – ${new Date(occ.endAt).toLocaleDateString()}`
                          : ""}
                      </Text>
                    )}
                    {occ.price != null && (
                      <Text fontSize="xs" fontWeight="medium">
                        ${occ.price.toFixed(2)}
                      </Text>
                    )}
                    {(occ.estimatedMinutes != null || (occ.startedAt && occ.completedAt)) && (
                      <HStack fontSize="xs" gap={2}>
                        {occ.estimatedMinutes != null && (
                          <Text color="fg.muted">Est: {formatDuration(occ.estimatedMinutes)}</Text>
                        )}
                        {(() => {
                          const actual = actualMinutes(occ);
                          if (actual == null) return null;
                          const color = occ.estimatedMinutes
                            ? actual <= occ.estimatedMinutes ? "green.600" : "red.600"
                            : "fg.muted";
                          return <Text color={color} fontWeight="medium">Actual: {formatDuration(actual)}</Text>;
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
                    {occ.proposalAmount != null && (
                      <Box p={2} bg="purple.50" rounded="sm" mt={1}>
                        <Text fontSize="xs" fontWeight="medium" color="purple.700">
                          Proposal: ${occ.proposalAmount.toFixed(2)}
                        </Text>
                        {occ.proposalNotes && (
                          <Text fontSize="xs" color="purple.600">{occ.proposalNotes}</Text>
                        )}
                      </Box>
                    )}
                    {occ.rejectionReason && (
                      <Box p={2} bg="red.50" rounded="sm" mt={1}>
                        <Text fontSize="xs" color="red.700">
                          Rejected: {occ.rejectionReason}
                        </Text>
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
                              {a.user?.displayName ?? a.user?.email ?? a.userId}
                              {a.user?.workerType ? ` · ${a.user.workerType === "CONTRACTOR" ? "1099" : a.user.workerType === "TRAINEE" ? "Trainee" : "W-2"}` : ""}
                              {isMe ? " (you)" : ""}
                              {isClaimer ? " · Claimer" : ""}
                            </Text>
                          );
                        })}
                      </VStack>
                    )}
                    {isUnassigned && occ.status !== "ARCHIVED" && (
                      <Text fontSize="xs" color="orange.500" fontWeight="medium">
                        {isTentative
                          ? "Tentative — awaiting admin confirmation"
                          : "Unclaimed — available to pick up"}
                      </Text>
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
                      </Box>
                    )}

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
                    {((occ._count?.photos ?? 0) > 0 || isAssignedToMe) && (
                      <OccurrencePhotos
                        occurrenceId={occ.id}
                        isAdmin={forAdmin}
                        canUpload={isAssignedToMe}
                        photoCount={occ._count?.photos ?? 0}
                      />
                    )}
                  </VStack>
                </Card.Body>
                )}

                {!isCardCompact && !isTrainee && (isUnassigned || isAssignedToMe) && !isTentative && (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS" || occ.status === "PENDING_PAYMENT") && (
                  <Card.Footer py="3" px="4" pt="0">
                    <HStack gap={2} wrap="wrap" mb="2">
                      {isUnassigned && (
                        <StatusButton
                          id="occ-claim"
                          itemId={occ.id}
                          label="Claim"
                          onClick={async () => setConfirmAction({
                            title: "Claim Job?",
                            message: "Are you sure you want to claim this job?",
                            confirmLabel: "Claim",
                            colorPalette: "green",
                            onConfirm: () => void claim(occ.id),
                          })}
                          variant="outline"
                          colorPalette="green"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "SCHEDULED" && (
                        <StatusButton
                          id="occ-start"
                          itemId={occ.id}
                          label="Start"
                          onClick={async () => setConfirmAction({
                            title: "Start Job?",
                            message: "Are you sure you want to start this job?",
                            confirmLabel: "Start",
                            colorPalette: "blue",
                            onConfirm: () => void updateStatus(occ, "start"),
                          })}
                          variant="outline"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "IN_PROGRESS" && (occ.workflow !== "ESTIMATE" && !occ.isEstimate) && (
                        <StatusButton
                          id="occ-complete"
                          itemId={occ.id}
                          label="Complete"
                          onClick={async () => setConfirmAction({
                            title: "Complete Job?",
                            message: "Are you sure you want to mark this job as complete?",
                            confirmLabel: "Complete",
                            colorPalette: "green",
                            onConfirm: () => void updateStatus(occ, "complete"),
                          })}
                          variant="outline"
                          colorPalette="green"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "IN_PROGRESS" && (occ.workflow === "ESTIMATE" || occ.isEstimate) && (
                        <StatusButton
                          id="occ-submit-proposal"
                          itemId={occ.id}
                          label="Submit Proposal"
                          onClick={async () => setConfirmAction({
                            title: "Submit Proposal?",
                            message: "Submit this estimate as a proposal. An admin will review and accept or reject it.",
                            confirmLabel: "Submit",
                            colorPalette: "purple",
                            inputLabel: "Proposal amount ($)",
                            inputPlaceholder: "Enter proposed price",
                            onConfirm: (amount: string) => void submitProposal(occ.id, amount),
                          })}
                          variant="outline"
                          colorPalette="purple"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "PENDING_PAYMENT" && occ.workflow !== "ESTIMATE" && !occ.isEstimate && (
                        <StatusButton
                          id="occ-accept-payment"
                          itemId={occ.id}
                          label="Accept Payment"
                          onClick={async () => {
                            setAcceptPaymentOcc(occ);
                            setAcceptPaymentOpen(true);
                          }}
                          variant="outline"
                          colorPalette="green"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isClaimer && occ.status !== "PENDING_PAYMENT" && (
                        <StatusButton
                          id="occ-manage-team"
                          itemId={occ.id}
                          label="Manage Team"
                          onClick={async () => {
                            setManageOccurrence(occ);
                            setManageOpen(true);
                          }}
                          variant="outline"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isClaimer && (
                        <StatusButton
                          id="occ-add-expense"
                          itemId={occ.id}
                          label="Add Expense"
                          onClick={async () => setExpenseDialogOccId(occ.id)}
                          variant="outline"
                          colorPalette="orange"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isClaimer && occ.status !== "PENDING_PAYMENT" && (
                        <StatusButton
                          id="occ-unclaim"
                          itemId={occ.id}
                          label="Unclaim"
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
                    </HStack>
                  </Card.Footer>
                )}
              </Card.Root>
            );
          })}
              </VStack>
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
          myId={myId}
          currentAssignees={(manageOccurrence.assignees ?? []).map((a) => ({
            userId: a.userId,
            user: a.user,
          }))}
          onChanged={() => void load(false)}
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
          createEndpoint="/api/occurrences/create-next"
          createBody={{ jobId: scheduleNextData.jobId }}
          onCreated={(nextStartDate) => {
            if (nextStartDate && dateTo && nextStartDate > dateTo) {
              setDateTo(nextStartDate);
            } else {
              void load(false);
            }
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

      <AddExpenseDialog
        open={!!expenseDialogOccId}
        onOpenChange={(o) => { if (!o) setExpenseDialogOccId(null); }}
        endpoint={`/api/occurrences/${expenseDialogOccId}/expenses`}
        onAdded={() => {
          setExpenseDialogOccId(null);
          void load(false);
        }}
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
          assignees={(acceptPaymentOcc.assignees ?? []).map((a) => ({
            userId: a.userId,
            displayName: a.user?.displayName ?? a.user?.email,
          }))}
          onAccepted={() => {
            const occ = acceptPaymentOcc;
            void load(false);
            // Prompt to schedule next if job has frequency and not one-off
            if (occ?.job?.frequencyDays && !occ.isOneOff) {
              setScheduleNextData({
                jobId: occ.job.id,
                frequencyDays: occ.job.frequencyDays,
                closedOccurrence: {
                  startAt: occ.startAt,
                  endAt: occ.endAt,
                  notes: occ.notes,
                  price: occ.price,
                  estimatedMinutes: occ.estimatedMinutes,
                  assignees: (occ.assignees ?? []).map((a) => ({ userId: a.userId, displayName: a.user?.displayName })),
                },
              });
              setScheduleNextOpen(true);
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
      <ContractorAgreementDialog
        open={agreementDialogOpen}
        onOpenChange={setAgreementDialogOpen}
        onAgreed={async () => {
          if (pendingClaimOccId) {
            await claim(pendingClaimOccId);
            setPendingClaimOccId(null);
          }
        }}
      />
    </Box>
  );
}
