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
import { Calendar, CheckCircle2, Download, Eye, SkipForward, X } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/src/lib/api";
import { fmtDate, fmtDateWeekday } from "@/src/lib/lib";
import { MapLink } from "@/src/ui/helpers/Link";
import { type ReceiptData, downloadReceipt, getReceiptBlob } from "@/src/lib/receipt";
import { useBranding } from "@/src/lib/useBranding";
import SafePhoto from "@/src/ui/components/SafePhoto";
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
  paymentPending?: boolean;
  payment?: {
    amountPaid: number;
    method: string;
    methodLabel?: string;
    paidAt: string;
    confirmed?: boolean;
    selfReported?: boolean;
  } | null;
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
  isOneOff?: boolean | null;
  frequencyDays?: number | null;
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

type LinkResponse =
  | { linked: true; contactId: string }
  | { linked: false; reason: "no_email" | "no_match" }
  | {
      linked: false;
      reason: "candidate";
      candidate: {
        clientId: string;
        displayName: string;
        contacts: Array<{ contactId: string; contactName: string; isPrimary: boolean }>;
      };
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

/**
 * Cadence label for the recurring/one-off chip on an upcoming job card.
 * Returns null when the job is neither recurring nor flagged one-off
 * (e.g. estimates, or scheduled visits with no cadence set yet).
 */
function cadenceLabel(job: { isOneOff?: boolean | null; frequencyDays?: number | null; workflow?: string | null }): string | null {
  if (job.workflow === "ESTIMATE") return null;
  if (job.isOneOff) return "One-time";
  const f = job.frequencyDays ?? null;
  if (!f || f <= 0) return null;
  if (f === 7) return "Weekly";
  if (f === 14) return "Every 2 weeks";
  if (f === 21) return "Every 3 weeks";
  if (f === 28) return "Every 4 weeks";
  if (f === 30) return "Monthly";
  return `Every ${f} days`;
}

export default function ClientMyJobsTab() {
  const { businessName } = useBranding();
  const [profile, setProfile] = useState<ClientProfile | null>(null);
  const [completed, setCompleted] = useState<CompletedJob[]>([]);
  // Month-by-month pagination for completed history. Default window
  // shows just the current calendar month; "Show more" expands one
  // month at a time up to a year. Server enforces the same ceilings.
  const [completedMonthsBack, setCompletedMonthsBack] = useState(1);
  const [completedHasMore, setCompletedHasMore] = useState(false);
  const [completedMaxMonths, setCompletedMaxMonths] = useState(12);
  const [completedLoadingMore, setCompletedLoadingMore] = useState(false);
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

  // Smart-hint candidate proposed by /client/link when the email-match
  // auto-link fails but someone recently signed up via this client's pay link.
  const [linkCandidate, setLinkCandidate] = useState<
    {
      clientId: string;
      displayName: string;
      contacts: Array<{ contactId: string; contactName: string; isPrimary: boolean }>;
    } | null
  >(null);
  const [confirmingCandidate, setConfirmingCandidate] = useState(false);

  async function load() {
    try {
      const res = await apiPost<LinkResponse>("/api/client/link");
      if (!res.linked && res.reason === "candidate") {
        setLinkCandidate(res.candidate);
      } else {
        setLinkCandidate(null);
      }
    } catch {}
    try {
      const me = await apiGet<ClientProfile>("/api/client/me");
      setProfile(me);
      if (me.linked) {
        const [jobsRes, upcomingRes] = await Promise.all([
          apiGet<{ items: CompletedJob[]; monthsBack?: number; maxMonthsBack?: number; hasMore?: boolean }>(
            `/api/client/jobs?monthsBack=${completedMonthsBack}`,
          ),
          apiGet<{ items: UpcomingJob[] }>("/api/client/upcoming"),
        ]);
        setCompleted(jobsRes.items);
        setCompletedHasMore(!!jobsRes.hasMore);
        if (typeof jobsRes.maxMonthsBack === "number") setCompletedMaxMonths(jobsRes.maxMonthsBack);
        setUpcoming(upcomingRes.items);
      }
    } catch (err) {
      console.error("Client load failed:", err);
      setProfile({ linked: false });
    }
    setLoading(false);
  }

  // Expand the history window by one calendar month and re-fetch. Server
  // returns everything from the new window in one shot (cheap — capped at
  // 100 rows), so we replace the list rather than concatenating.
  async function loadMoreHistory() {
    if (!completedHasMore || completedLoadingMore) return;
    const next = Math.min(completedMaxMonths, completedMonthsBack + 1);
    setCompletedLoadingMore(true);
    try {
      const jobsRes = await apiGet<{ items: CompletedJob[]; hasMore?: boolean }>(
        `/api/client/jobs?monthsBack=${next}`,
      );
      setCompleted(jobsRes.items);
      setCompletedMonthsBack(next);
      setCompletedHasMore(!!jobsRes.hasMore);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load older history.", err) });
    } finally {
      setCompletedLoadingMore(false);
    }
  }

  async function confirmCandidate(contactId?: string) {
    if (!linkCandidate) return;
    setConfirmingCandidate(true);
    try {
      await apiPost("/api/client/link/confirm-candidate", {
        clientId: linkCandidate.clientId,
        ...(contactId ? { contactId } : {}),
      });
      publishInlineMessage({ type: "SUCCESS", text: "Account linked." });
      setLinkCandidate(null);
      setLoading(true);
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't confirm — please ask an admin to link you.", err) });
    } finally {
      setConfirmingCandidate(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openAction(type: "reschedule" | "skip" | "accept" | "decline", job: UpcomingJob) {
    setActionDialog({ type, job } as any);
    setActionComment("");
    if (type === "reschedule") {
      // Default the suggested date to 3 days from now. This is just a
      // hint to the admin — the actual rescheduling happens after a
      // real conversation between admin and client.
      const base = new Date();
      base.setDate(base.getDate() + 3);
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
        // Suggested date is optional but defaults to 3 days from now.
        // Admin gets it as context for the conversation — not an
        // auto-applied command. The actual reschedule happens through
        // the admin's regular occurrence editor after they confirm
        // with the client.
        await apiPost(`/api/client/occurrences/${job.id}/reschedule-request`, {
          comment: actionComment.trim() || undefined,
          proposedStartAt: proposedDate ? new Date(proposedDate).toISOString() : undefined,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Request sent — we'll reach out shortly." });
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

  /** Build the ReceiptData payload from a CompletedJob. Shared between
   *  the View (inline) and Download (save) paths so the two surfaces
   *  always render the exact same receipt. */
  function buildReceiptData(job: CompletedJob): ReceiptData | null {
    if (!job.payment || !profile?.client) return null;
    const addr = [job.property.street1, job.property.city, job.property.state].filter(Boolean).join(", ");
    return {
      businessName,
      clientName: profile.client.displayName,
      propertyAddress: addr,
      jobType: prettyJobType(job.jobType) || prettyJobType(job.kind) || "Lawn Care",
      serviceDate: job.startAt ? fmtDate(job.startAt) : "—",
      completedDate: job.completedAt ? fmtDate(job.completedAt) : "—",
      amount: job.payment.amountPaid,
      // Server pre-resolves the method label from PAYMENT_METHODS so the
      // receipt PDF doesn't need its own taxonomy. Fall back to the raw
      // key on the rare chance the server skipped it.
      methodLabel: job.payment.methodLabel ?? job.payment.method,
      workers: job.workers,
      receiptId: job.id.slice(-8).toUpperCase(),
    };
  }

  function handleDownloadReceipt(job: CompletedJob) {
    const data = buildReceiptData(job);
    if (!data) return;
    downloadReceipt(data);
    publishInlineMessage({ type: "SUCCESS", text: "Receipt downloaded." });
  }

  /** Open the receipt PDF inline in a new browser tab. Uses a blob URL
   *  so no file lands on disk. The URL is revoked after a short delay
   *  to free memory without canceling the load if the browser is slow
   *  to render. Falls back to download if the popup is blocked (some
   *  mobile browsers block window.open inside a tap handler if the
   *  blob isn't created synchronously enough — getReceiptBlob is sync
   *  so this should be rare). */
  function handleViewReceipt(job: CompletedJob) {
    const data = buildReceiptData(job);
    if (!data) return;
    try {
      const blob = getReceiptBlob(data);
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (!win) {
        // Popup blocked — fall back to download so the user still gets
        // the receipt somehow.
        downloadReceipt(data);
        publishInlineMessage({
          type: "INFO",
          text: "Your browser blocked the inline view, so we downloaded it instead.",
        });
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: "Couldn't open the receipt. Try downloading it instead." });
    }
  }

  if (loading) return <Box py={10} textAlign="center"><Spinner size="lg" /></Box>;

  if (!profile?.linked) {
    return (
      <Box w="full" pb={8}>
        {linkCandidate ? (
          // Smart-hint: the server thinks this Clerk user is the same person
          // who recently tapped "Access your account" on this client's pay
          // link, but signed up with a different email. Ask the client to
          // confirm before linking. When the household has 2+ stamped
          // contacts we ask "which of you are you?" so we link to the right
          // person, not blindly to the primary.
          <Box p={5} bg="teal.50" borderWidth="1px" borderColor="teal.300" rounded="lg" mb={3}>
            <VStack gap={3} align="start">
              <Text fontSize="xl" fontWeight="bold" color="teal.800">Welcome back!</Text>
              {linkCandidate.contacts.length > 1 ? (
                <>
                  <Text fontSize="sm" color="teal.700">
                    We think you're with <Text as="span" fontWeight="semibold">{linkCandidate.displayName}</Text>. Which of you are you?
                  </Text>
                  <HStack gap={2} wrap="wrap">
                    {linkCandidate.contacts.map((c) => (
                      <Button
                        key={c.contactId}
                        size="sm"
                        colorPalette="teal"
                        variant={c.isPrimary ? "solid" : "outline"}
                        disabled={confirmingCandidate}
                        loading={confirmingCandidate}
                        onClick={() => void confirmCandidate(c.contactId)}
                      >
                        {c.contactName || "Unnamed contact"}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={confirmingCandidate}
                      onClick={() => setLinkCandidate(null)}
                    >
                      None of these
                    </Button>
                  </HStack>
                </>
              ) : (
                <>
                  <Text fontSize="sm" color="teal.700">
                    We think you're connected to <Text as="span" fontWeight="semibold">{linkCandidate.displayName}</Text>
                    {linkCandidate.contacts[0]?.contactName
                      ? <> (as <Text as="span" fontWeight="semibold">{linkCandidate.contacts[0].contactName}</Text>)</>
                      : null}.
                  </Text>
                  <Text fontSize="sm" color="teal.700">
                    If that's right, confirm and we'll connect your account to your service history.
                  </Text>
                  <HStack gap={2}>
                    <Button
                      size="sm"
                      colorPalette="teal"
                      loading={confirmingCandidate}
                      onClick={() => void confirmCandidate(linkCandidate.contacts[0]?.contactId)}
                    >
                      Yes, that's me
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={confirmingCandidate}
                      onClick={() => setLinkCandidate(null)}
                    >
                      Not me
                    </Button>
                  </HStack>
                </>
              )}
            </VStack>
          </Box>
        ) : null}
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
                          {(() => {
                            const lbl = cadenceLabel(job);
                            if (!lbl) return null;
                            const isOneTime = job.isOneOff;
                            return (
                              <Badge
                                colorPalette={isOneTime ? "gray" : "blue"}
                                variant="subtle"
                                fontSize="xs"
                                borderRadius="full"
                                px="2"
                              >
                                {lbl}
                              </Badge>
                            );
                          })()}
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
                              <Text fontSize="2xs" color="orange.700">
                                Suggested: {fmtDateWeekday(job.pendingChangeRequest.proposedStartAt)}
                              </Text>
                            )}
                            <Text fontSize="2xs" color="orange.600">
                              {job.pendingChangeRequest.kind === "RESCHEDULE"
                                ? "We'll reach out shortly to confirm a time."
                                : "Awaiting admin approval."}
                            </Text>
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
                          <SafePhoto key={p.id} src={p.url} onClick={() => openViewer(job.photos!, idx)} />
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

      {/* Completed service history — windowed by month, with "Show more"
       *  to expand up to a full year. */}
      {completed.length > 0 && (
        <Box mb={5}>
          <Text fontSize="xs" fontWeight="semibold" color="green.600" mb={2} px={1} textTransform="uppercase" letterSpacing="wide">
            Service history — {completedMonthsBack === 1
              ? "this month"
              : `last ${completedMonthsBack} months`}
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
                          {!job.paid && job.paymentPending && (
                            <Badge colorPalette="orange" variant="subtle" fontSize="xs" borderRadius="full" px="2">
                              Payment pending verification
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
                        {job.payment && job.paid && (
                          <HStack gap={2} align="center" wrap="wrap">
                            <Text fontSize="xs" color="green.600" fontWeight="medium">
                              ${job.payment.amountPaid.toFixed(2)} via {job.payment.method.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}
                            </Text>
                            <Button
                              size="xs"
                              variant="outline"
                              colorPalette="teal"
                              px="2"
                              onClick={() => handleViewReceipt(job)}
                              title="View receipt in a new tab"
                            >
                              <Eye size={12} />
                              View
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              colorPalette="teal"
                              px="2"
                              onClick={() => handleDownloadReceipt(job)}
                              title="Download receipt PDF"
                            >
                              <Download size={12} />
                              Download
                            </Button>
                          </HStack>
                        )}
                        {job.payment && !job.paid && job.paymentPending && (
                          <Text fontSize="xs" color="orange.700">
                            We received your note that you sent ${job.payment.amountPaid.toFixed(2)} via {job.payment.method.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}.
                            We&apos;ll confirm once it lands on our end — your receipt will be available here as soon as we do.
                          </Text>
                        )}
                      </VStack>
                      <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                        {job.startAt ? fmtDate(job.startAt) : ""}
                      </Text>
                    </HStack>

                    {job.photos.length > 0 && (
                      <HStack gap={2} mt={2} wrap="wrap">
                        {job.photos.map((p, idx) => (
                          <SafePhoto key={p.id} src={p.url} onClick={() => openViewer(job.photos, idx)} />
                        ))}
                      </HStack>
                    )}
                  </Card.Body>
                </Card.Root>
              );
            })}
          </VStack>
          {completedHasMore ? (
            <HStack justify="center" mt={3}>
              <Button
                size="sm"
                variant="outline"
                colorPalette="green"
                onClick={() => void loadMoreHistory()}
                loading={completedLoadingMore}
              >
                Show more
              </Button>
            </HStack>
          ) : completedMonthsBack >= completedMaxMonths ? (
            <Text fontSize="xs" color="fg.muted" textAlign="center" mt={3}>
              Showing the last year of service. Contact us if you need older records.
            </Text>
          ) : null}
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
          {/* If the photo 404s while the viewer is open (R2 object was
           *  purged), close the viewer instead of leaving a broken-image
           *  icon visible. publishInlineMessage gives the user a hint. */}
          <img
            src={viewerPhoto}
            alt="Photo"
            style={{ maxWidth: "90vw", maxHeight: "85vh", objectFit: "contain", borderRadius: "8px" }}
            onClick={(e) => e.stopPropagation()}
            onError={() => {
              setViewerPhoto(null);
              setViewerPhotos([]);
              publishInlineMessage({ type: "INFO", text: "That photo is no longer available." });
            }}
          />
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
                        <Text fontSize="sm" mb={1}>Suggested new date & time</Text>
                        <Input
                          type="datetime-local"
                          value={proposedDate}
                          onChange={(e) => setProposedDate(e.target.value)}
                        />
                        <Text fontSize="xs" color="fg.muted" mt={1}>
                          This is just a suggestion. We&apos;ll reach out to confirm a time
                          that actually works on our end before anything moves.
                        </Text>
                      </Box>
                      <Box>
                        <Text fontSize="sm" mb={1}>Anything we should know? (optional)</Text>
                        <Textarea
                          value={actionComment}
                          onChange={(e) => setActionComment(e.target.value)}
                          placeholder="e.g., Out of town next week, prefer mornings, etc."
                          rows={3}
                        />
                      </Box>
                      <Text fontSize="xs" color="fg.muted">
                        Your current visit stays scheduled until we confirm a new one.
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
