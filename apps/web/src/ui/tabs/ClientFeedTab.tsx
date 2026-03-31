"use client";

import { useEffect, useState } from "react";
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
  const [viewerPhoto, setViewerPhoto] = useState<string | null>(null);
  const [viewerPhotos, setViewerPhotos] = useState<FeedPhoto[]>([]);
  const [viewerIdx, setViewerIdx] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const feed = await apiGet<{ items: FeedItem[] }>("/api/public/feed?limit=30");
        setItems(feed.items);
      } catch (err: any) {
        console.error("Feed load failed:", err);
        setError(err?.message || "Failed to load feed");
      }
      setLoading(false);
    }
    void load();
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

      {/* In Progress section */}
      {inProgress.length > 0 && (
        <Box mb={5}>
          <Text fontSize="xs" fontWeight="semibold" color="blue.500" mb={2} px={1} textTransform="uppercase" letterSpacing="wide">
            Happening Now
          </Text>
          <VStack align="stretch" gap={2}>
            {inProgress.map((item) => (
              <FeedCard key={item.id} item={item} onPhotoClick={openViewer} />
            ))}
          </VStack>
        </Box>
      )}

      {/* Completed section */}
      {completed.length > 0 && (
        <Box mb={5}>
          <Text fontSize="xs" fontWeight="semibold" color="green.600" mb={2} px={1} textTransform="uppercase" letterSpacing="wide">
            Recent Activity
          </Text>
          <VStack align="stretch" gap={2}>
            {completed.map((item) => (
              <FeedCard key={item.id} item={item} onPhotoClick={openViewer} />
            ))}
          </VStack>
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
              <HStack gap={2} mt={1} overflowX="auto" pb={1}>
                {item.photos.map((p, idx) => (
                  <Box
                    key={p.id}
                    flexShrink={0}
                    w="90px"
                    h="90px"
                    rounded="lg"
                    overflow="hidden"
                    cursor="pointer"
                    onClick={() => onPhotoClick(item.photos, idx)}
                    borderWidth="1px"
                    borderColor="gray.200"
                  >
                    <img
                      src={p.url}
                      alt="Job photo"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      loading="lazy"
                    />
                  </Box>
                ))}
              </HStack>
            )}
          </VStack>
        </HStack>
      </Card.Body>
    </Card.Root>
  );
}
