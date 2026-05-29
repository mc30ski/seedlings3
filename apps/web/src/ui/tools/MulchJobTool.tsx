"use client";

// Mulch job estimator. Calculates cubic-yard volume + dollar price from
// bed dimensions, depth, and the configured pricing rate. Pure client-side
// math — reads /api/admin/pricing once on mount and never mutates anything.
//
// Pricing source: the `Setting` row with key prefix `pricing_*` whose JSON
// value carries `jobTag === "MULCH"`. The first such entry is treated as
// the active rate; the operator can override inline for one-off quotes
// without changing settings.
//
// Integration future: produces a ToolResult shape suitable for handing off
// to the New Estimate dialog. The "Use for new estimate" button is a stub
// in v1 — when wired up later, the estimate dialog will listen for a
// `tool:applyToEstimate` custom event carrying this object.

import { useEffect, useMemo, useState } from "react";
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
import { Calculator, Copy, FileText, Plus, Trash2, TriangleAlert } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";

// Mirrors the parsed pricing row returned by /api/admin/pricing. Only the
// fields the tool actually uses are declared — additional fields on the
// JSON payload are ignored.
type PricingRow = {
  key: string;
  parsedValue: {
    label?: string;
    description?: string;
    unit?: string;
    amount?: number;
    jobTag?: string | null;
  } | null;
};

// One bed entered by the operator. The tool supports either L×W dimensions
// or a direct sq-ft entry; the active mode is captured by `mode` so the
// UI can swap inputs without losing the other set of values.
type BedInput = {
  id: string;
  mode: "lw" | "sqft";
  length: string;
  width: string;
  sqft: string;
};

// What the tool emits. Will eventually be the payload of a
// `tool:applyToEstimate` custom event so the New Estimate dialog can
// listen + prefill. The shape stays stable across future tools by holding
// the per-tool specifics under `meta` and exposing the estimate-relevant
// fields at the top level.
export type ToolResult = {
  toolKey: "mulch";
  proposalAmount: number;
  proposalNotes: string;
  jobTags: string;
  meta: {
    beds: { sqFt: number; depthIn: number; yards: number }[];
    totalYards: number;
    ratePerYard: number;
    ratePerYardSource: "settings" | "override";
  };
};

const DEFAULT_DEPTH_IN = 2.5;
const MULCH_TAG = "MULCH";

function newBed(): BedInput {
  return {
    id: Math.random().toString(36).slice(2, 10),
    mode: "lw",
    length: "",
    width: "",
    sqft: "",
  };
}

// Round up to the next 0.5 yd (mulch delivery convention).
function roundUpToHalfYard(yards: number): number {
  return Math.ceil(yards * 2) / 2;
}

// Per-bed cubic-yard calculation. Returns null when inputs are incomplete
// so the UI can hide partial rows instead of flashing $0.00.
function computeBed(b: BedInput, depthIn: number): { sqFt: number; yards: number } | null {
  if (depthIn <= 0) return null;
  let sqFt = 0;
  if (b.mode === "lw") {
    const l = Number(b.length);
    const w = Number(b.width);
    if (!Number.isFinite(l) || !Number.isFinite(w) || l <= 0 || w <= 0) return null;
    sqFt = l * w;
  } else {
    const s = Number(b.sqft);
    if (!Number.isFinite(s) || s <= 0) return null;
    sqFt = s;
  }
  const cubicFeet = (sqFt * depthIn) / 12;
  const yards = cubicFeet / 27;
  return { sqFt, yards };
}

export default function MulchJobTool() {
  const [pricingLoaded, setPricingLoaded] = useState(false);
  const [mulchPricing, setMulchPricing] = useState<PricingRow | null>(null);
  const [rateOverride, setRateOverride] = useState<string>("");
  const [depthIn, setDepthIn] = useState<string>(String(DEFAULT_DEPTH_IN));
  const [roundHalfYard, setRoundHalfYard] = useState(true);
  const [beds, setBeds] = useState<BedInput[]>(() => [newBed()]);

  // Load pricing on mount. First MULCH-tagged entry wins; if none, the
  // operator can still enter an override and produce a quote.
  useEffect(() => {
    apiGet<PricingRow[]>("/api/admin/pricing")
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        const mulch = rows.find((r) => r.parsedValue?.jobTag === MULCH_TAG);
        if (mulch) setMulchPricing(mulch);
      })
      .catch(() => { /* no pricing — UI shows the missing-config notice */ })
      .finally(() => setPricingLoaded(true));
  }, []);

  // Effective rate: override first, then the pricing entry, then 0 (forces
  // the operator to enter something before the totals are meaningful).
  const ratePerYard = useMemo(() => {
    const overrideNum = Number(rateOverride);
    if (Number.isFinite(overrideNum) && overrideNum > 0) return overrideNum;
    const settingsNum = Number(mulchPricing?.parsedValue?.amount);
    if (Number.isFinite(settingsNum) && settingsNum > 0) return settingsNum;
    return 0;
  }, [rateOverride, mulchPricing]);

  const ratePerYardSource: "settings" | "override" = useMemo(() => {
    const overrideNum = Number(rateOverride);
    return Number.isFinite(overrideNum) && overrideNum > 0 ? "override" : "settings";
  }, [rateOverride]);

  // Per-bed totals. Null entries (incomplete inputs) are filtered out of
  // the summary so the operator sees a clean breakdown without partial rows.
  const depthNum = useMemo(() => {
    const d = Number(depthIn);
    return Number.isFinite(d) && d > 0 ? d : 0;
  }, [depthIn]);

  const bedResults = useMemo(() => {
    return beds
      .map((b) => ({ id: b.id, mode: b.mode, calc: computeBed(b, depthNum) }))
      .filter((r): r is { id: string; mode: "lw" | "sqft"; calc: { sqFt: number; yards: number } } => r.calc !== null);
  }, [beds, depthNum]);

  const rawTotalYards = useMemo(
    () => bedResults.reduce((sum, b) => sum + b.calc.yards, 0),
    [bedResults],
  );
  const totalYards = useMemo(
    () => (roundHalfYard ? roundUpToHalfYard(rawTotalYards) : rawTotalYards),
    [rawTotalYards, roundHalfYard],
  );
  const totalPrice = useMemo(() => totalYards * ratePerYard, [totalYards, ratePerYard]);

  // Result object emitted by the action buttons. Kept here so the "Copy
  // to clipboard" and "Use for new estimate" actions stay in sync.
  const result: ToolResult | null = useMemo(() => {
    if (bedResults.length === 0 || ratePerYard <= 0) return null;
    const lines: string[] = [];
    lines.push(`Mulch installation — ${totalYards.toFixed(roundHalfYard ? 1 : 2)} cubic yd${totalYards === 1 ? "" : "s"} @ $${ratePerYard.toFixed(2)}/yd`);
    if (mulchPricing?.parsedValue?.description) {
      lines.push(mulchPricing.parsedValue.description);
    }
    lines.push("");
    bedResults.forEach((b, i) => {
      lines.push(`Bed ${i + 1}: ${Math.round(b.calc.sqFt)} sq ft × ${depthNum}" depth ≈ ${b.calc.yards.toFixed(2)} yd`);
    });
    if (roundHalfYard && Math.abs(totalYards - rawTotalYards) > 0.001) {
      lines.push(`Rounded ${rawTotalYards.toFixed(2)} → ${totalYards.toFixed(1)} yd for delivery.`);
    }
    return {
      toolKey: "mulch",
      proposalAmount: Number(totalPrice.toFixed(2)),
      proposalNotes: lines.join("\n"),
      jobTags: MULCH_TAG,
      meta: {
        beds: bedResults.map((b) => ({ sqFt: b.calc.sqFt, depthIn: depthNum, yards: b.calc.yards })),
        totalYards,
        ratePerYard,
        ratePerYardSource,
      },
    };
  }, [bedResults, ratePerYard, mulchPricing, totalYards, rawTotalYards, depthNum, roundHalfYard, totalPrice, ratePerYardSource]);

  function updateBed(idx: number, patch: Partial<BedInput>) {
    setBeds((prev) => prev.map((b, i) => (i === idx ? { ...b, ...patch } : b)));
  }
  function removeBed(idx: number) {
    setBeds((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }
  function addBed() {
    setBeds((prev) => [...prev, newBed()]);
  }
  function toggleBedMode(idx: number) {
    setBeds((prev) =>
      prev.map((b, i) => (i === idx ? { ...b, mode: b.mode === "lw" ? "sqft" : "lw" } : b)),
    );
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
      publishInlineMessage({ type: "SUCCESS", text: "Mulch quote copied to clipboard." });
    } catch {
      publishInlineMessage({ type: "ERROR", text: "Copy failed — clipboard permission denied." });
    }
  }

  return (
    // Match the centered-with-padding layout used by ExportsTab, PaymentsTab,
    // etc. — without this the tool sits flush-left under the tab bar and
    // reads as misaligned compared to other tabs.
    <VStack align="stretch" gap={4} p={4} maxW="900px" mx="auto">
      <Box>
        <HStack gap={2} align="center" mb={1}>
          <Calculator size={20} />
          <Text fontSize="lg" fontWeight="bold">Mulch Job Estimator</Text>
        </HStack>
        <Text fontSize="sm" color="fg.muted">
          Calculate cubic yards of mulch needed and the installed price based on
          the configured rate. Reads <code>pricing_*</code> with <code>jobTag: "MULCH"</code>
          {" "}from Settings.
        </Text>
      </Box>

      {/* Pricing rate card */}
      <Card.Root variant="outline">
        <Card.Body p={3}>
          <Text fontWeight="semibold" mb={2}>Rate</Text>
          {!pricingLoaded ? (
            <HStack><Spinner size="sm" /><Text fontSize="sm" color="fg.muted">Loading pricing…</Text></HStack>
          ) : mulchPricing ? (
            <VStack align="stretch" gap={2}>
              <Box>
                <Text fontSize="sm">
                  <Text as="span" fontWeight="medium">{mulchPricing.parsedValue?.label ?? "Mulch"}</Text>
                  {" — "}
                  <Text as="span" color="green.700" fontWeight="bold">${Number(mulchPricing.parsedValue?.amount ?? 0).toFixed(2)}</Text>
                  {" "}{mulchPricing.parsedValue?.unit ?? "per cubic yard"}
                </Text>
                {mulchPricing.parsedValue?.description && (
                  <Text fontSize="xs" color="fg.muted">{mulchPricing.parsedValue.description}</Text>
                )}
              </Box>
              <HStack gap={2}>
                <Text fontSize="xs" color="fg.muted" minW="120px">Override ($/yd):</Text>
                <Input
                  size="sm"
                  type="number"
                  step="0.01"
                  placeholder="leave blank for default"
                  value={rateOverride}
                  onChange={(e) => setRateOverride(e.target.value)}
                  maxW="160px"
                />
                {rateOverride && (
                  <Button size="xs" variant="ghost" onClick={() => setRateOverride("")}>Clear</Button>
                )}
              </HStack>
            </VStack>
          ) : (
            <VStack align="stretch" gap={2}>
              <HStack gap={2} align="start">
                <Box color="orange.500" mt="0.5"><TriangleAlert size={16} /></Box>
                <Text fontSize="sm" color="orange.800">
                  No mulch rate found in Pricing settings (looking for an entry with
                  {" "}<code>jobTag: "MULCH"</code>). Enter a rate to use just for this quote,
                  or add one in <Text as="span" fontWeight="semibold">Money → Pricing</Text>.
                </Text>
              </HStack>
              <HStack gap={2}>
                <Text fontSize="xs" color="fg.muted" minW="120px">Rate ($/yd):</Text>
                <Input
                  size="sm"
                  type="number"
                  step="0.01"
                  placeholder="e.g. 95"
                  value={rateOverride}
                  onChange={(e) => setRateOverride(e.target.value)}
                  maxW="160px"
                />
              </HStack>
            </VStack>
          )}
        </Card.Body>
      </Card.Root>

      {/* Depth card */}
      <Card.Root variant="outline">
        <Card.Body p={3}>
          <Text fontWeight="semibold" mb={2}>Depth</Text>
          <HStack gap={2}>
            <Input
              size="sm"
              type="number"
              step="0.5"
              value={depthIn}
              onChange={(e) => setDepthIn(e.target.value)}
              maxW="100px"
            />
            <Text fontSize="sm" color="fg.muted">inches</Text>
          </HStack>
          <Text fontSize="xs" color="fg.muted" mt={1}>
            Typical mulch depth is 2–3″. Deeper for first install, shallower for refresh.
          </Text>
        </Card.Body>
      </Card.Root>

      {/* Beds card */}
      <Card.Root variant="outline">
        <Card.Body p={3}>
          <HStack justify="space-between" mb={2}>
            <Text fontWeight="semibold">Beds</Text>
            <Button size="xs" variant="outline" onClick={addBed}>
              <Plus size={12} /> Add bed
            </Button>
          </HStack>
          <VStack align="stretch" gap={3}>
            {beds.map((b, i) => {
              const calc = computeBed(b, depthNum);
              return (
                <Box key={b.id} borderWidth="1px" borderColor="gray.200" borderRadius="md" p={2}>
                  <HStack justify="space-between" mb={2}>
                    <HStack gap={2}>
                      <Text fontSize="sm" fontWeight="medium">Bed {i + 1}</Text>
                      <Button size="2xs" variant="ghost" onClick={() => toggleBedMode(i)}>
                        {b.mode === "lw" ? "Switch to sq ft" : "Switch to L × W"}
                      </Button>
                    </HStack>
                    {beds.length > 1 && (
                      <Button size="2xs" variant="ghost" colorPalette="red" onClick={() => removeBed(i)}>
                        <Trash2 size={12} />
                      </Button>
                    )}
                  </HStack>
                  {b.mode === "lw" ? (
                    <HStack gap={2} wrap="wrap">
                      <Input size="sm" type="number" placeholder="Length (ft)" value={b.length} onChange={(e) => updateBed(i, { length: e.target.value })} maxW="120px" />
                      <Text fontSize="sm" color="fg.muted">×</Text>
                      <Input size="sm" type="number" placeholder="Width (ft)" value={b.width} onChange={(e) => updateBed(i, { width: e.target.value })} maxW="120px" />
                      {calc && (
                        <Text fontSize="xs" color="fg.muted">
                          = {Math.round(calc.sqFt)} sq ft · {calc.yards.toFixed(2)} yd
                        </Text>
                      )}
                    </HStack>
                  ) : (
                    <HStack gap={2} wrap="wrap">
                      <Input size="sm" type="number" placeholder="Square feet" value={b.sqft} onChange={(e) => updateBed(i, { sqft: e.target.value })} maxW="140px" />
                      {calc && (
                        <Text fontSize="xs" color="fg.muted">
                          = {calc.yards.toFixed(2)} yd
                        </Text>
                      )}
                    </HStack>
                  )}
                </Box>
              );
            })}
          </VStack>
          <HStack gap={2} mt={3}>
            <input
              type="checkbox"
              checked={roundHalfYard}
              onChange={(e) => setRoundHalfYard(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            <Text fontSize="xs" color="fg.muted">
              Round up to next ½ yd for delivery
            </Text>
          </HStack>
        </Card.Body>
      </Card.Root>

      {/* Quote card */}
      <Card.Root variant="outline" borderColor="green.300" bg="green.50">
        <Card.Body p={3}>
          <HStack justify="space-between" align="start">
            <VStack align="start" gap={1}>
              <Text fontSize="xs" color="green.800" fontWeight="medium">Total quote</Text>
              <Text fontSize="3xl" fontWeight="bold" color="green.900" lineHeight="1">
                ${totalPrice.toFixed(2)}
              </Text>
              <Text fontSize="xs" color="green.700">
                {totalYards.toFixed(roundHalfYard ? 1 : 2)} cubic yd
                {totalYards === 1 ? "" : "s"} × ${ratePerYard.toFixed(2)}/yd
                {ratePerYardSource === "override" && (
                  <Badge ml={2} size="sm" colorPalette="orange" variant="subtle">override</Badge>
                )}
              </Text>
              {roundHalfYard && Math.abs(totalYards - rawTotalYards) > 0.001 && (
                <Text fontSize="2xs" color="green.700">
                  Raw {rawTotalYards.toFixed(2)} yd → delivery rounded to {totalYards.toFixed(1)} yd
                </Text>
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
