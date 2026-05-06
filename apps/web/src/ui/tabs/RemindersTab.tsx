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
import { Bell, Check, CheckCircle2, Circle, Copy, ListChecks, Mail, MessageCircle, Megaphone, Navigation, Play, Repeat } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { openEventSearch } from "@/src/lib/bus";
import { type Me, type WorkerOccurrence } from "@/src/lib/types";
import { bizDateKey, clientLabel } from "@/src/lib/lib";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";
import TomorrowWeatherWarning from "@/src/ui/components/TomorrowWeatherWarning";

type Props = {
  myId?: string;
  me?: Me | null;
  showAll?: boolean;
  forAdmin?: boolean;
  // Admin team-overview mode. Renders a single combined list sorted by start time
  // (instead of the per-worker Jobs/Estimates/Events sections). When `visibleUserIds`
  // is non-empty, the list is further filtered to those assignees; otherwise all
  // assigned tomorrow occurrences are shown. The per-worker view (no `teamView`)
  // is unchanged.
  teamView?: boolean;
  visibleUserIds?: string[];
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

/** Switch to the Jobs tab (admin or worker) and highlight a specific occurrence.
 *  Used by every "View →" link in the Planning tab.
 *
 *  Polls for `window.__jobsTabReady` before dispatching `jobsTab:highlightOcc`
 *  so the highlight fires only once JobsTab's listener is registered. A fixed
 *  setTimeout would race the destination tab's mount on slower devices. */
function viewOnJobs(occId: string, forAdmin?: boolean) {
  const eventName = forAdmin ? "navigate:adminTab" : "navigate:workerTab";
  const tab = forAdmin ? "admin-jobs" : "jobs";
  window.dispatchEvent(new CustomEvent(eventName, { detail: { tab } }));
  let attempts = 0;
  const maxAttempts = 30; // 30 × 100ms = 3 seconds max
  const interval = setInterval(() => {
    attempts++;
    if ((window as any).__jobsTabReady || attempts >= maxAttempts) {
      clearInterval(interval);
      window.dispatchEvent(new CustomEvent("jobsTab:highlightOcc", { detail: { occId } }));
    }
  }, 100);
}

/** Does this occurrence need client confirmation? */
function needsConfirm(occ: WorkerOccurrence): boolean {
  if (!occ.jobId) return false;
  if ((occ as any).isClientConfirmed) return false;
  if (occ.status !== "SCHEDULED") return false;
  const w = occ.workflow;
  return w === "STANDARD" || w === "ONE_OFF" || w === "ESTIMATE" || !w;
}

export default function RemindersTab({ myId, me, showAll, forAdmin, teamView, visibleUserIds }: Props) {
  const [items, setItems] = useState<WorkerOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [routeViewed, setRouteViewed] = useState(false);
  const [workflowLaunched, setWorkflowLaunched] = useState(false);

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

    // Filter to my assignments (or all if showAll). ANNOUNCEMENTs bypass the
    // assignee check — they're company-wide and visible to everyone.
    if (!showAll && myId) {
      rows = rows.filter((occ) =>
        occ.workflow === "ANNOUNCEMENT" ||
        (occ.assignees ?? []).some((a) => a.userId === myId)
      );
    } else if (showAll) {
      rows = rows.filter((occ) =>
        occ.workflow === "ANNOUNCEMENT" ||
        (occ.assignees ?? []).length > 0
      );
    }

    // Team-view: optional restriction to a specific subset of workers (multi-select).
    // Empty/absent visibleUserIds means "no restriction" (all workers). Announcements
    // bypass this too since they aren't worker-scoped.
    if (teamView && visibleUserIds && visibleUserIds.length > 0) {
      const ids = new Set(visibleUserIds);
      rows = rows.filter((occ) =>
        occ.workflow === "ANNOUNCEMENT" ||
        (occ.assignees ?? []).some((a) => ids.has(a.userId))
      );
    }

    // Tomorrow + SCHEDULED/ACCEPTED only
    rows = rows.filter((occ) => {
      if (!occ.startAt) return false;
      if (bizDateKey(occ.startAt) !== tomorrowKey) return false;
      return occ.status === "SCHEDULED" || occ.status === "ACCEPTED";
    });

    return rows;
  }, [items, myId, showAll, tomorrowKey, teamView, visibleUserIds]);

  // Group by type (per-worker view)
  const jobs = tomorrowItems.filter((occ) => occ.workflow === "STANDARD" || occ.workflow === "ONE_OFF" || !occ.workflow);
  const estimates = tomorrowItems.filter((occ) => occ.workflow === "ESTIMATE" || occ.isEstimate);
  const events = tomorrowItems.filter((occ) => occ.workflow === "EVENT");
  // "Other" bundle — non-actionable types (Tasks, Reminders, Follow-ups, Announcements).
  // No confirmation step; the cards render with a "View →" link to the Jobs tab.
  const others = tomorrowItems.filter((occ) =>
    occ.workflow === "TASK" ||
    occ.workflow === "REMINDER" ||
    occ.workflow === "FOLLOWUP" ||
    occ.workflow === "ANNOUNCEMENT"
  );

  // Sort helper: items with startAt first (earliest first), then no-startAt at the bottom.
  function sortByStart<T extends { startAt?: string | null }>(arr: T[]): T[] {
    return [...arr].sort((a, b) => {
      const aHas = !!a.startAt;
      const bHas = !!b.startAt;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (!aHas) return 0;
      return new Date(a.startAt as any).getTime() - new Date(b.startAt as any).getTime();
    });
  }

  // Team view also uses the same sectioned structure; sorting within each section
  // makes the order predictable when items are spread across the day. The earlier
  // single-combined-list approach was too cluttered once Tasks/Reminders/etc. were
  // added — sectioning keeps similar item types grouped while preserving time order.
  const sortedJobs = useMemo(() => sortByStart(jobs), [jobs]);
  const sortedEstimates = useMemo(() => sortByStart(estimates), [estimates]);
  const sortedEvents = useMemo(() => sortByStart(events), [events]);
  const sortedOthers = useMemo(() => sortByStart(others), [others]);

  const hasItems = jobs.length > 0 || estimates.length > 0 || events.length > 0 || others.length > 0;

  // Progress tracking. Only items with an actual action button count toward
  // "X of Y ready":
  //   - Jobs / Estimates: have a Confirm button
  //   - Route: has a Plan Route button (per-worker only)
  //   - Workflow: has a Start Workflow button (per-worker only)
  // Events and the Other section (Tasks/Reminders/Follow-ups/Announcements) only
  // have a "View →" link, which is navigation rather than action — so they
  // intentionally do NOT count.
  const checkedJobs = jobs.filter((occ) => !needsConfirm(occ)).length;
  const checkedEstimates = estimates.filter((occ) => !needsConfirm(occ)).length;
  const checkedRoute = routeViewed ? 1 : 0;
  const checkedWorkflow = workflowLaunched ? 1 : 0;
  const totalItems = teamView
    ? jobs.length + estimates.length
    : jobs.length + estimates.length + (hasItems ? 2 : 0); // +1 route, +1 workflow
  const checkedCount = teamView
    ? checkedJobs + checkedEstimates
    : checkedJobs + checkedEstimates + (hasItems ? checkedRoute + checkedWorkflow : 0);
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

  function launchPlanWorkdayWorkflow() {
    setWorkflowLaunched(true);
    // Trainees get the read-only variant of the workflow.
    const isTrainee = me?.workerType === "TRAINEE";
    const workflow = isTrainee ? "plan-workday-trainee" : "plan-workday";
    // pages/index.tsx listens for this and calls setActiveWorkflow(workflow).
    window.dispatchEvent(new CustomEvent("launch:workflow", { detail: { workflow } }));
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
        {/* Global completion banner — stays in the header. The per-section progress
            ("X of Y confirmed") lives under each section header where the action
            buttons actually are. */}
        {hasItems && allDone && (
          <Text fontSize="xs" color="green.600" mt={1} fontWeight="semibold">
            All set for tomorrow!
          </Text>
        )}
        {/* Inclement-weather chip — only renders when tomorrow is rainy/stormy/snowy. */}
        <Box mt={2}>
          <TomorrowWeatherWarning size="md" />
        </Box>
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
          <Text fontSize="md" fontWeight="semibold" color="fg.muted">
            {teamView ? "No team jobs scheduled tomorrow" : "All clear for tomorrow"}
          </Text>
          <Text fontSize="sm" color="fg.muted" mt={1}>
            {teamView ? "No assignments across the team for tomorrow." : "No jobs, estimates, or events scheduled."}
          </Text>
        </Box>
      )}

      {/* Sections (Jobs / Estimates / Events / Other) — used by both per-worker
          and team views. In team view, cards show worker labels via showTeam. */}
      {sortedJobs.length > 0 && (
        <Box mb={4}>
          <HStack mb={2} gap={2} wrap="wrap" align="baseline">
            <Text fontSize="xs" fontWeight="semibold" color="blue.600" textTransform="uppercase" letterSpacing="wide">
              Jobs ({sortedJobs.length})
            </Text>
            <Text fontSize="xs" color={checkedJobs === sortedJobs.length ? "green.600" : "fg.muted"} fontWeight={checkedJobs === sortedJobs.length ? "semibold" : "normal"}>
              {checkedJobs} of {sortedJobs.length} confirmed
            </Text>
          </HStack>
          <VStack align="stretch" gap={1}>
            {sortedJobs.map((occ) => (
              <ChecklistItem key={occ.id} occ={occ} forAdmin={forAdmin} onConfirm={handleConfirm} busy={busyId === occ.id} />
            ))}
          </VStack>
        </Box>
      )}

      {sortedEstimates.length > 0 && (
        <Box mb={4}>
          <HStack mb={2} gap={2} wrap="wrap" align="baseline">
            <Text fontSize="xs" fontWeight="semibold" color="pink.600" textTransform="uppercase" letterSpacing="wide">
              Estimates ({sortedEstimates.length})
            </Text>
            <Text fontSize="xs" color={checkedEstimates === sortedEstimates.length ? "green.600" : "fg.muted"} fontWeight={checkedEstimates === sortedEstimates.length ? "semibold" : "normal"}>
              {checkedEstimates} of {sortedEstimates.length} confirmed
            </Text>
          </HStack>
          <VStack align="stretch" gap={1}>
            {sortedEstimates.map((occ) => (
              <ChecklistItem key={occ.id} occ={occ} forAdmin={forAdmin} onConfirm={handleConfirm} busy={busyId === occ.id} />
            ))}
          </VStack>
        </Box>
      )}

      {sortedEvents.length > 0 && (
        <Box mb={4}>
          <Text fontSize="xs" fontWeight="semibold" color="yellow.700" mb={2} textTransform="uppercase" letterSpacing="wide">
            Events ({sortedEvents.length})
          </Text>
          <VStack align="stretch" gap={1}>
            {sortedEvents.map((occ) => (
              <OtherItem key={occ.id} occ={occ} forAdmin={forAdmin} showTeam={teamView} />
            ))}
          </VStack>
        </Box>
      )}

      {sortedOthers.length > 0 && (
        <Box mb={4}>
          <Text fontSize="xs" fontWeight="semibold" color="gray.700" mb={2} textTransform="uppercase" letterSpacing="wide">
            Other ({sortedOthers.length})
          </Text>
          <VStack align="stretch" gap={1}>
            {sortedOthers.map((occ) => (
              <OtherItem key={occ.id} occ={occ} forAdmin={forAdmin} showTeam={teamView} />
            ))}
          </VStack>
        </Box>
      )}

      {/* Route section — per-worker only; routes are individual, no team-wide route */}
      {!teamView && hasItems && (
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
                <Navigation size={12} /> Plan
              </Button>
            )}
          </HStack>
        </Box>
      )}

      {/* Workflow section — quick launcher for the guided "Plan Next Work Day"
          workflow. Per-worker only (admins viewing a worker's planning shouldn't
          launch the worker's workflow). */}
      {!teamView && hasItems && (
        <Box mb={4}>
          <Text fontSize="xs" fontWeight="semibold" color="blue.700" mb={2} textTransform="uppercase" letterSpacing="wide">
            Workflow
          </Text>
          <HStack
            gap={2}
            px={3}
            py={2}
            bg={workflowLaunched ? "green.50" : "gray.50"}
            borderWidth="1px"
            borderColor={workflowLaunched ? "green.200" : "gray.200"}
            borderRadius="md"
            align="center"
          >
            {workflowLaunched ? (
              <CheckCircle2 size={16} color="var(--chakra-colors-green-500)" />
            ) : (
              <Circle size={16} color="var(--chakra-colors-gray-400)" />
            )}
            <Text fontSize="sm" fontWeight="medium" flex="1">Plan next work day</Text>
            {!forAdmin && (
              <Button
                size="xs"
                variant={workflowLaunched ? "ghost" : "solid"}
                colorPalette="blue"
                onClick={launchPlanWorkdayWorkflow}
              >
                <Play size={12} /> Start
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
      position="relative"
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
        <HStack gap={1.5} wrap="wrap">
          {confirmed ? (
            <Badge size="xs" colorPalette="green" variant="subtle">Confirmed</Badge>
          ) : (
            <Badge size="xs" colorPalette="orange" variant="solid">Needs confirmation</Badge>
          )}
          {/* Messaging icons sit next to the "Needs confirmation" badge so the
              copy + text/email actions are right where the user looks first. */}
          {!confirmed && !forAdmin && (
            <>
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
                  px="1"
                  minW="0"
                  onClick={() => window.open(`sms:${contact.phone}?body=${encodeURIComponent(msg)}`, "_self")}
                  title={`Text ${contact.phone}`}
                >
                  <MessageCircle size={12} />
                </Button>
              ) : contact?.email ? (
                <Button
                  size="xs"
                  variant="outline"
                  colorPalette="blue"
                  px="1"
                  minW="0"
                  onClick={() => window.open(`mailto:${contact.email}?subject=${encodeURIComponent("Seedlings Lawn Care — Service Confirmation")}&body=${encodeURIComponent(msg)}`, "_self")}
                  title={`Email ${contact.email}`}
                >
                  <Mail size={12} />
                </Button>
              ) : null}
            </>
          )}
        </HStack>
      </VStack>

      {/* Right column — Confirm (when needed) sits above the always-present View →
          link, mirroring the right-side button layout used by OtherItem cards. */}
      <VStack gap={1} flexShrink={0} align="end">
        {!confirmed && !forAdmin && (
          <Button
            size="xs"
            variant="solid"
            colorPalette="orange"
            loading={busy}
            onClick={() => onConfirm(occ)}
          >
            <Check size={12} /> Confirm
          </Button>
        )}
        <Button size="xs" variant="ghost" colorPalette="blue" onClick={() => viewOnJobs(occ.id, forAdmin)}>
          View →
        </Button>
      </VStack>
    </HStack>
  );
}

/** Visual config per workflow type for the Other-section card. EVENT is included
 *  here so the team view can render events through the same simple-card path. */
function otherTypeConfig(workflow: string | null | undefined) {
  switch (workflow) {
    case "TASK":
      return { label: "Task", Icon: ListChecks, palette: "blue" as const, bg: "blue.50", border: "blue.200", color: "var(--chakra-colors-blue-500)" };
    case "REMINDER":
      return { label: "Reminder", Icon: Bell, palette: "purple" as const, bg: "purple.50", border: "purple.200", color: "var(--chakra-colors-purple-500)" };
    case "FOLLOWUP":
      return { label: "Follow-up", Icon: Repeat, palette: "red" as const, bg: "red.50", border: "red.200", color: "var(--chakra-colors-red-500)" };
    case "ANNOUNCEMENT":
      return { label: "Announcement", Icon: Megaphone, palette: "purple" as const, bg: "purple.50", border: "purple.300", color: "var(--chakra-colors-purple-600)" };
    case "EVENT":
      return { label: "Event", Icon: CheckCircle2, palette: "yellow" as const, bg: "green.50", border: "green.200", color: "var(--chakra-colors-green-500)" };
    default:
      return { label: "Item", Icon: ListChecks, palette: "gray" as const, bg: "gray.50", border: "gray.200", color: "var(--chakra-colors-gray-500)" };
  }
}

/** Simple non-actionable card for Tasks / Reminders / Follow-ups / Announcements. */
function OtherItem({ occ, forAdmin, showTeam }: { occ: WorkerOccurrence; forAdmin?: boolean; showTeam?: boolean }) {
  const cfg = otherTypeConfig(occ.workflow);
  const propertyName = occ.job?.property?.displayName ?? null;
  const title = occ.title ?? propertyName ?? "(untitled)";
  const subtitle = occ.title && propertyName ? propertyName : null;
  const team = showTeam ? assigneeSummary(occ.assignees) : null;

  return (
    <HStack
      gap={2}
      px={3}
      py={2}
      bg={cfg.bg}
      borderWidth="1px"
      borderColor={cfg.border}
      borderRadius="md"
      align="center"
    >
      <Box flexShrink={0}>
        <cfg.Icon size={16} color={cfg.color} />
      </Box>
      <VStack align="start" gap={0} flex="1" minW={0}>
        <HStack gap={1.5} w="full" minW={0}>
          <Badge size="xs" colorPalette={cfg.palette} variant="subtle" flexShrink={0}>{cfg.label}</Badge>
          <Text fontSize="sm" fontWeight="medium" truncate flex="1" minW={0}>{title}</Text>
        </HStack>
        {subtitle && <Text fontSize="xs" color="fg.muted" truncate w="full">{subtitle}</Text>}
        {team && team !== "Unassigned" && <Text fontSize="xs" color="fg.muted" truncate w="full">{team}</Text>}
      </VStack>
      <Button size="xs" variant="ghost" colorPalette="blue" onClick={() => viewOnJobs(occ.id, forAdmin)} flexShrink={0}>
        View →
      </Button>
    </HStack>
  );
}
