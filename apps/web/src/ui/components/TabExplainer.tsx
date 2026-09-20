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

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge, Box, HStack, Text, VStack } from "@chakra-ui/react";
import { Info } from "lucide-react";
import { usePersistedState } from "@/src/lib/usePersistedState";

/** ONE PREFERENCE, NOT THIRTY-SEVEN.
 *
 *  Help used to be open/closed PER TAB, under a per-tab (and per-role)
 *  localStorage key. So turning help on told you about the tab you were
 *  standing on and nothing else: every tab you moved to was closed again,
 *  and you had to hunt for the (i) each time. That is backwards — someone
 *  who wants the help wants it while they find their way around, which is
 *  exactly when they are moving between tabs.
 *
 *  It is now a single preference: help is on, or it is off, and it stays
 *  that way until you toggle it. Each tab still supplies its own copy; only
 *  the open/closed state is shared.
 *
 *  (This also retires a bug: nine role-branching explainers shared one key
 *  across roles, so collapsing the panel as a worker also collapsed the
 *  different text an admin saw. With one key there is nothing to disagree.) */
const HELP_OPEN_KEY = "help:open";

/** Fired whenever the preference changes, because `usePersistedState` is
 *  per-hook state: the breadcrumb button and the mounted panel are two
 *  separate hooks over the same key and would otherwise never see each
 *  other's writes. Carries the new value so both settle on the same one. */
const OPEN_CHANGED_EVENT = "seedlings:tab-explainer-open-changed";

/** The shared open/closed state. Every explainer and every trigger reads
 *  this — there is no per-tab variant to fall out of step with. */
function useHelpOpen(): [boolean, (next: boolean) => void] {
  const [open, setOpenRaw] = usePersistedState<boolean>(HELP_OPEN_KEY, false);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ open?: boolean }>).detail;
      if (typeof d?.open === "boolean") setOpenRaw(d.open);
    };
    window.addEventListener(OPEN_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(OPEN_CHANGED_EVENT, onChanged);
  }, [setOpenRaw]);

  // The value is dispatched explicitly rather than computed inside the state
  // updater — an updater must stay pure, and React may call it twice.
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenRaw(next);
      try {
        window.dispatchEvent(new CustomEvent(OPEN_CHANGED_EVENT, { detail: { open: next } }));
      } catch {}
    },
    [setOpenRaw],
  );

  return [open, setOpen];
}

/** ONE QUESTION, ASKED THE SAME WAY EVERYWHERE.
 *
 *  These were 36 hand-written titles — "What Home shows", "What Crews are",
 *  "How supplies are tracked", "What the Ledger is" — each a small guess at
 *  the right noun and verb for its tab. They answer the same question, so
 *  the panel now asks it identically and the tab supplies the context. Also
 *  the button's accessible name, where "What this tab shows" reads better
 *  than a phrase that assumes you know which tab you are on. */
export const DEFAULT_EXPLAINER_TITLE = "What this tab shows";

/** The explainer currently mounted, if any. Exactly one tab's content is
 *  mounted at a time, so "the active explainer" is unambiguous.
 *
 *  INVERTED ON PURPOSE. The trigger lives in the breadcrumb row, which is
 *  rendered by pages/index.tsx — and that file has no business knowing the
 *  storage key, title and role suffix of all 37 explainers. Mapping them
 *  there by hand would be a table nobody updates when a tab is added, and the
 *  failure would be a silently missing button. Instead each explainer
 *  announces itself on mount and the breadcrumb renders whatever is there. */
type ActiveExplainer = { id: string; title: string } | null;
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
  return <TabExplainerButton title={current.title} />;
}

export function TabExplainerButton({ title }: { title: string }) {
  const [open, setOpen] = useHelpOpen();
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
      w="28px"
      h="28px"
      borderRadius="full"
      // VISIBLE AT REST. Closed, this was a bare glyph on a transparent
      // ground — no pill, no edge — so it read as decoration and people
      // missed it. It now always wears a filled, outlined pill; the OPEN
      // state is a step darker still, so the toggle distinction survives
      // without the closed state having to be invisible to make the point.
      //
      // Ink stays `blue.fg` in both states — `solid` is a FILL that carries
      // `contrast` ink, never a text colour. The on/off state is the pill
      // BEHIND the glyph, which keeps ink sitting on a fill rather than
      // trying to be one.
      //   closed — pale fill, SOLID blue ring, dark blue glyph
      //   open   — solid blue fill, white glyph
      //
      // The ring is what makes it findable: `blue.subtle` on a white page is
      // 1.22:1, so a pale pill with a pale edge is invisible no matter how
      // large it is. `blue.solid` as an EDGE is ~5:1 against the page.
      // Open uses solid as a FILL with its paired `contrast` ink — the one
      // correct way to use `solid`, and Chakra tunes the pair per theme.
      color={open ? "blue.contrast" : "blue.fg"}
      bg={open ? "blue.solid" : "blue.subtle"}
      borderWidth="1.5px"
      borderColor="blue.solid"
      _hover={{ bg: open ? "blue.solid" : "blue.muted" }}
      transition="background-color 120ms, border-color 120ms"
      onClick={() => setOpen(!open)}
    >
      <Info size={18} />
    </Box>
  );
}

export default function TabExplainer({
  explainerId,
  title = DEFAULT_EXPLAINER_TITLE,
  children,
}: {
  /** WHICH explainer this is — NOT a storage key. It stopped keying storage
   *  when the open/closed state became one shared preference (see
   *  HELP_OPEN_KEY); it survives as the mounted panel's identity, which is
   *  what the breadcrumb registry announces and what makes a duplicate mount
   *  visible in a test. Renamed off "storageKey" deliberately: a prop that
   *  says it keys storage and does not is the kind of name that causes bugs.
   *  Convention: "seedlings:<tab>Tab:guideOpen" (plus a role suffix). */
  explainerId: string;
  /** Almost always omitted. The panel answers the same question on every
   *  tab, so it asks it the same way — see DEFAULT_EXPLAINER_TITLE. Pass one
   *  only where "tab" is wrong for the surface. */
  title?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useHelpOpen();

  // Announce this explainer to the breadcrumb for as long as it is mounted.
  useEffect(() => {
    setActive({ id: explainerId, title });
    return () => setActive(null);
  }, [explainerId, title]);

  // NOTHING AT ALL when closed — not an empty wrapper. Reclaiming the space
  // this used to hold at the top of every tab is the entire point.
  if (!open) return null;

  return (
    // A DISTINCT LAYER, NOT ANOTHER CARD.
    //
    // Every tab is already a column of bordered cards, so a differently
    // coloured 1px edge — which is what this was — just reads as one more of
    // them. Four things together are what separate it: a heavy border, a
    // thick left accent RAIL, real elevation, and a stronger fill. The rail
    // and the shadow do most of the work; they are the app's existing idiom
    // for "this section is not like the others" (see Dashboard's `hero`).
    //
    // No opt-in prop. This was trialled behind one on the worker Home tab
    // and kept, so it is the only path now — a flag every call site has to
    // remember is a flag some call site will forget.
    <Box
      borderWidth="2px"
      borderColor="blue.solid"
      borderLeftWidth="6px"
      borderRadius="md"
      overflow="hidden"
      shadow="md"
      mb={3}
      bg="blue.subtle"
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
        // A BAND, not a line. The heading sat on the same fill as the copy
        // with only a rule under it, so the panel read as one undivided
        // block.
        //
        // FULL-BLEED BY NOT PADDING THE FRAME, not by negative margins.
        // This was `w="full"` with `mx={-3}` against a frame that had
        // `px={3}` — but `width:100%` resolves against the frame's CONTENT
        // box, so the negative margins SHIFTED the band 12px left instead of
        // widening it: it ended 24px short of the right edge and looked like
        // a half-drawn header. The frame now carries no inline padding, each
        // child owns its own, and 100% really is the full width. The frame
        // still clips to its radius, so the band keeps the rounded top
        // corners.
        // TWO steps darker than the panel, not one. `blue.muted` was 1.16:1
        // against the `blue.subtle` fill — a band you cannot see is not a
        // band. `blue.strong` is 2.08:1 and still carries `fg.default` ink
        // at 6.98:1, so the title stays dark as well as the ground.
        // (`blue.solid` separates harder still but forces white ink.)
        bg="blue.strong"
        px={3}
        py={2}
        borderBottomWidth="1px"
        borderColor="blue.solid"
        cursor="pointer"
        onClick={() => setOpen(false)}
        aria-label={`Hide ${title}`}
      >
        <Box color="blue.fg" flexShrink={0} display="flex" alignItems="center">
          <Info size={14} />
        </Box>
        {/* Darker than the body copy under it — both were `blue.fg`, so the
            heading was doing its job on weight alone.
            `fg.default`, not a raw ramp step: it is the page's primary ink
            and flips with the theme exactly as `blue.subtle` beneath it
            does, so the pair holds in all 14. (`blue.contrast` would be the
            obvious "stronger blue" and is WHITE — 1.22:1 here.) */}
        <Text fontSize="xs" color="fg.default" fontWeight="semibold" flex="1" textAlign="left">
          {title}
        </Text>
      </HStack>
      <VStack align="stretch" gap={1.5} px={3} pt={3} pb={3}>
        {children}
      </VStack>
    </Box>
  );
}

/** ADDITIVE, NOT ALTERNATIVE.
 *
 *  Help text used to branch: a worker saw one version, an admin saw a
 *  DIFFERENT one, a super a third. Three problems with that shape.
 *
 *    • An admin is also a worker. Replacing the base text meant the shared
 *      behaviour had to be re-explained in every branch, or silently
 *      dropped — and it was dropped, in several tabs.
 *    • Three parallel copies drift. Fixing a fact in one branch left the
 *      other two wrong, and nothing pointed that out.
 *    • It hid the shape of the product. What an admin can do that a worker
 *      cannot is exactly the thing worth naming, and a rewritten paragraph
 *      buries it.
 *
 *  Buttons on these tabs are already additive — a super sees the worker's
 *  actions plus admin actions plus their own. The help now matches: base
 *  copy for everyone, then an "Admin" section, then a "Super" section, each
 *  appearing only when that role applies and each saying only what it ADDS.
 *
 *  Usage:
 *      <TabExplainer explainerId={...}>
 *        <ExplainerText>...what anyone on this tab can do...</ExplainerText>
 *        {scope.isAdmin && (
 *          <RoleSection role="Admin">
 *            <ExplainerText>...what admin adds...</ExplainerText>
 *          </RoleSection>
 *        )}
 *      </TabExplainer>
 */
export function RoleSection({
  role,
  children,
}: {
  role: "Admin" | "Super";
  children: ReactNode;
}) {
  return (
    <Box
      mt={2}
      pt={2}
      borderTopWidth="1px"
      borderColor="blue.emphasized"
    >
      <HStack gap={1.5} mb={1}>
        {/* Named for the ROLE CHIP the reader is wearing, so "Admin" here
            and "Admin" up in the header are obviously the same thing. */}
        <Badge size="xs" colorPalette={role === "Super" ? "purple" : "blue"} variant="solid">
          {role}
        </Badge>
        <Text fontSize="2xs" color="fg.muted">
          in addition to everything above
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
