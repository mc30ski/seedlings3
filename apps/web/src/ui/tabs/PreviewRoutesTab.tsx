"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PreviewRoutesTab — blended-role Routes tab. Takes a `scope` prop
// carrying {isWorker, isAdmin, isSuper} so one tab serves all three:
// Worker plans own routes; Admin/Super get the inline worker picker
// + on-behalf endpoints; Super also gets the team-travel Operations
// rollup at the top of the tab.
//
// Offline: covered by the shell's service worker (public/sw.js)
// which is network-first + cache-fallback for /api/*, plus this
// component caches the analysis result blob in localStorage per
// userId so results persist even without SW.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
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
import { Play, Settings2 } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { MapLink } from "@/src/ui/helpers/Link";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import { openEventSearch } from "@/src/lib/bus";
import { fmtDate, fmtDateTime, bizDateKey, bizTomorrow, bizDaysBetween, bizHourMinute, bizInstantFromEtParts, type EtDateKey } from "@/src/lib/dates";
import AddressAutocomplete from "@/src/ui/components/AddressAutocomplete";
import { AdminWorkerPicker, RoutesOperationsPanel, SectionExpander } from "@/src/ui/tabs/PreviewRoutesTab.parts";

type RouteJob = {
  id: string;
  jobId?: string;
  type: "claimable" | "claimed";
  property: string;
  client?: string | null;
  address: string;
  city: string;
  price: number | null;
  estimatedMinutes: number | null;
  kind: string;
  // True when the occurrence is an estimate (workflow=ESTIMATE or the
  // per-occurrence isEstimate flag). Estimates route the same as
  // regular jobs but the UI badges them distinctly so the operator
  // spots them in the plan.
  isEstimate?: boolean;
  currentDate: string | null;
};

type RouteStop = {
  occurrenceId: string;
  order: number;
  property: string;
  address: string;
  reason: string;
  dateChanged: boolean;
  originalDate: string | null;
  suggestedDate: string | null;
};

type DayPlan = {
  date: string;
  dayLabel: string;
  route: RouteStop[];
  estimatedEarnings: number;
  estimatedHours: number;
  daySummary: string;
};

type Suggestions = {
  days: DayPlan[];
  summary: string;
  totalEstimatedEarnings: number;
  dateChangeCount: number;
  additionalJobsToConsider?: string[];
};

type RoutingInfo = {
  provider: string;
  totalDriveMinutes: number;
  totalDriveMiles: number;
};

type DataIssue = {
  occurrenceId: string;
  missingProperty: boolean;
  missingAddress: boolean;
};

type Response = {
  suggestions: Suggestions | null;
  raw?: string;
  /** Informational note (e.g. "no jobs on that day") — rendered muted. */
  message?: string;
  /** Explicit failure note — rendered as a RED warning banner so the
   *  operator can't miss that the AI didn't run (e.g. retired model,
   *  Anthropic API down). Was previously silent; ["just shows numbers"
   *  bug from 2026-08-16]. */
  error?: string;
  jobs: RouteJob[];
  targetUser?: { id: string; displayName: string | null };
  routing?: RoutingInfo | null;
  routeError?: string | null;
  startedFromCurrentLocation?: boolean;
  currentLocationAddress?: string | null;
  dataIssues?: DataIssue[];
};

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Date helpers come from @/src/lib/dates (bizTomorrow). NEVER reinvent.

type Props = {
  /** Blended-role scope. Worker plans own routes; Admin/Super get
   *  the inline worker picker + on-behalf-of endpoints. Capabilities
   *  add — never subtract. */
  scope: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
};

const STORAGE_KEY_PREFIX = "preview_routeResults";
// Sibling localStorage key that holds the ISO timestamp of the last
// successful analysis. Stored separately from the result blob so old
// pre-timestamp caches still parse — they just render the banner as if
// the analysis time is unknown until the next run.
const TIMESTAMP_KEY_PREFIX = "preview_routeResults_at";

function loadCachedResults(userId?: string): Response | null {
  try {
    const key = userId ? `${STORAGE_KEY_PREFIX}_${userId}` : STORAGE_KEY_PREFIX;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCachedResults(data: Response | null, userId?: string) {
  try {
    const key = userId ? `${STORAGE_KEY_PREFIX}_${userId}` : STORAGE_KEY_PREFIX;
    if (data) localStorage.setItem(key, JSON.stringify(data));
    else localStorage.removeItem(key);
  } catch {}
}

function loadCachedTimestamp(userId?: string): string | null {
  try {
    const key = userId ? `${TIMESTAMP_KEY_PREFIX}_${userId}` : TIMESTAMP_KEY_PREFIX;
    return localStorage.getItem(key);
  } catch { return null; }
}

function saveCachedTimestamp(ts: string | null, userId?: string) {
  try {
    const key = userId ? `${TIMESTAMP_KEY_PREFIX}_${userId}` : TIMESTAMP_KEY_PREFIX;
    if (ts) localStorage.setItem(key, ts);
    else localStorage.removeItem(key);
  } catch {}
}

export default function PreviewRoutesTab({ scope }: Props) {
  // Blended admin picker — mounted when scope.isAdmin. Empty
  // selection = plan own routes (admin can still plan their own
  // day); picking a worker delegates to the on-behalf endpoints
  // via the `userId` variable below.
  const [selfPickedWorkerId, setSelfPickedWorkerId] = usePersistedState<string | null>(
    "routesTab_viewAsWorker",
    null,
  );
  const usingSelfPicker = scope.isAdmin;
  const userId = usingSelfPicker ? (selfPickedWorkerId ?? undefined) : undefined;
  const [data, setData] = useState<Response | null>(() => loadCachedResults(userId));
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(() => loadCachedTimestamp(userId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Rehydrate the cached-results state whenever the effective user
  // changes (admin picking a different worker). Without this,
  // useState's lazy initializer captured the mount-time userId and
  // the "Last analyzed" strip + cached route stuck to whoever the
  // admin was viewing first.
  useEffect(() => {
    setData(loadCachedResults(userId));
    setLastUpdatedAt(loadCachedTimestamp(userId));
  }, [userId]);

  // Target day = the day to optimize a route for
  const todayStr = bizDateKey(new Date());
  const tomorrowStr = bizTomorrow();
  const [targetDate, setTargetDate] = usePersistedState("preview_targetDate", tomorrowStr);

  const dateBadge = targetDate === todayStr ? "Today" : targetDate === tomorrowStr ? "Tomorrow" : null;

  // Look-ahead = how far to look for jobs that could be pulled into the target day
  const [lookAhead, setLookAhead] = usePersistedState("preview_lookAhead", 5);

  // Available hours in the day — defaults from profile
  // -1 = not yet seeded from the profile. 0 = "No limit", a deliberate choice
  // the worker can make and keep — distinct from "we don't know yet", which is
  // why this can't just be 0-means-unset. See the seeding effect below.
  const [availableHours, setAvailableHours] = usePersistedState("preview_availableHours", -1);
  const [profileHoursLoaded, setProfileHoursLoaded] = useState(false);

  // Buffer time between jobs (percentage)
  const [bufferPercent, setBufferPercent] = usePersistedState("preview_buffer", 10);

  // Commission/margin for payout calculation
  const [marginPercent, setMarginPercent] = useState(20);
  useEffect(() => {
    apiGet<any[]>("/api/settings")
      .then((list) => {
        if (!Array.isArray(list)) return;
        // Use the higher of the two as a conservative estimate
        const c = list.find((r: any) => r.key === "CONTRACTOR_PLATFORM_FEE_PERCENT");
        const m = list.find((r: any) => r.key === "EMPLOYEE_BUSINESS_MARGIN_PERCENT");
        const pct = Math.max(Number(c?.value ?? 0), Number(m?.value ?? 0));
        if (pct > 0) setMarginPercent(pct);
      })
      .catch(() => {});
  }, []);

  // Mode: "claimed" = only optimize route for claimed jobs, "suggest" = also suggest new jobs to claim
  const [mode, setMode] = usePersistedState<"claimed" | "suggest">("preview_mode", "claimed");

  // Routing provider — hardcoded to the only supported provider.
  // The picker UI was removed when the codebase settled on Mapbox;
  // kept as a constant so the API param is preserved for later
  // multi-provider work without touching every callsite.
  const routingProvider = "mapbox";

  const [homeBase, setHomeBase] = useState("");
  const [profileHomeBase, setProfileHomeBase] = useState("");
  const [activeHomeBase, setActiveHomeBase] = useState(""); // what's currently "set" (persisted or profile)
  const [homeBaseLoaded, setHomeBaseLoaded] = useState(false);

  useEffect(() => {
    // Refetch the profile whenever the effective user changes so an
    // admin switching workers gets the new worker's home-base +
    // available-hours defaults, not the previously-viewed worker's.
    setHomeBaseLoaded(false);
    setProfileHoursLoaded(false);
    const endpoint = userId ? `/api/admin/users/${userId}` : "/api/me";
    apiGet<any>(endpoint)
      .then((u) => {
        const profileAddr = u?.homeBaseAddress ?? "";
        setProfileHomeBase(profileAddr);
        // Use localStorage override if set, otherwise profile
        let override = "";
        try { override = localStorage.getItem("seedlings_routes_homeBaseOverride") ?? ""; } catch {}
        const activeAddr = override || profileAddr;
        setHomeBase(activeAddr);
        setActiveHomeBase(activeAddr);
        setHomeBaseLoaded(true);
        // Seed from the profile once. If the worker has never set an hours
        // preference we leave it at "No limit" rather than inventing 4 — a
        // fabricated cap silently binned a worker's 22-job Saturday into
        // several days. Don't override what a worker thinks they can do.
        if (availableHours < 0) {
          setAvailableHours(u?.availableHoursPerDay ?? 0);
        }
        setProfileHoursLoaded(true);
      })
      .catch(() => { setHomeBaseLoaded(true); setProfileHoursLoaded(true); });
  }, [userId]);

  // Listen for auto-analyze trigger from workflow
  useEffect(() => {
    const onAutoAnalyze = () => {
      // Small delay to let the tab render and state settle
      setTimeout(() => loadSuggestions(), 500);
    };
    window.addEventListener("routes:autoAnalyze", onAutoAnalyze);
    return () => window.removeEventListener("routes:autoAnalyze", onAutoAnalyze);
    // userId included so an admin switching workers mid-session gets
    // an auto-analyze scoped to the newly-picked worker.
  }, [targetDate, mode, bufferPercent, lookAhead, availableHours, routingProvider, userId]);

  function setHomeBaseOverride() {
    try { localStorage.setItem("seedlings_routes_homeBaseOverride", homeBase); } catch {}
    setActiveHomeBase(homeBase);
    publishInlineMessage({ type: "SUCCESS", text: "Home base set for route planning." });
  }

  // Start point for the optimized route. "home" uses the saved home base
  // (round-trip). "current" geolocates the device when Analyze runs and uses
  // those coords as the start (one-way — no return leg). Admin views can't
  // pick "current" because the device location belongs to the operator, not
  // the target worker.
  const [startFrom, setStartFrom] = usePersistedState<"home" | "current">("preview_startFrom", "home");
  const effectiveStartFrom = userId ? "home" : startFrom;

  async function loadSuggestions() {
    setLoading(true);
    setError(null);
    try {
      let startParam = "";
      if (effectiveStartFrom === "current") {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          publishInlineMessage({ type: "WARNING", text: "Geolocation isn't available in this browser." });
          setLoading(false);
          return;
        }
        try {
          const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: false,
              timeout: 10000,
              maximumAge: 60000,
            });
          });
          startParam = `&startLat=${pos.coords.latitude}&startLng=${pos.coords.longitude}`;
        } catch (err: any) {
          const msg = err?.code === 1
            ? "Location permission denied. Allow location access or switch to Home base."
            : err?.message || "Could not get your location.";
          publishInlineMessage({ type: "WARNING", text: msg });
          setLoading(false);
          return;
        }
      }
      const userParam = userId ? `&userId=${userId}` : "";
      const params = `targetDate=${targetDate}&bufferPercent=${bufferPercent}&mode=${mode}&routingProvider=${routingProvider}` +
        (mode === "suggest"
          ? `&lookAhead=${lookAhead}` + (availableHours > 0 ? `&availableHours=${availableHours}` : "")
          : "") +
        userParam + startParam;
      const res = await apiGet<Response>(`/api/preview/route-suggestions?${params}`);
      const now = new Date().toISOString();
      setData(res);
      saveCachedResults(res, userId);
      setLastUpdatedAt(now);
      saveCachedTimestamp(now, userId);
    } catch (err: any) {
      console.error("Route suggestions failed:", err);
      setError(err?.message || "Failed to load suggestions");
      setData(null);
      saveCachedResults(null, userId);
      setLastUpdatedAt(null);
      saveCachedTimestamp(null, userId);
    }
    setLoading(false);
  }

  function clearResults() {
    setData(null);
    saveCachedResults(null, userId);
    setLastUpdatedAt(null);
    saveCachedTimestamp(null, userId);
    setClaimedIds(new Set());
    setTargetDate(tomorrowStr);
  }

  // Track which jobs are being claimed or have been claimed
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimedIds, setClaimedIds] = useState<Set<string>>(new Set());

  async function claimJob(occurrenceId: string, job: any) {
    setClaimingId(occurrenceId);
    try {
      // Calculate new start date based on targetDate, preserving the
      // source's ET wall-clock time-of-day (and duration if multi-day).
      // Previously used a hard-coded "T09:00:00Z" (= 5 AM ET EDT / 4 AM
      // ET EST) which silently moved every claim to early morning
      // regardless of the job's original time.
      const sourceTime = job?.startAt ? bizHourMinute(job.startAt) : "09:00";
      const newStartIso = bizInstantFromEtParts(targetDate, sourceTime);
      const patchData: any = { startAt: newStartIso };
      if (job?.startAt && job?.endAt) {
        const durationMs = new Date(job.endAt).getTime() - new Date(job.startAt).getTime();
        patchData.endAt = new Date(new Date(newStartIso).getTime() + durationMs).toISOString();
      }

      const origDate = job?.startAt ? bizDateKey(job.startAt) : null;
      const needsDateChange = origDate !== targetDate;

      if (userId) {
        // Admin claiming on behalf of a worker — use admin assign endpoint
        await apiPost(`/api/admin/occurrences/${occurrenceId}/add-assignee`, { userId });
        if (needsDateChange) {
          await apiPatch(`/api/admin/occurrences/${occurrenceId}`, patchData);
        }
      } else {
        // Worker claiming for themselves
        await apiPost(`/api/occurrences/${occurrenceId}/claim`, {});
        if (needsDateChange) {
          try {
            await apiPost(`/api/occurrences/${occurrenceId}/reschedule`, { ...patchData, source: "route-planner" });
          } catch (reschedErr: any) {
            // Claim succeeded but reschedule failed — inform user
            setClaimedIds((prev) => new Set(prev).add(occurrenceId));
            publishInlineMessage({ type: "WARNING", text: `Job claimed but could not be rescheduled: ${reschedErr?.message || "Unknown error"}. The job is still on its original date.` });
            setClaimingId(null);
            return;
          }
        }
      }

      setClaimedIds((prev) => new Set(prev).add(occurrenceId));
      publishInlineMessage({ type: "SUCCESS", text: `Job claimed${needsDateChange ? ` and moved to ${fmtDate(targetDate + "T12:00:00Z")}` : ""}.` });
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("already") || msg.includes("ALREADY") || msg.includes("claimed")) {
        publishInlineMessage({ type: "WARNING", text: "This job was already claimed by someone else and is no longer available." });
      } else {
        publishInlineMessage({ type: "ERROR", text: msg || "Claim failed." });
      }
    }
    setClaimingId(null);
  }

  // Reschedule a claimed job to a new date
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rescheduledIds, setRescheduledIds] = useState<Set<string>>(new Set());

  const maxMoveDays = userId ? 5 : 2;

  async function rescheduleJob(occurrenceId: string, newDate: string, job: any) {
    // Validate move is within allowed range — ET calendar days
    // (DST-safe via the canonical helper).
    if (job?.currentDate) {
      const diffDays = Math.abs(bizDaysBetween(job.currentDate, newDate as EtDateKey));
      if (diffDays > maxMoveDays) {
        publishInlineMessage({
          type: "WARNING",
          text: `${userId ? "Admins" : "Workers"} can only move jobs up to ${maxMoveDays} days. This move is ${diffDays} days.`,
        });
        return;
      }
    }

    setReschedulingId(occurrenceId);
    try {
      // Same source-time-preservation fix as claimJob above — was
      // hard-coding "T09:00:00Z" which lost the original wall-clock.
      const sourceTime = job?.startAt ? bizHourMinute(job.startAt) : "09:00";
      const newStartIso = bizInstantFromEtParts(newDate as EtDateKey, sourceTime);
      const patchData: any = { startAt: newStartIso };
      if (job?.startAt && job?.endAt) {
        const durationMs = new Date(job.endAt).getTime() - new Date(job.startAt).getTime();
        patchData.endAt = new Date(new Date(newStartIso).getTime() + durationMs).toISOString();
      }

      if (userId) {
        await apiPatch(`/api/admin/occurrences/${occurrenceId}`, patchData);
      } else {
        await apiPost(`/api/occurrences/${occurrenceId}/reschedule`, { ...patchData, source: "route-planner" });
      }

      setRescheduledIds((prev) => new Set(prev).add(occurrenceId));
      publishInlineMessage({ type: "SUCCESS", text: `Job rescheduled to ${fmtDate(newDate + "T12:00:00Z")}.` });
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message || "Reschedule failed." });
    }
    setReschedulingId(null);
  }


  const jobMap = new Map((data?.jobs ?? []).map((j) => [j.id, j]));
  const days = data?.suggestions?.days ?? [];
  const dateChangeCount = data?.suggestions?.dateChangeCount ?? 0;

  return (
    <Box w="full" pb={8} position="relative">
      {/* Loading overlay — same pattern as HomeTab / ServicesTab / etc.
          Semi-transparent veil over the tab content + a viewport-centered
          spinner. Replaces the inline "Analyzing available jobs..." block
          that used to occupy in-flow space mid-tab. */}
      {loading && (
        <>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Box position="fixed" top="50%" left="50%" transform="translate(-50%, -50%)" zIndex="2">
            <Spinner size="lg" />
          </Box>
        </>
      )}
      {/* Tiny AI disclaimer — one line, muted (was previously a
          full yellow card that dominated the first render). */}
      <Text fontSize="xs" color="fg.muted" mb={3}>
        Routes are optimized from driving distances + AI. Treat as a starting point, not a final plan.
      </Text>

      {/* Super capability layer — team travel rollup (miles, drive
          time, sessions, active drivers, top drivers/vehicles) for
          a rolling period. Placed above the admin picker so the
          highest-level lens (team-wide travel) reads first; the
          picker below narrows the per-worker planning surface. */}
      {scope.isSuper && (
        <Box mb={3}>
          <RoutesOperationsPanel />
        </Box>
      )}

      {/* Admin picker — mounted when scope.isAdmin and no explicit
          userId prop. "Me" = plan own routes. Picking a worker
          delegates to the on-behalf endpoints. */}
      {usingSelfPicker && (
        <Box mb={3}>
          <AdminWorkerPicker
            selectedWorkerId={selfPickedWorkerId}
            onChange={setSelfPickedWorkerId}
          />
        </Box>
      )}

      {/* Primary CTA — one clear next step. Big date + Plan button,
          replaces the previous three-separate-cards layout for date
          + mode + settings + Analyze button. */}
      <Box mb={3} p={4} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="lg">
        <HStack gap={3} align="flex-end" wrap="wrap">
          <Box flex="1" minW="140px">
            <HStack mb={1} gap={2}>
              <Text fontSize="xs" fontWeight="semibold" color="blue.900" textTransform="uppercase" letterSpacing="wide">
                Plan for
              </Text>
              {dateBadge && <Badge size="sm" colorPalette="blue" variant="subtle">{dateBadge}</Badge>}
            </HStack>
            <Input
              type="date"
              size="md"
              value={targetDate}
              min={todayStr}
              onChange={(e) => setTargetDate(e.target.value as EtDateKey)}
              bg="white"
            />
          </Box>
          <Button
            size="md"
            colorPalette="blue"
            onClick={loadSuggestions}
            loading={loading}
            flexShrink={0}
          >
            <Play size={14} />
            <Text ml={1}>{data ? "Re-plan" : "Plan route"}</Text>
          </Button>
          {data && (
            <Button size="sm" variant="ghost" onClick={clearResults} flexShrink={0}>
              Clear
            </Button>
          )}
        </HStack>
        {lastUpdatedAt && (
          <Text fontSize="xs" color="blue.700" mt={2}>
            Last analyzed {fmtDateTime(lastUpdatedAt)}
          </Text>
        )}
      </Box>

      {/* Advanced settings — folded away by default so the first
          render is just "pick a date, hit Plan". Home base, mode
          toggle, buffer, look-ahead, available hours, map provider,
          start-from all live here. Open state is persisted so a
          user who wants them always visible only has to expand
          once. */}
      <Box mb={3}>
        <SectionExpander
          title={
            <HStack gap={2}>
              <Settings2 size={14} />
              <Text as="span">Advanced settings</Text>
              <Text as="span" fontSize="xs" color="fg.muted">
                · {mode === "claimed" ? "Claimed only" : "Suggest jobs"} · {bufferPercent}% buffer
                {mode === "suggest" ? `${availableHours > 0 ? ` · ${availableHours}h` : ""} · ±${Math.min(lookAhead, maxMoveDays)}d` : ""}
              </Text>
            </HStack>
          }
          storageKey="routesTab_advancedOpen"
        >
          <VStack align="stretch" gap={4}>
            {/* Home base */}
            <Box>
              <Text fontSize="xs" fontWeight="medium" mb={1}>Home base</Text>
              <HStack gap={2}>
                <AddressAutocomplete
                  size="sm"
                  value={homeBaseLoaded ? homeBase : ""}
                  onChange={setHomeBase}
                  placeholder={homeBaseLoaded ? "e.g. 123 Main St, Chapel Hill, NC" : "Loading..."}
                  disabled={!homeBaseLoaded}
                  showValidation
                />
                <Button size="sm" onClick={setHomeBaseOverride} disabled={!homeBaseLoaded || homeBase === activeHomeBase}>
                  Set
                </Button>
                {homeBase !== profileHomeBase && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setHomeBase(profileHomeBase);
                      setActiveHomeBase(profileHomeBase);
                      try { localStorage.removeItem("seedlings_routes_homeBaseOverride"); } catch {}
                    }}
                    disabled={!homeBaseLoaded}
                  >
                    Reset
                  </Button>
                )}
              </HStack>
              {!userId && (
                <HStack gap={2} mt={2} align="center">
                  <Text fontSize="xs" fontWeight="medium" color="fg.muted">Start route from:</Text>
                  <Button
                    size="xs"
                    variant={effectiveStartFrom === "home" ? "solid" : "outline"}
                    colorPalette={effectiveStartFrom === "home" ? "blue" : "gray"}
                    onClick={() => setStartFrom("home")}
                  >
                    Home base
                  </Button>
                  <Button
                    size="xs"
                    variant={effectiveStartFrom === "current" ? "solid" : "outline"}
                    colorPalette={effectiveStartFrom === "current" ? "blue" : "gray"}
                    onClick={() => setStartFrom("current")}
                    title="Geolocate the device when Analyze runs and use those coords as the start (one-way, no return leg)"
                  >
                    My current location
                  </Button>
                </HStack>
              )}
            </Box>

            {/* Mode toggle + map provider */}
            <Box>
              <Text fontSize="xs" fontWeight="medium" mb={1}>What to include</Text>
              <HStack gap={2} wrap="wrap">
                <Button
                  size="sm"
                  variant={mode === "claimed" ? "solid" : "outline"}
                  colorPalette={mode === "claimed" ? "blue" : "gray"}
                  onClick={() => setMode("claimed")}
                >
                  Claimed only
                </Button>
                <Button
                  size="sm"
                  variant={mode === "suggest" ? "solid" : "outline"}
                  colorPalette={mode === "suggest" ? "blue" : "gray"}
                  onClick={() => setMode("suggest")}
                >
                  Suggest additional
                </Button>
              </HStack>
              <Text fontSize="xs" color="fg.muted" mt={1}>
                {mode === "claimed"
                  ? "Optimize the route for jobs you've already claimed."
                  : "Also suggest nearby available jobs to fill your day."}
              </Text>
            </Box>

            {/* Buffer slider — always shown */}
            <Box>
              <HStack justify="space-between" mb={1}>
                <Text fontSize="xs" fontWeight="medium">Setup buffer between stops</Text>
                <Text fontSize="xs" color="fg.muted" fontWeight="medium">{bufferPercent}%</Text>
              </HStack>
              <input
                type="range"
                min={0}
                max={50}
                step={5}
                value={bufferPercent}
                onChange={(e) => setBufferPercent(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--chakra-colors-orange-500)" }}
              />
              <HStack justify="space-between" fontSize="xs" color="fg.muted">
                <Text>0%</Text>
                <Text>50%</Text>
              </HStack>
            </Box>

            {/* Suggest-only sliders */}
            {mode === "suggest" && (
              <HStack gap={4} wrap="wrap" align="flex-end">
                <Box flex="1" minW="140px">
                  <HStack justify="space-between" mb={1}>
                    <Text fontSize="xs" fontWeight="medium">Consider jobs within</Text>
                    <Text fontSize="xs" color="fg.muted" fontWeight="medium">±{Math.min(lookAhead, maxMoveDays)} days</Text>
                  </HStack>
                  <input
                    type="range"
                    min={0}
                    max={maxMoveDays}
                    value={Math.min(lookAhead, maxMoveDays)}
                    onChange={(e) => setLookAhead(Number(e.target.value))}
                    style={{ width: "100%", accentColor: "var(--chakra-colors-blue-500)" }}
                  />
                  <HStack justify="space-between" fontSize="xs" color="fg.muted">
                    <Text>Same day only</Text>
                    <Text>{maxMoveDays} days</Text>
                  </HStack>
                </Box>
                <Box flex="1" minW="140px">
                  <HStack justify="space-between" mb={1}>
                    <Text fontSize="xs" fontWeight="medium">Available hours</Text>
                    <Text fontSize="xs" color="fg.muted" fontWeight="medium">
                      {availableHours > 0 ? `${availableHours}h` : "No limit"}
                    </Text>
                  </HStack>
                  <input
                    type="range"
                    min={0}
                    max={12}
                    value={Math.max(availableHours, 0)}
                    onChange={(e) => setAvailableHours(Number(e.target.value))}
                    style={{ width: "100%", accentColor: "var(--chakra-colors-blue-500)" }}
                  />
                  <HStack justify="space-between" fontSize="xs" color="fg.muted">
                    <Text>No limit</Text>
                    <Text>12h</Text>
                  </HStack>
                </Box>
              </HStack>
            )}
          </VStack>
        </SectionExpander>
      </Box>

      {/* Empty state — clearer than the old "no jobs found" muted
          note. Only rendered when there's no cached data AND no
          in-flight analysis, so the CTA card above is the loudest
          thing on the page. */}
      {!data && !loading && (
        <Box mb={4} p={4} bg="gray.50" rounded="md" textAlign="center" borderWidth="1px" borderColor="gray.200">
          <Text fontSize="sm" color="fg.muted">
            Pick a date above, then tap <Text as="span" fontWeight="semibold">Plan route</Text> to see the best order to run your day.
          </Text>
        </Box>
      )}

      {error && <Text color="red.500" fontSize="sm" mb={4}>{error}</Text>}

      {/* Server-side AI failure — red banner (loud, so operators
          immediately know the route planner didn't run rather than
          staring at raw job list wondering what's wrong). */}
      {data?.error && (
        <Box p={4} bg="red.50" borderWidth="1px" borderColor="red.300" rounded="md" mb={4}>
          <Text fontSize="sm" fontWeight="semibold" color="red.900" mb={1}>
            Route planner failed to run
          </Text>
          <Text fontSize="xs" color="red.800">{data.error}</Text>
        </Box>
      )}

      {/* Informational note (e.g. "no jobs found") — muted, low-key. */}
      {data?.message && !data.suggestions && !data.error && (
        <Box p={4} bg="gray.50" rounded="md" mb={4}>
          <Text fontSize="sm" color="fg.muted">{data.message}</Text>
        </Box>
      )}

      {data?.suggestions && (
        <VStack align="stretch" gap={4}>
          {/* Summary */}
          <Box p={4} bg="blue.50" rounded="xl" borderWidth="1px" borderColor="blue.200">
            <Text fontSize="sm" fontWeight="medium" color="blue.700" mb={3}>{data.suggestions.summary}</Text>
            {(() => {
              const jobCount = days.reduce((n, d) => n + (d.route ?? []).length, 0);
              let assumedCount = 0;
              const totalWorkMins = days.reduce((total, d) => {
                return total + (d.route ?? []).reduce((dayTotal, stop) => {
                  const job = jobMap.get(stop.occurrenceId);
                  if (!job?.estimatedMinutes) assumedCount++;
                  return dayTotal + (job?.estimatedMinutes ?? 60);
                }, 0);
              }, 0);
              const setupMins = Math.round(totalWorkMins * bufferPercent / 100);
              const driveMins = data.routing?.totalDriveMinutes ?? 0;
              const totalMins = totalWorkMins + setupMins + driveMins;
              const totalCustomerCost = days.reduce((total, d) => {
                return total + (d.route ?? []).reduce((dayTotal, stop) => {
                  const job = jobMap.get(stop.occurrenceId);
                  return dayTotal + (job?.price ?? 0);
                }, 0);
              }, 0);
              return (
                <Box display="grid" gridTemplateColumns="auto 1fr" gap={1} rowGap={1.5} fontSize="sm" maxW="320px">
                  <Text color="blue.600">Jobs:</Text>
                  <Text fontWeight="semibold" color="blue.800">{jobCount}</Text>

                  {totalCustomerCost > 0 && (
                    <>
                      <Text color="blue.600">Customer cost:</Text>
                      <Text fontWeight="semibold" color="blue.800">${totalCustomerCost.toFixed(2)}</Text>
                    </>
                  )}

                  {totalCustomerCost > 0 && (
                    <>
                      <Text color="blue.600">Est. payout:</Text>
                      <Text fontWeight="semibold" color="green.700">
                        ${(totalCustomerCost * (1 - marginPercent / 100)).toFixed(2)}
                      </Text>
                    </>
                  )}

                  {jobCount > 0 && (
                    <>
                      <Text color="blue.600" borderTop="1px solid" borderColor="blue.200" pt={1}>Job time:</Text>
                      <Text fontWeight="semibold" color="blue.800" borderTop="1px solid" borderColor="blue.200" pt={1}>~{formatDuration(totalWorkMins)}</Text>

                      <Text color="blue.600">Buffer:</Text>
                      <Text fontWeight="semibold" color="blue.800">~{formatDuration(setupMins)} ({bufferPercent}%)</Text>

                      <Text color="blue.600">Drive time:</Text>
                      <Text fontWeight="semibold" color="blue.800">{data.routing ? formatDuration(driveMins) : "N/A"}{data.routing ? ` / ${data.routing.totalDriveMiles} mi` : ""}</Text>

                      <Text color="blue.700" fontWeight="medium" borderTop="1px solid" borderColor="blue.200" pt={1}>Total time:</Text>
                      <Text fontWeight="bold" color="blue.900" fontSize="md" borderTop="1px solid" borderColor="blue.200" pt={1}>~{formatDuration(totalMins)}</Text>

                      {assumedCount > 0 && (
                        <>
                          <Text />
                          <Text fontSize="xs" color="orange.500">
                            * {assumedCount} job{assumedCount !== 1 ? "s" : ""} assumed 60 min (no duration set)
                          </Text>
                        </>
                      )}
                      {availableHours > 0 && totalMins > availableHours * 60 * 1.05 && (
                        <>
                          <Text />
                          {/* A heads-up, not a trim. Every job is still in the
                              route — the worker decides whether the day is
                              too long, not us. */}
                          <Text fontSize="xs" color="red.500" fontWeight="medium">
                            ⚠ Over your {availableHours}h setting by ~{formatDuration(Math.round(totalMins - availableHours * 60))} — all jobs still routed
                          </Text>
                        </>
                      )}
                    </>
                  )}
                </Box>
              );
            })()}
            {data.routing && (
              <Badge size="sm" colorPalette="blue" variant="subtle" mt={2}>{data.routing.provider}</Badge>
            )}
            {data.startedFromCurrentLocation && (
              <Badge size="sm" colorPalette="purple" variant="subtle" mt={2} ml={2}>
                {data.currentLocationAddress
                  ? `Started from ${data.currentLocationAddress} · one-way`
                  : "Started from current location · one-way"}
              </Badge>
            )}
            {data.routeError && (
              <Text fontSize="xs" color="orange.500" mt={2}>Route optimization note: {data.routeError}</Text>
            )}
          </Box>

          {/* Missing-data warning — jobs without an address can't be geocoded
              for distance optimization, and show as "Unknown / No address" in
              the route until their property record is filled in. */}
          {data.dataIssues && data.dataIssues.length > 0 && (() => {
            const noAddr = data.dataIssues.filter((i) => i.missingAddress).length;
            const noName = data.dataIssues.filter((i) => i.missingProperty && !i.missingAddress).length;
            return (
              <Box p={3} bg="yellow.50" rounded="md" borderWidth="1px" borderColor="yellow.300">
                <Text fontSize="sm" fontWeight="medium" color="yellow.700">
                  {data.dataIssues.length} job{data.dataIssues.length !== 1 ? "s" : ""} can't be fully optimized — missing property data
                </Text>
                <Text fontSize="xs" color="yellow.700" mt={1}>
                  {noAddr > 0 && <>{noAddr} without an address (skipped from distance optimization). </>}
                  {noName > 0 && <>{noName} without a property name. </>}
                  Open the property in Clients/Properties and fill in {noAddr > 0 ? "street/city/state" : "displayName"} so the route can include real driving distances.
                </Text>
              </Box>
            );
          })()}

          {/* Date change warning */}
          {dateChangeCount > 0 && (
            <Box p={3} bg="orange.50" rounded="md" borderWidth="1px" borderColor="orange.300">
              <Text fontSize="sm" fontWeight="medium" color="orange.700">
                {dateChangeCount} job{dateChangeCount !== 1 ? "s" : ""} from other days could be added to this route
              </Text>
              <Text fontSize="xs" color="orange.600" mt={1}>
                These jobs are currently scheduled for different dates. You'd need to contact the client to confirm moving them. No changes have been made.
              </Text>
            </Box>
          )}

          {/* Route for each day (usually just the target day + maybe overflow) */}
          {days.map((day) => (
            <Box key={day.date}>
              <HStack justify="space-between" mb={2} px={1}>
                <VStack align="start" gap={0}>
                  <Text fontSize="sm" fontWeight="semibold">{day.dayLabel}</Text>
                  <Text fontSize="xs" color="fg.muted">{day.daySummary}</Text>
                </VStack>
                <VStack align="end" gap={0}>
                  {day.estimatedEarnings > 0 && (
                    <Text fontSize="xs" color="green.600" fontWeight="medium">${day.estimatedEarnings.toFixed(2)}</Text>
                  )}
                  {day.estimatedHours > 0 && (
                    <Text fontSize="xs" color="fg.muted">{formatDuration(Math.round(day.estimatedHours * 60))}</Text>
                  )}
                </VStack>
              </HStack>

              {(day.route ?? []).length > 0 && (
                <Button
                  size="sm"
                  variant="solid"
                  colorPalette="blue"
                  mb={2}
                  onClick={() => {
                    const stops = (day.route ?? []).map((s) => s.address).filter(Boolean);
                    if (stops.length === 0) return;
                    if (stops.length === 1) {
                      window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stops[0])}`, "_blank");
                    } else {
                      const origin = encodeURIComponent(stops[0]);
                      const destination = encodeURIComponent(stops[stops.length - 1]);
                      const waypoints = stops.slice(1, -1).map(encodeURIComponent).join("|");
                      window.open(`https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypoints ? `&waypoints=${waypoints}` : ""}`, "_blank");
                    }
                  }}
                >
                  Launch Route in Maps ({(day.route ?? []).length} stop{(day.route ?? []).length !== 1 ? "s" : ""})
                </Button>
              )}
              <VStack align="stretch" gap={2}>
                {(day.route ?? []).map((stop, idx) => {
                  const job = jobMap.get(stop.occurrenceId);
                  const isClaimed = job?.type === "claimed";
                  return (
                    <Card.Root
                      key={stop.occurrenceId}
                      variant="outline"
                      borderColor={stop.dateChanged ? "orange.300" : isClaimed ? "teal.200" : undefined}
                      bg={stop.dateChanged ? "orange.50" : isClaimed ? "teal.50" : undefined}
                    >
                      <Card.Body py="2" px="3">
                        <HStack gap={3} align="start">
                          <Box
                            w="28px"
                            h="28px"
                            borderRadius="full"
                            bg={stop.dateChanged ? "orange.500" : isClaimed ? "teal.500" : "blue.500"}
                            color="white"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                            fontSize="xs"
                            fontWeight="bold"
                            flexShrink={0}
                            mt="1px"
                          >
                            {idx + 1}
                          </Box>
                          <VStack align="start" gap={1} flex="1" minW={0}>
                            <HStack gap={2} wrap="wrap">
                              <Text fontSize="sm" fontWeight="medium">{stop.property}{job?.client ? ` — ${job.client}` : ""}</Text>
                              {isClaimed || claimedIds.has(stop.occurrenceId) ? (
                                <Badge colorPalette="teal" variant="solid" fontSize="xs" borderRadius="full" px="2">Claimed</Badge>
                              ) : (
                                <>
                                  <Badge colorPalette="blue" variant="outline" fontSize="xs" borderRadius="full" px="2">Available</Badge>
                                  <Button
                                    size="xs"
                                    colorPalette="teal"
                                    variant="solid"
                                    disabled={claimingId === stop.occurrenceId}
                                    onClick={(e) => { e.stopPropagation(); claimJob(stop.occurrenceId, job); }}
                                  >
                                    {claimingId === stop.occurrenceId ? "Claiming..." : userId ? "Assign" : "Claim"}
                                  </Button>
                                </>
                              )}
                              {job?.price != null && (
                                <Badge colorPalette="green" variant="solid" fontSize="xs" borderRadius="full" px="2">
                                  ${job.price.toFixed(2)}
                                </Badge>
                              )}
                              {job?.estimatedMinutes != null && (
                                <Text fontSize="xs" color="fg.muted">~{formatDuration(job.estimatedMinutes)}</Text>
                              )}
                            </HStack>

                            {stop.dateChanged && (
                              <HStack gap={1} fontSize="xs" wrap="wrap" align="center">
                                {rescheduledIds.has(stop.occurrenceId) ? (
                                  <Badge colorPalette="green" variant="solid" fontSize="xs" borderRadius="full" px="2">
                                    Rescheduled
                                  </Badge>
                                ) : (
                                  <>
                                    <Badge colorPalette="orange" variant="solid" fontSize="xs" borderRadius="full" px="2">
                                      Reschedule needed
                                    </Badge>
                                    <Text color="orange.600">
                                      Currently {stop.originalDate ? fmtDate(stop.originalDate + "T12:00:00Z") : "unscheduled"} → {stop.suggestedDate ? fmtDate(stop.suggestedDate + "T12:00:00Z") : fmtDate(day.date + "T12:00:00Z")}
                                    </Text>
                                    <Button
                                      size="xs"
                                      colorPalette="orange"
                                      variant="solid"
                                      disabled={reschedulingId === stop.occurrenceId}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        rescheduleJob(
                                          stop.occurrenceId,
                                          stop.suggestedDate || day.date,
                                          job,
                                        );
                                      }}
                                    >
                                      {reschedulingId === stop.occurrenceId ? "Moving..." : "Move"}
                                    </Button>
                                  </>
                                )}
                              </HStack>
                            )}

                            <Box fontSize="xs">
                              <MapLink address={stop.address} />
                            </Box>
                            <Text fontSize="xs" color="fg.muted" fontStyle="italic">
                              {stop.reason}
                            </Text>
                            {userId && job && (
                              <Button
                                size="xs"
                                variant="outline"
                                colorPalette="blue"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openEventSearch(
                                    "jobsTabToServicesTabSearch",
                                    stop.property,
                                    true,
                                    `${job?.jobId ?? ""}:${stop.occurrenceId}`,
                                  );
                                }}
                              >
                                Manage in Services
                              </Button>
                            )}
                          </VStack>
                        </HStack>
                      </Card.Body>
                    </Card.Root>
                  );
                })}
              </VStack>
            </Box>
          ))}

          {/* Additional recommendations */}
          {data.suggestions.additionalJobsToConsider && data.suggestions.additionalJobsToConsider.length > 0 && (
            <Box mt={2}>
              <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2} textTransform="uppercase" letterSpacing="wide">
                Also Consider Claiming
              </Text>
              <VStack align="stretch" gap={1}>
                {data.suggestions.additionalJobsToConsider.map((id) => {
                  const job = jobMap.get(id);
                  if (!job) return null;
                  return (
                    <HStack key={id} fontSize="xs" px={2} py={1} bg="gray.50" rounded="md" gap={2} wrap="wrap">
                      <Text fontWeight="medium">{job.property}{job.client ? ` — ${job.client}` : ""}</Text>
                      <Text color="fg.muted">{job.city}</Text>
                      {job.currentDate && <Text color="fg.muted">{fmtDate(job.currentDate + "T12:00:00Z")}</Text>}
                      {job.price != null && <Badge colorPalette="green" variant="solid" fontSize="xs" px="1.5" borderRadius="full">${job.price.toFixed(2)}</Badge>}
                      {claimedIds.has(id) ? (
                        <Badge colorPalette="teal" variant="solid" fontSize="xs" borderRadius="full" px="2">Claimed</Badge>
                      ) : (
                        <Button
                          size="xs"
                          colorPalette="teal"
                          variant="solid"
                          disabled={claimingId === id}
                          onClick={() => claimJob(id, job)}
                        >
                          {claimingId === id ? "Claiming..." : userId ? "Assign" : "Claim"}
                        </Button>
                      )}
                    </HStack>
                  );
                })}
              </VStack>
            </Box>
          )}
        </VStack>
      )}

      {/* Raw fallback */}
      {data?.raw && (
        <Box p={4} bg="gray.50" rounded="md" whiteSpace="pre-wrap" fontSize="sm">
          {data.raw}
        </Box>
      )}

      {/* All jobs listing — collapsed by default (redundant with the
          visible route when everything's shown up top). Kept for the
          "let me browse everything" case. */}
      {data?.jobs && data.jobs.length > 0 && (
        <Box mt={6}>
          <SectionExpander
            title={`All available jobs (${data.jobs.length})`}
            storageKey="routesTab_allJobsOpen"
          >
            <VStack align="stretch" gap={1}>
              {data.jobs.map((job) => (
                <HStack key={job.id} fontSize="xs" px={2} py={1.5} borderWidth="1px" rounded="md" gap={2} justify="space-between">
                  <HStack gap={2} flex="1" minW={0}>
                    <Badge
                      colorPalette={job.type === "claimed" ? "teal" : "gray"}
                      variant={job.type === "claimed" ? "solid" : "outline"}
                      fontSize="xs"
                      px="1.5"
                      borderRadius="full"
                    >
                      {job.type === "claimed" ? "Claimed" : "Open"}
                    </Badge>
                    {job.isEstimate && (
                      <Badge colorPalette="purple" variant="solid" fontSize="xs" px="1.5" borderRadius="full">
                        Estimate
                      </Badge>
                    )}
                    <Text fontWeight="medium" truncate>{job.property}{job.client ? ` — ${job.client}` : ""}</Text>
                    <Text color="fg.muted" truncate>{job.city}</Text>
                  </HStack>
                  <HStack gap={2} flexShrink={0}>
                    {job.currentDate && <Text color="fg.muted">{fmtDate(job.currentDate + "T12:00:00Z")}</Text>}
                    {job.price != null && <Text color="green.600">${job.price.toFixed(2)}</Text>}
                    {job.estimatedMinutes != null && <Text color="fg.muted">~{formatDuration(job.estimatedMinutes)}</Text>}
                  </HStack>
                </HStack>
              ))}
            </VStack>
          </SectionExpander>
        </Box>
      )}
    </Box>
  );
}
