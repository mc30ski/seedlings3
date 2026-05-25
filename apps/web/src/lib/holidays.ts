// US federal holidays — computed locally from the rules Congress sets in
// 5 U.S.C. § 6103. No API, no dependencies, no failure mode.
//
// We return both the holiday "name" (the official name) and an "observed"
// flag — when a date falls on a weekend, the federal observance shifts:
//   - Saturday holiday → observed on the preceding Friday
//   - Sunday holiday → observed on the following Monday
// For lawn-care scheduling, the *observed* day is usually what matters
// (workers/clients treat that as the day off), so the helper returns the
// observed date as well as the canonical one.
//
// Input/output use the "YYYY-MM-DD" business-date-key string format the
// rest of the app uses (see lib.ts:bizDateKey). That avoids timezone
// foot-guns from passing Date objects across the ET boundary.

export type HolidayInfo = {
  name: string;
  /** True when the date is the *observed* (weekend-shifted) day rather
   *  than the canonical calendar date. */
  observed: boolean;
};

/** Pad with leading zero. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** YYYY-MM-DD for the given numeric parts. */
function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Day of week for Y/M/D, 0=Sun..6=Sat. Uses UTC noon to avoid DST drift. */
function dow(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/** Date string of the Nth occurrence of `weekday` (0..6) in `month` (1..12). */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  // Find the first occurrence, then add (n-1) weeks.
  const firstDow = dow(year, month, 1);
  const offset = (weekday - firstDow + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return ymd(year, month, day);
}

/** Date string of the LAST occurrence of `weekday` in `month`. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  // Last day of month → walk back to the target weekday.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month
  const lastDow = dow(year, month, lastDay);
  const back = (lastDow - weekday + 7) % 7;
  return ymd(year, month, lastDay - back);
}

/**
 * The full set of US federal holidays for the given year, keyed by their
 * *canonical* (statute-defined) date in YYYY-MM-DD form.
 */
function federalHolidaysCanonical(year: number): Map<string, string> {
  const out = new Map<string, string>();
  // Fixed-date holidays
  out.set(ymd(year, 1, 1), "New Year's Day");
  out.set(ymd(year, 6, 19), "Juneteenth");
  out.set(ymd(year, 7, 4), "Independence Day");
  out.set(ymd(year, 11, 11), "Veterans Day");
  out.set(ymd(year, 12, 25), "Christmas Day");
  // Floating Monday/Thursday holidays (weekday: 0=Sun..6=Sat)
  out.set(nthWeekdayOfMonth(year, 1, 1, 3), "Martin Luther King Jr. Day"); // 3rd Mon Jan
  out.set(nthWeekdayOfMonth(year, 2, 1, 3), "Presidents' Day"); // 3rd Mon Feb
  out.set(lastWeekdayOfMonth(year, 5, 1), "Memorial Day"); // last Mon May
  out.set(nthWeekdayOfMonth(year, 9, 1, 1), "Labor Day"); // 1st Mon Sep
  out.set(nthWeekdayOfMonth(year, 10, 1, 2), "Columbus Day"); // 2nd Mon Oct
  out.set(nthWeekdayOfMonth(year, 11, 4, 4), "Thanksgiving Day"); // 4th Thu Nov
  return out;
}

/**
 * Build a date→holiday lookup for a year, including weekend observance
 * shifts. Both the canonical date AND the observed date are present so a
 * lookup on either returns a hit, with `observed=true` flagging the shift.
 */
function buildLookup(year: number): Map<string, HolidayInfo> {
  const out = new Map<string, HolidayInfo>();
  const canonical = federalHolidaysCanonical(year);
  for (const [date, name] of canonical) {
    // Canonical entry.
    out.set(date, { name, observed: false });
    // Weekend → observance shift.
    const [yStr, mStr, dStr] = date.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    const wd = dow(y, m, d);
    if (wd === 6) {
      // Saturday → observed Friday (d - 1).
      const obs = new Date(Date.UTC(y, m - 1, d - 1, 12));
      out.set(
        ymd(obs.getUTCFullYear(), obs.getUTCMonth() + 1, obs.getUTCDate()),
        { name: `${name} (observed)`, observed: true },
      );
    } else if (wd === 0) {
      // Sunday → observed Monday (d + 1).
      const obs = new Date(Date.UTC(y, m - 1, d + 1, 12));
      out.set(
        ymd(obs.getUTCFullYear(), obs.getUTCMonth() + 1, obs.getUTCDate()),
        { name: `${name} (observed)`, observed: true },
      );
    }
  }
  return out;
}

// Per-year lookup cache. Years are computed on demand and stick around for
// the page lifetime — about 11 entries per year, negligible memory.
const yearCache = new Map<number, Map<string, HolidayInfo>>();

function lookupForYear(year: number): Map<string, HolidayInfo> {
  let cached = yearCache.get(year);
  if (!cached) {
    cached = buildLookup(year);
    yearCache.set(year, cached);
  }
  return cached;
}

/**
 * Return the US federal holiday info for the given YYYY-MM-DD date, or
 * `null` when the date isn't a holiday. Matches both the canonical date
 * and the weekend-shifted observed date.
 *
 * Example: getUSHoliday("2026-07-03") → { name: "Independence Day (observed)", observed: true }
 *          getUSHoliday("2026-07-04") → { name: "Independence Day", observed: false }
 *          getUSHoliday("2026-07-05") → null
 */
export function getUSHoliday(dateKey: string): HolidayInfo | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const year = Number(dateKey.slice(0, 4));
  return lookupForYear(year).get(dateKey) ?? null;
}
