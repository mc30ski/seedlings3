import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * NOTHING THAT IS NOT SOURCE MAY SIT IN A SOURCE DIRECTORY.
 *
 * WHAT THIS EXISTS FOR
 * A conversion script once wrote its output beside the originals as
 * `preview.ts.converted` and `forecast.ts.converted`. They were diffed, the
 * real edits were applied, and the scratch copies were forgotten — for two
 * days, holding `requireRole(req, reply, RoleVal.SUPER)` after the `Role`
 * enum had been deleted from the codebase.
 *
 * Every safety net missed them, and each for the same reason:
 *
 *   - `tsc` compiles `.ts`. `.ts.converted` is not `.ts`, so the type
 *     checker never opened the file.
 *   - The permissions gates walk `/\.ts$/`. G37 bans `requireRole`; it could
 *     not see the two files still containing it.
 *   - Searches, however, DO find them. A sweep for hardcoded role names
 *     returned `forecast.ts.converted:35` as a hit, which is the worst of
 *     both worlds: invisible to the tools that would reject it, visible to
 *     the human trying to establish that the old model is gone.
 *
 * A stale file that looks like source and describes a deleted model is the
 * same hazard as a misleading name, which is most of what this codebase's
 * gates are about. So the rule is an ALLOW-LIST of extensions, not a
 * deny-list of the scratch suffixes seen so far: the next one will be
 * `.ts.new` or `.tsx.orig` or something nobody has thought of, and a
 * deny-list only ever catches the last mistake.
 *
 * Paired with the NUL-byte scan in `lib/scrubNulBytes.wiring.test.ts`, which
 * covers the other way a source file hides from tooling.
 */

const REPO = path.resolve(__dirname, "../../../..");

/** Directories whose contents are source and must stay source. */
const SOURCE_DIRS = [
  "apps/api/src",
  "apps/api/prisma",
  "apps/api/scripts",
  "apps/web/src",
  "apps/web/pages",
  "packages",
];

/**
 * Extensions that legitimately appear in those trees. Add one only when the
 * file is genuinely part of the build or the fixtures — never to silence a
 * leftover.
 */
const ALLOWED = new Set([
  ".ts", ".tsx", ".mjs",      // code
  ".sql", ".prisma",          // migrations + schema
  ".json", ".toml", ".css",   // config + styles
  ".csv",                     // test fixtures
  ".png", ".webm",            // seeded media
]);

/** Files git already ignores are not the repository's problem (.DS_Store). */
function gitIgnored(): Set<string> {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", ...SOURCE_DIRS],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (statSync(p).isFile()) out.push(p);
  }
  return out;
}

const files = () => {
  const ignored = gitIgnored();
  return SOURCE_DIRS.flatMap((d) => walk(path.join(REPO, d)))
    .map((f) => path.relative(REPO, f))
    .filter((rel) => {
      if (ignored.has(rel)) return false;
      // `git ls-files --directory` can report a whole ignored folder.
      for (const ig of ignored) if (ig.endsWith("/") && rel.startsWith(ig)) return false;
      return true;
    });
};

describe("[build-gate] source directories contain only source", () => {
  it("scans a meaningful number of files", () => {
    // A scan that silently stops finding files is a gate that passes
    // vacuously, which is worse than no gate at all.
    expect(files().length).toBeGreaterThan(300);
  });

  it("every file carries a known source extension", () => {
    const offenders = files()
      .filter((rel) => !ALLOWED.has(path.extname(rel)))
      .sort();
    expect(
      offenders,
      "These sit in a source tree but are not source. `tsc` and every " +
        "`/\\.ts$/` gate skip them, while greps still find them — so stale " +
        "code hides here and reads as real. Delete it, or if it genuinely " +
        "belongs, add its extension to ALLOWED with a reason.",
    ).toEqual([]);
  });

  it("no file hides a source extension in the middle of its name", () => {
    /**
     * The sharper half of the rule. `forecast.ts.converted` is caught above
     * because `.converted` is unknown — but `forecast.ts.json` would pass an
     * extension check while still being a stale copy of a TypeScript file
     * that nothing compiles. A real source extension followed by anything
     * else is always a leftover.
     */
    const offenders = files()
      .filter((rel) => /\.(ts|tsx|mjs|prisma)\.[A-Za-z0-9]+$/.test(path.basename(rel)))
      .sort();
    expect(
      offenders,
      "A real source extension with something appended is a scratch copy — " +
        "`foo.ts.converted`, `foo.tsx.bak`. Nothing compiles it and nothing " +
        "type-checks it, but it still answers searches. Delete it.",
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("[build-gate] no \\uXXXX escape sits in JSX text", () => {
  /**
   * A `\uXXXX` escape is processed by a JavaScript STRING. JSX text is not
   * a string — it is markup text, and the escape is seven literal
   * characters that React renders verbatim.
   *
   * `ClientsTab.tsx` carried `\u2b50` as the VIP marker and drew the
   * characters "\u2b50" beside every VIP client's name. The five other VIP
   * markers in the app use the character itself, so the bug was invisible
   * by comparison with any other screen.
   *
   * NOTHING ELSE CATCHES THIS. `tsc` is happy — it is valid JSX text. No
   * lint rule here looks for it. It renders without an error and without a
   * warning. The only detector in the codebase before this was a person
   * reading the screen and asking what the weird characters were.
   *
   * The rule is narrow on purpose: only escapes in TEXT position, never in
   * a string literal. `info={"… \u2014 …"}` is correct and common —
   * ForecastTab alone has a dozen — and flagging those would make the gate
   * noise that gets suppressed.
   */
  // The second alternative used to require the escape to be ALONE on its
  // line (`\s*$`). That is how the VIP star was written, so the gate caught
  // it — and it is why the gate then sat green over `\u26a0
  // {internalTagLabel(tag)}` forty lines below in the same file, which
  // drew "\u26a0" on every internal-tag badge. An escape that opens a line
  // is in text position whether or not something follows it.
  const JSX_TEXT_ESCAPE = /^[^"'`\/*]*>\s*\\u[0-9a-fA-F]{4}|^\s*\\u[0-9a-fA-F]{4}(?:\s|$)/;

  it("catches one when shown one", () => {
    // The gate reads its own detector back, so a regex that silently stops
    // matching cannot pass by finding nothing.
    expect(JSX_TEXT_ESCAPE.test("                      \\u2b50")).toBe(true);
    expect(JSX_TEXT_ESCAPE.test("      <Text>\\u2b50</Text>")).toBe(true);
    // The shape the first version missed: opens the line, then more JSX.
    expect(JSX_TEXT_ESCAPE.test("      \\u26a0 {internalTagLabel(tag)}")).toBe(true);
    // …and leaves string literals alone.
    expect(JSX_TEXT_ESCAPE.test('    info={"a \\u2014 b"}')).toBe(false);
    expect(JSX_TEXT_ESCAPE.test('    const s = "\\u2b50";')).toBe(false);
  });

  it("no .tsx file renders an escape as text", () => {
    const offenders: string[] = [];
    for (const f of files()) {
      if (!f.endsWith(".tsx")) continue;
      // `files()` yields REPO-RELATIVE paths; this test is the first to
      // open their contents rather than just read their names.
      const lines = readFileSync(path.join(REPO, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (JSX_TEXT_ESCAPE.test(line)) {
          offenders.push(`${f}:${i + 1}  ${t.slice(0, 70)}`);
        }
      });
    }
    expect(
      offenders,
      "A `\\uXXXX` escape in JSX TEXT renders as those literal characters — " +
        "JSX text is not a JavaScript string. Paste the character itself, " +
        "or wrap it in braces as a string: {\"\\u2b50\"}.",
    ).toEqual([]);
  });
});

describe("[build-gate] a raw INSERT supplies an id Prisma would have generated", () => {
  /**
   * `@default(cuid())` IS NOT A DATABASE DEFAULT. Prisma generates the value
   * in the CLIENT and sends it with the INSERT; the column itself is plain
   * `NOT NULL` with nothing behind it. So an INSERT written in raw SQL that
   * omits `id` inserts NULL and dies on the not-null constraint.
   *
   * WHAT THIS EXISTS FOR
   * `20261027090000_starter_roles_to_current_policy` creates the
   * `STAFF_DEFAULT_ROLE_ID` setting if it is absent. It omitted `id`, and it
   * took down a production deploy twenty migrations into a twenty-two
   * migration chain:
   *
   *     ERROR: null value in column "id" of relation "Setting"
   *            violates not-null constraint
   *
   * NOTHING ELSE CATCHES THIS, and the reason is the whole point of the
   * gate. The statement is `INSERT … WHERE NOT EXISTS (…)`, so on any
   * database that already HAS the row it inserts nothing and cannot fail.
   * Dev had the row. Every rehearsal — the no-op run, the drifted-database
   * repair — took the path that skips the insert, and all of them passed.
   * The failing path existed only on the one database nobody could rehearse
   * against. A test of the SQL is no substitute for reading the columns.
   *
   * The sixteen other inserts in that same file all had it right
   * (`gen_random_uuid()::text`), which is what made the one exception easy
   * to miss: it was the hand-written tail after a generated loop.
   */
  // Models whose id Prisma fills in client-side. `@default(dbgenerated(…))`
  // and `@default(autoincrement())` are the database's job and are exempt.
  function clientGeneratedIdModels(): Set<string> {
    const schema = readFileSync(path.join(REPO, "apps/api/prisma/schema.prisma"), "utf8");
    const out = new Set<string>();
    for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const [, name, body] = m;
      const idLine = body.split("\n").find((l) => /\bid\s+\w+.*@id\b/.test(l));
      if (idLine && /@default\((?:cuid|uuid)\(\)\)/.test(idLine)) out.add(name);
    }
    return out;
  }

  /** Every `INSERT INTO "Table" (cols)` in a SQL file, with its columns. */
  function inserts(sql: string): { table: string; cols: string[] }[] {
    return [...sql.matchAll(/INSERT\s+INTO\s+"(\w+)"\s*\(([^)]*)\)/gi)].map((m) => ({
      table: m[1],
      cols: m[2].split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase()),
    }));
  }

  it("catches one when shown one", () => {
    // The gate reads its own detector back, so a regex that quietly stops
    // matching cannot pass by finding nothing.
    const models = clientGeneratedIdModels();
    expect(models.has("Setting")).toBe(true);
    expect(models.has("CustomRole")).toBe(true);

    // The statement exactly as it shipped.
    const bad = inserts(
      `INSERT INTO "Setting" (key, value, description, section, "updatedAt")\nSELECT 'X',`,
    );
    expect(bad).toHaveLength(1);
    expect(bad[0].cols.includes("id")).toBe(false);

    // …and the corrected one.
    const good = inserts(
      `INSERT INTO "Setting" (id, key, value, description, section, "updatedAt")\nSELECT gen_random_uuid()::text,`,
    );
    expect(good[0].cols.includes("id")).toBe(true);
  });

  it("no migration inserts a row without the id the column has no default for", () => {
    const models = clientGeneratedIdModels();
    const root = path.join(REPO, "apps/api/prisma/migrations");
    const offenders: string[] = [];
    let scanned = 0;

    for (const dir of readdirSync(root)) {
      const file = path.join(root, dir, "migration.sql");
      if (!existsSync(file)) continue;
      scanned++;
      for (const { table, cols } of inserts(readFileSync(file, "utf8"))) {
        if (!models.has(table)) continue;
        if (!cols.includes("id")) {
          offenders.push(`${dir}: INSERT INTO "${table}" omits id`);
        }
      }
    }

    // A migrations directory that reads as empty would pass the check above
    // by finding nothing, which is the failure mode this gate was written
    // to stop happening in the first place.
    expect(scanned, "no migration.sql files were read").toBeGreaterThan(200);
    expect(
      offenders,
      'A raw INSERT must supply `id` for a model whose Prisma id is `@default(cuid())` ' +
        "or `@default(uuid())` — those are generated client-side, so the column has NO " +
        "database default and the insert fails on NOT NULL. Use `gen_random_uuid()::text`.",
    ).toEqual([]);
  });
});
