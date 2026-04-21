import { bizDateKey } from "@/src/lib/lib";

function localDate(d: Date): string {
  return bizDateKey(d);
}

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
  | "all"
  | null; // null = custom dates

export function computeDatesFromPreset(preset: DatePreset): { from: string; to: string } {
  const today = new Date();
  switch (preset) {
    case "now": {
      const d = new Date(today);
      d.setDate(d.getDate() + 2);
      return { from: localDate(today), to: localDate(d) };
    }
    case "today":
      return { from: localDate(today), to: localDate(today) };
    case "yesterday": {
      const d = new Date(today);
      d.setDate(d.getDate() - 1);
      return { from: localDate(d), to: localDate(d) };
    }
    case "next3": {
      const d = new Date(today);
      d.setDate(d.getDate() + 2);
      return { from: localDate(today), to: localDate(d) };
    }
    case "overdueAndNext3": {
      const d = new Date(today);
      d.setDate(d.getDate() + 3);
      const from = new Date(today);
      from.setDate(from.getDate() - 60);
      return { from: localDate(from), to: localDate(d) };
    }
    case "overdueOnly": {
      const d = new Date(today);
      d.setDate(d.getDate() - 1);
      return { from: "", to: localDate(d) };
    }
    case "overdueAndNextWeek": {
      const d = new Date(today);
      d.setDate(d.getDate() + 7);
      return { from: "", to: localDate(d) };
    }
    case "thisWeek":
    case "nextWeek": {
      const d = new Date(today);
      d.setDate(d.getDate() + 6);
      return { from: localDate(today), to: localDate(d) };
    }
    case "thisMonth":
    case "nextMonth": {
      const d = new Date(today);
      d.setMonth(d.getMonth() + 1);
      return { from: localDate(today), to: localDate(d) };
    }
    case "future":
      return { from: localDate(today), to: "" };
    case "recent": {
      const d = new Date(today);
      d.setDate(d.getDate() - 30);
      return { from: localDate(d), to: "" };
    }
    case "rolling": {
      const from = new Date(today);
      from.setMonth(from.getMonth() - 1);
      const to = new Date(today);
      to.setDate(to.getDate() + 7);
      return { from: localDate(from), to: localDate(to) };
    }
    case "lastWeek": {
      const d = new Date(today);
      d.setDate(d.getDate() - 7);
      return { from: localDate(d), to: localDate(today) };
    }
    case "lastMonth": {
      const d = new Date(today);
      d.setMonth(d.getMonth() - 1);
      return { from: localDate(d), to: localDate(today) };
    }
    case "all":
      return { from: "", to: "" };
    default:
      // fallback to next month
      const d = new Date(today);
      d.setMonth(d.getMonth() + 1);
      return { from: localDate(today), to: localDate(d) };
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
  all: "All time",
};
