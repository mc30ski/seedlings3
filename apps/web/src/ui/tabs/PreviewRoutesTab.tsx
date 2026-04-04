"use client";

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
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { MapLink } from "@/src/ui/helpers/Link";
import { type Me } from "@/src/lib/types";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import { fmtDate, bizDateKey } from "@/src/lib/lib";

type RouteJob = {
  id: string;
  type: "claimable" | "claimed";
  property: string;
  address: string;
  city: string;
  price: number | null;
  estimatedMinutes: number | null;
  kind: string;
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

type Response = {
  suggestions: Suggestions | null;
  raw?: string;
  message?: string;
  jobs: RouteJob[];
  targetUser?: { id: string; displayName: string | null };
  routing?: RoutingInfo | null;
  routeError?: string | null;
};

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

type Props = {
  userId?: string;
};

const STORAGE_KEY_PREFIX = "preview_routeResults";

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

export default function PreviewRoutesTab({ userId }: Props = {}) {
  const [data, setData] = useState<Response | null>(() => loadCachedResults(userId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Target day = the day to optimize a route for (always defaults to tomorrow on mount)
  const todayStr = bizDateKey(new Date());
  const tomorrowStr = bizDateKey(addDays(new Date(), 1));
  const [targetDate, setTargetDate] = useState(tomorrowStr);

  const dateBadge = targetDate === todayStr ? "Today" : targetDate === tomorrowStr ? "Tomorrow" : null;

  // Look-ahead = how far to look for jobs that could be pulled into the target day
  const [lookAhead, setLookAhead] = usePersistedState("preview_lookAhead", 5);

  // Available hours in the day — defaults from profile
  const [availableHours, setAvailableHours] = usePersistedState("preview_availableHours", 0);
  const [profileHoursLoaded, setProfileHoursLoaded] = useState(false);

  // Buffer time between jobs (percentage)
  const [bufferPercent, setBufferPercent] = usePersistedState("preview_buffer", 20);

  // Mode: "claimed" = only optimize route for claimed jobs, "suggest" = also suggest new jobs to claim
  const [mode, setMode] = usePersistedState<"claimed" | "suggest">("preview_mode", "claimed");

  // Routing provider
  const [routingProvider, setRoutingProvider] = usePersistedState("preview_routingProvider", "mapbox");
  const providerOptions = [{ value: "mapbox", label: "Mapbox" }];

  const [homeBase, setHomeBase] = useState("");
  const [homeBaseLoaded, setHomeBaseLoaded] = useState(false);
  const [homeBaseSaving, setHomeBaseSaving] = useState(false);

  useEffect(() => {
    const endpoint = userId ? `/api/admin/users/${userId}` : "/api/me";
    apiGet<any>(endpoint)
      .then((u) => {
        setHomeBase(u?.homeBaseAddress ?? "");
        setHomeBaseLoaded(true);
        const profileHours = u?.availableHoursPerDay ?? 4;
        setAvailableHours(profileHours);
        setProfileHoursLoaded(true);
      })
      .catch(() => { setHomeBaseLoaded(true); setProfileHoursLoaded(true); });
  }, []);

  async function saveHomeBase() {
    setHomeBaseSaving(true);
    try {
      await apiPatch("/api/me/home-base", { address: homeBase });
      publishInlineMessage({ type: "SUCCESS", text: "Home base saved." });
    } catch {}
    setHomeBaseSaving(false);
  }

  async function loadSuggestions() {
    setLoading(true);
    setError(null);
    try {
      const userParam = userId ? `&userId=${userId}` : "";
      const params = `targetDate=${targetDate}&bufferPercent=${bufferPercent}&mode=${mode}&routingProvider=${routingProvider}` +
        (mode === "suggest" ? `&lookAhead=${lookAhead}&availableHours=${availableHours}` : "") +
        userParam;
      const res = await apiGet<Response>(`/api/preview/route-suggestions?${params}`);
      setData(res);
      saveCachedResults(res, userId);
    } catch (err: any) {
      console.error("Route suggestions failed:", err);
      setError(err?.message || "Failed to load suggestions");
      setData(null);
      saveCachedResults(null, userId);
    }
    setLoading(false);
  }

  function clearResults() {
    setData(null);
    saveCachedResults(null, userId);
    setClaimedIds(new Set());
  }

  // Track which jobs are being claimed or have been claimed
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimedIds, setClaimedIds] = useState<Set<string>>(new Set());

  async function claimJob(occurrenceId: string, job: any) {
    setClaimingId(occurrenceId);
    try {
      // Calculate new start date based on targetDate, preserving duration if multi-day
      const patchData: any = { startAt: targetDate + "T09:00:00Z" };
      if (job?.startAt && job?.endAt) {
        const origStart = new Date(job.startAt).getTime();
        const origEnd = new Date(job.endAt).getTime();
        const durationMs = origEnd - origStart;
        const newStart = new Date(targetDate + "T09:00:00Z");
        patchData.startAt = newStart.toISOString();
        patchData.endAt = new Date(newStart.getTime() + durationMs).toISOString();
      }

      if (userId) {
        // Admin claiming on behalf of a worker — use admin assign endpoint
        await apiPost(`/api/admin/occurrences/${occurrenceId}/add-assignee`, { userId });
        // Update the date via admin endpoint
        if (job?.startAt !== targetDate) {
          await apiPatch(`/api/admin/occurrences/${occurrenceId}`, patchData);
        }
      } else {
        // Worker claiming for themselves
        await apiPost(`/api/occurrences/${occurrenceId}/claim`, {});
        // Update the date to the target date
        if (job?.startAt !== targetDate) {
          await apiPatch(`/api/occurrences/${occurrenceId}`, patchData);
        }
      }

      setClaimedIds((prev) => new Set(prev).add(occurrenceId));
      publishInlineMessage({ type: "SUCCESS", text: `Job claimed and scheduled for ${fmtDate(targetDate + "T12:00:00Z")}.` });
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


  const jobMap = new Map((data?.jobs ?? []).map((j) => [j.id, j]));
  const days = data?.suggestions?.days ?? [];
  const dateChangeCount = data?.suggestions?.dateChangeCount ?? 0;

  return (
    <Box w="full" pb={8}>
      <Box mb={3} p={3} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
        <Text fontSize="sm" fontWeight="medium" color="yellow.700">AI + Mapping Feature</Text>
        <Text fontSize="xs" color="yellow.600">Routes are optimized using real driving distances from a mapping provider and refined by AI. Results should be used as a starting point, not a final plan.</Text>
      </Box>

      {/* Home base */}
      <Box mb={3} p={3} bg="gray.50" rounded="md" borderWidth="1px">
        <Text fontSize="xs" fontWeight="medium" mb={1}>Home Base</Text>
        <HStack gap={2}>
          <Input
            size="sm"
            value={homeBaseLoaded ? homeBase : ""}
            onChange={(e) => setHomeBase(e.target.value)}
            placeholder={homeBaseLoaded ? "e.g. 123 Main St, Chapel Hill, NC" : "Loading..."}
            disabled={!homeBaseLoaded}
          />
          <Button size="sm" onClick={saveHomeBase} loading={homeBaseSaving} disabled={!homeBaseLoaded}>
            Save
          </Button>
        </HStack>
      </Box>

      {/* Mode toggle */}
      <Box mb={3}>
        <HStack gap={2}>
          <Button
            size="sm"
            variant={mode === "claimed" ? "solid" : "outline"}
            colorPalette={mode === "claimed" ? "blue" : "gray"}
            onClick={() => setMode("claimed")}
          >
            Claimed Only
          </Button>
          <Button
            size="sm"
            variant={mode === "suggest" ? "solid" : "outline"}
            colorPalette={mode === "suggest" ? "blue" : "gray"}
            onClick={() => setMode("suggest")}
          >
            Suggest Additional Jobs
          </Button>
        </HStack>
        <HStack gap={2} mt={2} align="center">
          <Text fontSize="xs" color="fg.muted">
            {mode === "claimed"
              ? "Optimize the route for jobs you've already claimed."
              : "Also suggest nearby available jobs to fill your day."}
          </Text>
          <HStack gap={1} flexShrink={0} align="center">
            <Text fontSize="xs" color="fg.muted">Map:</Text>
            <select
              value={routingProvider}
              onChange={(e) => setRoutingProvider(e.target.value)}
              style={{
                fontSize: "12px",
                padding: "2px 6px",
                borderRadius: "4px",
                border: "1px solid #e2e8f0",
                background: "#fff",
              }}
            >
              {providerOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </HStack>
        </HStack>
      </Box>

      {/* Planning controls */}
      <Box mb={3} p={3} bg="gray.50" rounded="md" borderWidth="1px">
        <HStack gap={4} wrap="wrap" align="flex-end">
          <Box flex="1" minW="140px">
            <HStack mb={1} gap={2}>
              <Text fontSize="xs" fontWeight="medium">Plan for date</Text>
              {dateBadge && <Badge size="sm" colorPalette="blue" variant="subtle">{dateBadge}</Badge>}
            </HStack>
            <Input
              type="date"
              size="sm"
              value={targetDate}
              min={todayStr}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </Box>
          <Box flex="1" minW="140px">
            <HStack justify="space-between" mb={1}>
              <Text fontSize="xs" fontWeight="medium">Travel/Setup buffer</Text>
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
        </HStack>
        {mode === "suggest" && (
          <HStack gap={4} wrap="wrap" align="flex-end" mt={3}>
            <Box flex="1" minW="140px">
              <HStack justify="space-between" mb={1}>
                <Text fontSize="xs" fontWeight="medium">Consider jobs within</Text>
                <Text fontSize="xs" color="fg.muted" fontWeight="medium">±{lookAhead} days</Text>
              </HStack>
              <input
                type="range"
                min={0}
                max={5}
                value={lookAhead}
                onChange={(e) => setLookAhead(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--chakra-colors-blue-500)" }}
              />
              <HStack justify="space-between" fontSize="xs" color="fg.muted">
                <Text>Same day only</Text>
                <Text>5 days</Text>
              </HStack>
            </Box>
            <Box flex="1" minW="140px">
              <HStack justify="space-between" mb={1}>
                <Text fontSize="xs" fontWeight="medium">Available hours</Text>
                <Text fontSize="xs" color="fg.muted" fontWeight="medium">{availableHours}h</Text>
              </HStack>
              <input
                type="range"
                min={2}
                max={12}
                value={availableHours}
                onChange={(e) => setAvailableHours(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--chakra-colors-blue-500)" }}
              />
              <HStack justify="space-between" fontSize="xs" color="fg.muted">
                <Text>2h</Text>
                <Text>12h</Text>
              </HStack>
            </Box>
          </HStack>
        )}
      </Box>

      <HStack justify="space-between" mb={4}>
        <VStack align="start" gap={0}>
          <Text fontSize="lg" fontWeight="semibold">Route Planner</Text>
          <Text fontSize="xs" color="fg.muted">
            Optimizing {fmtDate(targetDate + "T12:00:00Z")}
            {lookAhead > 0 ? ` · considering jobs ±${lookAhead} day${lookAhead !== 1 ? "s" : ""}` : ""}
          </Text>
        </VStack>
        <HStack gap={2}>
          <Button size="sm" onClick={loadSuggestions} loading={loading}>
            Analyze
          </Button>
          {data && (
            <Button size="sm" variant="ghost" onClick={clearResults}>
              Clear
            </Button>
          )}
        </HStack>
      </HStack>

      {loading && !data && (
        <Box textAlign="center" py={10}>
          <Spinner size="lg" />
          <Text fontSize="sm" color="fg.muted" mt={2}>Analyzing available jobs...</Text>
        </Box>
      )}

      {error && <Text color="red.500" fontSize="sm" mb={4}>{error}</Text>}

      {data?.message && !data.suggestions && (
        <Box p={4} bg="gray.50" rounded="md" mb={4}>
          <Text fontSize="sm" color="fg.muted">{data.message}</Text>
        </Box>
      )}

      {data?.suggestions && (
        <VStack align="stretch" gap={4}>
          {/* Summary */}
          <Box p={4} bg="blue.50" rounded="xl" borderWidth="1px" borderColor="blue.200">
            <Text fontSize="sm" fontWeight="medium" color="blue.700">{data.suggestions.summary}</Text>
            <HStack gap={4} mt={2} wrap="wrap">
              {data.suggestions.totalEstimatedEarnings > 0 && (
                <Text fontSize="xs" color="blue.600">
                  Est. earnings: ${data.suggestions.totalEstimatedEarnings.toFixed(2)}
                </Text>
              )}
              <Text fontSize="xs" color="blue.600">
                {days.reduce((n, d) => n + (d.route ?? []).length, 0)} jobs in route
              </Text>
              {data.routing && (
                <Text fontSize="xs" color="blue.600">
                  Drive: {formatDuration(data.routing.totalDriveMinutes)} / {data.routing.totalDriveMiles} mi
                </Text>
              )}
              {data.routing && (
                <Badge size="sm" colorPalette="blue" variant="subtle">{data.routing.provider}</Badge>
              )}
            </HStack>
            {data.routeError && (
              <Text fontSize="xs" color="orange.500" mt={1}>Route optimization note: {data.routeError}</Text>
            )}
          </Box>

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
                      <Card.Body py="3" px="4">
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
                              <Text fontSize="sm" fontWeight="medium">{stop.property}</Text>
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
                              <HStack gap={1} fontSize="xs" wrap="wrap">
                                <Badge colorPalette="orange" variant="solid" fontSize="xs" borderRadius="full" px="2">
                                  Reschedule needed
                                </Badge>
                                <Text color="orange.600">
                                  Currently {stop.originalDate ? fmtDate(stop.originalDate + "T12:00:00Z") : "unscheduled"} → move to {stop.suggestedDate ? fmtDate(stop.suggestedDate + "T12:00:00Z") : fmtDate(day.date + "T12:00:00Z")}
                                </Text>
                              </HStack>
                            )}

                            <Box fontSize="xs">
                              <MapLink address={stop.address} />
                            </Box>
                            <Text fontSize="xs" color="fg.muted" fontStyle="italic">
                              {stop.reason}
                            </Text>
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
                      <Text fontWeight="medium">{job.property}</Text>
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

      {/* All jobs listing */}
      {data?.jobs && data.jobs.length > 0 && (
        <Box mt={6}>
          <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2} textTransform="uppercase" letterSpacing="wide">
            All Available Jobs ({data.jobs.length})
          </Text>
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
                  <Text fontWeight="medium" truncate>{job.property}</Text>
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
        </Box>
      )}
    </Box>
  );
}
