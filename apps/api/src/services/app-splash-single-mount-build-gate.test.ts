// ─────────────────────────────────────────────────────────────────────────────
// AppSplash single-mount build gate
//
// PURPOSE
// `apps/web/pages/_document.tsx` paints a white shield over the viewport on
// first paint and removes it when AppSplash's overlay appears. That shield
// exists to hide a HANDOFF race: SSR'd app content paints for a frame or
// two before AppSplash's useEffect portals its overlay on top (the flash
// the operator captured on slow-motion video, 2026-08-17).
//
// The remover contains this line:
//
//     if (window.location.pathname !== '/') { drop(); return; }
//
// It is a load-bearing assumption, not a convenience: AppSplash is mounted
// in exactly ONE place — pages/index.tsx, which serves "/". On every other
// route no overlay is ever coming, so the MutationObserver could never
// fire and the shield sat for its full 3-SECOND fallback. That was three
// seconds of white on every public, client-facing page: the promotion
// landing page, and the /pay invoice a client opens from an SMS link.
//
// WHAT BREAKS IF THIS GATE IS IGNORED
// Mount <AppSplash> on a second route and that route silently regresses to
// the original flash — the shield skips itself there, but a splash now
// DOES arrive, so app content paints before it. The failure is a
// hard-to-catch one-or-two-frame flicker on a route nobody thinks to
// re-test, which is exactly why it is enforced mechanically instead of
// documented and hoped for.
//
// TWO WAYS TO SATISFY THIS GATE
//   1. Keep AppSplash mounted only in pages/index.tsx (the answer ~always).
//   2. If a second mount is genuinely needed, UPDATE THE PATHNAME CHECK in
//      _document.tsx to cover that route too, then update this gate's
//      ALLOWED list. Do not just raise the count.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCAN_DIRS = ["apps/web/pages", "apps/web/src"] as const;

/** JSX mount of the splash — `<AppSplash ...>`, not the import or a comment. */
const MOUNT = /<AppSplash[\s/>]/;

/**
 * Strip comments before scanning.
 *
 * _document.tsx DESCRIBES the handoff in prose ("hand off to <AppSplash />
 * once React has hydrated"), which a naive regex reads as a mount and
 * reports as a violation — a gate that cries wolf about the very file it
 * is protecting gets disabled, so it has to be precise.
 *
 * Deliberately crude: block comments, then line comments. Good enough for
 * "is there a JSX mount here", and it never has to parse real TS.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Files permitted to mount AppSplash. Each entry must be covered by the
 * pathname check in _document.tsx's SHIELD_REMOVER_JS.
 */
const ALLOWED = new Set<string>(["apps/web/pages/index.tsx"]);

function walk(dir: string, acc: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // directory absent in some checkouts — nothing to scan
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (st.isFile() && (full.endsWith(".tsx") || full.endsWith(".ts"))) acc.push(full);
  }
}

describe("AppSplash single-mount build gate", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(join(REPO_ROOT, d), files);

  const mounts = files
    .filter((f) => MOUNT.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => relative(REPO_ROOT, f))
    .sort();

  it("AppSplash is mounted only where the shield's pathname check expects", () => {
    const unexpected = mounts.filter((f) => !ALLOWED.has(f));
    if (unexpected.length > 0) {
      expect.fail(
        `\nAppSplash is mounted in ${unexpected.length} unexpected file(s):\n\n` +
          unexpected.map((f) => `  ${f}`).join("\n") +
          `\n\n_document.tsx drops its pre-paint white shield immediately on\n` +
          `any route other than "/", because AppSplash was only ever mounted\n` +
          `on "/". A splash on another route now paints AFTER the content —\n` +
          `reintroducing the one-or-two-frame flash the shield exists to\n` +
          `prevent.\n\n` +
          `Fix: extend the pathname check in SHIELD_REMOVER_JS\n` +
          `(apps/web/pages/_document.tsx) to cover the new route, then add\n` +
          `the file to ALLOWED in this test.\n`,
      );
    }
  });

  it("the expected mount still exists (the shield check isn't dead code)", () => {
    // If index.tsx stops mounting AppSplash, the pathname check and the
    // whole shield are pure cost and should be reconsidered — not left
    // sitting there implying a splash that no longer happens.
    expect(mounts).toContain("apps/web/pages/index.tsx");
  });

  it("_document.tsx still contains the pathname guard this gate protects", () => {
    // The gate and the guard are a pair. If someone deletes the guard, this
    // test would otherwise keep passing while protecting nothing — the
    // exact "green test that guards nothing" failure this repo has been
    // bitten by before.
    const doc = readFileSync(join(REPO_ROOT, "apps/web/pages/_document.tsx"), "utf8");
    expect(doc).toContain("window.location.pathname !== '/'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The splash caret has to be visible
//
// It shipped invisible: an empty <span> with `display: inline-block` and no
// height collapses to zero, so the `border-right` that was meant to BE the
// cursor had no length to draw along. The blink keyframes were fine — there
// was simply nothing on screen to blink. Nothing catches that but looking at
// it, and the splash is on screen for under two seconds.
// ─────────────────────────────────────────────────────────────────────────────

describe("app splash — the typing caret actually renders", () => {
  const SPLASH = readFileSync(
    join(REPO_ROOT, "apps/web/src/ui/helpers/AppSplash.tsx"), "utf8",
  );
  /** The caret span: the one carrying the blink animation. */
  const caret = (() => {
    const i = SPLASH.indexOf("seedlings-splash-cursor-blink");
    return SPLASH.slice(SPLASH.lastIndexOf("<span", i), SPLASH.indexOf("/>", i) + 2);
  })();

  it("sets an explicit height — it has no content to give it one", () => {
    expect(caret).toMatch(/height:\s*"[^"]+"/);
  });

  it("is a filled block, not a border on an empty box", () => {
    // A border needs a box with height; a background needs width and height.
    // Both are stated now, but the filled form makes the dependency obvious.
    expect(caret).toMatch(/background:\s*"#4a5568"/);
    expect(caret).toMatch(/width:\s*"2px"/);
  });

  it("the blink period tracks the typing speed", () => {
    // A caret ticking at a fixed 1s next to typing that accelerates reads as
    // two unrelated clocks. It rides the same speedFactor ramp as everything
    // else in the animation.
    expect(SPLASH).toMatch(/const blinkMs = \(idx: number\)/);
    expect(SPLASH).toMatch(/BLINK_BASE_MS \* speedFactor\(idx\)/);
    expect(caret).toMatch(/\$\{blink\}ms/);
  });

  it("the fastest blink stays under three flashes a second", () => {
    // WCAG 2.3.1. The raw ramp bottoms out at 0.24, which would drive a 1s
    // base down to 240ms — over four a second. The floor is what keeps it
    // legal, so it is asserted rather than left to whoever tunes the ramp.
    const base = Number(/const BLINK_BASE_MS = (\d+)/.exec(SPLASH)?.[1]);
    const floor = Number(/const BLINK_FLOOR_MS = (\d+)/.exec(SPLASH)?.[1]);
    expect(base).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(1000 / 3);
    // And the floor has to actually bind — otherwise it is decoration.
    const rampFloor = Number(/Math\.max\(([\d.]+), Math\.pow/.exec(SPLASH)?.[1]);
    expect(base * rampFloor).toBeLessThan(floor);
  });

  it("the blink keyframes it names exist", () => {
    // The animation silently does nothing if the name is wrong, which looks
    // identical to a caret that renders but never blinks.
    const css = readFileSync(join(REPO_ROOT, "apps/web/src/styles/globals.css"), "utf8");
    expect(css).toMatch(/@keyframes seedlings-splash-cursor-blink/);
  });
});
