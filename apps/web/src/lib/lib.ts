import { Me, Role, JOB_TYPE_OPTIONS } from "@/src/lib/types";

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const BIZ_TZ = "America/New_York";

// ─────────────────────────────────────────────────────────────────────────────
// DATE HELPERS — the SINGLE source of truth on the web side.
//
// Why this section exists:
//   The business operates in Eastern Time. Browsers run in the user's local
//   timezone. The default JS Date methods (`toISOString`, `.getDate()`,
//   `.getMonth()`, etc.) all use UTC or local time, neither of which is the
//   operator's calendar day near midnight. We've been bitten by this in many
//   places (Exports tab history, PnL Report, Accounting tab, JobsTab filters,
//   the Gusto CSV Pay Period End column, etc.) — every fix patches one site;
//   the bug keeps coming back because each callsite reinvents the formatter.
//
// The rules:
//   - Format a Date for display: `fmtDate(d)` / `fmtDateTime(d)` / `fmtDateWeekday(d)`
//   - Get a YYYY-MM-DD key (date-input value, URL param, localStorage key,
//     date-comparison key): `bizDateKey(d)`. Accepts a Date or an ISO string.
//   - Today / tomorrow / yesterday as YYYY-MM-DD: `bizToday()` / `bizTomorrow()` /
//     `bizYesterday()`.
//   - This week's Monday / current month start / current year start as
//     YYYY-MM-DD: `bizMondayOnOrBefore()` / `bizStartOfMonth()` / `bizStartOfYear()`.
//   - Add days to a YYYY-MM-DD string (handles month/year rollover correctly):
//     `bizAddDays(key, n)`.
//
// FORBIDDEN patterns (use the helpers above instead):
//   • `d.toISOString().slice(0, 10)` — uses UTC, wrong calendar day near
//     midnight ET (e.g. user picks 6/6, this emits 6/7).
//   • `d.getFullYear()` / `d.getMonth()` / `d.getDate()` chains — use the
//     browser's local time, which on a server build is UTC.
//   • `d.setHours(0, 0, 0, 0)` — uses local time, wrong on most servers.
//   • `new Date(YYYY, MM, DD)` — creates a Date at the browser's local
//     midnight, which depends on the user's timezone. Use `bizDateKey()`
//     or work in YYYY-MM-DD strings until you have a real timestamp.
//
// If a new helper would be useful, add it here. Don't reinvent date math
// at the callsite — that's how the bug keeps coming back.
// ─────────────────────────────────────────────────────────────────────────────

/** Format a date as a short date string in business timezone (Eastern) */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { timeZone: BIZ_TZ });
}

/** Format a date+time string in business timezone (Eastern) */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { timeZone: BIZ_TZ });
}

/** Format a date with weekday in business timezone */
export function fmtDateWeekday(d: string | Date | null | undefined, opts?: { year?: boolean }): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    timeZone: BIZ_TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(opts?.year ? { year: "numeric" } : {}),
  });
}

/** Get the YYYY-MM-DD date string in business timezone (Eastern). The
 *  canonical key format for date inputs, URL params, localStorage keys,
 *  and any string-based date comparison.
 *
 *  ALWAYS use this instead of `.toISOString().slice(0, 10)` or
 *  `${y}-${m}-${d}` template literals built from `.getDate()` etc. */
export function bizDateKey(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleDateString("en-CA", { timeZone: BIZ_TZ }); // en-CA gives YYYY-MM-DD
}

/** Today's date as YYYY-MM-DD in Eastern Time. */
export function bizToday(): string {
  return bizDateKey(new Date());
}

/** Tomorrow's date as YYYY-MM-DD in Eastern Time. */
export function bizTomorrow(): string {
  return bizDateKey(new Date(Date.now() + 86_400_000));
}

/** Yesterday's date as YYYY-MM-DD in Eastern Time. */
export function bizYesterday(): string {
  return bizDateKey(new Date(Date.now() - 86_400_000));
}

/** Add N days to a YYYY-MM-DD string, returning a new YYYY-MM-DD string.
 *  Handles month/year boundary rollover via the JS Date constructor's
 *  natural overflow semantics. Works in UTC noon to dodge DST edges. */
export function bizAddDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d + n, 12));
  return new Intl.DateTimeFormat("en-CA", { timeZone: BIZ_TZ }).format(utcNoon);
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
  if (t.includes("PAUSED")) return "orange";
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
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
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
