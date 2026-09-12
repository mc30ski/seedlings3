// ─────────────────────────────────────────────────────────────────────────────
// What the weather WAS when a job was worked.
//
// The forecast endpoints have no history — NWS hourly starts at the current
// hour and runs forward. So the only way to ever answer "what was it like when
// we did this job" is to write it down as it happens. This captures a reading
// at START and again at COMPLETE, and those two rows are the whole record.
//
// TWO RULES, BOTH LOAD-BEARING:
//
//   1. IT CAN NEVER BLOCK A JOB. A crew standing in a field pressing Start
//      does not care about the weather service. Every path returns rather
//      than throws, and the caller fires this without awaiting it.
//
//   2. IT USES THE SAME SOURCE AS THE WEATHER BAR. Conditions on the job card
//      and conditions in the title bar describing the same place at the same
//      moment must not disagree because they came from different providers.
//      That means OpenWeather, deliberately: NWS current conditions come from
//      a physical station, and the nearest one to most of these properties is
//      Raleigh-Durham airport, ~20 miles east. NWS is the better source for a
//      gridded FORECAST at a property; it is the worse source for what is
//      happening at that property right now.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import { cached } from "../lib/cache";
import { resolvePropertyPoint } from "./parcels";

/** The frozen reading stored on the occurrence. Deliberately small and flat:
 *  it is rendered verbatim and never queried on. `source` and `capturedAt`
 *  are part of the record — a reading with no provenance is not evidence. */
export type WeatherSnapshot = {
  tempF: number | null;
  feelsLikeF: number | null;
  /** "Light rain", "Clear" — the provider's own words. */
  description: string | null;
  /** Provider icon code, so the card can show the same glyph as the bar. */
  icon: string | null;
  humidityPct: number | null;
  windMph: number | null;
  /** Millimetres in the last hour, when the provider reports it. Usually
   *  absent, which is NOT the same as zero — hence null rather than 0. */
  rainMmLastHour: number | null;
  capturedAt: string;
  source: "openweather";
  /** Where the reading was taken for, and how we knew. "gps" means the
   *  worker's own phone at the moment they pressed the button, which is the
   *  most honest answer available; "property" means the property's stored or
   *  geocoded point. */
  locatedBy: "gps" | "property";
  lat: number;
  lng: number;
};

/**
 * Current conditions from OpenWeather, shared with the /weather proxy.
 *
 * Extracted so there is ONE implementation: the proxy renders this on the
 * weather bar and the capture below freezes it onto a job, and the two must
 * be the same numbers. Uses the same `openWeather` cache namespace and the
 * same 2-decimal coordinate rounding (~1km) the proxy already relies on.
 */
export async function fetchOpenWeather(
  lat: number,
  lng: number,
): Promise<{ current: any; forecast: any } | null> {
  const keySetting = await prisma.setting.findUnique({ where: { key: "WEATHER_API_KEY" } });
  const apiKey = keySetting?.value || process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return null;
  const wxKey = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
  const { value } = await cached("openWeather", wxKey, async () => {
    const [currentRes, forecastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=imperial&appid=${apiKey}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&units=imperial&appid=${apiKey}`),
    ]);
    if (!currentRes.ok) throw new Error(`Weather API returned ${currentRes.status}`);
    if (!forecastRes.ok) throw new Error(`Forecast API returned ${forecastRes.status}`);
    return { current: await currentRes.json(), forecast: await forecastRes.json() };
  });
  return value;
}

/** Normalise OpenWeather's `current` into the stored shape. Every field is
 *  optional upstream, so every field is nullable here — a partial reading is
 *  worth keeping, a fabricated one is not. */
function toSnapshot(
  current: any,
  where: { lat: number; lng: number; locatedBy: "gps" | "property" },
): WeatherSnapshot {
  const n = (v: any): number | null => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    tempF: n(current?.main?.temp),
    feelsLikeF: n(current?.main?.feels_like),
    description: current?.weather?.[0]?.description ?? null,
    icon: current?.weather?.[0]?.icon ?? null,
    humidityPct: n(current?.main?.humidity),
    windMph: n(current?.wind?.speed),
    rainMmLastHour: n(current?.rain?.["1h"]),
    capturedAt: new Date().toISOString(),
    source: "openweather",
    ...where,
  };
}

/**
 * Freeze the weather onto an occurrence at start or completion.
 *
 * NEVER THROWS, NEVER AWAITED BY THE CALLER. Called after the status change
 * has already committed, so a failure here costs a weather reading and
 * nothing else.
 *
 * Prefers the WORKER'S OWN GPS over the property's coordinates. If someone
 * pressed Start while standing on the lawn, that phone's position is a better
 * answer than an address geocode — and it is data already collected. Falls
 * back to the property point, which resolves (and permanently fills in) a
 * coordinate via the same path the parcel lookup uses.
 */
export async function captureOccurrenceWeather(
  occurrenceId: string,
  phase: "start" | "complete",
): Promise<void> {
  try {
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        id: true, jobId: true,
        startLat: true, startLng: true, completeLat: true, completeLng: true,
        job: { select: { propertyId: true } },
      },
    });
    if (!occ) return;

    const gpsLat = phase === "start" ? occ.startLat : occ.completeLat;
    const gpsLng = phase === "start" ? occ.startLng : occ.completeLng;

    let where: { lat: number; lng: number; locatedBy: "gps" | "property" } | null = null;
    if (gpsLat != null && gpsLng != null) {
      where = { lat: gpsLat, lng: gpsLng, locatedBy: "gps" };
    } else if (occ.job?.propertyId) {
      const point = await resolvePropertyPoint(occ.job.propertyId);
      if (point) where = { lat: point.lat, lng: point.lng, locatedBy: "property" };
    }
    if (!where) return; // Nowhere to ask about. Not an error.

    const wx = await fetchOpenWeather(where.lat, where.lng);
    if (!wx?.current) return;

    // audit-allow: records an observation about the world at the moment of a
    // status change that is itself already audited. Changes no business state
    // and nothing user-entered.
    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: phase === "start"
        ? { startWeather: toSnapshot(wx.current, where) as any }
        : { completeWeather: toSnapshot(wx.current, where) as any },
    });
  } catch {
    // Swallowed on purpose — see the header. A missing reading is a gap in a
    // record; a thrown error here would be a crew unable to start a job.
  }
}
