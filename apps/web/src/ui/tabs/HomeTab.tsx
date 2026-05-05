"use client";

import { useEffect, useState } from "react";
import { Box, Button, Card, HStack, SimpleGrid, Spinner, Text, VStack } from "@chakra-ui/react";
import { FiBell, FiClipboard, FiClock, FiInfo, FiMoon, FiNavigation, FiPlay, FiSun, FiTool } from "react-icons/fi";
import { TfiMoney } from "react-icons/tfi";
import { apiGet } from "@/src/lib/api";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import type { Me } from "@/src/lib/types";

type Props = {
  me: Me | null | undefined;
  onLaunchWorkflow: (name: string) => void;
};

type Summary = {
  overdue: number;
  today: number;
  tomorrow: number;
  pendingPayment: number;
  estimatesReady: number;
  followUps: number;
  activeWork: number;
  todayPotentialAmount: number;
  equipmentCheckedOut: number;
  equipmentReserved: number;
  remindersPending: number;
  notices: number;
  minutesThisWeek: number;
};

type Earnings = { thisWeek: number };

function dispatchNav(tab: string, filter?: { status?: string; type?: string; datePreset?: string; dateFrom?: string; dateTo?: string; overdue?: boolean }) {
  // JobsTab's filter listener treats every event as "clear, then apply" — so each tile
  // only needs to send the fields it cares about; everything else is reset to defaults.
  window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab, ...(filter ? { filter } : {}) } }));
}

function bizDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  color = "blue.500",
  bg = "blue.50",
  dimmed = false,
  onClick,
}: {
  icon: any;
  label: string;
  value?: string | number | null;
  hint?: string;
  color?: string;
  bg?: string;
  dimmed?: boolean;
  onClick: () => void;
}) {
  return (
    <Card.Root
      variant="outline"
      cursor="pointer"
      onClick={onClick}
      _hover={{ shadow: "md", borderColor: color }}
      transition="all 0.15s"
      opacity={dimmed ? 0.65 : 1}
    >
      <Card.Body p={4}>
        <HStack gap={3} align="start">
          <Box bg={bg} color={color} p={2} borderRadius="lg" flexShrink={0}>
            <Icon size={22} />
          </Box>
          <VStack align="start" gap={0} flex={1} minW={0}>
            <Text fontSize="sm" fontWeight="semibold" color="fg.default">
              {label}
            </Text>
            {value != null && value !== "" && (
              <Text fontSize="lg" fontWeight="bold" color={color}>
                {value}
              </Text>
            )}
            {hint && (
              <Text fontSize="xs" color="fg.muted" truncate w="full">
                {hint}
              </Text>
            )}
          </VStack>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}

export default function HomeTab({ me, onLaunchWorkflow }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [weekEarnings, setWeekEarnings] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [s, e] = await Promise.all([
        apiGet<Summary>("/api/dashboard-summary"),
        apiGet<Earnings>("/api/payments/earnings-summary").catch(() => ({ thisWeek: 0 } as Earnings)),
      ]);
      setSummary(s);
      setWeekEarnings(e?.thisWeek ?? 0);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load dashboard.", err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("visibilitychange", onVisible);
    return () => window.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Hour in Eastern Time (the business timezone) — drives the hero CTA framing.
  const etHour = (() => {
    try {
      return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()), 10);
    } catch { return new Date().getHours(); }
  })();
  const isEvening = etHour >= 15;       // 3pm+: pivot toward "plan tomorrow"
  const isLateEvening = etHour >= 21;   // 9pm+: calm mode, no aggressive CTA

  const greeting = etHour < 12 ? "Good morning"
    : etHour < 17 ? "Good afternoon"
    : "Good evening";
  const firstName = me?.displayName?.split(" ")[0] || me?.email?.split("@")[0] || "";

  if (loading && !summary) {
    return (
      <Box py={10} textAlign="center">
        <Spinner size="lg" />
      </Box>
    );
  }

  const s = summary;
  if (!s) return null;

  const hasJobsToday = s.today > 0;
  const hasActive = s.activeWork > 0;

  // Hero CTA derived from time of day:
  // - Active work in progress → always "Resume" (regardless of time)
  // - Late evening (9pm+) and nothing left → calm "Wrap up", no aggressive CTA
  // - Evening (3pm+) → prioritize "Plan tomorrow" when tomorrow has jobs
  // - Otherwise → "Begin work day" / "Finish remaining" / "Plan tomorrow" / "Wrap"
  type HeroMode = "resume" | "begin" | "finish" | "planTomorrow" | "wrap";
  const heroMode: HeroMode = (() => {
    if (hasActive) return "resume";
    if (isLateEvening) return hasJobsToday ? "finish" : (s.tomorrow > 0 ? "planTomorrow" : "wrap");
    if (isEvening) return s.tomorrow > 0 ? "planTomorrow" : (hasJobsToday ? "finish" : "wrap");
    // Morning / midday
    return hasJobsToday ? "begin" : (s.tomorrow > 0 ? "planTomorrow" : "wrap");
  })();

  return (
    <Box w="full">
      <VStack align="stretch" gap={4}>
        <Box>
          <Text fontSize="lg" fontWeight="bold" color="fg.default">
            {greeting}{firstName ? `, ${firstName}` : ""}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {hasActive
              ? "You have work in progress."
              : isLateEvening && s.today === 0
                ? "Wrapped up for the day."
                : s.today > 0
                  ? `You have ${s.today} job${s.today === 1 ? "" : "s"} scheduled today.`
                  : s.tomorrow > 0
                    ? `Nothing scheduled today — ${s.tomorrow} tomorrow.`
                    : "You're caught up. Nothing on your plate."}
          </Text>
        </Box>

        {/* Hero CTA: Resume active work (any time) */}
        {heroMode === "resume" && (
          <Card.Root
            variant="elevated"
            cursor="pointer"
            onClick={() => dispatchNav("jobs", { status: "IN_PROGRESS", datePreset: "lastMonth" })}
            _hover={{ shadow: "lg" }}
            bg="orange.500"
            color="white"
          >
            <Card.Body p={5}>
              <HStack gap={4}>
                <Box bg="white" color="orange.600" p={3} borderRadius="full">
                  <FiPlay size={28} />
                </Box>
                <VStack align="start" gap={0} flex={1}>
                  <Text fontSize="lg" fontWeight="bold">Resume active work</Text>
                  <Text fontSize="sm" opacity={0.9}>
                    {s.activeWork} job{s.activeWork === 1 ? "" : "s"} in progress or paused
                  </Text>
                </VStack>
                <Text fontSize="2xl">→</Text>
              </HStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Hero CTA: Begin / Finish — same workflow, different framing by time-of-day */}
        {(heroMode === "begin" || heroMode === "finish") && (
          <Card.Root
            variant="outline"
            cursor="pointer"
            onClick={() => onLaunchWorkflow("begin-workday")}
            _hover={{ shadow: "md", borderColor: "green.400" }}
            bg="green.50"
            borderColor="green.300"
          >
            <Card.Body p={5}>
              <HStack gap={4}>
                <Box bg="green.500" color="white" p={3} borderRadius="full">
                  <FiSun size={28} />
                </Box>
                <VStack align="start" gap={0} flex={1}>
                  <Text fontSize="lg" fontWeight="bold" color="green.800">
                    {heroMode === "begin" ? "Begin work day" : "Finish remaining jobs"}
                  </Text>
                  <Text fontSize="sm" color="green.700">
                    {s.today} job{s.today === 1 ? "" : "s"} today
                    {s.todayPotentialAmount > 0 ? ` · ${fmtMoney(s.todayPotentialAmount)} potential` : ""}
                  </Text>
                </VStack>
                <Text fontSize="2xl" color="green.600">→</Text>
              </HStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Hero CTA: Plan tomorrow — evening pivot, no work left today */}
        {heroMode === "planTomorrow" && (
          <Card.Root
            variant="outline"
            cursor="pointer"
            onClick={() => onLaunchWorkflow("plan-workday")}
            _hover={{ shadow: "md", borderColor: "blue.400" }}
            bg="blue.50"
            borderColor="blue.300"
          >
            <Card.Body p={5}>
              <HStack gap={4}>
                <Box bg="blue.500" color="white" p={3} borderRadius="full">
                  <FiMoon size={28} />
                </Box>
                <VStack align="start" gap={0} flex={1}>
                  <Text fontSize="lg" fontWeight="bold" color="blue.800">Plan tomorrow</Text>
                  <Text fontSize="sm" color="blue.700">
                    {s.tomorrow} job{s.tomorrow === 1 ? "" : "s"} scheduled · confirm and notify clients
                  </Text>
                </VStack>
                <Text fontSize="2xl" color="blue.600">→</Text>
              </HStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Hero: Wrap up — quiet end-of-day state */}
        {heroMode === "wrap" && (
          <Card.Root variant="outline" bg="gray.50" borderColor="gray.200">
            <Card.Body p={5}>
              <HStack gap={4}>
                <Box bg="gray.200" color="gray.700" p={3} borderRadius="full">
                  <FiMoon size={28} />
                </Box>
                <VStack align="start" gap={0} flex={1}>
                  <Text fontSize="lg" fontWeight="bold" color="gray.800">All done</Text>
                  <Text fontSize="sm" color="gray.700">
                    {!hasJobsToday ? "Nothing on your plate." : `${s.today} unfinished job${s.today === 1 ? "" : "s"}.`}
                  </Text>
                </VStack>
              </HStack>
            </Card.Body>
          </Card.Root>
        )}

        <SimpleGrid columns={{ base: 1, sm: 2 }} gap={3}>
          {/* Today's jobs — always shown, dimmed if 0 */}
          <Tile
            icon={FiClipboard}
            label="Today's jobs"
            value={s.today}
            hint={s.todayPotentialAmount > 0 ? `${fmtMoney(s.todayPotentialAmount)} potential` : undefined}
            color="blue.600"
            bg="blue.50"
            dimmed={s.today === 0}
            onClick={() => dispatchNav("jobs", { datePreset: "today" })}
          />

          {/* Tomorrow's jobs — always shown, dimmed if 0 */}
          <Tile
            icon={FiNavigation}
            label="Tomorrow's plan"
            value={s.tomorrow}
            hint={s.tomorrow > 0 ? "Confirm and notify clients" : undefined}
            color="purple.600"
            bg="purple.50"
            dimmed={s.tomorrow === 0}
            onClick={() => dispatchNav("reminders")}
          />

          {/* Equipment — directional based on time of day:
              morning/midday → reserved you need to check out;
              evening/night → checked out you need to return;
              otherwise → generic "no actions" tile that links to the Equipment tab. */}
          {(() => {
            if (!isEvening && s.equipmentReserved > 0) {
              return (
                <Tile
                  icon={FiTool}
                  label="Reserved equipment"
                  value={s.equipmentReserved}
                  hint="Check out before heading out"
                  color="teal.600"
                  bg="teal.50"
                  onClick={() => dispatchNav("equipment", { status: "MY_RESERVED" })}
                />
              );
            }
            if (isEvening && s.equipmentCheckedOut > 0) {
              return (
                <Tile
                  icon={FiTool}
                  label="Equipment to return"
                  value={s.equipmentCheckedOut}
                  hint="Check back in"
                  color="teal.600"
                  bg="teal.50"
                  onClick={() => dispatchNav("equipment", { status: "MY_CHECKED_OUT" })}
                />
              );
            }
            return (
              <Tile
                icon={FiTool}
                label="Equipment"
                hint="No actions to take at the moment"
                color="teal.600"
                bg="teal.50"
                dimmed
                onClick={() => dispatchNav("equipment")}
              />
            );
          })()}

          {/* Pending payments — only when present (last 30 days; matches dashboard count window) */}
          {s.pendingPayment > 0 && (
            <Tile
              icon={TfiMoney}
              label="Awaiting payment"
              value={s.pendingPayment}
              hint="Last month · tap to view"
              color="orange.600"
              bg="orange.50"
              onClick={() => dispatchNav("jobs", { status: "PENDING_PAYMENT", datePreset: "lastMonth" })}
            />
          )}

          {/* Notices — announcements, follow-ups, events (recent + upcoming) */}
          {s.notices > 0 && (
            <Tile
              icon={FiInfo}
              label="Notices"
              value={s.notices}
              hint="Announcements, follow-ups & events"
              color="purple.700"
              bg="purple.50"
              onClick={() => dispatchNav("jobs", { type: "NOTICES", datePreset: "recent" })}
            />
          )}

          {/* Reminders due — only when due */}
          {s.followUps > 0 && (
            <Tile
              icon={FiBell}
              label="Reminders due"
              value={s.followUps}
              hint={s.remindersPending > s.followUps ? `${s.remindersPending} total pending` : undefined}
              color="red.600"
              bg="red.50"
              onClick={() => dispatchNav("reminders")}
            />
          )}

          {/* Hours worked this week — pairs with the earnings tile.
              Window: Sunday-of-this-week → today (matches the backend's minutesThisWeek). */}
          <Tile
            icon={FiClock}
            label="Hours this week"
            value={(() => {
              const m = s.minutesThisWeek ?? 0;
              const h = Math.floor(m / 60);
              const mm = Math.round(m % 60);
              return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
            })()}
            hint="Completed real jobs"
            color="teal.700"
            bg="teal.50"
            dimmed={(s.minutesThisWeek ?? 0) === 0}
            onClick={() => {
              const today = new Date();
              const startOfWeek = new Date(today); startOfWeek.setDate(today.getDate() - today.getDay());
              dispatchNav("jobs", { status: "FINISHED", dateFrom: bizDateKey(startOfWeek), dateTo: bizDateKey(today) });
            }}
          />

          {/* This week's earnings — always shown */}
          <Tile
            icon={TfiMoney}
            label="This week's earnings"
            value={weekEarnings != null ? fmtMoney(weekEarnings) : "—"}
            hint="Net of fees and expenses"
            color="green.700"
            bg="green.50"
            onClick={() => dispatchNav("payments")}
          />
        </SimpleGrid>

        {/* 1-month window note */}
        <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
          <Text fontSize="xs" color="yellow.800">
            Counts on this page are limited to the last month. Older items still exist — open the Jobs tab and widen the date filter to find them.
          </Text>
        </Box>

        {/* Manual reload */}
        <HStack justify="center" pt={2}>
          <Button size="sm" variant="ghost" onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
}
