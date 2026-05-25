"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Box } from "@chakra-ui/react";

// Lazy-loaded photo that handles broken/missing sources gracefully.
//
// Key behaviors:
//   - Lazy-loads via IntersectionObserver — the <img> tag only mounts
//     when the square scrolls into view (200px rootMargin).
//   - While loading, shows a shimmer placeholder.
//   - On successful load, fades the image in.
//   - On error (404, deleted R2 object, network failure), returns null —
//     the entire square disappears from the DOM. The previous version
//     left a shimmer running indefinitely, making missing photos look
//     like they were stuck loading.
//
// Use this everywhere photos can plausibly be deleted from R2 (job
// photos, equipment photos, etc.) instead of raw <img> tags or per-tab
// LazyPhoto re-implementations.

type Props = {
  src: string;
  alt?: string;
  onClick?: () => void;
  /** Edge size in px when layout is "square". Default 80. */
  size?: number;
  /** "square" = fixed 80×80 thumbnail. "fill" = stretches to parent. */
  layout?: "square" | "fill";
  /** Chakra rounded token. Default "lg". */
  rounded?: string;
  /** Optional border. Default true (light gray). */
  bordered?: boolean;
  /** Extra inline style on the inner <img>. */
  imgStyle?: CSSProperties;
  /** Fires after the image transitions from loading → loaded. Useful
   *  for callers tracking when ANY photo in a list has rendered (e.g.
   *  to dismiss a global skeleton). */
  onReady?: () => void;
  /** Fires when the image failed to load. The square hides itself
   *  regardless; this is just a hook for callers that want to act on
   *  it (e.g. close a fullscreen viewer). */
  onError?: () => void;
};

export default function SafePhoto({
  src,
  alt = "Photo",
  onClick,
  size = 80,
  layout = "square",
  rounded = "lg",
  bordered = true,
  imgStyle,
  onReady,
  onError,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Image 404'd / R2 object deleted / network blew up — hide the whole
  // square so the user doesn't stare at a shimmer that never resolves.
  if (failed) return null;

  const sizing =
    layout === "square"
      ? { flexShrink: 0, w: `${size}px`, h: `${size}px` }
      : { w: "100%", h: "100%" };

  return (
    <Box
      ref={ref}
      {...sizing}
      rounded={rounded}
      overflow="hidden"
      cursor={onClick ? "pointer" : undefined}
      onClick={onClick}
      borderWidth={bordered ? "1px" : 0}
      borderColor="gray.200"
      position="relative"
    >
      {!loaded && (
        <>
          <style>{`
            @keyframes safe-photo-shimmer {
              0% { background-position: 200% 0; }
              100% { background-position: -200% 0; }
            }
          `}</style>
          <Box
            position="absolute"
            inset="0"
            style={{
              background:
                "linear-gradient(90deg, #e2e8f0 0%, #f7fafc 50%, #e2e8f0 100%)",
              backgroundSize: "200% 100%",
              animation: "safe-photo-shimmer 1.5s ease-in-out infinite",
            }}
          />
        </>
      )}
      {inView && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: loaded ? 1 : 0,
            transition: "opacity 0.3s ease",
            ...imgStyle,
          }}
          onLoad={() => {
            setLoaded(true);
            onReady?.();
          }}
          onError={() => {
            setFailed(true);
            onError?.();
          }}
        />
      )}
    </Box>
  );
}
