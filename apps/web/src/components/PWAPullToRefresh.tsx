// apps/web/src/components/PWAPullToRefresh.tsx
import { useEffect, useRef, useState } from "react";
import { Box, HStack, Spinner, Text } from "@chakra-ui/react";

/**
 * Lightweight pull-to-refresh for iOS PWA standalone (and other no-chrome modes).
 * Works with window scrolling. If your app scrolls inside a custom container,
 * pass that element via `getScrollTop`.
 */
type Props = {
  /** Pixels the user must pull before refresh triggers */
  threshold?: number;
  /** Called when a refresh is requested; default = hard reload */
  onRefresh?: () => Promise<void> | void;
  /** Only enable in standalone PWA display mode by default */
  enabled?: boolean;
  /** Function to read current scrollTop (default reads window/page) */
  getScrollTop?: () => number;
};

function isStandaloneDisplayMode() {
  // iOS Safari exposes navigator.standalone; modern browsers support matchMedia
  if (typeof window === "undefined") return false;
  return (
    (window.navigator as any).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true
  );
}

export default function PWAPullToRefresh({
  threshold = 70,
  onRefresh,
  enabled,
  getScrollTop,
}: Props) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const pulling = pull > 0 && !refreshing;

  const active =
    enabled ??
    (typeof window !== "undefined" ? isStandaloneDisplayMode() : false);

  const readScrollTop =
    getScrollTop ??
    (() =>
      // Read scroll position in a cross-browser way
      window.pageYOffset ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0);

  useEffect(() => {
    if (!active) return;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshing) return;
      // Only start if we're at very top
      if (readScrollTop() <= 0) {
        startY.current = e.touches[0].clientY;
        setPull(0);
      } else {
        startY.current = null;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (startY.current == null || refreshing) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy > 0) {
        // Pulling down from top; dampen for nicer feel
        const damped = Math.min(dy * 0.6, threshold * 2);
        setPull(damped);
        // Reduce rubber-banding interaction while pulling the header indicator
        // (on iOS this won't fully disable bounce, but helps responsiveness)
        if (damped > 0) e.preventDefault?.();
      }
    };

    const onTouchEnd = async () => {
      if (startY.current == null || refreshing) {
        setPull(0);
        startY.current = null;
        return;
      }
      const shouldRefresh = pull >= threshold;
      startY.current = null;

      if (!shouldRefresh) {
        // Snap back
        setPull(0);
        return;
      }

      // Trigger refresh
      setRefreshing(true);
      try {
        if (onRefresh) {
          await onRefresh();
        } else {
          // Hard reload by default
          window.location.reload();
        }
      } finally {
        // If we didn't reload (custom onRefresh), reset the UI
        setPull(0);
        setRefreshing(false);
      }
    };

    // Attach to window for body scroll
    window.addEventListener("touchstart", onTouchStart, { passive: false });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart as any);
      window.removeEventListener("touchmove", onTouchMove as any);
      window.removeEventListener("touchend", onTouchEnd as any);
    };
  }, [active, pull, threshold, refreshing, onRefresh, readScrollTop]);

  if (!active) return null;

  // Visual indicator: sits below the status bar / Dynamic Island
  const insetTop = "env(safe-area-inset-top, 0px)";
  const progress = Math.min(pull / threshold, 1);

  return (
    <Box
      pointerEvents="none"
      position="fixed"
      top={`calc(${insetTop} + 0px)`}
      left={0}
      right={0}
      zIndex={999}
      display={pull > 0 || refreshing ? "block" : "none"}
    >
      <HStack
        justify="center"
        align="center"
        h="44px"
        opacity={refreshing ? 1 : 0.9}
        transform={`translateY(${Math.max(0, pull - 44)}px)`}
        transition={refreshing ? "opacity 0.2s" : "transform 0.1s"}
      >
        <HStack
          gap="2"
          px="10px"
          py="6px"
          borderRadius="full"
          bg="white"
          boxShadow="sm"
        >
          {refreshing ? (
            <>
              <Spinner size="sm" />
              <Text fontSize="sm">Refreshing…</Text>
            </>
          ) : (
            <>
              <Box
                w="16px"
                h="16px"
                borderRadius="full"
                borderWidth="2px"
                borderColor="gray.300"
                // little fill ring to show progress
                bgGradient={`conic-gradient(#3182ce ${Math.floor(
                  progress * 360
                )}deg, transparent 0deg)`}
                mask="radial-gradient(circle 6px, transparent 6px, black 7px)"
              />
              <Text fontSize="sm" color="gray.700">
                Pull to refresh
              </Text>
            </>
          )}
        </HStack>
      </HStack>
    </Box>
  );
}
