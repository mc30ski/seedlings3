"use client";

import { Badge } from "@chakra-ui/react";
import { prettyStatus } from "@/src/lib/labels";
import { badgeColors, BadgeColorsVariant } from "@/src/lib/statusColors";

export function StatusBadge({
  status,
  palette,
  variant = "subtle",
}: {
  status: string;
  palette: string;
  variant: BadgeColorsVariant;
}) {
  return (
    <Badge variant={variant} {...badgeColors(palette, variant)} flexShrink={0}>
      {prettyStatus(status)}
    </Badge>
  );
}
