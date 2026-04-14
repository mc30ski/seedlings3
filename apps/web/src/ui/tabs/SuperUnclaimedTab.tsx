"use client";

import { useEffect, useMemo, useState } from "react";
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
import { CalendarRange, RefreshCw, X } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { apiGet } from "@/src/lib/api";
import { type WorkerOccurrence } from "@/src/lib/types";
import { fmtDate, bizDateKey, clientLabel, occurrenceStatusColor, prettyStatus } from "@/src/lib/lib";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import { MapLink } from "@/src/ui/helpers/Link";
import SearchWithClear from "@/src/ui/components/SearchWithClear";
import { openEventSearch } from "@/src/lib/bus";
import { type DatePreset, computeDatesFromPreset, PRESET_LABELS } from "@/src/lib/datePresets";

function localDate(d: Date): string {
  return bizDateKey(d);
}

const superPresetItems = [
  { value: "overdueOnly", label: "Overdue only" },
  { value: "overdueAndNext3", label: "Overdue + Next 3 days" },
  { value: "overdueAndNextWeek", label: "Overdue + Next week" },
];
const superPresetCollection = createListCollection({ items: superPresetItems });

export default function SuperUnclaimedTab() {
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  // Date preset (default: next week)
  const [datePreset, setDatePreset] = usePersistedState<DatePreset>("super_unclaimed_datePreset", "overdueAndNext3");
  const presetDates = useMemo(() => computeDatesFromPreset(datePreset), [datePreset]);
  const [dateFrom, setDateFrom] = useState(presetDates.from);
  const [dateTo, setDateTo] = useState(presetDates.to);

  // Overdue
  const [overdueActive, setOverdueActive] = usePersistedState("super_unclaimed_overdue", false);

  // Re-apply preset dates when preset changes
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

  async function load(displayLoading = true, overrideDates?: { from?: string; to?: string }) {
    if (displayLoading) setLoading(true);
    try {
      const qs = new URLSearchParams();
      const qFrom = overrideDates?.from ?? dateFrom;
      const qTo = overrideDates?.to ?? dateTo;
      if (qFrom) qs.set("from", qFrom);
      if (qTo) qs.set("to", qTo);
      const list = await apiGet<WorkerOccurrence[]>(`/api/occurrences?${qs}`);
      setItems(Array.isArray(list) ? list : []);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [dateFrom, dateTo]);

  // Refresh overdue count
  const filtered = useMemo(() => {
    const excludeStatuses = new Set(["COMPLETED", "CLOSED", "ARCHIVED", "CANCELED", "REJECTED", "ACCEPTED"]);
    let rows = items.filter((occ) =>
      (occ.assignees ?? []).length === 0 &&
      !excludeStatuses.has(occ.status)
    );

    if (overdueActive) {
      const overdueExclude = new Set(["COMPLETED", "CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"]);
      rows = rows.filter((occ) => !overdueExclude.has(occ.status));
    }

    const qlc = q.trim().toLowerCase();
    if (qlc) {
      rows = rows.filter((occ) =>
        [
          occ.job?.property?.displayName,
          occ.job?.property?.street1,
          occ.job?.property?.city,
          occ.job?.property?.client?.displayName,
          occ.status,
          occ.notes,
          (occ as any).jobType,
        ]
          .filter(Boolean)
          .some((s) => (s as string).toLowerCase().includes(qlc))
      );
    }

    // Sort chronologically (most urgent first)
    rows.sort((a, b) => (a.startAt ?? "").localeCompare(b.startAt ?? ""));

    return rows;
  }, [items, q, overdueActive]);

  if (loading && items.length === 0) {
    return <Box py={10} textAlign="center"><Spinner size="lg" /></Box>;
  }

  return (
    <Box w="full" pb={8}>
      <Box mb={3} p={3} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
        <Text fontSize="sm" fontWeight="medium" color="yellow.700">Unclaimed Jobs</Text>
        <Text fontSize="xs" color="yellow.600">Showing overdue and upcoming unassigned jobs. Red = overdue, yellow = today/tomorrow, green = upcoming. Default view: overdue + next 3 days.</Text>
      </Box>

      <HStack mb={2} gap={2}>
        <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading} px="2" flexShrink={0}>
          <RefreshCw size={14} />
        </Button>
        <SearchWithClear
          value={q}
          onChange={setQ}
          placeholder="Search…"
          inputId="super-unclaimed-search"
        />
      </HStack>

      <HStack mb={3} gap={2} align="center" wrap="wrap">
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
          collection={superPresetCollection}
          value={datePreset ? [datePreset] : []}
          onValueChange={(e) => {
            const val = e.value[0] as DatePreset;
            if (!val) return;
            setDatePreset(val);
            setOverdueActive(false);
          }}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2">
              <CalendarRange size={14} />
              <Select.ValueText placeholder="Date range" />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {superPresetItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        {!(datePreset === "overdueAndNext3" && !q) && (
        <Button
          variant="outline"
          size="xs"
          colorPalette="red"
          onClick={() => {
            setOverdueActive(false);
            setDatePreset("overdueAndNext3");
            setQ("");
          }}
        >
          Clear
        </Button>
        )}
      </HStack>

      {datePreset && (
        <HStack mb={2} gap={1} wrap="wrap" pl="2">
          <Badge size="sm" colorPalette={datePreset === "overdueOnly" ? "red" : "yellow"} variant="subtle">
            {PRESET_LABELS[datePreset] ?? datePreset}
          </Badge>
        </HStack>
      )}

      <Text fontSize="xs" color="fg.muted" mb={2}>
        {filtered.length} unclaimed job{filtered.length !== 1 ? "s" : ""}
      </Text>

      {filtered.length === 0 && !loading && (
        <Box textAlign="center" py={10}>
          <Text fontSize="lg" fontWeight="semibold" color="green.600">All jobs are assigned!</Text>
          <Text fontSize="sm" color="fg.muted" mt={1}>No unclaimed jobs in the selected date range.</Text>
        </Box>
      )}

      <VStack align="stretch" gap={2}>
        {filtered.map((occ) => {
          const prop = occ.job?.property;
          const isVip = !!(prop?.client as any)?.isVip;
          const vipReason = (prop?.client as any)?.vipReason;
          const today = bizDateKey(new Date());
          const tomorrowDate = new Date();
          tomorrowDate.setDate(tomorrowDate.getDate() + 1);
          const tomorrow = bizDateKey(tomorrowDate);
          const occDate = occ.startAt ? bizDateKey(occ.startAt) : "";
          const isOverdue = occDate && occDate < today;
          const isTodayOrTomorrow = occDate === today || occDate === tomorrow;
          const isFuture = occDate > tomorrow;

          // Card colors: overdue=red, today/tomorrow=yellow, future=green, VIP overlay
          const cardBg = isOverdue ? "red.50" : isTodayOrTomorrow ? "yellow.50" : isFuture ? "green.50" : undefined;
          const cardBorder = isOverdue ? "red.300" : isTodayOrTomorrow ? "yellow.400" : isFuture ? "green.300" : isVip ? "yellow.400" : undefined;

          return (
            <Card.Root
              key={occ.id}
              variant="outline"
              borderColor={cardBorder}
              bg={cardBg}
            >
              <Card.Body py="3" px="4">
                <VStack align="start" gap={1}>
                  <Text fontSize="sm" fontWeight="semibold">
                    {isVip && <span title={vipReason || "VIP Client"} style={{ cursor: "help" }}>⭐ </span>}
                    {prop?.displayName}
                    {prop?.client?.displayName && (
                      <Text as="span" color="fg.muted" fontWeight="normal"> — {clientLabel(prop.client.displayName)}</Text>
                    )}
                  </Text>

                  {isVip && vipReason && (
                    <Text fontSize="xs" color="yellow.700" fontWeight="medium">⭐ VIP: {vipReason}</Text>
                  )}

                  <Box display="flex" gap={1} flexWrap="wrap" alignItems="center">
                    {isOverdue && <StatusBadge status="Overdue" palette="red" variant="solid" />}
                    {isTodayOrTomorrow && <StatusBadge status={occDate === today ? "Today" : "Tomorrow"} palette="yellow" variant="solid" />}
                    {isFuture && <StatusBadge status="Upcoming" palette="green" variant="subtle" />}
                    {occ.isTentative ? (
                      <StatusBadge status="Tentative" palette="orange" variant="solid" />
                    ) : occ.status !== "SCHEDULED" ? (
                      <StatusBadge status={occ.status} palette={occurrenceStatusColor(occ.status)} variant="solid" />
                    ) : null}
                    {(occ.workflow === "STANDARD" || (!occ.workflow && !occ.isEstimate && !occ.isOneOff)) && <StatusBadge status="Repeating" palette="blue" variant="outline" />}
                    {(occ.workflow === "ESTIMATE" || occ.isEstimate) && <StatusBadge status="Estimate" palette="purple" variant="solid" />}
                    {(occ.workflow === "ONE_OFF" || occ.isOneOff) && <StatusBadge status="One-off" palette="cyan" variant="solid" />}
                    {occ.isAdminOnly && <StatusBadge status="Administered" palette="red" variant="outline" />}
                  </Box>

                  <HStack gap={3} fontSize="xs" wrap="wrap">
                    {occ.startAt && <Text color={isOverdue ? "red.600" : isTodayOrTomorrow ? "yellow.700" : isFuture ? "green.700" : "fg.muted"} fontWeight={isOverdue || isTodayOrTomorrow ? "medium" : "normal"}>{fmtDate(occ.startAt)}</Text>}
                    {(occ as any).jobType && (
                      <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                        {prettyStatus((occ as any).jobType)}
                      </Badge>
                    )}
                    {occ.price != null && (
                      <Badge colorPalette="green" variant="solid" fontSize="xs" px="2" borderRadius="full">
                        ${occ.price.toFixed(2)}
                      </Badge>
                    )}
                    {occ.estimatedMinutes != null && (
                      <Text color="fg.muted">{occ.estimatedMinutes}m</Text>
                    )}
                  </HStack>

                  <Box fontSize="xs">
                    <MapLink address={[prop?.street1, prop?.city, prop?.state].filter(Boolean).join(", ")} />
                  </Box>

                  <Button
                    size="xs"
                    variant="outline"
                    colorPalette="blue"
                    onClick={() =>
                      openEventSearch(
                        "jobsTabToServicesTabSearch",
                        prop?.displayName ?? "",
                        true,
                        `${occ.job?.id}:${occ.id}`,
                      )
                    }
                  >
                    Manage in Services
                  </Button>
                </VStack>
              </Card.Body>
            </Card.Root>
          );
        })}
      </VStack>
    </Box>
  );
}
