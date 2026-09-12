// ─────────────────────────────────────────────────────────────────────────────
// Address parsing build gate
//
// THE BUG THIS EXISTS TO PREVENT, in full, because it shipped:
//
// A one-line address gets split into fields in several places. The obvious
// implementation reads the third comma segment and takes its first whitespace
// token as the state:
//
//     const stateZip = parts[2].split(/\s+/);
//     const state = stateZip[0];              // "North"
//
// For "Chapel Hill, North Carolina 27517" that yields state "North". It does
// not throw, the field looks plausible in a free-text input, and the loss is
// invisible until a client's confirmation text reads "…Chapel Hill, North."
// It reached production and put "North" on 19 live properties.
//
// What made it survive is that there were THREE private copies of the splitter
// and no single place to fix:
//
//   PropertyDialog.tsx          fixed early
//   ConvertEstimateDialog.tsx   fixed later — and is DEAD CODE, rendered
//                               nowhere, so fixing it changed nothing
//   NewJobSetupWorkflow.tsx     the live estimate → property path, and the
//                               one still writing "North" the whole time
//
// So the rule is not "parse carefully". It is: there is ONE implementation,
// `apps/web/src/lib/address.ts`, and nothing else may hand-roll one. That file
// anchors on the trailing ZIP, which makes the state unambiguous however many
// words it has.
//
// The structural half of the fix is that estimates now STORE the parts
// (JobOccurrence.estimateStreet1 … estimatePostalCode), so the normal path
// does no parsing at all — the parser is only the fallback for rows created
// before those columns existed.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const WEB_SRC = join(REPO_ROOT, "apps/web/src");
const WEB_PAGES = join(REPO_ROOT, "apps/web/pages");

/** The one legitimate implementation. Everything else must import from it. */
const CANONICAL = "apps/web/src/lib/address.ts";

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(full, out);
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const files = [...walk(WEB_SRC), ...walk(WEB_PAGES)].map((f) => ({
  rel: f.slice(REPO_ROOT.length + 1),
  text: readFileSync(f, "utf8"),
}));

/** Strip line and block comments, so the incident write-ups that QUOTE the bad
 *  code (this file included, and the one in NewJobSetupWorkflow) are not
 *  themselves flagged. A gate that punishes documenting the bug teaches people
 *  to delete the explanation. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("address parsing — one implementation", () => {
  it("scans a meaningful number of web files", () => {
    // Guards the gate itself: a broken path would make every check below pass
    // vacuously, which is how a gate goes quietly dead.
    expect(files.length).toBeGreaterThan(100);
  });

  it("nothing outside lib/address.ts splits a state off an address by whitespace", () => {
    // The exact shape of the shipped bug: take a comma segment, split it on
    // whitespace, keep index 0 (or 1) as a field. Any variable whose name says
    // it holds a state and/or ZIP together.
    const HAZARD = /\b(?:state|stateZip|stateAndZip|edStateZip)\w*\s*(?:=|\.)\s*[^;\n]*\.split\s*\(\s*\/\\s\+\//i;
    const offenders = files
      .filter((f) => f.rel !== CANONICAL)
      .filter((f) => HAZARD.test(stripComments(f.text)))
      .map((f) => f.rel);
    expect(offenders, [
      "These files split a state/ZIP segment on whitespace, which drops every",
      "word of a multi-word state after the first (\"North Carolina\" -> \"North\").",
      "Import parseAddressLine from @/src/lib/address instead.",
    ].join(" ")).toEqual([]);
  });

  it("nothing outside lib/address.ts pulls the one-line estimate address apart", () => {
    // `estimateAddress` is the legacy one-line column. Any file taking it
    // apart by hand is a fourth copy of the parser in the making.
    const offenders = files
      .filter((f) => f.rel !== CANONICAL)
      .filter((f) => {
        const src = stripComments(f.text);
        return /estimateAddress[^;\n]{0,80}\.split\s*\(/.test(src);
      })
      .map((f) => f.rel);
    expect(offenders, [
      "These files parse the one-line estimateAddress by hand. Prefer the",
      "structured columns (estimateStreet1 … estimatePostalCode); fall back to",
      "parseAddressLine from @/src/lib/address for pre-column rows.",
    ].join(" ")).toEqual([]);
  });

  it("every file that parses an address imports the canonical helper", () => {
    const users = files.filter(
      (f) => f.rel !== CANONICAL && /parseAddressLine/.test(stripComments(f.text)),
    );
    // Sanity: the helper is genuinely in use, so this check is not vacuous.
    expect(users.length).toBeGreaterThan(0);
    const missingImport = users
      .filter((f) => !/from\s+["']@\/src\/lib\/address["']/.test(f.text))
      .map((f) => f.rel);
    expect(missingImport, "parseAddressLine must come from @/src/lib/address").toEqual([]);
  });

  it("the canonical parser anchors on the trailing ZIP, not a whitespace split", () => {
    const src = readFileSync(join(REPO_ROOT, CANONICAL), "utf8");
    // The property that makes it correct: the ZIP is matched at the END of the
    // segment, so everything before it is the state however many words it is.
    expect(src).toMatch(/\\d\{5\}(?:[^\n]*)\$\//);
    expect(stripComments(src)).not.toMatch(/\.split\s*\(\s*\/\\s\+\//);
  });

  it("the live estimate → property conversion prefers the stored parts", () => {
    // NewJobSetupWorkflow is the path an accepted estimate actually travels.
    // ConvertEstimateDialog looks like it but is rendered nowhere — fixing the
    // wrong one of the two is precisely what happened last time.
    const wf = files.find((f) => f.rel.endsWith("NewJobSetupWorkflow.tsx"));
    expect(wf, "NewJobSetupWorkflow.tsx not found").toBeTruthy();
    const src = stripComments(wf!.text);
    // EACH DERIVED VALUE must be sourced from its own stored part. Two weaker
    // drafts of this check both passed while the read was deleted: looking for
    // the field name anywhere matched the defaults TYPE, and looking for
    // `ed?.estimateCity` anywhere matched the `edHasParts` guard. So pin the
    // assignment itself.
    const BINDINGS: [string, string][] = [
      ["edStreet", "estimateStreet1"],
      ["edCity", "estimateCity"],
      ["edState", "estimateState"],
      ["edZip", "estimatePostalCode"],
    ];
    for (const [variable, field] of BINDINGS) {
      const line = src
        .split("\n")
        .find((l) => new RegExp(`\\bconst\\s+${variable}\\s*=`).test(l));
      expect(line, `${variable} is not assigned in NewJobSetupWorkflow`).toBeTruthy();
      expect(
        line!.includes(field),
        `${variable} must come from the estimate's ${field}, not from re-parsing the one-line address`,
      ).toBe(true);
    }
  });
});

describe("estimate address — parts are the source of truth", () => {
  const apiSrc = join(REPO_ROOT, "apps/api/src");
  const schema = readFileSync(join(REPO_ROOT, "apps/api/prisma/schema.prisma"), "utf8");

  it("the structured columns exist on JobOccurrence", () => {
    for (const col of [
      "estimateStreet1", "estimateStreet2", "estimateCity",
      "estimateState", "estimatePostalCode",
    ]) {
      expect(schema, `${col} missing from schema`).toContain(col);
    }
  });

  it("the one-line column is derived, never taken from a request body", () => {
    // The two representations drift the moment a caller can set both. Every
    // write path routes through applyEstimateAddressParts, which rebuilds the
    // line from the merged parts.
    const helper = readFileSync(join(apiSrc, "lib/estimateAddress.ts"), "utf8");
    expect(helper).toContain("formatEstimateAddressLine");
    const jobs = readFileSync(join(apiSrc, "services/jobs.ts"), "utf8");
    const calls = jobs.match(/applyEstimateAddressParts\(/g) ?? [];
    // create, update, and the generic occurrence patch.
    expect(calls.length, "every estimate write path must apply the parts").toBeGreaterThanOrEqual(3);
  });

  it("the derived line reads back as the parts it was built from", async () => {
    const { formatEstimateAddressLine } = await import("../lib/estimateAddress");
    const { parseAddressLine } = await import("../../../web/src/lib/address");
    const parts = {
      estimateStreet1: "1059 Perdue Dr",
      estimateCity: "Chapel Hill",
      estimateState: "North Carolina",
      estimatePostalCode: "27517",
    };
    const line = formatEstimateAddressLine(parts)!;
    const back = parseAddressLine(line);
    expect(back.street1).toBe("1059 Perdue Dr");
    expect(back.city).toBe("Chapel Hill");
    // The whole point: the second word survives.
    expect(back.state).toBe("North Carolina");
    expect(back.postalCode).toBe("27517");
  });

  it("an empty set of parts derives null, not an empty string", async () => {
    const { formatEstimateAddressLine } = await import("../lib/estimateAddress");
    // "" would overwrite a legacy row's only copy of its address.
    expect(formatEstimateAddressLine({})).toBeNull();
    expect(formatEstimateAddressLine({ estimateStreet1: "   " })).toBeNull();
  });

  it("editing one part does not blank the others", async () => {
    const { applyEstimateAddressParts } = await import("../lib/estimateAddress");
    const existing = {
      estimateStreet1: "1059 Perdue Dr",
      estimateCity: "Chapel Hill",
      estimateState: "North Carolina",
      estimatePostalCode: "27517",
    };
    const data: Record<string, any> = {};
    applyEstimateAddressParts(data, { estimatePostalCode: "27516" }, existing);
    expect(data.estimateAddress).toBe("1059 Perdue Dr, Chapel Hill, North Carolina 27516");
  });
});
