"use client";

// Returns a Map<YYYY-MM-DD, ForecastEntry> derived from the shared
// `window.__seedlingsWeather` cache that WeatherBar populates. Same
// subscription pattern as useTomorrowWeather — reads the cache on
// mount and updates on the seedlings:weather custom event so the map
// stays fresh across the whole session without every consumer
// needing to know about the cache mechanics.

import { useEffect, useState } from "react";

export type ForecastEntry = {
  date: string;
  label?: string;
  high: number;
  low: number;
  description: string;
  icon: string;
  rainChance: number;
  windSpeed: number;
  humidity: number;
};

function pickForecastMap(detail: any): Map<string, ForecastEntry> {
  const forecast = detail?.forecast;
  const map = new Map<string, ForecastEntry>();
  if (!Array.isArray(forecast)) return map;
  for (const f of forecast) {
    if (f?.date) map.set(f.date, f as ForecastEntry);
  }
  return map;
}

export function useForecastByDate(): Map<string, ForecastEntry> {
  const [map, setMap] = useState<Map<string, ForecastEntry>>(() => {
    if (typeof window === "undefined") return new Map();
    return pickForecastMap(window.__seedlingsWeather);
  });

  useEffect(() => {
    function onWeather(e: any) {
      setMap(pickForecastMap(e?.detail));
    }
    window.addEventListener("seedlings:weather", onWeather);
    if (window.__seedlingsWeather) {
      setMap(pickForecastMap(window.__seedlingsWeather));
    }
    return () => window.removeEventListener("seedlings:weather", onWeather);
  }, []);

  return map;
}
