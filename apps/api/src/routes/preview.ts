import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/prisma";
import Anthropic from "@anthropic-ai/sdk";
import { getRoutingProvider, AVAILABLE_PROVIDERS, type OptimizedRoute } from "../lib/routing";

const workerGuard = {
  preHandler: (req: FastifyRequest, reply: FastifyReply) =>
    (req.server as any).requireRole(req, reply, "WORKER"),
};

async function currentUserId(req: any): Promise<string> {
  return (req as any).user?.id;
}

export default async function previewRoutes(app: FastifyInstance) {
  app.get("/preview/route-suggestions", workerGuard, async (req: any) => {
    const userId = await currentUserId(req);
    const targetUserIdParam = req.query?.userId as string | undefined;
    const targetUserId = targetUserIdParam || userId;

    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, displayName: true, email: true, workerType: true, homeBaseAddress: true, availableDays: true, availableHoursPerDay: true },
    });
    if (!user) throw app.httpErrors.notFound("User not found.");

    const mode = (req.query?.mode as string) === "suggest" ? "suggest" : "claimed";
    const lookAhead = mode === "suggest" ? Math.min(Math.max(Number(req.query?.lookAhead) || 5, 0), 5) : 0;
    const availableHours = mode === "suggest" ? Math.min(Math.max(Number(req.query?.availableHours) || (user.availableHoursPerDay ?? 4), 2), 12) : 0;
    const bufferPercent = Math.min(Math.max(Number(req.query?.bufferPercent) || 20, 0), 50);
    const availableDays: number[] = user.availableDays ? JSON.parse(user.availableDays) : [];
    const now = new Date();
    // Target date = the specific day to plan a route for
    const targetDateParam = req.query?.targetDate as string | undefined;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetStr = targetDateParam || tomorrow.toISOString().slice(0, 10);
    // Search range: lookAhead days before AND after target date, but never before today
    const todayStr = now.toISOString().slice(0, 10);
    const rangeStartDate = new Date(targetStr + "T12:00:00Z");
    rangeStartDate.setDate(rangeStartDate.getDate() - lookAhead);
    const startStr = rangeStartDate.toISOString().slice(0, 10) < todayStr ? todayStr : rangeStartDate.toISOString().slice(0, 10);
    const endDate = new Date(targetStr + "T12:00:00Z");
    endDate.setDate(endDate.getDate() + lookAhead + 1);
    const endStr = endDate.toISOString().slice(0, 10);

    // Fetch claimable occurrences only in "suggest" mode
    // When admin is running routes (userId param set), include estimates in suggestions
    // When worker is running their own routes, exclude estimates (must be admin-assigned)
    const isAdminRoute = !!targetUserIdParam;
    const claimable = mode === "suggest" ? await prisma.jobOccurrence.findMany({
      where: {
        status: "SCHEDULED",
        assignees: { none: {} },
        ...(isAdminRoute ? {} : { isAdminOnly: false }),
        isTentative: false,
        ...(isAdminRoute ? {} : { workflow: { not: "ESTIMATE" } }),
        OR: [
          { startAt: { gte: new Date(startStr + "T00:00:00Z"), lt: new Date(endStr + "T00:00:00Z") } },
          { startAt: null },
        ],
      },
      include: {
        job: {
          include: {
            property: {
              select: { id: true, displayName: true, street1: true, city: true, state: true },
            },
          },
        },
      },
    }) : [];

    // Fetch already-claimed by this user
    const claimed = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        assignees: { some: { userId: targetUserId } },
        OR: [
          { startAt: { gte: new Date(startStr + "T00:00:00Z"), lt: new Date(endStr + "T00:00:00Z") } },
          { startAt: null },
        ],
      },
      include: {
        job: {
          include: {
            property: {
              select: { id: true, displayName: true, street1: true, city: true, state: true },
            },
          },
        },
        assignees: {
          include: { user: { select: { id: true, displayName: true } } },
        },
      },
    });

    // Fetch properties this worker has previously serviced
    const pastOccurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: "CLOSED",
        assignees: { some: { userId: targetUserId } },
      },
      select: {
        job: {
          select: {
            property: {
              select: { id: true, displayName: true, city: true },
            },
          },
        },
        completedAt: true,
      },
      orderBy: { completedAt: "desc" },
      take: 100,
    });

    // Dedupe into a map of propertyId → { name, city, count, lastDate }
    const historyMap = new Map<string, { name: string; city: string; count: number; lastDate: string | null }>();
    for (const occ of pastOccurrences) {
      const prop = occ.job?.property;
      if (!prop) continue;
      const existing = historyMap.get(prop.id);
      if (existing) {
        existing.count++;
      } else {
        historyMap.set(prop.id, {
          name: prop.displayName,
          city: prop.city ?? "",
          count: 1,
          lastDate: occ.completedAt?.toISOString()?.slice(0, 10) ?? null,
        });
      }
    }
    const workerHistory = Array.from(historyMap.values());

    const formatOcc = (occ: any, type: "claimable" | "claimed") => {
      const prop = occ.job?.property;
      const address = [prop?.street1, prop?.city, prop?.state].filter(Boolean).join(", ");
      return {
        id: occ.id,
        type,
        property: prop?.displayName ?? "Unknown",
        address: address || "No address",
        city: prop?.city ?? "Unknown",
        price: occ.price ?? occ.job?.defaultPrice ?? null,
        estimatedMinutes: occ.estimatedMinutes ?? occ.job?.estimatedMinutes ?? null,
        kind: occ.kind,
        currentDate: occ.startAt?.toISOString()?.slice(0, 10) ?? null,
      };
    };

    const allJobs = [
      ...claimed.map((o) => formatOcc(o, "claimed")),
      ...claimable.map((o) => formatOcc(o, "claimable")),
    ];

    if (allJobs.length === 0) {
      return {
        suggestions: null,
        message: `No available or claimed jobs found for ${targetStr}${lookAhead > 0 ? ` (or within ${lookAhead} days)` : ""}.`,
        jobs: [],
      };
    }

    // Route optimization using the selected provider
    const routingProviderName = (req.query?.routingProvider as string) || "mapbox";
    let optimizedRoute: OptimizedRoute | null = null;
    let routeError: string | null = null;

    try {
      const router = getRoutingProvider(routingProviderName);

      // Geocode all job addresses + home base
      const addresses = allJobs.map((j) => j.address);
      const geocoded = await router.geocodeMany(addresses);

      // Filter to jobs that were successfully geocoded
      const validIndices: number[] = [];
      const validCoords: { lng: number; lat: number }[] = [];
      for (let i = 0; i < geocoded.length; i++) {
        if (geocoded[i]) {
          validIndices.push(i);
          validCoords.push(geocoded[i]!.coordinates);
        }
      }

      // Geocode home base if available
      let homeCoords: { lng: number; lat: number } | undefined;
      if (user.homeBaseAddress) {
        const homeGeo = await router.geocode(user.homeBaseAddress);
        if (homeGeo) homeCoords = homeGeo.coordinates;
      }

      if (validCoords.length > 1) {
        optimizedRoute = await router.optimizeRoute(validCoords, {
          startCoords: homeCoords,
          roundTrip: !!homeCoords,
        });

        // Map the optimized indices back to allJobs indices
        for (const stop of optimizedRoute.stops) {
          stop.inputIndex = validIndices[stop.inputIndex] ?? stop.inputIndex;
        }
      }
    } catch (err: any) {
      routeError = err.message;
      app.log.warn({ where: "preview/route-optimization", err: err.message });
    }

    // Enforce time budget: trim claimable jobs that don't fit
    if (mode === "suggest" && availableHours > 0 && optimizedRoute && optimizedRoute.stops.length > 0) {
      const budgetMins = availableHours * 60 * 1.05; // 5% flexibility
      const totalDriveMins = Math.round(optimizedRoute.totalDuration / 60);

      // Calculate total work + setup for all jobs in the optimized order
      let workMins = 0;
      for (const stop of optimizedRoute.stops) {
        const job = allJobs[stop.inputIndex];
        if (job) workMins += (job.estimatedMinutes ?? 60);
      }
      const setupMins = Math.round(workMins * bufferPercent / 100);
      const totalMins = workMins + setupMins + totalDriveMins;

      // If over budget, remove claimable jobs from the end of the route until it fits
      if (totalMins > budgetMins) {
        // Build a list of stop indices that are claimable (can be removed)
        const removableStopIndices: number[] = [];
        for (let i = optimizedRoute.stops.length - 1; i >= 0; i--) {
          const job = allJobs[optimizedRoute.stops[i].inputIndex];
          if (job?.type === "claimable") removableStopIndices.push(i);
        }

        let currentWork = workMins;
        let currentDrive = totalDriveMins;
        const removedJobIndices = new Set<number>();

        for (const si of removableStopIndices) {
          const currentSetup = Math.round(currentWork * bufferPercent / 100);
          if (currentWork + currentSetup + currentDrive <= budgetMins) break;

          const stop = optimizedRoute.stops[si];
          const job = allJobs[stop.inputIndex];
          if (job) {
            currentWork -= (job.estimatedMinutes ?? 60);
            currentDrive -= Math.round(stop.durationFromPrev / 60);
            removedJobIndices.add(stop.inputIndex);
          }
        }

        // Filter jobs and re-optimize if we removed any
        if (removedJobIndices.size > 0) {
          optimizedRoute.stops = optimizedRoute.stops.filter(
            (s) => !removedJobIndices.has(s.inputIndex)
          );
          // Recalculate totals
          let newDuration = 0;
          let newDistance = 0;
          for (const s of optimizedRoute.stops) {
            newDuration += s.durationFromPrev;
            newDistance += s.distanceFromPrev;
          }
          optimizedRoute.totalDuration = newDuration;
          optimizedRoute.totalDistance = newDistance;

          // Also remove from allJobs so Claude doesn't suggest them
          for (const idx of Array.from(removedJobIndices).sort((a, b) => b - a)) {
            allJobs.splice(idx, 1);
          }
          // Re-map stop inputIndex after splice
          for (const stop of optimizedRoute.stops) {
            let offset = 0;
            for (const removed of Array.from(removedJobIndices).sort((a, b) => a - b)) {
              if (removed < stop.inputIndex) offset++;
            }
            stop.inputIndex -= offset;
          }
        }
      }
    }

    // Build route context for Claude
    let routeContext = "";
    if (optimizedRoute && optimizedRoute.stops.length > 0) {
      const totalMins = Math.round(optimizedRoute.totalDuration / 60);
      const totalMiles = Math.round(optimizedRoute.totalDistance / 1609.34 * 10) / 10;
      routeContext = `\n\nROUTE OPTIMIZATION DATA (from ${routingProviderName}, real driving distances):
Total driving time: ${totalMins} minutes (${totalMiles} miles)
Optimized stop order (by driving efficiency):
${optimizedRoute.stops.map((s, i) => {
  const job = allJobs[s.inputIndex];
  const driveMins = Math.round(s.durationFromPrev / 60);
  const driveMiles = Math.round(s.distanceFromPrev / 1609.34 * 10) / 10;
  return `  ${i + 1}. ${job?.property ?? "?"} (${job?.address ?? "?"}) — ${driveMins} min / ${driveMiles} mi from previous stop`;
}).join("\n")}

IMPORTANT: Use this optimized order as the basis for your route. The driving times above are REAL — use them instead of guessing. You may adjust the order slightly based on time constraints, job priority, or scheduling needs, but explain why.`;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        suggestions: null,
        message: "Route suggestions are not configured. Add ANTHROPIC_API_KEY to enable.",
        jobs: allJobs,
      };
    }

    const client = new Anthropic({ apiKey });

    const jobsJson = JSON.stringify(allJobs, null, 2);

    const modeInstructions = mode === "claimed"
      ? `MODE: Claimed Only — optimize the route order for ONLY the jobs this worker has already claimed. Do not suggest additional jobs. Focus purely on the most efficient ordering and travel path.

Rules:
1. ${user.homeBaseAddress ? `Route should start and end near the worker's home base (${user.homeBaseAddress})` : "Route should minimize total driving"}
2. All claimed jobs must be included — just find the optimal order
3. Setup buffer: ${bufferPercent}% — add this on top of each job's estimated work time for setup/teardown (unloading equipment, etc.). Travel time is calculated separately by the mapping provider.
4. Prioritize properties the worker has previously serviced — they know the property and can work more efficiently there`
      : `MODE: Suggest Additional Jobs — optimize the route AND suggest additional available jobs to fill the day.

STRICT TIME BUDGET: ${availableHours} hours TOTAL. This means work time + driving time combined must not exceed ${availableHours}h (with up to 5% flexibility = max ${Math.round(availableHours * 1.05 * 60)} minutes total). If driving alone takes 1.5h and the budget is ${availableHours}h, you only have ${Math.round((availableHours - 1.5) * 60)} minutes of actual work time. Do the math before selecting jobs.
Setup buffer: ${bufferPercent}% — add this percentage on top of each job's estimated work time for setup/teardown only (unloading, walking the property, etc.). Travel time between stops is calculated separately by the mapping provider and shown in the route data above. For example, a 60-min job with ${bufferPercent}% buffer = ${Math.round(60 * (1 + bufferPercent / 100))} min work time.
${lookAhead > 0 ? `Also considering jobs from ${lookAhead} days before and after ${targetStr} (but not before today) that could be moved to ${targetStr} for a better route.` : "Only considering jobs scheduled for this day."}

Rules:
1. ${user.homeBaseAddress ? `Route should start and end near the worker's home base (${user.homeBaseAddress})` : "Route should minimize total driving"}
2. Start with jobs already scheduled for ${targetStr} — these are the core of the route
3. Look at jobs from other days nearby — if moving them to ${targetStr} would create a tighter geographic cluster and a more efficient day, suggest it
4. Already claimed jobs for ${targetStr} must be included
5. For jobs from other days, clearly flag that a reschedule is needed (the worker must contact the client first)
6. Don't suggest moving ALL jobs to one day — only suggest moves that genuinely improve the route
7. Prioritize properties the worker has previously serviced — they know the property and can work more efficiently there`;

    const prompt = `You are a route optimizer for a lawn care service. A worker needs to plan the most efficient route for a specific day.

Worker: ${user.displayName ?? user.email ?? "Unknown"}
${user.homeBaseAddress ? `Home base: ${user.homeBaseAddress}` : "Home base: not set"}
Target day: ${targetStr}
${availableDays.length > 0 ? `Worker is typically available on: ${availableDays.map((d: number) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ")}` : ""}

Here are the jobs:

${jobsJson}
${workerHistory.length > 0 ? `
This worker has previously serviced these properties (prioritize familiar properties):
${JSON.stringify(workerHistory, null, 2)}
` : ""}
${modeInstructions}
${routeContext}
8. CRITICAL: The worker has ${availableHours} hours available TOTAL. Calculate: (sum of all job durations × ${1 + bufferPercent / 100} for setup buffer) + (total driving time from route data). If that exceeds ${Math.round(availableHours * 1.05 * 60)} minutes, remove jobs until it fits. This is a hard constraint.
9. For jobs without an estimated duration, assume 60 minutes (err on the larger side)
10. Consider earnings and estimated duration for workload balance

Respond in this JSON format:
{
  "days": [
    {
      "date": "YYYY-MM-DD",
      "dayLabel": "Monday, Apr 1",
      "route": [
        {
          "occurrenceId": "...",
          "order": 1,
          "property": "...",
          "address": "...",
          "reason": "Brief reason for this position in route",
          "dateChanged": false,
          "originalDate": null,
          "suggestedDate": null
        }
      ],
      "estimatedEarnings": 0,
      "estimatedHours": 0,
      "daySummary": "Brief summary of this day's route"
    }
  ],
  "summary": "Overall week strategy in 1-2 sentences",
  "totalEstimatedEarnings": 0,
  "dateChangeCount": 0,
  "additionalJobsToConsider": ["id1"]
}

For jobs that need a date change, set dateChanged=true with originalDate and suggestedDate. The "additionalJobsToConsider" field lists IDs of claimable jobs worth adding.`;

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      let parsed: any = null;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch {}

      return {
        suggestions: parsed,
        raw: parsed ? undefined : text,
        jobs: allJobs,
        targetUser: { id: user.id, displayName: user.displayName },
        routing: optimizedRoute ? {
          provider: optimizedRoute.provider,
          totalDriveMinutes: Math.round(optimizedRoute.totalDuration / 60),
          totalDriveMiles: Math.round(optimizedRoute.totalDistance / 1609.34 * 10) / 10,
        } : null,
        routeError,
      };
    } catch (err: any) {
      app.log.error({ where: "preview/route-suggestions", err: err.message });
      return {
        suggestions: null,
        message: `AI suggestion failed: ${err.message}`,
        jobs: allJobs,
      };
    }
  });

  app.get("/preview/routing-providers", workerGuard, async () => {
    return { providers: AVAILABLE_PROVIDERS };
  });
}
