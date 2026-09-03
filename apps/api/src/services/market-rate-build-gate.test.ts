// ─────────────────────────────────────────────────────────────────────────────
// Market-rate build gate
//
// The market band decides whether a worker reads as underpaid, whether the
// retention warning fires, and which way "should I hire someone to do my
// hours" points. It began life as two constants invented from general
// knowledge ($15-24) — for this business's actual metro the real 25th-75th is
// $17.78-$22.33, so the low end was $1.78/hr out in the flattering direction.
//
// What must hold now:
//   1. It is LOOKED UP, from the business's own address, not hardcoded.
//   2. A failure degrades visibly — never a silent unsourced number.
//   3. The cache re-resolves when the address (or any shaping input) changes.
//   4. The UI states the source, the survey year and when it was fetched.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(__dirname, "../../../..");
const SVC = readFileSync(join(ROOT, "apps/api/src/services/marketRate.ts"), "utf8");
const PARTS = readFileSync(join(ROOT, "apps/web/src/ui/tabs/ForecastTab.parts.tsx"), "utf8");
const MODEL = readFileSync(join(ROOT, "packages/money/forecastModel.ts"), "utf8");

describe("market rate — sourced, not invented", () => {
  it("resolves the metro area from BUSINESS_ADDRESS", () => {
    expect(SVC).toMatch(/BUSINESS_ADDRESS/);
    expect(SVC).toMatch(/Metropolitan Statistical Areas/);
  });

  it("caches through the shared cache, never in a Setting row", () => {
    // Settings are operator config and render in the Settings tab. A
    // machine-managed cache blob sitting there next to the rates and
    // endpoints someone actually edits is the junk-drawer problem again —
    // it was there briefly and had to be pulled back out.
    expect(SVC).not.toMatch(/setting\.(upsert|create|update)/);
    expect(SVC).not.toMatch(/MARKET_RATE_CACHE\b/);
    expect(SVC).toMatch(/cached\("marketRate"/);
  });

  it("the cache key includes the address, so moving re-resolves", () => {
    // Keying by the inputs means there is no invalidation hook to forget.
    expect(SVC).toMatch(/const key = \[cfg\.address, cfg\.soc, cfg\.percentiles\.join\("-"\)\]/);
  });

  it("rejects an implausible hourly wage instead of publishing it", () => {
    // OEWS returns hourly AND annual ladders. An off-by-one in the datatype
    // map renders $34,910/yr as an hourly rate — three orders of magnitude
    // wrong, and it looks like a plain number.
    expect(SVC).toMatch(/o\.value > 500/);
    expect(SVC).toMatch(/implausible hourly wage/);
  });

  it("never throws — it degrades to override, then to a labelled estimate", () => {
    expect(SVC).toMatch(/source: "override"/);
    expect(SVC).toMatch(/source: "fallback"/);
    expect(SVC).toMatch(/\} catch \(err: any\) \{/);
  });

  it("the fallback is labelled as an estimate, never as BLS", () => {
    const fb = SVC.slice(SVC.indexOf("const FALLBACK"), SVC.indexOf("async function loadCfg"));
    expect(fb).toMatch(/source: "fallback"/);
    expect(fb).toMatch(/generic estimate/);
  });

  it("the retention warning prices against the looked-up floor", () => {
    expect(MODEL).toMatch(/baseline\.marketRate\?\.low \?\? marketFloorFallback/);
  });
});

describe("market rate — the UI says where the number came from", () => {
  it("names the source, survey year, occupation, area and fetch date", () => {
    const blk = PARTS.slice(PARTS.indexOf("export function MarketRateProvenance"));
    for (const bit of ["Bureau of Labor Statistics", "market.year", "market.occupation",
                       "market.areaName", "cached "]) {
      expect(blk, `provenance must mention ${bit}`).toMatch(bit);
    }
  });

  it("distinguishes a looked-up figure from an override or an estimate", () => {
    const blk = PARTS.slice(PARTS.indexOf("export function MarketRateProvenance"));
    expect(blk).toMatch(/Manually set in Settings/);
    expect(blk).toMatch(/not a local figure/);
  });

  it("the fairness band uses the looked-up values, not the constants", () => {
    expect(PARTS).toMatch(/const lo = market\?\.low \?\? MARKET_LOW/);
    expect(PARTS).toMatch(/const hi = market\?\.high \?\? MARKET_HIGH/);
  });
});
