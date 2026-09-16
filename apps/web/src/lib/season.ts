/**
 * Season detection — determines which icon set to use.
 *
 * Spring/Summer (Mar–Aug): default green icons
 * Fall/Winter (Sep–Feb): fall icons
 *
 * Admins can override via localStorage.
 */

import { bizMonth } from "@/src/lib/dates";

export type Season = "spring" | "fall";
export type SeasonOverride = "auto" | "spring" | "fall";

const STORAGE_KEY = "seedlings_seasonOverride";
/** Who set the override: a theme that names a season, or an admin picking
 *  one by hand. Both write the same value, but only a theme's own entry may
 *  be cleared when switching to a theme that follows the calendar — wiping
 *  an admin's deliberate choice because they changed theme is a bug. */
const SOURCE_KEY = "seedlings_seasonOverrideSource";
export type SeasonSource = "manual" | "theme";

export function getSeasonSource(): SeasonSource {
  try {
    return localStorage.getItem(SOURCE_KEY) === "theme" ? "theme" : "manual";
  } catch { return "manual"; }
}

/** Get the natural season based on the current ET month. The business
 *  is anchored to Eastern Time; using `new Date().getMonth()` would key
 *  off the user's local timezone and could flip the season a day early
 *  or late for users outside ET. */
export function getNaturalSeason(): Season {
  const month = bizMonth(); // 1-indexed in ET
  // Mar (3) through Aug (8) = spring/summer
  return month >= 3 && month <= 8 ? "spring" : "fall";
}

/** Get the user's season override preference */
export function getSeasonOverride(): SeasonOverride {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "spring" || stored === "fall") return stored;
  } catch {}
  return "auto";
}

/** Set the user's season override preference */
export function setSeasonOverride(value: SeasonOverride, source: SeasonSource = "manual") {
  try {
    if (value === "auto") {
      // Only a theme may clear what a theme set. An admin's hand-picked
      // season survives a theme change.
      if (source === "theme" && getSeasonSource() === "manual") return;
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SOURCE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, value);
      localStorage.setItem(SOURCE_KEY, source);
    }
  } catch {}
}

/** Get the effective season (override or natural) */
export function getEffectiveSeason(): Season {
  const override = getSeasonOverride();
  if (override === "spring" || override === "fall") return override;
  return getNaturalSeason();
}

/** Get icon paths for the effective season */
export function getSeasonIcons(): { icon: string; icon32: string; icon16: string } {
  const season = getEffectiveSeason();
  if (season === "fall") {
    return {
      icon: "/seedlings-icon-fall.png",
      icon32: "/seedlings-icon-fall-32.png",
      icon16: "/seedlings-icon-fall-16.png",
    };
  }
  return {
    icon: "/seedlings-icon.png",
    icon32: "/seedlings-icon-32.png",
    icon16: "/seedlings-icon-16.png",
  };
}
