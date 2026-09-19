"use client";

// ─────────────────────────────────────────────────────────────────────────────
// The collapsed "what is this tab" disclosure.
//
// Standing copy that answers a question you ask once and then know. Open by
// default it held the top of every visit to the page — on a phone it pushed
// the actual content off the first screen entirely.
//
// EXTRACTED AFTER THE THIRD COPY. Supplies, Pricing and Promotions each had
// their own paste of this markup, and they had already begun to drift (one
// said "Show"/"Hide" where the others used a chevron, one used blue.300 for
// its border). A fourth and fifth copy were about to be written for the rest
// of Money.
//
// WRITE THE COPY FROM THE CODE, NOT FROM MEMORY. Explanatory text that
// disagrees with behaviour is worse than none, because it reads as
// documentation — a help string on the Supplies tab described a ledger link
// the UI had no control for, and it read as a shipped feature for weeks.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, type ReactNode } from "react";
import { Box, HStack, Text, VStack } from "@chakra-ui/react";
import { Info } from "lucide-react";
import { usePersistedState } from "@/src/lib/usePersistedState";

/** Fired when a remote trigger (see TabExplainerButton) wants to toggle a
 *  particular explainer. Carries the storageKey so several explainers can be
 *  mounted without listening to each other. */
const TOGGLE_EVENT = "seedlings:tab-explainer-toggle";

/** TRIAL (worker Jobs tab). Lets the affordance live somewhere other than
 *  above the content — currently the breadcrumb row's right edge — so the
 *  explainer costs no vertical space until it is opened.
 *
 *  Two components, one localStorage key. `usePersistedState` is per-hook
 *  state, so the button and the body would not see each other's writes; the
 *  event is what keeps them in step. */
export function toggleTabExplainer(storageKey: string) {
  try {
    window.dispatchEvent(new CustomEvent(TOGGLE_EVENT, { detail: { storageKey } }));
  } catch {}
}

/** The explainer currently mounted, if any. Exactly one tab's content is
 *  mounted at a time, so "the active explainer" is unambiguous.
 *
 *  INVERTED ON PURPOSE. The trigger lives in the breadcrumb row, which is
 *  rendered by pages/index.tsx — and that file has no business knowing the
 *  storage key, title and role suffix of all 37 explainers. Mapping them
 *  there by hand would be a table nobody updates when a tab is added, and the
 *  failure would be a silently missing button. Instead each explainer
 *  announces itself on mount and the breadcrumb renders whatever is there. */
type ActiveExplainer = { storageKey: string; title: string } | null;
const ACTIVE_EVENT = "seedlings:tab-explainer-active";
let active: ActiveExplainer = null;

function setActive(next: ActiveExplainer) {
  active = next;
  try {
    window.dispatchEvent(new CustomEvent(ACTIVE_EVENT, { detail: next }));
  } catch {}
}

/** The breadcrumb-row trigger. Renders nothing on tabs that have no
 *  explainer, so it can be mounted unconditionally. */
export function ActiveTabExplainerButton() {
  const [current, setCurrent] = useState<ActiveExplainer>(null);
  useEffect(() => {
    setCurrent(active);
    const onActive = (e: Event) =>
      setCurrent((e as CustomEvent<ActiveExplainer>).detail ?? null);
    window.addEventListener(ACTIVE_EVENT, onActive);
    return () => window.removeEventListener(ACTIVE_EVENT, onActive);
  }, []);
  if (!current) return null;
  return <TabExplainerButton storageKey={current.storageKey} title={current.title} />;
}

export function TabExplainerButton({
  storageKey,
  title,
}: {
  storageKey: string;
  title: string;
}) {
  const [open, setOpen] = usePersistedState<boolean>(storageKey, false);
  useEffect(() => {
    const onToggle = (e: Event) => {
      const d = (e as CustomEvent<{ storageKey?: string }>).detail;
      if (d?.storageKey === storageKey) setOpen((v) => !v);
    };
    window.addEventListener(TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_EVENT, onToggle);
  }, [storageKey, setOpen]);
  return (
    <Box
      as="button"
      aria-label={title}
      aria-expanded={open}
      title={title}
      display="flex"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
      w="24px"
      h="24px"
      borderRadius="full"
      // Ink stays `blue.fg` in both states — `solid` is a FILL that carries
      // `contrast` ink, never a text colour. The on/off state is the pill
      // BEHIND the glyph, which is the conventional toggle shape and keeps
      // ink sitting on a fill rather than trying to be one.
      color="blue.fg"
      bg={open ? "blue.muted" : "transparent"}
      borderWidth="1px"
      borderColor={open ? "blue.strong" : "transparent"}
      _hover={{ bg: open ? "blue.muted" : "blue.subtle" }}
      transition="background-color 120ms, border-color 120ms"
      onClick={() => toggleTabExplainer(storageKey)}
    >
      <Info size={16} />
    </Box>
  );
}

export default function TabExplainer({
  storageKey,
  title,
  children,
}: {
  /** Per-tab, per-role where the copy differs by role — so collapsing it as a
   *  worker does not also collapse the different text an admin sees.
   *  Convention: "seedlings:<tab>Tab:guideOpen" (plus a role suffix). */
  storageKey: string;
  /** Short. It names the panel when open and labels the breadcrumb button
   *  when closed — "How supplies are tracked", not a sentence. */
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistedState<boolean>(storageKey, false);

  // Announce this explainer to the breadcrumb for as long as it is mounted.
  useEffect(() => {
    setActive({ storageKey, title });
    return () => setActive(null);
  }, [storageKey, title]);

  useEffect(() => {
    const onToggle = (e: Event) => {
      const d = (e as CustomEvent<{ storageKey?: string }>).detail;
      if (d?.storageKey === storageKey) setOpen((v) => !v);
    };
    window.addEventListener(TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_EVENT, onToggle);
  }, [storageKey, setOpen]);

  // NOTHING AT ALL when closed — not an empty wrapper. Reclaiming the space
  // this used to hold at the top of every tab is the entire point.
  if (!open) return null;

  return (
    <Box
      borderWidth="1px"
      borderColor="blue.emphasized"
      borderRadius="md"
      px={2}
      py={2}
      mb={3}
      bg="blue.faint"
    >
      {/* THE TITLE STAYS. Moving the trigger to the breadcrumb is about
          reclaiming space when CLOSED — open, the panel still has to say what
          it is, or it reads as an unlabelled wall of text that appeared from
          nowhere. Clicking it closes, so the only way back is not hunting for
          the icon that opened it. No chevron: this only ever renders open, so
          a chevron here points one way forever. */}
      <HStack
        as="button"
        w="full"
        gap={2}
        pb={1.5}
        mb={1.5}
        borderBottomWidth="1px"
        borderColor="blue.emphasized"
        cursor="pointer"
        onClick={() => setOpen(false)}
        aria-label={`Hide ${title}`}
      >
        <Box color="blue.fg" flexShrink={0} display="flex" alignItems="center">
          <Info size={14} />
        </Box>
        <Text fontSize="xs" color="blue.fg" fontWeight="semibold" flex="1" textAlign="left">
          {title}
        </Text>
      </HStack>
      <VStack align="stretch" gap={1.5}>
        {children}
      </VStack>
    </Box>
  );
}

/** A paragraph inside a TabExplainer. Exists so callers do not each re-declare
 *  the size and colour — three copies of this markup had already drifted. */
export function ExplainerText({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="xs" color="blue.fg">
      {children}
    </Text>
  );
}

/** Emphasis inside explainer copy. */
export function Em({ children }: { children: ReactNode }) {
  return (
    <Text as="span" fontWeight="semibold">
      {children}
    </Text>
  );
}
