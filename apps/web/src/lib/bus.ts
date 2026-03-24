import { EventTypes } from "@/src/lib/types";

export function openEventSearch(
  eventName: EventTypes,
  q: string,
  forAdmin: boolean,
  entityId?: string,
) {
  window.dispatchEvent(
    new CustomEvent(`open:${eventName}`, { detail: { q, forAdmin, entityId } })
  );
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
