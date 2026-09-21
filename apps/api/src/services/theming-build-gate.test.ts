// ─────────────────────────────────────────────────────────────────────────────
// Theming build gate
//
// The app ships FOURTEEN themes. Three of them are dark-grounded without
// being the Dark theme (Funkadelic, Retro, Espresso, Urban), and four are
// seasonal tints. That breaks every habit a two-theme codebase teaches:
//
//   • `{ base: X, _dark: Y }` knows two worlds. The `danger` button variant
//     used it, so "Delete" rendered dark-red-on-dark at 1.26:1 on four themes
//     while looking perfect in Light and Dark.
//   • A raw ramp value (`gray.100`, `#FEE2E2`) is ONE colour forever. The
//     title bar was a hardcoded `#dce5d0` and rendered identical sage in all
//     fourteen; three dialogs had hardcoded pale fills with dark ink.
//   • `colorPalette.solid` is a FILL that carries `contrast` ink. Used as a
//     text colour it is 3.30:1 on plain white, and under a tinted panel it
//     drops below 3:1.
//   • Adding a theme means touching SEVEN maps. Miss one and it half-lands:
//     Funkadelic shipped with the light header for an hour because
//     `buildSemanticColors` never learned about it.
//
// None of these fail loudly at runtime. They render — just wrong, and only on
// themes nobody happened to open. Hence a gate.
//
// See memory/reference_theming.md. The visual check is
// `THEME_SWEEP=1 npx playwright test --project=super theme-contrast-sweep`.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";

const WEB = resolve(__dirname, "../../../web");
const TOKENS = readFileSync(join(WEB, "src/styles/themeTokens.ts"), "utf8");
const THEME = readFileSync(join(WEB, "src/styles/theme.ts"), "utf8");

/** Every theme id, read from the ThemeId union itself. */
function themeIds(): string[] {
  const m = TOKENS.match(/export type ThemeId =([\s\S]*?);/);
  expect(m, "could not find the ThemeId union — did themeTokens.ts move?").toBeTruthy();
  return [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
}

function uiFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "tests") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith(".tsx")) continue;
      // Client-facing pages render for people with no stored theme and are
      // deliberately fixed to the standard look.
      if (full.includes("/pages/pay/") || full.includes("/pages/promotion/")) continue;
      // The wall display is the same category: it renders for a viewer with no
      // stored theme, on a panel nobody signs into, and wants ONE deliberate
      // dark look — glare, viewing distance and burn-in all point there. It is
      // a single self-contained file so this exemption stays narrow.
      if (full.endsWith("/pages/display.tsx")) continue;
      out.push(full);
    }
  };
  walk(join(WEB, "src"));
  walk(join(WEB, "pages"));
  return out;
}

describe("theming build gate", () => {
  it("reads the files it guards", () => {
    expect(themeIds().length).toBeGreaterThanOrEqual(5);
    expect(TOKENS).toContain("export const SURFACES");
    expect(uiFiles().length).toBeGreaterThan(50);
  });

  it("every theme is wired into all of the maps it needs", () => {
    // The half-landed-theme failure: colours applied, chrome did not.
    const maps: [string, string][] = [
      ["SURFACES", TOKENS],
      ["THEME_SEASON", TOKENS],
      ["THEME_LABELS", TOKENS],
      ["THEME_DESCRIPTIONS", TOKENS],
      ["THEME_COLOR_SCHEME", TOKENS],
      ["THEME_IDS", TOKENS],
    ];
    for (const id of themeIds()) {
      for (const [name, src] of maps) {
        const at = src.indexOf(name);
        const block = src.slice(at, src.indexOf("\n};", at));
        expect(block.includes(`${id}:`) || block.includes(`"${id}"`),
          `theme "${id}" is missing from ${name} — it will silently fall back ` +
          "to the Light value for whatever that map controls.").toBe(true);
      }
      if (id === "original") continue; // the base theme sets no attribute
      expect(TOKENS, `theme "${id}" has no entry in THEME_CONDITIONS`)
        .toContain(`${id}: "html[data-theme=${id}] &"`);
      expect(THEME, `theme "${id}" is not registered as a Chakra condition in theme.ts`)
        .toContain(`${id}: THEME_CONDITIONS.${id}`);
    }
  });

  it("recipes never pin a colour with a base/_dark pair", () => {
    // The Delete bug. `_dark` is ONE theme; the other twelve fall to `base`.
    const bad = [...stripComments(THEME).matchAll(
      /\{\s*base:\s*"[a-z]+\.[0-9]{2,3}"\s*,\s*_dark:/g)];
    expect(bad.map((b) => b[0]),
      "a { base, _dark } pair of raw ramp values only resolves on two of the " +
      "fourteen themes. Use the semantic steps (faint/subtle/muted/emphasized/" +
      "strong/solid/fg/contrast), which resolve on all of them.").toEqual([]);
  });

  it("no component uses a solid fill as a text colour", () => {
    const hits: string[] = [];
    for (const f of uiFiles()) {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/color=\{?[^}\n]*?"([a-z]+)\.solid"/g)) {
        hits.push(`${f.replace(WEB, "apps/web")}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(hits,
      "`colorPalette.solid` is a FILL, paired with `contrast` as its ink. As a " +
      "text colour it is 3.30:1 on plain white and fails outright on a tinted " +
      "panel. Use `.fg`.\n" + hits.join("\n")).toEqual([]);
  });

  it("no component hardcodes a colour", () => {
    const hits: string[] = [];
    for (const f of uiFiles()) {
      const src = stripComments(readFileSync(f, "utf8"));
      // HEX only. A translucent scrim — `rgba(0,0,0,.4)` behind a modal or a
      // photo lightbox — is theme-independent BY DESIGN: it darkens whatever
      // is under it, whatever colour that is. An opaque hex is the bug.
      for (const m of src.matchAll(
        /(?:color|bg|background|borderColor|fill|backgroundColor)=\{?"(#[0-9a-fA-F]{3,8})"/g)) {
        hits.push(`${f.replace(WEB, "apps/web")}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(hits,
      "a hardcoded colour is the same in all fourteen themes. The title bar " +
      "shipped as `#dce5d0` and stayed sage everywhere.\n" + hits.join("\n")).toEqual([]);
  });

  it("the theme specs that prove all this still exist", () => {
    // Each was written against a bug that shipped. Deleting one silently
    // removes the only check for that failure mode.
    const specs = [
      ["theme-live-switch.spec.ts", "switching repaints the page, not just the cards"],
      ["theme-splash.spec.ts", "no white flash on a dark-grounded theme"],
      ["theme-chip-sync.spec.ts", "header and Profile pickers stay in step"],
      ["theme-header-dropdowns-admin.spec.ts", "nothing inherits the title bar's ink"],
      ["theme-pulse-contrast.spec.ts", "every pulse tint reads against its own page"],
      ["theme-season-logo-admin.spec.ts", "a theme pins the mark; a manual choice survives"],
      ["mobile-theme-chip.spec.ts", "the theme menu fits a 320px phone"],
      ["theme-contrast-sweep-admin.spec.ts", "every element on every tab in every theme"],
        [
      "job-guidance-pulse-admin.spec.ts",
      "Guidance renders at every card density and stops pulsing on a finished visit — both shipped broken and both were invisible to static rules",
    ],
];
    for (const [file, why] of specs) {
      expect(existsSync(join(WEB, "tests/e2e/specs", file)),
        `tests/e2e/specs/${file} is missing — it is the only check that ${why}.`).toBe(true);
    }
  });
});
