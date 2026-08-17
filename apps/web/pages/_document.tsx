import { Html, Head, Main, NextScript } from "next/document";

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
  background: #ffffff;
  z-index: 19999;
  pointer-events: none;
}
/* Safety net: while the shield is present, keep the body background
   itself white too — so if the shield somehow gets clipped by the
   browser (e.g. a UA extension, or a pathological viewport bug), the
   base color underneath is still white instead of app content. */
body:has(#pre-splash-shield) {
  background: #ffffff !important;
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

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <style dangerouslySetInnerHTML={{ __html: SHIELD_CSS }} />
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
