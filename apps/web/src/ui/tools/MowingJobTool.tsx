"use client";

// Mowing job estimator. Operator picks a base mow (flat residential, per
// acre, or time-based) and toggles any number of add-on services (string
// trim, edge, blow, hedge, leaf cleanup, etc.). Add-ons are loaded from
// the existing `pricing_*` Settings, so the catalog matches whatever the
// operator has configured on the Pricing tab — no hard-coded service list.
//
// "Full Service" is a one-tap preset that enables a sensible default
// bundle (trim + edge + blow). The bundle is local-only for v1 — if the
// operator later wants the bundle itself to be configurable, store it in a
// FULL_SERVICE_BUNDLE setting and read it here. The toggleable list per
// estimate stays under operator control.
//
// Read-only — same self-contained pattern as MulchJobTool. Hits the
// existing /api/admin/pricing endpoint and never mutates anything.

import { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Input,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Calculator, Copy, FileText, Sparkles, TriangleAlert } from "lucide-react";
import { jobTagLabel, pricingJobTags } from "@/src/ui/components/JobTagPicker";
import PricingPicker from "@/src/ui/components/PricingPicker";
import { usePricingPicker } from "@/src/lib/usePricingPicker";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";

type BaseMode = "standard" | "acres" | "time" | "custom";
type FrequencyKey = "one_time" | "weekly" | "biweekly" | "monthly";

const FREQUENCIES: { key: FrequencyKey; label: string; visitsPerYear: number }[] = [
  { key: "one_time", label: "One-time", visitsPerYear: 1 },
  { key: "weekly", label: "Weekly", visitsPerYear: 52 },
  { key: "biweekly", label: "Bi-weekly", visitsPerYear: 26 },
  { key: "monthly", label: "Monthly", visitsPerYear: 12 },
];

// Default "Full Service" bundle. These are the jobTags toggled on when the
// operator taps the Full Service button. The selection is otherwise fully
// editable per estimate.
const FULL_SERVICE_TAGS: ReadonlySet<string> = new Set(["TRIM", "EDGE", "BLOW"]);

// Tags considered the BASE mow line — excluded from the add-on list so they
// can't be double-counted. Time-based uses pricing_general_labor (no tag),
// so only the actual MOW tags are filtered.
const BASE_MOW_TAGS: ReadonlySet<string> = new Set(["MOW"]);

const MOW_TAG = "MOW";

type ToolResult = {
  toolKey: "mowing";
  proposalAmount: number;
  proposalNotes: string;
  jobTags: string;
  meta: {
    baseLabel: string;
    baseAmount: number;
    addOns: { key: string; label: string; amount: number; jobTags: string[] }[];
    frequency: FrequencyKey;
    perVisitTotal: number;
    monthlyTotal: number | null;
    annualTotal: number | null;
  };
};

export default function MowingJobTool() {
  // Base mow candidates = every entry whose only tag is MOW. Hook owns
  // load + filter + default-pick + collection plumbing; we just unwrap
  // its surface here and forward to <PricingPicker> below.
  const mowPicker = usePricingPicker({
    exclusiveTag: MOW_TAG,
    fallbackUnit: "per visit",
  });
  const { pricingLoaded, allPricing } = mowPicker;
  const standardMow = mowPicker.selected;
  const standardMowOptions = mowPicker.options;

  // Base mow selection
  const [baseMode, setBaseMode] = useState<BaseMode>("standard");
  const [acres, setAcres] = useState<string>("1");
  const [hours, setHours] = useState<string>("1");
  const [crewSize, setCrewSize] = useState<string>("1");
  const [baseOverride, setBaseOverride] = useState<string>("");
  const [customBase, setCustomBase] = useState<string>("");

  // Add-on selection (set of pricing entry keys)
  const [enabledAddOns, setEnabledAddOns] = useState<Set<string>>(new Set());

  // Frequency
  const [frequency, setFrequency] = useState<FrequencyKey>("weekly");

  // Other key-based lookups, derived from the same /api/admin/pricing
  // list the hook just fetched. The Acres mode uses a known key; the
  // Time mode uses the General Labor entry directly.
  const acreMow = useMemo(
    () => allPricing.find((r) => r.key === "pricing_mowing_acre") ?? null,
    [allPricing],
  );
  const laborRate = useMemo(
    () => allPricing.find((r) => r.key === "pricing_general_labor") ?? null,
    [allPricing],
  );

  // Available add-ons: every pricing entry that has at least one tag
  // bound AND at least one of those tags is NOT a base-mow tag. (A row
  // tagged purely with MOW is the base service, not an add-on; a row
  // tagged with MOW + something else still surfaces here on the non-MOW
  // tag.) Sorted by sortOrder so the operator's display order from the
  // Pricing tab carries through.
  const addOnCatalog = useMemo(() => {
    return allPricing
      .filter((r) => {
        const tags = pricingJobTags(r.parsedValue);
        if (tags.length === 0) return false;
        return tags.some((t) => !BASE_MOW_TAGS.has(t));
      })
      .map((r) => ({
        key: r.key,
        label: r.parsedValue?.label ?? r.key,
        amount: Number(r.parsedValue?.amount ?? 0),
        unit: r.parsedValue?.unit ?? "per visit",
        // Carry every tag bound on the entry through to the catalog row —
        // downstream logic (full-service auto-enable, display badges) can
        // then check against the full set.
        jobTags: pricingJobTags(r.parsedValue),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allPricing]);

  // Base mow amount + label, derived from the active mode + relevant inputs.
  const baseAmount = useMemo(() => {
    const overrideNum = Number(baseOverride);
    if (Number.isFinite(overrideNum) && overrideNum > 0) return overrideNum;
    if (baseMode === "standard") {
      return Number(standardMow?.parsedValue?.amount ?? 0);
    }
    if (baseMode === "acres") {
      const a = Number(acres);
      const rate = Number(acreMow?.parsedValue?.amount ?? 0);
      if (!Number.isFinite(a) || a <= 0 || rate <= 0) return 0;
      return a * rate;
    }
    if (baseMode === "time") {
      const h = Number(hours);
      const c = Number(crewSize);
      const rate = Number(laborRate?.parsedValue?.amount ?? 0);
      if (!Number.isFinite(h) || h <= 0 || rate <= 0) return 0;
      const cn = Number.isFinite(c) && c > 0 ? c : 1;
      return h * cn * rate;
    }
    if (baseMode === "custom") {
      const c = Number(customBase);
      return Number.isFinite(c) && c > 0 ? c : 0;
    }
    return 0;
  }, [baseMode, baseOverride, standardMow, acreMow, laborRate, acres, hours, crewSize, customBase]);

  const baseLabel = useMemo(() => {
    if (baseMode === "standard") return standardMow?.parsedValue?.label ?? "Standard mow";
    if (baseMode === "acres") {
      const a = Number(acres);
      const rate = Number(acreMow?.parsedValue?.amount ?? 0);
      return `Mowing — ${Number.isFinite(a) ? a : 0} acre${a === 1 ? "" : "s"} @ $${rate.toFixed(2)}/acre`;
    }
    if (baseMode === "time") {
      const h = Number(hours);
      const c = Number(crewSize);
      const cn = Number.isFinite(c) && c > 0 ? c : 1;
      const rate = Number(laborRate?.parsedValue?.amount ?? 0);
      return `Labor — ${Number.isFinite(h) ? h : 0} hr × ${cn} crew @ $${rate.toFixed(2)}/hr`;
    }
    return "Custom base";
  }, [baseMode, standardMow, acreMow, laborRate, acres, hours, crewSize]);

  const selectedAddOns = useMemo(() => {
    return addOnCatalog.filter((a) => enabledAddOns.has(a.key));
  }, [addOnCatalog, enabledAddOns]);

  const addOnsTotal = useMemo(
    () => selectedAddOns.reduce((sum, a) => sum + a.amount, 0),
    [selectedAddOns],
  );

  const perVisitTotal = baseAmount + addOnsTotal;
  const visitsPerYear = FREQUENCIES.find((f) => f.key === frequency)?.visitsPerYear ?? 1;
  const isRecurring = frequency !== "one_time";
  const monthlyTotal = isRecurring ? (perVisitTotal * visitsPerYear) / 12 : null;
  const annualTotal = isRecurring ? perVisitTotal * visitsPerYear : null;

  // Combined jobTags string for the estimate hand-off. MOW base is always
  // implied; every tag from every selected add-on is unioned in, de-duped,
  // and comma-joined.
  const jobTagsCombined = useMemo(() => {
    const tags = new Set<string>([MOW_TAG]);
    for (const a of selectedAddOns) {
      for (const t of a.jobTags) tags.add(t);
    }
    return Array.from(tags).join(",");
  }, [selectedAddOns]);

  const result: ToolResult | null = useMemo(() => {
    if (perVisitTotal <= 0) return null;
    const lines: string[] = [];
    lines.push(`Mowing visit — $${perVisitTotal.toFixed(2)}`);
    lines.push("");
    lines.push(`Base: ${baseLabel} — $${baseAmount.toFixed(2)}`);
    if (selectedAddOns.length > 0) {
      lines.push("Add-ons:");
      for (const a of selectedAddOns) {
        lines.push(`  • ${a.label} — $${a.amount.toFixed(2)}`);
      }
    }
    if (isRecurring && monthlyTotal != null && annualTotal != null) {
      lines.push("");
      const freqLabel = FREQUENCIES.find((f) => f.key === frequency)?.label ?? "";
      lines.push(`Frequency: ${freqLabel} (${visitsPerYear} visits/yr)`);
      lines.push(`Approx monthly: $${monthlyTotal.toFixed(2)}`);
      lines.push(`Approx annual: $${annualTotal.toFixed(2)}`);
    }
    return {
      toolKey: "mowing",
      proposalAmount: Number(perVisitTotal.toFixed(2)),
      proposalNotes: lines.join("\n"),
      jobTags: jobTagsCombined,
      meta: {
        baseLabel,
        baseAmount,
        addOns: selectedAddOns.map((a) => ({ key: a.key, label: a.label, amount: a.amount, jobTags: a.jobTags })),
        frequency,
        perVisitTotal,
        monthlyTotal,
        annualTotal,
      },
    };
  }, [perVisitTotal, baseLabel, baseAmount, selectedAddOns, isRecurring, monthlyTotal, annualTotal, frequency, visitsPerYear, jobTagsCombined]);

  function toggleAddOn(key: string) {
    setEnabledAddOns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function applyFullService() {
    // Enable every catalog entry that has at least one tag in the
    // FULL_SERVICE_TAGS set. Multi-tag entries (e.g. "Bagged clippings"
    // tagged MOW + LEAF_CLEANUP) get included whenever any one of their
    // tags is part of full service. Additive, never destructive.
    setEnabledAddOns((prev) => {
      const next = new Set(prev);
      for (const a of addOnCatalog) {
        if (a.jobTags.some((t) => FULL_SERVICE_TAGS.has(t))) next.add(a.key);
      }
      return next;
    });
  }

  function clearAddOns() {
    setEnabledAddOns(new Set());
  }

  async function copyToClipboard() {
    if (!result) return;
    const text = [
      `$${result.proposalAmount.toFixed(2)}`,
      "",
      result.proposalNotes,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      publishInlineMessage({ type: "SUCCESS", text: "Mowing quote copied to clipboard." });
    } catch {
      publishInlineMessage({ type: "ERROR", text: "Copy failed — clipboard permission denied." });
    }
  }

  return (
    <VStack align="stretch" gap={4} p={4} maxW="900px" mx="auto">
      <Box>
        <HStack gap={2} align="center" mb={1}>
          <Calculator size={20} />
          <Text fontSize="lg" fontWeight="bold">Mowing Job Estimator</Text>
        </HStack>
        <Text fontSize="sm" color="fg.muted">
          Pick a base mow and toggle the add-ons that belong with this visit.
          Add-on catalog is loaded from your <Text as="span" fontWeight="medium">Pricing</Text> tab —
          every pricing entry with a <code>jobTag</code> (besides MOW) shows up
          as a toggleable add-on.
        </Text>
      </Box>

      {/* Base mow */}
      <Card.Root variant="outline">
        <Card.Body p={3}>
          <Text fontWeight="semibold" mb={2}>Base mow</Text>
          {!pricingLoaded ? (
            <HStack><Spinner size="sm" /><Text fontSize="sm" color="fg.muted">Loading pricing…</Text></HStack>
          ) : (
            <VStack align="stretch" gap={3}>
              <HStack gap={2} wrap="wrap">
                {(["standard", "acres", "time", "custom"] as BaseMode[]).map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant={baseMode === m ? "solid" : "outline"}
                    colorPalette={baseMode === m ? "blue" : "gray"}
                    onClick={() => setBaseMode(m)}
                  >
                    {m === "standard" ? "Standard yard" : m === "acres" ? "By acres" : m === "time" ? "By time" : "Custom"}
                  </Button>
                ))}
              </HStack>

              {baseMode === "standard" && (
                <Box>
                  {standardMowOptions.length === 0 ? (
                    <HStack gap={2} align="start">
                      <Box color="orange.500" mt="0.5"><TriangleAlert size={16} /></Box>
                      <Text fontSize="sm" color="orange.800">
                        No standard mow rate found (looking for a pricing
                        entry tagged exclusively <code>MOW</code>).
                        Pick another mode or add one in Pricing settings.
                      </Text>
                    </HStack>
                  ) : (
                    <VStack align="stretch" gap={1.5}>
                      {/* Picker — always rendered so the operator can see
                          which entry is driving the estimate even when
                          there's only one option. */}
                      <PricingPicker
                        items={mowPicker.items}
                        collection={mowPicker.collection}
                        selectedKey={mowPicker.selectedKey}
                        onChange={mowPicker.setSelectedKey}
                        placeholder="Pick a mow rate"
                      />
                      {standardMow && (
                        <Text fontSize="sm">
                          <Text as="span" fontWeight="medium">{standardMow.parsedValue?.label}</Text>
                          {" — "}
                          <Text as="span" color="green.700" fontWeight="bold">${Number(standardMow.parsedValue?.amount ?? 0).toFixed(2)}</Text>
                          {" "}{standardMow.parsedValue?.unit ?? "per visit"}
                        </Text>
                      )}
                      {standardMow?.parsedValue?.description && (
                        <Text fontSize="xs" color="fg.muted">{standardMow.parsedValue.description}</Text>
                      )}
                    </VStack>
                  )}
                </Box>
              )}

              {baseMode === "acres" && (
                <HStack gap={2} wrap="wrap">
                  <Input
                    size="sm"
                    type="number"
                    step="0.1"
                    placeholder="Acres"
                    value={acres}
                    onChange={(e) => setAcres(e.target.value)}
                    maxW="120px"
                  />
                  <Text fontSize="sm" color="fg.muted">
                    × ${Number(acreMow?.parsedValue?.amount ?? 0).toFixed(2)}/acre
                    {!acreMow && " (rate missing — add pricing_mowing_acre)"}
                  </Text>
                </HStack>
              )}

              {baseMode === "time" && (
                <HStack gap={2} wrap="wrap">
                  <Input size="sm" type="number" step="0.25" placeholder="Hours" value={hours} onChange={(e) => setHours(e.target.value)} maxW="100px" />
                  <Text fontSize="sm" color="fg.muted">hr ×</Text>
                  <Input size="sm" type="number" step="1" placeholder="Crew" value={crewSize} onChange={(e) => setCrewSize(e.target.value)} maxW="100px" />
                  <Text fontSize="sm" color="fg.muted">
                    crew × ${Number(laborRate?.parsedValue?.amount ?? 0).toFixed(2)}/hr
                    {!laborRate && " (rate missing — add pricing_general_labor)"}
                  </Text>
                </HStack>
              )}

              {baseMode === "custom" && (
                <HStack gap={2}>
                  <Text fontSize="sm" color="fg.muted" minW="80px">Base ($):</Text>
                  <Input size="sm" type="number" step="0.01" value={customBase} onChange={(e) => setCustomBase(e.target.value)} maxW="160px" placeholder="e.g. 85" />
                </HStack>
              )}

              {baseMode !== "custom" && (
                <HStack gap={2}>
                  <Text fontSize="xs" color="fg.muted" minW="120px">Override ($):</Text>
                  <Input
                    size="sm"
                    type="number"
                    step="0.01"
                    placeholder="leave blank for computed"
                    value={baseOverride}
                    onChange={(e) => setBaseOverride(e.target.value)}
                    maxW="160px"
                  />
                  {baseOverride && (
                    <Button size="xs" variant="ghost" onClick={() => setBaseOverride("")}>Clear</Button>
                  )}
                </HStack>
              )}
            </VStack>
          )}
        </Card.Body>
      </Card.Root>

      {/* Add-ons */}
      <Card.Root variant="outline">
        <Card.Body p={3}>
          <HStack justify="space-between" mb={2}>
            <Text fontWeight="semibold">Add-ons</Text>
            <HStack gap={2}>
              <Button size="xs" variant="solid" colorPalette="purple" onClick={applyFullService}>
                <Sparkles size={12} /> Full Service
              </Button>
              {enabledAddOns.size > 0 && (
                <Button size="xs" variant="ghost" onClick={clearAddOns}>Clear</Button>
              )}
            </HStack>
          </HStack>
          {!pricingLoaded ? (
            <HStack><Spinner size="sm" /><Text fontSize="sm" color="fg.muted">Loading pricing…</Text></HStack>
          ) : addOnCatalog.length === 0 ? (
            <Text fontSize="sm" color="fg.muted">
              No add-on services found in Pricing. Add entries with one or
              more tags (e.g. TRIM, EDGE, BLOW) in Money → Pricing — they'll
              appear here.
            </Text>
          ) : (
            <VStack align="stretch" gap={1}>
              {addOnCatalog.map((a) => {
                const isOn = enabledAddOns.has(a.key);
                const inFullService = a.jobTags.some((t) => FULL_SERVICE_TAGS.has(t));
                return (
                  <HStack
                    key={a.key}
                    gap={2}
                    p={2}
                    borderWidth="1px"
                    borderColor={isOn ? "blue.300" : "gray.200"}
                    bg={isOn ? "blue.50" : undefined}
                    borderRadius="md"
                    cursor="pointer"
                    onClick={() => toggleAddOn(a.key)}
                  >
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={() => toggleAddOn(a.key)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ cursor: "pointer" }}
                    />
                    <Box flex="1" minW={0}>
                      <HStack gap={2}>
                        <Text fontSize="sm" fontWeight="medium">{a.label}</Text>
                        {a.jobTags.length > 0 && (
                          <Badge
                            size="sm"
                            variant="subtle"
                            colorPalette="blue"
                            borderRadius="full"
                            px="2"
                            title={a.jobTags.length > 1 ? "This pricing entry is bound to multiple tags" : "This pricing entry's tag"}
                          >
                            ⚡ tag{a.jobTags.length > 1 ? "s" : ""}: {a.jobTags.map((t) => jobTagLabel(t)).join(", ")}
                          </Badge>
                        )}
                        {inFullService && (
                          <Badge size="sm" variant="subtle" colorPalette="purple">full service</Badge>
                        )}
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">{a.unit}</Text>
                    </Box>
                    <Text fontSize="sm" color="green.700" fontWeight="bold">${a.amount.toFixed(2)}</Text>
                  </HStack>
                );
              })}
            </VStack>
          )}
        </Card.Body>
      </Card.Root>

      {/* Frequency */}
      <Card.Root variant="outline">
        <Card.Body p={3}>
          <Text fontWeight="semibold" mb={2}>Frequency</Text>
          <HStack gap={2} wrap="wrap">
            {FREQUENCIES.map((f) => (
              <Button
                key={f.key}
                size="sm"
                variant={frequency === f.key ? "solid" : "outline"}
                colorPalette={frequency === f.key ? "blue" : "gray"}
                onClick={() => setFrequency(f.key)}
              >
                {f.label}
              </Button>
            ))}
          </HStack>
          {isRecurring && (
            <Text fontSize="xs" color="fg.muted" mt={2}>
              Used to project monthly + annual totals from the per-visit price.
            </Text>
          )}
        </Card.Body>
      </Card.Root>

      {/* Quote */}
      <Card.Root variant="outline" borderColor="green.300" bg="green.50">
        <Card.Body p={3}>
          <HStack justify="space-between" align="start" wrap="wrap" gap={3}>
            <VStack align="start" gap={1} minW={0}>
              <Text fontSize="xs" color="green.800" fontWeight="medium">Per visit</Text>
              <Text fontSize="3xl" fontWeight="bold" color="green.900" lineHeight="1">
                ${perVisitTotal.toFixed(2)}
              </Text>
              <Text fontSize="xs" color="green.700">
                Base ${baseAmount.toFixed(2)}
                {selectedAddOns.length > 0 && ` + ${selectedAddOns.length} add-on${selectedAddOns.length === 1 ? "" : "s"} ($${addOnsTotal.toFixed(2)})`}
              </Text>
              {isRecurring && monthlyTotal != null && annualTotal != null && (
                <HStack gap={3} mt={2} wrap="wrap">
                  <Box>
                    <Text fontSize="2xs" color="green.700">Monthly (est)</Text>
                    <Text fontSize="md" fontWeight="bold" color="green.900">${monthlyTotal.toFixed(2)}</Text>
                  </Box>
                  <Box>
                    <Text fontSize="2xs" color="green.700">Annual (est)</Text>
                    <Text fontSize="md" fontWeight="bold" color="green.900">${annualTotal.toFixed(2)}</Text>
                  </Box>
                </HStack>
              )}
            </VStack>
            <VStack align="end" gap={2}>
              <Button size="sm" variant="outline" colorPalette="green" disabled={!result} onClick={copyToClipboard}>
                <Copy size={14} /> Copy
              </Button>
              <Button
                size="sm"
                variant="solid"
                colorPalette="green"
                disabled
                title="Coming soon — will prefill a new Estimate with these numbers."
              >
                <FileText size={14} /> Use for new estimate
              </Button>
            </VStack>
          </HStack>
        </Card.Body>
      </Card.Root>
    </VStack>
  );
}
