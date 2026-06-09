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
//   3. Cash Flow — management view of every dollar movement: Operating
//      (earnings vs expenses, → operating net) + Equity (capital
//      contributions vs owner draws, → equity net) = Net cash change.
//      Hidden when filtered to equity-only (would double-show that bucket).
//   4. Filters + paginated list. Type filter (All / Expenses / Capital
//      contributions / Owner draws) sits next to Category. Type badge is
//      rendered on equity entries only (expense cards stay visually clean).
//
// CSV exports live exclusively on the Exports tab (qb-expenses.csv +
// qb-equity.csv + qb-fixed-assets.csv + the QB bundle zip). This tab is
// for managing the BusinessExpense table — not for producing tax /
// accounting handoffs.
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
import { ChevronDown, ChevronUp, Eye, Info, Paperclip, Pencil, Plus, Repeat, Search, Trash2, X } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { bizToday, bizAddDays, bizStartOfMonth, bizStartOfYear, fmtDate, fmtDateOpts } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import DateInput from "@/src/ui/components/DateInput";
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
  // Free-text "what account/instrument did this come out of?" — pure
  // operator note (e.g. "Chase business card", "Owner cash"). Never
  // feeds tax line items; only surfaced as a column on the entry card
  // for reconciliation against bank/card statements.
  paymentFrom?: string | null;
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

// Per-page sizes for the Ledger pagination footer. Mirrors PaymentsTab —
// same option set, same module-level collection, so the two tabs feel
// identical. Stored as strings (Chakra Select uses string values);
// converted back to number when piped to `setPageSize`.
const pageSizeItems = [
  { label: "10", value: "10" },
  { label: "25", value: "25" },
  { label: "50", value: "50" },
  { label: "100", value: "100" },
];
const pageSizeCollection = createListCollection({ items: pageSizeItems });

// Date display helpers come from @/src/lib/lib (fmtDate, fmtDateOpts, etc.) —
// see those helper headers for the strict no-reinvent policy.

// Date helpers come from @/src/lib/lib (bizDateKey, bizToday, bizAddDays,
// bizStartOfMonth, bizStartOfYear). NEVER reinvent — see lib/lib.ts.

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
  const today = bizToday();
  switch (p) {
    case "last30":
      return { from: bizAddDays(today, -30), to: today };
    case "month":
      return { from: bizStartOfMonth(), to: today };
    case "quarter": {
      // Quarter start = first of the month for quarters: Jan (Q1), Apr (Q2),
      // Jul (Q3), Oct (Q4). Compute against ET-today's month.
      const [y, m] = today.split("-").map(Number);
      const q = Math.floor((m - 1) / 3);
      const qStartMonth = q * 3 + 1;
      return { from: `${y}-${String(qStartMonth).padStart(2, "0")}-01`, to: today };
    }
    case "year":
      return { from: bizStartOfYear(), to: today };
    case "lastYear": {
      const [y] = today.split("-").map(Number);
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    }
    case "all":
    default:
      return { from: "", to: "" };
  }
}

export default function BusinessExpensesTab() {
  const { categories, selectableCategories, lineFor } = useExpenseCategories();
  const [expenses, setExpenses] = useState<BusinessExpense[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
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
  // Quick-date popover visibility. Matches PaymentsTab's pattern — the
  // active preset is shown in a green chip; clicking it toggles the
  // dropdown that lists every preset choice.
  const [quickDateMenuOpen, setQuickDateMenuOpen] = useState(false);

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
  const [pageSize, setPageSize] = usePersistedState<number>("be_pageSize", 10);
  // Collapsible "When to capitalize vs expense" reference panel. Default
  // closed so the tab opens clean; opens once per user-preference (persisted
  // localStorage) for operators who want it visible while logging.
  const [assetRuleOpen, setAssetRuleOpen] = usePersistedState<boolean>("be_assetRuleOpen", false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BusinessExpense | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BusinessExpense | null>(null);
  // Capitalization threshold from FIXED_ASSET_MIN_COST setting — drives the
  // "$X" reference in the capitalize-vs-expense rule-of-thumb note below.
  // Falls back to 500 if the setting hasn't loaded yet or is missing.
  const [fixedAssetThreshold, setFixedAssetThreshold] = useState<number>(500);

  // Form
  const [fType, setFType] = useState<EntryType>("EXPENSE");
  const [fDate, setFDate] = useState("");
  const [fCost, setFCost] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fVendor, setFVendor] = useState("");
  const [fInvoiceNumber, setFInvoiceNumber] = useState("");
  const [fPaymentFrom, setFPaymentFrom] = useState("");
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
  // Separate confirm state for the "Already recorded" path. Distinct from
  // Skip because the operator intent differs ("I paid + recorded this
  // elsewhere — just dismiss" vs. "I'm not paying this cycle"), even
  // though both end up advancing the next reminder by one cadence via
  // the same skip-recurrence endpoint.
  const [confirmAlreadyRecorded, setConfirmAlreadyRecorded] =
    useState<DueSoonSuggestion | null>(null);

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
    apiGet<Array<{ key: string; value: string }>>("/api/settings")
      .then((rows) => {
        if (!Array.isArray(rows)) return;
        const row = rows.find((r) => r.key === "FIXED_ASSET_MIN_COST");
        const n = Number(row?.value);
        if (Number.isFinite(n) && n > 0) setFixedAssetThreshold(n);
      })
      .catch(() => {
        /* keep default */
      });
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
    setFDate(bizToday());
    setFCost("");
    setFDescription("");
    setFCategory("");
    setFVendor("");
    setFInvoiceNumber("");
    setFPaymentFrom("");
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
    setFPaymentFrom(e.paymentFrom ?? "");
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
    setFPaymentFrom("");
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

  // "Already recorded" path — dismiss the current suggestion because the
  // operator already entered this period's row separately. Same backend
  // call as Skip (advances the next reminder by one cadence), different
  // toast wording because the user intent is different. Reaches this state
  // when the recorded row's description/vendor/recurrence didn't perfectly
  // match the predicted series (which would have otherwise auto-advanced
  // the reminder once the new row became "latest" in the group).
  async function doAlreadyRecorded(s: DueSoonSuggestion) {
    const prevDueSoon = dueSoon;
    setDueSoon((rows) => rows.filter((r) => r.latestId !== s.latestId));
    try {
      await apiPost(
        `/api/admin/business-expenses/${s.latestId}/skip-recurrence`,
        { skipDate: s.nextExpectedDate },
      );
      publishInlineMessage({
        type: "SUCCESS",
        text: `Dismissed ${s.prefill.description} — the next reminder will appear when due.`,
      });
    } catch (err) {
      setDueSoon(prevDueSoon);
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Dismiss failed.", err),
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
        // Category/equipment/vendor/invoice are expense-only — server
        // ignores them on equity types, but blank them on the wire too
        // for clarity.
        category: fType === "EXPENSE" ? (fCategory.trim() || null) : null,
        vendor: fType === "EXPENSE" ? (fVendor.trim() || null) : null,
        invoiceNumber: fType === "EXPENSE" ? (fInvoiceNumber.trim() || null) : null,
        // paymentFrom applies to all entry types — even equity entries
        // (capital contributions / owner draws) have a source/destination
        // worth recording. Always send.
        paymentFrom: fPaymentFrom.trim() || null,
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
        <Text fontWeight="bold" fontSize="lg">Ledger</Text>
        <HStack gap={2}>
          <Button size="sm" colorPalette="blue" onClick={openCreate}>
            <Plus size={14} /> Add Entry
          </Button>
        </HStack>
      </HStack>

      {/* Informational banner — explains the Ledger's narrow scope. The
          tab is the operator's hand-logged record of the three money
          movements that don't otherwise touch the app's flow (real-time
          payments + payroll are tracked elsewhere; bank transactions
          live in the accounting software). Mirrors the type filter's
          three options: Expenses, Owner Draws (withdrawals), and
          Capital Contributions. */}
      <Box p={3} mb={3} bg="blue.50" borderLeftWidth="3px" borderColor="blue.400" borderRadius="md">
        <HStack align="flex-start" gap={2}>
          <Box pt={0.5}><Info size={14} /></Box>
          <Text fontSize="xs" color="blue.900">
            Ledger of Business <b>Expenses</b>, Owner <b>Withdrawals</b> (draws), and Capital <b>Contributions</b>.
          </Text>
        </HStack>
      </Box>

      {/* Capitalize-vs-expense reference. Collapsed by default so the tab
          doesn't lead with rules; admin can expand once and the open state
          persists. The dollar cutoff reads from the FIXED_ASSET_MIN_COST
          setting; item examples come from the operator's standing tax-
          policy notes — adjust the setting (or this list) if the rule
          changes. NOT a substitute for CPA review on edge cases. */}
      <CollapsibleNote
        open={assetRuleOpen}
        onToggle={() => setAssetRuleOpen(!assetRuleOpen)}
        palette="blue"
        label="When to capitalize vs expense"
      >
        <Text fontSize="sm" color="blue.900" mb={2} textAlign="left">
          <Text as="span" fontWeight="semibold">Rule of thumb:</Text>{" "}
          record anything over <Text as="span" fontWeight="semibold">${fixedAssetThreshold}</Text> as a fixed asset when purchased — your CPA decides at tax time whether to depreciate over multiple years or take the full Section 179 deduction (usually 179 for small businesses).
        </Text>
        <Box borderWidth="1px" borderColor="blue.200" borderRadius="md" bg="white" overflow="hidden">
          <Box as="table" w="full" fontSize="xs">
            <Box as="thead" bg="blue.100">
              <Box as="tr">
                <Box as="th" textAlign="left" px="2" py="1.5" color="blue.900" fontWeight="semibold">Item</Box>
                <Box as="th" textAlign="left" px="2" py="1.5" color="blue.900" fontWeight="semibold">How to record</Box>
              </Box>
            </Box>
            <Box as="tbody">
              {[
                { item: "Commercial mower $2,000+", how: "Fixed asset — depreciate or Section 179" },
                { item: "Trailer $1,500+", how: "Fixed asset — depreciate or Section 179" },
                { item: "Trimmer $300", how: "Expense immediately — Equipment & Tools" },
                { item: "Blower $250", how: "Expense immediately — Equipment & Tools" },
                { item: "Shovel $30", how: "Expense immediately — Supplies & Materials" },
              ].map((row, i) => (
                <Box as="tr" key={i} borderTopWidth={i === 0 ? "0" : "1px"} borderTopColor="blue.100">
                  <Box as="td" px="2" py="1.5" color="fg.default">{row.item}</Box>
                  <Box as="td" px="2" py="1.5" color="fg.default">{row.how}</Box>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      </CollapsibleNote>

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
                // nextExpectedDate is a YYYY-MM-DD string from the API.
                // Anchor at noon UTC for a stable instant on the correct
                // ET calendar day, then format in ET.
                const expectedLabel = fmtDateOpts(s.nextExpectedDate + "T12:00:00Z", {
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
                        title="Skip this period — I'm not paying this cycle"
                      >
                        Skip
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        colorPalette="green"
                        onClick={() => setConfirmAlreadyRecorded(s)}
                        title="Already recorded — I paid + entered this elsewhere"
                      >
                        Already recorded
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
      {/* Summary + Cash Flow are operating-side by design. Hide them when
          the user is filtered to an equity-only view — they'd be showing
          operating numbers that don't match the list. */}
      {summary && filterType !== "CAPITAL_CONTRIBUTION" && filterType !== "OWNER_DRAW" && (
        <Card.Root variant="outline" mb={3}>
          <Card.Body p={3}>
            {/* Timeframe row — DateInput + dash + DateInput + green preset
                chip on a single line, matching the PaymentsTab layout. */}
            <HStack gap={2} wrap="wrap" align="center" mb={3}>
              <DateInput
                value={filterFrom}
                onChange={(val) => {
                  setFilterFrom(val);
                  setExpensePreset("custom");
                  if (filterTo && val && val > filterTo) setFilterTo(val);
                }}
              />
              <Text fontSize="sm">–</Text>
              <DateInput
                value={filterTo}
                onChange={(val) => {
                  setFilterTo(val);
                  setExpensePreset("custom");
                  if (filterFrom && val && val < filterFrom) setFilterFrom(val);
                }}
              />
              {/* Preset picker — green chip + dropdown, matching PaymentsTab.
                  The chip's label is the currently-selected preset, or
                  "Custom dates" when the operator typed dates directly.
                  The dropdown is `position: fixed` and pinned to the chip
                  so it overflows the card without clipping. */}
              <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
                <Badge
                  size="sm"
                  colorPalette="green"
                  variant="subtle"
                  cursor="pointer"
                  onClick={() => setQuickDateMenuOpen((v) => !v)}
                >
                  {expensePreset === "custom"
                    ? "Custom dates"
                    : EXPENSE_PRESETS.find((p) => p.key === expensePreset)?.label ?? "Custom dates"}
                  {" "}
                  <Box
                    as="span"
                    display="inline-flex"
                    alignItems="center"
                    justifyContent="center"
                    w="14px"
                    h="14px"
                    borderRadius="full"
                    bg="green.500"
                    color="white"
                    verticalAlign="middle"
                  >
                    <ChevronDown size={9} />
                  </Box>
                </Badge>
                {quickDateMenuOpen && (
                  <VStack
                    position="fixed"
                    bg="white"
                    borderWidth="1px"
                    borderColor="gray.200"
                    rounded="md"
                    shadow="lg"
                    zIndex={10000}
                    p={1}
                    gap={0}
                    minW="160px"
                    ref={(el: HTMLDivElement | null) => {
                      if (el && el.parentElement) {
                        const rect = el.parentElement.getBoundingClientRect();
                        el.style.top = `${rect.bottom + 4}px`;
                        el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 168))}px`;
                      }
                    }}
                  >
                    {EXPENSE_PRESETS.map((p) => (
                      <Button
                        key={p.key}
                        size="xs"
                        variant={expensePreset === p.key ? "solid" : "ghost"}
                        colorPalette={expensePreset === p.key ? "green" : undefined}
                        w="full"
                        justifyContent="start"
                        onClick={() => { setQuickDateMenuOpen(false); applyPreset(p.key); }}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </VStack>
                )}
              </Box>
            </HStack>
            {Object.keys(summary.byCategory).length > 0 && (
              <Box>
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


      {/* Filters — Search, Type, Category share the row in equal thirds.
          Clear button drops below when active so the trio's symmetry isn't
          broken by its presence. */}
      <Card.Root variant="outline" mb={3}>
        <Card.Body p={3}>
          <HStack gap={2} align="stretch">
            <HStack gap={1} flex="1" minW="0">
              <Search size={14} color="var(--chakra-colors-gray-500)" />
              <Input
                size="sm"
                placeholder="Search…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </HStack>
            <Box flex="1" minW="0">
              <TypeFilterSelect value={filterType} onChange={setFilterType} />
            </Box>
            <Box flex="1" minW="0">
              <CategoryFilterSelect
                value={filterCategory}
                onChange={setFilterCategory}
                categories={usedCategories}
              />
            </Box>
          </HStack>
          {hasFilters && (
            <HStack justify="flex-end" mt={2}>
              <Button size="xs" variant="ghost" onClick={clearFilters}>
                <X size={12} /> Clear
              </Button>
            </HStack>
          )}
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
                      {e.paymentFrom && <Text>· from {e.paymentFrom}</Text>}
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

      {/* Pagination footer — mirrors PaymentsTab's renderPaginationFooter
          so the two surfaces feel identical. Same spacing, same Select
          variant ("sm" with a visible chevron via Select.Indicator), same
          "Per page" + "Showing X-Y of Z" framing. */}
      {total > 0 && (() => {
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const start = (page - 1) * pageSize + 1;
        const end = Math.min(page * pageSize, total);
        return (
          <HStack mt={2} justify="space-between" wrap="wrap" gap={2} fontSize="sm">
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
                <Select.Root
                  collection={pageSizeCollection}
                  value={[String(pageSize)]}
                  onValueChange={(e) => setPageSize(Number(e.value[0]))}
                  size="sm"
                  positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  css={{ width: "auto", flex: "0 0 auto" }}
                >
                  <Select.Control>
                    <Select.Trigger w="auto" minW="0" px="2">
                      <Select.ValueText placeholder={String(pageSize)} />
                      <Select.Indicator />
                    </Select.Trigger>
                  </Select.Control>
                  <Select.Positioner>
                    <Select.Content>
                      {pageSizeItems.map((it) => (
                        <Select.Item key={it.value} item={it.value}>
                          <Select.ItemText>{it.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Positioner>
                </Select.Root>
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
                    <TypePickerSelect
                      value={fType}
                      onChange={(next) => {
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
                    />
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
                  {/* Vendor + invoice are expense-only — for capital
                      contributions and owner draws there's no external
                      vendor and no invoice. Context (e.g., which account
                      the money moved between) can go in Notes below. */}
                  {fType === "EXPENSE" && (
                    <>
                      <Box>
                        <Text fontSize="sm" mb={1}>Vendor</Text>
                        <Input size="sm" value={fVendor} onChange={(e) => setFVendor(e.target.value)} placeholder="e.g., State Farm" />
                      </Box>
                      <Box>
                        <Text fontSize="sm" mb={1}>Invoice / Reference Number</Text>
                        <Input size="sm" value={fInvoiceNumber} onChange={(e) => setFInvoiceNumber(e.target.value)} placeholder="e.g., INV-2026-0042" />
                      </Box>
                    </>
                  )}
                  {/* Optional source-of-funds note. Pure free text — never
                      categorized or fed to tax line items. Useful for
                      matching to bank/card statements at month-end. */}
                  <Box>
                    <Text fontSize="sm" mb={1}>Payment From <Text as="span" fontSize="xs" color="fg.muted">(optional)</Text></Text>
                    <Input size="sm" value={fPaymentFrom} onChange={(e) => setFPaymentFrom(e.target.value)} placeholder="e.g., Chase business card, Owner cash" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Notes</Text>
                    <Textarea size="sm" value={fNotes} onChange={(e) => setFNotes(e.target.value)} placeholder="Optional notes" rows={2} />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Repeats every</Text>
                    <RecurrenceSelect value={fRecurrence} onChange={setFRecurrence} />
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

      {/* Already Recorded confirmation — semantically distinct from Skip
       *  (operator paid + entered the row separately) but uses the same
       *  skip-recurrence backend call to advance the next reminder. */}
      <Dialog.Root open={!!confirmAlreadyRecorded} onOpenChange={(e) => { if (!e.open) setConfirmAlreadyRecorded(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Already recorded this period?</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm">
                  Dismiss the reminder for <b>{confirmAlreadyRecorded?.prefill.description}</b>
                  {confirmAlreadyRecorded?.prefill.vendor ? <> from <b>{confirmAlreadyRecorded.prefill.vendor}</b></> : null}?
                  {" "}The next reminder will appear one
                  {" "}{confirmAlreadyRecorded ? RECURRENCE_NOUNS[confirmAlreadyRecorded.recurrence] : ""}
                  {" "}from the expected date. Nothing is created here — use this when you've already entered this period's expense via the regular Add Expense flow.
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setConfirmAlreadyRecorded(null)}>Cancel</Button>
                  <Button
                    colorPalette="green"
                    onClick={() => {
                      if (confirmAlreadyRecorded) {
                        void doAlreadyRecorded(confirmAlreadyRecorded);
                        setConfirmAlreadyRecorded(null);
                      }
                    }}
                  >
                    Dismiss reminder
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

// Type picker inside the Add/Edit dialog. Three EntryType values with
// hint text in the label. Required field, so no "none" option.
function TypePickerSelect(props: {
  value: EntryType;
  onChange: (v: EntryType) => void;
  disabled?: boolean;
}) {
  const { value, onChange, disabled } = props;
  const items = useMemo(
    () => [
      { label: "Expense (operating cash-out)", value: "EXPENSE" },
      { label: "Capital Contribution (owner → business)", value: "CAPITAL_CONTRIBUTION" },
      { label: "Owner Draw (business → owner)", value: "OWNER_DRAW" },
    ],
    [],
  );
  const collection = useMemo(() => createListCollection({ items }), [items]);
  return (
    <Select.Root
      collection={collection}
      value={[value]}
      onValueChange={(e) => {
        const v = e.value?.[0];
        if (v) onChange(v as EntryType);
      }}
      size="sm"
      disabled={disabled}
    >
      <Select.Control>
        <Select.Trigger w="full">
          <Select.ValueText />
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

// Recurrence picker inside the Add/Edit dialog. Same Chakra Select.Root
// pattern as the filter dropdowns so the dialog form reads consistently
// with the controls above it. "" = one-off.
function RecurrenceSelect(props: { value: string; onChange: (v: string) => void }) {
  const { value, onChange } = props;
  const items = useMemo(
    () => [
      { label: "One-off (no recurrence)", value: "__NONE__" },
      { label: "Weekly", value: "WEEKLY" },
      { label: "Monthly", value: "MONTHLY" },
      { label: "Quarterly", value: "QUARTERLY" },
      { label: "Annually", value: "ANNUALLY" },
    ],
    [],
  );
  const collection = useMemo(() => createListCollection({ items }), [items]);
  const current = value === "" ? "__NONE__" : value;
  return (
    <Select.Root
      collection={collection}
      value={[current]}
      onValueChange={(e) => {
        const v = e.value?.[0] ?? "__NONE__";
        onChange(v === "__NONE__" ? "" : v);
      }}
      size="sm"
    >
      <Select.Control>
        <Select.Trigger w="full">
          <Select.ValueText placeholder="One-off (no recurrence)" />
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

// Single-source-of-truth collapsible info card. Used for the equipment-
// rental CPA reminder and the capitalize-vs-expense rule so they render
// pixel-identically — only the colors differ.
function CollapsibleNote(props: {
  open: boolean;
  onToggle: () => void;
  /** Chakra palette name — "red" / "blue" / etc. Drives border/bg/icon/text colors. */
  palette: string;
  label: string;
  children: React.ReactNode;
}) {
  const { open, onToggle, palette, label, children } = props;
  const iconColor = `var(--chakra-colors-${palette}-700)`;
  return (
    <Card.Root variant="outline" mb={3} borderColor={`${palette}.300`} bg={`${palette}.50`}>
      <Box
        as="button"
        w="full"
        px="3"
        py="2"
        textAlign="left"
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="2"
        cursor="pointer"
        onClick={onToggle}
        _hover={{ bg: `${palette}.100` }}
      >
        <HStack gap={2} flex="1" minW="0" alignItems="center">
          <Box flexShrink={0} display="inline-flex" alignItems="center" justifyContent="center">
            <Info size={14} color={iconColor} />
          </Box>
          <Text fontSize="sm" fontWeight="semibold" color={`${palette}.800`} textAlign="left">
            {label}
          </Text>
        </HStack>
        <Box flexShrink={0} display="inline-flex" alignItems="center" justifyContent="center">
          {open
            ? <ChevronUp size={14} color={iconColor} />
            : <ChevronDown size={14} color={iconColor} />}
        </Box>
      </Box>
      {open && (
        <Box px="3" pb="3" pt="0">
          {children}
        </Box>
      )}
    </Card.Root>
  );
}

// Filter dropdown for entry type. Matches the look of CategoryFilterSelect
// (Chakra Select.Root) instead of the browser-native <select> so the filter
// row reads as one consistent control strip.
function TypeFilterSelect(props: { value: "" | EntryType; onChange: (v: "" | EntryType) => void }) {
  const { value, onChange } = props;
  const items = useMemo(
    () => [
      { label: "All types", value: "__ALL__" },
      { label: "Expenses", value: "EXPENSE" },
      { label: "Capital contributions", value: "CAPITAL_CONTRIBUTION" },
      { label: "Owner draws", value: "OWNER_DRAW" },
    ],
    [],
  );
  const collection = useMemo(() => createListCollection({ items }), [items]);
  const current = value === "" ? "__ALL__" : value;
  return (
    <Select.Root
      collection={collection}
      value={[current]}
      onValueChange={(e) => {
        const v = e.value?.[0] ?? "__ALL__";
        onChange(v === "__ALL__" ? "" : (v as EntryType));
      }}
      size="sm"
      positioning={{ strategy: "fixed", hideWhenDetached: true }}
      css={{ width: "100%" }}
    >
      <Select.Control>
        {/* Fills its parent container; the filter row enforces the 1/3
            width via a Box flex="1" wrapper. */}
        <Select.Trigger w="full" px="2">
          <Select.ValueText placeholder="All types" />
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
      css={{ width: "100%" }}
    >
      <Select.Control>
        {/* Fills its parent container; the filter row enforces the 1/3
            width via a Box flex="1" wrapper. Long Schedule C labels will
            truncate inside the trigger when the parent is narrow — the
            full label still renders in the dropdown menu. */}
        <Select.Trigger w="full" px="2">
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
