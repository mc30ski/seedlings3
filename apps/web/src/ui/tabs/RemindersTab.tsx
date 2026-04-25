"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Check, CheckCircle2, Circle, Copy, Mail, MessageCircle, Navigation } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { type Me, type WorkerOccurrence } from "@/src/lib/types";
import { bizDateKey, clientLabel } from "@/src/lib/lib";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";

type Props = {
  myId?: string;
  me?: Me | null;
  showAll?: boolean;
  forAdmin?: boolean;
};

function tomorrowDate(): { key: string; label: string } {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const key = bizDateKey(d);
  const label = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  return { key, label };
}

function contactName(occ: WorkerOccurrence): string {
  const poc = occ.job?.property?.pointOfContact
    ?? occ.linkedOccurrence?.job?.property?.pointOfContact;
  if (poc?.firstName) return poc.firstName;
  const clientDisplay = occ.job?.property?.client?.displayName
    ?? occ.linkedOccurrence?.job?.property?.client?.displayName;
  if (clientDisplay) return `${clientDisplay}`;
  return "there";
}

function getContactInfo(occ: WorkerOccurrence): { phone?: string; email?: string } | null {
  const poc = occ.job?.property?.pointOfContact
    ?? occ.linkedOccurrence?.job?.property?.pointOfContact;
  if (!poc) return null;
  return { phone: poc.phone ?? undefined, email: poc.email ?? undefined };
}

function confirmMessage(occ: WorkerOccurrence): string {
  const name = contactName(occ);
  const address = occ.job?.property?.street1 ?? occ.job?.property?.displayName ?? "";
  return `Hi ${name}, this is Seedlings Lawn Care. Just confirming we're scheduled for service tomorrow at ${address}. Please let us know if anything has changed. Thank you!`;
}

function assigneeSummary(assignees: WorkerOccurrence["assignees"]): string {
  if (!assignees || assignees.length === 0) return "Unassigned";
  const sorted = [...assignees].sort((a, b) => {
    const aIsClaimer = a.assignedById === a.userId && a.role !== "observer" ? 0 : a.role === "observer" ? 2 : 1;
    const bIsClaimer = b.assignedById === b.userId && b.role !== "observer" ? 0 : b.role === "observer" ? 2 : 1;
    return aIsClaimer - bIsClaimer;
  });
  return sorted.map((a) => a.user?.displayName ?? a.user?.email ?? "").filter(Boolean).join(", ");
}

/** Does this occurrence need client confirmation? */
function needsConfirm(occ: WorkerOccurrence): boolean {
  if (!occ.jobId) return false;
  if ((occ as any).isClientConfirmed) return false;
  if (occ.status !== "SCHEDULED") return false;
  const w = occ.workflow;
  return w === "STANDARD" || w === "ONE_OFF" || w === "ESTIMATE" || !w;
}

export default function RemindersTab({ myId, me, showAll, forAdmin }: Props) {
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [routeViewed, setRouteViewed] = useState(false);

  async function loadItems() {
    try {
      const list = await apiGet<WorkerOccurrence[]>("/api/occurrences");
      setItems(Array.isArray(list) ? list : []);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    void loadItems();
  }, []);

  // Listen for jobs-changed events to refresh
  useEffect(() => {
    const handler = () => void loadItems();
    window.addEventListener("seedlings3:jobs-changed", handler);
    return () => window.removeEventListener("seedlings3:jobs-changed", handler);
  }, []);

  const { key: tomorrowKey, label: tomorrowLabel } = useMemo(() => tomorrowDate(), []);

  // Filter to tomorrow's items assigned to me
  const tomorrowItems = useMemo(() => {
    let rows = items.filter((occ) => !occ._isReminderGhost && !occ._isPinnedGhost);

    // Filter to my assignments (or all if showAll)
    if (!showAll && myId) {
      rows = rows.filter((occ) => (occ.assignees ?? []).some((a) => a.userId === myId));
    } else if (showAll) {
      rows = rows.filter((occ) => (occ.assignees ?? []).length > 0);
    }

    // Tomorrow + SCHEDULED/ACCEPTED only
    rows = rows.filter((occ) => {
      if (!occ.startAt) return false;
      if (bizDateKey(occ.startAt) !== tomorrowKey) return false;
      return occ.status === "SCHEDULED" || occ.status === "ACCEPTED";
    });

    // Exclude announcements
    rows = rows.filter((occ) => occ.workflow !== "ANNOUNCEMENT");

    return rows;
  }, [items, myId, showAll, tomorrowKey]);

  // Group by type
  const jobs = tomorrowItems.filter((occ) => occ.workflow === "STANDARD" || occ.workflow === "ONE_OFF" || !occ.workflow);
  const estimates = tomorrowItems.filter((occ) => occ.workflow === "ESTIMATE" || occ.isEstimate);
  const events = tomorrowItems.filter((occ) => occ.workflow === "EVENT");

  const hasItems = jobs.length > 0 || estimates.length > 0 || events.length > 0;

  // Progress tracking
  const totalItems = jobs.length + estimates.length + events.length + (hasItems ? 1 : 0); // +1 for route
  const checkedJobs = jobs.filter((occ) => !needsConfirm(occ)).length;
  const checkedEstimates = estimates.filter((occ) => !needsConfirm(occ)).length;
  const checkedEvents = events.length; // always checked
  const checkedRoute = routeViewed ? 1 : 0;
  const checkedCount = checkedJobs + checkedEstimates + checkedEvents + (hasItems ? checkedRoute : 0);
  const allDone = hasItems && checkedCount === totalItems;

  async function handleConfirm(occ: WorkerOccurrence) {
    setBusyId(occ.id);
    try {
      await apiPost(`/api/occurrences/${occ.id}/confirm`);
      setItems((prev) => prev.map((o) => o.id === occ.id ? { ...o, isClientConfirmed: true } as any : o));
      publishInlineMessage({ type: "SUCCESS", text: "Client confirmed." });
      window.dispatchEvent(new CustomEvent("seedlings3:planning-changed"));
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: err?.message ?? "Failed to confirm." });
    }
    setBusyId(null);
  }

  function goToRoutes() {
    setRouteViewed(true);
    // Set the routes tab date to tomorrow before navigating
    try { localStorage.setItem("seedlings_preview_targetDate", JSON.stringify(tomorrowKey)); } catch {}
    window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "routes" } }));
  }

  if (loading) {
    return (
      <Box py={10} textAlign="center">
        <Spinner size="lg" />
      </Box>
    );
  }

  return (
    <Box w="full" pb={8}>
      {/* Header */}
      <Box mb={4}>
        <Text fontSize="lg" fontWeight="bold" color="fg.default">
          Tomorrow's Plan
        </Text>
        <Text fontSize="sm" color="fg.muted">
          {tomorrowLabel}
        </Text>
        {hasItems && (
          <Text fontSize="xs" color={allDone ? "green.600" : "fg.muted"} mt={1} fontWeight={allDone ? "semibold" : "normal"}>
            {allDone ? "All set for tomorrow!" : `${checkedCount} of ${totalItems} ready`}
          </Text>
        )}
      </Box>

      {/* All set banner */}
      {allDone && (
        <Box p={4} bg="green.50" borderWidth="1px" borderColor="green.300" borderRadius="md" mb={4} textAlign="center">
          <CheckCircle2 size={32} color="var(--chakra-colors-green-500)" style={{ margin: "0 auto 8px" }} />
          <Text fontSize="md" fontWeight="semibold" color="green.700">You're all set for tomorrow!</Text>
          <Text fontSize="sm" color="green.600" mt={1}>All clients confirmed and route planned.</Text>
        </Box>
      )}

      {/* No items */}
      {!hasItems && (
        <Box p={6} bg="gray.50" borderWidth="1px" borderColor="gray.200" borderRadius="md" textAlign="center">
          <Text fontSize="md" fontWeight="semibold" color="fg.muted">All clear for tomorrow</Text>
          <Text fontSize="sm" color="fg.muted" mt={1}>No jobs, estimates, or events scheduled.</Text>
        </Box>
      )}

      {/* Jobs section */}
      {jobs.length > 0 && (
        <Box mb={4}>
          <Text fontSize="xs" fontWeight="semibold" color="blue.600" mb={2} textTransform="uppercase" letterSpacing="wide">
            Jobs ({jobs.length})
          </Text>
          <VStack align="stretch" gap={1}>
            {jobs.map((occ) => (
              <ChecklistItem key={occ.id} occ={occ} forAdmin={forAdmin} onConfirm={handleConfirm} busy={busyId === occ.id} />
            ))}
          </VStack>
        </Box>
      )}

      {/* Estimates section */}
      {estimates.length > 0 && (
        <Box mb={4}>
          <Text fontSize="xs" fontWeight="semibold" color="pink.600" mb={2} textTransform="uppercase" letterSpacing="wide">
            Estimates ({estimates.length})
          </Text>
          <VStack align="stretch" gap={1}>
            {estimates.map((occ) => (
              <ChecklistItem key={occ.id} occ={occ} forAdmin={forAdmin} onConfirm={handleConfirm} busy={busyId === occ.id} />
            ))}
          </VStack>
        </Box>
      )}

      {/* Events section */}
      {events.length > 0 && (
        <Box mb={4}>
          <Text fontSize="xs" fontWeight="semibold" color="yellow.700" mb={2} textTransform="uppercase" letterSpacing="wide">
            Events ({events.length})
          </Text>
          <VStack align="stretch" gap={1}>
            {events.map((occ) => (
              <HStack
                key={occ.id}
                gap={2}
                px={3}
                py={2}
                bg="green.50"
                borderWidth="1px"
                borderColor="green.200"
                borderRadius="md"
                align="center"
              >
                <CheckCircle2 size={16} color="var(--chakra-colors-green-500)" />
                <VStack align="start" gap={0} flex="1" minW={0}>
                  <Text fontSize="sm" fontWeight="medium">{occ.title || "Event"}</Text>
                </VStack>
              </HStack>
            ))}
          </VStack>
        </Box>
      )}

      {/* Route section */}
      {hasItems && (
        <Box mb={4}>
          <Text fontSize="xs" fontWeight="semibold" color="cyan.700" mb={2} textTransform="uppercase" letterSpacing="wide">
            Route
          </Text>
          <HStack
            gap={2}
            px={3}
            py={2}
            bg={routeViewed ? "green.50" : "gray.50"}
            borderWidth="1px"
            borderColor={routeViewed ? "green.200" : "gray.200"}
            borderRadius="md"
            align="center"
          >
            {routeViewed ? (
              <CheckCircle2 size={16} color="var(--chakra-colors-green-500)" />
            ) : (
              <Circle size={16} color="var(--chakra-colors-gray-400)" />
            )}
            <Text fontSize="sm" fontWeight="medium" flex="1">Plan tomorrow's route</Text>
            {!forAdmin && (
              <Button
                size="xs"
                variant={routeViewed ? "ghost" : "solid"}
                colorPalette="cyan"
                onClick={goToRoutes}
              >
                <Navigation size={12} /> {routeViewed ? "View Again" : "Plan Route"}
              </Button>
            )}
          </HStack>
        </Box>
      )}
    </Box>
  );
}

function ChecklistItem({
  occ,
  forAdmin,
  onConfirm,
  busy,
}: {
  occ: WorkerOccurrence;
  forAdmin?: boolean;
  onConfirm: (occ: WorkerOccurrence) => void;
  busy?: boolean;
}) {
  const confirmed = !needsConfirm(occ);
  const contact = getContactInfo(occ);
  const msg = confirmMessage(occ);
  const propertyName = occ.job?.property?.displayName ?? occ.title ?? "Job";
  const clientName = occ.job?.property?.client?.displayName;
  const team = assigneeSummary(occ.assignees);

  return (
    <HStack
      gap={2}
      px={3}
      py={2}
      bg={confirmed ? "green.50" : "orange.50"}
      borderWidth="1px"
      borderColor={confirmed ? "green.200" : "orange.300"}
      borderRadius="md"
      align="start"
    >
      {/* Check icon */}
      <Box mt="2px" flexShrink={0}>
        {confirmed ? (
          <CheckCircle2 size={16} color="var(--chakra-colors-green-500)" />
        ) : (
          <Circle size={16} color="var(--chakra-colors-orange-400)" />
        )}
      </Box>

      {/* Content */}
      <VStack align="start" gap={0.5} flex="1" minW={0}>
        <Text fontSize="sm" fontWeight="medium">
          {propertyName}
          {clientName && <Text as="span" color="fg.muted" fontWeight="normal"> — {clientLabel(clientName)}</Text>}
        </Text>
        <Text fontSize="xs" color="fg.muted">{team}</Text>
        {confirmed ? (
          <Badge size="xs" colorPalette="green" variant="subtle">Confirmed</Badge>
        ) : (
          <Badge size="xs" colorPalette="orange" variant="solid">Needs confirmation</Badge>
        )}
      </VStack>

      {/* Actions */}
      {!confirmed && !forAdmin && (
        <VStack gap={1} flexShrink={0} align="end">
          <Button
            size="xs"
            variant="solid"
            colorPalette="orange"
            loading={busy}
            onClick={() => onConfirm(occ)}
          >
            <Check size={12} /> Confirm
          </Button>
          <HStack gap={1}>
            <Button
              size="xs"
              variant="ghost"
              px="1"
              minW="0"
              title="Copy message"
              onClick={() => { navigator.clipboard.writeText(msg); publishInlineMessage({ type: "SUCCESS", text: "Message copied." }); }}
            >
              <Copy size={12} />
            </Button>
            {contact?.phone ? (
              <Button
                size="xs"
                variant="outline"
                colorPalette="green"
                onClick={() => window.open(`sms:${contact.phone}?body=${encodeURIComponent(msg)}`, "_self")}
                title={`Text ${contact.phone}`}
              >
                <MessageCircle size={12} /> Message
              </Button>
            ) : contact?.email ? (
              <Button
                size="xs"
                variant="outline"
                colorPalette="blue"
                onClick={() => window.open(`mailto:${contact.email}?subject=${encodeURIComponent("Seedlings Lawn Care — Service Confirmation")}&body=${encodeURIComponent(msg)}`, "_self")}
                title={`Email ${contact.email}`}
              >
                <Mail size={12} /> Message
              </Button>
            ) : null}
          </HStack>
        </VStack>
      )}
    </HStack>
  );
}
