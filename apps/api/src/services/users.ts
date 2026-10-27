import { prisma } from "../db/prisma";

import { WorkerType } from "@prisma/client";
import { verifyToken, createClerkClient } from "@clerk/backend";
import type { ServicesUsers } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { enforceAssigneeInvariants, canHoldPaidSeat } from "../lib/claimerInvariant";
import { ServiceError } from "../lib/errors";
import { resolvePerspective } from "../lib/impersonation";
import { availablePerspectives } from "../lib/perspectives";
import { heldCapabilities, flattenRole } from "@repo/permissions";
import { isEntitlement } from "@repo/permissions";
import { isWorkerType } from "@repo/money";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export const users: ServicesUsers = {
  async list(params) {
    const where: any = {};
    if (params?.approved !== undefined) where.isApproved = params.approved;
    // STAFF ONLY — the payroll gate, which is the customer/worker boundary.
    //
    // A customer's login is an ordinary `User` row with no `workerType`, so
    // an unfiltered directory is a staff list with the customers mixed in.
    // Every picker that asks "who works here" was getting all of them: the
    // crew picker, the default-crew picker, the estimate picker, both
    // compliance pickers and the pay-per-hour cards, because they passed a
    // `role=WORKER` parameter this route stopped reading when the `Role`
    // enum was deleted — the filter was silently ignored and nobody saw a
    // change, because the list still looked like a list of people.
    //
    // `workerType IS NOT NULL` and nothing cleverer: it is the same question
    // `can()` asks before it walks anybody's roles. A customer who also
    // works for you HAS a worker type and belongs in these lists.
    if (params?.hasWorkerType) where.workerType = { not: null };
    // Filter by the role's stable KEY, not an enum value. Inheritance is
    // respected: asking for "seedlings.worker" includes anyone holding Admin
    // or Super, because those build on it — which is what the old role
    // filter meant in practice, since the tiers inherited.
    if (params?.roleKey) {
      const wanted = await prisma.customRole.findUnique({
        where: { key: params.roleKey },
        select: { id: true },
      });
      if (!wanted) return [];
      const all = await prisma.customRole.findMany({ select: { id: true, inheritsFromId: true } });
      const parentOf = new Map(all.map((r) => [r.id, r.inheritsFromId]));
      const inheritsWanted = (id: string) => {
        const seen = new Set<string>();
        let cur: string | null | undefined = id;
        while (cur && !seen.has(cur)) {
          if (cur === wanted.id) return true;
          seen.add(cur);
          cur = parentOf.get(cur) ?? null;
        }
        return false;
      };
      const matching = all.filter((r) => inheritsWanted(r.id)).map((r) => r.id);
      where.customRoles = { some: { customRoleId: { in: matching }, suspendedAt: null } };
    }
    const rows = await prisma.user.findMany({
      where,
      orderBy: { displayName: "asc" },
      include: {
        customRoles: {
          where: { suspendedAt: null, customRole: { suspendedAt: null } },
          select: { customRoleId: true },
        },
        areaAssignments: {
          where: { suspendedAt: null, customRole: { suspendedAt: null }, area: { retiredAt: null } },
          select: {
            customRoleId: true,
            isTemporary: true,
            area: { select: { id: true, name: true } },
          },
        },
      },
    });

    // ── Roles and capabilities, resolved HERE ────────────────────────────
    //
    // The directory used to read `u.roles` off the UserRole table and work
    // the rest out itself. That table is gone, and the work it was doing —
    // walking inheritance to decide what someone can actually do — must not
    // be reimplemented in a browser: there would then be two answers to the
    // same question, and the one on screen would be the one nobody tested.
    //
    // So both facts come from the server, and the capability set comes from
    // `heldCapabilities`, the SAME function that resolves a request's
    // principal. A badge in this list and a 403 from a route cannot disagree
    // if they are computed by one function.
    //
    // The role table is read once for all rows rather than per user: this is
    // a page of the directory, and a findMany per person is how a 40-person
    // list becomes 40 round trips to a serverless Postgres.
    const roleRows = await prisma.customRole.findMany({
      select: {
        id: true, name: true, key: true, inheritsFromId: true,
        entitlements: { select: { entitlement: true } },
      },
    });
    // WHICH OF THESE LOGINS ARE CUSTOMERS. Same rule as `/me`: an ACTIVE
    // ClientContact for the Clerk id. One query for the page, not one per
    // row — this is the directory, and a findUnique per person is how a
    // 40-person list becomes 40 round trips to a serverless Postgres.
    const contactClerkIds = new Set(
      (
        await prisma.clientContact.findMany({
          where: {
            status: "ACTIVE",
            clerkUserId: { in: rows.map((r) => r.clerkUserId).filter(Boolean) },
          },
          select: { clerkUserId: true },
        })
      ).map((c) => c.clerkUserId as string),
    );

    const rolesById = new Map(
      roleRows.map((r) => [
        r.id,
        {
          id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
          entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement),
        },
      ]),
    );

    return rows.map((u) => {
      const companyWide = (u.customRoles ?? []).map((g) => ({
        roleId: g.customRoleId,
        key: rolesById.get(g.customRoleId)?.key ?? null,
        name: rolesById.get(g.customRoleId)?.name ?? "(unknown role)",
        areaId: null as string | null,
        areaName: null as string | null,
        isTemporary: false,
      }));
      const areaScoped = (u.areaAssignments ?? []).map((g) => ({
        roleId: g.customRoleId,
        key: rolesById.get(g.customRoleId)?.key ?? null,
        name: rolesById.get(g.customRoleId)?.name ?? "(unknown role)",
        areaId: g.area.id,
        areaName: g.area.name,
        isTemporary: g.isTemporary,
      }));

      // COMPANY-WIDE GRANTS ONLY, deliberately.
      //
      // `heldCapabilities` is a union over grants and does not look at
      // `areaPath` — that is `can()`'s job, which needs the area of the
      // RECORD being acted on and there is no record here. Folding the
      // area-scoped grants in would therefore report "runs the schedule"
      // for someone who only runs Durham's, and the directory would read as
      // if they were someone with `people.manage` of the business. They are not.
      //
      // The area grants are not lost: each one is its own entry in
      // `roleGrants` with its area name, which is how a badge says
      // "Admin — Durham" rather than "Admin".
      //
      // No perspective either. A perspective is something a person looks through at
      // their own view; it has no meaning when an operator is reading
      // somebody else's row, and applying one would under-report them.
      const capabilities = heldCapabilities({
        kind: "user",
        workerType: u.workerType ?? null,
        roles: companyWide.map((g) => ({
          roleId: g.roleId,
          name: g.name,
          entitlements: flattenRole(g.roleId, rolesById as never),
        })),
        perspective: null,
      });

      const { customRoles: _c, areaAssignments: _a, ...user } = u as typeof u & Record<string, unknown>;
      return {
        ...(user as typeof u),
        roleGrants: [...companyWide, ...areaScoped],
        capabilities,
        isClientContact: contactClerkIds.has(u.clerkUserId),
      };
    });
  },

  async listHoldings() {
    const rows = await prisma.checkout.findMany({
      where: { releasedAt: null },
      include: {
        equipment: {
          select: {
            id: true,
            shortDesc: true,
            qrSlug: true,
            brand: true,
            model: true,
            type: true,
            energy: true,
            features: true,
            condition: true,
            issues: true,
            age: true,
          },
        },
      },
      orderBy: { reservedAt: "desc" },
    });

    return rows.map((r) => ({
      userId: r.userId,
      equipmentId: r.equipmentId,
      shortDesc: r.equipment?.shortDesc ?? "",
      qrSlug: r.equipment?.qrSlug ?? "",
      brand: r.equipment?.brand ?? null,
      model: r.equipment?.model ?? null,
      type: r.equipment?.type ?? null,
      energy: r.equipment?.energy ?? null,
      features: r.equipment?.features ?? null,
      condition: r.equipment?.condition ?? null,
      issues: r.equipment?.issues ?? null,
      age: r.equipment?.age ?? null,
      state: r.checkedOutAt ? ("CHECKED_OUT" as const) : ("RESERVED" as const),
      reservedAt: r.reservedAt,
      checkedOutAt: r.checkedOutAt ?? null,
    }));
  },

  async approve(currentUserId, userId, opts) {
    // Optional `linkContactId` folds the "link Clerk account to a
    // ClientContact" step into the same transaction so the approval
    // surface in Users guarantees a wired-up client. Previously
    // "Approve as Client" only flipped isApproved, leaving the link as a
    // separate step that often got forgotten — the contact landed in the
    // Directory → Clients "Unlinked client accounts" worklist
    // even though the operator believed approval did everything.
    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { isApproved: true },
      });

      if (opts?.linkContactId) {
        if (!updated.clerkUserId) {
          throw new ServiceError(
            "USER_HAS_NO_CLERK",
            "Can't link a contact — this user has no Clerk account on file.",
            400,
          );
        }
        const contact = await tx.clientContact.findUnique({
          where: { id: opts.linkContactId },
          select: { id: true, clerkUserId: true, status: true, email: true, normalizedPhone: true },
        });
        if (!contact) {
          throw new ServiceError("CONTACT_NOT_FOUND", "Contact to link was not found.", 404);
        }
        if (contact.status !== "ACTIVE") {
          throw new ServiceError(
            "CONTACT_INACTIVE",
            "Can't link to an inactive contact — pick an active one.",
            409,
          );
        }
        // Defense-in-depth race guard. The picker only shows unlinked
        // contacts, but another admin could have linked this one in the
        // window between the picker loading and submit.
        if (contact.clerkUserId && contact.clerkUserId !== updated.clerkUserId) {
          throw new ServiceError(
            "CONTACT_ALREADY_LINKED",
            "This contact is already linked to a different Clerk account. Reload the picker and choose another.",
            409,
          );
        }
        if (!contact.clerkUserId) {
          // Backfill the contact's email with the Clerk email when the
          // contact has none. A contact created without an email is
            // useful as a stub but blocks email-based comms and breaks
          // the existing auto-link path on every subsequent sign-in.
          // The Clerk-provided email is the most-reliable address we
          // have for this person, so promoting it to the contact record
          // closes both gaps in one step.
          const backfillEmail = !contact.email && !!updated.email;
          await tx.clientContact.update({
            where: { id: contact.id },
            data: {
              clerkUserId: updated.clerkUserId,
              ...(backfillEmail ? { email: updated.email } : {}),
            },
          });
          await writeAudit(tx, AUDIT.CLIENT.CONTACT_LINKED, currentUserId, {
            contactId: contact.id,
            clerkUserId: updated.clerkUserId,
            viaApprove: true,
            ...(backfillEmail ? { emailBackfilledFromClerk: updated.email } : {}),
          });
        }
      }

      await writeAudit(tx, AUDIT.USER.APPROVED, currentUserId, {
        userRecord: { ...updated },
        ...(opts?.linkContactId ? { linkedContactId: opts.linkContactId } : {}),
      });

      return updated;
    });
  },



  async remove(currentUserId, userId, actorUserId) {
    if (!actorUserId) {
      throw new ServiceError("UNAUTHORIZED", "Missing actor", 401);
    }
    if (actorUserId === userId) {
      throw new ServiceError(
        "CANNOT_DELETE_SELF",
        "You cannot delete your own account",
        400
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      
    });
    if (!user) {
      throw new ServiceError("NOT_FOUND", "User not found", 404);
    }

    return prisma.$transaction(async (tx) => {
      // DON'T LOCK THE BUSINESS OUT OF ITSELF.
      //
      // This refused deleting the last holder of the top role. The sharper question
      // under capabilities is who can still GRANT ROLES: lose the last
      // holder of `people.grant-roles` and nobody can ever hand it to
      // anybody again, which is unrecoverable from inside the app — the
      // starter script and database access are the only way back.
      const canGrant = await tx.userCustomRole.findMany({
        where: {
          suspendedAt: null,
          customRole: {
            suspendedAt: null,
            entitlements: { some: { entitlement: "people.grant-roles" } },
          },
        },
        select: { userId: true },
      });
      const otherGranters = new Set(canGrant.map((g) => g.userId));
      otherGranters.delete(userId);
      if (otherGranters.size === 0 && canGrant.some((g) => g.userId === userId)) {
        throw new ServiceError(
          "LAST_ROLE_GRANTER",
          "This is the only person who can grant roles. Give somebody else " +
            "that ability first, or nobody will be able to grant anything again.",
          409,
        );
      }

      let clerkDeleted = false;
      if (user.clerkUserId) {
        try {
          await clerk.users.deleteUser(user.clerkUserId);
          clerkDeleted = true;
        } catch (e: any) {
          clerkDeleted =
            typeof e?.status === "number" ? e.status === 404 : false;
        }
      }

      // Strip the now-stale clerkUserId off any ClientContact rows that
      // pointed at this user. Without this, deleting a user leaves ghost
      // links — the contact shows "Linked" forever even though the Clerk
      // identity is gone — and blocks the next sign-up with that email
      // from auto-linking (the /client/link email match filters on
      // clerkUserId: null). Done in-transaction so a user delete + its
      // contact cleanup either both succeed or both abort.
      let contactsUnlinked = 0;
      if (user.clerkUserId) {
        const cleared = await tx.clientContact.updateMany({
          where: { clerkUserId: user.clerkUserId },
          data: { clerkUserId: null },
        });
        contactsUnlinked = cleared.count;
      }

      // JobOccurrenceAssignee.assignedById is `onDelete: SetNull`, so this
      // delete silently nulls it on every row where the departing user was
      // the ASSIGNER — at the database level, underneath the service layer.
      // A visit whose claimer marker was that null loses its claimer and
      // becomes unstartable for everyone below admin. (Their own assignee
      // rows can't be the problem: `userId` is `onDelete: Restrict`, so a
      // user who is still on a job can't be deleted at all.)
      //
      // Collect the affected visits BEFORE the delete, repair them after.
      // See lib/claimerInvariant.ts.
      const orphanedOccIds = (await tx.jobOccurrenceAssignee.findMany({
        where: { assignedById: userId },
        select: { occurrenceId: true },
        distinct: ["occurrenceId"],
      })).map((r) => r.occurrenceId);

      const userDelete = await tx.user.delete({ where: { id: userId } });

      for (const occurrenceId of orphanedOccIds) {
        await enforceAssigneeInvariants(tx, occurrenceId, currentUserId);
      }

      await writeAudit(tx, AUDIT.USER.DELETED, currentUserId, {
        userRecord: { ...userDelete },
        contactsUnlinked,
        claimerRepairsChecked: orphanedOccIds.length,
      });

      return { deleted: true as const, clerkDeleted, contactsUnlinked };
    });
  },

  async pendingApprovalCount(): Promise<{ pending: number }> {
    const count = await prisma.user.count({ where: { isApproved: false } });
    return { pending: count };
  },

  // Implements a GET /me endpoint that authenticates with Clerk (via header
  // or cookie), ensures there is a matching user in the database, then
  // returns a normalized "me" object. It grants NOTHING: there is no env
  // var that confers a role, and recovery is re-running
  // apps/api/scripts/install-starter-roles.ts.
  //
  // The optional `clientImpersonationContactId` swaps the returned identity
  // to look like a signed-in client when someone with `people.approve` has an active client
  // "View as" session. See plugins/clientImpersonation.ts — that plugin
  // validates the header + the view-as gate + read-only enforcement BEFORE this
  // service is called, so by the time we get here we only need to overlay
  // the me shape.  When applied:
  //   - roles becomes empty (`[]`) so every UI visibility guard that
  //     hides tabs from workers/holders of `people.manage`/holders of `settings.manage` passes as it would for a
  //     signed-in client
  //   - workerType becomes null
  //   - isApproved becomes true (clients don't go through worker approval)
  //   - identity fields (email, first/last, phone, displayName) reflect
  //     the ClientContact, not the real caller
  //   - realRoles / realWorkerType / isImpersonating are preserved so the
  //     ImpersonationBanner keeps rendering with its Exit affordance
  //   - `me.id` stays as the CALLER's real User.id — audit / attribution
  //     downstream never confuses the actor
  async me(
    token: string,
    impersonateHeader?: string | string[] | null,
    clientImpersonationContactId?: string | null,
  ) {
    // Verify token with Clerk
    let clerkUserId: string;
    try {
      const payload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      clerkUserId = String((payload as any).sub);
      if (!clerkUserId) throw new Error("Missing sub in token");
    } catch (err) {
      throw new ServiceError("UNAUTHORIZED", "Invalid token", 401);
    }

    // Fetch Clerk profile (for email/displayName + bootstrap check)
    let fetchedEmail: string | undefined;
    let fetchedDisplayName: string | undefined;
    try {
      if (clerk) {
        const u = await clerk.users.getUser(clerkUserId);
        fetchedEmail =
          u.primaryEmailAddress?.emailAddress ??
          u.emailAddresses?.[0]?.emailAddress ??
          undefined;
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
        fetchedDisplayName = (name || u.username || undefined) ?? undefined;
      }
    } catch (e) {
      console.warn(
        { clerkUserId, error: (e as Error).message },
        "[/me] Clerk profile fetch failed (continuing)"
      );
    }

    // Ensure local DB user exists (create if missing)
    let user = await prisma.user.findUnique({
      where: { clerkUserId },
      include: {
                    customRoles: {
                where: { suspendedAt: null, customRole: { suspendedAt: null } },
                include: { customRole: { include: { entitlements: true } } },
              },
              areaAssignments: {
                where: { suspendedAt: null, customRole: { suspendedAt: null } },
                include: { area: { select: { path: true, name: true } } },
              },
            },
    });

    if (!user) {
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            clerkUserId,
            email: fetchedEmail,
            displayName: fetchedDisplayName,
            isApproved: false,
          },
          include: {
                            customRoles: {
                    where: { suspendedAt: null, customRole: { suspendedAt: null } },
                    include: { customRole: { include: { entitlements: true } } },
                  },
                  areaAssignments: {
                    where: { suspendedAt: null, customRole: { suspendedAt: null } },
                    include: { area: { select: { path: true, name: true } } },
                  },
                },
        });
        // First sign-in auto-provisions the account row. USER.SIGN_IN
        // covers sessions, not the birth of the row — without this the
        // only account-creation trail is the createdAt column. Audited
        // ONLY on the create branch: /me runs on every authenticated
        // request and must not emit a row on the read path. Actor is the
        // user themselves — no admin is involved.
        await writeAudit(tx, AUDIT.USER.CREATED, created.id, {
          userId: created.id,
          clerkUserId,
          email: created.email ?? null,
          displayName: created.displayName ?? null,
          isApproved: false,
          source: "auto_provision_me",
        });
        return created;
      });
    } else {
      // Keep the local mirror in sync with Clerk (the identity source of
      // truth) on EVERY /me — not just when the field was missing. So when
      // any user changes their email or name in Clerk, the next /me picks
      // it up. fetchedX is undefined if the Clerk fetch above failed — in
      // that case fall back to the stored value rather than clobbering it.
      // Diff-checked, so this is a DB write only when something changed.
      const nextEmail = fetchedEmail ?? user.email;
      const nextDisplayName = fetchedDisplayName ?? user.displayName;
      if (nextEmail !== user.email || nextDisplayName !== user.displayName) {
        user = await prisma.user.update({
          where: { clerkUserId },
          data: { email: nextEmail, displayName: nextDisplayName },
          include: {
                            customRoles: {
                    where: { suspendedAt: null, customRole: { suspendedAt: null } },
                    include: { customRole: { include: { entitlements: true } } },
                  },
                  areaAssignments: {
                    where: { suspendedAt: null, customRole: { suspendedAt: null } },
                    include: { area: { select: { path: true, name: true } } },
                  },
                },
        });
      }
    }

    // Propagate the refreshed email to a linked client contact, if any.
    // A ClientContact linked to this account (by clerkUserId) is the same
    // person, so its email should track the account — otherwise a client
    // who updates their email leaves the CRM record (and payment-request
    // delivery) stale. Best-effort: a failure here must not break /me.
    // Only clients have a ClientContact — for workers/holders of `people.manage` this is a
    // no-op, and the User row above IS their record. Phone is not synced:
    // the email-magic-link Clerk setup doesn't carry a phone number.
    if (user.email) {
      try {
        // Post multi-client refactor, a single Clerk identity may be
        // bound to N ClientContact rows (one per Client). Sync the
        // Clerk-side email to ALL of them whose stored email has
        // drifted — keeps identity consistent across the cross-
        // client roles for the same person.
        const linkedContacts = await prisma.clientContact.findMany({
          where: { clerkUserId },
          select: { id: true, email: true },
        });
        const targetEmail = user.email;
        const stale = linkedContacts.filter(
          (c) => (c.email ?? "").toLowerCase() !== targetEmail.toLowerCase(),
        );
        if (stale.length > 0) {
          await prisma.clientContact.updateMany({
            where: { id: { in: stale.map((c) => c.id) } },
            data: { email: targetEmail },
          });
        }
      } catch (e) {
        console.warn(
          { clerkUserId, error: (e as Error).message },
          "[/me] Linked ClientContact email sync failed (continuing)",
        );
      }
    }

    // THE ENV-VAR BREAK-GLASS IS GONE (decision 47).
    //
    // It granted the full role ladder to any address listed in an env var,
    // on every single /me, so a fresh install had someone who could log in
    // and the owner could never be locked out. Two reasons it is deleted:
    //
    //   1. There are no enum roles left to grant. It would have to create
    //      custom-role grants instead — which means break-glass resolving
    //      THROUGH the entitlement tables, so a single bad grant row could
    //      lock the owner out permanently and the recovery path would be the
    //      thing that needed recovering.
    //   2. It was a standing back door keyed on an environment variable.
    //      Anyone who could set one on the deployment became someone with `people.manage`
    //      silently, on their next request, with an audit row that said the
    //      user approved themselves.
    //
    // Initial assignment is now `scripts/install-starter-roles.ts` plus a
    // grant, run against the database by someone with Neon access. Slower,
    // deliberate, and leaves no permanent hole.

    // Respond
    //
    // PERSPECTIVES REPLACED THE ROLE SWAP. This block used to compute
    // `effectiveRoles` by substituting a synthetic roles array, and return
    // `realRoles` alongside so the menu could still offer a way back. Both
    // are gone with the enum.
    //
    // A perspective narrows the caller's OWN capability set instead, which
    // is strictly better: the old swap dropped custom-role grants wholesale
    // to avoid leaking them, so "view as worker" could only ever show the
    // generic worker experience — someone with `people.approve` could not actually check what one
    // of their own people sees. There is also no `realRoles` to expose any
    // more, because the full list of perspectives is always returned and the
    // unnarrowed view is simply "no perspective selected".
    const realWorkerType = user!.workerType ?? null;
    const realIsOwner = !!user!.isOwner;

    // Does this login belong to a customer? See the field's note on the
    // response below. Counted rather than fetched — nothing here needs the
    // contact, only whether one exists — and keyed on the REAL Clerk id, so
    // someone with `people.approve` in a client "View as" session is still not a client contact.
    const isClientContact =
      (await prisma.clientContact.count({
        where: { clerkUserId, status: "ACTIVE" },
      })) > 0;

    // Role table, for inheritance. Small, and read once.
    const allRoles = await prisma.customRole.findMany({
      select: {
        id: true, name: true, key: true, inheritsFromId: true,
        isPerspective: true, perspectiveOrder: true, perspectiveIcon: true,
        entitlements: { select: { entitlement: true } },
      },
    });
    const rolesById = new Map(
      allRoles.map((r) => [
        r.id,
        {
          id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
          isPerspective: r.isPerspective, perspectiveOrder: r.perspectiveOrder,
          perspectiveIcon: r.perspectiveIcon,
          entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement),
        },
      ]),
    );
    // Company-wide grants only. Area-scoped ones do not change which PERSPECTIVES
    // are on offer — a perspective narrows what you may do, not where, and
    // mixing an area grant in would offer a perspective the person only holds in
    // one territory as if they held it everywhere.
    // AREA GRANTS COUNT HERE TOO.
    //
    // This read `customRoles` alone, so somebody whose ONLY access is an
    // AreaAssignment — which is the entire point of the feature — came back
    // with zero capabilities and zero perspectives. The server authorized
    // them correctly all along (`currentUser.me` builds `req.principal`
    // from BOTH lists, twenty lines of a sibling file away), so the API
    // worked and the browser showed them the no-access notice. Area
    // scoping has never been usable in the UI because of this line.
    //
    // The narrowing still happens server-side: `visibleAreaPaths` reads
    // `areaPath` off the principal's grants. What this list decides is what
    // the person may DO at all, which is not a territorial question — a
    // Durham-only Admin can do Admin things, inside Durham.
    const heldRoleIds = [
      ...(user!.customRoles ?? []).map((ucr: any) => ucr.customRoleId),
      ...((user as any)!.areaAssignments ?? []).map((aa: any) => aa.customRoleId),
    ];
    const perspectives = availablePerspectives(heldRoleIds, rolesById as never);
    const perspective = resolvePerspective(perspectives, impersonateHeader ?? null);



    // What this caller may DO, for UI gating — narrowed by the active perspective,
    // because a button that appears for an action the route will refuse is
    // the mismatch G15 exists to prevent.
    const capabilities = heldCapabilities({
      kind: "user",
      workerType: realWorkerType as WorkerType | null,
      roles: heldRoleIds.map((roleId: string) => ({
        roleId,
        name: rolesById.get(roleId)?.name ?? "",
        entitlements: flattenRole(roleId, rolesById as never),
      })),
      perspective,
    });

    // The two legacy "privileges" are just capabilities now, narrowed by
    // any active perspective. The columns and `resolvePrivileges` are gone: they
    // were a SECOND source of truth for the same facts, and the two could
    // disagree — which is exactly what a feature flag is supposed to prevent
    // and what a duplicate store guarantees.
    const priv = {
      canPullInventory: capabilities.includes("inventory.pull"),
      canChargeBusinessExpenses: capabilities.includes("expenses.charge"),
      // A field named for two deleted roles sat here, computed from
       // `schedule.manage` and read by nothing. A role name carrying a
       // capability's value is exactly the confusion this model removes.
    };

    // WHERE THIS PERSON'S VIEW IS NARROWED TO, for the app-wide notice.
    //
    // Area scoping was threaded through ~30 query sites and announced in
    // TWO of them, so a district lead saw shorter lists on every tab with
    // nothing anywhere saying "Durham". That is the exact failure the whole
    // area design is built around — a territory's rows vanishing looks
    // identical to that territory being empty — and the header chip does
    // not cover it: the chip hides itself when there is nothing to choose
    // between, which is precisely the grant-limited case.
    //
    // Computed from the caller's OWN grants rather than per-capability,
    // because one banner cannot be per-capability. `mixed` carries the
    // honesty: somebody holding one role company-wide and another inside an
    // area is narrowed on SOME views and not others, so the notice softens
    // rather than claiming every tab is filtered.
    const grantedAreas: Array<{ path: string; name: string }> = [
      ...new Map(
        (((user as any)!.areaAssignments ?? []) as any[])
          .map((aa) => aa.area)
          .filter((a: any) => a?.path)
          .map((a: any) => [a.path as string, { path: a.path as string, name: a.name as string }]),
      ).values(),
    ];

    // THE ANCESTOR CHAIN, so the notice can read "Chapel Hill → Carrboro"
    // rather than just "Carrboro". A bare leaf name is ambiguous the moment
    // two districts both have a route called "North", and it tells somebody
    // looking at a narrowed screen nothing about how much of the business
    // they are missing.
    //
    // Only queried when there IS an area grant — `/me` is on the hot path
    // for every request and most people have none.
    let areaTrails: string[][] = [];
    if (grantedAreas.length > 0) {
      const all = await prisma.area.findMany({ select: { id: true, name: true, path: true } });
      const nameById = new Map(all.map((a) => [a.id, a.name]));
      // The path is "/rootId/childId/…", so its ids ARE the chain. The root
      // is dropped: it is the container, not a place, and prefixing every
      // trail with "All areas" says nothing.
      areaTrails = grantedAreas
        .map((a) =>
          a.path.split("/").filter(Boolean).slice(1).map((id) => nameById.get(id) ?? "?"),
        )
        .filter((t) => t.length > 0)
        .sort((x, y) => x.join("/").localeCompare(y.join("/")));
    }

    const hasCompanyWideRole = ((user!.customRoles ?? []) as any[]).length > 0;
    const areaScope =
      areaTrails.length === 0 ? null : { trails: areaTrails, mixed: hasCompanyWideRole };

    const me = {
      id: user!.id,
      isApproved: !!user!.isApproved,
      /**
       * The territories this person's access is confined to, or null when
       * it is not confined at all. Each entry is the chain from the top of
       * the tree down to the granted area ("Chapel Hill", "Carrboro"), with
       * the root left out. `mixed` means they ALSO hold something
       * company-wide, so only some views are narrowed.
       */
      areaScope,
      /** Perspectives this person may look through, lowest access first. The web
       *  renders the top-tab dropdown from this. */
      // `icon` is here because a field has to survive THREE hops to reach
      // the browser — the Prisma `select`, the `rolesById` mapping, and
      // this re-pick — and every one of them silently drops what it does
      // not name. The map is handed over as `rolesById as never`, so the
      // type checker cannot see a missing field either. Adding one means
      // checking all three.
      perspectives: perspectives.map((p) => ({
        roleId: p.roleId, key: p.key, name: p.name, icon: p.icon, order: p.order,
      })),
      /** Which perspective is active, or null for "everything I hold". */
      activePerspectiveRoleId: perspective?.roleId ?? null,
      /** What this caller may DO, for UI gating. Mirrors the server's own
       *  decision so a button never appears for an action the route refuses
       *  — the mismatch G15 exists to prevent. */
      capabilities,
      email: user!.email ?? null,
      phone: user!.phone ?? null,
      firstName: user!.firstName ?? null,
      lastName: user!.lastName ?? null,
      displayName: user!.displayName ?? null,
      workerType: realWorkerType,
      // NOT NARROWED BY A PERSPECTIVE, as of 2026-10-23.
      //
      // This read `perspective ? false : realIsOwner`, on the reasoning that
      // "an owner looking through a narrower perspective is not an owner in
      // it". But `isOwner` is not a capability — it authorizes nothing,
      // appears in no guard and in no `can()` branch. It records WHO THE
      // BUSINESS BELONGS TO, and a perspective narrows what you may DO.
      // Note the line directly above: `workerType` is deliberately the real
      // value for the same reason. Suppressing one identity fact and not
      // the other was the inconsistency.
      //
      // The visible cost of suppressing it was a card that cannot work. An
      // LLC owner is not on payroll — they take draws, not wages, and never
      // produce a PayrollPeriod row — so under any perspective Home fell
      // back to MY PAYDAY and showed "No payroll records yet" forever.
      // OwnerEquityPanel exists precisely to replace that "true but useless
      // answer", and the suppression put it back.
      isOwner: realIsOwner,
      homeBaseAddress: user!.homeBaseAddress ?? null,
      availableDays: user!.availableDays ? JSON.parse(user!.availableDays) : [],
      availableHoursPerDay: user!.availableHoursPerDay ?? 4,
      // Hourly wage — read-only for the user themselves; only someone with `people.approve`
      // can update it via PATCH /users/:id/profile. Surfaced
      // here so workers can see what's on file for them in their
      // profile.
      hourlyWage: Number(user!.hourlyWage ?? 0),
      // Compliance-policy state (insurance, W-9, contractor agreement, safety
      // SOP, etc.) is served separately in Slice 2 via GET /me/policies +
      // getMe compliance-cache. Removed from this response payload with the
      // migration; frontends should read the new endpoint instead.
      // The two `*Override` fields are GONE. They exposed a per-person tick
      // that this model forbids (G20) — an exception is a named role, which
      // is visible in a role list rather than hidden on a profile.
      // THE NAMES HERE ARE THE OLD COLUMNS; the values are capabilities.
      // `canPullInventory` is `inventory.pull` and `canChargeBusinessExpenses`
      // is `expenses.charge`, resolved from the caller's roles through any
      // active perspective — there is no longer an "management wins, otherwise
      // override-or-default" resolution, because there are no override
      // columns and no roles to short-circuit on. The field names survive
      // only as the wire contract the web still reads; renaming them is a
      // coordinated API+web change and has not been done yet.
      privileges: {
        canPullInventory: priv.canPullInventory,
        canChargeBusinessExpenses: priv.canChargeBusinessExpenses,
      },
      // Real (unimpersonated) identity values. Present even when no
      // the perspective is active so the frontend can unconditionally read them.
      // The dropdown no longer needs `realRoles` to decide whether to show
      // itself: it renders from `perspectives`, which is non-empty exactly
      // when there is something to switch to.
      realWorkerType,
      isImpersonating: !!perspective,
      // False by default; overlaid to true below when the caller's client
      // "View as" session is active. Independent of the role-impersonation
      // flag above.
      isClientImpersonating: false,
      // Is this login attached to a customer record?
      //
      // Holding no capability means two completely different things, and
      // until now the web could not tell them apart: a CUSTOMER, who is
      // meant to see the client portal, and a staff account nobody has
      // granted a role to yet, who should be told so. Both arrived with an
      // empty capability set, so the staff case silently rendered the
      // customer shell — which is what four real accounts have been seeing.
      isClientContact,
    };

    // Client "View as" overlay. Only applies when the underlying caller
    // may view-as AND an impersonation-target contact ID was passed
    // (both true only if plugins/clientImpersonation.ts already validated
    // the session — the plugin refuses the request with 400 or silently
    // no-ops long before we reach this code path otherwise).
    // THE AUTHORITATIVE CHECK for client view-as.
    //
    // `capabilities` here is the caller's resolved set with any active
    // perspective already applied, so this is the only place that can decide
    // it correctly — the plugin runs in an onRequest hook, before a
    // principal exists, and now only records which contact was requested.
    //
    // `clients.view-as`, not `identity.link`: linking a login to a client
    // record is data entry someone with `people.manage` does, while this reads a customer's
    // entire portal as them. The old gate let every admin do it.
    const mayViewAsClient = capabilities.includes("clients.view-as");
    if (mayViewAsClient && clientImpersonationContactId) {
      const contact = await prisma.clientContact.findUnique({
        where: { id: clientImpersonationContactId },
        select: {
          clerkUserId: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
        },
      });
      if (contact && contact.clerkUserId) {
        const displayName =
          [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null;
        return {
          ...me,
          // Swap the identity + capability shape to what a signed-in client
          // would receive. Every downstream tab-visibility guard reads these
          // fields and now behaves as if the caller were a client.
          //
          // `capabilities: []` is what `roles: []` used to be. A client holds
          // no internal capability at all, so every button in the staff UI
          // gates itself off — which is the point of the overlay.
          isApproved: true,
          capabilities: [] as string[],
          perspectives: [],
          activePerspectiveRoleId: null,
          workerType: null,
          isOwner: false,
          email: contact.email ?? null,
          phone: contact.phone ?? null,
          firstName: contact.firstName ?? null,
          lastName: contact.lastName ?? null,
          displayName,
          // Client-impersonation privileges are meaningless (no worker
          // actions available); force to false so any code that checks
          // renders correctly.
          privileges: {
            canPullInventory: false,
            canChargeBusinessExpenses: false,
          },
          // real* stays as-is (the caller's actual roles) so the exit
          // affordance in ImpersonationBanner keeps rendering.
          isClientImpersonating: true,
        };
      }
    }

    return me;
  },

  async setWorkerType(currentUserId: string, userId: string, workerType: WorkerType | null) {
    if (workerType !== null && !isWorkerType(workerType)) {
      throw new ServiceError("BAD_REQUEST", "Invalid worker type", 400);
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { workerType: workerType as WorkerType | null },
      });
      await writeAudit(tx, AUDIT.USER.WORKER_TYPE_SET, currentUserId, {
        userId, workerType: workerType ?? "UNCLASSIFIED",
      });

      // Leaving payroll vacates every PAID seat this person holds on work
      // that has not been completed yet. Without this, their worker type
      // says "not paid" while live visits still expect to pay them — and the
      // next time one of those is priced, computeBreakdown refuses and the
      // whole completion fails.
      //
      // COMPLETED work is left untouched. Those promised payouts were locked
      // at completion under the class the person held at the time, and
      // rewriting them would restate what someone was owed for work already
      // done.
      if (!canHoldPaidSeat(workerType)) {
        const openSeats = await tx.jobOccurrenceAssignee.findMany({
          where: {
            userId,
            // A paid seat is `role: null` OR anything that is not
            // "observer". `NOT: { role: "observer" }` alone would miss the
            // NULL rows — and NULL is the ordinary worker state, so it would
            // have found nobody at all. Caught by the observer-filter gate,
            // which exists for exactly this three-valued-logic trap.
            OR: [{ role: null }, { role: { not: "observer" } }],
            occurrence: { completedAt: null },
          },
          select: { occurrenceId: true },
        });
        for (const occurrenceId of new Set(openSeats.map((s) => s.occurrenceId))) {
          await enforceAssigneeInvariants(tx, occurrenceId, currentUserId);
        }
      }

      return updated;
    });
  },

  // Set/unset the LLC-owner flag on a user. Singleton-enforced both in app
  // logic and via a partial unique index on User(isOwner) WHERE isOwner=true.
  // The route layer must gate this on `settings.manage` — the service trusts its
  // caller, like setWorkerType.
  async setIsOwner(currentUserId: string, userId: string, isOwner: boolean) {
    return prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, isOwner: true } });
      if (!target) throw new ServiceError("NOT_FOUND", "User not found", 404);
      if (isOwner) {
        const existing = await tx.user.findFirst({
          where: { isOwner: true, NOT: { id: userId } },
          select: { id: true, displayName: true, email: true },
        });
        if (existing) {
          throw new ServiceError(
            "OWNER_ALREADY_SET",
            `Another user is already flagged as owner (${existing.displayName ?? existing.email ?? existing.id}). Clear that one first.`,
            409,
          );
        }
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { isOwner },
      });
      await writeAudit(tx, AUDIT.USER.OWNER_FLAG_UPDATED, currentUserId, {
        userId, isOwner,
      });
      return updated;
    });
  },

  // updateInsuranceCert, recordContractorAgreement, and setW9Collected were
  // removed with the compliance-policy migration. See services/policies.ts
  // for the replacement flow — worker sign, admin upload on behalf, admin
  // review of uploaded artifacts.

};
