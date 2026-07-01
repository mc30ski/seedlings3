"use client";

// Shared status chip used by both workday rows and mileage sub-rows
// so a single visual/legend covers every "approvable item" surface.
//
//   open      → orange "⚠ open"   (unfinished; must be closed before approval)
//   approved  → green "approved"   (all done)
//   otherwise → no chip; the row is COMPLETED-pending, which is the
//              default section-inferred state

import { Badge } from "@chakra-ui/react";
import { CheckCircle2 } from "lucide-react";

export default function StatusChip({
  open,
  approved,
}: {
  open: boolean;
  approved: boolean;
}) {
  if (open) {
    return <Badge size="xs" colorPalette="orange" variant="solid">⚠ open</Badge>;
  }
  if (approved) {
    return (
      <Badge size="xs" colorPalette="green" variant="subtle">
        <CheckCircle2 size={10} style={{ marginRight: 3 }} />
        approved
      </Badge>
    );
  }
  return null;
}
