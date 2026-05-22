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
import ReceiptUpload from "@/src/ui/components/ReceiptUpload";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Expense = {
  id: string;
  cost: number;
  description: string;
  businessExpenseId?: string | null;
  businessExpense?: {
    category?: string | null;
    vendor?: string | null;
    date?: string | null;
    receiptR2Key?: string | null;
    receiptFileName?: string | null;
    receiptContentType?: string | null;
    receiptUploadedAt?: string | null;
  } | null;
  // Set when this Expense was created by consuming inventory. The UI hides
  // edit on these rows since cost/description are derived from the hold's
  // qty × jobPayoutCost.
  supplyHold?: {
    id: string;
    quantity: number;
    status: "ACTIVE" | "CONSUMED" | "RELEASED";
    supply?: { id: string; name: string; unit: string } | null;
  } | null;
};

type SupplyOption = {
  id: string;
  name: string;
  unit: string;
  jobPayoutCost: number;
  available: number;
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
  /** Hide the "From inventory" toggle. Set true for workflows that don't
   *  carry physical supply consumption (events, followups, announcements). */
  disableInventory?: boolean;
  /** The viewing user's resolved privileges (admin/super always true). When
   *  omitted, both default to true for back-compat with admin contexts that
   *  haven't been wired through. */
  privileges?: {
    canPullInventory: boolean;
    canChargeBusinessExpenses: boolean;
  };
  onChanged?: () => void;
};

export default function ManageExpensesDialog({
  open,
  onOpenChange,
  occurrenceId,
  isAdmin,
  disableInventory = false,
  privileges = { canPullInventory: true, canChargeBusinessExpenses: true },
  onChanged,
}: Props) {
  const canInventory = privileges.canPullInventory && !disableInventory;
  const canCharge = privileges.canChargeBusinessExpenses;
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(false);
  // Serializes inventory +/− clicks — each adjust re-reads server state.
  const [holdBusy, setHoldBusy] = useState(false);
  // In-progress typed quantity per hold id. Absent = show the server value.
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, string>>({});

  // Add mode: nothing selected by default. The user must explicitly pick
  // Custom or From inventory. If they pick a mode they don't have permission
  // for, we render an inline yellow warning instead of the form fields —
  // never silently disable the button.
  const [addMode, setAddMode] = useState<"custom" | "inventory" | null>(null);

  const [newCost, setNewCost] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newCategory, setNewCategory] = useState("Supplies");

  // Inventory-mode state
  const [supplies, setSupplies] = useState<SupplyOption[]>([]);
  const [pickedSupplyId, setPickedSupplyId] = useState<string>("");
  const [pickedQty, setPickedQty] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCost, setEditCost] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editCategory, setEditCategory] = useState("Supplies");

  const collection = useMemo(() => createListCollection({ items: CATEGORY_ITEMS }), []);

  const expensesEndpoint = isAdmin
    ? `/api/admin/occurrences/${occurrenceId}/expenses`
    : `/api/occurrences/${occurrenceId}/expenses`;
  const holdsEndpoint = isAdmin
    ? `/api/admin/occurrences/${occurrenceId}/supply-holds`
    : `/api/occurrences/${occurrenceId}/supply-holds`;

  const supplyCollection = useMemo(
    () =>
      createListCollection({
        items: supplies.map((s) => ({
          label: `${s.name} — ${s.available} ${s.unit} avail @ $${s.jobPayoutCost.toFixed(2)}/${s.unit}`,
          value: s.id,
        })),
      }),
    [supplies],
  );
  const pickedSupply = useMemo(
    () => supplies.find((s) => s.id === pickedSupplyId) ?? null,
    [supplies, pickedSupplyId],
  );

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setAddMode(null);
    setNewCost("");
    setNewDesc("");
    setNewCategory("Supplies");
    setPickedSupplyId("");
    setPickedQty("");
    setEditingId(null);
    // Load supplies for inventory picker (worker route is read-only).
    apiGet<any[]>("/api/supplies")
      .then((list) => {
        if (!Array.isArray(list)) {
          setSupplies([]);
          return;
        }
        setSupplies(
          list
            .filter((s) => !s.archivedAt)
            .map((s) => ({
              id: s.id,
              name: s.name,
              unit: s.unit,
              jobPayoutCost: Number(s.jobPayoutCost ?? 0),
              available: Number(s.available ?? 0),
            })),
        );
      })
      .catch(() => setSupplies([]));
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

  async function handleAddFromInventory() {
    if (!pickedSupplyId || !pickedSupply) return;
    const qty = Math.round(Number(pickedQty));
    if (!Number.isInteger(qty) || qty <= 0) {
      publishInlineMessage({ type: "WARNING", text: "Quantity must be a positive integer." });
      return;
    }
    if (qty > pickedSupply.available) {
      publishInlineMessage({
        type: "WARNING",
        text: `Only ${pickedSupply.available} ${pickedSupply.unit}(s) available.`,
      });
      return;
    }
    try {
      const created = await apiPost<any>(holdsEndpoint, {
        supplyId: pickedSupplyId,
        quantity: qty,
      });
      // The API returns the SupplyHold with its linked Expense. Reload the
      // full expense list so the new row shows up with the inventory chip
      // (avoids assembling a synthetic Expense shape on the client).
      const refreshed = await apiGet<Expense[]>(expensesEndpoint);
      setExpenses(Array.isArray(refreshed) ? refreshed : []);
      // Refresh available qty on the picker too.
      setSupplies((prev) =>
        prev.map((s) =>
          s.id === pickedSupplyId ? { ...s, available: s.available - qty } : s,
        ),
      );
      setPickedSupplyId("");
      setPickedQty("");
      onChanged?.();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to add from inventory.", err),
      });
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

  // Bump an inventory-backed hold up or down by one unit. The server
  // reprices the paired expense and reconciles physical stock (a removed
  // unit goes back to inventory; an added one is pulled). Re-reads both
  // lists afterward so costs and availability stay exact.
  async function handleAdjustHold(holdId: string, newQty: number) {
    if (newQty < 1 || holdBusy) return;
    setHoldBusy(true);
    try {
      const endpoint = isAdmin
        ? `/api/admin/supply-holds/${holdId}`
        : `/api/supply-holds/${holdId}`;
      await apiPatch(endpoint, { quantity: newQty });
      const [refreshed, freshSupplies] = await Promise.all([
        apiGet<Expense[]>(expensesEndpoint),
        apiGet<any[]>("/api/supplies"),
      ]);
      setExpenses(Array.isArray(refreshed) ? refreshed : []);
      if (Array.isArray(freshSupplies)) {
        setSupplies(
          freshSupplies
            .filter((s) => !s.archivedAt)
            .map((s) => ({
              id: s.id,
              name: s.name,
              unit: s.unit,
              jobPayoutCost: Number(s.jobPayoutCost ?? 0),
              available: Number(s.available ?? 0),
            })),
        );
      }
      onChanged?.();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to adjust supply quantity.", err),
      });
    } finally {
      setHoldBusy(false);
      // Drop the typed draft so the input reflects the (refetched) server qty.
      setQtyDrafts((p) => {
        if (!(holdId in p)) return p;
        const n = { ...p };
        delete n[holdId];
        return n;
      });
    }
  }

  // Commit a typed quantity. Called on blur / Enter of the qty input.
  function commitQty(holdId: string, currentQty: number) {
    const draft = qtyDrafts[holdId];
    if (draft === undefined) return; // untouched
    const parsed = Math.round(Number(draft));
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      publishInlineMessage({
        type: "WARNING",
        text: "Quantity must be a whole number of at least 1 — use ✕ to remove entirely.",
      });
      // Reset the input back to the server value.
      setQtyDrafts((p) => {
        const n = { ...p };
        delete n[holdId];
        return n;
      });
      return;
    }
    if (parsed === currentQty) {
      // No change — just clear the draft.
      setQtyDrafts((p) => {
        const n = { ...p };
        delete n[holdId];
        return n;
      });
      return;
    }
    void handleAdjustHold(holdId, parsed);
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
                        <VStack key={exp.id} align="stretch" gap={1}>
                        <HStack gap={2} fontSize="xs">
                          <Text color="orange.600" flex="1">
                            ${exp.cost.toFixed(2)} — {exp.description}
                            {exp.supplyHold ? (
                              <Text as="span" color="blue.600" ml={1}>· Inventory</Text>
                            ) : (
                              <Text as="span" color="fg.muted" ml={1}>· {exp.businessExpense?.category ?? "Supplies"}</Text>
                            )}
                          </Text>
                          {/* Inventory-backed rows get a quantity stepper —
                              cost/description are derived from qty ×
                              jobPayoutCost, so the server reprices and
                              reconciles inventory on each step. Custom rows
                              get the inline Edit form. */}
                          {exp.supplyHold ? (() => {
                            const h = exp.supplyHold!;
                            const sup = supplies.find((s) => s.id === h.supply?.id);
                            const canInc = !sup || sup.available > 0;
                            return (
                              <HStack gap={0.5} flexShrink={0}>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  px={1.5}
                                  disabled={holdBusy || h.quantity <= 1}
                                  title="Remove one — returns it to inventory"
                                  onClick={() => handleAdjustHold(h.id, h.quantity - 1)}
                                >
                                  −
                                </Button>
                                <Input
                                  type="number"
                                  min={1}
                                  step={1}
                                  size="xs"
                                  w="48px"
                                  textAlign="center"
                                  px={1}
                                  disabled={holdBusy}
                                  value={qtyDrafts[h.id] ?? String(h.quantity)}
                                  onChange={(e) =>
                                    setQtyDrafts((p) => ({ ...p, [h.id]: e.target.value }))
                                  }
                                  onBlur={() => commitQty(h.id, h.quantity)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                  }}
                                />
                                <Button
                                  size="xs"
                                  variant="outline"
                                  px={1.5}
                                  disabled={holdBusy || !canInc}
                                  title={canInc ? "Add one more from inventory" : "None left in inventory"}
                                  onClick={() => handleAdjustHold(h.id, h.quantity + 1)}
                                >
                                  +
                                </Button>
                              </HStack>
                            );
                          })() : (
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
                          )}
                          <Button
                            size="xs"
                            variant="ghost"
                            colorPalette="red"
                            onClick={() => handleDelete(exp.id)}
                          >
                            ✕
                          </Button>
                        </HStack>
                        {/* Receipt — only for custom (company-account) rows.
                            Inventory rows derive from a supply purchase whose
                            receipt was captured at buy time. */}
                        {!exp.supplyHold && exp.businessExpenseId && (
                          <Box pl={1}>
                            <ReceiptUpload
                              compact
                              businessExpenseId={exp.businessExpenseId}
                              apiBase={`/api/expenses/${exp.id}`}
                              existing={exp.businessExpense ?? null}
                              onChanged={(next) =>
                                setExpenses((prev) =>
                                  prev.map((e) =>
                                    e.id === exp.id
                                      ? { ...e, businessExpense: { ...e.businessExpense, ...next } }
                                      : e,
                                  ),
                                )
                              }
                            />
                          </Box>
                        )}
                        </VStack>
                      )
                    )}
                    <HStack justify="flex-end" fontSize="sm" pt={1} borderTopWidth="1px" borderColor="gray.200">
                      <Text fontWeight="medium" color="orange.600">Total: ${total.toFixed(2)}</Text>
                    </HStack>
                  </VStack>
                )}

                {/* Add new expense */}
                <Box>
                  <HStack justify="space-between" mb={1} gap={2} wrap="wrap">
                    <Text fontSize="sm" fontWeight="medium">Add Expense</Text>
                    <HStack gap={1}>
                      <Button
                        size="xs"
                        variant={addMode === "custom" ? "solid" : "outline"}
                        onClick={() => setAddMode("custom")}
                      >
                        Custom
                      </Button>
                      <Button
                        size="xs"
                        variant={addMode === "inventory" ? "solid" : "outline"}
                        colorPalette={addMode === "inventory" ? "blue" : "gray"}
                        onClick={() => setAddMode("inventory")}
                        disabled={canInventory && supplies.length === 0}
                        title={canInventory && supplies.length === 0 ? "No supplies in inventory yet" : "Pull from inventory"}
                      >
                        From inventory
                      </Button>
                    </HStack>
                  </HStack>
                  {/* Render the appropriate body for the selected mode. If the
                      user picked a mode they don't have permission for, show
                      an inline yellow warning instead of form fields. */}
                  {addMode === null ? null : addMode === "custom" && !canCharge ? (
                    <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" borderRadius="md">
                      <Text fontSize="xs" color="yellow.800">
                        Recording new out-of-pocket or company-card expenses requires the <Text as="span" fontWeight="semibold">Charge business expenses</Text> privilege. Ask an admin to grant it, or have them log this expense for you.
                      </Text>
                    </Box>
                  ) : addMode === "inventory" && !canInventory ? (
                    <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" borderRadius="md">
                      <Text fontSize="xs" color="yellow.800">
                        Pulling from inventory requires the <Text as="span" fontWeight="semibold">Pull inventory</Text> privilege{disableInventory ? " (and isn't supported on this workflow)" : ""}. Ask an admin.
                      </Text>
                    </Box>
                  ) : addMode === "inventory" ? (
                    <VStack align="stretch" gap={2}>
                      <Box>
                        <Select.Root
                          collection={supplyCollection}
                          value={pickedSupplyId ? [pickedSupplyId] : []}
                          onValueChange={(e) => setPickedSupplyId(e.value?.[0] ?? "")}
                          size="sm"
                          positioning={{ strategy: "fixed", hideWhenDetached: true }}
                        >
                          <Select.Control>
                            <Select.Trigger w="full">
                              <Select.ValueText placeholder="Pick a supply…" />
                            </Select.Trigger>
                          </Select.Control>
                          <Select.Positioner>
                            <Select.Content>
                              {supplyCollection.items.map((it) => (
                                <Select.Item key={it.value} item={it.value}>
                                  <Select.ItemText>{it.label}</Select.ItemText>
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Positioner>
                        </Select.Root>
                      </Box>
                      <HStack gap={2}>
                        <Box w="80px" flexShrink={0}>
                          <Input
                            type="number"
                            min={1}
                            step={1}
                            value={pickedQty}
                            onChange={(e) => setPickedQty(e.target.value)}
                            size="sm"
                            placeholder="Qty"
                          />
                        </Box>
                        <Box flex="1">
                          {pickedSupply && pickedQty && Number(pickedQty) > 0 && (
                            <Text fontSize="xs" color="fg.muted">
                              {Number(pickedQty)} {pickedSupply.unit} × ${pickedSupply.jobPayoutCost.toFixed(2)} = ${(Number(pickedQty) * pickedSupply.jobPayoutCost).toFixed(2)}
                              <Text as="span" color={Number(pickedQty) > pickedSupply.available ? "red.600" : "fg.muted"} ml={1}>
                                ({pickedSupply.available} available)
                              </Text>
                            </Text>
                          )}
                        </Box>
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="blue"
                          disabled={
                            !pickedSupplyId ||
                            !pickedQty ||
                            !Number.isInteger(Number(pickedQty)) ||
                            Number(pickedQty) <= 0 ||
                            !!(pickedSupply && Number(pickedQty) > pickedSupply.available)
                          }
                          onClick={handleAddFromInventory}
                        >
                          Add
                        </Button>
                      </HStack>
                    </VStack>
                  ) : (
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
                  )}
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
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
