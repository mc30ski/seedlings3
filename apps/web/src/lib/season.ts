/**
 * Season detection — determines which icon set to use.
 *
 * Spring/Summer (Mar–Aug): default green icons
 * Fall/Winter (Sep–Feb): fall icons
 *
 * Admins can override via localStorage.
 */

export type Season = "spring" | "fall";
export type SeasonOverride = "auto" | "spring" | "fall";

const STORAGE_KEY = "seedlings_seasonOverride";

/** Get the natural season based on current month */
export function getNaturalSeason(): Season {
  const month = new Date().getMonth(); // 0-indexed
  // Mar (2) through Aug (7) = spring/summer
  return month >= 2 && month <= 7 ? "spring" : "fall";
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
export function setSeasonOverride(value: SeasonOverride) {
  try {
    if (value === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
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
