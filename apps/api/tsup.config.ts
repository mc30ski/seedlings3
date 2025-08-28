import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/start.ts"], // 👈 single entry (it pulls in all your routes/plugins)
  platform: "node",
  target: "node20",
  format: ["esm"], // stay ESM
  sourcemap: true,
  clean: true,
  bundle: true, // 👈 bundle your source so no .js suffix drama
  splitting: false, // single file output is simplest
  shims: false,
  skipNodeModulesBundle: true, // keep deps external (prisma, fastify, etc.)
  env: { NODE_ENV: "production" },
});
