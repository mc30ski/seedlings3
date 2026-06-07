// Unit tests for the canonical WEB date helpers, run from the API
// build gate via the `@web-lib` alias declared in vitest.config.ts.
// Locks in DST, leap-year, month-overflow (the BUG that motivated this
// file), and invalid-input behavior.

import { describe, it, expect } from "vitest";
import {
  bizDateKey,
  bizAddDays,
  bizAddMonths,
  bizAddYears,
  bizYearOf,
  bizDaysBetween,
  bizMondayOnOrBefore,
  bizStartOfMonth,
  bizStartOfYear,
  bizHour,
  bizMonth,
  bizInstantFromEtParts,
  bizToLocalInputValue,
  bizParseLocalInputValue,
  fmtDate,
  fmtDateTime,
  fmtDateWeekday,
  fmtDateOpts,
  fmtTimeOpts,
  prettyDate,
} from "@web-lib/lib";

describe("bizDateKey", () => {
  it("returns ET YYYY-MM-DD for a UTC instant on the same ET day", () => {
    expect(bizDateKey("2026-06-06T18:30:00.000Z")).toBe("2026-06-06"); // 2:30 PM EDT
  });

  it("returns the PREVIOUS ET day for an early-morning UTC instant", () => {
    expect(bizDateKey("2026-06-06T03:00:00.000Z")).toBe("2026-06-05"); // 11 PM EDT prev day
  });

  it("returns empty string for invalid input (no 'Invalid Date' leak)", () => {
    expect(bizDateKey("not-a-date")).toBe("");
    expect(bizDateKey("")).toBe("");
  });
});

describe("bizAddDays", () => {
  it("handles DST spring-forward correctly", () => {
    expect(bizAddDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(bizAddDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(bizAddDays("2026-03-01", 7)).toBe("2026-03-08");
  });

  it("handles DST fall-back correctly", () => {
    expect(bizAddDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(bizAddDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("handles year boundary", () => {
    expect(bizAddDays("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("handles leap-year Feb 29", () => {
    expect(bizAddDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(bizAddDays("2024-02-29", 1)).toBe("2024-03-01");
  });
});

describe("bizAddMonths (CLAMPING)", () => {
  it("clamps Feb 31 to Feb 28 in non-leap years", () => {
    // Previous bug: returned "2026-03-03" (JS Date overflow).
    expect(bizAddMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("clamps Feb 31 to Feb 29 in leap years", () => {
    expect(bizAddMonths("2024-01-31", 1)).toBe("2024-02-29");
  });

  it("clamps Apr 31 to Apr 30", () => {
    expect(bizAddMonths("2026-03-31", 1)).toBe("2026-04-30");
  });

  it("preserves day-of-month when target month has it", () => {
    expect(bizAddMonths("2026-06-15", 1)).toBe("2026-07-15");
  });

  it("handles year boundary", () => {
    expect(bizAddMonths("2025-12-15", 1)).toBe("2026-01-15");
  });

  it("handles negative N", () => {
    expect(bizAddMonths("2026-03-31", -1)).toBe("2026-02-28");
  });
});

describe("bizAddYears (CLAMPING)", () => {
  it("clamps Feb 29 to Feb 28 when target year is non-leap", () => {
    expect(bizAddYears("2024-02-29", 1)).toBe("2025-02-28");
  });

  it("preserves Feb 29 when target year is also leap", () => {
    expect(bizAddYears("2024-02-29", 4)).toBe("2028-02-29");
  });

  it("normal case", () => {
    expect(bizAddYears("2026-06-15", 1)).toBe("2027-06-15");
  });
});

describe("bizDaysBetween", () => {
  it("returns 0 for same day", () => {
    expect(bizDaysBetween("2026-06-06", "2026-06-06")).toBe(0);
  });

  it("returns positive when toKey is later", () => {
    expect(bizDaysBetween("2026-06-06", "2026-06-13")).toBe(7);
  });

  it("returns negative when toKey is earlier", () => {
    expect(bizDaysBetween("2026-06-13", "2026-06-06")).toBe(-7);
  });

  it("is DST-immune across spring-forward", () => {
    expect(bizDaysBetween("2026-03-01", "2026-03-15")).toBe(14);
  });

  it("is DST-immune across fall-back", () => {
    expect(bizDaysBetween("2026-10-25", "2026-11-08")).toBe(14);
  });
});

describe("bizYearOf", () => {
  it("extracts year from YYYY-MM-DD", () => {
    expect(bizYearOf("2026-06-06")).toBe(2026);
    expect(bizYearOf("1999-12-31")).toBe(1999);
  });

  it("returns NaN for invalid input", () => {
    expect(bizYearOf("")).toBeNaN();
    expect(bizYearOf("invalid")).toBeNaN();
  });
});

describe("Invalid-input propagation across all string helpers", () => {
  it("bizAddDays returns '' on empty / malformed input", () => {
    expect(bizAddDays("", 5)).toBe("");
    expect(bizAddDays("invalid", 5)).toBe("");
  });

  it("bizAddMonths returns '' on empty / malformed input", () => {
    expect(bizAddMonths("", 1)).toBe("");
    expect(bizAddMonths("not-a-date", 1)).toBe("");
  });

  it("bizAddYears returns '' on empty / malformed input", () => {
    expect(bizAddYears("", 1)).toBe("");
    expect(bizAddYears("not-a-date", 1)).toBe("");
  });

  it("bizDaysBetween returns NaN on empty / malformed input", () => {
    expect(bizDaysBetween("", "2026-06-06")).toBeNaN();
    expect(bizDaysBetween("2026-06-06", "")).toBeNaN();
    expect(bizDaysBetween("invalid", "2026-06-06")).toBeNaN();
  });

  it("bizToLocalInputValue returns '' for invalid Date object", () => {
    expect(bizToLocalInputValue(new Date("invalid"))).toBe("");
    expect(bizToLocalInputValue("")).toBe("");
  });
});

describe("Display formatters reject invalid input cleanly", () => {
  it("fmtDate returns '—' for null / undefined / empty / invalid", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
    expect(fmtDate("")).toBe("—");
    expect(fmtDate("invalid")).toBe("—");
    expect(fmtDate("2026-13-45")).toBe("—");
    expect(fmtDate(new Date("invalid"))).toBe("—");
  });

  it("fmtDateTime returns '—' for invalid input", () => {
    expect(fmtDateTime("invalid")).toBe("—");
    expect(fmtDateTime(new Date("invalid"))).toBe("—");
  });

  it("fmtDateWeekday returns '—' for invalid input", () => {
    expect(fmtDateWeekday("invalid")).toBe("—");
  });

  it("fmtDateOpts returns '—' for invalid input", () => {
    expect(fmtDateOpts("invalid", { month: "short" })).toBe("—");
  });

  it("fmtTimeOpts returns '—' for invalid input", () => {
    expect(fmtTimeOpts("invalid", { hour: "numeric" })).toBe("—");
  });

  it("prettyDate returns '—' for invalid input", () => {
    expect(prettyDate(null)).toBe("—");
    expect(prettyDate("")).toBe("—");
    expect(prettyDate("invalid")).toBe("—");
  });

  it("prettyDate formats in ET", () => {
    const result = prettyDate("2026-06-06T18:30:00.000Z");
    expect(result).toMatch(/Jun 6/);
    expect(result).toMatch(/2:30/);
  });
});

describe("bizInstantFromEtParts", () => {
  it("produces correct UTC for EDT date", () => {
    expect(bizInstantFromEtParts("2026-06-06", "14:30")).toBe("2026-06-06T18:30:00.000Z");
  });

  it("produces correct UTC for EST date", () => {
    expect(bizInstantFromEtParts("2026-01-15", "14:30")).toBe("2026-01-15T19:30:00.000Z");
  });

  it("supports HH:MM:SS format", () => {
    expect(bizInstantFromEtParts("2026-06-06", "14:30:45")).toBe("2026-06-06T18:30:45.000Z");
  });

  it("EARLY-MORNING spring-forward day uses EST (not EDT)", () => {
    // The old single-probe implementation returned EDT (05:30Z) for
    // 01:30 on the DST transition day, off by 1 hour. With the
    // round-trip verification it correctly picks EST (06:30Z).
    expect(bizInstantFromEtParts("2026-03-08", "01:30")).toBe("2026-03-08T06:30:00.000Z");
  });

  it("LATE-EVENING spring-forward day uses EDT", () => {
    // 8 PM EDT on the spring-forward day = 1 AM UTC next day.
    expect(bizInstantFromEtParts("2026-03-08", "20:00")).toBe("2026-03-09T00:00:00.000Z");
  });

  it("AMBIGUOUS fall-back time picks the EARLIER occurrence (EDT)", () => {
    // On Nov 1, 1:30 AM exists twice (EDT then EST). The implementation
    // picks the earlier one for determinism.
    expect(bizInstantFromEtParts("2026-11-01", "01:30")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("NON-EXISTENT spring-forward gap time falls back to EDT", () => {
    // 2:30 AM on 2026-03-08 doesn't exist (clocks skip from 2 to 3).
    // The function must return SOMETHING — it falls back to EDT
    // interpretation (2:30 EDT = 06:30 UTC).
    expect(bizInstantFromEtParts("2026-03-08", "02:30")).toBe("2026-03-08T06:30:00.000Z");
  });

  it("returns '' for invalid dateKey", () => {
    expect(bizInstantFromEtParts("", "14:30")).toBe("");
    expect(bizInstantFromEtParts("invalid", "14:30")).toBe("");
  });
});

describe("bizToLocalInputValue / bizParseLocalInputValue round-trip", () => {
  it("preserves EDT wall-clock through the round-trip", () => {
    const iso = "2026-06-06T18:30:00.000Z"; // 2:30 PM EDT
    const inputValue = bizToLocalInputValue(iso);
    expect(inputValue).toBe("2026-06-06T14:30");
    expect(bizParseLocalInputValue(inputValue)).toBe(iso);
  });

  it("preserves EST wall-clock through the round-trip", () => {
    const iso = "2026-01-15T19:30:00.000Z"; // 2:30 PM EST
    const inputValue = bizToLocalInputValue(iso);
    expect(inputValue).toBe("2026-01-15T14:30");
    expect(bizParseLocalInputValue(inputValue)).toBe(iso);
  });

  it("returns '' for empty input", () => {
    expect(bizToLocalInputValue("")).toBe("");
    expect(bizParseLocalInputValue("")).toBe("");
  });
});

describe("bizHour / bizMonth", () => {
  it("returns numbers in range", () => {
    const h = bizHour();
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(23);
    const m = bizMonth();
    expect(m).toBeGreaterThanOrEqual(1);
    expect(m).toBeLessThanOrEqual(12);
  });
});

describe("Date-key style helpers", () => {
  it("returns YYYY-MM-DD formatted strings", () => {
    expect(bizMondayOnOrBefore()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(bizStartOfMonth()).toMatch(/^\d{4}-\d{2}-01$/);
    expect(bizStartOfYear()).toMatch(/^\d{4}-01-01$/);
  });
});
