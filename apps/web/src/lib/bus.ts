import { EventTypes } from "@/src/lib/types";

export function openEventSearch(
  eventName: EventTypes,
  q: string,
  forAdmin: boolean,
  entityId?: string,
  // Optional date anchor — used by the Payments → Jobs handoff to narrow
  // the JobsTab date range around the occurrence's startAt so the
  // highlighted row is visible without scrolling through a year-wide
  // window. Ignored by handoffs that don't care about a date anchor.
  anchorAt?: string | null,
) {
  window.dispatchEvent(
    new CustomEvent(`open:${eventName}`, { detail: { q, forAdmin, entityId, anchorAt } })
  );
}

export function navigateToProfile(userId: string, forAdmin: boolean) {
  window.dispatchEvent(
    new CustomEvent("navigate:profile", { detail: { userId, forAdmin } })
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

// Signals the Admin Money tab to re-fetch its full payments list +
// pending approvals queue. Fire from any admin action that mutates a
// Payment row (approve, adjust, reject, write-off, edit/delete).
export function bumpAdminPayments() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("seedlings:admin-payments-changed"));
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
