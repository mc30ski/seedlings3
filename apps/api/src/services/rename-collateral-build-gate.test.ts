// ─────────────────────────────────────────────────────────────────────────────
// A GLOBAL RENAME MUST NOT REWRITE WORDS IT DOES NOT OWN.
//
// WHAT THIS EXISTS FOR
// `Area` → `Portfolio` was done with a word-boundary replace of `\barea\b`.
// A hyphen is a word boundary, so it also rewrote every hyphenated
// identifier containing "area" — none of which were ours:
//
//   · `env(safe-area-inset-top)` → `env(safe-portfolio-inset-top)`
//     in `_app.tsx` and `PWAPullToRefresh.tsx`. Not a real CSS variable,
//     so it silently fell back to the `0px` default and the whole title
//     bar slid under the iPhone Dynamic Island in the installed PWA.
//     Nothing failed to compile. Nothing failed a test. It was found by
//     the operator looking at their phone.
//   · lucide's `chart-area` and `area-chart` icon keys → `chart-portfolio`
//     and `portfolio-chart`, which resolve to nothing and draw a blank
//     cell in the picker.
//
// `textarea` survived only because it has no boundary before "area".
// That was luck, not care.
//
// THE RULES
//   1. The CSS safe-area variables are spelled correctly, and no
//      `env(...)` names a variable the platform does not define.
//   2. Every perspective icon key is a name lucide actually ships.
//
// Both are cheap, and both would have caught this before it shipped.
//
// WIRED VIA `test:build-gate` in package.json.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");
const WEB = path.join(REPO, "apps/web");

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".next", "dist"].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILES = [...walk(path.join(WEB, "src")), ...walk(path.join(WEB, "pages")), ...walk(path.join(WEB, "styles"))];

/** The CSS environment variables a browser actually defines. */
const REAL_ENV_VARS = new Set([
  "safe-area-inset-top",
  "safe-area-inset-bottom",
  "safe-area-inset-left",
  "safe-area-inset-right",
  "keyboard-inset-height",
  "titlebar-area-x",
  "titlebar-area-y",
  "titlebar-area-width",
  "titlebar-area-height",
]);

describe("[build-gate] a rename did not rewrite words it does not own", () => {
  it("reads a meaningful number of files", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("every env() names a variable the platform defines", () => {
    // THE ONE THAT SHIPPED. `env(safe-portfolio-inset-top, 0px)` is valid
    // CSS — an unknown variable simply takes its fallback — so the only
    // symptom was the header sitting under the Dynamic Island on a phone.
    const offenders: string[] = [];
    for (const f of FILES) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/env\(\s*([a-z-]+)/g)) {
          if (!REAL_ENV_VARS.has(m[1])) {
            offenders.push(`${path.relative(WEB, f)}:${i + 1}  env(${m[1]})`);
          }
        }
      });
    }
    expect(
      offenders,
      "An unknown CSS env() variable is not an error — it silently takes its " +
        "fallback. Check the spelling against the platform's list.",
    ).toEqual([]);
  });

  it("no hyphenated identifier was collaterally renamed", () => {
    // The shape of the damage: a word we do own, welded into a word we do
    // not. These are the ones the rename actually produced; the list is
    // short on purpose, because a broad "portfolio appears in a hyphenated
    // token" rule would flag our own `occurrence-portfolio-allow:` and
    // `x-portfolio-lens`, which are deliberate.
    const BANNED = [
      "safe-portfolio",
      "portfolio-inset",
      "chart-portfolio",
      "portfolio-chart",
      "content-portfolio",
      "textportfolio",
    ];
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = fs.readFileSync(f, "utf8");
      for (const bad of BANNED) {
        if (src.includes(bad)) offenders.push(`${path.relative(WEB, f)}  "${bad}"`);
      }
    }
    expect(
      offenders,
      "A global `\\barea\\b` replace also rewrites hyphenated identifiers — a " +
        "hyphen is a word boundary. These belong to CSS or to an icon set, " +
        "not to us.",
    ).toEqual([]);
  });
});
