import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve, relative } from "path";

/**
 * View-as endpoints build gate.
 *
 * Enforces the rule documented in docs/VIEW_AS_ENDPOINTS.md:
 *
 *   Every `GET /me/*` route registered with `workerGuard` (or
 *   `requireApproved`) must EITHER support view-as (i.e. accept an
 *   optional `?viewAsUserId=<id>` query param + role gate) OR be
 *   annotated as `// view-as-allow: <reason>` explaining why the
 *   endpoint is intentionally caller-scoped.
 *
 * This has already caught the same class of bug THREE times in
 * production (client "My Properties", workday-start spinner,
 * ComplianceBanner disabled). Every new /me GET must make an explicit
 * choice or CI blocks the merge.
 *
 * Sibling to `date-handling-build-gate.test.ts` — same mechanical
 * "scan, match a pattern, require an accompanying annotation" shape.
 */

// Patterns that count as "view-as aware" inside a handler body:
//   - resolveWorkdayTarget(...)     — the shared workday helper
//   - viewAsUserId                  — inline query-param handling
// Either match → the route is considered compliant.
const VIEW_AS_AWARE_PATTERNS = [
  /\bresolveWorkdayTarget\s*\(/,
  /\bviewAsUserId\b/,
];

// Match an `app.get("/me/...", ..., async (req...) => { BODY })` handler.
// Non-greedy body match with a nesting-aware stopper is impractical via
// pure regex, so we use a two-pass approach: locate the route header,
// then walk the file forward tracking braces to isolate the handler body.
const ROUTE_HEADER = /^\s*app\.get\(\s*"(\/me\/[^"]*)"/;

// The annotation must appear on a comment line within the 12 lines
// preceding the `app.get(` header. Blank lines and other comment lines
// don't interrupt the lookback; a non-comment, non-blank statement does.
// Format: `// view-as-allow: <reason>` (case-sensitive so misspellings
// don't slip through).
const ANNOTATION_LOOKBACK_LINES = 12;
const ANNOTATION_PATTERN = /^\s*\/\/\s*view-as-allow:\s*.+$/;

// Directories to scan for Fastify route registrations.
const ROUTE_DIRS = [
  "apps/api/src/routes",
];

function walkTsFiles(dirAbs: string, out: string[]): void {
  for (const entry of readdirSync(dirAbs)) {
    const abs = join(dirAbs, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkTsFiles(abs, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
}

type Finding = {
  file: string;
  line: number;
  routePath: string;
  reason: string;
};

function findHandlerBody(lines: string[], startIdx: number): string {
  // Walk forward from the route header until we find the opening `{`
  // of the handler body, then track brace depth to find its close.
  let depth = 0;
  let started = false;
  const parts: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    parts.push(line);
    if (started && depth === 0) return parts.join("\n");
  }
  // Ran off the end — return what we have. Regex still runs on partial.
  return parts.join("\n");
}

function hasAnnotationAbove(lines: string[], headerIdx: number): boolean {
  const start = Math.max(0, headerIdx - ANNOTATION_LOOKBACK_LINES);
  for (let i = headerIdx - 1; i >= start; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (ANNOTATION_PATTERN.test(line)) return true;
    // A comment that ISN'T the annotation — keep scanning back. This
    // allows a multi-line comment block ABOVE the annotation.
    if (/^\s*\/\//.test(line) || /^\s*\/\*/.test(line) || /\*\//.test(line)) continue;
    // A non-comment, non-blank line breaks the lookback — the annotation
    // has to be adjacent to the route.
    return false;
  }
  return false;
}

describe("view-as endpoints build gate", () => {
  it("every GET /me/* route is either view-as-aware or annotated with `// view-as-allow: <reason>`", () => {
    const repoRoot = resolve(__dirname, "../../../..");
    const files: string[] = [];
    for (const d of ROUTE_DIRS) {
      walkTsFiles(join(repoRoot, d), files);
    }
    expect(files.length).toBeGreaterThan(0);

    const findings: Finding[] = [];

    for (const absPath of files) {
      const src = readFileSync(absPath, "utf8");
      const lines = src.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(ROUTE_HEADER);
        if (!match) continue;
        const routePath = match[1];

        const body = findHandlerBody(lines, i);
        const isViewAsAware = VIEW_AS_AWARE_PATTERNS.some((p) => p.test(body));
        if (isViewAsAware) continue;

        if (hasAnnotationAbove(lines, i)) continue;

        findings.push({
          file: relative(repoRoot, absPath),
          line: i + 1,
          routePath,
          reason:
            "handler body does not reference `viewAsUserId` / `resolveWorkdayTarget` AND there is no `// view-as-allow: <reason>` annotation immediately above the route.",
        });
      }
    }

    if (findings.length > 0) {
      const summary = findings
        .map(
          (f) =>
            `  • ${f.file}:${f.line}  GET ${f.routePath}\n    ${f.reason}`,
        )
        .join("\n\n");
      const message = [
        `${findings.length} /me GET route(s) fail the view-as endpoints build gate.`,
        "",
        "Either:",
        "  (a) support view-as — accept `?viewAsUserId=<id>` and gate on ADMIN/SUPER role,",
        "      OR",
        "  (b) annotate the route with `// view-as-allow: <reason>` explaining why it is",
        "      intentionally caller-scoped.",
        "",
        "See docs/VIEW_AS_ENDPOINTS.md for patterns and history.",
        "",
        "Offenders:",
        summary,
      ].join("\n");
      throw new Error(message);
    }

    expect(findings).toEqual([]);
  });
});
