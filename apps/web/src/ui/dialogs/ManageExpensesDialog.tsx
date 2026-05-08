"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { apiGet, apiPost, apiDelete, apiPatch } from "@/src/lib/api";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Expense = {
  id: string;
  cost: number;
  description: string;
  businessExpenseId?: string | null;
  businessExpense?: { category?: string | null; vendor?: string | null; date?: string | null } | null;
};

const CATEGORY_ITEMS: { label: string; value: string }[] = [
  { label: "Advertising (line 8)", value: "Advertising" },
  { label: "Car and truck expenses (line 9)", value: "Car and truck expenses" },
  { label: "Contract labor (line 11)", value: "Contract labor" },
  { label: "Depreciation (line 13)", value: "Depreciation" },
  { label: "Insurance (line 15)", value: "Insurance" },
  { label: "Legal and professional services (line 17)", value: "Legal and professional services" },
  { label: "Office expense (line 18)", value: "Office expense" },
  { label: "Rent or lease — vehicles/equipment (line 20a)", value: "Rent or lease — vehicles/equipment" },
  { label: "Rent or lease — other business property (line 20b)", value: "Rent or lease — other business property" },
  { label: "Repairs and maintenance (line 21)", value: "Repairs and maintenance" },
  { label: "Supplies (line 22)", value: "Supplies" },
  { label: "Taxes and licenses (line 23)", value: "Taxes and licenses" },
  { label: "Travel (line 24a)", value: "Travel" },
  { label: "Meals (line 24b)", value: "Meals" },
  { label: "Utilities (line 25)", value: "Utilities" },
  { label: "Other (line 27a)", value: "Other" },
];

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
  const [newCategory, setNewCategory] = useState("Supplies");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCost, setEditCost] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editCategory, setEditCategory] = useState("Supplies");

  const collection = useMemo(() => createListCollection({ items: CATEGORY_ITEMS }), []);

  const expensesEndpoint = isAdmin
    ? `/api/admin/occurrences/${occurrenceId}/expenses`
    : `/api/occurrences/${occurrenceId}/expenses`;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setNewCost("");
    setNewDesc("");
    setNewCategory("Supplies");
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
        category: newCategory,
      });
      setExpenses((prev) => [...prev, created]);
      setNewCost("");
      setNewDesc("");
      setNewCategory("Supplies");
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
      const updated = await apiPatch<Expense>(`/api/expenses/${editingId}`, {
        cost,
        description: editDesc.trim(),
        category: editCategory,
      });
      setExpenses((prev) =>
        prev.map((e) => e.id === editingId ? updated : e)
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
                <Box p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" borderRadius="md">
                  <Text fontSize="xs" color="blue.800">
                    Each expense added here is also recorded as a business expense (categorized for
                    Schedule C) and should be paid on the company account. Default category is{" "}
                    <Text as="span" fontWeight="semibold">Supplies</Text> — change per row if it fits a different tax line.
                  </Text>
                </Box>
                {/* Existing expenses */}
                {expenses.length === 0 && !loading && (
                  <Text fontSize="xs" color="fg.muted">No expenses recorded.</Text>
                )}
                {expenses.length > 0 && (
                  <VStack align="stretch" gap={1}>
                    {expenses.map((exp) =>
                      editingId === exp.id ? (
                        <VStack key={exp.id} align="stretch" gap={1}>
                          <HStack gap={2}>
                            <Box w="80px" flexShrink={0}>
                              <CurrencyInput value={editCost} onChange={setEditCost} size="sm" placeholder="Cost" />
                            </Box>
                            <Input
                              value={editDesc}
                              onChange={(e) => setEditDesc(e.target.value)}
                              size="sm"
                              flex="1"
                            />
                          </HStack>
                          <HStack gap={2}>
                            <Box flex="1">
                              <Select.Root
                                collection={collection}
                                value={[editCategory]}
                                onValueChange={(e) => setEditCategory(e.value?.[0] ?? "Supplies")}
                                size="sm"
                                positioning={{ strategy: "fixed", hideWhenDetached: true }}
                              >
                                <Select.Control>
                                  <Select.Trigger w="full">
                                    <Select.ValueText placeholder="Supplies (line 22)" />
                                  </Select.Trigger>
                                </Select.Control>
                                <Select.Positioner>
                                  <Select.Content>
                                    {CATEGORY_ITEMS.map((it) => (
                                      <Select.Item key={it.value} item={it.value}>
                                        <Select.ItemText>{it.label}</Select.ItemText>
                                      </Select.Item>
                                    ))}
                                  </Select.Content>
                                </Select.Positioner>
                              </Select.Root>
                            </Box>
                            <Button size="xs" onClick={handleUpdate}>Save</Button>
                            <Button size="xs" variant="ghost" onClick={() => setEditingId(null)}>✕</Button>
                          </HStack>
                        </VStack>
                      ) : (
                        <HStack key={exp.id} gap={2} fontSize="xs">
                          <Text color="orange.600" flex="1">
                            ${exp.cost.toFixed(2)} — {exp.description}
                            <Text as="span" color="fg.muted" ml={1}>· {exp.businessExpense?.category ?? "Supplies"}</Text>
                          </Text>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setEditingId(exp.id);
                              setEditCost(exp.cost.toFixed(2));
                              setEditDesc(exp.description);
                              setEditCategory(exp.businessExpense?.category ?? "Supplies");
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
                  <VStack align="stretch" gap={2}>
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
                    </HStack>
                    <HStack gap={2}>
                      <Box flex="1">
                        <Select.Root
                          collection={collection}
                          value={[newCategory]}
                          onValueChange={(e) => setNewCategory(e.value?.[0] ?? "Supplies")}
                          size="sm"
                          positioning={{ strategy: "fixed", hideWhenDetached: true }}
                        >
                          <Select.Control>
                            <Select.Trigger w="full">
                              <Select.ValueText placeholder="Supplies (line 22)" />
                            </Select.Trigger>
                          </Select.Control>
                          <Select.Positioner>
                            <Select.Content>
                              {CATEGORY_ITEMS.map((it) => (
                                <Select.Item key={it.value} item={it.value}>
                                  <Select.ItemText>{it.label}</Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Positioner>
                        </Select.Root>
                      </Box>
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
                  </VStack>
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
