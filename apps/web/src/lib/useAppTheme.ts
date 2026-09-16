"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Choosing and applying a theme.
//
// Deliberately NOT next-themes: five named themes on two axes, and the
// pre-splash shield in _document paints before React exists, so owning the
// no-flash script outright is safer than layering another library's on top.
//
// The mechanism is one attribute: `data-theme` on <html>. `original` sets NO
// attribute, so the default path resolves exactly as it did before.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import {
  THEME_IDS, THEME_STORAGE_KEY, THEME_SEASON, THEME_COLOR_SCHEME, THEME_PAGE_BG, type ThemeId,
} from "@/src/styles/themeTokens";
import { setSeasonOverride, type SeasonOverride } from "@/src/lib/season";

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as string[]).includes(v);
}

/** A corrupted value must not leave the app unstyled. */
export function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(v)) return v;
  } catch { /* private mode, blocked storage */ }
  return "original";
}

export function applyTheme(id: ThemeId) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (id === "original") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", id);
  // Native controls follow this, not our tokens — see THEME_COLOR_SCHEME.
  root.style.colorScheme = THEME_COLOR_SCHEME[id];
  // The PAGE background is painted by globals.css from this variable, not
  // from a Chakra token, because the pre-splash shield has to paint it
  // before React exists. The boot script sets it once at load; without this
  // line nothing ever updated it again, so switching theme live re-skinned
  // every card and left the page itself on the previous theme's colour —
  // dark page, light cards. It is an inline style on <html>, so it outranks
  // every stylesheet and the mismatch is total until the next reload.
  root.style.setProperty("--seedlings-boot-bg", THEME_PAGE_BG[id]);

  const intent = THEME_SEASON[id];
  setSeasonOverride(intent === "auto" ? "auto" : (intent as SeasonOverride), "theme");
  try {
    window.dispatchEvent(new CustomEvent("seedlings:theme-changed", { detail: { theme: id } }));
    // AND the season event — BrandLabel listens for `seasonChanged` and knows
    // nothing about themes, so firing only the theme event left the logo put.
    window.dispatchEvent(new CustomEvent("seedlings:seasonChanged"));
  } catch {}
}

export function useAppTheme() {
  const [theme, setThemeState] = useState<ThemeId>("original");

  useEffect(() => {
    const stored = readStoredTheme();
    setThemeState(stored);
    // Reconcile on every load, not only on click: the boot script sets
    // `data-theme` and nothing else, so the season override would otherwise
    // stay at whatever it was.
    applyTheme(stored);
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<{ theme: ThemeId }>).detail?.theme;
      if (isThemeId(next)) setThemeState(next);
    };
    window.addEventListener("seedlings:theme-changed", onChange);
    return () => window.removeEventListener("seedlings:theme-changed", onChange);
  }, []);

  const setTheme = useCallback((id: ThemeId) => {
    try { localStorage.setItem(THEME_STORAGE_KEY, id); } catch {}
    applyTheme(id);
    setThemeState(id);
  }, []);

  return { theme, setTheme };
}
