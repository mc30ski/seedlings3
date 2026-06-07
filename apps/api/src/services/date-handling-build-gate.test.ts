// ─────────────────────────────────────────────────────────────────────────────
// Date-handling build gate
//
// PURPOSE
// This test scans the entire codebase for date-handling patterns that have
// caused production bugs and fails the build if any are reintroduced. It runs
// on EVERY API build (wired via `test:build-gate` script + `turbo.json`
// build.dependsOn test). A failing assertion here means new code has
// reintroduced a forbidden pattern — the diff shouldn't merge until the
// callsite is migrated to the canonical helpers.
//
// CANONICAL HELPERS (the only legitimate path for date code):
//   • API side:  apps/api/src/lib/dates.ts
//   • Web side:  apps/web/src/lib/lib.ts
//   • Reference: docs/DATE_HANDLING.md
//
// HOW IT WORKS
// We walk every .ts/.tsx file under apps/api/src, apps/web/src, and
// apps/web/pages. For each, we check the file's lines against an array of
// (pattern, reason) rules. Allow-lists exempt the canonical helper files,
// test files, the prisma seed (which is excluded from the rule set the same
// way prod code is — it's not user-facing, but we still nudge it), and any
// file with a documented `eslint-disable date-handling` comment immediately
// above the line.
//
// WHY HERE INSTEAD OF ESLINT
// The repo has no ESLint config today and we want zero new tool dependencies
// on the path to prod. The existing build-gate test runs in ~300 ms; adding
// this scan adds another ~100 ms, well under the cost of an ESLint rollout.
// If/when ESLint is added, this should be ported to `no-restricted-syntax`.
//
// EXTENDING
// When a new date-handling bug pattern is identified:
//   1. Fix the existing site(s) to use the canonical helper.
//   2. Add a new rule to FORBIDDEN_PATTERNS below.
//   3. Document the rule in docs/DATE_HANDLING.md.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve, sep } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");

// Directories to scan. We deliberately don't scan `node_modules`, `dist`,
// `.next`, `.turbo`, etc.
const SCAN_DIRS = [
  "apps/api/src",
  "apps/api/prisma",  // seed.ts uses date helpers too
  "apps/web/src",
  "apps/web/pages",
] as const;

// Files where forbidden patterns are LEGITIMATE — primarily the canonical
// helper files themselves (which implement the patterns the helpers expose)
// and test files (which assert against the patterns).
const HELPER_FILES = new Set<string>([
  "apps/api/src/lib/dates.ts",
  "apps/web/src/lib/lib.ts",
]);

function shouldSkipFile(repoRelPath: string): boolean {
  // Always allow the canonical helper files.
  if (HELPER_FILES.has(repoRelPath)) return true;
  // Test files freely use the patterns to assert against them.
  if (repoRelPath.endsWith(".test.ts") || repoRelPath.endsWith(".test.tsx")) return true;
  // Type definition files (no runtime).
  if (repoRelPath.endsWith(".d.ts")) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Forbidden patterns. Each rule is (regex, reason, optional file-level allow-list).
//
// The file-level allow-list is for documented legitimate exceptions (e.g.
// recurrence schedulers that preserve instants rather than wall-clock time —
// see docs/DATE_HANDLING.md "Legitimate exceptions" section). When you add
// a file to an allow-list, also leave a code comment at the site explaining
// WHY this exception is legitimate.
// ─────────────────────────────────────────────────────────────────────────────

type Rule = {
  pattern: RegExp;
  reason: string;
  fix: string;
  /** Files where this specific pattern is documented-legitimate. */
  allowFiles?: string[];
};

const FORBIDDEN_PATTERNS: Rule[] = [
  // 1. UTC YYYY-MM-DD slicing — the OG date bug in this codebase.
  {
    pattern: /\.toISOString\(\)\.slice\s*\(\s*0\s*,\s*10\s*\)/,
    reason: ".toISOString().slice(0, 10) emits UTC YYYY-MM-DD which is the wrong calendar day near midnight ET.",
    fix: "Use etFormatDate(d) on the API or bizDateKey(d) on the web side.",
  },
  // 2. toLocaleDateString without timeZone — uses the browser/server locale.
  {
    pattern: /\.toLocaleDateString\s*\(\s*undefined/,
    reason: ".toLocaleDateString(undefined, ...) uses the browser/server locale, not ET.",
    fix: "Use fmtDate / fmtDateWeekday / fmtDateOpts on the web side, or etFormatDateOpts on the API.",
  },
  {
    pattern: /\.toLocaleDateString\s*\(\s*\[\s*\]/,
    reason: ".toLocaleDateString([], ...) uses the browser/server locale, not ET.",
    fix: "Use fmtDate / fmtDateWeekday / fmtDateOpts on the web side, or etFormatDateOpts on the API.",
  },
  // 3. toLocaleString / toLocaleTimeString without explicit timeZone — same.
  //    These are easy to spot when used on Date instances; harder on numbers.
  //    We grep for the no-args / [] / undefined forms only.
  {
    pattern: /\.toLocaleTimeString\s*\(\s*(?:undefined|\[\s*\])/,
    reason: ".toLocaleTimeString without an explicit timeZone uses browser/server locale.",
    fix: "Use fmtTimeOpts on the web side, or etFormatTimeOpts on the API.",
  },
  // 4. Inline Intl.DateTimeFormat — must live in the canonical helper files.
  {
    pattern: /new\s+Intl\.DateTimeFormat\b/,
    reason: "Inline `new Intl.DateTimeFormat(...)` should live in the canonical helper files only.",
    fix: "If you need a new shape, add a helper to apps/api/src/lib/dates.ts or apps/web/src/lib/lib.ts and call it.",
    // ledgerId.ts builds a custom YY-MM-DD ID format; the implementation
    // is now routed through etFormatDate but the file may still reference
    // Intl elsewhere as comment / dead code. Allow it explicitly.
    allowFiles: [],
  },
  // 5. Browser/server-local Date constructor.
  {
    pattern: /new\s+Date\s*\(\s*\d{4}\s*,\s*\d+/,
    reason: "`new Date(YYYY, MM, DD)` creates a Date at server-local midnight (UTC on Vercel), wrong intent for ET data.",
    fix: "Use etMidnight('YYYY-MM-DD') on the API side.",
    // RRuleEditor uses `new Date(2000, m-1, 1).toLocaleString(..., { month: 'long' })`
    // to extract a month name. Month names don't drift across timezones, so it's
    // a benign smell that doesn't justify a helper. Documented allow.
    allowFiles: ["apps/web/src/ui/components/RRuleEditor.tsx"],
  },
  // 6. setHours(0,0,0,0) — browser-local midnight.
  {
    pattern: /\.setHours\s*\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/,
    reason: ".setHours(0,0,0,0) sets local midnight (UTC on Vercel), wrong for ET-anchored data.",
    fix: "Use etMidnight(etToday()) on the API.",
    allowFiles: [
      "apps/api/prisma/seed.ts", // test data — exact time-of-day doesn't matter
    ],
  },
  // 7. setUTCHours(0,...) — UTC midnight.
  {
    pattern: /\.setUTCHours\s*\(\s*0/,
    reason: ".setUTCHours(0,...) sets UTC midnight which lands in the middle of the ET workday.",
    fix: "Use etMidnight(etToday()) on the API.",
  },
  // 8. setDate(getDate() + N) — local-time mutation.
  {
    pattern: /\.setDate\s*\(\s*[A-Za-z_$][\w$]*\.getDate\s*\(\s*\)/,
    reason: ".setDate(d.getDate() + N) mutates in server-local time, breaking on DST.",
    fix: "Use etAddDays(str, N) on the API or bizAddDays(str, N) on the web.",
    // Recurrence schedulers — documented exception. These preserve the
    // instant across DST rather than wall-clock; ≤1-hour drift is invisible
    // for day-anchored jobs. See docs/DATE_HANDLING.md "Legitimate exceptions".
    allowFiles: [
      "apps/api/src/routes/admin.ts",
      "apps/api/src/services/jobs.ts",
      "apps/api/src/services/payments.ts",
      "apps/api/prisma/seed.ts", // test data — server-local timing is fine
    ],
  },
  // 9. setMonth / setFullYear mutations — same.
  {
    pattern: /\.setMonth\s*\(\s*[A-Za-z_$][\w$]*\.getMonth\s*\(\s*\)/,
    reason: ".setMonth(d.getMonth() + N) mutates in server-local time, breaking on month overflow + DST.",
    fix: "Use bizAddMonths(str, N) on the web; on the API recurrence is the only documented case.",
    allowFiles: [
      "apps/api/src/routes/admin.ts",
      "apps/api/src/services/jobs.ts",
      "apps/api/src/services/payments.ts",
    ],
  },
  {
    pattern: /\.setFullYear\s*\(\s*[A-Za-z_$][\w$]*\.getFullYear\s*\(\s*\)/,
    reason: ".setFullYear(d.getFullYear() + N) mutates in server-local time.",
    fix: "Use bizAddYears(str, N) on the web or refactor for API.",
    allowFiles: [
      "apps/api/src/routes/admin.ts",
      "apps/api/src/services/jobs.ts",
    ],
  },
  // 10. Raw day-in-ms constants. Calendar-day arithmetic must NOT use these
  //     (DST-fragile). Elapsed-time-in-days can but should be commented.
  {
    pattern: /\b86[_]?400[_]?000\b/,
    reason: "86_400_000 (day in ms) is DST-fragile for calendar-day arithmetic.",
    fix: "Use bizDaysBetween / bizAddDays / etAddDays on YYYY-MM-DD keys. For elapsed-time durations (NOT calendar days), wrap with `// date-handling-allow: elapsed-time` on the line above.",
    // Files with elapsed-time math that is genuinely instant-to-instant,
    // documented with a comment at the callsite. Re-evaluate each as new
    // sites appear.
    allowFiles: [
      "apps/api/src/services/equipment.ts", // listEtDaysBetween: iterates UTC-noon steps
      "apps/web/src/ui/tabs/EquipmentUsageTab.tsx", // daysOut: rental duration billing
      "apps/web/src/ui/components/UnlinkedClientAccountsSection.tsx", // "X days ago" cosmetic label
    ],
  },
  // 10b. Spelled-out millisecond chains that evaluate to 86_400_000.
  //      `1000 * 60 * 60 * 24`, `24 * 60 * 60 * 1000`, `24 * 3600000`,
  //      etc. — all bypass the literal regex above.
  {
    pattern: /\b(?:1000\s*\*\s*60\s*\*\s*60\s*\*\s*24|24\s*\*\s*60\s*\*\s*60\s*\*\s*1000|24\s*\*\s*3600000|60\s*\*\s*60\s*\*\s*24\s*\*\s*1000)\b/,
    reason: "Spelled-out millisecond chain (= 86_400_000) bypasses the day-in-ms rule. DST-fragile for calendar-day arithmetic.",
    fix: "Use bizDaysBetween / bizAddDays / etAddDays on YYYY-MM-DD keys, or annotate with `// date-handling-allow: elapsed-time`.",
  },
  // 11. `new Date("YYYY-MM-DDTHH:mm:ss")` without `Z` — browser-local parse.
  //     Forbidden for ET-anchored submission paths. The bizParseLocalInputValue
  //     helper handles the legitimate `<input type="datetime-local">` case.
  {
    pattern: /new\s+Date\s*\(\s*[^)]*T\d{2}:\d{2}:\d{2}["'`]\s*\)/,
    reason: "new Date('YYYY-MM-DDTHH:mm:ss') (no Z) parses in browser-local time, wrong for ET-anchored input.",
    fix: "Use bizParseLocalInputValue(value) for datetime-local inputs, or anchor with `T...Z` for UTC.",
  },
  // 12. UTC-day slicing variants. The original `.toISOString().slice(0, 10)`
  //     is caught above; these are equivalent bypasses.
  {
    pattern: /\.toISOString\(\)\.substring\s*\(\s*0\s*,\s*10\s*\)/,
    reason: ".toISOString().substring(0, 10) is an equivalent UTC-day slice; same bug as .slice(0, 10).",
    fix: "Use etFormatDate(d) on the API or bizDateKey(d) on the web side.",
  },
  {
    pattern: /\.toISOString\(\)\.substr\s*\(\s*0\s*,\s*10\s*\)/,
    reason: ".toISOString().substr(0, 10) is an equivalent UTC-day slice; same bug.",
    fix: "Use etFormatDate(d) on the API or bizDateKey(d) on the web side.",
  },
  {
    pattern: /\.toISOString\(\)\.split\s*\(\s*["'`]T["'`]\s*\)\s*\[\s*0\s*\]/,
    reason: ".toISOString().split('T')[0] is an equivalent UTC-day slice; same bug.",
    fix: "Use etFormatDate(d) on the API or bizDateKey(d) on the web side.",
  },
  {
    pattern: /\.toJSON\(\)\.slice\s*\(\s*0\s*,\s*10\s*\)/,
    reason: ".toJSON().slice(0, 10) on a Date emits UTC YYYY-MM-DD (same as .toISOString()).",
    fix: "Use etFormatDate(d) on the API or bizDateKey(d) on the web side.",
  },
  // 13. Browser/server-local stringifiers on Date.
  {
    pattern: /\.toDateString\s*\(\s*\)/,
    reason: ".toDateString() formats in browser/server-local time, wrong for ET-anchored data.",
    fix: "Use fmtDate / fmtDateWeekday on the web side, or etFormatDate on the API.",
  },
  {
    pattern: /\.toTimeString\s*\(\s*\)/,
    reason: ".toTimeString() formats in browser/server-local time.",
    fix: "Use fmtTimeOpts on the web side, or etFormatTimeOpts on the API.",
  },
  // 14. toLocaleDateString / toLocaleString with a locale string but NO
  //     timeZone — uses the runtime's timezone, not ET. Catches
  //     `.toLocaleDateString("en-US", { weekday: "long" })` etc.
  //     The full-helper variants always set `timeZone: BIZ_TZ`, so this
  //     pattern shouldn't appear outside the helper files.
  {
    pattern: /\.toLocaleDateString\s*\(\s*["'][a-z-]+["']\s*\)/,
    reason: ".toLocaleDateString('en-US') with no options uses the runtime timezone, not ET.",
    fix: "Use fmtDate(d) on the web side (forces timeZone: 'America/New_York').",
  },
  // 15. getTimezoneOffset() — browser/server offset, always smells.
  {
    pattern: /\.getTimezoneOffset\s*\(\s*\)/,
    reason: ".getTimezoneOffset() returns the runtime's offset (the browser's local tz or the server's UTC), almost never the right ET offset.",
    fix: "If you actually need the ET offset, use the EDT/EST detection in lib/dates.ts (search for `tzName === 'EDT'`).",
  },
  // 16. Hardcoded timezone-offset multiplications.
  {
    pattern: /[-+]?\s*[45]\s*\*\s*3600000\b/,
    reason: "Hardcoded `4 * 3600000` / `5 * 3600000` is a baked-in ET offset that breaks across DST.",
    fix: "Use etMidnight / etAddDays / etFormatDate which detect DST automatically.",
  },
  // 17. `useMemo` with empty deps caching any time-dependent function —
  //     stale past midnight rollover. The original rule caught only
  //     direct `bizToday()`/`bizTomorrow()`/`bizYesterday()` calls; this
  //     extended version also catches wrappers like
  //     `bizAddYears(bizToday(), -1)`, `computeDatesFromPreset("lastMonth")`,
  //     `new Date()`, and `Date.now()`. The regex uses lazy matching so
  //     it works even when the function arguments contain commas.
  {
    pattern: /useMemo\s*\([^)]*\)\s*=>\s*[\s\S]*?\b(bizToday|bizTomorrow|bizYesterday|bizHour|bizMonth|computeDatesFromPreset|new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\))\b[\s\S]*?,\s*\[\s*\]\s*\)/,
    reason: "useMemo with empty deps caching a time-dependent function (bizToday/bizTomorrow/bizYesterday/bizHour/bizMonth/computeDatesFromPreset/new Date()/Date.now()) becomes stale past midnight ET.",
    fix: "Compute inline (these are ~µs operations), or key the memo on something that changes per request (e.g. a refetch counter or data refetch tick).",
  },
  // 18. Template-literal YYYY-MM-DDTHH:MM string construction from
  //     individual browser-local getters. Bypasses the chained
  //     `setDate(getDate()+n)` rule because it doesn't use setters —
  //     it just composes a string from getFullYear/getMonth/getDate/etc.
  //     This is the EXACT pattern that the bizToLocalInputValue helper
  //     is meant to replace.
  {
    pattern: /\$\{[^}]*\.getFullYear\(\)[^}]*\}/,
    reason: "Template literal with `.getFullYear()` (and likely friends) is the browser-local datetime-local pattern; round-trip produces wrong instants for non-ET operators.",
    fix: "Use bizToLocalInputValue(d) for the input value and bizParseLocalInputValue(v) for the submission parse.",
  },
  // 19. Module-level (top-level `const`) capturing a time-dependent
  //     function. Captured at module load and never refreshed. The
  //     module loads once per process so the value lives for the entire
  //     server uptime — a long-running dev server / serverless instance
  //     would surface the wrong day after the first midnight ET.
  //
  //     Allowed for known FIXED constants (e.g. business-start cutoff
  //     dates that are intentionally static) — annotate with
  //     `// date-handling-allow: fixed-constant`.
  {
    pattern: /^const\s+\w+\s*=\s*(bizToday|bizTomorrow|bizYesterday|bizHour|bizMonth|computeDatesFromPreset|etToday|etTomorrow|etNow)\s*\(/,
    reason: "Module-level const capturing a time-dependent helper goes stale the moment the process crosses midnight ET. Long-running serverless instances will surface yesterday's date.",
    fix: "Move the call inside a function (so it's evaluated on each invocation), or document with `// date-handling-allow: fixed-constant` if intentionally static.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-line allow-comment.
//
// A line like:
//
//   // date-handling-allow: <reason>
//   someCode(...);
//
// or trailing:
//
//   someCode(...); // date-handling-allow: <reason>
//
// suppresses the rule for that one line. Use sparingly — every allow is a
// documented exception, not a workaround.
// ─────────────────────────────────────────────────────────────────────────────

/** A line is allowed if the marker appears on the line itself OR
 *  anywhere in the immediately-preceding contiguous comment block. We
 *  walk backward while the line is still a comment (`//` or `*`) and
 *  stop at the first non-comment line. This lets the developer place
 *  the marker anywhere inside a multi-line rationale block right above
 *  the suppressed code. */
function lineIsAllowed(prevLines: string[], line: string): boolean {
  const marker = "date-handling-allow:";
  if (line.includes(marker)) return true;
  for (let i = prevLines.length - 1; i >= 0; i--) {
    const candidate = prevLines[i].trimStart();
    if (!candidate.startsWith("//") && !candidate.startsWith("*")) break;
    if (prevLines[i].includes(marker)) return true;
  }
  return false;
}

function walkFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === ".turbo") {
      continue;
    }
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(full, out);
    } else if (stat.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
      out.push(full);
    }
  }
}

function scanFile(filePath: string, repoRelPath: string): Array<{ line: number; rule: Rule; snippet: string }> {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Array<{ line: number; rule: Rule; snippet: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Pass up to the previous 5 lines so the allow-marker can sit at
    // the top of a multi-line comment block right above the suppressed
    // code (typical for rationale comments).
    const prevLines = lines.slice(Math.max(0, i - 5), i);
    if (lineIsAllowed(prevLines, line)) continue;
    // Skip pure comments (// or * leading) — patterns there are documentation,
    // not behavior. We still scan trailing inline comments by checking the
    // whole line for the pattern.
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.allowFiles?.includes(repoRelPath)) continue;
      if (rule.pattern.test(line)) {
        violations.push({ line: i + 1, rule, snippet: line.trim() });
      }
    }
  }
  return violations;
}

describe("Date-handling build gate — forbidden patterns must not appear in production code", () => {
  it("no forbidden date patterns in apps/api/src + apps/web/src + apps/web/pages", () => {
    const allFiles: string[] = [];
    for (const dir of SCAN_DIRS) {
      walkFiles(join(REPO_ROOT, dir), allFiles);
    }
    expect(allFiles.length).toBeGreaterThan(50); // sanity: we actually scanned things

    const allViolations: Array<{ file: string; line: number; rule: Rule; snippet: string }> = [];
    for (const fullPath of allFiles) {
      const repoRel = relative(REPO_ROOT, fullPath).split(sep).join("/");
      if (shouldSkipFile(repoRel)) continue;
      const fileViolations = scanFile(fullPath, repoRel);
      for (const v of fileViolations) {
        allViolations.push({ file: repoRel, ...v });
      }
    }

    if (allViolations.length > 0) {
      const report = allViolations
        .map(
          (v) =>
            `\n  ${v.file}:${v.line}\n    ${v.snippet}\n    ❌ ${v.rule.reason}\n    ✅ ${v.rule.fix}`,
        )
        .join("\n");
      throw new Error(
        `Found ${allViolations.length} forbidden date pattern(s). Each must be migrated to the canonical helpers (apps/api/src/lib/dates.ts or apps/web/src/lib/lib.ts) or — if a documented exception — annotated with \`// date-handling-allow: <reason>\` on the line above.\n${report}\n\nSee docs/DATE_HANDLING.md for the full policy.`,
      );
    }
  });
});
