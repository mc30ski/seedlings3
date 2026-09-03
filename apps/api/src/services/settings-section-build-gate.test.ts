// ─────────────────────────────────────────────────────────────────────────────
// Settings section build gate
//
// PURPOSE
// The Settings tab groups rows by the `section` column, which is stamped from
// SETTING_SECTIONS in prisma/seed.ts. A setting whose key is missing from that
// map gets `section = null` and silently falls into the "Other" catch-all.
//
// Nothing breaks, which is exactly the problem: the setting still works, still
// saves, and still reads — it just sits in a junk drawer at the bottom of the
// page where the operator has to hunt for it. Discovered 2026-09-02 with seven
// settings sitting in "Other" across three features, by two different routes:
// five had no section at all, and two had `section = "vanity"` — a section the
// web app never defined, so they fell through to "Other" anyway while looking
// perfectly well-filed in the database.
//
// The shape of the mistake is always the same: a new setting gets added to the
// code that READS it and the seed row that CREATES it, but not the map that
// FILES it. Three places, and only two of them fail loudly when you forget.
//
// WHAT THIS GATE REQUIRES
//   1. Every setting key seeded by seed.ts appears in SETTING_SECTIONS.
//   2. Every key in a service-level settings map (PARCEL_SETTINGS) does too.
//   3. Every section NAME used in SETTING_SECTIONS is a real section defined
//      in the web's settingSections.ts — a typo'd section ("payment" for
//      "payments") also lands the row in "Other", just less obviously.
//
// Runtime-generated settings (promo HMAC secrets, vanity bookkeeping) are out
// of scope: they are machine-managed, not operator-facing, and are listed in
// RUNTIME_GENERATED below with a reason.
//
// WIRED VIA `test:build-gate` in package.json + turbo build.dependsOn test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SEED_SRC = readFileSync(join(REPO_ROOT, "apps/api/prisma/seed.ts"), "utf8");
const PARCELS_SRC = readFileSync(join(REPO_ROOT, "apps/api/src/services/parcels.ts"), "utf8");
const WEB_SECTIONS_SRC = readFileSync(
  join(REPO_ROOT, "apps/web/src/lib/settingSections.ts"),
  "utf8",
);

/** The `KEY: "section"` pairs in seed.ts's SETTING_SECTIONS map. */
function settingSectionMap(): Map<string, string> {
  const start = SEED_SRC.indexOf("const SETTING_SECTIONS");
  const end = SEED_SRC.indexOf("async function applySettingSections");
  const block = SEED_SRC.slice(start, end);
  const out = new Map<string, string>();
  for (const m of block.matchAll(/^\s+([A-Za-z0-9_]+):\s*"([a-z_]+)",/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Setting keys seed.ts actually writes.
 *
 * Two levels of scoping, both necessary:
 *   • Only the settings-seeding region (from `const feeSettings = [` to the
 *     applySettingSections call), so `key:` fields on Supply rows and other
 *     models earlier in the file are out of range.
 *   • Only `key:` immediately followed by `value:`, which is the shape of a
 *     Setting row. Taxonomy VALUES are themselves arrays of `{ key, label }`
 *     objects — payment methods, equipment kinds, service types, document
 *     types — and matching those would flag forty phantom "settings" that
 *     are really just entries inside one setting's JSON.
 */
function seededSettingKeys(): string[] {
  const start = SEED_SRC.indexOf("const feeSettings = [");
  const end = SEED_SRC.indexOf("await applySettingSections()");
  const block = SEED_SRC.slice(start, end);
  const re = /key:\s*"([A-Z][A-Z0-9_]*)",\s*(?:\/\/[^\n]*\n\s*)*value:/g;
  return [...new Set([...block.matchAll(re)].map((m) => m[1]))];
}

/** Keys of the PARCEL_SETTINGS map the parcel service reads its defaults from. */
function parcelSettingKeys(): string[] {
  const block = PARCELS_SRC.slice(PARCELS_SRC.indexOf("PARCEL_SETTINGS"));
  return [...new Set([...block.matchAll(/^ {2}(PARCEL_[A-Z0-9_]+):/gm)].map((m) => m[1]))];
}

/** Section keys the web app knows how to render a heading for. */
function webSectionKeys(): Set<string> {
  const start = WEB_SECTIONS_SRC.indexOf("export const SETTING_SECTIONS");
  const block = WEB_SECTIONS_SRC.slice(start);
  return new Set([...block.matchAll(/key:\s*"([a-z_]+)"/g)].map((m) => m[1]));
}

/**
 * Settings created at RUNTIME rather than seeded — machine-managed values the
 * operator never edits by hand. They legitimately carry no section.
 */
const RUNTIME_GENERATED = new Set<string>([
  // Auto-generated HMAC secret for promo link signing (services/promotions.ts).
  "PROMO_LINK_HMAC_KEY",
]);

describe("settings section build gate", () => {
  it("every seeded setting key has a section", () => {
    const map = settingSectionMap();
    const missing = seededSettingKeys().filter(
      (k) => !map.has(k) && !RUNTIME_GENERATED.has(k),
    );
    expect(
      missing,
      `These settings are seeded but absent from SETTING_SECTIONS in prisma/seed.ts, ` +
        `so they land in the "Other" catch-all at the bottom of the Settings tab:\n` +
        missing.map((k) => `  - ${k}`).join("\n") +
        `\n\nAdd each one to the map with the section it belongs in.`,
    ).toEqual([]);
  });

  it("every PARCEL_SETTINGS key has a section", () => {
    // This map is the source of truth for the parcel feature's tunables, and
    // seed.ts generates a Setting row for each — so a new tunable added here
    // needs a section entry too.
    const map = settingSectionMap();
    const missing = parcelSettingKeys().filter((k) => !map.has(k));
    expect(
      missing,
      `PARCEL_SETTINGS keys missing from SETTING_SECTIONS: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every section named in the map is one the web app can render", () => {
    // A typo'd section name is worse than a missing one: the row gets a
    // non-null section that matches nothing, and resolveSettingSection falls
    // through to "Other" with no hint that anything is wrong.
    const web = webSectionKeys();
    const bad = [...new Set(settingSectionMap().values())].filter((s) => !web.has(s));
    expect(
      bad,
      `Sections used in seed.ts that apps/web/src/lib/settingSections.ts does not define: ` +
        `${bad.join(", ")}. Either fix the spelling or add the section to the web constant.`,
    ).toEqual([]);
  });

  it("the map is not empty and the parsers still work", () => {
    // Guards the gate itself: a refactor that breaks these regexes would make
    // every assertion above vacuously pass.
    expect(settingSectionMap().size).toBeGreaterThan(50);
    expect(seededSettingKeys().length).toBeGreaterThan(30);
    expect(parcelSettingKeys().length).toBeGreaterThan(10);
    expect(webSectionKeys().size).toBeGreaterThan(5);
  });
});

// ── Cost behavior never returns to the expense taxonomy ───────────────────
//
// EXPENSE_COST_BEHAVIOR is gone: every category now starts "as is" in the
// forecaster and is tagged per-scenario, the same way every other lever
// baselines on reality. What must not come back is the ORIGINAL mistake —
// putting a forecasting-only field on EXPENSE_CATEGORIES, whose parser
// rejects unknown fields and whose loader swallows the error into an empty
// list. That took production's expense recording down on 2026-09-02.
describe("cost behavior stays out of the expense taxonomy", () => {
  it("costBehavior is NOT a field on EXPENSE_CATEGORIES", () => {
    const cats = SEED_SRC.slice(
      SEED_SRC.indexOf('key: "EXPENSE_CATEGORIES"'),
      SEED_SRC.indexOf("]),", SEED_SRC.indexOf('key: "EXPENSE_CATEGORIES"')),
    );
    expect(cats).not.toMatch(/costBehavior/);
    const parser = readFileSync(
      join(REPO_ROOT, "apps/api/src/services/expenseCategories.ts"), "utf8",
    );
    expect(parser).not.toMatch(/costBehavior/i);
  });

  it("no EXPENSE_COST_BEHAVIOR setting is seeded any more", () => {
    expect(SEED_SRC).not.toMatch(/EXPENSE_COST_BEHAVIOR/);
  });
});
