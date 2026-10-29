"use client";

// THE PORTFOLIO LENS, in the title bar — "show me only Durham".
//
// A LENS IS NOT A GRANT, and this control only exists because they are
// different things. A grant (an PortfolioAssignment) decides what you are ALLOWED
// to see and only ever widens. This decides what you are LOOKING AT and only
// ever narrows, inside what your grants already reach. So somebody who can
// see the whole company can still ask to read one district — which is the
// request this was built for — and somebody granted Durham alone cannot use
// it to reach Chapel Hill: the server intersects the choice with the grants,
// and a lens outside them resolves to nothing rather than to that territory.
//
// WHY IT IS LOUD WHEN SET. This is the feature's one real hazard: "Chapel
// Hill earned nothing this month" and "you have been looking at Durham since
// Tuesday" put the identical empty screen in front of you. The choice is
// persisted, so the chip names the portfolio whenever one is in force — that
// badge is what pays for the persistence.
//
// Mirrors ThemeChip/RoleChip's structure (relative box, click-outside,
// absolute panel) so the header's dropdowns behave identically.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, HStack, Text } from "@chakra-ui/react";
import { Check, Layers } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import {
  getAreaLens,
  setAreaLens,
  AREA_LENS_CHANGED_EVENT,
  type AreaLensOption,
} from "@/src/lib/impersonation";

export default function PortfolioLensChip() {
  const [open, setOpen] = useState(false);
  const [portfolios, setAreas] = useState<AreaLensOption[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Same off-screen nudge ThemeChip needs: the chip sits ~90px in from the
  // right edge, so anchoring a panel to it runs off the left of a phone.
  const [shiftX, setShiftX] = useState(0);
  useLayoutEffect(() => {
    if (!open) { setShiftX(0); return; }
    const el = panelRef.current;
    if (!el) return;
    const overflowLeft = 8 - el.getBoundingClientRect().left;
    if (overflowLeft > 0) setShiftX(overflowLeft);
  }, [open]);

  useEffect(() => {
    setActive(getAreaLens());
    let cancelled = false;
    (async () => {
      try {
        // Not `/portfolios`, which is gated on `portfolios.manage` — administering the
        // tree and choosing what to look at are different jobs held by
        // different people. `/me/portfolios` answers with the subtrees THIS caller
        // can already see, so the list itself discloses nothing.
        const res = await apiGet<{ portfolios: AreaLensOption[] }>("/api/me/portfolios");
        if (!cancelled) setAreas(res.portfolios ?? []);
      } catch {
        // A header control must never be the thing that breaks the app. No
        // list means no picker, and everything carries on unlensed.
        if (!cancelled) setAreas([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function handleChanged() { setActive(getAreaLens()); }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    window.addEventListener(AREA_LENS_CHANGED_EVENT, handleChanged);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener(AREA_LENS_CHANGED_EVENT, handleChanged);
    };
  }, [open]);

  // FEWER THAN TWO AREAS MEANS NO CHOICE TO MAKE. Someone granted Durham
  // alone already sees Durham and nothing else, so offering them "Durham" as
  // a filter would be a control that cannot change anything — and a control
  // that does nothing teaches people to distrust the ones that do.
  if (portfolios.length < 2) return null;

  const activeArea = portfolios.find((a) => a.id === active) ?? null;
  // An id we hold no row for — a portfolio retired since the choice was made, so
  // it is gone from this picker but still filtering on the server. Name it
  // rather than render a lens that looks like none.
  const lensOn = active !== null;
  const label = activeArea?.name ?? (lensOn ? "One portfolio" : null);

  function choose(id: string | null, name: string | null) {
    setOpen(false);
    setActive(id);
    void setAreaLens(id, name);
  }

  return (
    <Box position="relative" ref={ref} flexShrink={0}>
      <HStack
        as="button"
        gap={0}
        // SIZED TO THE ALERT BADGE, not to the theme icon beside it.
        // Explicit 24px rather than padding-plus-icon, because the two are
        // meant to read as the same kind of object — a small round status
        // dot — and a padding-derived size drifts the moment the icon
        // changes. Keep in step with the `width/height/minW="24px"` on the
        // alert badge in pages/index.tsx.
        width="24px"
        height="24px"
        minW="24px"
        justifyContent="center"
        rounded="full"
        // QUIET OFF, LOUD ON — but the same SIZE either way.
        //
        // This carried the portfolio's name in a filled pill, which read clearly
        // and cost more header than the header has: beside the theme icon,
        // the roles chip, the alert badge and the avatar, a word-width
        // control pushed the row. It is a filled circle now, exactly the
        // footprint of the theme switcher next to it, so turning the lens on
        // never reflows the strip.
        //
        // PURPLE, and not by elimination alone. Red is the alert badge,
        // green is the roles chip, teal is the client view-as bar and blue
        // is selection everywhere. Purple is already this app's colour for
        // "what you are looking at is not the default view" — it is what
        // BusinessStartRevealBanner uses — so the lens reads as a member of
        // that family rather than as a sixth unexplained accent.
        bg={lensOn ? "purple.solid" : open ? "blackAlpha.200" : "transparent"}
        color={lensOn ? "purple.contrast" : "chrome.headerFg"}
        _hover={{ bg: lensOn ? "purple.solid" : "blackAlpha.200" }}
        cursor="pointer"
        transition="all 0.1s"
        onClick={() => setOpen((v) => !v)}
        // THE NAME STILL HAS TO BE REACHABLE. Dropping the label saved the
        // space; it must not cost the answer to "narrowed to WHERE". The
        // tooltip and the accessible name both carry it, the open panel
        // marks the row, and the INSIGHTS note says it in words — that note
        // is now the one place the portfolio is spelled out on screen, so do not
        // quietly drop it when editing Dashboard.
        aria-label={lensOn ? `Viewing ${label} only — click to change portfolio` : "Viewing all portfolios — click to narrow to one"}
        aria-haspopup="menu"
        aria-expanded={open}
        title={lensOn ? `Viewing ${label} only` : "Viewing all portfolios"}
        data-testid="portfolio-lens-chip"
      >
        {/* The portfolio glyph, matching the Portfolios tab. A map pin
            said "place", and a portfolio need not be one — the tree
            already carries nodes tiered as Route. */}
        <Layers size={15} />
      </HStack>

      {open && (
        <Box
          ref={panelRef}
          position="absolute"
          zIndex={1000}
          right={0}
          top="100%"
          mt={1}
          transform={shiftX ? `translateX(${shiftX}px)` : undefined}
          bg="bg.panel"
          color="fg"
          // The header strip sets `lineHeight: 0` to close the gaps between
          // its icons, and this panel inherits it — every row would collapse
          // to its padding. See the same note in ThemeChip.
          lineHeight="normal"
          borderWidth="1px"
          borderColor="border.emphasis"
          rounded="lg"
          shadow="lg"
          w="248px"
          maxW="calc(100vw - 16px)"
          maxH="calc(100vh - 120px)"
          overflowY="auto"
          py={1}
          role="menu"
        >
          <Box px={3} py={1.5}>
            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
              Viewing
            </Text>
          </Box>

          <LensRow
            label="All portfolios"
            hint="All properties you have access to"
            active={!lensOn}
            onClick={() => choose(null, null)}
            testId="portfolio-lens-option-all"
          />

          {portfolios.map((a) => (
            <LensRow
              key={a.id}
              label={a.name}
              hint={a.tier ?? undefined}
              indent={indentOf(a, portfolios)}
              active={a.id === active}
              onClick={() => choose(a.id, a.name)}
              testId={`portfolio-lens-option-${a.id}`}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * How far to indent this option, in tree levels.
 *
 * Derived from the materialized path — the number of ids in it is the
 * node's depth — and normalised against the SHALLOWEST option on offer, so
 * the top of whatever subtree you can see sits flush at zero. That matters
 * because the list is already filtered: a sole root is dropped, and an
 * portfolio-limited reader is only offered their own branch. Indenting by raw
 * depth would push their whole list in by however deep their territory
 * happens to sit, which says nothing about anything.
 */
function indentOf(a: AreaLensOption, all: readonly AreaLensOption[]): number {
  const segs = (p: string) => p.split("/").filter(Boolean).length;
  const shallowest = Math.min(...all.map((x) => segs(x.path)));
  return Math.max(0, segs(a.path) - shallowest);
}

function LensRow({
  label, hint, indent = 0, active, onClick, testId,
}: {
  label: string;
  hint?: string;
  indent?: number;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <HStack
      as="button"
      role="menuitemradio"
      aria-checked={active}
      data-testid={testId}
      w="full"
      // Indent is on the PADDING here rather than a margin, unlike the
      // Portfolios tab: these rows have a full-width hover and selected state,
      // and a margin would leave an unhighlighted gutter down the left of
      // every nested row.
      // 20px a level, the same step the Portfolios tab's tree uses — the two
      // are the same hierarchy and should read as the same shape.
      pl={`${12 + indent * 20}px`}
      pr={3}
      py={2}
      gap={2}
      textAlign="left"
      cursor="pointer"
      bg={active ? "blue.faint" : undefined}
      _hover={{ bg: active ? "blue.subtle" : "gray.faint" }}
      onClick={onClick}
    >
      <Box flex="1" minW={0}>
        <Text
          fontSize="sm"
          fontWeight={active ? "semibold" : "normal"}
          color={active ? "blue.fg" : undefined}
          lineHeight="1.2"
          truncate
        >
          {label}
        </Text>
        {hint && (
          <Text fontSize="2xs" color="fg.muted" truncate>
            {hint}
          </Text>
        )}
      </Box>
      {active && <Check size={14} />}
    </HStack>
  );
}
