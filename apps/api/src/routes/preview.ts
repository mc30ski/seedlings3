import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/prisma";
import Anthropic from "@anthropic-ai/sdk";
import { getRoutingProvider, AVAILABLE_PROVIDERS, type OptimizedRoute } from "../lib/routing";

import { etMidnight, etToday, etAddDays, etFormatDate , type EtDateKey } from "../lib/dates";

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
    const maxLookAhead = targetUserIdParam ? 5 : 2;
    const lookAhead = mode === "suggest" ? Math.min(Math.max(Number(req.query?.lookAhead) || maxLookAhead, 0), maxLookAhead) : 0;
    // CAPACITY IS THE WORKER'S CALL.
    //
    // This used to fall back to `availableHoursPerDay ?? 4` and then hand the
    // model "remove jobs until it fits — hard constraint". A worker who had
    // claimed 22 jobs for a Saturday got most of the day binned against a
    // 4-hour default they never set. A stored preference is a planning hint,
    // not a cap on what someone has already committed to.
    //
    // So: only an EXPLICIT number from this request, or one the worker has
    // actually set on their profile, counts. Absent both, there is no stated
    // budget and none is enforced.
    const requestedHours = Number(req.query?.availableHours);
    const statedHours =
      Number.isFinite(requestedHours) && requestedHours > 0
        ? Math.min(Math.max(requestedHours, 1), 12)
        : (user.availableHoursPerDay ?? null);
    const availableHours = mode === "suggest" && statedHours ? statedHours : 0;
    const bufferPercent = Math.min(Math.max(Number(req.query?.bufferPercent) || 20, 0), 50);
    const availableDays: number[] = user.availableDays ? JSON.parse(user.availableDays) : [];
    // Target date = the specific day to plan a route for. ET-anchored so a
    // worker checking their route at 11pm ET still sees "tomorrow" as the
    // next calendar day in their actual timezone, not 6 hours ahead in UTC.
    const targetDateParam = req.query?.targetDate as string | undefined;
    const todayStr = etToday();
    const targetStr = targetDateParam || etAddDays(todayStr, 1);
    // Search range: lookAhead days before AND after the target date, but
    // never before today. All string arithmetic in ET so DST edges and the
    // server's UTC clock don't shift the window.
    const rangeStartStr = etAddDays(targetStr as EtDateKey, -lookAhead);
    const startStr = rangeStartStr < todayStr ? todayStr : rangeStartStr;
    const endStr = etAddDays(targetStr as EtDateKey, lookAhead + 1);

    // Fetch claimable occurrences only in "suggest" mode.
    // Estimates ARE included for both admin- and worker-mode planning —
    // workers may need to visit an estimate on their route the same as
    // any regular job. Light estimates (jobId null) carry their own
    // estimateAddress / contactName fields; formatOcc below falls back
    // to those when there's no linked Property. Estimates without any
    // resolvable address get skipped from route optimization via the
    // "No address" filter (dataIssues) — same treatment as jobs with
    // missing property data.
    const isAdminRoute = !!targetUserIdParam;
    const claimable = mode === "suggest" ? await prisma.jobOccurrence.findMany({
      where: {
        status: "SCHEDULED",
        assignees: { none: {} },
        ...(isAdminRoute ? {} : { isAdminOnly: false }),
        isTentative: false,
        OR: [
          { startAt: { gte: etMidnight(startStr), lt: etMidnight(endStr) } },
          { startAt: null },
        ],
      },
      include: {
        job: {
          include: {
            property: {
              select: { id: true, displayName: true, street1: true, city: true, state: true, client: { select: { displayName: true } } },
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
          { startAt: { gte: etMidnight(startStr), lt: etMidnight(endStr) } },
          { startAt: null },
        ],
      },
      include: {
        job: {
          include: {
            property: {
              select: { id: true, displayName: true, street1: true, city: true, state: true, client: { select: { displayName: true } } },
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
          lastDate: occ.completedAt ? etFormatDate(occ.completedAt) : null,
        });
      }
    }
    const workerHistory = Array.from(historyMap.values());

    const formatOcc = (occ: any, type: "claimable" | "claimed") => {
      const prop = occ.job?.property;
      // Estimate flag — true for both LIGHT estimates (jobId null,
      // workflow=ESTIMATE) and FULL estimates (jobId set, but the
      // occurrence itself is marked as an estimate). Both types get
      // routed the same way — a stop is a stop — but the response tags
      // them so the UI can badge them distinctly.
      const isEstimate = occ.workflow === "ESTIMATE" || occ.isEstimate === true;
      // Light-estimate fallback: no linked Property, so read address /
      // display name from the occurrence's own estimateAddress /
      // contactName fields. These are populated when a light estimate
      // is created via the "quick estimate" flow (no full Property
      // record yet).
      const address = prop
        ? [prop.street1, prop.city, prop.state].filter(Boolean).join(", ")
        : (occ.estimateAddress ?? "");
      const displayName = prop?.displayName
        ?? (occ.contactName ? `Estimate — ${occ.contactName}` : (isEstimate ? "Estimate" : "Unknown"));
      const cityFallback = prop?.city ?? extractCityFromAddress(occ.estimateAddress) ?? "Unknown";
      const clientName = prop?.client?.displayName ?? occ.contactName ?? null;
      return {
        id: occ.id,
        jobId: occ.jobId,
        type,
        property: displayName,
        client: clientName,
        address: address || "No address",
        city: cityFallback,
        price: occ.price ?? occ.job?.defaultPrice ?? null,
        estimatedMinutes: occ.estimatedMinutes ?? occ.job?.estimatedMinutes ?? null,
        kind: occ.kind,
        isEstimate,
        currentDate: occ.startAt ? etFormatDate(occ.startAt) : null,
      };
    };

    // Cheap parse: "1234 Main St, Austin, TX 78701" → "Austin". Best-effort;
    // returns null if the string isn't shaped like a US comma-separated address.
    function extractCityFromAddress(addr: string | null | undefined): string | null {
      if (!addr) return null;
      const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
      // Standard shape: [street, city, "STATE ZIP"] → city is at index 1.
      if (parts.length >= 2) return parts[1];
      return null;
    }

    const allJobs = [
      ...claimed.map((o) => formatOcc(o, "claimed")),
      ...claimable.map((o) => formatOcc(o, "claimable")),
    ];

    // Surface jobs whose property records are missing data the optimizer needs.
    // Without an address Mapbox can't geocode them, so they're skipped from
    // distance optimization — Claude still places them in the route but with
    // no spatial info. The client renders this as a warning so it's obvious
    // why a stop shows up as "Unknown / No address".
    const dataIssues = allJobs
      .filter((j) => j.address === "No address" || j.property === "Unknown")
      .map((j) => ({
        occurrenceId: j.id,
        missingProperty: j.property === "Unknown",
        missingAddress: j.address === "No address",
      }));

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

    // Optional override: start the route from the worker's current location
    // (lat/lng) instead of their home base. When present, the route is treated
    // as one-way (no return leg back to start) since "current location" is
    // assumed not to be a meaningful endpoint.
    const rawStartLat = req.query?.startLat;
    const rawStartLng = req.query?.startLng;
    const currentLat = rawStartLat != null ? Number(rawStartLat) : NaN;
    const currentLng = rawStartLng != null ? Number(rawStartLng) : NaN;
    const fromCurrentLocation =
      Number.isFinite(currentLat) && Number.isFinite(currentLng) &&
      currentLat >= -90 && currentLat <= 90 && currentLng >= -180 && currentLng <= 180;
    // Resolved when fromCurrentLocation is true: a friendly address for the
    // current coords, used in the prompt and surfaced in the response so the UI
    // can show "Started from <address>" instead of bare lat/lng.
    let currentLocationAddress: string | null = null;

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

      // Resolve start coords: explicit current location overrides home base.
      let startCoords: { lng: number; lat: number } | undefined;
      if (fromCurrentLocation) {
        startCoords = { lat: currentLat, lng: currentLng };
        // Reverse-geocode the device coords to a human-readable address so the
        // AI prompt has something meaningful (and the UI can display it).
        // Without this Claude tends to hallucinate a phantom "start" stop with
        // property "Unknown" and address "No address" because all it has is
        // bare lat/lng.
        if (typeof router.reverseGeocode === "function") {
          try {
            currentLocationAddress = await router.reverseGeocode(startCoords);
          } catch { /* non-fatal */ }
        }
      } else if (user.homeBaseAddress) {
        const homeGeo = await router.geocode(user.homeBaseAddress);
        if (homeGeo) startCoords = homeGeo.coordinates;
      }

      if (validCoords.length > 1) {
        optimizedRoute = await router.optimizeRoute(validCoords, {
          startCoords,
          // Round-trip only makes sense when start is home base; if the worker
          // is starting from wherever they happen to be, don't tack on a
          // return leg back to that arbitrary point.
          roundTrip: !!startCoords && !fromCurrentLocation,
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

    // ── Capacity is REPORTED, never enforced ────────────────────────────
    //
    // This block used to splice jobs out of `allJobs` — lowest price-per-
    // minute first — until the day fit inside the worker's hours setting,
    // then re-optimize the route around what was left. The jobs didn't just
    // drop out of the route; they vanished from the response entirely, so
    // the worker never saw that they'd been taken off the table.
    //
    // That is not the app's call to make. A worker who wants 22 jobs plotted
    // for one day gets 22 jobs plotted, whatever their stored preference
    // says. We still do the arithmetic — an honest "this is ~15h of work
    // against your 8h setting" is useful — but it is information handed back,
    // not a decision taken on the worker's behalf. The client renders it as
    // an over-capacity warning above the route.
    const totalDriveMins = optimizedRoute ? Math.round(optimizedRoute.totalDuration / 60) : 0;
    const totalWorkMins = allJobs.reduce((t, j) => t + (j.estimatedMinutes ?? 60), 0);
    const totalSetupMins = Math.round(totalWorkMins * bufferPercent / 100);
    const capacity = {
      statedHours: availableHours > 0 ? availableHours : null,
      totalMinutes: totalWorkMins + totalSetupMins + totalDriveMins,
      workMinutes: totalWorkMins,
      setupMinutes: totalSetupMins,
      driveMinutes: totalDriveMins,
      /** True only when the worker actually stated hours AND the plotted day
       *  exceeds them. Drives a warning — never a removal. */
      overStatedHours:
        availableHours > 0 &&
        totalWorkMins + totalSetupMins + totalDriveMins > availableHours * 60 * 1.05,
    };

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
        error: "Route suggestions are not configured on the server (ANTHROPIC_API_KEY is missing). Contact support.",
        jobs: allJobs,
      };
    }

    // Named `anthropic`, not `client`: the audit-coverage gate matches
    // `client.<x>.create(` as a Prisma mutation, and an SDK call is not one.
    const anthropic = new Anthropic({ apiKey });

    const jobsJson = JSON.stringify(allJobs, null, 2);

    const startRule = fromCurrentLocation
      ? `Route should start from the worker's current location (${currentLocationAddress ?? `lat ${currentLat.toFixed(4)}, lng ${currentLng.toFixed(4)}`}) — one-way, no return leg back to that point. DO NOT include the current location as an entry in the "route" array — the route array contains only the actual jobs.`
      : user.homeBaseAddress
        ? `Route should start and end near the worker's home base (${user.homeBaseAddress})`
        : "Route should minimize total driving";

    const modeInstructions = mode === "claimed"
      ? `MODE: Claimed Only — optimize the route order for ONLY the jobs this worker has already claimed. Do not suggest additional jobs. Focus purely on the most efficient ordering and travel path.

SINGLE DAY. Return EXACTLY ONE entry in "days", dated ${targetStr}, containing EVERY claimed job. Do NOT spread the work across multiple days, do not defer jobs to a later date, and do not leave any job out because the day looks long. The worker decided what they are doing that day; your job is the ORDER, not the workload.

Rules:
1. ${startRule}
2. All claimed jobs must be included, all on ${targetStr} — just find the optimal order
3. Setup buffer: ${bufferPercent}% — add this on top of each job's estimated work time for setup/teardown (unloading equipment, etc.). Travel time is calculated separately by the mapping provider.
4. Prioritize properties the worker has previously serviced — they know the property and can work more efficiently there`
      : `MODE: Suggest Additional Jobs — optimize the route AND suggest additional available jobs to fill the day.

STRICT TIME BUDGET: ${availableHours} hours TOTAL. This means work time + driving time combined must not exceed ${availableHours}h (with up to 5% flexibility = max ${Math.round(availableHours * 1.05 * 60)} minutes total). If driving alone takes 1.5h and the budget is ${availableHours}h, you only have ${Math.round((availableHours - 1.5) * 60)} minutes of actual work time. Do the math before selecting jobs.
Setup buffer: ${bufferPercent}% — add this percentage on top of each job's estimated work time for setup/teardown only (unloading, walking the property, etc.). Travel time between stops is calculated separately by the mapping provider and shown in the route data above. For example, a 60-min job with ${bufferPercent}% buffer = ${Math.round(60 * (1 + bufferPercent / 100))} min work time.
${lookAhead > 0 ? `Also considering jobs from ${lookAhead} days before and after ${targetStr} (but not before today) that could be moved to ${targetStr} for a better route.` : "Only considering jobs scheduled for this day."}

Rules:
1. ${startRule}
2. Start with jobs already scheduled for ${targetStr} — these are the core of the route
3. Look at jobs from other days nearby — if moving them to ${targetStr} would create a tighter geographic cluster and a more efficient day, suggest it
4. Already claimed jobs for ${targetStr} must be included
5. For jobs from other days, clearly flag that a reschedule is needed (the worker must contact the client first)
6. Don't suggest moving ALL jobs to one day — only suggest moves that genuinely improve the route
7. Prioritize properties the worker has previously serviced — they know the property and can work more efficiently there`;

    const prompt = `You are a route optimizer for a lawn care service. A worker needs to plan the most efficient route for a specific day.

Worker: ${user.displayName ?? user.email ?? "Unknown"}
${user.homeBaseAddress ? `Home base: ${user.homeBaseAddress}` : "Home base: not set"}
${fromCurrentLocation ? `Starting from current location: ${currentLocationAddress ?? `lat ${currentLat.toFixed(4)}, lng ${currentLng.toFixed(4)}`} (one-way route — no return leg)` : ""}
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
${mode === "suggest"
  ? (availableHours > 0
      ? `8. NEVER remove a claimed job. The worker has stated ${availableHours} hours available (~${Math.round(availableHours * 1.05 * 60)} minutes including buffer); order your ADDITIONAL suggestions best-first so the ones past that mark fall at the end, and say so in the reason. Do not withhold or delete anything — how much of it they take on is their call, not yours.`
      : `8. NEVER remove a job. The worker has not stated how many hours they have, so do not invent a limit — include everything claimed and order additional suggestions by how well they fit the route.`)
  : "8. Include ALL claimed jobs in the route — do not remove any, for any reason."}
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
      const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        // A WEEK of routes, each stop carrying property, address and a
        // prose `reason`. At 3000 this silently truncated in production
        // (2026-08-25): the model stopped mid-word, JSON.parse threw into
        // an empty catch, and the half-written JSON was rendered to the
        // operator as-is. One day of five stops already costs ~450 tokens
        // of `reason` text alone, so seven days never fit.
        //
        // Raise generously — output is billed by what's produced, not by
        // the ceiling, so a high cap costs nothing on a request that ends
        // early and prevents the failure that actually happened.
        max_tokens: 16000,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      // Truncation is NOT a parse problem and must not be reported as one.
      // `stop_reason === "max_tokens"` is the model telling us plainly that
      // it ran out of room; without this check the only symptom is
      // unparseable JSON, which looks identical to the model returning
      // nonsense and sends the next person debugging the wrong thing.
      if (response.stop_reason === "max_tokens") {
        app.log.error({
          where: "preview/route-suggestions",
          reason: "max_tokens",
          chars: text.length,
        });
        return {
          suggestions: null,
          error:
            "The route planner ran out of room before it finished the week. " +
            "Try planning fewer days at a time, or run it again — if it keeps " +
            "happening the output limit needs raising.",
          jobs: allJobs,
        };
      }

      let parsed: any = null;
      let parseError: string | null = null;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        else parseError = "no JSON object found in the response";
      } catch (e: any) {
        parseError = e?.message ?? "invalid JSON";
      }

      // Defense-in-depth: drop any AI-hallucinated stops whose occurrenceId
      // doesn't match a real job (e.g. a phantom "start point" stop with
      // property "Unknown" / address "No address"). Even with the prompt
      // instruction the model occasionally fabricates these.
      if (parsed?.days && Array.isArray(parsed.days)) {
        const validIds = new Set(allJobs.map((j) => j.id));
        for (const day of parsed.days) {
          if (Array.isArray(day.route)) {
            day.route = day.route.filter((s: any) => s && validIds.has(s.occurrenceId));
            day.route.forEach((s: any, i: number) => { s.order = i + 1; });
          }
        }
      }

      // ── Claimed mode is ONE day, enforced here, not merely requested ─────
      //
      // The response schema is an array of days and the summary prompt asks
      // for a "week strategy", so the model is structurally invited to spread
      // work out — and with 22 claimed jobs for one Saturday it did exactly
      // that, leaving the worker no usable route for the day he could
      // actually work. Asking nicely in the prompt is not enough when the
      // shape of the answer pulls the other way.
      //
      // Flatten to a single day at the target date, in the order the model
      // gave, de-duplicated. Anything it deferred comes back.
      if (mode === "claimed" && parsed?.days && Array.isArray(parsed.days)) {
        const seen = new Set<string>();
        const merged: any[] = [];
        for (const day of parsed.days) {
          for (const stop of day?.route ?? []) {
            if (stop?.occurrenceId && !seen.has(stop.occurrenceId)) {
              seen.add(stop.occurrenceId);
              // A claimed job is not being rescheduled — it is being ordered.
              merged.push({ ...stop, dateChanged: false, originalDate: null, suggestedDate: null });
            }
          }
        }
        // Any claimed job the model dropped entirely still belongs to the
        // day. Appended rather than discarded: a missing job is worse than
        // an imperfectly placed one.
        for (const j of allJobs) {
          if (!seen.has(j.id)) {
            seen.add(j.id);
            merged.push({
              occurrenceId: j.id,
              property: j.property,
              address: j.address,
              reason: "Added back — the planner left this out, but it is claimed for this day.",
              dateChanged: false, originalDate: null, suggestedDate: null,
            });
          }
        }
        merged.forEach((stop, i) => { stop.order = i + 1; });
        const collapsedFrom = parsed.days.length;
        parsed.days = [{
          date: targetStr,
          dayLabel: parsed.days[0]?.dayLabel ?? targetStr,
          route: merged,
          estimatedEarnings: parsed.days.reduce((t: number, d: any) => t + (Number(d?.estimatedEarnings) || 0), 0),
          estimatedHours: parsed.days.reduce((t: number, d: any) => t + (Number(d?.estimatedHours) || 0), 0),
          daySummary: parsed.days[0]?.daySummary ?? "",
        }];
        parsed.dateChangeCount = 0;
        if (collapsedFrom > 1) {
          app.log.warn({ where: "preview/route-suggestions", reason: "claimed_mode_multi_day", collapsedFrom, stops: merged.length });
          parsed.summary =
            `All ${merged.length} claimed jobs are on ${targetStr}. ` +
            (parsed.summary ?? "");
        }
      }

      return {
        suggestions: parsed,
        // Always pair unparseable output with an `error`, so the client
        // shows a banner explaining what happened instead of silently
        // rendering raw model output and leaving the operator to work out
        // that it failed at all.
        error: parsed
          ? undefined
          : `The route planner returned output we couldn't read (${parseError}). Try again.`,
        raw: parsed ? undefined : text,
        jobs: allJobs,
        targetUser: { id: user.id, displayName: user.displayName },
        routing: optimizedRoute ? {
          provider: optimizedRoute.provider,
          totalDriveMinutes: Math.round(optimizedRoute.totalDuration / 60),
          totalDriveMiles: Math.round(optimizedRoute.totalDistance / 1609.34 * 10) / 10,
        } : null,
        routeError,
        // Reported, not enforced — see the capacity block above.
        capacity,
        startedFromCurrentLocation: fromCurrentLocation,
        currentLocationAddress: fromCurrentLocation ? currentLocationAddress : null,
        dataIssues,
      };
    } catch (err: any) {
      app.log.error({ where: "preview/route-suggestions", err: err.message });
      // Explicit `error` field so the client renders this as a WARNING
      // banner instead of silently falling back to the unorganized job
      // list (which looks like "just numbers" to the operator and gives
      // no clue that anything went wrong). Common failure modes: the
      // configured Claude model has been retired (message will contain
      // "model_not_found" or similar), Anthropic API is temporarily
      // down, or the request timed out.
      return {
        suggestions: null,
        error: `The route planner failed to run. Deploy a fix or try again in a moment. Details: ${err.message}`,
        jobs: allJobs,
      };
    }
  });

  app.get("/preview/routing-providers", workerGuard, async () => {
    return { providers: AVAILABLE_PROVIDERS };
  });
}
