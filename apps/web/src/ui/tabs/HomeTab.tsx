"use client";

import { useEffect, useState } from "react";
import { Box, Button, Card, HStack, SimpleGrid, Spinner, Text, VStack } from "@chakra-ui/react";
import { FiBell, FiClipboard, FiClock, FiInfo, FiMoon, FiNavigation, FiPlay, FiSun, FiTool } from "react-icons/fi";
import { TfiMoney } from "react-icons/tfi";
import { ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList } from "recharts";
import { computeDatesFromPreset, type DatePreset } from "@/src/lib/datePresets";
import { apiGet } from "@/src/lib/api";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import TomorrowWeatherWarning from "@/src/ui/components/TomorrowWeatherWarning";
import type { Me } from "@/src/lib/types";

type Props = {
  me: Me | null | undefined;
  onLaunchWorkflow: (name: string) => void;
  // Admin-only: when set, the dashboard is computed for this worker instead of the
  // logged-in user. Hero CTAs are non-actionable in this mode (no startWorkday etc.)
  // since the actions belong to the viewed worker, not the admin.
  viewAsUserId?: string;
};

type Summary = {
  overdue: number;
  today: number;
  tomorrow: number;
  pendingPayment: number;
  estimatesReady: number;
  followUps: number;
  activeWork: number;
  todayRemaining: number;
  todayPotentialAmount: number;
  todayEarnedAmount: number;
  tomorrowUnclaimedCount: number;
  tomorrowUnclaimedPotential: number;
  tomorrowUnconfirmedClientCount: number;
  equipmentCheckedOut: number;
  equipmentReserved: number;
  remindersPending: number;
  notices: number;
  noticesAnnouncements: number;
  noticesFollowups: number;
  noticesEvents: number;
  tasksDue: number;
  minutesThisWeek: number;
  actualWeekEarnings: number;
  weekJobCount: number;
  weeklyCompleted: { weekStart: string; count: number; earnings: number }[];
};

type TabFilter = { status?: string; type?: string; kind?: string; datePreset?: string; dateFrom?: string; dateTo?: string; overdue?: boolean; method?: string };

const PFX = "seedlings_";
const setLS = (key: string, val: unknown) => {
  try { localStorage.setItem(PFX + key, JSON.stringify(val)); } catch {}
};

/** Pre-write filter values to a tab's localStorage so the tab opens with the right state on remount.
 *  Resets every relevant key (so prior values can't leak across taps) and dispatches a `remount` flag
 *  with the navigation event. The destination tab is force-remounted, reading its fresh state on first render. */
function navigateWithFilter(tab: "jobs" | "equipment" | "payments", filter: TabFilter) {
  // Always clear stale session keys that could trigger highlight/jump-to-occurrence behavior.
  try {
    sessionStorage.removeItem("open:remindersToJobsTabSearchOnce");
    sessionStorage.removeItem("servicesTabToJobsNav");
  } catch {}

  if (tab === "jobs") {
    // Worker JobsTab uses prefix "wjobs". Reset everything filterable.
    const pfx = "wjobs";
    setLS(`${pfx}_status`, [filter.status ?? "ALL"]);
    setLS(`${pfx}_type`, [filter.type ?? "ALL"]);
    setLS(`${pfx}_kind`, [filter.kind ?? "ALL"]);
    if (filter.dateFrom !== undefined || filter.dateTo !== undefined) {
      // Explicit dates — clear preset
      setLS(`${pfx}_datePreset`, null);
      setLS(`${pfx}_dateFrom`, filter.dateFrom ?? "");
      setLS(`${pfx}_dateTo`, filter.dateTo ?? "");
    } else {
      const dp = (filter.datePreset ?? "now") as DatePreset;
      setLS(`${pfx}_datePreset`, dp);
      const dates = computeDatesFromPreset(dp);
      setLS(`${pfx}_dateFrom`, dates.from);
      setLS(`${pfx}_dateTo`, dates.to);
    }
  } else if (tab === "payments") {
    setLS(`pay_w_datePreset`, filter.datePreset ?? null);
    setLS(`pay_w_dateFrom`, filter.dateFrom ?? "");
    setLS(`pay_w_dateTo`, filter.dateTo ?? "");
    setLS(`pay_w_type`, [filter.method ?? "ALL"]);
  } else if (tab === "equipment") {
    setLS(`equip_w_status`, [filter.status ?? "CLAIMED"]);
    setLS(`equip_w_kind`, [filter.kind ?? "ALL"]);
    setLS(`equip_w_likedOnly`, false);
  }

  window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab, remount: true } }));
}

/** Plain navigation (no filter), used when the destination tab manages its own state. */
function dispatchNavPlain(tab: string) {
  window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab } }));
}

function bizDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

function sevenDaysAgoKey(): string {
  // Today minus 6 days (so the range is 7 days inclusive of today), in Eastern Time.
  const todayKey = bizDateKey(new Date());
  const [y, m, d] = todayKey.split("-").map(Number);
  const todayUtcNoon = new Date(Date.UTC(y, m - 1, d, 12));
  todayUtcNoon.setUTCDate(todayUtcNoon.getUTCDate() - 6);
  return todayUtcNoon.toISOString().slice(0, 10);
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
  disabled = false,
  badge,
  onClick,
}: {
  icon: any;
  label: string;
  value?: string | number | null;
  hint?: string;
  color?: string;
  bg?: string;
  dimmed?: boolean;
  disabled?: boolean;
  badge?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Card.Root
      variant="outline"
      cursor={disabled ? "default" : "pointer"}
      onClick={disabled ? undefined : onClick}
      borderColor="gray.300"
      _hover={disabled ? undefined : { shadow: "md", borderColor: color }}
      transition="all 0.15s"
      opacity={dimmed ? 0.65 : 1}
    >
      <Card.Body p={4}>
        <HStack gap={3} align="center">
          <Box bg={bg} color={color} p={2} borderRadius="lg" flexShrink={0}>
            <Icon size={22} />
          </Box>
          <VStack align="start" gap={0} flex={1} minW={0}>
            <Text fontSize="sm" fontWeight="semibold" color="fg.default" w="full" truncate>
              {label}
            </Text>
            {hint && (
              <Text fontSize="xs" color="fg.muted" truncate w="full">
                {hint}
              </Text>
            )}
            {badge && <Box mt={1}>{badge}</Box>}
          </VStack>
          {value != null && value !== "" && (
            <Text fontSize="lg" fontWeight="bold" color={color} flexShrink={0}>
              {value}
            </Text>
          )}
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}

export default function HomeTab({ me, onLaunchWorkflow, viewAsUserId }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const isViewingOther = !!viewAsUserId;

  async function load() {
    setLoading(true);
    try {
      const url = viewAsUserId
        ? `/api/dashboard-summary?viewAsUserId=${encodeURIComponent(viewAsUserId)}`
        : "/api/dashboard-summary";
      const s = await apiGet<Summary>(url);
      setSummary(s);
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
  }, [viewAsUserId]);

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

  const hasJobsToday = (s.todayRemaining ?? 0) > 0;
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

  const greetingSubtitle = hasActive
    ? "You have work in progress."
    : isLateEvening && s.todayRemaining === 0
      ? "Wrapped up for the day."
      : s.todayRemaining > 0
        ? `You have ${s.todayRemaining} job${s.todayRemaining === 1 ? "" : "s"} left today.`
        : s.tomorrow > 0
          ? `Nothing left today — ${s.tomorrow} tomorrow.`
          : "You're caught up. Nothing on your plate.";

  return (
    <Box w="full" position="relative">
      {loading && summary && (
        <>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>
      )}
      <VStack align="stretch" gap={4}>

        {/* Hero CTA: Resume active work (any time) */}
        {heroMode === "resume" && (
          <Card.Root
            variant="elevated"
            cursor={isViewingOther ? "default" : "pointer"}
            onClick={isViewingOther ? undefined : () => navigateWithFilter("jobs", { status: "IN_PROGRESS", datePreset: "lastMonth" })}
            _hover={isViewingOther ? undefined : { shadow: "lg" }}
            bg="orange.500"
            color="white"
          >
            <Card.Body p={5}>
              <VStack align="stretch" gap={3}>
                <HStack gap={3} align="center">
                  <Box bg="white" color="orange.600" p={3} borderRadius="full" flexShrink={0}>
                    <FiPlay size={28} />
                  </Box>
                  <Box flex={1} minW={0}>
                    <Text fontSize="lg" fontWeight="bold">{greeting}{firstName ? `, ${firstName}` : ""}</Text>
                    <Text fontSize="sm" opacity={0.9}>{greetingSubtitle}</Text>
                  </Box>
                </HStack>
                <HStack gap={3}>
                  <VStack align="start" gap={0} flex={1} minW={0}>
                    <Text fontSize="md" fontWeight="bold">Resume active work</Text>
                    <Text fontSize="sm" opacity={0.9}>
                      {s.activeWork} job{s.activeWork === 1 ? "" : "s"} in progress or paused
                    </Text>
                  </VStack>
                  {!isViewingOther && <Text fontSize="2xl">→</Text>}
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Hero CTA: Begin / Finish — same workflow, different framing by time-of-day */}
        {(heroMode === "begin" || heroMode === "finish") && (
          <Card.Root
            variant="outline"
            cursor={isViewingOther ? "default" : "pointer"}
            onClick={isViewingOther ? undefined : () => onLaunchWorkflow("begin-workday")}
            _hover={isViewingOther ? undefined : { shadow: "md", borderColor: "green.400" }}
            bg="green.50"
            borderColor="green.300"
          >
            <Card.Body p={5}>
              <VStack align="stretch" gap={3}>
                <HStack gap={3} align="center">
                  <Box bg="green.500" color="white" p={3} borderRadius="full" flexShrink={0}>
                    <FiSun size={28} />
                  </Box>
                  <Box flex={1} minW={0}>
                    <Text fontSize="lg" fontWeight="bold" color="green.800">{greeting}{firstName ? `, ${firstName}` : ""}</Text>
                    <Text fontSize="sm" color="green.700">{greetingSubtitle}</Text>
                  </Box>
                </HStack>
                <HStack gap={3}>
                  <VStack align="start" gap={0} flex={1} minW={0}>
                    <Text fontSize="md" fontWeight="bold" color="green.800">
                      {heroMode === "begin" ? "Begin work day" : "Finish remaining jobs"}
                    </Text>
                    <Text fontSize="sm" color="green.700">
                      {s.todayRemaining} job{s.todayRemaining === 1 ? "" : "s"} left today
                      {(s.todayEarnedAmount ?? 0) + (s.todayPotentialAmount ?? 0) > 0
                        ? ` · ${fmtMoney(s.todayEarnedAmount ?? 0)} earned with ${fmtMoney(s.todayPotentialAmount ?? 0)} remaining potential`
                        : ""}
                    </Text>
                  </VStack>
                  {!isViewingOther && <Text fontSize="2xl" color="green.600">→</Text>}
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Hero CTA: Plan tomorrow — evening pivot, no work left today */}
        {heroMode === "planTomorrow" && (
          <Card.Root
            variant="outline"
            cursor={isViewingOther ? "default" : "pointer"}
            onClick={isViewingOther ? undefined : () => onLaunchWorkflow("plan-workday")}
            _hover={isViewingOther ? undefined : { shadow: "md", borderColor: "blue.400" }}
            bg="blue.50"
            borderColor="blue.300"
          >
            <Card.Body p={5}>
              <VStack align="stretch" gap={3}>
                <HStack gap={3} align="center">
                  <Box bg="blue.500" color="white" p={3} borderRadius="full" flexShrink={0}>
                    <FiMoon size={28} />
                  </Box>
                  <Box flex={1} minW={0}>
                    <Text fontSize="lg" fontWeight="bold" color="blue.800">{greeting}{firstName ? `, ${firstName}` : ""}</Text>
                    <Text fontSize="sm" color="blue.700">{greetingSubtitle}</Text>
                  </Box>
                </HStack>
                <HStack gap={3}>
                  <VStack align="start" gap={0} flex={1} minW={0}>
                    <Text fontSize="md" fontWeight="bold" color="blue.800">Plan tomorrow</Text>
                    <Text fontSize="sm" color="blue.700">
                      {s.tomorrow} job{s.tomorrow === 1 ? "" : "s"} scheduled
                      {(s.tomorrowUnconfirmedClientCount ?? 0) > 0
                        ? ` · confirm ${s.tomorrowUnconfirmedClientCount} client${s.tomorrowUnconfirmedClientCount === 1 ? "" : "s"}`
                        : " · all clients confirmed"}
                    </Text>
                    {(s.tomorrowUnclaimedCount ?? 0) > 0 && (
                      <Text
                        fontSize="sm"
                        color="blue.700"
                        mt={1}
                        textDecoration={isViewingOther ? undefined : "underline"}
                        cursor={isViewingOther ? "default" : "pointer"}
                        onClick={isViewingOther ? undefined : (e: any) => {
                          e.stopPropagation();
                          // Navigate to JobsTab filtered to tomorrow's unclaimed jobs.
                          const today = new Date();
                          const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
                          const tomorrowKey = bizDateKey(tomorrow);
                          navigateWithFilter("jobs", { status: "UNCLAIMED", dateFrom: tomorrowKey, dateTo: tomorrowKey });
                        }}
                      >
                        {s.tomorrowUnclaimedCount} unclaimed{s.tomorrowUnclaimedPotential > 0 ? ` · ${fmtMoney(s.tomorrowUnclaimedPotential)} potential` : ""}{isViewingOther ? "" : " →"}
                      </Text>
                    )}
                  </VStack>
                  {!isViewingOther && <Text fontSize="2xl" color="blue.600">→</Text>}
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Hero: Wrap up — quiet end-of-day state. Combines greeting + status into one card. */}
        {heroMode === "wrap" && (
          <Card.Root variant="outline" bg="gray.50" borderColor="gray.200">
            <Card.Body p={5}>
              <HStack gap={4}>
                <Box bg="gray.200" color="gray.700" p={3} borderRadius="full">
                  <FiMoon size={28} />
                </Box>
                <VStack align="start" gap={0} flex={1}>
                  <Text fontSize="lg" fontWeight="bold" color="gray.800">
                    {greeting}{firstName ? `, ${firstName}` : ""}
                  </Text>
                  <Text fontSize="sm" color="gray.700">{greetingSubtitle}</Text>
                </VStack>
              </HStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Weekly earnings trend over the last 2 months */}
        {(s.weeklyCompleted ?? []).length > 0 && (() => {
          const totalEarnings = s.weeklyCompleted.reduce((sum, w) => sum + (w.earnings ?? 0), 0);
          const fmtWeek = (s: string) => {
            const [, m, d] = s.split("-");
            return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
          };
          return (
            <Box p={3} bg="white" borderWidth="1px" borderColor="gray.200" rounded="md">
              <HStack justify="space-between" mb={2} wrap="wrap" gap={2}>
                <Text fontSize="sm" fontWeight="semibold" color="fg.default">Weekly Earnings (Jobs)</Text>
                <Text fontSize="xs" color="fg.muted">Last 2 months · {fmtMoney(totalEarnings)}</Text>
              </HStack>
              <Box h="160px">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={s.weeklyCompleted} margin={{ top: 18, right: 12, bottom: 0, left: 8 }}>
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

        {/* When viewing another worker's home, suppress tile interactivity — the
            click-throughs would land on the admin's own tabs and not the worker's. */}
        <SimpleGrid columns={{ base: 1, sm: 2 }} gap={3} pointerEvents={isViewingOther ? "none" : "auto"}>
          {/* Today's jobs — always shown, dimmed if 0.
              Hint shows "$X earned with $Y remaining potential" matching the hero. */}
          <Tile
            icon={FiClipboard}
            label="Today's jobs"
            value={s.today}
            hint={(() => {
              const earned = s.todayEarnedAmount ?? 0;
              const remaining = s.todayPotentialAmount ?? 0;
              if (earned + remaining <= 0) return undefined;
              return `${fmtMoney(earned)} earned, ${fmtMoney(remaining)} potential`;
            })()}
            color="blue.600"
            bg="blue.50"
            dimmed={s.today === 0}
            onClick={() => navigateWithFilter("jobs", { datePreset: "today" })}
          />

          {/* Tomorrow's jobs — always shown, dimmed if 0.
              Adds a weather chip under the hint when tomorrow's forecast is inclement
              (rain, thunderstorm, or snow) so workers can plan around it. */}
          <Tile
            icon={FiNavigation}
            label="Tomorrow's plan"
            value={s.tomorrow}
            hint={s.tomorrow > 0 ? "Confirm and notify clients" : undefined}
            color="purple.600"
            bg="purple.50"
            dimmed={s.tomorrow === 0}
            badge={<TomorrowWeatherWarning size="sm" />}
            onClick={() => dispatchNavPlain("reminders")}
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
                  onClick={() => navigateWithFilter("equipment", { status: "MY_RESERVED" })}
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
                  onClick={() => navigateWithFilter("equipment", { status: "MY_CHECKED_OUT" })}
                />
              );
            }
            return (
              <Tile
                icon={FiTool}
                label="Equipment"
                value={0}
                hint="No actions to take at the moment"
                color="teal.600"
                bg="teal.50"
                dimmed
                onClick={() => dispatchNavPlain("equipment")}
              />
            );
          })()}

          {/* Pending payments — last month window */}
          <Tile
            icon={TfiMoney}
            label="Awaiting payment"
            value={s.pendingPayment}
            hint="Last month · tap to view"
            color="orange.600"
            bg="orange.50"
            dimmed={s.pendingPayment === 0}
            onClick={() => navigateWithFilter("jobs", { status: "PENDING_PAYMENT", datePreset: "lastMonth" })}
          />

          {/* Notices — announcements, follow-ups, events scheduled for today */}
          <Tile
            icon={FiInfo}
            label="Notices"
            value={s.notices}
            hint={(() => {
              const a = s.noticesAnnouncements ?? 0;
              const f = s.noticesFollowups ?? 0;
              const e = s.noticesEvents ?? 0;
              const parts: string[] = [];
              if (a > 0) parts.push(`${a} announcement${a === 1 ? "" : "s"}`);
              if (f > 0) parts.push(`${f} follow-up${f === 1 ? "" : "s"}`);
              if (e > 0) parts.push(`${e} event${e === 1 ? "" : "s"}`);
              return parts.length > 0 ? parts.join(" · ") : "Announcements, follow-ups & events";
            })()}
            color="purple.700"
            bg="purple.50"
            dimmed={s.notices === 0}
            onClick={() => navigateWithFilter("jobs", { type: "NOTICES", datePreset: "today" })}
          />

          {/* Reminders due — Reminder-table notifications + TASK-workflow occurrences scheduled today or earlier.
              Click goes to JobsTab filtered to TASK workflow (the actionable subset). */}
          <Tile
            icon={FiBell}
            label="Reminders"
            value={(s.followUps ?? 0) + (s.tasksDue ?? 0)}
            hint={(() => {
              const r = s.followUps ?? 0;
              const t = s.tasksDue ?? 0;
              const parts: string[] = [];
              if (r > 0) parts.push(`${r} reminder${r === 1 ? "" : "s"}`);
              if (t > 0) parts.push(`${t} task${t === 1 ? "" : "s"}`);
              return parts.length > 0 ? parts.join(" · ") : undefined;
            })()}
            color="red.600"
            bg="red.50"
            dimmed={(s.followUps ?? 0) + (s.tasksDue ?? 0) === 0}
            onClick={() => navigateWithFilter("jobs", { type: "DUE", datePreset: "lastMonth" })}
          />

          {/* Hours worked in the last 7 days — pairs with the earnings tile. */}
          <Tile
            icon={FiClock}
            label="Hours (last 7 days)"
            value={(() => {
              const m = s.minutesThisWeek ?? 0;
              const h = Math.floor(m / 60);
              const mm = Math.round(m % 60);
              return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
            })()}
            hint={`Time spent on ${s.weekJobCount ?? 0} job${(s.weekJobCount ?? 0) === 1 ? "" : "s"}`}
            color="teal.700"
            bg="teal.50"
            dimmed={(s.minutesThisWeek ?? 0) === 0}
            onClick={() => navigateWithFilter("jobs", { status: "FINISHED", dateFrom: sevenDaysAgoKey(), dateTo: bizDateKey(new Date()) })}
          />

          {/* Earnings for the last 7 days — payout share for jobs completed in the
              last 7 days. Same set as the Hours tile so the two pair naturally. */}
          <Tile
            icon={TfiMoney}
            label="Earnings (last 7 days)"
            value={fmtMoney(s.actualWeekEarnings ?? 0)}
            hint={`Earned for ${s.weekJobCount ?? 0} job${(s.weekJobCount ?? 0) === 1 ? "" : "s"}`}
            color="green.700"
            bg="green.50"
            dimmed={(s.actualWeekEarnings ?? 0) === 0}
            onClick={() => navigateWithFilter("jobs", { status: "FINISHED", dateFrom: sevenDaysAgoKey(), dateTo: bizDateKey(new Date()) })}
          />
        </SimpleGrid>

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
