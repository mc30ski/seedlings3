// Compact single-metric card. Shares visual DNA with the mini cards
// inside AllWorkersHourlyPayCards but for scalar dashboard stats
// (money totals, job counts, equipment states, etc.). Used by
// SuperWorkHomeTab to fill each section's grid.

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

const PALETTE: Record<MiniStatColor, { bg: string; border: string; fg: string; num: string }> = {
  gray:   { bg: "gray.50",   border: "gray.200",   fg: "gray.700",   num: "gray.800" },
  blue:   { bg: "blue.50",   border: "blue.200",   fg: "blue.800",   num: "blue.900" },
  green:  { bg: "green.50",  border: "green.300",  fg: "green.800",  num: "green.900" },
  orange: { bg: "orange.50", border: "orange.300", fg: "orange.800", num: "orange.900" },
  red:    { bg: "red.50",    border: "red.300",    fg: "red.800",    num: "red.900" },
  purple: { bg: "purple.50", border: "purple.300", fg: "purple.800", num: "purple.900" },
  cyan:   { bg: "cyan.50",   border: "cyan.300",   fg: "cyan.800",   num: "cyan.900" },
  teal:   { bg: "teal.50",   border: "teal.200",   fg: "teal.800",   num: "teal.900" },
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
