import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readPackageVersion(): string {
  try {
    // points to apps/api/package.json in both dev (tsx) and prod (dist)
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const json = JSON.parse(raw);
    return typeof json.version === "string" ? json.version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

function detectCommit(): string | null {
  // Common CI/CD providers expose one of these:
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.FLY_COMMIT_SHA ||
    process.env.SOURCE_VERSION || // Heroku
    process.env.HEROKU_SLUG_COMMIT ||
    process.env.GIT_COMMIT ||
    process.env.COMMIT_SHA ||
    null
  );
}

function detectBuildTime(): string | null {
  // Prefer explicit env if you set it in CI, otherwise fall back to dist mtime or null
  if (process.env.BUILD_TIME) return process.env.BUILD_TIME;
  try {
    // Try the compiled entry as a proxy for build time
    const distStart = path.resolve(__dirname, "../start.js");
    const s = fs.statSync(distStart);
    return s.mtime.toISOString();
  } catch {
    return null;
  }
}

const versionInfo = {
  name: process.env.APP_NAME || "@repo/api",
  env: process.env.NODE_ENV || "development",
  version: readPackageVersion(),
  commit: detectCommit(),
  buildTime: detectBuildTime(), // ISO string or null
  startedAt: new Date().toISOString(), // updates each deploy/restart
  node: process.version,
};

export function getVersionInfo() {
  return versionInfo;
}
