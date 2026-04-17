"use client";

import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Download } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { fmtDate, fmtDateWeekday } from "@/src/lib/lib";
import { MapLink } from "@/src/ui/helpers/Link";
import { type ReceiptData, downloadReceipt } from "@/src/lib/receipt";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";

type Photo = { id: string; url: string; contentType?: string | null };

type CompletedJob = {
  id: string;
  kind: string;
  status: string;
  startAt?: string | null;
  completedAt?: string | null;
  jobType?: string | null;
  price?: number | null;
  property: { id: string; displayName: string; street1?: string | null; city?: string | null; state?: string | null };
  workers: string[];
  durationMinutes: number | null;
  photos: Photo[];
  paid: boolean;
  payment?: { amountPaid: number; method: string; paidAt: string } | null;
};

type UpcomingJob = {
  id: string;
  kind: string;
  status: string;
  startAt?: string | null;
  startedAt?: string | null;
  estimatedMinutes?: number | null;
  jobType?: string | null;
  price?: number | null;
  property: { id: string; displayName: string; street1?: string | null; city?: string | null; state?: string | null };
  workers: string[];
  photos?: Photo[];
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

function prettyJobType(jt: string | null | undefined): string {
  if (!jt) return "";
  return jt.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function LazyPhoto({ src, onClick }: { src: string; onClick?: () => void }) {
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
    <Box ref={ref} flexShrink={0} w="80px" h="80px" rounded="lg" overflow="hidden" cursor={onClick ? "pointer" : undefined} onClick={onClick} borderWidth="1px" borderColor="gray.200" position="relative">
      {!loaded && (
        <>
          <style>{`
            @keyframes img-shimmer {
              0% { background-position: 200% 0; }
              100% { background-position: -200% 0; }
            }
          `}</style>
          <Box position="absolute" inset="0" style={{
            background: "linear-gradient(90deg, #e2e8f0 0%, #f7fafc 50%, #e2e8f0 100%)",
            backgroundSize: "200% 100%",
            animation: "img-shimmer 1.5s ease-in-out infinite",
          }} />
        </>
      )}
      {inView && (
        <img src={src} alt="Photo" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: loaded ? 1 : 0, transition: "opacity 0.3s ease" }} onLoad={() => setLoaded(true)} />
      )}
    </Box>
  );
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

  function handleDownloadReceipt(job: CompletedJob) {
    if (!job.payment || !profile?.client) return;
    const addr = [job.property.street1, job.property.city, job.property.state].filter(Boolean).join(", ");
    const data: ReceiptData = {
      businessName: "Seedlings Lawn Care",
      clientName: profile.client.displayName,
      propertyAddress: addr,
      jobType: prettyJobType(job.jobType) || prettyJobType(job.kind) || "Lawn Care",
      serviceDate: job.startAt ? fmtDate(job.startAt) : "—",
      completedDate: job.completedAt ? fmtDate(job.completedAt) : "—",
      amount: job.payment.amountPaid,
      method: job.payment.method,
      workers: job.workers,
      receiptId: job.id.slice(-8).toUpperCase(),
    };
    downloadReceipt(data);
    publishInlineMessage({ type: "SUCCESS", text: "Receipt downloaded." });
  }

  if (loading) return <Box py={10} textAlign="center"><Spinner size="lg" /></Box>;

  if (!profile?.linked) {
    return (
      <Box w="full" pb={8}>
        <Box p={5} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="lg">
          <VStack gap={3} align="start">
            <Text fontSize="xl" fontWeight="bold" color="blue.800">Welcome to Seedlings Lawn Care</Text>
            <Text fontSize="sm" color="blue.700">
              Your account isn't linked to a client profile yet. An administrator will connect your account once your profile has been approved.
            </Text>
            <Text fontSize="sm" color="blue.600">
              Once linked, you'll be able to see your properties, upcoming services, completed work with photos, and payment history right here.
            </Text>
            <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="3" py="1" borderRadius="full">Pending setup</Badge>
          </VStack>
        </Box>
      </Box>
    );
  }

  return (
    <Box w="full" pb={8}>
      {/* Welcome header */}
      <Box mb={4} p={4} bg="green.50" borderWidth="1px" borderColor="green.200" rounded="lg">
        <Text fontSize="xl" fontWeight="bold" color="green.800">
          Welcome back, {profile.contact?.firstName}!
        </Text>
        <Text fontSize="sm" color="green.700" mt={1}>{profile.client?.displayName}</Text>
      </Box>

      {/* Properties */}
      {profile.client && profile.client.properties.length > 0 && (
        <Box mb={5}>
          <Text fontSize="xs" fontWeight="semibold" color="green.600" mb={2} px={1} textTransform="uppercase" letterSpacing="wide">
            Your Properties ({profile.client.properties.length})
          </Text>
          <VStack align="stretch" gap={2}>
            {profile.client.properties.map((p) => {
              const addr = [p.street1, p.city, p.state].filter(Boolean).join(", ");
              return (
                <Card.Root key={p.id} variant="outline">
                  <Card.Body py="3" px="4">
                    <HStack justify="space-between" align="start" gap={3}>
                      <VStack align="start" gap={1} flex="1" minW={0}>
                        <Text fontSize="sm" fontWeight="semibold">{p.displayName}</Text>
                        {addr && <Box fontSize="xs"><MapLink address={addr} /></Box>}
                      </VStack>
                      <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">Active</Badge>
                    </HStack>
                  </Card.Body>
                </Card.Root>
              );
            })}
          </VStack>
        </Box>
      )}

      {/* Upcoming / In Progress */}
      {upcoming.length > 0 && (
        <Box mb={5}>
          <Text fontSize="xs" fontWeight="semibold" color="blue.500" mb={2} px={1} textTransform="uppercase" letterSpacing="wide">
            {upcoming.some((j) => j.status === "IN_PROGRESS") ? "Happening Now & Upcoming" : "Upcoming"}
          </Text>
          <VStack align="stretch" gap={2}>
            {upcoming.map((job) => {
              const isActive = job.status === "IN_PROGRESS";
              const addr = [job.property.street1, job.property.city, job.property.state].filter(Boolean).join(", ");
              return (
                <Card.Root key={job.id} variant="outline" borderColor={isActive ? "blue.300" : undefined} bg={isActive ? "blue.50" : undefined}>
                  <Card.Body py="3" px="4">
                    <HStack justify="space-between" align="start">
                      <VStack align="start" gap={1} flex="1" minW={0}>
                        <Text fontSize="sm" fontWeight="medium">{job.property.displayName}</Text>
                        {addr && <Box fontSize="xs"><MapLink address={addr} /></Box>}
                        <HStack gap={2} wrap="wrap">
                          <Badge colorPalette={isActive ? "blue" : "gray"} variant={isActive ? "solid" : "outline"} fontSize="xs" borderRadius="full" px="2">
                            {isActive ? "In Progress" : "Scheduled"}
                          </Badge>
                          {job.jobType && (
                            <Badge colorPalette="gray" variant="subtle" fontSize="xs" borderRadius="full" px="2">
                              {prettyJobType(job.jobType)}
                            </Badge>
                          )}
                          {job.estimatedMinutes && (
                            <Text fontSize="xs" color="fg.muted">~{formatDuration(job.estimatedMinutes)}</Text>
                          )}
                        </HStack>
                        {job.workers.length > 0 && (
                          <Text fontSize="xs" color="fg.muted">Crew: {workerLabel(job.workers)}</Text>
                        )}
                        {job.price != null && (
                          <Text fontSize="xs" color="green.600" fontWeight="medium">${job.price.toFixed(2)}</Text>
                        )}
                      </VStack>
                      <VStack align="end" gap={1} flexShrink={0}>
                        <Text fontSize="xs" color="fg.muted">
                          {job.startAt ? fmtDateWeekday(job.startAt) : ""}
                        </Text>
                      </VStack>
                    </HStack>
                    {(job.photos ?? []).length > 0 && (
                      <HStack gap={2} mt={2} wrap="wrap">
                        {(job.photos ?? []).map((p, idx) => (
                          <LazyPhoto key={p.id} src={p.url} onClick={() => openViewer(job.photos!, idx)} />
                        ))}
                      </HStack>
                    )}
                  </Card.Body>
                </Card.Root>
              );
            })}
          </VStack>
        </Box>
      )}

      {/* Completed — last 30 days */}
      {completed.length > 0 && (
        <Box mb={5}>
          <Text fontSize="xs" fontWeight="semibold" color="green.600" mb={2} px={1} textTransform="uppercase" letterSpacing="wide">
            Completed — Last 30 days
          </Text>
          <VStack align="stretch" gap={2}>
            {completed.map((job) => {
              const addr = [job.property.street1, job.property.city, job.property.state].filter(Boolean).join(", ");
              return (
                <Card.Root key={job.id} variant="outline">
                  <Card.Body py="3" px="4">
                    <HStack justify="space-between" align="start">
                      <VStack align="start" gap={1} flex="1" minW={0}>
                        <Text fontSize="sm" fontWeight="medium">{job.property.displayName}</Text>
                        {addr && <Box fontSize="xs"><MapLink address={addr} /></Box>}
                        <HStack gap={2} wrap="wrap">
                          <Badge colorPalette="green" variant="solid" fontSize="xs" borderRadius="full" px="2">
                            Completed
                          </Badge>
                          {job.paid && (
                            <Badge colorPalette="teal" variant="solid" fontSize="xs" borderRadius="full" px="2">
                              Paid
                            </Badge>
                          )}
                          {job.jobType && (
                            <Badge colorPalette="gray" variant="subtle" fontSize="xs" borderRadius="full" px="2">
                              {prettyJobType(job.jobType)}
                            </Badge>
                          )}
                        </HStack>
                        <HStack gap={3} wrap="wrap" fontSize="xs" color="fg.muted">
                          {job.completedAt && <Text>Completed: {fmtDate(job.completedAt)}</Text>}
                          {job.durationMinutes != null && job.durationMinutes > 0 && <Text>Duration: {formatDuration(job.durationMinutes)}</Text>}
                        </HStack>
                        {job.workers.length > 0 && (
                          <Text fontSize="xs" color="fg.muted">Crew: {workerLabel(job.workers)}</Text>
                        )}
                        {job.payment && (
                          <HStack gap={2} align="center">
                            <Text fontSize="xs" color="green.600" fontWeight="medium">
                              ${job.payment.amountPaid.toFixed(2)} via {job.payment.method.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}
                            </Text>
                            <Button
                              size="xs"
                              variant="outline"
                              colorPalette="teal"
                              px="2"
                              onClick={() => handleDownloadReceipt(job)}
                            >
                              <Download size={12} />
                              Receipt
                            </Button>
                          </HStack>
                        )}
                      </VStack>
                      <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                        {job.startAt ? fmtDate(job.startAt) : ""}
                      </Text>
                    </HStack>

                    {job.photos.length > 0 && (
                      <HStack gap={2} mt={2} wrap="wrap">
                        {job.photos.map((p, idx) => (
                          <LazyPhoto key={p.id} src={p.url} onClick={() => openViewer(job.photos, idx)} />
                        ))}
                      </HStack>
                    )}
                  </Card.Body>
                </Card.Root>
              );
            })}
          </VStack>
        </Box>
      )}

      {completed.length === 0 && upcoming.length === 0 && (
        <Box p={4} bg="gray.50" rounded="lg" textAlign="center">
          <Text fontSize="md" fontWeight="semibold" color="fg.muted">No services scheduled yet</Text>
          <Text fontSize="sm" color="fg.muted" mt={1}>When your lawn care services are scheduled, you'll see them here along with photos and status updates.</Text>
        </Box>
      )}

      {/* Photo viewer */}
      {viewerPhoto && (
        <Box position="fixed" inset="0" zIndex={10000} bg="blackAlpha.800" display="flex" alignItems="center" justifyContent="center" onClick={() => { setViewerPhoto(null); setViewerPhotos([]); }}>
          {viewerIdx > 0 && (
            <Box position="absolute" left="3" top="50%" transform="translateY(-50%)" color="white" fontSize="2xl" cursor="pointer" p={2} onClick={(e) => { e.stopPropagation(); navigateViewer(-1); }} userSelect="none">◀</Box>
          )}
          <img src={viewerPhoto} alt="Photo" style={{ maxWidth: "90vw", maxHeight: "85vh", objectFit: "contain", borderRadius: "8px" }} onClick={(e) => e.stopPropagation()} />
          {viewerIdx < viewerPhotos.length - 1 && (
            <Box position="absolute" right="3" top="50%" transform="translateY(-50%)" color="white" fontSize="2xl" cursor="pointer" p={2} onClick={(e) => { e.stopPropagation(); navigateViewer(1); }} userSelect="none">▶</Box>
          )}
          <Text position="absolute" bottom="4" color="whiteAlpha.700" fontSize="sm">{viewerIdx + 1} / {viewerPhotos.length}</Text>
        </Box>
      )}
    </Box>
  );
}
