import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/prisma";
import { getRoutingProvider, AVAILABLE_PROVIDERS, type OptimizedRoute } from "../lib/routing";

import { etMidnight, etToday, etAddDays, etFormatDate , type EtDateKey } from "../lib/dates";
import { planRoute } from "../lib/routePlanner";

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
    /** The address the day actually starts from, in EITHER mode — so the
     *  client can hand Google Maps a real origin instead of falling back to
     *  the first job site. Hoisted out of the routing block below because the
     *  response is built after it closes. */
    let resolvedStartAddress: string | null = null;
    /** Mirrors the `roundTrip` given to the optimizer, so a launched map ends
     *  where the plan ends. */
    let routeReturnsToStart = false;

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
        resolvedStartAddress = currentLocationAddress;
      } else if (user.homeBaseAddress) {
        const homeGeo = await router.geocode(user.homeBaseAddress);
        if (homeGeo) {
          startCoords = homeGeo.coordinates;
          resolvedStartAddress = user.homeBaseAddress;
        }
      }
      routeReturnsToStart = !!startCoords && !fromCurrentLocation;

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

    // ── Plan the day, in code ────────────────────────────────────────────
    //
    // This was an LLM call. The provider had already solved the routing with
    // real driving times, and the prompt told the model so — "the driving
    // times above are REAL — use them instead of guessing". What remained was
    // arithmetic, a sort key, and caption text, none of which needs a model
    // and two of which were worse for having one. See lib/routePlanner.ts for
    // the full reasoning.
    //
    // Gone with it: ~120 lines of prompt, a max_tokens truncation branch, a
    // JSON-parse branch, a filter dropping hallucinated stops that matched no
    // real job, and a claimed-mode re-flattening step that existed because the
    // response schema invited the model to spread one day's work across a
    // week. None of those failure modes can occur now.
    const familiarProperties = new Set(workerHistory.map((h) => h.name));
    const plan = planRoute({
      jobs: allJobs.map((j) => ({
        id: j.id,
        jobId: j.jobId,
        type: j.type as "claimed" | "claimable",
        property: j.property,
        address: j.address,
        price: j.price,
        estimatedMinutes: j.estimatedMinutes,
        currentDate: j.currentDate,
      })),
      legs: (optimizedRoute?.stops ?? []).map((st) => ({
        inputIndex: st.inputIndex,
        durationFromPrev: st.durationFromPrev,
        distanceFromPrev: st.distanceFromPrev,
      })),
      targetDate: targetStr as EtDateKey,
      mode,
      availableHours,
      bufferPercent,
      familiarProperties,
      fromCurrentLocation,
      totalDriveSeconds: optimizedRoute?.totalDuration ?? null,
    });

    try {
      return {
        suggestions: plan,
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
        // WHERE THE DAY ACTUALLY STARTS, in both modes.
        //
        // `currentLocationAddress` is null on a home-base route, so the
        // client had no origin to hand Google Maps and used the FIRST JOB
        // instead — the launched route began at the first site and the leg
        // to get there, the one you drive first, was missing entirely.
        //
        // `routeReturnsToStart` mirrors the `roundTrip` passed to the
        // optimizer above, so the map link ends where the plan ends.
        startAddress: resolvedStartAddress,
        routeReturnsToStart,
        dataIssues,
      };
    } catch (err: any) {
      app.log.error({ where: "preview/route-suggestions", err: err.message });
      // Explicit `error` field so the client renders this as a WARNING
      // banner instead of silently falling back to the unorganized job
      // list, which looks like "just numbers" to the operator and gives no
      // clue anything went wrong.
      //
      // The planner itself is pure code over data already in hand, so this
      // is now a genuine last resort rather than the routine outcome it was
      // when an external model could be retired, rate-limited or time out.
      // The failure that DOES still happen — the routing provider being
      // unreachable — is caught above and reported as `routeError`, with the
      // day still planned in the order the jobs came.
      return {
        suggestions: null,
        error: `The route planner failed to run. Try again in a moment. Details: ${err.message}`,
        jobs: allJobs,
      };
    }
  });

  app.get("/preview/routing-providers", workerGuard, async () => {
    return { providers: AVAILABLE_PROVIDERS };
  });
}
