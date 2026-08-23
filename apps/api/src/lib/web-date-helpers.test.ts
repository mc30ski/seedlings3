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
  fmtDateKey,
  fmtDateOpts,
  fmtDateTime,
  fmtDateWeekday,
  fmtTimeOpts,
  prettyDate,
  type EtDateKey,
} from "@web-lib/dates";

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
    expect(bizAddDays("2026-03-07" as EtDateKey, 1)).toBe("2026-03-08");
    expect(bizAddDays("2026-03-08" as EtDateKey, 1)).toBe("2026-03-09");
    expect(bizAddDays("2026-03-01" as EtDateKey, 7)).toBe("2026-03-08");
  });

  it("handles DST fall-back correctly", () => {
    expect(bizAddDays("2026-10-31" as EtDateKey, 1)).toBe("2026-11-01");
    expect(bizAddDays("2026-11-01" as EtDateKey, 1)).toBe("2026-11-02");
  });

  it("handles year boundary", () => {
    expect(bizAddDays("2025-12-31" as EtDateKey, 1)).toBe("2026-01-01");
  });

  it("handles leap-year Feb 29", () => {
    expect(bizAddDays("2024-02-28" as EtDateKey, 1)).toBe("2024-02-29");
    expect(bizAddDays("2024-02-29" as EtDateKey, 1)).toBe("2024-03-01");
  });
});

describe("bizAddMonths (CLAMPING)", () => {
  it("clamps Feb 31 to Feb 28 in non-leap years", () => {
    // Previous bug: returned "2026-03-03" (JS Date overflow).
    expect(bizAddMonths("2026-01-31" as EtDateKey, 1)).toBe("2026-02-28");
  });

  it("clamps Feb 31 to Feb 29 in leap years", () => {
    expect(bizAddMonths("2024-01-31" as EtDateKey, 1)).toBe("2024-02-29");
  });

  it("clamps Apr 31 to Apr 30", () => {
    expect(bizAddMonths("2026-03-31" as EtDateKey, 1)).toBe("2026-04-30");
  });

  it("preserves day-of-month when target month has it", () => {
    expect(bizAddMonths("2026-06-15" as EtDateKey, 1)).toBe("2026-07-15");
  });

  it("handles year boundary", () => {
    expect(bizAddMonths("2025-12-15" as EtDateKey, 1)).toBe("2026-01-15");
  });

  it("handles negative N", () => {
    expect(bizAddMonths("2026-03-31" as EtDateKey, -1)).toBe("2026-02-28");
  });
});

describe("bizAddYears (CLAMPING)", () => {
  it("clamps Feb 29 to Feb 28 when target year is non-leap", () => {
    expect(bizAddYears("2024-02-29" as EtDateKey, 1)).toBe("2025-02-28");
  });

  it("preserves Feb 29 when target year is also leap", () => {
    expect(bizAddYears("2024-02-29" as EtDateKey, 4)).toBe("2028-02-29");
  });

  it("normal case", () => {
    expect(bizAddYears("2026-06-15" as EtDateKey, 1)).toBe("2027-06-15");
  });
});

describe("bizDaysBetween", () => {
  it("returns 0 for same day", () => {
    expect(bizDaysBetween("2026-06-06" as EtDateKey, "2026-06-06" as EtDateKey)).toBe(0);
  });

  it("returns positive when toKey is later", () => {
    expect(bizDaysBetween("2026-06-06" as EtDateKey, "2026-06-13" as EtDateKey)).toBe(7);
  });

  it("returns negative when toKey is earlier", () => {
    expect(bizDaysBetween("2026-06-13" as EtDateKey, "2026-06-06" as EtDateKey)).toBe(-7);
  });

  it("is DST-immune across spring-forward", () => {
    expect(bizDaysBetween("2026-03-01" as EtDateKey, "2026-03-15" as EtDateKey)).toBe(14);
  });

  it("is DST-immune across fall-back", () => {
    expect(bizDaysBetween("2026-10-25" as EtDateKey, "2026-11-08" as EtDateKey)).toBe(14);
  });
});

describe("bizYearOf", () => {
  it("extracts year from YYYY-MM-DD", () => {
    expect(bizYearOf("2026-06-06" as EtDateKey)).toBe(2026);
    expect(bizYearOf("1999-12-31" as EtDateKey)).toBe(1999);
  });

  it("returns NaN for invalid input", () => {
    expect(bizYearOf("" as EtDateKey)).toBeNaN();
    expect(bizYearOf("invalid" as EtDateKey)).toBeNaN();
  });
});

describe("Invalid-input propagation across all string helpers", () => {
  it("bizAddDays returns '' on empty / malformed input", () => {
    expect(bizAddDays("" as EtDateKey, 5)).toBe("");
    expect(bizAddDays("invalid" as EtDateKey, 5)).toBe("");
  });

  it("bizAddMonths returns '' on empty / malformed input", () => {
    expect(bizAddMonths("" as EtDateKey, 1)).toBe("");
    expect(bizAddMonths("not-a-date" as EtDateKey, 1)).toBe("");
  });

  it("bizAddYears returns '' on empty / malformed input", () => {
    expect(bizAddYears("" as EtDateKey, 1)).toBe("");
    expect(bizAddYears("not-a-date" as EtDateKey, 1)).toBe("");
  });

  it("bizDaysBetween returns NaN on empty / malformed input", () => {
    expect(bizDaysBetween("" as EtDateKey, "2026-06-06" as EtDateKey)).toBeNaN();
    expect(bizDaysBetween("2026-06-06" as EtDateKey, "" as EtDateKey)).toBeNaN();
    expect(bizDaysBetween("invalid" as EtDateKey, "2026-06-06" as EtDateKey)).toBeNaN();
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
    expect(bizInstantFromEtParts("2026-06-06" as EtDateKey, "14:30")).toBe("2026-06-06T18:30:00.000Z");
  });

  it("produces correct UTC for EST date", () => {
    expect(bizInstantFromEtParts("2026-01-15" as EtDateKey, "14:30")).toBe("2026-01-15T19:30:00.000Z");
  });

  it("supports HH:MM:SS format", () => {
    expect(bizInstantFromEtParts("2026-06-06" as EtDateKey, "14:30:45")).toBe("2026-06-06T18:30:45.000Z");
  });

  it("EARLY-MORNING spring-forward day uses EST (not EDT)", () => {
    // The old single-probe implementation returned EDT (05:30Z) for
    // 01:30 on the DST transition day, off by 1 hour. With the
    // round-trip verification it correctly picks EST (06:30Z).
    expect(bizInstantFromEtParts("2026-03-08" as EtDateKey, "01:30")).toBe("2026-03-08T06:30:00.000Z");
  });

  it("LATE-EVENING spring-forward day uses EDT", () => {
    // 8 PM EDT on the spring-forward day = 1 AM UTC next day.
    expect(bizInstantFromEtParts("2026-03-08" as EtDateKey, "20:00")).toBe("2026-03-09T00:00:00.000Z");
  });

  it("AMBIGUOUS fall-back time picks the EARLIER occurrence (EDT)", () => {
    // On Nov 1, 1:30 AM exists twice (EDT then EST). The implementation
    // picks the earlier one for determinism.
    expect(bizInstantFromEtParts("2026-11-01" as EtDateKey, "01:30")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("NON-EXISTENT spring-forward gap time falls back to EDT", () => {
    // 2:30 AM on 2026-03-08 doesn't exist (clocks skip from 2 to 3).
    // The function must return SOMETHING — it falls back to EDT
    // interpretation (2:30 EDT = 06:30 UTC).
    expect(bizInstantFromEtParts("2026-03-08" as EtDateKey, "02:30")).toBe("2026-03-08T06:30:00.000Z");
  });

  it("returns '' for invalid dateKey", () => {
    expect(bizInstantFromEtParts("" as EtDateKey, "14:30")).toBe("");
    expect(bizInstantFromEtParts("invalid" as EtDateKey, "14:30")).toBe("");
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

// ─────────────────────────────────────────────────────────────────────────
// fmtDateKey — off-by-one regression guard.
// Motivated by a shipped bug: fmtDate("2026-08-12") returns "8/11/2026"
// because JS parses date-only ISO strings as UTC midnight, and formatting
// that instant in ET (UTC-4/-5) rolls the wall-clock back to 8pm the
// PREVIOUS day. The NextStartOverride affordance mistakenly used fmtDate
// on YYYY-MM-DD keys, misleading the operator into thinking the schedule
// already matched what the client asked for. Any regression to that
// pattern must be caught here.
// ─────────────────────────────────────────────────────────────────────────
describe("fmtDateKey — YYYY-MM-DD calendar-day display", () => {
  it("returns the correct calendar day for a summer (EDT) date", () => {
    // The exact scenario from production: "2026-08-12" MUST format as
    // "8/12/2026", not "8/11/2026" (the fmtDate off-by-one).
    expect(fmtDateKey("2026-08-12")).toBe("8/12/2026");
  });

  it("returns the correct calendar day for a winter (EST) date", () => {
    // Winter has a bigger ET offset (UTC-5), so the fmtDate bug rolls
    // back 5h instead of 4h — same off-by-one. This locks EST too.
    expect(fmtDateKey("2026-01-15")).toBe("1/15/2026");
  });

  it("handles month/year boundaries without rolling", () => {
    expect(fmtDateKey("2026-12-31")).toBe("12/31/2026");
    expect(fmtDateKey("2026-01-01")).toBe("1/1/2026");
  });

  it("handles leap-day", () => {
    expect(fmtDateKey("2028-02-29")).toBe("2/29/2028");
  });

  it("returns em-dash for missing / malformed input (no leak of Invalid Date)", () => {
    expect(fmtDateKey(null)).toBe("—");
    expect(fmtDateKey(undefined)).toBe("—");
    expect(fmtDateKey("")).toBe("—");
    expect(fmtDateKey("not-a-date")).toBe("—");
    expect(fmtDateKey("2026/08/12")).toBe("—"); // wrong separator
    expect(fmtDateKey("08-12-2026")).toBe("—"); // wrong order
  });

  it("fmtDate now auto-routes YYYY-MM-DD keys (the off-by-one that hit prod is fixed)", () => {
    // Historical: fmtDate("2026-08-12") used to return "8/11/2026"
    // because JS parses date-only ISO strings as UTC midnight, and
    // formatting that instant in ET rolls the wall-clock back to 8pm
    // the previous day. That off-by-one shipped and misled the operator.
    //
    // The fix: fmtDate now detects the YYYY-MM-DD shape and routes it
    // through the same UTC-noon anchor fmtDateKey uses, guaranteeing
    // the calendar day never rolls under the ET offset. Both formatters
    // now produce the same correct display for a date-key input.
    expect(fmtDate("2026-08-12")).toBe("8/12/2026");
    expect(fmtDateKey("2026-08-12")).toBe("8/12/2026");
  });

  it("all date formatters auto-route YYYY-MM-DD keys to the correct calendar day", () => {
    // Lock the auto-route behavior across every formatter in the family.
    // Regression here would re-open the off-by-one for THAT formatter.
    // Uses a summer date (EDT, UTC-4) — worst-case for the roll bug.
    const key = "2026-08-12";
    // fmtDate — short date
    expect(fmtDate(key)).toBe("8/12/2026");
    // fmtDateTime — includes time (auto-anchored at UTC-noon = 8am ET)
    // Just assert the DATE portion is correct; the exact time format
    // can be locale-dependent but the day must never roll.
    expect(fmtDateTime(key).startsWith("8/12/2026")).toBe(true);
    // fmtDateWeekday — "Wednesday, Aug 12" style
    expect(fmtDateWeekday(key)).toContain("Aug 12");
    expect(fmtDateWeekday(key)).not.toContain("Aug 11");
    // fmtDateOpts — flexible custom shape
    expect(fmtDateOpts(key, { month: "short", day: "numeric" })).toBe("Aug 12");
    // Full ISO datetime strings continue to work unchanged
    const iso = "2026-08-12T12:00:00.000Z";
    expect(fmtDate(iso)).toBe("8/12/2026");
  });
});
