// ─────────────────────────────────────────────────────────────────────────────
// Hour-by-hour weather for the day a job is scheduled — the WHOLE day.
//
// WHY OPEN-METEO. The operator's requirement, in their words: "I still would
// like to see the previous hours because it might be that there was rain early
// that day, and that could effect if i decide to go out there if it's too wet."
//
// That rules out every forecast-only product. NWS's hourly forecast begins at
// the CURRENT HOUR — ask it at 5pm and the earliest period it returns is 4pm,
// so the morning is simply not in the response. OpenWeather's free tier is
// 3-hour steps and its history needs a paid One Call subscription.
//
// Open-Meteo answers both halves from one model: `past_days` backfills the
// elapsed hours of the day and the forecast runs forward from now. It is free,
// needs no key, and — the part that matters for a lawn — is GRIDDED, so it
// resolves to the property rather than to a physical station. That distinction
// already decided a previous round of this feature: NWS *observations* would
// have reported Raleigh-Durham airport, ~20 miles east, for every one of these
// properties.
//
// TWO QUANTITIES, NOT ONE. Before now, the honest number is how much rain
// ACTUALLY FELL. After now, it is the CHANCE of rain. "A 40% chance it rained
// at 9am" is not a thing — we know whether it did. The two are carried in
// separate fields and the chart draws them differently.
//
// LAZY BY CONSTRUCTION. Nothing here runs until someone opens the section on a
// card. The operator was explicit that a weather call per job on every feed
// render is not worth paying for in latency, however free the API is.
//
// TIME IS HANDLED IN INSTANTS. The API is asked for `timeformat=unixtime`, so
// every timestamp arrives as an unambiguous epoch second and never as a local
// string that has to be re-interpreted. ET only enters at the point a label is
// rendered, through the canonical helper.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import { cached, invalidate } from "../lib/cache";
import { resolvePropertyPoint } from "./parcels";
import { etClockTime, etDaysBetween, etFormatDate, etHourAxisLabel, type EtDateKey } from "../lib/dates";

export type ForecastHour = {
  /** Full ISO instant. */
  startTime: string;
  /** "4:00 PM" in ET — the tooltip form, matching how every other timestamp in
   *  the app is rendered. */
  label: string;
  /** "4p" in ET — the axis form. A whole day is ~24 labels in a row on a
   *  phone, so it has to be two or three characters. Derived from the same
   *  formatter as `label`, never by slicing it. */
  axisLabel: string;
  tempF: number | null;
  /** Chance of rain, percent. Meaningful for hours still AHEAD. Null when the
   *  provider omits it — which is not the same as zero, and a chart must not
   *  draw it as a zero bar. */
  precipPct: number | null;
  /** Rain that actually fell, in inches. Meaningful for hours already ELAPSED.
   *  This is the field that answers "is the ground going to be soaked". */
  precipIn: number | null;
  windMph: number | null;
  shortForecast: string | null;
  /** The hour has finished. Its rainfall is a measurement, not a probability. */
  isPast: boolean;
  /** The hour happening right now — the chart's anchor. False on every hour of
   *  a day that is not today, which is correct: there is no "now" on Thursday. */
  isCurrentHour: boolean;
};

export type HourlyForecast =
  /** `isToday` exists so the caller can say WHY no column is marked. On a
   *  future day there is no current hour, so nothing is highlighted — which
   *  looks identical to the marker being broken unless the copy says
   *  otherwise. That ambiguity is exactly what got reported once already. */
  | { available: true; hours: ForecastHour[]; dateKey: string; isToday: boolean; locatedBy: string; fetchedAt: string; stale: boolean }
  | { available: false; reason: "past" | "no-location" | "beyond-horizon" | "unavailable" | "disabled"; message: string };

/**
 * Operator-tunable settings, same shape as ALERT_SETTINGS in weatherAlerts.ts:
 * key → [default, description]. The seed generates a row per entry from this
 * map, so a tunable cannot exist in code without a row to change it, and the
 * service falls back to the default when the row is missing — which is what
 * keeps a fresh environment (and production before its rows are created)
 * working rather than dark.
 *
 * The BASE url is configurable, not the whole query string. That is a
 * deliberate difference from NWS_ALERTS_URL: the parameters here are a
 * contract, not a preference. `past_days` is what makes the elapsed hours of
 * the day appear at all, and `timeformat=unixtime` is what keeps every
 * timestamp an unambiguous instant. An operator editing a full template could
 * silently drop either — the chart would still render, just without the
 * morning, or with hours in the wrong zone. Pointing the base at a
 * self-hosted Open-Meteo instance is the real use case, and this covers it.
 */
export const HOURLY_WEATHER_SETTINGS: Record<string, [string, string]> = {
  HOURLY_WEATHER_ENABLED: [
    "true",
    "Master switch for the hour-by-hour weather chart on job cards. Turn off to hide the section everywhere without a deploy. The weather recorded at job start and finish is stored separately and is unaffected.",
  ],
  HOURLY_WEATHER_BASE_URL: [
    "https://api.open-meteo.com/v1/forecast",
    "Endpoint for the hourly chart. Open-Meteo is free and needs no API key, and unlike a forecast-only service it can return the hours of the day that have already passed — which is what answers 'did it rain here this morning'. Point this at a self-hosted Open-Meteo instance if you run one; another provider would need a matching response shape.",
  ],
};

/** Read the settings, falling back to the defaults above for any missing row. */
async function loadSettings() {
  const rows = await prisma.setting.findMany({
    where: { key: { in: Object.keys(HOURLY_WEATHER_SETTINGS) } },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const get = (k: string) => map.get(k)?.trim() || HOURLY_WEATHER_SETTINGS[k][0];
  return {
    enabled: get("HOURLY_WEATHER_ENABLED") !== "false",
    baseUrl: get("HOURLY_WEATHER_BASE_URL").replace(/\?+$/, ""),
  };
}

/** Open-Meteo's forecast horizon, in days. */
const MAX_FORECAST_DAYS = 16;

/** WMO weather codes, bucketed. The provider returns a number where NWS
 *  returned prose; these are the buckets that change whether a crew goes out,
 *  not a full translation of the code table. */
function describeWmo(code: number | null): string | null {
  if (code == null || !Number.isFinite(code)) return null;
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorm";
}

/**
 * The forecast for one occurrence's working day.
 *
 * Returns `available: false` with a REASON rather than an empty list, because
 * "we have no data" and "it will not rain" look identical in a bar chart and
 * mean opposite things. The caller renders the reason.
 */
export async function hourlyForecastForOccurrence(
  occurrenceId: string,
  opts: { refresh?: boolean } = {},
): Promise<HourlyForecast> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return {
      available: false,
      reason: "disabled",
      message: "The hourly weather chart is turned off in Settings.",
    };
  }

  const occ = await prisma.jobOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      // startAt for the DAY only — its time component is not meaningful here.
      // Jobs are scheduled by day; the time is a storage artifact.
      id: true, startAt: true,
      job: { select: { propertyId: true } },
    },
  });
  if (!occ?.startAt) {
    return { available: false, reason: "unavailable", message: "This visit has no scheduled time." };
  }

  const dateKey = etFormatDate(occ.startAt) as EtDateKey;
  const todayKey = etFormatDate(new Date()) as EtDateKey;
  if (dateKey < todayKey) {
    return {
      available: false,
      reason: "past",
      message: "This visit is in the past. The weather recorded when the job was started and completed is shown above.",
    };
  }

  if (!occ.job?.propertyId) {
    return { available: false, reason: "no-location", message: "This item has no property to look up." };
  }
  const point = await resolvePropertyPoint(occ.job.propertyId);
  if (!point) {
    return {
      available: false,
      reason: "no-location",
      message: "We couldn't work out where this property is, so there's no forecast to fetch. Opening the property's county record usually resolves it.",
    };
  }

  // How far ahead the target day sits, so we ask for exactly enough days.
  // Day 0 is today, and `forecast_days` counts today as one of them.
  //
  // Via the canonical helper, not a millisecond division: subtracting two
  // timestamps and dividing by a day is DST-fragile, and the build gate is
  // right to refuse it. Calendar-day distance is a calendar question.
  const daysAhead = etDaysBetween(todayKey, dateKey);
  if (daysAhead + 2 > MAX_FORECAST_DAYS) {
    return {
      available: false,
      reason: "beyond-horizon",
      message: "The forecast doesn't reach this far ahead yet — it runs about two weeks out. Check back closer to the day.",
    };
  }

  // past_days=1 backfills the elapsed hours of TODAY, which is the whole point
  // of this provider. It costs nothing extra on a future-dated visit, and the
  // day filter below discards what is not wanted.
  const url =
    `${settings.baseUrl}?latitude=${point.lat.toFixed(4)}&longitude=${point.lng.toFixed(4)}` +
    `&hourly=temperature_2m,precipitation,precipitation_probability,wind_speed_10m,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
    // +2, not +1: the buckets are UTC days and ET runs 4-5 hours behind, so an
    // ET day's last hours fall into the NEXT UTC day. Asking for exactly the
    // days ahead returned a day that stopped at 19:00 ET. The ET day filter
    // below discards the surplus, so over-fetching costs nothing.
    `&past_days=1&forecast_days=${Math.min(MAX_FORECAST_DAYS, daysAhead + 2)}&timeformat=unixtime&timezone=UTC`;

  let body: any;
  let fetchedAt = new Date().toISOString();
  let stale = false;
  try {
    // An explicit refresh drops OUR copy so the next read goes upstream. Worth
    // knowing at the callsite: the model reissues hourly, so a refresh a minute
    // after the last one can honestly return identical numbers. The "as of"
    // stamp is what tells the operator which it was.
    if (opts.refresh) await invalidate("openMeteoHourly", url);
    const got = await cached("openMeteoHourly", url, async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
      return res.json();
    });
    body = got.value;
    fetchedAt = got.fetchedAt;
    stale = got.stale;
  } catch {
    return {
      available: false,
      reason: "unavailable",
      message: "The weather service didn't answer just now. Try again in a few minutes.",
    };
  }

  // Parallel arrays, one entry per hour. A missing series is null throughout
  // rather than an exception — a partial reading is worth drawing.
  const h = body?.hourly ?? {};
  const times: number[] = Array.isArray(h.time) ? h.time : [];
  const at = (series: any, i: number): number | null => {
    const v = Array.isArray(series) ? series[i] : null;
    return Number.isFinite(Number(v)) ? Number(v) : null;
  };

  const nowMs = Date.now();
  const hours: ForecastHour[] = [];
  for (let i = 0; i < times.length; i++) {
    // Epoch SECONDS, because the request asked for unixtime — no local-time
    // string to re-interpret, and no timezone guess anywhere in this path.
    const t = Number(times[i]) * 1000;
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    if (etFormatDate(d) !== dateKey) continue;

    hours.push({
      startTime: d.toISOString(),
      label: etClockTime(d),
      axisLabel: etHourAxisLabel(d),
      tempF: at(h.temperature_2m, i),
      precipPct: at(h.precipitation_probability, i),
      precipIn: at(h.precipitation, i),
      windMph: at(h.wind_speed_10m, i),
      shortForecast: describeWmo(at(h.weather_code, i)),
      // An hour is PAST only once it has finished — mid-hour, its rainfall
      // is a partial number that would understate the hour, so the current
      // column is read as a forecast.
      isPast: t + 3_600_000 <= nowMs,
      isCurrentHour: t <= nowMs && nowMs < t + 3_600_000,
    });
  }

  if (hours.length === 0) {
    return {
      available: false,
      reason: "beyond-horizon",
      message: "The forecast doesn't reach this far ahead yet — it runs about two weeks out. Check back closer to the day.",
    };
  }

  return { available: true, hours, dateKey, isToday: dateKey === todayKey, locatedBy: point.located, fetchedAt, stale };
}
