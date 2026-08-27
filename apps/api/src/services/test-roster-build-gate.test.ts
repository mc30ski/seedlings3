// ─────────────────────────────────────────────────────────────────────────────
// Test roster build gate
//
// PURPOSE
// `test:build-gate` in package.json is an EXPLICIT FILE LIST, not a glob —
// deliberately, so adding a gate is a conscious act. The cost of that
// choice is that the list and the filesystem can drift, and vitest will
// not tell you.
//
// Found 2026-08-27: the list named `src/services/exports.test.ts`, deleted
// in c9fe8a4. The script had been reporting "22 passed (22)" against 23
// listed files ever since, green the whole time.
//
// It is silent because vitest treats those paths as FILTERS. It exits 1
// only when NO file matches; one dead entry among twenty live ones just
// runs one fewer file. So the failure is invisible in exactly the case
// that matters — a gate renamed or deleted without updating the script
// stops running and nothing says so.
//
// WHAT THIS GATE REQUIRES
//   1. Every path in `test:build-gate` exists on disk.
//   2. Every `*-build-gate.test.ts` under src/ appears in the list.
//   3. No duplicates padding the count.
//
// (2) is the important one: CLAUDE.md tells every contributor to add a new
// gate to FORBIDDEN_PATTERNS / the roster and wire it here. This makes
// forgetting the wiring a build failure rather than a gate that silently
// never runs.
//
// Non-gate unit tests are NOT required to be listed — some are slow or
// need a database. Only the `*-build-gate.test.ts` naming convention is
// mandatory, which is what makes the convention worth keeping.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";

const API_ROOT = resolve(__dirname, "../..");

/** The file paths named in the `test:build-gate` script, in order. */
function listedFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(API_ROOT, "package.json"), "utf8"));
  const script: string = pkg.scripts?.["test:build-gate"] ?? "";
  return script.split(/\s+/).filter((t) => t.endsWith(".test.ts"));
}

/** Every `*-build-gate.test.ts` on disk, as paths relative to apps/api. */
function gateFilesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(API_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(child);
      } else if (entry.name.endsWith("-build-gate.test.ts")) {
        out.push(child);
      }
    }
  };
  walk("src");
  return out;
}

describe("test roster build gate", () => {
  it("finds the script and a plausible number of entries", () => {
    // A parse that returned [] would make every assertion below vacuous —
    // the same silent-skip failure this gate exists to catch.
    expect(listedFiles().length).toBeGreaterThanOrEqual(10);
    expect(gateFilesOnDisk().length).toBeGreaterThanOrEqual(5);
  });

  it("every file named in test:build-gate exists", () => {
    for (const rel of listedFiles()) {
      expect(
        existsSync(join(API_ROOT, rel)),
        `test:build-gate names "${rel}", which does not exist. vitest treats ` +
          "these as filters and only fails when NOTHING matches, so a dead " +
          "entry silently shrinks the run instead of erroring.",
      ).toBe(true);
    }
  });

  it("every build gate on disk is wired into test:build-gate", () => {
    // The direction that actually costs coverage: a gate exists, passes in
    // isolation, and never runs on a build.
    const listed = new Set(listedFiles());
    for (const rel of gateFilesOnDisk()) {
      expect(
        listed.has(rel),
        `"${rel}" is a build gate but is NOT in the test:build-gate script — ` +
          "it will never run on a build. Add it to package.json and to the " +
          "roster in .claude/memory/reference_build_gates_roster.md.",
      ).toBe(true);
    }
  });

  it("the list has no duplicate entries", () => {
    // A duplicate inflates the apparent count and can mask a deletion.
    const listed = listedFiles();
    expect(listed.length, `duplicates: ${listed.filter((f, i) => listed.indexOf(f) !== i)}`).toBe(
      new Set(listed).size,
    );
  });
});
