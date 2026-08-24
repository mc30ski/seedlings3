// ─────────────────────────────────────────────────────────────────────────────
// Proxy link-wrapper build gate
//
// PURPOSE
// `apps/web/pages/api/_proxy/[...path].ts` sits in front of EVERY API call
// the web app makes — including the invoice load and the client's
// "I paid" self-report. It normally follows redirects server-side, which
// is what an XHR caller wants: the final JSON, not a 3xx.
//
// Two endpoint families are the exception. Promotion click wrappers and
// /mo/ short links exist ONLY to bounce a visitor's browser elsewhere.
// Following their redirect server-side parked the phone on the tracker URL
// while serving HTML rendered for the landing route; Next.js then
// reconciled the mismatch, churning history entries, and the back button
// appeared to reload the promo page until you hammered it.
// `isBrowserLinkWrapper` marks those two families so their 3xx reaches the
// browser instead.
//
// WHAT BREAKS IF THIS GATE IS IGNORED
// Widen that predicate and the matching endpoints STOP following
// redirects — a caller expecting JSON gets a bare 3xx. If it ever grew to
// cover `api/public/pay/...`, the invoice would fail to load and
// self-report would break, on a page that takes real money. That is the
// single worst outcome in this repo, and it is one careless regex away.
//
// So: this gate pins the predicate to exactly the two families, and
// asserts payment/app paths can never match. It is a tripwire on the file
// that once 404'd every production promo link, in front of the payment
// path.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const PROXY = join(REPO_ROOT, "apps/web/pages/api/_proxy/[...path].ts");

/**
 * Mirror of isBrowserLinkWrapper in the proxy.
 *
 * Duplicated rather than imported: this suite runs under apps/api and the
 * proxy is a Next.js page in apps/web with its own module graph. The last
 * test pins the real implementation's source so the two cannot drift.
 */
function isBrowserLinkWrapper(parts: string[]): boolean {
  return /^api\/public\/(promotion\/click|mo)\//.test(parts.join("/"));
}

const p = (s: string) => s.split("/");

describe("proxy link-wrapper build gate", () => {
  it("NEVER matches a payment path", () => {
    // The whole reason this gate exists. Every one of these must keep
    // following redirects server-side.
    const paymentPaths = [
      "api/public/pay/tok",
      "api/public/pay/tok/self-report",
      "api/public/pay/tok/record-intent",
      "api/public/pay/tok/signup-from-page",
      "api/public/pay/tok/promo-opt-in",
    ];
    for (const path of paymentPaths) {
      expect(isBrowserLinkWrapper(p(path)), `${path} must NOT be a link wrapper`).toBe(
        false,
      );
    }
  });

  it("NEVER matches an app or admin path", () => {
    for (const path of [
      "api/me",
      "api/me/policies",
      "api/admin/users",
      "api/super/promotions",
      "api/public/branding",
      "api/public/feed",
      "api/public/stats",
      "api/public/calendar/tok.ics",
      "api/public/promo/opt-out",
      // The landing-page RENDER endpoint is not a wrapper — it returns
      // JSON to getServerSideProps and must keep following redirects.
      "api/public/promotion/some-slug",
    ]) {
      expect(isBrowserLinkWrapper(p(path)), `${path} must NOT be a link wrapper`).toBe(
        false,
      );
    }
  });

  it("matches exactly the two families that redirect a browser", () => {
    for (const path of [
      "api/public/promotion/click/p/abc",
      "api/public/promotion/click/d/abc",
      "api/public/mo/slug",
      "api/public/mo/slug/code",
    ]) {
      expect(isBrowserLinkWrapper(p(path)), `${path} SHOULD be a link wrapper`).toBe(
        true,
      );
    }
  });

  it("is anchored — a lookalike prefix must not slip through", () => {
    for (const path of [
      // Not under api/public/ at all.
      "public/promotion/click/p/abc",
      "api/promotion/click/p/abc",
      // Nested deeper under something else.
      "api/public/x/promotion/click/p/abc",
      // Bare family name with no trailing segment — not a real wrapper URL.
      "api/public/mo",
    ]) {
      expect(isBrowserLinkWrapper(p(path)), `${path} must NOT match`).toBe(false);
    }
  });

  it("the proxy still uses the predicate, and only for the fetch mode", () => {
    // Guards against the predicate being kept while the call site quietly
    // reverts to following everything — a green test protecting nothing,
    // which this repo has been bitten by before.
    const src = readFileSync(PROXY, "utf8");
    expect(src).toContain("isBrowserLinkWrapper(parts)");
    expect(src).toContain("export function isBrowserLinkWrapper");
    // The non-wrapper branch must still follow redirects.
    expect(src).toContain("fetchFollowWithCookie");
  });

  it("the real predicate still matches this gate's mirror", () => {
    // Pins the regex itself. If the implementation changes shape, this
    // fails and forces the mirror above to be updated deliberately.
    const src = readFileSync(PROXY, "utf8");
    expect(src).toContain("/^api\\/public\\/(promotion\\/click|mo)\\//");
  });
});
