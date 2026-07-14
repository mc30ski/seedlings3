// ─────────────────────────────────────────────────────────────────────────────
// Sanity check for the CompanyDocument → Google Drive backup feature.
// Exercises the full auth chain end to end BEFORE any sync code exists:
//
//   1. Load the four OAuth env vars from apps/api/.env.
//   2. Exchange refresh_token → short-lived access_token (headless flow
//      the sync worker will do on every run).
//   3. Fetch the target folder's metadata (proves ROOT_FOLDER_ID is
//      valid + we have `drive.file` permission on it — because we
//      created it in this OAuth account's Drive).
//   4. List what's inside (should be empty on first run).
//
// If any step fails, prints a specific error so we can fix it now
// instead of during the sync-worker build.
//
// Usage:
//   npx tsx apps/api/scripts/verify-drive-connectivity.ts
//
// Zero runtime dependencies — same as oauth-drive-consent.ts.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { config as loadDotenv } from "dotenv";
// Load env from apps/api/.env regardless of CWD — so this works whether
// you run from the repo root or from apps/api.
loadDotenv({ path: path.resolve(__dirname, "../.env") });

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}. Check apps/api/.env.`);
    process.exit(1);
  }
  return v;
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as any;
  if (!res.ok) {
    const detail = json.error_description ?? json.error ?? JSON.stringify(json);
    if (json.error === "invalid_grant") {
      throw new Error(
        `invalid_grant — refresh token has been revoked, expired, or the client_secret changed.\n` +
          `Fix: re-run apps/api/scripts/oauth-drive-consent.ts to issue a fresh refresh token.\n` +
          `Details: ${detail}`,
      );
    }
    throw new Error(`Token refresh failed (${res.status}): ${detail}`);
  }
  return json.access_token as string;
}

async function driveGet(accessToken: string, path: string, query?: Record<string, string>) {
  const url = new URL(`${DRIVE_API}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json()) as any;
  if (!res.ok) {
    const detail = json.error?.message ?? JSON.stringify(json);
    throw new Error(`Drive API ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

async function main() {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN");
  const rootFolderId = requireEnv("GOOGLE_DRIVE_ROOT_FOLDER_ID");

  console.log("Step 1/4  Loading env vars from apps/api/.env  ✅");

  console.log("Step 2/4  Exchanging refresh_token for access_token...");
  const accessToken = await refreshAccessToken(clientId, clientSecret, refreshToken);
  console.log("           access_token acquired (length " + accessToken.length + ")  ✅");

  console.log("Step 3/4  Fetching folder metadata for GOOGLE_DRIVE_ROOT_FOLDER_ID...");
  const meta = await driveGet(accessToken, `/files/${rootFolderId}`, {
    fields: "id,name,mimeType,owners(emailAddress),createdTime",
  });
  if (meta.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error(
      `GOOGLE_DRIVE_ROOT_FOLDER_ID (${rootFolderId}) points to a ${meta.mimeType}, not a folder.`,
    );
  }
  const ownerEmail = meta.owners?.[0]?.emailAddress ?? "(unknown)";
  console.log(`           folder id:    ${meta.id}`);
  console.log(`           folder name:  ${meta.name}`);
  console.log(`           owner:        ${ownerEmail}`);
  console.log(`           created:      ${meta.createdTime}`);
  console.log(`           ✅`);

  console.log("Step 4/4  Listing folder contents...");
  const list = await driveGet(accessToken, `/files`, {
    q: `'${rootFolderId}' in parents and trashed=false`,
    fields: "files(id,name,mimeType)",
    pageSize: "20",
  });
  const files = (list.files ?? []) as { id: string; name: string; mimeType: string }[];
  if (files.length === 0) {
    console.log("           (empty — expected on first run)  ✅");
  } else {
    console.log(`           ${files.length} entr${files.length === 1 ? "y" : "ies"}:`);
    for (const f of files) console.log(`             - ${f.name}  [${f.mimeType}]`);
    console.log("           ✅");
  }

  console.log("\n🎉 All checks passed. Auth chain is working end to end.");
  console.log("   Ready to start building the sync worker.");
}

main().catch((err) => {
  console.error("\n❌ Verification failed.");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
