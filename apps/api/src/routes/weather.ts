import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { services } from "../services";
import { fetchWeatherAlerts } from "../services/weatherAlerts";
import { cached } from "../lib/cache";
import { businessLatLng } from "../lib/businessLocation";
import { prisma } from "../db/prisma";
import { hourlyForecastForOccurrence } from "../services/hourlyForecast";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etMidnight, etToday, etTomorrow, type EtDateKey } from "../lib/dates";
import { InstructionScope, JobOccurrenceStatus, Prisma } from "@prisma/client";
import { ServiceError } from "../lib/errors";
import { normalizePhone } from "../lib/phone";
import { persistCompletionSplits } from "../services/payments";
import { evaluateHoursApproval, loadHoursApprovalVarianceThreshold, loadPriorPersonMinutes } from "../services/jobs";
import { computeMyOccurrenceNet } from "../services/workerEarnings";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, paymentSplitCutoffWhere, resolveCutoff } from "../lib/businessStartCutoff";
import { redactObserverFieldsForCaller, redactPeekFieldsForCaller, redactUnclearedFieldsForCaller } from "../lib/observerRedaction";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { makeGuards } from "../lib/routeGuards";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { capabilitiesForUsers, userCan } from "../lib/userCapabilities";
import { classify, isFeeable, isW2, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, occInEditableState } from "./_shared";

export default async function weatherRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_scheduleView = requires("schedule.view");

  app.get("/weather/location", req_scheduleView, async (req: any) => {
    // area-scope-allow: forecast for a lat/lng. No rows, no territory
    //
    // THE AREA LENS WINS OVER THE BUSINESS ADDRESS. If the caller has
    // narrowed the app to a district, every number on their screen is that
    // district's — a forecast for head office would be the one panel still
    // answering about somewhere else.
    //
    // Reading `lensPath` here is the ONE place outside a query filter that
    // does so, and it is still not an authorization decision: it picks which
    // coordinates to forecast, and the worst a bad value does is anchor the
    // weather somewhere unhelpful. G47 lists this file for that reason.
    //
    // NO ANCESTOR WALK. A district with no point of its own falls through to
    // the business address rather than borrowing its region's — an inherited
    // coordinate is indistinguishable from a deliberate one when the forecast
    // turns out to be for the wrong town.
    const lensPath: string | null = req.principal?.lensPath ?? null;
    if (lensPath) {
      const area = await prisma.area.findFirst({
        where: { path: lensPath },
        select: { name: true, lat: true, lng: true },
      });
      if (area?.lat != null && area?.lng != null) {
        return { lat: area.lat, lng: area.lng, source: "area" as const, label: area.name };
      }
    }

    const biz = await businessLatLng();
    if (biz) return { ...biz, source: "business" as const };
    try {
      // Use ip-api.com (free, no key needed, 45 req/min)
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
      const res = await fetch(`http://ip-api.com/json/${ip === "127.0.0.1" || ip === "::1" ? "" : ip}?fields=lat,lon`);
      const data = await res.json();
      if (data.lat && data.lon) return { lat: data.lat, lng: data.lon, source: "ip" as const };
      throw new Error("No location data");
    } catch {
      throw app.httpErrors.serviceUnavailable("Could not determine location");
    }
  });
  // Weather proxy — OpenWeatherMap's free /data/2.5/forecast endpoint.
  //
  // HORIZON IS A HARD LIMIT. That endpoint returns 40 entries at 3-hour
  // steps = 5 days, so 5 days is the ceiling no matter what we ask for. A
  // 7-day forecast needs One Call API 3.0, which is a separate subscription
  // (1,000 calls/day free but billing details required). Until someone
  // decides to sign up for that, this returns everything the free window
  // actually covers rather than an arbitrary 3 days.
  app.get("/weather", req_scheduleView, async (req: any) => {
    // area-scope-allow: a lat/lng passthrough to an external forecast API.
    // It reads no rows of ours, so there is nothing to narrow.
    const { lat, lng } = (req.query || {}) as { lat?: string; lng?: string };
    if (!lat || !lng) throw app.httpErrors.badRequest("lat and lng are required");

    // Read API key from Setting table, fall back to env var
    const apiKeySetting = await prisma.setting.findUnique({ where: { key: "WEATHER_API_KEY" } });
    const apiKey = apiKeySetting?.value || process.env.OPENWEATHER_API_KEY;
    if (!apiKey) throw app.httpErrors.serviceUnavailable("Weather API key not configured");

    try {
      // Cached server-side, keyed by rounded coordinates. This had NO server
      // cache at all: every worker's browser poll was a fresh pair of
      // OpenWeather calls, and a crew working the same neighbourhood was
      // fetching the same weather over and over. Two decimal places is about
      // a kilometre, which is well inside the resolution of a forecast.
      const wxKey = `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
      const { value: wx } = await cached("openWeather", wxKey, async () => {
        const [currentRes, forecastRes] = await Promise.all([
          fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=imperial&appid=${apiKey}`),
          fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&units=imperial&appid=${apiKey}`),
        ]);
        if (!currentRes.ok) throw new Error(`Weather API returned ${currentRes.status}`);
        if (!forecastRes.ok) throw new Error(`Forecast API returned ${forecastRes.status}`);
        return { current: await currentRes.json(), forecast: await forecastRes.json() };
      });
      const current = wx.current;
      const forecast = wx.forecast;

      // Severe-weather alerts (NWS). Fetched AFTER the OpenWeather calls and
      // deliberately NOT inside the Promise.all above — that block throws on
      // a non-ok response, so folding NWS into it would let an NWS outage
      // take temperature down with it. fetchWeatherAlerts never throws and
      // never rejects; the worst case is an empty array and a weather bar
      // that behaves exactly as it did before alerts existed.
      const alerts = await fetchWeatherAlerts(Number(lat), Number(lng));

      // Group forecast by day and pick midday (12:00) or closest entry
      const days: Record<string, any[]> = {};
      for (const entry of (forecast.list ?? [])) {
        const date = entry.dt_txt?.split(" ")[0];
        if (!date) continue;
        if (!days[date]) days[date] = [];
        days[date].push(entry);
      }

      // ET calendar day for the "today" weather key.
      const todayKey = etToday();

      // Always include today using current weather, then next 2 forecast days
      const todayForecastEntries = days[todayKey] ?? [];
      const todayRainChances = todayForecastEntries.map((e) => Math.round((e.pop ?? 0) * 100));
      // Today's high/low comes from the FORECAST entries, like every other
      // day in the bar — not from current.main.temp_max.
      //
      // On the current-weather endpoint temp_max/temp_min are the spread of
      // what nearby stations are reporting RIGHT NOW, not a daily forecast.
      // Using them showed "Today 83°/78°" on a day forecast to hit 97°, with
      // a Heat Advisory in force — while tomorrow correctly read 95°, because
      // tomorrow was built from the forecast list. Only Today was wrong.
      //
      // The forecast list starts from the current 3-hour block, so late in
      // the day it no longer covers the morning. Fold in the observed
      // readings so the high is never lower than something already measured.
      const todayHighs = todayForecastEntries.map((e: any) => e.main?.temp_max ?? e.main?.temp ?? 0);
      const todayLows = todayForecastEntries.map((e: any) => e.main?.temp_min ?? e.main?.temp ?? 0);
      const observedNow = current.main?.temp ?? 0;
      const todayHigh = Math.max(...todayHighs, observedNow, current.main?.temp_max ?? observedNow);
      const todayLow = Math.min(...todayLows, observedNow, current.main?.temp_min ?? observedNow);

      const todayEntry = {
        date: todayKey,
        label: "Today",
        high: Math.round(todayHigh),
        low: Math.round(todayLow),
        description: current.weather?.[0]?.description ?? "",
        icon: current.weather?.[0]?.icon ?? "",
        rainChance: todayRainChances.length > 0 ? Math.max(...todayRainChances) : 0,
        windSpeed: Math.round(current.wind?.speed ?? 0),
        humidity: current.main?.humidity ?? 0,
      };

      // Get next days (skip today since we built it from current weather)
      const futureDays = Object.entries(days)
        .filter(([date]) => date > todayKey)
        // The last day in the window is usually a stub of one or two 3-hour
        // steps. Its min/max across those would be presented as a whole
        // day's high and low, which is worse than showing nothing — a
        // single 3am reading becomes "tomorrow's high". Require enough
        // coverage for the numbers to mean something.
        .filter(([, entries]) => entries.length >= 3)
        .slice(0, 6)
        .map(([date, entries]) => {
          const midday = entries.find((e) => e.dt_txt?.includes("12:00")) ?? entries[Math.floor(entries.length / 2)];
          const temps = entries.map((e) => e.main?.temp ?? 0);
          const rainChances = entries.map((e) => Math.round((e.pop ?? 0) * 100));
          return {
            date,
            high: Math.round(Math.max(...temps)),
            low: Math.round(Math.min(...temps)),
            description: midday.weather?.[0]?.description ?? "",
            icon: midday.weather?.[0]?.icon ?? "",
            rainChance: Math.max(...rainChances),
            windSpeed: Math.round(midday.wind?.speed ?? 0),
            humidity: midday.main?.humidity ?? 0,
          };
        });

      const dailyForecasts = [todayEntry, ...futureDays];

      return {
        // Additive: every field below this line is exactly what it was
        // before alerts existed. `alerts` is [] whenever NWS is disabled,
        // unreachable, or returns something unexpected.
        alerts,
        current: {
          temp: Math.round(current.main?.temp ?? 0),
          feelsLike: Math.round(current.main?.feels_like ?? 0),
          description: current.weather?.[0]?.description ?? "",
          icon: current.weather?.[0]?.icon ?? "",
          humidity: current.main?.humidity ?? 0,
          windSpeed: Math.round(current.wind?.speed ?? 0),
        },
        forecast: dailyForecasts,
        lat: Number(lat),
        lng: Number(lng),
      };
    } catch (err: any) {
      throw app.httpErrors.serviceUnavailable(err.message || "Weather unavailable");
    }
  });
}
