// Super-only "View as another role" helpers. The selection is persisted in
// localStorage and attached as the X-Impersonate-As header by api.ts on
// every API request. Backend silently ignores the header unless the
// underlying user is actually SUPER.
//
// Keys must stay in sync with the literal in api.ts (`attachImpersonateHeader`).

export const IMPERSONATE_STORAGE_KEY = "seedlings_impersonateAs";

export type ImpersonationValue =
  | "ADMIN"
  | "WORKER:EMPLOYEE"
  | "WORKER:CONTRACTOR"
  | "WORKER:TRAINEE";

export const IMPERSONATION_LABELS: Record<ImpersonationValue, string> = {
  ADMIN: "Admin",
  "WORKER:EMPLOYEE": "Worker — Employee",
  "WORKER:CONTRACTOR": "Worker — Contractor",
  "WORKER:TRAINEE": "Worker — Trainee",
};

export const IMPERSONATION_OPTIONS: ImpersonationValue[] = [
  "ADMIN",
  "WORKER:EMPLOYEE",
  "WORKER:CONTRACTOR",
  "WORKER:TRAINEE",
];

export function getImpersonation(): ImpersonationValue | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(IMPERSONATE_STORAGE_KEY);
    if (!raw) return null;
    if ((IMPERSONATION_OPTIONS as string[]).includes(raw)) {
      return raw as ImpersonationValue;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Set or clear the active impersonation, then fully reload the page after
 * purging the Service Worker's response cache so the new role is reflected
 * by every subsequent request. The page reload also flushes any in-flight
 * requests that would have carried the OLD header value.
 *
 * Pass null to exit impersonation.
 */
export async function setImpersonation(value: ImpersonationValue | null): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (value) localStorage.setItem(IMPERSONATE_STORAGE_KEY, value);
    else localStorage.removeItem(IMPERSONATE_STORAGE_KEY);
  } catch {
    /* keep going — the reload will still attach (or not) the header next time */
  }
  // Purge SW cache so cached API responses from the previous role don't
  // bleed through. caches.keys() can reject (private mode); ignore.
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* not fatal */
  }
  window.location.reload();
}
