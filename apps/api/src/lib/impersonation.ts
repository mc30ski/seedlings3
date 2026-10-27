import type { Entitlement } from "@repo/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// PERSPECTIVES — looking at the app as someone with less access would.
//
// WHAT THIS REPLACED
// The old `X-Impersonate-As` header SWAPPED the caller's roles array for
// a synthetic one. That had two problems the perspective model fixes:
//
//   1. It showed the GENERIC worker experience, not "what I would see if
//      demoted" — custom-role grants were dropped wholesale, because there
//      was no other user whose grants applied. So someone with `settings.manage` could not actually
//      check what one of their own people sees.
//   2. It was expressed as a role, and roles no longer authorize anything.
//      There is no roles array left to swap.
//
// A perspective is a named SUBSET of what the caller ALREADY HOLDS. It can
// only ever narrow (G35), and it is offered only when the caller holds its
// role or one that inherits it — which is what stops an unpaid observer
// being offered a scheduler's perspective. The subset property is why the
// downgrade is safe: there is no value of the header that grants anything.
//
// THE HEADER CARRIES A ROLE ID, and `resolvePerspective` only returns one
// that appeared in the caller's own resolved `perspectives` list. A roleId
// the caller cannot reach is ignored silently rather than refused, so the
// feature's existence does not leak through a 4xx.
// ─────────────────────────────────────────────────────────────────────────────

export const PERSPECTIVE_HEADER = "x-perspective";

export type AvailablePerspective = {
  roleId: string;
  key: string | null;
  name: string;
  order: number;
  entitlements: string[];
};

export type ActivePerspective = {
  roleId: string;
  entitlements: readonly Entitlement[];
};

/** Parse the header into a candidate roleId. Shape check only. */
export function parsePerspectiveHeader(
  value: string | string[] | undefined | null,
): string | null {
  if (!value) return null;
  const raw = (Array.isArray(value) ? value[0] : value).trim();
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(raw)) return null;
  return raw;
}

/**
 * Decide which perspective is active.
 *
 * Returns one ONLY when the requested roleId is in the caller's own
 * `perspectives` list — the list already filtered to roles they hold or
 * inherit. That single check is what makes this incapable of elevating:
 * every candidate is, by construction, a subset of what they hold.
 */
export function resolvePerspective(
  available: readonly AvailablePerspective[],
  headerValue: string | string[] | undefined | null,
): ActivePerspective | null {
  const wanted = parsePerspectiveHeader(headerValue);
  if (!wanted) return null;
  const hit = available.find((p) => p.roleId === wanted);
  if (!hit) return null;
  return { roleId: hit.roleId, entitlements: hit.entitlements as Entitlement[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Client "View as" — `clients.view-as` impersonation of a specific ClientContact.
//
// Distinct from the role impersonation above: role impersonation says
// "treat me as if my role were X". Client impersonation says "treat me as
// if I were logged in as this specific client account". It swaps the
// effective Clerk user ID so all downstream client-facing queries
// (properties, invoices, activity feed) return the target's real data.
//
// Read-only by design: any non-safe HTTP method is refused at the plugin
// layer. See plugins/clientImpersonation.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_IMPERSONATE_HEADER = "x-impersonate-client-contact";

/**
 * Parse the client-impersonation header value. Accepts a CUID-shaped
 * ClientContact ID string. Returns the raw string if it plausibly looks
 * like a contact ID; the real existence check happens in the resolver
 * (which hits the DB). Returns null for empty / malformed values.
 *
 * We don't accept email addresses or Clerk user IDs — the value MUST be a
 * ClientContact.id so the picker's choice is unambiguous when a single
 * Clerk user is linked to multiple contacts across multiple Clients.
 */
export function parseClientImpersonationHeader(
  value: string | string[] | undefined | null,
): string | null {
  if (!value) return null;
  const raw = (Array.isArray(value) ? value[0] : value).trim();
  // Cuid is 25 lowercase alphanumeric chars. Be forgiving on length; the
  // real existence check below catches anything that doesn't map.
  if (!/^[a-z0-9]{10,40}$/.test(raw)) return null;
  return raw;
}
