import { Html, Head, Main, NextScript } from "next/document";
import { THEME_PAGE_BG, THEME_COLOR_SCHEME, THEME_STORAGE_KEY, CONTRAST_RAMP_CSS, THEME_SEASON, THEME_BOOT_FG, THEME_BOOT_FG_MUTED, PULSE_CSS } from "@/src/styles/themeTokens";

// Custom document — sole purpose is to paint a pre-hydration white
// shield the very moment the HTML lands in the browser, and then hand
// off to <AppSplash /> once React has hydrated and mounted the overlay.
//
// Without this shield, the browser paints the SSR'd app content for a
// frame or two BEFORE AppSplash's `useEffect` fires to portal its own
// overlay onto the body. On mobile you can catch this as a brief flash
// of the last-visible feed content at the bottom of the screen (the
// "dad and brothers... Show more" flash the operator captured on
// slow-motion video, 2026-08-17).
//
// The fix is entirely OUTSIDE AppSplash.tsx apart from adding one
// data attribute to its overlay div (so the shield knows when to
// hand off). AppSplash's fragile layout code (dvh/dvw overlay, portal
// to body, phase state machine) is left untouched.
//
// Mechanics:
//   1. `#pre-splash-shield` renders inline in the HTML shell with
//      z-index 19999 (one below AppSplash's 20000). The moment the
//      browser paints anything, this white div covers the viewport.
//   2. AppSplash's overlay (z-index 20000, `data-app-splash-overlay=1`)
//      appears once React has hydrated — drawn on top of the shield,
//      so the handoff is invisible.
//   3. Inline <script> installs a MutationObserver watching for the
//      overlay. As soon as it appears, the shield removes itself.
//   4. Fallback: 3-second timeout removes the shield even if AppSplash
//      never mounts (e.g. show=false from the start on a background
//      route). Otherwise the shield would cover the app forever.

const SHIELD_CSS = `
#pre-splash-shield {
  position: fixed;
  /* Anchored above the top-left AND below the bottom-right of the
     viewport so any URL-bar / safe-area / dvh-vs-lvh mismatch during
     the initial paint (particularly on mobile PWAs, where the visual
     viewport can grow after first paint as the URL bar hides) still
     has nothing visible behind the shield. 200vh is enough to cover
     even the "URL bar just visible, then hides" transition without
     ever exposing app content underneath. */
  top: -100vh;
  left: -100vw;
  width: 300vw;
  height: 300vh;
  background: var(--seedlings-boot-bg, #ffffff);
  z-index: 19999;
  pointer-events: none;
}
/* Safety net: while the shield is present, keep the body background
   itself white too — so if the shield somehow gets clipped by the
   browser (e.g. a UA extension, or a pathological viewport bug), the
   base color underneath is still white instead of app content. */
body:has(#pre-splash-shield) {
  background: var(--seedlings-boot-bg, #ffffff) !important;
}
/* AppSplash's own overlay uses width:100dvw height:100dvh, which on
   some devices (particularly Android PWAs) doesn't cover the full
   visible viewport during URL-bar transitions — content leaks through
   at the bottom. Adding a huge white box-shadow expands the WHITE
   paint area far past the overlay's actual bounds without touching
   its width/height (so flex-centering of the logo stays put). The
   box-shadow doesn't affect layout, so AppSplash's fragile layout
   code isn't disturbed. */
[data-app-splash-overlay="1"] {
  box-shadow: 0 0 0 100vmax var(--seedlings-boot-bg, #ffffff) !important;
}
/* ── App content coordination with the splash ─────────────────────────
   Kills the flash entirely by hiding #__next while the splash is up,
   then cross-fading it IN over the same window that the splash fades
   OUT. Coordinated via the splash's data-app-splash-phase attribute
   so the cross-fade timing exactly matches AppSplash's FADE_MS (800ms).
   ────────────────────────────────────────────────────────────────── */
/* Default: app is visible, fade transitions are set up so any
   subsequent opacity change animates over 800ms (matches FADE_MS in
   AppSplash.tsx — keep in sync if you change one, change the other). */
#__next {
  opacity: 1;
  transition: opacity 800ms ease;
}
/* While the pre-hydration shield is up, the app is hidden. The shield
   itself covers everything visually; the opacity:0 here is defense in
   depth so no paint of app content ever escapes below the shield's
   z-index. */
body:has(#pre-splash-shield) #__next {
  opacity: 0 !important;
}
/* While the splash overlay is up and NOT yet fading, the app is
   hidden. The moment phase flips to "fading", this rule stops
   matching and the default (opacity:1 with 800ms transition) kicks
   in — so the app fades in over the exact same window the splash
   fades out. */
body:has([data-app-splash-overlay="1"]:not([data-app-splash-phase="fading"])) #__next {
  opacity: 0 !important;
}
`;

const SHIELD_REMOVER_JS = `
(function() {
  var shield = document.getElementById('pre-splash-shield');
  if (!shield) return;
  var removed = false;
  function drop() {
    if (removed) return;
    removed = true;
    try { shield.parentNode && shield.parentNode.removeChild(shield); } catch (_) {}
  }
  // ---- Routes with no splash drop the shield immediately ----
  //
  // The shield covers a HANDOFF: SSR'd app content paints for a frame
  // or two before AppSplash's useEffect portals its overlay on top.
  // That race exists ONLY where AppSplash actually mounts, which is
  // exactly one place: pages/index.tsx (route "/"). The
  // app-splash-single-mount build gate fails the build if a second
  // mount is added, precisely because that would invalidate this check.
  //
  // Everywhere else no overlay is coming, so the observer below could
  // never fire and the shield sat for the FULL 3s fallback - three
  // seconds of white on every public, client-facing page: the promotion
  // landing page, and the /pay invoice a client opens from an SMS link.
  // Nothing was being protected; the content underneath was already the
  // final state.
  //
  // This cannot reintroduce the flash: with no splash to hand off to,
  // painting the content immediately IS the correct end state.
  if (window.location.pathname !== '/') { drop(); return; }

  // Preferred trigger: AppSplash's overlay lands in DOM with the
  // data attribute. Fires the moment React commits the overlay.
  // We wait an extra HANDOFF_HOLD_MS after that to let the browser
  // finish any URL-bar / safe-area transition still in progress — if
  // dvh grows during that window, both layers are still covering the
  // viewport so nothing ever peeks through. Empirically 500ms is more
  // than enough for the initial-load URL-bar auto-hide on mobile
  // Safari and Chrome PWAs.
  var HANDOFF_HOLD_MS = 500;
  var obs = new MutationObserver(function(_, o) {
    if (document.querySelector('[data-app-splash-overlay="1"]')) {
      o.disconnect();
      setTimeout(drop, HANDOFF_HOLD_MS);
    }
  });
  try { obs.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  // Fallback for the case where AppSplash decides not to mount at all
  // (e.g. show=false initially on a background route). Shield can't
  // linger forever or it hides the whole app.
  setTimeout(function() { try { obs.disconnect(); } catch (_) {}; drop(); }, 3000);
})();
`;

// Runs BEFORE anything paints: stamps `data-theme` so Chakra's conditions
// resolve on the first paint, repaints the pre-splash shield in the theme's
// own colour (hardcoded white flashed white on the way into dark — the exact
// failure the shield exists to prevent), and sets `color-scheme` so the
// browser paints native controls correctly.
const THEME_BOOT_JS = `
(function () {
  try {
    var BG = ${JSON.stringify(THEME_PAGE_BG)};
    var FG = ${JSON.stringify(THEME_BOOT_FG)};
    var FGM = ${JSON.stringify(THEME_BOOT_FG_MUTED)};
    var CS = ${JSON.stringify(THEME_COLOR_SCHEME)};
    var t = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (!BG[t]) t = "original";
    if (t !== "original") document.documentElement.setAttribute("data-theme", t);
    document.documentElement.style.setProperty("--seedlings-boot-bg", BG[t]);
    // The splash reads these; it renders before any Chakra token exists.
    document.documentElement.style.setProperty("--seedlings-boot-fg", FG[t]);
    document.documentElement.style.setProperty("--seedlings-boot-fg-muted", FGM[t]);
    document.documentElement.style.colorScheme = CS[t] || "light";

    // SEASON. A theme that names a season pins the logo to it; Original and
    // Dark leave it on the natural month.
    //
    // This has to happen HERE, not in useAppTheme, because that hook is
    // mounted in exactly one place — the Profile tab's theme picker. Anywhere
    // else in the app the override was never written, so Spring and Fall got
    // their colours from the boot script above and their LOGO from the
    // calendar: the fall mark, under every theme, all autumn.
    //
    // Doing it before React also means the first painted frame is already
    // right, instead of the logo swapping after hydration.
    var SEASON = ${JSON.stringify(THEME_SEASON)};
    var want = SEASON[t] || "auto";
    if (want === "auto") {
      // Clear only what a THEME set. An admin who picked a season by hand on
      // the Profile tab keeps it when they switch to Original or Dark.
      if (localStorage.getItem("seedlings_seasonOverrideSource") === "theme") {
        localStorage.removeItem("seedlings_seasonOverride");
        localStorage.removeItem("seedlings_seasonOverrideSource");
      }
    } else {
      localStorage.setItem("seedlings_seasonOverride", want);
      localStorage.setItem("seedlings_seasonOverrideSource", "theme");
    }
  } catch (e) {
    /* Blocked storage — fall through to Original, which needs no attribute. */
  }
})();
`;

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* FIRST — sets --seedlings-boot-bg, which the shield CSS below reads. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_JS }} />
        <style dangerouslySetInnerHTML={{ __html: SHIELD_CSS }} />
        {/* Unlayered, so it outranks Chakra's `tokens` layer. Contrast theme only. */}
        <style dangerouslySetInnerHTML={{ __html: CONTRAST_RAMP_CSS }} />
        {/* Pulse ring tints, derived per theme — see PULSE_CSS. */}
        <style dangerouslySetInnerHTML={{ __html: PULSE_CSS }} />
      </Head>
      <body>
        <div id="pre-splash-shield" />
        <script dangerouslySetInnerHTML={{ __html: SHIELD_REMOVER_JS }} />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
