// Compact single-metric card. Shares visual DNA with the mini cards
// inside AllWorkersHourlyPayCards but for scalar dashboard stats
// (money totals, job counts, equipment states, etc.). Used by
// HomeTab to fill each section's grid.

"use client";
import { Box, Card, HStack, Text, VStack } from "@chakra-ui/react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Palette shorthand — matches Chakra's colorPalette values. Picked
 *  to keep the card readable in either light or dark themes without
 *  hardcoding hexes. */
export type MiniStatColor =
  | "gray"
  | "blue"
  | "green"
  | "orange"
  | "red"
  | "purple"
  | "cyan"
  | "teal";

type Props = {
  /** Uppercase label above the number ("Revenue", "Overdue", …). */
  label: string;
  /** Pre-formatted primary value (e.g. "$1,234" or "12"). */
  value: string;
  /** Optional supporting line under the number ("3 canceled", "8 in
   *  progress"). Keep it short — the card is compact. */
  hint?: string;
  /** Palette shorthand → bg / border / accent colors. */
  color?: MiniStatColor;
  /** Optional lucide icon rendered at the top-right of the card. */
  icon?: LucideIcon;
  /** Optional click handler — turns the card into a button. Used for
   *  drill-into-detail navigation from the dashboard. */
  onClick?: () => void;
  /** Optional custom slot below the hint (e.g. a tiny badge row). */
  children?: ReactNode;
};

// `num` and `fg` resolve to the same semantic ink; the 2xl-bold value and
// the xs-uppercase label are already separated by size and weight. They
// used to be `<hue>.900` and `<hue>.fg`, which in dark mode put the value
// at the same colour as the card behind it — every number vanished.
const PALETTE: Record<MiniStatColor, { bg: string; border: string; fg: string; num: string }> = {
  gray:   { bg: "gray.faint",   border: "gray.emphasized",   fg: "gray.fg",   num: "gray.fg" },
  blue:   { bg: "blue.faint",   border: "blue.emphasized",   fg: "blue.fg",   num: "blue.fg" },
  green:  { bg: "green.faint",  border: "green.emphasized",  fg: "green.fg",  num: "green.fg" },
  orange: { bg: "orange.faint", border: "orange.emphasized", fg: "orange.fg", num: "orange.fg" },
  red:    { bg: "red.faint",    border: "red.emphasized",    fg: "red.fg",    num: "red.fg" },
  purple: { bg: "purple.faint", border: "purple.emphasized", fg: "purple.fg", num: "purple.fg" },
  cyan:   { bg: "cyan.faint",   border: "cyan.emphasized",   fg: "cyan.fg",   num: "cyan.fg" },
  teal:   { bg: "teal.faint",   border: "teal.emphasized",   fg: "teal.fg",   num: "teal.fg" },
};

export default function MiniStatCard({
  label,
  value,
  hint,
  color = "gray",
  icon: Icon,
  onClick,
  children,
}: Props) {
  const p = PALETTE[color];
  return (
    <Card.Root
      variant="outline"
      bg={p.bg}
      borderColor={p.border}
      cursor={onClick ? "pointer" : undefined}
      onClick={onClick}
      transition="transform 100ms ease, box-shadow 100ms ease"
      _hover={onClick ? { transform: "translateY(-1px)", shadow: "sm" } : undefined}
    >
      <Card.Body p={3}>
        <HStack justify="space-between" align="start" mb={1} gap={1}>
          <Text
            fontSize="xs"
            fontWeight="semibold"
            color={p.fg}
            textTransform="uppercase"
            letterSpacing="wide"
            truncate
            flex={1}
            minW={0}
          >
            {label}
          </Text>
          {Icon && (
            <Box color={p.num} flexShrink={0}>
              <Icon size={14} />
            </Box>
          )}
        </HStack>
        <VStack align="start" gap={0}>
          <Text
            fontSize="2xl"
            fontWeight="bold"
            color={p.num}
            lineHeight="1"
          >
            {value}
          </Text>
          {hint && (
            <Text fontSize="2xs" color={p.fg} opacity={0.75} mt={1}>
              {hint}
            </Text>
          )}
        </VStack>
        {children}
      </Card.Body>
    </Card.Root>
  );
}
