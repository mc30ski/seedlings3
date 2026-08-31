// ─────────────────────────────────────────────────────────────────────────────
// Super-scope build gate
//
// PURPOSE
// A user's ROLE and the tab they are currently ON are different things. Super
// extras must be gated on SCOPE (the role chip the operator selected), never
// on role alone — otherwise a super sitting on the Admin chip silently gets
// super powers and super-only data.
//
// This bug class has now shipped TWICE, under two different variable names:
//
//   1. `showSuperExtras` fell back to `forAdmin ||` and leaked super-only
//      buttons into the Admin tab.
//   2. 2026-08-31 — JobsTab had:
//
//        const isSuper = (forAdmin || scope.isSuper) && hasSuperRole;
//
//      Both the Admin tab AND the Super tab mount JobsTab with
//      purpose="ADMIN", so `forAdmin` is true on both. A super on the Admin
//      chip therefore got isSuper === true, and the jobs feed fetched
//      /api/super/timeline/upcoming — pulling adminHidden Timeline events
//      (and, had any carried an expiry date, 21 adminHidden documents) into
//      the admin's own feed.
//
// The correct shape is `scope.isSuper && hasSuperRole`. Note the deliberate
// asymmetry with `isAdmin`, which MAY use `forAdmin ||`: purpose="ADMIN"
// legitimately means "show admin extras". Only SUPER is scope-only.
//
// WHAT THIS GATE REQUIRES
// No super-scope derivation may reference `forAdmin`, in either form:
//   • a const/let whose name contains "Super"
//   • a JSX prop whose name contains "Super"
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

/**
 * A super-scope binding that reads `forAdmin`.
 *
 * Matches the declaration name (anything containing "Super") and its
 * initializer up to the statement end. `forAdmin` anywhere in that
 * initializer is the defect — `(forAdmin || scope.isSuper)`,
 * `forAdmin ? … : …`, and `scope.isSuper || forAdmin` all qualify.
 */
const DECL_RE =
  /\b(?:const|let|var)\s+([A-Za-z0-9_$]*Super[A-Za-z0-9_$]*)\s*=\s*([^;]*);/g;

/** A JSX prop named *Super* whose value expression reads `forAdmin`. */
const PROP_RE = /\b([A-Za-z0-9_$]*[Ss]uper[A-Za-z0-9_$]*)=\{([^}]*)\}/g;

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

/** Line number (1-indexed) of a character offset. */
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

type Violation = { file: string; line: number; text: string };

function scan(): Violation[] {
  const found: Violation[] = [];
  for (const rel of sourceFiles()) {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    if (!src.includes("forAdmin")) continue;
    for (const re of [DECL_RE, PROP_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const [, name, rhs] = m;
        if (!/\bforAdmin\b/.test(rhs)) continue;
        if (isSuppressed(src, m.index)) continue;
        found.push({
          file: rel,
          line: lineOf(src, m.index),
          text: `${name} = ${rhs.trim().replace(/\s+/g, " ").slice(0, 120)}`,
        });
      }
    }
  }
  return found;
}

describe("super-scope build gate", () => {
  it("scans a plausible number of files", () => {
    // A broken walk returning [] would make the assertion below vacuously
    // green — the silent-skip failure mode the test-roster gate exists for.
    expect(sourceFiles().length).toBeGreaterThan(100);
  });

  it("its own detector actually fires", () => {
    // Proves the regexes work. Without this, a typo in a pattern turns the
    // gate into a no-op that reports success forever.
    const shipped = "const isSuper = (forAdmin || scope.isSuper) && hasSuperRole;";
    DECL_RE.lastIndex = 0;
    const m = DECL_RE.exec(shipped);
    expect(m, "DECL_RE no longer matches the 2026-08-31 regression").not.toBeNull();
    expect(/\bforAdmin\b/.test(m![2])).toBe(true);

    PROP_RE.lastIndex = 0;
    const p = PROP_RE.exec("<Tab isSuper={forAdmin || scope.isSuper} />");
    expect(p, "PROP_RE no longer matches a forAdmin-derived super prop").not.toBeNull();
    expect(/\bforAdmin\b/.test(p![2])).toBe(true);
  });

  it("no super-scope derivation falls back to forAdmin", () => {
    const violations = scan();
    expect(
      violations,
      violations.length === 0
        ? ""
        : "Super extras must be gated on SCOPE, not role. `forAdmin` is true " +
          "on BOTH the Admin and Super tabs (both mount with purpose=\"ADMIN\"), " +
          "so a super on the Admin chip would get super-only data and actions. " +
          "Use `scope.isSuper && hasSuperRole`. `isAdmin` may use `forAdmin ||` " +
          "— only SUPER is scope-only. If an exception is genuinely correct, " +
          `add "// ${SUPPRESSION} <reason>" above the line.\n` +
          violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n"),
    ).toEqual([]);
  });
});
