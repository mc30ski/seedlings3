"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
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
import { apiGet, apiPost } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";

// Mirror of the Schedule C list owned by BusinessExpensesTab — duplicated here
// to avoid an import cycle. The default is "Supplies" since fuel, materials,
// and small-item purchases on jobs almost always land there.
const SCHEDULE_C_CATEGORIES: { label: string; line: string }[] = [
  { label: "Advertising", line: "8" },
  { label: "Car and truck expenses", line: "9" },
  { label: "Contract labor", line: "11" },
  { label: "Insurance", line: "15" },
  { label: "Legal and professional services", line: "17" },
  { label: "Office expense", line: "18" },
  { label: "Depreciation", line: "13" },
  { label: "Rent or lease — vehicles/equipment", line: "20a" },
  { label: "Rent or lease — other business property", line: "20b" },
  { label: "Repairs and maintenance", line: "21" },
  { label: "Supplies", line: "22" },
  { label: "Taxes and licenses", line: "23" },
  { label: "Travel", line: "24a" },
  { label: "Meals", line: "24b" },
  { label: "Utilities", line: "25" },
  { label: "Other", line: "27a" },
];
const DEFAULT_CATEGORY = "Supplies";

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: string; // e.g. "/api/occurrences/:id/expenses"
  /** Optional supply-holds endpoint for "Add from inventory" mode. When
   *  provided, the dialog gains a Custom/Inventory toggle and POSTs to
   *  this endpoint when the user picks a supply. e.g. "/api/admin/occurrences/:id/supply-holds" */
  holdsEndpoint?: string;
  /** Hide the "From inventory" toggle even if holdsEndpoint is given. Set
   *  true for workflows that don't carry physical supply consumption
   *  (events, followups, announcements). */
  disableInventory?: boolean;
  onAdded: () => void;
};

type SupplyOption = {
  id: string;
  name: string;
  unit: string;
  jobPayoutCost: number;
  available: number;
};

export default function AddExpenseDialog({
  open,
  onOpenChange,
  endpoint,
  holdsEndpoint,
  disableInventory = false,
  onAdded,
}: Props) {
  const showInventoryToggle = !!holdsEndpoint && !disableInventory;
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"custom" | "inventory">("custom");
  const [cost, setCost] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [vendor, setVendor] = useState("");
  const [date, setDate] = useState(todayStr());

  const [supplies, setSupplies] = useState<SupplyOption[]>([]);
  const [pickedSupplyId, setPickedSupplyId] = useState("");
  const [pickedQty, setPickedQty] = useState("");

  const items = useMemo(
    () => SCHEDULE_C_CATEGORIES.map((c) => ({ label: `${c.label} (line ${c.line})`, value: c.label })),
    [],
  );
  const collection = useMemo(() => createListCollection({ items }), [items]);
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

  function reset() {
    setMode("custom");
    setCost("");
    setDescription("");
    setCategory(DEFAULT_CATEGORY);
    setVendor("");
    setDate(todayStr());
    setPickedSupplyId("");
    setPickedQty("");
  }

  useEffect(() => {
    if (!open) return;
    reset();
    if (!holdsEndpoint) return;
    apiGet<any[]>("/api/supplies")
      .then((list) => {
        if (!Array.isArray(list)) return setSupplies([]);
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
  }, [open, holdsEndpoint]);

  async function handleSubmit() {
    if (mode === "inventory") {
      if (!holdsEndpoint || !pickedSupply) return;
      const qty = Math.round(Number(pickedQty));
      if (!Number.isInteger(qty) || qty <= 0) {
        publishInlineMessage({ type: "WARNING", text: "Quantity must be a positive integer." });
        return;
      }
      if (qty > pickedSupply.available) {
        publishInlineMessage({ type: "WARNING", text: `Only ${pickedSupply.available} ${pickedSupply.unit}(s) available.` });
        return;
      }
      setBusy(true);
      try {
        await apiPost(holdsEndpoint, { supplyId: pickedSupply.id, quantity: qty });
        publishInlineMessage({ type: "SUCCESS", text: "Added from inventory." });
        reset();
        onOpenChange(false);
        onAdded();
      } catch (err) {
        publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to add from inventory.", err) });
      } finally {
        setBusy(false);
      }
      return;
    }

    const amt = parseFloat(cost);
    if (isNaN(amt) || amt <= 0) {
      publishInlineMessage({ type: "WARNING", text: "Please enter a valid cost." });
      return;
    }
    if (!description.trim()) {
      publishInlineMessage({ type: "WARNING", text: "Please enter a description." });
      return;
    }

    setBusy(true);
    try {
      await apiPost(endpoint, {
        cost: amt,
        description: description.trim(),
        category,
        vendor: vendor.trim() || null,
        date,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Expense added." });
      reset();
      onOpenChange(false);
      onAdded();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to add expense.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) reset();
        onOpenChange(e.open);
      }}
      initialFocusEl={() => cancelRef.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Add Expense</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {showInventoryToggle && (
                  <HStack gap={1} wrap="wrap">
                    <Button
                      size="xs"
                      variant={mode === "custom" ? "solid" : "outline"}
                      onClick={() => setMode("custom")}
                    >
                      Custom
                    </Button>
                    <Button
                      size="xs"
                      variant={mode === "inventory" ? "solid" : "outline"}
                      colorPalette={mode === "inventory" ? "blue" : "gray"}
                      onClick={() => setMode("inventory")}
                      disabled={supplies.length === 0}
                      title={supplies.length === 0 ? "No supplies in inventory yet" : "Pull from inventory"}
                    >
                      From inventory
                    </Button>
                  </HStack>
                )}
                {showInventoryToggle && mode === "inventory" ? (
                  <>
                    <div>
                      <Text mb="1">Supply *</Text>
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
                    </div>
                    <div>
                      <Text mb="1">Quantity *</Text>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={pickedQty}
                        onChange={(e) => setPickedQty(e.target.value)}
                        size="sm"
                        placeholder={pickedSupply ? `# of ${pickedSupply.unit}` : "Quantity"}
                      />
                      {pickedSupply && pickedQty && Number(pickedQty) > 0 && (
                        <Text fontSize="xs" color="fg.muted" mt={1}>
                          {Number(pickedQty)} {pickedSupply.unit} × ${pickedSupply.jobPayoutCost.toFixed(2)} = ${(Number(pickedQty) * pickedSupply.jobPayoutCost).toFixed(2)}
                          <Text as="span" color={Number(pickedQty) > pickedSupply.available ? "red.600" : "fg.muted"} ml={1}>
                            ({pickedSupply.available} available)
                          </Text>
                        </Text>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                <div>
                  <Text mb="1">Cost *</Text>
                  <CurrencyInput
                    value={cost}
                    onChange={(v) => setCost(v)}
                    size="sm"
                  />
                </div>
                <div>
                  <Text mb="1">Description *</Text>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g. fuel, supplies, dump fee"
                    size="sm"
                  />
                </div>
                <div>
                  <Text mb="1">Category (Schedule C line)</Text>
                  <Select.Root
                    collection={collection}
                    value={[category]}
                    onValueChange={(e) => setCategory(e.value?.[0] ?? DEFAULT_CATEGORY)}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger w="full">
                        <Select.ValueText placeholder="Supplies" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {items.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                  <Text fontSize="xs" color="fg.muted" mt={1}>
                    Default: Supplies. Pick a different line if it fits better — used for tax reporting.
                  </Text>
                </div>
                <div>
                  <Text mb="1">Vendor</Text>
                  <Input
                    value={vendor}
                    onChange={(e) => setVendor(e.target.value)}
                    placeholder="e.g. Shell, Lowes"
                    size="sm"
                  />
                </div>
                <div>
                  <Text mb="1">Date</Text>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    style={{
                      padding: "6px 8px",
                      fontSize: "14px",
                      border: "1px solid var(--chakra-colors-gray-200)",
                      borderRadius: "6px",
                      width: "100%",
                    }}
                  />
                </div>
                  </>
                )}
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  variant="ghost"
                  ref={cancelRef}
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  colorPalette="green"
                  onClick={handleSubmit}
                  loading={busy}
                  disabled={
                    mode === "inventory"
                      ? !pickedSupplyId ||
                        !pickedQty ||
                        !Number.isInteger(Number(pickedQty)) ||
                        Number(pickedQty) <= 0 ||
                        !!(pickedSupply && Number(pickedQty) > pickedSupply.available)
                      : !cost || !description.trim()
                  }
                >
                  {mode === "inventory" ? "Add from inventory" : "Add Expense"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
