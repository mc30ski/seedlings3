---
name: project-clerk-satellite-hardcoded-hostnames
description: Clerk multi-domain hostnames hardcoded in apps/web/src/lib/clerkDomains.ts — inconsistent with the promo domain design pattern; slated to move to NEXT_PUBLIC_ env vars
metadata:
  node_type: memory
  type: project
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:23:12.364Z
---

Clerk multi-domain setup shipped 2026-08-13 with `PRIMARY_HOSTNAME` and `SATELLITE_HOSTNAMES` hardcoded in `apps/web/src/lib/clerkDomains.ts`, plus a derived `ALL_APP_HOSTNAMES` for the sign-in redirect_url allowlist. Currently: primary = `seedlings.team`, satellites = `seedlings.pro`. Additional planned satellite: `seedlings.promo`.

**Why:** The user (correctly) pointed out this violates the "everything configurable via Settings/env" pattern we agreed on for the promo multi-domain work. Rationale for shipping hardcoded anyway: (a) ClerkProvider needs the hostname list at first render before any API call can complete, (b) sign-in redirect allowlist must ship with the deploy for security (can't be a DB setting that could be tampered with), (c) the user was frustrated with an accumulating stack of incremental fixes and wanted the sign-in flow to stop being broken. Shipping the hardcoded version was the fast path.

**How to apply:** Refactor to NEXT_PUBLIC_ env vars in a small dedicated pass — do NOT bundle with other work.

Suggested shape:
- `NEXT_PUBLIC_APP_PRIMARY_HOST=seedlings.team`
- `NEXT_PUBLIC_APP_SATELLITE_HOSTS=seedlings.pro,seedlings.promo` (comma-separated)

Then `clerkDomains.ts` reads:
```typescript
export const PRIMARY_HOSTNAME = process.env.NEXT_PUBLIC_APP_PRIMARY_HOST ?? "seedlings.team";
export const SATELLITE_HOSTNAMES = new Set(
  (process.env.NEXT_PUBLIC_APP_SATELLITE_HOSTS ?? "").split(",").filter(Boolean),
);
```

Vercel `seedlings3-web` project → Environment Variables → add both. Redeploy. No code change to add a satellite going forward. Consistent with how `WEB_ORIGIN`, `API_BASE_URL`, `CLERK_PUBLISHABLE_KEY` are already configured.

**Do NOT** move to a DB Setting — the security + first-render constraints make that a bad fit. See [[feedback-multi-domain-design-first]] for the process lesson.

The promo domain list is a separate concern and CAN be Setting-based; different tool for different constraint.
