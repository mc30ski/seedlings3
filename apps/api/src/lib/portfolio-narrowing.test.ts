// Unit tests for the WEB portfolio-narrowing table, run from the API build
// gate via the `@web-lib` alias declared in vitest.config.ts.
//
// WHY THESE EXIST ALONGSIDE G50. G50 source-scans: it proves the table
// agrees with the API about which endpoints narrow, and that the strip asks
// the table rather than hand-rolling a condition. It cannot prove the
// RESOLVER is right — a `tabNarrowing` that returned `true` for everything
// would satisfy every regex in that gate and put the old lie back on every
// tab at once.
//
// The distinction under test is the one the table exists for: a LENS is a
// portfolio you picked from the header chip, a GRANT is a portfolio your
// access is confined to, and `performance` obeys the second while
// deliberately ignoring the first (`ignoreLens` on
// GET /reports/portfolio-performance — the tab compares portfolios, so a
// lens that collapsed it to one would empty it).

import { describe, it, expect } from "vitest";
import {
  tabNarrowing,
  tabIsFiltered,
  tabNarrowedPart,
  tabShowsMoney,
  grantIsNarrowing,
  portfolioIsNarrowing,
} from "@web-lib/portfolioFilteredTabs";

const NOTHING = { lens: false, grant: false };
const LENS = { lens: true, grant: false };
const GRANT = { lens: false, grant: true };
const BOTH = { lens: true, grant: true };

describe("portfolio narrowing — nothing in force", () => {
  it("narrows nothing, however the tab is listed", () => {
    // The ordinary case for most of the business, every day. A table that
    // answered otherwise would mark every tab for everybody.
    for (const tab of ["repeating", "performance", "equipment", "ledger", null]) {
      expect(tabNarrowing(tab, NOTHING), `${tab}`).toBe(false);
      expect(tabIsFiltered(tab, NOTHING), `${tab}`).toBe(false);
      expect(tabNarrowedPart(tab, NOTHING), `${tab}`).toBeNull();
    }
  });
});

describe("portfolio narrowing — a tab that obeys both", () => {
  it("Repeating is wholly narrowed by either route in", () => {
    // The bug of 2026-11-12: `repeating` was absent from the table, so the
    // strip appended "— this tab shows the whole business" over a table the
    // filter had already shortened.
    for (const inForce of [LENS, GRANT, BOTH]) {
      expect(tabIsFiltered("repeating", inForce)).toBe(true);
      expect(tabNarrowedPart("repeating", inForce)).toBeNull();
    }
  });
});

describe("portfolio narrowing — a tab that obeys ONE", () => {
  it("Performance narrows under a grant", () => {
    expect(tabIsFiltered("performance", GRANT)).toBe(true);
  });

  it("…and not under a lens, because that tab ignores the lens", () => {
    // Listing it flatly would make the strip claim a lens narrowed a tab
    // that refused to apply it — the overclaiming direction.
    expect(tabIsFiltered("performance", LENS)).toBe(false);
    expect(tabNarrowing("performance", LENS)).toBe(false);
  });

  it("and a grant still wins when both are in force", () => {
    // A lead with a grant may also pick one of their own portfolios from
    // the chip. The grant has not stopped applying because they did.
    expect(tabIsFiltered("performance", BOTH)).toBe(true);
  });
});

describe("portfolio narrowing — a tab with one narrowed panel", () => {
  it("Equipment is not wholly narrowed, and names what is", () => {
    // Its own figures are the company's; the Insights leaderboard comes
    // from occurrences and does narrow. "This tab shows the whole
    // business" is true of the tab and false of that panel.
    expect(tabIsFiltered("equipment", LENS)).toBe(false);
    expect(tabNarrowedPart("equipment", LENS)).toBe("the Insights panel");
    expect(tabNarrowedPart("equipment", GRANT)).toBe("the Insights panel");
    expect(tabNarrowedPart("equipment", BOTH)).toBe("the Insights panel");
  });

  it("Portfolios names its own", () => {
    expect(tabIsFiltered("portfolios", BOTH)).toBe(false);
    expect(tabNarrowedPart("portfolios", BOTH)).toBe("the property picker");
  });

  it("and a part is still nothing when that narrowing is not in force", () => {
    expect(tabNarrowedPart("equipment", NOTHING)).toBeNull();
  });
});

describe("portfolio narrowing — the whole-business reports", () => {
  it("are never narrowed, by either route in", () => {
    // books.view / forecasts.view are global-only by design. The popover
    // named the Ledger as narrowed for weeks; it is the one money surface
    // that is not.
    for (const tab of ["ledger", "reconcile", "forecast"]) {
      expect(tabNarrowing(tab, BOTH), tab).toBe(false);
    }
  });

  it("and neither is a tab nobody has described", () => {
    expect(tabNarrowing("settings", BOTH)).toBe(false);
    expect(tabNarrowing("a-tab-that-does-not-exist", BOTH)).toBe(false);
  });
});

describe("tabShowsMoney", () => {
  it("is a money tab AND wholly narrowed", () => {
    expect(tabShowsMoney("home", LENS)).toBe(true);
    expect(tabShowsMoney("payments", GRANT)).toBe(true);
  });

  it("is false when nothing narrows — there is no basis to report", () => {
    expect(tabShowsMoney("home", NOTHING)).toBe(false);
  });

  it("and false for a tab that shows no money", () => {
    expect(tabShowsMoney("repeating", BOTH)).toBe(false);
  });
});

describe("which narrowing is in force", () => {
  it("a grant that takes nothing away is not a narrowing", () => {
    // Somebody recorded as leading a portfolio who also holds everything
    // company-wide. A loud warning there would be false every day until
    // they stopped reading it.
    expect(grantIsNarrowing({ grantCount: 1, narrows: false })).toBe(false);
    expect(grantIsNarrowing({ grantCount: 0 })).toBe(false);
    expect(grantIsNarrowing({ grantCount: 1 })).toBe(true);
    expect(grantIsNarrowing({ grantCount: 2, narrows: true })).toBe(true);
  });

  it("a lens is always a narrowing — it was chosen", () => {
    expect(portfolioIsNarrowing({ lensSet: true, grantCount: 0 })).toBe(true);
    expect(portfolioIsNarrowing({ lensSet: true, grantCount: 1, narrows: false })).toBe(true);
  });

  it("and the two halves answer different questions", () => {
    // `portfolioIsNarrowing` is "is anything in force at all" and drives
    // whether the markers appear; `grantIsNarrowing` is the grant half
    // alone, which is what the table needs. Conflating them would mark a
    // lens-only reader's Performance tab as grant-narrowed.
    const lensOnly = { lensSet: true, grantCount: 0 };
    expect(portfolioIsNarrowing(lensOnly)).toBe(true);
    expect(grantIsNarrowing(lensOnly)).toBe(false);
  });
});
