"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Card,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiGet, apiPost } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/lib";
import { MapLink } from "@/src/ui/helpers/Link";

type Photo = { id: string; url: string; contentType?: string | null };

type CompletedJob = {
  id: string;
  kind: string;
  status: string;
  startAt?: string | null;
  completedAt?: string | null;
  property: { id: string; displayName: string; city?: string | null; state?: string | null };
  workers: string[];
  durationMinutes: number | null;
  photos: Photo[];
  paid: boolean;
};

type UpcomingJob = {
  id: string;
  kind: string;
  status: string;
  startAt?: string | null;
  startedAt?: string | null;
  estimatedMinutes?: number | null;
  property: { id: string; displayName: string; city?: string | null; state?: string | null };
  workers: string[];
};

type ClientProfile = {
  linked: boolean;
  contact?: { id: string; firstName: string; lastName: string; email?: string | null };
  client?: { id: string; displayName: string; properties: { id: string; displayName: string; street1?: string | null; city?: string | null; state?: string | null }[] };
};

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

export default function ClientMyJobsTab() {
  const [profile, setProfile] = useState<ClientProfile | null>(null);
  const [completed, setCompleted] = useState<CompletedJob[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewerPhoto, setViewerPhoto] = useState<string | null>(null);
  const [viewerPhotos, setViewerPhotos] = useState<Photo[]>([]);
  const [viewerIdx, setViewerIdx] = useState(0);

  useEffect(() => {
    async function load() {
      // Try to auto-link on first load
      try { await apiPost("/api/client/link"); } catch {}

      try {
        const me = await apiGet<ClientProfile>("/api/client/me");
        setProfile(me);
        if (me.linked) {
          const [jobsRes, upcomingRes] = await Promise.all([
            apiGet<{ items: CompletedJob[] }>("/api/client/jobs"),
            apiGet<{ items: UpcomingJob[] }>("/api/client/upcoming"),
          ]);
          setCompleted(jobsRes.items);
          setUpcoming(upcomingRes.items);
        }
      } catch (err) {
        console.error("Client load failed:", err);
        setProfile({ linked: false });
      }
      setLoading(false);
    }
    void load();
  }, []);

  function openViewer(photos: Photo[], idx: number) {
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
    return <Box py={10} textAlign="center"><Spinner size="lg" /></Box>;
  }

  if (!profile?.linked) {
    return (
      <Box py={10} textAlign="center">
        <VStack gap={3}>
          <Text fontSize="lg" fontWeight="semibold">Welcome!</Text>
          <Text fontSize="sm" color="fg.muted" maxW="sm">
            Your account isn't linked to a client profile yet. If you're an existing client, make sure you signed up with the same email address we have on file.
          </Text>
          <Text fontSize="sm" color="fg.muted" maxW="sm">
            Need to become a client? Visit our Services tab to get in touch.
          </Text>
        </VStack>
      </Box>
    );
  }

  return (
    <Box w="full" pb={8}>
      {/* Welcome header */}
      <Box mb={4} px={1}>
        <Text fontSize="lg" fontWeight="semibold">
          Welcome, {profile.contact?.firstName}
        </Text>
        {profile.client && (
          <>
            <Text fontSize="sm" color="fg.muted">
              {profile.client.properties.length} propert{profile.client.properties.length === 1 ? "y" : "ies"} on file
            </Text>
            {profile.client.properties.map((p) => (
              <Box key={p.id} fontSize="xs">
                <MapLink address={[p.street1, p.city, p.state].filter(Boolean).join(", ")} />
              </Box>
            ))}
          </>
        )}
      </Box>

      {/* Upcoming / In Progress */}
      {upcoming.length > 0 && (
        <Box mb={5}>
          <Text fontSize="xs" fontWeight="semibold" color="blue.500" mb={2} px={1} textTransform="uppercase" letterSpacing="wide">
            {upcoming.some((j) => j.status === "IN_PROGRESS") ? "Happening Now & Upcoming" : "Upcoming"}
          </Text>
          <VStack align="stretch" gap={2}>
            {upcoming.map((job) => {
              const isActive = job.status === "IN_PROGRESS";
              return (
                <Card.Root key={job.id} variant="outline" borderColor={isActive ? "blue.200" : undefined} bg={isActive ? "blue.50" : undefined}>
                  <Card.Body py="3" px="4">
                    <HStack justify="space-between" align="start">
                      <VStack align="start" gap={1} flex="1" minW={0}>
                        <Text fontSize="sm" fontWeight="medium">{job.property.displayName}</Text>
                        <HStack gap={2} wrap="wrap">
                          <Badge colorPalette={isActive ? "blue" : "gray"} variant={isActive ? "solid" : "outline"} fontSize="xs" borderRadius="full" px="2">
                            {isActive ? "In Progress" : "Scheduled"}
                          </Badge>
                          {job.estimatedMinutes && (
                            <Text fontSize="xs" color="fg.muted">~{formatDuration(job.estimatedMinutes)}</Text>
                          )}
                        </HStack>
                        {job.workers.length > 0 && (
                          <Text fontSize="xs" color="fg.muted">{workerLabel(job.workers)}</Text>
                        )}
                      </VStack>
                      <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                        {job.startAt ? fmtDate(job.startAt) : ""}
                      </Text>
                    </HStack>
                  </Card.Body>
                </Card.Root>
              );
            })}
          </VStack>
        </Box>
      )}

      {/* Completed */}
      {completed.length > 0 && (
        <Box mb={5}>
          <Text fontSize="xs" fontWeight="semibold" color="green.600" mb={2} px={1} textTransform="uppercase" letterSpacing="wide">
            Completed
          </Text>
          <VStack align="stretch" gap={2}>
            {completed.map((job) => (
              <Card.Root key={job.id} variant="outline">
                <Card.Body py="3" px="4">
                  <HStack justify="space-between" align="start">
                    <VStack align="start" gap={1} flex="1" minW={0}>
                      <Text fontSize="sm" fontWeight="medium">{job.property.displayName}</Text>
                      <HStack gap={2} wrap="wrap">
                        <Badge colorPalette="green" variant="solid" fontSize="xs" borderRadius="full" px="2">
                          Completed
                        </Badge>
                        {job.paid && (
                          <Badge colorPalette="teal" variant="solid" fontSize="xs" borderRadius="full" px="2">
                            Paid
                          </Badge>
                        )}
                        {job.durationMinutes != null && job.durationMinutes > 0 && (
                          <Text fontSize="xs" color="fg.muted">{formatDuration(job.durationMinutes)}</Text>
                        )}
                      </HStack>
                      {job.workers.length > 0 && (
                        <Text fontSize="xs" color="fg.muted">{workerLabel(job.workers)}</Text>
                      )}
                    </VStack>
                    <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                      {job.completedAt ? fmtDate(job.completedAt) : ""}
                    </Text>
                  </HStack>

                  {/* Photos */}
                  {job.photos.length > 0 && (
                    <HStack gap={2} mt={2} overflowX="auto" pb={1}>
                      {job.photos.map((p, idx) => (
                        <Box
                          key={p.id}
                          flexShrink={0}
                          w="90px"
                          h="90px"
                          rounded="lg"
                          overflow="hidden"
                          cursor="pointer"
                          onClick={() => openViewer(job.photos, idx)}
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
            ))}
          </VStack>
        </Box>
      )}

      {completed.length === 0 && upcoming.length === 0 && (
        <Text textAlign="center" color="fg.muted" py={8}>No jobs to show yet. Check back soon!</Text>
      )}

      {/* Photo viewer */}
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
              position="absolute" left="3" top="50%" transform="translateY(-50%)"
              color="white" fontSize="2xl" cursor="pointer" p={2}
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
              position="absolute" right="3" top="50%" transform="translateY(-50%)"
              color="white" fontSize="2xl" cursor="pointer" p={2}
              onClick={(e) => { e.stopPropagation(); navigateViewer(1); }}
              userSelect="none"
            >
              ▶
            </Box>
          )}
          <Text position="absolute" bottom="4" color="whiteAlpha.700" fontSize="sm">
            {viewerIdx + 1} / {viewerPhotos.length}
          </Text>
        </Box>
      )}
    </Box>
  );
}
