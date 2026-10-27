import { EventTypes } from "@/src/lib/types";

export function openEventSearch(
  eventName: EventTypes,
  q: string,
  // A boolean sat here, third. It meant "open the staff build of
  // the destination tab", because every tab had a worker build and someone with `schedule.manage`
  // build and a search result had to be routed to the right one. There is
  // one build now, so every caller was passing a flag the handler either
  // ignored or branched on into two identical bodies. Removed rather than
  // left dead: a parameter named for a deleted role is how the next person
  // concludes the roles still exist.
  entityId?: string,
  // Optional date anchor — used by the Payments → Jobs handoff to narrow
  // the JobsTab date range around the occurrence's startAt so the
  // highlighted row is visible without scrolling through a year-wide
  // window. Ignored by handoffs that don't care about a date anchor.
  anchorAt?: string | null,
) {
  window.dispatchEvent(
    new CustomEvent(`open:${eventName}`, { detail: { q, entityId, anchorAt } })
  );
}

/** `otherUser` — is this somebody else's profile, rather than your own?
 *  It was named for the caller's role instead of for the fact the
 *  handler needs; the handler now pairs it with `people.view`. */
export function navigateToProfile(userId: string, otherUser: boolean) {
  window.dispatchEvent(
    new CustomEvent("navigate:profile", { detail: { userId, otherUser } })
  );
}

// Signals the title-bar money chip to re-fetch its earnings number.
// Fire from any worker self-action that affects their own earnings
// (claim, unclaim, start, pause/resume, complete, take payment, etc.).
// Admin actions on other users intentionally do NOT fire this — those
// users will see fresh numbers on next page load.
export function bumpTitleBarEarnings() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("seedlings:earnings-changed"));
}

// Signals the Money tab to re-fetch its full payments list + pending
// approvals queue. Fire from any action that mutates a
// Payment row (approve, adjust, reject, write-off, edit/delete).
export function bumpPayments() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("seedlings:payments-changed"));
}

// Signals the WorkdayStrip (and any other listener) to re-fetch
// workday state. Fired by the lib/workday.ts mutation helpers after
// every successful POST/PATCH so any UI that started/paused/resumed/
// reopened/ended/cancelled the workday — including the cross-component
// workday-required gate dialog used by the start-job flow — keeps
// the home-screen strip in sync without a hard refresh.
export function bumpWorkday() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("seedlings:workday-changed"));
}

/**
 * Ask the global MileageReminderInterceptor to consider nudging the
 * worker about their driving log, right after they clocked in or out.
 *
 * Deliberately a SEPARATE event from `bumpWorkday()`. That one means
 * "workday state may have changed" and fires from a dozen places
 * including background refreshes and the offline queue draining — a
 * dialog on every one of those would be intolerable. This one fires
 * only from a person's own explicit start/end, and the interceptor
 * still checks whether there is anything worth saying before it opens.
 *
 *   "start" — clocked in with a vehicle assigned and no session open.
 *   "stop"  — clocked out with a session still running.
 *
 * Never fired for someone with `schedule.manage` acting as someone else: the mileage
 * endpoints are self-only server-side (driverUserId === caller), so
 * the prompt would offer an action the caller cannot take.
 */
export function promptMileageReminder(mode: "start" | "stop") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("seedlings:mileage-reminder", { detail: { mode } }),
  );
}

/**
 * Refresh the MY ACTIVITIES section and nothing else.
 *
 * Its children fetch independently, so "refresh this section" has to
 * reach them somehow — but it must not claim the workday CHANGED.
 * `bumpWorkday()` means real state moved, and other sections
 * legitimately react to it (WorkerHourlyPayCard recomputes pay-per-hour
 * off it). Firing that from a section's refresh button made every one of
 * those sections refresh too, which is exactly what a section-scoped
 * refresh is not supposed to do.
 */
export function bumpMyActivities() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("seedlings:my-activities-refresh"));
}

export function onEventSearchRun(
  eventName: EventTypes,
  setQ: (q: string) => void,
  inputRef: React.RefObject<HTMLInputElement>,
  setHighlightId?: (id: string | null) => void,
) {
  const onRun = (ev: Event) => {
    const { q, entityId } = (ev as CustomEvent<{ q?: string; entityId?: string }>).detail || {};
    if (typeof q === "string") {
      setQ(q);
      setHighlightId?.(entityId ?? null);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  };
  window.addEventListener(`${eventName}:run`, onRun as EventListener);
  return () =>
    window.removeEventListener(`${eventName}:run`, onRun as EventListener);
}
