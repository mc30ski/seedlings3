"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { Download, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";

type BusinessExpense = {
  id: string;
  date: string;
  cost: number;
  description: string;
  category?: string | null;
  vendor?: string | null;
  notes?: string | null;
  createdAt: string;
  createdBy?: { id: string; displayName?: string | null; email?: string | null };
};

type Summary = {
  today: number;
  thisWeek: number;
  thisMonth: number;
  thisYear: number;
  total: number;
  byCategory: Record<string, number>;
  count: number;
};

const COMMON_CATEGORIES = [
  "Insurance",
  "Fuel",
  "Vehicle Maintenance",
  "Equipment Purchase",
  "Equipment Repair",
  "Office Supplies",
  "Software/Subscription",
  "Marketing",
  "Professional Services",
  "Tax/License",
  "Bank Fees",
  "Other",
];

function fmtUSD(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString();
}

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function BusinessExpensesTab() {
  const [expenses, setExpenses] = useState<BusinessExpense[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);

  // Filters
  const [q, setQ] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterCategory, setFilterCategory] = useState("");

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BusinessExpense | null>(null);
  const [comingSoonOpen, setComingSoonOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<BusinessExpense | null>(null);

  // Form
  const [fDate, setFDate] = useState("");
  const [fCost, setFCost] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fVendor, setFVendor] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterFrom) params.set("from", filterFrom);
      if (filterTo) params.set("to", filterTo);
      if (filterCategory) params.set("category", filterCategory);
      if (q.trim()) params.set("q", q.trim());
      const qs = params.toString();
      const list = await apiGet<BusinessExpense[]>(`/api/admin/business-expenses${qs ? `?${qs}` : ""}`);
      setExpenses(Array.isArray(list) ? list : []);
      const sumQs = new URLSearchParams();
      if (filterFrom) sumQs.set("from", filterFrom);
      if (filterTo) sumQs.set("to", filterTo);
      const s = await apiGet<Summary>(`/api/admin/business-expenses/summary${sumQs.toString() ? `?${sumQs.toString()}` : ""}`);
      setSummary(s);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load expenses.", err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // re-load when filters change (debounced for search)
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
  }, [q, filterFrom, filterTo, filterCategory]);

  function openCreate() {
    setEditing(null);
    setFDate(todayStr());
    setFCost("");
    setFDescription("");
    setFCategory("");
    setFVendor("");
    setFNotes("");
    setDialogOpen(true);
  }

  function openEdit(e: BusinessExpense) {
    setEditing(e);
    setFDate(e.date.slice(0, 10));
    setFCost(e.cost.toFixed(2));
    setFDescription(e.description);
    setFCategory(e.category ?? "");
    setFVendor(e.vendor ?? "");
    setFNotes(e.notes ?? "");
    setDialogOpen(true);
  }

  async function save() {
    if (!fDate || !fDescription.trim() || !fCost) {
      publishInlineMessage({ type: "WARNING", text: "Date, description, and cost are required." });
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        date: fDate,
        cost: parseFloat(fCost),
        description: fDescription.trim(),
        category: fCategory.trim() || null,
        vendor: fVendor.trim() || null,
        notes: fNotes.trim() || null,
      };
      if (editing) {
        await apiPatch(`/api/admin/business-expenses/${editing.id}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Expense updated." });
      } else {
        await apiPost("/api/admin/business-expenses", payload);
        publishInlineMessage({ type: "SUCCESS", text: "Expense added." });
      }
      setDialogOpen(false);
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage(editing ? "Update failed." : "Add failed.", err) });
    } finally {
      setSaving(false);
    }
  }

  async function doDelete(id: string) {
    try {
      await apiDelete(`/api/admin/business-expenses/${id}`);
      publishInlineMessage({ type: "SUCCESS", text: "Expense deleted." });
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  const allCategories = useMemo(() => {
    const seen = new Set<string>();
    for (const c of COMMON_CATEGORIES) seen.add(c);
    for (const e of expenses) if (e.category) seen.add(e.category);
    return Array.from(seen).sort();
  }, [expenses]);

  const usedCategories = useMemo(() => {
    const seen = new Set<string>();
    for (const e of expenses) if (e.category) seen.add(e.category);
    return Array.from(seen).sort();
  }, [expenses]);

  function clearFilters() {
    setQ("");
    setFilterFrom("");
    setFilterTo("");
    setFilterCategory("");
  }

  const hasFilters = !!(q || filterFrom || filterTo || filterCategory);

  return (
    <Box w="full">
      <HStack justify="space-between" mb={3} wrap="wrap" gap={2}>
        <Text fontWeight="bold" fontSize="lg">Business Expenses</Text>
        <HStack gap={2}>
          <Button size="sm" variant="outline" onClick={() => setComingSoonOpen(true)} title="Export for tax software">
            <Download size={14} /> Export
          </Button>
          <Button size="sm" colorPalette="blue" onClick={openCreate}>
            <Plus size={14} /> Add Expense
          </Button>
        </HStack>
      </HStack>

      {/* Summary */}
      {summary && (
        <Card.Root variant="outline" mb={3}>
          <Card.Body p={3}>
            <HStack gap={6} wrap="wrap">
              <VStack align="start" gap={0}>
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">Today</Text>
                <Text fontSize="md" fontWeight="bold">{fmtUSD(summary.today)}</Text>
              </VStack>
              <VStack align="start" gap={0}>
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">This Week</Text>
                <Text fontSize="md" fontWeight="bold">{fmtUSD(summary.thisWeek)}</Text>
              </VStack>
              <VStack align="start" gap={0}>
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">This Month</Text>
                <Text fontSize="md" fontWeight="bold">{fmtUSD(summary.thisMonth)}</Text>
              </VStack>
              <VStack align="start" gap={0}>
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">This Year</Text>
                <Text fontSize="md" fontWeight="bold">{fmtUSD(summary.thisYear)}</Text>
              </VStack>
              <VStack align="start" gap={0}>
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">Total {hasFilters ? "(filtered)" : ""}</Text>
                <Text fontSize="md" fontWeight="bold" color="orange.600">{fmtUSD(summary.total)}</Text>
              </VStack>
              <VStack align="start" gap={0}>
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">Entries</Text>
                <Text fontSize="md" fontWeight="bold">{summary.count}</Text>
              </VStack>
            </HStack>
            {Object.keys(summary.byCategory).length > 0 && (
              <Box mt={3} pt={3} borderTopWidth="1px" borderColor="gray.200">
                <Text fontSize="xs" color="fg.muted" mb={1.5}>By Category {hasFilters ? "(filtered)" : ""}</Text>
                <HStack gap={2} wrap="wrap">
                  {Object.entries(summary.byCategory)
                    .sort((a, b) => b[1] - a[1])
                    .map(([cat, amt]) => (
                      <Badge key={cat} size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="2">
                        {cat}: {fmtUSD(amt)}
                      </Badge>
                    ))}
                </HStack>
              </Box>
            )}
          </Card.Body>
        </Card.Root>
      )}

      {/* Filters */}
      <Card.Root variant="outline" mb={3}>
        <Card.Body p={3}>
          <HStack gap={2} wrap="wrap">
            <HStack gap={1} flex="1" minW="200px">
              <Search size={14} color="var(--chakra-colors-gray-500)" />
              <Input
                size="sm"
                placeholder="Search description, vendor, notes…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </HStack>
            <HStack gap={1}>
              <Text fontSize="xs" color="fg.muted">From</Text>
              <input
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
                style={{ padding: "4px 8px", fontSize: "13px", border: "1px solid var(--chakra-colors-gray-200)", borderRadius: "6px" }}
              />
            </HStack>
            <HStack gap={1}>
              <Text fontSize="xs" color="fg.muted">To</Text>
              <input
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
                style={{ padding: "4px 8px", fontSize: "13px", border: "1px solid var(--chakra-colors-gray-200)", borderRadius: "6px" }}
              />
            </HStack>
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              style={{ padding: "4px 8px", fontSize: "13px", border: "1px solid var(--chakra-colors-gray-200)", borderRadius: "6px", background: "white" }}
            >
              <option value="">All categories</option>
              {usedCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {hasFilters && (
              <Button size="xs" variant="ghost" onClick={clearFilters}>
                <X size={12} /> Clear
              </Button>
            )}
          </HStack>
        </Card.Body>
      </Card.Root>

      {/* List */}
      {loading && expenses.length === 0 ? (
        <Box py={8} textAlign="center"><Spinner /></Box>
      ) : expenses.length === 0 ? (
        <Box py={8} textAlign="center" color="fg.muted">
          <Text>{hasFilters ? "No expenses match the current filters." : "No business expenses yet. Click Add Expense to get started."}</Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={1}>
          {expenses.map((e) => (
            <Card.Root key={e.id} variant="outline">
              <Card.Body p={3}>
                <HStack justify="space-between" align="flex-start" gap={2}>
                  <Box flex="1" minW={0}>
                    <HStack gap={2} wrap="wrap" mb={0.5}>
                      <Text fontSize="sm" fontWeight="semibold">{e.description}</Text>
                      {e.category && (
                        <Badge size="sm" colorPalette="purple" variant="subtle" borderRadius="full" px="2">
                          {e.category}
                        </Badge>
                      )}
                    </HStack>
                    <HStack gap={3} fontSize="xs" color="fg.muted" wrap="wrap">
                      <Text>{fmtDate(e.date)}</Text>
                      {e.vendor && <Text>· {e.vendor}</Text>}
                      {e.createdBy?.displayName && <Text>· by {e.createdBy.displayName}</Text>}
                    </HStack>
                    {e.notes && (
                      <Text fontSize="xs" color="fg.muted" mt={1}>{e.notes}</Text>
                    )}
                  </Box>
                  <VStack align="end" gap={1}>
                    <Text fontSize="md" fontWeight="bold" color="orange.600">{fmtUSD(e.cost)}</Text>
                    <HStack gap={1}>
                      <Button size="xs" variant="ghost" onClick={() => openEdit(e)} title="Edit">
                        <Pencil size={12} />
                      </Button>
                      <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setConfirmDelete(e)} title="Delete">
                        <Trash2 size={12} />
                      </Button>
                    </HStack>
                  </VStack>
                </HStack>
              </Card.Body>
            </Card.Root>
          ))}
        </VStack>
      )}

      {/* Add/Edit Dialog */}
      <Dialog.Root open={dialogOpen} onOpenChange={(e) => { if (!e.open) setDialogOpen(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>{editing ? "Edit Expense" : "Add Expense"}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="sm" mb={1}>Date *</Text>
                    <input
                      type="date"
                      value={fDate}
                      onChange={(e) => setFDate(e.target.value)}
                      style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid var(--chakra-colors-gray-200)", borderRadius: "6px" }}
                    />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Description *</Text>
                    <Input size="sm" value={fDescription} onChange={(e) => setFDescription(e.target.value)} placeholder="e.g., Liability insurance Q1" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Cost *</Text>
                    <CurrencyInput value={fCost} onChange={setFCost} size="sm" placeholder="0.00" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Category</Text>
                    <HStack gap={2}>
                      <Input size="sm" value={fCategory} onChange={(e) => setFCategory(e.target.value)} placeholder="e.g., Insurance" list="business-expense-categories" />
                      <datalist id="business-expense-categories">
                        {allCategories.map((c) => <option key={c} value={c} />)}
                      </datalist>
                    </HStack>
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Vendor</Text>
                    <Input size="sm" value={fVendor} onChange={(e) => setFVendor(e.target.value)} placeholder="e.g., State Farm" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Notes</Text>
                    <Textarea size="sm" value={fNotes} onChange={(e) => setFNotes(e.target.value)} placeholder="Optional notes" rows={2} />
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
                    Cancel
                  </Button>
                  <Button colorPalette="blue" onClick={save} loading={saving} disabled={!fDate || !fDescription.trim() || !fCost}>
                    {editing ? "Save" : "Add"}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Coming Soon Dialog */}
      <Dialog.Root open={comingSoonOpen} onOpenChange={(e) => { if (!e.open) setComingSoonOpen(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Export — Coming Soon</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm">
                  Export to a tax-software-friendly format (CSV / QuickBooks-compatible) is not yet implemented.
                  When ready, this will produce a file you can directly import into TurboTax, QuickBooks, or other tax/accounting software.
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <Button colorPalette="blue" onClick={() => setComingSoonOpen(false)}>Got it</Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Delete confirmation */}
      <Dialog.Root open={!!confirmDelete} onOpenChange={(e) => { if (!e.open) setConfirmDelete(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Delete Expense?</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm">
                  Delete <b>{confirmDelete?.description}</b> ({confirmDelete ? fmtUSD(confirmDelete.cost) : ""})? This cannot be undone.
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                  <Button colorPalette="red" onClick={() => { if (confirmDelete) { void doDelete(confirmDelete.id); setConfirmDelete(null); } }}>
                    Delete
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}
