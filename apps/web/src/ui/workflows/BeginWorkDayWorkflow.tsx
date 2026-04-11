"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { CheckCircle, MapPin, Wrench } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { type WorkerOccurrence } from "@/src/lib/types";
import { fmtDate, bizDateKey, clientLabel, jobTypeLabel } from "@/src/lib/lib";
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
};

export default function BeginWorkDayWorkflow({ active, onDone, myId }: Props) {
  const today = bizDateKey(new Date());

  const [step, setStep] = useState<"idle" | "loading" | "overview" | "route" | "equipment" | "ready" | "no-jobs">("idle");
  const [occurrences, setOccurrences] = useState<WorkerOccurrence[]>([]);
  const [equipment, setEquipment] = useState<any[]>([]);
  const [equipmentLoaded, setEquipmentLoaded] = useState(false);

  async function loadTodaysJobs(): Promise<WorkerOccurrence[]> {
    try {
      // Load today + any overdue
      const list = await apiGet<WorkerOccurrence[]>(`/api/occurrences?to=${today}`);
      const myJobs = (Array.isArray(list) ? list : []).filter((occ) => {
        if (occ.workflow === "TASK") return false; // tasks shown separately
        const isAssigned = (occ.assignees ?? []).some((a) => a.userId === myId);
        if (!isAssigned) return false;
        const isActive = occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS";
        return isActive;
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
      const myTasks = (Array.isArray(list) ? list : []).filter((occ) =>
        occ.workflow === "TASK" &&
        occ.status === "SCHEDULED" &&
        (occ.assignees ?? []).some((a) => a.userId === myId)
      );
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
          <Dialog.Content maxW="md" mx={{ base: "3", md: "4" }} w="full">
            {/* Loading */}
            {step === "loading" && (
              <>
                <Dialog.Header><Dialog.Title>Begin Work Day</Dialog.Title></Dialog.Header>
                <Dialog.Body>
                  <Box py={8} textAlign="center"><Spinner size="lg" /><Text mt={2} color="fg.muted">Loading today's schedule...</Text></Box>
                </Dialog.Body>
              </>
            )}

            {/* No jobs */}
            {step === "no-jobs" && (
              <>
                <Dialog.Header><Dialog.Title>Begin Work Day</Dialog.Title></Dialog.Header>
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
                        return (
                          <Card.Root key={occ.id} variant="outline" borderColor={isOverdue ? "red.200" : isInProgress ? "blue.200" : "gray.200"} bg={isOverdue ? "red.50" : isInProgress ? "blue.50" : undefined}>
                            <Card.Body py="2" px="3">
                              <HStack justify="space-between" align="start" gap={2}>
                                <VStack align="start" gap={0.5} flex="1" minW={0}>
                                  <Text fontSize="sm" fontWeight="medium">
                                    {occ.job?.property?.displayName}
                                    {occ.job?.property?.client?.displayName && (
                                      <Text as="span" color="fg.muted" fontWeight="normal"> — {clientLabel(occ.job.property.client.displayName)}</Text>
                                    )}
                                  </Text>
                                  <HStack gap={2} fontSize="xs" wrap="wrap">
                                    {isOverdue && <StatusBadge status="Overdue" palette="red" variant="solid" />}
                                    {isInProgress && <StatusBadge status="In Progress" palette="blue" variant="solid" />}
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
                    <Button variant="outline" size="sm" onClick={() => { goToTab("jobs", "overview"); }}>
                      View in Jobs
                    </Button>
                    <HStack gap={2} wrap="wrap">
                      <Button variant="ghost" size="sm" onClick={() => { setStep("idle"); onDone(); }}>Cancel</Button>
                      <Button size="sm" colorPalette="green" onClick={() => setStep("route")}>
                        Route
                      </Button>
                    </HStack>
                  </HStack>
                </Dialog.Footer>
              </>
            )}

            {/* Step 2: Route */}
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
                    <Button variant="ghost" size="sm" onClick={() => setStep("overview")}>Back</Button>
                    <HStack gap={2} wrap="wrap">
                      <Button variant="outline" size="sm" colorPalette="blue" onClick={() => goToTab("routes", "route")}>
                        Open Full Route
                      </Button>
                      <Button size="sm" colorPalette="green" onClick={() => setStep("equipment")}>
                        Equipment
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
                            {eq.dailyRate != null && (
                              <Text fontSize="xs" fontWeight="medium" color="orange.700" flexShrink={0}>${eq.dailyRate.toFixed(2)}/day</Text>
                            )}
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
                    <Button variant="ghost" size="sm" onClick={() => setStep("route")}>Back</Button>
                    <HStack gap={2} wrap="wrap">
                      <Button variant="outline" size="sm" colorPalette="orange" onClick={() => goToTab("equipment", "equipment")}>
                        Manage Equipment
                      </Button>
                      <Button size="sm" colorPalette="green" onClick={() => setStep("ready")}>
                        All Set
                      </Button>
                    </HStack>
                  </HStack>
                </Dialog.Footer>
              </>
            )}

            {/* Step 4: Ready */}
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
                    <Button variant="ghost" size="sm" onClick={() => setStep("equipment")}>Back</Button>
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
                        Start First Job
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
