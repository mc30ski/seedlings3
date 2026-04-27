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
  onCompleted: (completedAt?: string) => void;
};

export default function CompleteJobDialog({
  open,
  onOpenChange,
  occurrenceId,
  occurrencePrice,
  startedAt,
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
