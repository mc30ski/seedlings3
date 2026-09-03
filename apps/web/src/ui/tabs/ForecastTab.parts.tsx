// Presentational pieces for ForecastTab.
//
// Charts are CSS, not a library: the shapes here are bars and a waterfall,
// they need to repaint on every slider tick, and a charting dependency would
// buy nothing but weight. Everything below is a pure function of props so a
// re-render on drag stays cheap.

import React, { useState } from "react";
import { Badge, Box, Button, HStack, Select, Separator, Stack, Text, VStack, createListCollection } from "@chakra-ui/react";
import { FiAlertTriangle, FiInfo, FiTrendingUp, FiTrendingDown } from "react-icons/fi";
import type { ForecastResult, WorkerOutcome, ForecastAssessment, MarketRateInfo } from "@/src/lib/forecast";
import { money, pct, VERDICT_LABEL, VERDICT_TONE } from "@/src/lib/forecast";
import { fmtDate } from "@/src/lib/dates";

/**
 * One numeric column of a comparison row.
 *
 * On a phone the header row is hidden and each number carries its own caption
 * instead. The three fixed numeric columns came to 260px, which on a 360px
 * screen left the label about 40px — narrow enough that "Revenue" itself broke
 * mid-word, one fragment per line. Nothing about the layout was salvageable at
 * that width; it had to stop being a table.
 */
function CompareCell({
  caption, w, children, ...rest
}: { caption: string; w: string; children: React.ReactNode } & Record<string, any>) {
  return (
    <Box w={{ base: "auto", md: w }} textAlign={{ base: "left", md: "right" }} minW={0}>
      <Text display={{ base: "block", md: "none" }} fontSize="10px" color="fg.muted"
            textTransform="uppercase" letterSpacing="wide" lineHeight="1.2">
        {caption}
      </Text>
      <Text fontVariantNumeric="tabular-nums" {...rest}>{children}</Text>
    </Box>
  );
}

/** Last-resort band, used only when no rate has been looked up. The real one
 *  comes from the BLS for the metro the business address sits in — see
 *  services/marketRate.ts. These constants exist so the component still
 *  renders when a baseline predates the lookup. */
export const MARKET_LOW = 15;
export const MARKET_HIGH = 24;

const PCT_LABEL: Record<number, string> = {
  10: "10th", 25: "25th", 50: "median", 75: "75th", 90: "90th",
};

/** Says plainly where the band came from, which survey year, and when it was
 *  fetched — so a number that steers a pay decision is never anonymous. */
export function MarketRateProvenance({ market }: { market?: MarketRateInfo }) {
  if (!market) return null;
  const looked = market.source === "bls";
  const tone = looked ? "blue" : market.source === "override" ? "purple" : "orange";
  return (
    <HStack
      gap={2} align="start" px={2.5} py={2} borderRadius="md"
      bg={`${tone}.subtle`} borderWidth="1px" borderColor={`${tone}.solid`}
    >
      <Box as={FiInfo} mt="2px" color={`${tone}.solid`} flexShrink={0} />
      <Box minW={0}>
        <Text fontSize="12.5px" fontWeight="semibold">
          Market rate ${market.low.toFixed(2)}–${market.high.toFixed(2)}/hr
          {market.percentiles && (
            <Text as="span" fontWeight="normal" color="fg.muted">
              {" "}({PCT_LABEL[market.percentiles[0]] ?? market.percentiles[0]}–
              {PCT_LABEL[market.percentiles[1]] ?? market.percentiles[1]} percentile)
            </Text>
          )}
        </Text>
        <Text fontSize="11.5px" color="fg.muted">
          {looked ? (
            <>
              US Bureau of Labor Statistics, OEWS {market.year} · Landscaping &amp;
              Groundskeeping Workers (SOC {market.occupation}) · {market.areaName} ·
              looked up from your business address
              {market.fetchedAt ? ` · cached ${fmtDate(market.fetchedAt)}` : ""}
            </>
          ) : market.source === "override" ? (
            <>Manually set in Settings (MARKET_RATE_OVERRIDE), overriding the BLS figure.</>
          ) : (
            <>Not looked up — this is a generic estimate, not a local figure.</>
          )}
        </Text>
        {market.note && (
          <Text fontSize="11.5px" color={looked ? "fg.muted" : `${tone}.fg`} mt={0.5}>
            {market.note}
          </Text>
        )}
      </Box>
    </HStack>
  );
}

// ── Headline numbers ────────────────────────────────────────────────────────

/**
 * The (i) affordance, matching the one on every Adjustments lever.
 *
 * Same contract deliberately: a toggle, not a hover tooltip. These sit on a
 * mobile-first tab where hover doesn't exist, and the explanations are long
 * enough that a tooltip would clip them.
 */
function InfoDot({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <Box
      as="button"
      aria-label={`What does "${label}" mean?`}
      aria-expanded={open}
      onClick={(e: any) => { e.stopPropagation(); onToggle(); }}
      color={open ? "blue.solid" : "fg.muted"}
      display="inline-flex"
      flexShrink={0}
      _hover={{ color: "blue.solid" }}
    >
      <FiInfo size={12} />
    </Box>
  );
}

function InfoPanel({ children }: { children: React.ReactNode }) {
  return (
    <Box mt={1.5} px={2.5} py={2} bg="blue.subtle" borderRadius="md"
         borderLeftWidth="3px" borderColor="blue.solid">
      <Text fontSize="11.5px" lineHeight="1.5">{children}</Text>
    </Box>
  );
}

/** What each headline number actually means. Written to answer "why is this
 *  number what it is", not to restate the label. */
const STAT_INFO: Record<string, string> = {
  "Retained after owner share":
    "What the business keeps once everything is paid — the crew, employer payroll tax, every operating cost, AND your own share of the jobs you personally worked. It is the bottom line for the COMPANY as a separate thing from you. Equipment purchases are not in it; a machine you will use for years is capital, not a cost of running this window's jobs, so it sits on its own line below.",
  "Margin":
    "Retained profit as a percentage of revenue collected. Negative means you finished behind: at −20% every dollar collected left you twenty cents down. It uses the retained figure, so it is after your own share — the business's margin, not yours.",
  "Labor % of revenue":
    "Every dollar that went to a person, as a share of revenue: crew pay, your own share, and the employer payroll tax charged on W-2 wages. This is usually the number that decides whether the business works. A lawn operation generally needs this in the 35–50% range; well above that and no amount of cost-cutting elsewhere closes the gap.",
  "LLC Owner share":
    "What YOU accrued for jobs you personally worked — your cut of those jobs, exactly like any crew member's. It is not payment for hours on the clock: under a share model, clocking time on a job you are not credited on earns nothing. It gets its own line because it is neither a business cost nor profit, and it is the number that moves when you model hiring someone to do your hours.",
};

/** Every line of the money flow, in plain terms. */
const FLOW_INFO: Record<string, string> = {
  "Revenue collected":
    "Cash actually collected on confirmed payments in this window — not what you invoiced. A job billed at $60 that paid $40 counts as $40 here, and one that paid nothing counts as nothing. Unpaid work is a collection problem, and counting it as revenue would hide a real loss.",
  "Job materials":
    "Mulch, chemicals and anything else bought for a specific job. It comes off the top before the crew's split is calculated, so it reduces both what workers take and what the business keeps. These also carry a ledger row — counted once here, not again under Operating costs.",
  "Processor fees":
    "What Stripe and the card networks skimmed off the payments. The business absorbs these in full; they are never charged back to a worker's share.",
  "Crew pay":
    "Everyone but you. Each worker's share of the jobs they worked, after the business keeps its margin. Under an hourly or rate-card structure this also carries those amounts.",
  "Employer payroll tax":
    "The employer's half — Social Security, Medicare, FUTA and state unemployment — as a percentage of W-2 wages. Charged on employees and trainees only: contractors pay their own, and the owner takes a draw rather than a paycheck. It comes from the app's estimator, never from imported Gusto rows.",
  "Operating costs":
    "Every business expense in the window — fuel, insurance, supplies, advertising — grouped by category in the Costs section, where you can tag which ones actually scale with volume. Equipment purchases above the fixed-asset threshold are held out; job materials are too, since they are already counted above.",
  "Operating profit":
    "Revenue less every cost of producing it, BEFORE your own share. This is the closest line to the P&L's Net Operating Income, and the one to use when comparing the two pages.",
  "Your own share":
    "Your cut of the jobs you personally worked, on its own line. Deducted here so that hiring someone to do your hours is a visible trade rather than a hidden one — replacing you converts this into crew pay.",
  "Retained in the business":
    "Operating profit after your own share. What the company kept, treating you as someone who has to be paid for the work you did.",
  "Equipment bought":
    "Purchases at or above your fixed-asset threshold — a mower, a trailer. Real money that left the bank, but held out of the lines above because a machine you will use for years is not a cost of running this window's jobs. Charging it all to one quarter is right for tax (Section 179) and wrong for judging whether the work itself pays. Same rule the P&L uses.",
  "Cash after equipment":
    "What actually happened to the bank balance: everything above, including the equipment. Use this for a cash-flow question and the line above it for an is-this-business-working question.",
};

export function StatStrip({
  scenario,
  statusQuo,
}: {
  scenario: ForecastResult;
  statusQuo: ForecastResult;
}) {
  const profitNow = statusQuo.profitAfterOwnerLabor;
  const profitNew = scenario.profitAfterOwnerLabor;

  // `betterWhenLower` inverts the good/bad colouring for labor share — a
  // smaller number is the win there, and colouring it like a loss is the
  // kind of thing that gets read wrong at a glance.
  const cards: Array<{
    k: string; now: number; next: number;
    fmt: (n: number) => string; deltaFmt: (n: number) => string;
    betterWhenLower?: boolean; neutral?: boolean;
  }> = [
    {
      k: "Retained after owner share",
      now: profitNow, next: profitNew,
      fmt: money, deltaFmt: (n) => (n >= 0 ? "+" : "−") + money(Math.abs(n)),
    },
    {
      k: "Margin",
      now: statusQuo.marginPercent, next: scenario.marginPercent,
      fmt: (n) => pct(n), deltaFmt: (n) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)} pts`,
    },
    {
      k: "Labor % of revenue",
      now: statusQuo.laborPercentOfRevenue, next: scenario.laborPercentOfRevenue,
      fmt: (n) => pct(n), deltaFmt: (n) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)} pts`,
      betterWhenLower: true,
    },
    {
      // Its own card, never folded into profit and never hidden. This is the
      // number that moves when you model hiring someone to do your hours.
      k: "LLC Owner share",
      now: statusQuo.ownerPay, next: scenario.ownerPay,
      fmt: money, deltaFmt: (n) => (n >= 0 ? "+" : "−") + money(Math.abs(n)),
      neutral: true,
    },
  ];

  // One open at a time — four cards side by side, and two expanded panels
  // push the layout around more than they explain.
  const [openInfo, setOpenInfo] = useState<string | null>(null);

  return (
    <HStack gap={2} align="stretch" wrap="wrap">
      {cards.map((c) => {
        const diff = c.next - c.now;
        const moved = Math.abs(diff) >= 0.05;
        const good = c.betterWhenLower ? diff < 0 : diff > 0;
        const tone = !moved || c.neutral ? "gray" : good ? "green" : "red";
        return (
          <Box key={c.k} flex="1 1 170px" minW="160px" borderWidth="1px" borderRadius="md" p={3} bg="bg.panel">
            <HStack gap={1} align="center" minW={0}>
              <Text fontSize="10px" letterSpacing="wide" textTransform="uppercase" color="fg.muted">
                {c.k}
              </Text>
              <InfoDot label={c.k} open={openInfo === c.k}
                       onToggle={() => setOpenInfo((v) => (v === c.k ? null : c.k))} />
            </HStack>
            <HStack gap={2} align="center" mt={1.5} wrap="wrap">
              <Text fontSize="22px" fontWeight="bold" lineHeight="1" fontVariantNumeric="tabular-nums">
                {c.fmt(c.next)}
              </Text>
              {/* The change, not the absolute, is what the operator is here to
                  read — so it gets the colour and a solid chip instead of the
                  faint trend arrow this used to carry. */}
              <Box
                px={1.5} py={0.5} borderRadius="full"
                bg={`${tone}.subtle`} borderWidth="1px" borderColor={`${tone}.solid`}
              >
                <Text fontSize="11px" fontWeight="bold" color={`${tone}.fg`}
                      fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
                  {moved ? c.deltaFmt(diff) : "no change"}
                </Text>
              </Box>
            </HStack>
            <Text fontSize="11.5px" color="fg.muted" mt={1.5} fontVariantNumeric="tabular-nums">
              Today {c.fmt(c.now)}
            </Text>
            {openInfo === c.k && STAT_INFO[c.k] && <InfoPanel>{STAT_INFO[c.k]}</InfoPanel>}
          </Box>
        );
      })}
    </HStack>
  );
}

// ── Money flow ──────────────────────────────────────────────────────────────

/**
 * Where the money went, top to bottom, always visible.
 *
 * The Waterfall below answers "what does my change do" — three columns of
 * today-vs-forecast-vs-change, and it lives in a section that can be collapsed
 * and stay collapsed. That left the tab with no plain answer to the first
 * question anyone actually asks, which is where the revenue went. This is that
 * answer and nothing else: one column, no comparison, no expander.
 */
export function MoneyFlow({
  scenario,
  capitalPurchases = 0,
}: {
  scenario: ForecastResult;
  capitalPurchases?: number;
}) {
  const lines: Array<{ label: string; amount: number; kind?: "in" | "rule" | "total" | "owner" }> = [
    { label: "Revenue collected", amount: scenario.revenue, kind: "in" },
    { label: "Job materials", amount: -scenario.materials },
    { label: "Processor fees", amount: -scenario.processorFees },
    { label: "Crew pay", amount: -scenario.crewPay },
    { label: "Employer payroll tax", amount: -scenario.employerBurden },
    { label: "Operating costs", amount: -scenario.costsTotal },
    { label: "Operating profit", amount: scenario.profitBeforeOwnerLabor, kind: "total" },
    { label: "Your own share", amount: -scenario.ownerPay, kind: "owner" },
    { label: "Retained in the business", amount: scenario.profitAfterOwnerLabor, kind: "total" },
  ];
  if (capitalPurchases > 0) {
    lines.push({ label: "Equipment bought", amount: -capitalPurchases });
    lines.push({
      label: "Cash after equipment",
      amount: scenario.profitAfterOwnerLabor - capitalPurchases,
      kind: "total",
    });
  }

  const [openInfo, setOpenInfo] = useState<string | null>(null);

  return (
    <Box borderWidth="1px" borderRadius="md" overflow="hidden">
      <HStack px={3} py={2} bg="bg.emphasized" gap={2}>
        <Box w="3px" h="14px" borderRadius="full" bg="blue.solid" flexShrink={0} />
        <Text fontSize="12px" fontWeight="bold" textTransform="uppercase" letterSpacing="0.1em">
          Where the money went
        </Text>
      </HStack>
      <VStack align="stretch" gap={0} px={3} py={1}>
        {lines.map((l) => {
          const isTotal = l.kind === "total";
          const open = openInfo === l.label;
          return (
            <Box key={l.label} borderTopWidth={isTotal ? "1px" : 0}>
              <HStack justify="space-between" gap={3} py={1.5}>
                <HStack gap={1.5} minW={0} align="center">
                  <Text fontSize="13px"
                        fontWeight={isTotal ? "semibold" : "normal"}
                        color={l.kind === "owner" ? "purple.fg" : undefined}>
                    {l.label}
                  </Text>
                  <InfoDot label={l.label} open={open}
                           onToggle={() => setOpenInfo((v) => (v === l.label ? null : l.label))} />
                </HStack>
                <Text fontSize={isTotal ? "14px" : "13px"}
                      fontWeight={isTotal ? "bold" : "normal"}
                      fontVariantNumeric="tabular-nums"
                      color={
                        isTotal ? (l.amount < 0 ? "red.solid" : "green.solid")
                          : l.kind === "in" ? "blue.fg"
                          : l.kind === "owner" ? "purple.fg"
                          : "fg"
                      }>
                  {money(l.amount)}
                </Text>
              </HStack>
              {open && FLOW_INFO[l.label] && (
                <Box pb={1.5}><InfoPanel>{FLOW_INFO[l.label]}</InfoPanel></Box>
              )}
            </Box>
          );
        })}
      </VStack>
    </Box>
  );
}

// ── Waterfall ───────────────────────────────────────────────────────────────

export function Waterfall({
  scenario,
  statusQuo,
  capitalPurchases = 0,
}: {
  scenario: ForecastResult;
  statusQuo: ForecastResult;
  /** Equipment bought in the window. Sits BELOW the operating total rather
   *  than inside it — the money left the bank, but a mower is not a cost of
   *  running this quarter's jobs. Shown whenever there were any, so it can
   *  never look like it was quietly ignored. */
  capitalPurchases?: number;
}) {
  const rows: Array<{ label: string; now: number; next: number; kind: "in" | "out" | "total" | "owner"; note?: string }> = [
    { label: "Revenue collected", now: statusQuo.revenue, next: scenario.revenue, kind: "in" },
    { label: "Job materials", now: -statusQuo.materials, next: -scenario.materials, kind: "out" },
    { label: "Processor fees", now: -statusQuo.processorFees, next: -scenario.processorFees, kind: "out" },
    { label: "Crew pay", now: -statusQuo.crewPay, next: -scenario.crewPay, kind: "out" },
    { label: "Employer tax + workers comp", now: -statusQuo.employerBurden, next: -scenario.employerBurden, kind: "out" },
    { label: "Operating costs", now: -statusQuo.costsTotal, next: -scenario.costsTotal, kind: "out" },
    {
      label: "Operating profit",
      note: "before the owner's share",
      now: statusQuo.profitBeforeOwnerLabor,
      next: scenario.profitBeforeOwnerLabor,
      kind: "total",
    },
    {
      // Always present. Neither a business cost nor silent profit — the
      // owner's own share of the work, on its own line so hiring someone to
      // do those hours is a visible trade rather than a hidden one.
      label: "LLC Owner share",
      note: "accrued to the owner for hours they worked",
      now: -statusQuo.ownerPay,
      next: -scenario.ownerPay,
      kind: "owner",
    },
    {
      label: "Retained in the business",
      note: "after the owner's share",
      now: statusQuo.profitAfterOwnerLabor,
      next: scenario.profitAfterOwnerLabor,
      kind: "total",
    },
  ];

  const scale = Math.max(scenario.revenue, statusQuo.revenue, 1);
  const cashAfterCapEx = scenario.profitAfterOwnerLabor - capitalPurchases;

  return (
    <VStack align="stretch" gap={0} borderWidth="1px" borderRadius="md" overflow="hidden">
      {/* Headers at a readable weight. These were 10px muted micro-caps and
          were effectively invisible — the comparison was on screen the whole
          time and styled to be ignored. */}
      <HStack px={3} py={2} bg="bg.subtle" fontSize="12px" fontWeight="semibold"
              display={{ base: "none", md: "flex" }}>
        <Text flex="1" color="fg.muted">Line</Text>
        <Text w="90px" textAlign="right" color="fg.muted">Today</Text>
        <Text w="90px" textAlign="right">Forecast</Text>
        <Text w="80px" textAlign="right">Change</Text>
      </HStack>
      {rows.map((r, i) => {
        const diff = r.next - r.now;
        const good = r.kind === "out" ? diff > 0 : diff > 0;
        return (
          <Box key={r.label} px={3} py={2}
               bg={r.kind === "total" ? "bg.subtle" : r.kind === "owner" ? "purple.subtle" : undefined}
               borderTopWidth={i === 0 ? 0 : "1px"}>
            <Stack direction={{ base: "column", md: "row" }}
                   gap={{ base: 1, md: 2 }} align={{ md: "center" }}>
              <Box flex={{ md: "1" }} minW={0}>
                <Text fontSize="13px"
                      fontWeight={r.kind === "total" || r.kind === "owner" ? "semibold" : "normal"}
                      color={r.kind === "owner" ? "purple.fg" : undefined}>
                  {r.label}
                </Text>
                {r.note && <Text fontSize="11px" color="fg.muted">{r.note}</Text>}
              </Box>
              <HStack gap={2} justify={{ base: "space-between", md: "flex-end" }}
                      w={{ base: "100%", md: "auto" }}>
                <CompareCell caption="Today" w="90px" fontSize="12px" color="fg.muted">
                  {money(r.now)}
                </CompareCell>
                <CompareCell caption="Forecast" w="90px" fontSize="13px" fontWeight="medium">
                  {money(r.next)}
                </CompareCell>
                <CompareCell caption="Change" w="80px" fontSize="12px"
                             color={Math.abs(diff) < 0.5 ? "fg.muted" : good ? "green.solid" : "red.solid"}>
                  {Math.abs(diff) < 0.5 ? "—" : money(diff)}
                </CompareCell>
              </HStack>
            </Stack>
            {/* Paired bars: the faint one is today, the solid one the scenario.
                Seeing both lengths at once is the point of the whole panel. */}
            <Box mt={1.5} position="relative" h="10px">
              <Box
                position="absolute" top="0" left="0" h="4px" borderRadius="sm"
                bg={r.kind === "in" ? "blue.muted" : r.kind === "total" ? "green.muted" : r.kind === "owner" ? "purple.muted" : "red.muted"}
                w={`${Math.min(100, (Math.abs(r.now) / scale) * 100)}%`}
              />
              <Box
                position="absolute" top="5px" left="0" h="4px" borderRadius="sm"
                bg={r.kind === "in" ? "blue.solid" : r.kind === "total" ? "green.solid" : r.kind === "owner" ? "purple.solid" : "red.solid"}
                w={`${Math.min(100, (Math.abs(r.next) / scale) * 100)}%`}
              />
            </Box>
          </Box>
        );
      })}
      {capitalPurchases > 0 && (
        <Box px={3} py={2} borderTopWidth="1px" bg="blue.subtle">
          <Stack direction={{ base: "column", md: "row" }} gap={{ base: 1, md: 2 }}
                 align={{ md: "center" }}>
            <Box flex={{ md: "1" }} minW={0}>
              <Text fontSize="13px" fontWeight="semibold">Equipment bought this window</Text>
              <Text fontSize="11px" color="fg.muted">
                Held out of the lines above — a machine you'll use for years isn't a cost of
                running this quarter's jobs. Same rule the P&amp;L uses.
              </Text>
            </Box>
            <HStack gap={2} w={{ base: "100%", md: "auto" }}
                    justify={{ base: "space-between", md: "flex-end" }}>
              <CompareCell caption="Spent" w="90px" fontSize="13px" fontWeight="medium">
                {money(-capitalPurchases)}
              </CompareCell>
              <CompareCell caption="Cash after" w="90px" fontSize="13px" fontWeight="bold"
                           color={cashAfterCapEx < 0 ? "red.solid" : "green.solid"}>
                {money(cashAfterCapEx)}
              </CompareCell>
              <Box w={{ base: "auto", md: "80px" }} />
            </HStack>
          </Stack>
        </Box>
      )}
    </VStack>
  );
}

// ── Per-person outcomes ─────────────────────────────────────────────────────

export function WorkerFairnessTable({
  scenario,
  statusQuo,
  market,
}: {
  scenario: ForecastResult;
  statusQuo: ForecastResult;
  market?: MarketRateInfo;
}) {
  const lo = market?.low ?? MARKET_LOW;
  const hi = market?.high ?? MARKET_HIGH;
  const rows = scenario.workers.filter((w) => w.clockedHours > 0);
  if (!rows.length) {
    return (
      <Text fontSize="13px" color="fg.muted">
        Nobody clocked hours in this window, so there are no per-person outcomes to show.
      </Text>
    );
  }
  const maxRate = Math.max(...rows.map((w) => w.effectiveHourly), hi, 1);

  return (
    <VStack align="stretch" gap={0} borderWidth="1px" borderRadius="md" overflow="hidden">
      {/* Desktop only. On a phone each number carries its own caption instead —
          a header row can't line up with a stacked layout. */}
      <HStack px={3} py={1.5} bg="bg.subtle" fontSize="10px" letterSpacing="wide"
              textTransform="uppercase" color="fg.muted"
              display={{ base: "none", md: "flex" }}>
        <Text flex="1">Worker</Text>
        <Text w="52px" textAlign="right">Hours</Text>
        <Text w="76px" textAlign="right">Pay</Text>
        <Text w="70px" textAlign="right">Today</Text>
        <Text w="120px">Per hour vs market</Text>
      </HStack>
      {rows.map((w, i) => {
        const before = statusQuo.workers.find((x) => x.userId === w.userId);
        const was = before?.effectiveHourly ?? 0;
        const change = was > 0 ? (w.effectiveHourly - was) / was : 0;
        return (
          <Box key={w.userId} px={3} py={2} borderTopWidth={i === 0 ? 0 : "1px"}>
            {/* Two rows on a phone, one on a desktop. The four fixed columns
                came to 318px, so on a 360px screen the name was squeezed to
                nothing and the badges rendered straight through the hours. */}
            <Stack direction={{ base: "column", md: "row" }}
                   gap={{ base: 1.5, md: 2 }} align={{ md: "center" }}>
              <HStack flex={{ md: "1" }} gap={1.5} minW={0} wrap="wrap">
                <Text fontSize="13px" fontWeight="medium" truncate>{w.name}</Text>
                {w.isOwner && <Badge size="xs" colorPalette="purple">Owner</Badge>}
                {w.hypothetical && <Badge size="xs" colorPalette="cyan">Modelled</Badge>}
                <Badge size="xs" variant="outline">
                  {w.workerType === "CONTRACTOR" ? "1099" : w.workerType === "TRAINEE" ? "Trainee" : "W-2"}
                </Badge>
              </HStack>
              <HStack gap={2} w={{ base: "100%", md: "auto" }}
                      align={{ base: "start", md: "center" }}
                      justify={{ base: "space-between", md: "flex-end" }}>
              <VStack w={{ base: "auto", md: "52px" }} align={{ base: "start", md: "end" }} gap={0}>
                <Text display={{ base: "block", md: "none" }} fontSize="10px" color="fg.muted"
                      textTransform="uppercase" letterSpacing="wide">Hours</Text>
                <Text fontSize="12px" fontVariantNumeric="tabular-nums">
                  {w.clockedHours.toFixed(0)}h
                </Text>
                {/* Hours paid but not worked. Shown beside the worked hours
                    because the per-hour bar to the right divides by the WORKED
                    ones — a guarantee lifts that rate without anyone being
                    paid more per hour on the job. */}
                {w.guaranteedTopUpHours > 0 && (
                  <Text fontSize="10px" color="orange.fg" fontVariantNumeric="tabular-nums">
                    +{w.guaranteedTopUpHours.toFixed(0)}h gtd
                  </Text>
                )}
              </VStack>
              <Box w={{ base: "auto", md: "76px" }} textAlign={{ base: "left", md: "right" }}>
                <Text display={{ base: "block", md: "none" }} fontSize="10px" color="fg.muted"
                      textTransform="uppercase" letterSpacing="wide">Pay</Text>
                <Text fontSize="12px" fontVariantNumeric="tabular-nums">{money(w.totalPay)}</Text>
              </Box>
              <VStack w={{ base: "auto", md: "70px" }} align={{ base: "end", md: "end" }} gap={0}>
                <Text display={{ base: "block", md: "none" }} fontSize="10px" color="fg.muted"
                      textTransform="uppercase" letterSpacing="wide">Today</Text>
                <Text fontSize="11px" color="fg.muted" fontVariantNumeric="tabular-nums">
                  ${was.toFixed(2)}
                </Text>
                {was > 0 && Math.abs(change) > 0.01 && (
                  <Text fontSize="11px" fontVariantNumeric="tabular-nums"
                        color={change > 0 ? "green.solid" : "red.solid"}>
                    {change > 0 ? "+" : "−"}{Math.abs(change * 100).toFixed(0)}%
                  </Text>
                )}
              </VStack>
              </HStack>
              {/* Full width on a phone: the bar IS the fairness read, and at
                  120px squeezed beside four other columns it was unreadable. */}
              <Box w={{ base: "100%", md: "120px" }}>
                {/* Market band drawn behind the bar, so "is this fair" is a
                    glance rather than a calculation. */}
                <Box position="relative" h="14px" bg="bg.subtle" borderRadius="sm" overflow="hidden">
                  <Box
                    position="absolute" top="0" bottom="0"
                    left={`${(lo / maxRate) * 100}%`}
                    w={`${((hi - lo) / maxRate) * 100}%`}
                    bg="green.muted" opacity={0.55}
                  />
                  <Box
                    position="absolute" top="3px" left="0" h="8px" borderRadius="sm"
                    w={`${Math.min(100, (w.effectiveHourly / maxRate) * 100)}%`}
                    bg={
                      w.effectiveHourly < 7.25 ? "red.solid"
                        : w.effectiveHourly < lo ? "orange.solid"
                        : "blue.solid"
                    }
                  />
                </Box>
                <Text fontSize="11px" fontVariantNumeric="tabular-nums" mt={0.5}>
                  ${w.effectiveHourly.toFixed(2)}/hr
                </Text>
              </Box>
            </Stack>
          </Box>
        );
      })}
      <Box px={3} py={1.5} bg="bg.subtle">
        <Text fontSize="11px" color="fg.muted">
          Green band is the local market rate (${lo.toFixed(2)}–${hi.toFixed(2)}/hr). Per-hour
          figures divide total pay by hours actually clocked, drive time included.
        </Text>
        {(() => {
          // The owner's rate is the number that answers "should I hire someone
          // to do my hours" — replacing them costs roughly the market rate,
          // so seeing what they currently accrue per hour is the whole trade.
          const owner = rows.find((w) => w.isOwner);
          if (!owner) return null;
          const cheap = owner.effectiveHourly < lo;
          return (
            <Text fontSize="11px" color={cheap ? "orange.fg" : "fg.muted"} mt={1}>
              You are accruing <strong>${owner.effectiveHourly.toFixed(2)}/hr</strong> for{" "}
              {owner.clockedHours.toFixed(0)}h of your own work
              {cheap
                ? ` — under the $${lo.toFixed(2)}/hr it would cost to replace you. Hiring those hours out would cost more than you are currently taking.`
                : ` — above the $${lo.toFixed(2)}/hr it would cost to replace you, so hiring those hours out would cost less than you are taking.`}
            </Text>
          );
        })()}
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
  AS_IS: "As is — holds what you actually spent",
  FIXED: "Fixed — doesn't grow with volume",
  VARIABLE: "Variable — scales with revenue",
  PER_JOB: "Per job — scales with job count",
  ONE_TIME: "One-time — excluded from a forward view",
  DISCRETIONARY: "Discretionary — you choose each period",
};

/** The five behaviors, for the per-row picker. Labels are short because they
 *  sit in a table cell; the group headings carry the full explanation. */
const BEHAVIOR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "AS_IS", label: "As is" },
  { value: "FIXED", label: "Fixed" },
  { value: "VARIABLE", label: "Variable" },
  { value: "PER_JOB", label: "Per job" },
  { value: "ONE_TIME", label: "One-time" },
  { value: "DISCRETIONARY", label: "Discretionary" },
];

export function CostBreakdown({
  scenario,
  statusQuo,
  onRetag,
}: {
  scenario: ForecastResult;
  statusQuo: ForecastResult;
  /** Retag a category for this scenario. Advisory — it does NOT write the
   *  EXPENSE_COST_BEHAVIOR setting; it rides along with the saved forecast. */
  onRetag?: (category: string, behavior: string) => void;
}) {
  const todayByCategory = new Map(statusQuo.costs.map((c) => [c.category, c.amount]));
  // statusQuo is simulated with the default assumptions, so its behavior is
  // the configured one — the baseline to show a retag against.
  const baseBehavior = new Map(statusQuo.costs.map((c) => [c.category, c.behavior]));

  const groups = new Map<string, typeof scenario.costs>();
  for (const c of scenario.costs) {
    if (!groups.has(c.behavior)) groups.set(c.behavior, []);
    groups.get(c.behavior)!.push(c);
  }
  // AS_IS FIRST, and it must be here at all: this list is what gets rendered,
  // so when AS_IS became the default for every untagged category the whole
  // table silently emptied — every row grouped under a behavior the renderer
  // didn't know to draw.
  const order = ["AS_IS", "FIXED", "VARIABLE", "PER_JOB", "DISCRETIONARY", "ONE_TIME"];
  const total = scenario.costsTotal || 1;

  return (
    <VStack align="stretch" gap={2}>
      <Text fontSize="11.5px" color="fg.muted">
        Every category starts at <Text as="span" fontWeight="semibold">As is</Text> — the amount
        you actually spent, unchanged by the other levers. Tag the ones you know scale, and they
        follow volume. Tags belong to this scenario and save with it.
      </Text>
      <HStack px={2.5} fontSize="12px" fontWeight="semibold">
        <Text flex="1" color="fg.muted">Category</Text>
        <Text w="132px" color="fg.muted">Behaves as</Text>
        <Text w="80px" textAlign="right" color="fg.muted">Today</Text>
        <Text w="80px" textAlign="right">Forecast</Text>
        <Text w="70px" textAlign="right">Change</Text>
      </HStack>
      {order.filter((b) => groups.has(b)).map((b) => {
        const rows = groups.get(b)!;
        const sub = rows.reduce((s, r) => s + r.amount, 0);
        const subToday = rows.reduce((s, r) => s + (todayByCategory.get(r.category) ?? 0), 0);
        return (
          <Box key={b} borderWidth="1px" borderRadius="md" p={2.5}>
            <HStack gap={2} mb={1}>
              <Text flex="1" fontSize="11px" fontWeight="medium" color="fg.muted">
                {BEHAVIOR_LABEL[b] ?? b}
              </Text>
              <Box w="132px" />
              <Text w="80px" textAlign="right" fontSize="12px" color="fg.muted"
                    fontVariantNumeric="tabular-nums">{money(subToday)}</Text>
              <Text w="80px" textAlign="right" fontSize="12px" fontWeight="semibold"
                    fontVariantNumeric="tabular-nums">{money(sub)}</Text>
              <Text w="70px" textAlign="right" fontSize="12px" fontVariantNumeric="tabular-nums"
                    color={Math.abs(sub - subToday) < 0.5 ? "fg.muted" : sub > subToday ? "red.solid" : "green.solid"}>
                {Math.abs(sub - subToday) < 0.5 ? "—" : money(sub - subToday)}
              </Text>
            </HStack>
            {rows.sort((x, y) => y.amount - x.amount).map((r) => {
              const was = todayByCategory.get(r.category) ?? 0;
              const diff = r.amount - was;
              const original = baseBehavior.get(r.category);
              return (
                <HStack key={r.category} gap={2} py={1}>
                  <HStack flex="1" gap={2} minW={0}>
                    <Text fontSize="12px" truncate>{r.category}</Text>
                    <Box flex="1" h="5px" bg="bg.subtle" borderRadius="sm" overflow="hidden" maxW="90px">
                      <Box h="100%" bg="orange.solid" w={`${Math.min(100, (r.amount / total) * 100)}%`} />
                    </Box>
                  </HStack>
                  <Box w="132px">
                    {onRetag ? (
                      <BehaviorPicker
                        value={r.behavior}
                        original={original}
                        onChange={(v) => onRetag(r.category, v)}
                      />
                    ) : (
                      <Text fontSize="11px" color="fg.muted">{r.behavior}</Text>
                    )}

                  </Box>
                  <Text fontSize="12px" w="80px" textAlign="right" color="fg.muted"
                        fontVariantNumeric="tabular-nums">{money(was)}</Text>
                  <Text fontSize="12px" w="80px" textAlign="right"
                        fontVariantNumeric="tabular-nums">{money(r.amount)}</Text>
                  <Text fontSize="12px" w="70px" textAlign="right" fontVariantNumeric="tabular-nums"
                        color={Math.abs(diff) < 0.5 ? "fg.muted" : diff > 0 ? "red.solid" : "green.solid"}>
                    {Math.abs(diff) < 0.5 ? "—" : money(diff)}
                  </Text>
                </HStack>
              );
            })}
          </Box>
        );
      })}
    </VStack>
  );
}

function BehaviorPicker({
  value, original, onChange,
}: {
  value: string; original?: string; onChange: (v: string) => void;
}) {
  const collection = createListCollection({ items: BEHAVIOR_OPTIONS });
  const changed = original !== undefined && original !== value;
  return (
    <Select.Root
      collection={collection}
      value={[value]}
      onValueChange={(e) => { const v = e.value?.[0]; if (v) onChange(v); }}
      size="xs"
      positioning={{ strategy: "fixed", hideWhenDetached: true }}
    >
      <Select.Control>
        <Select.Trigger
          w="100%" px="1.5"
          borderColor={changed ? "blue.solid" : undefined}
          color={changed ? "blue.fg" : undefined}
        >
          <Select.ValueText />
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

export function ComparisonPanel({ entries }: { entries: ComparisonEntry[] }) {
  if (entries.length < 2) {
    return (
      <Text fontSize="13px" color="fg.muted">
        Pick two or more saved forecasts to line them up here. Comparing the same window under
        different assumptions — or the same assumptions across two seasons — is usually more
        informative than either one alone.
      </Text>
    );
  }
  const profitOf = (e: ComparisonEntry) => e.result.profitAfterOwnerLabor;
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
