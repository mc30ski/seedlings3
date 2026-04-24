import { Me, Role, JOB_TYPE_OPTIONS } from "@/src/lib/types";

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const BIZ_TZ = "America/New_York";

/** Format a date as a short date string in business timezone (Eastern) */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { timeZone: BIZ_TZ });
}

/** Format a date+time string in business timezone (Eastern) */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { timeZone: BIZ_TZ });
}

/** Format a date with weekday in business timezone */
export function fmtDateWeekday(d: string | Date | null | undefined, opts?: { year?: boolean }): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    timeZone: BIZ_TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(opts?.year ? { year: "numeric" } : {}),
  });
}

/** Get the YYYY-MM-DD date string in business timezone */
export function bizDateKey(d: string | Date): string {
  const dt = new Date(d);
  const parts = dt.toLocaleDateString("en-CA", { timeZone: BIZ_TZ }); // en-CA gives YYYY-MM-DD
  return parts;
}

/** Append " JOB" to client display names for display purposes. */
export function jobTypeLabel(value: string | null | undefined): string {
  if (!value) return "";
  const opt = JOB_TYPE_OPTIONS.find((o) => o.value === value);
  return opt?.label ?? value;
}

export function clientLabel(name: string | null | undefined): string {
  if (!name) return "";
  return `${name} JOB`;
}

export function notifyEquipmentUpdated() {
  try {
    window.dispatchEvent(new CustomEvent("seedlings3:equipment-updated"));
  } catch {}
}

export function errorMessage(err: any): string {
  return (
    err?.message ||
    err?.data?.message ||
    err?.response?.data?.message ||
    "Action failed"
  );
}

// Pretty-print status like other tabs: "Available", "Checked out", etc.
export function prettyStatus(s: string): string {
  if (!s) return "—";
  if (s.toUpperCase() === "CLOSED") return "Completed";
  return s
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function extractSlug(value: string): string {
  try {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : value;
    }
    return value;
  } catch {
    // In case it's not a valid URL even though it starts with protocol
    return value;
  }
}

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
  if (act.includes("RESERVED")) return "orange";
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
  if (t.includes("PAUSED")) return "orange";
  if (t.includes("ARCHIVED")) return "red";
  return "gray";
}

export function propertyStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t.includes("ACTIVE")) return "green";
  if (t.includes("ARCHIVED")) return "red";
  return "gray";
}

export function prettyDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso || "—";
  }
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
  if (t === "SCHEDULED") return "blue";
  if (t === "PROPOSAL_SUBMITTED") return "teal";
  if (t === "ACCEPTED") return "green";
  if (t === "REJECTED") return "red";
  if (t === "CANCELED") return "red";
  if (t === "ARCHIVED") return "gray";
  return "gray";
}

export const hasRole = (roles: Me["roles"] | undefined, role: Role) =>
  !!roles?.includes(role);

export function determineRoles(me: Me | null, purpose: Role) {
  const isWorker = hasRole(me?.roles, "WORKER");
  const isAdmin = hasRole(me?.roles, "ADMIN");
  return {
    isWorker: isWorker,
    isAdmin: isAdmin,
    isSuper: hasRole(me?.roles, "SUPER"),
    isAvail: isAdmin || isWorker,
    forAdmin: purpose === "ADMIN" && isAdmin,
  };
}
