// Vanity URL service — pure-logic invariants (no DB touch). Tests
// the validators + reserved-slug guard that both the service and the
// frontend editor rely on. Route-layer + DB-touching behavior is
// covered by scenario tests (below).
//
// If a test breaks, the fix is almost never to relax the assertion —
// the reserved-slug list encodes routes that would silently be
// overshadowed by a vanity page, and the slug format encodes what's
// safe in a URL path without escaping.

import { describe, it, expect } from "vitest";
import {
  isValidSlugFormat,
  isReservedSlug,
  RESERVED_SLUGS,
} from "./vanityPages";

describe("isValidSlugFormat — URL-safe kebab-case", () => {
  it("accepts single lowercase word", () => {
    expect(isValidSlugFormat("perties")).toBe(true);
    expect(isValidSlugFormat("motions")).toBe(true);
  });

  it("accepts multi-word kebab-case", () => {
    expect(isValidSlugFormat("fall-offers")).toBe(true);
    expect(isValidSlugFormat("fall-offers-2026")).toBe(true);
  });

  it("accepts digits", () => {
    expect(isValidSlugFormat("2026")).toBe(true);
    expect(isValidSlugFormat("a1b2c3")).toBe(true);
  });

  it("rejects uppercase", () => {
    expect(isValidSlugFormat("Perties")).toBe(false);
    expect(isValidSlugFormat("FALL")).toBe(false);
  });

  it("rejects leading hyphen", () => {
    expect(isValidSlugFormat("-perties")).toBe(false);
  });

  it("rejects trailing hyphen", () => {
    expect(isValidSlugFormat("perties-")).toBe(false);
  });

  it("accepts double hyphens and underscores in the middle", () => {
    // URL-safe characters — allowed anywhere between the first and
    // last character. The only positional restriction is on the
    // leading/trailing character (must be alphanumeric).
    expect(isValidSlugFormat("fall--offers")).toBe(true);
    expect(isValidSlugFormat("fall_offers")).toBe(true);
    expect(isValidSlugFormat("vide_feedback")).toBe(true);
    expect(isValidSlugFormat("fall__offers")).toBe(true);
    expect(isValidSlugFormat("fall-_-offers")).toBe(true);
  });

  it("rejects leading/trailing underscore", () => {
    expect(isValidSlugFormat("_perties")).toBe(false);
    expect(isValidSlugFormat("perties_")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidSlugFormat("")).toBe(false);
  });

  it("rejects strings longer than 40 chars", () => {
    expect(isValidSlugFormat("a".repeat(40))).toBe(true);
    expect(isValidSlugFormat("a".repeat(41))).toBe(false);
  });

  it("rejects spaces and special chars", () => {
    expect(isValidSlugFormat("fall offers")).toBe(false);
    expect(isValidSlugFormat("fall.offers")).toBe(false);
    expect(isValidSlugFormat("fall/offers")).toBe(false);
    expect(isValidSlugFormat("fall?offers")).toBe(false);
  });

  it("rejects non-ASCII", () => {
    expect(isValidSlugFormat("perties🎉")).toBe(false);
    expect(isValidSlugFormat("naïve")).toBe(false);
  });
});

describe("isReservedSlug — blocks paths owned by Next.js or the app", () => {
  it("blocks app routes", () => {
    expect(isReservedSlug("sign-in")).toBe(true);
    expect(isReservedSlug("opt-out")).toBe(true);
    expect(isReservedSlug("pay")).toBe(true);
    expect(isReservedSlug("promotion")).toBe(true);
  });

  it("blocks infrastructure paths", () => {
    expect(isReservedSlug("api")).toBe(true);
    expect(isReservedSlug("_next")).toBe(true);
    expect(isReservedSlug("favicon.ico")).toBe(true);
    expect(isReservedSlug("robots.txt")).toBe(true);
    expect(isReservedSlug("sitemap.xml")).toBe(true);
  });

  it("blocks admin-adjacent paths", () => {
    expect(isReservedSlug("admin")).toBe(true);
    expect(isReservedSlug("super")).toBe(true);
    expect(isReservedSlug("vanity")).toBe(true);
  });

  it("blocks future promo short-URL prefix", () => {
    // /mo/CODE/SLUG is the planned Phase 2 promo click URL shape.
    // Reserving now prevents someone from claiming "mo" as a vanity
    // slug and shadowing the future route.
    expect(isReservedSlug("mo")).toBe(true);
  });

  it("is case-insensitive (defense in depth)", () => {
    // isValidSlugFormat already rejects uppercase, but if a row got
    // into the DB with mixed case somehow, the reserved check should
    // still fire.
    expect(isReservedSlug("Sign-In")).toBe(true);
    expect(isReservedSlug("API")).toBe(true);
  });

  it("allows non-reserved slugs", () => {
    expect(isReservedSlug("perties")).toBe(false);
    expect(isReservedSlug("fessional")).toBe(false);
    expect(isReservedSlug("book")).toBe(false);
    expect(isReservedSlug("call")).toBe(false);
  });
});

describe("RESERVED_SLUGS — the actual set (frontend mirror must match)", () => {
  it("contains every expected reserved path", () => {
    const expected = [
      "sign-in",
      "opt-out",
      "pay",
      "promotion",
      "api",
      "mo",
      "_next",
      "favicon.ico",
      "robots.txt",
      "sitemap.xml",
      "vanity",
      "admin",
      "super",
    ];
    for (const s of expected) {
      expect(RESERVED_SLUGS.has(s)).toBe(true);
    }
  });

  it("has the exact expected size", () => {
    // Locks the set — any addition/removal forces a corresponding
    // update to the frontend's mirror list in [vanitySlug].tsx +
    // VanityUrlsTab.tsx. Bump this number when adding a new reserved
    // slug and update both frontend files in the same commit.
    expect(RESERVED_SLUGS.size).toBe(13);
  });
});
