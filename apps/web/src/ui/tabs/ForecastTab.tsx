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
  FiPlus, FiSave, FiCopy, FiTrash2, FiRefreshCw, FiArchive, FiX, FiBarChart2,
} from "react-icons/fi";
import { LineChart } from "lucide-react";
import { simulate, defaultAssumptions } from "@repo/money";
import type { Assumptions, ForecastResult, WorkerType } from "@repo/money";
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
  StatStrip, Waterfall, WorkerFairnessTable, WarningList, CostBreakdown,
  SensitivityList, AssessmentPanel, ComparisonPanel,
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

const PAY_MODELS = [
  { value: "SHARE", label: "Share of each job" },
  { value: "HOURLY_PLUS_SHARE", label: "Hourly base + share" },
  { value: "RATE_CARD", label: "Fixed rate card per job" },
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

/** Small labelled slider. Chakra's Slider in v3 is heavier than this needs to
 *  be, and a native range input is the one form control the house rule about
 *  `<select>` doesn't cover. */
function Lever({
  label, value, min, max, step = 1, suffix = "", onChange, hint, disabled,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  suffix?: string; onChange: (n: number) => void; hint?: string; disabled?: boolean;
}) {
  return (
    <Box opacity={disabled ? 0.45 : 1}>
      <HStack justify="space-between" mb={0.5}>
        <Text fontSize="12px" fontWeight="medium">{label}</Text>
        <Text fontSize="12px" color="fg.muted" fontVariantNumeric="tabular-nums">
          {value}{suffix}
        </Text>
      </HStack>
      <input
        type="range"
        min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "var(--chakra-colors-blue-500)" }}
      />
      {hint && <Text fontSize="10.5px" color="fg.muted" mt={0.5}>{hint}</Text>}
    </Box>
  );
}

function Picker({
  label, value, options, onChange, w = "100%",
}: {
  label?: string; value: string; options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void; w?: string;
}) {
  const collection = useMemo(() => createListCollection({ items: options }), [options]);
  return (
    <Box w={w}>
      {label && <Text fontSize="12px" fontWeight="medium" mb={0.5}>{label}</Text>}
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

export default function ForecastTab() {
  const [from, setFrom] = usePersistedState("forecast_from", PRESETS[0].range()[0]);
  const [to, setTo] = usePersistedState("forecast_to", PRESETS[0].range()[1]);
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
        result: simulate(src.baseline, s.assumptions),
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
    setAssumptions(s.assumptions);
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
      if (full.assumptions) setAssumptions(full.assumptions);
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
                   onChange={(e) => setFrom(e.target.value)} />
          </Box>
          <Box>
            <Text fontSize="11px" color="fg.muted" mb={0.5}>To</Text>
            <Input size="sm" type="date" value={to} w="145px"
                   onChange={(e) => setTo(e.target.value)} />
          </Box>
          <HStack gap={1} wrap="wrap">
            {PRESETS.map((p) => (
              <Button key={p.key} size="xs" variant="ghost"
                      onClick={() => { const [f, t] = p.range(); setFrom(f); setTo(t); }}>
                {p.label}
              </Button>
            ))}
          </HStack>
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
          placeholder="What are you trying to work out? (saved with the forecast, and given to Claude when you ask for a read)"
          value={notes}
          onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
        />
      </Box>

      {/* ── Headline ───────────────────────────────────────────────────── */}
      <StatStrip scenario={scenario} statusQuo={sq} payOwner={a.payOwner} />

      {/* ── Levers ─────────────────────────────────────────────────────── */}
      <SectionExpander title="Assumptions" storageKey="forecast_sec_levers" defaultOpen>
        <VStack align="stretch" gap={3} pt={2}>
          <HStack gap={3} align="start" wrap="wrap">
            <VStack align="stretch" gap={2.5} flex="1 1 280px">
              <Text fontSize="11px" textTransform="uppercase" letterSpacing="wide" color="fg.muted">
                How people are paid
              </Text>
              <Picker
                label="Pay model"
                value={a.payModel}
                options={PAY_MODELS}
                onChange={(v) => set("payModel", v as Assumptions["payModel"])}
              />
              <Lever
                label="Business keeps — employees" value={a.employeeMarginPercent}
                min={0} max={90} suffix="%"
                onChange={(n) => set("employeeMarginPercent", n)}
                hint={`Worker share ${100 - a.employeeMarginPercent}% · live setting ${data.baseline.rates.employeeMarginPercent}%`}
                disabled={a.payModel === "RATE_CARD"}
              />
              <Lever
                label="Business keeps — contractors" value={a.contractorFeePercent}
                min={0} max={90} suffix="%"
                onChange={(n) => set("contractorFeePercent", n)}
                hint={`Worker share ${100 - a.contractorFeePercent}% · live setting ${data.baseline.rates.contractorFeePercent}%`}
                disabled={a.payModel === "RATE_CARD"}
              />
              <Lever
                label="Guaranteed hourly base" value={a.hourlyBase}
                min={0} max={30} suffix="/hr"
                onChange={(n) => set("hourlyBase", n)}
                hint="Covers drive time, rain days and training — the hours a pure share model pays nothing for."
                disabled={a.payModel !== "HOURLY_PLUS_SHARE"}
              />
              <Lever
                label="Crew-lead premium" value={a.leadHourlyBonus}
                min={0} max={10} suffix="/hr"
                onChange={(n) => set("leadHourlyBonus", n)}
                hint="Makes a productivity premium explicit rather than an artifact of job assignment."
                disabled={a.payModel !== "HOURLY_PLUS_SHARE"}
              />
              <Lever
                label="Rate card per job" value={a.rateCardPerJob}
                min={0} max={120} suffix=""
                onChange={(n) => set("rateCardPerJob", n)}
                hint="Decouples pay from price, so a price increase reaches the business instead of being split on the way in."
                disabled={a.payModel !== "RATE_CARD"}
              />
            </VStack>

            <VStack align="stretch" gap={2.5} flex="1 1 280px">
              <Text fontSize="11px" textTransform="uppercase" letterSpacing="wide" color="fg.muted">
                Pricing and volume
              </Text>
              <Lever label="Price change" value={a.priceIncreasePercent} min={-20} max={50} suffix="%"
                     onChange={(n) => set("priceIncreasePercent", n)} />
              <Lever label="Minimum invoice" value={a.minimumInvoice} min={0} max={120} suffix=""
                     onChange={(n) => set("minimumInvoice", n)}
                     hint="Lifts underpriced jobs to a floor. Never applied to jobs that collected $0 — that's a collection problem, not a pricing one." />
              <Lever label="Volume" value={a.volumeMultiplier} min={0.5} max={4} step={0.25} suffix="×"
                     onChange={(n) => set("volumeMultiplier", n)}
                     hint="Fixed costs deliberately don't follow — that gap is how much of the problem is scale rather than structure." />
              <Lever label="Cost inflation" value={a.costInflationPercent} min={0} max={25} suffix="%"
                     onChange={(n) => set("costInflationPercent", n)}
                     hint="Everything gets more expensive. Applied to every cost, not to wages — share-based pay already rises with prices, and you set the hourly base yourself." />

              <Text fontSize="11px" textTransform="uppercase" letterSpacing="wide" color="fg.muted" pt={1}>
                Employer costs
              </Text>
              <Lever label="Employer payroll tax" value={a.employerTaxPercent} min={0} max={20} step={0.25} suffix="%"
                     onChange={(n) => set("employerTaxPercent", n)}
                     hint="From the app's estimator, never from imported Gusto rows." />
              <Lever label="Workers comp" value={a.workersCompPercent} min={0} max={30} step={0.5} suffix="%"
                     onChange={(n) => set("workersCompPercent", n)}
                     hint="Of W-2 wages. A quote, not something the app can derive — check a renewal before leaning on it." />
              <Lever label="Fixed costs" value={Math.round(a.fixedCostOverride ?? scenario.fixedCosts)}
                     min={0} max={Math.max(1000, Math.round(scenario.fixedCosts * 2))} step={50} suffix=""
                     onChange={(n) => set("fixedCostOverride", n)}
                     hint="Insurance, software, banking. Doesn't move with volume." />

              <VStack align="start" gap={1.5} pt={1}>
                <Checkbox.Root size="sm" checked={a.includeOneTime}
                               onCheckedChange={(e) => set("includeOneTime", !!e.checked)}>
                  <Checkbox.HiddenInput /><Checkbox.Control />
                  <Checkbox.Label fontSize="12px">Include one-time costs (tools, startup)</Checkbox.Label>
                </Checkbox.Root>
                <Checkbox.Root size="sm" checked={a.scaleDiscretionary}
                               onCheckedChange={(e) => set("scaleDiscretionary", !!e.checked)}>
                  <Checkbox.HiddenInput /><Checkbox.Control />
                  <Checkbox.Label fontSize="12px">Grow advertising with revenue</Checkbox.Label>
                </Checkbox.Root>
                <Checkbox.Root size="sm" checked={a.payOwner}
                               onCheckedChange={(e) => set("payOwner", !!e.checked)}>
                  <Checkbox.HiddenInput /><Checkbox.Control />
                  <Checkbox.Label fontSize="12px">Count the owner's own labor as a cost</Checkbox.Label>
                </Checkbox.Root>
              </VStack>
            </VStack>
          </HStack>
        </VStack>
      </SectionExpander>

      {/* ── Roster ─────────────────────────────────────────────────────── */}
      <SectionExpander title="Crew" storageKey="forecast_sec_roster">
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
      <SectionExpander title="What it does to the books" storageKey="forecast_sec_pnl" defaultOpen>
        <Box pt={2}><Waterfall scenario={scenario} statusQuo={sq} payOwner={a.payOwner} /></Box>
      </SectionExpander>

      <SectionExpander title="What it does to people" storageKey="forecast_sec_people" defaultOpen>
        <VStack align="stretch" gap={3} pt={2}>
          <WorkerFairnessTable scenario={scenario} statusQuo={sq} />
          <WarningList warnings={scenario.warnings} />
        </VStack>
      </SectionExpander>

      <SectionExpander title="Which lever matters" storageKey="forecast_sec_sens">
        <Box pt={2}><SensitivityList rows={sensitivity} /></Box>
      </SectionExpander>

      <SectionExpander title="Costs" storageKey="forecast_sec_costs">
        <Box pt={2}><CostBreakdown scenario={scenario} /></Box>
      </SectionExpander>

      {/* ── Assessment ─────────────────────────────────────────────────── */}
      <SectionExpander title="Claude's read" storageKey="forecast_sec_ai">
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
      <SectionExpander title="Saved forecasts" storageKey="forecast_sec_saved" defaultOpen>
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
          <ComparisonPanel entries={comparison} payOwner={a.payOwner} />
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
