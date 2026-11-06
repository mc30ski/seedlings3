// ─────────────────────────────────────────────────────────────────────────────
// US spelling build gate
//
// The app is used by one lawn-care business in North Carolina. Its words
// should be the ones its crew and its customers write, and "coloured",
// "centre" and "summarised" are not those words.
//
// WHY A GATE RATHER THAN A PROOFREAD. Nothing about a British spelling
// fails: it typechecks, it renders, it reads perfectly well to whoever wrote
// it. It is only ever caught by somebody noticing, and four of them reached
// production by exactly that route — a portfolio's "Automatic colour", the
// hint under its map point, a line in the payroll explainer and one in the
// jobs legend — each written at a different time, by an author who does not
// hear anything wrong with them. That author will write more copy.
//
// WHAT IT SCANS: double-quoted strings and JSX text in the web app, with
// comments stripped first. Comments are for whoever is reading the code and
// are deliberately out of scope; this is about what a person using the app
// sees. Identifiers are out of scope too — a local named `colour` harms
// nobody and renaming them all would be a large diff for no reader.
//
// ADDING A WORD: put it in BRITISH below. Pairs only — a word that is
// genuinely ambiguous, or that appears in a product name, belongs in ALLOW
// with the reason, not in the list.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

const WEB = resolve(__dirname, "../../../web");

/** British spelling → the one to use instead. */
const BRITISH: Record<string, string> = {
  colour: "color",
  coloured: "colored",
  colours: "colors",
  colouring: "coloring",
  centre: "center",
  centred: "centered",
  centres: "centers",
  organise: "organize",
  organised: "organized",
  organising: "organizing",
  organisation: "organization",
  summarise: "summarize",
  summarised: "summarized",
  prioritise: "prioritize",
  prioritised: "prioritized",
  customise: "customize",
  customised: "customized",
  recognise: "recognize",
  recognised: "recognized",
  analyse: "analyze",
  analysed: "analyzed",
  behaviour: "behavior",
  licence: "license",
  apologise: "apologize",
  whilst: "while",
  travelling: "traveling",
  catalogue: "catalog",
  // NOT "cancelled". It is an accepted US variant, not a Britishism, and
  // the app says it in eighteen places. Worth normalising to match the
  // `CANCELED` status it describes — but that is a copy decision for the
  // owner to make, not something to enforce under cover of a spelling gate.
};

/**
 * Exact strings allowed to keep a British spelling, each with a reason.
 * Empty, and the right thing to do with a new entry is usually to fix the
 * copy instead of listing it.
 */
const ALLOW: Array<{ text: string; why: string }> = [];

const WORD_RE = new RegExp(`\\b(${Object.keys(BRITISH).join("|")})\\b`, "i");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

function webFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "tests") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(join(WEB, "src"));
  walk(join(WEB, "pages"));
  return out;
}

describe("US spelling build gate", () => {
  it("no British spelling in anything the user reads", () => {
    const files = webFiles();
    expect(files.length, "walked no web files — this gate is reading nothing").toBeGreaterThan(50);

    const allowed = new Set(ALLOW.map((a) => a.text));
    const hits: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"));
      const candidates: string[] = [];
      // Double-quoted strings: labels, titles, placeholders, aria text.
      for (const m of src.matchAll(/"([^"\n]{2,400})"/g)) candidates.push(m[1]);
      // JSX text nodes: >Some words<, with no braces or tags inside.
      //
      // NEWLINES ALLOWED INSIDE. This excluded `\n`, which meant it only saw
      // text that sat on the same line as both its tags — and prose long
      // enough to be worth proofreading is exactly the prose that wraps.
      // Caught by mutation: a Britishism planted in a two-line <Text> went
      // straight through. The class still excludes <>{} so a match cannot
      // run past a tag or into an expression.
      for (const m of src.matchAll(/>([^<>{}]{3,400})</g)) candidates.push(m[1].replace(/\s+/g, " "));
      for (const text of candidates) {
        if (allowed.has(text.trim())) continue;
        const m = WORD_RE.exec(text);
        if (!m) continue;
        const bad = m[0].toLowerCase();
        hits.push(
          `${f.replace(WEB, "apps/web")}: "${bad}" → "${BRITISH[bad]}"\n    in: ${text.trim().slice(0, 110)}`,
        );
      }
    }
    expect(
      hits,
      "British spelling in user-facing copy. Nothing fails over one — it typechecks, renders, and reads fine to whoever wrote it — which is why they accumulate.\n" +
        hits.join("\n"),
    ).toEqual([]);
  });
});
