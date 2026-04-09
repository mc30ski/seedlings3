import { bizDateKey } from "@/src/lib/lib";

function localDate(d: Date): string {
  return bizDateKey(d);
}

export type DatePreset =
  | "today"
  | "next3"
  | "overdueAndNext3"
  | "overdueOnly"
  | "overdueAndNextWeek"
  | "nextWeek"
  | "nextMonth"
  | "future"
  | "recent"
  | "yesterday"
  | "lastWeek"
  | "all"
  | null; // null = custom dates

export function computeDatesFromPreset(preset: DatePreset): { from: string; to: string } {
  const today = new Date();
  switch (preset) {
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
      return { from: "", to: localDate(d) };
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
    case "nextWeek": {
      const d = new Date(today);
      d.setDate(d.getDate() + 6);
      return { from: localDate(today), to: localDate(d) };
    }
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
    case "lastWeek": {
      const d = new Date(today);
      d.setDate(d.getDate() - 7);
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
  today: "Today",
  next3: "Next 3 days",
  overdueOnly: "Overdue only",
  overdueAndNext3: "Overdue + Next 3 days",
  overdueAndNextWeek: "Overdue + Next week",
  nextWeek: "Next week",
  nextMonth: "Next month",
  future: "Future",
  recent: "Recent & Future",
  yesterday: "Yesterday",
  lastWeek: "Last week",
  all: "All time",
};
