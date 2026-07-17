"use client";

import { useEffect, useState } from "react";
import { Box, Button, Card, HStack, SimpleGrid, Spinner, Text, VStack } from "@chakra-ui/react";
import { FiBell, FiClipboard, FiClock, FiInfo, FiMoon, FiNavigation, FiPlay, FiRefreshCw, FiSun, FiTool, FiX } from "react-icons/fi";
import { TfiMoney } from "react-icons/tfi";
import { ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList } from "recharts";
import { computeDatesFromPreset, type DatePreset } from "@/src/lib/datePresets";
import { apiGet } from "@/src/lib/api";
import { bizDateKey, bizToday, bizTomorrow, bizAddDays, bizHour, fmtDateOpts, fmtTimeOpts } from "@/src/lib/lib";
import { usePushNotifications } from "@/src/lib/usePushNotifications";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import TomorrowWeatherWarning from "@/src/ui/components/TomorrowWeatherWarning";
import HomeBanners from "@/src/ui/components/HomeBanners";
import ComplianceBanner from "@/src/ui/components/ComplianceBanner";
import WorkdayStrip from "@/src/ui/components/WorkdayStrip";
import MileageStrip from "@/src/ui/components/MileageStrip";
import TodayHourlyPayPanel from "@/src/ui/components/TodayHourlyPayPanel";
import WorkerHourlyPayCard from "@/src/ui/components/WorkerHourlyPayCard";
import type { Me } from "@/src/lib/types";

type Props = {
  me: Me | null | undefined;
  onLaunchWorkflow: (name: string) => void;
  // Admin-only: when set, the dashboard is computed for this worker instead of the
  // logged-in user. Hero CTAs that launch worker workflows (begin/plan workday) are
  // disabled in this mode since the actions belong to the viewed worker. Tile click-
  // throughs are rerouted to the admin's equivalent tabs, pre-filtered to the worker.
  viewAsUserId?: string;
  // Admin-only: display name + first name for the impersonated worker (drives the
  // greeting copy "Good morning, Bob" instead of using the admin's identity).
  viewAsDisplayName?: string;
  // Admin-only: company-wide aggregate mode. Hits a different endpoint that sums
  // values across the whole team. Hero is replaced with a single team-summary
  // banner; tile click-throughs go to admin tabs WITHOUT a worker filter.
  // Mutually exclusive with viewAsUserId.
  aggregate?: boolean;
  // Admin-only: subset team mode. Same shape as aggregate but restricted to the
  // listed workers — uses the aggregate endpoint with a workerIds filter, and
  // tile click-throughs pre-filter destination tabs to those workers. Mutually
  // exclusive with viewAsUserId and aggregate.
  subsetUserIds?: string[];
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
  // Subset of todayRemaining where the user is an observer (not a working
  // assignee). Surfaced in the greeting as "... (Y as observer)" so the user
  // can tell at a glance how many of their remaining jobs they're just
  // watching rather than working. 0 in aggregate (multi-worker) views.
  todayObserverRemaining: number;
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
  // ET date strings (YYYY-MM-DD) for the earnings window — the 7 days before
  // today, excluding today. Used so the tile's drill-down filters to exactly
  // the range the number was computed from.
  weekEarningsFrom?: string;
  weekEarningsTo?: string;
  weeklyCompleted: { weekStart: string; count: number; earnings: number }[];
  // Aggregate-only: per-row breakdown of currently active work for the
  // Team Overview banner. Empty/undefined in per-worker mode.
  inProgressJobs?: {
    id: string;
    startAt: string | null;
    status: string;
    title: string | null;
    propertyName: string | null;
    clientName: string | null;
    // Time-tracking fields for the "elapsed since started" text. When
    // status === "PAUSED", the UI freezes the elapsed at pausedAt so
    // the number matches what the operator sees on the WorkdayStrip.
    startedAt: string | null;
    pausedAt: string | null;
    totalPausedMs: number;
    assignees: { userId: string; displayName: string; isClaimer: boolean }[];
  }[];
  // Aggregate-only: per-row breakdown of work finished today. Includes any
  // occurrence whose completedAt landed today regardless of post-completion
  // state (COMPLETED, PENDING_PAYMENT, CLOSED).
  completedTodayJobs?: {
    id: string;
    startAt: string | null;
    completedAt: string | null;
    status: string;
    title: string | null;
    propertyName: string | null;
    clientName: string | null;
    // Time fields for the "took Xm" duration on each row.
    startedAt: string | null;
    totalPausedMs: number;
    assignees: { userId: string; displayName: string; isClaimer: boolean }[];
  }[];
  // Aggregate-only: workers currently on the clock (workday endedAt null).
  // Each row carries just enough to compute a live-ticking active duration
  // + the display name. UI derives IN_PROGRESS vs PAUSED from pausedAt.
  workdaysInProgress?: {
    id: string;
    userId: string;
    displayName: string;
    startedAt: string;
    pausedAt: string | null;
    totalPausedMs: number;
  }[];
};

type TabFilter = { status?: string; type?: string; kind?: string; datePreset?: string; dateFrom?: string; dateTo?: string; overdue?: boolean; method?: string };

const PFX = "seedlings_";
const setLS = (key: string, val: unknown) => {
  try { localStorage.setItem(PFX + key, JSON.stringify(val)); } catch {}
};

/** Pre-write filter values to a tab's localStorage so the tab opens with the right state on remount.
 *  Resets every relevant key (so prior values can't leak across taps) and dispatches a `remount` flag
 *  with the navigation event. The destination tab is force-remounted, reading its fresh state on first render.
 *
 *  Three modes:
 *  - default (no opts): worker mode. Writes wjobs_, equip_w_, pay_w_ keys, dispatches navigate:workerTab.
 *  - opts.adminViewAsUserId: admin-impersonation mode. Writes admin keys + worker-scope filters
 *    (adminjobs_workers, pay_a_persons, equip_a_workers), dispatches navigate:adminTab.
 *  - opts.adminAggregate: admin company-wide mode. Writes admin keys, CLEARS worker-scope filters,
 *    dispatches navigate:adminTab.
 */
type NavOpts = {
  adminViewAsUserId?: string;
  adminAggregate?: boolean;
  // When provided (and non-empty), navigation pre-writes this list of worker IDs
  // to the destination tab's worker filter, so the destination shows the same subset.
  adminSubsetUserIds?: string[];
};
function navigateWithFilter(
  tab: "jobs" | "equipment" | "payments",
  filter: TabFilter,
  opts?: NavOpts,
) {
  // Always clear stale session keys that could trigger highlight/jump-to-occurrence behavior.
  try {
    sessionStorage.removeItem("open:remindersToJobsTabSearchOnce");
    sessionStorage.removeItem("servicesTabToJobsNav");
  } catch {}

  const adminViewAsUserId = opts?.adminViewAsUserId;
  const adminAggregate = !!opts?.adminAggregate;
  const adminSubsetUserIds = opts?.adminSubsetUserIds;
  const adminMode = !!adminViewAsUserId || adminAggregate || (!!adminSubsetUserIds && adminSubsetUserIds.length > 0);
  // For destination-tab worker filters: subset takes precedence (use the list),
  // then impersonation (single worker), then aggregate (clear it).
  const destWorkerIds: string[] = adminSubsetUserIds && adminSubsetUserIds.length > 0
    ? adminSubsetUserIds
    : adminViewAsUserId
      ? [adminViewAsUserId]
      : [];

  if (tab === "jobs") {
    // Worker JobsTab uses prefix "wjobs", admin uses "ajobs". Reset everything filterable.
    const pfx = adminMode ? "ajobs" : "wjobs";
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
    // JobsTab has a "daily reset" useEffect that wipes filters on the first mount of a
    // new day. It reads the marker as a RAW localStorage key (no seedlings_ prefix), so
    // we write it raw too — otherwise the reset still fires and clobbers what we just
    // wrote, leaving the user with default filters and "everything" in the feed.
    try { localStorage.setItem(`${pfx}_lastUsedDate`, bizToday()); } catch {}
    if (adminMode) {
      // Worker filter for destination AdminJobsTab: subset list, single worker, or empty.
      setLS(`adminjobs_workers`, destWorkerIds);
    }
  } else if (tab === "payments") {
    const pfx = adminMode ? "pay_a" : "pay_w";
    setLS(`${pfx}_datePreset`, filter.datePreset ?? null);
    setLS(`${pfx}_dateFrom`, filter.dateFrom ?? "");
    setLS(`${pfx}_dateTo`, filter.dateTo ?? "");
    if (adminMode) {
      setLS(`${pfx}_method`, [filter.method ?? "ALL"]);
      // Person filter: subset list, single worker, or empty.
      setLS(`${pfx}_persons`, destWorkerIds);
    } else {
      setLS(`${pfx}_type`, [filter.method ?? "ALL"]);
    }
  } else if (tab === "equipment") {
    const pfx = adminMode ? "equip_a" : "equip_w";
    // Worker view supports "MY_RESERVED" / "MY_CHECKED_OUT" virtual statuses that are
    // implicitly scoped to the current user. In admin mode the equivalent is the global
    // RESERVED/CHECKED_OUT status combined with the worker filter set below — translate
    // here so admin tile clicks land on a meaningful Equipment view.
    let adminStatus = filter.status ?? "ALL";
    if (adminMode) {
      if (filter.status === "MY_RESERVED") adminStatus = "RESERVED";
      else if (filter.status === "MY_CHECKED_OUT") adminStatus = "CHECKED_OUT";
    }
    setLS(`${pfx}_status`, [adminMode ? adminStatus : (filter.status ?? "CLAIMED")]);
    setLS(`${pfx}_kind`, [filter.kind ?? "ALL"]);
    setLS(`${pfx}_likedOnly`, false);
    if (adminMode) {
      // Worker filter: subset list, single worker, or empty.
      setLS(`${pfx}_workers`, destWorkerIds);
    }
  }

  // Admin and Worker share inner-tab value names for the Work-category
  // tabs (jobs/payments/equipment), so the destination is the same
  // string in both modes — no remap needed.
  const eventName = adminMode ? "navigate:adminTab" : "navigate:workerTab";
  window.dispatchEvent(new CustomEvent(eventName, { detail: { tab, remount: true } }));
}

/** Plain navigation (no filter), used when the destination tab manages its own state.
 *  Carries impersonation/aggregate mode forward — admin clicks set or clear the
 *  destination tab's worker selector accordingly. */
function dispatchNavPlain(tab: string, opts?: NavOpts) {
  const adminViewAsUserId = opts?.adminViewAsUserId;
  const adminAggregate = !!opts?.adminAggregate;
  const adminSubsetUserIds = opts?.adminSubsetUserIds;
  const adminMode = !!adminViewAsUserId || adminAggregate || (!!adminSubsetUserIds && adminSubsetUserIds.length > 0);
  // Same precedence as navigateWithFilter: subset > impersonation > aggregate.
  const destWorkerIds: string[] = adminSubsetUserIds && adminSubsetUserIds.length > 0
    ? adminSubsetUserIds
    : adminViewAsUserId
      ? [adminViewAsUserId]
      : [];
  const eventName = adminMode ? "navigate:adminTab" : "navigate:workerTab";
  let remount = false;
  if (adminMode) {
    if (tab === "reminders") {
      // AdminRemindersTab uses usePersistedState<string[]>("adminreminders_workers").
      setLS(`adminreminders_workers`, destWorkerIds);
      remount = true;
    }
  }
  window.dispatchEvent(new CustomEvent(eventName, { detail: { tab, remount } }));
}

// Date helpers come from @/src/lib/lib (bizDateKey is imported below).
// NEVER reinvent — see lib/lib.ts header for why.

function sevenDaysAgoKey(): string {
  // Today minus 6 days (so the range is 7 days inclusive of today), in ET.
  return bizAddDays(bizToday(), -6);
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
  hintOnClick,
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
  /** When set, the hint text becomes its own click target (separate from the
   *  tile body) — e.g. "Earned for X jobs" linking somewhere distinct. */
  hintOnClick?: () => void;
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
              hintOnClick ? (
                <Text
                  fontSize="xs"
                  color={color}
                  truncate
                  w="full"
                  textDecoration="underline"
                  textDecorationStyle="dotted"
                  cursor="pointer"
                  onClick={(e) => { e.stopPropagation(); hintOnClick(); }}
                >
                  {hint}
                </Text>
              ) : (
                <Text fontSize="xs" color="fg.muted" truncate w="full">
                  {hint}
                </Text>
              )
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

export default function HomeTab({ me, onLaunchWorkflow, viewAsUserId, viewAsDisplayName, aggregate, subsetUserIds }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const isViewingOther = !!viewAsUserId;
  const push = usePushNotifications();
  const [pushBannerDismissed, setPushBannerDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("seedlings_pushBannerDismissed") === "1"; } catch { return false; }
  });
  // Session-only help shown right after the user enables. Component state
  // resets when the tab unmounts, so this naturally disappears on the next
  // return to Home — and the X button closes it manually.
  const [showJustEnabledHelp, setShowJustEnabledHelp] = useState(false);
  // Same pattern, but for the post-Dismiss state: a one-shot reminder that
  // the user can still re-enable from Profile.
  const [showJustDismissedHelp, setShowJustDismissedHelp] = useState(false);
  // Subset mode: aggregate-style view restricted to a list of workers. Treated like
  // aggregate for hero suppression and tile layout, but click-throughs scope to the subset.
  const isSubset = !!subsetUserIds && subsetUserIds.length > 0 && !viewAsUserId;
  const isAggregate = (!!aggregate || isSubset) && !viewAsUserId;
  // Stable cache key for subset list to avoid re-fetching on identical arrays.
  const subsetKey = (subsetUserIds ?? []).join(",");
  // Local nav helpers that fold in impersonation/aggregate/subset context. Always reach
  // for these from inside the component instead of the module-level ones.
  const navOpts: NavOpts | undefined = isSubset
    ? { adminAggregate: true, adminSubsetUserIds: subsetUserIds }
    : aggregate && !viewAsUserId
      ? { adminAggregate: true }
      : viewAsUserId
        ? { adminViewAsUserId: viewAsUserId }
        : undefined;
  const navTo = (tab: "jobs" | "equipment" | "payments", filter: TabFilter) =>
    navigateWithFilter(tab, filter, navOpts);
  const navPlain = (tab: string) => dispatchNavPlain(tab, navOpts);

  async function load() {
    setLoading(true);
    try {
      const url = isSubset
        ? `/api/dashboard-summary/aggregate?workerIds=${encodeURIComponent((subsetUserIds ?? []).join(","))}`
        : aggregate && !viewAsUserId
          ? `/api/dashboard-summary/aggregate`
          : viewAsUserId
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
  }, [viewAsUserId, aggregate, subsetKey]);

  // Hour in Eastern Time (the business timezone) — drives the hero CTA framing.
  const etHour = bizHour();
  const isEvening = etHour >= 15;       // 3pm+: pivot toward "plan tomorrow"
  const isLateEvening = etHour >= 21;   // 9pm+: calm mode, no aggressive CTA

  const greeting = etHour < 12 ? "Good morning"
    : etHour < 17 ? "Good afternoon"
    : "Good evening";
  // When impersonating, the greeting names the viewed worker, not the admin.
  const firstName = isViewingOther
    ? (viewAsDisplayName?.split(" ")[0] || "")
    : (me?.displayName?.split(" ")[0] || me?.email?.split("@")[0] || "");

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
        ? `You have ${s.todayRemaining} job${s.todayRemaining === 1 ? "" : "s"} left today${(s.todayObserverRemaining ?? 0) > 0 ? ` (${s.todayObserverRemaining} as observer)` : ""}.`
        : s.tomorrow > 0
          ? `Nothing left today — ${s.tomorrow} tomorrow.`
          : "You're caught up. Nothing on your plate.";

  // Today's money strip — the big 3-column indicator that answers
  //   "how much can I make today · how much have I made · how much is left"
  // in one glance. Rendered inside the resume + begin/finish heroes.
  //
  //   Can make   = todayEarnedAmount + todayPotentialAmount
  //                (completed jobs use ACTUAL splits via the paycheck
  //                 helper; uncompleted jobs get equal-split projection
  //                 because completionSplits isn't set until completion)
  //   Made       = todayEarnedAmount   (actuals only)
  //   Remaining  = todayPotentialAmount (equal-split projection)
  //
  // Numbers already take out expenses + fees/margin — see
  // services/workerEarnings.ts computeMyOccurrenceNet. Returns null when
  // nothing is priced today so the strip doesn't render an empty $0 row.
  // Values captured outside the function so TS keeps the non-null
  // narrowing on `s` (function scope re-widens the closure otherwise).
  const heroEarned = s.todayEarnedAmount ?? 0;
  const heroRemaining = s.todayPotentialAmount ?? 0;
  const heroCanMake = heroEarned + heroRemaining;
  function todaysMoneyStrip(theme: "orange" | "green"): React.ReactNode {
    if (heroCanMake <= 0) return null;
    const c = theme === "orange"
      ? { bg: "whiteAlpha.200", border: "whiteAlpha.400", label: "orange.50", value: "white" }
      : { bg: "white",           border: "green.200",     label: "green.700", value: "green.800" };
    // Tooltip on the two projected columns — hints that the equal-split
    // assumption is used for jobs that haven't been completed yet, so
    // the worker isn't surprised when actuals land differently on jobs
    // with an uneven completionSplits.
    const projectionHint =
      "Assumes equal split for jobs not yet completed. Actual splits kick in on completion.";
    return (
      <SimpleGrid
        columns={3}
        gap={0}
        bg={c.bg}
        borderRadius="md"
        borderWidth="1px"
        borderColor={c.border}
        overflow="hidden"
      >
        <VStack align="center" gap={0} py={3} px={2}>
          <Text
            fontSize="2xs"
            color={c.label}
            textTransform="uppercase"
            letterSpacing="wider"
            fontWeight="medium"
            title={projectionHint}
          >
            Can make
          </Text>
          <Text fontSize="xl" fontWeight="bold" color={c.value} lineHeight="1.1">
            {fmtMoney(heroCanMake)}
          </Text>
        </VStack>
        <VStack
          align="center"
          gap={0}
          py={3}
          px={2}
          borderLeftWidth="1px"
          borderRightWidth="1px"
          borderColor={c.border}
        >
          <Text
            fontSize="2xs"
            color={c.label}
            textTransform="uppercase"
            letterSpacing="wider"
            fontWeight="medium"
            title="Actual paycheck value from completed jobs today — respects real completionSplits and payment reconciliation."
          >
            Made
          </Text>
          <Text fontSize="xl" fontWeight="bold" color={c.value} lineHeight="1.1">
            {fmtMoney(heroEarned)}
          </Text>
        </VStack>
        <VStack align="center" gap={0} py={3} px={2}>
          <Text
            fontSize="2xs"
            color={c.label}
            textTransform="uppercase"
            letterSpacing="wider"
            fontWeight="medium"
            title={projectionHint}
          >
            Remaining
          </Text>
          <Text fontSize="xl" fontWeight="bold" color={c.value} lineHeight="1.1">
            {fmtMoney(heroRemaining)}
          </Text>
        </VStack>
      </SimpleGrid>
    );
  }

  // Corner refresh button — anchored top-right of whichever hero card
  // is currently rendered. Mirrors the small icon-button pattern used
  // on ServicesTab / DocumentsTab / UsersTab (etc). Each hero Card.Root
  // gets `position="relative"` so this absolutely-positioned element
  // lands inside its border. stopPropagation because several hero
  // cards are themselves click-navigable.
  const heroCornerRefresh = (
    <Box position="absolute" top={2} right={2} zIndex={1}>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => { e.stopPropagation(); void load(); }}
        loading={loading}
        px="2"
        flexShrink={0}
        aria-label="Refresh"
        title="Refresh"
      >
        <FiRefreshCw size={14} />
      </Button>
    </Box>
  );

  return (
    <Box w="full" position="relative">
      {loading && summary && (
        <>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>
      )}
      <VStack align="stretch" gap={4}>

        {/* Admin-posted home banners — stack newest-first at the top until
            the user dismisses them. Hidden while impersonating since the
            data is always the *current* user's, which would be misleading. */}
        <HomeBanners disabled={isViewingOther} />

        {/* Enable-notifications banner — about the logged-in user's own
            device. Hidden only in impersonation (admin viewing-as worker);
            shown in aggregate/subset because the admin still wants push for
            themselves. Dismissible per-device.

            After a successful enable, the pink banner is replaced by a yellow
            help-text box (session-only, dismissible) reminding the user where
            to look if notifications don't appear. */}
        {!isViewingOther && showJustEnabledHelp && (
          <Card.Root variant="outline" bg="yellow.50" borderColor="yellow.300" borderWidth="1px">
            <Card.Body p={3}>
              <HStack align="center" gap={3}>
                <Text fontSize="xs" color="yellow.800" flex={1} minW={0}>
                  If you don't see notifications, check Settings → Notifications and verify it's enabled for your browser (e.g. Chrome, Safari, etc.).
                </Text>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label="Dismiss notifications help"
                  onClick={() => setShowJustEnabledHelp(false)}
                >
                  <FiX size={14} />
                </Button>
              </HStack>
            </Card.Body>
          </Card.Root>
        )}

        {!isViewingOther && showJustDismissedHelp && (
          <Card.Root variant="outline" bg="yellow.50" borderColor="yellow.300" borderWidth="1px">
            <Card.Body p={3}>
              <HStack align="center" gap={3}>
                <Text fontSize="xs" color="yellow.800" flex={1} minW={0}>
                  You can re-enable notifications anytime from your{" "}
                  <Text
                    as="span"
                    color="yellow.900"
                    fontWeight="semibold"
                    textDecoration="underline"
                    cursor="pointer"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent("navigate:profile", { detail: { userId: me?.id } }));
                    }}
                  >
                    Profile
                  </Text>
                  .
                </Text>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label="Dismiss"
                  onClick={() => setShowJustDismissedHelp(false)}
                >
                  <FiX size={14} />
                </Button>
              </HStack>
            </Card.Body>
          </Card.Root>
        )}

        {!isViewingOther && !showJustEnabledHelp && !pushBannerDismissed && (push.status === "default" || push.status === "needs-pwa-install" || (push.status === "granted-no-sub" && push.explicitlyDisabled)) && (
          <Card.Root
            variant="outline"
            bg="pink.50"
            borderColor="pink.400"
            borderWidth="2px"
            style={{ animation: "seedlings-pulse 2.5s ease-in-out infinite" }}
          >
            <Card.Body p={2}>
              <HStack gap={2} align="center" wrap="wrap">
                <Box bg="pink.200" color="pink.800" p={1.5} borderRadius="md" flexShrink={0}>
                  <FiBell size={16} />
                </Box>
                <VStack align="start" gap={0} flex="1" minW="180px">
                  <Text fontSize="sm" fontWeight="semibold" color="pink.900" lineHeight="1.2">
                    Get a phone alert for tomorrow's plan
                  </Text>
                  <Text fontSize="xs" color="pink.800" lineHeight="1.3">
                    {push.status === "needs-pwa-install"
                      ? "Add Seedlings to your Home Screen to enable notifications."
                      : "Tap Enable to receive a push notification each evening."}
                  </Text>
                </VStack>
                <HStack gap={1} flexShrink={0}>
                  {push.status !== "needs-pwa-install" && (
                    <Button
                      size="sm"
                      colorPalette="pink"
                      loading={push.busy}
                      onClick={async () => {
                        const r = await push.subscribe();
                        if (r.ok) {
                          publishInlineMessage({ type: "SUCCESS", text: "Notifications enabled." });
                          setShowJustEnabledHelp(true);
                        } else {
                          publishInlineMessage({ type: "ERROR", text: r.error ?? "Could not enable notifications" });
                        }
                      }}
                    >
                      Enable
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      try { localStorage.setItem("seedlings_pushBannerDismissed", "1"); } catch {}
                      setPushBannerDismissed(true);
                      setShowJustDismissedHelp(true);
                    }}
                  >
                    Dismiss
                  </Button>
                </HStack>
              </HStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Compliance banner — surfaces pending policy work below the
            admin-posted banners AND the push-alert enablement banner. Red
            when BLOCK-level items are pending (can't start work), orange
            when only WARN/INFO are left, silently absent when fully
            cleared. Sign now button dispatches the same `policies:required`
            event PolicyGateInterceptor listens for, reusing the wizard
            flow. Hidden while an admin is impersonating another worker. */}
        <ComplianceBanner
          viewAsUserId={viewAsUserId ?? null}
          viewAsDisplayName={isViewingOther ? (viewAsDisplayName ?? null) : null}
        />

        {/* Workday — mileage is injected INSIDE the workday card via the
            mileageSlot prop so they share ONE border, ONE background, ONE
            collapse gesture. Not two adjacent cards. Not a wrapper around
            two cards. Structurally one card with two zones inside. */}
        {!isAggregate && (
          <WorkdayStrip
            viewAsUserId={viewAsUserId ?? null}
            viewAsDisplayName={isViewingOther ? (viewAsDisplayName ?? null) : null}
            canImpersonate={!!me?.realRoles?.includes("SUPER")}
            mileageSlot={!isViewingOther ? <MileageStrip embedded /> : null}
            // The strip's trailing 12px margin double-counted with
            // this VStack's gap={4}, making the space before the hero
            // visibly larger than any other between-section gap. Let
            // the parent VStack own all exterior spacing.
            noBottomMargin
          />
        )}

        {/* Aggregate mode: a single team-summary banner replaces the per-worker hero. */}
        {isAggregate && (
          <Card.Root variant="outline" bg="gray.50" borderColor="gray.300" position="relative">
            {heroCornerRefresh}
            <Card.Body p={5}>
              <VStack align="start" gap={1}>
                <Text fontSize="lg" fontWeight="bold" color="gray.800">
                  {isSubset ? `Selected workers (${subsetUserIds?.length ?? 0})` : "Team overview"}
                </Text>
                <Text fontSize="sm" color="gray.700">
                  {s.today} job{s.today === 1 ? "" : "s"} scheduled today
                  {s.activeWork > 0 ? ` · ${s.activeWork} in progress` : ""}
                  {(s.tomorrow ?? 0) > 0 ? ` · ${s.tomorrow} tomorrow` : ""}
                </Text>
                {/* Live "who's doing what" panel — only renders in aggregate
                    mode when at least one job is active. Each row links to
                    the occurrence on the Admin Jobs tab via the existing
                    pendingHighlight handoff. */}
                {(s.inProgressJobs?.length ?? 0) > 0 && (
                  <VStack align="stretch" gap={1} w="full" mt={2} pt={2} borderTopWidth="1px" borderColor="gray.300">
                    <Text fontSize="xs" fontWeight="medium" color="gray.700" textTransform="uppercase">
                      Jobs in progress now
                    </Text>
                    {(s.inProgressJobs ?? []).map((occ) => {
                      const claimer = occ.assignees.find((a) => a.isClaimer);
                      const others = occ.assignees.filter((a) => !a.isClaimer);
                      const assigneeText =
                        occ.assignees.length === 0
                          ? "(unassigned)"
                          : claimer
                            ? `${claimer.displayName}${others.length > 0 ? ` +${others.length}` : ""}`
                            : occ.assignees.map((a) => a.displayName).join(", ");
                      // Client name leads the row so the admin's eye lands
                      // on "who" before "where" — matches the way most
                      // admins ask "what's <client> doing right now?".
                      // Falls back to the property name alone when the
                      // client name isn't available.
                      const jobLabel =
                        occ.clientName
                          ? `${occ.clientName}${occ.propertyName ? ` — ${occ.propertyName}` : ""}`
                          : occ.propertyName
                          ? occ.propertyName
                          : (occ.title ?? "(untitled)");
                      // Date label disambiguates rows when the same property
                      // has multiple active occurrences. Older dates are
                      // typically a sign of a forgotten "complete" — the
                      // status dot stays accurate either way.
                      const dateLabel = occ.startAt
                        ? fmtDateOpts(occ.startAt, { month: "short", day: "numeric" })
                        : "";
                      return (
                        <HStack
                          key={occ.id}
                          gap={2}
                          fontSize="sm"
                          p={1.5}
                          borderRadius="sm"
                          cursor="pointer"
                          _hover={{ bg: "white" }}
                          onClick={() => {
                            try {
                              localStorage.setItem(
                                "seedlings_jobs_pendingHighlight",
                                `${occ.id}|${occ.startAt ?? ""}`,
                              );
                            } catch {}
                            window.dispatchEvent(
                              new CustomEvent("navigate:adminTab", {
                                detail: { tab: "jobs", remount: true },
                              }),
                            );
                          }}
                          title="Open this occurrence on the Admin Jobs tab"
                        >
                          {occ.status === "PAUSED" ? (
                            <Box
                              w="8px"
                              h="8px"
                              borderRadius="full"
                              bg="orange.400"
                              flexShrink={0}
                              title="Paused"
                            />
                          ) : (
                            <Box
                              w="8px"
                              h="8px"
                              borderRadius="full"
                              bg="green.500"
                              flexShrink={0}
                              title="In progress"
                            />
                          )}
                          <Text flex="1" minW={0} truncate color="gray.800">
                            {jobLabel}
                            {dateLabel && (
                              <Text as="span" color="gray.500" fontSize="xs" ml={1}>
                                · {dateLabel}
                              </Text>
                            )}
                          </Text>
                          {/* Live elapsed since the job actually started —
                              matches the "Xh Ym" cell shown on Workdays
                              in progress. Freezes at pausedAt when the
                              job is PAUSED so the number matches the
                              WorkdayStrip's paused-clock behavior.
                              Hidden when startedAt is null (job was
                              never actually clocked-in — no
                              meaningful duration to show). */}
                          {occ.startedAt && (
                            <LiveJobElapsed
                              startedAt={occ.startedAt}
                              pausedAt={occ.status === "PAUSED" ? occ.pausedAt : null}
                              totalPausedMs={occ.totalPausedMs}
                            />
                          )}
                          <Text fontSize="xs" color="gray.600" whiteSpace="nowrap">
                            {assigneeText}
                          </Text>
                          <Text fontSize="xs" color="blue.600">→</Text>
                        </HStack>
                      );
                    })}
                  </VStack>
                )}

                {/* "Workdays in progress" panel — one row per worker
                    currently on the clock (workday endedAt is null).
                    Complements "In progress now" (which is about jobs)
                    by showing "who is clocked in right now" — workers
                    driving between jobs, on breaks, etc. appear here
                    even when no job is active. Duration ticks live
                    every 30 seconds; states derive from pausedAt (set
                    → PAUSED with amber dot, else IN_PROGRESS with blue
                    dot, matching the WorkdayStrip's state theme). */}
                {(s.workdaysInProgress?.length ?? 0) > 0 && (
                  <WorkdaysInProgressPanel workdays={s.workdaysInProgress ?? []} />
                )}

                {/* "Completed today" panel — mirrors "In progress now" in
                    structure and click behavior. Shows everything that
                    finished today (status COMPLETED, PENDING_PAYMENT, or
                    CLOSED) so the admin can see the day's output at a
                    glance and drill into any row. */}
                {(s.completedTodayJobs?.length ?? 0) > 0 && (
                  <VStack align="stretch" gap={1} w="full" mt={2} pt={2} borderTopWidth="1px" borderColor="gray.300">
                    <Text fontSize="xs" fontWeight="medium" color="gray.700" textTransform="uppercase">
                      Completed today
                    </Text>
                    {(s.completedTodayJobs ?? []).map((occ) => {
                      const claimer = occ.assignees.find((a) => a.isClaimer);
                      const others = occ.assignees.filter((a) => !a.isClaimer);
                      const assigneeText =
                        occ.assignees.length === 0
                          ? "(unassigned)"
                          : claimer
                            ? `${claimer.displayName}${others.length > 0 ? ` +${others.length}` : ""}`
                            : occ.assignees.map((a) => a.displayName).join(", ");
                      // Client name leads the row so the admin's eye lands
                      // on "who" before "where" — matches the way most
                      // admins ask "what's <client> doing right now?".
                      // Falls back to the property name alone when the
                      // client name isn't available.
                      const jobLabel =
                        occ.clientName
                          ? `${occ.clientName}${occ.propertyName ? ` — ${occ.propertyName}` : ""}`
                          : occ.propertyName
                          ? occ.propertyName
                          : (occ.title ?? "(untitled)");
                      // Time-of-completion label so a glance shows what
                      // wrapped up when. Falls back to the scheduled date
                      // when completedAt is somehow missing.
                      const timeLabel = occ.completedAt
                        ? fmtTimeOpts(occ.completedAt, { hour: "numeric", minute: "2-digit" })
                        : occ.startAt
                          ? fmtDateOpts(occ.startAt, { month: "short", day: "numeric" })
                          : "";
                      // Dot color reflects post-completion state at a
                      // glance: blue = awaiting payment, gray = closed
                      // (paid + done), green = freshly completed.
                      const dotColor =
                        occ.status === "PENDING_PAYMENT"
                          ? "blue.500"
                          : occ.status === "CLOSED"
                            ? "gray.500"
                            : "green.500";
                      const dotTitle =
                        occ.status === "PENDING_PAYMENT"
                          ? "Awaiting payment"
                          : occ.status === "CLOSED"
                            ? "Closed"
                            : "Completed";
                      return (
                        <HStack
                          key={occ.id}
                          gap={2}
                          fontSize="sm"
                          p={1.5}
                          borderRadius="sm"
                          cursor="pointer"
                          _hover={{ bg: "white" }}
                          onClick={() => {
                            try {
                              localStorage.setItem(
                                "seedlings_jobs_pendingHighlight",
                                `${occ.id}|${occ.startAt ?? ""}`,
                              );
                            } catch {}
                            window.dispatchEvent(
                              new CustomEvent("navigate:adminTab", {
                                detail: { tab: "jobs", remount: true },
                              }),
                            );
                          }}
                          title="Open this occurrence on the Admin Jobs tab"
                        >
                          <Box
                            w="8px"
                            h="8px"
                            borderRadius="full"
                            bg={dotColor}
                            flexShrink={0}
                            title={dotTitle}
                          />
                          <Text flex="1" minW={0} truncate color="gray.800">
                            {jobLabel}
                            {timeLabel && (
                              <Text as="span" color="gray.500" fontSize="xs" ml={1}>
                                · {timeLabel}
                              </Text>
                            )}
                          </Text>
                          {/* "Took Xh Ym" — static duration derived from
                              startedAt / completedAt / totalPausedMs.
                              Hidden when either bound is missing (rare
                              — job was manually completed without a
                              real start). */}
                          {occ.startedAt && occ.completedAt && (() => {
                            const ms = Math.max(
                              0,
                              new Date(occ.completedAt).getTime()
                                - new Date(occ.startedAt).getTime()
                                - (occ.totalPausedMs ?? 0),
                            );
                            return (
                              <Text fontSize="xs" color="gray.600" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
                                {fmtJobElapsed(ms)}
                              </Text>
                            );
                          })()}
                          <Text fontSize="xs" color="gray.600" whiteSpace="nowrap">
                            {assigneeText}
                          </Text>
                          <Text fontSize="xs" color="blue.600">→</Text>
                        </HStack>
                      );
                    })}
                  </VStack>
                )}
              </VStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Hero CTA: Resume active work (any time) */}
        {!isAggregate && heroMode === "resume" && (
          <Card.Root
            variant="elevated"
            cursor="pointer"
            onClick={() => navTo("jobs", { status: "IN_PROGRESS", datePreset: "lastMonth" })}
            _hover={{ shadow: "lg" }}
            bg="orange.500"
            color="white"
            position="relative"
          >
            {heroCornerRefresh}
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
                {todaysMoneyStrip("orange")}
                <HStack gap={3}>
                  <VStack align="start" gap={0} flex={1} minW={0}>
                    <Text fontSize="md" fontWeight="bold">Resume active work</Text>
                    <Text fontSize="sm" opacity={0.9}>
                      {s.activeWork} job{s.activeWork === 1 ? "" : "s"} in progress or paused
                    </Text>
                  </VStack>
                  <Text fontSize="2xl">→</Text>
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Hero CTA: Begin / Finish — same workflow, different framing by time-of-day */}
        {!isAggregate && (heroMode === "begin" || heroMode === "finish") && (
          <Card.Root
            variant="outline"
            cursor={isViewingOther ? "default" : "pointer"}
            onClick={isViewingOther ? undefined : () => onLaunchWorkflow("begin-workday")}
            _hover={isViewingOther ? undefined : { shadow: "md", borderColor: "green.400" }}
            bg="green.50"
            borderColor="green.300"
            position="relative"
          >
            {heroCornerRefresh}
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
                {/* Money strip replaces the old "$X earned · $Y remaining
                    potential" one-line subline — same numbers, bigger and
                    split into three columns so the intent is legible at
                    a glance. */}
                {todaysMoneyStrip("green")}
                <HStack gap={3}>
                  <VStack align="start" gap={0} flex={1} minW={0}>
                    <Text fontSize="md" fontWeight="bold" color="green.800">
                      {heroMode === "begin" ? "Begin work day" : "Finish remaining jobs"}
                    </Text>
                  </VStack>
                  {!isViewingOther && <Text fontSize="2xl" color="green.600">→</Text>}
                </HStack>
              </VStack>
            </Card.Body>
          </Card.Root>
        )}

        {/* Hero CTA: Plan tomorrow — evening pivot, no work left today */}
        {!isAggregate && heroMode === "planTomorrow" && (
          <Card.Root
            variant="outline"
            cursor={isViewingOther ? "default" : "pointer"}
            onClick={isViewingOther ? undefined : () => onLaunchWorkflow("plan-workday")}
            _hover={isViewingOther ? undefined : { shadow: "md", borderColor: "blue.400" }}
            bg="blue.50"
            borderColor="blue.300"
            position="relative"
          >
            {heroCornerRefresh}
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
                        textDecoration="underline"
                        cursor="pointer"
                        onClick={(e: any) => {
                          e.stopPropagation();
                          // Navigate to JobsTab filtered to tomorrow's unclaimed jobs.
                          const tomorrowKey = bizTomorrow();
                          navTo("jobs", { status: "UNCLAIMED", dateFrom: tomorrowKey, dateTo: tomorrowKey });
                        }}
                      >
                        {s.tomorrowUnclaimedCount} unclaimed{s.tomorrowUnclaimedPotential > 0 ? ` · ${fmtMoney(s.tomorrowUnclaimedPotential)} potential` : ""} →
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
        {!isAggregate && heroMode === "wrap" && (
          <Card.Root variant="outline" bg="gray.50" borderColor="gray.200" position="relative">
            {heroCornerRefresh}
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

        {/* Approximate pay-per-hour card — worker's own on their Home,
            OR the impersonated worker's when Admin Home is viewing a
            single worker via the "View as" picker (so admins can see
            exactly what that worker sees). Hidden in aggregate /
            subset views since those already show a per-worker table
            below. */}
        {!isAggregate && !isSubset && (
          <WorkerHourlyPayCard
            viewAsUserId={viewAsUserId ?? null}
            viewAsDisplayName={viewAsDisplayName ?? null}
          />
        )}

        {/* Today's hourly pay — admin-only, per-worker snapshot table.
            Sits BELOW the Approximate pay-per-hour card so the admin
            first sees the impersonated worker's number, then the
            team-wide day-of-work rollup. Gated on any admin-view prop
            (aggregate, subset, or view-as-single-worker); regular
            worker Home never renders it. */}
        {(isAggregate || viewAsUserId) && (
          <TodayHourlyPayPanel
            workerIds={
              viewAsUserId
                ? viewAsUserId
                : isSubset
                  ? (subsetUserIds ?? []).join(",")
                  : ""
            }
          />
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
                <Text fontSize="xs" fontWeight="semibold" color="fg.default" textTransform="uppercase" letterSpacing="wide">Weekly Earnings (Jobs)</Text>
                <Text fontSize="xs" color="fg.muted">Last 2 months · {fmtMoney(totalEarnings)}</Text>
              </HStack>
              <Box h="160px">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={s.weeklyCompleted} margin={{ top: 28, right: 12, bottom: 0, left: 8 }}>
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

        <SimpleGrid columns={{ base: 1, sm: 2 }} gap={3}>
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
            onClick={() => navTo("jobs", { datePreset: "today", type: "JOBS" })}
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
            onClick={() => navPlain("reminders")}
          />

          {/* Equipment — in aggregate mode, show team totals (reserved + checked out).
              Otherwise directional based on time of day:
              morning/midday → reserved you need to check out;
              evening/night → checked out you need to return;
              otherwise → generic "no actions" tile that links to the Equipment tab. */}
          {(() => {
            if (isAggregate) {
              const reserved = s.equipmentReserved ?? 0;
              const checkedOut = s.equipmentCheckedOut ?? 0;
              // Mirror per-person directional logic for the team:
              // morning/midday → focus on reserved (gear awaiting checkout);
              // evening → focus on checked out (gear that needs return).
              if (!isEvening && reserved > 0) {
                return (
                  <Tile
                    icon={FiTool}
                    label="Reserved equipment"
                    value={reserved}
                    hint={checkedOut > 0 ? `${checkedOut} also checked out` : "Awaiting checkout"}
                    color="teal.600"
                    bg="teal.50"
                    onClick={() => navTo("equipment", { status: "RESERVED" })}
                  />
                );
              }
              if (isEvening && checkedOut > 0) {
                return (
                  <Tile
                    icon={FiTool}
                    label="Equipment out"
                    value={checkedOut}
                    hint={reserved > 0 ? `${reserved} also reserved` : "Currently in workers' hands"}
                    color="teal.600"
                    bg="teal.50"
                    onClick={() => navTo("equipment", { status: "CHECKED_OUT" })}
                  />
                );
              }
              // Combined fallback view. Click filters to whichever bucket has items
              // (so a "0 reserved · 5 checked out" tile filters to CHECKED_OUT, not the
              // empty RESERVED bucket). When both have items, time-of-day breaks the tie.
              // navTo also clears the worker-scope filter on the destination tab.
              const total = reserved + checkedOut;
              const hint = total > 0
                ? `${reserved} reserved · ${checkedOut} checked out`
                : "Nothing in workers' hands right now";
              const fallbackStatus =
                reserved > 0 && checkedOut === 0 ? "RESERVED"
                : checkedOut > 0 && reserved === 0 ? "CHECKED_OUT"
                : isEvening ? "CHECKED_OUT"
                : "RESERVED";
              return (
                <Tile
                  icon={FiTool}
                  label="Equipment"
                  value={total}
                  hint={hint}
                  color="teal.600"
                  bg="teal.50"
                  dimmed={total === 0}
                  onClick={() => navTo("equipment", { status: fallbackStatus })}
                />
              );
            }
            if (!isEvening && s.equipmentReserved > 0) {
              return (
                <Tile
                  icon={FiTool}
                  label="Reserved equipment"
                  value={s.equipmentReserved}
                  hint="Check out before heading out"
                  color="teal.600"
                  bg="teal.50"
                  onClick={() => navTo("equipment", { status: "MY_RESERVED" })}
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
                  onClick={() => navTo("equipment", { status: "MY_CHECKED_OUT" })}
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
                onClick={() => navPlain("equipment")}
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
            onClick={() => navTo("jobs", { status: "PENDING_PAYMENT", datePreset: "lastMonth" })}
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
            onClick={() => navTo("jobs", { type: "NOTICES", datePreset: "today" })}
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
            onClick={() => navTo("jobs", { type: "DUE", datePreset: "lastMonth" })}
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
            onClick={() => navTo("jobs", { status: "FINISHED", dateFrom: sevenDaysAgoKey(), dateTo: bizDateKey(new Date()) })}
          />

          {/* Earnings for the last 7 days (EXCLUDING today). Worker-type-split:
              - Employee/trainee: work-anchored (promised net for jobs completed
                in the window). Whole tile drills into the Jobs tab.
              - Contractor: payment-anchored (actual payout from payments
                recorded in the window). Tile body drills into the Payments
                tab; the "X jobs" hint drills into the Jobs tab.
              Window dates come from the API so the number and the drill-down
              always cover the same range. */}
          {(() => {
            const isEmp = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE";
            const from = s.weekEarningsFrom || sevenDaysAgoKey();
            const to = s.weekEarningsTo || bizDateKey(new Date());
            const jobCount = s.weekJobCount ?? 0;
            const goJobs = () => navTo("jobs", { status: "FINISHED", dateFrom: from, dateTo: to });
            const goPayments = () => navTo("payments", { dateFrom: from, dateTo: to });
            return (
              <Tile
                icon={TfiMoney}
                label="Earnings (last 7 days)"
                value={fmtMoney(s.actualWeekEarnings ?? 0)}
                hint={`Earned for ${jobCount} job${jobCount === 1 ? "" : "s"}`}
                color="green.700"
                bg="green.50"
                dimmed={(s.actualWeekEarnings ?? 0) === 0}
                onClick={isEmp ? goJobs : goPayments}
                hintOnClick={isEmp ? undefined : goJobs}
              />
            );
          })()}
        </SimpleGrid>

      </VStack>
    </Box>
  );
}

// Shared "how long has this been running" formatter used by both the
// Jobs in progress and Completed today rows on the Admin Home Team
// Overview panel. Sub-hour intervals stay in minutes so short jobs
// don't collapse to "0h Xm"; hour-plus intervals use "Hh Mm".
function fmtJobElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Live-ticking elapsed cell for a Jobs-in-progress row. Owns its own
// 30-second interval so ticking a single cell doesn't force the whole
// HomeTab render tree to re-run every 30s (matches
// WorkdaysInProgressPanel's tick cadence). Freezes at pausedAt when
// the row is paused so the number stays consistent with the
// WorkdayStrip's paused-clock behavior.
function LiveJobElapsed({
  startedAt,
  pausedAt,
  totalPausedMs,
}: {
  startedAt: string;
  pausedAt: string | null;
  totalPausedMs: number;
}) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (pausedAt) return; // frozen — no need to tick
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [pausedAt]);
  const endMs = pausedAt ? new Date(pausedAt).getTime() : nowMs;
  const activeMs = Math.max(
    0,
    endMs - new Date(startedAt).getTime() - (totalPausedMs ?? 0),
  );
  return (
    <Text
      fontSize="xs"
      color="gray.600"
      whiteSpace="nowrap"
      fontVariantNumeric="tabular-nums"
    >
      {fmtJobElapsed(activeMs)}{pausedAt ? " · paused" : ""}
    </Text>
  );
}

// Team Overview panel row-list for currently-on-the-clock workdays.
// Extracted so the live-tick useEffect + duration computation don't
// bloat the main HomeTab render tree. Ticks every 30 seconds — same
// cadence the MileageStrip uses for its "elapsed" text; workers are
// almost always going to look at this on the minute-scale, not
// second-scale, so 1-Hz would just burn cycles.
function WorkdaysInProgressPanel({
  workdays,
}: {
  workdays: {
    id: string;
    userId: string;
    displayName: string;
    startedAt: string;
    pausedAt: string | null;
    totalPausedMs: number;
  }[];
}) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <VStack align="stretch" gap={1} w="full" mt={2} pt={2} borderTopWidth="1px" borderColor="gray.300">
      <Text fontSize="xs" fontWeight="medium" color="gray.700" textTransform="uppercase">
        Workdays in progress
      </Text>
      {workdays.map((wd) => {
        const isPaused = !!wd.pausedAt;
        // Endpoint for the interval:
        //   - In-progress + not paused → now (still ticking).
        //   - In-progress + paused → pausedAt (interval is frozen at
        //     pause; the open pause segment isn't yet in
        //     totalPausedMs, so we clip the endpoint to avoid
        //     double-counting).
        const endMs = isPaused
          ? new Date(wd.pausedAt!).getTime()
          : nowMs;
        const rawMs = endMs - new Date(wd.startedAt).getTime();
        const activeMs = Math.max(0, rawMs - wd.totalPausedMs);
        const startedLabel = fmtTimeOpts(wd.startedAt, { hour: "numeric", minute: "2-digit" });
        return (
          <HStack
            key={wd.id}
            gap={2}
            fontSize="sm"
            p={1.5}
            borderRadius="sm"
          >
            {/* Blue = actively on the clock, amber = paused — matches
                the WorkdayStrip's state theme. */}
            <Box
              w="8px"
              h="8px"
              borderRadius="full"
              bg={isPaused ? "yellow.400" : "blue.500"}
              flexShrink={0}
              title={isPaused ? "Paused" : "On the clock"}
            />
            <Text flex="1" minW={0} truncate color="gray.800">
              {wd.displayName}
              <Text as="span" color="gray.500" fontSize="xs" ml={1}>
                · started {startedLabel}
              </Text>
            </Text>
            <Text fontSize="xs" color="gray.600" whiteSpace="nowrap" fontVariantNumeric="tabular-nums">
              {fmtJobElapsed(activeMs)}{isPaused ? " · paused" : ""}
            </Text>
          </HStack>
        );
      })}
    </VStack>
  );
}
