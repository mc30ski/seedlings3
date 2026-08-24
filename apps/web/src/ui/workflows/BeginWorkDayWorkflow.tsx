"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  createListCollection,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { AlertCircle, AlertTriangle, CheckCircle, Eye, MapPin, Truck, Wrench } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { buildMailtoHref, buildSmsHref, fetchCommsCc } from "@/src/lib/comms";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { type WorkerOccurrence } from "@/src/lib/types";
// Reuse the shared workday client, not a raw fetch: startWorkday() fires
// bumpWorkday(), which broadcasts seedlings:workday-changed so the
// WorkdayStrip on Worker Home re-renders. Hitting the endpoint directly
// would start the day and leave the strip still showing "not started".
import { fetchWorkdayToday, startWorkday, fmtWorkdayDate, type WorkdaySummary, type WorkdayTodayPayload } from "@/src/lib/workday";
import { bumpWorkday } from "@/src/lib/bus";
import { fmtDate, fmtDateOpts, bizDateKey } from "@/src/lib/dates";
import { clientLabel, jobTypeLabel } from "@/src/lib/labels";
import { resolveBillingMode, shortBillingChip } from "@/src/lib/equipmentBilling";
import { useEquipmentBillingEnabled } from "@/src/lib/useEquipmentBillingEnabled";
import { MapLink } from "@/src/ui/helpers/Link";
import { StatusBadge } from "@/src/ui/components/StatusBadge";

const STORAGE_KEY = "seedlings_beginWorkday";
const PAUSED_KEY = "seedlings_beginWorkday_paused";

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type Props = {
  active: boolean;
  onDone: () => void;
  myId?: string;
  // Worker type drives a few cost-display gates — only contractors actually
  // pay equipment daily-rate costs; employees and trainees see equipment as
  // a no-charge company resource.
  myWorkerType?: string | null;
};

type WorkflowVehicle = {
  id: string;
  displayName: string;
  currentOdometer?: number | null;
};

export default function BeginWorkDayWorkflow({ active, onDone, myId, myWorkerType }: Props) {
  const today = bizDateKey(new Date());

  const equipmentBillingEnabled = useEquipmentBillingEnabled();
  const [step, setStep] = useState<"idle" | "loading" | "overview" | "confirm" | "route" | "equipment" | "vehicle" | "prior-open" | "start-workday" | "ready" | "no-jobs">("idle");
  const [startingWorkday, setStartingWorkday] = useState(false);
  const [priorOpen, setPriorOpen] = useState<WorkdaySummary[]>([]);
  const [vehicles, setVehicles] = useState<WorkflowVehicle[]>([]);
  const [vehicleId, setVehicleId] = useState<string>("");
  const [odometer, setOdometer] = useState<string>("");
  const [startingDrive, setStartingDrive] = useState(false);
  /** Workday payload fetched when leaving the route step, reused after the
   *  vehicle step so the post-vehicle branch doesn't refetch. Starting a
   *  mileage session touches neither `openPrior` nor `today.state`, so the
   *  stashed copy is still accurate. */
  const [pendingWorkday, setPendingWorkday] = useState<WorkdayTodayPayload | null>(null);
  /** True while the vehicle step is a real stop in this run — drives where
   *  the downstream Back buttons return to. Cleared once a drive starts,
   *  since re-offering the step would suggest starting a second session. */
  const [vehicleStepShown, setVehicleStepShown] = useState(false);

  /**
   * Decide whether to offer "start your workday" before the final step.
   *
   * The workflow walks a worker through preparing their day and then hands
   * them a button to their first job — but nothing in it ever started the
   * workday, so they could finish the whole flow still clocked out and not
   * notice until hours were missing.
   *
   * ORDER MATTERS. A dangling prior workday takes precedence over today's
   * state, matching WorkdayRequiredDialog. `assertWorkdayActiveOrPrompt`
   * returns ok:false whenever `openPrior` is non-empty EVEN IF today is
   * IN_PROGRESS, so starting today's day while yesterday is still open
   * accomplishes nothing — the worker is still refused at the first job,
   * now with two open rows and no idea why. Send them to close the old
   * day instead of offering a start that cannot help.
   *
   * Otherwise ONLY NOT_STARTED gets the prompt. A day already IN_PROGRESS,
   * PAUSED or COMPLETED skips straight through: re-asking someone already
   * on the clock invites a double-start and would confuse a paused day.
   *
   * A failed lookup skips the prompt rather than blocking — the worker can
   * still start from the Home strip, and a network blip must not trap them
   * in the workflow.
   */
  function decideAfterVehicle(payload: WorkdayTodayPayload | null) {
    if ((payload?.openPrior ?? []).length > 0) {
      setPriorOpen(payload!.openPrior);
      setStep("prior-open");
      return;
    }
    setStep(payload?.today?.state === "NOT_STARTED" ? "start-workday" : "ready");
  }

  /**
   * Leaving the route step. Offers to start a mileage session first when
   * the worker has a vehicle assigned and isn't already driving — a worker
   * who heads out without starting one loses the trip, and reconstructing
   * odometer readings after the fact is guesswork.
   *
   * Skipped when there is nothing to offer: no assigned vehicle, or a
   * session already open (`openMileageEntries`). A failed vehicle lookup
   * degrades to skipping the step rather than blocking the workflow.
   */
  async function proceedFromRoute() {
    try {
      const [payload, list] = await Promise.all([
        fetchWorkdayToday(),
        apiGet<WorkflowVehicle[]>("/api/me/vehicles").catch(() => [] as WorkflowVehicle[]),
      ]);
      setPendingWorkday(payload ?? null);
      const assigned = Array.isArray(list) ? list : [];
      const alreadyDriving = (payload?.openMileageEntries ?? []).length > 0;
      if (assigned.length > 0 && !alreadyDriving) {
        setVehicles(assigned);
        pickVehicle(assigned[0].id, assigned);
        setVehicleStepShown(true);
        setStep("vehicle");
        return;
      }
      setVehicleStepShown(false);
      decideAfterVehicle(payload ?? null);
    } catch {
      setStep("ready");
    }
  }

  function pickVehicle(id: string, list: WorkflowVehicle[] = vehicles) {
    setVehicleId(id);
    const v = list.find((x) => x.id === id);
    setOdometer(v?.currentOdometer != null ? String(v.currentOdometer) : "");
  }

  async function startDriving() {
    if (!vehicleId || !/^\d+$/.test(odometer.trim())) return;
    setStartingDrive(true);
    try {
      await apiPost("/api/me/mileage/start", {
        vehicleId,
        startOdometer: Number(odometer),
      });
      // Same broadcast the MileageBanner's own start fires, so the Home
      // strip reflects the open session the moment the workflow closes.
      bumpWorkday();
      publishInlineMessage({ type: "SUCCESS", text: "Mileage session started." });
      setVehicleStepShown(false);
      decideAfterVehicle(pendingWorkday);
    } catch (err) {
      // Stay put so the worker can retry — advancing silently would leave
      // them believing the trip is being recorded when it isn't.
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't start the mileage session.", err) });
    } finally {
      setStartingDrive(false);
    }
  }
  const [occurrences, setOccurrences] = useState<WorkerOccurrence[]>([]);
  const [confirmIndex, setConfirmIndex] = useState(0);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [equipment, setEquipment] = useState<any[]>([]);
  const [equipmentLoaded, setEquipmentLoaded] = useState(false);

  async function loadTodaysJobs(): Promise<WorkerOccurrence[]> {
    try {
      // Load today + any overdue
      const list = await apiGet<WorkerOccurrence[]>(`/api/occurrences?to=${today}`);
      const myJobs = (Array.isArray(list) ? list : []).filter((occ) => {
        // Ghost rows (reminder-ghost, pinned-ghost, next-occurrence
        // "Expiring" placeholder) are shallow copies of a real occurrence
        // carrying `workflow: "STANDARD"`, `status: SCHEDULED`, and the
        // real assignee list — so they pass every check below. Their id is
        // synthetic (`ghost:<jobId>`), so Confirm Clients would POST it to
        // /api/occurrences/:id/confirm and get "Occurrence not found".
        // The next-occurrence ghost snaps its startAt forward to today when
        // the projected date is past, so the date anchor doesn't screen it
        // out either. Exclude them explicitly, as JobsTab does.
        if ((occ as any)._isReminderGhost) return false;
        if ((occ as any)._isPinnedGhost) return false;
        if ((occ as any)._isNextOccurrenceGhost) return false;
        // Only real jobs — exclude TASK, REMINDER, EVENT, FOLLOWUP, ANNOUNCEMENT, ESTIMATE
        if (occ.workflow !== "STANDARD" && occ.workflow !== "ONE_OFF") return false;
        const isAssigned = (occ.assignees ?? []).some((a) => a.userId === myId);
        if (!isAssigned) return false;
        const isActive = occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS";
        if (!isActive) return false;
        // Anchor to today (ET) or earlier. The /api/occurrences endpoint
        // intentionally merges pinned/liked/observed rows that fall
        // OUTSIDE the requested date range (so they stay visible on the
        // JobsTab when the operator narrows the date filter). For the
        // Today's Overview dialog we DON'T want a pinned next-week job
        // showing up alongside today's work — re-anchor on the client.
        const occDate = occ.startAt ? bizDateKey(occ.startAt) : "";
        return !!occDate && occDate <= today;
      });
      // Sort: overdue first, then by startAt
      myJobs.sort((a, b) => {
        const aDate = a.startAt ? bizDateKey(a.startAt) : "";
        const bDate = b.startAt ? bizDateKey(b.startAt) : "";
        const aOverdue = aDate < today ? 0 : 1;
        const bOverdue = bDate < today ? 0 : 1;
        if (aOverdue !== bOverdue) return aOverdue - bOverdue;
        return aDate.localeCompare(bDate);
      });
      setOccurrences(myJobs);
      return myJobs;
    } catch {
      setOccurrences([]);
      return [];
    }
  }

  async function loadEquipment() {
    try {
      const list = await apiGet<any[]>("/api/equipment/mine");
      setEquipment(Array.isArray(list) ? list : []);
    } catch {
      setEquipment([]);
    }
    setEquipmentLoaded(true);
  }

  // Load tasks for today
  const [tasks, setTasks] = useState<WorkerOccurrence[]>([]);
  async function loadTasks() {
    try {
      const list = await apiGet<WorkerOccurrence[]>(`/api/occurrences?from=${today}&to=${today}`);
      const myTasks = (Array.isArray(list) ? list : []).filter((occ) => {
        if (occ.workflow !== "TASK") return false;
        if (occ.status !== "SCHEDULED") return false;
        if (!(occ.assignees ?? []).some((a) => a.userId === myId)) return false;
        // Same merge caveat as loadTodaysJobs — the server adds
        // pinned/liked/observed rows that fall outside the date range.
        // Restrict to today's ET date so a pinned future task can't
        // sneak into the "Tasks for Today" list.
        return !!occ.startAt && bizDateKey(occ.startAt) === today;
      });
      setTasks(myTasks);
    } catch {
      setTasks([]);
    }
  }

  useEffect(() => {
    if (!active) { setStep("idle"); return; }

    // Check for persisted state (returning from route/equipment tab)
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.date === today && data.step) {
          localStorage.removeItem(STORAGE_KEY);
          setStep("loading");
          Promise.all([loadTodaysJobs(), loadEquipment(), loadTasks()]).then(([jobs]) => {
            if (jobs.length === 0) setStep("no-jobs");
            else setStep(data.step as any);
          });
          return;
        }
      }
    } catch {}

    // Fresh start
    setStep("loading");
    Promise.all([loadTodaysJobs(), loadEquipment(), loadTasks()]).then(([jobs]) => {
      if (jobs.length === 0) setStep("no-jobs");
      else setStep("overview");
    });
  }, [active]);

  function persist(stepName: string) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: today, step: stepName })); } catch {}
  }

  function goToTab(tab: string, pauseStep: string) {
    persist(pauseStep);
    try { localStorage.setItem(PAUSED_KEY, "1"); } catch {}
    setStep("idle");
    onDone();
    if (tab === "routes") {
      try { localStorage.setItem("seedlings_preview_targetDate", JSON.stringify(today)); } catch {}
      window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "routes", autoAnalyze: true } }));
    } else if (tab === "equipment") {
      window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "equipment" } }));
      // EquipmentTab persists its filters across visits; pre-day prep wants
      // a fresh "show me everything" view, not whatever filter was last left
      // applied (commonly "claimed", which hides the items they need to grab).
      // Fire an empty applyFilter so the tab's handler resets status/kind/likedOnly/query.
      // setTimeout defers until after the tab swap so the freshly-mounted
      // EquipmentTab's listener catches the event.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("equipment:applyFilter", { detail: {} }));
      }, 100);
    } else if (tab === "jobs") {
      // Set date filter to today
      try { localStorage.setItem("seedlings_beginWorkday_jobsDate", today); } catch {}
      window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "jobs" } }));
    }
  }

  if (!active || step === "idle") return null;

  // Computed stats
  const totalJobs = occurrences.length;
  const totalMinutes = occurrences.reduce((sum, o) => sum + (o.estimatedMinutes ?? 0), 0);
  const totalRevenue = occurrences.reduce((sum, o) => sum + (o.price ?? 0), 0);
  const overdueJobs = occurrences.filter((o) => o.startAt && bizDateKey(o.startAt) < today);
  const todayJobs = occurrences.filter((o) => o.startAt && bizDateKey(o.startAt) === today);
  const maintenanceEquipment = equipment.filter((e) => e.status === "MAINTENANCE");

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) { setStep("idle"); onDone(); } }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          {/* minW={0} is load-bearing. The positioner is a flex row, so the
              content box defaults to min-width:auto — it refuses to shrink
              below its own min-content width. Today's Overview has the
              widest content of any step (min-content 441px), so on a 390px
              phone it blew past the mx gutters and rendered edge-to-edge
              while every other step sat inset by 12px. Zeroing the minimum
              lets it shrink to the margin box; the cards inside already
              truncate. */}
          <Dialog.Content maxW="md" mx={{ base: "3", md: "4" }} w="full" minW={0} rounded="2xl" p="4" shadow="lg">
            {/* Loading */}
            {step === "loading" && (
              <>
                <Dialog.Header><Dialog.Title>Prepare for work day</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <Box py={8} textAlign="center"><Spinner size="lg" /><Text mt={2} color="fg.muted">Loading today's schedule...</Text></Box>
                </Dialog.Body>
              </>
            )}

            {/* No jobs */}
            {step === "no-jobs" && (
              <>
                <Dialog.Header><Dialog.Title>Prepare for work day</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <Box py={6} textAlign="center">
                    <CheckCircle size={48} style={{ margin: "0 auto", color: "var(--chakra-colors-green-500)" }} />
                    <Text fontSize="lg" fontWeight="semibold" mt={3} color="green.600">No jobs scheduled for today</Text>
                    <Text fontSize="sm" color="fg.muted" mt={1}>You don't have any jobs assigned for today. Check the Jobs tab for available work to claim.</Text>
                  </Box>
                </Dialog.Body>
                <Dialog.Footer>
                  <Button onClick={() => { setStep("idle"); onDone(); }}>Close</Button>
                </Dialog.Footer>
              </>
            )}

            {/* Step 1: Overview */}
            {step === "overview" && (
              <>
                <Dialog.Header><Dialog.Title>Today's Overview</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <VStack align="stretch" gap={3}>
                    {/* Summary bar */}
                    <HStack gap={3} p={3} bg="green.50" rounded="md" wrap="wrap">
                      <Badge colorPalette="green" variant="solid" fontSize="sm" px="3" borderRadius="full">
                        {totalJobs} job{totalJobs !== 1 ? "s" : ""}
                      </Badge>
                      {totalMinutes > 0 && (
                        <Badge colorPalette="blue" variant="subtle" fontSize="sm" px="3" borderRadius="full">
                          ~{formatDuration(totalMinutes)}
                        </Badge>
                      )}
                      {totalRevenue > 0 && (
                        <Badge colorPalette="green" variant="subtle" fontSize="sm" px="3" borderRadius="full">
                          ${totalRevenue.toFixed(2)}
                        </Badge>
                      )}
                    </HStack>

                    {/* Overdue warning */}
                    {overdueJobs.length > 0 && (
                      <Box p={3} bg="red.50" borderWidth="1px" borderColor="red.200" rounded="md">
                        <Text fontSize="sm" fontWeight="medium" color="red.700">
                          {overdueJobs.length} overdue job{overdueJobs.length !== 1 ? "s" : ""} from previous days
                        </Text>
                      </Box>
                    )}

                    {/* Job list */}
                    <VStack align="stretch" gap={2}>
                      {occurrences.map((occ) => {
                        const isOverdue = occ.startAt && bizDateKey(occ.startAt) < today;
                        const isInProgress = occ.status === "IN_PROGRESS";
                        // True when the user's own assignment role on this
                        // occurrence is "observer" — they're watching, not
                        // working it. Visual cue mirrors the Eye icon used
                        // on JobsTab cards so observer status reads the
                        // same wherever an occurrence shows up.
                        const isObserverHere = (occ.assignees ?? []).some((a) => a.userId === myId && a.role === "observer");
                        return (
                          <Card.Root key={occ.id} variant="outline" borderColor={isOverdue ? "red.200" : isInProgress ? "blue.200" : "gray.200"} bg={isOverdue ? "red.50" : isInProgress ? "blue.50" : undefined}>
                            <Card.Body py="2" px="3">
                              <HStack justify="space-between" align="start" gap={2}>
                                <VStack align="start" gap={0.5} flex="1" minW={0}>
                                  <HStack gap={1.5} align="center" minW={0} w="full">
                                    {isObserverHere && (
                                      <Box flexShrink={0} display="inline-flex" alignItems="center" title="You're an observer">
                                        <Eye size={14} color="var(--chakra-colors-blue-500)" />
                                      </Box>
                                    )}
                                    <Text fontSize="sm" fontWeight="medium" minW={0} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                      {occ.job?.property?.displayName}
                                      {occ.job?.property?.client?.displayName && (
                                        <Text as="span" color="fg.muted" fontWeight="normal"> — {clientLabel(occ.job.property.client.displayName)}</Text>
                                      )}
                                    </Text>
                                  </HStack>
                                  <HStack gap={2} fontSize="xs" wrap="wrap">
                                    {isOverdue && <StatusBadge status="Overdue" palette="red" variant="solid" />}
                                    {isInProgress && <StatusBadge status="In Progress" palette="blue" variant="solid" />}
                                    {isObserverHere && <StatusBadge status="Observer" palette="blue" variant="subtle" />}
                                    {(occ as any).jobType && (
                                      <Text color="fg.muted">{jobTypeLabel((occ as any).jobType)}</Text>
                                    )}
                                    {occ.estimatedMinutes && <Text color="fg.muted">~{formatDuration(occ.estimatedMinutes)}</Text>}
                                    {occ.price != null && <Text color="green.600">${occ.price.toFixed(2)}</Text>}
                                  </HStack>
                                </VStack>
                                <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                                  {occ.startAt ? fmtDate(occ.startAt) : ""}
                                </Text>
                              </HStack>
                            </Card.Body>
                          </Card.Root>
                        );
                      })}
                    </VStack>

                    {/* Tasks for today */}
                    {tasks.length > 0 && (
                      <Box>
                        <Text fontSize="xs" fontWeight="semibold" color="blue.600" mb={1} textTransform="uppercase" letterSpacing="wide">
                          Tasks for Today ({tasks.length})
                        </Text>
                        <VStack align="stretch" gap={1}>
                          {tasks.map((t) => (
                            <HStack key={t.id} p={2} bg="blue.50" rounded="md" gap={2}>
                              <Text fontSize="sm" flex="1">{t.title}</Text>
                            </HStack>
                          ))}
                        </VStack>
                      </Box>
                    )}
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                    {/* Same footer shape as every other step: the leave
                        action sits alone on the left, the link-out and the
                        primary advance group on the right. */}
                    <Button variant="ghost" size="sm" onClick={() => { setStep("idle"); onDone(); }}>Cancel</Button>
                    <HStack gap={2} wrap="wrap">
                      <Button variant="outline" size="sm" onClick={() => { goToTab("jobs", "overview"); }}>
                        View in Jobs
                      </Button>
                      <Button size="sm" colorPalette="green" onClick={() => {
                        const unconfirmed = occurrences.filter((o) =>
                          o.jobId && !(o as any).isClientConfirmed && o.status === "SCHEDULED" &&
                          (o.workflow === "STANDARD" || o.workflow === "ONE_OFF" || o.workflow === "ESTIMATE" || !o.workflow)
                        );
                        if (unconfirmed.length > 0) {
                          setConfirmIndex(0);
                          setStep("confirm");
                        } else {
                          setStep("equipment");
                        }
                      }}>
                        Next
                      </Button>
                    </HStack>
                  </HStack>
                </Dialog.Footer>
              </>
            )}

            {/* Step 2: Client Confirmation */}
            {step === "confirm" && (() => {
              const unconfirmed = occurrences.filter((o) =>
                o.jobId && !(o as any).isClientConfirmed && o.status === "SCHEDULED" &&
                (o.workflow === "STANDARD" || o.workflow === "ONE_OFF" || o.workflow === "ESTIMATE" || !o.workflow)
              );
              const current = unconfirmed[confirmIndex];
              if (!current) {
                // All done or no more — move to route
                return (
                  <>
                    <Dialog.Header><Dialog.Title>All Confirmed</Dialog.Title></Dialog.Header>
                    <Dialog.Body>
                      <Box py={6} textAlign="center">
                        <CheckCircle size={48} style={{ margin: "0 auto", color: "var(--chakra-colors-green-500)" }} />
                        <Text fontSize="md" fontWeight="semibold" mt={3} color="green.600">All clients confirmed</Text>
                      </Box>
                    </Dialog.Body>
                    <Dialog.Footer>
                      <HStack justify="flex-end" w="full">
                        <Button size="sm" colorPalette="green" onClick={() => setStep("equipment")}>Next</Button>
                      </HStack>
                    </Dialog.Footer>
                  </>
                );
              }
              const address = [current.job?.property?.street1, current.job?.property?.city, current.job?.property?.state].filter(Boolean).join(", ");
              const poc = (current.job?.property as any)?.pointOfContact;
              const contactName = poc ? [poc.firstName, poc.lastName].filter(Boolean).join(" ") : null;
              return (
                <>
                  <Dialog.Header>
                    <Dialog.Title>Confirm Clients ({confirmIndex + 1} of {unconfirmed.length})</Dialog.Title>
                  </Dialog.Header>
                  <Dialog.Body>
                    <VStack align="stretch" gap={3}>
                      <Card.Root variant="outline" borderColor="orange.300" bg="orange.50">
                        <Card.Body py="2" px="3">
                          <VStack align="start" gap={1}>
                            <Text fontSize="sm" fontWeight="semibold">
                              {current.job?.property?.displayName}
                              {current.job?.property?.client?.displayName && (
                                <Text as="span" color="fg.muted" fontWeight="normal"> — {clientLabel(current.job.property.client.displayName)}</Text>
                              )}
                            </Text>
                            {address && <Text fontSize="xs" color="fg.muted">{address}</Text>}
                            {contactName && <Text fontSize="xs" color="fg.muted">Contact: {contactName}{poc?.phone ? ` · ${poc.phone}` : ""}</Text>}
                            {(current as any).pinnedNote && (
                              <Box px={2} py={1} bg="yellow.100" borderWidth="1px" borderColor="yellow.400" borderRadius="md" w="full">
                                <HStack gap="1.5" align="center">
                                  <AlertCircle
                                    size={18}
                                    color="var(--chakra-colors-yellow-900)"
                                    fill="var(--chakra-colors-yellow-400)"
                                    strokeWidth={2.5}
                                  />
                                  <Text fontSize="xs" fontWeight="semibold" color="yellow.700">{(current as any).pinnedNote}</Text>
                                </HStack>
                              </Box>
                            )}
                            <HStack gap={2} fontSize="xs" wrap="wrap" mt={1}>
                              {current.estimatedMinutes && <Text color="fg.muted">~{formatDuration(current.estimatedMinutes)}</Text>}
                              {current.price != null && <Text color="green.600">${current.price.toFixed(2)}</Text>}
                            </HStack>
                          </VStack>
                        </Card.Body>
                      </Card.Root>
                      <Text fontSize="sm" color="fg.muted">
                        Have you contacted the client to confirm this job?
                      </Text>
                      {/* Same advisory as the JobsTab Confirm Client dialog so
                          the warning copy and visual treatment match the
                          ConfirmDialog component's `warning` slot exactly. */}
                      <Box
                        p={3}
                        bg="blue.50"
                        borderWidth="1px"
                        borderColor="blue.300"
                        borderLeftWidth="4px"
                        borderLeftColor="blue.500"
                        rounded="md"
                      >
                        <Text fontSize="sm" color="blue.900">
                          Only confirm if client has approved the appointment. Otherwise tap "Request Confirmation" to send them a message — a job that starts without the client's go-ahead can cause issues.
                        </Text>
                      </Box>
                      {/* Request Confirmation — mirrors the openConfirmClientDialog
                          flow in JobsTab: send the same canned wording via SMS
                          (preferred) or email, depending on which contact channel
                          the point-of-contact has. No assumption that the worker
                          will phone-call; the operator can do that separately if
                          they want to. */}
                      {(() => {
                        const pocPhone: string | null = poc?.phone ?? null;
                        const pocEmail: string | null = poc?.email ?? null;
                        if (!pocPhone && !pocEmail) return null;
                        const dateStr = current.startAt
                          ? fmtDateOpts(current.startAt, { weekday: "long", month: "long", day: "numeric" })
                          : "your upcoming appointment";
                        const name = contactName || "there";
                        // `address` is already computed above for the card
                        // header — reuse so the message body matches the
                        // location the worker sees and matches the wording
                        // produced by getQuickMessage() in JobsTab.
                        const atAddress = address ? ` at ${address}` : "";
                        const body = `Hi ${name}, this is Seedlings Lawn Care. We have your lawn service scheduled for ${dateStr}${atAddress}. Could you please confirm this works for you? Or let us know if you need to reschedule.`;
                        return (
                          <Button
                            size="sm"
                            variant="outline"
                            colorPalette="blue"
                            onClick={async () => {
                              const cc = await fetchCommsCc();
                              if (pocPhone) {
                                window.open(buildSmsHref({ to: pocPhone, body, ccPhones: cc.phones }), "_self");
                              } else if (pocEmail) {
                                window.open(buildMailtoHref({ to: pocEmail, subject: "Seedlings Lawn Care", body, ccEmails: cc.emails }), "_self");
                              }
                            }}
                          >
                            Request Confirmation
                          </Button>
                        );
                      })()}
                    </VStack>
                  </Dialog.Body>
                  <Dialog.Footer>
                    <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                      <Button variant="ghost" size="sm" onClick={() => setStep("overview")}>Back</Button>
                      <HStack gap={2}>
                        <Button variant="ghost" size="sm" onClick={() => {
                          if (confirmIndex + 1 < unconfirmed.length) setConfirmIndex(confirmIndex + 1);
                          else setStep("equipment");
                        }}>
                          Skip
                        </Button>
                        <Button size="sm" colorPalette="orange" disabled={confirmBusy} onClick={async () => {
                          setConfirmBusy(true);
                          try {
                            await apiPost(`/api/occurrences/${current.id}/confirm`);
                            setOccurrences((prev) => prev.map((o) => o.id === current.id ? { ...o, isClientConfirmed: true } as any : o));
                            if (confirmIndex + 1 < unconfirmed.length) setConfirmIndex(confirmIndex + 1);
                            else setStep("equipment");
                          } catch (err) {
                            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to confirm.", err) });
                          } finally { setConfirmBusy(false); }
                        }}>
                          Confirm Client
                        </Button>
                      </HStack>
                    </HStack>
                  </Dialog.Footer>
                </>
              );
            })()}

            {/* Step 4: Route */}
            {step === "route" && (
              <>
                <Dialog.Header><Dialog.Title>Today's Route</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <VStack align="stretch" gap={3}>
                    <Box p={3} bg="blue.50" rounded="md">
                      <HStack gap={2} mb={2}>
                        <MapPin size={16} />
                        <Text fontSize="sm" fontWeight="medium" color="blue.700">Route for {todayJobs.length + overdueJobs.length} stops</Text>
                      </HStack>
                      <Text fontSize="xs" color="blue.600">
                        Review your optimized route to minimize drive time between jobs.
                      </Text>
                    </Box>

                    <VStack align="stretch" gap={1}>
                      {occurrences.map((occ, i) => (
                        <HStack key={occ.id} gap={2} px={2} py={1}>
                          <Badge colorPalette="gray" variant="subtle" fontSize="xs" borderRadius="full" w="6" h="6" display="flex" alignItems="center" justifyContent="center">
                            {i + 1}
                          </Badge>
                          <VStack align="start" gap={0} flex="1" minW={0}>
                            <Text fontSize="sm">{occ.job?.property?.displayName}</Text>
                            <Box fontSize="xs">
                              <MapLink address={[
                                occ.job?.property?.street1,
                                occ.job?.property?.city,
                                occ.job?.property?.state,
                              ].filter(Boolean).join(", ")} />
                            </Box>
                          </VStack>
                        </HStack>
                      ))}
                    </VStack>
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                    <Button variant="ghost" size="sm" onClick={() => setStep("equipment")}>Back</Button>
                    <HStack gap={2} wrap="wrap">
                      <Button variant="outline" size="sm" colorPalette="blue" onClick={() => goToTab("routes", "route")}>
                        Open Route
                      </Button>
                      <Button size="sm" colorPalette="green" onClick={() => void proceedFromRoute()}>
                        Next
                      </Button>
                    </HStack>
                  </HStack>
                </Dialog.Footer>
              </>
            )}

            {/* Step 3: Equipment */}
            {step === "equipment" && (
              <>
                <Dialog.Header><Dialog.Title>Equipment Check</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <VStack align="stretch" gap={3}>
                    <Box p={3} bg="orange.50" rounded="md">
                      <HStack gap={2} mb={2}>
                        <Wrench size={16} />
                        <Text fontSize="sm" fontWeight="medium" color="orange.700">Your Equipment</Text>
                      </HStack>
                      <Text fontSize="xs" color="orange.600">
                        Make sure you have everything you need for today's jobs. Remember to check out each item when you pick it up.
                      </Text>
                    </Box>

                    {!equipmentLoaded ? (
                      <Box py={4} textAlign="center"><Spinner size="sm" /></Box>
                    ) : equipment.length === 0 ? (
                      <Box p={3} bg="gray.50" rounded="md">
                        <Text fontSize="sm" color="fg.muted">No equipment currently checked out.</Text>
                      </Box>
                    ) : (
                      <VStack align="stretch" gap={1}>
                        {equipment.map((eq) => (
                          <HStack key={eq.id} justify="space-between" px={2} py={1} bg={eq.status === "MAINTENANCE" ? "red.50" : undefined} rounded="md">
                            <VStack align="start" gap={0}>
                              <Text fontSize="sm">
                                {eq.shortDesc || eq.type || "Equipment"}
                                {eq.brand ? ` — ${eq.brand}` : ""}
                                {eq.model ? ` ${eq.model}` : ""}
                              </Text>
                              {eq.status === "MAINTENANCE" && (
                                <Text fontSize="xs" color="red.600">In maintenance{eq.issues ? `: ${eq.issues}` : ""}</Text>
                              )}
                            </VStack>
                            {/* Daily-rate cost is contractor-only — employees
                                and trainees use company equipment at no
                                charge, so showing a cost there is misleading.
                                Chip text comes from shortBillingChip so it
                                reflects the new per-job-with-cap model when
                                the piece has equivalentJobs set. */}
                            {myWorkerType === "CONTRACTOR" && (() => {
                              const chip = shortBillingChip(
                                resolveBillingMode((eq as any).dailyRate, (eq as any).equivalentJobs, equipmentBillingEnabled),
                              );
                              return chip ? (
                                <Text fontSize="xs" fontWeight="medium" color="orange.700" flexShrink={0}>{chip}</Text>
                              ) : null;
                            })()}
                          </HStack>
                        ))}
                      </VStack>
                    )}

                    {maintenanceEquipment.length > 0 && (
                      <Box p={2} bg="red.50" borderWidth="1px" borderColor="red.200" rounded="md">
                        <Text fontSize="xs" color="red.700" fontWeight="medium">
                          {maintenanceEquipment.length} item{maintenanceEquipment.length !== 1 ? "s" : ""} in maintenance — you may need a substitute.
                        </Text>
                      </Box>
                    )}

                    <Box p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="md">
                      <Text fontSize="xs" color="blue.700">
                        Remember to return all equipment at the end of the day. Check items back in through the Equipment tab so they're available for the next crew.
                      </Text>
                    </Box>
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                    <Button variant="ghost" size="sm" onClick={() => setStep("overview")}>Back</Button>
                    <HStack gap={2} wrap="wrap">
                      <Button variant="outline" size="sm" colorPalette="orange" onClick={() => goToTab("equipment", "equipment")}>
                        Manage
                      </Button>
                      <Button size="sm" colorPalette="green" onClick={() => setStep("route")}>
                        Next
                      </Button>
                    </HStack>
                  </HStack>
                </Dialog.Footer>
              </>
            )}

            {/* Step 6: Start the workday (only when it hasn't been) */}
            {/* Step 5: Start driving (only when a vehicle is assigned and
                no session is already open). Suggested, never required — the
                worker may be a passenger, or on a site they walked to. */}
            {step === "vehicle" && (
              <>
                <Dialog.Header><Dialog.Title>Start driving?</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <VStack align="stretch" gap={3}>
                    <Box p={4} bg="orange.50" rounded="lg" textAlign="center">
                      <Truck size={40} style={{ margin: "0 auto", color: "var(--chakra-colors-orange-500)" }} />
                      <Text fontSize="lg" fontWeight="bold" color="orange.700" mt={2}>
                        {vehicles.length === 1
                          ? `You're assigned ${vehicles[0].displayName}`
                          : "You have vehicles assigned"}
                      </Text>
                      <Text fontSize="sm" color="orange.600" mt={1}>
                        Starting a mileage session now records the trip automatically.
                      </Text>
                    </Box>

                    {vehicles.length > 1 && (
                      <VStack align="stretch" gap={1}>
                        <Text fontSize="sm" fontWeight="medium">Vehicle</Text>
                        <Select.Root
                          collection={createListCollection({
                            items: vehicles.map((v) => ({ label: v.displayName, value: v.id })),
                          })}
                          value={vehicleId ? [vehicleId] : []}
                          onValueChange={(e) => { const v = e.value?.[0]; if (v) pickVehicle(v); }}
                          size="sm"
                          positioning={{ strategy: "fixed", hideWhenDetached: true }}
                        >
                          <Select.Control>
                            <Select.Trigger>
                              <Select.ValueText placeholder="Choose a vehicle" />
                              <Select.Indicator />
                            </Select.Trigger>
                          </Select.Control>
                          <Select.Positioner>
                            <Select.Content>
                              {vehicles.map((v) => (
                                <Select.Item key={v.id} item={v.id}>
                                  <Select.ItemText>{v.displayName}</Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Positioner>
                        </Select.Root>
                      </VStack>
                    )}

                    <VStack align="stretch" gap={1}>
                      <Text fontSize="sm" fontWeight="medium">Starting odometer (mi)</Text>
                      <Input
                        value={odometer}
                        onChange={(e) => setOdometer(e.target.value)}
                        inputMode="numeric"
                        placeholder="e.g. 48231"
                        size="sm"
                      />
                    </VStack>

                    <Text fontSize="xs" color="fg.muted" textAlign="center">
                      You can skip this and start a session later from your Home screen.
                    </Text>
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={startingDrive}
                      onClick={() => setStep("route")}
                    >
                      Back
                    </Button>
                    <HStack gap={2} wrap="wrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={startingDrive}
                        onClick={() => { setVehicleStepShown(false); decideAfterVehicle(pendingWorkday); }}
                      >
                        Not driving
                      </Button>
                      <Button
                        size="sm"
                        colorPalette="orange"
                        loading={startingDrive}
                        disabled={!vehicleId || !/^\d+$/.test(odometer.trim())}
                        onClick={() => void startDriving()}
                      >
                        Start Driving
                      </Button>
                    </HStack>
                  </HStack>
                </Dialog.Footer>
              </>
            )}

            {/* Dangling prior workday — blocks before the start prompt.
                Copy mirrors WorkdayRequiredDialog's openPrior branch so the
                worker reads the same instruction wherever they hit this. No
                "start anyway" affordance: the server refuses the first job
                while a prior day is open, so offering one would only add a
                second open row. */}
            {step === "prior-open" && (
              <>
                <Dialog.Header>
                  <Dialog.Title>Close out a previous workday first</Dialog.Title>
                </Dialog.Header>
                <Dialog.Body>
                  <VStack align="stretch" gap={3}>
                    <Text fontSize="sm">
                      You didn&apos;t end your workday on{" "}
                      <Text as="span" fontWeight="semibold">
                        {priorOpen[0] ? fmtWorkdayDate(priorOpen[0].workdayDate) : ""}
                      </Text>
                      {priorOpen.length > 1 && (
                        <Text as="span" color="fg.muted">
                          {" "}(plus {priorOpen.length - 1} more)
                        </Text>
                      )}
                      . Set the end time on the{" "}
                      <Text as="span" fontWeight="semibold">Home</Text> tab
                      (orange &quot;didn&apos;t end your workday&quot; banner) before
                      starting any new jobs.
                    </Text>
                    <Box p={3} bg="orange.50" borderWidth="1px" borderColor="orange.300" borderRadius="md">
                      <HStack gap={2} align="start">
                        <Box color="orange.600" flexShrink={0} mt="2px">
                          <AlertTriangle size={16} />
                        </Box>
                        <Text fontSize="xs" color="orange.900">
                          Past workdays don&apos;t auto-close — they need an end time so your
                          hours for that day are recorded correctly.
                        </Text>
                      </HStack>
                    </Box>
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                    <Button variant="ghost" size="sm" onClick={() => setStep(vehicleStepShown ? "vehicle" : "route")}>
                      Back
                    </Button>
                    <Button
                      colorPalette="orange"
                      size="sm"
                      onClick={() => { setStep("idle"); onDone(); }}
                    >
                      OK
                    </Button>
                  </HStack>
                </Dialog.Footer>
              </>
            )}

            {step === "start-workday" && (
              <>
                <Dialog.Header><Dialog.Title>Start your workday?</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <VStack align="stretch" gap={3}>
                    <Box p={4} bg="green.50" rounded="lg" textAlign="center">
                      <CheckCircle size={40} style={{ margin: "0 auto", color: "var(--chakra-colors-green-500)" }} />
                      <Text fontSize="lg" fontWeight="bold" color="green.700" mt={2}>
                        You&apos;re prepared — but not clocked in
                      </Text>
                      <Text fontSize="sm" color="green.600" mt={1}>
                        Starting your workday begins tracking your hours for today.
                      </Text>
                    </Box>
                    {/* Says plainly what happens if they skip. Someone who
                        finishes this flow assuming they are on the clock,
                        and isn't, loses hours they have to reconstruct
                        later. */}
                    <Text fontSize="xs" color="fg.muted" textAlign="center">
                      You can skip this and start later from your Home screen.
                    </Text>
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={startingWorkday}
                      onClick={() => setStep(vehicleStepShown ? "vehicle" : "route")}
                    >
                      Back
                    </Button>
                    <HStack gap={2} wrap="wrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={startingWorkday}
                        onClick={() => setStep("ready")}
                      >
                        Not yet
                      </Button>
                      <Button
                        size="sm"
                        colorPalette="green"
                        loading={startingWorkday}
                        onClick={async () => {
                          setStartingWorkday(true);
                          try {
                            // startedAt null = server stamps "now", the same
                            // as the Home strip's Start button.
                            await startWorkday({ startedAt: null });
                            publishInlineMessage({ type: "SUCCESS", text: "Workday started." });
                            setStep("ready");
                          } catch (err) {
                            // Stay on this step so the worker can retry —
                            // silently advancing would leave them believing
                            // they were clocked in.
                            publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't start your workday.", err) });
                          } finally {
                            setStartingWorkday(false);
                          }
                        }}
                      >
                        Start Workday
                      </Button>
                    </HStack>
                  </HStack>
                </Dialog.Footer>
              </>
            )}

            {/* Step 7: Ready */}
            {step === "ready" && (
              <>
                <Dialog.Header><Dialog.Title>Ready to Go!</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <VStack align="stretch" gap={3}>
                    <Box p={4} bg="green.50" rounded="lg" textAlign="center">
                      <CheckCircle size={40} style={{ margin: "0 auto", color: "var(--chakra-colors-green-500)" }} />
                      <Text fontSize="lg" fontWeight="bold" color="green.700" mt={2}>You're all set</Text>
                      <Text fontSize="sm" color="green.600" mt={1}>
                        {totalJobs} job{totalJobs !== 1 ? "s" : ""} today
                        {totalMinutes > 0 ? ` · ~${formatDuration(totalMinutes)}` : ""}
                        {totalRevenue > 0 ? ` · $${totalRevenue.toFixed(2)}` : ""}
                      </Text>
                    </Box>

                    {/* First job highlight */}
                    {occurrences.length > 0 && (
                      <Box p={3} bg="teal.50" borderWidth="1px" borderColor="teal.200" rounded="md">
                        <Text fontSize="xs" fontWeight="semibold" color="teal.700" mb={1} textTransform="uppercase" letterSpacing="wide">First Stop</Text>
                        <Text fontSize="sm" fontWeight="medium">{occurrences[0].job?.property?.displayName}</Text>
                        <Box fontSize="xs">
                          <MapLink address={[
                            occurrences[0].job?.property?.street1,
                            occurrences[0].job?.property?.city,
                            occurrences[0].job?.property?.state,
                          ].filter(Boolean).join(", ")} />
                        </Box>
                        {(occurrences[0] as any).jobType && (
                          <Text fontSize="xs" color="fg.muted" mt={0.5}>{jobTypeLabel((occurrences[0] as any).jobType)}</Text>
                        )}
                      </Box>
                    )}

                    {tasks.length > 0 && (
                      <Box p={3} bg="blue.50" rounded="md">
                        <Text fontSize="xs" fontWeight="semibold" color="blue.700" mb={1}>Don't forget your {tasks.length} task{tasks.length !== 1 ? "s" : ""} for today</Text>
                        {tasks.map((t) => (
                          <Text key={t.id} fontSize="xs" color="blue.600">• {t.title}</Text>
                        ))}
                      </Box>
                    )}

                    <Box p={3} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
                      <Text fontSize="xs" fontWeight="medium" color="yellow.700" mb={1}>Reminders</Text>
                      <Text fontSize="xs" color="yellow.600">• Start each job when you arrive and complete it when you're done</Text>
                      <Text fontSize="xs" color="yellow.600">• Upload a few photos of the finished work — great results help build trust with clients</Text>
                    </Box>
                  </VStack>
                </Dialog.Body>
                <Dialog.Footer>
                  <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                    <Button variant="ghost" size="sm" onClick={() => setStep(vehicleStepShown ? "vehicle" : "route")}>Back</Button>
                    <HStack gap={2} wrap="wrap">
                      <Button variant="ghost" size="sm" onClick={() => { setStep("idle"); onDone(); }}>
                        Close
                      </Button>
                      <Button
                        size="sm"
                        colorPalette="green"
                        onClick={() => {
                          setStep("idle");
                          onDone();
                          const firstOcc = occurrences[0];
                          // Set date to today and navigate to Jobs tab highlighting the first job
                          try { localStorage.setItem("seedlings_beginWorkday_jobsDate", today); } catch {}
                          window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "jobs" } }));
                          if (firstOcc) {
                            setTimeout(() => {
                              window.dispatchEvent(new CustomEvent("remindersToJobsTabSearch:run", {
                                detail: { entityId: `${firstOcc.id}|${firstOcc.startAt ?? ""}` },
                              }));
                            }, 200);
                          }
                        }}
                      >
                        {/* "Go to", not "Start" — this button navigates and
                            nothing more. It filters the Jobs tab down to the
                            first occurrence and expands its card; no status
                            changes and no API call. The worker still taps
                            Start on the card itself. The old label promised
                            the workday had begun. */}
                        Go to First Job
                      </Button>
                    </HStack>
                  </HStack>
                </Dialog.Footer>
              </>
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
