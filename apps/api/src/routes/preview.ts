import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/prisma";
import Anthropic from "@anthropic-ai/sdk";

const adminGuard = {
  preHandler: (req: FastifyRequest, reply: FastifyReply) =>
    (req.server as any).requireRole(req, reply, "ADMIN"),
};

async function currentUserId(req: any): Promise<string> {
  return (req as any).user?.id;
}

export default async function previewRoutes(app: FastifyInstance) {
  app.get("/preview/route-suggestions", adminGuard, async (req: any) => {
    const userId = await currentUserId(req);
    const targetUserIdParam = req.query?.userId as string | undefined;
    const targetUserId = targetUserIdParam || userId;

    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, displayName: true, email: true, workerType: true, homeBaseAddress: true },
    });
    if (!user) throw app.httpErrors.notFound("User not found.");

    const lookAhead = Math.min(Math.max(Number(req.query?.lookAhead) || 7, 0), 30);
    const availableHours = Math.min(Math.max(Number(req.query?.availableHours) || 8, 2), 12);
    const now = new Date();
    // Target date = the specific day to plan a route for
    const targetDateParam = req.query?.targetDate as string | undefined;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetStr = targetDateParam || tomorrow.toISOString().slice(0, 10);
    // Search range: from target date, extending lookAhead days
    const startStr = targetStr;
    const endDate = new Date(targetStr + "T12:00:00Z");
    endDate.setDate(endDate.getDate() + lookAhead + 1);
    const endStr = endDate.toISOString().slice(0, 10);

    // Fetch claimable occurrences (unassigned, scheduled, next 7 days or undated)
    const claimable = await prisma.jobOccurrence.findMany({
      where: {
        status: "SCHEDULED",
        assignees: { none: {} },
        isAdminOnly: false,
        isTentative: false,
        workflow: { not: "ESTIMATE" },
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
    });

    // Fetch already-claimed by this user (next 7 days)
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
    const prompt = `You are a route optimizer for a lawn care service. A worker needs to plan the most efficient route for a specific day.

Worker: ${user.displayName ?? user.email ?? "Unknown"}
${user.homeBaseAddress ? `Home base: ${user.homeBaseAddress}` : "Home base: not set"}
Target day: ${targetStr}
Available hours: ${availableHours} hours (do not exceed this)
${lookAhead > 0 ? `Also considering jobs from the next ${lookAhead} days that could be moved to ${targetStr} for a better route.` : "Only considering jobs scheduled for this day."}

Here are the available jobs (some on the target day, some on nearby days that could potentially be moved):

${jobsJson}
${workerHistory.length > 0 ? `
This worker has previously serviced these properties (prioritize familiar properties):
${JSON.stringify(workerHistory, null, 2)}
` : ""}
Your primary goal is to build the BEST POSSIBLE route for ${targetStr}.

Rules:
1. ${user.homeBaseAddress ? `Route should start and end near the worker's home base (${user.homeBaseAddress})` : "Route should minimize total driving"}
2. Start with jobs already scheduled for ${targetStr} — these are the core of the route
3. Look at jobs from other days nearby — if moving them to ${targetStr} would create a tighter geographic cluster and a more efficient day, suggest it
4. Already claimed jobs for ${targetStr} must be included
5. For jobs from other days, clearly flag that a reschedule is needed (the worker must contact the client first)
6. Don't suggest moving ALL jobs to one day — only suggest moves that genuinely improve the route
7. Prioritize properties the worker has previously serviced — they know the property and can work more efficiently there
8. The worker has ${availableHours} hours available. Do NOT schedule more than ${availableHours} hours of work (include estimated travel time between jobs, roughly 15-20 min per stop)
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
}
