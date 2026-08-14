// Clerk multi-domain (primary + satellites) configuration.
//
// The app runs on the same Vercel project across multiple custom domains
// (seedlings.team, seedlings.pro, and possibly more later). Clerk's auth
// state lives on the primary domain's cookies; satellite domains render
// the same app but must redirect to the primary for sign-in, then bounce
// back via `?__clerk_synced=true` so the session is shared.
//
// See: https://clerk.com/docs/deployments/set-up-satellite-application
//
// This module centralizes the primary/satellite hostname list so every
// place that needs to make a domain-aware decision (ClerkProvider config,
// sign-in page redirect, future satellite-specific routing) reads from
// the same source of truth.
//
// PRIMARY_HOSTNAME: hostname of the domain where Clerk's Primary is
// configured (matches Clerk dashboard → Configure → Domains → Primary).
// SATELLITE_HOSTNAMES: every other hostname that renders the app under
// satellite semantics — these MUST be added as Satellites in the Clerk
// dashboard first, with the required CNAME record on their DNS.
//
// Localhost, preview deployments, and www.seedlings.team (which 307s
// to the apex before the app even loads) all fall through to primary
// behavior — which is what we want.

export const PRIMARY_HOSTNAME = "seedlings.team";
export const SATELLITE_HOSTNAMES = new Set<string>(["seedlings.pro"]);

export function isSatelliteHost(hostname: string): boolean {
  return SATELLITE_HOSTNAMES.has(hostname);
}

// Absolute URL for the primary's sign-in page — used both by
// ClerkProvider's signInUrl prop and by the sign-in page's own redirect
// when it detects it's rendering on a satellite (Clerk rejects
// signIn.create() on satellite domains — auth MUST happen on primary).
export const PRIMARY_SIGN_IN_URL = `https://${PRIMARY_HOSTNAME}/sign-in`;

// Full list of hostnames the app is served on, including www variants.
// Used by resolvePostSignInRedirect below to allowlist the redirect_url
// query param — prevents an open-redirect vulnerability where a malicious
// link like `/sign-in?redirect_url=https://evil.com` would bounce users
// to an attacker-controlled site immediately after they authenticate.
const ALL_APP_HOSTNAMES = new Set<string>([
  PRIMARY_HOSTNAME,
  `www.${PRIMARY_HOSTNAME}`,
  ...Array.from(SATELLITE_HOSTNAMES).flatMap((h) => [h, `www.${h}`]),
]);

// Resolve where to send the user after a successful sign-in.
//
// Priority:
//   1. `redirect_url` query param — used when the sign-in flow was
//      initiated from a satellite (satellite /sign-in redirects to
//      primary with `?redirect_url=<satellite-URL>` so we can bounce
//      the user back to their original context).
//   2. Fallback to "/" (the same-origin app root).
//
// The redirect_url is allowlisted against our own hostnames so an
// attacker can't craft `/sign-in?redirect_url=https://evil.com` and
// piggyback our auth flow to phish a signed-in user. Any host outside
// ALL_APP_HOSTNAMES falls back to "/". Malformed URLs also fall back.
//
// Returns a same-origin relative path ("/") when the redirect target
// is the current origin, and an absolute URL otherwise — this way the
// browser only initiates a cross-origin navigation when we're truly
// bouncing back to a satellite from the primary.
export function resolvePostSignInRedirect(): string {
  if (typeof window === "undefined") return "/";
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("redirect_url");
  if (!raw) return "/";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "/";
    if (!ALL_APP_HOSTNAMES.has(parsed.hostname)) return "/";
    // Same-origin → strip the origin so we do an in-app navigation
    // (preserves any middleware / router state the SPA depends on).
    if (parsed.origin === window.location.origin) {
      return parsed.pathname + parsed.search + parsed.hash || "/";
    }
    return parsed.toString();
  } catch {
    return "/";
  }
}
