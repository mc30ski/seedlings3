// "Earning Power" card for the Worker Home tab.
//
// Prominent single-metric card that shows the worker their average
// $/hr over a user-selectable window. Visual treatment intensifies
// with the rate — low tiers are neutral + encouraging, high tiers
// add color + glow + sparkle. The goal is "make the worker want to
// look at this number" without being condescending at the low end.
//
// Data: /api/me/hourly-pay?days=N (see routes/worker.ts).

"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Card, HStack, IconButton, Spinner, Text, VStack } from "@chakra-ui/react";
import { ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList } from "recharts";
import { bizToday, bizAddDays } from "@/src/lib/dates";
import {
  Award,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Crown,
  DollarSign,
  RefreshCw,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { fmtDateOpts, fmtTimeOpts } from "@/src/lib/dates";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { Dashboard } from "@/src/ui/components/Dashboard";

export type BreakdownJob = {
  id: string;
  completedAt: string | null;
  label: string;
  clientName: string | null;
  tags: string[];
  basePrice: number;
  addonsTotal: number;
  expensesTotal: number;
  net: number;
  myPercent: number;
  shareSource: "completionSplits" | "even-split" | "none";
  grossShare: number;
  feeAmount: number;
  projected: number;
};
export type BreakdownWorkday = {
  startedAt: string;
  endedAt: string;
  pausedMs: number;
  activeMs: number;
};
export type HourlyPayDetails = {
  ratePct: number;
  rateLabel: string;
  jobs: BreakdownJob[];
  workdays: BreakdownWorkday[];
};
export type HourlyPay = {
  dollars: number;
  hours: number;
  jobs: number;
  ratePerHour: number;
  days: number;
  details?: HourlyPayDetails;
};

type Props = {
  // Optional: when Admin Home views a specific worker via the "View
  // as" picker, pass that worker's id so the card shows their data
  // instead of the caller's. Admin-only on the server side.
  viewAsUserId?: string | null;
  // Optional: display name of the impersonated worker for the header
  // copy ("Earnings for {name}").
  viewAsDisplayName?: string | null;
  // Optional: when provided, embed a weekly-earnings trend chart at
  // the bottom of this card, filtered to whatever period the pay
  // selector is on. The chart's own header ("Weekly Earnings") is
  // omitted so both surfaces read as one section driven by one
  // time-frame control.
  weeklyCompleted?: { weekStart: string; count: number; earnings: number }[];
};

// Two kinds of periods:
//   • Rolling windows — "last N days" ending at "now". Anchored on
//     absolute time, so completing a job at 11 PM still counts against
//     the same window a job at 6 AM does. Good for "how am I doing
//     lately" trend context.
//   • Calendar-anchored presets — "today" and "yesterday". Anchored on
//     ET midnight boundaries so the labels mean what the operator
//     actually thinks they mean (yesterday = yesterday's physical
//     calendar day, not "last 24 hours"). Required by the operator so
//     the label + numbers agree with their day-end payroll checks.
//
// Workers see the short list — the intent is "how am I doing lately",
// not year-over-year trend analysis. Admins viewing a specific worker
// via the "View as" picker get the extended list so they can spot
// longer-arc performance context that the worker themselves doesn't.
export type Period = {
  /** UI label. Rendered verbatim by buttonPeriodLabel below. */
  label: string;
  /** Rolling-window size in days. Ignored when `preset` is set. */
  days?: number;
  /** Calendar-anchored preset — server resolves boundaries in ET. */
  preset?: "today" | "yesterday";
};

export const WORKER_PERIODS: Period[] = [
  { preset: "today", label: "today" },
  { preset: "yesterday", label: "yesterday" },
  { days: 3, label: "last 3 days" },
  { days: 7, label: "last week" },
  { days: 14, label: "last 2 weeks" },
  { days: 21, label: "last 3 weeks" },
  { days: 30, label: "last month" },
];
export const ADMIN_EXTRA_PERIODS: Period[] = [
  { days: 60, label: "last 2 months" },
  { days: 90, label: "last 3 months" },
  { days: 180, label: "last 6 months" },
  { days: 365, label: "last year" },
];
export const ADMIN_PERIODS = [...WORKER_PERIODS, ...ADMIN_EXTRA_PERIODS];
export const DEFAULT_DAYS = 30;
/** Default period used by pickers that only accept days-based state.
 *  Matches the "last month" entry above. */
export const DEFAULT_PERIOD: Period = { days: DEFAULT_DAYS, label: "last month" };

/** Stable string ID for a period — used as React key / persisted state
 *  and to look up the current period in the array. */
export function periodKey(p: Period): string {
  if (p.preset) return `preset:${p.preset}`;
  return `days:${p.days ?? 0}`;
}

/** Build the query-param fragment the server understands. */
export function periodQueryParams(p: Period): string {
  return p.preset ? `preset=${p.preset}` : `days=${p.days ?? 0}`;
}

/** Labels are already in their display form (e.g. "last week", "today").
 *  Helper kept for API compatibility with callers that used to format
 *  the raw label. */
export function buttonPeriodLabel(label: string): string {
  return label;
}

export type Tier = {
  min: number;
  label: string;
  tagline: string;
  bg: string;
  border: string;
  fg: string;
  numberFg: string;
  icon: LucideIcon;
  animation?: string;
  sparkle: boolean;
};

// Ranges tuned to lawn-care market realities in North Carolina: min
// wage is $7.25, entry-level $10-15, skilled $20-30, top solo
// operator $40+, owner or specialist $60+. Tune when we learn more.
export const TIERS: Tier[] = [
  {
    min: 0,
    label: "Building up",
    tagline: "Every hour adds up.",
    bg: "gray.50",
    border: "gray.200",
    fg: "gray.700",
    numberFg: "gray.800",
    icon: TrendingUp,
    sparkle: false,
  },
  {
    min: 10,
    label: "Getting there",
    tagline: "Steady progress.",
    bg: "teal.50",
    border: "teal.200",
    fg: "teal.800",
    numberFg: "teal.900",
    icon: TrendingUp,
    sparkle: false,
  },
  {
    min: 15,
    label: "Solid earner",
    tagline: "You're on solid ground.",
    bg: "green.50",
    border: "green.300",
    fg: "green.800",
    numberFg: "green.900",
    icon: DollarSign,
    sparkle: false,
  },
  {
    min: 25,
    label: "Skilled hand",
    tagline: "Doing really well.",
    bg: "green.100",
    border: "green.400",
    fg: "green.900",
    numberFg: "green.900",
    icon: Award,
    sparkle: false,
  },
  {
    min: 40,
    label: "Top performer",
    tagline: "Top of the field.",
    bg: "cyan.50",
    border: "cyan.400",
    fg: "cyan.900",
    numberFg: "cyan.900",
    icon: Award,
    sparkle: true,
  },
  {
    min: 60,
    label: "Elite",
    tagline: "Elite earner.",
    bg: "purple.50",
    border: "purple.400",
    fg: "purple.900",
    numberFg: "purple.900",
    icon: Crown,
    sparkle: true,
  },
];

export function tierFor(rate: number): Tier {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (rate >= TIERS[i].min) return TIERS[i];
  }
  return TIERS[0];
}

export function fmtHours(n: number): string {
  if (n >= 1000) return `${Math.round(n).toLocaleString()}h`;
  return `${n.toFixed(1)}h`;
}

export function fmtUSD(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function fmtUSDPrecise(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtMsAsHrs(ms: number): string {
  const h = ms / 3_600_000;
  return `${h.toFixed(2)}h`;
}

function fmtCompletedAt(iso: string | null): string {
  return fmtDateOpts(iso, { month: "short", day: "numeric" });
}

function fmtCompletedTime(iso: string | null): string {
  if (!iso) return "";
  return fmtTimeOpts(iso, { hour: "numeric", minute: "2-digit" });
}

function fmtWorkdayStart(iso: string): string {
  const day = fmtDateOpts(iso, { month: "short", day: "numeric" });
  const t = fmtTimeOpts(iso, { hour: "numeric", minute: "2-digit" });
  return `${day} ${t}`;
}

function shareSourceLabel(s: BreakdownJob["shareSource"]): string {
  if (s === "completionSplits") return "from splits at completion";
  if (s === "even-split") return "even split among crew";
  return "no share";
}

export default function WorkerHourlyPayCard({ viewAsUserId, viewAsDisplayName, weeklyCompleted }: Props = {}) {
  // Period is session-only (plain useState, no persistence). Every fresh
  // page load resets to the default so the card always starts at the
  // "how am I doing lately" default instead of remembering whatever the
  // user last cycled to. Deliberate — the previous persisted-state
  // version confused users who came back the next day expecting the
  // default and saw a stale window.
  const [periodKeyState, setPeriodKeyState] = useState<string>(periodKey(DEFAULT_PERIOD));
  const [data, setData] = useState<HourlyPay | null>(null);
  const [loading, setLoading] = useState(false);

  // "How was this calculated?" panel — collapsed by default, fires a
  // second request on first expand and caches the payload keyed by
  // (days, viewAsUserId). Re-expanding after a period change re-fetches.
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<HourlyPayDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  // True once a details fetch has actually failed. Used to distinguish
  // "no data yet because we haven't fetched" (show spinner) from "no
  // data because the fetch failed" (show error fallback).
  const [detailsError, setDetailsError] = useState(false);

  // Admin-viewing-a-worker gets the extended list; regular worker
  // Home is capped at 1 month.
  const isAdminView = !!viewAsUserId;
  const periods = isAdminView ? ADMIN_PERIODS : WORKER_PERIODS;

  // Clamp stale persisted values that fall outside the current allowed
  // list — e.g. a worker previously saw a longer period and later got
  // locked to the short list. Snap to the default.
  const currentPeriod = periods.find((p) => periodKey(p) === periodKeyState);
  const effectivePeriod = currentPeriod ?? periods.find((p) => periodKey(p) === periodKey(DEFAULT_PERIOD)) ?? periods[0];
  const effectiveKey = periodKey(effectivePeriod);
  useEffect(() => {
    if (!currentPeriod) setPeriodKeyState(effectiveKey);
  }, [currentPeriod, effectiveKey]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams(periodQueryParams(effectivePeriod));
      if (viewAsUserId) qs.set("viewAsUserId", viewAsUserId);
      const d = await apiGet<HourlyPay>(`/api/me/hourly-pay?${qs.toString()}`);
      setData(d);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load hourly pay.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [effectiveKey, viewAsUserId]);

  useEffect(() => { void load(); }, [load]);

  // Re-fetch when the hero refresh (or any surface that dispatches
  // this event) asks for a page-wide refresh. Same channel the
  // workday banners already listen on, so one event covers every
  // data-owning surface on the Home page.
  useEffect(() => {
    const onRefresh = () => { void load(); };
    window.addEventListener("seedlings:workday-changed", onRefresh);
    return () => window.removeEventListener("seedlings:workday-changed", onRefresh);
  }, [load]);

  // Any change to the summary inputs invalidates the details cache so
  // the next render pulls fresh breakdown data. If the panel is open
  // right now, the effect below will re-fetch immediately; otherwise
  // the next expand triggers the fetch.
  useEffect(() => {
    setDetails(null);
    setDetailsError(false);
  }, [effectiveKey, viewAsUserId]);

  const loadDetails = useCallback(async () => {
    setDetailsLoading(true);
    setDetailsError(false);
    try {
      const qs = new URLSearchParams(periodQueryParams(effectivePeriod));
      qs.set("details", "1");
      if (viewAsUserId) qs.set("viewAsUserId", viewAsUserId);
      const d = await apiGet<HourlyPay>(`/api/me/hourly-pay?${qs.toString()}`);
      // Rewrite summary too — the details fetch is authoritative for
      // the same window, so keep them in sync in case the underlying
      // data changed between fetches.
      setData(d);
      setDetails(d.details ?? null);
    } catch (err) {
      setDetailsError(true);
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load pay breakdown.", err),
      });
    } finally {
      setDetailsLoading(false);
    }
  }, [effectiveKey, viewAsUserId]);

  // Single source of truth for "when the panel is open and we don't
  // have data, fetch it". Handles the initial expand AND the case
  // where a period / view-as change wipes the cache while expanded.
  // The `!detailsError` guard prevents an infinite retry loop when
  // the backend is failing.
  useEffect(() => {
    if (expanded && !details && !detailsLoading && !detailsError) {
      void loadDetails();
    }
  }, [expanded, details, detailsLoading, detailsError, loadDetails]);

  function toggleExpanded() {
    setExpanded((v) => !v);
  }

  function refreshAll() {
    void load();
    if (expanded) {
      // Clear details + error so the effect above re-fetches.
      setDetails(null);
      setDetailsError(false);
    }
  }

  const period = effectivePeriod;

  // Cycle-forward on click of the label chip — dead simple UI, no
  // dropdown mechanics. Long-press or the refresh icon handle the
  // rare "wait, I meant to go back" case (they can just click again).
  function cyclePeriod() {
    const idx = periods.findIndex((p) => periodKey(p) === effectiveKey);
    const next = periods[(idx + 1) % periods.length];
    setPeriodKeyState(periodKey(next));
  }

  if (!data) {
    return loading ? (
      <Card.Root variant="outline">
        <Card.Body p={4}>
          <HStack gap={2}>
            <Spinner size="sm" />
            <Text fontSize="sm" color="fg.muted">Loading your earning rate…</Text>
          </HStack>
        </Card.Body>
      </Card.Root>
    ) : null;
  }

  const rate = data.ratePerHour;
  // Tier still drives the LABEL, tagline, icon and sparkle — the
  // encouragement ladder. The PALETTE is deliberately FIXED (light yellow),
  // per operator preference (2026-08-24).
  //
  // Two reasons it was tier-coloured before and shouldn't be:
  //   1. The card sits directly above the PAYROLL section, which states
  //      what someone was actually paid. Recolouring by rate reads as the
  //      app passing judgement on their earnings.
  //   2. The colour tracked the PERIOD DROPDOWN as much as the worker —
  //      switching "last month" to "last 2 weeks" could flip the card from
  //      gray to teal with no change in what anyone earned.
  //
  // NOTE: AllWorkersHourlyPayCards (Super aggregate) still uses tierFor's
  // colours. Left alone deliberately; change both together if that should
  // go neutral too.
  // Yellow marks this as the ESTIMATE, distinct from the blue PAYROLL
  // section directly below it, which reports what was actually paid.
  const tier = {
    ...tierFor(rate),
    bg: "yellow.50",
    border: "yellow.200",
    fg: "yellow.900",
    numberFg: "yellow.900",
  };
  const Icon = tier.icon;
  const hasHours = data.hours > 0;
  const periodDisplay = buttonPeriodLabel(period.label);
  const cycleTitle = `Showing ${periodDisplay} — click to change period`;

  return (
    // Same chrome as the other Home sections: collapsible, with the thicker
    // left accent stripe. `estimate` is the amber palette — this is a number
    // the app DERIVED, sitting above the blue PAYROLL section that reports
    // what Gusto actually paid.
    //
    // The rate rides in `summarySlot` so a collapsed section still answers
    // the question it exists for. The period picker stays in the BODY: the
    // Dashboard header is itself a button, and nesting one inside would be
    // invalid markup and would fight the collapse toggle.
    <Dashboard
      storageKey="seedlings:homeTab:hourlyPayOpen"
      // "My earnings" for the worker's own card; "Earnings: Name" when an
      // admin is viewing someone else, since "My" would then be wrong.
      // Same shape as MY ACTIVITIES -> "Activities: Name", and the colon
      // convention every Home section now shares.
      title={
        viewAsUserId && viewAsDisplayName
          ? `Earnings: ${viewAsDisplayName}`
          : "My earnings"
      }
      icon={Icon}
      variant="estimate"
      // Collapsed ONLY. Open, the rate is already the largest thing on the
      // card — repeating it beside the title is redundant. Collapsed, it is
      // the whole reason to have a header line.
      collapsedSummarySlot={
        hasHours ? (
          <Text fontSize="xs" fontWeight="bold" color={tier.numberFg} whiteSpace="nowrap">
            ${rate.toFixed(2)}/hr
          </Text>
        ) : undefined
      }
    >
      <Box>
        <HStack justify="flex-end" mb={2} align="start">
          <HStack gap={1}>
            <Button
              size="xs"
              variant="outline"
              px="2"
              onClick={cyclePeriod}
              title={cycleTitle}
              borderColor={tier.border}
              bg="whiteAlpha.700"
              css={{
                color: `var(--chakra-colors-${tier.fg.replace(".", "-")})`,
                "&:hover": { background: "white", borderColor: `var(--chakra-colors-${tier.numberFg.replace(".", "-")})` },
              }}
            >
              {periodDisplay}
              <Box as="span" ml={1} display="inline-flex" opacity={0.7}>
                <ChevronsUpDown size={11} />
              </Box>
            </Button>
          </HStack>
        </HStack>

        {hasHours ? (
          <>
            <HStack gap={3} align="center" mb={2}>
              <Box color={tier.numberFg} flexShrink={0}>
                <Icon size={40} strokeWidth={2} />
              </Box>
              <VStack align="start" gap={0} flex={1} minW={0}>
                <HStack align="baseline" gap={1}>
                  <Text
                    fontSize={{ base: "4xl", md: "5xl" }}
                    fontWeight="bold"
                    color={tier.numberFg}
                    lineHeight="1"
                  >
                    ${rate.toFixed(2)}
                  </Text>
                  <Text fontSize="md" color={tier.fg} fontWeight="medium">/hr</Text>
                </HStack>
                <Text fontSize="sm" color={tier.fg} mt={1}>
                  {tier.label} · {tier.tagline}
                </Text>
              </VStack>
              {tier.sparkle && (
                <Box color={tier.numberFg} flexShrink={0}>
                  <Sparkles size={24} />
                </Box>
              )}
            </HStack>
            <HStack gap={1.5} align="baseline" wrap="wrap">
              <Text fontSize="xl" fontWeight="bold" color={tier.numberFg} lineHeight="1">
                {fmtUSD(data.dollars)}
              </Text>
              <Text fontSize="sm" fontWeight="semibold" color={tier.fg}>
                earned
              </Text>
              <Text fontSize="xs" color={tier.fg} opacity={0.75}>
                · {fmtHours(data.hours)} across {data.jobs} job{data.jobs === 1 ? "" : "s"}
              </Text>
            </HStack>
          </>
        ) : (
          <VStack align="start" gap={1} py={2}>
            <Text fontSize="sm" color={tier.fg}>
              Not enough hours logged yet to calculate your rate.
            </Text>
            <Text fontSize="xs" color={tier.fg} opacity={0.7}>
              Start clocking workdays and your average $/hr will show up here.
            </Text>
          </VStack>
        )}

        <Box mt={3} borderTopWidth="1px" borderColor={tier.border} pt={2}>
          <Button
            size="xs"
            variant="ghost"
            width="100%"
            justifyContent="space-between"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            css={{ color: `var(--chakra-colors-${tier.fg.replace(".", "-")})` }}
          >
            <Text fontSize="xs" fontWeight="medium">
              How was this approximate value calculated?
            </Text>
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </Button>

          {expanded && (
            <Box mt={2}>
              {details ? (
                <BreakdownPanel
                  data={data}
                  details={details}
                  period={period}
                  fg={tier.fg}
                  isAdminContext={!!viewAsUserId}
                />
              ) : detailsError ? (
                <Text fontSize="xs" color={tier.fg} opacity={0.7} py={2}>
                  Couldn't load the breakdown. Tap the refresh button and try again.
                </Text>
              ) : (
                <HStack gap={2} py={2}>
                  <Spinner size="sm" />
                  <Text fontSize="xs" color={tier.fg}>Loading breakdown…</Text>
                </HStack>
              )}
            </Box>
          )}
        </Box>

        {/* Weekly earnings trend — embedded inside this same Card so
            the "pay per hour" number and the "week over week" trend
            read as one section, both driven by the period selector
            above. Filtered to the same window the pay data used. */}
        {(weeklyCompleted?.length ?? 0) > 0 && (() => {
          // Window: rolling days for a days-based period, or fall
          // back to the last 60 days for calendar-anchored presets
          // (today/yesterday) — a week-scale trend needs at least a
          // month or two of context to read as a trend.
          const windowDays = effectivePeriod.days ?? 60;
          const cutoff = bizAddDays(bizToday(), -Math.max(7, windowDays));
          const filtered = (weeklyCompleted ?? []).filter((w) => w.weekStart >= cutoff);
          if (filtered.length === 0) return null;
          const totalEarnings = filtered.reduce((sum, w) => sum + (w.earnings ?? 0), 0);
          const fmtWeek = (s: string) => {
            const [, m, d] = s.split("-");
            return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
          };
          return (
            <Box mt={4} pt={3} borderTopWidth="1px" borderColor="gray.200">
              <HStack justify="space-between" mb={2} wrap="wrap" gap={2}>
                <Text fontSize="xs" fontWeight="semibold" color="fg.default" textTransform="uppercase" letterSpacing="wide">
                  Earnings (jobs)
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  {buttonPeriodLabel(effectivePeriod.label)} · {fmtUSDPrecise(totalEarnings)}
                </Text>
              </HStack>
              <Box h="160px">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={filtered} margin={{ top: 28, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="weekStart" tickFormatter={fmtWeek} fontSize={10} interval="preserveStartEnd" />
                    <YAxis fontSize={10} width={56} tickFormatter={(v: number) => v >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `$${v}`} />
                    <Tooltip
                      content={({ active, payload }: any) => {
                        if (!active || !payload || !payload.length) return null;
                        const d = payload[0].payload as { weekStart: string; count: number; earnings: number };
                        return (
                          <Box bg="white" p={2} borderWidth="1px" borderColor="gray.200" rounded="md" fontSize="xs" shadow="sm">
                            <Text fontWeight="semibold" mb={0.5}>Week of {fmtWeek(d.weekStart)}</Text>
                            <Text color="fg.muted">Jobs: <Text as="span" color="fg.default" fontWeight="medium">{d.count}</Text></Text>
                            <Text color="fg.muted">Earnings: <Text as="span" color="green.700" fontWeight="medium">${d.earnings.toFixed(2)}</Text></Text>
                          </Box>
                        );
                      }}
                    />
                    <Line type="monotone" dataKey="earnings" stroke="var(--chakra-colors-green-600)" strokeWidth={2} dot={{ r: 3, fill: "var(--chakra-colors-green-600)" }}>
                      <LabelList dataKey="count" position="top" offset={14} fontSize={10} fill="var(--chakra-colors-fg-default)" formatter={(v: any) => (v && v > 0 ? String(v) : "")} />
                    </Line>
                  </ComposedChart>
                </ResponsiveContainer>
              </Box>
            </Box>
          );
        })()}
      </Box>
    </Dashboard>
  );
}

// Deep-link into the Jobs tab and highlight a specific occurrence.
// Mirrors the pattern used elsewhere in pages/index.tsx (Services →
// Jobs, Reminders → Jobs): dispatch a tab switch, then poll for the
// tab to signal ready via window.__jobsTabReady before firing the
// highlight event. Caps attempts so a never-mounted tab doesn't hang.
//
// anchorAt is critical for worker deep-links: without it, applyHighlight
// falls back to a ±1yr window which clampWorkerDates then trims to the
// most-recent 62 days, missing anything older. Passing the occurrence's
// completedAt makes applyHighlight pin the range to that exact ET day
// so the load always includes it.
function jumpToOccurrence(
  occId: string,
  adminContext: boolean,
  anchorAt: string | null,
) {
  const outer = adminContext ? "admin" : "worker";
  window.dispatchEvent(
    new CustomEvent("seedlings:switchTab", { detail: { outer, inner: "jobs" } }),
  );
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    if ((window as any).__jobsTabReady || attempts >= 30) {
      clearInterval(interval);
      window.dispatchEvent(
        new CustomEvent("jobsTab:highlightOcc", { detail: { occId, anchorAt } }),
      );
    }
  }, 100);
}

function BreakdownPanel({
  data,
  details,
  period,
  fg,
  isAdminContext,
}: {
  data: HourlyPay;
  details: HourlyPayDetails;
  period: Period;
  fg: string;
  isAdminContext: boolean;
}) {
  // Sanity: sum of projected values should equal `data.dollars` within
  // a rounding cent. Same for workday active-ms and `data.hours`.
  const dollarsCheck = useMemo(
    () => details.jobs.reduce((s, j) => s + j.projected, 0),
    [details.jobs],
  );
  const hoursCheck = useMemo(
    () => details.workdays.reduce((s, w) => s + w.activeMs, 0) / 3_600_000,
    [details.workdays],
  );

  const rowBg = "blackAlpha.50";
  const zebra = "blackAlpha.100";

  return (
    <VStack align="stretch" gap={3}>
      <Box>
        <Text fontSize="xs" fontWeight="semibold" color={fg} mb={1}>
          The formula
        </Text>
        <Box
          bg={rowBg}
          borderRadius="md"
          p={2}
          fontFamily="mono"
          fontSize="xs"
          color={fg}
          overflowX="auto"
        >
          <Text>
            For each completed job you worked on (as a non-observer) {period.label}:
          </Text>
          <Text mt={1}>
            &nbsp;&nbsp;projected = (price − expenses) × your_share × (1 − rate%)
          </Text>
          <Text mt={2}>
            Then: $/hr = Σ projected ÷ workday hours
          </Text>
          <Text mt={2}>
            rate% = <b>{details.ratePct}%</b> ({details.rateLabel})
          </Text>
        </Box>
      </Box>

      <Box>
        <HStack justify="space-between" mb={1}>
          <Text fontSize="xs" fontWeight="semibold" color={fg}>
            Jobs ({details.jobs.length})
          </Text>
          <Text fontSize="xs" color={fg} opacity={0.7}>
            Σ projected: {fmtUSDPrecise(dollarsCheck)}
          </Text>
        </HStack>
        {details.jobs.length === 0 ? (
          <Text fontSize="xs" color={fg} opacity={0.7} px={1}>
            No qualifying completed jobs in this window.
          </Text>
        ) : (
          <Box borderRadius="md" overflow="hidden">
            {details.jobs.map((j, idx) => {
              // Build the identity line: date · time · property · client.
              // Time-of-day + client are the practical differentiators when
              // the same property gets serviced multiple times a day, and
              // when different clients happen to share property names.
              const time = fmtCompletedTime(j.completedAt);
              const identityParts = [
                fmtCompletedAt(j.completedAt),
                time || null,
                j.label,
                j.clientName,
              ].filter(Boolean) as string[];
              return (
                <Box
                  key={j.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => jumpToOccurrence(j.id, isAdminContext, j.completedAt)}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      jumpToOccurrence(j.id, isAdminContext, j.completedAt);
                    }
                  }}
                  bg={idx % 2 === 0 ? rowBg : zebra}
                  p={2}
                  fontSize="xs"
                  color={fg}
                  cursor="pointer"
                  transition="background-color 120ms ease"
                  _hover={{ bg: "blackAlpha.200" }}
                  _focus={{ outline: "2px solid", outlineColor: "blue.400", outlineOffset: "-2px" }}
                  title="Open this job in the Jobs tab"
                >
                  <HStack justify="space-between" gap={2} align="baseline">
                    <Text fontWeight="semibold" flex={1} minW={0} truncate>
                      {identityParts.join(" · ")}
                    </Text>
                    <Text fontWeight="bold" flexShrink={0}>
                      {fmtUSDPrecise(j.projected)}
                    </Text>
                  </HStack>
                  {j.tags.length > 0 && (
                    <HStack gap={1} mt={1} wrap="wrap">
                      {j.tags.map((t) => (
                        <Text
                          key={t}
                          fontSize="2xs"
                          fontWeight="bold"
                          px={1}
                          bg="blackAlpha.100"
                          borderRadius="sm"
                          color={fg}
                        >
                          {t}
                        </Text>
                      ))}
                    </HStack>
                  )}
                  <Text fontFamily="mono" mt={1} opacity={0.85}>
                    ({fmtUSDPrecise(j.basePrice)}
                    {j.addonsTotal > 0 ? ` + ${fmtUSDPrecise(j.addonsTotal)} addons` : ""}
                    {j.expensesTotal > 0 ? ` − ${fmtUSDPrecise(j.expensesTotal)} exp` : ""}
                    ) = <b>{fmtUSDPrecise(j.net)}</b> net
                  </Text>
                  <Text fontFamily="mono" opacity={0.85}>
                    × {j.myPercent.toFixed(1)}% share ({shareSourceLabel(j.shareSource)})
                    = {fmtUSDPrecise(j.grossShare)}
                  </Text>
                  <Text fontFamily="mono" opacity={0.85}>
                    − {fmtUSDPrecise(j.feeAmount)} fee
                    = <b>{fmtUSDPrecise(j.projected)}</b>
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      <Box>
        <HStack justify="space-between" mb={1}>
          <Text fontSize="xs" fontWeight="semibold" color={fg}>
            Workdays ({details.workdays.length})
          </Text>
          <Text fontSize="xs" color={fg} opacity={0.7}>
            Σ active: {hoursCheck.toFixed(2)}h
          </Text>
        </HStack>
        {details.workdays.length === 0 ? (
          <Text fontSize="xs" color={fg} opacity={0.7} px={1}>
            No completed workdays in this window.
          </Text>
        ) : (
          <Box borderRadius="md" overflow="hidden">
            {details.workdays.map((w, idx) => (
              <HStack
                key={`${w.startedAt}-${idx}`}
                justify="space-between"
                bg={idx % 2 === 0 ? rowBg : zebra}
                p={2}
                fontSize="xs"
                color={fg}
                fontFamily="mono"
              >
                <Text>{fmtWorkdayStart(w.startedAt)}</Text>
                <Text opacity={0.85}>
                  {w.pausedMs > 0 ? `− ${fmtMsAsHrs(w.pausedMs)} paused → ` : ""}
                  <b>{fmtMsAsHrs(w.activeMs)}</b>
                </Text>
              </HStack>
            ))}
          </Box>
        )}
      </Box>

      <Box bg={rowBg} borderRadius="md" p={2}>
        <Text fontSize="xs" fontFamily="mono" color={fg}>
          <b>{fmtUSDPrecise(data.dollars)}</b> ÷ <b>{data.hours.toFixed(2)}h</b>
          {" "}= <b>${data.ratePerHour.toFixed(2)}/hr</b>
        </Text>
      </Box>
    </VStack>
  );
}
