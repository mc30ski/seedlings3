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
