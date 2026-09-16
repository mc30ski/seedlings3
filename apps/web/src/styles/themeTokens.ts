// ─────────────────────────────────────────────────────────────────────────────
// THEME TOKEN VOCABULARY — the single source for every theme's values.
//
// Five themes, two axes:
//   APPEARANCE  Light · Dark · High contrast
//   SEASON      Spring · Summer · Fall · Winter — tint the CHROME, never what
//               a colour MEANS.
//   PLAY        Funkadelic · Retro.
//   WARM        Coffeehouse (light roast) · Espresso (dark roast).
//   BOLD        Urban · Jelly · Juice — supplied palettes, taken literally.
//
// Brand themes must not touch meaning: red means REJECTED, amber means the
// Access callout. Let Fall tint those and a cancelled job stops looking
// alarming on an autumn ground.
//
// Brand values sampled from the two shipped logo variants, not invented:
//   Spring  ground #e8f8e8 · ring #386018 · leaf #68b030 · light leaf #98d870
//   Fall    ground #fff8c8 · ring #883028 · rust #ff6038 · amber #ff9828
//   Seed    #a88058 — the same brown in both, the one cross-season anchor.
// ─────────────────────────────────────────────────────────────────────────────

export type ThemeId =
  | "original" | "dark" | "contrast"
  | "spring" | "summer" | "fall" | "winter"
  | "funkadelic" | "retro"
  | "coffeehouse" | "espresso"
  | "urban" | "jelly" | "juice";

/** Light and Dark are appearance-only and keep the ET-month auto-switch in
 *  lib/season.ts. Spring and Fall ARE a season, so they pin the mark. High
 *  contrast has no seasonal identity and no icon of its own. */
export const THEME_SEASON: Record<ThemeId, "auto" | "spring" | "fall"> = {
  original: "auto",
  dark: "auto",
  spring: "spring",
  fall: "fall",
  // The icon set has two marks, not four. lib/season.ts splits the year
  // Mar–Aug (green) / Sep–Feb (autumn), so Summer takes the green mark and
  // Winter the autumn one — the same split the calendar already uses.
  summer: "spring",
  winter: "fall",
  contrast: "spring",
  // Funkadelic has no season of its own. It pins the SPRING mark because the
  // palette runs cool — mint, teal, violet — and the green leaf sits in it;
  // the autumn mark's cream ground fights the neon.
  funkadelic: "spring",
  // Coral and apricot carry the chrome, so the autumn mark is the match.
  retro: "fall",
  // Both roasts are warm browns; the autumn mark is the only one that fits.
  coffeehouse: "fall",
  espresso: "fall",
  // Acid yellow and citrus both sit closer to the autumn mark than the green
  // one; Jelly's purples clash with autumn, so it takes the green.
  urban: "fall",
  jelly: "spring",
  juice: "fall",
};

export type SurfaceTokens = {
  "surface.page": string;
  "surface.panel": string;
  "surface.raised": string;
  "surface.subtle": string;
  "surface.inset": string;
  "chrome.header": string;
  /** Second stop of the title bar's vertical gradient. */
  "chrome.headerAlt": string;
  "chrome.headerFg": string;
  "border.default": string;
  "border.emphasis": string;
  "fg.default": string;
  "fg.muted": string;
  "fg.subtle": string;
  "fg.onAccent": string;
  "accent.solid": string;
  "accent.emphasis": string;
  "accent.muted": string;
};

// `fg.muted` and `fg.subtle` are the two secondary inks, and both sat below
// AA: 4.02:1 and 2.26:1 on white, 3.98:1 for subtle on the dark page. They
// were the single largest source of contrast failures in the audit. Now 4.8+
// and 4.5+ against each theme's OWN page colour, with muted kept the darker
// of the two so the hierarchy between them survives. This is the one change
// in the theming work that makes Original differ from what shipped.
// ORIGINAL'S HEADER IS SAGE GREEN, NOT GREY. It shipped as a hardcoded
// `#dce5d0` with a gradient to `#e8eedf`; pointing it at a generic
// `chrome.header` of `#f7fafc` turned the title bar cool white and was the
// most visible difference between dev and production.
export const SURFACES: Record<ThemeId, SurfaceTokens> = {
  original: {
    "surface.page": "#ffffff", "surface.panel": "#ffffff", "surface.raised": "#ffffff",
    "surface.subtle": "#f7fafc", "surface.inset": "#edf2f7",
    "chrome.header": "#dce5d0", "chrome.headerAlt": "#e8eedf", "chrome.headerFg": "#1a202c",
    "border.default": "#e2e8f0", "border.emphasis": "#cbd5e0",
    "fg.default": "#1a202c", "fg.muted": "#647185", "fg.subtle": "#6d7783", "fg.onAccent": "#ffffff",
    "accent.solid": "#3182ce", "accent.emphasis": "#2b6cb0", "accent.muted": "#ebf8ff",
  },
  // Panels sit ABOVE the page, not below — that is what makes depth read dark.
  dark: {
    "surface.page": "#12151a", "surface.panel": "#1a1f27", "surface.raised": "#232933",
    "surface.subtle": "#1f242d", "surface.inset": "#0e1116",
    "chrome.header": "#1a1f27", "chrome.headerAlt": "#232933", "chrome.headerFg": "#e8ecf1",
    "border.default": "#2d3544", "border.emphasis": "#3d4759",
    "fg.default": "#e8ecf1", "fg.muted": "#9aa5b5", "fg.subtle": "#768191", "fg.onAccent": "#0b0e12",
    "accent.solid": "#4a9eff", "accent.emphasis": "#7ab8ff", "accent.muted": "#16283d",
  },
  spring: {
    "surface.page": "#e6f4e0", "surface.panel": "#f8fdf6", "surface.raised": "#ffffff",
    "surface.subtle": "#d8ecd0", "surface.inset": "#c9e3bf",
    "chrome.header": "#386018", "chrome.headerAlt": "#47761f", "chrome.headerFg": "#eaf7e4",
    "border.default": "#aed69f", "border.emphasis": "#8cc077",
    "fg.default": "#1f2e18", "fg.muted": "#5a6b52", "fg.subtle": "#666f60", "fg.onAccent": "#ffffff",
    "accent.solid": "#68b030", "accent.emphasis": "#386018", "accent.muted": "#dff2dc",
  },
  // The rust accent backs off from the logo's #ff6038: that sits between status
  // orange and status red, so a primary button in it reads as a warning.
  fall: {
    "surface.page": "#fbf0d8", "surface.panel": "#fffdf6", "surface.raised": "#ffffff",
    "surface.subtle": "#f7e6bf", "surface.inset": "#f0d9a6",
    "chrome.header": "#883028", "chrome.headerAlt": "#a03c32", "chrome.headerFg": "#fff4dc",
    "border.default": "#ddc48a", "border.emphasis": "#c2a05e",
    "fg.default": "#2e1d18", "fg.muted": "#6b544a", "fg.subtle": "#7b6a64", "fg.onAccent": "#ffffff",
    "accent.solid": "#c2410c", "accent.emphasis": "#883028", "accent.muted": "#ffe8d8",
  },
  // SUMMER — a sand ground under an ocean-teal bar. Warm where Spring is
  // green and Fall is rust, so the four seasons stay distinguishable at a
  // glance. The teal is deepened from a brighter reference until white ink
  // clears AA on both gradient stops.
  summer: {
    "surface.page": "#fff8ea", "surface.panel": "#fffdf7", "surface.raised": "#ffffff",
    "surface.subtle": "#fff2d6", "surface.inset": "#ffe7b8",
    "chrome.header": "#0a6a78", "chrome.headerAlt": "#0e7d84", "chrome.headerFg": "#effbfc",
    "border.default": "#f0d8a4", "border.emphasis": "#d9b46a",
    "fg.default": "#2b1f0a", "fg.muted": "#7a6647", "fg.subtle": "#807054",
    "fg.onAccent": "#ffffff",
    "accent.solid": "#0d7e8d", "accent.emphasis": "#0a6a78", "accent.muted": "#dff3f5",
  },
  // WINTER — deep, cold and BOLD, not a pale wash. Built from a supplied
  // palette: azure #0474c4 · slate #5379ae · teal #2c444c · ice #a8c4ec ·
  // navy #06457f · ink #262b40.
  //
  // The saturated ice is the PAGE, with lighter panels floating on it — the
  // same move Spring makes with its green ground, but pitched much stronger.
  // That is what carries the boldness: a tinted page, not a tinted accent.
  //
  // The header's second stop is deepened from the palette's #0474c4, which
  // gives the bar's ink only 4.30:1.
  winter: {
    "surface.page": "#a8c4ec", "surface.panel": "#e8f0fb", "surface.raised": "#ffffff",
    "surface.subtle": "#93b4e2", "surface.inset": "#7fa3d6",
    "chrome.header": "#06457f", "chrome.headerAlt": "#046ab4", "chrome.headerFg": "#eaf1fb",
    "border.default": "#7fa3d6", "border.emphasis": "#5379ae",
    "fg.default": "#262b40", "fg.muted": "#2f4a6b", "fg.subtle": "#385173",
    "fg.onAccent": "#ffffff",
    "accent.solid": "#0474c4", "accent.emphasis": "#06457f", "accent.muted": "#d5e4f8",
  },
  // RETRO — 80s pastels on slate. The reference palette has exactly ONE dark
  // value (#3d405b), so that becomes the panel and the page goes a shade
  // deeper beneath it; the pastels then work as CHROME rather than as page
  // fills, which is what keeps them from washing out.
  //
  // The header carries dark ink, not white: coral and apricot are light
  // enough that white on them would be unreadable, while #2b2d42 gives 7.7:1
  // and 9.9:1.
  retro: {
    "surface.page": "#2b2d42", "surface.panel": "#3d405b", "surface.raised": "#4a4e6d",
    "surface.subtle": "#343650", "surface.inset": "#222436",
    "chrome.header": "#ffb199", "chrome.headerAlt": "#ffd6a5", "chrome.headerFg": "#2b2d42",
    "border.default": "#545879", "border.emphasis": "#6f74a0",
    "fg.default": "#eef0ff", "fg.muted": "#b9bcd8", "fg.subtle": "#9a9ec2",
    "fg.onAccent": "#2b2d42",
    "accent.solid": "#bdb2ff", "accent.emphasis": "#d4ccff", "accent.muted": "#343a63",
  },
  // COFFEEHOUSE — parchment under an espresso bar. Deliberately browner and
  // quieter than Fall, which is cream under RUST: the two would otherwise
  // read as the same theme twice.
  coffeehouse: {
    "surface.page": "#f7f0e4", "surface.panel": "#fdfaf4", "surface.raised": "#ffffff",
    "surface.subtle": "#efe4d2", "surface.inset": "#e3d4bc",
    "chrome.header": "#3b2418", "chrome.headerAlt": "#5a3a26", "chrome.headerFg": "#f6ece0",
    "border.default": "#ddcbb0", "border.emphasis": "#c0a683",
    "fg.default": "#2a1c12", "fg.muted": "#7d6550", "fg.subtle": "#7d6b58",
    "fg.onAccent": "#ffffff",
    "accent.solid": "#a9622c", "accent.emphasis": "#83491f", "accent.muted": "#f0e0cc",
  },
  // ESPRESSO — the dark roast. Same hues as Coffeehouse, inverted: the browns
  // become the ground and the crema becomes the ink.
  espresso: {
    "surface.page": "#1c1512", "surface.panel": "#2a211b", "surface.raised": "#382c24",
    "surface.subtle": "#241c17", "surface.inset": "#140f0c",
    "chrome.header": "#3d2c21", "chrome.headerAlt": "#513a2b", "chrome.headerFg": "#f2e8dc",
    "border.default": "#4a3a2e", "border.emphasis": "#6b5443",
    "fg.default": "#f2e8dc", "fg.muted": "#b09a86", "fg.subtle": "#96806a",
    "fg.onAccent": "#1c1512",
    "accent.solid": "#c98a4b", "accent.emphasis": "#e0a468", "accent.muted": "#3a2a1c",
  },
  // URBAN — concrete greys with one acid-yellow signal. The palette is
  // almost entirely neutral (#141414 · #444444 · #979797 · #d6d6d6), so the
  // single chromatic value carries the whole identity: it is the ink in the
  // title bar AND the accent, and nothing else competes with it.
  urban: {
    "surface.page": "#141414", "surface.panel": "#232323", "surface.raised": "#2e2e2e",
    "surface.subtle": "#1b1b1b", "surface.inset": "#0a0a0a",
    "chrome.header": "#1a1a1a", "chrome.headerAlt": "#2e2e2e", "chrome.headerFg": "#e2e800",
    // Hard, visible edges — the structure does the work a colour usually
    // would, because there is barely any colour here to do it.
    "border.default": "#4a4a4a", "border.emphasis": "#6e6e6e",
    "fg.default": "#ededed", "fg.muted": "#979797", "fg.subtle": "#7f7f7f",
    "fg.onAccent": "#141414",
    "accent.solid": "#e2e800", "accent.emphasis": "#c3c800", "accent.muted": "#2a2c00",
  },
  // JELLY — orchid and periwinkle. The supplied colours are all light, so the
  // two violets are deepened for the title bar (white on #8866de is 4.20:1)
  // while the bright orchid stays untouched as the accent, carrying dark ink.
  jelly: {
    "surface.page": "#f0ddff", "surface.panel": "#fdf8ff", "surface.raised": "#ffffff",
    "surface.subtle": "#e6cdfb", "surface.inset": "#d8b8f5",
    "chrome.header": "#6f42c9", "chrome.headerAlt": "#7a4fd0", "chrome.headerFg": "#f6ecff",
    "border.default": "#d8b8f5", "border.emphasis": "#b98ee8",
    "fg.default": "#2d1040", "fg.muted": "#5a2a72", "fg.subtle": "#6b3d85",
    "fg.onAccent": "#2d1040",
    "accent.solid": "#dd68e3", "accent.emphasis": "#c44ecb", "accent.muted": "#f7e4fb",
  },
  // JUICE — citrus. Every colour in this palette is too light to carry white
  // text (the best is 2.63:1), so the whole theme runs on DARK ink over warm
  // fills, which is also what makes it read as juice rather than as a
  // warning banner.
  juice: {
    "surface.page": "#fdeec2", "surface.panel": "#fffaed", "surface.raised": "#ffffff",
    "surface.subtle": "#fbe3a4", "surface.inset": "#f2cf7e",
    "chrome.header": "#ff7900", "chrome.headerAlt": "#ffbf00", "chrome.headerFg": "#3d2000",
    "border.default": "#f2cf7e", "border.emphasis": "#e0ab3c",
    "fg.default": "#3d2000", "fg.muted": "#8a5a10", "fg.subtle": "#92631b",
    "fg.onAccent": "#3d2000",
    "accent.solid": "#ffbf00", "accent.emphasis": "#e0a400", "accent.muted": "#fff2cf",
  },
  // FUNKADELIC — neon on deep violet. The one theme that is not trying to be
  // quiet, so it is grounded DARK and lets the colours do the shouting.
  //
  // Reference swatches, lightly tuned to hold against a violet ground:
  //   hot pink #ff1289 · violet #b81fe8 · orange #fa4a08
  //   mint #00f0a5 · teal #4bbdd1
  //
  // The header's pink is deepened to #e20f7a — the reference #ff1289 gives
  // white only 3.68:1, and the title bar carries text at every screen.
  funkadelic: {
    "surface.page": "#150029", "surface.panel": "#22063d", "surface.raised": "#2f0d52",
    "surface.subtle": "#1c0434", "surface.inset": "#0d0018",
    "chrome.header": "#e20f7a", "chrome.headerAlt": "#b81fe8", "chrome.headerFg": "#ffffff",
    "border.default": "#4a1a75", "border.emphasis": "#7b2fc4",
    "fg.default": "#f6e9ff", "fg.muted": "#c9a8e8", "fg.subtle": "#a880d0",
    "fg.onAccent": "#14002e",
    // Mint carries the primary action — it is the brightest thing in the
    // palette (13:1 on the ground) so a button never gets lost in the noise.
    "accent.solid": "#00f0a5", "accent.emphasis": "#00c98a", "accent.muted": "#0a3a2c",
  },
  contrast: {
    "surface.page": "#ffffff", "surface.panel": "#ffffff", "surface.raised": "#ffffff",
    "surface.subtle": "#ffffff", "surface.inset": "#ffffff",
    "chrome.header": "#000000", "chrome.headerAlt": "#000000", "chrome.headerFg": "#ffffff",
    "border.default": "#000000", "border.emphasis": "#000000",
    "fg.default": "#000000", "fg.muted": "#000000", "fg.subtle": "#1a1a1a", "fg.onAccent": "#ffffff",
    "accent.solid": "#0033cc", "accent.emphasis": "#001f7a", "accent.muted": "#ffffff",
  },
};

// ORDER IS THE MENU ORDER, in both the Profile picker and the header chip —
// the three appearance choices first, then the two seasonal ones.
//
// The id stays `original` even though it is LABELLED "Light" (it was
// "Original", then "Normal"): the id is what sits in localStorage and is
// stamped as `data-theme`, so renaming it would silently reset the preference
// of everyone already on it. The label is free to change; the id is not.
export const THEME_IDS: ThemeId[] = [
  "original", "dark", "contrast",
  // Calendar order, so the four read as one set rather than an arbitrary list.
  "spring", "summer", "fall", "winter",
  "funkadelic", "retro", "coffeehouse", "espresso",
  "urban", "jelly", "juice",
];

export const THEME_LABELS: Record<ThemeId, string> = {
  original: "Light", dark: "Dark", contrast: "High contrast",
  spring: "Spring", summer: "Summer", fall: "Fall", winter: "Winter",
  funkadelic: "Funkadelic",
  retro: "Retro",
  coffeehouse: "Coffeehouse", espresso: "Espresso",
  urban: "Urban", jelly: "Jelly", juice: "Juice",
};

export const THEME_DESCRIPTIONS: Record<ThemeId, string> = {
  original: "The standard light appearance. The logo follows the season.",
  dark: "Dark surfaces for low light. The logo follows the season.",
  contrast: "Maximum contrast, no subtle tints. For bright sun or low vision.",
  spring: "The logo's greens across the whole app. Pins the spring mark.",
  summer: "Sand and ocean teal. Pins the spring mark.",
  fall: "Cream and rust, from the autumn mark. Pins the fall mark.",
  winter: "Deep azure and ice. Cold and loud. Pins the fall mark.",
  funkadelic: "Neon on deep violet. Loud on purpose.",
  retro: "Pastel coral and periwinkle on slate. Sunset, 1985.",
  coffeehouse: "Parchment and espresso, with a caramel accent.",
  espresso: "The same roast, served dark.",
  urban: "Concrete and acid yellow. Night in the city.",
  jelly: "Orchid and periwinkle. Soft and sweet.",
  juice: "Citrus — amber, gold and orange peel.",
};

/** `html[...]` not `[...]`: a bare attribute selector ties with Chakra's own
 *  `:root`, so which won came down to emission order. */
export const THEME_CONDITIONS: Record<Exclude<ThemeId, "original">, string> = {
  dark: "html[data-theme=dark] &",
  spring: "html[data-theme=spring] &",
  fall: "html[data-theme=fall] &",
  contrast: "html[data-theme=contrast] &",
  summer: "html[data-theme=summer] &",
  winter: "html[data-theme=winter] &",
  funkadelic: "html[data-theme=funkadelic] &",
  retro: "html[data-theme=retro] &",
  coffeehouse: "html[data-theme=coffeehouse] &",
  espresso: "html[data-theme=espresso] &",
  urban: "html[data-theme=urban] &",
  jelly: "html[data-theme=jelly] &",
  juice: "html[data-theme=juice] &",
};

/** Chakra's OWN token names, mapped onto our surfaces. Without this, nothing
 *  in the app consumes the vocabulary and the themes change nothing on screen. */
const CHAKRA_ALIASES: Record<string, keyof SurfaceTokens> = {
  bg: "surface.page",
  "bg.panel": "surface.panel",
  "bg.subtle": "surface.subtle",
  "bg.muted": "surface.inset",
  "bg.emphasized": "surface.inset",
  fg: "fg.default",
  "fg.muted": "fg.muted",
  "fg.subtle": "fg.subtle",
  border: "border.default",
  "border.muted": "border.default",
  "border.emphasized": "border.emphasis",
};

/**
 * FLAT, deliberately — unlike buildColorPaletteColors, which must nest.
 *
 * These are our own namespaces, so nothing of Chakra's competes with them and
 * a flat dotted key resolves correctly as a PROP, which is how every one of
 * the ~2,000 call sites uses them.
 *
 * The one cost: Chakra emits no `--chakra-colors-fg-muted` VARIABLE for a
 * flat dotted key, so a hand-written `var(--chakra-colors-fg-muted)` resolves
 * to nothing. Nesting fixes that but breaks the bare aliases (`bg`, `fg`,
 * `border`): a node carrying its own `value` hides its children, and a
 * `DEFAULT` child loses to Chakra's own bare token, which has no seasonal
 * conditions — so Spring would take Chakra's white instead of its green.
 *
 * Six call sites wrote the var() spelling; they now use tokens that DO emit
 * variables (the bare aliases, and the gray palette). Prefer the prop form.
 */
export function buildSemanticColors(): Record<string, any> {
  const out: Record<string, any> = {};
  const emit = (name: string, key: keyof SurfaceTokens) => {
    const value = {
      base: SURFACES.original[key], _dark: SURFACES.dark[key],
      _spring: SURFACES.spring[key], _summer: SURFACES.summer[key],
      _fall: SURFACES.fall[key], _winter: SURFACES.winter[key],
      _contrast: SURFACES.contrast[key], _funkadelic: SURFACES.funkadelic[key],
      _retro: SURFACES.retro[key],
      _coffeehouse: SURFACES.coffeehouse[key], _espresso: SURFACES.espresso[key],
      _urban: SURFACES.urban[key], _jelly: SURFACES.jelly[key], _juice: SURFACES.juice[key],
    };
    out[name] = { value };
  };
  for (const key of Object.keys(SURFACES.original) as (keyof SurfaceTokens)[]) emit(key, key);
  for (const [name, key] of Object.entries(CHAKRA_ALIASES)) emit(name, key);
  return out;
}

/** Needed BEFORE React runs — the pre-splash shield paints this. */
export const THEME_PAGE_BG: Record<ThemeId, string> = Object.fromEntries(
  THEME_IDS.map((id) => [id, SURFACES[id]["surface.page"]]),
) as Record<ThemeId, string>;

/**
 * The splash paints BEFORE React and before any Chakra token exists, so it
 * cannot read `fg.default` — it gets these from the boot script as plain CSS
 * variables, same as the page background. Without them the splash was a white
 * card with dark grey type in every theme, so a dark-mode refresh flashed
 * white before the app faded in.
 */
export const THEME_BOOT_FG: Record<ThemeId, string> = Object.fromEntries(
  THEME_IDS.map((id) => [id, SURFACES[id]["fg.default"]]),
) as Record<ThemeId, string>;

export const THEME_BOOT_FG_MUTED: Record<ThemeId, string> = Object.fromEntries(
  THEME_IDS.map((id) => [id, SURFACES[id]["fg.muted"]]),
) as Record<ThemeId, string>;

/**
 * What the BROWSER paints for native controls — date fields, their calendar
 * popups, scrollbars, select menus. None of that reads a CSS variable, so a
 * `<input type="date">` came out white with grey digits on a dark dialog.
 */
export const THEME_COLOR_SCHEME: Record<ThemeId, "light" | "dark"> = {
  original: "light", dark: "dark", spring: "light", fall: "light", contrast: "light",
  summer: "light", winter: "light",
  // Slate-grounded, so native controls follow.
  retro: "dark",
  coffeehouse: "light", espresso: "dark",
  urban: "dark", jelly: "light", juice: "light",
  // Dark-grounded, so native date pickers and scrollbars must follow.
  funkadelic: "dark",
};

export const THEME_STORAGE_KEY = "seedlings_theme";


// ─────────────────────────────────────────────────────────────────────────────
// THE colorPalette FAMILY — subtle / muted / emphasized / solid / fg / contrast.
//
// Chakra ships these as its own semantic tokens, compiled against its own
// `_dark`. Overriding that condition name does not retarget them — they were
// resolved when Chakra's preset was built — so `blue.subtle` stayed pale on a
// dark page. Declaring them here makes them ours.
//
// Light themes keep Chakra's ramp exactly; dark mirrors it, so "subtle" means
// a DEEP tint, which is what subtle has to mean on a dark ground.
// ─────────────────────────────────────────────────────────────────────────────
// `base` must equal what the Original theme actually RENDERS, because it is
// what Spring and Fall are derived from — a base that disagrees with Original
// makes a season read as a redesign rather than a tint. Four of these were
// out of step (yellow.solid, gray.solid, gray.fg, yellow.fg) and were
// corrected against the running app.
// `strong` is the .400 step, which Chakra's scale also lacks — between
// `emphasized` (.300) and `solid` (.600). Without it every `.400` BORDER
// jumped to `solid`, turning a light green hairline (#4ade80) into a dark
// green one (#16a34a) on 30 sites.
//
// `faint` is the .50 step, and it exists because Chakra's semantic scale
// starts at `subtle` (= .100). The app's pale fills were overwhelmingly
// written as `.50`, so mapping them onto `subtle` made 455 surfaces one step
// more saturated than they shipped — visible as the earnings card's yellow,
// the equity blue and the vehicle tiles all reading heavier than production.
const COLOR_PALETTE_FAMILY: Record<string, { base: string; dark: string }> = {
  "gray.faint": { base: "#fafafa", dark: "#15171b" },
  "gray.subtle": { base: "#f4f4f5", dark: "#18181b" },
  "gray.muted": { base: "#e4e4e7", dark: "#27272a" },
  "gray.emphasized": { base: "#d4d4d8", dark: "#3f3f46" },
  "gray.strong": { base: "#a1a1aa", dark: "#56565d" },
  "gray.solid": { base: "#18181b", dark: "#71717a" },
  "gray.fg": { base: "#27272a", dark: "#d4d4d8" },
  "gray.contrast": { base: "#ffffff", dark: "#ffffff" },
  "red.faint": { base: "#fef2f2", dark: "#221012" },
  "red.subtle": { base: "#fee2e2", dark: "#300c0c" },
  "red.muted": { base: "#fecaca", dark: "#511111" },
  "red.emphasized": { base: "#fca5a5", dark: "#991919" },
  "red.strong": { base: "#f87171", dark: "#c02c2c" },
  "red.solid": { base: "#dc2626", dark: "#ef4444" },
  "red.fg": { base: "#991919", dark: "#fca5a5" },
  "red.contrast": { base: "#ffffff", dark: "#ffffff" },
  "orange.faint": { base: "#fff7ed", dark: "#29130f" },
  "orange.subtle": { base: "#ffedd5", dark: "#3b1106" },
  "orange.muted": { base: "#fed7aa", dark: "#6c2710" },
  "orange.emphasized": { base: "#fdba74", dark: "#92310a" },
  "orange.strong": { base: "#fb923c", dark: "#c04f0f" },
  "orange.solid": { base: "#ea580c", dark: "#f97316" },
  "orange.fg": { base: "#92310a", dark: "#fdba74" },
  "orange.contrast": { base: "#ffffff", dark: "#ffffff" },
  "yellow.faint": { base: "#fefce8", dark: "#2c1b0f" },
  "yellow.subtle": { base: "#fef9c3", dark: "#422006" },
  "yellow.muted": { base: "#fef08a", dark: "#713f12" },
  "yellow.emphasized": { base: "#fde047", dark: "#845209" },
  "yellow.strong": { base: "#facc15", dark: "#b27e09" },
  "yellow.solid": { base: "#fde047", dark: "#eab308" },
  "yellow.fg": { base: "#713f12", dark: "#fde047" },
  "yellow.contrast": { base: "#ffffff", dark: "#ffffff" },
  "green.faint": { base: "#f0fdf4", dark: "#0a1f16" },
  "green.subtle": { base: "#dcfce7", dark: "#042713" },
  "green.muted": { base: "#bbf7d0", dark: "#124a28" },
  "green.emphasized": { base: "#86efac", dark: "#116932" },
  "green.strong": { base: "#4ade80", dark: "#199246" },
  "green.solid": { base: "#16a34a", dark: "#22c55e" },
  "green.fg": { base: "#116932", dark: "#86efac" },
  "green.contrast": { base: "#ffffff", dark: "#ffffff" },
  "teal.faint": { base: "#f0fdfa", dark: "#0a1f21" },
  "teal.subtle": { base: "#ccfbf1", dark: "#032726" },
  "teal.muted": { base: "#99f6e4", dark: "#114240" },
  "teal.emphasized": { base: "#5eead4", dark: "#0c5d56" },
  "teal.strong": { base: "#2dd4bf", dark: "#10867a" },
  "teal.solid": { base: "#0d9488", dark: "#14b8a6" },
  "teal.fg": { base: "#0c5d56", dark: "#5eead4" },
  "teal.contrast": { base: "#ffffff", dark: "#ffffff" },
  "blue.faint": { base: "#eff6ff", dark: "#131b34" },
  "blue.subtle": { base: "#dbeafe", dark: "#14204a" },
  "blue.muted": { base: "#bfdbfe", dark: "#1a3478" },
  "blue.emphasized": { base: "#a3cfff", dark: "#173da6" },
  "blue.strong": { base: "#60a5fa", dark: "#275cca" },
  "blue.solid": { base: "#2563eb", dark: "#3b82f6" },
  "blue.fg": { base: "#173da6", dark: "#a3cfff" },
  "blue.contrast": { base: "#ffffff", dark: "#ffffff" },
  "cyan.faint": { base: "#ecfeff", dark: "#0c212a" },
  "cyan.subtle": { base: "#cffafe", dark: "#072a38" },
  "cyan.muted": { base: "#a5f3fc", dark: "#134152" },
  "cyan.emphasized": { base: "#67e8f9", dark: "#0c5c72" },
  "cyan.strong": { base: "#22d3ee", dark: "#09849e" },
  "cyan.solid": { base: "#0891b2", dark: "#06b6d4" },
  "cyan.fg": { base: "#0c5c72", dark: "#67e8f9" },
  "cyan.contrast": { base: "#ffffff", dark: "#ffffff" },
  "purple.faint": { base: "#faf5ff", dark: "#220c39" },
  "purple.subtle": { base: "#f3e8ff", dark: "#2f0553" },
  "purple.muted": { base: "#e9d5ff", dark: "#4a1772" },
  "purple.emphasized": { base: "#d8b4fe", dark: "#641ba3" },
  "purple.strong": { base: "#c084fc", dark: "#8335c9" },
  "purple.solid": { base: "#9333ea", dark: "#a855f7" },
  "purple.fg": { base: "#641ba3", dark: "#d8b4fe" },
  "purple.contrast": { base: "#ffffff", dark: "#ffffff" },
  "pink.faint": { base: "#fdf2f8", dark: "#2e0d1d" },
  "pink.subtle": { base: "#fce7f3", dark: "#45061f" },
  "pink.muted": { base: "#fbcfe8", dark: "#6d0e34" },
  "pink.emphasized": { base: "#f9a8d4", dark: "#a41752" },
  "pink.strong": { base: "#f472b6", dark: "#c42d72" },
  "pink.solid": { base: "#db2777", dark: "#ec4899" },
  "pink.fg": { base: "#a41752", dark: "#f9a8d4" },
  "pink.contrast": { base: "#ffffff", dark: "#ffffff" },
};

// ─── Deriving Spring / Fall / High contrast from the Original column ────────
//
// These three used to reuse Original's value for all sixty palette tokens.
// The chrome was themed and the CONTENTS were not, which is why Original,
// Spring and Fall looked alike: a green page with Original-coloured cards on
// it. Each theme is derived by a stated rule rather than sixty hand-picked
// hexes, so the relationship between themes lives in the code.

type RGB = [number, number, number];

const toRgb = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16),
];
const toHex = (c: RGB): string =>
  "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
/** Move `c` a fraction `t` of the way toward `target`. */
const mix = (c: RGB, target: RGB, t: number): RGB =>
  [0, 1, 2].map((i) => c[i] + (target[i] - c[i]) * t) as RGB;

const relLum = (c: RGB): number => {
  const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratioOnWhite = (c: RGB): number => 1.05 / (relLum(c) + 0.05);

// A SEASON RIDES ON THE NEUTRALS, NOT ON THE STATE COLOURS.
//
// Grey is what most of the app is built from, so tinting grey is what makes
// the whole surface feel like the season. The chromatic hues barely move,
// because in this app they are not decoration — they are workflow state:
// green is pending payment, red is a followup, yellow is an event, purple is
// an announcement. An earlier draft of this pulled every hue toward the
// season's ground at 0.55 and turned `purple.subtle` into grey and
// `red.subtle` into beige; a followup card stopped reading as red. The two
// tables below are the fix, and the split between them is the whole idea.
const NEUTRAL_PULL: Record<string, number> = {
  faint: 0.85,
  strong: 0.3,
  subtle: 0.78, muted: 0.62, emphasized: 0.45, solid: 0.12,
};
const CHROMA_PULL: Record<string, number> = {
  faint: 0.18,
  strong: 0.05,
  subtle: 0.15, muted: 0.1, emphasized: 0.06, solid: 0.03,
};

/** rgb -> hsl and back, so chroma can be pushed without shifting hue. */
function toHsl(c: RGB): [number, number, number] {
  const [r, g, b] = [c[0] / 255, c[1] / 255, c[2] / 255];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0))
    : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, sat, l];
}
function fromHsl(h: number, sat: number, l: number): RGB {
  if (sat === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const pp = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return pp + (q - pp) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return pp + (q - pp) * (2 / 3 - t) * 6;
    return pp;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

// FUNKADELIC derives from the DARK column, not the light one: it is a
// dark-grounded theme, and dark's steps are already known to work as fills
// and inks against a near-black page. What changes is the character —
// neutrals get pulled toward the violet ground so panels read purple rather
// than grey, and every chromatic step gets its chroma pushed so the palette
// glows instead of sitting flat.
function funkadelic(hue: string, step: string, dark: string): string {
  const ground = toRgb(SURFACES.funkadelic["surface.page"]);
  if (hue === "gray") {
    // Neutrals ARE the theme here — a grey panel would break the spell.
    const pull = step === "fg" ? 0.0 : 0.62;
    if (step === "fg") return SURFACES.funkadelic["fg.muted"];
    return toHex(mix(toRgb(dark), ground, pull));
  }
  const [h, sat, l] = toHsl(toRgb(dark));
  // Inks go neon; fills stay dark enough to carry them.
  const boosted = step === "fg"
    ? fromHsl(h, Math.min(1, sat * 1.45 + 0.15), Math.min(0.82, l * 1.12 + 0.06))
    : fromHsl(h, Math.min(1, sat * 1.35 + 0.08), l);
  // Every fill also picks up a little of the ground, so the hues feel like
  // one family rather than ten unrelated neons.
  return toHex(step === "fg" ? boosted : mix(boosted, ground, 0.22));
}

// RETRO is the inverse of Funkadelic's move on the same source. Both start
// from the DARK column because both are dark-grounded, but where Funkadelic
// pushes chroma up, Retro pulls it DOWN and lifts lightness — that is what
// makes a colour read as pastel rather than merely pale.
function retro(hue: string, step: string, dark: string): string {
  const ground = toRgb(SURFACES.retro["surface.page"]);
  if (hue === "gray") {
    if (step === "fg") return SURFACES.retro["fg.muted"];
    return toHex(mix(toRgb(dark), ground, 0.55));
  }
  const [h, sat, l] = toHsl(toRgb(dark));
  const pastel = step === "fg"
    ? fromHsl(h, Math.max(0.28, sat * 0.62), Math.min(0.84, l * 1.15 + 0.1))
    : fromHsl(h, Math.max(0.16, sat * 0.7), l);
  return toHex(step === "fg" ? pastel : mix(pastel, ground, 0.3));
}

// URBAN is deliberately MONOCHROME. Reusing the dark column made it Dark with
// a yellow header — the greys were zinc-tinted and the cards kept their full
// saturation, so it read as the same theme twice.
//
// Here the neutrals go to true grey (concrete, not zinc) and every chromatic
// hue is pulled hard toward grey, leaving the acid accent as the only
// saturated thing on screen. Status hues are muted, NOT removed: red still has
// to read as rejected and green as paid, so the inks keep more of their
// chroma than the fills do.
function urban(hue: string, step: string, dark: string): string {
  if (hue === "gray") {
    if (step === "fg") return SURFACES.urban["fg.muted"];
    const [, , l] = toHsl(toRgb(dark));
    return toHex(fromHsl(0, 0, l));
  }
  const [h, sat, l] = toHsl(toRgb(dark));
  const drained = step === "fg" ? sat * 0.5 : sat * 0.26;
  return toHex(fromHsl(h, drained, l));
}

function seasonal(
  hue: string, step: string, base: string,
  theme: "spring" | "summer" | "fall" | "winter" | "coffeehouse" | "jelly" | "juice",
): string {
  // `contrast` is the ink ON a solid fill (white/black); a season must not
  // touch it or the label stops being legible on its own button.
  if (step === "contrast") return base;
  const ground = toRgb(SURFACES[theme]["surface.page"]);
  const ink = toRgb(SURFACES[theme]["fg.default"]);
  // Text is warmed/cooled toward the season's own body colour so type on a
  // tinted card belongs to the same family as the type beside it.
  if (step === "fg") return toHex(mix(toRgb(base), ink, hue === "gray" ? 0.35 : 0.2));
  const table = hue === "gray" ? NEUTRAL_PULL : CHROMA_PULL;
  return toHex(mix(toRgb(base), ground, table[step] ?? 0.1));
}

// HIGH CONTRAST IS A RULE, NOT A TINT.
//
// Every fill goes white, every ink goes black, and a hue survives only in
// `solid` — darkened until it clears AA on white. That is what makes the
// white-on-solid badges legible: the audit found 151 of them sitting on
// fills far too light to carry white text.
function highContrast(step: string, base: string): string {
  if (step === "faint" || step === "subtle" || step === "muted" || step === "emphasized") return "#ffffff";
  if (step === "fg") return "#000000";
  if (step === "contrast") return "#ffffff";
  let c = toRgb(base);
  for (let i = 0; i < 24 && ratioOnWhite(c) < 4.5; i++) c = mix(c, [0, 0, 0], 0.08);
  return toHex(c);
}

/**
 * NESTED, not flat.
 *
 * The surface builder above returns flat dotted keys ("bg.panel") and those
 * override Chakra's own tokens fine. These do NOT: `gray` / `red` / `blue`
 * are COLOR PALETTE names, and Chakra regenerates a palette's semantic steps
 * from its own ramp after merging user config, so a flat "gray.subtle" key
 * was silently discarded. The symptom was total: every one of these sixty
 * tokens resolved to Chakra's value in every theme, and the only reason the
 * app looked themed at all was the surface tokens. Verified by dumping the
 * emitted CSS rules for --chakra-colors-gray-subtle: before this change the
 * only two rules were Chakra's `:root` and `html[data-theme=dark]`, with no
 * spring rule emitted at all.
 */
// ─── High contrast: the RAW ramp ────────────────────────────────────────
//
// The semantic tokens above only reach code that USES them. Roughly 240
// call sites still name a raw ramp step directly (`bg="orange.500"`,
// `var(--chakra-colors-yellow-400)`), almost always as a solid fill with
// white text on it. Those are correct enough in the other four themes and
// are exactly what keeps High contrast from being high contrast: 25 of the
// 30 mid-ramp steps fail white-text AA, `yellow.400` worst at 1.53:1.
//
// Converting all 240 is the larger and riskier change, and it would still
// miss the next literal someone writes. Overriding the ramp ITSELF, under
// the contrast condition only, fixes every one of them at once and keeps
// working for literals added later. No other theme is touched.
//
// Note this deliberately leaves steps 50-300 alone. A single var serves
// both pale fills and borders, so forcing them white would erase borders
// as readily as it lightened fills. The failures are all mid-ramp.
const CHAKRA_RAMP: Record<string, string> = {
  "blue-400": "#60a5fa",
  "blue-500": "#3b82f6",
  "blue-600": "#2563eb",
  "cyan-400": "#22d3ee",
  "cyan-500": "#06b6d4",
  "cyan-600": "#0891b2",
  "gray-400": "#a1a1aa",
  "gray-500": "#71717a",
  "gray-600": "#52525b",
  "green-400": "#4ade80",
  "green-500": "#22c55e",
  "green-600": "#16a34a",
  "orange-400": "#fb923c",
  "orange-500": "#f97316",
  "orange-600": "#ea580c",
  "pink-400": "#f472b6",
  "pink-500": "#ec4899",
  "pink-600": "#db2777",
  "purple-400": "#c084fc",
  "purple-500": "#a855f7",
  "purple-600": "#9333ea",
  "red-400": "#f87171",
  "red-500": "#ef4444",
  "red-600": "#dc2626",
  "teal-400": "#2dd4bf",
  "teal-500": "#14b8a6",
  "teal-600": "#0d9488",
  "yellow-400": "#facc15",
  "yellow-500": "#eab308",
  "yellow-600": "#ca8a04",
};

/** Darken until WHITE text on this fill clears AA. */
function darkenForWhiteInk(hexValue: string): string {
  let c = toRgb(hexValue);
  for (let i = 0; i < 200 && 1.05 / (relLum(c) + 0.05) < 4.5; i++) {
    c = [c[0] * 0.97, c[1] * 0.97, c[2] * 0.97];
  }
  return toHex(c);
}

/** Unlayered CSS — must outrank every Chakra cascade layer. Injected by
 *  _document, scoped to the contrast theme alone. */
export const CONTRAST_RAMP_CSS = `html[data-theme="contrast"] {\n${Object
  .entries(CHAKRA_RAMP)
  .map(([name, v]) => `  --chakra-colors-${name}: ${darkenForWhiteInk(v)};`)
  .join("\n")}\n}`;

// ─── Pulse tints, per theme ─────────────────────────────────────────────
//
// Every `seedlings-pulse-*` keyframe expands a box-shadow ring and fades it
// to alpha 0. The ring is drawn at ~0.45 alpha OVER the page, so what makes
// it visible is the tint's contrast with that theme's own background — not
// its absolute brightness.
//
// These were hand-written for two themes and every theme added since
// inherited the light values: washed out on the tinted light themes and, on
// the dark-grounded ones, a ring the same luminance as the page behind it.
// Deriving them means a new theme can never silently lose its pulses.
//
// The hue is preserved and only lightness moves, so a red pulse stays red —
// these carry meaning (red is a BLOCK-level compliance stop).
const PULSE_TINTS: Record<string, string> = {
  pink: "#ec4899", orange: "#f97316", blue: "#3b82f6", cyan: "#06b6d4",
  purple: "#9333ea", red: "#dc2626", ghost: "#111827", gray: "#6b7280",
  yellow: "#eab308", green: "#22c55e", instruction: "#ca8a04",
};

/** Push a tint away from the page until the ring reads against it. */
function pulseAgainst(tint: string, page: string): RGB {
  const pageLum = relLum(toRgb(page));
  const goingLighter = pageLum < 0.35;
  const target: RGB = goingLighter ? [255, 255, 255] : [0, 0, 0];
  let c = toRgb(tint);
  const ratio = (a: RGB) => {
    const la = relLum(a), lb = pageLum;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  // 3.2:1 is where a half-transparent ring stops reading as a smudge.
  for (let i = 0; i < 80 && ratio(c) < 3.2; i++) c = mix(c, target, 0.06);
  return c;
}

/** Unlayered CSS: one variable block per theme. Injected by _document. */
export const PULSE_CSS = (() => {
  const blockFor = (theme: ThemeId) =>
    Object.entries(PULSE_TINTS)
      .map(([name, tint]) => {
        const c = pulseAgainst(tint, SURFACES[theme]["surface.page"]);
        return `  --pulse-${name}: ${c.map((v) => Math.round(v)).join(", ")};`;
      })
      .join("\n");
  const out = [`:root {\n${blockFor("original")}\n}`];
  for (const id of THEME_IDS) {
    if (id === "original") continue;
    out.push(`html[data-theme="${id}"] {\n${blockFor(id)}\n}`);
  }
  return out.join("\n");
})();

export function buildColorPaletteColors(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, v] of Object.entries(COLOR_PALETTE_FAMILY)) {
    const [hue, step] = name.split(".");
    // `solid` and `contrast` are a PAIR — a fill and the ink that has to stay
    // legible on it. Chakra tunes both together per theme, so overriding one
    // half breaks the other: lightening the dark `solid` values (right for
    // text, wrong for a fill) put white on `green.solid` at 2.28:1 across 29
    // buttons and badges. In dark we leave that pair alone and let Chakra's
    // own rule apply. High contrast is the one theme that must override it,
    // because there the rule is "legible on WHITE", which Chakra has no
    // reason to guarantee.
    const pairedWithInk = step === "solid" || step === "contrast";
    const value: Record<string, string> = pairedWithInk
      // Chakra owns this pair in every theme but High contrast. Our own
      // `contrast` column is "#ffffff" for all ten hues, which is simply
      // wrong for yellow — Chakra sets yellow's ink to BLACK, because white
      // on yellow cannot be read. Emitting our value under a season put
      // white on `#fce14c` at 1.31:1. High contrast is the exception: there
      // the rule is "legible on white", which Chakra has no reason to meet.
      ? { base: v.base, _contrast: highContrast(step, v.base) }
      : {
          base: v.base,
          _dark: v.dark,
          _spring: seasonal(hue, step, v.base, "spring"),
          _summer: seasonal(hue, step, v.base, "summer"),
          _fall: seasonal(hue, step, v.base, "fall"),
          _winter: seasonal(hue, step, v.base, "winter"),
          _coffeehouse: seasonal(hue, step, v.base, "coffeehouse"),
          _espresso: v.dark,
          _urban: urban(hue, step, v.dark),
          _jelly: seasonal(hue, step, v.base, "jelly"),
          _juice: seasonal(hue, step, v.base, "juice"),
          _contrast: highContrast(step, v.base),
          _funkadelic: funkadelic(hue, step, v.dark),
          _retro: retro(hue, step, v.dark),
        };
    (out[hue] ??= {})[step] = { value };
  }
  return out;
}
