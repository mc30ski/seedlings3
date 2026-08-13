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
