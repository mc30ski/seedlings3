/**
 * Eastern Time date utilities.
 * The business operates in Eastern time, so all date range queries
 * should use ET boundaries regardless of server or user timezone.
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
