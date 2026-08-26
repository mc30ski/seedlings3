"use client";

// ─────────────────────────────────────────────────────────────────────────────
// HomeTab — blended-role Home tab.
//
// One tab serves worker/admin/super via a `scope` prop. The layout is
// capability-additive:
//   • Worker : self-view (HomeBanners → MyDashboard → hero card →
//              WorkerHourlyPayCard).
//   • Admin  : adds the AdminViewAsSelector + badges above the hero,
//              which drive `viewAsUserId`/`subsetUserIds`/`aggregate`
//              — the same hero and pay card re-render scoped to the
//              picker. TodayHourlyPayPanel appears alongside.
//   • Super  : adds the Operations rollup at the very top (money /
//              jobs / equipment / team & clients) via the parts file.
// Client role is walled off — HomeTab is worker-and-up only.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Box, Button, Card, HStack, SimpleGrid, Spinner, Text, VStack } from "@chakra-ui/react";
import { BarChart3 } from "lucide-react";
import { FiMoon, FiPlay, FiRefreshCw, FiSun } from "react-icons/fi";
import { computeDatesFromPreset, type DatePreset } from "@/src/lib/datePresets";
import { apiGet } from "@/src/lib/api";
import { bizToday, bizTomorrow, bizAddDays, bizHour, fmtDateOpts, fmtTimeOpts } from "@/src/lib/dates";
import { getErrorMessage, publishInlineMessage } from "@/src/ui/components/InlineMessage";
import HomeBanners from "@/src/ui/components/HomeBanners";
import MyDashboard from "@/src/ui/components/MyDashboard";
import PayrollHomeSection from "@/src/ui/components/PayrollHomeSection";
import { fetchWorkdayToday } from "@/src/lib/workday";
import TodayHourlyPayPanel from "@/src/ui/components/TodayHourlyPayPanel";
import WorkerHourlyPayCard from "@/src/ui/components/WorkerHourlyPayCard";
import AllWorkersHourlyPayCards from "@/src/ui/components/AllWorkersHourlyPayCards";
import type { Me } from "@/src/lib/types";
import { OperationsPanel } from "@/src/ui/tabs/HomeTab.parts";
import {
  AdminViewAsBadges,
  AdminViewAsSelector,
  type AdminWorker,
} from "@/src/ui/tabs/JobsTab.parts";
import { usePersistedState } from "@/src/lib/usePersistedState";

type Props = {
  me: Me | null | undefined;
  onLaunchWorkflow: (name: string) => void;
  // Blended-role scope. Worker layer is the always-on self-view; Admin
  // adds the Team dashboard; Super adds Operations. Additive — never
  // subtractive — so a Super sees Worker + Admin + Super sections.
  scope: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
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

// Narrowed to the fields this tab actually consumes. The API returns
// more (equipment/notices/reminders/tasks/etc. — see
// routes/worker.ts /dashboard-summary), but the tile grid that used
// them was removed. Add fields back here as new UI needs them.
type Summary = {
  today: number;
  tomorrow: number;
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

type TabFilter = { status?: string; type?: string; kind?: string; datePreset?: string; dateFrom?: string; dateTo?: string; method?: string };

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
      // Worker filter for destination JobsTab: subset list, single worker, or empty.
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

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function HomeTab({
  me,
  onLaunchWorkflow,
  scope,
  viewAsUserId: propViewAsUserId,
  viewAsDisplayName: propViewAsDisplayName,
  aggregate: propAggregate,
  subsetUserIds: propSubsetUserIds,
}: Props) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  // Whether the scoped worker's workday has already begun. The hero CTA
  // ("Prepare for work day") walks someone THROUGH starting their day, so
  // it has nothing to offer once they're on the clock.
  //
  // `null` = not yet known. The button renders only on a definite `false`,
  // so it never appears and then vanishes a moment later.
  const [workdayStarted, setWorkdayStarted] = useState<boolean | null>(null);
  // Push-notification + compliance state is owned by MyDashboard's
  // inner banners (NotificationOptInBanner, CompliancePromptBanner) —
  // this file no longer needs to track any of it.

  // Blended admin picker — matches the JobsTab pattern. When
  // scope.isAdmin is on AND the caller didn't already pass explicit
  // viewAs/aggregate/subset props, this internal state feeds the same
  // load() / render code paths the shipped HomeTab uses. Default
  // (empty selection) is "All Workers" = aggregate; 1 selection =
  // single-worker view-as; N selections = subset.
  const [adminWorkers, setAdminWorkers] = useState<AdminWorker[]>([]);
  const [selfViewAsIds, setSelfViewAsIds] = usePersistedState<string[]>(
    "homeTab_viewAsIds",
    [],
  );
  // Super Insights (Operations rollup) collapse state — same
  // pattern as the Equipment + Jobs Insights sections.
  const [insightsCollapsed, setInsightsCollapsed] = usePersistedState<boolean>(
    "homeTab_insightsCollapsed",
    false,
  );
  const usingSelfViewAs =
    scope.isAdmin && !propViewAsUserId && !propAggregate && !propSubsetUserIds?.length;
  useEffect(() => {
    if (!scope.isAdmin) return;
    apiGet<AdminWorker[]>("/api/workers")
      .then((list) => setAdminWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [scope.isAdmin]);

  // Effective props — either what the parent passed, or what the
  // internal picker derives. Downstream code reads these names.
  const rawViewAsUserId = usingSelfViewAs
    ? (selfViewAsIds.length === 1 ? selfViewAsIds[0] : undefined)
    : propViewAsUserId;
  const rawViewAsDisplayName = usingSelfViewAs
    ? (selfViewAsIds.length === 1
        ? (adminWorkers.find((w) => w.id === selfViewAsIds[0])?.displayName ?? undefined)
        : undefined)
    : propViewAsDisplayName;

  // SELECTING YOURSELF IS NOT IMPERSONATION.
  //
  // The operator appears in their own /api/workers picker, so an admin can
  // pick themselves as the single selected worker. Everything downstream
  // keys off `isViewingOther = !!viewAsUserId`, which had no self-check —
  // so choosing your own name put the page into full impersonation mode
  // against yourself: third-person compliance copy with "Manage in
  // Compliance" instead of Sign now, MileageBanner and the notification
  // opt-in suppressed entirely, the hero CTA disabled, and the section
  // titled "Workday: <your name>". You could see your own blockers and do
  // nothing about them.
  //
  // Collapsing to self-view here fixes every one of those at once, because
  // they all read these two names. It is also what the server already
  // does: /api/me/* mutations are caller-scoped, so a self-targeted
  // view-as call was resolving to the caller anyway — the UI was hiding
  // controls that would have worked.
  const isSelfSelection = !!rawViewAsUserId && rawViewAsUserId === me?.id;
  const viewAsUserId = isSelfSelection ? undefined : rawViewAsUserId;
  const viewAsDisplayName = isSelfSelection ? undefined : rawViewAsDisplayName;
  const subsetUserIds = usingSelfViewAs
    ? (selfViewAsIds.length > 1 ? selfViewAsIds : undefined)
    : propSubsetUserIds;
  const aggregate = usingSelfViewAs
    ? selfViewAsIds.length === 0  // no selection → All Workers aggregate
    : propAggregate;

  const isViewingOther = !!viewAsUserId;
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

  // Workday state for the scoped worker. Refetched on the same broadcast
  // the WorkdayStrip fires, so starting the day from the strip above hides
  // this card's CTA immediately rather than on the next page load.
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const payload = await fetchWorkdayToday({ viewAsUserId: viewAsUserId ?? null });
        if (cancelled) return;
        const st = payload?.today?.state;
        setWorkdayStarted(st === "IN_PROGRESS" || st === "PAUSED");
      } catch {
        // A workday lookup failing must not remove a working button.
        if (!cancelled) setWorkdayStarted(false);
      }
    };
    void read();
    const onChanged = () => void read();
    window.addEventListener("seedlings:workday-changed", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("seedlings:workday-changed", onChanged);
    };
  }, [viewAsUserId]);

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
  // - Otherwise → "Prepare for work day" / "Finish remaining" / "Plan tomorrow" / "Wrap"
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
        <VStack align="center" gap={0} py={2} px={2}>
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
          <Text fontSize="lg" fontWeight="bold" color={c.value} lineHeight="1.1">
            {fmtMoney(heroCanMake)}
          </Text>
        </VStack>
        <VStack
          align="center"
          gap={0}
          py={2}
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
          <Text fontSize="lg" fontWeight="bold" color={c.value} lineHeight="1.1">
            {fmtMoney(heroEarned)}
          </Text>
        </VStack>
        <VStack align="center" gap={0} py={2} px={2}>
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
          <Text fontSize="lg" fontWeight="bold" color={c.value} lineHeight="1.1">
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
        onClick={(e) => {
          e.stopPropagation();
          // Refresh every data-owning surface on this page:
          //   • dashboard summary (drives hero + tiles)
          //   • MyDashboard banners (workday, mileage, compliance)
          //     — they already listen for seedlings:workday-changed
          //   • WorkerHourlyPayCard — same event
          // No full page reload; each component re-fetches its own data.
          void load();
          window.dispatchEvent(new CustomEvent("seedlings:workday-changed"));
        }}
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

  // Hero card for the current mode. Declared here rather than inline in
  // the tree because it is handed to MyDashboard as `leadContent` — the
  // hero and the workday banners are ONE section ("My activities"), with
  // the hero on top. Every branch is `!isAggregate`, matching
  // MyDashboard's own render gate, so the two can never disagree about
  // whether this worker-scoped content belongs on screen.
  const heroSection = (
    <>
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
          <Card.Body px={4} py={2}>
            <VStack align="stretch" gap={2}>
              <HStack gap={3} align="center">
                <Box bg="white" color="orange.600" p={2} borderRadius="full" flexShrink={0}>
                  <FiPlay size={22} />
                </Box>
                <Box flex={1} minW={0}>
                  <Text fontSize="md" fontWeight="bold">{greeting}{firstName ? `, ${firstName}` : ""}</Text>
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

      {/* Hero CTA: Begin / Finish — same workflow, different framing by time-of-day.
          Deliberately NOT clickable as a whole, unlike the other hero cards:
          the button inside is the only way in. A card-wide onClick meant an
          incidental tap anywhere in the hero (or on the money strip) opened a
          multi-step workflow. */}
      {!isAggregate && (heroMode === "begin" || heroMode === "finish") && (
        <Card.Root
          variant="outline"
          bg="green.50"
          borderColor="green.300"
          position="relative"
        >
          {heroCornerRefresh}
          <Card.Body px={4} py={2}>
            <VStack align="stretch" gap={2}>
              <HStack gap={3} align="center">
                <Box bg="green.500" color="white" p={2} borderRadius="full" flexShrink={0}>
                  <FiSun size={22} />
                </Box>
                <Box flex={1} minW={0}>
                  <Text fontSize="md" fontWeight="bold" color="green.800">{greeting}{firstName ? `, ${firstName}` : ""}</Text>
                  <Text fontSize="sm" color="green.700">{greetingSubtitle}</Text>
                </Box>
              </HStack>
              {/* Money strip replaces the old "$X earned · $Y remaining
                  potential" one-line subline — same numbers, bigger and
                  split into three columns so the intent is legible at
                  a glance. */}
              {todaysMoneyStrip("green")}
              {/* A real Button, not a text row with an arrow — and the
                  ONLY launcher for this workflow now that the card
                  itself no longer handles clicks. Sized to its label and
                  centered rather than stretched full-width; it shared the
                  top row with the greeting briefly, which crowded the text
                  out at phone widths. */}
              {/* Hidden once the worker is on the clock. This launches the
                  "prepare for work day" flow — review today's jobs, confirm
                  clients, check equipment, look at the route, start the
                  workday — and every one of those is either done or moot by
                  the time someone is clocked in. Rendered only on a
                  definite `false` so it doesn't appear and then vanish
                  while the workday lookup is in flight. */}
              {workdayStarted === false && (
                <HStack justify="center">
                  <Button
                    size="md"
                    colorPalette="green"
                    disabled={isViewingOther}
                    onClick={() => onLaunchWorkflow("begin-workday")}
                  >
                    {heroMode === "begin" ? "Prepare for work day" : "Finish remaining jobs"}
                  </Button>
                </HStack>
              )}
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
          <Card.Body px={4} py={2}>
            <VStack align="stretch" gap={2}>
              <HStack gap={3} align="center">
                <Box bg="blue.500" color="white" p={2} borderRadius="full" flexShrink={0}>
                  <FiMoon size={22} />
                </Box>
                <Box flex={1} minW={0}>
                  <Text fontSize="md" fontWeight="bold" color="blue.800">{greeting}{firstName ? `, ${firstName}` : ""}</Text>
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
          <Card.Body px={4} py={2}>
            <HStack gap={3}>
              <Box bg="gray.200" color="gray.700" p={2} borderRadius="full">
                <FiMoon size={22} />
              </Box>
              <VStack align="start" gap={0} flex={1}>
                <Text fontSize="md" fontWeight="bold" color="gray.800">
                  {greeting}{firstName ? `, ${firstName}` : ""}
                </Text>
                <Text fontSize="sm" color="gray.700">{greetingSubtitle}</Text>
              </VStack>
            </HStack>
          </Card.Body>
        </Card.Root>
      )}
    </>
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

        {/* Admin-posted broadcasts — stay above MY DASHBOARD so
            company-wide announcements aren't buried inside the
            collapsible. Hidden while impersonating since the data
            is always the *current* user's, which would be
            misleading in that context. */}
        <HomeBanners disabled={isViewingOther} />

        {/* Super Insights — Operations rollup (money, jobs, equipment,
            team & clients) driven by one period control. Placed
            ABOVE the admin picker so the highest-level lens
            (business-wide pulse) sits at the top; the picker below
            narrows the main hero/tile area. Wrapped in the orange
            Insights card that matches the Equipment + Jobs Insights
            sections for a consistent Super visual language. */}
        {scope.isSuper && (
          <Card.Root variant="outline" bg="orange.50" borderColor="orange.200">
            <Card.Body py={3} px={3}>
              <HStack
                gap={2}
                align="center"
                mb={insightsCollapsed ? 0 : 2}
                cursor="pointer"
                onClick={() => setInsightsCollapsed(!insightsCollapsed)}
                _hover={{ opacity: 0.7 }}
              >
                <BarChart3 size={14} color="var(--chakra-colors-gray-600)" />
                <Text fontSize="sm" fontWeight="bold" color="gray.600" textTransform="uppercase" letterSpacing="wide">
                  Insights
                </Text>
                <Text fontSize="xs" color="gray.400">{insightsCollapsed ? "▶" : "▼"}</Text>
              </HStack>
              {!insightsCollapsed && <OperationsPanel />}
            </Card.Body>
          </Card.Root>
        )}

        {/* Admin picker — mirrors the shipped Admin → Work → Home
            worker selector. Default (nothing selected) = All Workers
            aggregate; 1 = single-worker view-as; N = subset team
            view. The same hero / hourly-pay / weekly-chart / tile
            grid below re-renders scoped to the picker. */}
        {usingSelfViewAs && (
          <VStack align="stretch" gap={1}>
            <HStack gap={2} align="center" wrap="nowrap">
              <AdminViewAsSelector
                workers={adminWorkers}
                selected={selfViewAsIds}
                onChange={setSelfViewAsIds}
              />
            </HStack>
            {/* Wrapping HStack keeps the selected-worker badges as
                inline chips instead of full-width rows (a Badge
                inside a VStack align="stretch" would otherwise get
                stretched to 100% width). */}
            {selfViewAsIds.length > 0 && (
              <HStack gap={1} wrap="wrap">
                <AdminViewAsBadges
                  workers={adminWorkers}
                  selected={selfViewAsIds}
                />
              </HStack>
            )}
          </VStack>
        )}

        {/* MY ACTIVITIES — the day's hero card plus the self-view
            banners, merged into one section. Reflects the
            currently-scoped user: logged-in user by default, or the
            impersonated worker when the admin picker has exactly
            one selection (WorkdayBanner + CompliancePromptBanner
            are view-as-aware; MileageBanner + NotificationOptInBanner
            are inherently self-only and skip themselves in that
            mode — see MyDashboard). Hidden in subset (N workers)
            and aggregate (0 workers, admin scope) modes because
            everything in it is a single-user surface. */}
        {(!scope.isAdmin || !!viewAsUserId || (!isAggregate && !isSubset)) && (
          <MyDashboard
            storageKey="seedlings:homeTab:myDashboardOpen"
            viewAsUserId={viewAsUserId ?? null}
            viewAsDisplayName={viewAsDisplayName ?? null}
            leadContent={heroSection}
          />
        )}
        {/* NOTHING self-scoped renders in team modes (aggregate / subset).
            This previously kept a self-scoped CompliancePromptBanner alive
            here, on the reasoning that an admin parked in Team overview
            would otherwise never see their own BLOCK-level items before
            PolicyGateInterceptor blocked them. That was reverted
            deliberately (2026-08-24, product decision): the Admin surface
            is for a TEAM overview, or for a single selected worker whose
            view you are inspecting and acting on behalf of. The operator's
            OWN items belong in MY WORKDAY — reachable via the Work role,
            or on the Admin role by selecting yourself in the picker.
            A self-scoped banner floating above a team roster reads as if
            it describes the team, which is what prompted the revert.
            Don't "restore" it without asking. */}

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
                {/* "Workdays in progress" panel — one row per worker
                    currently on the clock (workday endedAt is null).
                    Rendered ABOVE "Jobs in progress now" because the
                    "who's clocked in" question is the foundational
                    lens: an admin wants to see who's on before
                    drilling into what any of them is doing. Duration
                    ticks live every 30 seconds; states derive from
                    pausedAt (set → PAUSED with amber dot, else
                    IN_PROGRESS with blue dot, matching the
                    WorkdayStrip's state theme). */}
                {(s.workdaysInProgress?.length ?? 0) > 0 && (
                  <WorkdaysInProgressPanel workdays={s.workdaysInProgress ?? []} />
                )}

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
                            // Preserve the operator's active scope on
                            // the jump — a Super clicking a row lands
                            // on Super → Jobs; an Admin lands on
                            // Admin → Jobs. JobsTab renders the same
                            // data via scope, but scope-continuity
                            // matters for the Back button + breadcrumb.
                            const eventName = scope.isSuper
                              ? "navigate:superTab"
                              : "navigate:adminTab";
                            window.dispatchEvent(
                              new CustomEvent(eventName, {
                                detail: { tab: "jobs", remount: true },
                              }),
                            );
                          }}
                          title="Open this occurrence on the Jobs tab"
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
                            // Preserve the operator's active scope on
                            // the jump — a Super clicking a row lands
                            // on Super → Jobs; an Admin lands on
                            // Admin → Jobs. JobsTab renders the same
                            // data via scope, but scope-continuity
                            // matters for the Back button + breadcrumb.
                            const eventName = scope.isSuper
                              ? "navigate:superTab"
                              : "navigate:adminTab";
                            window.dispatchEvent(
                              new CustomEvent(eventName, {
                                detail: { tab: "jobs", remount: true },
                              }),
                            );
                          }}
                          title="Open this occurrence on the Jobs tab"
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
            weeklyCompleted={s.weeklyCompleted ?? []}
          />
        )}

        {/* Today's hourly pay — admin-only TEAM roster for today, one row
            per worker who has finished a job. Regular worker Home never
            renders it.

            NOT shown when a single worker is selected: a roster of one is
            not a roster, and it duplicated the MY EARNINGS card directly
            above it with a narrower window. `isAggregate` covers All
            Workers and a subset of N — the two cases where comparing
            workers side by side is the point. */}
        {isAggregate && (
          <TodayHourlyPayPanel
            workerIds={isSubset ? (subsetUserIds ?? []).join(",") : ""}
          />
        )}

        {/* MY PAYDAY — what Gusto actually paid, deliberately adjacent to the
            approximate-pay card above. The two numbers disagree by design;
            putting them side by side with clear labels is more honest than
            separating them and letting the mismatch read as a bug. Same
            single-user gate as that card — payroll is per-person, so it has
            no meaning in the aggregate/subset team views. Renders nothing
            when the worker has no payroll on record (every contractor,
            today). */}
        {!isAggregate && !isSubset && (
          <PayrollHomeSection
            viewAsUserId={viewAsUserId ?? null}
            viewAsDisplayName={viewAsDisplayName ?? null}
          />
        )}

        {/* Aggregate / no-worker-selected variant of the pay-per-hour
            card — one mini card per approved worker, side by side. Only
            renders when we're actually in "all workers" mode (no
            view-as, no subset). Subset views can rely on the existing
            TodayHourlyPayPanel above. */}
        {isAggregate && !isSubset && <AllWorkersHourlyPayCards />}





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
