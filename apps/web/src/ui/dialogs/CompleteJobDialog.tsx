"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiGet, apiPost } from "@/src/lib/api";
import { bizToLocalInputValue, bizParseLocalInputValue } from "@/src/lib/lib";
import {
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import ImpersonationWarning from "@/src/ui/components/ImpersonationWarning";

type Expense = { id: string; cost: number; description: string };

type DialogAssignee = {
  userId: string;
  role?: string | null;
  user: { id: string; displayName?: string | null; email?: string | null };
};

type ContactHint = { firstName?: string; lastName?: string; phone?: string | null; email?: string | null } | null;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  occurrencePrice?: number | null;
  startedAt?: string | null;
  /** Estimated minutes for the job (raw, before per-worker division). */
  estimatedMinutes?: number | null;
  /** Total paused time in ms across all pauses. */
  totalPausedMs?: number | null;
  /** If currently paused, the timestamp the current pause began. */
  pausedAt?: string | null;
  /** Existing completedAt — used as default if the job was previously completed and is being re-completed. */
  existingCompletedAt?: string | null;
  /** Number of non-observer assignees. */
  workerCount?: number;
  /** Non-observer assignees for split allocation. */
  assignees?: DialogAssignee[];
  /** Job workflow — splits only apply to paying jobs. */
  workflow?: string | null;
  /** Property point-of-contact (hint for contact-info gate). */
  pointOfContact?: ContactHint;
  /** Display name of the impersonated worker when admin is viewing-as a
   *  single worker; renders the inline impersonation warning. */
  viewAsName?: string | null;
  onCompleted: (completedAt?: string, startedAt?: string, totalPausedMs?: number, completionSplits?: Array<{ userId: string; percent: number }>) => void;
};

export default function CompleteJobDialog({
  open,
  onOpenChange,
  occurrenceId,
  occurrencePrice,
  startedAt,
  estimatedMinutes,
  totalPausedMs,
  pausedAt,
  existingCompletedAt,
  workerCount,
  assignees,
  workflow: _workflow,
  pointOfContact: _pointOfContact,
  viewAsName = null,
  onCompleted,
}: Props) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completedAtTime, setCompletedAtTime] = useState("");
  const [startedAtTime, setStartedAtTime] = useState("");
  const [offHours, setOffHours] = useState("0");
  const [offMinutes, setOffMinutes] = useState("0");
  const [acknowledgedDiscrepancy, setAcknowledgedDiscrepancy] = useState(false);
  const [splits, setSplits] = useState<Record<string, string>>({});

  const nonObserverAssignees = (assignees ?? []).filter((a) => a.role !== "observer");
  // Splits are no longer set at completion — they're set in the Take Payment
  // dialog along with the actual collected amount. Keep the variables (used
  // by the existing onCompleted callback signature) but render nothing and
  // skip validation.
  const showSplits = false;
  const splitsSum = Object.values(splits).reduce((s, v) => s + (Number(v) || 0), 0);
  const splitsValid = true;

  // ET-anchored datetime-local helper — see lib/lib.ts. The previous
  // browser-local implementation made the round-trip wrong for any
  // operator outside ET (they'd pick "2 PM" thinking ET, the system
  // would record 2 PM in their local zone, off by 3 hours for PST etc.).
  const toLocalInput = (d: Date) => bizToLocalInputValue(d);


  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setAcknowledgedDiscrepancy(false);
    // Default completedAt to: existing completedAt (if previously completed and being re-completed),
    // else pausedAt (if currently paused — no work has happened since), else now.
    const dflt = existingCompletedAt
      ? new Date(existingCompletedAt)
      : pausedAt
        ? new Date(pausedAt)
        : new Date();
    setCompletedAtTime(toLocalInput(dflt));
    if (startedAt) {
      const s = new Date(startedAt);
      if (!isNaN(s.getTime())) setStartedAtTime(toLocalInput(s));
      else setStartedAtTime("");
    } else {
      setStartedAtTime("");
    }
    // Off-the-clock = totalPausedMs + the in-progress pause (if currently paused) up to now.
    let initialPausedMs = totalPausedMs ?? 0;
    if (pausedAt) {
      const pAt = new Date(pausedAt).getTime();
      if (!isNaN(pAt)) initialPausedMs += Math.max(0, Date.now() - pAt);
    }
    const initialMin = Math.max(0, Math.round(initialPausedMs / 60000));
    setOffHours(String(Math.floor(initialMin / 60)));
    setOffMinutes(String(initialMin % 60));
    apiGet<Expense[]>(`/api/occurrences/${occurrenceId}/expenses`)
      .then((list) => setExpenses(Array.isArray(list) ? list : []))
      .catch(() => setExpenses([]))
      .finally(() => setLoading(false));
    // Initialise even split across non-observer assignees.
    const ws = (assignees ?? []).filter((a) => a.role !== "observer");
    if (ws.length > 0) {
      const even = 100 / ws.length;
      const base = Math.floor(even * 100) / 100;
      const residual = Math.round((100 - base * ws.length) * 100) / 100;
      const next: Record<string, string> = {};
      ws.forEach((a, i) => {
        next[a.userId] = (i === 0 ? (base + residual).toFixed(2) : base.toFixed(2));
      });
      setSplits(next);
    } else {
      setSplits({});
    }
  }, [open, occurrenceId]);

  const totalExpenses = expenses.reduce((s, e) => s + e.cost, 0);

  // Wall-clock elapsed = (end - start) - off-the-clock. Compare to per-worker adjusted estimate.
  const wc = Math.max(1, workerCount ?? 1);
  const offMs = (() => {
    const h = parseInt(offHours || "0", 10) || 0;
    const m = parseInt(offMinutes || "0", 10) || 0;
    return Math.max(0, h * 60 + m) * 60000;
  })();
  const startMs = startedAtTime ? new Date(startedAtTime).getTime() : NaN;
  const endMs = completedAtTime ? new Date(completedAtTime).getTime() : NaN;
  const spanMs = !isNaN(startMs) && !isNaN(endMs) ? endMs - startMs : null;
  const endBeforeStart = spanMs != null && spanMs < 0;
  const offTooLarge = spanMs != null && spanMs >= 0 && offMs > spanMs;
  const elapsedMin: number | null = spanMs != null && spanMs >= 0 && !offTooLarge
    ? Math.max(0, (spanMs - offMs) / 60000)
    : null;
  const adjEst = estimatedMinutes != null ? estimatedMinutes / wc : null;
  const discrepancy = (elapsedMin != null && adjEst && adjEst > 0)
    ? Math.abs(elapsedMin - adjEst) / adjEst
    : 0;
  const showDiscrepancyWarning = discrepancy > 0.25;
  const isOver = elapsedMin != null && adjEst != null && elapsedMin > adjEst;
  const fmt = (m: number) => {
    const h = Math.floor(m / 60); const mm = Math.round(m % 60);
    return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
  };

  // Min for completedAt comes from the (editable) startedAtTime
  const minCompletedAt = startedAtTime || undefined;

  async function handleComplete() {
    if (endBeforeStart) {
      publishInlineMessage({ type: "WARNING", text: "End time cannot be before start time." });
      return;
    }
    if (offTooLarge) {
      publishInlineMessage({ type: "WARNING", text: "Off-the-clock time exceeds the span between start and end." });
      return;
    }
    if (!splitsValid) {
      publishInlineMessage({ type: "WARNING", text: `Splits must total 100% (currently ${splitsSum.toFixed(2)}%).` });
      return;
    }
    setBusy(true);
    try {
      // Parse the datetime-local strings as ET wall-clock time. The
      // naive `new Date(...).toISOString()` interprets in browser-local,
      // which is wrong for any operator not in ET.
      const completedAtIso = completedAtTime ? bizParseLocalInputValue(completedAtTime) : undefined;
      const startedAtIso = startedAtTime ? bizParseLocalInputValue(startedAtTime) : undefined;
      // Only forward startedAt if it actually changed from the original prop value.
      const origStartedIso = startedAt ? new Date(startedAt).toISOString() : undefined;
      const startedAtChanged = startedAtIso !== origStartedIso ? startedAtIso : undefined;
      const completionSplits = showSplits
        ? nonObserverAssignees.map((a) => ({ userId: a.userId, percent: Number(splits[a.userId]) || 0 }))
        : undefined;
      onCompleted(completedAtIso, startedAtChanged, offMs, completionSplits);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onOpenChange(false); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Complete Job</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <ImpersonationWarning viewAsName={viewAsName} />
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Start time</Text>
                  <input
                    type="datetime-local"
                    value={startedAtTime}
                    onChange={(e) => { setStartedAtTime(e.target.value); setAcknowledgedDiscrepancy(false); }}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "16px", border: "1px solid #ccc", borderRadius: "6px" }}
                  />
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Completion time</Text>
                  <input
                    type="datetime-local"
                    value={completedAtTime}
                    onChange={(e) => { setCompletedAtTime(e.target.value); setAcknowledgedDiscrepancy(false); }}
                    min={minCompletedAt}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "16px", border: "1px solid #ccc", borderRadius: "6px" }}
                  />
                  {endBeforeStart && (
                    <Text fontSize="xs" color="red.500" mt={1}>End time cannot be before start time.</Text>
                  )}
                </Box>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Off-the-clock (Paused) time</Text>
                  <HStack gap={2}>
                    <Box flex="1">
                      <Text fontSize="xs" color="fg.muted" mb={1}>Hours</Text>
                      <input
                        type="number"
                        min={0}
                        value={offHours}
                        onChange={(e) => { setOffHours(e.target.value); setAcknowledgedDiscrepancy(false); }}
                        style={{ width: "100%", padding: "6px 10px", fontSize: "16px", border: "1px solid #ccc", borderRadius: "6px" }}
                      />
                    </Box>
                    <Box flex="1">
                      <Text fontSize="xs" color="fg.muted" mb={1}>Minutes</Text>
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={offMinutes}
                        onChange={(e) => { setOffMinutes(e.target.value); setAcknowledgedDiscrepancy(false); }}
                        style={{ width: "100%", padding: "6px 10px", fontSize: "16px", border: "1px solid #ccc", borderRadius: "6px" }}
                      />
                    </Box>
                  </HStack>
                  {offTooLarge && (
                    <Text fontSize="xs" color="red.500" mt={1}>Off-the-clock time exceeds the span between start and end.</Text>
                  )}
                  {elapsedMin != null && (
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Working time: <Text as="span" fontWeight="semibold" color="fg.default">{fmt(elapsedMin)}</Text>
                    </Text>
                  )}
                </Box>
                <Text fontSize="sm" color="fg.muted">
                  Review details before marking this job as complete.
                </Text>

                {showDiscrepancyWarning && elapsedMin != null && adjEst != null && (
                  <Box p={3} bg="orange.50" borderWidth="2px" borderColor="orange.400" rounded="md">
                    <Text fontSize="sm" fontWeight="semibold" color="orange.800" mb={1}>
                      ⚠ Time discrepancy: {Math.round(discrepancy * 100)}% {isOver ? "over" : "under"} estimate
                    </Text>
                    <Text fontSize="xs" color="orange.700">
                      Actual: {fmt(elapsedMin)} · Estimate: {fmt(adjEst)}{wc > 1 ? ` (${wc} workers)` : ""}
                    </Text>
                    <Text fontSize="xs" color="orange.700" mt={1} mb={2}>
                      You can adjust the completion time above, or confirm below to continue.
                    </Text>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={acknowledgedDiscrepancy}
                        onChange={(e) => setAcknowledgedDiscrepancy(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: "pointer" }}
                      />
                      <Text fontSize="sm" color="orange.900" fontWeight="medium">
                        I confirm the completion time is correct
                      </Text>
                    </label>
                  </Box>
                )}

                {/* Contact-info gate removed: it was checking the property's
                    `pointOfContact` field (a single optional linked contact),
                    which is independent of the client's actual contacts list.
                    The server's payment-request sender uses the client's
                    primary contacts and surfaces a clear 409
                    NO_PRIMARY_CONTACT error if none are reachable — that
                    check fires at send time, when it actually matters. */}

                {showSplits && (
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Payout split</Text>
                    <Text fontSize="xs" color="fg.muted" mb={2}>
                      Set each worker&apos;s share of the payout. Must total 100%.
                    </Text>
                    <VStack align="stretch" gap={1}>
                      {nonObserverAssignees.map((a) => (
                        <HStack key={a.userId} gap={2}>
                          <Text fontSize="sm" flex="1" lineClamp={1}>
                            {a.user.displayName || a.user.email || "Worker"}
                          </Text>
                          <Box w="90px">
                            <HStack gap={1}>
                              <input
                                type="number"
                                min={0}
                                max={100}
                                step="0.01"
                                value={splits[a.userId] ?? ""}
                                onChange={(e) => setSplits((prev) => ({ ...prev, [a.userId]: e.target.value }))}
                                style={{ width: "100%", padding: "4px 8px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px", textAlign: "right" }}
                              />
                              <Text fontSize="sm" color="fg.muted">%</Text>
                            </HStack>
                          </Box>
                        </HStack>
                      ))}
                    </VStack>
                    <HStack justify="space-between" mt={2}>
                      <Text fontSize="xs" color={splitsValid ? "fg.muted" : "red.600"} fontWeight={splitsValid ? "normal" : "semibold"}>
                        Total: {splitsSum.toFixed(2)}%
                      </Text>
                      {!splitsValid && (
                        <Text fontSize="xs" color="red.600">Must total 100%</Text>
                      )}
                    </HStack>
                  </Box>
                )}

                {/* Summary */}
                {occurrencePrice != null && (
                  <Box p={3} bg="gray.50" rounded="md" borderWidth="1px" borderColor="gray.200">
                    <HStack justify="space-between" fontSize="sm">
                      <Text>Job Price</Text>
                      <Text fontWeight="medium">${occurrencePrice.toFixed(2)}</Text>
                    </HStack>
                    {totalExpenses > 0 && (
                      <HStack justify="space-between" fontSize="sm">
                        <Text color="orange.600">Total Expenses</Text>
                        <Text color="orange.600">−${totalExpenses.toFixed(2)}</Text>
                      </HStack>
                    )}
                    <Box borderTopWidth="1px" borderColor="gray.300" pt={1} mt={1}>
                      <HStack justify="space-between">
                        <Text fontWeight="bold" fontSize="sm">Net</Text>
                        <Text fontWeight="bold" fontSize="sm">${(occurrencePrice - totalExpenses).toFixed(2)}</Text>
                      </HStack>
                    </Box>
                  </Box>
                )}

                {/* Expenses (read-only — managed on Admin Services tab) */}
                {expenses.length > 0 && (
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Expenses</Text>
                    <VStack align="stretch" gap={1}>
                      {expenses.map((exp) => (
                        <Text key={exp.id} fontSize="xs" color="orange.600">
                          −${exp.cost.toFixed(2)} — {exp.description}
                        </Text>
                      ))}
                    </VStack>
                    <Text fontSize="2xs" color="fg.muted" mt={1}>Expenses are managed on the Admin Services tab.</Text>
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  colorPalette="blue"
                  onClick={handleComplete}
                  loading={busy}
                  disabled={
                    !completedAtTime ||
                    endBeforeStart ||
                    offTooLarge ||
                    !splitsValid ||
                    (showDiscrepancyWarning && !acknowledgedDiscrepancy)
                  }
                >
                  Complete Job
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
