"use client";

import { useEffect, useState } from "react";

export type TomorrowWeather = {
  icon: string;
  rainChance: number;
  description: string;
  high: number;
  low: number;
  windSpeed: number;
  // Coarse category derived from icon + rainChance.
  category: "rain" | "thunderstorm" | "snow" | "wind" | null;
  inclement: boolean;
};

declare global {
  interface Window {
    __seedlingsWeather?: {
      forecast?: Array<{
        date: string;
        label?: string;
        high: number;
        low: number;
        description: string;
        icon: string;
        rainChance: number;
        windSpeed: number;
        humidity: number;
      }>;
    };
  }
}

function categorize(icon: string, rainChance: number, windSpeed: number): TomorrowWeather["category"] {
  if (icon.startsWith("11")) return "thunderstorm";
  if (icon.startsWith("13")) return "snow";
  if (icon.startsWith("09") || icon.startsWith("10") || rainChance >= 50) return "rain";
  if (windSpeed >= 20 || icon.startsWith("50")) return "wind";
  return null;
}

function pickTomorrow(detail: any): TomorrowWeather | null {
  const forecast = detail?.forecast;
  if (!Array.isArray(forecast) || forecast.length === 0) return null;
  // Forecast index 0 is today; index 1 is tomorrow when present.
  const t = forecast.length > 1 ? forecast[1] : null;
  if (!t) return null;
  const cat = categorize(t.icon ?? "", t.rainChance ?? 0, t.windSpeed ?? 0);
  return {
    icon: t.icon ?? "",
    rainChance: t.rainChance ?? 0,
    description: t.description ?? "",
    high: t.high,
    low: t.low,
    windSpeed: t.windSpeed ?? 0,
    category: cat,
    inclement: cat === "rain" || cat === "thunderstorm" || cat === "snow",
  };
}

export function useTomorrowWeather(): TomorrowWeather | null {
  const [tomorrow, setTomorrow] = useState<TomorrowWeather | null>(() => {
    if (typeof window === "undefined") return null;
    return pickTomorrow(window.__seedlingsWeather);
  });

  useEffect(() => {
    function onWeather(e: any) {
      setTomorrow(pickTomorrow(e?.detail));
    }
    window.addEventListener("seedlings:weather", onWeather);
    // Also re-read the cached value at mount (in case it was set between
    // initial render and effect attach).
    if (window.__seedlingsWeather) setTomorrow(pickTomorrow(window.__seedlingsWeather));
    return () => window.removeEventListener("seedlings:weather", onWeather);
  }, []);

  return tomorrow;
}
