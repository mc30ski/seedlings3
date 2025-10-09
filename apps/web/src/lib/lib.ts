import { EquipmentStatus } from "./types";

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
export function prettyStatus(s: EquipmentStatus): string {
  const lower = s.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
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

export function statusColor(value: string): string {
  switch (value) {
    case "AVAILABLE":
      return "green";
    case "RESERVED":
      return "orange";
    case "CHECKED_OUT":
      return "cyan";
    case "MAINTENANCE":
      return "yellow";
    case "RETIRED":
      return "red";
  }
  return "gray";
}

export function actionStatusColor(value: string): string {
  const act = (value || "").toUpperCase();
  if (act.includes("RETIRED") || act.includes("DELETED")) return "gray";
  if (act.includes("CHECKED_OUT") || act.includes("MAINTENANCE_START"))
    return "red";
  if (act.includes("MAINTENANCE_END")) return "yellow";
  if (act.includes("UPDATED") || act.includes("RESERVED")) return "orange";
  if (act.includes("APPROVED") || act.includes("ROLE_ASSIGNED"))
    return "purple";
  if (act.includes("RELEASED") || act.includes("FORCE_RELEASED")) return "blue";
  return "teal";
}
