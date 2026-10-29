// ─────────────────────────────────────────────────────────────────────────────
// A QUERY FRAGMENT TYPESCRIPT CANNOT CHECK MUST BE CHECKED SOMEWHERE ELSE.
//
// WHAT THIS EXISTS FOR
// The portfolio work broke the same way twice in one day, and both times the
// compiler was green:
//
//   1. `portfolioWhere()` returns `Record<string, unknown>`. When membership
//      went from a column to a join table its emitted shape
//      (`{ portfolio: { OR: … } }`) became a field that no longer exists.
//      Nothing failed to build. It would simply have matched NOTHING — every
//      portfolio-scoped reader seeing an empty app, with no error anywhere.
//      Caught only because a unit test asserted the literal shape.
//
//   2. `areaWhereOn(principal, cap, "defaultPortfolio")` took the relation
//      name as a STRING. `Job.defaultArea` was dropped in the same change.
//      TypeScript saw a string; Prisma threw a 500 on every job list the
//      moment any portfolio filter was in force — which is to say the
//      Services tab was broken for exactly the people the feature is for.
//      Caught only by calling the endpoint with and without the header.
//
// The shared cause is not portfolios. It is a `where` fragment built as an
// untyped object, or keyed by a field named in a string, so the one tool
// that would notice a schema change is switched off at the callsite.
//
// THE RULE
//   A function that returns an untyped query fragment must have a test
//   asserting its literal shape. The test is then the thing that fails when
//   the schema moves, in the second it takes to run rather than the week it
//   takes somebody to notice an empty list.
//
// WHY NOT JUST TYPE THEM
// `Prisma.XWhereInput` differs per model and these helpers are deliberately
// model-agnostic — that is what lets one filter be threaded through thirty
// query sites. The looseness buys something real; this gate is its price.
//
// WIRED VIA `test:build-gate` in package.json.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const API = path.resolve(__dirname, "..");
const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

/** Every lib file that hands callers a `where` fragment it has not typed. */
function untypedFragmentExporters(): Array<{ file: string; fn: string }> {
  const out: Array<{ file: string; fn: string }> = [];
  const dir = path.join(API, "lib");
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    const src = read(path.join(dir, name));
    for (const m of src.matchAll(
      /export function (\w+)\([\s\S]*?\):\s*Record<string,\s*unknown>/g,
    )) {
      out.push({ file: name, fn: m[1] });
    }
  }
  return out;
}

describe("[build-gate] untyped query fragments are shape-tested", () => {
  it("finds the exporters at all", () => {
    // A walk that quietly returns nothing would pass every check below.
    expect(untypedFragmentExporters().length).toBeGreaterThan(0);
  });

  it("every fragment builder has a test asserting its literal shape", () => {
    const tests = [path.join(API, "lib"), path.join(API, "services")]
      .filter((d) => fs.existsSync(d))
      .flatMap((d) =>
        fs.readdirSync(d).filter((f) => f.includes(".test.")).map((f) => read(path.join(d, f))),
      )
      .join("\n");

    const offenders = untypedFragmentExporters()
      .filter(({ fn }) => {
        // The test must both CALL it and assert on a whole object, which is
        // what pins the shape. `expect(f(…)).toEqual({…})` qualifies;
        // asserting only that it is truthy does not.
        const calls = new RegExp(`\\b${fn}\\(`).test(tests);
        const asserts = new RegExp(`${fn}\\([^;]*\\)\\s*\\)?\\s*\\.toEqual\\(`, "s").test(tests);
        return !(calls && asserts);
      })
      .map(({ file, fn }) => `${file}: ${fn}`);

    expect(
      offenders,
      "This returns a `where` fragment TypeScript will not check. Add a test " +
        "that asserts its exact emitted object, so a schema change fails here " +
        "instead of silently matching nothing. See the header for the two " +
        "times this shipped.",
    ).toEqual([]);
  });

  it("no helper names a Prisma field or relation in a string parameter", () => {
    // `areaWhereOn(principal, cap, "defaultPortfolio")` — the relation was a
    // string, so dropping the field was invisible until Prisma threw. A
    // helper that builds `{ [relation]: … }` from an argument cannot be
    // checked by anything; the relation has to be written literally at the
    // callsite, where a rename or a drop is a compile error.
    const dir = path.join(API, "lib");
    const offenders: string[] = [];
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!name.endsWith(".ts") || name.includes(".test.")) continue;
      const src = read(path.join(dir, name));
      for (const m of src.matchAll(/export function (\w+)\(([\s\S]*?)\):/g)) {
        const [, fn, params] = m;
        if (!/:\s*string\b/.test(params)) continue;
        const body = src.slice(m.index! + m[0].length, src.indexOf("\n}\n", m.index!));
        // Building an object whose KEY is a parameter is the shape to refuse.
        if (!/return\s*\{\s*\[\s*\w+\s*\]:/.test(body)) continue;
        // …unless it says why it is safe. The doc comment above it must
        // carry `untyped-fragment-allow:` with a reason, the same idiom as
        // `worker-class-allow` and `view-as-allow`. An allow is a claim
        // somebody signed, which is the point: the next person reads the
        // reason instead of rediscovering the hazard.
        const before = src.slice(Math.max(0, m.index! - 1400), m.index!);
        if (/untyped-fragment-allow:/.test(before)) continue;
        offenders.push(`${name}: ${fn}`);
      }
    }
    expect(
      offenders,
      "This builds a query key from a string argument, so a renamed or " +
        "deleted Prisma field is invisible to the compiler. Write the " +
        "relation literally at the callsite instead — `portfolioWhereVia` " +
        "nests an already-shaped fragment and is the pattern to copy.",
    ).toEqual([]);
  });
});
