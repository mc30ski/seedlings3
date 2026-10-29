import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../db/prisma";
import { PERSPECTIVE_HEADER } from "../lib/impersonation";
import { resolveCutoff } from "../lib/businessStartCutoff";
import { resolveParcel, parcelImageUrl, redactParcelForWorker } from "../services/parcels";
import { callerCan } from "../lib/callerCan";

function readBearer(req: any): string | null {
  const h = req.headers?.authorization ?? "";
  if (typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

function readCookie(name: string, cookieHeader?: string): string | null {
  const h = cookieHeader || "";
  if (!h) return null;
  const parts = h.split(";").map((s) => s.trim());
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

export default async function meRoutes(app: FastifyInstance) {
  app.get("/me", async (req: FastifyRequest, reply: FastifyReply) => {
    // Acquire a token from header or cookie
    const authHeader = readBearer(req);
    const cookieToken = readCookie("__session", req.headers?.cookie as string);
    const token = authHeader || cookieToken;

    if (!token) {
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "Missing token (header/cookie)",
      });
    } else {
      // The perspective header is ignored unless the caller can actually
      // reach that perspective (it must be in their own resolved `perspectives`),
      // and the client-contact header unless they are someone with `routes.plan`. Both fall
      // back silently rather than 4xx, so neither feature's existence leaks.
      const t = Date.now();
      const result = await services.users.me(
        token,
        req.headers[PERSPECTIVE_HEADER],
        req.impersonatedContact?.id ?? null,
      );
      // TEMP diagnostic (part of the hang-hunt): report how long
      // services.users.me took. Combined with the global "total"
      // timing hook, we can distinguish hangs inside the /me
      // service from hangs in the auth plugin or Vercel edge.
      const t2 = ((reply as any).serverTimings ??= [] as string[]);
      t2.push(`meservice;dur=${Date.now() - t}`);
      return result;
    }
  });

  // ── Public parcel record + overhead imagery ────────────────────────────
  //
  // Available to every approved role, but the PAYLOAD DIFFERS. Workers get
  // the parcel size and the picture — what they need to plan the work.
  // Holders of `routes.plan` and Holders of `routes.plan` additionally get the county's appraised value and the
  // owner of record. The stripping happens here, on the server: a redaction
  // that only hides fields in the UI is still sitting in the network
  // response for anyone who opens devtools.
  //
  // The redaction level comes from `req.principal`, which requireApproved
  // attaches with any active perspective already applied — so someone with `routes.plan`
  // looking through the Worker perspective sees the worker payload here too, which
  // is the whole point of the perspective.
  //
  // view-as-allow: a parcel is a property of the LAND, identical for every
  // caller. There is no per-worker state to impersonate — only the redaction
  // level, which already follows the caller's effective roles above.
  app.get("/me/properties/:id/parcel", { preHandler: app.requireApproved.bind(app) }, async (req: any) => {
    // Unredacted parcel detail is owner/valuation data about somebody's
    // land, which the worker sensitive-data guardrail keeps out of worker
    // views. `clients.manage` is the level that may already edit the client
    // and property records this describes.
    const privileged = callerCan(req, "clients.manage");
    const result = await resolveParcel(String(req.params.id), {
      force: String(req.query?.refresh ?? "") === "1",
    });
    return privileged ? { ...result, redacted: false } : redactParcelForWorker(result);
  });

  // view-as-allow: the imagery is the same picture of the same land for
  // every caller — nothing here varies by user.
  app.get("/me/properties/:id/parcel/image", { preHandler: app.requireApproved.bind(app) }, async (req: any) => {
    return parcelImageUrl(String(req.params.id));
  });

  // Business Start Date — exposes the EFFECTIVE cutoff for the current
  // request so the client can render UI consistently with the API filter.
  // Honors the X-Reveal-Pre-Cutoff header the same way every money endpoint
  // does — i.e. when someone with `routes.plan` sends reveal=true, this returns null and the
  // UI shows the unfiltered state. See lib/businessStartCutoff.ts.
  // view-as-allow: returns the EFFECTIVE Business Start Date cutoff for
  // the current request, driven by the caller's own reveal header. Not a
  // per-worker resource.
  app.get("/me/business-start", { preHandler: app.requireApproved.bind(app) }, async (req: any) => {
    const cutoff = await resolveCutoff(req);
    return {
      // `cutoff` is null when the filter is off (globally OR via reveal
      // header). When non-null, ISO 8601 — UI compares against job dates
      // to decide whether to show "—" for hidden money fields.
      cutoff: cutoff ? cutoff.toISOString() : null,
    };
  });

  // The portfolios this caller may point their LENS at.
  //
  // Not `GET /portfolios`, which is gated on `portfolios.manage` — that endpoint is for
  // BUILDING the tree, and the people who need to narrow a view are mostly
  // not the people who edit territories. Choosing what to look at is not
  // administering anything.
  //
  // Each row is somewhere the caller can already see data, so offering it
  // discloses nothing: a global reader gets the live tree, and anyone else
  // gets only their own granted subtrees. Retired portfolios are excluded because
  // this feeds a PICKER — retirement hides a portfolio from pickers and leaves it
  // in reporting, so a lens already set to one keeps working.
  //
  // AN OPTION MUST EXCLUDE SOMETHING, or it is not a filter.
  //
  // A lens that returns everything the caller can already see is a control
  // that cannot change anything, and the picker already has one of those:
  // "All portfolios", which clears the lens. So an entry is offered only
  // when something the caller can otherwise see falls OUTSIDE it.
  //
  // This was written as "omit a sole root", which is the same rule for the
  // only tree that existed when it was written — one level deep, so the
  // root was the only node that could cover everything. It stopped being
  // the same rule the moment a State and a Market were added above the
  // districts (2026-10-29): somebody granted Durham alone was then offered
  // "North Carolina", "Triangle" and "Durham", three entries returning the
  // identical rows, because the lens is intersected with their grants and
  // all three intersect to Durham. Three controls that do nothing is worse
  // than one.
  //
  // So the rule is stated directly: drop any node whose subtree contains
  // the caller's ENTIRE reach — their granted subtrees, or the roots
  // themselves for a global reader. For one root and a global reader that
  // drops exactly the root, which is what the old wording achieved; with
  // several roots each one still excludes the others, so none are dropped.
  //
  // view-as-allow: the lens belongs to the SESSION doing the looking, not to
  // any worker being looked at. Viewing as someone else does not hand you
  // their territories, and must not — that would make view-as a way to read
  // a district you hold nothing in.
  app.get("/me/portfolios", { preHandler: app.requireApproved.bind(app) }, async (req: any) => {
    const principal = req.principal;
    const all = await prisma.portfolio.findMany({
      where: { retiredAt: null },
      orderBy: [{ path: "asc" }],
      select: { id: true, name: true, tier: true, path: true, parentId: true },
    });

    // Global in ANY role means the whole tree; otherwise the union of the
    // subtrees they are granted. This deliberately asks "do they hold
    // anything globally", not "do they hold capability X" — the lens spans
    // every view at once, so there is no single capability to test it on.
    const roles: Array<{ portfolioPath?: string }> = principal?.roles ?? [];
    const global = principal?.kind === "system" || roles.some((r) => !r.portfolioPath);
    const grantedPaths = roles.map((r) => r.portfolioPath).filter(Boolean) as string[];
    const visible = global
      ? all
      : all.filter((a) =>
          grantedPaths.some((g) => a.path.startsWith(g) || g.startsWith(a.path)),
        );

    const roots = visible.filter((a) => a.parentId === null);
    // What this caller can reach at all. For a global reader that is the
    // roots; for anyone else, the subtrees they are granted.
    const reach = global ? roots.map((r) => r.path) : grantedPaths;
    // `trail` is the chain of names from the top of the tree down to this
    // portfolio, root excluded — so a notice can read "Chapel Hill → Carrboro"
    // instead of a bare leaf name that two districts might share. Built
    // from `all`, not `visible`: an ancestor the caller cannot SELECT is
    // still needed to describe where the portfolio they can select sits.
    const nameById = new Map(all.map((a) => [a.id, a.name]));
    const trailOf = (path: string) =>
      path.split("/").filter(Boolean).slice(1).map((id) => nameById.get(id) ?? "?");
    const options = visible
      // `g.startsWith(a.path)` is "a contains g" — path containment, the
      // same test the scope filter uses, so the picker and the filter can
      // never disagree about what a lens would return.
      .filter((a) => !(reach.length > 0 && reach.every((g) => g.startsWith(a.path))))
      .map(({ id, name, tier, path }) => ({ id, name, tier, path, trail: trailOf(path) }));
    return { portfolios: options };
  });

  app.post("/me/sync", async (req: any, reply: FastifyReply) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return reply.code(401).send({ error: "Unauthorized" });

    const user = await prisma.user.findUnique({ where: { clerkUserId } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
    const u = await clerk.users.getUser(clerkUserId);

    const email = u?.primaryEmailAddress?.emailAddress ?? u?.emailAddresses?.[0]?.emailAddress ?? null;
    const firstName = u?.firstName ?? null;
    const lastName = u?.lastName ?? null;
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const displayName = name || u?.username || null;

    const updates: any = { updatedAt: new Date() };
    if (email && user.email !== email) updates.email = email;
    if (firstName && user.firstName !== firstName) updates.firstName = firstName;
    if (lastName && user.lastName !== lastName) updates.lastName = lastName;
    if (displayName && user.displayName !== displayName) updates.displayName = displayName;

    // audit-allow: mirrors Clerk's email/name onto our User row. A sync
    // of an upstream identity, not a decision anyone made here.
    await prisma.user.update({ where: { id: user.id }, data: updates });

    return { ok: true, synced: Object.keys(updates).filter(k => k !== "updatedAt") };
  });

  // ── Push subscriptions ──────────────────────────────────────────────
  // Per-device web-push subscriptions for the current user. Self-healing:
  // the web app re-subscribes on every PWA launch and POSTs the result;
  // the unique constraint on `endpoint` makes that a no-op when valid and
  // a fresh insert when iOS/Android quietly invalidated the old one.

  // view-as-allow: push subscriptions are per-device and belong to the
  // caller's device. No admin has a reason to enumerate another user's
  // subscriptions.
  app.get("/me/push-subscriptions", async (req: any, reply: FastifyReply) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return reply.code(401).send({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({ where: { clerkUserId }, select: { id: true } });
    if (!user) return reply.code(404).send({ error: "User not found" });
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: user.id },
      select: { id: true, endpoint: true, userAgent: true, label: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: "desc" },
    });
    return subs;
  });

  app.post("/me/push-subscriptions", async (req: any, reply: FastifyReply) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return reply.code(401).send({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({ where: { clerkUserId }, select: { id: true } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const body = req.body || {};
    const endpoint = String(body.endpoint || "").trim();
    const p256dh = String(body.p256dh || "").trim();
    const auth = String(body.auth || "").trim();
    const userAgent = body.userAgent ? String(body.userAgent).slice(0, 200) : null;
    const label = body.label ? String(body.label).slice(0, 60) : null;

    if (!endpoint || !p256dh || !auth) {
      return reply.code(400).send({ error: "endpoint, p256dh, and auth are required" });
    }

    // Upsert on endpoint — same browser hitting subscribe() returns the same
    // endpoint, so re-subscribe-on-launch is a no-op when nothing changed.
    // audit-allow: push subscriptions are tied to a browser install, not
    // to any user-meaningful state. Registering a device is not an action
    // anyone would audit.
    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: user.id, endpoint, p256dh, auth, userAgent, label },
      update: { userId: user.id, p256dh, auth, userAgent, label, lastUsedAt: new Date() },
      select: { id: true, endpoint: true, userAgent: true, label: true, createdAt: true, lastUsedAt: true },
    });
    return sub;
  });

  app.delete("/me/push-subscriptions/:id", async (req: any, reply: FastifyReply) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return reply.code(401).send({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({ where: { clerkUserId }, select: { id: true } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const id = String((req.params as any)?.id || "");
    const sub = await prisma.pushSubscription.findUnique({ where: { id }, select: { userId: true } });
    if (!sub) return reply.code(404).send({ error: "Not found" });
    if (sub.userId !== user.id) return reply.code(403).send({ error: "Forbidden" });

    // audit-allow: unregistering a device — see the upsert above.
    await prisma.pushSubscription.delete({ where: { id } });
    return { ok: true };
  });
}
