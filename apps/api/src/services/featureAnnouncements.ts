// ─────────────────────────────────────────────────────────────────────────────
// WHAT'S NEW — the half of it the server owns.
//
// The server does NOT own the announcements. They live in the web app
// (`src/lib/whatsNew.ts`) and ship with the release they describe, which is
// the whole point: a release note written in the same change as the feature
// goes out when that change deploys, with nobody having to remember to type
// it into an admin screen afterwards. Compare `BannerNotification`, which is
// deliberately the opposite — an operator writing to named people.
//
// So all that is kept here is WHO HAS BEEN TOLD. The server never validates
// an announcement id against a list, because it has no list; an id that no
// longer exists in the registry simply stops being asked about.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";

/** What somebody did with the bar. Both are "seen"; they differ in whether
 *  the feature was actually opened, which is the number worth having. */
const ACTIONS = new Set(["shown", "skipped"]);

/** A registry key. Bounded and charset-limited because it arrives from the
 *  client and is stored verbatim — the web app writes kebab-case slugs. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const featureAnnouncements = {
  /**
   * The announcements this person has already answered.
   *
   * Ids only. The browser holds the registry, so it needs nothing from here
   * but the set to subtract — and sending back rows the client cannot read
   * anything into would only grow with every release.
   */
  async seenIdsFor(userId: string): Promise<string[]> {
    const rows = await prisma.featureAnnouncementSeen.findMany({
      where: { userId },
      select: { announcementId: true },
    });
    return rows.map((r) => r.announcementId);
  },

  /**
   * Record that somebody has been told.
   *
   * IDEMPOTENT, and that matters more than it looks: this fires on a click
   * in a bar that is on screen in every open tab at once, so the same
   * announcement can be answered twice within a second. The unique index is
   * what makes the second one a no-op rather than a second row that leaves
   * the bar permanently returning for one of them.
   *
   * FIRST ANSWER WINS. "Show me" then "Skip" from a second tab must not
   * rewrite the row to `skipped` — the person did open the feature, and that
   * is the fact worth keeping.
   */
  async markSeen(userId: string, announcementId: string, action: string) {
    if (!ID_RE.test(announcementId)) {
      throw new ServiceError("INVALID", "Not an announcement id.", 400);
    }
    if (!ACTIONS.has(action)) {
      throw new ServiceError("INVALID", "Action must be 'shown' or 'skipped'.", 400);
    }
    // audit-allow: the row IS the record. This is a person acknowledging a
    // UI notice about their own screen — no business state moves — and it
    // fires once per person per release, so auditing it would add a row per
    // user per deploy that says exactly what the table it duplicates says.
    const created = await prisma.featureAnnouncementSeen.createMany({
      data: [{ userId, announcementId, action }],
      skipDuplicates: true,
    });
    return { ok: true as const, alreadySeen: created.count === 0 };
  },

  /**
   * Un-see one announcement, or all of them.
   *
   * THE WAY BACK. Without this, answering the bar is permanent: there is no
   * second chance to look at a change you skipped on a busy morning, and —
   * the way it was actually found — no way for anybody to see the thing
   * twice while building it. A notice you get exactly one shot at is a
   * notice most people miss.
   *
   * Deleting the row rather than flagging it: the row's whole meaning is
   * "this person has been told", and somebody asking to be told again has
   * unmade exactly that.
   */
  async forget(userId: string, announcementId?: string) {
    // audit-allow: the inverse of markSeen, which is audit-allowed for the
    // same reason — a person changing what their own screen shows them.
    const { count } = await prisma.featureAnnouncementSeen.deleteMany({
      where: { userId, ...(announcementId ? { announcementId } : {}) },
    });
    return { ok: true as const, forgotten: count };
  },
};
