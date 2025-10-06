import { useEffect, useRef, useState } from "react";
import { Box } from "@chakra-ui/react";
import { keyframes } from "@emotion/react";

const dropIn = keyframes`
  0%   { transform: translateY(-40vh) scale(0.95); opacity: 0; }
  60%  { transform: translateY(6px)   scale(1.00); opacity: 1; }
  80%  { transform: translateY(-2px)  scale(1.00); opacity: 1; }
  100% { transform: translateY(0)     scale(1.00); opacity: 1; }
`;

const fadeOut = keyframes`
  from { opacity: 1; transform: scale(1.00); }
  to   { opacity: 0; transform: scale(0.985); }
`;

export default function AppSplash({
  show,
  minDurationMs = 1000,
  fadeMs = 350,
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
    <Box
      position="fixed"
      inset="0"
      bg="white"
      zIndex={2000}
      display="grid"
      placeItems="center"
      pointerEvents="none"
      animation={fading ? `${fadeOut} ${fadeMs}ms ease forwards` : undefined}
    >
      <Box
        w="96px"
        h="96px"
        borderRadius="24px"
        boxShadow="0 8px 32px rgba(0,0,0,0.12)"
        display="grid"
        placeItems="center"
        animation={`${dropIn} 520ms cubic-bezier(.17,.84,.44,1) both`}
      >
        <img
          src="/seedlings-icon.png"
          alt="Seedlings"
          width={84}
          height={84}
          style={{ borderRadius: 20 }}
        />
      </Box>
    </Box>
  );
}
