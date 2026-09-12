// ─────────────────────────────────────────────────────────────────────────────
// Hour-by-hour forecast for the day a job is scheduled.
//
// WHY NWS AND NOT OPENWEATHER: the free OpenWeather tier returns 3-hour steps,
// so a 9am–12pm job collapses into a single 09:00 reading. True hourly needs
// One Call 3.0, a paid subscription. NWS gives 156 genuinely hourly periods
// for free with no key, and the app is already an NWS consumer for alerts.
//
// AND NOT NWS OBSERVATIONS: this is the gridded FORECAST product, interpolated
// to a ~2.5km cell containing the property — three properties a few miles
// apart resolve to three different cells with different rain probabilities.
// That is the opposite of NWS's *observation* endpoint, which reports from
// whichever physical station is nearest (Raleigh-Durham airport for most of
// these properties, ~20 miles east). Forecast: use NWS. Right now: don't.
//
// LAZY BY CONSTRUCTION. Nothing here runs until someone opens the section on
// a card. The operator was explicit that a weather call per job on every feed
// render is not worth paying for in latency, however free the API is.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import { cached, invalidate } from "../lib/cache";
import { resolvePropertyPoint } from "./parcels";
import { etFormatDate, type EtDateKey } from "../lib/dates";

export type ForecastHour = {
  /** Full ISO instant with offset, as NWS returns it. */
  startTime: string;
  /** "14:00" in the property's local time, ready to label an axis. */
  label: string;
  tempF: number | null;
  /** Percent chance of precipitation. Null when NWS omits it — which is not
   *  the same as zero, and a chart must not draw it as a zero bar. */
  precipPct: number | null;
  windMph: number | null;
  shortForecast: string | null;
  /** True for the hours the job is expected to be worked, so the chart can
   *  pick them out of the day. */
  inWorkWindow: boolean;
};

export type HourlyForecast =
  | { available: true; hours: ForecastHour[]; dateKey: string; locatedBy: string; fetchedAt: string; stale: boolean }
  | { available: false; reason: "past" | "no-location" | "beyond-horizon" | "unavailable"; message: string };

const NWS_SETTINGS_UA = "NWS_ALERTS_USER_AGENT";

async function nwsFetch(url: string): Promise<any> {
  // Reuses the alerts service's User-Agent setting rather than adding a
  // second one: NWS throttles anonymous callers and asks for contact details,
  // and there is no reason for the two NWS consumers to identify differently.
  const ua = await prisma.setting.findUnique({ where: { key: NWS_SETTINGS_UA } });
  const res = await fetch(url, {
    headers: { "User-Agent": ua?.value || "SeedlingsLawnCare/1.0", Accept: "application/geo+json" },
  });
  if (!res.ok) throw new Error(`NWS returned ${res.status}`);
  return res.json();
}

/** The hourly-forecast URL for a coordinate. Two calls, but the first is
 *  cached for a month — a property's grid cell does not move. */
async function hourlyUrlFor(lat: number, lng: number): Promise<string> {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const { value } = await cached("nwsGrid", key, async () => {
    const body = await nwsFetch(`https://api.weather.gov/points/${lat},${lng}`);
    const url = body?.properties?.forecastHourly;
    if (!url) throw new Error("No gridpoint for this coordinate");
    return url as string;
  });
  return value;
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
  const occ = await prisma.jobOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      id: true, startAt: true, endAt: true, estimatedMinutes: true,
      job: { select: { propertyId: true } },
    },
  });
  if (!occ?.startAt) {
    return { available: false, reason: "unavailable", message: "This visit has no scheduled time." };
  }

  const dateKey = etFormatDate(occ.startAt) as EtDateKey;
  const todayKey = etFormatDate(new Date()) as EtDateKey;
  if (dateKey < todayKey) {
    // Forecast endpoints carry no history. Say so plainly instead of
    // rendering an empty chart that reads as "clear".
    return {
      available: false,
      reason: "past",
      message: "This visit is in the past. A forecast can't be looked up after the fact — the weather recorded when the job was started and completed is shown above.",
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

  let periods: any[] = [];
  let fetchedAt = new Date().toISOString();
  let stale = false;
  try {
    const url = await hourlyUrlFor(point.lat, point.lng);
    // An explicit refresh drops OUR copy so the next read goes upstream. The
    // GRID lookup is deliberately left alone: a property's cell does not move,
    // and re-resolving it would spend a call to learn the same answer.
    //
    // Worth knowing at the callsite: NWS reissues roughly hourly, so a refresh
    // a minute after the last one can honestly return identical numbers. The
    // "as of" stamp is what tells the operator which it was.
    if (opts.refresh) await invalidate("nwsHourly", url);
    const got = await cached("nwsHourly", url, async () => {
      const body = await nwsFetch(url);
      return (body?.properties?.periods ?? []) as any[];
    });
    periods = got.value;
    fetchedAt = got.fetchedAt;
    stale = got.stale;
  } catch {
    return {
      available: false,
      reason: "unavailable",
      message: "The National Weather Service didn't answer just now. This is a free public service and it has quiet outages — try again in a few minutes.",
    };
  }

  // Only the hours belonging to the job's own ET day. NWS timestamps carry an
  // offset, so etFormatDate does the timezone work rather than a string slice.
  const dayHours = periods.filter((p) => {
    try { return etFormatDate(new Date(p.startTime)) === dateKey; } catch { return false; }
  });

  if (dayHours.length === 0) {
    // The horizon is ~156 hours. A job further out than that is not an error
    // and not "no rain" — there is simply no forecast yet.
    return {
      available: false,
      reason: "beyond-horizon",
      message: "The forecast doesn't reach this far ahead yet — it runs about a week out. Check back closer to the day.",
    };
  }

  // The window the crew is expected to be on site, used to highlight the bars
  // that actually matter. endAt when set, otherwise the estimate, otherwise a
  // nominal hour so something is marked rather than nothing.
  const startMs = occ.startAt.getTime();
  const endMs = occ.endAt?.getTime()
    ?? startMs + (occ.estimatedMinutes ?? 60) * 60_000;

  const hours: ForecastHour[] = dayHours.map((p) => {
    const t = new Date(p.startTime).getTime();
    const pop = p?.probabilityOfPrecipitation?.value;
    const windMph = Number(String(p?.windSpeed ?? "").match(/\d+/)?.[0]);
    return {
      startTime: p.startTime,
      label: String(p.startTime).slice(11, 16),
      tempF: Number.isFinite(Number(p.temperature)) ? Number(p.temperature) : null,
      precipPct: Number.isFinite(Number(pop)) ? Number(pop) : null,
      windMph: Number.isFinite(windMph) ? windMph : null,
      shortForecast: p.shortForecast ?? null,
      // An hour counts as in-window if the hour it covers overlaps the job at
      // all — a 09:30 start puts the 09:00 bar in the window.
      inWorkWindow: t + 3_600_000 > startMs && t < endMs,
    };
  });

  return { available: true, hours, dateKey, locatedBy: point.located, fetchedAt, stale };
}
