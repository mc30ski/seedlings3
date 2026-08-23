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
      bg: `${palette}.100`,
      color: `${palette}.700`,
      border: "1px solid",
      borderColor: `${palette}.200`,
    };
  }
  if (variant === "outline") {
    return {
      bg: `${palette}.200`,
      color: `${palette}.700`,
      border: "1px solid",
      borderColor: `${palette}.300`,
    };
  }
  if (palette === "gray") return { bg: "gray.500", color: "white" };
  return { bg: `${palette}.600`, color: "white" };
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
