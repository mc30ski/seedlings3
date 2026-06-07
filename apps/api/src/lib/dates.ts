/**
 * ═════════════════════════════════════════════════════════════════════════
 * Eastern Time date utilities — the SINGLE source of truth on the API side.
 *
 * READ THIS BEFORE WRITING ANY DATE CODE IN apps/api/.
 * Canonical reference: docs/DATE_HANDLING.md
 *
 * Why this file exists:
 *   The business operates in Eastern Time. The Vercel API runs in UTC. The
 *   default JS Date methods (`toISOString`, `.getDate()`, `.getMonth()`,
 *   `.getFullYear()`, `.setHours(0,0,0,0)`) all use UTC on the server, so
 *   any time you hand-roll YYYY-MM-DD formatting you risk emitting the
 *   wrong calendar day near midnight ET.
 *
 * ─── DECISION TABLE ─────────────────────────────────────────────────────
 *
 *   I want to…                              | Use…
 *   ----------------------------------------|------------------------------
 *   Get today / tomorrow as YYYY-MM-DD       | etToday() / etTomorrow()
 *   Format any Date as YYYY-MM-DD in ET      | etFormatDate(d)
 *   Construct a Date at ET midnight          | etMidnight("YYYY-MM-DD")
 *   Construct a Date at ET 23:59:59.999      | etEndOfDay("YYYY-MM-DD")
 *   Parse a YYYY-MM-DD or full ISO string    | parseUserDate(str)
 *   Add N days to a YYYY-MM-DD string         | etAddDays(str, n)
 *   This week's Monday / Sunday (YYYY-MM-DD)  | etMondayOnOrBefore() / etSundayOnOrBefore()
 *   First of month / year as YYYY-MM-DD       | etStartOfMonth() / etStartOfYear()
 *
 * ─── FORBIDDEN PATTERNS ─────────────────────────────────────────────────
 *
 *   ❌ `d.toISOString().slice(0, 10)`
 *       → UTC, wrong calendar day near midnight ET. Use etFormatDate(d).
 *
 *   ❌ `.toLocaleDateString(...)` / `.toLocaleString(...)`
 *       → Uses server locale = UTC on Vercel. Wrong calendar day.
 *       → If you need a localized display string, use Intl.DateTimeFormat
 *         with an explicit `timeZone: "America/New_York"`.
 *
 *   ❌ `.getFullYear()` / `.getMonth()` / `.getDate()` chains for YYYY-MM-DD
 *       → Server local time. Use etFormatDate(d).
 *
 *   ❌ `.setHours(0,0,0,0)` / `.setUTCHours(0,0,0,0)`
 *       → Wrong timezone for midnight. Use etMidnight(etToday()).
 *
 *   ❌ `new Date(YYYY, MM, DD)`
 *       → Server local midnight. Use etMidnight("YYYY-MM-DD").
 *
 *   ❌ `new Date("YYYY-MM-DD")` for ET-anchored data
 *       → Parses as UTC midnight. Use etMidnight(str) or parseUserDate(str).
 *
 *   ❌ `.setDate(d.getDate() + n)` / `.setMonth(...)` to add a day/month
 *       → Mutates in server time. Use etAddDays(str, n) on string keys.
 *       → EXCEPTION: arithmetic on a stored DateTime instant (e.g., adding
 *         7 days to a JobOccurrence.startAt to compute next-occurrence)
 *         is OK *as long as the result is only used as an instant, not
 *         formatted as a calendar day at a different DST boundary*.
 *
 *   ❌ `new Intl.DateTimeFormat(...)` inline at a callsite
 *       → Add a helper here. Don't inline.
 *
 *   ❌ `new Date(d.getTime() + 86_400_000)` for "tomorrow"
 *       → Breaks on DST boundaries. Use etAddDays(etToday(), 1) + etMidnight.
 *
 * If you find a date-handling need that isn't covered here, ADD A HELPER
 * to this file with a clear name + doc comment. Do NOT reinvent date math
 * at the callsite — that's how the bug keeps coming back.
 * ═════════════════════════════════════════════════════════════════════════
 */

/** Convert a YYYY-MM-DD string to a Date at midnight Eastern time (handles EST/EDT).
 *
 * Probe at 1 AM UTC of the target day, NOT noon UTC. On DST transition
 * days the shift happens at 2 AM ET, so midnight ET is always BEFORE the
 * shift. 1 AM UTC translates to ~8-9 PM the previous ET day, which is
 * on the same side of the shift as midnight on the target day — picking
 * the correct EST/EDT offset for midnight regardless of which direction
 * the day is transitioning. Probing at noon UTC (the previous
 * implementation) silently picked the AFTER-shift offset on DST days
 * and produced 1 AM ET instead of midnight ET (caught by unit tests).
 */
export function etMidnight(dateStr: string): Date {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(NaN);
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  const testDate = new Date(Date.UTC(y, m - 1, d, 1)); // 1 AM UTC — same side of the DST shift as midnight ET
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
  const parts = formatter.format(testDate);
  const isEDT = parts.includes("EDT");
  const offsetHours = isEDT ? 4 : 5;
  return new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0));
}

/** Convert a YYYY-MM-DD string to end-of-day (23:59:59.999) in Eastern time */
export function etEndOfDay(dateStr: string): Date {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Date(NaN);
  }
  // End of day = one millisecond before midnight of the NEXT day in ET.
  // Probe at 1 AM UTC of the NEXT day to detect the correct offset that
  // applies at NEXT-day midnight (which is when end-of-day-of-current-day
  // transitions to next-day-midnight). Same DST-safety logic as etMidnight.
  const [y, m, d] = dateStr.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d + 1, 1));
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
  const parts = formatter.format(probe);
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
 * Number of calendar days from `fromKey` to `toKey`, ET-anchored. Returns
 * a signed integer: positive if `toKey` is later, negative if earlier.
 *
 * Use this instead of `Math.round((d1.getTime() - d2.getTime()) / 86_400_000)`
 * — that pattern silently drifts by an hour across DST boundaries and can
 * round up / down to the wrong day count.
 *
 * Both inputs MUST be YYYY-MM-DD strings (no time component). For mixed
 * Date / ISO inputs, convert via `etFormatDate(d)` first.
 *
 *   etDaysBetween("2026-06-06", "2026-06-13") → 7
 *   etDaysBetween("2026-06-13", "2026-06-06") → -7
 */
export function etDaysBetween(fromKey: string, toKey: string): number {
  if (!fromKey || !toKey || !/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey)) return NaN;
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  // UTC noon on both ends — noon UTC × 24h is always exactly 86_400_000
  // ms apart, so DST has no effect.
  const fromUtc = Date.UTC(fy, fm - 1, fd, 12);
  const toUtc = Date.UTC(ty, tm - 1, td, 12);
  return Math.round((toUtc - fromUtc) / 86_400_000);
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
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "";
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
 * Flexible ET-anchored Intl date formatter. Use when you need a shape
 * `etFormatDate` doesn't produce (e.g. "Mon, Jun 6" with a weekday).
 * Always pins `timeZone: "America/New_York"` so server-local UTC never
 * leaks into operator/client-visible text.
 *
 * Use this instead of `d.toLocaleDateString("en-US", opts)` — the bare
 * locale call uses the server locale (UTC on Vercel) and emits the
 * wrong ET day near midnight.
 */
export function etFormatDateOpts(
  d: Date,
  opts: Intl.DateTimeFormatOptions,
  locale: string = "en-US",
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "America/New_York",
    ...opts,
  }).format(d);
}

/**
 * Flexible ET-anchored Intl time formatter. Use for time-only output
 * (e.g. "9:30 AM"). Same rules as etFormatDateOpts.
 */
export function etFormatTimeOpts(
  d: Date,
  opts: Intl.DateTimeFormatOptions,
  locale: string = "en-US",
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "America/New_York",
    ...opts,
  }).format(d);
}

/**
 * Format any Date as the iCalendar local-datetime basic format:
 * `YYYYMMDDTHHMMSS` in Eastern Time. Pair with the `TZID=America/New_York`
 * parameter on DTSTART / DTEND for RFC 5545 timed events.
 *
 * Specialized format helper used only by the iCal feed
 * (`apps/api/src/routes/public.ts`). Routed through this helper instead
 * of inlining `Intl.DateTimeFormat` to keep the "no inline Intl" rule
 * absolute.
 */
export function etIcalLocalDateTime(d: Date): string {
  // sv-SE locale emits "YYYY-MM-DD HH:mm:ss"; convert to iCal "YYYYMMDDTHHMMSS".
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return parts.replace(/[-: ]/g, "").replace(/(\d{8})(\d{6})/, "$1T$2");
}

/**
 * Get the ET hour:minute (24h) of any Date as "HH:MM". Used by the iCal
 * feed to distinguish "scheduled at default 9 AM (untimed)" from
 * "scheduled at a specific time" without exposing the inline Intl
 * pattern at the callsite.
 */
export function etHourMinute(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
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
