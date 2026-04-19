"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiGet, apiPost, apiDelete, apiPatch } from "@/src/lib/api";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import {
  publishInlineMessage,
  getErrorMessage,
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

  // New expense fields
  const [newCost, setNewCost] = useState("");
  const [newDesc, setNewDesc] = useState("");

  // Editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCost, setEditCost] = useState("");
  const [editDesc, setEditDesc] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setNewCost("");
    setNewDesc("");
    setEditingId(null);
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

  async function handleAddExpense() {
    const cost = parseFloat(newCost);
    if (isNaN(cost) || cost <= 0 || !newDesc.trim()) return;
    try {
      const created = await apiPost<Expense>(`/api/occurrences/${occurrenceId}/expenses`, {
        cost,
        description: newDesc.trim(),
      });
      setExpenses((prev) => [...prev, created]);
      setNewCost("");
      setNewDesc("");
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to add expense.", err) });
    }
  }

  async function handleDeleteExpense(id: string) {
    try {
      await apiDelete(`/api/expenses/${id}`);
      setExpenses((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete expense.", err) });
    }
  }

  async function handleUpdateExpense() {
    if (!editingId) return;
    const cost = parseFloat(editCost);
    if (isNaN(cost) || cost <= 0 || !editDesc.trim()) return;
    try {
      await apiPatch(`/api/expenses/${editingId}`, {
        cost,
        description: editDesc.trim(),
      });
      setExpenses((prev) =>
        prev.map((e) => e.id === editingId ? { ...e, cost, description: editDesc.trim() } : e)
      );
      setEditingId(null);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to update expense.", err) });
    }
  }

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
                  Review and update expenses before marking this job as complete.
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

                {/* Existing expenses */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Expenses</Text>
                  {expenses.length === 0 && !loading && (
                    <Text fontSize="xs" color="fg.muted">No expenses recorded.</Text>
                  )}
                  <VStack align="stretch" gap={1}>
                    {expenses.map((exp) =>
                      editingId === exp.id ? (
                        <HStack key={exp.id} gap={2}>
                          <Box w="80px" flexShrink={0}>
                            <CurrencyInput value={editCost} onChange={setEditCost} size="sm" placeholder="Cost" />
                          </Box>
                          <Input
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            size="sm"
                            flex="1"
                          />
                          <Button size="xs" onClick={handleUpdateExpense}>Save</Button>
                          <Button size="xs" variant="ghost" onClick={() => setEditingId(null)}>✕</Button>
                        </HStack>
                      ) : (
                        <HStack key={exp.id} gap={2} fontSize="xs">
                          <Text color="orange.600" flex="1">
                            ${exp.cost.toFixed(2)} — {exp.description}
                          </Text>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setEditingId(exp.id);
                              setEditCost(exp.cost.toFixed(2));
                              setEditDesc(exp.description);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            colorPalette="red"
                            onClick={() => handleDeleteExpense(exp.id)}
                          >
                            ✕
                          </Button>
                        </HStack>
                      )
                    )}
                  </VStack>
                </Box>

                {/* Add new expense */}
                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>Add Expense</Text>
                  <HStack gap={2}>
                    <Box w="80px" flexShrink={0}>
                      <CurrencyInput value={newCost} onChange={setNewCost} size="sm" placeholder="Cost" />
                    </Box>
                    <Input
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      size="sm"
                      flex="1"
                      placeholder="Description"
                    />
                    <Button
                      size="xs"
                      variant="outline"
                      colorPalette="orange"
                      disabled={!newCost || !newDesc.trim()}
                      onClick={handleAddExpense}
                    >
                      Add
                    </Button>
                  </HStack>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button colorPalette="green" onClick={handleComplete} loading={busy} disabled={!completedAtTime || (!!minCompletedAt && completedAtTime < minCompletedAt)}>
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
