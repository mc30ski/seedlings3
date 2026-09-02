// Presentational pieces for ForecastTab.
//
// Charts are CSS, not a library: the shapes here are bars and a waterfall,
// they need to repaint on every slider tick, and a charting dependency would
// buy nothing but weight. Everything below is a pure function of props so a
// re-render on drag stays cheap.

import React from "react";
import { Badge, Box, Button, HStack, Separator, Text, VStack } from "@chakra-ui/react";
import { FiAlertTriangle, FiInfo, FiTrendingUp, FiTrendingDown } from "react-icons/fi";
import type { ForecastResult, WorkerOutcome, ForecastAssessment } from "@/src/lib/forecast";
import { money, pct, VERDICT_LABEL, VERDICT_TONE } from "@/src/lib/forecast";

/** Local market band for lawn crew in the Triangle. General knowledge, not
 *  queried — shown as context for the fairness read, never as a rule. */
export const MARKET_LOW = 15;
export const MARKET_HIGH = 24;

// ── Headline numbers ────────────────────────────────────────────────────────

export function StatStrip({
  scenario,
  statusQuo,
  payOwner,
}: {
  scenario: ForecastResult;
  statusQuo: ForecastResult;
  payOwner: boolean;
}) {
  const profitNow = payOwner ? statusQuo.profitAfterOwnerLabor : statusQuo.profitBeforeOwnerLabor;
  const profitNew = payOwner ? scenario.profitAfterOwnerLabor : scenario.profitBeforeOwnerLabor;

  const cards = [
    {
      k: payOwner ? "Profit after owner labor" : "Profit before owner labor",
      v: money(profitNew),
      was: money(profitNow),
      up: profitNew >= profitNow,
      tone: profitNew >= 0 ? "green" : "red",
    },
    {
      k: "Margin",
      v: pct(scenario.marginPercent),
      was: pct(statusQuo.marginPercent),
      up: scenario.marginPercent >= statusQuo.marginPercent,
      tone: scenario.marginPercent >= 10 ? "green" : scenario.marginPercent >= 0 ? "orange" : "red",
    },
    {
      k: "Labor % of revenue",
      v: pct(scenario.laborPercentOfRevenue),
      was: pct(statusQuo.laborPercentOfRevenue),
      // Lower is better here, so the arrow has to be inverted deliberately.
      up: scenario.laborPercentOfRevenue <= statusQuo.laborPercentOfRevenue,
      tone: scenario.laborPercentOfRevenue <= 55 ? "green" : scenario.laborPercentOfRevenue <= 65 ? "orange" : "red",
    },
    {
      k: "Revenue",
      v: money(scenario.revenue),
      was: money(statusQuo.revenue),
      up: scenario.revenue >= statusQuo.revenue,
      tone: "gray",
    },
  ];

  return (
    <HStack gap={2} align="stretch" wrap="wrap">
      {cards.map((c) => (
        <Box
          key={c.k}
          flex="1 1 160px"
          minW="150px"
          borderWidth="1px"
          borderRadius="md"
          p={3}
          bg="bg.panel"
        >
          <Text fontSize="10px" letterSpacing="wide" textTransform="uppercase" color="fg.muted">
            {c.k}
          </Text>
          <HStack gap={1.5} align="baseline" mt={1}>
            <Text fontSize="22px" fontWeight="bold" color={`${c.tone}.solid`} lineHeight="1.1">
              {c.v}
            </Text>
            <Box as={c.up ? FiTrendingUp : FiTrendingDown} color={c.up ? "green.solid" : "red.solid"} />
          </HStack>
          <Text fontSize="11px" color="fg.muted" mt={0.5}>
            now {c.was}
          </Text>
        </Box>
      ))}
    </HStack>
  );
}

// ── Waterfall ───────────────────────────────────────────────────────────────

export function Waterfall({
  scenario,
  statusQuo,
  payOwner,
}: {
  scenario: ForecastResult;
  statusQuo: ForecastResult;
  payOwner: boolean;
}) {
  const rows: Array<{ label: string; now: number; next: number; kind: "in" | "out" | "total" }> = [
    { label: "Revenue collected", now: statusQuo.revenue, next: scenario.revenue, kind: "in" },
    { label: "Job materials", now: -statusQuo.materials, next: -scenario.materials, kind: "out" },
    { label: "Processor fees", now: -statusQuo.processorFees, next: -scenario.processorFees, kind: "out" },
    { label: "Crew pay", now: -statusQuo.crewPay, next: -scenario.crewPay, kind: "out" },
    { label: "Employer tax + workers comp", now: -statusQuo.employerBurden, next: -scenario.employerBurden, kind: "out" },
    { label: "Operating costs", now: -statusQuo.costsTotal, next: -scenario.costsTotal, kind: "out" },
    {
      label: "Profit before owner labor",
      now: statusQuo.profitBeforeOwnerLabor,
      next: scenario.profitBeforeOwnerLabor,
      kind: "total",
    },
  ];
  if (payOwner) {
    rows.push(
      { label: "Owner labor", now: -statusQuo.ownerPay, next: -scenario.ownerPay, kind: "out" },
      {
        label: "Profit after owner labor",
        now: statusQuo.profitAfterOwnerLabor,
        next: scenario.profitAfterOwnerLabor,
        kind: "total",
      },
    );
  }

  const scale = Math.max(scenario.revenue, statusQuo.revenue, 1);

  return (
    <VStack align="stretch" gap={0} borderWidth="1px" borderRadius="md" overflow="hidden">
      <HStack
        px={3}
        py={1.5}
        bg="bg.subtle"
        fontSize="10px"
        letterSpacing="wide"
        textTransform="uppercase"
        color="fg.muted"
      >
        <Text flex="1">Line</Text>
        <Text w="90px" textAlign="right">Now</Text>
        <Text w="90px" textAlign="right">Scenario</Text>
        <Text w="80px" textAlign="right">Change</Text>
      </HStack>
      {rows.map((r, i) => {
        const diff = r.next - r.now;
        const good = r.kind === "out" ? diff > 0 : diff > 0;
        return (
          <Box key={r.label} px={3} py={2} bg={r.kind === "total" ? "bg.subtle" : undefined}
               borderTopWidth={i === 0 ? 0 : "1px"}>
            <HStack gap={2}>
              <Text flex="1" fontSize="13px" fontWeight={r.kind === "total" ? "semibold" : "normal"}>
                {r.label}
              </Text>
              <Text w="90px" textAlign="right" fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
                {money(r.now)}
              </Text>
              <Text w="90px" textAlign="right" fontSize="13px" fontWeight="medium" fontVariantNumeric="tabular-nums">
                {money(r.next)}
              </Text>
              <Text
                w="80px"
                textAlign="right"
                fontSize="12px"
                fontVariantNumeric="tabular-nums"
                color={Math.abs(diff) < 0.5 ? "fg.muted" : good ? "green.solid" : "red.solid"}
              >
                {Math.abs(diff) < 0.5 ? "—" : money(diff)}
              </Text>
            </HStack>
            {/* Paired bars: the faint one is today, the solid one the scenario.
                Seeing both lengths at once is the point of the whole panel. */}
            <Box mt={1.5} position="relative" h="10px">
              <Box
                position="absolute" top="0" left="0" h="4px" borderRadius="sm"
                bg={r.kind === "in" ? "blue.muted" : r.kind === "total" ? "green.muted" : "red.muted"}
                w={`${Math.min(100, (Math.abs(r.now) / scale) * 100)}%`}
              />
              <Box
                position="absolute" top="5px" left="0" h="4px" borderRadius="sm"
                bg={r.kind === "in" ? "blue.solid" : r.kind === "total" ? "green.solid" : "red.solid"}
                w={`${Math.min(100, (Math.abs(r.next) / scale) * 100)}%`}
              />
            </Box>
          </Box>
        );
      })}
    </VStack>
  );
}

// ── Per-person outcomes ─────────────────────────────────────────────────────

export function WorkerFairnessTable({
  scenario,
  statusQuo,
}: {
  scenario: ForecastResult;
  statusQuo: ForecastResult;
}) {
  const rows = scenario.workers.filter((w) => w.clockedHours > 0);
  if (!rows.length) {
    return (
      <Text fontSize="13px" color="fg.muted">
        Nobody clocked hours in this window, so there are no per-person outcomes to show.
      </Text>
    );
  }
  const maxRate = Math.max(...rows.map((w) => w.effectiveHourly), MARKET_HIGH, 1);

  return (
    <VStack align="stretch" gap={0} borderWidth="1px" borderRadius="md" overflow="hidden">
      <HStack px={3} py={1.5} bg="bg.subtle" fontSize="10px" letterSpacing="wide"
              textTransform="uppercase" color="fg.muted">
        <Text flex="1">Worker</Text>
        <Text w="52px" textAlign="right">Hours</Text>
        <Text w="76px" textAlign="right">Pay</Text>
        <Text w="120px">Per hour vs market</Text>
        <Text w="70px" textAlign="right">Was</Text>
      </HStack>
      {rows.map((w, i) => {
        const before = statusQuo.workers.find((x) => x.userId === w.userId);
        const was = before?.effectiveHourly ?? 0;
        const change = was > 0 ? (w.effectiveHourly - was) / was : 0;
        return (
          <Box key={w.userId} px={3} py={2} borderTopWidth={i === 0 ? 0 : "1px"}>
            <HStack gap={2}>
              <HStack flex="1" gap={1.5} minW={0}>
                <Text fontSize="13px" fontWeight="medium" truncate>{w.name}</Text>
                {w.isOwner && <Badge size="xs" colorPalette="purple">Owner</Badge>}
                {w.hypothetical && <Badge size="xs" colorPalette="cyan">Modelled</Badge>}
                <Badge size="xs" variant="outline">
                  {w.workerType === "CONTRACTOR" ? "1099" : w.workerType === "TRAINEE" ? "Trainee" : "W-2"}
                </Badge>
              </HStack>
              <Text w="52px" textAlign="right" fontSize="12px" fontVariantNumeric="tabular-nums">
                {w.clockedHours.toFixed(0)}h
              </Text>
              <Text w="76px" textAlign="right" fontSize="12px" fontVariantNumeric="tabular-nums">
                {money(w.totalPay)}
              </Text>
              <Box w="120px">
                {/* Market band drawn behind the bar, so "is this fair" is a
                    glance rather than a calculation. */}
                <Box position="relative" h="14px" bg="bg.subtle" borderRadius="sm" overflow="hidden">
                  <Box
                    position="absolute" top="0" bottom="0"
                    left={`${(MARKET_LOW / maxRate) * 100}%`}
                    w={`${((MARKET_HIGH - MARKET_LOW) / maxRate) * 100}%`}
                    bg="green.muted" opacity={0.55}
                  />
                  <Box
                    position="absolute" top="3px" left="0" h="8px" borderRadius="sm"
                    w={`${Math.min(100, (w.effectiveHourly / maxRate) * 100)}%`}
                    bg={
                      w.effectiveHourly < 7.25 ? "red.solid"
                        : w.effectiveHourly < MARKET_LOW ? "orange.solid"
                        : "blue.solid"
                    }
                  />
                </Box>
                <Text fontSize="11px" fontVariantNumeric="tabular-nums" mt={0.5}>
                  ${w.effectiveHourly.toFixed(2)}/hr
                </Text>
              </Box>
              <VStack w="70px" align="end" gap={0}>
                <Text fontSize="11px" color="fg.muted" fontVariantNumeric="tabular-nums">
                  ${was.toFixed(2)}
                </Text>
                {was > 0 && Math.abs(change) > 0.01 && (
                  <Text
                    fontSize="11px"
                    fontVariantNumeric="tabular-nums"
                    color={change > 0 ? "green.solid" : "red.solid"}
                  >
                    {change > 0 ? "+" : "−"}{Math.abs(change * 100).toFixed(0)}%
                  </Text>
                )}
              </VStack>
            </HStack>
          </Box>
        );
      })}
      <Box px={3} py={1.5} bg="bg.subtle">
        <Text fontSize="11px" color="fg.muted">
          Green band is the local market rate ($15–24/hr). Per-hour figures divide total pay by
          hours actually clocked, drive time included.
        </Text>
      </Box>
    </VStack>
  );
}

// ── Guardrails ──────────────────────────────────────────────────────────────

export function WarningList({ warnings }: { warnings: ForecastResult["warnings"] }) {
  if (!warnings.length) {
    return (
      <HStack gap={2} px={3} py={2} borderWidth="1px" borderRadius="md" bg="bg.panel">
        <Box as={FiInfo} color="green.solid" />
        <Text fontSize="13px">No guardrails tripped. Nobody falls below market and the sample holds up.</Text>
      </HStack>
    );
  }
  return (
    <VStack align="stretch" gap={1.5}>
      {warnings.map((w, i) => (
        <HStack
          key={i}
          gap={2}
          align="start"
          px={3}
          py={2}
          borderWidth="1px"
          borderLeftWidth="3px"
          borderLeftColor={w.level === "critical" ? "red.solid" : "orange.solid"}
          borderRadius="md"
          bg="bg.panel"
        >
          <Box as={FiAlertTriangle} mt="2px" flexShrink={0}
               color={w.level === "critical" ? "red.solid" : "orange.solid"} />
          <Text fontSize="13px">{w.message}</Text>
        </HStack>
      ))}
    </VStack>
  );
}

// ── Costs, grouped by how they respond to volume ────────────────────────────

const BEHAVIOR_LABEL: Record<string, string> = {
  FIXED: "Fixed — doesn't grow with volume",
  VARIABLE: "Variable — scales with revenue",
  PER_JOB: "Per job — scales with job count",
  ONE_TIME: "One-time — excluded from a forward view",
  DISCRETIONARY: "Discretionary — you choose each period",
};

export function CostBreakdown({ scenario }: { scenario: ForecastResult }) {
  const groups = new Map<string, typeof scenario.costs>();
  for (const c of scenario.costs) {
    if (!groups.has(c.behavior)) groups.set(c.behavior, []);
    groups.get(c.behavior)!.push(c);
  }
  const order = ["FIXED", "VARIABLE", "PER_JOB", "DISCRETIONARY", "ONE_TIME"];
  const total = scenario.costsTotal || 1;

  return (
    <VStack align="stretch" gap={2}>
      {order.filter((b) => groups.has(b)).map((b) => {
        const rows = groups.get(b)!;
        const sub = rows.reduce((s, r) => s + r.amount, 0);
        return (
          <Box key={b} borderWidth="1px" borderRadius="md" p={2.5}>
            <HStack justify="space-between" mb={1}>
              <Text fontSize="11px" fontWeight="medium" color="fg.muted">{BEHAVIOR_LABEL[b] ?? b}</Text>
              <Text fontSize="12px" fontWeight="semibold" fontVariantNumeric="tabular-nums">
                {money(sub)} · {pct((sub / total) * 100, 0)}
              </Text>
            </HStack>
            {rows.sort((x, y) => y.amount - x.amount).map((r) => (
              <HStack key={r.category} gap={2} py={0.5}>
                <Text fontSize="12px" flex="1" truncate>{r.category}</Text>
                <Box flex="1" h="5px" bg="bg.subtle" borderRadius="sm" overflow="hidden" maxW="140px">
                  <Box h="100%" bg="orange.solid" w={`${Math.min(100, (r.amount / total) * 100)}%`} />
                </Box>
                <Text fontSize="12px" w="70px" textAlign="right" fontVariantNumeric="tabular-nums">
                  {money(r.amount)}
                </Text>
              </HStack>
            ))}
          </Box>
        );
      })}
    </VStack>
  );
}

// ── Which lever actually matters ────────────────────────────────────────────

export type SensitivityRow = { label: string; perUnit: string; impact: number };

export function SensitivityList({ rows }: { rows: SensitivityRow[] }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.impact)), 1);
  return (
    <VStack align="stretch" gap={1}>
      {rows.map((r) => (
        <HStack key={r.label} gap={2}>
          <VStack align="start" gap={0} w="150px" flexShrink={0}>
            <Text fontSize="12px">{r.label}</Text>
            <Text fontSize="10px" color="fg.muted">{r.perUnit}</Text>
          </VStack>
          <Box flex="1" h="16px" bg="bg.subtle" borderRadius="sm" overflow="hidden">
            <Box
              h="100%"
              bg={r.impact >= 0 ? "green.solid" : "red.solid"}
              w={`${(Math.abs(r.impact) / max) * 100}%`}
            />
          </Box>
          <Text fontSize="12px" w="70px" textAlign="right" fontVariantNumeric="tabular-nums"
                color={r.impact >= 0 ? "green.solid" : "red.solid"}>
            {money(r.impact)}
          </Text>
        </HStack>
      ))}
      <Text fontSize="11px" color="fg.muted" mt={1}>
        Profit change from moving one lever, holding everything else at its current position.
      </Text>
    </VStack>
  );
}

// ── AI assessment ───────────────────────────────────────────────────────────

export function AssessmentPanel({
  assessment,
  stale,
  loading,
  error,
  onRun,
}: {
  assessment: ForecastAssessment | null;
  stale: boolean;
  loading: boolean;
  error: string | null;
  onRun: () => void;
}) {
  if (error) {
    return (
      <HStack gap={2} align="start" px={3} py={2.5} borderWidth="1px" borderRadius="md"
              borderLeftWidth="3px" borderLeftColor="orange.solid" bg="bg.panel">
        <Box as={FiAlertTriangle} mt="2px" color="orange.solid" flexShrink={0} />
        <VStack align="start" gap={1.5}>
          <Text fontSize="13px">{error}</Text>
          <Button size="xs" variant="outline" onClick={onRun} loading={loading}>Try again</Button>
        </VStack>
      </HStack>
    );
  }

  if (!assessment) {
    return (
      <VStack align="start" gap={2} px={3} py={3} borderWidth="1px" borderRadius="md" bg="bg.panel">
        <Text fontSize="13px" color="fg.muted">
          Hand this scenario to Claude for a written read — what it does well, what it costs,
          and whether it's fair to the people named above.
        </Text>
        <Button size="sm" onClick={onRun} loading={loading} loadingText="Thinking…">
          Assess this forecast
        </Button>
        <Text fontSize="11px" color="fg.muted">
          Save the forecast first. The assessment is advice about a projection — treat it as a
          second opinion, not a decision.
        </Text>
      </VStack>
    );
  }

  return (
    <VStack align="stretch" gap={3} px={3} py={3} borderWidth="1px" borderRadius="md" bg="bg.panel">
      {stale && (
        <HStack gap={2} px={2} py={1.5} borderRadius="sm" bg="orange.subtle">
          <Box as={FiAlertTriangle} color="orange.solid" flexShrink={0} />
          <Text fontSize="12px">
            You've changed the assumptions since this was written, so it describes different
            numbers. Re-run it before relying on it.
          </Text>
        </HStack>
      )}

      <HStack gap={2} align="start">
        <Badge colorPalette={VERDICT_TONE[assessment.verdict]} size="sm">
          {VERDICT_LABEL[assessment.verdict]}
        </Badge>
        <Text fontSize="15px" fontWeight="semibold" lineHeight="1.35">{assessment.headline}</Text>
      </HStack>

      <Text fontSize="13px">{assessment.summary}</Text>

      {assessment.fairness && (
        <Box px={2.5} py={2} borderRadius="sm" bg="bg.subtle" borderLeftWidth="3px" borderLeftColor="purple.solid">
          <Text fontSize="10px" textTransform="uppercase" letterSpacing="wide" color="fg.muted" mb={1}>
            On fairness
          </Text>
          <Text fontSize="13px">{assessment.fairness}</Text>
        </Box>
      )}

      <HStack align="start" gap={4} wrap="wrap">
        {!!assessment.strengths?.length && (
          <VStack align="start" gap={1} flex="1 1 220px">
            <Text fontSize="10px" textTransform="uppercase" letterSpacing="wide" color="green.solid">
              Works
            </Text>
            {assessment.strengths.map((s, i) => (
              <Text key={i} fontSize="12.5px">• {s}</Text>
            ))}
          </VStack>
        )}
        {!!assessment.concerns?.length && (
          <VStack align="start" gap={1} flex="1 1 220px">
            <Text fontSize="10px" textTransform="uppercase" letterSpacing="wide" color="orange.solid">
              Costs
            </Text>
            {assessment.concerns.map((s, i) => (
              <Text key={i} fontSize="12.5px">• {s}</Text>
            ))}
          </VStack>
        )}
      </HStack>

      {!!assessment.recommendations?.length && (
        <>
          <Separator />
          <VStack align="stretch" gap={2}>
            <Text fontSize="10px" textTransform="uppercase" letterSpacing="wide" color="fg.muted">
              What to change
            </Text>
            {assessment.recommendations.map((r, i) => (
              <Box key={i}>
                <Text fontSize="13px" fontWeight="medium">{r.action}</Text>
                <Text fontSize="12.5px" color="fg.muted">{r.why}</Text>
              </Box>
            ))}
          </VStack>
        </>
      )}

      {!!assessment.questionsToResolve?.length && (
        <>
          <Separator />
          <VStack align="start" gap={1}>
            <Text fontSize="10px" textTransform="uppercase" letterSpacing="wide" color="fg.muted">
              The data can't answer these
            </Text>
            {assessment.questionsToResolve.map((q, i) => (
              <Text key={i} fontSize="12.5px">• {q}</Text>
            ))}
          </VStack>
        </>
      )}

      <HStack justify="space-between" pt={1}>
        <Text fontSize="11px" color="fg.muted">
          Model reproduced the books within {assessment.backtestPercent}% when this was written.
        </Text>
        <Button size="xs" variant="ghost" onClick={onRun} loading={loading}>Re-run</Button>
      </HStack>
    </VStack>
  );
}

// ── Side-by-side comparison ─────────────────────────────────────────────────

export type ComparisonEntry = {
  id: string;
  name: string;
  result: ForecastResult;
  window: string;
};

export function ComparisonPanel({
  entries,
  payOwner,
}: {
  entries: ComparisonEntry[];
  payOwner: boolean;
}) {
  if (entries.length < 2) {
    return (
      <Text fontSize="13px" color="fg.muted">
        Pick two or more saved forecasts to line them up here. Comparing the same window under
        different assumptions — or the same assumptions across two seasons — is usually more
        informative than either one alone.
      </Text>
    );
  }
  const profitOf = (e: ComparisonEntry) =>
    payOwner ? e.result.profitAfterOwnerLabor : e.result.profitBeforeOwnerLabor;
  const maxAbs = Math.max(...entries.map((e) => Math.abs(profitOf(e))), 1);

  const metrics: Array<{ label: string; get: (e: ComparisonEntry) => string }> = [
    { label: "Revenue", get: (e) => money(e.result.revenue) },
    { label: "Crew pay", get: (e) => money(e.result.crewPay) },
    { label: "Labor %", get: (e) => pct(e.result.laborPercentOfRevenue) },
    { label: "Margin", get: (e) => pct(e.result.marginPercent) },
    { label: "Jobs", get: (e) => String(e.result.jobCount) },
    { label: "Lowest paid /hr", get: (e) => {
      const paid = e.result.workers.filter((w) => w.clockedHours > 0 && !w.isOwner);
      if (!paid.length) return "—";
      const min = paid.reduce((a: WorkerOutcome, b) => (b.effectiveHourly < a.effectiveHourly ? b : a));
      return `$${min.effectiveHourly.toFixed(0)} (${min.name.split(" ")[0]})`;
    } },
  ];

  return (
    <VStack align="stretch" gap={3}>
      <VStack align="stretch" gap={1.5}>
        {entries.map((e) => {
          const p = profitOf(e);
          return (
            <HStack key={e.id} gap={2}>
              <VStack w="140px" align="start" gap={0} flexShrink={0}>
                <Text fontSize="12px" fontWeight="medium" truncate maxW="140px">{e.name}</Text>
                <Text fontSize="10px" color="fg.muted">{e.window}</Text>
              </VStack>
              <Box flex="1" h="18px" bg="bg.subtle" borderRadius="sm" position="relative">
                <Box
                  position="absolute" top="0" bottom="0" left="0" borderRadius="sm"
                  bg={p >= 0 ? "green.solid" : "red.solid"}
                  w={`${(Math.abs(p) / maxAbs) * 100}%`}
                />
              </Box>
              <Text w="80px" textAlign="right" fontSize="12px" fontWeight="medium"
                    fontVariantNumeric="tabular-nums" color={p >= 0 ? "green.solid" : "red.solid"}>
                {money(p)}
              </Text>
            </HStack>
          );
        })}
      </VStack>

      <Box overflowX="auto">
        <Box as="table" w="100%" fontSize="12px" style={{ borderCollapse: "collapse" }}>
          <Box as="thead">
            <Box as="tr">
              <Box as="th" textAlign="left" py={1} color="fg.muted" fontWeight="medium">Metric</Box>
              {entries.map((e) => (
                <Box key={e.id} as="th" textAlign="right" py={1} px={2} fontWeight="medium" truncate>
                  {e.name}
                </Box>
              ))}
            </Box>
          </Box>
          <Box as="tbody">
            {metrics.map((m) => (
              <Box as="tr" key={m.label} borderTopWidth="1px">
                <Box as="td" py={1.5} color="fg.muted">{m.label}</Box>
                {entries.map((e) => (
                  <Box key={e.id} as="td" py={1.5} px={2} textAlign="right"
                       fontVariantNumeric="tabular-nums">
                    {m.get(e)}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    </VStack>
  );
}
