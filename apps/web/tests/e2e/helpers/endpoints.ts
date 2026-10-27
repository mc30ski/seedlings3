import { readdirSync, readFileSync } from "fs";
import path from "path";

/**
 * THE BACKEND'S ENDPOINT INVENTORY, PARSED AT RUN TIME.
 *
 * Not a committed fixture, deliberately. A generated list is a second source
 * of truth that goes stale the moment somebody adds a route, and the point of
 * this suite is that it cannot silently stop covering something. Reading
 * `apps/api/src/routes/*.ts` on every run means a new endpoint is in the
 * matrix the first time the suite executes after it lands.
 *
 * The parse mirrors `apps/api/scripts/build-route-map.ts` — same guard-const
 * lookup, same bucketing — so this suite and the route map cannot disagree
 * about what exists.
 */

export type Bucket =
  | { kind: "entitlement"; entitlement: string }
  | { kind: "ownership" }
  | { kind: "client-portal" }
  | { kind: "public" }
  | { kind: "system" };

export type Endpoint = {
  verb: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path as declared, e.g. `/occurrences/:id/addons`. */
  path: string;
  /** The file it is declared in, for failure messages. */
  file: string;
  bucket: Bucket;
  /**
   * The route's own `// in-handler-scoped: <reason>` annotation, if present.
   *
   * Some routes use their entitlement as a FLOOR and then apply a narrower
   * rule the entitlement cannot express — "you must be the claimer of this
   * visit", "you must be on this job". Holding the entitlement is then
   * correctly not enough, so the ALLOW half of the matrix does not apply.
   *
   * The reason lives at the CALLSITE, in the route source, exactly like
   * `view-as-allow`, `caller-read-allow` and `claimer-invariant-allow`. That
   * is deliberate: an allowlist kept in the test file would be a second
   * source of truth about authorization, and this repo has been bitten by
   * every one of those it has had.
   */
  inHandlerScoped: string | null;
};

const ROUTES_DIR = path.resolve(__dirname, "../../../../api/src/routes");

/** A path param value that cannot match a real row. */
export const PROBE_ID = "e2e-no-such-row-0000";

/** Substitute every `:param` with a value that resolves to nothing. */
export function concretePath(p: string): string {
  return p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, PROBE_ID);
}

/** True when the path has no parameters, so a GET should really return 2xx. */
export function isParameterless(p: string): boolean {
  return !/:[A-Za-z_]/.test(p);
}

let cache: Endpoint[] | null = null;

export function allEndpoints(): Endpoint[] {
  if (cache) return cache;
  const out: Endpoint[] = [];

  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(path.join(ROUTES_DIR, file), "utf8");

    // `const req_moneyApprove = requires("money.approve")`
    const guardToEntitlement = new Map<string, string>();
    for (const m of src.matchAll(
      /const\s+([A-Za-z0-9_]+)\s*=\s*requires\(\s*"([^"]+)"\s*\)/g,
    )) {
      guardToEntitlement.set(m[1], m[2]);
    }

    const lines = src.split("\n");
    /**
     * The `in-handler-scoped:` note belonging to THIS route.
     *
     * Walks UPWARD from the declaration and stops at the previous route
     * registration — otherwise the note above one route is also "above" the
     * next one, and the annotation silently covers a route nobody annotated.
     * The first version of this did exactly that and claimed
     * `GET /occurrences/pinned` was scoped using the note written for
     * `/unclaim`.
     */
    const scopedNoteAt = (offset: number): string | null => {
      const lineNo = src.slice(0, offset).split("\n").length - 1;
      for (let i = lineNo - 1; i >= 0; i--) {
        const line = lines[i] ?? "";
        if (/app\.(get|post|patch|put|delete)\s*(?:<[^>]*>)?\s*\(/.test(line)) return null;
        const m = /\/\/\s*in-handler-scoped:\s*(.+)$/.exec(line);
        if (m) {
          // Continuation lines: the reason may wrap across several `//` lines.
          const parts = [m[1].trim()];
          for (let j = i + 1; j < lineNo; j++) {
            const cont = /^\s*\/\/\s?(.*)$/.exec(lines[j] ?? "");
            if (!cont) break;
            parts.push(cont[1].trim());
          }
          return parts.join(" ").trim();
        }
      }
      return null;
    };

    for (const m of src.matchAll(
      /app\.(get|post|patch|put|delete)\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"\s*(?:,\s*([A-Za-z0-9_.]+))?/g,
    )) {
      const verb = m[1].toUpperCase() as Endpoint["verb"];
      const p = m[2];
      const guard = m[3] ?? "";
      const inHandlerScoped = scopedNoteAt(m.index ?? 0);

      const entitlement = guardToEntitlement.get(guard);
      let bucket: Bucket;
      if (entitlement) bucket = { kind: "entitlement", entitlement };
      else if (guard === "approvedUser") bucket = { kind: "ownership" };
      else if (guard === "clientGuard") bucket = { kind: "client-portal" };
      else if (file === "public.ts") bucket = { kind: "public" };
      else if (file === "system.ts" || file === "cron.ts") bucket = { kind: "system" };
      else bucket = { kind: "ownership" }; // me.ts — caller-scoped in-handler

      out.push({ verb, path: p, file, bucket, inHandlerScoped });
    }
  }

  // Stable order so a failure list reads the same way twice.
  out.sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb));
  cache = out;
  return out;
}

export const guardedEndpoints = () =>
  allEndpoints().filter(
    (e): e is Endpoint & { bucket: { kind: "entitlement"; entitlement: string } } =>
      e.bucket.kind === "entitlement",
  );

/** Every entitlement that guards at least one route. */
export function entitlementsWithRoutes(): string[] {
  return [...new Set(guardedEndpoints().map((e) => e.bucket.entitlement))].sort();
}

/** A mutation executes if it gets past the guard, so it is probed differently. */
export const isMutation = (e: Endpoint) => e.verb !== "GET";
