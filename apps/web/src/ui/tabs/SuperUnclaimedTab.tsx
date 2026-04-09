"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { AlertTriangle, RefreshCw, X } from "lucide-react";
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

const presetItems = Object.entries(PRESET_LABELS).map(([value, label]) => ({ value, label }));
const presetCollection = createListCollection({ items: presetItems });

export default function SuperUnclaimedTab() {
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  // Date preset (default: next week)
  const [datePreset, setDatePreset] = usePersistedState<DatePreset>("super_unclaimed_datePreset", "nextWeek");
  const presetDates = useMemo(() => computeDatesFromPreset(datePreset), [datePreset]);
  const [dateFrom, setDateFrom] = useState(presetDates.from);
  const [dateTo, setDateTo] = useState(presetDates.to);

  // Overdue
  const [overdueActive, setOverdueActive] = usePersistedState("super_unclaimed_overdue", false);
  const [overdueCount, setOverdueCount] = useState(0);
  const presetBeforeOverdueRef = useRef<DatePreset>(datePreset);

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
  async function refreshOverdueCount() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const list = await apiGet<WorkerOccurrence[]>(`/api/occurrences?to=${localDate(yesterday)}`);
      const excludeStatuses = new Set(["CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"]);
      const todayKey = bizDateKey(new Date());
      const count = (Array.isArray(list) ? list : []).filter((o) =>
        (o.assignees ?? []).length === 0 &&
        o.startAt &&
        !excludeStatuses.has(o.status as string) &&
        bizDateKey(o.startAt) < todayKey
      ).length;
      setOverdueCount(count);
    } catch {}
  }

  useEffect(() => { void refreshOverdueCount(); }, [items]);

  const filtered = useMemo(() => {
    const excludeStatuses = new Set(["CLOSED", "ARCHIVED", "CANCELED", "REJECTED", "ACCEPTED"]);
    let rows = items.filter((occ) =>
      (occ.assignees ?? []).length === 0 &&
      !excludeStatuses.has(occ.status)
    );

    if (overdueActive) {
      const overdueExclude = new Set(["CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"]);
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

    // Sort: VIP first, then by date
    rows.sort((a, b) => {
      const aVip = !!(a.job?.property?.client as any)?.isVip;
      const bVip = !!(b.job?.property?.client as any)?.isVip;
      if (aVip && !bVip) return -1;
      if (!aVip && bVip) return 1;
      return (a.startAt ?? "").localeCompare(b.startAt ?? "");
    });

    return rows;
  }, [items, q, overdueActive]);

  if (loading && items.length === 0) {
    return <Box py={10} textAlign="center"><Spinner size="lg" /></Box>;
  }

  return (
    <Box w="full" pb={8}>
      <Box mb={3} p={3} bg="red.50" borderWidth="1px" borderColor="red.300" rounded="md">
        <Text fontSize="sm" fontWeight="medium" color="red.700">Unclaimed Jobs</Text>
        <Text fontSize="xs" color="red.600">These jobs have no one assigned and need attention. Assign workers or follow up with the team.</Text>
      </Box>

      <HStack mb={3} gap={2} wrap="wrap">
        <SearchWithClear
          value={q}
          onChange={setQ}
          placeholder="Search…"
          inputId="super-unclaimed-search"
        />
        <Select.Root
          collection={presetCollection}
          value={datePreset ? [datePreset] : []}
          onValueChange={(e) => {
            setOverdueActive(false);
            setDatePreset((e.value[0] as DatePreset) ?? "nextWeek");
          }}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2" css={{ background: "var(--chakra-colors-blue-100)", borderRadius: "6px" }}>
              <Select.ValueText placeholder="Date range" />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {presetItems.map((it) => (
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
              setDatePreset(presetBeforeOverdueRef.current ?? "nextWeek");
            } else {
              presetBeforeOverdueRef.current = datePreset;
              const yesterday = new Date();
              yesterday.setDate(yesterday.getDate() - 1);
              setDatePreset(null);
              setDateFrom("");
              const overdueTo = localDate(yesterday);
              setDateTo(overdueTo);
              setOverdueActive(true);
              void load(true, { from: "", to: overdueTo });
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
        <Button
          variant="ghost"
          size="sm"
          px="2"
          minW="0"
          disabled={!overdueActive && datePreset === "nextWeek" && !q}
          onClick={() => {
            setOverdueActive(false);
            setDatePreset("nextWeek");
            setQ("");
          }}
        >
          <X size={14} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw size={14} />
        </Button>
      </HStack>

      <Text fontSize="xs" color="fg.muted" mb={2}>
        {filtered.length} unclaimed job{filtered.length !== 1 ? "s" : ""}
        {datePreset && !overdueActive && ` · ${PRESET_LABELS[datePreset] ?? datePreset}`}
        {overdueActive && " · Overdue"}
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
          const isOverdue = occ.startAt && bizDateKey(occ.startAt) < bizDateKey(new Date());
          return (
            <Card.Root
              key={occ.id}
              variant="outline"
              borderColor={isOverdue ? "red.300" : isVip ? "yellow.400" : undefined}
              bg={isOverdue ? "red.50" : isVip ? "yellow.50" : undefined}
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
                    {occ.isTentative ? (
                      <StatusBadge status="Tentative" palette="orange" variant="solid" />
                    ) : occ.status !== "SCHEDULED" ? (
                      <StatusBadge status={occ.status} palette={occurrenceStatusColor(occ.status)} variant="solid" />
                    ) : null}
                    {(occ.workflow === "STANDARD" || (!occ.workflow && !occ.isEstimate && !occ.isOneOff)) && <StatusBadge status="Repeating" palette="blue" variant="outline" />}
                    {(occ.workflow === "ESTIMATE" || occ.isEstimate) && <StatusBadge status="Estimate" palette="purple" variant="solid" />}
                    {(occ.workflow === "ONE_OFF" || occ.isOneOff) && <StatusBadge status="One-off" palette="gray" variant="solid" />}
                    {occ.isAdminOnly && <StatusBadge status="Administered" palette="red" variant="outline" />}
                  </Box>

                  <HStack gap={3} fontSize="xs" wrap="wrap">
                    {occ.startAt && <Text color={isOverdue ? "red.600" : "fg.muted"} fontWeight={isOverdue ? "medium" : "normal"}>{fmtDate(occ.startAt)}</Text>}
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
