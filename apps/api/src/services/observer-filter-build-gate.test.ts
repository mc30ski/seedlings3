// ─────────────────────────────────────────────────────────────────────────────
// Observer-filter build gate
//
// PURPOSE
// Locks in the SQL three-valued-logic gotcha that caused the Reconcile
// → Payroll surface to silently drop every worker whose
// `JobOccurrenceAssignee.role` was NULL (the common "regular worker —
// no special role set" case).
//
// THE BUG
//   Prisma:  where: { role: { not: "observer" } }
//   SQL:     WHERE role != 'observer'
//   Postgres semantics: NULL != 'observer' → UNKNOWN, NOT TRUE.
//   Result:  every row with role=NULL is silently dropped.
//
// THE FIX (used everywhere else in the codebase)
//   where: { OR: [{ role: null }, { role: { not: "observer" } }] }
//
// HOW THIS GATE WORKS
// We scan every .ts/.tsx file under apps/api/src for the bare pattern
// `role: { not: "observer" }` and fail if it appears OUTSIDE of an
// `OR: [{ role: null }, ...]` clause. If you intentionally want to
// exclude rows with NULL role, add `// observer-filter-allow: <reason>`
// on the immediately preceding line — same suppression convention the
// date-handling gate uses.
//
// WIRED VIA  `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");

const SCAN_DIRS = ["apps/api/src"] as const;

function shouldSkipFile(repoRelPath: string): boolean {
  if (repoRelPath.endsWith(".test.ts") || repoRelPath.endsWith(".test.tsx")) return true;
  if (repoRelPath.endsWith(".d.ts")) return true;
  return false;
}

// The forbidden patterns. Two equivalent Prisma syntaxes can
// produce the same broken SQL — both must be caught:
//   • `role: { not: "observer" }`     ← Prisma "field-level not" form
//   • `NOT: { role: "observer" }`     ← Prisma "object-level NOT" form
// Both translate to `role != 'observer'` which excludes NULL roles
// via Postgres three-valued logic. We match across whitespace so
// minified and pretty-printed variants both hit.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /role\s*:\s*\{\s*not\s*:\s*["']observer["']\s*\}/,
  /NOT\s*:\s*\{\s*role\s*:\s*["']observer["']\s*\}/,
];

// A nearby `{ role: null }` within ~120 chars BEFORE the forbidden
// match indicates the safe `OR: [{ role: null }, { role: { not: "observer" } }]`
// pattern. This is a string-distance heuristic; if the OR clause is
// split across many lines you may need to compact it.
const SAFE_NEIGHBOR = /\{\s*role\s*:\s*null\s*\}/;

const SUPPRESS_COMMENT = /\/\/\s*observer-filter-allow:/;

type Violation = { file: string; line: number; text: string };

function scanFile(absPath: string, repoRelPath: string): Violation[] {
  const text = readFileSync(absPath, "utf8");
  const lines = text.split("\n");
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FORBIDDEN_PATTERNS.some((re) => re.test(line));
    if (!m) continue;

    // Per-line suppression on the immediately preceding line.
    if (i > 0 && SUPPRESS_COMMENT.test(lines[i - 1])) continue;

    // Look BACKWARDS up to 4 lines (covers the multi-line OR layout
    // used widely in this codebase, e.g.
    //   OR: [
    //     { role: null },
    //     { role: { not: "observer" } },
    //   ]
    // ) for a `{ role: null }` neighbor — that's the safe pattern.
    const startBack = Math.max(0, i - 4);
    const lookback = lines.slice(startBack, i + 1).join("\n");
    if (SAFE_NEIGHBOR.test(lookback)) continue;

    // Also look FORWARDS a couple lines in case of unusual layout
    // where { role: null } is below.
    const lookahead = lines.slice(i, Math.min(lines.length, i + 3)).join("\n");
    if (SAFE_NEIGHBOR.test(lookahead) && lookahead.indexOf("OR") !== -1) continue;

    violations.push({ file: repoRelPath, line: i + 1, text: line.trim() });
  }
  return violations;
}

function walk(dir: string, repoRoot: string, acc: string[]) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === ".turbo") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, repoRoot, acc);
    } else if (st.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      acc.push(full);
    }
  }
}

describe("observer-filter build gate", () => {
  it("rejects `role: { not: 'observer' }` without an `{ role: null }` companion clause", () => {
    const all: string[] = [];
    for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d), REPO_ROOT, all);

    const allViolations: Violation[] = [];
    for (const abs of all) {
      const rel = relative(REPO_ROOT, abs);
      if (shouldSkipFile(rel)) continue;
      allViolations.push(...scanFile(abs, rel));
    }

    if (allViolations.length > 0) {
      const msg =
        `\nFound ${allViolations.length} forbidden observer-filter pattern(s).\n` +
        `These will silently drop assignees whose role is NULL.\n` +
        `Replace with:  where: { OR: [{ role: null }, { role: { not: "observer" } }] }\n\n` +
        allViolations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n\n") +
        `\n\nIf the exclusion of NULL roles IS intentional, add a comment on the immediately preceding line:\n` +
        `  // observer-filter-allow: <reason>\n`;
      expect.fail(msg);
    }
  });
});
