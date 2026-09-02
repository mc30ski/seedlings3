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

/** Chakra palette per severity. Extreme and Severe are red on purpose — a
 *  crew should not have to read the words to know which one matters. */
export function alertTone(severity: WeatherAlert["severity"]): string {
  if (severity === "Extreme" || severity === "Severe") return "red";
  if (severity === "Moderate") return "orange";
  return "yellow";
}

/** Most urgent first — what a single-slot surface (title bar) should show. */
export function topAlert(alerts: WeatherAlert[] | undefined): WeatherAlert | null {
  if (!alerts?.length) return null;
  const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
  return [...alerts].sort((a, b) => rank[a.severity] - rank[b.severity])[0];
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
