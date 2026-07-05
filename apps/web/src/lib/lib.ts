import { Me, Role, JOB_TYPE_OPTIONS } from "@/src/lib/types";

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const BIZ_TZ = "America/New_York";

// ═════════════════════════════════════════════════════════════════════════════
// DATE HELPERS — the SINGLE source of truth on the web side.
//
// READ THIS BEFORE WRITING ANY DATE CODE IN apps/web/.
// Canonical reference: docs/DATE_HANDLING.md
//
// Why this section exists:
//   The business operates in Eastern Time. Browsers run in the user's local
//   timezone. The default JS Date methods (`toISOString`, `.getDate()`,
//   `.getMonth()`, etc.) all use UTC or local time, neither of which is the
//   operator's calendar day near midnight. We've been bitten by this in many
//   places (Exports tab history, P&L Report, Accounting tab, JobsTab filters,
//   the Gusto CSV Pay Period End column, etc.) — every fix patches one site;
//   the bug keeps coming back because each callsite reinvents the formatter.
//
// ─── DECISION TABLE ─────────────────────────────────────────────────────────
//
//   I want to…                              | Use…
//   ----------------------------------------|-----------------------------------
//   Get today's YYYY-MM-DD (for an input,   | bizToday()
//   URL, localStorage key, comparison)      |
//   Get tomorrow / yesterday                 | bizTomorrow() / bizYesterday()
//   Format a Date for display ("6/6/2026")  | fmtDate(d)
//   Format with time ("6/6/2026, 9:30 AM")  | fmtDateTime(d)
//   Format with weekday ("Mon, Jun 6")      | fmtDateWeekday(d)
//   Custom display format                   | fmtDateOpts(d, options)
//   Custom time format                      | fmtTimeOpts(d, options)
//   Get the current ET hour (0-23)          | bizHour()
//   Get YYYY-MM-DD from a Date/ISO string   | bizDateKey(d)
//   Add N days to a YYYY-MM-DD              | bizAddDays(key, n)
//   This week's Monday (YYYY-MM-DD)         | bizMondayOnOrBefore()
//   First of this month / year (YYYY-MM-DD) | bizStartOfMonth() / bizStartOfYear()
//
// ─── FORBIDDEN PATTERNS ──────────────────────────────────────────────────────
//
//   ❌ `d.toISOString().slice(0, 10)`
//       → Uses UTC. Wrong calendar day near midnight ET (user picks 6/6,
//         this emits 6/7). Use `bizDateKey(d)`.
//
//   ❌ `d.getFullYear()` / `d.getMonth()` / `d.getDate()` chains for YYYY-MM-DD
//       → Uses the browser's local time. NOT ET unless the user happens to
//         be in ET. Use `bizDateKey(d)`.
//       → EXCEPTION: building a value for `<input type="datetime-local">`
//         REQUIRES browser-local time per the HTML spec. This is the only
//         legitimate use — see OccurrenceDialog.toDateTimeLocal etc.
//
//   ❌ `d.setHours(0, 0, 0, 0)` / `d.setUTCHours(0, 0, 0, 0)`
//       → Sets midnight in the wrong timezone. Use `bizToday()` then a
//         server-side `etMidnight()` if you need the actual Date instant.
//
//   ❌ `new Date(YYYY, MM, DD)`
//       → Browser-local midnight. Same problem. Build a YYYY-MM-DD string
//         and pass it to the server, OR use `bizDateKey(...)` for display.
//
//   ❌ `new Date("YYYY-MM-DD")` for ET-anchored data
//       → Parses as UTC midnight. Often wrong intent. If you need an instant
//         for a date the operator picked, this is what the server's
//         `etMidnight()` is for — DON'T construct on the web side.
//
//   ❌ `.toLocaleDateString(undefined, ...)` / `.toLocaleString(...)`
//       → Uses the user's locale + timezone. For an ET-anchored business,
//         use `fmtDate / fmtDateTime / fmtDateWeekday / fmtDateOpts /
//         fmtTimeOpts` instead — they pin the timezone to ET.
//
//   ❌ `new Intl.DateTimeFormat(...)` inline at a callsite
//       → If you need it, add a helper here. Don't inline.
//
//   ❌ `new Date(d.getTime() + 86_400_000)` for "tomorrow"
//       → Works most days but breaks on DST boundaries. Use `bizAddDays()`.
//
//   ❌ Defining a local `fmtDate()` / `dateKey()` / `pad()` helper inside
//      a component file
//       → Add it here instead, with a clear name. That's how we end up with
//         15 slightly-different formatters, each with their own bugs.
//
// If you find a date-handling need that isn't covered here, ADD A HELPER to
// this file with a clear name and doc comment, then use it. Do NOT reinvent
// date math at the callsite.
// ═════════════════════════════════════════════════════════════════════════════

/** Returns true if the input can be coerced to a valid Date. Used by
 *  every formatter below so an invalid string ("invalid", "2026-13-45",
 *  empty after trim, etc.) renders as "—" instead of leaking "Invalid
 *  Date" into the UI. */
function isValidDateInput(d: string | Date): boolean {
  const dt = typeof d === "string" ? new Date(d) : d;
  return !isNaN(dt.getTime());
}

/** Format a date as a short date string in business timezone (Eastern) */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d || !isValidDateInput(d)) return "—";
  return new Date(d).toLocaleDateString("en-US", { timeZone: BIZ_TZ });
}

/** Format a date+time string in business timezone (Eastern) */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d || !isValidDateInput(d)) return "—";
  return new Date(d).toLocaleString("en-US", { timeZone: BIZ_TZ });
}

/** Format a date with weekday in business timezone */
export function fmtDateWeekday(d: string | Date | null | undefined, opts?: { year?: boolean }): string {
  if (!d || !isValidDateInput(d)) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    timeZone: BIZ_TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(opts?.year ? { year: "numeric" } : {}),
  });
}

/** Flexible escape hatch for one-off display formats. Always ET-anchored
 *  (timeZone is forced). Use this when fmtDate / fmtDateWeekday don't
 *  produce the exact shape you need — for example "Jun 6" without the
 *  weekday. NEVER call `.toLocaleDateString(undefined, ...)` directly. */
export function fmtDateOpts(
  d: string | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions,
): string {
  if (!d || !isValidDateInput(d)) return "—";
  return new Date(d).toLocaleDateString("en-US", { timeZone: BIZ_TZ, ...opts });
}

/** Flexible escape hatch for one-off time formats. Always ET-anchored. */
export function fmtTimeOpts(
  d: string | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions,
): string {
  if (!d || !isValidDateInput(d)) return "—";
  return new Date(d).toLocaleTimeString("en-US", { timeZone: BIZ_TZ, ...opts });
}

/** Current hour in ET (0-23). Use this for "is it morning?" / "good
 *  evening" / time-of-day-aware UI logic instead of `new Date().getHours()`
 *  (which would use the browser's local timezone — wrong for a user
 *  outside ET). Falls back to 12 (midday) if Intl is unavailable so the
 *  fallback never produces a wildly different result. */
export function bizHour(): number {
  try {
    return parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: BIZ_TZ,
        hour: "numeric",
        hour12: false,
      }).format(new Date()),
      10,
    );
  } catch {
    return 12;
  }
}

/** Current month (1-12) in ET. Use this for season/quarter detection
 *  instead of `new Date().getMonth() + 1`. */
export function bizMonth(): number {
  try {
    return parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: BIZ_TZ,
        month: "2-digit",
      }).format(new Date()),
      10,
    );
  } catch {
    return 1;
  }
}

/** Build a `<input type="datetime-local">` value (YYYY-MM-DDTHH:mm) from
 *  any Date / ISO string, ET-anchored. Pair with
 *  `bizParseLocalInputValue` on submit so the round-trip is consistent.
 *
 *  The HTML spec says `<input type="datetime-local">` `value` is in the
 *  user's local timezone. For an ET-anchored business, we instead show
 *  ET-equivalent wall-clock time so the operator sees what they expect
 *  regardless of their device clock. */
export function bizToLocalInputValue(d: Date | string): string {
  if (!d) return "";
  const date = bizDateKey(d);
  // bizDateKey returns "" for invalid input — propagate that here rather
  // than emitting "TInvalid Date" which would break <input type="datetime-local">.
  if (!date) return "";
  const time = new Date(d).toLocaleTimeString("en-GB", {
    timeZone: BIZ_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date}T${time}`;
}

/** Parse a `<input type="datetime-local">` value as an ET wall-clock
 *  time, returning a UTC ISO instant. The naive
 *  `new Date(value).toISOString()` interprets the value in the browser's
 *  local timezone — fine when the operator is in ET, wrong everywhere
 *  else. Always route datetime-local submissions through this helper.
 *
 *  Returns `""` for empty input. Throws if the value can't be split into
 *  date + time parts. */
export function bizParseLocalInputValue(value: string): string {
  if (!value) return "";
  const [date, time] = value.split("T");
  if (!date || !time) {
    throw new Error(`bizParseLocalInputValue: not a valid YYYY-MM-DDTHH:mm value: ${value}`);
  }
  return bizInstantFromEtParts(date, time);
}

/** Build a UTC ISO instant from an ET wall-clock date + time.
 *
 *  Use when the operator types something like "9:00 on June 6" in a
 *  date+time picker and we need an absolute instant for storage. The
 *  naive `new Date(date + "T" + time).toISOString()` interprets the
 *  string in the BROWSER's local timezone — fine when the operator is
 *  in ET, wrong if they're traveling or the dialog is open on a
 *  worker/client device in another zone. This helper always anchors
 *  the wall-clock interpretation to America/New_York, automatically
 *  picking the EDT (UTC-4) vs EST (UTC-5) offset for the given date.
 *
 *  Returns an ISO string ending in `.000Z` (UTC) so the backend can
 *  store it as a Prisma DateTime without any further conversion. */
export function bizInstantFromEtParts(dateKey: string, time: string): string {
  // dateKey: "YYYY-MM-DD", time: "HH:MM" (24-hour) or "HH:MM:SS"
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return "";
  const [y, m, d] = dateKey.split("-").map(Number);
  const timeParts = time.split(":").map(Number);
  const hh = timeParts[0] ?? 0;
  const mm = timeParts[1] ?? 0;
  const ss = timeParts[2] ?? 0;
  // Try BOTH candidate offsets (EDT and EST) and verify which one
  // round-trips to the requested wall-clock time when formatted in ET.
  // A naive single-probe approach (e.g. "probe noon UTC and pick the
  // offset that applies") gets the WRONG answer for times before 2 AM
  // on a DST spring-forward day, because the noon-UTC probe is on the
  // AFTER-shift side while the requested time is on the BEFORE-shift
  // side. The round-trip check is correct in every case.
  //
  // Ambiguous fall-back times (e.g. 1:30 AM on Nov 1) match BOTH
  // candidates. We deterministically prefer the EARLIER occurrence
  // (EDT, the first 1:30) so the round-trip is predictable.
  // Non-existent spring-forward times (e.g. 2:30 AM on Mar 8) match
  // NEITHER candidate. We fall back to EDT (the offset that would have
  // applied had the shift not happened) so we don't throw.
  const expected =
    String(hh).padStart(2, "0") + ":" +
    String(mm).padStart(2, "0") + ":" +
    String(ss).padStart(2, "0");
  const verifier = new Intl.DateTimeFormat("en-CA", {
    timeZone: BIZ_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  // Try EDT first so ambiguous fall-back times pick the earlier instance.
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, hh + offsetHours, mm, ss));
    const parts = Object.fromEntries(
      verifier.formatToParts(candidate).map((p) => [p.type, p.value]),
    );
    const formattedKey = `${parts.year}-${parts.month}-${parts.day}`;
    // Intl returns "24" for midnight in some browsers; normalize.
    const hourStr = parts.hour === "24" ? "00" : parts.hour;
    const formattedTime = `${hourStr}:${parts.minute}:${parts.second}`;
    if (formattedKey === dateKey && formattedTime === expected) {
      return candidate.toISOString();
    }
  }
  // Spring-forward gap (the requested time doesn't exist). Fall back to
  // the EDT interpretation — that's what the user would get if they
  // typed the same value 5 minutes later.
  return new Date(Date.UTC(y, m - 1, d, hh + 4, mm, ss)).toISOString();
}

/** Get the YYYY-MM-DD date string in business timezone (Eastern). The
 *  canonical key format for date inputs, URL params, localStorage keys,
 *  and any string-based date comparison.
 *
 *  ALWAYS use this instead of `.toISOString().slice(0, 10)` or
 *  `${y}-${m}-${d}` template literals built from `.getDate()` etc. */
export function bizDateKey(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  // Invalid input yields "" rather than the literal string "Invalid Date"
  // — silent failure here surfaces upstream as the canonical "no value"
  // signal that the rest of the helpers (fmtDate etc.) already treat as
  // missing.
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-CA", { timeZone: BIZ_TZ }); // en-CA gives YYYY-MM-DD
}

/** Today's date as YYYY-MM-DD in Eastern Time. */
export function bizToday(): string {
  return bizDateKey(new Date());
}

/** Tomorrow's date as YYYY-MM-DD in Eastern Time. Routes through
 *  bizAddDays on the bizToday() key — the previous `Date.now() + 86_400_000`
 *  pattern was DST-fragile when invoked within an hour of midnight ET on
 *  spring-forward / fall-back days (adding exactly 24 hours could land on
 *  the day-after-tomorrow or stay on today). */
export function bizTomorrow(): string {
  return bizAddDays(bizToday(), 1);
}

/** Yesterday's date as YYYY-MM-DD in Eastern Time. Same DST-safety
 *  rationale as bizTomorrow above. */
export function bizYesterday(): string {
  return bizAddDays(bizToday(), -1);
}

/** Add N days to a YYYY-MM-DD string, returning a new YYYY-MM-DD string.
 *  Handles month/year boundary rollover via the JS Date constructor's
 *  natural overflow semantics. Works in UTC noon to dodge DST edges.
 *  Returns "" if the input key isn't a valid YYYY-MM-DD — propagates
 *  the "invalid input" signal rather than producing a garbage Date that
 *  crashes Intl.format downstream. */
export function bizAddDays(key: string, n: number): string {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const [y, m, d] = key.split("-").map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d + n, 12));
  return new Intl.DateTimeFormat("en-CA", { timeZone: BIZ_TZ }).format(utcNoon);
}

/** Add N calendar months to a YYYY-MM-DD string. Day-of-month is CLAMPED
 *  to the last valid day of the target month — "the same day next month,
 *  or the last day of next month if that day doesn't exist." Use this
 *  instead of `d.setMonth(d.getMonth() + n)` on browser-local Date
 *  instants.
 *
 *  Examples:
 *    bizAddMonths("2026-01-31", 1) → "2026-02-28"  (clamped, not Mar 3)
 *    bizAddMonths("2024-01-31", 1) → "2024-02-29"  (clamped, leap year)
 *    bizAddMonths("2026-03-31", 1) → "2026-04-30"  (clamped, April has 30)
 *    bizAddMonths("2026-06-15", 1) → "2026-07-15"  (normal case)
 *    bizAddMonths("2025-12-15", 1) → "2026-01-15"  (year boundary)
 */
export function bizAddMonths(key: string, n: number): string {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const [y, m, d] = key.split("-").map(Number);
  // The last day of the target month: pass day 0 of (target + 1) — JS
  // Date constructor interprets day 0 as the last day of the prior month.
  // Use UTC throughout to dodge DST + browser-local quirks.
  const lastDayOfTargetMonth = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, lastDayOfTargetMonth);
  const utcNoon = new Date(Date.UTC(y, m - 1 + n, clampedDay, 12));
  return new Intl.DateTimeFormat("en-CA", { timeZone: BIZ_TZ }).format(utcNoon);
}

/** Add N calendar years to a YYYY-MM-DD string. Day-of-month is CLAMPED:
 *  Feb 29 in a leap year + 1 year → Feb 28 of the next (non-leap) year,
 *  NOT Mar 1 (which is what JS Date overflow would produce).
 *
 *  Examples:
 *    bizAddYears("2024-02-29", 1) → "2025-02-28"  (clamped, non-leap)
 *    bizAddYears("2024-02-29", 4) → "2028-02-29"  (target is also leap)
 *    bizAddYears("2026-06-15", 1) → "2027-06-15"  (normal case)
 */
export function bizAddYears(key: string, n: number): string {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const [y, m, d] = key.split("-").map(Number);
  const lastDayOfTargetMonth = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  const clampedDay = Math.min(d, lastDayOfTargetMonth);
  const utcNoon = new Date(Date.UTC(y + n, m - 1, clampedDay, 12));
  return new Intl.DateTimeFormat("en-CA", { timeZone: BIZ_TZ }).format(utcNoon);
}

/** Extract the year portion of a YYYY-MM-DD key as a number. Pure string
 *  math — no timezone risk. Use this instead of `new Date(key).getFullYear()`. */
export function bizYearOf(key: string): number {
  if (!key || !/^\d{4}/.test(key)) return NaN;
  return parseInt(key.slice(0, 4), 10);
}

/** Number of calendar days from `fromKey` to `toKey`, ET-anchored. Returns
 *  a signed integer: positive if `toKey` is later, negative if earlier.
 *
 *  Use this instead of `Math.round((d1.getTime() - d2.getTime()) / 86_400_000)`
 *  — that pattern silently drifts by an hour across DST boundaries and can
 *  round up / down to the wrong day count.
 *
 *  Both inputs MUST be YYYY-MM-DD strings (no time component). For mixed
 *  Date / ISO inputs, convert via `bizDateKey(d)` first. */
export function bizDaysBetween(fromKey: string, toKey: string): number {
  if (!fromKey || !toKey || !/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey)) return NaN;
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  // Use UTC noon for both ends so DST has no effect: noon UTC × 24h is
  // always exactly 86_400_000 ms apart.
  const fromUtc = Date.UTC(fy, fm - 1, fd, 12);
  const toUtc = Date.UTC(ty, tm - 1, td, 12);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

/** The Monday on-or-before today, as YYYY-MM-DD in Eastern Time. The
 *  canonical week-start for the operator's calendar. */
export function bizMondayOnOrBefore(): string {
  const today = bizToday();
  const [y, m, d] = today.split("-").map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12));
  const dow = utcNoon.getUTCDay(); // 0 = Sun ... 6 = Sat
  const daysBack = dow === 0 ? 6 : dow - 1;
  return bizAddDays(today, -daysBack);
}

/** First day of the current month as YYYY-MM-DD in Eastern Time. */
export function bizStartOfMonth(): string {
  return `${bizToday().slice(0, 7)}-01`;
}

/** January 1st of the current year as YYYY-MM-DD in Eastern Time. */
export function bizStartOfYear(): string {
  return `${bizToday().slice(0, 4)}-01-01`;
}

/** Append " JOB" to client display names for display purposes. */
export function jobTypeLabel(value: string | null | undefined): string {
  if (!value) return "";
  const opt = JOB_TYPE_OPTIONS.find((o) => o.value === value);
  return opt?.label ?? value;
}

export function clientLabel(name: string | null | undefined): string {
  if (!name) return "";
  return `${name} JOB`;
}

export function notifyEquipmentUpdated() {
  try {
    window.dispatchEvent(new CustomEvent("seedlings3:equipment-updated"));
  } catch {}
}

export function errorMessage(err: any): string {
  return (
    err?.message ||
    err?.data?.message ||
    err?.response?.data?.message ||
    "Action failed"
  );
}

// Pretty-print status like other tabs: "Available", "Checked out", etc.
export function prettyStatus(s: string): string {
  if (!s) return "—";
  if (s.toUpperCase() === "CLOSED") return "Completed";
  // "Stream" is internal-only terminology (matches schema field names).
  // The user-facing concept is "Repeating" — a paused recurring stream.
  if (s.toUpperCase() === "STREAM_PAUSED") return "Repeating Paused";
  return s
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function extractSlug(value: string): string {
  try {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : value;
    }
    return value;
  } catch {
    // In case it's not a valid URL even though it starts with protocol
    return value;
  }
}

export function equipmentStatusColor(value: string): string {
  const act = (value || "").toUpperCase();
  if (
    act.includes("AVAILABLE") ||
    act.includes("CREATED") ||
    act.includes("MAINTENANCE_END") ||
    act.includes("RETURNED") ||
    act.includes("CANCELLED") ||
    act.includes("RELEASED") ||
    act.includes("UNRETIRED")
  )
    return "green";
  if (act.includes("RESERVED")) return "purple";
  if (act.includes("CHECKED_OUT")) return "cyan";
  if (act.includes("MAINTENANCE_START") || act === "MAINTENANCE")
    return "yellow";
  if (act.includes("APPROVED") || act.includes("ROLE_ASSIGNED"))
    return "purple";
  if (act.includes("UPDATED")) return "teal";
  if (act.includes("RELEASED") || act.includes("FORCE_RELEASED")) return "blue";
  if (
    act.includes("RETIRED") ||
    act.includes("DELETED") ||
    act.includes("REMOVED")
  )
    return "red";
  return "gray";
}

export function clientStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t.includes("ACTIVE")) return "green";
  if (t.includes("ARCHIVED")) return "red";
  return "gray";
}

export function propertyStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t.includes("ACTIVE")) return "green";
  if (t.includes("ARCHIVED")) return "red";
  return "gray";
}

export function prettyDate(iso?: string | null) {
  if (!iso || !isValidDateInput(iso)) return "—";
  try {
    // ET-anchored. `toLocaleString([], opts)` defaults to the browser's
    // local timezone — that emits PST/CST/etc. text for non-ET users,
    // which contradicts the rest of the app's ET pinning. Always force
    // `timeZone: BIZ_TZ` here, same as fmtDateTime + friends.
    return new Date(iso).toLocaleString("en-US", {
      timeZone: BIZ_TZ,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso || "—";
  }
}

export type BadgeColorsVariant = "subtle" | "outline" | "solid";

export function badgeColors(
  palette: string,
  variant: BadgeColorsVariant = "subtle"
) {
  if (variant === "subtle") {
    return {
      bg: `${palette}.100`,
      color: `${palette}.700`,
      border: "1px solid",
      borderColor: `${palette}.200`,
    };
  }
  if (variant === "outline") {
    return {
      bg: `${palette}.200`,
      color: `${palette}.700`,
      border: "1px solid",
      borderColor: `${palette}.300`,
    };
  }
  if (palette === "gray") return { bg: "gray.500", color: "white" };
  return { bg: `${palette}.600`, color: "white" };
}

export function jobStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t === "ACCEPTED") return "green";
  if (t === "PROPOSED") return "orange";
  if (t === "PAUSED") return "yellow";
  return "gray";
}

export function occurrenceStatusColor(value: string): string {
  const t = (value || "").toUpperCase();
  if (t === "PENDING_PAYMENT") return "orange";
  if (t === "CLOSED") return "gray";
  if (t === "IN_PROGRESS") return "cyan";
  if (t === "PAUSED") return "orange";
  // Stream-pause chip uses purple to visually distinguish from the
  // orange "worker timer paused" chip. Two different concepts sharing
  // color would confuse admins reading the same list.
  if (t === "STREAM_PAUSED") return "purple";
  if (t === "SCHEDULED") return "blue";
  if (t === "PROPOSAL_SUBMITTED") return "teal";
  if (t === "ACCEPTED") return "green";
  if (t === "REJECTED") return "red";
  if (t === "CANCELED") return "red";
  if (t === "ARCHIVED") return "gray";
  return "gray";
}

export const hasRole = (roles: Me["roles"] | undefined, role: Role) =>
  !!roles?.includes(role);

export function determineRoles(me: Me | null, purpose: Role) {
  const isWorker = hasRole(me?.roles, "WORKER");
  const isAdmin = hasRole(me?.roles, "ADMIN");
  const isSuper = hasRole(me?.roles, "SUPER");
  return {
    isWorker: isWorker,
    isAdmin: isAdmin,
    isSuper: isSuper,
    isAvail: isAdmin || isWorker,
    // Admin-flavored views — true on either the Admin shell OR the Super
    // shell, since Super always inherits Admin capabilities and the Super
    // tabs lean on the same admin-mode rendering. Tabs that want to
    // further distinguish "Super inner tab" from "Admin inner tab" should
    // gate on `purpose === "SUPER"` directly (e.g. EquipmentTab uses this
    // to expose the act-on-behalf-of-worker buttons in addition to the
    // admin controls).
    forAdmin: (purpose === "ADMIN" && isAdmin) || (purpose === "SUPER" && (isSuper || isAdmin)),
  };
}
