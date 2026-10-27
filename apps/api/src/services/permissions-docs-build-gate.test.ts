import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ENTITLEMENTS, ENTITLEMENT_GROUPS } from "@repo/permissions";

/**
 * THE PERMISSIONS DESIGN DOCS STAY INTERNALLY CONSISTENT.
 *
 * The design for roles/entitlements/areas lives in three documents and took
 * five audit passes. Its decision log exists so "was this recorded?" is a
 * table lookup rather than a claim about somebody's memory.
 *
 * That only works if the log itself is sound — and it has already silently
 * broken once. An anchored string replacement matched a row inside the
 * DECISION LOG instead of the GATE TABLE (both are pipe tables with similar
 * shapes), splicing four gate definitions into the log and overwriting the
 * enforcement cell of the single most important decision in it. Uniqueness
 * of the anchor was asserted; its LOCATION was not. Nothing in a read-through
 * would catch that.
 *
 * So the check runs here, with everything else, instead of when someone
 * thinks to look.
 *
 * These are DESIGN docs, not code. The gate deletes itself along with them
 * when the work ships — see permissions-BUILD.md, which says to delete it.
 */

const DOCS = path.resolve(__dirname, "../../../../docs/features");
const BUILD = path.join(DOCS, "permissions-BUILD.md");
const PERMISSIONS_DOC = path.join(DOCS, "permissions.md");

const has = existsSync(BUILD);

describe.skipIf(!has)("[build-gate] the permissions decision log is sound", () => {
  const src = () => readFileSync(BUILD, "utf8");

  const split = () => {
    const s = src();
    const i = s.indexOf("## Gates — exact assertions");
    expect(i, "the Gates section must exist").toBeGreaterThan(-1);
    return { logPart: s.slice(0, i), gatePart: s.slice(i) };
  };

  /** Rows of the decision log: | n | decision | enforced by | */
  const logRows = () =>
    [...split().logPart.matchAll(/^\| (\d+[a-z]?) \| (.+?) \| (.+?) \|$/gm)]
      .map((m) => ({ n: m[1], decision: m[2], enforcedBy: m[3] }));

  /** Gate ids DEFINED in the gate table — nowhere else counts. */
  const definedGates = () =>
    new Set([...split().gatePart.matchAll(/^\| \*\*(G\d+)\*\* \|/gm)].map((m) => m[1]));

  it("reads the files it guards", () => {
    expect(logRows().length).toBeGreaterThan(40);
    expect(definedGates().size).toBeGreaterThan(20);
  });

  it("every gate a decision cites is actually defined", () => {
    const defined = definedGates();
    const dangling: string[] = [];
    for (const r of logRows()) {
      for (const g of r.enforcedBy.match(/G\d+/g) ?? []) {
        if (!defined.has(g)) dangling.push(`decision ${r.n} cites ${g}`);
      }
    }
    expect(
      dangling,
      "A decision pointing at a gate that does not exist is a decision nothing " +
        "enforces. This is exactly how G19-G23 ended up spliced into the log " +
        "instead of the gate table.",
    ).toEqual([]);
  });

  it("no decision row is malformed", () => {
    // A stray pipe in the enforcement cell means another table's row was
    // spliced in — the failure that corrupted decision 26.
    const broken = logRows().filter((r) => r.enforcedBy.includes("|")).map((r) => r.n);
    expect(broken, "extra `|` in the enforcement cell = a spliced row").toEqual([]);
  });

  it("no gate definition has leaked outside the gate table", () => {
    const strays = [...split().logPart.matchAll(/^\| \*\*(G\d+)\*\* \|/gm)].map((m) => m[1]);
    expect(strays, "gate rows belong under `## Gates`, not in the decision log").toEqual([]);
  });

  it("decision numbers are unique", () => {
    const seen = new Map<string, number>();
    for (const r of logRows()) seen.set(r.n, (seen.get(r.n) ?? 0) + 1);
    expect([...seen].filter(([, c]) => c > 1).map(([n]) => n)).toEqual([]);
  });

  it("rows with no mechanical enforcement are still declared out loud", () => {
    // Not a failure — these are legitimate. The gate exists so the count
    // cannot drift upward unnoticed: every new "human" row is a new way for
    // this to rot, and should be a deliberate choice.
    const human = logRows().filter((r) => ["human", "process"].includes(r.enforcedBy.trim()));
    expect(
      human.map((r) => r.n),
      "If this list grew, someone recorded a decision nothing enforces. " +
        "Either add a gate or accept it deliberately and update this expectation.",
      // 1  — the four axes never collapsing
      // 20 — geocoding home base and ranking the picker
      // 31 — one arrival point, nothing intermediate deployed
      // 15l — build everything, deploy once (asked explicitly, declined splitting)
      // Each was accepted deliberately when this list last changed. Adding a
      // fifth means pausing to ask whether a gate is possible first.
    // 46 and 47 joined on 2026-10-12: "ships with no custom roles" and
    // "the env-var break-glass is deleted" are both process, not code. Nothing
    // can assert that a fresh install was left alone, or that a starter script
    // was run by the right person against the right database.
    ).toEqual(["1", "15l", "20", "31", "46", "47"]);
  });

  it("every entitlement that guards a route is covered by the authz matrix", () => {
    // WHAT THIS USED TO CHECK, AND WHY IT MOVED.
    //
    // It required every entitlement in permissions.md to appear somewhere
    // in permissions-BUILD.md, on the reasoning that the build file WAS
    // the persona test matrix — true when written, and it caught
    // `pricing.view` and `routes.plan` reaching the design and never the
    // plan.
    //
    // Two things have changed since. The matrix is GENERATED now:
    // `tests/e2e/api/authz-matrix.spec.ts` loops
    // `entitlementsWithRoutes()`, derived from the live route map, so a
    // new entitlement that guards a route gets a holder/non-holder test
    // the moment it exists — no document to update. And
    // `tests/e2e/api/coverage.spec.ts` separately fails if any guarded
    // route has an entitlement with no matrix test.
    //
    // Meanwhile the old check was passing for the wrong reason: 15
    // entitlements were missing from permissions.md, so it could not see
    // them. Completing that table on 2026-10-23 turned it red against a
    // finished planning document — a gate that would fail on every future
    // entitlement while protecting nothing.
    //
    // So it now asserts the thing the sentence actually promises: every
    // entitlement guarding a route is reachable by the generated matrix.
    // The route map is the same source both sides read, which is what
    // makes this checkable from here at all.
    const routeMap = readFileSync(path.join(DOCS, "permissions-ROUTE-MAP.md"), "utf8");
    const NOT_AN_ENTITLEMENT = new Set(["OWNERSHIP", "CLIENT-PORTAL", "PUBLIC", "SYSTEM"]);
    const guarding = [...routeMap.matchAll(/^## ([A-Za-z][A-Za-z.\- ]*?)\s+\((\d+)\)/gm)]
      .map((m) => m[1].trim())
      .filter((g) => !NOT_AN_ENTITLEMENT.has(g));
    expect(guarding.length, "the route map must be readable").toBeGreaterThan(30);

    // Each must be a real entitlement — a typo in a map heading would
    // otherwise create a bucket the matrix silently never drives.
    const vocabulary = new Set<string>(ENTITLEMENTS as readonly string[]);
    const unknown = guarding.filter((g) => !vocabulary.has(g)).sort();
    expect(
      unknown,
      "the route map guards a capability that is not in the vocabulary — " +
        "the generated authz matrix would build a test for a thing that " +
        "cannot be granted",
    ).toEqual([]);

    // And the suite that drives them must still derive from the map
    // rather than a hand-kept list, or this assertion means nothing.
    const matrix = readFileSync(
      path.resolve(__dirname, "../../../web/tests/e2e/api/authz-matrix.spec.ts"),
      "utf8",
    );
    expect(
      matrix,
      "authz-matrix must enumerate entitlements from the route map — if it " +
        "ever hardcodes a list, a new entitlement stops being tested and " +
        "nothing here would notice",
    ).toMatch(/entitlementsWithRoutes\(\)/);
  });

  it("the design doc states no gate range and no phase number", () => {
    // permissions.md said "The authoritative gate list is G1–G15 in
    // permissions-BUILD.md" — in the same sentence as explaining that the
    // list is kept there "because it is a build artifact: it changes as code
    // lands, and this document should not." It was still saying G1–G15 at
    // G28, and the same range had been copied into the memory note.
    //
    // It also numbered the work Phase 0/1/2 while the build file numbered it
    // Step 1-4, with Phase 0 sitting INSIDE Step 1. Sequencing and the gate
    // inventory belong to the build file; this document describes the design.
    const design = readFileSync(path.join(DOCS, "permissions.md"), "utf8");

    const ranges = [...design.matchAll(/G\d+\s*[–—-]\s*G?\d+/g)].map((m) => m[0]);
    expect(
      ranges,
      "A gate range in the design doc dates it to the day it was written. " +
        "Name no range and no count — the build file owns the inventory.",
    ).toEqual([]);

    const phases = [...design.matchAll(/Phase \d+/g)].map((m) => m[0]);
    expect(
      phases,
      "Two numbering schemes for the same work. The build file's Step N is " +
        "the one with a checklist behind it.",
    ).toEqual([]);

    // A table column headed `Phase` carries the scheme without ever writing
    // "Phase 1", so the check above walked straight past it.
    const cols = [...design.matchAll(/^\|.*\bPhase\b.*\|$/gm)].map((m) => m[0].trim());
    expect(
      cols,
      "A `Phase` table column is the same second scheme wearing a hat.",
    ).toEqual([]);
  });

  it("suffixed decision rows ascend within their number", () => {
    // The 15x rows ran 15a-d, 15g-j, 15o, 15p, 15r, 15q, 15m, 15n, 15l, 15k,
    // 15f, 15e — 15e and 15f stranded at the end and the tail running
    // backwards. Cosmetic on its own, but it is the fingerprint of the
    // splicing incident this gate exists for: the log was hand-patched more
    // than once, and each patch appended wherever the anchor happened to
    // match.
    const rows = [...src().matchAll(/^\| (\d+)([a-z]) \| /gm)];
    expect(rows.length, "there must be suffixed rows to check").toBeGreaterThan(5);

    const seen = new Map<string, string>();
    const outOfOrder: string[] = [];
    for (const [, num, letter] of rows) {
      const prev = seen.get(num);
      if (prev !== undefined && letter <= prev) {
        outOfOrder.push(`${num}${letter} follows ${num}${prev}`);
      }
      seen.set(num, letter);
    }
    expect(
      outOfOrder,
      "Suffixed decision rows must read in order. Out-of-order rows mean the " +
        "log was appended to wherever a string match landed.",
    ).toEqual([]);
  });

  it("each step's items are a clean 1..n", () => {
    // The steps ran 1-9, 8-15, 14-18-17, 18-19: every step collided with the
    // next, and Step 3 repeated 17. The scheme had been one continuous
    // sequence, so a single insertion in Step 1 invalidated everything after
    // it — which is how the duplicate got there, and how adding two
    // foundation items on 2026-10-11 broke it again within the hour.
    //
    // Markdown renumbers ordered lists when rendering, so the document
    // always LOOKED right. Nothing caught it for 55 decisions because the
    // only broken copy was the source.
    const build = src();
    const steps = build.split(/^## Step \d+ — .*$/m).slice(1);
    expect(steps.length, "the four steps must be findable").toBe(4);

    const broken: string[] = [];
    steps.forEach((body, n) => {
      const nums = [...body.matchAll(/^(\d+[a-z]?)\. \[[ x]\] /gm)].map((m) => m[1]);
      const want = nums.map((_, k) => String(k + 1));
      if (nums.join(",") !== want.join(",")) {
        broken.push(`Step ${n + 1}: ${nums.join(", ")} (expected 1..${nums.length})`);
      }
    });
    expect(
      broken,
      "Items are numbered per step and must start at 1 with no gaps, repeats " +
        "or letter suffixes. A suffix like `1a.` is not a valid list marker " +
        "and renders as a paragraph, silently breaking the list.",
    ).toEqual([]);
  });

  it("every gate is scheduled in exactly one step", () => {
    // The gate table used to carry its own `Step` column, and it disagreed
    // with the step lists for five of the first six gates — G1, G2 and G4
    // were stamped Step 3 while Step 1 claimed all three. "Write the gate
    // before the code it guards" then held or did not hold depending on
    // which table you read. The column is gone; this keeps the step lists
    // complete, which is what the column was really for.
    //
    // Removing it also surfaced seven gates (G16, G17, G21, G22, G24, G25,
    // G26) that appeared in no step at all.
    const build = src();
    const i = build.indexOf("## Gates — exact assertions");
    const defined = [
      ...build.slice(i).matchAll(/^\| \*\*(G\d+)\*\* \|/gm),
    ].map((m) => m[1]);
    expect(defined.length, "the gate table must be readable").toBeGreaterThan(20);

    // Ranges are deliberately not parsed: the step lines name every gate
    // explicitly so this cannot be satisfied by an unread "G10–G14".
    const scheduled: string[] = [];
    for (const line of build.slice(0, i).matchAll(/Gates: \*\*(.+?)\*\*/g)) {
      scheduled.push(...(line[1].match(/G\d+/g) ?? []));
    }

    const unscheduled = defined.filter((g) => !scheduled.includes(g)).sort();
    expect(
      unscheduled,
      "These gates are defined but named in no step list, so nobody is told " +
        "when to write them. Add each to the step whose code it guards.",
    ).toEqual([]);

    const dupes = [...new Set(scheduled.filter((g, n) => scheduled.indexOf(g) !== n))].sort();
    expect(
      dupes,
      "These gates are scheduled in more than one step. One home each.",
    ).toEqual([]);

    const phantom = [...new Set(scheduled)].filter((g) => !defined.includes(g)).sort();
    expect(
      phantom,
      "These gates are scheduled but never defined in the gate table.",
    ).toEqual([]);
  });

  it("no persona is a holder of an entitlement they are denied", () => {
    // The coverage table and the expected-outcomes table disagreed in the
    // worst possible place: Sam was listed as a holder of `work.complete`
    // and `inventory.pull`, the exact two entitlements he exists to be the
    // NEGATIVE case for. The cause was a `WORKER (Jake, Dana, Sam)`
    // shorthand that named the base role and then listed everyone holding
    // it, ignoring worker-type subtraction.
    //
    // Holders are read up to the first em dash, so a cell may explain
    // itself ("Jake, Dana — not Sam, trainee defaults omit it") without the
    // disclaimer counting as a grant.
    const build = src();

    const denied = [
      ...build.matchAll(
        /^\| \*{0,2}([A-Z][a-z]+) · `([a-z]+\.[a-z-]+)`\*{0,2} \| \*{0,2}(✅|❌)\*{0,2} \|/gm,
      ),
    ]
      .filter((m) => m[3] === "❌")
      .map((m) => ({ who: m[1], ent: m[2] }));
    expect(denied.length, "the outcomes table must be readable").toBeGreaterThan(5);

    const holders = new Map(
      [...build.matchAll(/^\| `([a-z]+\.[a-z-]+)` \| (.+?) \|$/gm)].map((m) => [
        m[1],
        m[2].split("—")[0],
      ]),
    );
    expect(holders.size, "the coverage table must be readable").toBeGreaterThan(40);

    const contradictions = denied
      .filter((d) => (holders.get(d.ent) ?? "").includes(d.who))
      .map((d) => `${d.who} is denied ${d.ent} but listed as a holder of it`)
      .sort();
    expect(
      contradictions,
      "The coverage table and the outcomes table disagree. One of the two is " +
        "wrong, and the negative cases are where it matters most.",
    ).toEqual([]);
  });

  it("every coverage row's holder is a persona from the persona table", () => {
    // The check above asks only whether an entitlement string occurs
    // SOMEWHERE in the build file. Twelve of them satisfied it by naming
    // "Morgan" and "Alex" in the coverage table — two people who appeared in
    // no persona table, no expected-outcome row and no seed list. A mention
    // is not a testable holder, and the audit that found it also found that
    // Fran and Casey had no Clerk account either.
    const build = src();
    const personas = [
      ...build.matchAll(/^\| \*\*([A-Z][a-z]+)\*\* \| (?:WORKER|STAFF|ADMIN|SUPER)\b/gm),
    ].map((m) => m[1]);
    expect(personas.length, "the persona table must be readable").toBeGreaterThan(5);

    const coverage = [...build.matchAll(/^\| `([a-z]+\.[a-z-]+)` \| (.+?) \|$/gm)];
    expect(coverage.length, "the coverage table must be readable").toBeGreaterThan(40);

    const unheld = coverage
      .filter((m) => !personas.some((p) => m[2].includes(p)))
      .map((m) => m[1])
      .sort();
    expect(
      unheld,
      "These entitlements name a holder who is not a persona in the persona " +
        "table. A holder has to be someone the matrix actually drives — " +
        "add them to the persona table, or move the entitlement to a " +
        "persona that exists.",
    ).toEqual([]);
  });

  it("counts quoted in prose match the generated map", () => {
    // 676 was repeated confidently across all three documents and in
    // conversation. The real figure was 669 — an early run counted the same
    // path twice when it appeared in two route files.
    const map = readFileSync(path.join(DOCS, "permissions-ROUTE-MAP.md"), "utf8");
    const rows = (map.match(/^\| `[A-Z]+` \| `/gm) ?? []).length;
    const claimed = map.match(/(\d+) distinct method\+path pairs/);
    expect(claimed, "the map must state its own count").toBeTruthy();
    expect(Number(claimed![1]), "stated count must equal the rows present").toBe(rows);
  });

  it("the three documents still exist and reference each other", () => {
    for (const f of ["permissions.md", "permissions-BUILD.md", "permissions-ROUTE-MAP.md"]) {
      expect(existsSync(path.join(DOCS, f)), `${f} is missing`).toBe(true);
    }
    expect(src()).toContain("permissions.md");
    expect(readFileSync(path.join(DOCS, "permissions.md"), "utf8")).toContain("permissions-BUILD.md");
  });

  // ───────────────────────────────────────────────────────────────────────
  // The entitlement table in permissions.md IS the vocabulary, or it is
  // worse than nothing.
  //
  // It drifted silently for months: the doc listed 46 entitlements under
  // 8 groups and claimed "45 entitlements" while the code had 64 under 9
  // — an entire group ("Administration", 7 of them) had never been written
  // down. Nothing failed, because this gate only ever checked the
  // decision-log and gate tables. A reader comparing the doc to the role
  // builder would have found rows missing with no indication which side
  // was wrong.
  //
  // THE DOC IS NOT THE SOURCE. `ENTITLEMENT_GROUPS` is. These assertions
  // only insist the prose match it — so adding an entitlement is two
  // edits, and forgetting the second one fails the build instead of
  // quietly ageing the documentation.
  // ───────────────────────────────────────────────────────────────────────
  describe("the entitlement table matches the vocabulary", () => {
    const doc = () => readFileSync(PERMISSIONS_DOC, "utf-8");
    /** Every `| \`id\` | copy |` row in the doc, in order. */
    const docRows = (): Array<{ id: string; copy: string }> =>
      [...doc().matchAll(/^\| `([a-z][a-z-]*\.[a-z-]+)` \| (.+?) \|$/gm)].map((m) => ({
        id: m[1],
        copy: m[2].trim(),
      }));

    it("reads the file it guards", () => {
      expect(existsSync(PERMISSIONS_DOC), `${PERMISSIONS_DOC} is missing`).toBe(true);
      expect(docRows().length, "no entitlement rows parsed — the table format changed")
        .toBeGreaterThan(50);
    });

    it("lists every entitlement, and invents none", () => {
      const inDoc = new Set(docRows().map((r) => r.id));
      const inCode = new Set<string>(ENTITLEMENTS as readonly string[]);
      const missing = [...inCode].filter((e) => !inDoc.has(e)).sort();
      const stale = [...inDoc].filter((e) => !inCode.has(e)).sort();
      expect(missing, "entitlements in the vocabulary with no row in permissions.md").toEqual([]);
      expect(stale, "rows in permissions.md naming an entitlement that no longer exists").toEqual([]);
    });

    it("quotes the UI copy exactly", () => {
      // The copy is what sits beside the checkbox in the role builder. A
      // doc paraphrase is how an operator ends up granting the wrong thing
      // because the sentence they read is not the sentence they clicked.
      const copyById = new Map<string, string>();
      for (const g of ENTITLEMENT_GROUPS) {
        for (const e of g.entitlements) copyById.set(e.id, e.copy);
      }
      const wrong = docRows()
        .filter((r) => copyById.has(r.id) && copyById.get(r.id) !== r.copy)
        .map((r) => `  ${r.id}\n    doc:  ${r.copy}\n    code: ${copyById.get(r.id)}`);
      expect(wrong, `\nthe doc paraphrases the UI copy:\n\n${wrong.join("\n")}\n`).toEqual([]);
    });

    it("states the right total", () => {
      const m = /\*\*(\d+) entitlements\.\*\*/.exec(doc());
      expect(m, "permissions.md no longer states a total").not.toBeNull();
      expect(Number(m![1]), "the stated total disagrees with the vocabulary")
        .toBe(ENTITLEMENTS.length);
    });

    it("writes down every group the role builder shows", () => {
      const headings = new Set(
        [...doc().matchAll(/^#### (.+?)(?:\s*\*\(.*\)\*)?$/gm)].map((m) => m[1].trim()),
      );
      const missing = ENTITLEMENT_GROUPS.map((g) => g.group).filter((g) => !headings.has(g));
      expect(missing, "groups in the vocabulary with no section in permissions.md").toEqual([]);
    });
  });
});