"use client";

// Severe-weather alerts, for any surface that already shows weather.
//
// Rides the same `seedlings:weather` broadcast WeatherBar already emits, so
// this adds no fetch of its own and stays in step with the temperature the
// rest of the app is showing. Returns [] when alerts are disabled,
// unavailable, or simply none are active — which is the normal case.

import { useEffect, useState } from "react";
import type { WeatherAlert } from "@/src/lib/weatherAlerts";

export function useWeatherAlerts(): WeatherAlert[] {
  const [alerts, setAlerts] = useState<WeatherAlert[]>(() => {
    if (typeof window === "undefined") return [];
    return ((window as any).__seedlingsWeather?.alerts as WeatherAlert[]) ?? [];
  });

  useEffect(() => {
    function onWeather(e: any) {
      const next = e?.detail?.alerts;
      if (Array.isArray(next)) setAlerts(next);
    }
    window.addEventListener("seedlings:weather", onWeather);
    return () => window.removeEventListener("seedlings:weather", onWeather);
  }, []);

  return alerts;
}
