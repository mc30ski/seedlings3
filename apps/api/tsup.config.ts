import { defineConfig } from "tsup";

// Standalone (non-Vercel) build of the API.
//
// Vercel does NOT use this — vercel.json builds `api/index.ts` with
// @vercel/node. This exists for running the API as a plain long-lived Node
// process: `npm run build && npm start`.
//
// History: the previous config pointed at `src/start.ts` / `src/app.ts` /
// `src/index.ts`, all of which were removed when the codebase was
// reorganised in 39c7edb. The config was deleted with them but the `build`
// script kept invoking tsup, so `npm run build` failed with "No input files"
// from that commit onward. Deploys were unaffected, which is why it went
// unnoticed.
export default defineConfig({
  // The one real standalone entry: src/server.ts constructs Fastify and
  // listens. (api/index.ts is the serverless handler and is Vercel's job.)
  entry: ["src/server.ts"],
  platform: "node",
  target: "node20",
  // CJS, not ESM: package.json declares "type": "commonjs", so an ESM build
  // would be emitted as .mjs and `node dist/server.js` would not exist.
  format: ["cjs"],
  sourcemap: true,
  clean: true,
  bundle: true,
  splitting: false,
  shims: false,
  // Leave real dependencies (prisma, fastify, aws-sdk) to node_modules at
  // runtime rather than bundling them.
  skipNodeModulesBundle: true,
  // ...but DO bundle our own workspace packages. They resolve through a
  // node_modules symlink to raw TypeScript, so leaving them external would
  // emit `require("@repo/money")` and Node would choke on the .ts file.
  noExternal: [/^@repo\//],
  env: { NODE_ENV: "production" },
});
