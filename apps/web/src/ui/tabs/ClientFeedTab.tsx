"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Badge,
  Card,
  HStack,
  Text,
  VStack,
  Spinner,
} from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";

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

type Stats = {
  jobsCompleted: number;
  jobsThisMonth: number;
  activeProperties: number;
  teamSize: number;
  inProgress: number;
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
  return new Date(dateStr).toLocaleDateString();
}

function relativeTime(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Tomorrow";
  return new Date(dateStr).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function workerLabel(workers: string[]): string {
  if (workers.length === 0) return "";
  if (workers.length === 1) return workers[0];
  if (workers.length === 2) return `${workers[0]} & ${workers[1]}`;
  return `${workers[0]} + ${workers.length - 1} others`;
}

const typeBadge: Record<string, { label: string; palette: string; variant: string }> = {
  completed: { label: "Completed", palette: "green", variant: "solid" },
  in_progress: { label: "In Progress", palette: "blue", variant: "solid" },
  upcoming: { label: "Upcoming", palette: "gray", variant: "outline" },
};

export default function ClientFeedTab() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
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
      try {
        const st = await apiGet<Stats>("/api/public/stats");
        setStats(st);
      } catch (err: any) {
        console.error("Stats load failed:", err);
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
  const upcoming = items.filter((i) => i.type === "upcoming");

  return (
    <Box w="full" pb={8}>
      {/* Stats banner */}
      {stats && (
        <Box mb={5} p={4} bg="green.50" rounded="xl" borderWidth="1px" borderColor="green.200">
          <HStack gap={6} justify="center" wrap="wrap">
            <VStack gap={0}>
              <Text fontSize="2xl" fontWeight="bold" color="green.700">{stats.jobsCompleted.toLocaleString()}</Text>
              <Text fontSize="xs" color="green.600">Jobs Completed</Text>
            </VStack>
            <VStack gap={0}>
              <Text fontSize="2xl" fontWeight="bold" color="green.700">{stats.jobsThisMonth}</Text>
              <Text fontSize="xs" color="green.600">This Month</Text>
            </VStack>
            <VStack gap={0}>
              <Text fontSize="2xl" fontWeight="bold" color="teal.700">{stats.activeProperties}</Text>
              <Text fontSize="xs" color="teal.600">Properties</Text>
            </VStack>
            <VStack gap={0}>
              <Text fontSize="2xl" fontWeight="bold" color="blue.700">{stats.teamSize}</Text>
              <Text fontSize="xs" color="blue.600">Team Members</Text>
            </VStack>
            {stats.inProgress > 0 && (
              <VStack gap={0}>
                <Text fontSize="2xl" fontWeight="bold" color="blue.600">{stats.inProgress}</Text>
                <Text fontSize="xs" color="blue.500">Active Now</Text>
              </VStack>
            )}
          </HStack>
        </Box>
      )}

      {error && (
        <Text textAlign="center" color="red.500" py={4} fontSize="sm">{error}</Text>
      )}

      {/* In Progress section */}
      {inProgress.length > 0 && (
        <Box mb={4}>
          <Text fontSize="sm" fontWeight="semibold" color="blue.600" mb={2} px={1}>
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
        <Box mb={4}>
          <Text fontSize="sm" fontWeight="semibold" color="green.600" mb={2} px={1}>
            Recently Completed
          </Text>
          <VStack align="stretch" gap={2}>
            {completed.map((item) => (
              <FeedCard key={item.id} item={item} onPhotoClick={openViewer} />
            ))}
          </VStack>
        </Box>
      )}

      {/* Upcoming section */}
      {upcoming.length > 0 && (
        <Box mb={4}>
          <Text fontSize="sm" fontWeight="semibold" color="fg.muted" mb={2} px={1}>
            Coming Up
          </Text>
          <VStack align="stretch" gap={2}>
            {upcoming.map((item) => (
              <FeedCard key={item.id} item={item} onPhotoClick={openViewer} />
            ))}
          </VStack>
        </Box>
      )}

      {!error && items.length === 0 && (
        <Text textAlign="center" color="fg.muted" py={8}>No recent activity to show.</Text>
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
  const badge = typeBadge[item.type];
  const isUpcoming = item.type === "upcoming";
  const isInProgress = item.type === "in_progress";

  return (
    <Card.Root variant="outline" borderColor={isInProgress ? "blue.200" : undefined} bg={isInProgress ? "blue.50" : undefined}>
      <Card.Body py="3" px="4">
        <HStack justify="space-between" align="start" gap={3}>
          <VStack align="start" gap={1} flex="1" minW={0}>
            <HStack gap={2} wrap="wrap">
              <Badge colorPalette={badge.palette} variant={badge.variant as any} fontSize="xs" borderRadius="full" px="2">
                {badge.label}
              </Badge>
              <Badge colorPalette="gray" variant="outline" fontSize="xs" borderRadius="full" px="2">
                {prettyKind(item.kind)}
              </Badge>
              {item.estimatedMinutes && !item.durationMinutes && (
                <Badge colorPalette="gray" variant="subtle" fontSize="xs" borderRadius="full" px="2">
                  ~{formatDuration(item.estimatedMinutes)}
                </Badge>
              )}
            </HStack>

            {item.area && (
              <Text fontSize="sm" fontWeight="medium">
                {item.area}
              </Text>
            )}

            <HStack gap={3} fontSize="xs" color="fg.muted" wrap="wrap">
              {item.workers.length > 0 && (
                <Text>{workerLabel(item.workers)}</Text>
              )}
              {item.durationMinutes != null && item.durationMinutes > 0 && (
                <Text>
                  {isInProgress ? `${formatDuration(item.durationMinutes)} so far` : formatDuration(item.durationMinutes)}
                </Text>
              )}
            </HStack>
          </VStack>

          <Text fontSize="xs" color="fg.muted" flexShrink={0} whiteSpace="nowrap">
            {isUpcoming ? relativeTime(item.timestamp) : timeAgo(item.timestamp)}
          </Text>
        </HStack>

        {/* Photos */}
        {item.photos.length > 0 && (
          <HStack gap={2} mt={3} overflowX="auto" pb={1}>
            {item.photos.map((p, idx) => (
              <Box
                key={p.id}
                flexShrink={0}
                w="100px"
                h="100px"
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
      </Card.Body>
    </Card.Root>
  );
}
