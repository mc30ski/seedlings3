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
import { useCallback, useEffect, useState } from "react";
import { Box, Button, Card, HStack, IconButton, Spinner, Text, VStack } from "@chakra-ui/react";
import {
  Award,
  Crown,
  DollarSign,
  RefreshCw,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { apiGet } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";

type HourlyPay = {
  dollars: number;
  hours: number;
  jobs: number;
  ratePerHour: number;
  days: number;
  isOwnerProjection?: boolean;
};

type Props = {
  // Optional: when Admin Home views a specific worker via the "View
  // as" picker, pass that worker's id so the card shows their data
  // instead of the caller's. Admin-only on the server side.
  viewAsUserId?: string | null;
  // Optional: display name of the impersonated worker for the header
  // copy ("Approximate pay per hour for {name}").
  viewAsDisplayName?: string | null;
};

// Workers see the short list — the intent is "how am I doing lately",
// not year-over-year trend analysis. Admins viewing a specific worker
// via the "View as" picker get the extended list so they can spot
// longer-arc performance context that the worker themselves doesn't.
const WORKER_PERIODS: Array<{ days: number; label: string }> = [
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 21, label: "3 weeks" },
  { days: 30, label: "1 month" },
];
const ADMIN_EXTRA_PERIODS: Array<{ days: number; label: string }> = [
  { days: 60, label: "2 months" },
  { days: 90, label: "3 months" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
];
const ADMIN_PERIODS = [...WORKER_PERIODS, ...ADMIN_EXTRA_PERIODS];
const DEFAULT_DAYS = 30;

type Tier = {
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
const TIERS: Tier[] = [
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

function tierFor(rate: number): Tier {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (rate >= TIERS[i].min) return TIERS[i];
  }
  return TIERS[0];
}

function fmtHours(n: number): string {
  if (n >= 1000) return `${Math.round(n).toLocaleString()}h`;
  return `${n.toFixed(1)}h`;
}

function fmtUSD(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export default function WorkerHourlyPayCard({ viewAsUserId, viewAsDisplayName }: Props = {}) {
  const [days, setDays] = usePersistedState<number>("home_hourlyPayDays", DEFAULT_DAYS);
  const [data, setData] = useState<HourlyPay | null>(null);
  const [loading, setLoading] = useState(false);

  // Admin-viewing-a-worker gets the extended list; regular worker
  // Home is capped at 1 month.
  const isAdminView = !!viewAsUserId;
  const periods = isAdminView ? ADMIN_PERIODS : WORKER_PERIODS;

  // Clamp stale persisted values that fall outside the current allowed
  // list — e.g. a worker previously saw 365 and later got locked to
  // the short list. Snap to DEFAULT_DAYS in that case.
  const currentPeriod = periods.find((p) => p.days === days);
  const effectiveDays = currentPeriod ? days : DEFAULT_DAYS;
  useEffect(() => {
    if (!currentPeriod) setDays(DEFAULT_DAYS);
  }, [currentPeriod, setDays]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ days: String(effectiveDays) });
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
  }, [effectiveDays, viewAsUserId]);

  useEffect(() => { void load(); }, [load]);

  const period =
    periods.find((p) => p.days === effectiveDays) ??
    periods.find((p) => p.days === DEFAULT_DAYS) ??
    periods[0];

  // Cycle-forward on click of the label chip — dead simple UI, no
  // dropdown mechanics. Long-press or the refresh icon handle the
  // rare "wait, I meant to go back" case (they can just click again).
  function cyclePeriod() {
    const idx = periods.findIndex((p) => p.days === effectiveDays);
    const next = periods[(idx + 1) % periods.length];
    setDays(next.days);
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
  const tier = tierFor(rate);
  const Icon = tier.icon;
  const hasHours = data.hours > 0;
  const cycleTitle = `Showing last ${period.label} — click to change period`;

  return (
    <Card.Root
      variant="outline"
      bg={tier.bg}
      borderColor={tier.border}
      borderWidth={tier.animation ? "2px" : "1px"}
      style={tier.animation ? { animation: tier.animation } : undefined}
    >
      <Card.Body p={4}>
        <HStack justify="space-between" mb={2} align="start">
          <Text fontSize="xs" fontWeight="semibold" color={tier.fg} textTransform="uppercase" letterSpacing="wide">
            Approximate pay per hour
            {viewAsUserId && viewAsDisplayName && (
              <> · {viewAsDisplayName}</>
            )}
          </Text>
          <HStack gap={1}>
            <Button
              size="xs"
              variant="ghost"
              px="2"
              onClick={cyclePeriod}
              title={cycleTitle}
              css={{
                color: `var(--chakra-colors-${tier.fg.replace(".", "-")})`,
                "&:hover": { background: "blackAlpha.100" },
              }}
            >
              last {period.label}
            </Button>
            <IconButton
              aria-label="Refresh"
              size="xs"
              variant="ghost"
              onClick={() => void load()}
              loading={loading}
              css={{
                color: `var(--chakra-colors-${tier.fg.replace(".", "-")})`,
              }}
            >
              <RefreshCw size={12} />
            </IconButton>
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
            <Text fontSize="xs" color={tier.fg} opacity={0.85}>
              {fmtHours(data.hours)} across {data.jobs} job{data.jobs === 1 ? "" : "s"} · {fmtUSD(data.dollars)} earned
            </Text>
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
      </Card.Body>
    </Card.Root>
  );
}
