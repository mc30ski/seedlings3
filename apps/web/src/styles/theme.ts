// components/theme.ts
import { THEME_CONDITIONS, buildSemanticColors, buildColorPaletteColors } from "@/src/styles/themeTokens";
import {
  createSystem,
  defaultConfig,
  defineConfig,
  defineRecipe,
} from "@chakra-ui/react";

const buttonRecipe = defineRecipe({
  variants: {
    // extend the existing "variant" variants
    variant: {
      // `colorPalette.fg` rather than a flat `fg`, so a plain Cancel follows
      // gray while a red ghost "Delete" stays red — in every theme.
      ghost: { color: "colorPalette.fg" },
      outline: { color: "colorPalette.fg" },
      // SEMANTIC TOKENS, not `{ base, _dark }` pairs of raw ramp values.
      //
      // The pair form only knows two worlds, light and `_dark`. Every theme
      // that is dark-GROUNDED without being the Dark theme — Funkadelic,
      // Retro, Espresso, Urban — fell through to `base`, so "Delete" rendered
      // as a dark red on a dark page at 1.26:1. The semantic steps resolve in
      // all fourteen themes, including any added later.
      danger: {
        bg: "red.solid",
        color: "red.contrast",
        _hover: { bg: "red.emphasized" },
        _active: { bg: "red.emphasized" },
        _focusVisible: { boxShadow: "0 0 0 3px token(colors.red.emphasized)" },
        _disabled: { opacity: 0.6, cursor: "not-allowed" },
      },
      "danger-outline": {
        bg: "transparent",
        borderWidth: "1px",
        borderColor: "red.emphasized",
        color: "red.fg",
        _hover: { bg: "red.subtle" },
        _active: { bg: "red.muted" },
      },
    },
  },
});

// THEMES — see styles/themeTokens.ts for the vocabulary and reasoning.
// `original` is the BASE (no attribute on the root); every other theme is a
// condition, which keeps the default path byte-identical to before.
const config = defineConfig({
  conditions: {
    dark: THEME_CONDITIONS.dark,
    spring: THEME_CONDITIONS.spring,
    fall: THEME_CONDITIONS.fall,
    contrast: THEME_CONDITIONS.contrast,
    summer: THEME_CONDITIONS.summer,
    winter: THEME_CONDITIONS.winter,
    funkadelic: THEME_CONDITIONS.funkadelic,
    retro: THEME_CONDITIONS.retro,
    coffeehouse: THEME_CONDITIONS.coffeehouse,
    espresso: THEME_CONDITIONS.espresso,
    urban: THEME_CONDITIONS.urban,
    jelly: THEME_CONDITIONS.jelly,
    juice: THEME_CONDITIONS.juice,
  },
  theme: {
    recipes: {
      button: buttonRecipe, // merges with Chakra's default button recipe
    },
    semanticTokens: {
      colors: { ...buildSemanticColors(), ...buildColorPaletteColors() },
    },
  },
  globalCss: {
    // Without this the body keeps whatever Chakra's reset painted and a dark
    // theme shows white behind every scroll bounce.
    "html, body": {
      background: "surface.page",
      color: "fg.default",
    },
  },
});

export const system = createSystem(defaultConfig, config);
