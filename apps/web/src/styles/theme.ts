// components/theme.ts
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
      danger: {
        bg: { base: "red.600", _dark: "red.500" },
        color: "white",
        _hover: { bg: { base: "red.700", _dark: "red.600" } },
        _active: { bg: { base: "red.800", _dark: "red.700" } },
        _focusVisible: { boxShadow: "0 0 0 3px token(colors.red.200)" },
        _disabled: { opacity: 0.6, cursor: "not-allowed" },
      },
      "danger-outline": {
        bg: "transparent",
        borderWidth: "1px",
        borderColor: "red.600",
        color: { base: "red.700", _dark: "red.300" },
        _hover: { bg: { base: "red.50", _dark: "red.900/20" } },
        _active: { bg: { base: "red.100", _dark: "red.900/30" } },
      },
    },
  },
});

const config = defineConfig({
  theme: {
    recipes: {
      button: buttonRecipe, // merges with Chakra's default button recipe
    },
  },
});

export const system = createSystem(defaultConfig, config);
