// apps/web/lib/devRole.ts
export type Role = "ADMIN" | "WORKER";
export type DevOverride = Role | "NONE"; // NONE = explicitly no roles (dev only)

const KEY = "seedlings3.devRole";

export const isDev = () => process.env.NODE_ENV !== "production";

export function ensureDefaultWorker() {
  if (!isDev()) return;
  try {
    const v = localStorage.getItem(KEY);
    // Only set default if *missing*; do not overwrite 'NONE'
    if (v === null) localStorage.setItem(KEY, "WORKER");
  } catch {}
}

export function setOverrideRole(role: DevOverride) {
  if (!isDev()) return;
  try {
    localStorage.setItem(KEY, role);
  } catch {}
}

export function getOverrideRole(): DevOverride | null {
  if (!isDev()) return null;
  try {
    const v = localStorage.getItem(KEY);
    if (v === "ADMIN" || v === "WORKER" || v === "NONE") return v;
    return null;
  } catch {
    return null;
  }
}

export function effectiveRoleGuards(serverRoles?: string[] | null) {
  const override = getOverrideRole();
  // Explicitly NONE => no roles, regardless of server
  if (override === "NONE") return { isAdmin: false, isWorker: false };
  if (override === "ADMIN") return { isAdmin: true, isWorker: true };
  if (override === "WORKER") return { isAdmin: false, isWorker: true };
  // No override -> use server roles
  const set = new Set(serverRoles ?? []);
  return { isAdmin: set.has("ADMIN"), isWorker: set.has("WORKER") };
}
