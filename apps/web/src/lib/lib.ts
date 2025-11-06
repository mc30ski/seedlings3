import { Me, Role } from "@/src/lib/types";

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
  if (t.includes("INDIVIDUAL")) return "blue";
  if (t.includes("HOUSEHOLD")) return "green";
  if (t.includes("COMMUNITY")) return "purple";
  if (t.includes("ORGANIZATION")) return "yellow";
  return "gray";
}

export function contactStatusColor(value: string): string {
  return "teal";
}

export function propertyStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t.includes("ACTIVE")) return "green";
  if (t.includes("PENDING")) return "orange";
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
  return { bg: `${palette}.600`, color: "white" };
}

export const hasRole = (roles: Me["roles"] | undefined, role: Role) =>
  !!roles?.includes(role);

export function determineRoles(me: Me | null, purpose: Role) {
  const isWorker = hasRole(me?.roles, "WORKER");
  const isAdmin = hasRole(me?.roles, "WORKER");
  return {
    isWorker: isWorker,
    isAdmin: isAdmin,
    isSuper: hasRole(me?.roles, "SUPER"),
    isAvail: isAdmin || isWorker,
    forAdmin: purpose === "ADMIN" && isAdmin,
  };
}
