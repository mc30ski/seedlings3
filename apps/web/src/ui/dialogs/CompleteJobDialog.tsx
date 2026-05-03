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
import {
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";

type Expense = { id: string; cost: number; description: string };

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
  /** Number of non-observer assignees. */
  workerCount?: number;
  onCompleted: (completedAt?: string) => void;
};

export default function CompleteJobDialog({
  open,
  onOpenChange,
  occurrenceId,
  occurrencePrice,
  startedAt,
  estimatedMinutes,
  totalPausedMs,
  workerCount,
  onCompleted,
}: Props) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [completedAtTime, setCompletedAtTime] = useState("");


  useEffect(() => {
    if (!open) return;
    setLoading(true);
    // Default completedAt to now
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    setCompletedAtTime(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`);
    apiGet<Expense[]>(`/api/occurrences/${occurrenceId}/expenses`)
      .then((list) => setExpenses(Array.isArray(list) ? list : []))
      .catch(() => setExpenses([]))
      .finally(() => setLoading(false));
  }, [open, occurrenceId]);

  const totalExpenses = expenses.reduce((s, e) => s + e.cost, 0);

  // Compute elapsed time from current completedAtTime + startedAt + paused time, per worker.
  // Compare to per-worker adjusted estimate. Show a warning if it differs by more than 25%.
  const wc = Math.max(1, workerCount ?? 1);
  const elapsedMin: number | null = (() => {
    if (!startedAt || !completedAtTime) return null;
    const start = new Date(startedAt).getTime();
    const end = new Date(completedAtTime).getTime();
    if (isNaN(start) || isNaN(end) || end < start) return null;
    const paused = totalPausedMs ?? 0;
    return Math.max(0, (end - start - paused) / 60000 / wc);
  })();
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

  // Compute min for completedAt from startedAt
  const minCompletedAt = (() => {
    if (!startedAt) return undefined;
    const d = new Date(startedAt);
    if (isNaN(d.getTime())) return undefined;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  async function handleComplete() {
    if (minCompletedAt && completedAtTime < minCompletedAt) {
      publishInlineMessage({ type: "WARNING", text: "End time cannot be before start time." });
      return;
    }
    setBusy(true);
    try {
      const completedAt = completedAtTime ? new Date(completedAtTime).toISOString() : undefined;
      onCompleted(completedAt);
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
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Completion time</Text>
                  <input
                    type="datetime-local"
                    value={completedAtTime}
                    onChange={(e) => setCompletedAtTime(e.target.value)}
                    min={minCompletedAt}
                    style={{ width: "100%", padding: "6px 10px", fontSize: "16px", border: "1px solid #ccc", borderRadius: "6px" }}
                  />
                  {minCompletedAt && completedAtTime && completedAtTime < minCompletedAt && (
                    <Text fontSize="xs" color="red.500" mt={1}>End time cannot be before start time.</Text>
                  )}
                </Box>
                <Text fontSize="sm" color="fg.muted">
                  Review details before marking this job as complete.
                </Text>

                {showDiscrepancyWarning && elapsedMin != null && adjEst != null && (
                  <Box p={3} bg="orange.50" borderWidth="1px" borderColor="orange.300" rounded="md">
                    <Text fontSize="sm" fontWeight="semibold" color="orange.800" mb={1}>
                      ⚠ Time discrepancy: {Math.round(discrepancy * 100)}% {isOver ? "over" : "under"} estimate
                    </Text>
                    <Text fontSize="xs" color="orange.700">
                      Actual: {fmt(elapsedMin)} · Estimate: {fmt(adjEst)}{wc > 1 ? ` (${wc} workers)` : ""}
                    </Text>
                    <Text fontSize="xs" color="orange.700" mt={1}>
                      You can adjust the completion time above, or continue with the current time.
                    </Text>
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
                <Button colorPalette="blue" onClick={handleComplete} loading={busy} disabled={!completedAtTime || (!!minCompletedAt && completedAtTime < minCompletedAt)}>
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
