import { useEffect, useRef, useState } from "react";
import { getSeasonIcons } from "@/src/lib/season";

// Full-viewport splash shown while the app is initializing. Static
// centered logo → fade + expand together when the app is ready.
//
// Uses plain DOM + inline styles (NOT Chakra Box) and keyframes from
// globals.css (NOT emotion-generated). Prior iterations of this
// component leaned on Chakra props (`display: grid; place-items:
// center`, animation prop backed by emotion keyframes) and produced
// a visible vertical jump on cold load: those styles were applied
// via CSS classes/rules injected at Chakra runtime, so on the very
// first frame the logo painted at the block-flow position (top of
// the viewport) and only snapped to center once the class landed.
// Inline styles + a static stylesheet dodge that entirely — the
// browser has everything it needs before it composites the first
// frame. `position: fixed` on the outer means it's viewport-anchored,
// so no Portal needed as long as no ancestor establishes a transform
// containing block (none in _app.tsx today).

const FADE_MS = 800;
const MIN_DURATION_MS = 1000;

export default function AppSplash({ show }: { show: boolean }) {
  const [shouldRender, setShouldRender] = useState(show);
  const [fading, setFading] = useState(false);
  const shownAtRef = useRef<number | null>(show ? Date.now() : null);
  const hideTimerRef = useRef<number | null>(null);
  const unmountTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (show) {
      if (!shouldRender) setShouldRender(true);
      setFading(false);
      shownAtRef.current = shownAtRef.current ?? Date.now();
    } else {
      const startedAt = shownAtRef.current ?? Date.now();
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(MIN_DURATION_MS - elapsed, 0);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (unmountTimerRef.current) window.clearTimeout(unmountTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => {
        setFading(true);
        unmountTimerRef.current = window.setTimeout(() => {
          setShouldRender(false);
          setFading(false);
          shownAtRef.current = null;
        }, FADE_MS);
      }, remaining);
    }
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (unmountTimerRef.current) window.clearTimeout(unmountTimerRef.current);
    };
  }, [show, shouldRender]);

  if (!shouldRender) return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 20000,
        background: "white",
        pointerEvents: "none",
        animation: fading ? `seedlings-splash-overlay-fade ${FADE_MS}ms ease forwards` : undefined,
      }}
    >
      <img
        src={typeof window !== "undefined" ? getSeasonIcons().icon : "/seedlings-icon.png"}
        alt="Seedlings"
        width={120}
        height={120}
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          // Centering is BAKED INTO the transform so the animation's
          // `transform: translate(-50%, -50%) scale(...)` doesn't
          // clobber it mid-flight (a naked `scale()` in the keyframes
          // would replace the centering translate and snap the image
          // to the top-left corner during the fade).
          transform: "translate(-50%, -50%)",
          display: "block",
          animation: fading ? `seedlings-splash-logo-expand ${FADE_MS}ms ease forwards` : undefined,
        }}
      />
    </div>
  );
}
