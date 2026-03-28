"use client";

import { useEffect, useState } from "react";
import {
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
  /** Use admin endpoints */
  isAdmin?: boolean;
  onChanged?: () => void;
};

export default function ManageExpensesDialog({
  open,
  onOpenChange,
  occurrenceId,
  isAdmin,
  onChanged,
}: Props) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(false);

  const [newCost, setNewCost] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCost, setEditCost] = useState("");
  const [editDesc, setEditDesc] = useState("");

  const expensesEndpoint = isAdmin
    ? `/api/admin/occurrences/${occurrenceId}/expenses`
    : `/api/occurrences/${occurrenceId}/expenses`;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setNewCost("");
    setNewDesc("");
    setEditingId(null);
    apiGet<Expense[]>(expensesEndpoint)
      .then((list) => setExpenses(Array.isArray(list) ? list : []))
      .catch(() => setExpenses([]))
      .finally(() => setLoading(false));
  }, [open, occurrenceId]);

  async function handleAdd() {
    const cost = parseFloat(newCost);
    if (isNaN(cost) || cost <= 0 || !newDesc.trim()) return;
    try {
      const created = await apiPost<Expense>(expensesEndpoint, {
        cost,
        description: newDesc.trim(),
      });
      setExpenses((prev) => [...prev, created]);
      setNewCost("");
      setNewDesc("");
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to add expense.", err) });
    }
  }

  async function handleDelete(id: string) {
    try {
      const deleteEndpoint = isAdmin ? `/api/admin/expenses/${id}` : `/api/expenses/${id}`;
      await apiDelete(deleteEndpoint);
      setExpenses((prev) => prev.filter((e) => e.id !== id));
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to delete expense.", err) });
    }
  }

  async function handleUpdate() {
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
      onChanged?.();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to update expense.", err) });
    }
  }

  const total = expenses.reduce((s, e) => s + e.cost, 0);

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onOpenChange(false); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Manage Expenses</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {/* Existing expenses */}
                {expenses.length === 0 && !loading && (
                  <Text fontSize="xs" color="fg.muted">No expenses recorded.</Text>
                )}
                {expenses.length > 0 && (
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
                          <Button size="xs" onClick={handleUpdate}>Save</Button>
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
                            onClick={() => handleDelete(exp.id)}
                          >
                            ✕
                          </Button>
                        </HStack>
                      )
                    )}
                    <HStack justify="flex-end" fontSize="sm" pt={1} borderTopWidth="1px" borderColor="gray.200">
                      <Text fontWeight="medium" color="orange.600">Total: ${total.toFixed(2)}</Text>
                    </HStack>
                  </VStack>
                )}

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
                      onClick={handleAdd}
                    >
                      Add
                    </Button>
                  </HStack>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Done
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
