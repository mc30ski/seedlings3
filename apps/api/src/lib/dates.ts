/**
 * Eastern Time date utilities — the SINGLE source of truth for date
 * formatting on the API side.
 *
 * Why this file exists:
 *   The business operates in Eastern Time. The Vercel API runs in UTC. The
 *   default JS Date methods (`toISOString`, `.getDate()`, `.getMonth()`,
 *   `.getFullYear()`, `.setHours(0,0,0,0)`) all use UTC on the server, so
 *   any time you hand-roll YYYY-MM-DD formatting you risk emitting the
 *   wrong calendar day near midnight ET. We've been bitten by this in:
 *   the Accounting tab Cash Flow filter, the Exports tab history display,
 *   the BusinessExpense list/summary endpoints, the Gusto W-2/Contractors
 *   "Pay Period End" column, the iCalendar feed, the daily preview route,
 *   admin summary endpoints, and worker dashboard summaries. Every fix
 *   patches one site; the bug keeps coming back because each callsite
 *   reinvents the formatter.
 *
 * The rule:
 *   - To CONSTRUCT an ET-anchored Date from YYYY-MM-DD: `etMidnight(str)`
 *     or `etEndOfDay(str)` (inclusive day-end).
 *   - To FORMAT any Date back to a YYYY-MM-DD calendar string: ALWAYS
 *     `etFormatDate(d)`. NEVER `.toISOString().slice(0, 10)`. NEVER
 *     `.getDate()`/`.getMonth()`/`.getFullYear()` chains. NEVER
 *     `.setHours(0, 0, 0, 0)` to roll back to midnight.
 *   - For "today" / "tomorrow" as strings: `etToday()` / `etTomorrow()`.
 *   - For parsing user-typed YYYY-MM-DD: `parseUserDate(str)`.
 *
 * If a new helper would be useful, add it here. Don't write inline
 * date math at the callsite — it's how the bug keeps coming back.
 */

/** Convert a YYYY-MM-DD string to a Date at midnight Eastern time (handles EST/EDT) */
export function etMidnight(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const testDate = new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC — safe from DST edges
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
  const parts = formatter.format(testDate);
  const isEDT = parts.includes("EDT");
  const offsetHours = isEDT ? 4 : 5;
  return new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0));
}

/** Convert a YYYY-MM-DD string to end-of-day (23:59:59.999) in Eastern time */
export function etEndOfDay(dateStr: string): Date {
  // End of day = one millisecond before midnight of the NEXT day in ET
  const [y, m, d] = dateStr.split("-").map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1, 12)); // noon UTC of next day
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
  const parts = formatter.format(nextDay);
  const isEDT = parts.includes("EDT");
  const offsetHours = isEDT ? 4 : 5;
  return new Date(Date.UTC(y, m - 1, d + 1, offsetHours, 0, 0) - 1);
}

/** Get tomorrow's date string in Eastern time (YYYY-MM-DD) */
export function etTomorrow(): string {
  const now = new Date(Date.now() + 86400000);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
  return formatter.format(now);
}

/** Get today's date string in Eastern time (YYYY-MM-DD) */
export function etToday(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }); // en-CA gives YYYY-MM-DD
  return formatter.format(now);
}

/**
 * Parse a user-supplied date string. Bare YYYY-MM-DD inputs (from <input type="date">)
 * are interpreted as ET midnight so they render on the correct calendar day after
 * `fmtDate` formats them in `America/New_York`. Full datetime strings are passed
 * through to the Date constructor unchanged.
 */
export function parseUserDate(raw: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? etMidnight(raw) : new Date(raw);
}

/**
 * Add N calendar days to a YYYY-MM-DD string, returning a new YYYY-MM-DD
 * string in Eastern Time. Handles month/year rollover via JS Date overflow.
 * Use this instead of `setDate(getDate() - n)` / `setUTCDate(...)` chains.
 *
 *   etAddDays("2026-06-06", -7)  → "2026-05-30"
 *   etAddDays("2026-06-30",  1)  → "2026-07-01"
 */
export function etAddDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Use UTC noon to dodge DST edges; format back in ET so the result is
  // anchored on the operator's calendar day.
  const utcNoon = new Date(Date.UTC(y, m - 1, d + n, 12));
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(utcNoon);
}

/**
 * Format any Date as YYYY-MM-DD in Eastern Time. The CANONICAL formatter
 * for converting an ET-anchored Date back to a calendar-day string.
 *
 * Use cases:
 *   - Date returned from etMidnight() / etEndOfDay() that needs to be
 *     written into a CSV column or display string.
 *   - DateTime field from Prisma (`createdAt`, `confirmedAt`, etc.)
 *     that the operator should see as "the day it happened to me in NC."
 *   - Any Date object where you'd otherwise reach for
 *     `.toISOString().slice(0, 10)`.
 *
 * Always returns the operator's calendar day, never the server's UTC day.
 */
export function etFormatDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

/**
 * Get the Monday on-or-before today, as a YYYY-MM-DD string in ET. Used
 * by week-based summary endpoints + date-range default presets (ISO week
 * convention: Mon → Sun). Returns a stable string regardless of server
 * timezone.
 *
 * Use this instead of `setDate(now.getDate() - now.getDay())` etc., which
 * does the arithmetic in server time (= UTC on Vercel).
 */
export function etMondayOnOrBefore(): string {
  const today = etToday();
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun..6=Sat
  const daysBack = dow === 0 ? 6 : dow - 1;
  return etAddDays(today, -daysBack);
}

/**
 * Get the Sunday on-or-before today, as a YYYY-MM-DD string in ET. Used
 * by endpoints that follow the US week convention (Sun → Sat) — typically
 * worker payroll-style summaries that mirror `now.getDay() === 0`.
 */
export function etSundayOnOrBefore(): string {
  const today = etToday();
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun..6=Sat
  return etAddDays(today, -dow);
}

/**
 * Get the first of the current month, as YYYY-MM-DD in ET. For "this
 * month" date-range presets and summary endpoints.
 */
export function etStartOfMonth(): string {
  const today = etToday();
  return `${today.slice(0, 7)}-01`;
}

/**
 * Get January 1 of the current year, as YYYY-MM-DD in ET. For YTD
 * date-range presets and summary endpoints.
 */
export function etStartOfYear(): string {
  const today = etToday();
  return `${today.slice(0, 4)}-01-01`;
}
