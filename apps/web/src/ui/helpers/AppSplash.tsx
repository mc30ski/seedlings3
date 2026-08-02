import { useEffect, useRef, useState } from "react";
import { Box, Portal } from "@chakra-ui/react";
import { keyframes } from "@emotion/react";
import { getSeasonIcons } from "@/src/lib/season";

// Split into two animations — see the JSX comment for why. Keeping
// the outer box off `transform` avoids a compositor layer promotion
// at animation-start that snapped the layout down by a couple pixels.
const overlayFade = keyframes`
  from { opacity: 1; }
  to   { opacity: 0; }
`;
const logoExpand = keyframes`
  from { opacity: 1; transform: scale(1);   }
  to   { opacity: 0; transform: scale(1.5); }
`;

export default function AppSplash({
  show,
  minDurationMs = 1000,
  fadeMs = 800,
}: {
  show: boolean;
  minDurationMs?: number;
  fadeMs?: number;
}) {
  const [shouldRender, setShouldRender] = useState(show); // whether component is mounted/visible
  const [fading, setFading] = useState(false);
  const shownAtRef = useRef<number | null>(show ? Date.now() : null);
  const hideTimerRef = useRef<number | null>(null);
  const unmountTimerRef = useRef<number | null>(null);

  // When we start showing, record the start time and ensure it's mounted.
  useEffect(() => {
    if (show) {
      if (!shouldRender) setShouldRender(true);
      setFading(false);
      shownAtRef.current = shownAtRef.current ?? Date.now();
    } else {
      // Loading finished: honor minimum duration before fading out.
      const startedAt = shownAtRef.current ?? Date.now();
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(minDurationMs - elapsed, 0);

      // Clear any previous timers
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (unmountTimerRef.current) window.clearTimeout(unmountTimerRef.current);

      hideTimerRef.current = window.setTimeout(() => {
        setFading(true);
        unmountTimerRef.current = window.setTimeout(() => {
          setShouldRender(false);
          setFading(false);
          shownAtRef.current = null;
        }, fadeMs);
      }, remaining);
    }

    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      if (unmountTimerRef.current) window.clearTimeout(unmountTimerRef.current);
    };
  }, [show, minDurationMs, fadeMs, shouldRender]);

  if (!shouldRender) return null;

  return (
    <Portal>
      {/* Two separate animations so the fade + expand read as one
          effect without the layout jump you get from putting a
          transform on a full-viewport fixed element. The outer only
          animates opacity (compositor-only, zero layout impact) and
          `will-change` locks it into its own layer from the first
          frame so nothing promotes mid-lifecycle. The inner <img>
          owns the scale — transform-origin defaults to its own
          center so it grows in place. */}
      <Box
        position="fixed"
        inset="0"
        bg="white"
        zIndex={20000}
        display="grid"
        placeItems="center"
        pointerEvents="none"
        style={{ willChange: "opacity" }}
        animation={fading ? `${overlayFade} ${fadeMs}ms ease forwards` : undefined}
      >
        <img
          src={typeof window !== "undefined" ? getSeasonIcons().icon : "/seedlings-icon.png"}
          alt="Seedlings"
          width={120}
          height={120}
          style={{
            willChange: "transform, opacity",
            animation: fading ? `${logoExpand} ${fadeMs}ms ease forwards` : undefined,
          }}
        />
      </Box>
    </Portal>
  );
}
