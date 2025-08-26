"use client";
import React from "react";
import { ChakraProvider, createSystem, defaultConfig } from "@chakra-ui/react";
import { tokens as ds } from "@repo/tokens";

// Convert your v2-style tokens to v3 token objects { value: ... }
const toTokenObj = (o: Record<string, string | number>) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      { value: typeof v === "number" ? `${v}px` : String(v) },
    ])
  );

// Build the system from your tokens
const system = createSystem(defaultConfig, {
  theme: {
    tokens: {
      colors: {
        brand: Object.fromEntries(
          Object.entries(ds.colors.brand).map(([k, v]) => [k, { value: v }])
        ),
      },
      radii: toTokenObj(ds.radii),
      fonts: {
        body: { value: ds.fonts.body },
        heading: { value: ds.fonts.body },
      },
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return <ChakraProvider value={system}>{children}</ChakraProvider>;
}
