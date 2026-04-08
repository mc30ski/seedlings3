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

function loadState(todayKey: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.date !== todayKey) {
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

/** Inline component to show current equipment reservations */
function EquipmentSummary({ myId, onCostLoaded }: { myId?: string; onCostLoaded?: (cost: number) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    apiGet<any[]>("/api/equipment/mine")
      .then((list) => {
        const eq = Array.isArray(list) ? list : [];
        setItems(eq);
        setLoaded(true);
        const totalCost = eq.reduce((sum, e) => sum + (e.dailyRate ?? 0), 0);
        onCostLoaded?.(totalCost);
      })
      .catch(() => setLoaded(true));
  }, []);

  return (
    <Box p={3} bg="orange.50" rounded="md">
      <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2} textTransform="uppercase" letterSpacing="wide">Equipment Reserved</Text>
      {!loaded ? (
        <Spinner size="sm" />
      ) : items.length === 0 ? (
        <Text fontSize="sm" color="fg.muted">No equipment reserved.</Text>
      ) : (
        <VStack align="stretch" gap={1}>
          {items.map((eq) => (
            <HStack key={eq.id} justify="space-between" fontSize="sm">
              <Text>{eq.shortDesc || eq.type || "Equipment"}{eq.brand ? ` — ${eq.brand}` : ""}{eq.model ? ` ${eq.model}` : ""}</Text>
              {eq.dailyRate != null && (
                <Text fontWeight="medium" color="orange.700" flexShrink={0}>${eq.dailyRate.toFixed(2)}/day</Text>
              )}
            </HStack>
          ))}
        </VStack>
      )}
    </Box>
  );
}

type Props = {
  active: boolean;
  onDone: () => void;
  myId?: string;
  defaultTargetDate?: string;
  trainee?: boolean;
};

export default function PlanWorkdayWorkflow({ active, onDone, myId, defaultTargetDate, trainee }: Props) {
  const today = bizDateKey(new Date());
  const tomorrow = bizDateKey(new Date(Date.now() + 86400000));

  const [step, setStep] = useState<"idle" | "choose-date" | "routes" | "loading" | "confirm-jobs" | "no-jobs" | "equipment" | "summary" | "done">("idle");
  const [targetDate, setTargetDate] = useState(defaultTargetDate ?? tomorrow);
  const [occurrences, setOccurrences] = useState<WorkerOccurrence[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const [releasedIds, setReleasedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editableMessage, setEditableMessage] = useState("");
  const [contactMap, setContactMap] = useState<Map<string, { phone?: string | null; email?: string | null; firstName?: string }>>(new Map());
  const [propertyPhotos, setPropertyPhotos] = useState<Map<string, { id: string; url: string }[]>>(new Map());
  const [viewPhotoIndex, setViewPhotoIndex] = useState<number>(-1);
  const [viewPhotoList, setViewPhotoList] = useState<{ id: string; url: string }[]>([]);
  const [marginPercent, setMarginPercent] = useState(20);
  const [equipmentCost, setEquipmentCost] = useState(0);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Restore persisted state on mount
  useEffect(() => {
    if (!active) return;
    const saved = loadState(today);
    if (saved && saved.step === "routes") {
      setTargetDate(saved.targetDate);
      setStep("routes");
    } else if (saved && saved.step === "equipment") {
      setTargetDate(saved.targetDate);
      setConfirmedIds(saved.confirmedIds);
      setReleasedIds(saved.releasedIds);
      setStep("equipment");
      loadOccurrences(saved.targetDate); // reload in case jobs changed while on equipment tab
    } else if (saved && saved.step === "summary") {
      setTargetDate(saved.targetDate);
      setConfirmedIds(saved.confirmedIds);
      setReleasedIds(saved.releasedIds);
      setStep("summary");
      loadOccurrences(saved.targetDate); // reload for fresh summary
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
    } else if (trainee) {
      // Trainee mode — show date picker, then go to summary
      setStep("choose-date");
    } else {
      // Fresh start — find next day with jobs, defaulting to tomorrow
      setStep("loading");
      apiGet<WorkerOccurrence[]>(`/api/occurrences?from=${tomorrow}`)
        .then((list) => {
          const myOccs = (Array.isArray(list) ? list : []).filter(
            (occ) => (occ.assignees ?? []).some((a) => a.userId === myId) &&
              (occ.status === "SCHEDULED" || occ.status === "IN_PROGRESS")
          );
          if (myOccs.length > 0) {
            // Find the earliest date
            const dates = myOccs
              .map((o) => o.startAt ? bizDateKey(o.startAt) : null)
              .filter(Boolean) as string[];
            dates.sort();
            const nextDate = dates[0] ?? tomorrow;
            setTargetDate(nextDate);
          } else {
            setTargetDate(tomorrow);
          }
          setStep("choose-date");
        })
        .catch(() => {
          setTargetDate(tomorrow);
          setStep("choose-date");
        });
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

      // Fetch margin settings
      apiGet<any[]>("/api/settings")
        .then((list) => {
          if (!Array.isArray(list)) return;
          const c = list.find((r: any) => r.key === "CONTRACTOR_PLATFORM_FEE_PERCENT");
          const m = list.find((r: any) => r.key === "EMPLOYEE_BUSINESS_MARGIN_PERCENT");
          const pct = Math.max(Number(c?.value ?? 0), Number(m?.value ?? 0));
          if (pct > 0) setMarginPercent(pct);
        })
        .catch(() => {});

      // Fetch primary contact for each unique client
      const clientIds = [...new Set(myOccs.map((o) => o.job?.property?.client?.id).filter(Boolean))] as string[];
      const cMap = new Map<string, { phone?: string | null; email?: string | null; firstName?: string }>();
      await Promise.all(
        clientIds.map(async (cid) => {
          try {
            const client = await apiGet<any>(`/api/clients/${cid}`);
            const contacts = Array.isArray(client?.contacts) ? client.contacts : [];
            const primary = contacts.find((c: any) => c.isPrimary) ?? contacts[0];
            if (primary) {
              cMap.set(cid, {
                phone: primary.phone ?? primary.normalizedPhone ?? null,
                email: primary.email ?? null,
                firstName: primary.firstName ?? null,
              });
            }
          } catch {}
        })
      );
      setContactMap(cMap);

      // Fetch last photos for each property
      const propIds = [...new Set(myOccs.map((o) => o.job?.property?.id).filter(Boolean))] as string[];
      if (propIds.length > 0) {
        try {
          const props = await apiGet<any[]>("/api/properties?limit=500");
          const pMap = new Map<string, { id: string; url: string }[]>();
          for (const p of (Array.isArray(props) ? props : [])) {
            if (propIds.includes(p.id) && p.lastPhotos?.length) {
              pMap.set(p.id, p.lastPhotos);
            }
          }
          setPropertyPhotos(pMap);
        } catch {}
      }

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
    setEditableMessage("");
    setViewPhotoIndex(-1);
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
    setEditableMessage("");
    setViewPhotoIndex(-1);
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

  function getSendInfo(occ: WorkerOccurrence, customMessage?: string) {
    const clientId = occ.job?.property?.client?.id;
    const contact = clientId ? contactMap.get(clientId) : null;
    const msg = customMessage || generateMessage(occ);
    const encoded = encodeURIComponent(msg);

    if (contact?.phone) {
      // Clean phone number — keep digits and leading +
      const phone = contact.phone.replace(/[^\d+]/g, "");
      return {
        method: "sms" as const,
        label: `Text ${contact.firstName || "client"}`,
        url: `sms:${phone}${/iPhone|iPad|iPod/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "") ? "&" : "?"}body=${encoded}`,
        available: true,
      };
    }
    if (contact?.email) {
      return {
        method: "email" as const,
        label: `Email ${contact.firstName || "client"}`,
        url: `mailto:${contact.email}?subject=${encodeURIComponent("Seedlings Lawn Care — Confirmation")}&body=${encoded}`,
        available: true,
      };
    }
    return {
      method: null,
      label: "No contact info",
      url: "",
      available: false,
    };
  }

  if (!active || step === "idle") return null;

  function startWithDate() {
    setStep("loading");
    loadOccurrences(targetDate).then((occs) => {
      if (trainee) {
        // Trainee — skip to summary directly
        setStep("summary");
        persist({ step: "summary", targetDate });
      } else if (occs.length > 0) {
        setStep("routes");
        persist({ step: "routes", targetDate });
      } else {
        setStep("no-jobs");
        persist({ step: "no-jobs", targetDate });
      }
    });
  }

  function goToConfirmJobs() {
    setStep("loading");
    persist({ step: "loading", targetDate });
    loadOccurrences(targetDate).then((occs) => {
      if (occs.length > 0) {
        setStep("confirm-jobs");
        persist({ step: "confirm-jobs", targetDate });
      } else {
        setStep("no-jobs");
        persist({ step: "no-jobs", targetDate });
      }
    });
  }

  if (step === "choose-date") {
    const dateLabel = targetDate === today ? "Today" : targetDate === tomorrow ? "Tomorrow" : null;
    return (
      <Dialog.Root open onOpenChange={(e) => { if (!e.open) { onDone(); } }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title fontSize="md">Plan Work Day</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Text fontSize="sm" color="fg.muted">
                    {trainee
                      ? "Choose a day to view your job summary."
                      : "Choose which day to plan. We'll go through your claimed jobs so you can confirm or release them."}
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
          <Dialog.Positioner style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
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
                      // Set the routes tab date and clear previous results
                      try {
                        localStorage.setItem("seedlings_preview_targetDate", JSON.stringify(targetDate));
                        localStorage.removeItem("preview_routeResults");
                      } catch {}
                      // Persist workflow state so it resumes when coming back
                      persist({ step: "routes" });
                      // Signal that workflow is paused for routes
                      try { localStorage.setItem("seedlings_planWorkday_paused", "1"); } catch {}
                      setStep("idle");
                      onDone();
                      window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "routes", autoAnalyze: true } }));
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
          <Dialog.Positioner style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
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
          <Dialog.Positioner style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
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
                  {(targetDate === today || targetDate === tomorrow) ? (
                    <>
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
                    </>
                  ) : (
                    <Box p={3} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                      <Text fontSize="sm" color="fg.muted">
                        Equipment reservations are only available for today or tomorrow. You can reserve equipment by visiting the Equipment tab the day before, or by re-running this workflow closer to the date.
                      </Text>
                    </Box>
                  )}
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
                        setStep("summary");
                        persist({ step: "summary" });
                        loadOccurrences(targetDate); // reload for fresh summary
                      }}
                    >
                      Next
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

  if (step === "no-jobs") {
    return (
      <Dialog.Root open onOpenChange={(e) => { if (!e.open) handleClose(); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title fontSize="md">No Jobs Found</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm" color="fg.muted">
                  You have no claimed jobs for {fmtDate(targetDate + "T12:00:00Z")}. Use the Routes tab to find and claim jobs, or ask your administrator to assign work to you.
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="space-between" w="full">
                  <Button
                    size="sm"
                    variant="ghost"
                    colorPalette="gray"
                    onClick={() => {
                      try {
                        localStorage.setItem("seedlings_preview_targetDate", JSON.stringify(targetDate));
                        localStorage.removeItem("preview_routeResults");
                      } catch {}
                      handleClose();
                      window.dispatchEvent(new CustomEvent("navigate:workerTab", { detail: { tab: "routes", autoAnalyze: true } }));
                    }}
                  >
                    Go to Routes
                  </Button>
                  <Button size="sm" colorPalette="blue" onClick={handleClose}>Done</Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    );
  }

  if (step === "summary") {
    // Compute summary from current occurrences (includes any changes made during workflow or outside)
    const activeOccs = occurrences.filter((o) => !releasedIds.includes(o.id));
    const totalCustomerCost = activeOccs.reduce((sum, o) => sum + (o.price ?? 0), 0);
    const totalExpenses = activeOccs.reduce((sum, o) => sum + (o.expenses ?? []).reduce((s, e) => s + e.cost, 0), 0);
    const totalEstMinutes = activeOccs.reduce((sum, o) => sum + (o.estimatedMinutes ?? 60), 0);

    return (
      <Dialog.Root open onOpenChange={(e) => { if (!e.open) { persist({ step: "summary" }); onDone(); } }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <VStack align="start" gap={1} w="full">
                  <Dialog.Title fontSize="md">Day Summary</Dialog.Title>
                  <Text fontSize="xs" color="fg.muted">
                    {fmtDate(targetDate + "T12:00:00Z")}
                  </Text>
                </VStack>
              </Dialog.Header>
              <Dialog.Body py="2">
                <VStack align="stretch" gap={3}>
                  {/* Jobs */}
                  <Box p={3} bg="gray.50" rounded="md">
                    <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2} textTransform="uppercase" letterSpacing="wide">Jobs</Text>
                    {activeOccs.length === 0 ? (
                      <Text fontSize="sm" color="fg.muted">No jobs for this day.</Text>
                    ) : (
                      <VStack align="stretch" gap={1}>
                        {activeOccs.map((o) => (
                          <HStack key={o.id} justify="space-between" fontSize="sm">
                            <Text>
                              {o.job?.property?.displayName}
                              {o.job?.property?.client?.displayName && (
                                <span style={{ color: "var(--chakra-colors-fg-muted)" }}> — {o.job.property.client.displayName}</span>
                              )}
                            </Text>
                            <Text fontWeight="medium" flexShrink={0}>
                              {o.price != null ? `$${o.price.toFixed(2)}` : "—"}
                            </Text>
                          </HStack>
                        ))}
                      </VStack>
                    )}
                  </Box>

                  {/* Released */}
                  {releasedIds.length > 0 && (
                    <Box p={3} bg="red.50" rounded="md">
                      <Text fontSize="xs" fontWeight="semibold" color="red.600" mb={1}>Released: {releasedIds.length} job{releasedIds.length !== 1 ? "s" : ""}</Text>
                    </Box>
                  )}

                  {/* Equipment */}
                  <EquipmentSummary myId={myId} onCostLoaded={setEquipmentCost} />

                  {/* Time */}
                  <Box p={3} bg="green.50" rounded="md">
                    <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2} textTransform="uppercase" letterSpacing="wide">Time</Text>
                    {(() => {
                      const assumedCount = activeOccs.filter((o) => !o.estimatedMinutes).length;
                      let bufferPct = 10;
                      try {
                        const stored = localStorage.getItem("seedlings_preview_buffer");
                        if (stored) bufferPct = JSON.parse(stored);
                      } catch {}
                      const setupMins = Math.round(totalEstMinutes * bufferPct / 100);
                      let driveMins = 0;
                      try {
                        const cached = localStorage.getItem("preview_routeResults");
                        if (cached) {
                          const parsed = JSON.parse(cached);
                          driveMins = parsed?.routing?.totalDriveMinutes ?? 0;
                        }
                      } catch {}
                      const totalMins = totalEstMinutes + setupMins + driveMins;
                      const fmtDur = (mins: number) => {
                        if (mins < 60) return `${mins}m`;
                        const h = Math.floor(mins / 60);
                        const m = mins % 60;
                        return m > 0 ? `${h}h ${m}m` : `${h}h`;
                      };
                      return (
                        <Box display="grid" gridTemplateColumns="auto 1fr" gap={1} rowGap={1.5} fontSize="sm">
                          <Text color="green.700">Jobs:</Text>
                          <Text fontWeight="semibold" textAlign="right">{activeOccs.length}</Text>

                          <Text color="green.700">Job time:</Text>
                          <Text fontWeight="semibold" textAlign="right">~{fmtDur(totalEstMinutes)}</Text>

                          <Text color="green.700">Buffer ({bufferPct}%):</Text>
                          <Text fontWeight="semibold" textAlign="right">~{fmtDur(setupMins)}</Text>

                          {driveMins > 0 && (
                            <>
                              <Text color="green.700">Drive time:</Text>
                              <Text fontWeight="semibold" textAlign="right">{fmtDur(driveMins)}</Text>
                            </>
                          )}

                          <Text color="green.800" fontWeight="medium" borderTop="1px solid" borderColor="green.200" pt={1}>Total time:</Text>
                          <Text fontWeight="bold" textAlign="right" borderTop="1px solid" borderColor="green.200" pt={1}>~{fmtDur(totalMins)}</Text>

                          {assumedCount > 0 && (
                            <>
                              <Text />
                              <Text fontSize="xs" color="orange.500" textAlign="right">
                                * {assumedCount} job{assumedCount !== 1 ? "s" : ""} assumed 60 min
                              </Text>
                            </>
                          )}
                          {driveMins === 0 && (
                            <>
                              <Text />
                              <Text fontSize="xs" color="fg.muted" textAlign="right">
                                Run Routes analysis to include drive time
                              </Text>
                            </>
                          )}
                        </Box>
                      );
                    })()}
                  </Box>

                  {/* Financials */}
                  <Box p={3} bg="blue.50" rounded="md">
                    <Text fontSize="xs" fontWeight="semibold" color="fg.muted" mb={2} textTransform="uppercase" letterSpacing="wide">Financials</Text>
                    {(() => {
                      const allExpenses = totalExpenses + equipmentCost;
                      const netRevenue = totalCustomerCost - allExpenses;
                      const deduction = Math.round(netRevenue * marginPercent) / 100;
                      const workerPayout = netRevenue - deduction;
                      return (
                        <Box display="grid" gridTemplateColumns="auto 1fr" gap={1} rowGap={1.5} fontSize="sm">
                          <Text color="blue.600">Customer cost:</Text>
                          <Text fontWeight="semibold" textAlign="right">${totalCustomerCost.toFixed(2)}</Text>

                          {totalExpenses > 0 && (
                            <>
                              <Text color="blue.600">Job expenses:</Text>
                              <Text fontWeight="semibold" textAlign="right" color="red.600">-${totalExpenses.toFixed(2)}</Text>
                            </>
                          )}

                          {equipmentCost > 0 && (
                            <>
                              <Text color="blue.600">Equipment rental:</Text>
                              <Text fontWeight="semibold" textAlign="right" color="red.600">-${equipmentCost.toFixed(2)}</Text>
                            </>
                          )}

                          <Text color="blue.600">Platform fee ({marginPercent}%):</Text>
                          <Text fontWeight="semibold" textAlign="right" color="red.600">-${deduction.toFixed(2)}</Text>

                          <Text color="blue.700" fontWeight="medium" borderTop="1px solid" borderColor="blue.200" pt={1}>Est. payout:</Text>
                          <Text fontWeight="bold" textAlign="right" color="green.700" borderTop="1px solid" borderColor="blue.200" pt={1}>
                            ${workerPayout.toFixed(2)}
                          </Text>
                        </Box>
                      );
                    })()}
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify={trainee ? "flex-end" : "space-between"} w="full">
                  {!trainee && (
                    <Button
                      size="sm"
                      variant="ghost"
                      colorPalette="gray"
                      onClick={() => { setStep("equipment"); persist({ step: "equipment" }); }}
                    >
                      Back
                    </Button>
                  )}
                  <HStack gap={2}>
                    {!trainee && <Button size="sm" variant="ghost" colorPalette="red" onClick={handleClose}>Cancel</Button>}
                    <Button size="sm" colorPalette="green" onClick={handleClose}>Finish</Button>
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
    handleClose();
    return null;
  }

  // confirm-jobs step
  const occ = occurrences[currentIndex];
  if (!occ) {
    // Edge case — advance to done
    setStep("done");
    return null;
  }

  const prop = occ.job?.property;
  const defaultMessage = generateMessage(occ);
  const message = editableMessage || defaultMessage;
  // Initialize editable message on first render of each job
  if (!editableMessage && defaultMessage) setEditableMessage(defaultMessage);
  const progress = `${currentIndex + 1} of ${occurrences.length}`;

  return (
    <Dialog.Root
      open
      onOpenChange={(e) => { if (!e.open) { persist(); onDone(); } }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
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
            <Dialog.Body py="2">
              <VStack align="start" gap={2}>
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

                {/* Last photos from this property */}
                {(() => {
                  const photos = propertyPhotos.get(prop?.id ?? "") ?? [];
                  if (photos.length === 0) return null;
                  return (
                    <Box w="full">
                      <Text fontSize="xs" fontWeight="medium" color="fg.muted" mb={1}>Recent photos:</Text>
                      <Box display="flex" gap={1} flexWrap="wrap">
                        {photos.map((p, i) => (
                          <img
                            key={p.id}
                            src={p.url}
                            alt=""
                            onClick={(e) => { e.stopPropagation(); setViewPhotoList(photos); setViewPhotoIndex(i); }}
                            style={{
                              width: 56,
                              height: 56,
                              objectFit: "cover",
                              borderRadius: 6,
                              cursor: "pointer",
                            }}
                          />
                        ))}
                      </Box>
                    </Box>
                  );
                })()}

                {/* Photo viewer overlay with navigation */}
                {viewPhotoIndex >= 0 && viewPhotoList.length > 0 && (
                  <div
                    onClick={() => setViewPhotoIndex(-1)}
                    style={{
                      position: "fixed",
                      inset: 0,
                      zIndex: 99999,
                      background: "rgba(0,0,0,0.85)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    {/* Left arrow */}
                    {viewPhotoIndex > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setViewPhotoIndex(viewPhotoIndex - 1); }}
                        style={{
                          position: "absolute",
                          left: 12,
                          top: "50%",
                          transform: "translateY(-50%)",
                          background: "rgba(255,255,255,0.2)",
                          border: "none",
                          color: "white",
                          fontSize: 28,
                          cursor: "pointer",
                          borderRadius: "50%",
                          width: 44,
                          height: 44,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        ‹
                      </button>
                    )}

                    <img
                      src={viewPhotoList[viewPhotoIndex]?.url}
                      alt=""
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        maxWidth: "85vw",
                        maxHeight: "80vh",
                        objectFit: "contain",
                        borderRadius: 8,
                        cursor: "default",
                      }}
                    />

                    {/* Right arrow */}
                    {viewPhotoIndex < viewPhotoList.length - 1 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setViewPhotoIndex(viewPhotoIndex + 1); }}
                        style={{
                          position: "absolute",
                          right: 12,
                          top: "50%",
                          transform: "translateY(-50%)",
                          background: "rgba(255,255,255,0.2)",
                          border: "none",
                          color: "white",
                          fontSize: 28,
                          cursor: "pointer",
                          borderRadius: "50%",
                          width: 44,
                          height: 44,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        ›
                      </button>
                    )}

                    {/* Counter */}
                    <div style={{
                      position: "absolute",
                      bottom: 16,
                      left: "50%",
                      transform: "translateX(-50%)",
                      color: "rgba(255,255,255,0.7)",
                      fontSize: 14,
                    }}>
                      {viewPhotoIndex + 1} / {viewPhotoList.length}
                    </div>

                    {/* Close */}
                    <button
                      onClick={() => setViewPhotoIndex(-1)}
                      style={{
                        position: "absolute",
                        top: 16,
                        right: 16,
                        background: "rgba(255,255,255,0.2)",
                        border: "none",
                        color: "white",
                        fontSize: 24,
                        cursor: "pointer",
                        borderRadius: "50%",
                        width: 36,
                        height: 36,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}

                {/* Copy/paste message */}
                <Box w="full">
                  <HStack justify="space-between" mb={1}>
                    <Text fontSize="xs" fontWeight="medium" color="fg.muted">Message to client:</Text>
                    <HStack gap={1}>
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
                  </HStack>
                  <textarea
                    value={editableMessage}
                    onChange={(e) => setEditableMessage(e.target.value)}
                    rows={4}
                    style={{
                      width: "100%",
                      padding: "10px",
                      fontSize: "12px",
                      color: "#2c5282",
                      backgroundColor: "#ebf8ff",
                      border: "1px solid #bee3f8",
                      borderRadius: "6px",
                      resize: "vertical",
                      lineHeight: 1.5,
                    }}
                  />
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer pt="1">
              <VStack w="full" gap={4}>
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
                  {(() => {
                    const send = getSendInfo(occ, editableMessage);
                    return (
                      <a
                        href={send.available ? send.url : undefined}
                        onClick={(e) => { if (!send.available) e.preventDefault(); }}
                        style={{
                          fontSize: "13px",
                          color: send.available ? "#ffffff" : "#a0aec0",
                          backgroundColor: send.available
                            ? (send.method === "sms" ? "#38a169" : "#3182ce")
                            : "#e2e8f0",
                          border: "none",
                          borderRadius: "6px",
                          cursor: send.available ? "pointer" : "default",
                          padding: "5px 12px",
                          fontWeight: 600,
                          textDecoration: "none",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                      >
                        {send.method === "sms" ? "💬 " : send.method === "email" ? "✉️ " : ""}
                        {send.available ? send.label : "No contact info"}
                      </a>
                    );
                  })()}
                </HStack>
                <HStack justify="space-between" w="full">
                  <Button
                    size="sm"
                    variant="ghost"
                    colorPalette="gray"
                    onClick={() => {
                      if (currentIndex === 0) {
                        setStep("routes");
                        persist({ step: "routes" });
                      } else {
                        goBack();
                      }
                    }}
                  >
                    Back
                  </Button>
                  <HStack gap={2}>
                    <Button size="sm" variant="ghost" colorPalette="red" onClick={handleClose}>Cancel</Button>
                    <Button size="sm" colorPalette="blue" onClick={advance}>
                      Next
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
