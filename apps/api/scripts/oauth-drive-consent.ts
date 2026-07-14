// ─────────────────────────────────────────────────────────────────────────────
// One-shot OAuth consent flow for the CompanyDocument → Google Drive backup
// feature. Run this ONCE (per environment) to obtain a long-lived refresh
// token for admin@seedlingslawncare.com's Drive.
//
// Usage:
//   npx tsx apps/api/scripts/oauth-drive-consent.ts <path-to-client_secret.json>
//
// Where <path-to-client_secret.json> is the file downloaded when the OAuth
// 2.0 Client ID was created in Google Cloud Console → Google Auth Platform →
// Clients. The file must be a Desktop-app OAuth client.
//
// What happens:
//   1. Start a temporary HTTP server on loopback port 3737.
//   2. Print the Google consent URL and try to open it in your browser.
//   3. You sign in as admin@seedlingslawncare.com and approve the scope.
//   4. Google redirects back to http://127.0.0.1:3737/callback with a
//      one-shot authorization code.
//   5. This script exchanges the code for tokens and prints the
//      refresh_token to stdout.
//   6. Server shuts down.
//
// The printed refresh_token then goes into apps/api/.env (dev) and Vercel
// env vars (prod) as GOOGLE_OAUTH_REFRESH_TOKEN. See docs/features/
// documents-gdrive-backup.md for full context.
//
// Zero runtime dependencies — uses only Node built-ins so it can run
// before `npm install` gets `googleapis` added.
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const PORT = 3737;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/drive";
const AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

type ClientSecretFile = {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
};

function loadClientSecret(path: string): { clientId: string; clientSecret: string } {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as ClientSecretFile;
  const creds = parsed.installed ?? parsed.web;
  if (!creds?.client_id || !creds?.client_secret) {
    throw new Error(
      `Could not find client_id / client_secret in ${path}. Expected a Google Cloud OAuth client JSON file with an "installed" or "web" root key.`,
    );
  }
  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

function openInBrowser(url: string): void {
  // macOS `open`. On Linux/Windows we'd need `xdg-open` / `start` — user
  // can also copy the URL from stdout if the auto-open doesn't work.
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.log("\nCouldn't auto-open a browser. Copy this URL and paste it in your browser:\n");
    console.log(url);
    console.log("");
  });
  child.unref();
}

async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${errText}`);
  }
  return (await res.json()) as any;
}

async function main() {
  const clientSecretPath = process.argv[2];
  if (!clientSecretPath) {
    console.error("Usage: tsx apps/api/scripts/oauth-drive-consent.ts <path-to-client_secret.json>");
    process.exit(1);
  }

  const { clientId, clientSecret } = loadClientSecret(clientSecretPath);

  // CSRF protection — the state parameter must round-trip. If Google
  // sends back a different value, something is wrong and we abort.
  const stateNonce = randomBytes(16).toString("hex");

  const authUrl = new URL(AUTH_URI);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPE);
  // access_type=offline is what triggers Google to issue a refresh_token
  // in addition to the access_token. Without this we'd only get a
  // short-lived access token and the whole exercise fails.
  authUrl.searchParams.set("access_type", "offline");
  // prompt=consent forces a fresh refresh_token even if this Google
  // account has already consented to this OAuth client before (Google
  // otherwise re-issues the previous refresh_token which may not be in
  // hand). Belt + suspenders for the one-shot flow.
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", stateNonce);

  // Set up the loopback server BEFORE opening the browser so we don't
  // race the redirect.
  const server = createServer(async (req, res) => {
    if (!req.url) return;
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end("Not found");
      return;
    }

    const returnedState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" }).end(
        `<h1>OAuth error</h1><p>${escapeHtml(error)}</p><p>You can close this tab.</p>`,
      );
      console.error(`\nOAuth error from Google: ${error}`);
      cleanup(1);
      return;
    }

    if (returnedState !== stateNonce) {
      res.writeHead(400, { "Content-Type": "text/html" }).end(
        "<h1>State mismatch</h1><p>Aborting. Re-run the script.</p>",
      );
      console.error("\nState nonce mismatch — possible CSRF attempt. Aborting.");
      cleanup(1);
      return;
    }

    if (!code) {
      res.writeHead(400).end("Missing code");
      cleanup(1);
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens(clientId, clientSecret, code);
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        "<h1>Success</h1><p>Refresh token issued. You can close this tab and return to the terminal.</p>",
      );

      console.log("\n" + "─".repeat(72));
      if (!tokens.refresh_token) {
        console.error(
          "No refresh_token in the response. This usually means this Google account\n" +
            "has already consented to this OAuth client and prompt=consent was ignored\n" +
            "for some reason. Try revoking access at\n" +
            "https://myaccount.google.com/permissions and re-running.",
        );
        cleanup(1);
        return;
      }
      console.log("✅ Refresh token issued successfully.\n");
      console.log(`Scope granted:   ${tokens.scope}`);
      console.log(`Access expires:  ${tokens.expires_in}s from now (this is the short-lived one)`);
      console.log("");
      console.log("Add this to your .env (dev) and Vercel env vars (prod):");
      console.log("");
      console.log(`GOOGLE_OAUTH_CLIENT_ID=${clientId}`);
      console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}`);
      console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log("");
      console.log("─".repeat(72));
      cleanup(0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(500).end(`<h1>Token exchange failed</h1><pre>${escapeHtml(msg)}</pre>`);
      console.error(`\nToken exchange failed: ${msg}`);
      cleanup(1);
    }
  });

  const cleanup = (exitCode: number) => {
    server.close(() => process.exit(exitCode));
  };

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Consent server listening on ${REDIRECT_URI}`);
    console.log("Opening your browser to Google's consent screen...");
    console.log("");
    console.log("If the browser doesn't open automatically, copy this URL:");
    console.log(authUrl.toString());
    console.log("");
    console.log("Sign in as admin@seedlingslawncare.com and approve.");
    openInBrowser(authUrl.toString());
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
