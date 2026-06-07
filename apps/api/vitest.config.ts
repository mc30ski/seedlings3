import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Vitest config for the API package. The build gate cross-imports the
// web canonical helpers (`apps/web/src/lib/lib.ts`) so we can lock them
// in with unit tests the same way we lock in the API helpers. Allow
// resolution outside the package root via an explicit alias.
export default defineConfig({
  test: {
    // Allow scanning files outside the package's src/ — needed by the
    // date-handling build-gate scan and by the web-helpers test below.
    server: { deps: { inline: [/apps\/web\/src\/lib/] } },
  },
  resolve: {
    alias: {
      "@web-lib": resolve(__dirname, "../web/src/lib"),
      // The web package's internal aliases — needed because the web
      // helpers we import here reference siblings via `@/src/*`.
      "@/src": resolve(__dirname, "../web/src"),
    },
  },
});
