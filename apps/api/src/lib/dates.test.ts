// Unit tests for the canonical API date helpers.
// Locks in correctness for DST boundaries, leap years, year boundaries,
// month overflow, and invalid input. If any of these break, the build
// gate fails and the diff can't merge.

import { describe, it, expect } from "vitest";
import {
  etMidnight,
  etEndOfDay,
  etToday,
  etTomorrow,
  etFormatDate,
  etFormatDateOpts,
  etFormatTimeOpts,
  etAddDays,
  etDaysBetween,
  etMondayOnOrBefore,
  etSundayOnOrBefore,
  etStartOfMonth,
  etStartOfYear,
  parseUserDate,
} from "./dates";

describe("etFormatDate", () => {
  it("formats a UTC instant as the ET calendar day", () => {
    // 2026-06-06 12:00 UTC = 2026-06-06 8 AM EDT → "2026-06-06"
    expect(etFormatDate(new Date("2026-06-06T12:00:00Z"))).toBe("2026-06-06");
  });

  it("returns the ET day for a late-UTC instant that's still earlier ET", () => {
    // 2026-06-06 03:00 UTC = 2026-06-05 11 PM EDT → "2026-06-05"
    expect(etFormatDate(new Date("2026-06-06T03:00:00Z"))).toBe("2026-06-05");
  });
});

describe("etAddDays", () => {
  it("handles simple within-month addition", () => {
    expect(etAddDays("2026-06-06", 1)).toBe("2026-06-07");
    expect(etAddDays("2026-06-06", -1)).toBe("2026-06-05");
  });

  it("handles month boundary", () => {
    expect(etAddDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(etAddDays("2026-07-01", -1)).toBe("2026-06-30");
  });

  it("handles year boundary", () => {
    expect(etAddDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(etAddDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles DST spring-forward (US: 2026-03-08)", () => {
    expect(etAddDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(etAddDays("2026-03-08", 1)).toBe("2026-03-09");
    // Adding 7 days across the DST boundary stays exact.
    expect(etAddDays("2026-03-01", 7)).toBe("2026-03-08");
    expect(etAddDays("2026-03-08", 7)).toBe("2026-03-15");
  });

  it("handles DST fall-back (US: 2026-11-01)", () => {
    expect(etAddDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(etAddDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(etAddDays("2026-10-25", 7)).toBe("2026-11-01");
    expect(etAddDays("2026-11-01", 7)).toBe("2026-11-08");
  });

  it("handles leap-year Feb 29", () => {
    expect(etAddDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(etAddDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(etAddDays("2023-02-28", 1)).toBe("2023-03-01"); // non-leap
  });

  it("zero is a no-op", () => {
    expect(etAddDays("2026-06-06", 0)).toBe("2026-06-06");
  });

  it("handles large offsets", () => {
    expect(etAddDays("2026-06-06", 365)).toBe("2027-06-06");
    expect(etAddDays("2026-06-06", -365)).toBe("2025-06-06");
  });
});

describe("etDaysBetween", () => {
  it("returns positive when toKey is later", () => {
    expect(etDaysBetween("2026-06-06", "2026-06-13")).toBe(7);
  });

  it("returns negative when toKey is earlier", () => {
    expect(etDaysBetween("2026-06-13", "2026-06-06")).toBe(-7);
  });

  it("returns 0 for same day", () => {
    expect(etDaysBetween("2026-06-06", "2026-06-06")).toBe(0);
  });

  it("is DST-immune across spring-forward", () => {
    // 2026-03-01 to 2026-03-15 spans the DST shift; should be exactly 14 days.
    expect(etDaysBetween("2026-03-01", "2026-03-15")).toBe(14);
  });

  it("is DST-immune across fall-back", () => {
    expect(etDaysBetween("2026-10-25", "2026-11-08")).toBe(14);
  });

  it("handles year boundary", () => {
    expect(etDaysBetween("2025-12-25", "2026-01-05")).toBe(11);
  });

  it("handles leap-year Feb 29", () => {
    expect(etDaysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(etDaysBetween("2023-02-28", "2023-03-01")).toBe(1);
  });
});

describe("etMidnight", () => {
  it("returns the correct UTC instant for ET midnight in EST", () => {
    // 2026-01-15 00:00 EST = 2026-01-15 05:00 UTC
    expect(etMidnight("2026-01-15").toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("returns the correct UTC instant for ET midnight in EDT", () => {
    // 2026-07-15 00:00 EDT = 2026-07-15 04:00 UTC
    expect(etMidnight("2026-07-15").toISOString()).toBe("2026-07-15T04:00:00.000Z");
  });

  it("handles DST spring-forward day (still EST at midnight)", () => {
    // 2026-03-08 00:00 ET is BEFORE the 2 AM shift, so it's still EST
    expect(etMidnight("2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("handles DST fall-back day (still EDT at midnight)", () => {
    // 2026-11-01 00:00 ET is BEFORE the 2 AM shift, so it's still EDT
    expect(etMidnight("2026-11-01").toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
});

describe("etEndOfDay", () => {
  it("returns 23:59:59.999 ET", () => {
    // EST: 2026-01-15 23:59:59.999 ET = 2026-01-16 04:59:59.999 UTC
    expect(etEndOfDay("2026-01-15").toISOString()).toBe("2026-01-16T04:59:59.999Z");
    // EDT: 2026-07-15 23:59:59.999 ET = 2026-07-16 03:59:59.999 UTC
    expect(etEndOfDay("2026-07-15").toISOString()).toBe("2026-07-16T03:59:59.999Z");
  });
});

describe("etMondayOnOrBefore", () => {
  it("returns a valid YYYY-MM-DD string", () => {
    const result = etMondayOnOrBefore();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("etSundayOnOrBefore", () => {
  it("returns a valid YYYY-MM-DD string", () => {
    const result = etSundayOnOrBefore();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("etStartOfMonth", () => {
  it("returns the first of the current month", () => {
    const result = etStartOfMonth();
    expect(result).toMatch(/^\d{4}-\d{2}-01$/);
  });
});

describe("etStartOfYear", () => {
  it("returns January 1 of the current year", () => {
    const result = etStartOfYear();
    expect(result).toMatch(/^\d{4}-01-01$/);
  });
});

describe("parseUserDate", () => {
  it("parses YYYY-MM-DD as ET midnight", () => {
    const d = parseUserDate("2026-06-06");
    expect(d.toISOString()).toBe("2026-06-06T04:00:00.000Z"); // EDT
  });

  it("parses full ISO strings as their UTC instant", () => {
    const d = parseUserDate("2026-06-06T14:30:00.000Z");
    expect(d.toISOString()).toBe("2026-06-06T14:30:00.000Z");
  });
});

describe("etFormatDateOpts", () => {
  it("forces the ET timezone", () => {
    // 2026-06-06 03:00 UTC = 2026-06-05 11 PM EDT → "Jun 5"
    const result = etFormatDateOpts(new Date("2026-06-06T03:00:00Z"), {
      month: "short",
      day: "numeric",
    });
    expect(result).toBe("Jun 5");
  });
});

describe("etFormatTimeOpts", () => {
  it("forces the ET timezone", () => {
    // 2026-06-06 18:30 UTC = 2026-06-06 2:30 PM EDT
    const result = etFormatTimeOpts(new Date("2026-06-06T18:30:00Z"), {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(result).toMatch(/2:30/);
  });
});

describe("Invalid-input propagation across API helpers", () => {
  it("etMidnight returns Invalid Date for malformed input", () => {
    expect(isNaN(etMidnight("").getTime())).toBe(true);
    expect(isNaN(etMidnight("not-a-date").getTime())).toBe(true);
  });

  it("etEndOfDay returns Invalid Date for malformed input", () => {
    expect(isNaN(etEndOfDay("").getTime())).toBe(true);
    expect(isNaN(etEndOfDay("garbage").getTime())).toBe(true);
  });

  it("etAddDays returns '' for malformed input", () => {
    expect(etAddDays("", 5)).toBe("");
    expect(etAddDays("not-a-date", 5)).toBe("");
  });

  it("etDaysBetween returns NaN for malformed input", () => {
    expect(etDaysBetween("", "2026-06-06")).toBeNaN();
    expect(etDaysBetween("2026-06-06", "")).toBeNaN();
  });
});

describe("etMidnight + etEndOfDay range invariant", () => {
  it("etEndOfDay returns a later instant than etMidnight on the same day (DST spring-forward)", () => {
    // The day is short (23 hours) but the end-of-day instant must still
    // be later than the midnight instant for Prisma `gte / lte` queries.
    const start = etMidnight("2026-03-08");
    const end = etEndOfDay("2026-03-08");
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it("etEndOfDay returns a later instant than etMidnight on the same day (DST fall-back)", () => {
    // The day is long (25 hours).
    const start = etMidnight("2026-11-01");
    const end = etEndOfDay("2026-11-01");
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it("etEndOfDay returns a later instant than etMidnight on a regular day", () => {
    const start = etMidnight("2026-06-15");
    const end = etEndOfDay("2026-06-15");
    expect(end.getTime()).toBeGreaterThan(start.getTime());
    // Regular day = exactly 24 hours.
    expect(end.getTime() - start.getTime()).toBe(86_400_000 - 1);
  });
});
