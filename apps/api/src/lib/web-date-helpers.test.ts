// Unit tests for the canonical WEB date helpers, run from the API
// build gate via the `@web-lib` alias declared in vitest.config.ts.
// Locks in DST, leap-year, month-overflow (the BUG that motivated this
// file), and invalid-input behavior.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  bizDateKey,
  bizDateKeyOf,
  bizAddDays,
  bizAddMonths,
  bizAddYears,
  bizYearOf,
  bizDaysBetween,
  bizToday,
  fmtRelativeDay,
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

describe("fmtRelativeDay", () => {
  // Counts CALENDAR DAYS in the business timezone, which is what a person
  // means. A naive (now - then) / 86_400_000 would call an 11pm ask viewed at
  // 1am "today"; it is yesterday, and it is also the forbidden pattern.
  it("names today, yesterday, and further back", () => {
    const today = bizToday();
    expect(fmtRelativeDay(today)).toBe("today");
    expect(fmtRelativeDay(bizAddDays(today, -1))).toBe("yesterday");
    expect(fmtRelativeDay(bizAddDays(today, -3))).toBe("3 days ago");
    expect(fmtRelativeDay(bizAddDays(today, -30))).toBe("30 days ago");
  });

  it("treats a future stamp as today rather than inventing negative days", () => {
    // Clock skew between a phone and the server is real; "-1 days ago" is
    // worse than a harmless "today".
    expect(fmtRelativeDay(bizAddDays(bizToday(), 1))).toBe("today");
  });

  it("returns empty for anything unparseable, so callers need no guard", () => {
    expect(fmtRelativeDay(null)).toBe("");
    expect(fmtRelativeDay(undefined)).toBe("");
    expect(fmtRelativeDay("")).toBe("");
    expect(fmtRelativeDay("not-a-date")).toBe("");
  });

  it("accepts a full ISO instant, which is what the API returns", () => {
    // confirmationRequestedAt is a DateTime, serialized as an ISO string —
    // not a date key. Both shapes have to work.
    const iso = `${bizAddDays(bizToday(), -2)}T15:04:05.000Z`;
    expect(fmtRelativeDay(iso)).toBe("2 days ago");
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

  it("fmtDateWeekday `short` abbreviates the weekday and nothing else", () => {
    // 2026-11-11 is a Wednesday — the day that prompted this, because
    // "WEDNESDAY, NOV 11" is the longest weekday in the Jobs day header and
    // the one that collided with the chips beside it.
    const key = "2026-11-11";
    expect(fmtDateWeekday(key)).toBe("Wednesday, Nov 11");
    expect(fmtDateWeekday(key, { short: true })).toBe("Wed, Nov 11");

    // The other options still compose. `short` must not quietly drop the
    // year when both are asked for — the long-ago / far-ahead header needs
    // both at once, and that combination has no other test.
    expect(fmtDateWeekday(key, { year: true })).toBe("Wednesday, Nov 11, 2026");
    expect(fmtDateWeekday(key, { short: true, year: true })).toBe("Wed, Nov 11, 2026");

    // Every weekday shortens — asserted across the week rather than on one
    // day, because a `slice(0, 3)` would also pass a single-day check while
    // being wrong for a locale that abbreviates differently.
    const longs = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const shorts = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let i = 0; i < 7; i++) {
      const d = `2026-11-${String(8 + i).padStart(2, "0")}`; // 8 Nov 2026 is a Sunday
      expect(fmtDateWeekday(d).startsWith(longs[i]), `${d} long`).toBe(true);
      expect(fmtDateWeekday(d, { short: true }).startsWith(shorts[i]), `${d} short`).toBe(true);
    }

    expect(fmtDateWeekday("invalid", { short: true })).toBe("—");
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

// ─────────────────────────────────────────────────────────────────────────
// bizDateKeyOf — and the two guards that make the bug it fixes unwritable.
//
// THE SHIPPED BUG (2026-11-13). `WorkerWorkday.workdayDate` is a String
// column holding an ET date key. A comment in the End Workday dialog said
// it arrived "from Prisma as an ISO datetime", so four call sites routed it
// through `bizDateKey` — which reads its argument as an INSTANT. A bare
// "2026-11-11" parses as UTC midnight, 7pm ET on the 10th, so the key came
// back a day early.
//
// The owner of a workday left open on WEDNESDAY was told "You didn't end
// your workday on Tuesday, Nov 10", and the dialog defaulted its picker to
// 6pm on that Tuesday — before the workday had started — so the dialog's
// own before-start guard refused every submission. Closing it meant
// overruling the app and naming a day it insisted was wrong.
// ─────────────────────────────────────────────────────────────────────────
describe("bizDateKeyOf", () => {
  it("passes a date key through untouched — the whole point", () => {
    // Every one of these moves a day under plain bizDateKey.
    expect(bizDateKeyOf("2026-11-11")).toBe("2026-11-11");
    expect(bizDateKeyOf("2026-01-01")).toBe("2026-01-01");
    expect(bizDateKeyOf("2026-12-31")).toBe("2026-12-31");
  });

  it("still converts an instant, so it is a safe drop-in", () => {
    expect(bizDateKeyOf("2026-06-06T18:30:00.000Z")).toBe("2026-06-06");
    // Late-evening ET: the instant is the NEXT UTC day and must still key
    // to the ET day it belongs to.
    expect(bizDateKeyOf("2026-06-06T03:00:00.000Z")).toBe("2026-06-05");
    expect(bizDateKeyOf(new Date("2026-06-06T18:30:00.000Z"))).toBe("2026-06-06");
  });

  it("holds across both DST transitions, in both directions", () => {
    // Spring forward 2026-03-08, fall back 2026-11-01. A key is a key on
    // every one of these days; the hour that does or does not exist is
    // irrelevant to a value with no time in it.
    for (const key of ["2026-03-07", "2026-03-08", "2026-03-09",
                       "2026-10-31", "2026-11-01", "2026-11-02"]) {
      expect(bizDateKeyOf(key)).toBe(key);
    }
  });

  it("does not mistake a datetime that merely STARTS with a date key", () => {
    // The shape test is anchored, so "2026-11-11T00:00:00Z" is still read
    // as the instant it is — which in ET is the 10th.
    expect(bizDateKeyOf("2026-11-11T00:00:00.000Z")).toBe("2026-11-10");
  });

  it("propagates garbage as the canonical empty signal", () => {
    expect(bizDateKeyOf("not-a-date")).toBe("");
    expect(bizDateKeyOf("")).toBe("");
    expect(bizDateKeyOf("26-11-11")).toBe("");
    // A NEARLY-key falls through to `bizDateKey`, by design: the shape test
    // is strict, so anything that is not exactly YYYY-MM-DD is treated as
    // an instant. "2026-11-1" is not ISO, so the JS parser reads it in
    // LOCAL time and it happens to land on the right day — inherited
    // `bizDateKey` behaviour, asserted here so a change to it is visible
    // rather than discovered.
    expect(bizDateKeyOf("2026-11-1")).toBe("2026-11-01");
  });

  it("is exactly what the production row needed", () => {
    // The real row: workdayDate "2026-11-11", a Wednesday.
    const workdayDate = "2026-11-11";
    expect(bizDateKey(workdayDate)).toBe("2026-11-10"); // the bug, preserved
    expect(bizDateKeyOf(workdayDate)).toBe("2026-11-11"); // the fix
  });
});

describe("the guards that make that bug a compile error", () => {
  // THE REGEX IS THE FALLBACK, NOT THE DEFENCE. Gate rule 31 matches
  // argument NAMES, so it only catches spellings somebody thought of. What
  // actually makes the bug unwritable is the signature plus the brand —
  // and both can be widened back in a one-line edit that fails nothing
  // else, which is precisely why they are asserted here.
  const read = (rel: string) =>
    readFileSync(join(__dirname, "../../../web/src/", rel), "utf-8");

  it("bizDateKey refuses a branded EtDateKey", () => {
    const src = read("lib/dates.ts");
    const sig = /export function bizDateKey\(\s*d:\s*([^)]*)\)/.exec(src);
    expect(sig, "bizDateKey must exist").toBeTruthy();
    expect(
      sig![1],
      "bizDateKey must not take a bare `string` — that is what let an " +
        "EtDateKey be re-keyed into the previous day. It takes an instant: " +
        "`(string & { readonly __brand?: undefined }) | IsoInstant | Date`.",
    ).not.toMatch(/^\s*string\s*\|/);
    expect(
      sig![1],
      "the brand exclusion is the guard — keep `__brand?: undefined` in the " +
        "parameter type",
    ).toMatch(/__brand\?\s*:\s*undefined/);
  });

  it("and the field that caused it stays branded", () => {
    const src = read("lib/workday.ts");
    expect(
      src,
      "WorkdaySummary.workdayDate must be an EtDateKey. Typed as a plain " +
        "`string` it opts out of the signature guard above, and the bug is " +
        "writable again with no test failing.",
    ).toMatch(/workdayDate:\s*EtDateKey;/);
  });

  it("and nothing re-keys a workday date anywhere", () => {
    // Belt and braces for a file the brand cannot reach — one that pulls
    // the row through `as any`, which is how the four original call sites
    // would still compile today.
    const web = join(__dirname, "../../../web/src");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        // Same nesting allowance as gate rule 31 — `[^)]*` could not reach
        // past the parens in `bizDateKey((workday as any).workdayDate)`,
        // and that is the one spelling the brand does not stop either.
        else if (
          /\.tsx?$/.test(e.name) &&
          /bizDateKey\s*\(\s*(?:[^()\n]|\([^()\n]*\))*?[Ww]orkdayDate/.test(readFileSync(full, "utf-8"))
        ) {
          bad.push(full.slice(web.length + 1));
        }
      }
    };
    walk(web);
    expect(
      bad,
      "a workday date re-keyed through bizDateKey \u2014 it will render, and " +
        "every date on that screen will be one day early",
    ).toEqual([]);
  });
});
