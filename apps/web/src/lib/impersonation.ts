// Super-only "View as another role" helpers. The selection is persisted in
// localStorage and attached as the X-Impersonate-As header by api.ts on
// every API request. Backend silently ignores the header unless the
// underlying user is actually SUPER.
//
// Keys must stay in sync with the literals in api.ts (`attachImpersonateHeader`).

export const IMPERSONATE_STORAGE_KEY = "seedlings_impersonateAs";
// Separate storage key + header for the client "View as" flavor. Client
// impersonation is orthogonal to role impersonation — different targets
// (a ClientContact ID vs a role literal), different backend semantics
// (identity swap vs role swap), different lifecycle (read-only).
export const CLIENT_IMPERSONATE_STORAGE_KEY = "seedlings_impersonateClientContact";

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

/** Details of the currently active client "View as" session. Stored as
 *  JSON in localStorage so we can render the banner without hitting the
 *  API again. */
export type ClientImpersonationValue = {
  contactId: string;
  contactName: string;
  clientName: string;
};

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

/** Read the currently active client "View as" session, if any. */
export function getClientImpersonation(): ClientImpersonationValue | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CLIENT_IMPERSONATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientImpersonationValue;
    if (
      typeof parsed?.contactId === "string" &&
      typeof parsed?.contactName === "string" &&
      typeof parsed?.clientName === "string"
    ) {
      return parsed;
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
  await purgeAndReload();
}

/**
 * Enter or exit a Super-only client "View as" session. On enter, we also
 * force topTab → "client" so the app renders the client-mode UI. On exit,
 * we clear the storage entry and reload — the app snaps back to whatever
 * tab Super was on before.
 */
export async function setClientImpersonation(
  value: ClientImpersonationValue | null,
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      localStorage.setItem(CLIENT_IMPERSONATE_STORAGE_KEY, JSON.stringify(value));
      // Force the client-mode UI so Super lands where the client would.
      localStorage.setItem("seedlings_topTab", JSON.stringify("client"));
    } else {
      localStorage.removeItem(CLIENT_IMPERSONATE_STORAGE_KEY);
      // Don't touch topTab on exit — the reload will land Super wherever
      // the persisted tab points, typically back to Super/Directory since
      // that's where they came from.
    }
  } catch {
    /* keep going — the reload will still attach (or not) the header next time */
  }
  await purgeAndReload();
}

// Shared cache-purge + hard reload used by both impersonation setters.
async function purgeAndReload(): Promise<void> {
  // Purge SW cache so cached API responses from the previous session
  // don't bleed through. caches.keys() can reject (private mode); ignore.
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
