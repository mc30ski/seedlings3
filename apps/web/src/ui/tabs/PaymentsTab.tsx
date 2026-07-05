"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Spinner,
  Stack,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { CalendarRange, ChevronDown, ChevronUp, CreditCard, Download, Filter, List, Maximize2, RefreshCw, User, X } from "lucide-react";
import { type DatePreset, computeDatesFromPreset, PRESET_LABELS } from "@/src/lib/datePresets";
import DateInput from "@/src/ui/components/DateInput";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import { apiGet, apiPatch, apiDelete, apiPost } from "@/src/lib/api";
import { determineRoles, prettyStatus, clientLabel, fmtDate, bizDateKey, bizToday, bizAddDays, bizAddYears } from "@/src/lib/lib";
import { composePaymentMessage } from "@/src/lib/paymentMessages";
import { resolveBillingMode, shortBillingChip } from "@/src/lib/equipmentBilling";
import { useEquipmentBillingEnabled } from "@/src/lib/useEquipmentBillingEnabled";
import { usePaymentMethodLabels } from "@/src/lib/usePaymentMethodLabels";
import {
  type TabPropsType,
  type WorkerPaymentItem,
  type PaymentListItem,
  type EquipmentCharge,
} from "@/src/lib/types";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import StatusButton from "@/src/ui/components/StatusButton";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { TextLink } from "@/src/ui/helpers/Link";
import { openEventSearch, bumpAdminPayments } from "@/src/lib/bus";
import PendingApprovalsSection from "@/src/ui/components/PendingApprovalsSection";
import OutstandingRequestsSection from "@/src/ui/components/OutstandingRequestsSection";

// Date helpers come from @/src/lib/lib (bizToday, bizAddDays). NEVER
// reinvent — see lib/lib.ts.
function defaultDateFrom() {
  return bizAddDays(bizToday(), -30);
}

// Payments tab sub-tabs. Driven by `typeFilter` state. Only ONE is shown
// at a time — switching between them was previously a Select dropdown
// with an "All" option that rendered both sections, but that combined
// view had awkward shared pagination + crowded layout. Tabs are cleaner.
const typeFilterItems = [
  { label: "Jobs", value: "JOBS" },
  { label: "Equipment", value: "EQUIPMENT" },
];

// Per-page sizes for the Payments-tab pagination footer. Stored as strings
// because Chakra's Select uses string values; converted back to number when
// piped to `setPageSize`. Shared between WorkerPayments and AdminPayments.
const pageSizeItems = [
  { label: "10", value: "10" },
  { label: "25", value: "25" },
  { label: "50", value: "50" },
  { label: "100", value: "100" },
];
const pageSizeCollection = createListCollection({ items: pageSizeItems });

// ─── Worker Payments ─────────────────────────────────────────────────

function WorkerPayments({
  me,
  forAdmin,
  viewAs,
}: {
  me: TabPropsType["me"];
  forAdmin: boolean;
  /** Super-only "view as worker" override. When present, the API fetches
   *  that worker's data instead of the caller's, and `me` reads for
   *  card-rendering purposes use this object's workerType/name instead.
   *  Each viewed worker gets its own persisted filter slot via
   *  `viewAs.id` so multiple workers can be inspected side-by-side
   *  without their search/date state colliding. */
  viewAs?: { id: string; displayName?: string | null; workerType?: any } | null;
}) {
  // Effective identity used for card-rendering decisions (workerType
  // gates on "is this an employee class" for the pending-badge logic).
  // Falls back to the caller's own `me` when no override is present.
  const effectiveMe = viewAs ? { ...me, id: viewAs.id, displayName: viewAs.displayName ?? me?.displayName, workerType: viewAs.workerType as any } : me;
  // Per-worker localStorage namespace so multiple viewed workers don't
  // share filter state. Empty string keeps the original keys for the
  // default (no view-as) case so existing users' saved preferences
  // survive the refactor.
  const ns = viewAs ? `_${viewAs.id}` : "";

  const equipmentBillingEnabled = useEquipmentBillingEnabled();
  const [items, setItems] = useState<WorkerPaymentItem[]>([]);
  const [totalAmount, setTotalAmount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [equipCharges, setEquipCharges] = useState<EquipmentCharge[]>([]);
  // Method labels come from the PAYMENT_METHODS taxonomy so editing a label
  // in Settings flows through everywhere — no hardcoded fallback strings.
  const { labelFor: methodLabel } = usePaymentMethodLabels();

  const [q, setQ] = useState("");
  const [datePreset, setDatePreset] = usePersistedState<DatePreset>(`pay_w${ns}_datePreset`, "lastMonth");
  // Inline (not useMemo) — caching the result with empty deps would let
  // the "lastMonth" anchor go stale past midnight ET if a tab is open
  // across the day boundary. Recomputation is cheap (~µs).
  const presetDates = computeDatesFromPreset("lastMonth");
  const [dateFrom, setDateFrom] = usePersistedState(`pay_w${ns}_dateFrom`, presetDates.from);
  const [dateTo, setDateTo] = usePersistedState(`pay_w${ns}_dateTo`, presetDates.to);
  const [quickDateMenuOpen, setQuickDateMenuOpen] = useState(false);
  // Sub-tab on the worker Payments view: which list is showing (Jobs or
  // Equipment). Was a 3-option Select (All/Jobs/Equipment) before tabs.
  // Legacy persisted value "ALL" is normalized to "JOBS" on read.
  const [typeFilterRaw, setTypeFilter] = usePersistedState<string[]>(`pay_w${ns}_type`, ["JOBS"]);
  const typeFilter = typeFilterRaw[0] === "ALL" ? ["JOBS"] : typeFilterRaw;
  const [compact, setCompact] = usePersistedState(`pay_w${ns}_compact`, false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  // Pagination — Jobs and Equipment paginate INDEPENDENTLY. Same pattern
  // as AdminPayments; see that block for rationale.
  const [pageSize, setPageSize] = usePersistedState<number>(`pay_w${ns}_pageSize`, 10);
  const [jobsPage, setJobsPage] = useState(1);
  const [equipPage, setEquipPage] = useState(1);

  function applyPreset(preset: DatePreset) {
    setDatePreset(preset);
    if (preset) {
      const d = computeDatesFromPreset(preset);
      setDateFrom(d.from);
      setDateTo(d.to);
    }
  }

  // Listen for external filter requests (e.g., from HomeTab tiles).
  // Reset filters first, then apply only what the event provides.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail || {};
      setQ("");
      setTypeFilter(["JOBS"]);
      if (typeof detail.datePreset === "string") {
        applyPreset(detail.datePreset as DatePreset);
      }
      if (typeof detail.dateFrom === "string" || typeof detail.dateTo === "string") {
        setDatePreset(null);
        if (typeof detail.dateFrom === "string") setDateFrom(detail.dateFrom);
        if (typeof detail.dateTo === "string") setDateTo(detail.dateTo);
      }
      if (typeof detail.q === "string") setQ(detail.q);
      if (typeof detail.method === "string") setTypeFilter([detail.method]);
    };
    window.addEventListener("payments:applyFilter", handler as EventListener);
    return () => window.removeEventListener("payments:applyFilter", handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recompute dates from preset on each mount (so "last month" stays current).
  // Worker view excludes "All time" — workers are capped to a rolling 1-year
  // lookback. The admin/super version (AdminPayments) keeps "All time".
  const quickDateItems = useMemo(() => [
    { label: "Today", value: "today" },
    { label: "Yesterday", value: "yesterday" },
    { label: "Last week", value: "lastWeek" },
    { label: "Last month", value: "lastMonth" },
    { label: "Last year", value: "lastYear" },
  ], []);

  // Floor for the custom-range date pickers: workers can't query earlier
  // than 1 year ago. Inline (not useMemo with []) so it stays current
  // across day boundaries — the previous empty-deps memo cached the
  // value indefinitely, contradicting the comment.
  const minWorkerDate = bizAddYears(bizToday(), -1);

  useEffect(() => {
    // Reset to the default ("Last month") if the persisted preset isn't a
    // recognized option (e.g. legacy "all" value from before workers were
    // capped to 1 year).
    const validPresets = quickDateItems.map((it) => it.value);
    if (datePreset && !validPresets.includes(datePreset)) {
      applyPreset("lastMonth");
      return;
    }
    // Whenever datePreset changes (including hydration from localStorage), recompute dates
    if (datePreset) {
      const d = computeDatesFromPreset(datePreset);
      setDateFrom(d.from);
      setDateTo(d.to);
    }
  }, [datePreset]);

  // Clamp persisted custom dates against the 1-year floor. Runs on mount and
  // whenever the floor changes (cross-midnight). Empty strings (== open-ended)
  // are bumped up to the floor too, so a worker can't bypass the cap by
  // clearing the field.
  useEffect(() => {
    if (datePreset) return; // preset paths already produce ≤ 1-year ranges
    if (!dateFrom || dateFrom < minWorkerDate) setDateFrom(minWorkerDate);
    if (!dateTo || dateTo < minWorkerDate) setDateTo(minWorkerDate);
  }, [datePreset, dateFrom, dateTo, minWorkerDate]);

  useEffect(() => {
    if (!quickDateMenuOpen) return;
    const close = () => setQuickDateMenuOpen(false);
    const timer = setTimeout(() => document.addEventListener("click", close), 50);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [quickDateMenuOpen]);

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      // Server honors `asUserId` only when the caller is SUPER. Non-Super
      // callers see this param silently ignored, so it's safe to always
      // append when viewAs is set.
      if (viewAs?.id) qs.set("asUserId", viewAs.id);
      const [res, charges] = await Promise.all([
        apiGet<{ items: WorkerPaymentItem[]; totalAmount: number }>(
          `/api/payments/mine${qs.toString() ? `?${qs}` : ""}`
        ),
        apiGet<EquipmentCharge[]>(
          `/api/payments/equipment-charges${qs.toString() ? `?${qs}` : ""}`
        ),
      ]);
      setItems(res.items ?? []);
      setTotalAmount(res.totalAmount ?? 0);
      // Show whatever equipment charges the API returned — it already filters
      // to checkouts with a real recorded rentalCost. No worker-type gating:
      // every worker (and the owner) is tracked the same way.
      setEquipCharges(charges ?? []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load payments.", err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Re-fetch when the viewed-as worker changes too (Super view-as flow).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, viewAs?.id]);

  // Tabs are mutually exclusive — exactly one of these is true at a time.
  // Kept as named booleans so the conditional blocks below read clearly.
  const showJobs = typeFilter[0] === "JOBS";
  const showEquip = typeFilter[0] === "EQUIPMENT";

  const filteredItems = useMemo(() => {
    if (!q.trim()) return items;
    const qlc = q.trim().toLowerCase();
    return items.filter((p) => {
      const prop = p.occurrence?.job?.property;
      const arr = [
        prop?.displayName || "",
        prop?.client?.displayName || "",
        p.payment?.method || "",
        p.payment?.note || "",
        p.payment?.collectedBy?.displayName || "",
      ];
      return arr.some((v) => v.toLowerCase().includes(qlc));
    });
  }, [items, q]);

  const filteredCharges = useMemo(() => {
    if (!q.trim()) return equipCharges;
    const qlc = q.trim().toLowerCase();
    return equipCharges.filter((c) => {
      const arr = [c.equipment?.shortDesc || "", c.equipment?.brand || "", c.equipment?.model || ""];
      return arr.some((v) => v.toLowerCase().includes(qlc));
    });
  }, [equipCharges, q]);

  // Per-section pagination — Jobs and Equipment slice independently. See
  // the same block in AdminPayments for the full rationale.
  const jobsTotalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const jobsSafePage = Math.min(jobsPage, jobsTotalPages);
  const jobsPageStart = (jobsSafePage - 1) * pageSize;
  const jobsPageEnd = jobsPageStart + pageSize;
  const pagedItems = filteredItems.slice(jobsPageStart, jobsPageEnd);

  const equipTotalPages = Math.max(1, Math.ceil(filteredCharges.length / pageSize));
  const equipSafePage = Math.min(equipPage, equipTotalPages);
  const equipPageStart = (equipSafePage - 1) * pageSize;
  const equipPageEnd = equipPageStart + pageSize;
  const pagedCharges = filteredCharges.slice(equipPageStart, equipPageEnd);

  useEffect(() => {
    setJobsPage(1);
    setEquipPage(1);
  }, [q, typeFilter, dateFrom, dateTo, pageSize]);

  function renderPaginationFooter(opts: {
    totalCount: number;
    totalPages: number;
    safePage: number;
    pageStart: number;
    pageEnd: number;
    setPage: (updater: (n: number) => number) => void;
  }) {
    const { totalCount, totalPages, safePage, pageStart, pageEnd, setPage } = opts;
    if (totalCount === 0) return null;
    const start = pageStart + 1;
    const end = Math.min(pageEnd, totalCount);
    return (
      <HStack mt={2} justify="space-between" wrap="wrap" gap={2} fontSize="sm">
        <Text color="fg.muted">
          Showing {start}–{end} of {totalCount}
        </Text>
        <HStack gap={2} wrap="wrap">
          {totalPages > 1 && (
            <>
              <Button size="xs" variant="outline" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                ← Prev
              </Button>
              <Text color="fg.muted" fontSize="xs">
                Page {safePage} of {totalPages}
              </Text>
              <Button size="xs" variant="outline" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                Next →
              </Button>
            </>
          )}
          <HStack gap={1}>
            <Text color="fg.muted" fontSize="xs">Per page:</Text>
            <Select.Root
              collection={pageSizeCollection}
              value={[String(pageSize)]}
              onValueChange={(e) => setPageSize(Number(e.value[0]))}
              size="sm"
              positioning={{ strategy: "fixed", hideWhenDetached: true }}
              css={{ width: "auto", flex: "0 0 auto" }}
            >
              <Select.Control>
                <Select.Trigger w="auto" minW="0" px="2">
                  <Select.ValueText placeholder={String(pageSize)} />
                  <Select.Indicator />
                </Select.Trigger>
              </Select.Control>
              <Select.Positioner>
                <Select.Content>
                  {pageSizeItems.map((it) => (
                    <Select.Item key={it.value} item={it.value}>
                      <Select.ItemText>{it.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Select.Root>
          </HStack>
        </HStack>
      </HStack>
    );
  }

  return (
    <Box w="full">
      <HStack mb={2} gap={2}>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-100)" }}>
          <RefreshCw size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          px="2"
          flexShrink={0}
          onClick={() => { setCompact((p) => !p); setExpandedCards(new Set()); }}
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
          onChange={setQ}
          inputId="worker-payments-search"
          placeholder="Search…"
        />
      </HStack>
      {/* Timeframe row — custom dates + preset badge inline, matching the
          AdminPayments layout. Worker variant: min-floored to 1 year, no
          "All time" preset (see quickDateItems above). */}
      <HStack mb={2} gap={2} align="center" wrap="wrap">
        <DateInput min={minWorkerDate} value={dateFrom} onChange={(val) => { const clamped = val && val < minWorkerDate ? minWorkerDate : val; setDateFrom(clamped); setDatePreset(null); if (dateTo && clamped && clamped > dateTo) setDateTo(clamped); }} />
        <Text fontSize="sm">–</Text>
        <DateInput min={minWorkerDate} value={dateTo} onChange={(val) => { const clamped = val && val < minWorkerDate ? minWorkerDate : val; setDateTo(clamped); setDatePreset(null); if (dateFrom && clamped && clamped < dateFrom) setDateFrom(clamped); }} />
        <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
          <Badge size="sm" colorPalette="green" variant="subtle" cursor="pointer" onClick={() => setQuickDateMenuOpen((v) => !v)}>
            {datePreset ? (PRESET_LABELS[datePreset] ?? datePreset) : (dateFrom || dateTo) ? "Custom dates" : "Last month"}
            {" "}<Box as="span" display="inline-flex" alignItems="center" justifyContent="center" w="14px" h="14px" borderRadius="full" bg="green.500" color="white" verticalAlign="middle"><ChevronDown size={9} /></Box>
          </Badge>
          {quickDateMenuOpen && (
            <VStack position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px"
              ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 148))}px`; } }}>
              {quickDateItems.map((it) => (
                <Button key={it.value} size="xs" variant={datePreset === it.value ? "solid" : "ghost"} colorPalette={datePreset === it.value ? "green" : undefined} w="full" justifyContent="start"
                  onClick={() => { setQuickDateMenuOpen(false); applyPreset(it.value as DatePreset); }}>
                  {it.label}
                </Button>
              ))}
            </VStack>
          )}
        </Box>
      </HStack>
      {/* Tab itself shows what's active — no extra badge needed for
          typeFilter, removed when the dropdown became tabs. */}
      {!datePreset && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          <Badge
            size="sm"
            colorPalette="red"
            variant="outline"
            cursor="pointer"
            onClick={() => { setTypeFilter(["JOBS"]); applyPreset("lastMonth"); }}
          >
            ✕ Clear
          </Badge>
        </HStack>
      )}

      {(() => {
        // The summary panel ALWAYS aggregates both Jobs and Equipment
        // regardless of which sub-tab is active — switching tabs changes
        // the LIST below but the totals stay the full overview. Per
        // operator preference.
        const showJobs = true;
        const showEquip = true;
        // totalAmount already represents the worker's post-deduction payout (commission/margin/expenses removed at acceptance time).
        // Equipment rental charges are separate — billed AFTER payout, so they're a real additional deduction here.
        const totalEquipCost = showEquip ? equipCharges.reduce((s, c) => s + (c.rentalCost ?? 0), 0) : 0;
        // Split the visible payout into confirmed and pending-approval. For
        // contractors, the pending portion is provisional — admin may
        // adjust it. For employees/trainees the pending portion is what
        // they'll receive via payroll regardless.
        const pendingTotal = showJobs
          ? items.reduce((s, it) => s + (it.payment.confirmed === false ? it.myAmount : 0), 0)
          : 0;
        const visibleTotal = showJobs ? totalAmount : 0;
        const confirmedTotal = visibleTotal - pendingTotal;
        const finalNet = visibleTotal - totalEquipCost;
        // Viewer is the LLC owner when every row is flagged as owner earnings.
        // Render "Owner Earnings" instead of "Payout" so the label matches the
        // accounting treatment (a draw, not payroll).
        const allOwner = showJobs && items.length > 0 && items.every((it) => it.myOwnerEarnings === true);
        const payoutLabel = allOwner ? "Owner Earnings" : "Payout";
        return (
          <Box mb={3} p={3} bg="green.50" rounded="md">
            {showJobs && (
              <Text fontSize="lg" fontWeight="bold" color="green.700">
                {payoutLabel}: ${visibleTotal.toFixed(2)}
              </Text>
            )}
            {showJobs && pendingTotal > 0 && (
              <Text fontSize="xs" color="orange.700">
                ${confirmedTotal.toFixed(2)} confirmed · ${pendingTotal.toFixed(2)} pending admin approval
              </Text>
            )}
            {totalEquipCost > 0 && (
              <Text fontSize="sm" color="orange.600">
                Equipment rental: −${totalEquipCost.toFixed(2)}
              </Text>
            )}
            {totalEquipCost > 0 && showJobs && (
              <Text fontSize="lg" fontWeight="bold" color="green.700">
                Net: ${finalNet.toFixed(2)}
              </Text>
            )}
            {!showJobs && totalEquipCost > 0 && (
              <Text fontSize="lg" fontWeight="bold" color="orange.600">
                Equipment Total: −${totalEquipCost.toFixed(2)}
              </Text>
            )}
          </Box>
        );
      })()}

      {/* Sub-tab bar — Jobs vs. Equipment. Replaces the previous "Type
          Filter" dropdown so the two lists are clearly separate views
          rather than coexisting on one paginated page. Counts come from
          the FILTERED set so they update with the search/date filters. */}
      <HStack gap={0} mb={2} borderWidth="1px" borderColor="gray.300" borderRadius="md" overflow="hidden" w="full">
        {typeFilterItems.map((it) => {
          const isActive = typeFilter[0] === it.value;
          const count = it.value === "JOBS" ? filteredItems.length : filteredCharges.length;
          return (
            <Button
              key={it.value}
              size="sm"
              variant="ghost"
              borderRadius="0"
              flex="1"
              fontWeight={isActive ? "semibold" : "normal"}
              bg={isActive ? "purple.100" : "transparent"}
              color={isActive ? "purple.800" : "fg.muted"}
              _hover={{ bg: isActive ? "purple.200" : "gray.100" }}
              onClick={() => setTypeFilter([it.value])}
            >
              {it.label} ({count})
            </Button>
          );
        })}
      </HStack>

      {loading && items.length === 0 && equipCharges.length === 0 && <LoadingCenter />}
      <Box position="relative">
        {loading && (items.length > 0 || equipCharges.length > 0) && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
      {showJobs && filteredItems.length === 0 && filteredCharges.length === 0 && (
        <Text color="fg.muted" p="8">No payments found.</Text>
      )}

      {showJobs && filteredItems.length > 0 && (
        <Text fontSize="sm" fontWeight="semibold" mb={1}>Job Payments</Text>
      )}
      {showJobs && <VStack align="stretch" gap={2}>
        {pagedItems.map((item) => {
          const prop = item.occurrence?.job?.property;
          const client = prop?.client;
          const cardId = `jp-${item.splitId}`;
          const isCardCompact = compact && !expandedCards.has(cardId);
          const toggleCard = compact ? () => setExpandedCards((prev) => {
            const next = new Set(prev);
            next.has(cardId) ? next.delete(cardId) : next.add(cardId);
            return next;
          }) : undefined;
          return (
            <Card.Root
              key={item.splitId}
              variant="outline"
              css={compact ? { cursor: "pointer" } : undefined}
              onClick={(e: any) => {
                if (!toggleCard) return;
                if ((e.target as HTMLElement)?.closest?.("a, button")) return;
                toggleCard();
              }}
            >
              <Card.Body py="2" px="3">
                {isCardCompact ? (
                  <HStack justify="space-between" align="center">
                    <Text fontSize="md" fontWeight="semibold" truncate>
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && <> — {clientLabel(client.displayName)}</>}
                    </Text>
                    <HStack gap={2} flexShrink={0}>
                      {/* Contractors get a louder, more explicit pending badge
                          because their amount can actually shrink at admin
                          approval (adjustment / write-off). Employees /
                          trainees get the muted "Pending" — for them the
                          amount won't change at approval. */}
                      {item.payment.confirmed === false && (
                        (effectiveMe?.workerType === "EMPLOYEE" || effectiveMe?.workerType === "TRAINEE") ? (
                          <Badge size="sm" colorPalette="orange" variant="subtle">Pending</Badge>
                        ) : (
                          <Badge size="sm" colorPalette="orange" variant="solid">Pending — may change</Badge>
                        )
                      )}
                      <Badge size="sm" colorPalette="gray">{methodLabel(item.payment.method)}</Badge>
                      <Text fontWeight="bold" color="green.700" fontSize="lg">
                        ${item.myAmount.toFixed(2)}
                      </Text>
                    </HStack>
                  </HStack>
                ) : (
                // On phones (base) stack the property block above the payout
                // block so neither has to wrap mid-sentence in a ~360px
                // viewport. From sm (≥30em / 480px) up, lay out side by side
                // as before. Same treatment on admin/equipment cards below.
                <Stack direction={{ base: "column", sm: "row" }} justify="space-between" align={{ base: "stretch", sm: "start" }} gap={2} w="full">
                  <VStack align="start" gap={0} flex="1" minW={0}>
                    <Text fontSize="md" fontWeight="semibold">
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && (
                        <> — {clientLabel(client.displayName)}</>
                      )}
                    </Text>
                    <HStack gap={2} wrap="wrap" fontSize="xs">
                      {prop?.displayName && (
                        <TextLink
                          text="Property"
                          onClick={() => openEventSearch("paymentsTabToPropertiesTabSearch", prop.displayName, forAdmin, prop.id)}
                        />
                      )}
                      {client?.displayName && (
                        <TextLink
                          text="Client"
                          onClick={() => openEventSearch("paymentsTabToClientsTabSearch", client.displayName, forAdmin, client.id)}
                        />
                      )}
                      {prop?.displayName && (
                        <TextLink
                          text="Job"
                          onClick={() => openEventSearch("paymentsTabToServicesTabSearch", prop.displayName, forAdmin, item.occurrence?.id, item.occurrence?.startAt ?? null)}
                        />
                      )}
                    </HStack>
                    {item.occurrence?.startAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {fmtDate(item.occurrence.startAt)}
                      </Text>
                    )}
                    <Text fontSize="xs" color="fg.muted">
                      {methodLabel(item.payment.method)}
                      {item.payment.note ? ` — ${item.payment.note}` : ""}
                    </Text>
                    {item.payment.createdAt && (
                      <Text fontSize="xs" color="fg.muted">
                        Paid on {fmtDate(item.payment.createdAt)}
                      </Text>
                    )}
                    {item.payment.splits.length > 1 && (() => {
                      // Per-worker percent split is derived from grossAmount
                      // shares — sums to ~100 of the actual collected amount.
                      // For legacy rows that don't have grossAmount, the
                      // percent is omitted.
                      const totalGross = item.payment.splits.reduce((s, sp) => s + (sp.grossAmount ?? 0), 0);
                      return (
                        <VStack align="start" gap={0} mt={0.5}>
                          {item.payment.splits.map((sp) => {
                            const pct = totalGross > 0 && sp.grossAmount != null
                              ? Math.round((sp.grossAmount / totalGross) * 100)
                              : null;
                            return (
                              <Text key={sp.userId} fontSize="xs" color="fg.muted">
                                {sp.user?.displayName ?? sp.user?.email ?? sp.userId}
                                {pct != null ? ` (${pct}%)` : ""}: ${sp.amount.toFixed(2)}
                                {sp.guaranteedPayoutPaidAt && (
                                  <Text as="span" ml={1} fontSize="2xs" color="purple.700" fontWeight="semibold">
                                    · Advance paid
                                  </Text>
                                )}
                              </Text>
                            );
                          })}
                        </VStack>
                      );
                    })()}
                    {(() => {
                      const expTotal = (item.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                      return expTotal > 0 ? (
                        <VStack align="start" gap={0} mt={0.5}>
                          {(item.occurrence?.expenses ?? []).map((exp) => (
                            <Text key={exp.id} fontSize="xs" color="orange.600">
                              Expense: ${exp.cost.toFixed(2)} — {exp.description}
                            </Text>
                          ))}
                        </VStack>
                      ) : null;
                    })()}
                  </VStack>
                  {(() => {
                    // myAmount is the post-deduction payout (commission/margin/expenses already removed at acceptance time).
                    // Show informational context about what was deducted from the gross, but don't re-subtract.
                    const expTotal = (item.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                    const fee = item.payment.platformFeeAmount ?? 0;
                    const margin = item.payment.businessMarginAmount ?? 0;
                    const isPending = item.payment.confirmed === false;
                    const isEmployeeClass = effectiveMe?.workerType === "EMPLOYEE" || effectiveMe?.workerType === "TRAINEE";
                    return (
                      <VStack align={{ base: "start", sm: "end" }} gap={0}>
                        {/* Same split-by-worker-type treatment as the compact
                            view: louder solid badge + inline caption for
                            contractors because their amount can shrink at
                            approval. Employees get the muted reminder
                            since their number won't change. */}
                        {isPending && (
                          isEmployeeClass ? (
                            <Badge size="sm" colorPalette="orange" variant="subtle" title="Recorded but not yet approved by admin. You'll receive this amount via payroll regardless.">
                              Pending approval
                            </Badge>
                          ) : (
                            <Badge size="sm" colorPalette="orange" variant="solid">
                              Pending — may change
                            </Badge>
                          )
                        )}
                        {item.myOwnerEarnings && (
                          <Badge size="sm" colorPalette="purple" variant="subtle" title="Owner's earnings — taken as a draw, not paid through payroll.">
                            Owner Earnings
                          </Badge>
                        )}
                        <Text fontWeight="bold" color="green.700" fontSize="lg">
                          ${item.myAmount.toFixed(2)}
                        </Text>
                        {/* Pro-rata reduction (contractors only). When the
                            client underpaid, the contractor's actual
                            payout is below what was promised at Initiate-
                            Payment time. Surface the gap so the worker
                            understands why their take is lower than
                            expected on this row. Employees skip this —
                            they're made whole, so the gap is always 0. */}
                        {!isEmployeeClass && item.myPromisedNet != null && item.myPromisedNet > item.myAmount && (
                          <Text fontSize="2xs" color="orange.700" textAlign={{ base: "left", sm: "right" }} maxW={{ base: "100%", sm: "220px" }}>
                            Pro-rata reduction: −${(item.myPromisedNet - item.myAmount).toFixed(2)} due to client underpay
                          </Text>
                        )}
                        {isPending && !isEmployeeClass && (
                          <Text fontSize="2xs" color="orange.700" textAlign={{ base: "left", sm: "right" }} maxW={{ base: "100%", sm: "200px" }}>
                            If admin adjusts the payment or writes it off, this amount may shrink.
                          </Text>
                        )}
                        {item.payment.amountPaid !== item.myAmount && (
                          <Text fontSize="xs" color="fg.muted">
                            of ${item.payment.amountPaid.toFixed(2)} total
                          </Text>
                        )}
                        {(expTotal > 0 || fee > 0 || margin > 0) && (
                          <Text fontSize="2xs" color="fg.muted" fontStyle="italic" mt={0.5}>
                            (after deductions)
                          </Text>
                        )}
                        {expTotal > 0 && (
                          <Text fontSize="2xs" color="fg.muted">
                            ${expTotal.toFixed(2)} expenses on job
                          </Text>
                        )}
                        {fee > 0 && (
                          <Text fontSize="2xs" color="fg.muted">
                            {item.payment.platformFeePercent}% commission on contractor's share
                          </Text>
                        )}
                        {margin > 0 && (
                          <Text fontSize="2xs" color="fg.muted">
                            {item.payment.businessMarginPercent}% margin on employee's share
                          </Text>
                        )}
                      </VStack>
                    );
                  })()}
                </Stack>
                )}
              </Card.Body>
            </Card.Root>
          );
        })}
      </VStack>}
      {/* Jobs pagination footer (worker view). */}
      {showJobs && filteredItems.length > 0 && renderPaginationFooter({
        totalCount: filteredItems.length,
        totalPages: jobsTotalPages,
        safePage: jobsSafePage,
        pageStart: jobsPageStart,
        pageEnd: jobsPageEnd,
        setPage: setJobsPage,
      })}

      {showEquip && filteredCharges.length > 0 && (
        <>
          <Text fontSize="sm" fontWeight="semibold" mt={4} mb={1}>Equipment Charges</Text>
          <VStack align="stretch" gap={2}>
            {pagedCharges.map((c) => {
              const cardId = `ec-${c.id}`;
              const isCardCompact = compact && !expandedCards.has(cardId);
              const toggleCard = compact ? () => setExpandedCards((prev) => {
                const next = new Set(prev);
                next.has(cardId) ? next.delete(cardId) : next.add(cardId);
                return next;
              }) : undefined;
              return (
              <Card.Root
                key={c.id}
                variant="outline"
                css={compact ? { cursor: "pointer" } : undefined}
                onClick={(e: any) => {
                  if (!toggleCard) return;
                  const tag = (e.target as HTMLElement)?.closest?.("a, button");
                  if (tag) return;
                  toggleCard();
                }}
              >
                <Card.Body py="2" px="3">
                  {isCardCompact ? (
                    <HStack justify="space-between" align="center">
                      <Text fontSize="md" fontWeight="semibold" truncate>
                        {c.equipment.shortDesc}
                      </Text>
                      <Text fontWeight="bold" color="orange.600" fontSize="lg" flexShrink={0}>
                        −${(c.rentalCost ?? 0).toFixed(2)}
                      </Text>
                    </HStack>
                  ) : (
                  <Stack direction={{ base: "column", sm: "row" }} justify="space-between" align={{ base: "stretch", sm: "start" }} gap={2} w="full">
                    <VStack align="start" gap={0} flex="1" minW={0}>
                      <Text fontSize="md" fontWeight="semibold">
                        {c.equipment.shortDesc}
                      </Text>
                      <Text fontSize="sm" color="fg.muted">
                        {c.equipment.brand ? `${c.equipment.brand} ` : ""}
                        {c.equipment.model ?? ""}
                      </Text>
                      {(() => {
                        // Equipment chip — same helper the reserve flow
                        // uses, so the worker sees consistent billing copy.
                        const mode = resolveBillingMode(c.equipment.dailyRate, c.equipment.equivalentJobs, equipmentBillingEnabled);
                        const chip = shortBillingChip(mode);
                        return (
                          <Text fontSize="xs" color="fg.muted">
                            {c.rentalDays} day{c.rentalDays !== 1 ? "s" : ""}
                            {chip ? ` · ${chip}` : ""}
                          </Text>
                        );
                      })()}
                      {/* Per-day breakdown — surfaces the math behind the
                          charge. Only renders when stored (recent
                          checkouts; legacy data has null). */}
                      {c.rentalBreakdown && c.rentalBreakdown.length > 0 && (
                        <VStack align="start" gap={0} mt={1}>
                          {c.rentalBreakdown.map((line) => (
                            <Text key={line.day} fontSize="2xs" color="fg.muted">
                              {fmtDate(line.day)}
                              {line.jobs != null ? ` · ${line.jobs} job${line.jobs === 1 ? "" : "s"}` : ""}
                              {" → "}${line.subtotal.toFixed(2)}
                              {line.capped && line.jobs != null && line.jobs > 0 ? " (capped)" : ""}
                            </Text>
                          ))}
                        </VStack>
                      )}
                      {c.releasedAt && (
                        <Text fontSize="xs" color="fg.muted">
                          Returned {fmtDate(c.releasedAt)}
                        </Text>
                      )}
                    </VStack>
                    <Text fontWeight="bold" color="orange.600" fontSize="lg" textAlign={{ base: "left", sm: "right" }}>
                      −${(c.rentalCost ?? 0).toFixed(2)}
                    </Text>
                  </Stack>
                  )}
                </Card.Body>
              </Card.Root>
              );
            })}
          </VStack>
        </>
      )}
      {/* Equipment pagination footer (worker view). */}
      {showEquip && filteredCharges.length > 0 && renderPaginationFooter({
        totalCount: filteredCharges.length,
        totalPages: equipTotalPages,
        safePage: equipSafePage,
        pageStart: equipPageStart,
        pageEnd: equipPageEnd,
        setPage: setEquipPage,
      })}
      </Box>
    </Box>
  );
}

// ─── Admin Payments ──────────────────────────────────────────────────

function AdminPayments({ forAdmin, isSuper }: { forAdmin: boolean; isSuper: boolean }) {
  const equipmentBillingEnabled = useEquipmentBillingEnabled();
  const [items, setItems] = useState<PaymentListItem[]>([]);
  const [personTotals, setPersonTotals] = useState<Array<{ userId: string; displayName: string | null; total: number }>>([]);
  const [totalPlatformFees, setTotalPlatformFees] = useState(0);
  const [totalBusinessMargin, setTotalBusinessMargin] = useState(0);
  // Method labels + configs from the PAYMENT_METHODS taxonomy (Super →
  // Settings). Both the type-filter dropdown and the edit-payment method
  // picker derive from this — no hardcoded method lists.
  const { labelFor: methodLabel, methods: paymentMethods } = usePaymentMethodLabels();
  // Type-filter dropdown: "All Methods" + every taxonomy entry (active or
  // not, so history recorded under a now-inactive method stays filterable).
  const methodFilterItems = useMemo(
    () => [
      { label: "All Methods", value: "ALL" },
      ...paymentMethods.map((m) => ({ label: m.label, value: m.key })),
    ],
    [paymentMethods],
  );
  const methodFilterCollection = useMemo(
    () => createListCollection({ items: methodFilterItems }),
    [methodFilterItems],
  );
  // Edit-payment method picker: admin manual recording shows ALL active
  // methods regardless of context flags (per spec Part 6).
  const editMethodItems = useMemo(
    () => paymentMethods.filter((m) => m.active).map((m) => ({ label: m.label, value: m.key })),
    [paymentMethods],
  );
  const editMethodCollection = useMemo(
    () => createListCollection({ items: editMethodItems }),
    [editMethodItems],
  );
  const [totalOverage, setTotalOverage] = useState(0);
  const [totalShortfall, setTotalShortfall] = useState(0);
  // Money-flow total revenue = sum of (amountPaid − worker payouts − expenses)
  // across all payments in the filtered range. Always correct regardless
  // of overpay / underpay / write-off; computed server-side so the
  // breakdown components (fees, margin, overage) don't need to add up.
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [loading, setLoading] = useState(false);
  const [equipCharges, setEquipCharges] = useState<EquipmentCharge[]>([]);

  const [q, setQ] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [quickDateMenuOpen, setQuickDateMenuOpen] = useState(false);
  const [datePreset, setDatePreset] = usePersistedState<DatePreset>("pay_a_datePreset", "lastMonth");
  // Inline — see explanation on the worker variant above.
  const presetDates = computeDatesFromPreset("lastMonth");
  const [dateFrom, setDateFrom] = usePersistedState("pay_a_dateFrom", presetDates.from);
  const [dateTo, setDateTo] = usePersistedState("pay_a_dateTo", presetDates.to);
  const [quickDate, setQuickDate] = useState<string[]>([]);

  function applyPreset(preset: DatePreset) {
    setDatePreset(preset);
    if (preset) {
      const d = computeDatesFromPreset(preset);
      setDateFrom(d.from);
      setDateTo(d.to);
      void load({ from: d.from, to: d.to });
    }
  }

  // Recompute dates from preset on each mount (so "last month" stays current)
  const quickDateItems = useMemo(() => [
    { label: "Today", value: "today" },
    { label: "Yesterday", value: "yesterday" },
    { label: "Last week", value: "lastWeek" },
    { label: "Last month", value: "lastMonth" },
    { label: "Last year", value: "lastYear" },
    { label: "All time", value: "all" },
  ], []);

  useEffect(() => {
    // Reset to the default ("Last month") if the persisted preset isn't a
    // recognized option.
    const validPresets = quickDateItems.map((it) => it.value);
    if (datePreset && !validPresets.includes(datePreset)) {
      applyPreset("lastMonth");
      return;
    }
    // Whenever datePreset changes (including hydration from localStorage), recompute dates
    if (datePreset) {
      const d = computeDatesFromPreset(datePreset);
      setDateFrom(d.from);
      setDateTo(d.to);
    }
  }, [datePreset]);

  useEffect(() => {
    if (!quickDateMenuOpen) return;
    const close = () => setQuickDateMenuOpen(false);
    const timer = setTimeout(() => document.addEventListener("click", close), 50);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [quickDateMenuOpen]);
  const quickDateCollection = useMemo(() => createListCollection({ items: quickDateItems }), [quickDateItems]);
  const [methodFilter, setMethodFilter] = usePersistedState<string[]>("pay_a_method", ["ALL"]);
  const [personFilter, setPersonFilter] = usePersistedState<string[]>("pay_a_persons", []);
  const [personDropOpen, setPersonDropOpen] = useState(false);
  const [personSearch, setPersonSearch] = useState("");
  const personDropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!personDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (personDropRef.current && !personDropRef.current.contains(e.target as Node)) {
        setPersonDropOpen(false);
        setPersonSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [personDropOpen]);
  // Sub-tab on the admin Payments view (see WorkerPayments comment).
  const [typeFilterRaw, setTypeFilter] = usePersistedState<string[]>("pay_a_type", ["JOBS"]);
  const typeFilter = typeFilterRaw[0] === "ALL" ? ["JOBS"] : typeFilterRaw;
  const [compact, setCompact] = usePersistedState("pay_a_compact", false);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  // Pagination — applied client-side over filteredItems / filteredCharges
  // so the green summary still aggregates the full filtered set (not just
  // the visible page). pageSize is user-controlled and persists; `page`
  // resets to 1 whenever a filter changes (see effect below).
  // Jobs and Equipment paginate INDEPENDENTLY — they're conceptually
  // different lists (job-payment income vs. contractor equipment-rental
  // income) and merging them under a single page counter produced weird
  // page transitions ("page 2 of 3 has 4 jobs + 1 equipment" etc).
  // Shared pageSize so the operator only configures rows-per-page once.
  const [pageSize, setPageSize] = usePersistedState<number>("pay_a_pageSize", 10);
  const [jobsPage, setJobsPage] = useState(1);
  const [equipPage, setEquipPage] = useState(1);

  // Edit state
  const [editPayment, setEditPayment] = useState<PaymentListItem | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editMethod, setEditMethod] = useState<string[]>([]);
  const [editNote, setEditNote] = useState("");
  const [editSplits, setEditSplits] = useState<Record<string, string>>({});
  const [editBusy, setEditBusy] = useState(false);
  const [editConfirm, setEditConfirm] = useState(false);

  // Revert state — Super-only undo of an already-approved payment.
  const [revertingPayment, setRevertingPayment] = useState<PaymentListItem | null>(null);

  // Delete expense state
  const [deleteExpenseId, setDeleteExpenseId] = useState<string | null>(null);
  const [deleteExpenseBusy, setDeleteExpenseBusy] = useState(false);

  const [statusButtonBusyId, setStatusButtonBusyId] = useState<string>("");

  // Fetch all workers for the person search
  const [allWorkers, setAllWorkers] = useState<Array<{ id: string; displayName?: string | null; email?: string | null }>>([]);
  useEffect(() => {
    apiGet<any[]>("/api/workers")
      .then((list) => setAllWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  const personItems = useMemo(() => {
    return allWorkers.map((w) => ({
      label: w.displayName || w.email || w.id,
      value: w.id,
    }));
  }, [allWorkers]);
  const personNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of allWorkers) map[w.id] = w.displayName || w.email || w.id;
    return map;
  }, [allWorkers]);

  async function load(overrides?: { from?: string; to?: string }) {
    const from = overrides?.from ?? dateFrom;
    const to = overrides?.to ?? dateTo;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (methodFilter[0] && methodFilter[0] !== "ALL") qs.set("method", methodFilter[0]);
      const eqs = new URLSearchParams();
      if (from) eqs.set("from", from);
      if (to) eqs.set("to", to);
      const [res, charges] = await Promise.all([
        apiGet<{
          items: PaymentListItem[];
          personTotals: Array<{ userId: string; displayName: string | null; total: number }>;
          totalPlatformFees: number;
          totalBusinessMargin: number;
          totalOverage?: number;
          totalShortfall?: number;
          totalRevenue?: number;
        }>(`/api/admin/payments${qs.toString() ? `?${qs}` : ""}`),
        apiGet<EquipmentCharge[]>(
          `/api/admin/payments/equipment-charges${eqs.toString() ? `?${eqs}` : ""}`
        ),
      ]);
      setItems(res.items ?? []);
      setPersonTotals(res.personTotals ?? []);
      setTotalPlatformFees(res.totalPlatformFees ?? 0);
      setTotalBusinessMargin(res.totalBusinessMargin ?? 0);
      setTotalOverage(res.totalOverage ?? 0);
      setTotalShortfall(res.totalShortfall ?? 0);
      setTotalRevenue(res.totalRevenue ?? 0);
      setEquipCharges(charges ?? []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load payments.", err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [dateFrom, dateTo, methodFilter]);

  // Listen for admin payment mutations (approve / adjust / reject / write
  // off in the Pending Approvals section, or edit/delete from this list).
  // Refetch with current filters so the row's badge + numbers update
  // immediately without a hard refresh.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener("seedlings:admin-payments-changed", onChanged);
    return () => window.removeEventListener("seedlings:admin-payments-changed", onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, methodFilter]);

  const grandTotal = useMemo(
    () => items.reduce((s, p) => s + p.amountPaid, 0),
    [items]
  );

  const totalExpenses = useMemo(
    () => items.reduce((s, p) => s + (p.occurrence?.expenses ?? []).reduce((es, e) => es + e.cost, 0), 0),
    [items]
  );

  const filteredItems = useMemo(() => {
    let rows = items;
    // Person filter (multi-select)
    if (personFilter.length > 0) {
      const ids = new Set(personFilter);
      rows = rows.filter((p) => p.splits.some((sp) => ids.has(sp.userId)));
    }
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((p) => {
        const prop = p.occurrence?.job?.property;
        const arr = [
          prop?.displayName || "",
          prop?.client?.displayName || "",
          p.method || "",
          p.note || "",
          ...p.splits.map((sp) => sp.user?.displayName || sp.user?.email || ""),
        ];
        return arr.some((v) => v.toLowerCase().includes(qlc));
      });
    }
    return rows;
  }, [items, q, personFilter]);

  const filteredCharges = useMemo(() => {
    let rows = equipCharges;
    if (personFilter.length > 0) {
      const ids = new Set(personFilter);
      rows = rows.filter((c) => ids.has(c.userId));
    }
    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((c) => {
        const arr = [c.equipment?.shortDesc || "", c.equipment?.brand || "", c.equipment?.model || ""];
        return arr.some((v) => v.toLowerCase().includes(qlc));
      });
    }
    return rows;
  }, [equipCharges, q, personFilter]);

  // Per-section pagination — Jobs and Equipment slice independently so
  // moving through either list doesn't drag the other along.
  // Totals (green panel) continue to be aggregated from the FULL
  // filtered set; pagination affects only which cards are visible.
  const jobsTotalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const jobsSafePage = Math.min(jobsPage, jobsTotalPages);
  const jobsPageStart = (jobsSafePage - 1) * pageSize;
  const jobsPageEnd = jobsPageStart + pageSize;
  const pagedItems = filteredItems.slice(jobsPageStart, jobsPageEnd);

  const equipTotalPages = Math.max(1, Math.ceil(filteredCharges.length / pageSize));
  const equipSafePage = Math.min(equipPage, equipTotalPages);
  const equipPageStart = (equipSafePage - 1) * pageSize;
  const equipPageEnd = equipPageStart + pageSize;
  const pagedCharges = filteredCharges.slice(equipPageStart, equipPageEnd);

  // Per-section pagination footer. Lives inline below each list section
  // (Jobs / Equipment) so each scrolls independently. Both footers share
  // the same `pageSize` state, so flipping the per-page selector in one
  // updates both. The pageSize selector lives in EACH footer for
  // ergonomics — you can change it without scrolling up.
  function renderPaginationFooter(opts: {
    totalCount: number;
    totalPages: number;
    safePage: number;
    pageStart: number;
    pageEnd: number;
    setPage: (updater: (n: number) => number) => void;
  }) {
    const { totalCount, totalPages, safePage, pageStart, pageEnd, setPage } = opts;
    if (totalCount === 0) return null;
    const start = pageStart + 1;
    const end = Math.min(pageEnd, totalCount);
    return (
      <HStack mt={2} justify="space-between" wrap="wrap" gap={2} fontSize="sm">
        <Text color="fg.muted">
          Showing {start}–{end} of {totalCount}
        </Text>
        <HStack gap={2} wrap="wrap">
          {totalPages > 1 && (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← Prev
              </Button>
              <Text color="fg.muted" fontSize="xs">
                Page {safePage} of {totalPages}
              </Text>
              <Button
                size="xs"
                variant="outline"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next →
              </Button>
            </>
          )}
          <HStack gap={1}>
            <Text color="fg.muted" fontSize="xs">Per page:</Text>
            <Select.Root
              collection={pageSizeCollection}
              value={[String(pageSize)]}
              onValueChange={(e) => setPageSize(Number(e.value[0]))}
              size="sm"
              positioning={{ strategy: "fixed", hideWhenDetached: true }}
              css={{ width: "auto", flex: "0 0 auto" }}
            >
              <Select.Control>
                <Select.Trigger w="auto" minW="0" px="2">
                  <Select.ValueText placeholder={String(pageSize)} />
                  <Select.Indicator />
                </Select.Trigger>
              </Select.Control>
              <Select.Positioner>
                <Select.Content>
                  {pageSizeItems.map((it) => (
                    <Select.Item key={it.value} item={it.value}>
                      <Select.ItemText>{it.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Select.Root>
          </HStack>
        </HStack>
      </HStack>
    );
  }

  // Any filter change should bring BOTH sections back to page 1 — otherwise
  // you'd be on page 5 of "all", flip a worker filter, and silently land
  // on what's now an empty page 5 of the narrower set.
  useEffect(() => {
    setJobsPage(1);
    setEquipPage(1);
  }, [q, personFilter, methodFilter, typeFilter, dateFrom, dateTo, pageSize]);

  // Green-summary totals derived client-side from the FILTERED visible rows
  // so the summary always describes what's on screen. The server returns
  // unfiltered totals (for the no-filter case), but applying the person /
  // search filters here means the summary updates instantly as the user
  // tweaks the filter chips — no extra round-trip and no stale numbers.
  //
  // Math mirrors services/payments.ts → listAllPayments. When personFilter
  // is empty, the result matches the server's totals exactly.
  const displayedTotals = useMemo(() => {
    let grandTotal = 0;
    let totalExpenses = 0;
    let totalPlatformFees = 0;
    let totalBusinessMargin = 0;
    let totalOverage = 0;
    let totalShortfall = 0;
    let totalRevenue = 0;
    // `hasPendingProjection` lights up the "Projection" chip in the summary
    // panel — operator should know when any of the visible numbers depend
    // on the pending-payment reconcileApproval projection (which can shift
    // when admin actually approves with a possibly-adjusted amount).
    let hasPendingProjection = false;
    const personMap = new Map<string, { displayName: string | null; total: number }>();
    const selectedPersons = personFilter.length > 0 ? new Set(personFilter) : null;
    for (const p of filteredItems) {
      const expensesSum = (p.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
      // Effective worker payouts:
      //   • Confirmed payments → sum of materialized PaymentSplit.amount
      //   • Pending payments (no splits yet) → fall back to the
      //     promisedPayouts snapshot. Otherwise pending-payment cash gets
      //     fully counted as "Net to Business" since workerPayouts = 0
      //     on empty splits, which inflates the business-kept total by
      //     the entire pending-payments pool.
      // promisedPayouts.net IS the expected per-worker payout for a
      // happy-path full collection. Contractor adjustments on underpay
      // are captured at approval time via shortfall/overage.
      let workerPayouts: number;
      const isPendingNoSplits = (p.splits ?? []).length === 0 && p.confirmed === false;
      const promised = isPendingNoSplits
        ? ((p.occurrence?.promisedPayouts ?? null) as Array<{ userId: string; net: number; fee: number; splitPercent: number; ratePercent: number; workerType: string | null }> | null)
        : null;
      grandTotal += p.amountPaid ?? 0;
      totalExpenses += expensesSum;
      if (promised && promised.length > 0) {
        hasPendingProjection = true;
        // Project the canonical reconcileApproval outcome for the pending
        // payment so the SAME decomposition that holds on confirmed
        // payments (Commission + Margin + Overage − Shortfall =
        // Net to Business) also holds on pending ones. Mirrors
        // services/payments.ts → reconcileApproval; if you change the
        // logic on the server, update this block too. The canonical math
        // is locked in by the server's payments.test.ts suite.
        const N = Math.max(0, (p.amountPaid ?? 0) - expensesSum);
        const totalPromisedPct = promised.reduce((s, r) => s + (r.splitPercent ?? 0), 0) || 100;
        let projectedWorkerPayouts = 0;
        let promisedCommission = 0;
        let promisedMargin = 0;
        for (const r of promised) {
          const normalized = (r.splitPercent / totalPromisedPct) * 100;
          const actualGross = N * (normalized / 100);
          const actualFee = actualGross * (r.ratePercent / 100);
          const actualNet = Math.max(0, actualGross - actualFee);
          const wt = r.workerType ?? null;
          const isEmployeeClass = wt === "EMPLOYEE" || wt === "TRAINEE";
          // Employee/trainee → made whole (paid promised net regardless).
          // Contractor / null → pro-rata loss on underpay, capped at promised.
          const paid = isEmployeeClass ? r.net : Math.min(actualNet, r.net);
          projectedWorkerPayouts += Math.max(0, paid);
          // Commission/margin lines use the PROMISED fee (matches the
          // confirmed-payment behavior so the identity holds — see
          // reconcileApproval comment about overpay double-count).
          if (isEmployeeClass) promisedMargin += r.fee ?? 0;
          else promisedCommission += r.fee ?? 0;
        }
        workerPayouts = projectedWorkerPayouts;
        totalPlatformFees += promisedCommission;
        totalBusinessMargin += promisedMargin;
        // Projected overage/shortfall: delta between what the business
        // actually retains and what was promised. Locks in the
        // decomposition identity above.
        const promisedRetained = promisedCommission + promisedMargin;
        const actualRetained = (p.amountPaid ?? 0) - expensesSum - projectedWorkerPayouts;
        const delta = actualRetained - promisedRetained;
        if (delta > 0) totalOverage += delta;
        if (delta < 0) totalShortfall += -delta;
      } else {
        // Confirmed (or legacy without promisedPayouts) — use the stamped
        // values written by reconcileApproval at approval time.
        workerPayouts = p.splits.reduce((s, sp) => s + sp.amount, 0);
        totalPlatformFees += p.platformFeeAmount ?? 0;
        totalBusinessMargin += p.businessMarginAmount ?? 0;
        totalOverage += (p as any).overageAmount ?? 0;
        totalShortfall += (p as any).shortfallAmount ?? 0;
      }
      totalRevenue += (p.amountPaid ?? 0) - workerPayouts - expensesSum;
      // Per-person bucket. For confirmed payments, use the materialized
      // splits. For pending payments, use promisedPayouts so employees'
      // guaranteed amounts show up; contractors are intentionally NOT
      // bucketed in this case because their final amount is contingent
      // on the collected vs. promised reconciliation at approval.
      if (promised && promised.length > 0) {
        const assigneesByUser = new Map(
          (p.occurrence?.assignees ?? []).map((a) => [a.userId, a]),
        );
        for (const r of promised) {
          if (selectedPersons && !selectedPersons.has(r.userId)) continue;
          const wt = r.workerType ?? assigneesByUser.get(r.userId)?.user?.workerType ?? null;
          const isEmployeeClass = wt === "EMPLOYEE" || wt === "TRAINEE";
          if (!isEmployeeClass) continue; // contractor pending → don't bucket
          const assignee = assigneesByUser.get(r.userId);
          const existing = personMap.get(r.userId);
          if (existing) existing.total += r.net;
          else personMap.set(r.userId, {
            displayName: assignee?.user?.displayName ?? assignee?.user?.email ?? null,
            total: r.net,
          });
        }
      } else {
        for (const sp of p.splits) {
          if (selectedPersons && !selectedPersons.has(sp.userId)) continue;
          const existing = personMap.get(sp.userId);
          if (existing) existing.total += sp.amount;
          else personMap.set(sp.userId, {
            displayName: sp.user?.displayName ?? sp.user?.email ?? null,
            total: sp.amount,
          });
        }
      }
    }
    const totalEquipCost = filteredCharges.reduce((s, c) => s + (c.rentalCost ?? 0), 0);
    // Per-user equipment cost (driven by filteredCharges, which already
    // respects the personFilter). Lets the per-person breakdown attribute
    // equipment debits to the specific contractor who incurred them, so
    // a mixed-crew worker-scoped view doesn't make the equipment look
    // like it applies to every selected worker.
    const equipmentByUser = new Map<string, number>();
    for (const c of filteredCharges) {
      if (c.rentalCost == null || c.rentalCost <= 0) continue;
      equipmentByUser.set(c.userId, (equipmentByUser.get(c.userId) ?? 0) + c.rentalCost);
    }

    // Runtime decomposition identity check. Locks in the rule that
    //   Net to Business = Commission + Margin + Overage − Shortfall
    // for confirmed payments (stamped by reconcileApproval) AND for
    // pending projections (computed by the loop above using the same
    // canonical math). A drift of more than a penny means the
    // projection has bug-walked away from the canonical math — log it
    // loudly + flag it in the UI so the operator notices immediately.
    // PENNY tolerance accounts for the residual-fix penny on splits.
    const PENNY = 0.011;
    const expectedNet = totalPlatformFees + totalBusinessMargin + totalOverage - totalShortfall;
    const identityDrift = Math.abs(totalRevenue - expectedNet);
    const mathOK = identityDrift <= PENNY;
    if (!mathOK && typeof window !== "undefined") {
      // Surface in the console so a developer running locally sees the
      // alert even if the visible badge gets dismissed mentally.
      console.warn(
        "[PaymentsTab] Net-to-Business identity drift",
        {
          netToBusiness: totalRevenue,
          expectedFromDecomposition: expectedNet,
          drift: identityDrift,
          totalPlatformFees, totalBusinessMargin, totalOverage, totalShortfall,
        },
      );
    }

    return {
      grandTotal,
      totalExpenses,
      totalPlatformFees,
      totalBusinessMargin,
      totalOverage,
      totalShortfall,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalEquipCost,
      // Per-user totals. `total` is the worker's earnings on the visible
      // payments. `equipment` is the contractor equipment debit attributed
      // to them (0 for employees/trainees — they don't pay for equipment).
      // `net` = earnings − equipment, which is the actual take-home for
      // a contractor on a mixed-crew worker-scoped view.
      personTotals: (() => {
        // Union of users that appear in payment splits OR equipment
        // charges, so a contractor who only had equipment in the window
        // (no payments) still gets a row.
        const userIds = new Set<string>([
          ...personMap.keys(),
          ...equipmentByUser.keys(),
        ]);
        return Array.from(userIds).map((userId) => {
          const fromPayments = personMap.get(userId);
          const equipment = Math.round((equipmentByUser.get(userId) ?? 0) * 100) / 100;
          const total = Math.round(((fromPayments?.total ?? 0)) * 100) / 100;
          // Fall back to whatever display name we have — pull from the
          // first equipment charge if no payment split carried one.
          const fallbackChargeUser = !fromPayments
            ? filteredCharges.find((c) => c.userId === userId)?.user
            : null;
          const displayName =
            fromPayments?.displayName
            ?? fallbackChargeUser?.displayName
            ?? fallbackChargeUser?.email
            ?? null;
          return {
            userId,
            displayName,
            total,
            equipment,
            net: Math.round((total - equipment) * 100) / 100,
          };
        });
      })(),
      /** Map of userId → equipment cost incurred (>$0 only). Empty when
       *  no equipment charges are in the visible window. */
      equipmentByUser: Object.fromEntries(equipmentByUser),
      /** Any pending payments included? Drives the "Projection" chip so
       *  the operator knows the numbers can shift at approval time. */
      hasPendingProjection,
      /** False iff the decomposition identity broke by more than a penny.
       *  Surfaces a visible warning in the summary panel; investigate
       *  the console log for the drift breakdown. */
      mathOK,
      identityDrift,
    };
  }, [filteredItems, filteredCharges, personFilter]);

  function openEdit(p: PaymentListItem) {
    setEditPayment(p);
    setEditAmount(p.amountPaid.toFixed(2));
    setEditMethod([p.method]);
    setEditNote(p.note ?? "");
    const map: Record<string, string> = {};
    p.splits.forEach((sp) => { map[sp.userId] = sp.amount.toFixed(2); });
    setEditSplits(map);
    setEditConfirm(false);
  }

  async function handleEditSave() {
    if (!editPayment) return;
    const amt = parseFloat(editAmount);
    if (isNaN(amt) || amt <= 0) {
      publishInlineMessage({ type: "WARNING", text: "Please enter a valid amount." });
      return;
    }
    if (!editConfirm) {
      setEditConfirm(true);
      return;
    }
    setEditBusy(true);
    try {
      const splits = editPayment.splits.map((sp) => ({
        userId: sp.userId,
        amount: parseFloat(editSplits[sp.userId] || "0"),
      }));
      await apiPatch(`/api/admin/payments/${editPayment.id}`, {
        amountPaid: amt,
        method: editMethod[0],
        note: editNote.trim() || null,
        splits,
      });
      publishInlineMessage({ type: "SUCCESS", text: composePaymentMessage("updated") });
      // Keep the alerts dropdown's "Payments to review" counter in
      // lockstep with the PaymentsTab list — edits can shift a row
      // between confirmed/unconfirmed buckets server-side, so the
      // badge needs to recount alongside.
      bumpAdminPayments();
      setEditPayment(null);
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Update payment failed.", err) });
    } finally {
      setEditBusy(false);
    }
  }

  async function doRevert(p: PaymentListItem, reason: string) {
    try {
      await apiPost(`/api/admin/payments/${p.id}/revert`, { reason: reason.trim() || null });
      // Revert always returns the occurrence to PENDING_PAYMENT and
      // ghost-cancels the auto-created next occurrence (see
      // services/jobs.ts updateOccurrence). Keep the extra context
      // about where the job lands now, since revert is the inverse of
      // approve and operators need to know what just happened.
      publishInlineMessage({
        type: "SUCCESS",
        text: composePaymentMessage("reverted", null, "The job is back to Pending Payment and the auto-created next occurrence (if any) was removed."),
      });
      // Revert un-confirms a payment, which puts the occurrence back
      // into the "Awaiting client payment" bucket — both the alerts
      // badge counter and any in-tab list need to recount.
      bumpAdminPayments();
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Revert failed.", err) });
    }
  }

  return (
    <Box w="full">
      {isSuper && <PendingApprovalsSection />}
      {isSuper && <OutstandingRequestsSection />}
      <HStack mb={2} gap={2}>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0} css={{ background: "var(--chakra-colors-gray-100)" }}>
          <RefreshCw size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          px="2"
          flexShrink={0}
          onClick={() => { setCompact((p) => !p); setExpandedCards(new Set()); }}
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
          onChange={setQ}
          inputId="admin-payments-search"
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
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          flexShrink={0}
          title={typeFilter[0] === "EQUIPMENT" ? "Export equipment charges (CSV)" : "Export job payments (CSV)"}
          css={{ background: "var(--chakra-colors-gray-100)" }}
          onClick={() => {
            // Tab-aware CSV: download mirrors what's on screen. Jobs tab
            // gets one row per PaymentSplit (worker payout); Equipment
            // tab gets one row per Checkout (contractor rental charge).
            // Use the FULL filtered set (not just the current paginated
            // page) so the download reflects everything that matches the
            // active filters. CSV escape is comma-stripping for compat
            // with simple consumers; not a full RFC-4180 quoted-string
            // implementation since the downstream is Excel-style ad-hoc.
            const stripCommas = (s: string) => s.replace(/,/g, "");
            const rows: string[] = [];
            let filenameTab: string;
            if (typeFilter[0] === "EQUIPMENT") {
              filenameTab = "equipment";
              rows.push("Worker,Equipment,Released,Days,Daily Rate,Charge");
              for (const c of filteredCharges) {
                const worker = stripCommas(c.user.displayName ?? c.user.email ?? c.user.id);
                const eqLabel = stripCommas(
                  [c.equipment.brand, c.equipment.model].filter(Boolean).join(" ") || c.equipment.shortDesc || "",
                );
                const released = c.releasedAt ? fmtDate(c.releasedAt) : "";
                const days = c.rentalDays != null ? String(c.rentalDays) : "";
                const rate = c.equipment.dailyRate != null ? c.equipment.dailyRate.toFixed(2) : "";
                const charge = c.rentalCost != null ? c.rentalCost.toFixed(2) : "";
                rows.push(`${worker},${eqLabel},${released},${days},${rate},${charge}`);
              }
            } else {
              // Jobs tab (default). One row per PaymentSplit — sp.amount
              // is the post-deduction payout (commission/margin/expenses
              // already removed at acceptance time).
              filenameTab = "jobs";
              rows.push("Worker,Type,Job,Date,Payout,Method");
              for (const p of filteredItems) {
                const prop = p.occurrence?.job?.property;
                for (const sp of p.splits) {
                  const name = stripCommas(sp.user?.displayName ?? sp.user?.email ?? sp.userId);
                  const wType = (sp.user as any)?.workerType ?? "UNCLASSIFIED";
                  const jobName = stripCommas(`${prop?.displayName ?? ""} - ${prop?.client?.displayName ?? ""}`);
                  const date = p.createdAt ? fmtDate(p.createdAt) : "";
                  rows.push(`${name},${wType},${jobName},${date},${sp.amount.toFixed(2)},${methodLabel(p.method)}`);
                }
              }
            }
            const blob = new Blob([rows.join("\n")], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `payments-${filenameTab}-${dateFrom || "all"}-to-${dateTo || "all"}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download size={14} />
        </Button>
      </HStack>
      {/* Timeframe — always visible, identical to the worker Payments view
          so the preset + custom-date control is consistent across roles. */}
      <HStack mb={2} gap={2} align="center" wrap="wrap">
        <DateInput value={dateFrom} onChange={(val) => { setDateFrom(val); setDatePreset(null); if (dateTo && val && val > dateTo) setDateTo(val); }} />
        <Text fontSize="sm">–</Text>
        <DateInput value={dateTo} onChange={(val) => { setDateTo(val); setDatePreset(null); if (dateFrom && val && val < dateFrom) setDateFrom(val); }} />
        <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
          <Badge size="sm" colorPalette="green" variant="subtle" cursor="pointer" onClick={() => setQuickDateMenuOpen((v) => !v)}>
            {datePreset ? (PRESET_LABELS[datePreset] ?? datePreset) : (dateFrom || dateTo) ? "Custom dates" : "Last month"}
            {" "}<Box as="span" display="inline-flex" alignItems="center" justifyContent="center" w="14px" h="14px" borderRadius="full" bg="green.500" color="white" verticalAlign="middle"><ChevronDown size={9} /></Box>
          </Badge>
          {quickDateMenuOpen && (
            <VStack position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px"
              ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 148))}px`; } }}>
              {quickDateItems.map((it) => (
                <Button key={it.value} size="xs" variant={datePreset === it.value ? "solid" : "ghost"} colorPalette={datePreset === it.value ? "green" : undefined} w="full" justifyContent="start"
                  onClick={() => { setQuickDateMenuOpen(false); applyPreset(it.value as DatePreset); }}>
                  {it.label}
                </Button>
              ))}
            </VStack>
          )}
        </Box>
      </HStack>
      {!filtersOpen && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          {/* typeFilter is now the tab; no chip needed. */}
          {/* Method chip is Jobs-only (matches the filter UI scope above). */}
          {typeFilter[0] === "JOBS" && methodFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="blue" variant="solid">
              {methodFilterItems.find((i) => i.value === methodFilter[0])?.label}
            </Badge>
          )}
          {personFilter.map((id) => (
            <Badge key={id} size="sm" colorPalette="teal" variant="solid">
              {personNameMap[id] || "Loading…"}
            </Badge>
          ))}
          {q && <Badge size="sm" colorPalette="gray" variant="subtle">"{q}"</Badge>}
          {!((typeFilter[0] !== "JOBS" || methodFilter[0] === "ALL") && personFilter.length === 0 && !q && datePreset) && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setTypeFilter(["JOBS"]);
                setMethodFilter(["ALL"]);
                setPersonFilter([]);
                setPersonSearch("");
                setQ("");
                applyPreset("lastMonth");
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      {filtersOpen && <Box borderWidth="1px" borderColor="gray.300" borderRadius="md" bg="gray.100" p={2} pb={0} mb={2} css={{ "& button": { borderColor: "var(--chakra-colors-gray-400)" } }}>
      <HStack mb={2} gap={2} wrap="nowrap">
        {/* Method filter is Jobs-only — equipment rentals don't have a
            payment method (they're a per-checkout charge to the
            contractor, not a client transaction). Hidden on the Equipment
            tab; the value persists so switching back restores it. */}
        {typeFilter[0] === "JOBS" && (
        <Select.Root
          collection={methodFilterCollection}
          value={methodFilter}
          onValueChange={(e) => setMethodFilter(e.value)}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: methodFilter[0] !== "ALL" ? "var(--chakra-colors-blue-200)" : "var(--chakra-colors-blue-100)", border: methodFilter[0] !== "ALL" ? "1px solid var(--chakra-colors-blue-400)" : "1px solid var(--chakra-colors-blue-300)", borderRadius: "6px" }}>
              <CreditCard size={14} />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {methodFilterItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        )}
        <Box ref={personDropRef} position="relative" css={{ flex: "0 0 auto" }}>
          <Input
            size="sm"
            w="200px"
            placeholder={personFilter.length > 0
              ? personFilter.map((id) => personNameMap[id] || "Loading…").join(", ")
              : "All Workers"}
            value={personSearch}
            onChange={(e) => {
              setPersonSearch(e.target.value);
              if (!personDropOpen) setPersonDropOpen(true);
            }}
            onFocus={() => {
              setPersonDropOpen(true);
              setPersonSearch("");
            }}
          />
          {personDropOpen && (() => {
            const searchLc = personSearch.toLowerCase();
            const filtered = personSearch
              ? personItems.filter((it) => it.label.toLowerCase().includes(searchLc))
              : personItems;
            const limited = filtered.slice(0, 10);
            const hasMore = filtered.length > 10;
            return (
              <Box
                position="fixed"
                zIndex={9999}
                bg="white"
                borderWidth="1px"
                borderColor="gray.200"
                rounded="md"
                shadow="lg"
                w="240px"
                mt="1"
                ref={(el: HTMLDivElement | null) => {
                  if (el && personDropRef.current) {
                    const rect = personDropRef.current.getBoundingClientRect();
                    el.style.top = `${rect.bottom + 4}px`;
                    el.style.left = `${rect.left}px`;
                  }
                }}
              >
                <Box maxH="250px" overflowY="auto">
                  {limited.map((it) => (
                    <Box
                      key={it.value}
                      px="3"
                      py="1.5"
                      fontSize="sm"
                      cursor="pointer"
                      bg={personFilter.includes(it.value) ? "teal.50" : undefined}
                      _hover={{ bg: "gray.100" }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setPersonFilter((prev) =>
                          prev.includes(it.value)
                            ? prev.filter((id) => id !== it.value)
                            : [...prev, it.value]
                        );
                      }}
                    >
                      <HStack gap={2}>
                        <Text flex="1">{it.label}</Text>
                        {personFilter.includes(it.value) && <Text color="teal.500" fontWeight="bold">✓</Text>}
                      </HStack>
                    </Box>
                  ))}
                  {hasMore && !personSearch && (
                    <Text fontSize="xs" color="fg.muted" px="3" py="2" fontStyle="italic">
                      …{filtered.length - 10} more — type to search
                    </Text>
                  )}
                  {filtered.length === 0 && (
                    <Text fontSize="xs" color="fg.muted" px="3" py="2">No matches</Text>
                  )}
                </Box>
              </Box>
            );
          })()}
        </Box>
      </HStack>
      <HStack mb={2} gap={2} align="center">
        <DateInput value={dateFrom} onChange={(val) => { setDateFrom(val); setDatePreset(null); if (dateTo && val && val > dateTo) setDateTo(val); }} />
        <Text fontSize="sm">–</Text>
        <DateInput value={dateTo} onChange={(val) => { setDateTo(val); setDatePreset(null); if (dateFrom && val && val < dateFrom) setDateFrom(val); }} />
        <Select.Root
          collection={quickDateCollection}
          value={quickDate}
          onValueChange={(e) => {
            setQuickDate(e.value);
            const val = e.value[0] as DatePreset;
            if (!val) return;
            applyPreset(val);
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
      {((typeFilter[0] === "JOBS" && methodFilter[0] !== "ALL") || personFilter.length > 0 || datePreset || dateFrom || dateTo) && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
            <Badge size="sm" colorPalette="green" variant="subtle" cursor="pointer" onClick={() => setQuickDateMenuOpen((v) => !v)}>
              {datePreset ? (PRESET_LABELS[datePreset] ?? datePreset) : (dateFrom || dateTo) ? "Custom dates" : "Last month"}
              {" "}<Box as="span" display="inline-flex" alignItems="center" justifyContent="center" w="14px" h="14px" borderRadius="full" bg="green.500" color="white" verticalAlign="middle"><ChevronDown size={9} /></Box>
            </Badge>
            {quickDateMenuOpen && (
              <VStack position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px"
                ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 148))}px`; } }}>
                {quickDateItems.map((it) => (
                  <Button key={it.value} size="xs" variant={datePreset === it.value ? "solid" : "ghost"} colorPalette={datePreset === it.value ? "green" : undefined} w="full" justifyContent="start"
                    onClick={() => { setQuickDateMenuOpen(false); applyPreset(it.value as DatePreset); }}>
                    {it.label}
                  </Button>
                ))}
              </VStack>
            )}
          </Box>
          {/* typeFilter is now the tab; no chip needed. */}
          {/* Method chip is Jobs-only (matches the filter UI scope above). */}
          {typeFilter[0] === "JOBS" && methodFilter[0] !== "ALL" && (
            <Badge size="sm" colorPalette="blue" variant="solid">
              {methodFilterItems.find((i) => i.value === methodFilter[0])?.label}
            </Badge>
          )}
          {personFilter.map((id) => (
            <Badge key={id} size="sm" colorPalette="teal" variant="solid">
              {personNameMap[id] || "Loading…"}
            </Badge>
          ))}
          {!((typeFilter[0] !== "JOBS" || methodFilter[0] === "ALL") && personFilter.length === 0 && datePreset) && (
            <Badge
              size="sm"
              colorPalette="red"
              variant="outline"
              cursor="pointer"
              onClick={() => {
                setTypeFilter(["JOBS"]);
                setMethodFilter(["ALL"]);
                setPersonFilter([]);
                setPersonSearch("");
                applyPreset("lastMonth");
              }}
            >
              ✕ Clear
            </Badge>
          )}
        </HStack>
      )}
      </Box>}

      {(() => {
        // The summary panel ALWAYS aggregates both Jobs and Equipment
        // regardless of which sub-tab is active — switching tabs changes
        // the LIST below but the totals at the top remain the business
        // overview. Per operator preference.
        const showJobs = true;
        const showEquip = true;
        // When one or more workers are selected, the green panel switches
        // into a WORKER-SCOPED view: Total = sum of those workers' splits
        // (their actual earnings on the visible payments), and the
        // business-side rows (Commission / Margin / Overage / Shortfall /
        // Total Revenue) are hidden — they describe what the BUSINESS kept
        // across the whole team, which is meaningless for a worker scope.
        // When no person filter is active, the panel shows the full
        // business-side summary as before.
        const workerScoped = personFilter.length > 0;
        const selectedEarnings = displayedTotals.personTotals.reduce((s, p) => s + p.total, 0);
        const visibleExpenses = showJobs && !workerScoped ? displayedTotals.totalExpenses : 0;
        const totalEquipCost = showEquip ? displayedTotals.totalEquipCost : 0;
        const visibleTotal = showJobs
          ? (workerScoped ? selectedEarnings : displayedTotals.grandTotal)
          : 0;
        // Worker-scoped: equipment is a DEDUCTION from the worker's
        // take-home (they paid the business to use it).
        // Admin/unscoped: equipment is INCOME to the business (contractor
        // → business cash flow), so it ADDS to the business total below.
        // See memory/project_equipment_rental_income.md for the policy.
        const equipmentIsBusinessIncome = !workerScoped;
        const workerSidedeductions = workerScoped ? visibleExpenses + totalEquipCost : 0;
        const workerScopedNet = visibleTotal - workerSidedeductions;
        // Final Net to Business for the admin view: job-side retention
        // (Commission + Margin + Overage − Shortfall — covered by the
        // identity check in displayedTotals) PLUS equipment rental income.
        const netToBusinessFinal = displayedTotals.totalRevenue + (equipmentIsBusinessIncome ? totalEquipCost : 0);
        return (
      <Box mb={3} p={3} bg="green.50" rounded="md">
        {/* Status chips on top of the summary:
            • Projection — visible iff any pending-approval payment is in
              the visible set; signals the totals can shift at approval.
            • Math check failed — visible iff the decomposition identity
              breaks; investigate the console for the breakdown. */}
        {(displayedTotals.hasPendingProjection || !displayedTotals.mathOK) && (
          <HStack gap={2} mb={1} wrap="wrap">
            {displayedTotals.hasPendingProjection && (
              <Badge
                size="sm"
                colorPalette="orange"
                variant="subtle"
                title="One or more visible payments are pending approval. Numbers below are projected from the canonical reconciliation math and may shift when admin approves (especially if the collected amount is adjusted at approval)."
              >
                Projected on approval
              </Badge>
            )}
            {!displayedTotals.mathOK && (
              <Badge
                size="sm"
                colorPalette="red"
                variant="solid"
                title={`Decomposition identity broke by $${displayedTotals.identityDrift.toFixed(4)}. Expected Net to Business = Commission + Margin + Overage − Shortfall. Open the console for the breakdown.`}
              >
                ⚠ Math check failed
              </Badge>
            )}
          </HStack>
        )}
        {/* Top section — gross collected from clients + worker-scoped
            deductions if a worker filter is on (the contractor view sees
            equipment as a debit against their take-home). */}
        <Box
          display="grid"
          gridTemplateColumns="1fr auto"
          rowGap={0.5}
          columnGap={4}
          css={{ fontVariantNumeric: "tabular-nums" }}
        >
          {showJobs && (
            <>
              <Text fontSize="lg" fontWeight="bold" color="green.700" title={workerScoped ? "Sum of the selected workers' splits on the visible payments." : "Gross collected on the visible payments before any deductions — what came in from clients."}>
                {workerScoped ? "Earnings" : "Gross Collected"}
              </Text>
              <Text fontSize="lg" fontWeight="bold" color="green.700" textAlign="right">
                ${visibleTotal.toFixed(2)}
              </Text>
            </>
          )}
          {workerScoped && visibleExpenses > 0 && (
            <>
              <Text fontSize="sm" color="orange.600">Expenses</Text>
              <Text fontSize="sm" color="orange.600" textAlign="right">−${visibleExpenses.toFixed(2)}</Text>
            </>
          )}
          {/* Worker-scoped equipment: aggregating it at the top as a
              single deduction is misleading when the crew is mixed
              (only contractors pay for equipment). Equipment is now
              attributed per-worker in the breakdown below. The combined
              Net line still sums correctly across all selected workers. */}
          {workerScoped && showJobs && (visibleExpenses > 0 || totalEquipCost > 0) && (
            <>
              <Text fontSize="lg" fontWeight="bold" color="green.700">Combined Net</Text>
              <Text fontSize="lg" fontWeight="bold" color={workerScopedNet < 0 ? "red.700" : "green.700"} textAlign="right">${workerScopedNet.toFixed(2)}</Text>
            </>
          )}
          {!showJobs && totalEquipCost > 0 && !equipmentIsBusinessIncome && (
            <>
              <Text fontSize="lg" fontWeight="bold" color="orange.600">Equipment Total</Text>
              <Text fontSize="lg" fontWeight="bold" color="orange.600" textAlign="right">−${totalEquipCost.toFixed(2)}</Text>
            </>
          )}
          {/* Admin-only equipment-only view (typeFilter = Equipment, no
              worker filter) — equipment IS the income, show the total. */}
          {!showJobs && totalEquipCost > 0 && equipmentIsBusinessIncome && (
            <>
              <Text fontSize="lg" fontWeight="bold" color="green.700">Equipment Rental Income</Text>
              <Text fontSize="lg" fontWeight="bold" color="green.700" textAlign="right">${totalEquipCost.toFixed(2)}</Text>
            </>
          )}
          {/* Admin job-expenses line — shown in the top section because
              expenses are a true deduction from job revenue (the
              business buys gas, mulch, etc. on the company card to
              service the job). Equipment is NOT shown here. */}
          {!workerScoped && visibleExpenses > 0 && showJobs && (
            <>
              <Text fontSize="sm" color="orange.600">Job Expenses</Text>
              <Text fontSize="sm" color="orange.600" textAlign="right">−${visibleExpenses.toFixed(2)}</Text>
            </>
          )}
        </Box>
        {showJobs && !workerScoped && (displayedTotals.totalPlatformFees > 0 || displayedTotals.totalBusinessMargin > 0 || displayedTotals.totalOverage > 0 || displayedTotals.totalShortfall > 0 || (equipmentIsBusinessIncome && totalEquipCost > 0)) && (
          <Box
            mt={2}
            pt={2}
            borderTopWidth="1px"
            borderTopColor="green.200"
            display="grid"
            gridTemplateColumns="1fr auto"
            rowGap={0.5}
            columnGap={4}
            css={{ fontVariantNumeric: "tabular-nums" }}
          >
            {displayedTotals.totalPlatformFees > 0 && (
              <>
                <Text fontSize="sm" fontWeight="medium" color="blue.600">Contractor Commission</Text>
                <Text fontSize="sm" fontWeight="medium" color="blue.600" textAlign="right">${displayedTotals.totalPlatformFees.toFixed(2)}</Text>
              </>
            )}
            {displayedTotals.totalBusinessMargin > 0 && (
              <>
                <Text fontSize="sm" fontWeight="medium" color="blue.600">Employee Business Margin</Text>
                <Text fontSize="sm" fontWeight="medium" color="blue.600" textAlign="right">${displayedTotals.totalBusinessMargin.toFixed(2)}</Text>
              </>
            )}
            {displayedTotals.totalOverage > 0 && (
              <>
                <Text fontSize="sm" fontWeight="medium" color="green.600">Overage retained</Text>
                <Text fontSize="sm" fontWeight="medium" color="green.600" textAlign="right">${displayedTotals.totalOverage.toFixed(2)}</Text>
              </>
            )}
            {displayedTotals.totalShortfall > 0 && (
              <>
                <Text fontSize="sm" fontWeight="medium" color="red.600">Shortfall absorbed</Text>
                <Text fontSize="sm" fontWeight="medium" color="red.600" textAlign="right">−${displayedTotals.totalShortfall.toFixed(2)}</Text>
              </>
            )}
            {/* Net from Jobs — sums Commission + Margin + Overage − Shortfall.
                This is the line covered by the decomposition identity check
                in `displayedTotals`. The next line (Equipment Rental
                Income) adds on top to arrive at the final Net to Business. */}
            <Text fontSize="sm" fontWeight="medium" color="blue.700" title="What the business kept on the visible job payments: collected − worker payouts − job expenses. Includes commission, margin, and any overage; net of shortfalls absorbed on underpaid jobs. Excludes equipment rental income (added separately below).">
              Net from Jobs
            </Text>
            <Text fontSize="sm" fontWeight="medium" color="blue.700" textAlign="right">
              ${displayedTotals.totalRevenue.toFixed(2)}
            </Text>
            {/* Equipment rental income — additive. Contractors pay the
                business to use equipment; that's income on the LLC's
                books. Routed to QB Income / Schedule C as "Equipment
                Rental Income". See memory/project_equipment_rental_income.md. */}
            {equipmentIsBusinessIncome && totalEquipCost > 0 && (
              <>
                <Text fontSize="sm" fontWeight="medium" color="green.700" title="Contractor equipment rentals are income to the business — they pay to use company-owned equipment. Flows to QB Income export as 'Equipment Rental Income'.">
                  + Equipment Rental Income
                </Text>
                <Text fontSize="sm" fontWeight="medium" color="green.700" textAlign="right">
                  ${totalEquipCost.toFixed(2)}
                </Text>
              </>
            )}
            {/* Final business net — jobs + equipment combined. */}
            <Text fontSize="sm" fontWeight="bold" color="blue.700" title="Total cash the business kept across the visible payments: Net from Jobs + Equipment Rental Income.">
              Net to Business
            </Text>
            <Text fontSize="sm" fontWeight="bold" color="blue.700" textAlign="right">
              ${netToBusinessFinal.toFixed(2)}
            </Text>
          </Box>
        )}
        {showJobs && displayedTotals.personTotals.length > 0 && (
          /* Per-person section is visually separated from the
             aggregate-totals area above — distinct sub-card so the
             operator can scan worker payouts as their own data block. */
          <Box
            mt={3}
            pt={2}
            px={2}
            pb={1}
            bg="green.100"
            borderRadius="md"
            borderWidth="1px"
            borderColor="green.200"
          >
            <Text fontSize="xs" color="green.900" fontWeight="semibold" textTransform="uppercase" letterSpacing="wider" mb={1}>
              {workerScoped ? "Per-person breakdown" : "Per-person (net of expenses & fees)"}
            </Text>
            <Box
              display="grid"
              gridTemplateColumns="1fr auto"
              rowGap={0.5}
              columnGap={4}
              css={{ fontVariantNumeric: "tabular-nums" }}
            >
              {displayedTotals.personTotals.map((p) => {
                const hasEquipment = (p.equipment ?? 0) > 0;
                // When equipment is involved (worker-scoped, mixed crew),
                // expand the row to a 3-line block: earnings, equipment,
                // net. Otherwise keep the compact one-liner.
                if (workerScoped && hasEquipment) {
                  return (
                    <Fragment key={p.userId}>
                      <Box gridColumn="1 / -1" mt={1.5}>
                        <Text fontSize="sm" color="green.900" fontWeight="semibold">
                          {p.displayName ?? p.userId}
                        </Text>
                      </Box>
                      <Text fontSize="xs" color="green.800" pl={3}>Earnings</Text>
                      <Text fontSize="xs" color="green.800" textAlign="right">${p.total.toFixed(2)}</Text>
                      <Text fontSize="xs" color="orange.700" pl={3}>Equipment</Text>
                      <Text fontSize="xs" color="orange.700" textAlign="right">−${(p.equipment ?? 0).toFixed(2)}</Text>
                      <Text fontSize="sm" color={p.net < 0 ? "red.700" : "green.800"} fontWeight="semibold" pl={3}>Net</Text>
                      <Text fontSize="sm" color={p.net < 0 ? "red.700" : "green.800"} fontWeight="semibold" textAlign="right">${(p.net ?? 0).toFixed(2)}</Text>
                    </Fragment>
                  );
                }
                return (
                  <Fragment key={p.userId}>
                    <Text fontSize="sm" color="green.800">{p.displayName ?? p.userId}</Text>
                    <Text fontSize="sm" color="green.800" fontWeight="medium" textAlign="right">${p.total.toFixed(2)}</Text>
                  </Fragment>
                );
              })}
            </Box>
          </Box>
        )}
      </Box>
        );
      })()}

      {/* Sub-tab bar — Jobs vs. Equipment. See the matching block in
          WorkerPayments for the rationale. */}
      <HStack gap={0} mb={2} borderWidth="1px" borderColor="gray.300" borderRadius="md" overflow="hidden" w="full">
        {typeFilterItems.map((it) => {
          const isActive = typeFilter[0] === it.value;
          const count = it.value === "JOBS" ? filteredItems.length : filteredCharges.length;
          return (
            <Button
              key={it.value}
              size="sm"
              variant="ghost"
              borderRadius="0"
              flex="1"
              fontWeight={isActive ? "semibold" : "normal"}
              bg={isActive ? "purple.100" : "transparent"}
              color={isActive ? "purple.800" : "fg.muted"}
              _hover={{ bg: isActive ? "purple.200" : "gray.100" }}
              onClick={() => setTypeFilter([it.value])}
            >
              {it.label} ({count})
            </Button>
          );
        })}
      </HStack>

      {loading && items.length === 0 && equipCharges.length === 0 && <LoadingCenter />}
      <Box position="relative">
        {loading && (items.length > 0 || equipCharges.length > 0) && (<>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>)}
      {typeFilter[0] === "JOBS" && filteredItems.length === 0 && (
        <Text color="fg.muted" p="8">No job payments found.</Text>
      )}
      {typeFilter[0] === "EQUIPMENT" && filteredCharges.length === 0 && (
        <Text color="fg.muted" p="8">No equipment charges found.</Text>
      )}

      {typeFilter[0] === "JOBS" && <VStack align="stretch" gap={2}>
        {pagedItems.map((p) => {
          const prop = p.occurrence?.job?.property;
          const client = prop?.client;
          const cardId = `ap-${p.id}`;
          const isCardCompact = compact && !expandedCards.has(cardId);
          const toggleCard = compact ? () => setExpandedCards((prev) => {
            const next = new Set(prev);
            next.has(cardId) ? next.delete(cardId) : next.add(cardId);
            return next;
          }) : undefined;
          return (
            <Card.Root
              key={p.id}
              variant="outline"
              css={compact ? { cursor: "pointer" } : undefined}
              onClick={(e: any) => {
                if (!toggleCard) return;
                if ((e.target as HTMLElement)?.closest?.("a, button")) return;
                toggleCard();
              }}
            >
              <Card.Body py="2" px="3">
                {isCardCompact ? (
                  <HStack justify="space-between" align="center">
                    <Text fontSize="md" fontWeight="semibold" truncate>
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && <> — {clientLabel(client.displayName)}</>}
                    </Text>
                    <HStack gap={2} flexShrink={0}>
                      {p.confirmed === false && !(p as any).writtenOff && !(p as any).skippedAt && (
                        <Badge size="sm" colorPalette="orange" variant="subtle">Pending</Badge>
                      )}
                      {(p as any).writtenOff && !(p as any).skippedAt && (
                        <Badge size="sm" colorPalette="red" variant="solid">Written off</Badge>
                      )}
                      {(p as any).skippedAt && (
                        <Badge size="sm" colorPalette="gray" variant="solid" title="Super-erased — treated as if the service never happened. Excluded from every income/payroll/1099 aggregate.">
                          Skipped
                        </Badge>
                      )}
                      <Badge size="sm" colorPalette="gray">{methodLabel(p.method)}</Badge>
                      <Text
                        fontWeight="bold"
                        color={(p as any).skippedAt ? "gray.500" : (p as any).writtenOff ? "red.700" : "green.700"}
                        textDecoration={(p as any).skippedAt ? "line-through" : undefined}
                        fontSize="lg"
                      >
                        ${p.amountPaid.toFixed(2)}
                      </Text>
                    </HStack>
                  </HStack>
                ) : (
                <Stack direction={{ base: "column", sm: "row" }} justify="space-between" align={{ base: "stretch", sm: "start" }} gap={2} w="full">
                  <VStack align="start" gap={0} flex="1" minW={0}>
                    <Text fontSize="md" fontWeight="semibold">
                      {prop?.displayName ?? "Unknown property"}
                      {client?.displayName && (
                        <> — {clientLabel(client.displayName)}</>
                      )}
                    </Text>
                    <HStack gap={2} wrap="wrap" fontSize="xs">
                      {prop?.displayName && (
                        <TextLink
                          text="Property"
                          onClick={() => openEventSearch("paymentsTabToPropertiesTabSearch", prop.displayName, forAdmin, prop.id)}
                        />
                      )}
                      {client?.displayName && (
                        <TextLink
                          text="Client"
                          onClick={() => openEventSearch("paymentsTabToClientsTabSearch", client.displayName, forAdmin, client.id)}
                        />
                      )}
                      {prop?.displayName && (
                        <TextLink
                          text="Job"
                          onClick={() => openEventSearch("paymentsTabToServicesTabSearch", prop.displayName, forAdmin, p.occurrence?.id, p.occurrence?.startAt ?? null)}
                        />
                      )}
                    </HStack>
                    {p.occurrence?.startAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {fmtDate(p.occurrence.startAt)}
                      </Text>
                    )}
                    <Text fontSize="xs" color="fg.muted">
                      {methodLabel(p.method)}
                      {p.note ? ` — ${p.note}` : ""}
                    </Text>
                    {(p.processorFeeAmount ?? 0) > 0 && (
                      <Text fontSize="xs" color="fg.muted">
                        Processor fee −${(p.processorFeeAmount ?? 0).toFixed(2)} · Net received ${(p.netReceived ?? 0).toFixed(2)}
                      </Text>
                    )}
                    {p.collectedBy && (
                      <Text fontSize="xs" color="fg.muted">
                        Collected by {p.collectedBy.displayName ?? (p.collectedBy as any).email ?? "unknown"}
                      </Text>
                    )}
                    {p.createdAt && (
                      <Text fontSize="xs" color="fg.muted">
                        {fmtDate(p.createdAt)}
                      </Text>
                    )}
                    {(() => {
                      // Derive the rows we'll display + use for the headline.
                      // Three sources, in priority order:
                      //   1. Real PaymentSplit rows (post-approval)
                      //   2. promisedPayouts snapshot joined with assignees
                      //      (pre-approval — the canonical "what we owe each
                      //      worker for an in-full collection")
                      //   3. Empty (legacy occurrences with neither)
                      // The contingent flag captures the policy:
                      //   • Employees + trainees: guaranteed promised net
                      //     even on pending payments (made-whole).
                      //   • Contractors / null: contingent until admin
                      //     approves with a final collected amount.
                      const isPending = p.confirmed === false && !(p as any).writtenOff;
                      type DerivedRow = {
                        userId: string;
                        name: string;
                        workerType: string | null | undefined;
                        share: number | null;     // gross share of pool
                        rate: number | null;       // fee %
                        deduction: number | null;  // fee dollars
                        payout: number;            // what they actually get (or will get)
                        topUp: number | null;
                        isOwner: boolean;
                        sharePctLabel: number | null;
                        /** True iff this worker's payout is NOT guaranteed until
                         *  admin approval — contractors on pending payments. */
                        contingent: boolean;
                      };
                      const realSplits = p.splits ?? [];
                      const promisedRows = (p.occurrence?.promisedPayouts ?? null) as Array<{
                        userId: string; workerType: string | null;
                        splitPercent: number; gross: number; ratePercent: number;
                        fee: number; net: number;
                      }> | null;
                      const assigneesByUser = new Map(
                        (p.occurrence?.assignees ?? []).map((a) => [a.userId, a]),
                      );
                      let derived: DerivedRow[] = [];
                      if (realSplits.length > 0) {
                        const totalGross = realSplits.reduce((s, sp) => s + ((sp as any).grossAmount ?? 0), 0);
                        derived = realSplits.map((sp) => {
                          const g = (sp as any).grossAmount as number | null;
                          const fee = (sp as any).feeAmount as number | null;
                          const rate = (sp as any).ratePercent as number | null;
                          const topUp = (sp as any).topUpAmount as number | null;
                          return {
                            userId: sp.userId,
                            name: sp.user?.displayName ?? sp.user?.email ?? sp.userId,
                            workerType: sp.user?.workerType,
                            share: g,
                            rate: rate,
                            deduction: fee,
                            payout: sp.amount,
                            topUp,
                            isOwner: (sp as any).ownerEarnings === true,
                            sharePctLabel: totalGross > 0 && g != null ? Math.round((g / totalGross) * 100) : null,
                            contingent: false, // already paid; not contingent
                          };
                        });
                      } else if (promisedRows && promisedRows.length > 0) {
                        // Synthesize rows from the promisedPayouts snapshot.
                        // Employees + trainees: guaranteed (made-whole policy).
                        // Contractors / unclassified: contingent until approval.
                        derived = promisedRows.map((r) => {
                          const assignee = assigneesByUser.get(r.userId);
                          const wt = r.workerType ?? assignee?.user?.workerType ?? null;
                          const isEmployeeClass = wt === "EMPLOYEE" || wt === "TRAINEE";
                          return {
                            userId: r.userId,
                            name: assignee?.user?.displayName ?? assignee?.user?.email ?? r.userId,
                            workerType: wt,
                            share: r.gross,
                            rate: r.ratePercent,
                            deduction: r.fee,
                            // Employees keep their promised net; contractors
                            // sit at $0 until reconciliation determines the
                            // actual amount (which may shrink on underpay).
                            payout: isEmployeeClass ? r.net : 0,
                            topUp: null,
                            isOwner: false,
                            sharePctLabel: Math.round(r.splitPercent),
                            contingent: !isEmployeeClass,
                          };
                        });
                      }
                      if (derived.length === 0) return null;
                      const selectedSet = personFilter.length > 0 ? new Set(personFilter) : null;
                      return (
                        <VStack align="start" gap={1} mt={0.5}>
                          {derived.map((row) => {
                            const isSelected = selectedSet?.has(row.userId) ?? false;
                            const isEmployeeClass = row.workerType === "EMPLOYEE" || row.workerType === "TRAINEE";
                            const deductionLabel = isEmployeeClass ? "margin" : "commission";
                            // Pending + contingent contractor: show the
                            // promised amount as "promised" rather than the
                            // payout (which is $0 until approval). This
                            // tells the operator the contractor's expected
                            // upside without conflating it with what's been
                            // guaranteed.
                            const showPromised = row.contingent && isPending && row.share != null && row.deduction != null;
                            return (
                              <Box
                                key={row.userId}
                                fontSize="xs"
                                w="full"
                                px={selectedSet ? 1.5 : 0}
                                py={selectedSet ? 1 : 0}
                                borderRadius={selectedSet ? "sm" : undefined}
                                bg={isSelected ? "green.50" : undefined}
                                borderLeftWidth={isSelected ? "3px" : undefined}
                                borderLeftColor={isSelected ? "green.500" : undefined}
                              >
                                <HStack gap={1} wrap="wrap" align="center">
                                  <Text fontWeight="medium" color={row.isOwner ? "purple.700" : "green.700"}>
                                    {row.name}
                                    {row.sharePctLabel != null ? ` (${row.sharePctLabel}%)` : ""}
                                  </Text>
                                  {row.isOwner && (
                                    <Badge size="sm" colorPalette="purple" variant="subtle" title="Owner's earnings — excluded from Gusto payroll and QB labor expense.">
                                      Owner Earnings
                                    </Badge>
                                  )}
                                  {row.contingent && isPending && (
                                    <Badge size="sm" colorPalette="orange" variant="subtle" title="Contractor pay is contingent on the collected amount; reconciled at admin approval.">
                                      Contingent
                                    </Badge>
                                  )}
                                  {!row.contingent && isPending && isEmployeeClass && (
                                    <Badge size="sm" colorPalette="green" variant="subtle" title="Employees + trainees are paid the promised net regardless of what the client pays.">
                                      Guaranteed
                                    </Badge>
                                  )}
                                </HStack>
                                {row.share != null && row.deduction != null && row.rate != null ? (
                                  <Text fontSize="2xs" color="fg.muted">
                                    ${row.share.toFixed(2)} share − ${row.deduction.toFixed(2)} {deductionLabel} ({row.rate}%)
                                    {row.topUp && row.topUp > 0 ? ` + $${row.topUp.toFixed(2)} top-up` : ""}
                                    {" = "}
                                    <Text as="span" fontWeight="semibold" color={row.isOwner ? "purple.700" : "green.700"}>
                                      {/* Total must include the top-up addend
                                          to match the equation rendered just
                                          above. Without it, an employee made
                                          whole on a write-off / underpayment
                                          displays `share − margin + $X.XX
                                          top-up = $0.00`, which contradicts
                                          itself. `row.topUp` is null/0 for
                                          rows with no top-up so this is a
                                          no-op in the common (full-pay)
                                          case. */}
                                      ${(row.share - row.deduction + (row.topUp ?? 0)).toFixed(2)}
                                    </Text>
                                    {showPromised && (
                                      <Text as="span" color="fg.muted"> promised (pending approval)</Text>
                                    )}
                                  </Text>
                                ) : (
                                  // Legacy row with no breakdown — fall back
                                  // to just the net amount.
                                  <Text fontSize="2xs" color="fg.muted">
                                    Net payout:{" "}
                                    <Text as="span" fontWeight="semibold" color={row.isOwner ? "purple.700" : "green.700"}>
                                      ${row.payout.toFixed(2)}
                                    </Text>
                                  </Text>
                                )}
                              </Box>
                            );
                          })}
                        </VStack>
                      );
                    })()}
                    {(() => {
                      const expTotal = (p.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                      return expTotal > 0 ? (
                        <VStack align="start" gap={0} mt={0.5}>
                          {(p.occurrence?.expenses ?? []).map((exp) => (
                            <HStack key={exp.id} gap={1} w="full">
                              <Text fontSize="xs" color="orange.600" flex="1">
                                Expense: ${exp.cost.toFixed(2)} — {exp.description}
                              </Text>
                            </HStack>
                          ))}
                        </VStack>
                      ) : null;
                    })()}
                  </VStack>
                  {(() => {
                    const expTotal = (p.occurrence?.expenses ?? []).reduce((s, e) => s + e.cost, 0);
                    const fee = p.platformFeeAmount ?? 0;
                    const margin = (p as any).businessMarginAmount ?? 0;
                    // Headline payout uses the SAME derivation as the rows
                    // on the left: real splits when present, otherwise the
                    // employees' promised nets (guaranteed) when pending.
                    // Contractors on pending payments don't contribute —
                    // their amount is contingent on the collected total.
                    // When a worker filter is active we sum only the
                    // selected workers; unfiltered = full-team total.
                    const writtenOff = !!(p as any).writtenOff;
                    const skipped = !!(p as any).skippedAt;
                    const isPending = p.confirmed === false && !writtenOff && !skipped;
                    const promisedRows = (p.occurrence?.promisedPayouts ?? null) as Array<{
                      userId: string; workerType: string | null; net: number;
                    }> | null;
                    type EffectiveRow = { userId: string; displayName: string | null; payout: number; contingent: boolean };
                    let effectiveRows: EffectiveRow[];
                    if ((p.splits ?? []).length > 0) {
                      effectiveRows = p.splits.map((sp) => ({
                        userId: sp.userId,
                        displayName: sp.user?.displayName ?? sp.user?.email ?? null,
                        payout: sp.amount,
                        contingent: false,
                      }));
                    } else if (promisedRows && promisedRows.length > 0) {
                      const assigneesByUser = new Map(
                        (p.occurrence?.assignees ?? []).map((a) => [a.userId, a]),
                      );
                      effectiveRows = promisedRows.map((r) => {
                        const a = assigneesByUser.get(r.userId);
                        const wt = r.workerType ?? a?.user?.workerType ?? null;
                        const isEmployeeClass = wt === "EMPLOYEE" || wt === "TRAINEE";
                        return {
                          userId: r.userId,
                          displayName: a?.user?.displayName ?? a?.user?.email ?? null,
                          payout: isEmployeeClass ? r.net : 0,
                          contingent: !isEmployeeClass,
                        };
                      });
                    } else {
                      effectiveRows = [];
                    }
                    const selectedPersons = personFilter.length > 0 ? new Set(personFilter) : null;
                    const headlineRows = selectedPersons
                      ? effectiveRows.filter((r) => selectedPersons.has(r.userId))
                      : effectiveRows;
                    const splitTotal = headlineRows.reduce((s, r) => s + r.payout, 0);
                    const hasContingent = headlineRows.some((r) => r.contingent);
                    // Label disambiguation:
                    //   • Person filter + 1 worker  → "<name>'s payout"
                    //   • Person filter + N workers → "Selected workers' payout"
                    //   • No filter, 1 worker on card → "Worker payout"
                    //   • No filter, N workers on card → "Total to workers"
                    // The unfiltered multi-worker case used to read just
                    // "Worker payout" which made the sum look like a single
                    // worker's number — confusing on mixed crews.
                    const payoutLabel = selectedPersons
                      ? (headlineRows.length === 1 ? `${headlineRows[0].displayName ?? "Worker"} payout` : "Selected workers' payout")
                      : (headlineRows.length === 1 ? "Worker payout" : "Total to workers");
                    const hasDeductions = expTotal > 0 || fee > 0 || margin > 0;
                    const shortfall = (p as any).shortfallAmount ?? 0;
                    const overage = (p as any).overageAmount ?? 0;
                    const adjustedFrom = (p as any).adjustedFromAmount as number | null | undefined;
                    return (
                      // Headline = worker payout (what the workers actually
                      // got — the actionable number for payroll/accounting
                      // review). The gross "$X paid" sits below as context;
                      // the business-retained line completes the chain.
                      // Same selected-vs-total scoping as the green summary
                      // panel above.
                      <VStack align={{ base: "start", sm: "end" }} gap={0}>
                        {/* Status badges stack ABOVE the WORKER PAYOUT
                            headline so the headline number remains the
                            tallest, most prominent element in the row. */}
                        {(isPending || writtenOff || skipped || (adjustedFrom != null && adjustedFrom !== p.amountPaid)) && (
                          <HStack gap={1} align="center" wrap="wrap" justify={{ base: "flex-start", sm: "flex-end" }} mb={1}>
                            {isPending && (
                              <Badge size="sm" colorPalette="orange" variant="subtle" title="Awaiting admin approval in the Pending Approvals queue.">
                                Pending approval
                              </Badge>
                            )}
                            {writtenOff && (
                              <Badge size="sm" colorPalette="red" variant="solid">Written off</Badge>
                            )}
                            {skipped && (
                              <Badge size="sm" colorPalette="gray" variant="solid" title="Super-erased — treated as if the service never happened. Excluded from every income/payroll/1099 aggregate.">
                                Skipped
                              </Badge>
                            )}
                            {adjustedFrom != null && adjustedFrom !== p.amountPaid && (
                              <Badge size="sm" colorPalette="orange" variant="subtle" title={`Originally reported as $${adjustedFrom.toFixed(2)}`}>
                                Adjusted
                              </Badge>
                            )}
                          </HStack>
                        )}
                        <VStack align={{ base: "start", sm: "end" }} gap={0}>
                          <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wider">
                            {payoutLabel}
                            {/* "Guaranteed" qualifier on pending payments so
                                an operator reading "WORKER PAYOUT: $35" on
                                a pending row understands that's the
                                made-whole employee amount — and that any
                                contractor share is still pending. */}
                            {isPending && hasContingent ? " (guaranteed)" : ""}
                          </Text>
                          <Text
                            fontWeight="bold"
                            color={skipped ? "gray.500" : writtenOff ? "red.700" : "green.700"}
                            textDecoration={skipped ? "line-through" : undefined}
                            fontSize="xl"
                            lineHeight="1"
                          >
                            ${splitTotal.toFixed(2)}
                          </Text>
                        </VStack>
                        {isPending && hasContingent && (
                          <Text fontSize="2xs" color="orange.700" mt={1} maxW={{ base: "100%", sm: "240px" }} textAlign={{ base: "left", sm: "right" }}>
                            Contractor pay is contingent on the collected amount and reconciles at admin approval.
                          </Text>
                        )}
                        <Text fontSize="xs" color="fg.muted" mt={1}>
                          from ${p.amountPaid.toFixed(2)} paid
                          {expTotal > 0 ? `, after $${expTotal.toFixed(2)} expenses` : ""}
                        </Text>
                        {(fee > 0 || margin > 0) && (
                          <Text fontSize="xs" color="fg.muted">
                            Business kept ${(fee + margin).toFixed(2)}
                            {fee > 0 && margin > 0
                              ? ` ($${fee.toFixed(2)} commission + $${margin.toFixed(2)} margin)`
                              : fee > 0
                                ? ` commission (${p.platformFeePercent}%)`
                                : ` margin (${(p as any).businessMarginPercent}%)`}
                          </Text>
                        )}
                        {shortfall > 0 && (
                          <Text fontSize="xs" color="red.600" mt={1}>
                            Business absorbed ${shortfall.toFixed(2)} shortfall
                          </Text>
                        )}
                        {overage > 0 && (
                          <Text fontSize="xs" color="green.600" mt={1}>
                            Business kept ${overage.toFixed(2)} overage
                          </Text>
                        )}
                      </VStack>
                    );
                  })()}
                </Stack>
                )}
              </Card.Body>
              {!isCardCompact && isSuper && (
              <Card.Footer>
                <HStack gap={2} wrap="wrap">
                  <StatusButton
                    id="payment-edit"
                    itemId={p.id}
                    label="Edit"
                    onClick={async () => openEdit(p)}
                    variant="outline"
                    busyId={statusButtonBusyId}
                    setBusyId={setStatusButtonBusyId}
                  />
                  {p.confirmed && (
                    <StatusButton
                      id="payment-revert"
                      itemId={p.id}
                      label="Revert"
                      onClick={async () => setRevertingPayment(p)}
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
      </VStack>}
      {/* Jobs pagination footer — only paginates job payments. */}
      {typeFilter[0] === "JOBS" && filteredItems.length > 0 && renderPaginationFooter({
        totalCount: filteredItems.length,
        totalPages: jobsTotalPages,
        safePage: jobsSafePage,
        pageStart: jobsPageStart,
        pageEnd: jobsPageEnd,
        setPage: setJobsPage,
      })}

      {typeFilter[0] === "EQUIPMENT" && filteredCharges.length > 0 && (
        <>
          <Text fontSize="sm" fontWeight="semibold" mt={4} mb={1}>Equipment Charges</Text>
          <VStack align="stretch" gap={2}>
            {pagedCharges.map((c) => {
              const cardId = `aec-${c.id}`;
              const isCardCompact = compact && !expandedCards.has(cardId);
              // "No charge" vs the amount is driven by the recorded rentalCost,
              // not the worker type — owners and every worker are treated alike.
              const noCharge = (c.rentalCost ?? 0) <= 0;
              const toggleCard = compact ? () => setExpandedCards((prev) => {
                const next = new Set(prev);
                next.has(cardId) ? next.delete(cardId) : next.add(cardId);
                return next;
              }) : undefined;
              return (
              <Card.Root
                key={c.id}
                variant="outline"
                css={compact ? { cursor: "pointer" } : undefined}
                onClick={(e: any) => {
                  if (!toggleCard) return;
                  const tag = (e.target as HTMLElement)?.closest?.("a, button");
                  if (tag) return;
                  toggleCard();
                }}
              >
                <Card.Body py="2" px="3">
                  {isCardCompact ? (
                    <HStack justify="space-between" align="center">
                      <Text fontSize="md" fontWeight="semibold" truncate>
                        {c.equipment.shortDesc}
                      </Text>
                      <HStack gap={1} flexShrink={0}>
                        <Text fontSize="xs" color="fg.muted">{c.user.displayName ?? c.user.email ?? c.user.id}</Text>
                        {noCharge ? (
                          <Badge colorPalette="green" variant="subtle" fontSize="xs">No charge</Badge>
                        ) : (
                          // Admin/Super view: rentals are INCOME to the
                          // business (contractor pays the LLC to use
                          // company equipment). See memory/project_equipment_rental_income.md.
                          // Rendered green + positive sign to match the
                          // green summary panel above.
                          <Text fontWeight="bold" color="green.700" fontSize="lg">
                            +${(c.rentalCost ?? 0).toFixed(2)}
                          </Text>
                        )}
                      </HStack>
                    </HStack>
                  ) : (
                  <Stack direction={{ base: "column", sm: "row" }} justify="space-between" align={{ base: "stretch", sm: "start" }} gap={2} w="full">
                    <VStack align="start" gap={0} flex="1" minW={0}>
                      <Text fontSize="md" fontWeight="semibold">
                        {c.equipment.shortDesc}
                      </Text>
                      <Text fontSize="sm" color="fg.muted">
                        {c.equipment.brand ? `${c.equipment.brand} ` : ""}
                        {c.equipment.model ?? ""}
                      </Text>
                      <HStack gap={1} fontSize="xs">
                        <Text color="fg.muted">
                          {c.user.displayName ?? c.user.email ?? c.user.id}
                        </Text>
                        <Badge size="xs" colorPalette={(c.user as any).workerType === "EMPLOYEE" || (c.user as any).workerType === "TRAINEE" ? "blue" : "orange"} variant="subtle">
                          {(c.user as any).workerType === "EMPLOYEE" ? "W-2" : (c.user as any).workerType === "TRAINEE" ? "Trainee" : (c.user as any).workerType === "CONTRACTOR" ? "1099" : "Unclassified"}
                        </Badge>
                      </HStack>
                      {(() => {
                        // Show the same per-job-aware billing chip the worker
                        // view uses. Without this, per-job-billed equipment
                        // confusingly shows "X days @ $Y/day" (the legacy
                        // flat-daily format) on a checkout whose actual
                        // billing was per-completed-job — making a $0 charge
                        // look like a bug instead of "the contractor didn't
                        // complete a billable job during the window."
                        const mode = resolveBillingMode(c.equipment.dailyRate, c.equipment.equivalentJobs, equipmentBillingEnabled);
                        const chip = shortBillingChip(mode);
                        return (
                          <Text fontSize="xs" color="fg.muted">
                            {c.rentalDays} day{c.rentalDays !== 1 ? "s" : ""}
                            {chip ? ` · ${chip}` : ""}
                          </Text>
                        );
                      })()}
                      {/* Per-day breakdown — same as worker view. Surfaces
                          the "0 jobs → $0" math when per-job billing kicks
                          in. Only rendered when stored (recent checkouts). */}
                      {c.rentalBreakdown && c.rentalBreakdown.length > 0 && (
                        <VStack align="start" gap={0} mt={1}>
                          {c.rentalBreakdown.map((line) => (
                            <Text key={line.day} fontSize="2xs" color="fg.muted">
                              {fmtDate(line.day)}
                              {line.jobs != null ? ` · ${line.jobs} job${line.jobs === 1 ? "" : "s"}` : ""}
                              {" → "}${line.subtotal.toFixed(2)}
                              {line.capped && line.jobs != null && line.jobs > 0 ? " (capped)" : ""}
                            </Text>
                          ))}
                        </VStack>
                      )}
                      {c.releasedAt && (
                        <Text fontSize="xs" color="fg.muted">
                          Returned {fmtDate(c.releasedAt)}
                        </Text>
                      )}
                    </VStack>
                    {noCharge ? (
                      <Badge colorPalette="green" variant="subtle" fontSize="sm" alignSelf={{ base: "flex-start", sm: "auto" }} flexShrink={0}>
                        No charge
                      </Badge>
                    ) : (
                      // Admin/Super view: equipment rentals are INCOME
                      // (see compact view above and
                      // memory/project_equipment_rental_income.md).
                      <Text fontWeight="bold" color="green.700" fontSize="lg" flexShrink={0} textAlign={{ base: "left", sm: "right" }}>
                        +${(c.rentalCost ?? 0).toFixed(2)}
                      </Text>
                    )}
                  </Stack>
                  )}
                </Card.Body>
              </Card.Root>
              );
            })}
          </VStack>
        </>
      )}
      {/* Equipment pagination footer — only paginates equipment charges. */}
      {typeFilter[0] === "EQUIPMENT" && filteredCharges.length > 0 && renderPaginationFooter({
        totalCount: filteredCharges.length,
        totalPages: equipTotalPages,
        safePage: equipSafePage,
        pageStart: equipPageStart,
        pageEnd: equipPageEnd,
        setPage: setEquipPage,
      })}
      </Box>

      {/* ── Edit Payment Dialog ── */}
      <Dialog.Root open={!!editPayment} onOpenChange={(e) => { if (!e.open) setEditPayment(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Edit Payment</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <div>
                    <Text mb="1">Amount Paid *</Text>
                    <CurrencyInput
                      value={editAmount}
                      onChange={(v) => {
                        setEditAmount(v);
                        setEditConfirm(false);
                        // Auto-recalculate even splits
                        const total = parseFloat(v);
                        if (!isNaN(total) && total > 0 && editPayment?.splits.length) {
                          const even = (total / editPayment.splits.length).toFixed(2);
                          const map: Record<string, string> = {};
                          editPayment.splits.forEach((sp) => { map[sp.userId] = even; });
                          setEditSplits(map);
                        }
                      }}
                      size="sm"
                    />
                  </div>
                  <div>
                    <Text mb="1">Payment Method *</Text>
                    <Select.Root
                      collection={editMethodCollection}
                      value={editMethod}
                      onValueChange={(e) => { setEditMethod(e.value); setEditConfirm(false); }}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Method" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {editMethodItems.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </div>
                  <div>
                    <Text mb="1">Note</Text>
                    <Input
                      value={editNote}
                      onChange={(e) => { setEditNote(e.target.value); setEditConfirm(false); }}
                      placeholder="e.g. check #1234"
                      size="sm"
                    />
                  </div>
                  {editPayment && editPayment.splits.length > 1 && (
                    <div>
                      <Text mb="1">Per-Person Split</Text>
                      <VStack align="stretch" gap={2}>
                        {editPayment.splits.map((sp) => (
                          <HStack key={sp.userId} gap={2}>
                            <Text fontSize="sm" flex="1" minW={0} truncate>
                              {sp.user?.displayName ?? sp.user?.email ?? sp.userId}
                            </Text>
                            <CurrencyInput
                              value={editSplits[sp.userId] || ""}
                              onChange={(v) => { setEditSplits((prev) => ({ ...prev, [sp.userId]: v })); setEditConfirm(false); }}
                              size="sm"
                            />
                          </HStack>
                        ))}
                      </VStack>
                    </div>
                  )}
                </VStack>
              </Dialog.Body>

              {editConfirm && (
                <VStack align="stretch" px="4" pb="2" gap={1}>
                  <Text fontSize="sm" color="orange.600" fontWeight="medium">
                    Are you sure you want to update this payment? This will change the recorded payment amounts.
                  </Text>
                </VStack>
              )}

              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setEditPayment(null)} disabled={editBusy}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette={editConfirm ? "orange" : undefined}
                    onClick={handleEditSave}
                    loading={editBusy}
                    disabled={!editAmount || !editMethod[0]}
                  >
                    {editConfirm ? "Yes, Save Changes" : "Save"}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* ── Delete Expense Confirmation ── */}
      <Dialog.Root open={!!deleteExpenseId} onOpenChange={(e) => { if (!e.open) setDeleteExpenseId(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Delete Expense</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text>
                  This job is closed. Are you sure you want to delete this expense?
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setDeleteExpenseId(null)} disabled={deleteExpenseBusy}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette="red"
                    loading={deleteExpenseBusy}
                    onClick={async () => {
                      if (!deleteExpenseId) return;
                      setDeleteExpenseBusy(true);
                      try {
                        await apiDelete(`/api/admin/expenses/${deleteExpenseId}`);
                        publishInlineMessage({ type: "SUCCESS", text: "Expense deleted." });
                        setDeleteExpenseId(null);
                        void load();
                      } catch (err) {
                        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete expense.", err) });
                      } finally {
                        setDeleteExpenseBusy(false);
                      }
                    }}
                  >
                    Delete Expense
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={!!revertingPayment}
        title="Revert Payment?"
        message={
          revertingPayment
            ? `Revert the $${revertingPayment.amountPaid.toFixed(2)} ${revertingPayment.method} payment?`
            : ""
        }
        warning="This deletes the payment record and returns the job to Pending Payment. The auto-created next visit is removed too — unless a worker has already started it. To restore, the payment must be re-recorded and re-approved."
        confirmLabel="Revert"
        confirmColorPalette="red"
        inputLabel="Reason"
        inputPlaceholder="e.g. Check bounced, refunded the client, recorded the wrong amount…"
        inputOptional
        onConfirm={async (reason: string) => {
          const p = revertingPayment;
          setRevertingPayment(null);
          if (p) await doRevert(p, reason);
        }}
        onCancel={() => setRevertingPayment(null)}
      />
    </Box>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────

export default function PaymentsTab({ me, purpose = "WORKER" }: TabPropsType) {
  const { isAvail, forAdmin, isSuper: hasSuperRole } = determineRoles(me, purpose);

  // The Super → Money → Payments tab passes purpose="SUPER"; determineRoles()
  // only sets forAdmin for purpose="ADMIN", so treat the Super tab as an
  // admin-level view here. Payment approval + edit/revert are Super-only.
  const isSuper = purpose === "SUPER" && hasSuperRole;
  const showAdmin = forAdmin || isSuper;

  if (!isAvail && !isSuper) return <UnavailableNotice />;

  // Super-only "view as worker" wrapper. Adds a multi-select picker at
  // the top of the tab that, when one worker is selected, swaps the
  // entire view to that worker's WorkerPayments rendering (with the
  // server fetching their data via ?asUserId). With multiple workers
  // selected, we stack one WorkerPayments per selected worker so the
  // Super can compare worker-eye views side-by-side. With none, the
  // normal admin worklist renders.
  if (isSuper) {
    return <SuperPaymentsTabWithViewAs me={me} forAdmin={forAdmin} />;
  }

  return showAdmin
    ? <AdminPayments forAdmin isSuper={isSuper} />
    : <WorkerPayments me={me} forAdmin={forAdmin} />;
}

type ViewAsWorker = { id: string; displayName: string | null; workerType: any };

function SuperPaymentsTabWithViewAs({ me, forAdmin }: { me: TabPropsType["me"]; forAdmin: boolean }) {
  // Mirrors the AdminHomeTab "View as" picker — same Input + dropdown +
  // badge-row treatment, same colors, same persistedState lifecycle.
  // 0 selected = normal admin worklist; 1 = that worker's WorkerPayments
  // view fetched via ?asUserId; 2+ = stacked WorkerPayments per worker.
  const [workers, setWorkers] = useState<ViewAsWorker[]>([]);
  const [selectedWorkers, setSelectedWorkers] = usePersistedState<string[]>("pay_s_viewAsIds", []);
  const [searchText, setSearchText] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<Array<{ id: string; displayName: string | null; email?: string | null; workerType?: any }>>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list.map((u) => ({ id: u.id, displayName: u.displayName, workerType: u.workerType })) : []))
      .catch(() => setWorkers([]));
  }, []);

  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
        setSearchText("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropOpen]);

  const workerNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of workers) map[w.id] = w.displayName || w.id;
    return map;
  }, [workers]);

  const workerItems = useMemo(
    () => workers.map((w) => ({ label: w.displayName || w.id, value: w.id })),
    [workers],
  );

  const searchLc = searchText.toLowerCase();
  const filtered = searchText
    ? workerItems.filter((it) => it.label.toLowerCase().includes(searchLc))
    : workerItems;
  const limited = filtered.slice(0, 10);
  const hasMore = filtered.length > 10;

  // Resolve selected ids to worker objects for the WorkerPayments view-as
  // prop. Ids that haven't loaded yet are skipped.
  const byId = useMemo(() => {
    const m = new Map<string, ViewAsWorker>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);
  const selectedWorkerObjs = useMemo(
    () => selectedWorkers.map((id) => byId.get(id)).filter((w): w is ViewAsWorker => !!w),
    [selectedWorkers, byId],
  );

  return (
    <Box w="full">
      <HStack mb={2} gap={2} align="center" wrap="nowrap">
        <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap" flexShrink={0}>
          View as:
        </Text>
        <Box ref={dropRef} position="relative" flex="1">
          <Input
            size="sm"
            w="full"
            placeholder={selectedWorkers.length > 0
              ? selectedWorkers.map((id) => workerNameMap[id] || "Loading…").join(", ")
              : "All Workers"
            }
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              if (!dropOpen) setDropOpen(true);
            }}
            onFocus={() => {
              setDropOpen(true);
              setSearchText("");
            }}
          />
          {dropOpen && (
            <Box
              position="fixed"
              zIndex={9999}
              bg="white"
              borderWidth="1px"
              borderColor="gray.200"
              rounded="md"
              shadow="lg"
              w="240px"
              mt="1"
              ref={(el: HTMLDivElement | null) => {
                if (el && dropRef.current) {
                  const rect = dropRef.current.getBoundingClientRect();
                  el.style.top = `${rect.bottom + 4}px`;
                  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 248));
                  el.style.left = `${left}px`;
                }
              }}
            >
              <Box maxH="250px" overflowY="auto">
                {limited.map((it) => (
                  <Box
                    key={it.value}
                    px="3"
                    py="1.5"
                    fontSize="sm"
                    cursor="pointer"
                    bg={selectedWorkers.includes(it.value) ? "blue.50" : undefined}
                    _hover={{ bg: "gray.100" }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setSelectedWorkers((prev) =>
                        prev.includes(it.value)
                          ? prev.filter((id) => id !== it.value)
                          : [...prev, it.value]
                      );
                    }}
                  >
                    <HStack gap={2}>
                      <Text flex="1">{it.label}</Text>
                      {selectedWorkers.includes(it.value) && <Text color="blue.500" fontWeight="bold">✓</Text>}
                    </HStack>
                  </Box>
                ))}
                {hasMore && !searchText && (
                  <Text fontSize="xs" color="fg.muted" px="3" py="2" fontStyle="italic">
                    …{filtered.length - 10} more — type to search
                  </Text>
                )}
                {filtered.length === 0 && (
                  <Text fontSize="xs" color="fg.muted" px="3" py="2">No matches</Text>
                )}
              </Box>
            </Box>
          )}
        </Box>
      </HStack>
      {selectedWorkers.length > 0 && (
        <HStack mb={2} gap={1} wrap="wrap" pl="1">
          {selectedWorkers.map((id) => (
            <Badge key={id} size="sm" colorPalette="blue" variant="solid">
              {workerNameMap[id] || "Loading…"}
            </Badge>
          ))}
          <Badge
            size="sm"
            colorPalette="red"
            variant="outline"
            cursor="pointer"
            onClick={() => { setSelectedWorkers([]); setSearchText(""); }}
          >
            ✕ Clear
          </Badge>
        </HStack>
      )}

      {selectedWorkerObjs.length === 0 ? (
        <AdminPayments forAdmin isSuper />
      ) : selectedWorkerObjs.length === 1 ? (
        <WorkerPayments
          key={`single-${selectedWorkerObjs[0].id}`}
          me={me}
          forAdmin={forAdmin}
          viewAs={selectedWorkerObjs[0]}
        />
      ) : (
        <VStack align="stretch" gap={4}>
          {selectedWorkerObjs.map((w) => (
            <Box key={w.id} borderTopWidth="2px" borderColor="blue.300" pt={2}>
              <Text fontSize="md" fontWeight="bold" color="blue.700" mb={1}>
                {w.displayName ?? w.id.slice(-6)}
              </Text>
              <WorkerPayments
                key={`stack-${w.id}`}
                me={me}
                forAdmin={forAdmin}
                viewAs={w}
              />
            </Box>
          ))}
        </VStack>
      )}
    </Box>
  );
}
