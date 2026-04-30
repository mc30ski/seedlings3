"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Text } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";

type Photo = { id: string; url: string };

type Props = {
  equipmentId: string;
  /** Use admin endpoint when true; defaults to worker (read-only) */
  isAdmin?: boolean;
  size?: number;
  onClick?: () => void;
};

/**
 * Minimal thumbnail of the first photo for an equipment item.
 * Lazy-loads when scrolled into view (IntersectionObserver).
 * Clicking opens a full-size viewer (unless onClick is provided).
 */
export default function EquipmentThumbnail({ equipmentId, isAdmin, size = 64, onClick }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [inView, setInView] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Observe visibility
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" }, // start loading slightly before it enters the viewport
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fetch the photo URL once visible
  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    (async () => {
      try {
        const endpoint = isAdmin ? `/api/admin/equipment/${equipmentId}/photos` : `/api/equipment/${equipmentId}/photos`;
        const list = await apiGet<Photo[]>(endpoint);
        if (cancelled) return;
        setUrl(Array.isArray(list) && list.length > 0 ? list[0].url : null);
      } catch {
        if (!cancelled) setUrl(null);
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [inView, equipmentId, isAdmin]);

  // Always reserve space so siblings don't shift when the photo loads (or doesn't exist).
  const hasImage = !!url;
  const showEmptyLabel = loaded && !url;

  const handleClick = (ev: React.MouseEvent) => {
    if (!hasImage) return;
    ev.stopPropagation();
    if (onClick) onClick();
    else setViewerOpen(true);
  };

  return (
    <>
      <Box
        ref={ref}
        w={`${size}px`}
        h={`${size}px`}
        borderRadius="md"
        overflow="hidden"
        borderWidth="1px"
        borderColor="gray.200"
        flexShrink={0}
        cursor={hasImage ? "pointer" : undefined}
        onClick={handleClick}
        bg="gray.100"
        display="flex"
        alignItems="center"
        justifyContent="center"
      >
        {hasImage ? (
          <img
            src={url}
            alt="Equipment"
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : showEmptyLabel ? (
          <Text fontSize="2xs" color="fg.muted" textAlign="center" px={1}>
            No image
          </Text>
        ) : null}
      </Box>

      {viewerOpen && url && (
        <Box
          position="fixed"
          inset="0"
          zIndex={10000}
          bg="blackAlpha.800"
          display="flex"
          alignItems="center"
          justifyContent="center"
          onClick={(e) => { e.stopPropagation(); setViewerOpen(false); }}
        >
          <img
            src={url}
            alt="Equipment"
            style={{ maxWidth: "90vw", maxHeight: "85vh", objectFit: "contain", borderRadius: "8px" }}
            onClick={(e) => e.stopPropagation()}
          />
        </Box>
      )}
    </>
  );
}
