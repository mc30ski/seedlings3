import { EventTypes } from "@/src/lib/types";

export function openEventSearch(
  eventName: EventTypes,
  q: string,
  forAdmin: boolean
) {
  window.dispatchEvent(
    new CustomEvent(`open:${eventName}`, { detail: { q, forAdmin } })
  );
}

export function onEventSearchRun(
  eventName: EventTypes,
  setQ: (q: string) => void,
  inputRef: React.RefObject<HTMLInputElement>
) {
  console.log("HERE SETUP", eventName);
  const onRun = (ev: Event) => {
    const { q } = (ev as CustomEvent<{ q?: string }>).detail || {};
    if (typeof q === "string") {
      console.log("HERE", q);

      setQ(q);
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
