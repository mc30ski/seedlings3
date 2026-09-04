// Severe-weather alerts — shared shape + presentation, used everywhere the
// app already shows weather.
//
// ADDITIVE BY DESIGN. These come from the National Weather Service on top of
// the OpenWeather data that drives temperature and forecast. The API returns
// `alerts: []` whenever NWS is disabled, unreachable, or returns something
// unexpected, so every consumer must treat an empty array as the normal case
// and render exactly as it did before alerts existed.

import type { LucideIcon } from "lucide-react";
import {
  Thermometer, Snowflake, CloudLightning, Tornado, Waves,
  Wind, Factory, CloudFog, Flame, TriangleAlert,
} from "lucide-react";

export type AlertKind =
  | "heat" | "cold" | "storm" | "tornado" | "flood"
  | "wind" | "air" | "fog" | "fire" | "other";

export type WeatherAlert = {
  id: string;
  event: string;
  severity: "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
  headline: string;
  instruction: string | null;
  onset: string | null;
  ends: string | null;
  /** ET date keys this alert covers — lets a per-day surface show it only on
   *  the days it actually applies to. */
  dateKeys: string[];
  kind: AlertKind;
};

const ICONS: Record<AlertKind, LucideIcon> = {
  heat: Thermometer,
  cold: Snowflake,
  storm: CloudLightning,
  tornado: Tornado,
  flood: Waves,
  wind: Wind,
  air: Factory,
  fog: CloudFog,
  fire: Flame,
  other: TriangleAlert,
};

export const alertIcon = (kind: AlertKind): LucideIcon => ICONS[kind] ?? TriangleAlert;

/** Chakra palette per alert. Extreme and Severe are red on purpose — a crew
 *  should not have to read the words to know which one matters.
 *
 *  HEAT IS ALWAYS RED regardless of severity. The NWS files a Heat Advisory as
 *  merely "Moderate", which rendered it in the same orange as the "unconfirmed
 *  jobs" chip sitting inches away in the same header — two completely
 *  different urgencies, identical colour. For an outdoor crew in a Carolina
 *  summer, heat is the alert that actually puts someone in hospital. */
export function alertTone(a: Pick<WeatherAlert, "severity" | "kind">): string {
  if (a.kind === "heat") return "red";
  if (a.severity === "Extreme" || a.severity === "Severe") return "red";
  if (a.severity === "Moderate") return "orange";
  return "yellow";
}

const SEVERITY_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

/** Most urgent first — what a single-slot surface (title bar) should show.
 *
 *  Prefers an alert covering TODAY. An advisory that starts tomorrow is real
 *  and worth flagging, but showing it identically to one in force right now
 *  makes every date-scoped surface look broken: the title bar said "heat" and
 *  the Today section, correctly, showed nothing. */
export function topAlert(
  alerts: WeatherAlert[] | undefined,
  todayKey?: string,
): { alert: WeatherAlert; today: boolean } | null {
  if (!alerts?.length) return null;
  const byUrgency = [...alerts].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  if (todayKey) {
    const now = byUrgency.find((a) => a.dateKeys.includes(todayKey));
    if (now) return { alert: now, today: true };
  }
  return { alert: byUrgency[0], today: !todayKey };
}

/** "today" | "tomorrow" | a weekday name — for saying WHEN an alert applies. */
export function whenLabel(a: WeatherAlert, todayKey: string, tomorrowKey: string): string {
  if (a.dateKeys.includes(todayKey)) return "today";
  if (a.dateKeys.includes(tomorrowKey)) return "tomorrow";
  const first = a.dateKeys[0];
  if (!first) return "";
  return new Date(`${first}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long" });
}

/** Alerts covering a specific ET date key, for per-day surfaces like a job
 *  card or a dated forecast row. */
export function alertsForDate(alerts: WeatherAlert[] | undefined, dateKey: string): WeatherAlert[] {
  return (alerts ?? []).filter((a) => a.dateKeys.includes(dateKey));
}

/** Short label for tight spaces — "Heat Advisory" → "Heat". The full event
 *  name goes in the tooltip. */
export function shortLabel(a: WeatherAlert): string {
  return a.event
    .replace(/\b(Advisory|Warning|Watch|Statement)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || a.event;
}
