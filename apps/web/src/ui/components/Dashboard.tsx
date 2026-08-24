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
  /** Optional externally-supplied count for the header badge. When
   *  set, overrides the internally-computed glowing-child count.
   *  Use for Dashboards whose children aren't CompactBanners
   *  (Client Requests polls its own count). */
  count?: number;
  /** Visual variant. "default" = neutral gray section (Ops, Client
   *  Requests). "hero" = emerald + left accent stripe + elevation —
   *  used for MY DASHBOARD so it stands apart from every other
   *  section on the page. */
  variant?: "default" | "hero";
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

  // Variant styling — hero draws the eye (emerald surface, colored
  // left accent stripe, subtle elevation, slightly bolder title);
  // default keeps the neutral gray section frame.
  const isHero = variant === "hero";
  const frameBg = isHero ? "green.50" : "gray.200";
  const frameBorderColor = isHero ? "green.400" : "gray.400";
  const frameShadow = isHero ? "md" : undefined;
  const titleColor = isHero ? "green.900" : "gray.700";
  const titleSize = isHero ? "sm" : "xs";
  const iconColor = isHero
    ? "var(--chakra-colors-green-700)"
    : "var(--chakra-colors-gray-700)";
  const chevronColor = isHero
    ? "var(--chakra-colors-green-700)"
    : undefined;
  // Hero header reads as a tappable bar rather than a bare label: a tinted
  // band a step darker than the frame, with its own hover shade. The
  // default variant keeps the plain opacity hover — its gray frame is
  // already darker than its surroundings, so a band would just muddy it.
  const headerBg = isHero ? "green.200" : undefined;
  const headerHoverBg = isHero ? "green.300" : undefined;

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
      borderLeftWidth={isHero ? "4px" : "1px"}
      borderLeftColor={isHero ? "green.500" : frameBorderColor}
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
          flexShrink={0}
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
        {summarySlot && (
          <Box flex="1" minW={0} overflow="hidden">
            {summarySlot}
          </Box>
        )}
        {!summarySlot && <Box flex="1" />}
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
