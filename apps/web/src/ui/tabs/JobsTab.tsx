"use client";

import { useEffect, useMemo, useState } from "react";
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
import { AlertTriangle, CalendarRange, Filter, LayoutList, RefreshCw, Tag, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiGet, apiPost, apiDelete } from "@/src/lib/api";
import { getLocation } from "@/src/lib/geo";
import { determineRoles, occurrenceStatusColor, prettyStatus } from "@/src/lib/lib";
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

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const statusStates = ["ALL", "UNCLAIMED", ...JOB_OCCURRENCE_STATUS.filter((s) => s !== "ARCHIVED")] as const;

const quickDateItemsBase = [
  { label: "Yesterday", value: "yesterday" },
  { label: "Today", value: "today" },
  { label: "Last week", value: "lastWeek" },
  { label: "Next 3 days", value: "next3" },
  { label: "Next 7 days", value: "next7" },
  { label: "Next 14 days", value: "next14" },
  { label: "Recent & Future", value: "recent" },
  { label: "Future", value: "future" },
];

const kindStates = ["ALL", ...JOB_KIND] as const;

export default function JobsTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isAvail, forAdmin } = determineRoles(me, purpose);
  const myId = me?.id ?? "";

  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string[]>(["ALL"]);

  const kindItems = useMemo(
    () => kindStates.map((s) => ({ label: prettyStatus(s), value: s })),
    []
  );
  const kindCollection = useMemo(
    () => createListCollection({ items: kindItems }),
    [kindItems]
  );
  const [typeFilter, setTypeFilter] = useState<string[]>(["ALL"]);
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

  const [statusFilter, setStatusFilter] = useState<string[]>(["SCHEDULED"]);
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

  const [dateFrom, setDateFrom] = useState(() => localDate(new Date()));
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 6);
    return localDate(d);
  });
  const [quickDate, setQuickDate] = useState<string[]>([]);
  const [overdueActive, setOverdueActive] = useState(false);

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
    closedOccurrence: { startAt?: string | null; endAt?: string | null; notes?: string | null; price?: number | null };
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
      const list = await apiGet<WorkerOccurrence[]>(url);
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
  }, [dateFrom, dateTo]);

  async function claim(occurrenceId: string) {
    try {
      await apiPost(`/api/occurrences/${occurrenceId}/claim`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Job claimed." });
      await load(false);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Claim failed.", err),
      });
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
        ]
          .filter(Boolean)
          .some((s) => s!.toLowerCase().includes(qlc))
      );
    }
    return rows;
  }, [items, q, kind, statusFilter, typeFilter, overdueActive]);

  if (!isAvail) return <UnavailableNotice />;

  return (
    <Box w="full">
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
            setDateFrom(localDate(new Date()));
            setDateTo("");
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
      </HStack>

      <HStack mb={3} gap={2} align="center">
        <DateInput
          value={dateFrom}
          onChange={(val) => {
            setDateFrom(val);
            if (dateTo && val && val > dateTo) setDateTo(val);
          }}
        />
        <Text fontSize="sm">–</Text>
        <DateInput
          value={dateTo}
          onChange={(val) => {
            setDateTo(val);
            if (dateFrom && val && val < dateFrom) setDateFrom(val);
          }}
        />
        <Select.Root
          collection={quickDateCollection}
          value={quickDate}
          onValueChange={(e) => {
            setQuickDate(e.value);
            const val = e.value[0];
            if (!val) return;
            const today = new Date();
            if (val === "yesterday") {
              const d = new Date(today);
              d.setDate(d.getDate() - 1);
              setDateFrom(localDate(d));
              setDateTo(localDate(d));
            } else if (val === "today") {
              setDateFrom(localDate(today));
              setDateTo(localDate(today));
            } else if (val === "next3") {
              const d = new Date(today);
              d.setDate(d.getDate() + 2);
              setDateFrom(localDate(today));
              setDateTo(localDate(d));
            } else if (val === "lastWeek") {
              const d = new Date(today);
              d.setDate(d.getDate() - 7);
              setDateFrom(localDate(d));
              setDateTo(localDate(today));
            } else if (val === "next7") {
              const d = new Date(today);
              d.setDate(d.getDate() + 6);
              setDateFrom(localDate(today));
              setDateTo(localDate(d));
            } else if (val === "next14") {
              const d = new Date(today);
              d.setDate(d.getDate() + 13);
              setDateFrom(localDate(today));
              setDateTo(localDate(d));
            } else if (val === "recent") {
              const d = new Date(today);
              d.setDate(d.getDate() - 30);
              setDateFrom(localDate(d));
              setDateTo("");
            } else if (val === "future") {
              setDateFrom(localDate(today));
              setDateTo("");
            } else if (val === "all") {
              setConfirmAction({
                title: "Load All Data",
                message:
                  "This will load all occurrences for all time. This may be slow. Are you sure?",
                confirmLabel: "Load All",
                colorPalette: "orange",
                onConfirm: () => {
                  setDateFrom("");
                  setDateTo("");
                },
              });
              requestAnimationFrame(() => setQuickDate([]));
              return;
            }
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
            } else {
              const yesterday = new Date();
              yesterday.setDate(yesterday.getDate() - 1);
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
        </Button>
      </HStack>

      {(kind[0] !== "ALL" || statusFilter[0] !== "ALL" || typeFilter[0] !== "ALL" || overdueActive) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
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
          {filtered.length === 0 && (
            <Box p="8" color="fg.muted">
              No job occurrences match current filters.
            </Box>
          )}

          {filtered.map((occ) => {
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

            return (
              <Card.Root
                key={occ.id}
                variant="outline"
                borderColor={cardBorderColor}
                bg={cardBg}
              >
                <Card.Header pb="2">
                  <HStack gap={3} justify="space-between" align="center">
                    <VStack align="start" gap={0} flex="1" minW={0}>
                      <Text fontSize="md" fontWeight="semibold">
                        {occ.job?.property?.client?.displayName && (
                          <>{occ.job.property.client.displayName} — </>
                        )}
                        {occ.job?.property?.displayName}
                      </Text>
                      <Box fontSize="sm">
                        <MapLink address={[
                            occ.job?.property?.street1,
                            occ.job?.property?.city,
                            occ.job?.property?.state,
                          ]
                            .filter(Boolean)
                            .join(", ")} />
                      </Box>
                      <HStack gap={3} fontSize="xs">
                        {occ.job?.property?.displayName && (
                          <TextLink
                            text="View Property"
                            onClick={() =>
                              openEventSearch(
                                "jobsTabToPropertiesTabSearch",
                                occ.job?.property?.displayName ?? "",
                                forAdmin,
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
                              )
                            }
                          />
                        )}
                      </HStack>
                    </VStack>
                    <VStack gap={1} align="end">
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
                      {occ.isEstimate && (
                        <StatusBadge
                          status="Estimate"
                          palette="purple"
                          variant="solid"
                        />
                      )}
                      {occ.isOneOff && (
                        <StatusBadge
                          status="One-off"
                          palette="gray"
                          variant="solid"
                        />
                      )}
                    </VStack>
                  </HStack>
                </Card.Header>

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
                    {occ.notes && (
                      <Text fontSize="xs" color="fg.muted">
                        {occ.notes}
                      </Text>
                    )}
                    {(occ.startLat != null || occ.completeLat != null) && (
                      <HStack gap={3} fontSize="xs" color="fg.muted">
                        {occ.startLat != null && occ.startLng != null && (
                          <a href={`https://maps.google.com/?q=${occ.startLat},${occ.startLng}`} target="_blank" rel="noopener" style={{ color: "var(--chakra-colors-blue-600)" }}>
                            Started: {occ.startLat.toFixed(4)}, {occ.startLng.toFixed(4)}
                          </a>
                        )}
                        {occ.completeLat != null && occ.completeLng != null && (
                          <a href={`https://maps.google.com/?q=${occ.completeLat},${occ.completeLng}`} target="_blank" rel="noopener" style={{ color: "var(--chakra-colors-blue-600)" }}>
                            Completed: {occ.completeLat.toFixed(4)}, {occ.completeLng.toFixed(4)}
                          </a>
                        )}
                      </HStack>
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
                  </VStack>
                </Card.Body>

                {(isUnassigned || isAssignedToMe) && !isTentative && (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS" || occ.status === "PENDING_PAYMENT") && (
                  <Card.Footer>
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
                      {isAssignedToMe && occ.status === "IN_PROGRESS" && (
                        <StatusButton
                          id="occ-complete"
                          itemId={occ.id}
                          label="Complete"
                          onClick={async () => setConfirmAction({
                            title: occ.isEstimate ? "Complete Estimate?" : "Complete Job?",
                            message: occ.isEstimate
                              ? "This estimate will be closed (no payment step)."
                              : "Are you sure you want to mark this job as complete?",
                            confirmLabel: "Complete",
                            colorPalette: "green",
                            ...(occ.isEstimate
                              ? {
                                  inputLabel: "Comment (required)",
                                  inputPlaceholder: "What happened and why is this estimate being completed?",
                                  onConfirm: (comment: string) => void updateStatus(occ, "complete", comment),
                                }
                              : { onConfirm: () => void updateStatus(occ, "complete") }),
                          })}
                          variant="outline"
                          colorPalette="green"
                          busyId={statusButtonBusyId}
                          setBusyId={setStatusButtonBusyId}
                        />
                      )}
                      {isAssignedToMe && occ.status === "PENDING_PAYMENT" && !occ.isEstimate && (
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
                },
              });
              setScheduleNextOpen(true);
            }
            setAcceptPaymentOcc(null);
          }}
        />
      )}
    </Box>
  );
}
