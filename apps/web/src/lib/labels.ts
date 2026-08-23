"use client";

// Human-readable labels and small display helpers — turning enum-ish
// values into words a person reads.
//
// Split out of the old `lib.ts`. These are pure string transforms with no
// date or role dependency.

import { JOB_TYPE_OPTIONS } from "@/src/lib/types";

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));


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

// ═════════════════════════════════════════════════════════════════════════════
// Branded date types (Phase 2)
// ═════════════════════════════════════════════════════════════════════════════
//
// TypeScript can't tell `"2026-08-12"` (an ET calendar-day key) from
// `"2026-08-12T12:00:00Z"` (a UTC instant) — both are `string`. Every date
// helper that accepts `string | Date` is a landmine when a caller passes
// the wrong shape (silent off-by-one, silent regex-fail-to-empty-string,
// silent DST drift). The runtime auto-route in the formatters (Phase 1)
// closed the display class of that bug. These brands close the compile-
// time class for arithmetic + comparison + storage.
//
// Both brands compile to `string` at runtime — they're zero-cost lenses
// TypeScript uses to reject miscalls at build time. The brand strings
// are structurally-typed and shared with `apps/api/src/lib/dates.ts` so
// a key produced on the API is interchangeable with one produced on the
// web (same brand, same identity).

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
