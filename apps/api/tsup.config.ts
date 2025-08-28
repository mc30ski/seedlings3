import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/start.ts"], // pulls in routes/plugins/services/etc.
  platform: "node",
  target: "node20",
  format: ["esm"],
  sourcemap: true,
  clean: true,
  bundle: true,
  splitting: false, // single file output (simplest for Cloud Run)
  shims: false,
  skipNodeModulesBundle: true, // keep external deps in node_modules
});
