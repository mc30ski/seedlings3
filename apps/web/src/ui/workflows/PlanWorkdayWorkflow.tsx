"use client";

import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
  Badge,
  Spinner,
} from "@chakra-ui/react";
import { apiGet, apiPost } from "@/src/lib/api";
import { type WorkerOccurrence } from "@/src/lib/types";
import { fmtDate, bizDateKey, clientLabel } from "@/src/lib/lib";
import { MapLink } from "@/src/ui/helpers/Link";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

const STORAGE_KEY = "seedlings_planWorkday";

type PersistedState = {
  date: string;       // YYYY-MM-DD of when workflow was started
  targetDate: string;  // the date being planned for
  step: string;        // current step name
  confirmedIds: string[];
  releasedIds: string[];
  currentIndex: number; // which occurrence we're on in the confirm step
};

function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (data.date !== today) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return data;
  } catch { return null; }
}

function saveState(state: PersistedState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function clearState() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

type Props = {
  active: boolean;
  onDone: () => void;
  myId?: string;
  defaultTargetDate?: string;
};

export default function PlanWorkdayWorkflow({ active, onDone, myId, defaultTargetDate }: Props) {
  const today = bizDateKey(new Date());
  const tomorrow = bizDateKey(new Date(Date.now() + 86400000));

  const [step, setStep] = useState<"idle" | "choose-date" | "routes" | "loading" | "confirm-jobs" | "equipment" | "done">("idle");
  const [targetDate, setTargetDate] = useState(defaultTargetDate ?? tomorrow);
  const [occurrences, setOccurrences] = useState<WorkerOccurrence[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const [releasedIds, setReleasedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Restore persisted state on mount
  useEffect(() => {
    if (!active) return;
    const saved = loadState();
    if (saved && saved.step === "routes") {
      setTargetDate(saved.targetDate);
      setStep("routes");
    } else if (saved && saved.step === "equipment") {
      setTargetDate(saved.targetDate);
      setConfirmedIds(saved.confirmedIds);
      setReleasedIds(saved.releasedIds);
      setStep("equipment");
    } else if (saved && saved.step !== "idle" && saved.step !== "done") {
      setTargetDate(saved.targetDate);
      setConfirmedIds(saved.confirmedIds);
      setReleasedIds(saved.releasedIds);
      setCurrentIndex(saved.currentIndex);
      // Reload occurrences then resume
      loadOccurrences(saved.targetDate).then((occs) => {
        if (occs.length > 0 && saved.currentIndex < occs.length) {
          setStep("confirm-jobs");
        } else {
          setStep("done");
        }
      });
    } else if (saved?.step === "done") {
      setStep("done");
      setTargetDate(saved.targetDate);
      setConfirmedIds(saved.confirmedIds);
      setReleasedIds(saved.releasedIds);
    } else {
      // Fresh start — let user pick the date
      setStep("choose-date");
    }
  }, [active]);

  async function loadOccurrences(date: string): Promise<WorkerOccurrence[]> {
    try {
      const list = await apiGet<WorkerOccurrence[]>(`/api/occurrences?from=${date}&to=${date}`);
      const myOccs = (Array.isArray(list) ? list : []).filter(
        (occ) => (occ.assignees ?? []).some((a) => a.userId === myId) &&
          occ.status === "SCHEDULED"
      );
      setOccurrences(myOccs);
      return myOccs;
    } catch {
      setOccurrences([]);
      return [];
    }
  }

  function persist(overrides?: Partial<PersistedState>) {
    saveState({
      date: today,
      targetDate,
      step: step,
      confirmedIds,
      releasedIds,
      currentIndex,
      ...overrides,
    });
  }

  function advance() {
    setCopied(false);
    const nextIdx = currentIndex + 1;
    if (nextIdx >= occurrences.length) {
      setStep("equipment");
      persist({ step: "equipment", currentIndex: nextIdx });
    } else {
      setCurrentIndex(nextIdx);
      persist({ currentIndex: nextIdx });
    }
  }

  async function confirmJob() {
    const occ = occurrences[currentIndex];
    if (!occ) return;
    setConfirmedIds((prev) => {
      const next = [...prev, occ.id];
      persist({ confirmedIds: next });
      return next;
    });
    advance();
  }

  async function releaseJob() {
    const occ = occurrences[currentIndex];
    if (!occ) return;
    setBusy(true);
    try {
      await apiPost(`/api/occurrences/${occ.id}/unclaim`, {});
      setReleasedIds((prev) => {
        const next = [...prev, occ.id];
        persist({ releasedIds: next });
        return next;
      });
      publishInlineMessage({ type: "SUCCESS", text: "Job released." });
    } catch (err: any) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Release failed.", err) });
    }
    setBusy(false);
    advance();
  }

  function goBack() {
    setCopied(false);
    if (currentIndex > 0) {
      const prevIdx = currentIndex - 1;
      setCurrentIndex(prevIdx);
      persist({ currentIndex: prevIdx });
    }
  }

  function handleClose() {
    clearState();
    try { localStorage.removeItem("seedlings_planWorkday_paused"); } catch {}
    setStep("idle");
    setCurrentIndex(0);
    setConfirmedIds([]);
    setReleasedIds([]);
    onDone();
  }

  function generateMessage(occ: WorkerOccurrence): string {
    const prop = occ.job?.property;
    const dateStr = occ.startAt ? fmtDate(occ.startAt) : "the scheduled date";

    // Get client's first name from displayName (take first word)
    const clientDisplay = prop?.client?.displayName ?? "";
    const firstName = clientDisplay.split(" ")[0];
    const greeting = firstName ? `Hi ${firstName}!` : "Hi!";

    // Check if this client has multiple properties in the current occurrence list
    const clientId = prop?.client?.id;
    const clientPropertyCount = clientId
      ? occurrences.filter((o) => o.job?.property?.client?.id === clientId).length
      : 0;

    const address = [prop?.street1, prop?.city, prop?.state].filter(Boolean).join(", ");
    const locationNote = clientPropertyCount > 1 && address
      ? ` at ${address}`
      : "";

    return `${greeting} This is Seedlings Lawn Care. Just confirming we'll be out${locationNote} on ${dateStr}. Please let us know if anything has changed or if there's anything we should be aware of. Thanks!`;
  }

  if (!active || step === "idle") return null;

  function startWithDate() {
    setStep("routes");
    persist({ step: "routes", targetDate });
  }

  function goToConfirmJobs() {
    setStep("loading");
    persist({ step: "loading", targetDate });
    loadOccurrences(targetDate).then((occs) => {
      if (occs.length > 0) {
        setStep("confirm-jobs");
        persist({ step: "confirm-jobs", targetDate });
      } else {
        setStep("equipment");
        persist({ step: "equipment", targetDate });
      }
    });
  }

  if (step === "choose-date") {
    const dateLabel = targetDate === today ? "Today" : targetDate === tomorrow ? "Tomorrow" : null;
    return (
      <Dialog.Root open onOpenChange={(e) => { if (!e.open) { onDone(); } }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title fontSize="md">Plan Work Day</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
                    <Text fontSize="xs" color="yellow.700">This feature is a work in progress and will change substantially. Use for preview purposes only.</Text>
                  </Box>
                  <Text fontSize="sm" color="fg.muted">
                    Choose which day to plan. We'll go through your claimed jobs so you can confirm or release them.
                  </Text>
                  <Box>
                    <HStack mb={1} gap={2}>
                      <Text fontSize="xs" fontWeight="medium">Date</Text>
                      {dateLabel && <Badge size="sm" colorPalette="blue" variant="subtle">{dateLabel}</Badge>}
                    </HStack>
                    <input
                      type="date"
                      value={targetDate}
                      min={today}
                      onChange={(e) => setTargetDate(e.target.value)}
                      style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "14px" }}
                    />
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full" gap={2}>
                  <Button size="sm" variant="ghost" colorPalette="red" onClick={handleClose}>Cancel</Button>
                  <Button size="sm" colorPalette="blue" onClick={startWithDate}>Start</Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    );
  }

  if (step === "routes") {
    return (
      <Dialog.Root open onOpenChange={(e) => { if (!e.open) { persist({ step: "routes" }); onDone(); } }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <VStack align="start" gap={1} w="full">
                  <Dialog.Title fontSize="md">Review & Optimize Your Route</Dialog.Title>
                  <Text fontSize="xs" color="fg.muted">
                    Planning for {fmtDate(targetDate + "T12:00:00Z")}
                  </Text>
                </VStack>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box p={3} bg="blue.50" rounded="md" borderWidth="1px" borderColor="blue.200">
                    <Text fontSize="sm" color="blue.800">
                      Use the <strong>Routes</strong> feature to review your claimed jobs, get suggestions on potential jobs to add to fill out your day, and generate the most efficient route. When you're done, use the <strong>"Return to Workflow"</strong> button at the top of the Routes tab to come back and continue.
                    </Text>
                  </Box>
                  <Button
                    colorPalette="blue"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // Set the routes tab date to match the workflow date
                      try { localStorage.setItem("seedlings_preview_targetDate", JSON.stringify(targetDate)); } catch {}
                      // Persist workflow state so it resumes when coming back
                      persist({ step: "routes" });
                      // Signal that workflow is paused for routes
                      try { localStorage.setItem("seedlings_planWorkday_paused", "1"); } catch {}
                      setStep("idle");
                      onDone();
                      window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "routes" } }));
                    }}
                  >
                    Open Routes
                  </Button>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="space-between" w="full">
                  <Button
                    size="sm"
                    variant="ghost"
                    colorPalette="gray"
                    onClick={() => { setStep("choose-date"); persist({ step: "choose-date" }); }}
                  >
                    Back
                  </Button>
                  <HStack gap={2}>
                    <Button size="sm" variant="ghost" colorPalette="red" onClick={handleClose}>Cancel</Button>
                    <Button size="sm" colorPalette="blue" onClick={goToConfirmJobs}>Next</Button>
                  </HStack>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    );
  }

  if (step === "loading") {
    return (
      <Dialog.Root open onOpenChange={() => {}}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="6">
              <Box textAlign="center" py={6}>
                <Spinner size="lg" />
                <Text mt={3} color="fg.muted">Loading your jobs...</Text>
              </Box>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    );
  }

  if (step === "equipment") {
    return (
      <Dialog.Root open onOpenChange={(e) => { if (!e.open) { persist({ step: "equipment" }); onDone(); } }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <VStack align="start" gap={1} w="full">
                  <Dialog.Title fontSize="md">Equipment for the Day</Dialog.Title>
                  <Text fontSize="xs" color="fg.muted">
                    Planning for {fmtDate(targetDate + "T12:00:00Z")}
                  </Text>
                </VStack>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box p={3} bg="orange.50" rounded="md" borderWidth="1px" borderColor="orange.200">
                    <Text fontSize="sm" color="orange.800">
                      Do you need to reserve any equipment for the day? Use the <strong>Equipment</strong> tab to browse available equipment and make reservations. When you're done, use the <strong>"Return to Workflow"</strong> button at the top of the Equipment tab to come back and continue.
                    </Text>
                  </Box>
                  <Button
                    colorPalette="orange"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      persist({ step: "equipment" });
                      try { localStorage.setItem("seedlings_planWorkday_paused", "1"); } catch {}
                      setStep("idle");
                      onDone();
                      window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "equipment" } }));
                    }}
                  >
                    Open Equipment
                  </Button>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="space-between" w="full">
                  <Button
                    size="sm"
                    variant="ghost"
                    colorPalette="gray"
                    onClick={() => {
                      // Go back to confirm-jobs (reload them)
                      setStep("loading");
                      persist({ step: "loading" });
                      loadOccurrences(targetDate).then((occs) => {
                        if (occs.length > 0) {
                          setCurrentIndex(0);
                          setStep("confirm-jobs");
                          persist({ step: "confirm-jobs", currentIndex: 0 });
                        } else {
                          setStep("equipment");
                          persist({ step: "equipment" });
                        }
                      });
                    }}
                  >
                    Back
                  </Button>
                  <HStack gap={2}>
                    <Button size="sm" variant="ghost" colorPalette="red" onClick={handleClose}>Cancel</Button>
                    <Button
                      size="sm"
                      colorPalette="blue"
                      onClick={() => {
                        setStep("done");
                        persist({ step: "done" });
                      }}
                    >
                      Finish
                    </Button>
                  </HStack>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    );
  }

  if (step === "done") {
    return (
      <Dialog.Root open onOpenChange={() => handleClose()}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Plan Complete</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="start" gap={2}>
                  <Text fontSize="sm">
                    Confirmed: <strong>{confirmedIds.length}</strong> job{confirmedIds.length !== 1 ? "s" : ""}
                  </Text>
                  <Text fontSize="sm">
                    Released: <strong>{releasedIds.length}</strong> job{releasedIds.length !== 1 ? "s" : ""}
                  </Text>
                  {occurrences.length === 0 && (
                    <Text fontSize="sm" color="fg.muted">No claimed jobs found for {fmtDate(targetDate + "T12:00:00Z")}.</Text>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button onClick={handleClose}>Done</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    );
  }

  // confirm-jobs step
  const occ = occurrences[currentIndex];
  if (!occ) {
    // Edge case — advance to done
    setStep("done");
    return null;
  }

  const prop = occ.job?.property;
  const message = generateMessage(occ);
  const progress = `${currentIndex + 1} of ${occurrences.length}`;

  return (
    <Dialog.Root
      open
      onOpenChange={(e) => { if (!e.open) { persist(); onDone(); } }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <VStack align="start" gap={1} w="full">
                <HStack justify="space-between" w="full">
                  <Dialog.Title fontSize="md">Confirm Job</Dialog.Title>
                  <Badge colorPalette="blue" variant="subtle">{progress}</Badge>
                </HStack>
                <Text fontSize="xs" color="fg.muted">
                  Planning for {fmtDate(targetDate + "T12:00:00Z")}
                </Text>
              </VStack>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="start" gap={3}>
                {/* Job details */}
                <Box w="full" p={3} bg="gray.50" rounded="md">
                  <Text fontWeight="semibold" fontSize="sm">
                    {prop?.displayName}
                    {prop?.client?.displayName && (
                      <> — {clientLabel(prop.client.displayName)}</>
                    )}
                  </Text>
                  <Box fontSize="xs" mt={1}>
                    <MapLink address={[prop?.street1, prop?.city, prop?.state].filter(Boolean).join(", ")} />
                  </Box>
                  {occ.price != null && (
                    <Badge colorPalette="green" variant="solid" fontSize="xs" mt={1} borderRadius="full" px="2">
                      ${occ.price.toFixed(2)}
                    </Badge>
                  )}
                  {occ.estimatedMinutes != null && (
                    <Text fontSize="xs" color="fg.muted" mt={1}>~{occ.estimatedMinutes} min</Text>
                  )}
                  {occ.notes && (
                    <Text fontSize="xs" color="fg.muted" mt={1}>{occ.notes}</Text>
                  )}
                </Box>

                {/* Copy/paste message */}
                <Box w="full">
                  <HStack justify="space-between" mb={1}>
                    <Text fontSize="xs" fontWeight="medium" color="fg.muted">Message to client:</Text>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(message);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      style={{
                        fontSize: "12px",
                        color: copied ? "#38a169" : "#3182ce",
                        background: copied ? "#f0fff4" : "none",
                        border: copied ? "1px solid #38a169" : "none",
                        borderRadius: "4px",
                        cursor: "pointer",
                        padding: "2px 8px",
                        fontWeight: copied ? 600 : 400,
                        transition: "all 0.15s",
                      }}
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </HStack>
                  <Box
                    p={3}
                    bg="blue.50"
                    rounded="md"
                    fontSize="xs"
                    color="blue.800"
                    whiteSpace="pre-wrap"
                    borderWidth="1px"
                    borderColor="blue.200"
                  >
                    {message}
                  </Box>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <VStack w="full" gap={2}>
                <HStack justify="center" w="full" gap={2}>
                  <Button
                    size="sm"
                    variant="outline"
                    colorPalette="red"
                    onClick={releaseJob}
                    disabled={busy}
                  >
                    {busy ? "Releasing..." : "Release"}
                  </Button>
                  <Button
                    size="sm"
                    colorPalette="green"
                    onClick={confirmJob}
                  >
                    Confirm
                  </Button>
                </HStack>
                <HStack justify="space-between" w="full">
                  <Button
                    size="sm"
                    variant="ghost"
                    colorPalette="gray"
                    onClick={goBack}
                    disabled={currentIndex === 0}
                  >
                    Back
                  </Button>
                  <HStack gap={2}>
                    <Button size="sm" variant="ghost" colorPalette="red" onClick={handleClose}>Cancel</Button>
                    <Button size="sm" variant="ghost" colorPalette="blue" onClick={advance}>
                      {currentIndex === occurrences.length - 1 ? "Finish" : "Next"}
                    </Button>
                  </HStack>
                </HStack>
              </VStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
