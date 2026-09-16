"use client";

// Status → Chakra colour-palette mapping for badges and chips.
//
// Split out of the old `lib.ts` (which held dates, labels, colours, and
// role logic in one 800-line file named after its own directory). Colour
// choices are a presentation concern with no relationship to date maths,
// so they live on their own.

export function equipmentStatusColor(value: string): string {
  const act = (value || "").toUpperCase();
  if (
    act.includes("AVAILABLE") ||
    act.includes("CREATED") ||
    act.includes("MAINTENANCE_END") ||
    act.includes("RETURNED") ||
    act.includes("CANCELLED") ||
    act.includes("RELEASED") ||
    act.includes("UNRETIRED")
  )
    return "green";
  if (act.includes("RESERVED")) return "purple";
  if (act.includes("CHECKED_OUT")) return "cyan";
  if (act.includes("MAINTENANCE_START") || act === "MAINTENANCE")
    return "yellow";
  if (act.includes("APPROVED") || act.includes("ROLE_ASSIGNED"))
    return "purple";
  if (act.includes("UPDATED")) return "teal";
  if (act.includes("RELEASED") || act.includes("FORCE_RELEASED")) return "blue";
  if (
    act.includes("RETIRED") ||
    act.includes("DELETED") ||
    act.includes("REMOVED")
  )
    return "red";
  return "gray";
}

export function clientStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t.includes("ACTIVE")) return "green";
  if (t.includes("ARCHIVED")) return "red";
  return "gray";
}

export function propertyStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t.includes("ACTIVE")) return "green";
  if (t.includes("ARCHIVED")) return "red";
  return "gray";
}

export type BadgeColorsVariant = "subtle" | "outline" | "solid";

export function badgeColors(
  palette: string,
  variant: BadgeColorsVariant = "subtle"
) {
  if (variant === "subtle") {
    return {
      bg: `${palette}.subtle`,
      color: `${palette}.fg`,
      border: "1px solid",
      borderColor: `${palette}.emphasized`,
    };
  }
  if (variant === "outline") {
    return {
      bg: `${palette}.muted`,
      color: `${palette}.fg`,
      border: "1px solid",
      borderColor: `${palette}.emphasized`,
    };
  }
  // `solid` is the one variant that was never converted: a raw ramp fill
  // with the ink hardcoded to white. That is unreadable on the bright hues —
  // white on `yellow` measured 2.94:1 — and it themes nowhere, because the
  // raw ramp is the same value in all five themes.
  //
  // `colorPalette.solid` + `colorPalette.contrast` is the pair Chakra tunes
  // together per hue and per theme: yellow's ink comes back BLACK, the rest
  // white, and each theme gets its own fill. One change here covers all 71
  // <StatusBadge> call sites.
  return { bg: `${palette}.solid`, color: `${palette}.contrast` };
}

export function jobStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t === "ACCEPTED") return "green";
  if (t === "PROPOSED") return "orange";
  if (t === "PAUSED") return "yellow";
  return "gray";
}

export function occurrenceStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t === "PENDING_PAYMENT") return "orange";
  if (t === "CLOSED") return "gray";
  if (t === "IN_PROGRESS") return "cyan";
  if (t === "PAUSED") return "orange";
  // Stream-pause chip uses purple to visually distinguish from the
  // orange "worker timer paused" chip. Two different concepts sharing
  // color would confuse admins reading the same list.
  if (t === "STREAM_PAUSED") return "purple";
  if (t === "SCHEDULED") return "blue";
  if (t === "PROPOSAL_SUBMITTED") return "teal";
  if (t === "ACCEPTED") return "green";
  if (t === "REJECTED") return "red";
  if (t === "CANCELED") return "red";
  if (t === "ARCHIVED") return "gray";
  return "gray";
}
