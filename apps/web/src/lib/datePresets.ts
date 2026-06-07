import { bizToday, bizAddDays, bizAddMonths, bizAddYears } from "@/src/lib/lib";

// Every preset returns a YYYY-MM-DD string key. All arithmetic is on
// string keys via the canonical helpers — no `.setDate()` /
// `.setMonth()` / `.setFullYear()` on Date instants (which would mix
// browser-local time into an ET-anchored calendar). See
// docs/DATE_HANDLING.md.

export type DatePreset =
  | "now"
  | "today"
  | "next3"
  | "overdueAndNext3"
  | "overdueOnly"
  | "overdueAndNextWeek"
  | "thisWeek"
  | "nextWeek"
  | "thisMonth"
  | "nextMonth"
  | "future"
  | "recent"
  | "rolling"
  | "yesterday"
  | "lastWeek"
  | "lastMonth"
  | "lastYear"
  | "thisYear"
  | "all"
  | null; // null = custom dates

export function computeDatesFromPreset(preset: DatePreset): { from: string; to: string } {
  const today = bizToday();
  switch (preset) {
    case "now":
      return { from: today, to: bizAddDays(today, 2) };
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = bizAddDays(today, -1);
      return { from: y, to: y };
    }
    case "next3":
      return { from: today, to: bizAddDays(today, 2) };
    case "overdueAndNext3":
      return { from: bizAddDays(today, -60), to: bizAddDays(today, 3) };
    case "overdueOnly":
      return { from: "", to: bizAddDays(today, -1) };
    case "overdueAndNextWeek":
      return { from: "", to: bizAddDays(today, 7) };
    case "thisWeek":
    case "nextWeek":
      return { from: today, to: bizAddDays(today, 6) };
    case "thisMonth":
    case "nextMonth":
      return { from: today, to: bizAddMonths(today, 1) };
    case "future":
      return { from: today, to: "" };
    case "recent":
      return { from: bizAddDays(today, -30), to: "" };
    case "rolling":
      return { from: bizAddMonths(today, -1), to: bizAddDays(today, 7) };
    case "lastWeek":
      return { from: bizAddDays(today, -7), to: today };
    case "lastMonth":
      return { from: bizAddMonths(today, -1), to: today };
    case "lastYear":
      // Rolling 12 months ending today (matches lastWeek/lastMonth shape).
      return { from: bizAddYears(today, -1), to: today };
    case "thisYear":
      // Forward-looking, matching thisWeek (today → +6 days) and thisMonth (today → +1 month).
      return { from: today, to: bizAddYears(today, 1) };
    case "all":
      return { from: "", to: "" };
    default:
      // fallback to next month
      return { from: today, to: bizAddMonths(today, 1) };
  }
}

export const PRESET_LABELS: Record<string, string> = {
  now: "Now (3 days)",
  today: "Today",
  next3: "Next 3 days",
  overdueOnly: "Overdue only",
  overdueAndNext3: "Last 60 days + Next 3 days",
  overdueAndNextWeek: "Overdue + Next week",
  thisWeek: "This week",
  nextWeek: "This week",
  thisMonth: "This month",
  nextMonth: "This month",
  future: "Future",
  recent: "Recent & Future",
  rolling: "Rolling",
  yesterday: "Yesterday",
  lastWeek: "Last week",
  lastMonth: "Last month",
  lastYear: "Last year",
  thisYear: "This year",
  all: "All time",
};
