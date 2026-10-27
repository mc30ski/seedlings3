// ─────────────────────────────────────────────────────────────────────────────
// Stale-reference build gate
//
// WHY THIS EXISTS
// The operator kept finding, by hand, comments that pointed at things which
// no longer exist: a file header still naming `components/AdminUsers.tsx`
// after the file moved AND was renamed, routes under an `/admin/` prefix
// deleted with the role enum, "Admin/Super" used as a tier in a codebase
// that has no tiers. Each round of manual cleanup missed a class the next
// search found, because a search is only as good as the pattern someone
// thought to type.
//
// A comment that names something deleted is worse than no comment. The
// reader greps for it, finds nothing, and either wastes the trip or — worse
// — believes the thing exists and reasons from it.
//
// So the rule is mechanical now, like every other load-bearing rule here.
//
// WHAT IT CHECKS
//   A. Every file path named in a comment resolves to a real file.
//   B. No comment uses a role word as an AUTHORITY label. Authorization is
//      capabilities; a tier name in prose is the deleted model leaking back.
//   C. No identifier is named for a role.
//
// WHAT IT DOES NOT CHECK
// "worker" as a PERSON ("the worker on the visit"), as a PAY CLASS (W-2
// worker), or as a background process (the Drive sync worker). Those are
// the English word, not the deleted enum. The allow-lists below carry the
// handful of deliberate historical references, each with a reason, and are
// SHRINK-ONLY: deleting an entry is how the work gets done; adding one
// needs a reason in review.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const SCAN_DIRS = [
  "apps/api/src",
  "apps/api/prisma",
  "apps/api/scripts",
  "apps/web/src",
  "apps/web/pages",
  // The e2e suite counts. A dead `_proxy/admin/...` URL lived here for an
  // unknown length of time, silently falling through to a fallback branch
  // so the spec passed while never exercising the path it names.
  "apps/web/tests",
  "packages",
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist", ".turbo"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

/** Comment lines only — a role word inside a string literal or an
 *  identifier is rules B/C's business, not rule A's. */
function commentLines(src: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  src.split("\n").forEach((l, i) => {
    const t = l.trim();
    // `{/*` is the JSX comment form and starts with a brace, so a naive
    // "starts with //" test walks straight past every comment in the tab
    // components — which is most of the UI.
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) {
      out.push([i + 1, l]);
    }
  });
  return out;
}

const rel = (f: string) => path.relative(ROOT, f);

describe("[stale-reference] comments may not name things that do not exist", () => {
  it("sanity: the scan actually reaches the code", () => {
    // Every assertion below is a regex over a file list. An empty list
    // passes everything, which is how a gate goes quietly green.
    expect(FILES.length, "no source files found — SCAN_DIRS is wrong").toBeGreaterThan(300);
    const totalComments = FILES.reduce(
      (n, f) => n + commentLines(readFileSync(f, "utf8")).length, 0,
    );
    expect(totalComments, "no comments found — the comment matcher is broken").toBeGreaterThan(5000);
  });

  // ── A. Dead file paths ────────────────────────────────────────────────
  it("A — every file path named in a comment exists", () => {
    // Deliberate references to things that are GONE, where naming the dead
    // thing IS the point. Each says so in its own text.
    const ALLOW = new Set([
      "scripts/derive-base-bundles.ts",   // explicitly "That script is DELETED"
      "src/services/exports.test.ts",     // explicitly "deleted in c9fe8a4"
      "apps/web/src/lib/refReturnDiagnostic.ts", // explicitly "(git history: …)"
    ]);
    const PATH = /(?<![\w/.])((?:apps|packages|prisma|docs|scripts|src|tests)[\w./@-]*\.(?:tsx|prisma|json|md|css|ts|js))/g;
    const dead: string[] = [];
    for (const f of FILES) {
      for (const [n, line] of commentLines(readFileSync(f, "utf8"))) {
        for (const m of line.matchAll(PATH)) {
          const p = m[1];
          if (ALLOW.has(p)) continue;
          const bases = ["", "apps/api", "apps/web", "apps/api/src", "apps/web/src"];
          const found =
            bases.some((b) => existsSync(path.join(ROOT, b, p))) ||
            existsSync(path.join(path.dirname(f), p));
          if (!found) dead.push(`${rel(f)}:${n} → ${p}`);
        }
      }
    }
    expect(
      dead,
      "These comments name a file that does not exist. A reader greps for " +
        "it and finds nothing, or assumes it is real. Point at the file " +
        "that holds the behaviour now, or delete the reference. If the " +
        "point IS that the thing was deleted, say so in the text and add " +
        "it to ALLOW with that reason.",
    ).toEqual([]);
  });

  // ── B. Role words as authority ────────────────────────────────────────
  it("B — no comment uses a role word as an authority label", () => {
    // Shapes that only make sense in a tiered model. Deliberately NOT
    // matching bare "worker"/"admin", which are ordinary English here.
    const SHAPES: Array<[RegExp, string]> = [
      [/\b(?:Admin|ADMIN|admin)\s*\/\s*(?:Super|SUPER|super)\b/, "Admin/Super as a tier"],
      [/\b(?:Worker|WORKER|worker)\s*\/\s*(?:Admin|ADMIN|admin)\b/, "Worker/admin as a tier"],
      // Hyphenated only — "the sync worker only ever …" is English. `staff`
      // is excluded because it is a LIVE concept: the app has two shells,
      // `client` and `staff`, so "staff-only" names a real thing.
      [/\b(?:super|admin|worker)-only\b/i, "role-only"],
      // `Super` IS a live role name — a CustomRole row and a perspective
      // label — so it is only wrong when it stands in for a CAPABILITY.
      // "only Super can act on this workday" hardcodes a renameable row
      // into an authorization fact; "Acting as Super" is the chip's real
      // text and is fine. Matched only next to an authority verb.
      [/\bSuper(?![a-z])[\s\S]{0,24}?\b(?:can|cannot|must|requires?|needs?|gets?|sees?|approves?|override)\b|\bonly Super\b|\bnon-Super\b|\bSuper-(?:guarded|gated|side|tier|only|voided|skipped)\b/, "Super standing in for a capability"],
      [/\/(?:api\/)?(?:admin|super|worker|staff)\//, "role-prefixed route path"],
      [/\b(?:routes|services)\/(?:admin|super|worker|staff)\.ts\b/, "deleted role-named route file"],
      [/\bblended[-\s]role\b/i, "the deleted shell vocabulary"],
      [/\b(?:Admin|Super|Worker)\s*:\s/, "role used as a section label"],
      // `side` must not swallow "side-by-side".
      [/\b(?:admin|super|worker)\s+(?:path|variant|version|view|tab)s?\b|\b(?:admin|super|worker)\s+side(?!-by-side)\b/i, "role-qualified noun"],
    ];
    // Each of these names a forbidden shape ON PURPOSE — the assertion or
    // the detector regex next to it is what keeps the shape out.
    const ALLOW = [
      "apps/api/src/services/job-materials-build-gate.test.ts",   // asserts /admin/occurrences never returns
      "apps/api/src/services/photo-visibility-build-gate.test.ts",// asserts /super/displays/photos never returns
      "apps/api/src/services/permissions-build-gate.test.ts",     // G24b/G41 detectors + their messages
      "apps/api/src/services/stale-reference-build-gate.test.ts", // this file
    ];
    // A comment may NAME the old model when it is explaining that the model
    // is gone — "this was a shell switcher listing Client/Worker/Admin/Super"
    // is the useful kind of comment, not the rotten kind. Past-tense framing
    // on the same line is the signal. Somebody could game this by writing
    // "was" in a live comment; this is a guardrail against drift, not a
    // security control.
    const HISTORICAL = /\b(was|were|used to|no longer|deleted|replaces?|replacing|formerly|predates|since removed|is gone|are gone|the old)\b/i;
    const bad: string[] = [];
    for (const f of FILES) {
      if (ALLOW.includes(rel(f))) continue;
      const lines = readFileSync(f, "utf8").split("\n");
      for (const [n, line] of commentLines(readFileSync(f, "utf8"))) {
        // Look at the few lines above as well: a block that opens with
        // "WHAT USED TO BE HERE, AND WHY IT IS NOT." frames every line
        // under it, and a per-line test cannot see that.
        const window = lines.slice(Math.max(0, n - 5), n).join(" ");
        if (HISTORICAL.test(window)) continue;
        for (const [rx, why] of SHAPES) {
          if (rx.test(line)) { bad.push(`${rel(f)}:${n} [${why}]\n      ${line.trim().slice(0, 100)}`); break; }
        }
      }
    }
    expect(
      bad,
      "There are no roles — only capabilities. A comment that says " +
        "\"Admin/Super\" or \"super-only\" describes a model this app " +
        "deleted, and sends the reader looking for a tier that is not " +
        "there. Name the capability the code actually checks, taken from " +
        "the route the control calls (docs/features/permissions-ROUTE-MAP.md). " +
        "If the word means a PERSON or a PAY CLASS, reword so it cannot " +
        "read as authority.",
    ).toEqual([]);
  });

  // ── D. Role enum literals ─────────────────────────────────────────────
  it("D — no comment quotes a role enum value, in any tense", () => {
    // RULE B EXEMPTS PAST TENSE. THIS ONE DOES NOT, DELIBERATELY.
    //
    // A comment reading `This used to post { role: "ADMIN" }` is honest
    // prose and still puts ADMIN in the file. Past tense helps somebody
    // already READING that line; it does nothing for somebody SEARCHING,
    // which is how these keep being found. Comments say what the code does
    // now. The record of what was deleted lives in exactly one place:
    // .claude/memory/reference_capabilities_model.md, "THE DELETED SHAPES".
    const LITERAL =
      /"(?:ADMIN|SUPER|WORKER|STAFF)"|'(?:ADMIN|SUPER|WORKER|STAFF)'|RoleVal\.(?:ADMIN|SUPER|WORKER|STAFF)|\b(?:WORKER|ADMIN|SUPER|STAFF)\s*\|\s*(?:WORKER|ADMIN|SUPER|STAFF)\b/;
    // Files whose JOB is to name the old shape so it cannot return. The
    // string IS the guard; deleting it disarms the gate.
    const ALLOW = [
      "apps/api/src/services/permissions-build-gate.test.ts",
      "apps/api/src/services/source-hygiene-build-gate.test.ts",
      "apps/api/src/services/permissions-docs-build-gate.test.ts",
      "apps/api/src/services/stale-reference-build-gate.test.ts",
    ];
    const bad: string[] = [];
    for (const f of FILES) {
      if (ALLOW.includes(rel(f))) continue;
      for (const [n, line] of commentLines(readFileSync(f, "utf8"))) {
        if (LITERAL.test(line)) bad.push(`${rel(f)}:${n}\n      ${line.trim().slice(0, 100)}`);
      }
    }
    expect(
      bad,
      "This comment quotes a value from the deleted `Role` enum. Say what " +
        "the code does NOW and name the capability. If you need the history, " +
        "it is in .claude/memory/reference_capabilities_model.md under THE " +
        "DELETED SHAPES — one place, so a search for ADMIN stops landing in " +
        "forty files that merely remember it.",
    ).toEqual([]);
  });

  // ── D. No comment quotes a WorkerType value that no longer exists ──────
  //
  // Same rule as C, one enum along, and it was missed because C only knows
  // about `Role`. Nine comments still said `workerType === "TRAINEE"` long
  // after that value was dropped — in `isFieldCleared`, four tabs, three
  // routes and the redaction helper. Each was explaining why the code no
  // longer works that way, which is exactly the trap: a reader greps
  // TRAINEE, finds nine hits, and has to read all nine to learn the thing
  // does not exist.
  //
  // THE DEAD NAMES ARE LISTED, THE LIVE ONES ARE DERIVED. The first half
  // has to be written down — nothing in the schema remembers what was
  // deleted. The second half is read from `enum WorkerType` so that if a
  // name on this list is ever reinstated as a real value, the gate stops
  // flagging it instead of quietly lying about the vocabulary.
  it("D. no comment names a removed WorkerType value", () => {
    const schema = readFileSync(path.join(ROOT, "apps/api/prisma/schema.prisma"), "utf8");
    const block = /enum WorkerType \{([^}]*)\}/.exec(schema);
    expect(block, "enum WorkerType not found — this check cannot run").not.toBeNull();
    const live = new Set(
      (block![1].match(/^\s*([A-Z_]+)\s*$/gm) ?? []).map((v) => v.trim()),
    );
    expect(live.size, "the WorkerType enum parsed to nothing").toBeGreaterThan(1);

    // Values this schema once had. Append only when you DELETE one.
    const REMOVED = ["TRAINEE"].filter((v) => !live.has(v));

    // The files whose job is to name the dead value so it cannot return.
    const ALLOW = [
      "apps/api/src/services/stale-reference-build-gate.test.ts",
      "apps/api/src/services/permissions-build-gate.test.ts",
    ];
    if (REMOVED.length === 0) return;
    const pattern = new RegExp(`\\b(?:${REMOVED.join("|")})\\b`);
    const bad: string[] = [];
    for (const f of FILES) {
      if (ALLOW.includes(rel(f))) continue;
      for (const [n, line] of commentLines(readFileSync(f, "utf8"))) {
        if (pattern.test(line)) bad.push(`${rel(f)}:${n}\n      ${line.trim().slice(0, 100)}`);
      }
    }
    expect(
      bad,
      "This comment names a worker type that was REMOVED from the enum. " +
        "Describe the shape instead of the dead value — \"a pay-class " +
        "comparison standing in for a permission\" tells the reader the " +
        "same thing without leaving an identifier that greps to nothing. " +
        "The history lives in .claude/memory/reference_worker_class.md.",
    ).toEqual([]);
  });

  // ── E. Authority shapes in CODE, not just comments ────────────────────
  it("E — no string literal or test name uses a role word as authority", () => {
    // A COMMENT IS NOT THE ONLY PLACE THIS ROTS. A tooltip read
    // "Recorded but not yet approved by admin", a seeded role description
    // said "Lets a non-admin charge …", and a fixture was called
    // "AdminOnly Test Property" in the very spec that exists to prove the
    // flag has nothing to do with admins. Operators read the first two.
    //
    // Narrow on purpose: only the shapes that can ONLY mean authority.
    // `workerType`, "a worker sees only their own row" and `seedlings.admin`
    // are the English word or real data, and are left alone.
    const SHAPES: Array<[RegExp, string]> = [
      [/\b(?:Admin|ADMIN|admin)\s*\/\s*(?:Super|SUPER|super)\b/, "Admin/Super as a tier"],
      [/\b(?:super|admin|worker)-only\b/i, "role-only"],
      // `Super` IS a live role name — a CustomRole row and a perspective
      // label — so it is only wrong when it stands in for a CAPABILITY.
      // "only Super can act on this workday" hardcodes a renameable row
      // into an authorization fact; "Acting as Super" is the chip's real
      // text and is fine. Matched only next to an authority verb.
      [/\bSuper(?![a-z])[\s\S]{0,24}?\b(?:can|cannot|must|requires?|needs?|gets?|sees?|approves?|override)\b|\bonly Super\b|\bnon-Super\b|\bSuper-(?:guarded|gated|side|tier|only|voided|skipped)\b/, "Super standing in for a capability"],
      [/\b(?:super|admin|worker)-gated\b/i, "role-gated"],
      [/\bnon-(?:admin|super|worker)\b/i, "role-negation"],
      [/\b(?:approved|authorized|allowed|permitted) by (?:an? )?(?:admin|super)\b/i, "role as the authority"],
    ];
    const ALLOW = [
      "apps/api/src/services/job-materials-build-gate.test.ts",
      "apps/api/src/services/photo-visibility-build-gate.test.ts",
      "apps/api/src/services/permissions-build-gate.test.ts",
      "apps/api/src/services/stale-reference-build-gate.test.ts",
    ];
    const bad: string[] = [];
    for (const f of FILES) {
      if (ALLOW.includes(rel(f))) continue;
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        // comments are rule B's job
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) return;
        for (const [rx, why] of SHAPES) {
          if (rx.test(line)) { bad.push(`${rel(f)}:${i + 1} [${why}]\n      ${t.slice(0, 100)}`); break; }
        }
      });
    }
    expect(
      bad,
      "A role word is doing authority work in CODE — a label, a tooltip, a " +
        "seeded description or a test name. Copy that names a role teaches " +
        "the operator a model the app does not have. Name the capability, " +
        "or describe the person.",
    ).toEqual([]);
  });

  // ── C. Role-named identifiers ─────────────────────────────────────────
  it("C — no identifier is named for a role", () => {
    // `isWorkerView` was TWO different variables in two files meaning
    // OPPOSITE things — `!canManageSchedule` in one, `canViewEquipment` in
    // the other — and the name hid a condition that was always true.
    // The role word must be followed by an uppercase letter or the end of
    // the identifier. Without that, `hasWorkers` (people on a visit) and
    // `isSuperseded` (a policy version) both match, and the gate cries wolf
    // on correct names until somebody turns it off.
    const IDENT = /\b(?:const|let|var|function)\s+((?:is|can|has|show|use|should)(?:Worker|Admin|Super|Staff)(?![a-z])[A-Za-z0-9]*)\s*[=(:]/g;
    const bad: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, "utf8");
      src.split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*")) return;
        for (const m of line.matchAll(IDENT)) {
          // `WorkerType` is the PAY CLASS enum, not a role — any identifier
          // built on it is about how somebody is paid.
          if (/WorkerType/.test(m[1])) continue;
          bad.push(`${rel(f)}:${i + 1} → ${m[1]}`);
        }
      });
    }
    expect(
      bad,
      "A boolean named for a role is the deleted model rebuilt. Name it " +
        "for the capability it asks for — or, when an existing variable " +
        "already holds that answer, use it instead of aliasing it under a " +
        "role name.",
    ).toEqual([]);
  });
});
