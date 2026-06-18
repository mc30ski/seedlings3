"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Spinner,
  Table,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ChevronDown, ChevronRight, AlertTriangle, Copy } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import DateInput from "@/src/ui/components/DateInput";
import {
  bizToday,
  bizAddDays,
  bizMondayOnOrBefore,
  bizStartOfMonth,
} from "@/src/lib/lib";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";

// ─────────────────────────────────────────────────────────────────────────
// Worker Reconciliation Cockpit — experimental Super tab.
//
// Single-page surface for reconciling worker time + pay against Gusto and
// QuickBooks. Three layers:
//   1. Period totals (the trust ledger — does it all add up?)
//   2. Reconciliation targets (exact numbers to copy/paste against
//      external systems — Gusto wages, QB Income, QB Contract Labor, etc.)
//   3. Per-worker drill-down — expand a worker → see day breakdown →
//      expand a day → see per-job breakdown
//
// Anomaly flagging (yellow chips) surfaces rows that need attention:
//   • Worker has hours but no completed jobs
//   • Worker has jobs but no hours
//   • Employee/trainee pre-top-up hourly below minimum wage
//   • Completed jobs whose payment isn't confirmed yet
// ─────────────────────────────────────────────────────────────────────────

type JobRow = {
  occurrenceId: string;
  title: string;
  client: string | null;
  property: string | null;
  completedAt: string | null;
  grossShare: number;
  feeOrMargin: number;
  topUp: number;
  netPaid: number;
  paymentConfirmed: boolean;
  paymentWrittenOff: boolean;
  source: "snapshot" | "computed";
};

type DayRow = {
  date: string;
  hoursActive: number;
  jobsCompleted: number;
  grossEarnings: number;
  feesOrMargin: number;
  topUps: number;
  netPaid: number;
  jobs: JobRow[];
};

type WorkerRow = {
  userId: string;
  displayName: string | null;
  email: string | null;
  workerType: string | null;
  hoursActive: number;
  daysWorked: number;
  jobsCompleted: number;
  grossEarnings: number;
  feesOrMargin: number;
  topUps: number;
  netPaid: number;
  ownerEarnings: number;
  effectiveHourly: number | null;
  preTopUpHourly: number | null;
  belowMinWage: boolean;
  anomalies: string[];
  days: DayRow[];
};

type Period = {
  range: { from: string; to: string };
  minWagePerHour: number;
  totals: {
    workersActive: number;
    totalHours: number;
    totalDaysLogged: number;
    totalJobsCompleted: number;
    totalRevenue: number;
    totalEquipmentRental: number;
    totalProcessorFees: number;
    totalWorkerGross: number;
    totalBusinessMargin: number;
    totalContractorFees: number;
    totalTopUps: number;
    totalWorkerNetPaid: number;
    totalOwnerEarnings: number;
    netOperatingIncome: number;
    anomalies: number;
  };
  reconciliationTargets: {
    gustoEmployeeWages: number;
    qbServiceIncome: number;
    qbEquipmentRentalIncome: number;
    qbProcessorFees: number;
    qbContractLabor: number;
  };
  workers: WorkerRow[];
};

function fmtUSD(n: number): string {
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `−$${formatted}` : `$${formatted}`;
}

function workerTypeLabel(t: string | null | undefined): string {
  switch (t) {
    case "EMPLOYEE": return "Employee";
    case "TRAINEE": return "Trainee";
    case "CONTRACTOR": return "Contractor";
    default: return "Unclassified";
  }
}

function workerTypePalette(t: string | null | undefined): string {
  switch (t) {
    case "EMPLOYEE": return "blue";
    case "TRAINEE": return "purple";
    case "CONTRACTOR": return "green";
    default: return "gray";
  }
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    publishInlineMessage({ type: "SUCCESS", text: `Copied: ${text}` });
  } catch {
    publishInlineMessage({ type: "ERROR", text: "Copy failed — clipboard unavailable." });
  }
}

export default function ReconcileWorkersTab() {
  // Default to "last week" since that's the typical reconciliation cadence
  // (you reconcile the period that just ended, not the current in-flight one).
  const defaultRange = useMemo(() => {
    const lastMon = bizAddDays(bizMondayOnOrBefore(), -7);
    return { from: lastMon, to: bizAddDays(lastMon, 6) };
  }, []);
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);
  const [data, setData] = useState<Period | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [activePreset, setActivePreset] = useState<string | null>("last-week");

  const load = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    try {
      const r = await apiGet<Period>(`/api/super/reconcile/period?from=${from}&to=${to}`);
      setData(r);
      setExpanded(new Set());
      setExpandedDays(new Set());
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load reconciliation.", err) });
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const presets = useMemo(
    () => [
      {
        key: "this-week",
        label: "This week",
        range: () => {
          const mon = bizMondayOnOrBefore();
          return { from: mon, to: bizAddDays(mon, 6) };
        },
      },
      {
        key: "last-week",
        label: "Last week",
        range: () => {
          const lastMon = bizAddDays(bizMondayOnOrBefore(), -7);
          return { from: lastMon, to: bizAddDays(lastMon, 6) };
        },
      },
      {
        key: "this-month",
        label: "This month",
        range: () => {
          const startStr = bizStartOfMonth();
          return { from: startStr, to: bizToday() };
        },
      },
      {
        key: "last-month",
        label: "Last month",
        range: () => {
          const thisMonthStart = bizStartOfMonth();
          const lastMonthEnd = bizAddDays(thisMonthStart, -1);
          const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
          return { from: lastMonthStart, to: lastMonthEnd };
        },
      },
    ],
    [],
  );

  return (
    <VStack align="stretch" gap={3}>
      {/* Experimental banner */}
      <Box
        p={3}
        bg="purple.50"
        borderLeftWidth="3px"
        borderColor="purple.500"
        borderRadius="md"
      >
        <Text fontSize="xs" color="purple.900">
          <b>Experimental.</b> Reconciliation cockpit for weekly/monthly Gusto + QuickBooks tie-out.
          Period totals show the trust ledger; "Targets" copies the exact numbers to paste against
          external systems; per-worker drill-downs let you trace any variance to a specific job.
        </Text>
      </Box>

      {/* Date range + presets */}
      <Card.Root>
        <Card.Body>
          <HStack gap={2} wrap="wrap" align="center">
            <DateInput
              value={from}
              onChange={(v) => {
                setActivePreset(null);
                setFrom(v);
                if (to && v && v > to) setTo(v);
              }}
            />
            <Text fontSize="sm">–</Text>
            <DateInput
              value={to}
              min={from || undefined}
              onChange={(v) => {
                setActivePreset(null);
                setTo(v);
                if (from && v && v < from) setFrom(v);
              }}
            />
            <HStack gap={1} wrap="wrap">
              {presets.map((p) => (
                <Button
                  key={p.key}
                  size="xs"
                  variant={activePreset === p.key ? "solid" : "outline"}
                  colorPalette={activePreset === p.key ? "purple" : "gray"}
                  onClick={() => {
                    const r = p.range();
                    setActivePreset(p.key);
                    setFrom(r.from);
                    setTo(r.to);
                  }}
                >
                  {p.label}
                </Button>
              ))}
            </HStack>
          </HStack>
        </Card.Body>
      </Card.Root>

      {loading && !data ? (
        <HStack justify="center" py={6}><Spinner /></HStack>
      ) : !data ? null : (
        <>
          {/* Period summary — the trust ledger */}
          <Card.Root>
            <Card.Body>
              <Text fontSize="sm" fontWeight="semibold" mb={3}>Period summary</Text>
              <HStack gap={4} wrap="wrap" align="stretch">
                <SummaryStat label="Workers" value={data.totals.workersActive.toString()} />
                <SummaryStat label="Hours" value={data.totals.totalHours.toFixed(2)} />
                <SummaryStat label="Days logged" value={data.totals.totalDaysLogged.toString()} />
                <SummaryStat label="Jobs done" value={data.totals.totalJobsCompleted.toString()} />
                <SummaryStat
                  label="Anomalies"
                  value={data.totals.anomalies.toString()}
                  emphasis={data.totals.anomalies > 0 ? "warn" : undefined}
                />
              </HStack>
              <Box borderTopWidth="1px" borderColor="gray.200" my={3} />
              <HStack gap={4} wrap="wrap" align="stretch">
                <SummaryStat label="Revenue" value={fmtUSD(data.totals.totalRevenue)} />
                <SummaryStat label="Equipment rental" value={fmtUSD(data.totals.totalEquipmentRental)} />
                <SummaryStat label="Processor fees" value={fmtUSD(data.totals.totalProcessorFees)} emphasis="neg" />
                <SummaryStat label="Worker payouts" value={fmtUSD(data.totals.totalWorkerNetPaid)} emphasis="neg" />
                <SummaryStat
                  label="Net operating income"
                  value={fmtUSD(data.totals.netOperatingIncome)}
                  emphasis={data.totals.netOperatingIncome < 0 ? "neg" : "pos"}
                />
              </HStack>
              <Box borderTopWidth="1px" borderColor="gray.200" my={3} />
              <HStack gap={4} wrap="wrap" align="stretch">
                <SummaryStat label="Worker gross" value={fmtUSD(data.totals.totalWorkerGross)} />
                <SummaryStat label="Business margin (W-2)" value={fmtUSD(data.totals.totalBusinessMargin)} />
                <SummaryStat label="Contractor fees" value={fmtUSD(data.totals.totalContractorFees)} />
                <SummaryStat label="Top-ups" value={fmtUSD(data.totals.totalTopUps)} />
                <SummaryStat label="Owner earnings" value={fmtUSD(data.totals.totalOwnerEarnings)} />
              </HStack>
            </Card.Body>
          </Card.Root>

          {/* Reconciliation targets — the actual numbers to paste */}
          <Card.Root bg="indigo.50" borderColor="indigo.200">
            <Card.Body>
              <Text fontSize="sm" fontWeight="semibold" mb={1}>Reconciliation targets</Text>
              <Text fontSize="xs" color="fg.muted" mb={3}>
                Copy these numbers and verify against the corresponding line in Gusto / QuickBooks.
                Click any value to copy.
              </Text>
              <VStack align="stretch" gap={2}>
                <TargetRow
                  label="Gusto · Employee + Trainee wages (gross + top-ups)"
                  value={data.reconciliationTargets.gustoEmployeeWages}
                  hint="Sum of W-2 worker promised gross + top-ups. What Gusto needs to pay through payroll."
                />
                <TargetRow
                  label="QB · Service income"
                  value={data.reconciliationTargets.qbServiceIncome}
                  hint="Confirmed Payment.amountPaid sum (cash basis, anchored on confirmedAt)."
                />
                <TargetRow
                  label="QB · Equipment rental income"
                  value={data.reconciliationTargets.qbEquipmentRentalIncome}
                  hint="Checkout.rentalCost sum on releases in this window."
                />
                <TargetRow
                  label="QB · Processor fees"
                  value={data.reconciliationTargets.qbProcessorFees}
                  hint="Payment.processorFeeAmount sum (Venmo/Zelle/card fees absorbed)."
                />
                <TargetRow
                  label="QB · Contract labor"
                  value={data.reconciliationTargets.qbContractLabor}
                  hint="Sum of contractor net payouts (excludes employees & GP-flagged splits)."
                />
              </VStack>
            </Card.Body>
          </Card.Root>

          {/* Per-worker rows */}
          <Card.Root>
            <Card.Body>
              <Text fontSize="sm" fontWeight="semibold" mb={3}>
                Workers ({data.workers.length})
                {data.totals.anomalies > 0 && (
                  <Badge ml={2} size="xs" colorPalette="yellow" variant="subtle">
                    {data.totals.anomalies} anomaly{data.totals.anomalies === 1 ? "" : "ies"}
                  </Badge>
                )}
              </Text>
              <Text fontSize="xs" color="fg.muted" mb={3}>
                Rows sorted by anomaly count (most first), then net paid. Tap a worker to see the
                day-by-day breakdown; tap a day to see each job's contribution.
              </Text>
              {data.workers.length === 0 ? (
                <Text fontSize="sm" color="fg.muted" textAlign="center" py={4}>
                  No workers logged in this window.
                </Text>
              ) : (
                <VStack align="stretch" gap={1}>
                  {data.workers.map((w) => (
                    <WorkerCard
                      key={w.userId}
                      worker={w}
                      minWage={data.minWagePerHour}
                      expanded={expanded.has(w.userId)}
                      onToggle={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(w.userId)) next.delete(w.userId);
                          else next.add(w.userId);
                          return next;
                        })
                      }
                      expandedDays={expandedDays}
                      onToggleDay={(dayKey) =>
                        setExpandedDays((prev) => {
                          const next = new Set(prev);
                          if (next.has(dayKey)) next.delete(dayKey);
                          else next.add(dayKey);
                          return next;
                        })
                      }
                    />
                  ))}
                </VStack>
              )}
            </Card.Body>
          </Card.Root>

          {/* Footer */}
          <Text fontSize="xs" color="fg.muted">
            Hours from WorkerWorkday active time (ended rows only). Earnings from JobOccurrence.promisedPayouts
            snapshot when available, computed from price/expenses/splits + rates otherwise. Cash basis.
            ET-anchored boundaries. Minimum wage threshold: ${data.minWagePerHour.toFixed(2)}/hr
            (from settings).
          </Text>
        </>
      )}
    </VStack>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function SummaryStat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: "pos" | "neg" | "warn";
}) {
  const color =
    emphasis === "pos" ? "green.700" :
    emphasis === "neg" ? "red.600" :
    emphasis === "warn" ? "yellow.700" :
    "fg.default";
  return (
    <Box minW="120px">
      <Text fontSize="xs" color="fg.muted">{label}</Text>
      <Text fontSize="md" fontWeight="bold" color={color}>{value}</Text>
    </Box>
  );
}

function TargetRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint: string;
}) {
  const display = fmtUSD(value);
  return (
    <HStack
      gap={3}
      align="flex-start"
      py={1.5}
      borderBottomWidth="1px"
      borderColor="indigo.100"
    >
      <Box flex="1" minW={0}>
        <Text fontSize="sm" fontWeight="medium">{label}</Text>
        <Text fontSize="2xs" color="fg.muted">{hint}</Text>
      </Box>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void copyToClipboard(value.toFixed(2))}
        title="Click to copy"
      >
        <Text fontSize="md" fontWeight="bold" fontFamily="mono">{display}</Text>
        <Copy size={12} style={{ marginLeft: 6 }} />
      </Button>
    </HStack>
  );
}

function WorkerCard({
  worker,
  minWage,
  expanded,
  onToggle,
  expandedDays,
  onToggleDay,
}: {
  worker: WorkerRow;
  minWage: number;
  expanded: boolean;
  onToggle: () => void;
  expandedDays: Set<string>;
  onToggleDay: (dayKey: string) => void;
}) {
  return (
    <Box
      borderWidth="1px"
      borderColor={worker.anomalies.length > 0 ? "yellow.300" : "gray.200"}
      borderRadius="md"
      bg={worker.anomalies.length > 0 ? "yellow.50" : undefined}
    >
      <HStack
        as="button"
        onClick={onToggle}
        gap={2}
        p={2.5}
        w="full"
        textAlign="left"
        align="center"
        _hover={{ bg: "blackAlpha.50" }}
        cursor="pointer"
        wrap="wrap"
      >
        <Box flexShrink={0} color="fg.muted">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </Box>
        <VStack align="start" gap={0} flex="1" minW="180px">
          <HStack gap={2} wrap="wrap">
            <Text fontSize="sm" fontWeight="semibold">
              {worker.displayName ?? worker.email ?? "(unnamed)"}
            </Text>
            <Badge size="xs" colorPalette={workerTypePalette(worker.workerType)} variant="subtle">
              {workerTypeLabel(worker.workerType)}
            </Badge>
            {worker.belowMinWage && (
              <Badge size="xs" colorPalette="red" variant="solid">
                Below min wage
              </Badge>
            )}
            {worker.anomalies.length > 0 && !worker.belowMinWage && (
              <Badge size="xs" colorPalette="yellow" variant="solid">
                ⚠ {worker.anomalies.length}
              </Badge>
            )}
          </HStack>
          <Text fontSize="xs" color="fg.muted">
            {worker.hoursActive.toFixed(2)}h · {worker.daysWorked} day{worker.daysWorked === 1 ? "" : "s"}
            · {worker.jobsCompleted} job{worker.jobsCompleted === 1 ? "" : "s"}
            {worker.ownerEarnings > 0 && ` · owner cut ${fmtUSD(worker.ownerEarnings)}`}
          </Text>
        </VStack>
        <VStack align="end" gap={0} flexShrink={0}>
          <Text fontSize="sm" fontWeight="bold">{fmtUSD(worker.netPaid)}</Text>
          {worker.effectiveHourly != null && (
            <Text
              fontSize="xs"
              color={worker.belowMinWage ? "red.600" : "fg.muted"}
              fontWeight={worker.belowMinWage ? "semibold" : undefined}
            >
              {fmtUSD(worker.effectiveHourly)}/hr
              {worker.preTopUpHourly != null &&
                worker.preTopUpHourly !== worker.effectiveHourly &&
                ` · pre-top-up ${fmtUSD(worker.preTopUpHourly)}/hr`}
            </Text>
          )}
        </VStack>
      </HStack>

      {expanded && (
        <Box px={3} pb={3} pt={1} borderTopWidth="1px" borderColor="gray.200">
          {worker.anomalies.length > 0 && (
            <Box mb={2} p={2} bg="yellow.100" borderRadius="md">
              <HStack gap={2} align="flex-start">
                <Box pt={0.5}><AlertTriangle size={14} color="var(--chakra-colors-yellow-800)" /></Box>
                <VStack align="start" gap={0}>
                  {worker.anomalies.map((a, i) => (
                    <Text key={i} fontSize="xs" color="yellow.900">
                      • {a}
                    </Text>
                  ))}
                </VStack>
              </HStack>
            </Box>
          )}

          {/* Earnings breakdown summary */}
          <HStack gap={4} mb={3} wrap="wrap">
            <BreakdownStat label="Gross" value={fmtUSD(worker.grossEarnings)} />
            <BreakdownStat label="Fee/margin" value={fmtUSD(-worker.feesOrMargin)} />
            <BreakdownStat label="Top-ups" value={fmtUSD(worker.topUps)} />
            <BreakdownStat label="Net paid" value={fmtUSD(worker.netPaid)} bold />
          </HStack>

          {/* Day-by-day breakdown */}
          <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={1}>
            Daily breakdown
          </Text>
          {worker.days.length === 0 ? (
            <Text fontSize="xs" color="fg.muted" fontStyle="italic">No activity recorded.</Text>
          ) : (
            <VStack align="stretch" gap={1}>
              {worker.days.map((d) => {
                const dayKey = `${worker.userId}|${d.date}`;
                const dayExpanded = expandedDays.has(dayKey);
                return (
                  <Box
                    key={d.date}
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="md"
                    bg="white"
                  >
                    <HStack
                      as="button"
                      onClick={() => onToggleDay(dayKey)}
                      gap={2}
                      px={2.5}
                      py={1.5}
                      w="full"
                      textAlign="left"
                      align="center"
                      _hover={{ bg: "blackAlpha.50" }}
                      cursor="pointer"
                      wrap="wrap"
                    >
                      <Box flexShrink={0} color="fg.muted">
                        {dayExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </Box>
                      <Text fontSize="xs" fontFamily="mono" minW="90px">{d.date}</Text>
                      <Text fontSize="xs" color="fg.muted" flex="1" minW="80px">
                        {d.hoursActive.toFixed(2)}h · {d.jobsCompleted} job{d.jobsCompleted === 1 ? "" : "s"}
                      </Text>
                      <Text fontSize="xs" fontWeight="semibold">{fmtUSD(d.netPaid)}</Text>
                    </HStack>
                    {dayExpanded && d.jobs.length > 0 && (
                      <Box px={2.5} pb={2} pt={0.5} borderTopWidth="1px" borderColor="gray.100">
                        <Table.Root size="sm" variant="line">
                          <Table.Header>
                            <Table.Row>
                              <Table.ColumnHeader fontSize="2xs">Job</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Gross</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Fee/margin</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Top-up</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs" textAlign="right">Net</Table.ColumnHeader>
                              <Table.ColumnHeader fontSize="2xs">Status</Table.ColumnHeader>
                            </Table.Row>
                          </Table.Header>
                          <Table.Body>
                            {d.jobs.map((j) => (
                              <Table.Row key={j.occurrenceId}>
                                <Table.Cell fontSize="xs">
                                  <Text>{j.title}</Text>
                                  {j.client && (
                                    <Text fontSize="2xs" color="fg.muted">{j.client}</Text>
                                  )}
                                </Table.Cell>
                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                  {fmtUSD(j.grossShare)}
                                </Table.Cell>
                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                  {fmtUSD(-j.feeOrMargin)}
                                </Table.Cell>
                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono">
                                  {j.topUp > 0 ? fmtUSD(j.topUp) : "—"}
                                </Table.Cell>
                                <Table.Cell fontSize="xs" textAlign="right" fontFamily="mono" fontWeight="semibold">
                                  {fmtUSD(j.netPaid)}
                                </Table.Cell>
                                <Table.Cell fontSize="2xs">
                                  {j.paymentWrittenOff ? (
                                    <Badge size="xs" colorPalette="gray" variant="subtle">written off</Badge>
                                  ) : j.paymentConfirmed ? (
                                    <Badge size="xs" colorPalette="green" variant="subtle">paid</Badge>
                                  ) : (
                                    <Badge size="xs" colorPalette="yellow" variant="subtle">unpaid</Badge>
                                  )}
                                  {j.source === "computed" && (
                                    <Badge ml={1} size="xs" colorPalette="orange" variant="outline">computed</Badge>
                                  )}
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table.Root>
                      </Box>
                    )}
                  </Box>
                );
              })}
            </VStack>
          )}
        </Box>
      )}
    </Box>
  );
}

function BreakdownStat({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <Box>
      <Text fontSize="2xs" color="fg.muted">{label}</Text>
      <Text fontSize="sm" fontWeight={bold ? "bold" : undefined} fontFamily="mono">{value}</Text>
    </Box>
  );
}
