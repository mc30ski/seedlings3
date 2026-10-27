// Three orthogonal lenses, sharing only a cache-purge helper.
//
//  1. PERSPECTIVE — "show me the app as somebody holding less would see it".
//     A perspective is a named SUBSET of what you already hold, offered only
//     when you hold its role or one inheriting it, so no value of the header
//     can grant anything. The selection is a `CustomRole.id`, persisted in
//     localStorage and attached as `X-Perspective` by api.ts.
//
//  2. CLIENT VIEW-AS — "show me the app as this client account". A different
//     target (a ClientContact id), different semantics (identity swap, and
//     read-only), different lifecycle.
//
//  3. AREA LENS — "show me only Durham". Narrows WHERE, where a perspective
//     narrows WHAT YOU MAY DO. Unrelated mechanisms and freely combined: you
//     can look at Durham through a scheduler's perspective. Sent as
//     `X-Area-Lens` carrying an Area id; the server intersects it with the
//     areas you are granted, so a forged value shows you LESS, never more.
//
// WHAT CHANGED. This file used to store a role literal under
// `X-Impersonate-As`, which SWAPPED the caller's roles array for a synthetic
// one. Both halves of that are gone: the server reads `x-perspective` and
// there is no roles array to swap. The old key is read once on load and
// discarded, so a browser holding a stale value does not keep sending a
// header nothing answers.
//
// Keys must stay in sync with the literals in api.ts (`attachImpersonateHeader`).

export const PERSPECTIVE_STORAGE_KEY = "seedlings_perspectiveRoleId";
/**
 * The chosen perspective's NAME, cached for display only.
 *
 * Nothing authorizes on this. It exists because `ImpersonationWarning`
 * renders inside confirm dialogs all over the app and has no access to
 * `me`, where the authoritative list lives. Anything deciding whether a
 * perspective is in force reads `me.activePerspectiveRoleId` instead — the server
 * ignores a roleId the caller cannot reach, so the stored pair can name a
 * perspective that is not active.
 */
export const PERSPECTIVE_NAME_STORAGE_KEY = "seedlings_perspectiveName";
/** Written by versions before 2026-10-16. Cleared on sight, never read. */
const LEGACY_IMPERSONATE_STORAGE_KEY = "seedlings_impersonateAs";
export const CLIENT_IMPERSONATE_STORAGE_KEY = "seedlings_impersonateClientContact";

/** One entry of `me.perspectives` — the server's list of perspectives you may take. */
export type PerspectiveOption = {
  roleId: string;
  key: string | null;
  name: string;
  order: number;
};

/**
 * The role id of the active perspective, or null for "my own full access".
 *
 * Deliberately NOT validated against the available list here: the list lives
 * on `me`, which this module does not see, and the server ignores a roleId
 * the caller cannot reach anyway. Validating in two places is how the two
 * disagree.
 */
export function getPerspective(): string | null {
  if (typeof window === "undefined") return null;
  try {
    localStorage.removeItem(LEGACY_IMPERSONATE_STORAGE_KEY);
    const raw = localStorage.getItem(PERSPECTIVE_STORAGE_KEY);
    if (!raw) return null;
    // Same shape check the server's `parsePerspectiveHeader` applies, so a
    // junk value is dropped here rather than sent and silently ignored.
    return /^[A-Za-z0-9_-]{10,40}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The cached name of the chosen perspective. Display only — see the key's note. */
export function getPerspectiveName(): string | null {
  if (typeof window === "undefined") return null;
  try {
    if (!localStorage.getItem(PERSPECTIVE_STORAGE_KEY)) return null;
    return localStorage.getItem(PERSPECTIVE_NAME_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The label to show for an active perspective, given the list from `me`. */
export function perspectiveLabel(
  options: readonly PerspectiveOption[] | undefined,
  roleId: string | null,
): string | null {
  if (!roleId) return null;
  return options?.find((o) => o.roleId === roleId)?.name ?? "another role";
}

/**
 * Take a perspective, or pass null to return to your own access. Reloads, because
 * every cached response was fetched under the previous perspective.
 */
export async function setPerspective(
  roleId: string | null,
  name?: string | null,
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (roleId) {
      localStorage.setItem(PERSPECTIVE_STORAGE_KEY, roleId);
      if (name) localStorage.setItem(PERSPECTIVE_NAME_STORAGE_KEY, name);
      else localStorage.removeItem(PERSPECTIVE_NAME_STORAGE_KEY);
    } else {
      localStorage.removeItem(PERSPECTIVE_STORAGE_KEY);
      localStorage.removeItem(PERSPECTIVE_NAME_STORAGE_KEY);
    }
  } catch {
    /* keep going — the header is read from storage on the next request */
  }

  // NO RELOAD. Taking a perspective used to call `purgeAndReload()`, which
  // threw the whole app away and rebuilt it — splash screen, every tab
  // remounted, scroll position gone — to switch a lens. The role switch it
  // replaced never did that, and a reload is not what the feature is.
  //
  // A reload WAS the honest blunt answer to a real problem: every response
  // already on screen was fetched under the previous perspective, so the
  // server's answers are stale the instant this changes. The cheap fix is
  // the same one without the sledgehammer — purge the cached responses,
  // then tell the app to re-ask.
  //
  // `pages/index.tsx` listens: it refetches `/api/me`, which flows into
  // `capabilities` → `scopeCan` → every title-bar count callback, and bumps
  // the key on the tab content so the open tab remounts and refetches. That
  // covers both halves of what a reload did.
  await purgeCaches();
  try {
    window.dispatchEvent(new Event(PERSPECTIVE_CHANGED_EVENT));
  } catch {
    /* no listener is survivable; the next navigation reads the new header */
  }
}

/** Fired after a perspective is taken or cleared. See `setPerspective`. */
export const PERSPECTIVE_CHANGED_EVENT = "seedlings3:perspective-changed";

/** Details of the currently active client "View as" session. Stored as
 *  JSON in localStorage so we can render the banner without hitting the
 *  API again. */
export type ClientImpersonationValue = {
  contactId: string;
  contactName: string;
  clientName: string;
};

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
 * Enter or exit a client "View as" session (`clients.view-as`). On enter, we also
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

// ─────────────────────────────────────────────────────────────────────────────
// AREA LENS — "show me only Durham", for somebody entitled to see more.
// ─────────────────────────────────────────────────────────────────────────────

export const AREA_LENS_STORAGE_KEY = "seedlings_areaLensId";
/** The chosen area's NAME, cached so the header chip can render before
 *  `/me/areas` has answered. Display only; nothing resolves on it. */
export const AREA_LENS_NAME_STORAGE_KEY = "seedlings_areaLensName";

/** One entry of `GET /me/areas` — somewhere this caller may point the lens. */
export type AreaLensOption = {
  id: string;
  name: string;
  tier: string | null;
  path: string;
  /** Names from the top of the tree down to this area, root excluded —
   *  e.g. ["Chapel Hill", "Carrboro"]. Server-built; the client has no
   *  reliable way to name an ancestor it may not be allowed to select. */
  trail?: string[];
};

/**
 * The area id being looked through, or null for "everywhere I can see".
 *
 * PERSISTED ON PURPOSE, which is only safe because the chip in the header
 * renders whenever this is set. A lens you cannot see is the feature's one
 * real hazard: "Chapel Hill earned nothing" and "you were looking at Durham"
 * produce the same empty screen. Persistence buys the convenience; the chip
 * pays for it.
 */
export function getAreaLens(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AREA_LENS_STORAGE_KEY);
    if (!raw) return null;
    // Same shape check the server's `parseAreaLensHeader` applies, so junk
    // is dropped here rather than sent and silently ignored.
    return /^[A-Za-z0-9_-]{10,40}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The cached name of the chosen area. Display only — see the key's note. */
export function getAreaLensName(): string | null {
  if (typeof window === "undefined") return null;
  try {
    if (!localStorage.getItem(AREA_LENS_STORAGE_KEY)) return null;
    return localStorage.getItem(AREA_LENS_NAME_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Look at one area, or pass null to go back to everywhere.
 *
 * Purge-and-refetch rather than reload, for the same reason `setPerspective`
 * does it: every response on screen was fetched through the OUTGOING lens,
 * so they are all stale — but throwing the whole app away to change which
 * district you are reading is not what the feature is.
 */
export async function setAreaLens(areaId: string | null, name?: string | null): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (areaId) {
      localStorage.setItem(AREA_LENS_STORAGE_KEY, areaId);
      if (name) localStorage.setItem(AREA_LENS_NAME_STORAGE_KEY, name);
      else localStorage.removeItem(AREA_LENS_NAME_STORAGE_KEY);
    } else {
      localStorage.removeItem(AREA_LENS_STORAGE_KEY);
      localStorage.removeItem(AREA_LENS_NAME_STORAGE_KEY);
    }
  } catch {
    /* keep going — the header is read from storage on the next request */
  }
  await purgeCaches();
  try {
    window.dispatchEvent(new Event(AREA_LENS_CHANGED_EVENT));
  } catch {
    /* no listener is survivable; the next navigation reads the new header */
  }
}

/** Fired after the area lens changes. `pages/index.tsx` listens and remounts
 *  the open tab, the same way it does for a perspective change. */
export const AREA_LENS_CHANGED_EVENT = "seedlings3:area-lens-changed";

/** Drop cached API responses. They were fetched under the OUTGOING lens,
 *  so every one of them may be an answer the caller is no longer entitled
 *  to — or, taking a lens off, a narrower answer than they should see. */
async function purgeCaches(): Promise<void> {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* not fatal */
  }
}

// Cache-purge + hard reload. Still used by CLIENT impersonation, which
// genuinely does change identity rather than narrow one: `/api/me` comes
// back as a different person and the shell itself changes.
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
