import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/start.ts", "src/app.ts", "src/index.ts"],
  platform: "node",
  target: "node20",
  format: ["esm"],
  sourcemap: true,
  clean: true,
  bundle: true,
  splitting: false,
  shims: false,
  skipNodeModulesBundle: true,
  env: { NODE_ENV: "production" },
});
