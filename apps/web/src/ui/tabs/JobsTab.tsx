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
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { AlertTriangle, CalendarRange, Filter, Info, LayoutList, List, Maximize2, RefreshCw, Tag, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiGet, apiPost, apiDelete } from "@/src/lib/api";
import { getLocation } from "@/src/lib/geo";
import { determineRoles, occurrenceStatusColor, prettyStatus, clientLabel, fmtDate, fmtDateTime, fmtDateWeekday, bizDateKey } from "@/src/lib/lib";
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
import AcceptPaymentDialog from "@/src/ui/dialogs/AcceptPaymentDialog";
import ManageExpensesDialog from "@/src/ui/dialogs/ManageExpensesDialog";
import { MapLink, TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch } from "@/src/lib/bus";
import { type DatePreset, computeDatesFromPreset, PRESET_LABELS } from "@/src/lib/datePresets";
import OccurrencePhotos from "@/src/ui/components/OccurrencePhotos";
import ClaimAgreementDialog from "@/src/ui/dialogs/ClaimAgreementDialog";
import InsuranceUploadDialog from "@/src/ui/dialogs/InsuranceUploadDialog";
import CompleteJobDialog from "@/src/ui/dialogs/CompleteJobDialog";

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
  /** Simulated worker type when admin is impersonating (for UI behavior like hiding tentative) */
  viewAsWorkerType?: string | null;
  /** Extra UI rendered above the filter bar (e.g. worker selector) */
  headerSlot?: React.ReactNode;
};

export default function JobsTab({ me, purpose = "WORKER", viewAsUserIds, viewAsWorkerType, headerSlot }: JobsTabProps) {
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
  const [showInfoDialog, setShowInfoDialog] = useState(() => {
    try {
      return !localStorage.getItem("seedlings_jobs_infoDismissed");
    } catch { return false; }
  });
  const [overdueCount, setOverdueCount] = useState(0);
  const [highValueThreshold, setHighValueThreshold] = useState(200);
  const [commissionPercent, setCommissionPercent] = useState(0);
  const [marginPercent, setMarginPercent] = useState(0);

  const [datePreset, setDatePreset] = usePersistedState<DatePreset>(`${pfx}_datePreset`, "nextMonth");
  const presetDates = useMemo(() => computeDatesFromPreset(datePreset), [datePreset]);
  const [dateFrom, setDateFrom] = useState(presetDates.from);
  const [dateTo, setDateTo] = useState(presetDates.to);
  const [quickDate, setQuickDate] = useState<string[]>([]);
  const [overdueActive, setOverdueActive] = usePersistedState(`${pfx}_overdue`, false);
  const presetBeforeOverdueRef = useRef<DatePreset>(datePreset);

  // Re-apply preset dates when preset changes (e.g., on mount or when user selects a preset)
  useEffect(() => {
    if (overdueActive) {
      // When overdue is persisted, apply the overdue date range
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
  } | null>(null);

  const [acceptPaymentOpen, setAcceptPaymentOpen] = useState(false);
  const [acceptPaymentOcc, setAcceptPaymentOcc] = useState<WorkerOccurrence | null>(null);

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
        // Admin "View as" — show only selected workers' jobs
        const idSet = new Set(viewAsUserIds);
        list = list.filter((occ) => {
          const assignees = occ.assignees ?? [];
          // If impersonating a trainee, hide unassigned jobs
          if (isTrainee) return assignees.some((a) => idSet.has(a.userId));
          return assignees.length === 0 || assignees.some((a) => idSet.has(a.userId));
        });
      } else if (!forAdmin && myId) {
        if (isTrainee) {
          // Trainees only see jobs they are assigned to (no unassigned/claimable)
          list = list.filter((occ) => {
            const assignees = occ.assignees ?? [];
            return assignees.some((a) => a.userId === myId);
          });
        } else {
          // Worker view — show only my jobs + unassigned (claimable)
          list = list.filter((occ) => {
            const assignees = occ.assignees ?? [];
            return assignees.length === 0 || assignees.some((a) => a.userId === myId);
          });
        }
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

      const count = list.filter((o) => {
        const s = o.status as string;
        return s !== "CLOSED" && s !== "ARCHIVED" && s !== "CANCELED" && s !== "REJECTED" && s !== "ACCEPTED";
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

  async function updateStatus(occ: WorkerOccurrence, action: "start" | "complete", notes?: string) {
    try {
      const loc = await getLocation();
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
    // Trainees should not see tentative jobs
    if (isTrainee) rows = rows.filter((occ) => !occ.isTentative);
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
      rows = rows.filter((occ) => occ.status !== "CLOSED" && occ.status !== "ARCHIVED" && occ.status !== "ACCEPTED" && occ.status !== "REJECTED");
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
  }, [items, q, kind, statusFilter, typeFilter, overdueActive, isTrainee]);

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

    let current: (typeof groups)[number] | null = null;
    for (const occ of filtered) {
      const dateKey = occ.startAt ? bizDateKey(occ.startAt) : "no-date";
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
          onClick={() => setShowInfoDialog(true)}
          px="2"
          title="How jobs work"
        >
          <Info size={14} />
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
              <HStack gap={3} align="center" my={2}>
                <Box flex="1" borderBottomWidth="2px" borderColor="gray.300" />
                <Text fontSize="sm" fontWeight="bold" color="gray.600" whiteSpace="nowrap" textTransform="uppercase" letterSpacing="wide">
                  {group.label}
                </Text>
                <Box flex="1" borderBottomWidth="2px" borderColor="gray.300" />
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

            const isEstimateOcc = occ.workflow === "ESTIMATE" || occ.isEstimate;
            const isAcceptedEstimate = isEstimateOcc && occ.status === "ACCEPTED";
            const isClosed = occ.status === "CLOSED" || occ.status === "ARCHIVED";
            const isAdminOnlyOcc = !!occ.isAdminOnly;

            const cardBorderColor = (isClosed || isAcceptedEstimate)
              ? "gray.200"
              : isTentative
              ? "orange.300"
              : isEstimateOcc
              ? "purple.300"
              : isAssignedToMe ? "teal.400" : "gray.200";
            const cardBg = (isClosed || isAcceptedEstimate)
              ? undefined
              : isTentative
              ? "orange.50"
              : isEstimateOcc
              ? "purple.50"
              : isAssignedToMe
              ? "teal.50"
              : isAssignedToOthers
              ? "gray.100"
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
                {forAdmin && !isCardCompact && (
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
                <Card.Header py="3" px="4" pb="0">
                  <HStack gap={3} justify="space-between" align="center">
                    <VStack align="start" gap={0} flex="1" minW={0}>
                      <Text fontSize={isCardCompact ? "sm" : "md"} fontWeight="semibold">
                        {occ.job?.property?.displayName}
                        {occ.job?.property?.client?.displayName && (
                          <> — {clientLabel(occ.job.property.client.displayName)}</>
                        )}
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
                        {isTentative ? (
                          <StatusBadge status="Tentative" palette="orange" variant="solid" />
                        ) : occ.status !== "SCHEDULED" ? (
                          <StatusBadge
                            status={occ.status}
                            palette={occurrenceStatusColor(occ.status)}
                            variant="solid"
                          />
                        ) : null}
                        {(occ.workflow === "STANDARD" || (!occ.workflow && !occ.isEstimate && !occ.isOneOff)) && <StatusBadge status="Repeating" palette="blue" variant="outline" />}
                        {(occ.workflow === "ESTIMATE" || occ.isEstimate) && <StatusBadge status="Estimate" palette="purple" variant="solid" />}
                        {(occ.workflow === "ONE_OFF" || occ.isOneOff) && <StatusBadge status="One-off" palette="gray" variant="solid" />}
                        {isAdminOnlyOcc && <StatusBadge status="Administered" palette="red" variant="outline" />}
                        {(occ.price ?? 0) >= highValueThreshold && <span title="Only employees or insured contractors can claim this job" style={{ display: "flex" }}><StatusBadge status="Insured Only" palette="yellow" variant="solid" /></span>}
                      </HStack>
                    ) : (
                      <Box display="flex" gap={1} flexShrink={0} flexDirection={{ base: "column", md: "row" }} alignItems="flex-end">
                        {isTentative ? (
                          <StatusBadge
                            status="Tentative"
                            palette="orange"
                            variant="solid"
                          />
                        ) : occ.status !== "SCHEDULED" ? (
                          <StatusBadge
                            status={occ.status}
                            palette={occurrenceStatusColor(occ.status)}
                            variant="solid"
                          />
                        ) : null}
                        {(occ.workflow === "STANDARD" || (!occ.workflow && !occ.isEstimate && !occ.isOneOff)) && (
                          <StatusBadge
                            status="Repeating"
                            palette="blue"
                            variant="outline"
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
                        {isAdminOnlyOcc && (
                          <StatusBadge status="Administered" palette="red" variant="outline" />
                        )}
                        {(occ.price ?? 0) >= highValueThreshold && (
                          <span title="Only employees or insured contractors can claim this job" style={{ display: "flex" }}>
                            <StatusBadge
                              status="Insured Only"
                              palette="yellow"
                              variant="solid"
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
                        <Badge colorPalette="green" variant="solid" fontSize="xs" px="2" py="0.5" borderRadius="full">
                          ${occ.price.toFixed(2)}
                        </Badge>
                      )}
                      {occ.payment && (
                        <Badge colorPalette="teal" variant="solid" fontSize="xs" px="2" py="0.5" borderRadius="full">
                          Paid: ${(occ.payment as any).amountPaid.toFixed(2)}
                        </Badge>
                      )}
                      {occ.price != null && !occ.payment && (() => {
                        const expTotal = (occ.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                        const net = occ.price! - expTotal;
                        const isEmp = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE";
                        const isCon = me?.workerType === "CONTRACTOR" || !me?.workerType;
                        const pct = isEmp ? marginPercent : isCon ? commissionPercent : 0;
                        const deduction = Math.round(net * pct) / 100;
                        const payout = net - deduction;
                        return pct > 0 ? (
                          <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                            Payout: ${payout.toFixed(2)}
                          </Badge>
                        ) : null;
                      })()}
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
                          {isTentative ? "Tentative" : isAdminOnlyOcc ? "Administered" : "Unclaimed"}
                        </Text>
                      )}
                    </HStack>
                  </Card.Body>
                ) : (
                <Card.Body pt="0">
                  <VStack align="start" gap={1}>
                    {occ.startAt && (
                      <Text fontSize="xs">
                        {fmtDate(occ.startAt)}
                        {occ.endAt && fmtDate(occ.endAt) !== fmtDate(occ.startAt)
                          ? ` – ${fmtDate(occ.endAt)}`
                          : ""}
                      </Text>
                    )}
                    {occ.price != null && (
                      <Badge colorPalette="green" variant="solid" fontSize="sm" px="3" py="0.5" borderRadius="full">
                        ${occ.price.toFixed(2)}
                      </Badge>
                    )}
                    {occ.payment && (
                      <Badge colorPalette="teal" variant="solid" fontSize="sm" px="3" py="0.5" borderRadius="full">
                        Paid: ${(occ.payment as any).amountPaid.toFixed(2)}
                      </Badge>
                    )}
                    {occ.price != null && !occ.payment && (() => {
                      const expTotal = (occ.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                      const net = occ.price! - expTotal;
                      const isEmp = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE";
                      const isCon = me?.workerType === "CONTRACTOR" || !me?.workerType;
                      const pct = isEmp ? marginPercent : isCon ? commissionPercent : 0;
                      const deduction = Math.round(net * pct) / 100;
                      const payout = net - deduction;
                      const label = isEmp ? "margin" : "commission";
                      return pct > 0 ? (
                        <Box fontSize="xs" color="fg.muted" mt={0.5}>
                          <HStack gap={2}>
                            <Text>Est. payout:</Text>
                            <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                              ${payout.toFixed(2)}
                            </Badge>
                          </HStack>
                          <Text fontSize="xs" color="fg.muted">
                            ${occ.price!.toFixed(2)}{expTotal > 0 ? ` − $${expTotal.toFixed(2)} exp` : ""} − ${deduction.toFixed(2)} {label} ({pct}%)
                          </Text>
                        </Box>
                      ) : null;
                    })()}
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
                        Start Time: {fmtDateTime(occ.startedAt)}
                      </Text>
                    )}
                    {occ.completedAt && (
                      <Text fontSize="xs" color="fg.muted">
                        Complete Time: {fmtDateTime(occ.completedAt)}
                      </Text>
                    )}
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
                            <Text fontSize="xs" color="fg.muted">{otherLines}</Text>
                          )}
                          {occ.proposalNotes && (
                            <Box p={2} bg="purple.50" rounded="sm" mt={1}>
                              <Text fontSize="xs" fontWeight="medium" color="purple.700">Completed:</Text>
                              <Text fontSize="xs" color="purple.600">{occ.proposalNotes}</Text>
                              {occ.proposalAmount != null && (
                                <Text fontSize="xs" color="purple.600" mt={0.5}>Amount: ${occ.proposalAmount.toFixed(2)}</Text>
                              )}
                            </Box>
                          )}
                          {(occ.status === "ACCEPTED" || acceptComment) && (
                            <Box p={2} bg="green.50" rounded="sm" mt={1}>
                              <Text fontSize="xs" fontWeight="medium" color="green.700">Accepted{acceptComment ? ":" : ""}</Text>
                              {acceptComment && <Text fontSize="xs" color="green.600">{acceptComment}</Text>}
                            </Box>
                          )}
                        </>
                      );
                    })()}
                    {occ.rejectionReason && (
                      <Box p={2} bg="red.50" rounded="sm" mt={1}>
                        <Text fontSize="xs" fontWeight="medium" color="red.700">Rejected:</Text>
                        <Text fontSize="xs" color="red.600">{occ.rejectionReason}</Text>
                      </Box>
                    )}
                    {occ.status === "REJECTED" && !occ.rejectionReason && (
                      <Box p={2} bg="red.50" rounded="sm" mt={1}>
                        <Text fontSize="xs" fontWeight="medium" color="red.700">Rejected</Text>
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
                              {(pay.splits ?? []).map((sp: any) => {
                                const ratio = splitTotal > 0 ? sp.amount / splitTotal : 0;
                                const expShare = expTotal * ratio;
                                const isContractor = sp.user?.workerType !== "EMPLOYEE" && sp.user?.workerType !== "TRAINEE";
                                const isEmployee = sp.user?.workerType === "EMPLOYEE" || sp.user?.workerType === "TRAINEE";
                                const feeShare = isContractor && feeableSplitTotal > 0 ? fee * (sp.amount / feeableSplitTotal) : 0;
                                const marginShare = isEmployee && employeeSplitTotal > 0 ? margin * (sp.amount / employeeSplitTotal) : 0;
                                const payout = sp.amount - expShare - feeShare - marginShare;
                                return (
                                  <Box key={sp.userId} fontSize="xs">
                                    <HStack gap={2} align="center">
                                      <Text fontWeight="medium" color="green.700">
                                        {sp.user?.displayName ?? sp.user?.email ?? sp.userId}
                                      </Text>
                                      <Badge colorPalette="green" variant="solid" fontSize="xs" px="2" borderRadius="full">
                                        Payout: ${payout.toFixed(2)}
                                      </Badge>
                                    </HStack>
                                    <Box pl={2} color="fg.muted">
                                      <Text>Split: ${sp.amount.toFixed(2)}</Text>
                                      {expShare > 0 && <Text color="orange.600">−${expShare.toFixed(2)} expenses</Text>}
                                      {feeShare > 0 && <Text color="orange.600">−${feeShare.toFixed(2)} commission ({pay.platformFeePercent}%)</Text>}
                                      {marginShare > 0 && <Text color="orange.600">−${marginShare.toFixed(2)} margin ({pay.businessMarginPercent}%)</Text>}
                                    </Box>
                                  </Box>
                                );
                              })}
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

                {!isCardCompact && !isTrainee && (isUnassigned || isAssignedToMe) && !isTentative && (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS" || occ.status === "PENDING_PAYMENT" || occ.status === "PROPOSAL_SUBMITTED") && (
                  <Card.Footer py="3" px="4" pt="0">
                    <HStack gap={2} wrap="wrap" mb="2">
                      {isUnassigned && !isAdminOnlyOcc && (
                        <StatusButton
                          id="occ-claim"
                          itemId={occ.id}
                          label="Claim"
                          onClick={async () => void claim(occ.id)}
                          variant="outline"
                          colorPalette="green"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "SCHEDULED" && !isTentative && (
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
                          onClick={async () => setCompleteDialogOcc(occ)}
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
                          label="Complete Estimate"
                          onClick={async () => setConfirmAction({
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
                          variant="outline"
                          colorPalette="purple"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "PROPOSAL_SUBMITTED" && (occ.workflow === "ESTIMATE" || occ.isEstimate) && (
                        <StatusButton
                          id="occ-accept-estimate"
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
                                await apiPost(`/api/occurrences/${occ.id}/accept-estimate`, { comment: comment || undefined });
                                publishInlineMessage({ type: "SUCCESS", text: "Estimate accepted." });
                                await load(false);
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
                      {isAssignedToMe && occ.status === "PROPOSAL_SUBMITTED" && (occ.workflow === "ESTIMATE" || occ.isEstimate) && (
                        <StatusButton
                          id="occ-reject-estimate"
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
                                await apiPost(`/api/occurrences/${occ.id}/reject-estimate`, { reason: reason || undefined });
                                publishInlineMessage({ type: "SUCCESS", text: "Estimate rejected." });
                                await load(false);
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
                          label="Expenses"
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

      <ManageExpensesDialog
        open={!!expenseDialogOccId}
        onOpenChange={(o) => { if (!o) { setExpenseDialogOccId(null); void load(false); } }}
        occurrenceId={expenseDialogOccId ?? ""}
        onChanged={() => void load(false)}
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
          onAccepted={(result: any) => {
            void load(false);
            if (result?.nextOccurrence) {
              const nextDate = result.nextOccurrence.startAt
                ? fmtDate(result.nextOccurrence.startAt)
                : "upcoming";
              publishInlineMessage({
                type: "SUCCESS",
                text: `Payment accepted. Next occurrence scheduled for ${nextDate}.`,
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
          onCompleted={() => {
            void updateStatus(completeDialogOcc, "complete");
            setCompleteDialogOcc(null);
          }}
        />
      )}

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
                    <Text fontSize="xs" color="fg.muted" mb={2}>Each job can have multiple occurrences. The type determines the workflow and defaults.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="blue.300">
                    <Badge colorPalette="blue" variant="outline" mb={1}>Repeating</Badge>
                    <Text fontSize="sm">A recurring job on a schedule (e.g. every 14 days). Workers can claim it, or an admin can assign a team. When payment is accepted, the next occurrence is automatically created and left unassigned so it can be claimed again.</Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>Flow: Scheduled → Claim or Assign → Start → Complete → Accept Payment → Next occurrence auto-created</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="gray.300">
                    <Badge colorPalette="gray" variant="solid" mb={1}>One-Off</Badge>
                    <Text fontSize="sm">A single job that does not repeat. Workers can claim it, or an admin can assign a team. No next occurrence is created after payment.</Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>Flow: Scheduled → Claim or Assign → Start → Complete → Accept Payment → Done</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="purple.300">
                    <Badge colorPalette="purple" variant="solid" mb={1}>Estimate</Badge>
                    <Text fontSize="sm">A site visit to assess work before committing. Estimates are administered by default — they cannot be claimed and must be assigned by an admin. The assigned team visits the site, starts the estimate, then completes it with optional comments and photos.</Text>
                    <Text fontSize="sm" mt={1}>After completion, the assigned team or an admin can accept or reject the estimate. Accepting prompts to update the job defaults (price, frequency, duration) and optionally create a new occurrence of any type.</Text>
                    <Text fontSize="xs" color="fg.muted" mt={1}>Flow: Admin Creates & Assigns → Start → Complete → Accept or Reject</Text>
                  </Box>

                  <Box mt={2}>
                    <Text fontWeight="bold" fontSize="md" mb={1}>Flags</Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>These flags can be applied to any occurrence type to modify its behavior.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="red.300">
                    <Badge colorPalette="red" variant="outline" mb={1}>Administered</Badge>
                    <Text fontSize="sm">An administered occurrence cannot be claimed by workers — an admin must assign the team. Once assigned, the team can start, complete, and manage it normally. Estimates are administered by default, but any repeating or one-off occurrence can also be marked as administered. When an administered repeating job auto-creates the next occurrence, it keeps the same team assigned.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="orange.300">
                    <Badge colorPalette="orange" variant="solid" mb={1}>Tentative</Badge>
                    <Text fontSize="sm">A tentative occurrence cannot be claimed or started until an admin confirms it. Used when scheduling is uncertain or needs client approval first.</Text>
                  </Box>

                  <Box p={3} borderWidth="1px" rounded="md" borderColor="yellow.400">
                    <Badge colorPalette="yellow" variant="solid" mb={1}>Insured Only</Badge>
                    <Text fontSize="sm">High-value jobs above a configured threshold. Contractors must have a valid insurance certificate to claim or be assigned. Employees can always be assigned.</Text>
                  </Box>
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
    </Box>
  );
}
