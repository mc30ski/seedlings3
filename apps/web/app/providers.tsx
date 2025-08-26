"use client";
import { ChakraProvider, createSystem, defaultConfig } from "@chakra-ui/react";
import { tokens } from "@repo/tokens";
const toTokenObj = (o: Record<string, string | number>) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      { value: typeof v === "number" ? `${v}px` : String(v) },
    ])
  );
const system = createSystem(defaultConfig, {
  theme: {
    tokens: {
      colors: {
        brand: Object.fromEntries(
          Object.entries(tokens.colors.brand).map(([k, v]) => [k, { value: v }])
        ),
      },
      radii: toTokenObj(tokens.radii),
      fonts: {
        body: { value: tokens.fonts.body },
        heading: { value: tokens.fonts.body },
      },
    },
  },
});
export function Providers({ children }: { children: React.ReactNode }) {
  return <ChakraProvider value={system}>{children}</ChakraProvider>;
}
