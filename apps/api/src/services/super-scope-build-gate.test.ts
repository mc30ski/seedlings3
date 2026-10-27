// ─────────────────────────────────────────────────────────────────────────────
// Super-scope build gate
//
// WHAT THIS CAUGHT, TWICE
// An authorization answer derived from the SHELL the reader arrived through
// rather than from what they hold. Both times, a boolean meaning "the most
// privileged build of this tab" was computed by ORing in a second boolean
// meaning "the staff build of this tab" — and because the two shells mounted
// the tab identically, the second was true on both. The reader got the
// highest-privilege rendering from whichever screen they happened to be on.
// The 2026-08-31 instance pulled restricted Timeline rows into a feed that
// was not supposed to carry them.
//
// WHY IT WAS REPOINTED (2026-10-17)
// It scanned for those two flag names. Both were deleted in the
// one-tab-per-feature collapse: there are no shells, no `purpose`, and no
// role-named flags. The scan could no longer match anything, so it passed
// trivially and protected nothing — a green run that means nothing is worse
// than no gate, because it reads like coverage.
//
// The BUG CLASS did not go away; it changed shape. The successor is:
//
//   A capability answer derived from anything other than the
//   PERSPECTIVE-NARROWED set the server put in `me.capabilities`.
//
// `/api/me` resolves what the caller may do and applies any active
// perspective BEFORE replying. Re-deriving that in the browser — from
// `roleGrants`, from a fetched role list, or by applying a perspective a
// second time — restores exactly the powers the perspective exists to
// remove. That is the 2026-08-31 bug with new nouns.
//
// WHAT THIS GATE REQUIRES, in apps/web
//   1. Every `can()` principal is built from `me.capabilities`, carries
//      `perspective: null`, and never mentions a role list.
//   2. `roleGrants` never reaches an entitlement test. It describes OTHER
//      people in the directory; it is not an authorization source.
//   3. "Is a perspective in force?" is read from `me.activePerspectiveRoleId`,
//      never from localStorage. The stored id is what gets SENT; the server
//      ignores one the caller cannot reach, so the stored value can name a
//      perspective that is not active.
//
// Legitimate exceptions carry `// super-scope-allow: <reason>` on the line
// or the line above.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCAN_ROOTS = ["apps/web/src", "apps/web/pages"];

const SUPPRESSION = "super-scope-allow:";

/** The file that may legitimately read the perspective id out of storage —
 *  it is the one that puts it on the wire. */
const HEADER_SENDER = "apps/web/src/lib/api.ts";
/** …and the module that owns the storage keys themselves. */
const STORAGE_OWNER = "apps/web/src/lib/impersonation.ts";

/** A role list masquerading as a capability source. */
const ROLE_SOURCE_RE = /\b(roleGrants|userCustomRoles|customRoles|me\.roles)\b/;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(child);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(child);
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return out;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/**
 * Suppressed when the marker sits on the offending line or the line above —
 * the same convention `date-handling-allow:` uses.
 */
function isSuppressed(src: string, index: number): boolean {
  const lines = src.split("\n");
  const n = lineOf(src, index);
  return (
    (lines[n - 1] ?? "").includes(SUPPRESSION) ||
    (lines[n - 2] ?? "").includes(SUPPRESSION)
  );
}

/**
 * The object literal containing `kind: "user"`, by brace matching.
 *
 * A byte window would cut the literal off mid-way and silently stop seeing
 * the fields it is here to check — which is the failure mode that made the
 * old version of this gate vacuous.
 */
function principalLiteral(src: string, at: number): string {
  let open = src.lastIndexOf("{", at);
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return src.slice(open, i);
}

type Violation = { file: string; line: number; text: string };
const trim = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 140);

/** RULE 1 — every principal is built from the server-narrowed set. */
export function scanPrincipals(files: [string, string][]): Violation[] {
  const found: Violation[] = [];
  for (const [rel, src] of files) {
    const re = /kind:\s*"user"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (isSuppressed(src, m.index)) continue;
      const lit = principalLiteral(src, m.index);
      const why: string[] = [];
      // FILE-level, not literal-level: the sanctioned shape binds the array
      // a few lines above (`const caps = (me?.capabilities ?? [])…`) and
      // passes `entitlements: caps`. Looking only inside the literal would
      // miss that and flag the correct code. A byte window around the
      // literal is the other tempting answer and is worse — it silently
      // stops seeing what it is meant to check, which is how the previous
      // version of this gate went vacuous.
      if (!/\.capabilities\b/.test(src)) {
        why.push(
          "this file builds a principal but never reads `.capabilities` — " +
          "its entitlements come from somewhere other than the server-narrowed set",
        );
      }
      if (!/perspective:\s*null/.test(lit)) {
        why.push("does not pass `perspective: null` (the server already applied it)");
      }
      if (ROLE_SOURCE_RE.test(lit)) {
        why.push("reads a role list — that is re-deriving what the server resolved");
      }
      if (why.length) {
        found.push({ file: rel, line: lineOf(src, m.index), text: why.join("; ") });
      }
    }
  }
  return found;
}

/** RULE 2 — `roleGrants` is never an authorization source. */
export function scanRoleGrantAuthz(files: [string, string][]): Violation[] {
  const found: Violation[] = [];
  for (const [rel, src] of files) {
    src.split("\n").forEach((line, i) => {
      if (!/\broleGrants\b/.test(line)) return;
      // An entitlement test on the same expression: `can(`, or a membership
      // check against a dotted entitlement literal such as "money.approve".
      if (!/\bcan\s*\(|includes\(\s*"[a-z]+\.[a-z-]+"/.test(line)) return;
      if (line.includes(SUPPRESSION) || (src.split("\n")[i - 1] ?? "").includes(SUPPRESSION)) return;
      found.push({ file: rel, line: i + 1, text: trim(line) });
    });
  }
  return found;
}

/** RULE 3 — "is a perspective in force" comes from the server, not storage. */
export function scanPerspectiveSource(files: [string, string][]): Violation[] {
  const found: Violation[] = [];
  for (const [rel, src] of files) {
    if (rel === HEADER_SENDER || rel === STORAGE_OWNER) continue;
    src.split("\n").forEach((line, i) => {
      if (!/getPerspective\s*\(\s*\)|PERSPECTIVE_STORAGE_KEY|seedlings_perspectiveRoleId/.test(line)) return;
      if (line.includes(SUPPRESSION) || (src.split("\n")[i - 1] ?? "").includes(SUPPRESSION)) return;
      found.push({ file: rel, line: i + 1, text: trim(line) });
    });
  }
  return found;
}

function load(): [string, string][] {
  return sourceFiles().map((rel) => [rel, readFileSync(join(REPO_ROOT, rel), "utf8")]);
}

describe("super-scope build gate", () => {
  it("scans a plausible number of files", () => {
    // A broken walk returning [] would make every assertion below vacuously
    // green — the silent-skip failure mode the test-roster gate exists for,
    // and the exact way the previous version of this gate died.
    expect(sourceFiles().length).toBeGreaterThan(100);
  });

  it("the thing it is about is actually present", () => {
    // If nothing in apps/web builds a principal any more, this gate has lost
    // its subject again and must be repointed rather than left green.
    const files = load();
    const principals = files.filter(([, src]) => /kind:\s*"user"/.test(src));
    expect(
      principals.length,
      "no `can()` principal found in apps/web — this gate has lost its subject",
    ).toBeGreaterThan(0);
  });

  it("each detector actually fires", () => {
    // Proves the patterns work. Without this, a typo turns the gate into a
    // no-op that reports success forever — which is what happened to its
    // predecessor for an entire refactor.
    // No `.capabilities` anywhere, a role list as the source, and a
    // re-applied perspective — three defects, each on its own sufficient.
    const bad = `const x = can({ kind: "user", roles: u.roleGrants, perspective: active }, "money.approve");`;
    expect(scanPrincipals([["f.ts", bad]]), "principal detector").not.toEqual([]);

    const grantAuthz = `if (user.roleGrants.some((g) => g.entitlements.includes("money.approve"))) {`;
    expect(scanRoleGrantAuthz([["f.ts", grantAuthz]]), "roleGrants detector").not.toEqual([]);

    const stored = `const active = getPerspective();`;
    expect(scanPerspectiveSource([["f.tsx", stored]]), "perspective-source detector").not.toEqual([]);

    // …and that each stays quiet on the sanctioned shape.
    // The sanctioned shape, including the out-of-literal binding that the
    // file-level check exists to tolerate.
    const good = `const caps = (me?.capabilities ?? []).filter(isEntitlement);\n`
      + `can({ kind: "user", workerType: me?.workerType ?? null, roles: [{ roleId: "__me__", name: "me", entitlements: caps }], perspective: null }, c)`;
    expect(scanPrincipals([["g.ts", good]]), "must not flag the sanctioned principal").toEqual([]);
  });

  it("every can() principal is built from the server-narrowed capability set", () => {
    const v = scanPrincipals(load());
    expect(
      v,
      v.length === 0
        ? ""
        : "A capability answer must come from `me.capabilities`, which the " +
          "server already narrowed by any active perspective. Re-deriving it " +
          "in the browser restores the powers the perspective exists to " +
          "remove — the 2026-08-31 leak with new nouns.\n" +
          v.map((x) => `  ${x.file}:${x.line}  ${x.text}`).join("\n"),
    ).toEqual([]);
  });

  it("roleGrants never answers an authorization question", () => {
    const v = scanRoleGrantAuthz(load());
    expect(
      v,
      v.length === 0
        ? ""
        : "`roleGrants` describes OTHER people in the directory — it is not " +
          "narrowed by a perspective and is not the caller's resolved set. " +
          "Ask `scope.can(entitlement)` instead.\n" +
          v.map((x) => `  ${x.file}:${x.line}  ${x.text}`).join("\n"),
    ).toEqual([]);
  });

  it("whether a perspective is in force comes from the server, not localStorage", () => {
    const v = scanPerspectiveSource(load());
    expect(
      v,
      v.length === 0
        ? ""
        : "Read `me.activePerspectiveRoleId`. The stored id is what gets SENT; " +
          "the server ignores one the caller cannot reach, so the stored value " +
          `can name a perspective that is not active. Only ${HEADER_SENDER} ` +
          `and ${STORAGE_OWNER} may touch the key.\n` +
          v.map((x) => `  ${x.file}:${x.line}  ${x.text}`).join("\n"),
    ).toEqual([]);
  });
});
