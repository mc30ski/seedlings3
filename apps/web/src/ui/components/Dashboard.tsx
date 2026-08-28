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
import {
  Badge, Box, HStack, IconButton, Select, Spinner, Text, VStack, createListCollection,
} from "@chakra-ui/react";
import { ChevronDown, ChevronRight, LayoutDashboard, RefreshCw } from "lucide-react";
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
// Pulse keyframe now comes from the PALETTE (see `pulse` on each entry
// below), not from one shared constant. Every section used to pulse gray
// no matter its colour, so an orange or purple frame flashed a grey
// ripple — read as a bug rather than as attention.
const FALLBACK_PULSE = "seedlings-pulse-gray 2.5s ease-in-out infinite";

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
  onRefresh,
  refreshing = false,
  timeframe,
  timeframeSlot,
  accentColor,
  headerAction,
  defaultOpen = true,
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
  /**
   * Externally-driven glow for Dashboards whose children aren't
   * CompactBanners (so GlowContext registration wouldn't fire). Pair with
   * `count` to show the number in the badge.
   *
   * TRIGGER ONLY — the pulse COLOUR comes from the variant's palette, so
   * a section always pulses in its own colour. Passing a palette name
   * here that differs from the variant does not change the colour, by
   * design: that mismatch is how "Awaiting payment" (purple) ended up
   * asking for an orange pulse.
   */
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
  /**
   * Section-scoped refresh. When supplied, Dashboard renders a refresh
   * control in the title bar, dims the body behind a centred spinner while
   * `refreshing` is true, and re-runs this automatically whenever the
   * section is expanded from collapsed.
   *
   * Owning this HERE is the point: six Home sections had six different
   * answers to "what does refresh do" — one reloaded the entire tab,
   * others had no control at all, and only some showed they were busy.
   * Anything that renders a Dashboard now behaves the same way for free.
   */
  onRefresh?: () => void | Promise<void>;
  /** True while `onRefresh`'s work is in flight. Drives the overlay. */
  refreshing?: boolean;
  /**
   * Timeframe picker, rendered right-aligned at the top of the body.
   *
   * Deliberately a plain {label, value} list rather than the `Period`
   * type: `Period` lives beside WorkerHourlyPayCard, which imports THIS
   * file, so depending on it here would be a circular import. Sections
   * map their own period list in and resolve the key back out — see
   * `periodTimeframe()`.
   *
   * Five sections had five near-identical Select.Root blocks differing
   * only in which state they set. That is the duplication that produced
   * the click-through/dropdown inconsistency in the first place.
   */
  /** Rendered on the SAME right-aligned row as the timeframe picker.
   *  Sections that have both a timeframe and their own control (a "View
   *  all" link, say) otherwise stack two right-aligned rows of controls,
   *  which reads as two unrelated toolbars. */
  timeframeSlot?: React.ReactNode;
  timeframe?: {
    options: ReadonlyArray<{ label: string; value: string }>;
    value: string;
    onChange: (value: string) => void;
  };
  /**
   * Overrides the palette's left stripe with a specific colour.
   *
   * For the Tasks page, where each row's accent deliberately matches its
   * sibling entry in the header alerts dropdown — that per-section colour
   * coding is the point, and collapsing 20 sections onto 7 palettes would
   * throw it away.
   */
  accentColor?: string;
  /**
   * Initial collapse state before any stored preference exists.
   *
   * Defaults to open, which is right for a page with a handful of
   * sections. Tasks is a SCAN list — a dozen queues at once — so it opens
   * collapsed; defaulting it open turned that page into a 10,000px scroll.
   */
  defaultOpen?: boolean;
  /**
   * Extra control rendered beside the refresh button, OUTSIDE the header
   * <button> (nesting a button inside a button is invalid HTML). Tasks
   * uses it for the "go to this section's home tab" arrow.
   */
  headerAction?: React.ReactNode;
  /** Visual variant. "default" = neutral gray section (Ops, Client
   *  Requests). "hero" = emerald + left accent stripe + elevation —
   *  used for MY DASHBOARD so it stands apart from every other
   *  section on the page. */
  variant?:
    | "default"
    | "hero"
    | "info"
    | "estimate"
    | "team"
    | "neutral"
    | "insights"
    | "attention";
}) {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v === "0") setOpen(false);
      else if (v === "1") setOpen(true);
    } catch { /* ignore */ }
  }, [storageKey]);
  // Re-run the section's loader when it is opened from a collapsed state.
  // `prevOpen` starts undefined so the very first render does NOT fire —
  // sections already fetch on mount, and firing here would double every
  // initial load.
  /**
   * Expanding auto-refreshes — kicked off from the CLICK, not an effect.
   *
   * An effect runs AFTER paint, so the browser drew one frame of the old
   * data before `refreshing` flipped and hid it: expanding visibly flashed
   * stale figures, then the spinner, then the new figures. Reported
   * 2026-08-27.
   *
   * Doing it here means `setOpen(true)` and `setExpandPending(true)` land
   * in the SAME React batch, so the very first frame after expanding is
   * already the dimmed, empty one. No flash to see.
   */
  const [expandPending, setExpandPending] = useState(false);
  const busy = refreshing || expandPending;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* ignore */ }
    if (next && onRefresh) {
      setExpandPending(true);
      void Promise.resolve(onRefresh()).finally(() => setExpandPending(false));
    }
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
  /**
   * Pulse rules differ by source:
   *   • `forceGlow` — pulses OPEN OR COLLAPSED. These are queues with work
   *     blocked on the operator (client requests, unlinked accounts,
   *     payments awaiting approval). The hand-rolled versions pulsed while
   *     expanded, and hiding the signal the moment you open the section is
   *     backwards — that is when you are looking at it.
   *   • glowing children — collapsed only, as before. There the pulse
   *     stands in for rows you cannot currently see.
   */
  const shouldPulse = !!forceGlow || (!open && glowCount > 0);


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
      refreshHoverBg: "gray.300",
      headerHoverBg: undefined as string | undefined,
      // Intentionally NO stripe and no header band. `default` predates this
      // family of palettes and is used by an unrelated tab; new sections
      // that want the family look should use `neutral`, not restyle this.
      stripe: undefined as string | undefined,
      pulse: "seedlings-pulse-gray 2.5s ease-in-out infinite",
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
      refreshHoverBg: "purple.300",
      headerHoverBg: "purple.200",
      pulse: "seedlings-pulse-purple 2.5s ease-in-out infinite",
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
      refreshHoverBg: "green.400",
      headerHoverBg: "green.300",
      pulse: "seedlings-pulse-green 2.5s ease-in-out infinite",
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
      refreshHoverBg: "yellow.300",
      headerHoverBg: "yellow.200",
      pulse: "seedlings-pulse-yellow 2.5s ease-in-out infinite",
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
      refreshHoverBg: "blue.300",
      headerHoverBg: "blue.200",
      pulse: "seedlings-pulse-blue 2.5s ease-in-out infinite",
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
      refreshHoverBg: "gray.400",
      headerHoverBg: "gray.300",
      pulse: "seedlings-pulse-gray 2.5s ease-in-out infinite",
      stripe: "gray.400",
    },
    // Orange + yellow stripe — the INSIGHTS section, on five tabs.
    //
    // Not a colour claim like the others: Insights is the same surface
    // wherever you meet it (Home, Jobs, Inventory, Collections, Vehicles),
    // so it keeps one identity app-wide rather than relating to whatever
    // sits beside it on a given page. The yellow.500 stripe is darker than
    // the orange.200 frame edge so the accent reads as deliberate against
    // the pale fill.
    // Orange — a queue waiting on the operator.
    //
    // Distinct from `insights` (also orange) by being a full step
    // stronger: an orange.200 band rather than orange.100, and an orange
    // stripe rather than yellow. Insights is a rollup you browse; this is
    // work that is blocked on you, and it used to justify a pulsing
    // animation. The strength difference is what carries that now.
    attention: {
      frameBg: "orange.50",
      border: "orange.300",
      shadow: "sm",
      title: "orange.900",
      titleSize: "sm",
      icon: "var(--chakra-colors-orange-700)",
      chevron: "var(--chakra-colors-orange-700)",
      headerBg: "orange.200",
      headerHoverBg: "orange.300",
      refreshHoverBg: "orange.400",
      pulse: "seedlings-pulse-orange 2.5s ease-in-out infinite",
      stripe: "orange.500",
    },
    insights: {
      frameBg: "orange.50",
      border: "orange.200",
      shadow: "sm",
      title: "orange.900",
      titleSize: "sm",
      icon: "var(--chakra-colors-orange-700)",
      chevron: "var(--chakra-colors-orange-700)",
      headerBg: "orange.100",
      refreshHoverBg: "orange.300",
      headerHoverBg: "orange.200",
      pulse: "seedlings-pulse-orange 2.5s ease-in-out infinite",
      stripe: "yellow.500",
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
  const refreshHoverBg = (pal as { refreshHoverBg?: string }).refreshHoverBg;
  // Pulse in the section's OWN colour — see `pulse` on each palette.
  const animation = shouldPulse
    ? (pal as { pulse?: string }).pulse ?? FALLBACK_PULSE
    : undefined;
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
      borderLeftWidth={accentColor || pal.stripe ? "4px" : "1px"}
      borderLeftColor={accentColor ?? pal.stripe ?? frameBorderColor}
      shadow={frameShadow}
      style={animation ? { animation } : undefined}
    >
      {/* Relative wrapper so the refresh control can sit ON the title bar
          without living INSIDE it — the header is a <button>, and nesting
          a button in a button is invalid HTML (and the inner one would
          fight the collapse toggle for the click). */}
      {/* The wrapper — not the bar — owns the bar's hover.
          The bar and the refresh control are SIBLINGS (a button cannot
          nest inside a button), so with the rule on the bar itself,
          moving onto the refresh took the pointer off the bar and it
          snapped back to its resting, LIGHTER colour. That flash is what
          "the title bar goes lighter when I hover the refresh" was.
          Hovering the wrapper covers both children, so the bar darkens
          once and stays darkened the whole way across. */}
      <Box position="relative" _hover={{ "& [data-dash-header]": { bg: headerHoverBg } }}>
      <HStack
        as="button"
        data-dash-header
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
        // No rule here — the wrapper above drives it, so the darkening
        // survives the move onto the refresh control.
        _hover={undefined}
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
      {/* Hidden while collapsed: there is nothing on screen to refresh,
          and expanding auto-refreshes anyway — so a collapsed refresh
          would do invisible work, which is the same complaint that turned
          out to be the double-render refetch bug. */}
      {headerAction && (
        <Box
          position="absolute"
          top="50%"
          right={onRefresh && open ? (isHero ? 8 : 6) : isHero ? 2 : 0}
          transform="translateY(-50%)"
          zIndex={1}
        >
          {headerAction}
        </Box>
      )}
      {onRefresh && open && (
        <IconButton
          aria-label="Refresh section"
          size="xs"
          variant="ghost"
          position="absolute"
          top="50%"
          right={isHero ? 2 : 0}
          transform="translateY(-50%)"
          zIndex={1}
          loading={busy}
          // Tinted to the section, not left as neutral grey: at rest it
          // matches the header ICON, and on hover it deepens to the TITLE
          // colour — every palette's title is the darker end of its own
          // hue (e.g. orange.700 -> orange.900), so this reads as "the
          // same control, emphasised" in each section rather than
          // introducing a fifth colour.
          color={iconColor}
          // Hover darkens THIS BUTTON's background one shade below the
          // bar's own hover shade (e.g. orange.300 on an orange.200
          // hovered bar), so the control still reads as the darker thing
          // even while the bar underneath is darkened too.
          //
          // The bar itself has no hover at all any more (see the header
          // above). That was the actual source of "you keep changing the
          // title bar colour": the bar is full-width, so approaching this
          // control hovered the bar and repainted it. A pixel diff of the
          // refresh hover showed only the icon changing, which is what
          // finally located it.
          _hover={{ bg: refreshHoverBg, color: titleColor }}
          _active={{ bg: refreshHoverBg }}
          onClick={(e) => {
            // The title bar behind this toggles the section; without
            // stopPropagation a refresh would also collapse it.
            e.stopPropagation();
            void onRefresh();
          }}
        >
          <RefreshCw size={13} />
        </IconButton>
      )}
      </Box>
      {pinnedContent && (
        <Box mb={open ? 2 : 0}>{pinnedContent}</Box>
      )}
      {/* ONE instance of `children`, shown or hidden — never two branches.
          It used to render them twice: `{open && …}` and `{!open && <Box
          display="none">…}`. Those are different positions in the tree, so
          React UNMOUNTED and REMOUNTED every child on each toggle, and any
          child that fetches on mount re-fetched — invisibly, while
          collapsed. Measured before this fix: collapsing Insights fired one
          request, expanding fired two (a remount plus the intended
          expand-refresh). Reported 2026-08-27 as "why are the sections
          refreshing when collapsing them".

          Children stay mounted while collapsed on purpose — that is what
          keeps CompactBanner glow registration alive. */}
      <GlowContext.Provider value={registry}>
        <Box position="relative" display={open ? undefined : "none"} aria-hidden={!open || undefined}>
          {busy && (
            <Box
              data-testid="dashboard-refreshing"
              position="absolute"
              inset="0"
              zIndex={2}
              bg="whiteAlpha.700"
              borderRadius="md"
              display="flex"
              alignItems="center"
              justifyContent="center"
              minH="60px"
            >
              <Spinner size="lg" />
            </Box>
          )}
          {/* Body HIDDEN, not unmounted, while refreshing — "clear the data
              while loading" done once here. Several sections early-return a
              skeleton when their data is null, so clearing per-component
              made the whole section vanish instead of dimming. */}
          <VStack
            align="stretch"
            gap={2}
            visibility={busy ? "hidden" : undefined}
            aria-hidden={busy || undefined}
          >
            {(timeframe || timeframeSlot) && (
              // flexShrink={0} on the wrapper — Select.Root stretches to
              // fill a flex row otherwise, which strands anything beside it.
              <HStack justify="flex-end" gap={2} wrap="wrap" align="center">
                {timeframe && (
                <Box flexShrink={0}>
                  <Select.Root
                    collection={createListCollection({ items: [...timeframe.options] })}
                    value={[timeframe.value]}
                    onValueChange={(e) => {
                      const v = e.value?.[0];
                      if (v) timeframe.onChange(v);
                    }}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger w="auto" minW="150px" px="2">
                        <Select.ValueText placeholder="Timeframe" />
                        <Select.Indicator />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content minW="var(--reference-width)">
                        {timeframe.options.map((item) => (
                          <Select.Item key={item.value} item={item.value}>
                            <Select.ItemText>{item.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </Box>
                )}
                {timeframeSlot}
              </HStack>
            )}
            {children}
          </VStack>
        </Box>
      </GlowContext.Provider>
    </Box>
  );
}
