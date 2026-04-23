"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Card,
  HStack,
  Text,
  VStack,
  Spinner,
} from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { fmtDate, fmtDateWeekday } from "@/src/lib/lib";

type FeedPhoto = {
  id: string;
  url: string;
  contentType?: string | null;
};

type FeedItem = {
  id: string;
  type: "completed" | "in_progress" | "upcoming";
  timestamp: string;
  jobKind: string;
  kind: string;
  area: string;
  workers: string[];
  durationMinutes: number | null;
  estimatedMinutes: number | null;
  photos: FeedPhoto[];
};

function prettyKind(kind: string): string {
  return kind.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return relativeTime(dateStr);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return fmtDate(dateStr);
}

function relativeTime(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Tomorrow";
  return fmtDateWeekday(dateStr);
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function workerLabel(workers: string[]): string {
  if (workers.length === 0) return "Our team";
  if (workers.length === 1) return workers[0];
  if (workers.length === 2) return `${workers[0]} & ${workers[1]}`;
  return `${workers[0]}, ${workers[1]} & others`;
}

/** Build a natural-language description for a feed item */
function feedMessage(item: FeedItem): string {
  const where = item.area || "the area";

  if (item.type === "in_progress") {
    return `Our team is servicing lawns in ${where}`;
  }
  if (item.type === "upcoming") {
    return `Lawn care scheduled in ${where}`;
  }
  // completed
  return `Our team completed lawn care in ${where}`;
}

const typeStyle: Record<string, { dot: string; color: string; bg?: string; borderColor?: string }> = {
  in_progress: { dot: "blue.500", color: "blue.700", bg: "blue.50", borderColor: "blue.200" },
  completed: { dot: "green.500", color: "fg.default" },
  upcoming: { dot: "gray.400", color: "fg.muted" },
};

export default function ClientFeedTab() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [daysShown, setDaysShown] = useState(3);
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewerPhoto, setViewerPhoto] = useState<string | null>(null);
  const [viewerPhotos, setViewerPhotos] = useState<FeedPhoto[]>([]);
  const [viewerIdx, setViewerIdx] = useState(0);

  // Global keyboard handler for photo viewer
  const viewerIdxRef = useRef(viewerIdx);
  const viewerPhotosRef = useRef(viewerPhotos);
  viewerIdxRef.current = viewerIdx;
  viewerPhotosRef.current = viewerPhotos;
  useEffect(() => {
    if (!viewerPhoto) return;
    const handler = (e: KeyboardEvent) => {
      const photos = viewerPhotosRef.current;
      const idx = viewerIdxRef.current;
      if (e.key === "ArrowLeft" && idx > 0) { e.preventDefault(); const next = idx - 1; setViewerIdx(next); setViewerPhoto(photos[next]?.url ?? null); }
      else if (e.key === "ArrowRight" && idx < photos.length - 1) { e.preventDefault(); const next = idx + 1; setViewerIdx(next); setViewerPhoto(photos[next]?.url ?? null); }
      else if (e.key === "Escape") { setViewerPhoto(null); setViewerPhotos([]); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewerPhoto]);

  async function loadFeed(days: number, showLoading = true): Promise<FeedItem[]> {
    if (showLoading) setLoadingMore(true);
    let result: FeedItem[] = [];
    try {
      const feed = await apiGet<{ items: FeedItem[] }>(`/api/public/feed?limit=50&days=${days}`);
      result = feed.items;
      setItems(feed.items);
      setDaysShown(days);
    } catch (err: any) {
      if (days === 3) setError(err?.message || "Failed to load feed");
    }
    setLoading(false);
    setLoadingMore(false);
    return result;
  }

  useEffect(() => {
    loadFeed(3, false).then((items) => {
      if (items.length === 0) void loadFeed(7, false);
    });
  }, []);

  function openViewer(photos: FeedPhoto[], idx: number) {
    setViewerPhotos(photos);
    setViewerIdx(idx);
    setViewerPhoto(photos[idx]?.url ?? null);
  }

  function navigateViewer(dir: -1 | 1) {
    const next = viewerIdx + dir;
    if (next >= 0 && next < viewerPhotos.length) {
      setViewerIdx(next);
      setViewerPhoto(viewerPhotos[next].url);
    }
  }

  if (loading) {
    return (
      <Box py={10} textAlign="center">
        <Spinner size="lg" />
      </Box>
    );
  }

  // Group items by type for sections
  const inProgress = items.filter((i) => i.type === "in_progress");
  const completed = items.filter((i) => i.type === "completed");

  return (
    <Box w="full" pb={8}>
      {error && (
        <Text textAlign="center" color="red.500" py={4} fontSize="sm">{error}</Text>
      )}

      {items.length > 0 && (
        <Box mb={5}>
          <Text fontSize="xs" fontWeight="semibold" color={daysShown <= 3 ? "blue.500" : "green.600"} mb={2} px={1} textTransform="uppercase" letterSpacing="wide">
            {daysShown <= 3 ? "Happening Now" : `Recent Activity — Last ${daysShown} days`}
          </Text>
          <VStack align="stretch" gap={2}>
            {items.map((item) => (
              <FeedCard key={item.id} item={item} onPhotoClick={openViewer} />
            ))}
          </VStack>
        </Box>
      )}

      {/* Show more */}
      {daysShown < 30 && !error && (
        <Box textAlign="center" py={3}>
          <Text
            as="button"
            fontSize="sm"
            color="blue.600"
            fontWeight="medium"
            cursor="pointer"
            onClick={() => void loadFeed(daysShown === 3 ? 7 : 30)}
            _hover={{ textDecoration: "underline" }}
          >
            {loadingMore ? "Loading..." : daysShown === 3 ? "Show more — last 7 days" : "Show more — last 30 days"}
          </Text>
        </Box>
      )}

      {!error && items.length === 0 && (
        <Box textAlign="center" py={10}>
          <Text color="fg.muted" fontSize="lg">All caught up!</Text>
          <Text color="fg.muted" fontSize="sm" mt={1}>Check back soon for updates on your lawn care.</Text>
        </Box>
      )}

      {/* Full-screen photo viewer */}
      {viewerPhoto && (
        <Box
          position="fixed"
          inset="0"
          zIndex={10000}
          bg="blackAlpha.800"
          display="flex"
          alignItems="center"
          justifyContent="center"
          onClick={() => { setViewerPhoto(null); setViewerPhotos([]); }}
          onTouchStart={(e) => { (e.currentTarget as any)._touchX = e.touches[0].clientX; }}
          onTouchEnd={(e) => {
            const dx = e.changedTouches[0].clientX - ((e.currentTarget as any)._touchX ?? 0);
            if (Math.abs(dx) > 50) { e.stopPropagation(); dx < 0 ? navigateViewer(1) : navigateViewer(-1); }
          }}
        >
          {viewerIdx > 0 && (
            <Box
              position="absolute"
              left="3"
              top="50%"
              transform="translateY(-50%)"
              color="white"
              fontSize="2xl"
              cursor="pointer"
              p={2}
              onClick={(e) => { e.stopPropagation(); navigateViewer(-1); }}
              userSelect="none"
            >
              ◀
            </Box>
          )}
          <img
            src={viewerPhoto}
            alt="Photo"
            style={{ maxWidth: "90vw", maxHeight: "85vh", objectFit: "contain", borderRadius: "8px" }}
            onClick={(e) => e.stopPropagation()}
          />
          {viewerIdx < viewerPhotos.length - 1 && (
            <Box
              position="absolute"
              right="3"
              top="50%"
              transform="translateY(-50%)"
              color="white"
              fontSize="2xl"
              cursor="pointer"
              p={2}
              onClick={(e) => { e.stopPropagation(); navigateViewer(1); }}
              userSelect="none"
            >
              ▶
            </Box>
          )}
          <Text
            position="absolute"
            bottom="4"
            color="whiteAlpha.700"
            fontSize="sm"
          >
            {viewerIdx + 1} / {viewerPhotos.length}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function LazyImage({ src, alt, onClick }: { src: string; alt: string; onClick?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); observer.disconnect(); } },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Box
      ref={ref}
      flexShrink={0}
      w="90px"
      h="90px"
      rounded="lg"
      overflow="hidden"
      cursor={onClick ? "pointer" : undefined}
      onClick={onClick}
      borderWidth="1px"
      borderColor="gray.200"
      position="relative"
    >
      {/* Skeleton shimmer */}
      {!loaded && (
        <>
          <style>{`
            @keyframes img-shimmer {
              0% { background-position: 200% 0; }
              100% { background-position: -200% 0; }
            }
          `}</style>
          <Box
            position="absolute"
            inset="0"
            style={{
              background: "linear-gradient(90deg, #e2e8f0 0%, #f7fafc 50%, #e2e8f0 100%)",
              backgroundSize: "200% 100%",
              animation: "img-shimmer 1.5s ease-in-out infinite",
            }}
          />
        </>
      )}
      {inView && (
        <img
          src={src}
          alt={alt}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: loaded ? 1 : 0,
            transition: "opacity 0.3s ease",
          }}
          onLoad={() => setLoaded(true)}
        />
      )}
    </Box>
  );
}

function FeedCard({ item, onPhotoClick }: { item: FeedItem; onPhotoClick: (photos: FeedPhoto[], idx: number) => void }) {
  const style = typeStyle[item.type];
  const isUpcoming = item.type === "upcoming";

  return (
    <Card.Root
      variant="outline"
      borderColor={style.borderColor}
      bg={style.bg}
    >
      <Card.Body py="3" px="4">
        <HStack align="start" gap={3}>
          {/* Timeline dot */}
          <Box
            w="8px"
            h="8px"
            borderRadius="full"
            bg={style.dot}
            mt="6px"
            flexShrink={0}
          />
          <VStack align="start" gap={1} flex="1" minW={0}>
            <Text fontSize="sm" color={style.color}>
              {feedMessage(item)}
            </Text>
            <Text fontSize="xs" color="fg.muted">
              {isUpcoming ? relativeTime(item.timestamp) : timeAgo(item.timestamp)}
            </Text>

            {/* Photos */}
            {item.photos.length > 0 && (
              <HStack gap={2} mt={1} wrap="wrap">
                {item.photos.map((p, idx) => (
                  <LazyImage
                    key={p.id}
                    src={p.url}
                    alt="Job photo"
                    onClick={() => onPhotoClick(item.photos, idx)}
                  />
                ))}
              </HStack>
            )}
          </VStack>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}
