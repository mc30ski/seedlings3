"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard — collapsible bordered section that groups a set of
// CompactBanner children into a single attention surface. Common
// across pages; each usage supplies its own `storageKey` (drives the
// localStorage-persisted collapse state) and optional `title`.
//
// Glow behavior: children registered via GlowContext bubble up.
// When the Dashboard is collapsed AND any child is glowing, the
// Dashboard frame itself pulses in the most-urgent palette
// (red > orange > blue). A small count badge on the header shows how
// many are hidden.
//
// `pinnedContent` is the exception to the collapse: it renders below
// the header and stays visible in both states.
//
// Children stay mounted while collapsed (via display:none) so their
// glow registration keeps working — otherwise unmounting would drop
// glow state and the collapsed frame wouldn't know anything's still
// active.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { Badge, Box, HStack, Text, VStack } from "@chakra-ui/react";
import { ChevronDown, ChevronRight, LayoutDashboard } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  GlowContext,
  type BannerPalette,
  type BannerRegistration,
  type GlowRegistry,
} from "@/src/ui/components/CompactBanner";

// Dashboard uses a single neutral gray pulse regardless of the
// severity of the underlying child banners — the badge stays red so
// the "there's something here" signal is legible without picking
// per-child colors that fight the child's own tints.
const DASHBOARD_PULSE = "seedlings-pulse-gray 2.5s ease-in-out infinite";

export function Dashboard({
  storageKey,
  title = "Dashboard",
  icon: Icon = LayoutDashboard,
  children,
  pinnedContent,
  forceGlow,
  summarySlot,
  collapsedSummarySlot,
  count,
  variant = "default",
}: {
  /** Required — each usage needs its own key so pages don't share
   *  collapse state. Convention: "seedlings:<page>:dashboardOpen". */
  storageKey: string;
  /** Header label (default "Dashboard"). Upper-cased at render time. */
  title?: string;
  /** Header icon (default LayoutDashboard). Pass a distinct icon
   *  per Dashboard instance so multiple sections on one page read
   *  as different surfaces at a glance. */
  icon?: LucideIcon;
  children: React.ReactNode;
  /** Content rendered inside the frame, below the header, that the
   *  collapse toggle does NOT hide. Use when a section has a headline
   *  surface that should stay on screen (Home's hero card) while the
   *  individual rows underneath fold away. Unlike `children` it is not
   *  wrapped in GlowContext — it isn't a CompactBanner and must not
   *  contribute to the collapsed-state glow/count. */
  pinnedContent?: React.ReactNode;
  /** Externally-driven glow for Dashboards whose children aren't
   *  CompactBanners (so GlowContext registration wouldn't fire).
   *  When set AND collapsed, the frame pulses. Pair with `count`
   *  to show the actual number in the badge. */
  forceGlow?: BannerPalette;
  /** Optional inline content rendered next to the title in the
   *  header row (both open and collapsed). Use for at-a-glance stats
   *  that should stay visible in the collapsed state. */
  summarySlot?: React.ReactNode;
  /** Like `summarySlot`, but shown ONLY while collapsed. For a figure that
   *  the open body already states prominently — repeating it in the header
   *  is noise when you can see it, and the point of the header line when
   *  you can't. */
  collapsedSummarySlot?: React.ReactNode;
  /** Optional externally-supplied count for the header badge. When
   *  set, overrides the internally-computed glowing-child count.
   *  Use for Dashboards whose children aren't CompactBanners
   *  (Client Requests polls its own count). */
  count?: number;
  /** Visual variant. "default" = neutral gray section (Ops, Client
   *  Requests). "hero" = emerald + left accent stripe + elevation —
   *  used for MY DASHBOARD so it stands apart from every other
   *  section on the page. */
  variant?: "default" | "hero" | "info" | "estimate" | "team" | "neutral" | "pay";
}) {
  const [open, setOpen] = useState<boolean>(true);
  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v === "0") setOpen(false);
      else if (v === "1") setOpen(true);
    } catch { /* ignore */ }
  }, [storageKey]);
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  // Full registry — every mounted CompactBanner child registers with
  // its icon + palette + glowing state. Icons drive the collapsed
  // header's right-aligned icon strip; glowing count drives the
  // pulse + badge count.
  const [registered, setRegistered] = useState<Map<string, BannerRegistration>>(new Map());
  const registry = useMemo<GlowRegistry>(() => ({
    register: (id, reg) => setRegistered((prev) => {
      const next = new Map(prev);
      next.set(id, reg);
      return next;
    }),
    update: (id, reg) => setRegistered((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, reg);
      return next;
    }),
    unregister: (id) => setRegistered((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    }),
  }), []);
  const registeredEntries = Array.from(registered.values());
  const glowingEntries = registeredEntries.filter((r) => r.glowing);
  const glowCount = glowingEntries.length;
  const shouldPulse = !open && (glowCount > 0 || !!forceGlow);
  const animation = shouldPulse ? DASHBOARD_PULSE : undefined;

  // Red circle badge — always red regardless of underlying palette
  // urgency, so the visual signal is consistent across sections.
  const RedCountBadge = ({ children }: { children: React.ReactNode }) => (
    <Box
      minW="18px"
      h="18px"
      px="1.5"
      borderRadius="full"
      bg="red.500"
      color="white"
      fontSize="xs"
      fontWeight="bold"
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
    >
      {children}
    </Box>
  );

  // Variant palettes.
  //   default — neutral gray section frame.
  //   hero    — emerald surface + left accent stripe + elevation; draws the
  //             eye. Its header is a tinted, tappable band (see headerBg).
  //   info    — blue surface for a section that states facts rather than
  //             prompting action (Home's PAYROLL summary). Same shape as
  //             hero so its content sits DIRECTLY in the frame — no inner
  //             card, which would read as a section inside a section.
  //   estimate— amber, for a number the app DERIVED rather than received.
  //   team    — purple, for an operator-side team snapshot that is neither
  //             the worker's estimate nor what they were paid.
  const PALETTES = {
    default: {
      frameBg: "gray.200",
      border: "gray.400",
      shadow: undefined as string | undefined,
      title: "gray.700",
      titleSize: "xs",
      icon: "var(--chakra-colors-gray-700)",
      chevron: undefined as string | undefined,
      headerBg: undefined as string | undefined,
      headerHoverBg: undefined as string | undefined,
      // Intentionally NO stripe and no header band. `default` predates this
      // family of palettes and is used by an unrelated tab; new sections
      // that want the family look should use `neutral`, not restyle this.
      stripe: undefined as string | undefined,
    },
    // Purple — the team-snapshot member of the family.
    //
    // Colour is nearly forced here. Home already spends green on MY
    // ACTIVITIES, amber on the worker's ESTIMATE and blue on what was
    // ACTUALLY paid; orange carries warnings elsewhere on the page
    // (mileage, unmatched payroll) and red means error. Gray read as
    // "disabled" beside three coloured neighbours, and teal just read as
    // green again. Purple is the one distinct slot left.
    team: {
      frameBg: "purple.50",
      border: "purple.300",
      shadow: "sm",
      title: "purple.900",
      titleSize: "sm",
      icon: "var(--chakra-colors-purple-700)",
      chevron: "var(--chakra-colors-purple-700)",
      headerBg: "purple.100",
      headerHoverBg: "purple.200",
      stripe: "purple.400",
    },
    hero: {
      frameBg: "green.50",
      border: "green.400",
      shadow: "md",
      title: "green.900",
      titleSize: "sm",
      icon: "var(--chakra-colors-green-700)",
      chevron: "var(--chakra-colors-green-700)",
      headerBg: "green.200",
      headerHoverBg: "green.300",
      stripe: "green.500",
    },
    // Amber. Marks a figure the app DERIVED rather than one it was told —
    // Home's "Approximate pay per hour" sits in this, directly above the
    // blue `info` PAYROLL section reporting what was actually paid.
    estimate: {
      frameBg: "yellow.50",
      border: "yellow.300",
      shadow: "sm",
      title: "yellow.900",
      titleSize: "sm",
      icon: "var(--chakra-colors-yellow-800)",
      chevron: "var(--chakra-colors-yellow-800)",
      headerBg: "yellow.100",
      headerHoverBg: "yellow.200",
      stripe: "yellow.400",
    },
    info: {
      frameBg: "blue.50",
      border: "blue.300",
      shadow: "sm",
      title: "blue.900",
      titleSize: "sm",
      icon: "var(--chakra-colors-blue-700)",
      chevron: "var(--chakra-colors-blue-700)",
      headerBg: "blue.100",
      headerHoverBg: "blue.200",
      stripe: "blue.400",
    },
    // Gray — the family look WITHOUT a colour claim.
    //
    // The `default` palette above predates this family and deliberately has
    // no stripe and no header band; restyling it would change an unrelated
    // tab. `neutral` is the one to reach for when a section wants the
    // family shape but must not imply a relationship to green / amber /
    // blue / purple, each of which carries meaning on Home. Team overview
    // uses it: it is a container for the whole team's state, not one of the
    // colour-coded measures beside it.
    neutral: {
      frameBg: "gray.50",
      border: "gray.300",
      shadow: "sm",
      title: "gray.800",
      titleSize: "sm",
      icon: "var(--chakra-colors-gray-700)",
      chevron: "var(--chakra-colors-gray-700)",
      headerBg: "gray.200",
      headerHoverBg: "gray.300",
      stripe: "gray.400",
    },
    // Pink — the team-wide ESTIMATED rate.
    //
    // The last unclaimed slot on Home. `estimate` (amber) is the worker's
    // own derived rate and `team` (purple) is the operator's team snapshot;
    // this section is both at once, so it can borrow neither without
    // reading as the wrong one. Orange means warning elsewhere in the app
    // and red means error, and teal beside a green hero just reads as green
    // again — which leaves pink.
    pay: {
      frameBg: "pink.50",
      border: "pink.200",
      shadow: "sm",
      title: "pink.800",
      titleSize: "sm",
      icon: "var(--chakra-colors-pink-600)",
      chevron: "var(--chakra-colors-pink-600)",
      headerBg: "pink.100",
      headerHoverBg: "pink.200",
      stripe: "pink.400",
    },
  } as const;

  const pal = PALETTES[variant] ?? PALETTES.default;
  const frameBg = pal.frameBg;
  const frameBorderColor = pal.border;
  const frameShadow = pal.shadow;
  const titleColor = pal.title;
  const titleSize = pal.titleSize;
  const iconColor = pal.icon;
  const chevronColor = pal.chevron;
  const headerBg = pal.headerBg;
  const headerHoverBg = pal.headerHoverBg;
  const isHero = variant !== "default";

  return (
    <Box
      borderWidth="1px"
      borderColor={frameBorderColor}
      borderRadius="lg"
      bg={frameBg}
      p={3}
      // Left accent stripe (hero only) — 4px solid emerald band flush
      // to the left inner edge. Uses borderLeftWidth in place of the
      // 1px baseline so total frame width is preserved.
      borderLeftWidth={pal.stripe ? "4px" : "1px"}
      borderLeftColor={pal.stripe ?? frameBorderColor}
      shadow={frameShadow}
      style={animation ? { animation } : undefined}
    >
      <HStack
        as="button"
        onClick={toggle}
        gap={2}
        align="center"
        mb={open || pinnedContent ? 2 : 0}
        w="full"
        cursor="pointer"
        bg={headerBg}
        px={isHero ? 2 : 0}
        py={isHero ? 1.5 : 0}
        borderRadius={isHero ? "md" : undefined}
        _hover={isHero ? { bg: headerHoverBg } : { opacity: 0.85 }}
        textAlign="left"
      >
        {open
          ? <ChevronDown size={14} color={chevronColor} />
          : <ChevronRight size={14} color={chevronColor} />}
        <Icon size={isHero ? 16 : 14} color={iconColor} />
        <Text
          fontSize={titleSize}
          fontWeight={isHero ? "bold" : "semibold"}
          color={titleColor}
          textTransform="uppercase"
          letterSpacing="wide"
          // Truncate rather than overflow — view-as titles carry a worker
          // name ("Approximate pay per hour · Employee Worker") and ran off
          // the right edge on a phone.
          minW={0}
          lineClamp={1}
        >
          {title}
        </Text>
        {/* Badge next to the title. Prefers an externally-supplied
            count (Client Requests polls its own count), otherwise
            falls back to the glowing-child count from the registry
            (My Dashboard). Only rendered when collapsed. */}
        {!open && (() => {
          const displayCount = count ?? glowCount;
          if (displayCount <= 0) return null;
          return <RedCountBadge>{displayCount}</RedCountBadge>;
        })()}
        {(summarySlot || (!open && collapsedSummarySlot)) && (
          <Box flex="1" minW={0} overflow="hidden">
            {summarySlot}
            {!open && collapsedSummarySlot}
          </Box>
        )}
        {!summarySlot && !(!open && collapsedSummarySlot) && <Box flex="1" />}
        {/* Right-aligned strip: preview icons of each registered
            child banner (only rendered when collapsed so the open
            header stays uncluttered). Each icon inherits its own
            banner palette (via the registered `palette` field) so
            the strip visually mirrors the color-coding of the rows
            below — same green Play as "On the clock", same orange
            Bell as Notifications, etc. */}
        {!open && registeredEntries.length > 0 && (
          <HStack gap={1} flexShrink={0}>
            {registeredEntries.map((r, i) => (
              <Box
                key={i}
                display="inline-flex"
                alignItems="center"
                color={`${r.palette}.600`}
              >
                {r.icon}
              </Box>
            ))}
          </HStack>
        )}
      </HStack>
      {pinnedContent && (
        <Box mb={open ? 2 : 0}>{pinnedContent}</Box>
      )}
      {open && (
        <GlowContext.Provider value={registry}>
          <VStack align="stretch" gap={2}>
            {children}
          </VStack>
        </GlowContext.Provider>
      )}
      {!open && (
        <GlowContext.Provider value={registry}>
          <Box display="none" aria-hidden>
            <VStack align="stretch" gap={2}>
              {children}
            </VStack>
          </Box>
        </GlowContext.Provider>
      )}
    </Box>
  );
}
