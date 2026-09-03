// ─────────────────────────────────────────────────────────────────────────────
// Forecast — Super → Money → Forecast
//
// A pay-structure simulator. Pick a window of real jobs, move the levers, and
// see what the books and every worker's hourly rate would have looked like.
//
// ADVISORY. Nothing here writes a Setting or pays anyone. What it produces is
// a saved question you can argue from, not a decision that has been executed.
//
// Two design commitments worth keeping if this file is edited:
//
//   1. Simulation runs CLIENT-SIDE through @repo/money — the same module the
//      server uses. That keeps slider drags instant AND makes it impossible
//      for the tool's arithmetic to drift from the code that writes real
//      PaymentSplit rows.
//   2. Every scenario shows what it does to NAMED PEOPLE, not just to a labor
//      percentage. A margin number with the humans abstracted out is how you
//      talk yourself into something you'd never defend out loud.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  HStack,
  IconButton,
  Input,
  Select,
  Separator,
  Spinner,
  Text,
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import {
  FiPlus, FiSave, FiCopy, FiTrash2, FiRefreshCw, FiArchive, FiX, FiBarChart2, FiInfo,
} from "react-icons/fi";
import { LineChart, ChevronDown } from "lucide-react";
import { simulate, defaultAssumptions, describePayShape, migrateAssumptions } from "@repo/money";
import type { Assumptions, ForecastBaseline, ForecastResult, WorkerType } from "@repo/money";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { bizToday, bizAddDays } from "@/src/lib/dates";
import { SectionExpander } from "@/src/ui/tabs/PreviewRoutesTab.parts";
import {
  fetchBaseline, fetchForecasts, fetchForecast, createForecast, updateForecast, duplicateForecast,
  archiveForecast, deleteForecast, assessForecast, assessmentIsStale, newHypothetical,
  money,
  type BaselineResponse, type SavedForecast, type ForecastAssessment,
} from "@/src/lib/forecast";
import {
  StatStrip, MoneyFlow, Waterfall, WorkerFairnessTable, WarningList, CostBreakdown,
  SensitivityList, AssessmentPanel, ComparisonPanel, MarketRateProvenance,
  type SensitivityRow, type ComparisonEntry,
} from "@/src/ui/tabs/ForecastTab.parts";

// ── Window presets ──────────────────────────────────────────────────────────
//
// Seasonality in this business is large, so the presets are seasons rather
// than rolling windows. Comparing spring against summer is usually the more
// useful question, and a rolling "last 30 days" invites annualising a peak.
type Preset = { key: string; label: string; range: () => [string, string] };
const PRESETS: Preset[] = [
  { key: "90d", label: "Last 90 days", range: () => [bizAddDays(bizToday(), -90), bizToday()] },
  { key: "180d", label: "Last 6 months", range: () => [bizAddDays(bizToday(), -180), bizToday()] },
  { key: "ytd", label: "Year to date", range: () => [`${bizToday().slice(0, 4)}-01-01`, bizToday()] },
  { key: "12m", label: "Last 12 months", range: () => [bizAddDays(bizToday(), -365), bizToday()] },
];

const WORKER_TYPES = [
  { value: "EMPLOYEE", label: "Employee (W-2)" },
  { value: "CONTRACTOR", label: "Contractor (1099)" },
  { value: "TRAINEE", label: "Trainee (W-2)" },
];
const CAPACITY_MODES = [
  { value: "SUBSTITUTION", label: "Takes over existing hours" },
  { value: "ADDED_CAPACITY", label: "Brings new work" },
];

/** Heading for a group of levers.
 *
 *  These were the same muted 11px uppercase run used for every minor label on
 *  the tab, so the three groups didn't read as divisions at all — the column
 *  of sliders looked like one undifferentiated list. An accent bar and a rule
 *  that runs to the edge give them weight without turning them into headings
 *  that compete with the section title above. */
function GroupHeading({ children, mt = 0 }: { children: React.ReactNode; mt?: number }) {
  return (
    <Box
      mt={mt} mb={1}
      bg="bg.emphasized"
      borderLeftWidth="4px" borderLeftColor="blue.solid"
      borderTopRightRadius="md" borderBottomRightRadius="md"
      px={3} py={2}
    >
      <Text fontSize="13px" fontWeight="bold" textTransform="uppercase"
            letterSpacing="0.1em" color="fg" lineHeight="1.2">
        {children}
      </Text>
    </Box>
  );
}

/** Small labelled slider. Chakra's Slider in v3 is heavier than this needs to
 *  be, and a native range input is the one form control the house rule about
 *  `<select>` doesn't cover. */
function Lever({
  label, value, baseline, min, max, step = 1, suffix = "", onChange, hint, info,
  disabled, disabledReason,
}: {
  label: string; value: number;
  /** Where this lever sits today, before any adjustment — the live setting
   *  where one exists, otherwise the neutral default. Shown beside the
   *  current value so an adjustment is always read against its starting
   *  point rather than in isolation. */
  baseline?: number;
  min: number; max: number; step?: number;
  suffix?: string; onChange: (n: number) => void;
  /** One line under the control, always visible. */
  hint?: string;
  /** The full explanation, behind the (i). Answers "what does this actually
   *  do to my numbers", not just what it is called. */
  info?: string;
  disabled?: boolean;
  /** Why it's disabled. Required whenever `disabled` can be true. */
  disabledReason?: string;
}) {
  // DIRECTION, not judgement. Green means you moved this lever up and red means
  // you moved it down — it does NOT mean the change is good or bad for the
  // business. Raising "Business keeps" is green and costs the crew; raising
  // "Fixed costs" is green and costs you. The colour answers "which way did I
  // push this", which is the thing that's hard to see at a glance across a
  // dozen sliders; whether that was wise is what the numbers below are for.
  const delta = baseline === undefined ? 0 : value - baseline;
  const changed = Math.abs(delta) > 1e-9;
  const [showInfo, setShowInfo] = useState(false);
  return (
    <Box opacity={disabled ? 0.45 : 1}>
      <HStack justify="space-between" mb={0.5} gap={2}>
        <HStack gap={1} minW={0}>
          <Text fontSize="12px" fontWeight="medium">{label}</Text>
          {info && (
            <Box
              as="button"
              aria-label={`What does "${label}" do?`}
              onClick={() => setShowInfo((v) => !v)}
              color={showInfo ? "blue.solid" : "fg.muted"}
              display="inline-flex"
              flexShrink={0}
              _hover={{ color: "blue.solid" }}
            >
              <FiInfo size={12} />
            </Box>
          )}
        </HStack>
        <HStack gap={1.5} flexShrink={0}>
          {changed && (
            <>
              <Text fontSize="11px" color="fg.muted" fontVariantNumeric="tabular-nums"
                    textDecoration="line-through">
                {baseline}{suffix}
              </Text>
              <Text fontSize="11px" color="fg.muted">→</Text>
            </>
          )}
          <Text
            fontSize="12px"
            fontWeight={changed ? "bold" : "normal"}
            color={changed ? (delta > 0 ? "green.fg" : "red.fg") : "fg.muted"}
            fontVariantNumeric="tabular-nums"
          >
            {/* Sign the delta explicitly. Colour alone fails for anyone who
                can't separate red from green, and it's the one cue that
                survives a screenshot pasted into a message. */}
            {value}{suffix}
            <Text as="span" fontSize="10px" fontWeight="normal" ml={0.5}>
              {changed ? (delta > 0 ? "▲" : "▼") : ""}
            </Text>
          </Text>
        </HStack>
      </HStack>
      <input
        type="range"
        min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "var(--chakra-colors-blue-500)" }}
      />
      {showInfo && info && (
        <Box mt={1.5} mb={1} px={2.5} py={2} bg="blue.subtle" borderRadius="md"
             borderLeftWidth="3px" borderColor="blue.solid">
          <Text fontSize="11.5px" lineHeight="1.5">{info}</Text>
        </Box>
      )}
      {/* A greyed-out control with no reason is just a dead control. */}
      {disabled && disabledReason && (
        <Text fontSize="10.5px" color="orange.fg" mt={0.5}>{disabledReason}</Text>
      )}
      {hint && !disabled && <Text fontSize="10.5px" color="fg.muted" mt={0.5}>{hint}</Text>}
    </Box>
  );
}

function Picker({
  label, value, baseline, options, onChange, w = "100%",
}: {
  label?: string; value: string;
  /** The unadjusted choice, shown struck through when you've moved off it. */
  baseline?: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void; w?: string;
}) {
  const collection = useMemo(() => createListCollection({ items: options }), [options]);
  const changed = baseline !== undefined && baseline !== value;
  const baseLabel = options.find((o) => o.value === baseline)?.label ?? baseline;
  return (
    <Box w={w}>
      {label && (
        <HStack justify="space-between" mb={0.5} gap={2}>
          <Text fontSize="12px" fontWeight="medium">{label}</Text>
          {changed && (
            <Text fontSize="11px" color="fg.muted" textDecoration="line-through" truncate maxW="120px">
              {baseLabel}
            </Text>
          )}
        </HStack>
      )}
      <Select.Root
        collection={collection}
        value={[value]}
        onValueChange={(e) => { const v = e.value?.[0]; if (v) onChange(v); }}
        size="sm"
        positioning={{ strategy: "fixed", hideWhenDetached: true }}
      >
        <Select.Control>
          <Select.Trigger w="100%" px="2">
            <Select.ValueText placeholder="Choose" />
            <Select.Indicator />
          </Select.Trigger>
        </Select.Control>
        <Select.Positioner>
          <Select.Content minW="var(--reference-width)">
            {collection.items.map((item) => (
              <Select.Item key={item.value} item={item.value}>
                <Select.ItemText>{item.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Select.Root>
    </Box>
  );
}

/**
 * A stored scenario, laid over today's defaults.
 *
 * Saved assumptions are a jsonb snapshot of whatever levers existed the day
 * they were saved, so a scenario from before a new lever shipped has no key
 * for it. Without this the control renders `undefined` and React flips it to
 * an uncontrolled input; with it, an old scenario simply means "that lever was
 * at its default", which is exactly what it meant when it was saved.
 */
function hydrate(stored: Assumptions, baseline: ForecastBaseline): Assumptions {
  // migrateAssumptions first: a scenario saved under the old pay-model
  // dropdown needs "RATE_CARD" rewritten as "business keeps 100%", or the
  // additive rules would pay both the rate card and the share.
  return {
    ...defaultAssumptions(baseline),
    ...(migrateAssumptions(stored as unknown as Record<string, unknown>) as Partial<Assumptions>),
  };
}

export default function ForecastTab() {
  const [from, setFrom] = usePersistedState("forecast_from", PRESETS[0].range()[0]);
  const [to, setTo] = usePersistedState("forecast_to", PRESETS[0].range()[1]);
  // Which preset produced the current window, so the badge can name it. Cleared
  // the moment either date is edited by hand — a badge still reading "Last 90
  // days" over a hand-picked range is worse than no label at all.
  const [presetKey, setPresetKey] = usePersistedState("forecast_preset", PRESETS[0].key);
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);

  // Close on any click that isn't the badge itself. The badge stops propagation,
  // so this only ever fires for clicks elsewhere on the page.
  useEffect(() => {
    if (!presetMenuOpen) return;
    const close = () => setPresetMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [presetMenuOpen]);
  const [data, setData] = useState<BaselineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [assumptions, setAssumptions] = useState<Assumptions | null>(null);

  const [saved, setSaved] = useState<SavedForecast[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const [assessment, setAssessment] = useState<ForecastAssessment | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [assessError, setAssessError] = useState<string | null>(null);

  const [compareIds, setCompareIds] = useState<string[]>([]);
  // Baselines for windows OTHER than the one currently loaded. A saved
  // scenario must be replayed against its own window — otherwise the
  // comparison prints one window's label above another window's numbers,
  // which is exactly the seasonality question it exists to answer.
  const [otherBaselines, setOtherBaselines] = useState<Record<string, BaselineResponse>>({});
  const [comparing, setComparing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SavedForecast | null>(null);

  // ── Load the window ──────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchBaseline(from, to);
      setData(res);
      // Only reset the levers when there's no scenario in progress — reloading
      // a window shouldn't silently throw away what the operator was building.
      setAssumptions((prev) => prev ?? defaultAssumptions(res.baseline));
    } catch (e) {
      publishInlineMessage({ type: "WARNING", text: getErrorMessage("Couldn't load the forecast baseline for that window.", e) });
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetchForecasts().then(setSaved).catch(() => { /* list is non-critical */ });
  }, []);

  useEffect(() => {
    const needed = saved
      .filter((s) => compareIds.includes(s.id))
      .map((s) => `${s.windowFrom}|${s.windowTo}`)
      .filter((k, i, all) => all.indexOf(k) === i)
      .filter((k) => k !== `${from}|${to}` && !otherBaselines[k]);
    if (!needed.length) return;
    let cancelled = false;
    setComparing(true);
    Promise.all(
      needed.map(async (k) => {
        const [f, t] = k.split("|");
        return [k, await fetchBaseline(f, t)] as const;
      }),
    )
      .then((pairs) => {
        if (cancelled) return;
        setOtherBaselines((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      })
      .catch((e) =>
        publishInlineMessage({
          type: "WARNING",
          text: getErrorMessage("Couldn't load one of the windows being compared.", e),
        }),
      )
      .finally(() => { if (!cancelled) setComparing(false); });
    return () => { cancelled = true; };
  }, [compareIds, saved, from, to, otherBaselines]);

  const set = useCallback(<K extends keyof Assumptions>(key: K, value: Assumptions[K]) => {
    setAssumptions((a) => (a ? { ...a, [key]: value } : a));
    setDirty(true);
  }, []);

  // ── Simulate ─────────────────────────────────────────────────────────────
  const scenario: ForecastResult | null = useMemo(
    () => (data && assumptions ? simulate(data.baseline, assumptions) : null),
    [data, assumptions],
  );

  // Which lever actually matters. Each row perturbs ONE input and reports the
  // profit change, so the operator doesn't have to hunt for the big one.
  const sensitivity: SensitivityRow[] = useMemo(() => {
    if (!data || !assumptions || !scenario) return [];
    const base = scenario.profitBeforeOwnerLabor;
    const probe = (over: Partial<Assumptions>) =>
      simulate(data.baseline, { ...assumptions, ...over }).profitBeforeOwnerLabor - base;
    return [
      { label: "Business margin", perUnit: "+5 points from employees",
        impact: probe({ employeeMarginPercent: assumptions.employeeMarginPercent + 5 }) },
      { label: "Contractor fee", perUnit: "+5 points",
        impact: probe({ contractorFeePercent: assumptions.contractorFeePercent + 5 }) },
      { label: "Prices", perUnit: "+5% across the board",
        impact: probe({ priceIncreasePercent: assumptions.priceIncreasePercent + 5 }) },
      { label: "Minimum invoice", perUnit: "floor raised $10",
        impact: probe({ minimumInvoice: assumptions.minimumInvoice + 10 }) },
      { label: "Volume", perUnit: "+25% more work",
        impact: probe({ volumeMultiplier: assumptions.volumeMultiplier + 0.25 }) },
      { label: "Fixed costs", perUnit: "cut 20%",
        impact: probe({ fixedCostOverride: scenario.fixedCosts * 0.8 }) },
      { label: "Hourly base", perUnit: "+$1/hr",
        impact: probe({ hourlyBase: assumptions.hourlyBase + 1 }) },
      { label: "Pay-period guarantee", perUnit: "+1 guaranteed hour",
        impact: probe({ guaranteedHoursPerPeriod: assumptions.guaranteedHoursPerPeriod + 1 }) },
      { label: "Cost inflation", perUnit: "+3% on costs",
        impact: probe({ costInflationPercent: assumptions.costInflationPercent + 3 }) },
    ].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  }, [data, assumptions, scenario]);

  const comparison: ComparisonEntry[] = useMemo(() => {
    if (!data) return [];
    const picked = saved.filter((s) => compareIds.includes(s.id));
    const rows: ComparisonEntry[] = picked.flatMap((s) => {
      // Each scenario is computed from ITS OWN window's data. A row whose
      // window hasn't finished loading is skipped rather than silently
      // rendered against the wrong numbers.
      const key = `${s.windowFrom}|${s.windowTo}`;
      const src = key === `${from}|${to}` ? data : otherBaselines[key];
      if (!src) return [];
      return [{
        id: s.id,
        name: s.name,
        window: `${s.windowFrom} → ${s.windowTo}`,
        result: simulate(src.baseline, hydrate(s.assumptions, src.baseline)),
      }];
    });
    if (assumptions && scenario) {
      rows.unshift({
        id: "__current__",
        name: name.trim() || "Working scenario",
        window: `${from} → ${to}`,
        result: scenario,
      });
    }
    return rows;
  }, [saved, compareIds, data, otherBaselines, assumptions, scenario, name, from, to]);

  // ── Saving ───────────────────────────────────────────────────────────────
  async function save() {
    if (!assumptions) return;
    if (!name.trim()) {
      publishInlineMessage({ type: "WARNING", text: "Give the forecast a name before saving it." });
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(), notes,
        windowFrom: from, windowTo: to,
        assumptions,
      };
      const row = activeId
        ? await updateForecast(activeId, payload)
        : await createForecast(payload);
      setActiveId(row.id);
      setDirty(false);
      setSaved(await fetchForecasts());
      publishInlineMessage({ type: "SUCCESS", text: `Saved "${row.name}".` });
    } catch (e) {
      publishInlineMessage({ type: "WARNING", text: getErrorMessage("Couldn't save the forecast.", e) });
    } finally {
      setBusy(false);
    }
  }

  async function loadScenario(s: SavedForecast) {
    setActiveId(s.id);
    setName(s.name);
    setNotes(s.notes ?? "");
    setAssumptions(data ? hydrate(s.assumptions, data.baseline) : s.assumptions);
    setAssessError(null);
    setDirty(false);
    if (s.windowFrom !== from || s.windowTo !== to) {
      setFrom(s.windowFrom);
      setTo(s.windowTo);
    }
    // The list omits the assessment blob, so fetch the full record for the
    // one being opened. Failing here costs the cached write-up, not the
    // scenario, so it degrades quietly rather than blocking the open.
    try {
      const full = await fetchForecast(s.id);
      setAssessment(full.assessment ?? null);
      if (full.assumptions) {
        setAssumptions(data ? hydrate(full.assumptions, data.baseline) : full.assumptions);
      }
    } catch {
      setAssessment(null);
    }
  }

  function startNew() {
    if (!data) return;
    setActiveId(null);
    setName("");
    setNotes("");
    setAssumptions(defaultAssumptions(data.baseline));
    setAssessment(null);
    setAssessError(null);
    setDirty(false);
  }

  async function runAssessment() {
    if (!activeId) {
      publishInlineMessage({
        type: "WARNING",
        text: "Save the forecast first — the assessment is written about a saved scenario.",
      });
      return;
    }
    if (dirty) {
      publishInlineMessage({
        type: "WARNING",
        text: "Save your changes first, otherwise the assessment would describe the previous numbers.",
      });
      return;
    }
    setAssessing(true);
    setAssessError(null);
    try {
      const res = await assessForecast(activeId);
      if (res.error) setAssessError(res.error);
      else setAssessment(res.assessment);
      setSaved(await fetchForecasts());
    } catch (e) {
      setAssessError(getErrorMessage("The assessment couldn't be generated.", e));
    } finally {
      setAssessing(false);
    }
  }

  const crewRevenuePerHour = scenario?.revenuePerClockedHour ?? 60;

  if (loading && !data) {
    return <Box py={10} textAlign="center"><Spinner size="lg" /></Box>;
  }
  if (!data || !assumptions || !scenario) {
    return (
      <Box py={8} textAlign="center">
        <Text fontSize="14px" color="fg.muted">
          Couldn't load the forecast baseline. Try reloading the window.
        </Text>
        <Button mt={3} size="sm" onClick={() => void load()}>Retry</Button>
      </Box>
    );
  }

  const a = assumptions;
  const sq = data.statusQuo;
  // What every lever sits at before you touch it. Same function the model
  // uses for the "Today" column, so the two can never disagree about what
  // the current settings are.
  const base = defaultAssumptions(data.baseline);
  // How pay periods are described and how many the window holds. Comes from
  // the baseline so the copy matches PAYROLL_PERIOD_CADENCE instead of
  // hard-coding "weekly" and being wrong the day it changes.
  const periodCount = data.baseline.payPeriods?.keys.length ?? 0;
  const periodWord = (data.baseline.payPeriods?.cadence ?? "WEEKLY").toLowerCase();
  // What the pay levers currently add up to, named if it lands on a structure
  // that has a name.
  const shape = describePayShape(a);

  return (
    <VStack align="stretch" gap={3}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <Box borderWidth="1px" borderRadius="md" p={3} bg="bg.panel">
        <HStack justify="space-between" wrap="wrap" gap={2} mb={2}>
          <HStack gap={2}>
            <Box as={LineChart} />
            <Text fontSize="16px" fontWeight="semibold">Forecast</Text>
            <Badge size="xs" variant="outline">Advisory — changes nothing</Badge>
          </HStack>
          <HStack gap={1.5}>
            <Button size="xs" variant="outline" onClick={startNew}>
              <Box as={FiPlus} /> New
            </Button>
            <Button size="xs" onClick={save} loading={busy}>
              <Box as={FiSave} /> {activeId ? "Save" : "Save as new"}
            </Button>
          </HStack>
        </HStack>

        <HStack gap={2} wrap="wrap" align="end">
          <Box>
            <Text fontSize="11px" color="fg.muted" mb={0.5}>From</Text>
            <Input size="sm" type="date" value={from} w="145px"
                   onChange={(e) => { setFrom(e.target.value); setPresetKey(""); }} />
          </Box>
          <Box>
            <Text fontSize="11px" color="fg.muted" mb={0.5}>To</Text>
            <Input size="sm" type="date" value={to} w="145px"
                   onChange={(e) => { setTo(e.target.value); setPresetKey(""); }} />
          </Box>
          {/* Green preset badge — same affordance as the timeframe pickers on
              Payments and the other money tabs, so a date range is picked the
              same way everywhere. */}
          <Box position="relative" pb={0.5} onClick={(e: any) => e.stopPropagation()}>
            <Badge size="sm" colorPalette="green" variant="subtle" cursor="pointer"
                   onClick={() => setPresetMenuOpen((v) => !v)}>
              {PRESETS.find((p) => p.key === presetKey)?.label ?? "Custom dates"}
              {" "}
              <Box as="span" display="inline-flex" alignItems="center" justifyContent="center"
                   w="14px" h="14px" borderRadius="full" bg="green.500" color="white"
                   verticalAlign="middle">
                <ChevronDown size={9} />
              </Box>
            </Badge>
            {presetMenuOpen && (
              <VStack
                position="fixed" bg="bg.panel" borderWidth="1px" borderColor="border"
                rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="160px"
                ref={(el: HTMLDivElement | null) => {
                  if (el && el.parentElement) {
                    const rect = el.parentElement.getBoundingClientRect();
                    el.style.top = `${rect.bottom + 4}px`;
                    el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 168))}px`;
                  }
                }}
              >
                {PRESETS.map((p) => (
                  <Button key={p.key} size="xs" w="full" justifyContent="start"
                          variant={presetKey === p.key ? "solid" : "ghost"}
                          colorPalette={presetKey === p.key ? "green" : undefined}
                          onClick={() => {
                            const [f, t] = p.range();
                            setFrom(f); setTo(t); setPresetKey(p.key);
                            setPresetMenuOpen(false);
                          }}>
                    {p.label}
                  </Button>
                ))}
              </VStack>
            )}
          </Box>
          <IconButton size="xs" variant="ghost" aria-label="Reload window"
                      onClick={() => void load()} loading={loading}>
            <Box as={FiRefreshCw} />
          </IconButton>
        </HStack>

        {/* The trust line. Not a precision claim — a smoke detector. If this
            number ever jumps, the model has broken, not the business. */}
        <HStack gap={2} mt={2} wrap="wrap">
          <Text fontSize="11.5px" color="fg.muted">
            {data.baseline.jobs.length} paid jobs · {sq.totalClockedHours.toFixed(0)}h clocked ·
            replaying today's settings lands within{" "}
            <Text as="span" fontWeight="semibold"
                  color={data.backtest.differencePercent < 10 ? "green.solid" : "orange.solid"}>
              {data.backtest.differencePercent}%
            </Text>{" "}
            of the books
          </Text>
          {data.baseline.jobs.length < 30 && (
            <Badge size="xs" colorPalette="orange">Small sample</Badge>
          )}
        </HStack>

        <HStack gap={2} mt={2} wrap="wrap">
          <Input size="sm" placeholder="Scenario name" value={name} maxW="260px"
                 onChange={(e) => { setName(e.target.value); setDirty(true); }} />
          {dirty && <Badge size="xs" colorPalette="orange">Unsaved</Badge>}
          {activeId && (
            <>
              <Button size="xs" variant="ghost" loading={busy} onClick={async () => {
                setBusy(true);
                try {
                  const copy = await duplicateForecast(activeId);
                  setSaved(await fetchForecasts());
                  await loadScenario(copy);
                  publishInlineMessage({ type: "SUCCESS", text: `Duplicated as "${copy.name}".` });
                } catch (e) {
                  publishInlineMessage({ type: "WARNING", text: getErrorMessage("Couldn't duplicate the forecast.", e) });
                } finally { setBusy(false); }
              }}>
                <Box as={FiCopy} /> Duplicate
              </Button>
              <Button size="xs" variant="ghost" colorPalette="red"
                      onClick={() => setConfirmDelete(saved.find((s) => s.id === activeId) ?? null)}>
                <Box as={FiTrash2} /> Delete
              </Button>
            </>
          )}
        </HStack>

        {/* Why this scenario exists. Saved with it and handed to the AI
            assessment, which reads much better when it knows what the
            operator was actually trying to work out. */}
        <Textarea
          mt={2}
          size="sm"
          rows={2}
          placeholder="What are you trying to work out?"
          value={notes}
          onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
        />
      </Box>

      {/* ── Headline ───────────────────────────────────────────────────── */}
      <StatStrip scenario={scenario} statusQuo={sq} />

      {/* Deliberately NOT in a SectionExpander. "Where did the revenue go" is
          the first question anyone asks, and it was only answerable inside a
          collapsible that remembers being closed. */}
      <MoneyFlow scenario={scenario}
                 capitalPurchases={data.baseline.actual.fixedAssetPurchases} />

      {/* ── Levers ─────────────────────────────────────────────────────── */}
      <SectionExpander emphasis title="Adjustments" storageKey="forecast_sec_levers" defaultOpen>
        <VStack align="stretch" gap={3} pt={2}>
          {/* One column, read top to bottom. Side by side, the three groups
              had no reading order — "Employer costs" sat below "Pricing and
              volume" in the right-hand column while "How people are paid"
              filled the left, so which lever came after which depended on the
              window width. */}
          <VStack align="stretch" gap={4}>
            <VStack align="stretch" gap={2.5}>
              <GroupHeading>How people are paid</GroupHeading>
              {/* Read out of the levers, not a control of them. There used to
                  be a "pay model" dropdown here that greyed out whichever
                  levers its mode didn't use — which made pure hourly, the
                  structure most likely to be the right answer, impossible to
                  express. The levers are free now and this names what they
                  come to. */}
              <Box borderWidth="1px" borderRadius="md" px={2.5} py={2} bg="bg.subtle">
                <HStack gap={1.5} mb={0.5}>
                  <Text fontSize="10px" textTransform="uppercase" letterSpacing="wide"
                        color="fg.muted">
                    This structure is
                  </Text>
                  {shape.name ? (
                    <Badge size="xs" colorPalette="blue">{shape.name}</Badge>
                  ) : (
                    <Badge size="xs" variant="outline">A blend</Badge>
                  )}
                </HStack>
                <Text fontSize="11.5px" color="fg.muted">
                  Workers are paid {shape.detail}.
                </Text>
                {!shape.name && (
                  <Text fontSize="10.5px" color="fg.muted" mt={0.5}>
                    Nothing wrong with that — it just doesn't match a structure with a
                    standard name.
                  </Text>
                )}
              </Box>
              <Lever
                label="Business keeps — employees"
                info={"The share of each job the business retains from a W-2 worker's cut; they take the rest. Applied to each worker's OWN share of a job, never to the pool \u2014 so on a two-person job each person's rate applies only to their half. Employer payroll tax and workers comp are charged on top of what the worker takes, so an employee costs more than their share alone."} value={a.employeeMarginPercent} baseline={base.employeeMarginPercent}
                min={0} max={100} suffix="%"
                onChange={(n) => set("employeeMarginPercent", n)}
                hint={a.employeeMarginPercent >= 100
                  ? "Worker share 0% — the job pays nothing on its own, so pay comes only from the hourly base and rate card."
                  : `Worker share ${100 - a.employeeMarginPercent}%`}
              />
              <Lever
                label="Business keeps — contractors"
                info={"The same thing for 1099 contractors \u2014 the platform fee the business keeps from their share. Contractors carry no employer payroll tax and no workers comp, so a dollar paid to a contractor costs the business a dollar, where a dollar to an employee costs roughly $1.26."} value={a.contractorFeePercent} baseline={base.contractorFeePercent}
                min={0} max={100} suffix="%"
                onChange={(n) => set("contractorFeePercent", n)}
                hint={a.contractorFeePercent >= 100
                  ? "Worker share 0% — the job pays nothing on its own."
                  : `Worker share ${100 - a.contractorFeePercent}%`}
              />
              <Lever
                label="Guaranteed hourly base"
                info={"An hourly wage paid for every hour a worker actually clocks \u2014 clock-in to clock-out, including drive time, loading and rain delays. It is NOT a guaranteed number of hours: clock three hours and you are paid for three. It is also NOT a floor that the job share tops up to \u2014 it is ADDED to the share, so raising it without lowering the share raises total pay. Its purpose is to pay for the hours a pure share model pays nothing for. Set it alongside a business-keeps of 100% and you have a plain hourly wage."} value={a.hourlyBase} baseline={base.hourlyBase}
                min={0} max={30} suffix="/hr"
                onChange={(n) => set("hourlyBase", n)}
                hint="Covers drive time, rain days and training — the hours a pure share model pays nothing for."
              />
              <Lever
                label="Crew-lead premium"
                info={"Extra dollars per hour on top of the base, paid only to workers marked as crew lead. Makes a seniority premium something you set deliberately rather than something that emerges from who happened to be assigned the expensive jobs."} value={a.leadHourlyBonus} baseline={base.leadHourlyBonus}
                min={0} max={10} suffix="/hr"
                onChange={(n) => set("leadHourlyBonus", n)}
                hint="Makes a productivity premium explicit rather than an artifact of job assignment."
              />
              <Lever
                label="Guaranteed hours per pay period"
                info={
                  "A floor under each " + periodWord + " paycheck. Everyone covered is paid for at least this many hours in EVERY " +
                  periodWord + " period \u2014 including the periods they didn't work at all, which is what makes it a guarantee rather than a bonus for showing up. " +
                  "Someone who clocks 2 hours against a 5-hour floor is paid for 5; someone who clocks 9 is paid for 9. " +
                  "Only the shortfall is added, and it is paid at the base rate above, without the crew-lead premium. " +
                  "The cost lands mostly in slow " + periodWord + " periods, not slow days, and it is W-2 wages \u2014 employer payroll tax and workers comp are charged on top."
                }
                value={a.guaranteedHoursPerPeriod} baseline={base.guaranteedHoursPerPeriod}
                min={0} max={40} suffix="h"
                onChange={(n) => set("guaranteedHoursPerPeriod", n)}
                hint={
                  a.guaranteedHoursPerPeriod > 0 && periodCount > 0
                    ? `Applies to all ${periodCount} ${periodWord} periods in this window, worked or not.`
                    : "0 turns it off. Pay is then whatever the hours and the share come to."
                }
                disabled={a.hourlyBase <= 0}
                disabledReason={"Needs an hourly base above \u2014 the shortfall is paid at that rate, so at $0/hr it costs nothing."}
              />
              {a.guaranteedHoursPerPeriod > 0 && a.hourlyBase > 0 && (
                <Checkbox.Root size="sm" checked={a.guaranteeContractors}
                               onCheckedChange={(e) => set("guaranteeContractors", !!e.checked)}>
                  <Checkbox.HiddenInput /><Checkbox.Control />
                  <Checkbox.Label fontSize="12px">
                    Also guarantee contractors
                    <Text fontSize="10.5px" color="orange.fg">
                      A guaranteed minimum makes a 1099 worker look like an employee.
                    </Text>
                  </Checkbox.Label>
                </Checkbox.Root>
              )}
              <Lever
                label="Rate card per job"
                info={"A flat amount paid per job, split across whoever worked it by their split percentage, with the client's price ignored entirely. It is ADDED to the job share, so on its own it is a per-job bonus. For a TRUE rate card \u2014 pay fully decoupled from price \u2014 raise business-keeps to 100%, which zeroes the share and leaves this as the whole of job-based pay. That is the point of the structure: under a share model the crew automatically takes a cut of every price rise, so a price increase never reaches the business."} value={a.rateCardPerJob} baseline={base.rateCardPerJob}
                min={0} max={120} suffix=""
                onChange={(n) => set("rateCardPerJob", n)}
                hint={a.employeeMarginPercent >= 100 && a.contractorFeePercent >= 100
                  ? "With the share at zero this IS the pay — a price increase reaches the business instead of being split on the way in."
                  : "Paid ON TOP of the job share. Set business-keeps to 100% for a pure rate card."}
              />
            </VStack>

            <VStack align="stretch" gap={2.5}>
              <GroupHeading>Pricing and volume</GroupHeading>
              <Lever label="Price change"
                info={"Raises or lowers every collected amount by this percentage, keeping the same jobs and the same hours. Jobs that collected $0 stay at $0 \u2014 unpaid work is a collection problem, and quietly turning it into revenue would hide a real loss."} value={a.priceIncreasePercent} baseline={base.priceIncreasePercent} min={-20} max={50} suffix="%"
                     onChange={(n) => set("priceIncreasePercent", n)} />
              <Lever label="Minimum invoice"
                info={"Lifts any job that collected less than this up to the floor, leaving everything above it untouched. Models repricing the cheap end of the book without touching the rest. Never applied to jobs that collected nothing."} value={a.minimumInvoice} baseline={base.minimumInvoice} min={0} max={120} suffix=""
                     onChange={(n) => set("minimumInvoice", n)}
                     hint="Lifts underpriced jobs to a floor. Never applied to jobs that collected $0 — that's a collection problem, not a pricing one." />
              <Lever label="Volume"
                info={"Scales the whole book of work \u2014 twice the volume means twice the jobs, twice the crew hours and twice the revenue. Costs only follow if you have tagged them to in the Costs section; anything left at 'as is' holds steady. Fixed costs never follow, which is what makes scale improve margin."} value={a.volumeMultiplier} baseline={base.volumeMultiplier} min={0.5} max={4} step={0.25} suffix="×"
                     onChange={(n) => set("volumeMultiplier", n)}
                     hint="Fixed costs deliberately don't follow — that gap is how much of the problem is scale rather than structure." />
              <Lever label="Cost inflation"
                info={"Raises every cost line by this percentage, on top of any volume scaling. Applied to costs only, never to wages: share-based pay already rises with prices and the hourly base is a number you set yourself, so inflating wages here would count the same rise twice."} value={a.costInflationPercent} baseline={base.costInflationPercent} min={0} max={25} suffix="%"
                     onChange={(n) => set("costInflationPercent", n)}
                     hint="Everything gets more expensive. Applied to every cost, not to wages — share-based pay already rises with prices, and you set the hourly base yourself." />

              <GroupHeading mt={2}>Employer costs</GroupHeading>
              <Lever label="Employer payroll tax"
                info={"The employer's share of payroll tax as a percentage of W-2 wages \u2014 Social Security, Medicare, FUTA and state unemployment. Charged on employees and trainees only, never on contractors and never on the owner, who takes a draw rather than a paycheck. The figure comes from the app's own estimator, never from imported Gusto rows."} value={a.employerTaxPercent} baseline={base.employerTaxPercent} min={0} max={20} step={0.25} suffix="%"
                     onChange={(n) => set("employerTaxPercent", n)}
                     hint="From the app's estimator, never from imported Gusto rows." />
              <Lever label="Workers comp (re-modelled on wages)"
                info={
                  "Workers compensation as a percentage of W-2 wages. OFF BY DEFAULT, because your real premiums are already booked as Insurance \u2014 adding a percentage on top counts comp twice, and at a landscaping rate that is the biggest single piece of the burden. " +
                  "Turn it on only alongside the control above, which takes the booked premium back out. What you gain is that comp then RESPONDS to the scenario: model hiring two people and a flat Insurance line doesn't move, which understates what growing costs. " +
                  "The rate itself is a quote, not something the app can derive. Landscaping class codes run high and first-year minimum premiums distort the effective rate, so check a renewal before leaning on it."
                }
                value={a.workersCompPercent} baseline={base.workersCompPercent} min={0} max={30} step={0.5} suffix="%"
                     onChange={(n) => set("workersCompPercent", n)}
                     hint={a.workersCompPercent > 0 && a.workersCompInExpenses <= 0
                       ? "Counting comp twice — the booked premium is still in Insurance. Set the control above."
                       : `Off by default; your configured rate is ${data.baseline.workersCompPercent}%. The ledger already carries the real premium.`} />
              <Lever
                label="Workers comp already in Insurance"
                info={
                  "How many dollars of this window's booked Insurance are workers comp premium. " +
                  "The app cannot work this out on its own \u2014 comp, general liability and commercial auto all sit in one Insurance category on Schedule C line 15, with nothing to tell them apart. " +
                  "Enter it and the forecast takes that amount OUT of costs and re-derives comp from wages at the rate below, so it scales when you model hiring or more volume. " +
                  "Leave both at zero and the scenario simply uses the premiums you actually booked, which is what the P&L does."
                }
                value={a.workersCompInExpenses} baseline={base.workersCompInExpenses}
                min={0} max={Math.max(500, Math.round(sq.costsTotal))} step={25} suffix=""
                onChange={(n) => set("workersCompInExpenses", n)}
                hint="Only needed if you want comp to scale with payroll. Otherwise leave at $0."
              />
              <Lever label="Fixed costs"
                info={"Replaces the total of everything tagged Fixed \u2014 insurance, software, banking. Use it to model an insurance change or a software cull without editing individual categories. This is the number that decides how much growing actually helps, since it is the part that does not rise with the work."} value={Math.round(a.fixedCostOverride ?? scenario.fixedCosts)}
                     baseline={Math.round(sq.fixedCosts)}
                     min={0} max={Math.max(1000, Math.round(scenario.fixedCosts * 2))} step={50} suffix=""
                     onChange={(n) => set("fixedCostOverride", n)}
                     hint="Insurance, software, banking. Doesn't move with volume." />

              <VStack align="start" gap={1.5} pt={1}>
                <Checkbox.Root size="sm" checked={a.excludeFixedAssets}
                               onCheckedChange={(e) => set("excludeFixedAssets", !!e.checked)}>
                  <Checkbox.HiddenInput /><Checkbox.Control />
                  <Checkbox.Label fontSize="12px">
                    Treat equipment purchases as capital, not running costs
                    {a.excludeFixedAssets !== base.excludeFixedAssets && (
                      <Text as="span" fontSize="10px" color="blue.fg" fontWeight="bold" ml={1}>
                        {" "}· changed
                      </Text>
                    )}
                    <Text fontSize="10.5px" color="fg.muted">
                      {data.baseline.actual.fixedAssetPurchases > 0
                        ? `${money(data.baseline.actual.fixedAssetPurchases)} of purchases in this window. A mower cuts grass for years — charging it all to one quarter is right for tax and wrong for "am I making money running jobs". This is the same rule the P&L uses.`
                        : "No purchases in this window meet the threshold."}
                    </Text>
                  </Checkbox.Label>
                </Checkbox.Root>
                <Checkbox.Root size="sm" checked={a.includeOneTime}
                               onCheckedChange={(e) => set("includeOneTime", !!e.checked)}>
                  <Checkbox.HiddenInput /><Checkbox.Control />
                  <Checkbox.Label fontSize="12px">
                    Include one-time costs (tools, startup)
                    {a.includeOneTime !== base.includeOneTime && (
                      <Text as="span" fontSize="10px" color="blue.fg" fontWeight="bold" ml={1}>
                        {" "}· changed
                      </Text>
                    )}
                  </Checkbox.Label>
                </Checkbox.Root>
                <Checkbox.Root size="sm" checked={a.scaleDiscretionary}
                               onCheckedChange={(e) => set("scaleDiscretionary", !!e.checked)}>
                  <Checkbox.HiddenInput /><Checkbox.Control />
                  <Checkbox.Label fontSize="12px">
                    Grow advertising with revenue
                    {a.scaleDiscretionary !== base.scaleDiscretionary && (
                      <Text as="span" fontSize="10px" color="blue.fg" fontWeight="bold" ml={1}>
                        {" "}· changed
                      </Text>
                    )}
                  </Checkbox.Label>
                </Checkbox.Root>
              </VStack>
            </VStack>
          </VStack>
        </VStack>
      </SectionExpander>

      {/* ── Roster ─────────────────────────────────────────────────────── */}
      <SectionExpander emphasis title="Crew" storageKey="forecast_sec_roster">
        <VStack align="stretch" gap={2} pt={2}>
          {data.baseline.workers.map((w) => {
            const o = a.workerOverrides[w.userId] ?? {};
            return (
              <HStack key={w.userId} gap={2} wrap="wrap"
                      borderWidth="1px" borderRadius="md" p={2} opacity={o.excluded ? 0.5 : 1}>
                <VStack align="start" gap={0} minW="130px" flex="1">
                  <HStack gap={1.5}>
                    <Text fontSize="13px" fontWeight="medium">{w.name}</Text>
                    {w.isOwner && <Badge size="xs" colorPalette="purple">Owner</Badge>}
                  </HStack>
                  <Text fontSize="11px" color="fg.muted">
                    {w.clockedHours.toFixed(0)}h · earned {money(w.actualPay)}
                  </Text>
                </VStack>
                <Picker
                  value={(o.workerType ?? w.workerType ?? "EMPLOYEE") as string}
                  options={WORKER_TYPES}
                  onChange={(v) => set("workerOverrides", {
                    ...a.workerOverrides,
                    [w.userId]: { ...o, workerType: v as WorkerType },
                  })}
                  w="165px"
                />
                <Box w="110px">
                  <Text fontSize="10px" color="fg.muted">Hours</Text>
                  <Input size="xs" type="number" value={o.clockedHours ?? Math.round(w.clockedHours)}
                         onChange={(e) => set("workerOverrides", {
                           ...a.workerOverrides,
                           [w.userId]: { ...o, clockedHours: Number(e.target.value) },
                         })} />
                </Box>
                <Checkbox.Root size="sm" checked={!!o.excluded}
                               onCheckedChange={(e) => set("workerOverrides", {
                                 ...a.workerOverrides,
                                 [w.userId]: { ...o, excluded: !!e.checked },
                               })}>
                  <Checkbox.HiddenInput /><Checkbox.Control />
                  <Checkbox.Label fontSize="11px">Gone</Checkbox.Label>
                </Checkbox.Root>
              </HStack>
            );
          })}

          {a.hypotheticalWorkers.map((h, i) => (
            <HStack key={h.id} gap={2} wrap="wrap" borderWidth="1px" borderStyle="dashed"
                    borderRadius="md" p={2} bg="cyan.subtle">
              <Input size="xs" value={h.name} w="120px"
                     onChange={(e) => set("hypotheticalWorkers", a.hypotheticalWorkers.map((x, j) =>
                       j === i ? { ...x, name: e.target.value } : x))} />
              <Picker value={h.workerType} options={WORKER_TYPES} w="150px"
                      onChange={(v) => set("hypotheticalWorkers", a.hypotheticalWorkers.map((x, j) =>
                        j === i ? { ...x, workerType: v as WorkerType } : x))} />
              <Box w="90px">
                <Text fontSize="10px" color="fg.muted">Hours</Text>
                <Input size="xs" type="number" value={h.hours}
                       onChange={(e) => set("hypotheticalWorkers", a.hypotheticalWorkers.map((x, j) =>
                         j === i ? { ...x, hours: Number(e.target.value) } : x))} />
              </Box>
              <Picker value={h.mode} options={CAPACITY_MODES} w="200px"
                      onChange={(v) => set("hypotheticalWorkers", a.hypotheticalWorkers.map((x, j) =>
                        j === i ? { ...x, mode: v as any } : x))} />
              {h.mode === "ADDED_CAPACITY" ? (
                <Box w="110px">
                  <Text fontSize="10px" color="fg.muted">Revenue /hr</Text>
                  <Input size="xs" type="number" value={h.revenuePerHour}
                         onChange={(e) => set("hypotheticalWorkers", a.hypotheticalWorkers.map((x, j) =>
                           j === i ? { ...x, revenuePerHour: Number(e.target.value) } : x))} />
                </Box>
              ) : (
                <Picker
                  value={h.substituteForUserId ?? data.baseline.workers[0]?.userId ?? ""}
                  options={data.baseline.workers.map((w) => ({ value: w.userId, label: `Takes ${w.name}'s hours` }))}
                  w="190px"
                  onChange={(v) => set("hypotheticalWorkers", a.hypotheticalWorkers.map((x, j) =>
                    j === i ? { ...x, substituteForUserId: v } : x))}
                />
              )}
              <IconButton size="xs" variant="ghost" aria-label="Remove modelled worker"
                          onClick={() => set("hypotheticalWorkers",
                            a.hypotheticalWorkers.filter((_, j) => j !== i))}>
                <Box as={FiX} />
              </IconButton>
            </HStack>
          ))}

          <Button size="xs" variant="outline" alignSelf="start"
                  onClick={() => set("hypotheticalWorkers", [
                    ...a.hypotheticalWorkers,
                    newHypothetical(a.hypotheticalWorkers.length + 1, crewRevenuePerHour),
                  ])}>
            <Box as={FiPlus} /> Model a hire
          </Button>
          <Text fontSize="11px" color="fg.muted">
            "Takes over existing hours" leaves revenue alone and only changes what the work costs —
            the honest way to compare W-2 against 1099. "Brings new work" assumes you can sell
            those hours, which nothing in this data can tell you.
          </Text>
        </VStack>
      </SectionExpander>

      {/* ── Outcomes ───────────────────────────────────────────────────── */}
      <SectionExpander emphasis title="What it does to the books" storageKey="forecast_sec_pnl" defaultOpen>
        <Box pt={2}>
          <Waterfall scenario={scenario} statusQuo={sq}
                     capitalPurchases={data.baseline.actual.fixedAssetPurchases} />
        </Box>
      </SectionExpander>

      <SectionExpander emphasis title="What it does to people" storageKey="forecast_sec_people" defaultOpen>
        <VStack align="stretch" gap={3} pt={2}>
          {/* Where the market band comes from, stated before the table that
              uses it — this number decides who reads as underpaid. */}
          <MarketRateProvenance market={data.baseline.marketRate} />
          <WorkerFairnessTable scenario={scenario} statusQuo={sq} market={data.baseline.marketRate} />
          <WarningList warnings={scenario.warnings} />
        </VStack>
      </SectionExpander>

      <SectionExpander emphasis title="Which lever matters" storageKey="forecast_sec_sens">
        <Box pt={2}><SensitivityList rows={sensitivity} /></Box>
      </SectionExpander>

      <SectionExpander emphasis title="Costs" storageKey="forecast_sec_costs">
        <Box pt={2}>
          <CostBreakdown
            scenario={scenario}
            statusQuo={sq}
            onRetag={(category, behavior) => {
              // Clearing back to "As is" removes the entry rather than
              // storing it, so a saved scenario only carries real decisions.
              const next = { ...a.behaviorOverrides };
              if (behavior === "AS_IS") delete next[category];
              else next[category] = behavior as any;
              set("behaviorOverrides", next);
            }}
          />
        </Box>
      </SectionExpander>

      {/* ── Assessment ─────────────────────────────────────────────────── */}
      <SectionExpander emphasis title="Claude's read" storageKey="forecast_sec_ai">
        <Box pt={2}>
          <AssessmentPanel
            assessment={assessment}
            stale={assessmentIsStale(assessment, a)}
            loading={assessing}
            error={assessError}
            onRun={runAssessment}
          />
        </Box>
      </SectionExpander>

      {/* ── Saved + compare ────────────────────────────────────────────── */}
      <SectionExpander emphasis title="Saved forecasts" storageKey="forecast_sec_saved" defaultOpen>
        <VStack align="stretch" gap={2} pt={2}>
          {!saved.length && (
            <Text fontSize="13px" color="fg.muted">
              Nothing saved yet. Build a scenario, name it, and save — then you can put two of
              them side by side.
            </Text>
          )}
          {saved.map((s) => (
            <HStack key={s.id} gap={2} borderWidth="1px" borderRadius="md" px={2.5} py={2}
                    bg={s.id === activeId ? "blue.subtle" : undefined} wrap="wrap">
              <Checkbox.Root size="sm" checked={compareIds.includes(s.id)}
                             onCheckedChange={(e) => setCompareIds((ids) =>
                               e.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id))}>
                <Checkbox.HiddenInput /><Checkbox.Control />
              </Checkbox.Root>
              <VStack align="start" gap={0} flex="1" minW="140px">
                <Text fontSize="13px" fontWeight="medium">{s.name}</Text>
                <Text fontSize="11px" color="fg.muted">
                  {s.windowFrom} → {s.windowTo}
                  {s.assessedAt ? " · assessed" : ""}
                </Text>
              </VStack>
              <Button size="xs" variant="outline" onClick={() => void loadScenario(s)}>Open</Button>
              <IconButton size="xs" variant="ghost" aria-label="Archive"
                          onClick={async () => {
                            try {
                              await archiveForecast(s.id, true);
                              setSaved(await fetchForecasts());
                              publishInlineMessage({ type: "SUCCESS", text: `Archived "${s.name}".` });
                            } catch (e) {
                              publishInlineMessage({ type: "WARNING", text: getErrorMessage("Couldn't archive the forecast.", e) });
                            }
                          }}>
                <Box as={FiArchive} />
              </IconButton>
            </HStack>
          ))}

          <Separator />
          <HStack gap={2}>
            <Box as={FiBarChart2} color="fg.muted" />
            <Text fontSize="11px" textTransform="uppercase" letterSpacing="wide" color="fg.muted">
              Side by side
            </Text>
          </HStack>
          {comparing && (
            <Text fontSize="12px" color="fg.muted">Loading the other windows…</Text>
          )}
          <ComparisonPanel entries={comparison} />
        </VStack>
      </SectionExpander>

      <Text fontSize="11px" color="fg.muted" px={1}>
        Everything here is a simulation replayed over jobs that already happened. The app's
        figures are a close estimate — QuickBooks, Gusto and the bank are the source of truth.
        Nothing on this tab changes a setting or pays anyone.
      </Text>

      <ConfirmDialog
        open={!!confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        title="Delete this forecast?"
        message={
          confirmDelete
            ? `"${confirmDelete.name}" will be removed permanently. The audit trail keeps a copy of its assumptions, but it won't be openable here again.`
            : ""
        }
        confirmLabel="Delete"
        confirmColorPalette="red"
        onConfirm={async () => {
          if (!confirmDelete) return;
          try {
            await deleteForecast(confirmDelete.id);
            if (activeId === confirmDelete.id) startNew();
            setSaved(await fetchForecasts());
            publishInlineMessage({ type: "SUCCESS", text: `Deleted "${confirmDelete.name}".` });
          } catch (e) {
            publishInlineMessage({ type: "WARNING", text: getErrorMessage("Couldn't delete the forecast.", e) });
          } finally {
            setConfirmDelete(null);
          }
        }}
      />
    </VStack>
  );
}
