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

    // Get the target user info
    const user = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, displayName: true, email: true, workerType: true, homeBaseAddress: true },
    });
    if (!user) throw app.httpErrors.notFound("User not found.");

    // Get tomorrow's date range
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const dayAfter = new Date(tomorrow);
    dayAfter.setDate(dayAfter.getDate() + 1);

    // Fetch claimable occurrences (unassigned, scheduled, tomorrow or undated)
    const claimable = await prisma.jobOccurrence.findMany({
      where: {
        status: "SCHEDULED",
        assignees: { none: {} },
        isAdminOnly: false,
        isTentative: false,
        workflow: { not: "ESTIMATE" },
        OR: [
          { startAt: { gte: new Date(tomorrowStr + "T00:00:00Z"), lt: new Date(dayAfter.toISOString().slice(0, 10) + "T00:00:00Z") } },
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

    // Fetch already-claimed by this user (tomorrow)
    const claimed = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        assignees: { some: { userId: targetUserId } },
        OR: [
          { startAt: { gte: new Date(tomorrowStr + "T00:00:00Z"), lt: new Date(dayAfter.toISOString().slice(0, 10) + "T00:00:00Z") } },
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

    // Format data for Claude
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
        startAt: occ.startAt?.toISOString() ?? null,
      };
    };

    const allJobs = [
      ...claimed.map((o) => formatOcc(o, "claimed")),
      ...claimable.map((o) => formatOcc(o, "claimable")),
    ];

    if (allJobs.length === 0) {
      return {
        suggestions: null,
        message: "No available or claimed jobs found for tomorrow.",
        jobs: [],
      };
    }

    // Call Claude
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
    const prompt = `You are a route optimizer for a lawn care service. A worker needs to plan their day for tomorrow.

Worker: ${user.displayName ?? user.email ?? "Unknown"}
${user.homeBaseAddress ? `Home base: ${user.homeBaseAddress}` : "Home base: not set"}

Here are the available jobs (some already claimed by this worker, others available to claim):

${jobsJson}

Please suggest an optimal route for the day. Consider:
1. ${user.homeBaseAddress ? `Start and end the route near the worker's home base (${user.homeBaseAddress})` : "Geographic clustering — group nearby jobs to minimize driving"}
2. Minimize total driving distance between jobs
3. Earnings — higher-paying jobs should be prioritized
4. Time efficiency — consider estimated duration and travel between locations
5. Already claimed jobs must be included in the route

For each job in your suggested order, explain briefly why it fits at that position in the route.

Respond in this JSON format:
{
  "route": [
    {
      "occurrenceId": "...",
      "order": 1,
      "property": "...",
      "address": "...",
      "reason": "Start here because..."
    }
  ],
  "summary": "A brief 1-2 sentence overview of the route strategy",
  "estimatedEarnings": 0,
  "estimatedHours": 0,
  "additionalJobsToConsider": ["id1", "id2"]
}

Only include jobs from the list provided. The "additionalJobsToConsider" field should list IDs of claimable jobs you recommend the worker claim to fill gaps in the route.`;

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      // Try to parse JSON from response
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
