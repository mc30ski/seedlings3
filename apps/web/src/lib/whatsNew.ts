// ─────────────────────────────────────────────────────────────────────────────
// WHAT'S NEW — the register of visible changes, and the only file a new
// feature has to touch to announce itself.
//
// ADDING ONE IS ONE ENTRY. Put it at the TOP of `WHATS_NEW`, give it an id
// nobody has used before, and it goes out with the deploy that carries the
// feature. There is no admin screen and nothing to publish afterwards,
// because the step somebody has to remember after shipping is the step that
// never happens.
//
// THE ID IS PERMANENT. It is written into a row against every person who
// answers the bar, and that row is the only record they have been told.
// Reusing an id for a different change silently announces it to nobody;
// renaming one re-announces an old change to everybody. Neither fails
// loudly, which is why this is said twice.
//
// WHO SEES IT: only people who can actually use the thing. `requires` is the
// capability the feature's OWN endpoint is guarded on — take it from
// docs/features/permissions-ROUTE-MAP.md, the same rule every other gate in
// this app follows. Announcing a feature to somebody who then cannot find it
// is worse than staying quiet. `requires: null` means everybody.
//
// WHEN TO ADD ONE: when a person who already knows the app would otherwise
// not notice the change, or would notice and not know what it was. A new
// control, a moved control, a new tab. Not a bug fix, not a speed-up, not
// anything invisible — a bar that cries wolf gets skipped on sight, and then
// the one announcement that mattered is skipped too.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fired whenever somebody's seen-state changes, from anywhere.
 *
 * THE BAR AND THE PANEL ARE TWO VIEWS OF ONE ROW. Without this they each
 * read it once at mount and then drift: skipping the bar left the panel on
 * Profile still calling the change unread, and — the way it was found —
 * hid the "Show all again" button, because the panel believed there was
 * nothing to reset.
 */
export const WHATS_NEW_CHANGED = "seedlings3:whats-new-changed";

export function notifyWhatsNewChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WHATS_NEW_CHANGED));
}

export type WhatsNewEntry = {
  /** Permanent, unique, kebab-case. Stored per person. Never reuse. */
  id: string;
  /** One line. What changed, in the words somebody would use out loud. */
  headline: string;
  /** A sentence or two. What it is for, not how it was built. */
  body: string;
  /**
   * The capability the feature's own endpoint requires, or null for
   * everybody. Nobody is told about something they cannot open.
   */
  requires: string | null;
  /**
   * Where "Show me" goes: the staff tab id, and optionally the category it
   * sits under. Omitted, the bar offers only Skip — right for a change that
   * is not in one place, like a change to every card.
   *
   * IT ALSO RINGS THE CONTROL. Tag it with `data-whats-new="<this entry's
   * id>"` and "Show me" scrolls to it and pulses it. That is not a flourish:
   * without it, somebody already on the destination tab presses Show me and
   * the app does nothing at all, which is how this shipped the first time.
   * A build gate requires the tag, so `spotlight: false` is how an entry
   * says out loud that there is no single control to point at.
   */
  showMe?: { tab: string; category?: string; spotlight?: false };
  /** Shown on the bar so an old announcement reads as old. ISO date. */
  shippedOn: string;
};

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: "day-map",
    headline: "See a day on a map",
    body:
      "Any day in the Jobs list can switch to a map of its addresses — colored " +
      "by what is done, running, or still unclaimed. Use the map icon at the " +
      "left of a day's heading.",
    // The map reads properties, which is what `GET /properties/points` is
    // guarded on. Everybody with a worker type holds it, but naming it keeps
    // the rule honest for the next entry, where it will matter.
    requires: "clients.view",
    showMe: { tab: "jobs", category: "Work" },
    shippedOn: "2026-11-06",
  },
];

/**
 * The one thing to tell this person about, or nothing.
 *
 * ONE AT A TIME, oldest first. Three bars stacked on a phone is a wall, and
 * answering the oldest first means a person who has been away a fortnight
 * meets the changes in the order they happened rather than in reverse.
 *
 * Unknown ids in `seen` are ignored rather than treated as an error: an
 * entry removed from this file leaves its rows behind for ever, and they are
 * harmless.
 */
export function nextAnnouncement(
  seen: ReadonlySet<string>,
  can: (capability: string) => boolean,
): WhatsNewEntry | null {
  const unseen = WHATS_NEW.filter(
    (e) => !seen.has(e.id) && (e.requires === null || can(e.requires)),
  );
  if (unseen.length === 0) return null;
  // The array is newest-first for whoever edits it; the reader wants the
  // oldest outstanding one.
  return unseen[unseen.length - 1];
}
