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
