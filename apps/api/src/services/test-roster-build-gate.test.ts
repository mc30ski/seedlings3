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

/** Every `*.test.ts` under src/, gate or not. */
function allTestFilesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(API_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(child);
      } else if (entry.name.endsWith(".test.ts")) {
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

  it("every test file is either wired in or explicitly skipped", () => {
    /**
     * WHY THIS COVERS MORE THAN THE GATE CHECK ABOVE.
     *
     * That one requires `*-build-gate.test.ts` files to be listed. Ordinary
     * unit tests were exempt, on the reasoning that some are slow or need a
     * database. Defensible — but the exemption was SILENT, and silence is
     * what this whole gate exists to remove.
     *
     * `services/equipment.test.ts` sat unlisted for months: 600 lines of
     * equipment rental-cost invariants, neither slow nor database-backed,
     * that simply never ran. When it was finally executed it FAILED — one
     * assertion had rotted into asserting a bug as policy ("null workerType
     * is treated as billable"), which is the negation G30 forbids and the
     * shape that charged unclassified workers a contractor fee. A test that
     * does not run cannot tell you it has gone wrong.
     *
     * So the exemption stays available and stops being silent: skip a file
     * by writing the reason in it.
     *
     *     // roster-skip: needs a live Neon branch; run with `npm run test:db`
     *
     * Listed or skipped — either is fine. Neither is not.
     */
    const listed = new Set(listedFiles());
    const offenders: string[] = [];
    for (const rel of allTestFilesOnDisk()) {
      if (listed.has(rel)) continue;
      const src = readFileSync(join(API_ROOT, rel), "utf8");
      // Match the marker FIRST, then judge the reason — otherwise a bare
      // `// roster-skip:` reports as "no roster-skip", which is the kind of
      // not-quite-true message this gate exists to stamp out.
      const skip = /^[ \t]*\/\/[ \t]*roster-skip:(.*)$/m.exec(src);
      const reason = skip ? skip[1].trim() : null;
      if (reason && reason.length >= 10) continue;
      offenders.push(
        skip
          ? `${rel} — has a roster-skip but gives no reason for it`
          : `${rel} — not in test:build-gate and no roster-skip`,
      );
    }
    expect(
      offenders.sort(),
      "A test file that is neither wired into `test:build-gate` nor marked " +
        "`// roster-skip: <reason>` never runs, and a test that never runs " +
        "cannot report that it has started failing. Add it to the script, " +
        "or say in the file why it is excluded.",
    ).toEqual([]);
  });

  it("the list has no duplicate entries", () => {
    // A duplicate inflates the apparent count and can mask a deletion.
    const listed = listedFiles();
    expect(listed.length, `duplicates: ${listed.filter((f, i) => listed.indexOf(f) !== i)}`).toBe(
      new Set(listed).size,
    );
  });
});
