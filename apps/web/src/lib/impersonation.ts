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
//  3. PORTFOLIO LENS — "show me only Durham". Narrows WHERE, where a perspective
//     narrows WHAT YOU MAY DO. Unrelated mechanisms and freely combined: you
//     can look at Durham through a scheduler's perspective. Sent as
//     `X-Portfolio-Lens` carrying an Portfolio id; the server intersects it with the
//     portfolios you are granted, so a forged value shows you LESS, never more.
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

/**
 * Fired when the SIGNED-IN PERSON'S OWN capability set may have changed,
 * as opposed to the lens they are looking through.
 *
 * `/api/me` is fetched once at load, so what the app believes you may do
 * is a snapshot. A grant that lands after that snapshot is invisible until
 * something refetches: the role builder goes on saying "you don't hold
 * this" about a capability you now hold, which reads as a bug in the
 * builder rather than a stale cache. That happened for real when a
 * migration granted two capabilities mid-session.
 *
 * Deliberately NOT a poll — the app does not poll — and deliberately
 * lighter than PERSPECTIVE_CHANGED_EVENT: this refetches `me` and nothing
 * else, because the data on screen is still answering the right question.
 * Fire it at the moments the app can actually know: granting or revoking a
 * role on yourself, and opening the screen whose whole subject is what
 * roles grant.
 */
export const CAPABILITIES_CHANGED_EVENT = "seedlings3:capabilities-changed";

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
// PORTFOLIO LENS — "show me only Durham", for somebody entitled to see more.
// ─────────────────────────────────────────────────────────────────────────────

export const AREA_LENS_STORAGE_KEY = "seedlings_areaLensId";
/** The chosen portfolio's NAME, cached so the header chip can render before
 *  `/me/portfolios` has answered. Display only; nothing resolves on it. */
export const AREA_LENS_NAME_STORAGE_KEY = "seedlings_areaLensName";

/**
 * "ALL" means the viewer DELIBERATELY chose the whole business.
 *
 * An absent key and an explicit all-portfolios choice used to be the same
 * state — both null. They cannot be, now that leading a portfolio sets
 * your default view to it: without a way to record "I chose All", the
 * default would reassert itself on every load and the chip would be a
 * control you could operate but not obey.
 */
export const AREA_LENS_ALL = "ALL";

/** True once the viewer has picked something, including "All portfolios". */
export function hasChosenAreaLens(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !!localStorage.getItem(AREA_LENS_STORAGE_KEY);
  } catch {
    return false;
  }
}

/** One entry of `GET /me/portfolios` — somewhere this caller may point the lens. */
export type AreaLensOption = {
  id: string;
  name: string;
  tier: string | null;
  path: string;
  /** Names from the top of the tree down to this portfolio, root excluded —
   *  e.g. ["Chapel Hill", "Carrboro"]. Server-built; the client has no
   *  reliable way to name an ancestor it may not be allowed to select. */
  trail?: string[];
};

/**
 * The portfolio id being looked through, or null for "everywhere I can see".
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
    // Absent, or an explicit "show me everything" — either way, no filter.
    if (!raw || raw === AREA_LENS_ALL) return null;
    // Same shape check the server's `parseAreaLensHeader` applies, so junk
    // is dropped here rather than sent and silently ignored.
    return /^[A-Za-z0-9_-]{10,40}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The cached name of the chosen portfolio. Display only — see the key's note. */
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
 * Look at one portfolio, or pass null to go back to everywhere.
 *
 * Purge-and-refetch rather than reload, for the same reason `setPerspective`
 * does it: every response on screen was fetched through the OUTGOING lens,
 * so they are all stale — but throwing the whole app away to change which
 * district you are reading is not what the feature is.
 */
export async function setAreaLens(portfolioId: string | null, name?: string | null): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (portfolioId) {
      localStorage.setItem(AREA_LENS_STORAGE_KEY, portfolioId);
      if (name) localStorage.setItem(AREA_LENS_NAME_STORAGE_KEY, name);
      else localStorage.removeItem(AREA_LENS_NAME_STORAGE_KEY);
    } else {
      // Record the choice rather than erase it. Clearing the key would
      // read as "never chose", and the default-to-your-portfolio below
      // would put the filter straight back on the next load.
      localStorage.setItem(AREA_LENS_STORAGE_KEY, AREA_LENS_ALL);
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

/** Fired after the portfolio lens changes. `pages/index.tsx` listens and remounts
 *  the open tab, the same way it does for a perspective change. */
export const AREA_LENS_CHANGED_EVENT = "seedlings3:portfolio-lens-changed";

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


/**
 * LEADING A PORTFOLIO SETS YOUR DEFAULT VIEW TO IT.
 *
 * `portfolioScope` narrows a person whose access comes only from a grant.
 * It deliberately does NOT narrow somebody who holds the same capability
 * company-wide — invariant 1 in `portfolioScope.ts`, which exists so a
 * grant can never quietly take access away.
 *
 * That left the owner assigning themselves District Lead of Durham with a
 * record and nothing else: every list still showed the whole business.
 * What they wanted was the ordinary consequence of leading a patch —
 * their jobs, their properties, their money — without losing a single tab.
 *
 * A lens does exactly that, and is the one narrowing a global reader
 * accepts, because it is a request rather than a restriction. So a grant
 * seeds the lens instead of changing what a grant means:
 *
 *   · data narrows, because the lens is in force
 *   · tabs and controls do not, because those come from capabilities
 *   · "All portfolios" is one click away, and sticks once chosen
 *
 * Only with exactly ONE granted portfolio. With two, their default view is
 * already both, and picking one for them would be inventing a preference.
 */
export function applyDefaultAreaLens(
  grants: Array<{ id: string; trail: string[] }> | undefined,
): boolean {
  if (typeof window === "undefined") return false;
  if (hasChosenAreaLens()) return false;
  if (!grants || grants.length !== 1) return false;
  const only = grants[0];
  if (!only?.id) return false;
  try {
    localStorage.setItem(AREA_LENS_STORAGE_KEY, only.id);
    const name = only.trail?.[only.trail.length - 1];
    if (name) localStorage.setItem(AREA_LENS_NAME_STORAGE_KEY, name);
    window.dispatchEvent(new Event(AREA_LENS_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}
