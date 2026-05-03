"use client";

import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { Calendar, CheckCircle2, Download, SkipForward, X } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/src/lib/api";
import { fmtDate, fmtDateWeekday } from "@/src/lib/lib";
import { MapLink } from "@/src/ui/helpers/Link";
import { type ReceiptData, downloadReceipt } from "@/src/lib/receipt";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";

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
  workflow?: string | null;
  isEstimate?: boolean | null;
  jobType?: string | null;
  price?: number | null;
  proposalAmount?: number | null;
  proposalNotes?: string | null;
  property: { id: string; displayName: string; street1?: string | null; city?: string | null; state?: string | null };
  workers: string[];
  photos?: Photo[];
  pendingChangeRequest?: {
    id: string;
    kind: "RESCHEDULE" | "SKIP";
    status: string;
    proposedStartAt?: string | null;
    comment?: string | null;
    createdAt: string;
  } | null;
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

  // Action dialog state
  const [actionDialog, setActionDialog] = useState<
    | { type: "reschedule"; job: UpcomingJob }
    | { type: "skip"; job: UpcomingJob }
    | { type: "accept"; job: UpcomingJob }
    | { type: "decline"; job: UpcomingJob }
    | null
  >(null);
  const [proposedDate, setProposedDate] = useState("");
  const [actionComment, setActionComment] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

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

  async function reloadUpcoming() {
    try {
      const upcomingRes = await apiGet<{ items: UpcomingJob[] }>("/api/client/upcoming");
      setUpcoming(upcomingRes.items);
    } catch (err) {
      console.error("Reload upcoming failed:", err);
    }
  }

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

  function openAction(type: "reschedule" | "skip" | "accept" | "decline", job: UpcomingJob) {
    setActionDialog({ type, job } as any);
    setActionComment("");
    if (type === "reschedule") {
      // Default proposed date to one week after the current scheduled date.
      const base = job.startAt ? new Date(job.startAt) : new Date();
      base.setDate(base.getDate() + 7);
      const pad = (n: number) => String(n).padStart(2, "0");
      setProposedDate(`${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`);
    } else {
      setProposedDate("");
    }
  }

  async function submitAction() {
    if (!actionDialog) return;
    setActionBusy(true);
    try {
      const { type, job } = actionDialog;
      if (type === "reschedule") {
        if (!proposedDate) {
          publishInlineMessage({ type: "WARNING", text: "Please choose a proposed date." });
          setActionBusy(false);
          return;
        }
        await apiPost(`/api/client/occurrences/${job.id}/reschedule-request`, {
          proposedStartAt: new Date(proposedDate).toISOString(),
          comment: actionComment.trim() || undefined,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Reschedule request sent." });
      } else if (type === "skip") {
        await apiPost(`/api/client/occurrences/${job.id}/skip-request`, {
          comment: actionComment.trim() || undefined,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Skip request sent." });
      } else if (type === "accept") {
        await apiPost(`/api/client/estimates/${job.id}/accept`, {
          comment: actionComment.trim() || undefined,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Estimate accepted." });
      } else if (type === "decline") {
        await apiPost(`/api/client/estimates/${job.id}/decline`, {
          reason: actionComment.trim() || undefined,
        });
        publishInlineMessage({ type: "INFO", text: "Estimate declined." });
      }
      setActionDialog(null);
      await reloadUpcoming();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Action failed.", err) });
    } finally {
      setActionBusy(false);
    }
  }

  async function cancelChangeRequest(job: UpcomingJob) {
    if (!job.pendingChangeRequest) return;
    try {
      await apiDelete(`/api/client/change-requests/${job.pendingChangeRequest.id}`);
      publishInlineMessage({ type: "SUCCESS", text: "Request canceled." });
      await reloadUpcoming();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Cancel failed.", err) });
    }
  }

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
                  <Card.Body py="2" px="3">
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
              const isEstimate = job.workflow === "ESTIMATE" || job.isEstimate;
              const isProposalSubmitted = isEstimate && job.status === "PROPOSAL_SUBMITTED";
              const canRequestChange = !isEstimate && (job.status === "SCHEDULED" || job.status === "ACCEPTED") && !job.pendingChangeRequest;
              const addr = [job.property.street1, job.property.city, job.property.state].filter(Boolean).join(", ");
              return (
                <Card.Root key={job.id} variant="outline" borderColor={isActive ? "blue.300" : isEstimate ? "purple.200" : undefined} bg={isActive ? "blue.50" : isEstimate ? "purple.50" : undefined}>
                  <Card.Body py="2" px="3">
                    <HStack justify="space-between" align="start">
                      <VStack align="start" gap={1} flex="1" minW={0}>
                        <Text fontSize="sm" fontWeight="medium">{job.property.displayName}</Text>
                        {addr && <Box fontSize="xs"><MapLink address={addr} /></Box>}
                        <HStack gap={2} wrap="wrap">
                          <Badge
                            colorPalette={isEstimate ? "purple" : isActive ? "blue" : "gray"}
                            variant={isActive || isEstimate ? "solid" : "outline"}
                            fontSize="xs" borderRadius="full" px="2"
                          >
                            {isEstimate ? (isProposalSubmitted ? "Estimate ready" : "Estimate") : isActive ? "In Progress" : "Scheduled"}
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
                        {(job.proposalAmount != null || job.price != null) && (
                          <Text fontSize="xs" color="green.600" fontWeight="medium">
                            ${(job.proposalAmount ?? job.price ?? 0).toFixed(2)}{isEstimate ? " (proposed)" : ""}
                          </Text>
                        )}
                        {isProposalSubmitted && job.proposalNotes && (
                          <Text fontSize="xs" color="fg.muted" mt={1}>{job.proposalNotes}</Text>
                        )}
                      </VStack>
                      <VStack align="end" gap={1} flexShrink={0}>
                        <Text fontSize="xs" color="fg.muted">
                          {job.startAt ? fmtDateWeekday(job.startAt) : ""}
                        </Text>
                      </VStack>
                    </HStack>

                    {/* Pending change request banner */}
                    {job.pendingChangeRequest && (
                      <Box mt={2} p={2} bg="orange.50" borderWidth="1px" borderColor="orange.200" rounded="md">
                        <HStack justify="space-between" gap={2} wrap="wrap">
                          <Box flex="1" minW={0}>
                            <Text fontSize="xs" fontWeight="semibold" color="orange.800">
                              {job.pendingChangeRequest.kind === "RESCHEDULE" ? "Reschedule requested" : "Skip requested"}
                            </Text>
                            {job.pendingChangeRequest.kind === "RESCHEDULE" && job.pendingChangeRequest.proposedStartAt && (
                              <Text fontSize="xs" color="orange.700">
                                Proposed: {fmtDateWeekday(job.pendingChangeRequest.proposedStartAt)}
                              </Text>
                            )}
                            <Text fontSize="2xs" color="orange.600">Awaiting admin approval</Text>
                          </Box>
                          <Button size="xs" variant="ghost" colorPalette="red" onClick={() => void cancelChangeRequest(job)}>
                            Cancel
                          </Button>
                        </HStack>
                      </Box>
                    )}

                    {/* Quick action buttons */}
                    {canRequestChange && (
                      <HStack gap={1} mt={2}>
                        <Button size="xs" variant="outline" onClick={() => openAction("reschedule", job)}>
                          <Calendar size={12} /> Reschedule
                        </Button>
                        <Button size="xs" variant="outline" onClick={() => openAction("skip", job)}>
                          <SkipForward size={12} /> Skip
                        </Button>
                      </HStack>
                    )}
                    {isProposalSubmitted && (
                      <HStack gap={1} mt={2}>
                        <Button size="xs" colorPalette="green" onClick={() => openAction("accept", job)}>
                          <CheckCircle2 size={12} /> Accept Estimate
                        </Button>
                        <Button size="xs" variant="outline" colorPalette="red" onClick={() => openAction("decline", job)}>
                          <X size={12} /> Decline
                        </Button>
                      </HStack>
                    )}

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
                  <Card.Body py="2" px="3">
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
        <Box position="fixed" inset="0" zIndex={10000} bg="blackAlpha.800" display="flex" alignItems="center" justifyContent="center" onClick={() => { setViewerPhoto(null); setViewerPhotos([]); }} onTouchStart={(e) => { (e.currentTarget as any)._touchX = e.touches[0].clientX; }} onTouchEnd={(e) => { const dx = e.changedTouches[0].clientX - ((e.currentTarget as any)._touchX ?? 0); if (Math.abs(dx) > 50) { e.stopPropagation(); dx < 0 ? navigateViewer(1) : navigateViewer(-1); } }}>
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

      {/* Reschedule / Skip / Accept / Decline dialog */}
      <Dialog.Root open={!!actionDialog} onOpenChange={(e) => { if (!e.open) setActionDialog(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>
                  {actionDialog?.type === "reschedule" && "Request Reschedule"}
                  {actionDialog?.type === "skip" && "Request to Skip"}
                  {actionDialog?.type === "accept" && "Accept Estimate"}
                  {actionDialog?.type === "decline" && "Decline Estimate"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  {actionDialog && (
                    <Box p={2} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                      <Text fontSize="sm" fontWeight="medium">{actionDialog.job.property.displayName}</Text>
                      {actionDialog.job.startAt && (
                        <Text fontSize="xs" color="fg.muted">Currently: {fmtDateWeekday(actionDialog.job.startAt)}</Text>
                      )}
                    </Box>
                  )}

                  {actionDialog?.type === "reschedule" && (
                    <>
                      <Box>
                        <Text fontSize="sm" mb={1}>Preferred new date & time *</Text>
                        <Input
                          type="datetime-local"
                          value={proposedDate}
                          onChange={(e) => setProposedDate(e.target.value)}
                        />
                      </Box>
                      <Box>
                        <Text fontSize="sm" mb={1}>Reason (optional)</Text>
                        <Textarea
                          value={actionComment}
                          onChange={(e) => setActionComment(e.target.value)}
                          placeholder="e.g., Out of town that week"
                          rows={2}
                        />
                      </Box>
                      <Text fontSize="xs" color="fg.muted">
                        Your request will be sent to your service provider for approval. The current date stays scheduled until they confirm.
                      </Text>
                    </>
                  )}

                  {actionDialog?.type === "skip" && (
                    <>
                      <Box>
                        <Text fontSize="sm" mb={1}>Reason (optional)</Text>
                        <Textarea
                          value={actionComment}
                          onChange={(e) => setActionComment(e.target.value)}
                          placeholder="e.g., Lawn doesn't need it this week"
                          rows={2}
                        />
                      </Box>
                      <Text fontSize="xs" color="fg.muted">
                        Skipping cancels just this single visit. Future scheduled visits aren't affected.
                      </Text>
                    </>
                  )}

                  {actionDialog?.type === "accept" && (
                    <>
                      <Box>
                        <Text fontSize="sm" mb={1}>Comment (optional)</Text>
                        <Textarea
                          value={actionComment}
                          onChange={(e) => setActionComment(e.target.value)}
                          placeholder="Any questions or notes?"
                          rows={2}
                        />
                      </Box>
                      {actionDialog.job.proposalAmount != null && (
                        <Box p={2} bg="green.50" rounded="md" borderWidth="1px" borderColor="green.200">
                          <Text fontSize="sm" color="green.800" fontWeight="semibold">
                            Estimate: ${actionDialog.job.proposalAmount.toFixed(2)}
                          </Text>
                        </Box>
                      )}
                    </>
                  )}

                  {actionDialog?.type === "decline" && (
                    <Box>
                      <Text fontSize="sm" mb={1}>Reason (optional)</Text>
                      <Textarea
                        value={actionComment}
                        onChange={(e) => setActionComment(e.target.value)}
                        placeholder="Help us understand"
                        rows={2}
                      />
                    </Box>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setActionDialog(null)} disabled={actionBusy}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette={actionDialog?.type === "decline" ? "red" : actionDialog?.type === "accept" ? "green" : "blue"}
                    onClick={() => void submitAction()}
                    loading={actionBusy}
                    disabled={actionDialog?.type === "reschedule" && !proposedDate}
                  >
                    {actionDialog?.type === "reschedule" && "Send Request"}
                    {actionDialog?.type === "skip" && "Send Skip Request"}
                    {actionDialog?.type === "accept" && "Accept"}
                    {actionDialog?.type === "decline" && "Decline"}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}
