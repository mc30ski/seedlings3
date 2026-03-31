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

    // Next 7 days
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() + 1);
    const startStr = startDate.toISOString().slice(0, 10);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);
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
        message: "No available or claimed jobs found for the next 7 days.",
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
    const prompt = `You are a route optimizer for a lawn care service. A worker needs to plan their week.

Worker: ${user.displayName ?? user.email ?? "Unknown"}
${user.homeBaseAddress ? `Home base: ${user.homeBaseAddress}` : "Home base: not set"}
Week: ${startStr} to ${endStr}

Here are the available jobs for the next 7 days (some already claimed, others available to claim):

${jobsJson}

Your goal is to organize these jobs into efficient DAILY routes. Jobs may currently be scheduled on different days — you should suggest moving jobs to different days if it creates better geographic routes. This is advisory only — the worker will need to contact clients to confirm date changes.

Rules:
1. ${user.homeBaseAddress ? `Each day's route should start and end near the worker's home base (${user.homeBaseAddress})` : "Each day's route should minimize total driving"}
2. Group jobs by geographic proximity into daily clusters
3. Already claimed jobs must be included
4. If a job's date needs to change to fit an efficient route, flag it clearly
5. Not every day needs jobs — consolidate into fewer, more efficient days when possible
6. Consider earnings and estimated duration for workload balance

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
