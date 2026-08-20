"use client";

// ─────────────────────────────────────────────────────────────────────────────
// CompactBanner — the one-row banner primitive used across the app for
// "you have something to look at" strips. Mirrors the shipped
// "You didn't end your workday" reminder in WorkdayStrip.
//
// Shape: leading icon → message → one or more action buttons.
// EVERY action is a real Button with its own icon (no text-link
// pseudo-buttons). Callers order actions left-to-right, primary
// last. Set `variant: "outline"` on secondary actions (Cancel, Pause)
// so the primary reads as the dominant CTA.
//
// Optional `glow` prop turns on a soft pulse when the banner
// represents a required or recommended action. Uses the shared
// `@keyframes seedlings-pulse-*` defined in globals.css.
//
// GlowContext (also exported) lets an enclosing container (e.g.
// Dashboard) know when any of its child banners is glowing — the
// container can then propagate a glow of its own (useful when
// collapsed so the user still sees "something's pending inside").
// Banners rendered OUTSIDE any provider register nothing (ctx=null,
// effect no-ops) and behave normally.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { ChevronDown } from "lucide-react";

export type BannerPalette =
  | "yellow"
  | "orange"
  | "green"
  | "red"
  | "blue"
  | "gray"
  | "purple";

export type BannerAction = {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  /** Non-busy disabled state (e.g. an action that's currently not
   *  permitted by state — precondition not met, blocker present).
   *  Different semantic from `busy`, which means "in-flight". */
  disabled?: boolean;
  variant?: "solid" | "outline";
  /** Override the button palette (defaults to the banner palette). */
  palette?: BannerPalette;
};

// ─── Banner registry context ─────────────────────────────────────────────
// Providers (Dashboard, etc.) implement register/unregister to track
// their child CompactBanners — both to pick a summary glow color AND
// to surface each child's leading icon in the container's collapsed
// header. Every mounted CompactBanner registers unconditionally with
// its icon; the `glowing` flag toggles on when its own `glow` prop
// is true so the container can pulse when at least one child says so.
export type BannerRegistration = {
  palette: BannerPalette;
  icon: React.ReactNode;
  glowing: boolean;
};
export type GlowRegistry = {
  register: (id: string, reg: BannerRegistration) => void;
  update: (id: string, reg: BannerRegistration) => void;
  unregister: (id: string) => void;
};
export const GlowContext = createContext<GlowRegistry | null>(null);

// Map of palette → globals.css keyframe. Palettes without a matching
// keyframe simply won't animate — safe fallback.
const PULSE_ANIMATION: Partial<Record<BannerPalette, string>> = {
  orange: "seedlings-pulse-orange 2.5s ease-in-out infinite",
  blue: "seedlings-pulse-blue 2.5s ease-in-out infinite",
  red: "seedlings-pulse-red 2.5s ease-in-out infinite",
  purple: "seedlings-pulse-purple 2.5s ease-in-out infinite",
};

export function CompactBanner({
  palette,
  icon,
  children,
  actions,
  glow,
  expandedContent,
}: {
  palette: BannerPalette;
  icon: React.ReactNode;
  children: React.ReactNode;
  actions?: BannerAction[];
  glow?: boolean;
  /** Optional detail block. When provided, clicking anywhere on the
   *  banner (except an action button) toggles a reveal that appends
   *  this content below the compact row. Useful on narrow screens
   *  where the message text is otherwise ellipsis-truncated. */
  expandedContent?: React.ReactNode;
}) {
  const animation = glow ? PULSE_ANIMATION[palette] : undefined;
  const [expanded, setExpanded] = useState(false);
  const isExpandable = !!expandedContent;

  // Register with any enclosing container (Dashboard, etc.) so it
  // can show this banner's icon in its collapsed header AND decide
  // whether to pulse (any child glowing → container pulses too).
  // Registers unconditionally; the `glowing` flag toggles based on
  // this banner's own `glow` prop. Safe outside a container — ctx
  // is null, both effects no-op.
  const glowCtx = useContext(GlowContext);
  const bannerId = useId();
  useEffect(() => {
    if (!glowCtx) return;
    glowCtx.register(bannerId, { palette, icon, glowing: !!glow });
    return () => glowCtx.unregister(bannerId);
    // Register/unregister once per lifetime. Icon/palette/glow
    // updates are pushed via the separate effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glowCtx, bannerId]);
  useEffect(() => {
    if (!glowCtx) return;
    glowCtx.update(bannerId, { palette, icon, glowing: !!glow });
  }, [glowCtx, bannerId, palette, icon, glow]);

  return (
    <Box
      minH="48px"
      bg={`${palette}.50`}
      borderWidth="1px"
      borderColor={`${palette}.300`}
      borderRadius="md"
      style={animation ? { animation } : undefined}
      overflow="hidden"
    >
      {/* Compact row — kept at exactly 48px so all banners line up.
          When the banner is expandable, the entire row (except the
          action buttons) is the toggle. Buttons stop propagation so
          clicking an action never accidentally toggles the reveal. */}
      <HStack
        gap={2}
        align="center"
        wrap="nowrap"
        w="full"
        h="48px"
        px={3}
        cursor={isExpandable ? "pointer" : "default"}
        onClick={isExpandable ? () => setExpanded((v) => !v) : undefined}
      >
        {isExpandable && (
          <Box
            color={`${palette}.600`}
            flexShrink={0}
            display="flex"
            alignItems="center"
            style={{
              transform: expanded ? "rotate(180deg)" : undefined,
              transition: "transform 0.15s ease",
            }}
            aria-hidden
          >
            <ChevronDown size={14} />
          </Box>
        )}
        <Box color={`${palette}.600`} display="flex" alignItems="center" flexShrink={0}>
          {icon}
        </Box>
        <Box
          fontSize="sm"
          color={`${palette}.900`}
          flex="1"
          minW={0}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {children}
        </Box>
        {/* Compact-row action group. Rendered here only when the
            banner is NOT expanded — on expand, actions move into the
            expanded section below where they get full labels + room. */}
        {actions && actions.length > 0 && !expanded && (
          <HStack
            gap={2}
            flexShrink={0}
            onClick={(e) => e.stopPropagation()}
          >
            {actions.map((a, i) => (
              <Button
                key={`compact-${a.label}-${i}`}
                size="sm"
                h="32px"
                colorPalette={a.palette ?? palette}
                variant={a.variant ?? "solid"}
                onClick={a.onClick}
                disabled={a.busy || a.disabled}
                loading={a.busy}
                aria-label={a.label}
                title={a.label}
              >
                {a.icon}
                {/* Label hidden below `sm` (< 480px) to reclaim
                    horizontal space for the message text. Icons stay
                    visible and the button still exposes the label via
                    aria-label + native tooltip. */}
                <Text ml={1} display={{ base: "none", sm: "inline" }}>
                  {a.label}
                </Text>
              </Button>
            ))}
          </HStack>
        )}
      </HStack>
      {isExpandable && expanded && (
        <Box
          px={3}
          pt={2}
          pb={3}
          borderTopWidth="1px"
          borderColor={`${palette}.200`}
          fontSize="sm"
          color={`${palette}.900`}
        >
          {expandedContent}
          {/* Expanded-state action row. Buttons always show labels
              here — the extra height of the expanded panel means we
              don't need to conserve horizontal space the way the
              compact row does. Right-aligned so the primary CTA lands
              on the same visual axis as it would in the compact row.
              Wraps to a new right-aligned line on very narrow widths.
              colorPalette / variant are re-declared explicitly (same
              values as the compact row) so nothing in the expanded
              container's cascade can quietly strip them. */}
          {actions && actions.length > 0 && (
            <HStack gap={2} pt={3} wrap="wrap" justify="flex-end">
              {actions.map((a, i) => {
                const pal = a.palette ?? palette;
                const variant = a.variant ?? "solid";
                return (
                  <Button
                    key={`expanded-${a.label}-${i}`}
                    size="sm"
                    h="32px"
                    colorPalette={pal}
                    variant={variant}
                    onClick={a.onClick}
                    disabled={a.busy || a.disabled}
                    loading={a.busy}
                    aria-label={a.label}
                  >
                    {a.icon}
                    <Text ml={1}>{a.label}</Text>
                  </Button>
                );
              })}
            </HStack>
          )}
        </Box>
      )}
    </Box>
  );
}
