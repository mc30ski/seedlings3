import type { Role, WorkerType } from "@prisma/client";

// Super-only "View as another role" support. The frontend sets the header
// `X-Impersonate-As` when an active impersonation is selected; both the /me
// endpoint and the requireApproved auth decorator parse it through this
// helper, then call `applyImpersonation` to produce a swapped role payload.
//
// Security model: the parser only accepts safe targets — never SUPER, never
// a way to elevate. The caller layer (users.me + requireApproved) is
// responsible for gating the swap on the underlying user actually being a
// SUPER. If a non-Super sends this header, parse may succeed but the caller
// will ignore the result.

export const IMPERSONATE_HEADER = "x-impersonate-as";

export type ImpersonationTarget = {
  roles: Role[];
  workerType: WorkerType | null;
};

const VALID_WORKER_TYPES: ReadonlySet<string> = new Set<string>([
  "EMPLOYEE",
  "CONTRACTOR",
  "TRAINEE",
]);

/**
 * Parse the X-Impersonate-As header into an effective role/workerType.
 * Accepted forms:
 *   - "ADMIN"                  → roles: ["ADMIN"], workerType: null
 *   - "WORKER:EMPLOYEE"        → roles: ["WORKER"], workerType: "EMPLOYEE"
 *   - "WORKER:CONTRACTOR"      → roles: ["WORKER"], workerType: "CONTRACTOR"
 *   - "WORKER:TRAINEE"         → roles: ["WORKER"], workerType: "TRAINEE"
 *
 * Anything else (including "SUPER" or a malformed value) returns null. The
 * caller must then leave the user's real role intact — silent fallback, no
 * error response, so the feature's existence doesn't leak via 400s.
 */
export function parseImpersonationHeader(
  value: string | string[] | undefined | null,
): ImpersonationTarget | null {
  if (!value) return null;
  const raw = (Array.isArray(value) ? value[0] : value).trim().toUpperCase();
  if (!raw) return null;
  if (raw === "ADMIN") {
    return { roles: ["ADMIN" as Role], workerType: null };
  }
  if (raw.startsWith("WORKER:")) {
    const wt = raw.slice("WORKER:".length);
    if (VALID_WORKER_TYPES.has(wt)) {
      return { roles: ["WORKER" as Role], workerType: wt as WorkerType };
    }
  }
  return null;
}

/**
 * Decide whether to apply an impersonation target. Returns the target only
 * when (a) the caller really is a SUPER and (b) the header parsed cleanly.
 * Centralizes the SUPER gate so the two call sites (users.me + rbac) can't
 * accidentally drift.
 */
export function resolveImpersonation(
  realRoles: Role[],
  headerValue: string | string[] | undefined | null,
): ImpersonationTarget | null {
  const isReallySuper = realRoles.includes("SUPER" as Role);
  if (!isReallySuper) return null;
  return parseImpersonationHeader(headerValue);
}

// ─────────────────────────────────────────────────────────────────────────────
// Client "View as" — Super-only impersonation of a specific ClientContact.
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
