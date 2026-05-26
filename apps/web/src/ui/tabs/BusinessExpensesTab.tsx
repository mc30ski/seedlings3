"use client";

// Accounting tab (filename + component still "BusinessExpenses" for history —
// the model is named BusinessExpense in Prisma and the API route prefix is
// /api/admin/business-expenses; renaming any of those would be a wide blast
// radius for no functional gain, so the rename is label-only).
//
// Entry types (BusinessExpense.type discriminator, see schema.prisma):
//   - EXPENSE              — operating cash-out (Schedule C / P&L)
//   - CAPITAL_CONTRIBUTION — owner money INTO the business (equity)
//   - OWNER_DRAW           — owner money OUT of the business (equity)
// Entry type is chosen at create time in the dialog. The Type picker is
// locked on rows linked to a job or supply purchase (always EXPENSE).
//
// What this tab shows:
//   1. "Due to record" — forecasted next instance of recurring rows of any
//      type (predictions). Sourced from /business-expenses/due-soon.
//   2. Summary card — total / count / by-category for the filtered range.
//      EXPENSE-only on the backend; hidden when the user is filtered to an
//      equity-only view (the numbers would be misleading).
//   3. Earnings vs Expenses — management P&L. EXPENSE-only on the backend;
//      same hide rule as Summary.
//   4. Filters + paginated list. Type filter (All / Expenses / Capital
//      contributions / Owner draws) sits next to Category. Type badge is
//      rendered on equity entries only (expense cards stay visually clean).
//   5. CSV export ("Export" button) — Schedule C-aligned; hard-pinned to
//      type=EXPENSE regardless of on-screen filter. Equity export lives on
//      the Exports tab as qb-equity.csv.
//
// Three creation paths into BusinessExpense (always EXPENSE except #1):
//   - Freestanding — admin types into Add Entry (any type).
//   - Job-paired — worker logs an Expense on a JobOccurrence (EXPENSE).
//   - Supply-paired — SupplyPurchase creates a BE at buy time (EXPENSE).
//
// QuickBooks-side mapping:
//   EXPENSE              → Schedule C line via EXPENSE_CATEGORIES setting
//   CAPITAL_CONTRIBUTION → "Owner's Investment" equity account
//   OWNER_DRAW           → "Owner's Draw" equity account

import { useEffect, useMemo, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Spinner,
  Text,
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { Download, Eye, Paperclip, Pencil, Plus, Repeat, Search, Trash2, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import ReceiptUpload from "@/src/ui/components/ReceiptUpload";
import { compressOnly } from "@/src/lib/imageRedact";
import { useExpenseCategories } from "@/src/lib/useExpenseCategories";

type EntryType = "EXPENSE" | "CAPITAL_CONTRIBUTION" | "OWNER_DRAW";

const ENTRY_TYPE_LABELS: Record<EntryType, string> = {
  EXPENSE: "Expense",
  CAPITAL_CONTRIBUTION: "Capital Contribution",
  OWNER_DRAW: "Owner Draw",
};

// Color palette per type for the badge on each card. EXPENSE keeps the
// neutral look it already had (no badge below); equity entries get a
// distinct color so the operator immediately sees that it's not a P&L item.
const ENTRY_TYPE_COLOR: Record<EntryType, string> = {
  EXPENSE: "gray",
  CAPITAL_CONTRIBUTION: "green",
  OWNER_DRAW: "pink",
};

type BusinessExpense = {
  id: string;
  type: EntryType;
  date: string;
  cost: number;
  description: string;
  category?: string | null;
  vendor?: string | null;
  invoiceNumber?: string | null;
  notes?: string | null;
  equipmentId?: string | null;
  equipment?: { id: string; shortDesc?: string | null; brand?: string | null; model?: string | null; qrSlug?: string | null } | null;
  occurrenceId?: string | null;
  occurrence?: { id: string; startAt?: string | null; job?: { id: string; property?: { id: string; displayName?: string | null; client?: { displayName?: string | null } | null } | null } | null } | null;
  supplyPurchase?: {
    id: string;
    quantity: number;
    unitCost: number;
    supply: { id: string; name: string; unit: string };
  } | null;
  receiptR2Key?: string | null;
  receiptFileName?: string | null;
  receiptContentType?: string | null;
  receiptUploadedAt?: string | null;
  recurrence?: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY" | null;
  createdAt: string;
  createdBy?: { id: string; displayName?: string | null; email?: string | null };
};

type DueSoonSuggestion = {
  nextExpectedDate: string;
  overdueDays: number;
  recurrence: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY";
  type: EntryType;
  prefill: {
    type: EntryType;
    description: string;
    cost: number;
    category: string | null;
    vendor: string | null;
    invoiceNumber: string | null;
    notes: string | null;
    equipmentId: string | null;
    recurrence: "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY";
  };
  latestId: string;
  latestDate: string;
  latestCost: number;
};

const RECURRENCE_LABELS: Record<string, string> = {
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUALLY: "Annually",
};
// Singular noun used in copy like "one month from now". "Annually" → "year",
// not "annual", so the prose reads naturally.
const RECURRENCE_NOUNS: Record<string, string> = {
  WEEKLY: "week",
  MONTHLY: "month",
  QUARTERLY: "quarter",
  ANNUALLY: "year",
};

type EquipmentLite = {
  id: string;
  shortDesc?: string | null;
  brand?: string | null;
  model?: string | null;
  qrSlug?: string | null;
  retiredAt?: string | null;
};

function equipmentLabel(e: EquipmentLite): string {
  const parts = [e.brand, e.model].filter(Boolean);
  if (e.shortDesc) return `${e.shortDesc}${parts.length ? ` (${parts.join(" ")})` : ""}`;
  if (parts.length) return parts.join(" ");
  return e.qrSlug || e.id.slice(-6);
}

type Summary = {
  today: number;
  thisWeek: number;
  thisMonth: number;
  thisYear: number;
  total: number;
  byCategory: Record<string, number>;
  count: number;
};

// Earnings vs Expenses for the selected timeframe (single range, not buckets).
type Comparison = {
  platformFees: number;
  businessMargin: number;
  equipmentRentals: number;
  earnings: number;
  expenses: number;
  processingFees: number;
  net: number;
};

// Categories aligned to Schedule C (Form 1040). The label is what gets stored
// in the DB so it imports cleanly into tax software; the line number is shown
// in the picker for clarity. COGS / Part III is intentionally omitted —
// materials consumed in the course of providing services land on line 22 for
// a small service business under cash-method accounting.
// Expense categories + Schedule C lines come from the EXPENSE_CATEGORIES
// taxonomy via useExpenseCategories() — the single source of truth.

function fmtUSD(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString();
}

function todayStr(): string {
  return ymd(new Date());
}

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Backward-looking, calendar-accurate ranges for the summary timeframe — the
// shared datePresets lib is forward-looking (built for job scheduling), wrong
// for expenses. Tax-oriented: month/quarter/year to date, plus last year.
type ExpensePreset = "last30" | "month" | "quarter" | "year" | "lastYear" | "all" | "custom";

// Order matters — these render left-to-right. "All time" sits at the end
// because it's the rarest choice (and the most expensive query). Default is
// "Last 30 days" — covers the typical "what did we spend recently" question
// without pulling the full history every time the tab opens.
const EXPENSE_PRESETS: { key: ExpensePreset; label: string }[] = [
  { key: "last30", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "quarter", label: "This quarter" },
  { key: "year", label: "This year" },
  { key: "lastYear", label: "Last year" },
  { key: "all", label: "All time" },
];

function rangeForExpensePreset(p: ExpensePreset): { from: string; to: string } {
  const now = new Date();
  const today = ymd(now);
  switch (p) {
    case "last30": {
      const from = new Date(now);
      from.setDate(from.getDate() - 30);
      return { from: ymd(from), to: today };
    }
    case "month":
      return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case "quarter": {
      const q = Math.floor(now.getMonth() / 3);
      return { from: ymd(new Date(now.getFullYear(), q * 3, 1)), to: today };
    }
    case "year":
      return { from: ymd(new Date(now.getFullYear(), 0, 1)), to: today };
    case "lastYear":
      return {
        from: ymd(new Date(now.getFullYear() - 1, 0, 1)),
        to: ymd(new Date(now.getFullYear() - 1, 11, 31)),
      };
    case "all":
    default:
      return { from: "", to: "" };
  }
}

export default function BusinessExpensesTab() {
  const { categories, selectableCategories, lineFor } = useExpenseCategories();
  const [expenses, setExpenses] = useState<BusinessExpense[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(false);

  // Filters. filterFrom/filterTo are the shared date range — set by the
  // summary timeframe control and scoped across the summary, list, and export.
  // Default to last-30-days so the tab opens to a sensible, bounded window.
  const initialRange = rangeForExpensePreset("last30");
  const [q, setQ] = useState("");
  const [filterFrom, setFilterFrom] = useState(initialRange.from);
  const [filterTo, setFilterTo] = useState(initialRange.to);
  const [filterCategory, setFilterCategory] = useState("");
  // "" = all types. EXPENSE | CAPITAL_CONTRIBUTION | OWNER_DRAW narrows.
  const [filterType, setFilterType] = useState<"" | EntryType>("");
  const [expensePreset, setExpensePreset] = useState<ExpensePreset>("last30");

  function applyPreset(p: ExpensePreset) {
    setExpensePreset(p);
    if (p !== "custom") {
      const r = rangeForExpensePreset(p);
      setFilterFrom(r.from);
      setFilterTo(r.to);
    }
  }

  // Pagination — most recent first, page back through history. pageSize is
  // user-controlled (persisted) so the choice survives reloads. page resets
  // to 1 whenever a filter changes.
  const [pageSize, setPageSize] = usePersistedState<number>("be_pageSize", 20);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BusinessExpense | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BusinessExpense | null>(null);

  // Form
  const [fType, setFType] = useState<EntryType>("EXPENSE");
  const [fDate, setFDate] = useState("");
  const [fCost, setFCost] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fVendor, setFVendor] = useState("");
  const [fInvoiceNumber, setFInvoiceNumber] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [fEquipmentId, setFEquipmentId] = useState<string>("");
  const [fRecurrence, setFRecurrence] = useState<string>(""); // "" = one-off
  // Buffered receipt for create flow — uploaded against the new BE id after
  // POST returns. On edit, ReceiptUpload talks to the API directly so this
  // stays null.
  const [fNewReceiptFile, setFNewReceiptFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [equipmentList, setEquipmentList] = useState<EquipmentLite[]>([]);
  // Recurring-expense suggestions panel.
  const [dueSoon, setDueSoon] = useState<DueSoonSuggestion[]>([]);
  const [confirmSkip, setConfirmSkip] = useState<DueSoonSuggestion | null>(null);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterFrom) params.set("from", filterFrom);
      if (filterTo) params.set("to", filterTo);
      if (filterCategory) params.set("category", filterCategory);
      if (filterType) params.set("type", filterType);
      if (q.trim()) params.set("q", q.trim());
      params.set("limit", String(pageSize));
      params.set("offset", String((page - 1) * pageSize));
      const qs = params.toString();
      const resp = await apiGet<{ rows: BusinessExpense[]; total: number }>(`/api/admin/business-expenses${qs ? `?${qs}` : ""}`);
      setExpenses(Array.isArray(resp?.rows) ? resp.rows : []);
      setTotal(typeof resp?.total === "number" ? resp.total : 0);
      const sumQs = new URLSearchParams();
      if (filterFrom) sumQs.set("from", filterFrom);
      if (filterTo) sumQs.set("to", filterTo);
      const s = await apiGet<Summary>(`/api/admin/business-expenses/summary${sumQs.toString() ? `?${sumQs.toString()}` : ""}`);
      setSummary(s);
      // Earnings vs Expenses — scoped to the same selected timeframe.
      try {
        const cmp = await apiGet<Comparison>(`/api/admin/business-expenses/vs-revenue${sumQs.toString() ? `?${sumQs.toString()}` : ""}`);
        setComparison(cmp);
      } catch { /* non-fatal */ }
      // Due-to-record suggestions (also global; recurrence is a property of
      // the series, not the current filter view).
      try {
        const ds = await apiGet<DueSoonSuggestion[]>("/api/admin/business-expenses/due-soon");
        setDueSoon(Array.isArray(ds) ? ds : []);
      } catch { /* non-fatal */ }
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load expenses.", err) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    apiGet<EquipmentLite[]>("/api/equipment/all")
      .then((list) => setEquipmentList(Array.isArray(list) ? list : []))
      .catch(() => setEquipmentList([]));
  }, []);

  // Filter changes always reset to page 1 — otherwise you could be on
  // page 5 of "all", flip the category filter, and silently land on what
  // is now an empty page 5 of the narrower set.
  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filterFrom, filterTo, filterCategory, filterType, pageSize]);

  // Re-load when filters or pagination change. Search is debounced; page/
  // pageSize changes load immediately.
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filterFrom, filterTo, filterCategory, filterType, page, pageSize]);

  function openCreate() {
    setEditing(null);
    // If the user is filtered to a specific entry type, default new entries
    // to that type — they're almost certainly adding more of the same.
    setFType(filterType || "EXPENSE");
    setFDate(todayStr());
    setFCost("");
    setFDescription("");
    setFCategory("");
    setFVendor("");
    setFInvoiceNumber("");
    setFNotes("");
    setFEquipmentId("");
    setFRecurrence("");
    setFNewReceiptFile(null);
    setDialogOpen(true);
  }

  function openEdit(e: BusinessExpense) {
    setEditing(e);
    setFType(e.type);
    setFDate(e.date.slice(0, 10));
    setFCost(e.cost.toFixed(2));
    setFDescription(e.description);
    // Existing rows may carry old free-text categories that aren't in the
    // Schedule C list. Surface them as-is so the picker shows them as
    // unselected and the user can re-pick a valid one. Save logic still
    // accepts the empty string.
    setFCategory(e.category ?? "");
    setFVendor(e.vendor ?? "");
    setFInvoiceNumber(e.invoiceNumber ?? "");
    setFNotes(e.notes ?? "");
    setFEquipmentId(e.equipmentId ?? "");
    setFRecurrence(e.recurrence ?? "");
    setFNewReceiptFile(null);
    setDialogOpen(true);
  }

  // Open the Add Expense dialog pre-filled from a "Due to record"
  // suggestion. Date is the next expected date (editable); cost is the last
  // paid amount (editable); description/vendor/category/recurrence carry
  // forward unchanged. Treated as a CREATE (editing=null) so the new row
  // becomes the most-recent in its series after save.
  function openFromSuggestion(s: DueSoonSuggestion) {
    setEditing(null);
    setFType(s.prefill.type);
    setFDate(s.nextExpectedDate);
    setFCost(s.prefill.cost.toFixed(2));
    setFDescription(s.prefill.description);
    setFCategory(s.prefill.category ?? "");
    setFVendor(s.prefill.vendor ?? "");
    setFInvoiceNumber("");
    setFNotes("");
    setFEquipmentId(s.prefill.equipmentId ?? "");
    setFRecurrence(s.prefill.recurrence);
    setFNewReceiptFile(null);
    setDialogOpen(true);
  }

  // Confirmed skip — store the dismissed expected date on the most recent
  // row; the panel removes it optimistically. On failure, restore.
  async function doSkip(s: DueSoonSuggestion) {
    const prevDueSoon = dueSoon;
    setDueSoon((rows) => rows.filter((r) => r.latestId !== s.latestId));
    try {
      await apiPost(
        `/api/admin/business-expenses/${s.latestId}/skip-recurrence`,
        { skipDate: s.nextExpectedDate },
      );
      publishInlineMessage({
        type: "SUCCESS",
        text: `Skipped ${s.prefill.description} for this period.`,
      });
    } catch (err) {
      setDueSoon(prevDueSoon);
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Skip failed.", err),
      });
    }
  }

  async function save() {
    if (!fDate || !fDescription.trim() || !fCost) {
      publishInlineMessage({ type: "WARNING", text: "Date, description, and cost are required." });
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        type: fType,
        date: fDate,
        cost: parseFloat(fCost),
        description: fDescription.trim(),
        // Category/equipment are expense-only — server ignores them on
        // equity types, but blank them on the wire too for clarity.
        category: fType === "EXPENSE" ? (fCategory.trim() || null) : null,
        vendor: fVendor.trim() || null,
        invoiceNumber: fInvoiceNumber.trim() || null,
        notes: fNotes.trim() || null,
        equipmentId: fType === "EXPENSE" ? (fEquipmentId || null) : null,
        recurrence: fRecurrence || null,
      };
      if (editing) {
        await apiPatch(`/api/admin/business-expenses/${editing.id}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Expense updated." });
      } else {
        const created = await apiPost<{ id: string }>("/api/admin/business-expenses", payload);
        // Optional buffered receipt → upload against the new BE id. If this
        // fails the BE itself is fine, so we warn and let the user retry via
        // edit instead of rolling back the create.
        if (fNewReceiptFile && created?.id) {
          try {
            const file = fNewReceiptFile;
            const isPdf = file.type === "application/pdf";
            const body: Blob = isPdf ? file : await compressOnly(file);
            const contentType = isPdf ? "application/pdf" : "image/jpeg";
            const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
              `/api/admin/business-expenses/${created.id}/receipt/upload-url`,
              { fileName: file.name, contentType },
            );
            const uploadRes = await fetch(uploadUrl, {
              method: "PUT",
              body,
              headers: { "Content-Type": contentType },
            });
            if (!uploadRes.ok) {
              throw new Error(`Upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
            }
            await apiPost(`/api/admin/business-expenses/${created.id}/receipt`, {
              key,
              fileName: file.name,
              contentType,
            });
            publishInlineMessage({ type: "SUCCESS", text: "Expense added with receipt." });
          } catch (e) {
            publishInlineMessage({
              type: "WARNING",
              text: `Expense saved, but receipt upload failed: ${getErrorMessage("", e)}. Re-open the expense to attach.`,
            });
          }
        } else {
          publishInlineMessage({ type: "SUCCESS", text: "Expense added." });
        }
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
    for (const c of selectableCategories) seen.add(c.label);
    for (const e of expenses) if (e.category) seen.add(e.category);
    return Array.from(seen).sort();
  }, [expenses, selectableCategories]);

  const usedCategories = useMemo(() => {
    const seen = new Set<string>();
    for (const e of expenses) if (e.category) seen.add(e.category);
    return Array.from(seen).sort();
  }, [expenses]);

  function clearFilters() {
    setQ("");
    setFilterCategory("");
    setFilterType("");
    // Reset the date range to the default last-30-days window rather than
    // dumping the user into the full-history "All time" view.
    const r = rangeForExpensePreset("last30");
    setFilterFrom(r.from);
    setFilterTo(r.to);
    setExpensePreset("last30");
  }

  // Schedule C-aligned CSV export. Columns chosen for compatibility with tax
  // software import (TurboTax / QuickBooks / FreshBooks all accept this shape)
  // and for handing directly to a CPA. Includes the explicit Schedule C line
  // number so the categorization is unambiguous even if the importer doesn't
  // recognize the label by name.
  async function exportCsv() {
    // Re-fetch with all=true so the export contains every row matching
    // the current filters, not just the page on screen.
    const params = new URLSearchParams();
    if (filterFrom) params.set("from", filterFrom);
    if (filterTo) params.set("to", filterTo);
    if (filterCategory) params.set("category", filterCategory);
    if (q.trim()) params.set("q", q.trim());
    // Schedule C CSV is tax-shaped — columns are expense-specific. Hard-pin
    // to EXPENSE regardless of the on-screen Type filter so the file is
    // always meaningful. Equity entries export from the Exports tab.
    params.set("type", "EXPENSE");
    params.set("all", "true");
    let allRows: BusinessExpense[] = [];
    try {
      const resp = await apiGet<{ rows: BusinessExpense[]; total: number }>(
        `/api/admin/business-expenses?${params.toString()}`,
      );
      allRows = Array.isArray(resp?.rows) ? resp.rows : [];
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Export failed.", err) });
      return;
    }
    if (allRows.length === 0) return;

    const lineByCategory: Record<string, string> = {};
    for (const c of categories) lineByCategory[c.label] = c.scheduleCLine;

    const csvEscape = (v: unknown): string => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = [
      "Date",
      "Amount",
      "Category",
      "Schedule C Line",
      "Vendor",
      "Description",
      "Invoice Number",
      "Linked Equipment",
      "Linked Job",
      "Linked Supply",
      "Recurrence",
      "Notes",
    ];

    const rows: string[] = [headers.join(",")];
    // Stable order: by date (most recent first), matching what's on screen.
    const sorted = [...allRows].sort((a, b) => b.date.localeCompare(a.date));
    for (const e of sorted) {
      const eq = e.equipment;
      const eqLabel = eq
        ? [
            eq.shortDesc || [eq.brand, eq.model].filter(Boolean).join(" "),
            eq.qrSlug ? `(${eq.qrSlug})` : "",
          ].filter(Boolean).join(" ")
        : "";
      const job = e.occurrence?.job;
      const jobLabel = job?.property?.displayName
        ? `${job.property.displayName}${job.property.client?.displayName ? ` — ${job.property.client.displayName}` : ""}${e.occurrence?.startAt ? ` (${new Date(e.occurrence.startAt).toLocaleDateString()})` : ""}`
        : "";
      const sp = e.supplyPurchase;
      const supplyLabel = sp
        ? `${sp.supply.name} × ${sp.quantity} ${sp.supply.unit} @ $${sp.unitCost.toFixed(2)}`
        : "";
      rows.push([
        csvEscape(e.date.slice(0, 10)),
        csvEscape(e.cost.toFixed(2)),
        csvEscape(e.category ?? ""),
        csvEscape(e.category ? (lineByCategory[e.category] ?? "") : ""),
        csvEscape(e.vendor ?? ""),
        csvEscape(e.description),
        csvEscape(e.invoiceNumber ?? ""),
        csvEscape(eqLabel),
        csvEscape(jobLabel),
        csvEscape(supplyLabel),
        csvEscape(e.recurrence ? RECURRENCE_LABELS[e.recurrence] ?? e.recurrence : ""),
        csvEscape(e.notes ?? ""),
      ].join(","));
    }

    // BOM so Excel opens UTF-8 correctly without mangling em-dashes etc.
    const blob = new Blob(["﻿" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const fromStr = filterFrom || "all";
    const toStr = filterTo || "all";
    a.download = `business-expenses-${fromStr}-to-${toStr}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const hasFilters = !!(q || filterFrom || filterTo || filterCategory || filterType);

  return (
    <Box w="full" position="relative">
      {/* Full-tab loading overlay — same pattern used by Payments, Clients,
          Equipment, etc. Dims everything and centers a Spinner on top while
          a new timeframe or filter is being fetched. */}
      {loading && (
        <>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>
      )}
      <HStack justify="space-between" mb={3} wrap="wrap" gap={2}>
        <Text fontWeight="bold" fontSize="lg">Accounting</Text>
        <HStack gap={2}>
          <Button size="sm" variant="outline" onClick={() => void exportCsv()} disabled={total === 0} title="Download CSV for tax software / CPA">
            <Download size={14} /> Export
          </Button>
          <Button size="sm" colorPalette="blue" onClick={openCreate}>
            <Plus size={14} /> Add Entry
          </Button>
        </HStack>
      </HStack>

      {/* Due to record — recurring expenses whose next expected instance
          has arrived (or is within the lead window). Hidden when nothing
          is due so the panel doesn't nag with empty state. */}
      {dueSoon.length > 0 && (
        <Card.Root variant="outline" mb={3} borderColor="orange.300" bg="orange.50">
          <Card.Body p={3}>
            <Text fontSize="xs" fontWeight="semibold" color="orange.800" textTransform="uppercase" mb={2}>
              Due to record
            </Text>
            <VStack align="stretch" gap={1}>
              {dueSoon.map((s) => {
                const isOverdue = s.overdueDays > 0;
                const expectedLabel = new Date(s.nextExpectedDate + "T00:00:00").toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                });
                return (
                  <HStack
                    key={s.latestId}
                    gap={2}
                    p={2}
                    bg="white"
                    borderRadius="md"
                    borderWidth="1px"
                    borderColor={isOverdue ? "red.200" : "gray.200"}
                    fontSize="sm"
                    wrap="wrap"
                  >
                    <Box flex="1" minW="200px">
                      <Text fontWeight="medium" color="gray.800">
                        {s.prefill.description}
                        {s.prefill.vendor && <Text as="span" color="fg.muted"> — {s.prefill.vendor}</Text>}
                      </Text>
                      <HStack gap={2} fontSize="xs" color="fg.muted" wrap="wrap">
                        <Badge size="sm" colorPalette="purple" variant="subtle" borderRadius="full" px="2">
                          {RECURRENCE_LABELS[s.recurrence]}
                        </Badge>
                        <Text>last {fmtUSD(s.latestCost)} on {fmtDate(s.latestDate)}</Text>
                        <Text color={isOverdue ? "red.600" : "fg.muted"} fontWeight={isOverdue ? "medium" : "normal"}>
                          · {isOverdue ? `${s.overdueDays} day${s.overdueDays === 1 ? "" : "s"} overdue` : `due ${expectedLabel}`}
                        </Text>
                      </HStack>
                    </Box>
                    <HStack gap={1}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmSkip(s)}
                      >
                        Skip
                      </Button>
                      <Button
                        size="sm"
                        colorPalette="orange"
                        onClick={() => openFromSuggestion(s)}
                      >
                        Record
                      </Button>
                    </HStack>
                  </HStack>
                );
              })}
            </VStack>
          </Card.Body>
        </Card.Root>
      )}

      {/* Summary */}
      {/* Summary + Earnings vs Expenses are expense-only by design (P&L
          surfaces). Hide them when the user is filtered to an equity-only
          view — they'd be showing operating numbers that don't match the
          list. */}
      {summary && filterType !== "CAPITAL_CONTRIBUTION" && filterType !== "OWNER_DRAW" && (
        <Card.Root variant="outline" mb={3}>
          <Card.Body p={3}>
            {/* Timeframe — shared range, scopes the summary, list, and export. */}
            <HStack gap={1.5} wrap="wrap" align="center" mb={3}>
              {EXPENSE_PRESETS.map((p) => (
                <Button
                  key={p.key}
                  size="xs"
                  variant={expensePreset === p.key ? "solid" : "outline"}
                  colorPalette={expensePreset === p.key ? "blue" : "gray"}
                  onClick={() => applyPreset(p.key)}
                >
                  {p.label}
                </Button>
              ))}
              <HStack gap={1}>
                <Text fontSize="xs" color="fg.muted">From</Text>
                <input
                  type="date"
                  value={filterFrom}
                  onChange={(e) => { setFilterFrom(e.target.value); setExpensePreset("custom"); }}
                  style={{ padding: "4px 8px", fontSize: "13px", border: "1px solid var(--chakra-colors-gray-200)", borderRadius: "6px" }}
                />
              </HStack>
              <HStack gap={1}>
                <Text fontSize="xs" color="fg.muted">To</Text>
                <input
                  type="date"
                  value={filterTo}
                  onChange={(e) => { setFilterTo(e.target.value); setExpensePreset("custom"); }}
                  style={{ padding: "4px 8px", fontSize: "13px", border: "1px solid var(--chakra-colors-gray-200)", borderRadius: "6px" }}
                />
              </HStack>
            </HStack>
            <HStack gap={6} wrap="wrap">
              <VStack align="start" gap={0}>
                <Text fontSize="2xs" color="fg.muted" textTransform="uppercase">
                  Total{expensePreset === "all" ? "" : ` · ${EXPENSE_PRESETS.find((p) => p.key === expensePreset)?.label ?? "Custom range"}`}
                </Text>
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

      {/* TEMP — CPA-review reminder. Remove after reviewing equipment-rental treatment. */}
      <Box bg="red.50" borderWidth="1px" borderColor="red.300" borderRadius="md" p={3} mb={3}>
        <Text fontSize="sm" fontWeight="bold" color="red.700" mb={1}>
          Reminder — review equipment-rental treatment with a CPA
        </Text>
        <Text fontSize="xs" color="red.700">
          Equipment rental charges are internal — they reduce a worker's take-home and the business
          recovers them; they don't flow into any tax export (Gusto / QuickBooks).{" "}
          <b>Contractors (1099):</b> a business-to-business charge — confirm with a CPA how it nets
          against reported income.{" "}
          <b>Employees (W-2):</b> charging an employee for equipment is a wage deduction
          (payroll / labor-law regulated) — review with a CPA and payroll before charging real W-2
          staff. Owner charges are a wash.
        </Text>
        <Text fontSize="xs" color="red.600" mt={1} fontStyle="italic">
          Remove this note once reviewed with a CPA.
        </Text>
      </Box>

      {/* Earnings vs Expenses — for the selected timeframe */}
      {comparison && filterType !== "CAPITAL_CONTRIBUTION" && filterType !== "OWNER_DRAW" && (() => {
        const rangeLabel = expensePreset === "all"
          ? "All time"
          : EXPENSE_PRESETS.find((p) => p.key === expensePreset)?.label ?? "Custom range";
        const net = comparison.net;
        return (
          <Card.Root variant="outline" mb={3}>
            <Card.Body p={3}>
              <HStack justify="space-between" mb={1}>
                <Text fontSize="sm" fontWeight="semibold">Earnings vs Expenses</Text>
                <Badge size="sm" colorPalette="blue" variant="subtle" borderRadius="full">{rangeLabel}</Badge>
              </HStack>
              <Text fontSize="xs" color="fg.muted" mb={2}>
                Earnings = contractor platform fees + employee margin captured on payments + equipment rental charges (deducted from worker payouts). Net = earnings − business expenses − processing fees.
              </Text>
              <VStack align="stretch" gap={0} fontSize="xs">
                <HStack justify="space-between" py={1.5}>
                  <Text color="fg.muted">Platform fees (contractors)</Text>
                  <Text>{fmtUSD(comparison.platformFees)}</Text>
                </HStack>
                <HStack justify="space-between" py={1.5}>
                  <Text color="fg.muted">Margin (employees/trainees)</Text>
                  <Text>{fmtUSD(comparison.businessMargin)}</Text>
                </HStack>
                <HStack justify="space-between" py={1.5}>
                  <Text color="fg.muted">Equipment rentals</Text>
                  <Text>{fmtUSD(comparison.equipmentRentals)}</Text>
                </HStack>
                <HStack justify="space-between" py={1.5} borderTopWidth="1px" borderColor="gray.200">
                  <Text fontWeight="semibold" color="green.700">Earnings (total)</Text>
                  <Text fontWeight="semibold" color="green.700">{fmtUSD(comparison.earnings)}</Text>
                </HStack>
                <HStack justify="space-between" py={1.5}>
                  <Text fontWeight="semibold" color="orange.700">Business expenses</Text>
                  <Text fontWeight="semibold" color="orange.700">−{fmtUSD(comparison.expenses)}</Text>
                </HStack>
                {(comparison.processingFees ?? 0) > 0 && (
                  <HStack justify="space-between" py={1.5}>
                    <Text fontWeight="semibold" color="orange.700">Processing fees</Text>
                    <Text fontWeight="semibold" color="orange.700">−{fmtUSD(comparison.processingFees)}</Text>
                  </HStack>
                )}
                <HStack justify="space-between" py={1.5} borderTopWidth="2px" borderColor="gray.300">
                  <Text fontWeight="bold">Net</Text>
                  <Text fontWeight="bold" color={net >= 0 ? "green.700" : "red.600"}>
                    {net < 0 ? "−" : ""}{fmtUSD(Math.abs(net))}
                  </Text>
                </HStack>
              </VStack>
              <Text fontSize="xs" color="fg.muted" mt={2}>
                Management view only. For tax reporting use QuickBooks exports + Gusto.
              </Text>
            </Card.Body>
          </Card.Root>
        );
      })()}

      {/* Filters */}
      <Card.Root variant="outline" mb={3}>
        <Card.Body p={3}>
          <HStack gap={2} wrap="wrap">
            <HStack gap={1} flex="1" minW="200px">
              <Search size={14} color="var(--chakra-colors-gray-500)" />
              <Input
                size="sm"
                placeholder="Search…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </HStack>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as "" | EntryType)}
              title="Filter by entry type"
              style={{
                padding: "4px 8px",
                fontSize: "13px",
                border: "1px solid var(--chakra-colors-gray-200)",
                borderRadius: "6px",
                background: "white",
              }}
            >
              <option value="">All types</option>
              <option value="EXPENSE">Expenses</option>
              <option value="CAPITAL_CONTRIBUTION">Capital contributions</option>
              <option value="OWNER_DRAW">Owner draws</option>
            </select>
            <CategoryFilterSelect
              value={filterCategory}
              onChange={setFilterCategory}
              categories={usedCategories}
            />
            {hasFilters && (
              <Button size="xs" variant="ghost" onClick={clearFilters}>
                <X size={12} /> Clear
              </Button>
            )}
          </HStack>
        </Card.Body>
      </Card.Root>

      {/* List. Initial-load spinner is handled by the full-tab overlay
          above; here we just show the empty state when not loading. */}
      {expenses.length === 0 ? (
        !loading && (
          <Box py={8} textAlign="center" color="fg.muted">
            <Text>{hasFilters ? "No entries match the current filters." : "No entries yet. Click Add Entry to get started."}</Text>
          </Box>
        )
      ) : (
        <VStack align="stretch" gap={1}>
          {expenses.map((e) => (
            <Card.Root key={e.id} variant="outline">
              <Card.Body p={3}>
                <HStack justify="space-between" align="flex-start" gap={2}>
                  <Box flex="1" minW={0}>
                    <HStack gap={2} wrap="wrap" mb={0.5}>
                      <Text fontSize="sm" fontWeight="semibold">{e.description}</Text>
                      {/* Type badge — shown only for equity entries so the
                          expense list stays visually identical to before. */}
                      {e.type !== "EXPENSE" && (
                        <Badge
                          size="sm"
                          colorPalette={ENTRY_TYPE_COLOR[e.type]}
                          variant="subtle"
                          borderRadius="full"
                          px="2"
                          title="Equity entry — excluded from P&L and Schedule C"
                        >
                          {ENTRY_TYPE_LABELS[e.type]}
                        </Badge>
                      )}
                      {e.recurrence && (
                        <Badge
                          size="sm"
                          colorPalette="cyan"
                          variant="subtle"
                          borderRadius="full"
                          px="2"
                          title={`Repeats ${RECURRENCE_LABELS[e.recurrence].toLowerCase()}`}
                        >
                          <HStack gap="1" align="center">
                            <Repeat size={12} />
                            <Text as="span">{RECURRENCE_LABELS[e.recurrence]}</Text>
                          </HStack>
                        </Badge>
                      )}
                      {e.category && (
                        <Badge
                          size="sm"
                          colorPalette="purple"
                          variant={filterCategory === e.category ? "solid" : "subtle"}
                          borderRadius="full"
                          px="2"
                          cursor="pointer"
                          _hover={{ bg: filterCategory === e.category ? undefined : "purple.100" }}
                          title={filterCategory === e.category ? "Click to clear filter" : "Filter by this category"}
                          onClick={() => setFilterCategory(filterCategory === e.category ? "" : (e.category ?? ""))}
                        >
                          {e.category}
                          {e.category && lineFor(e.category) && (
                            <Text as="span" ml={1} opacity={0.75}>
                              (line {lineFor(e.category)})
                            </Text>
                          )}
                        </Badge>
                      )}
                      {e.occurrenceId && e.occurrence?.job?.property?.displayName && (
                        <Badge
                          size="sm"
                          colorPalette="teal"
                          variant="subtle"
                          borderRadius="full"
                          px="2"
                          cursor="pointer"
                          _hover={{ bg: "teal.100" }}
                          title="View this occurrence on the Admin Jobs tab"
                          onClick={() => {
                            try {
                              localStorage.setItem(
                                "seedlings_jobs_pendingHighlight",
                                `${e.occurrenceId}|${e.occurrence?.startAt ?? ""}`,
                              );
                            } catch {}
                            window.dispatchEvent(
                              new CustomEvent("navigate:adminTab", {
                                detail: { tab: "admin-jobs", remount: true },
                              }),
                            );
                          }}
                        >
                          Job: {e.occurrence.job.property.displayName}
                          {e.occurrence.job.property.client?.displayName ? ` — ${e.occurrence.job.property.client.displayName}` : ""} →
                        </Badge>
                      )}
                      {e.supplyPurchase && (
                        <Badge
                          size="sm"
                          colorPalette="blue"
                          variant="subtle"
                          borderRadius="full"
                          px="2"
                          cursor="pointer"
                          _hover={{ bg: "blue.100" }}
                          title="View this supply on the Supplies tab"
                          onClick={() => {
                            // Hand off to the Super → Supplies tab. Same pattern as
                            // the Job badge above; the receiving tab loads on mount.
                            try {
                              localStorage.setItem(
                                "seedlings_supplies_pendingHighlight",
                                e.supplyPurchase!.supply.id,
                              );
                            } catch {}
                            window.dispatchEvent(
                              new CustomEvent("navigate:superTab", {
                                detail: { tab: "supplies" },
                              }),
                            );
                          }}
                        >
                          Supply: {e.supplyPurchase.supply.name} × {e.supplyPurchase.quantity} →
                        </Badge>
                      )}
                    </HStack>
                    <HStack gap={3} fontSize="xs" color="fg.muted" wrap="wrap">
                      <Text>{fmtDate(e.date)}</Text>
                      {e.vendor && <Text>· {e.vendor}</Text>}
                      {e.invoiceNumber && <Text>· #{e.invoiceNumber}</Text>}
                      {e.createdBy?.displayName && <Text>· by {e.createdBy.displayName}</Text>}
                    </HStack>
                    {e.notes && (
                      <Text fontSize="xs" color="fg.muted" mt={1}>{e.notes}</Text>
                    )}
                  </Box>
                  <VStack align="end" gap={1}>
                    <Text fontSize="md" fontWeight="bold" color="orange.600">{fmtUSD(e.cost)}</Text>
                    <HStack gap={1}>
                      {/* Paperclip icon when a receipt is attached — clicks
                          open the receipt in a new tab via a presigned GET URL. */}
                      {e.receiptR2Key && (
                        <Button
                          size="xs"
                          variant="ghost"
                          colorPalette="green"
                          title={`View receipt${e.receiptFileName ? `: ${e.receiptFileName}` : ""}`}
                          onClick={async () => {
                            try {
                              const { url } = await apiGet<{ url: string }>(
                                `/api/admin/business-expenses/${e.id}/receipt-url`,
                              );
                              window.open(url, "_blank", "noopener,noreferrer");
                            } catch (err) {
                              publishInlineMessage({
                                type: "ERROR",
                                text: getErrorMessage("Couldn't open receipt.", err),
                              });
                            }
                          }}
                        >
                          <Paperclip size={12} />
                        </Button>
                      )}
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

      {/* Pagination footer — only renders when there's more than one page
          worth of rows. Per-page selector lives on the right. */}
      {total > 0 && (() => {
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const start = (page - 1) * pageSize + 1;
        const end = Math.min(page * pageSize, total);
        return (
          <HStack mt={3} justify="space-between" wrap="wrap" gap={2} fontSize="sm">
            <Text color="fg.muted">
              Showing {start}–{end} of {total}
            </Text>
            <HStack gap={2} wrap="wrap">
              {totalPages > 1 && (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    ← Prev
                  </Button>
                  <Text color="fg.muted" fontSize="xs">
                    Page {page} of {totalPages}
                  </Text>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next →
                  </Button>
                </>
              )}
              <HStack gap={1}>
                <Text color="fg.muted" fontSize="xs">Per page:</Text>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  style={{
                    padding: "2px 6px",
                    fontSize: "12px",
                    border: "1px solid var(--chakra-colors-gray-200)",
                    borderRadius: "4px",
                    background: "white",
                  }}
                >
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </HStack>
            </HStack>
          </HStack>
        );
      })()}

      {/* Add/Edit Dialog */}
      <Dialog.Root open={dialogOpen} onOpenChange={(e) => { if (!e.open) setDialogOpen(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>
                  {editing
                    ? `Edit ${ENTRY_TYPE_LABELS[fType]}`
                    : `Add ${ENTRY_TYPE_LABELS[fType]}`}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="sm" mb={1}>Type *</Text>
                    {/* Switching type wipes category/equipment so a stale
                        Schedule C label doesn't survive on an equity entry.
                        Type changes are blocked server-side on rows linked
                        to a job or supply purchase. */}
                    <select
                      value={fType}
                      onChange={(e) => {
                        const next = e.target.value as EntryType;
                        setFType(next);
                        if (next !== "EXPENSE") {
                          setFCategory("");
                          setFEquipmentId("");
                        }
                      }}
                      disabled={
                        !!editing &&
                        (!!editing.occurrenceId || !!editing.supplyPurchase)
                      }
                      style={{
                        padding: "6px 8px",
                        fontSize: "14px",
                        border: "1px solid var(--chakra-colors-gray-200)",
                        borderRadius: "6px",
                        width: "100%",
                        background: "white",
                      }}
                    >
                      <option value="EXPENSE">Expense (operating cash-out)</option>
                      <option value="CAPITAL_CONTRIBUTION">Capital Contribution (owner → business)</option>
                      <option value="OWNER_DRAW">Owner Draw (business → owner)</option>
                    </select>
                    {fType !== "EXPENSE" && (
                      <Text fontSize="xs" color="fg.muted" mt={1}>
                        Equity entries post to QuickBooks under{" "}
                        <Text as="span" fontWeight="semibold">
                          {fType === "CAPITAL_CONTRIBUTION" ? "Owner's Investment" : "Owner's Draw"}
                        </Text>
                        . They're excluded from the P&L and Schedule C export.
                      </Text>
                    )}
                    {editing && (editing.occurrenceId || editing.supplyPurchase) && (
                      <Text fontSize="xs" color="fg.muted" mt={1}>
                        Type is locked because this entry is tied to a job or supply purchase.
                      </Text>
                    )}
                  </Box>
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
                    <Input
                      size="sm"
                      value={fDescription}
                      onChange={(e) => setFDescription(e.target.value)}
                      placeholder={
                        fType === "CAPITAL_CONTRIBUTION"
                          ? "e.g., Initial owner investment"
                          : fType === "OWNER_DRAW"
                            ? "e.g., Monthly owner draw"
                            : "e.g., Liability insurance Q1"
                      }
                    />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>
                      {fType === "EXPENSE"
                        ? "Cost *"
                        : fType === "CAPITAL_CONTRIBUTION"
                          ? "Amount contributed *"
                          : "Amount drawn *"}
                    </Text>
                    <CurrencyInput value={fCost} onChange={setFCost} size="sm" placeholder="0.00" />
                  </Box>
                  {fType === "EXPENSE" && (
                    <>
                      <Box>
                        <Text fontSize="sm" mb={1}>Category (Schedule C line)</Text>
                        <CategoryDropdown value={fCategory} onChange={setFCategory} />
                        {fCategory && !selectableCategories.some((c) => c.label === fCategory) && (
                          <Text fontSize="xs" color="orange.600" mt={1}>
                            Legacy category "{fCategory}" — pick a Schedule C category to update it.
                          </Text>
                        )}
                        <Box mt={2} p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" borderRadius="md">
                          <Text fontSize="xs" color="blue.800">
                            <Text as="span" fontWeight="semibold">Supplies vs Depreciation:</Text>{" "}
                            Use <Text as="span" fontWeight="semibold">Supplies (line 22)</Text> for consumables and small items
                            — string trimmer line, fertilizer, fuel, hand tools, anything under roughly{" "}
                            <Text as="span" fontWeight="semibold">$2,500</Text>.
                            Use <Text as="span" fontWeight="semibold">Depreciation (line 13)</Text> for major
                            equipment that lasts multiple years — commercial mowers, trailers, trucks, anything
                            ~$2,500 and up. The app records the purchase; your CPA decides at tax time whether
                            to fully deduct it under Section 179 (usually yes for small businesses) or depreciate
                            it over several years.
                            Tip: when picking <Text as="span" fontWeight="semibold">Depreciation</Text>, link the
                            expense to the equipment record below so you have a clean audit trail.
                          </Text>
                        </Box>
                      </Box>
                      <Box>
                        <Text fontSize="sm" mb={1}>Linked equipment (optional)</Text>
                        <EquipmentDropdown
                          value={fEquipmentId}
                          onChange={setFEquipmentId}
                          equipment={equipmentList}
                        />
                        <Text fontSize="xs" color="fg.muted" mt={1}>
                          Use for capital purchases (Depreciation) or major repairs you want to track
                          against a specific piece of equipment.
                        </Text>
                      </Box>
                    </>
                  )}
                  <Box>
                    <Text fontSize="sm" mb={1}>Vendor</Text>
                    <Input size="sm" value={fVendor} onChange={(e) => setFVendor(e.target.value)} placeholder="e.g., State Farm" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Invoice / Reference Number</Text>
                    <Input size="sm" value={fInvoiceNumber} onChange={(e) => setFInvoiceNumber(e.target.value)} placeholder="e.g., INV-2026-0042" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Notes</Text>
                    <Textarea size="sm" value={fNotes} onChange={(e) => setFNotes(e.target.value)} placeholder="Optional notes" rows={2} />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Repeats every</Text>
                    {/* Native select for simplicity — same pattern as the
                        date input. The UI is a free-standing tab; full
                        Chakra Select.Root is overkill for 5 options. */}
                    <select
                      value={fRecurrence}
                      onChange={(e) => setFRecurrence(e.target.value)}
                      style={{
                        padding: "6px 8px",
                        fontSize: "14px",
                        border: "1px solid var(--chakra-colors-gray-200)",
                        borderRadius: "6px",
                        width: "100%",
                        background: "white",
                      }}
                    >
                      <option value="">One-off (no recurrence)</option>
                      <option value="WEEKLY">Weekly</option>
                      <option value="MONTHLY">Monthly</option>
                      <option value="QUARTERLY">Quarterly</option>
                      <option value="ANNUALLY">Annually</option>
                    </select>
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Mark recurring spends (e.g., software subscriptions, insurance) so the system can suggest the next instance when it's due.
                    </Text>
                  </Box>
                  {/* Receipt. On EDIT, ReceiptUpload talks to the API
                      directly (we have a BE id). On CREATE, the BE doesn't
                      exist yet — we buffer the file locally and upload it
                      against the new BE id after save() completes. Sync both
                      the list and the open dialog in place so the change is
                      visible immediately without re-fetching. */}
                  {editing ? (
                    <ReceiptUpload
                      businessExpenseId={editing.id}
                      existing={editing}
                      onChanged={(next) => {
                        setExpenses((rows) =>
                          rows.map((r) => (r.id === editing.id ? { ...r, ...next } : r)),
                        );
                        setEditing((cur) => (cur ? { ...cur, ...next } : cur));
                      }}
                    />
                  ) : (
                    <Box>
                      <HStack gap={2} mb={1}>
                        <Text fontSize="sm" fontWeight="medium">Receipt</Text>
                        <Text fontSize="xs" color="fg.muted">(optional)</Text>
                      </HStack>
                      {fNewReceiptFile ? (
                        <HStack
                          gap={2}
                          p={2}
                          borderWidth="1px"
                          borderColor="green.200"
                          bg="green.50"
                          borderRadius="md"
                          fontSize="sm"
                        >
                          <Text flex="1" minW={0} truncate>{fNewReceiptFile.name}</Text>
                          <Button
                            size="xs"
                            variant="ghost"
                            colorPalette="red"
                            onClick={() => setFNewReceiptFile(null)}
                          >
                            Remove
                          </Button>
                        </HStack>
                      ) : (
                        <input
                          type="file"
                          accept="image/*,application/pdf"
                          onChange={(e) => setFNewReceiptFile(e.target.files?.[0] ?? null)}
                          style={{ fontSize: "13px" }}
                        />
                      )}
                      <Text fontSize="xs" color="fg.muted" mt={1}>
                        Uploaded after the expense saves. If the upload fails, the expense still gets recorded — re-open it from the list to attach.
                      </Text>
                    </Box>
                  )}
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

      {/* Skip confirmation — same shape as the Delete dialog. */}
      <Dialog.Root open={!!confirmSkip} onOpenChange={(e) => { if (!e.open) setConfirmSkip(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Skip this {confirmSkip ? RECURRENCE_LABELS[confirmSkip.recurrence].toLowerCase() : ""} expense?</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm">
                  Skip <b>{confirmSkip?.prefill.description}</b>
                  {confirmSkip?.prefill.vendor ? <> from <b>{confirmSkip.prefill.vendor}</b></> : null}
                  {" "}for this period? The next reminder will be one
                  {" "}{confirmSkip ? RECURRENCE_NOUNS[confirmSkip.recurrence] : ""}
                  {" "}from now. Nothing is recorded — you can always add this period later if needed.
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setConfirmSkip(null)}>Cancel</Button>
                  <Button
                    colorPalette="orange"
                    onClick={() => {
                      if (confirmSkip) {
                        void doSkip(confirmSkip);
                        setConfirmSkip(null);
                      }
                    }}
                  >
                    Skip this period
                  </Button>
                </HStack>
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

function CategoryDropdown(props: { value: string; onChange: (v: string) => void }) {
  const { value, onChange } = props;
  const { selectableCategories } = useExpenseCategories();
  const items = useMemo(
    () => [
      { label: "— Select category —", value: "__NONE__" },
      ...selectableCategories.map((c) => ({ label: `${c.label} (line ${c.scheduleCLine})`, value: c.label })),
    ],
    [selectableCategories],
  );
  const collection = useMemo(() => createListCollection({ items }), [items]);
  // If the stored value is a legacy / unrecognized string, show __NONE__ in
  // the picker so the user is prompted to pick a real one.
  const current = value && selectableCategories.some((c) => c.label === value) ? value : "__NONE__";
  return (
    <Select.Root
      collection={collection}
      value={[current]}
      onValueChange={(e) => {
        const v = e.value?.[0] ?? "__NONE__";
        onChange(v === "__NONE__" ? "" : v);
      }}
      size="sm"
      positioning={{ strategy: "fixed", hideWhenDetached: true }}
    >
      <Select.Control>
        <Select.Trigger w="full">
          <Select.ValueText placeholder="— Select category —" />
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
  );
}

function EquipmentDropdown(props: {
  value: string;
  onChange: (v: string) => void;
  equipment: EquipmentLite[];
}) {
  const { value, onChange, equipment } = props;
  // Filter retired equipment unless it's the currently-selected value (so an
  // existing link to retired equipment still displays correctly when editing).
  const visible = useMemo(
    () => equipment.filter((e) => !e.retiredAt || e.id === value),
    [equipment, value],
  );
  // Each row shows the descriptive label plus the unique qrSlug so similar
  // equipment can be told apart.
  const items = useMemo(
    () => [
      { label: "— No equipment —", value: "__NONE__" },
      ...visible.map((e) => {
        const slug = e.qrSlug ? ` · ${e.qrSlug}` : "";
        const retired = e.retiredAt ? " (retired)" : "";
        return { label: `${equipmentLabel(e)}${slug}${retired}`, value: e.id };
      }),
    ],
    [visible],
  );
  const collection = useMemo(() => createListCollection({ items }), [items]);
  const current = value || "__NONE__";
  return (
    <Select.Root
      collection={collection}
      value={[current]}
      onValueChange={(e) => {
        const v = e.value?.[0] ?? "__NONE__";
        onChange(v === "__NONE__" ? "" : v);
      }}
      size="sm"
      positioning={{ strategy: "fixed", hideWhenDetached: true }}
    >
      <Select.Control>
        <Select.Trigger w="full">
          <Select.ValueText placeholder="— No equipment —" />
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
  );
}

function CategoryFilterSelect(props: { value: string; onChange: (v: string) => void; categories: string[] }) {
  const { value, onChange, categories } = props;
  const items = useMemo(
    () => [
      { label: "All categories", value: "__ALL__" },
      ...categories.map((c) => ({ label: c, value: c })),
    ],
    [categories],
  );
  const collection = useMemo(() => createListCollection({ items }), [items]);
  const current = value === "" ? "__ALL__" : value;
  return (
    <Select.Root
      collection={collection}
      value={[current]}
      onValueChange={(e) => {
        const v = e.value?.[0] ?? "__ALL__";
        onChange(v === "__ALL__" ? "" : v);
      }}
      size="sm"
      positioning={{ strategy: "fixed", hideWhenDetached: true }}
      css={{ width: "auto", flex: "0 0 auto" }}
    >
      <Select.Control>
        <Select.Trigger w="auto" minW="0" px="2">
          <Select.ValueText placeholder="All categories" />
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
  );
}
