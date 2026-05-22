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
  Select,
  Spinner,
  Text,
  Textarea,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import {
  Archive,
  ArchiveRestore,
  Clock,
  Package,
  Pencil,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
  ShoppingCart,
  Sliders,
} from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import QRScannerDialog from "@/src/ui/dialogs/QRScannerDialog";
import { compressOnly } from "@/src/lib/imageRedact";
import { useExpenseCategories } from "@/src/lib/useExpenseCategories";

// Barcode formats to scan when looking up supplies. Stable reference so
// QRScannerDialog's effect doesn't re-run on every parent render.
const UPC_FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8"];

type ActiveHold = {
  id: string;
  quantity: number;
  jobPayoutCost: number;
  createdAt: string;
  createdBy?: { id: string; displayName?: string | null } | null;
  occurrence?: {
    id: string;
    startAt?: string | null;
    status?: string | null;
    job?: {
      id: string;
      property?: {
        id: string;
        displayName?: string | null;
        client?: { id: string; displayName?: string | null } | null;
      } | null;
    } | null;
  } | null;
};

type Supply = {
  id: string;
  name: string;
  description?: string | null;
  unit: string;
  upc?: string | null;
  category: string;
  businessCost: number;
  jobPayoutCost: number;
  onHand: number;
  held: number;
  available: number;
  archivedAt?: string | null;
  createdAt: string;
  // Populated only on Admin/Super list responses (includeHoldDetails=true).
  // Per-job breakdown of currently-claimed (ACTIVE) holds.
  activeHolds?: ActiveHold[];
};


function fmtUSD(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateTime(d: string): string {
  return new Date(d).toLocaleString();
}

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Props = {
  /** Read-only mode hides all action buttons, the businessCost column,
   *  and the archived filter. */
  readOnly?: boolean;
  /** Drives endpoint choice and which inventory details are surfaced.
   *  - WORKER: minimal — only "Remaining" count, worker-only endpoint
   *  - ADMIN: full inventory + per-job claim breakdown with click-through
   *  - SUPER: same data as ADMIN, plus mutation actions (default behavior)
   */
  purpose?: "WORKER" | "ADMIN" | "SUPER";
};

export default function SuppliesTab({
  readOnly = false,
  purpose = "SUPER",
}: Props = {}) {
  const { selectableCategories } = useExpenseCategories();
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [loading, setLoading] = useState(false);

  const [q, setQ] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [expandedClaims, setExpandedClaims] = useState<Set<string>>(new Set());

  // Worker uses the worker-readable endpoint (no per-job breakdown).
  // Admin/Super hit /admin/supplies which now returns activeHolds details.
  const listEndpoint = purpose === "WORKER" ? "/api/supplies" : "/api/admin/supplies";
  const historyEndpoint = (id: string) =>
    purpose === "WORKER" ? `/api/supplies/${id}/history` : `/api/admin/supplies/${id}/history`;

  // Edit / create supply dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Supply | null>(null);
  const [fName, setFName] = useState("");
  const [fUnit, setFUnit] = useState("");
  const [fCategory, setFCategory] = useState("Supplies");
  const [fJobPayoutCost, setFJobPayoutCost] = useState("");
  const [fUpc, setFUpc] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Buy more dialog
  const [buyOpen, setBuyOpen] = useState<Supply | null>(null);
  const [bQty, setBQty] = useState("");
  // Total actually paid for the whole purchase, incl. tax/discounts.
  const [bTotalCost, setBTotalCost] = useState("");
  const [bDate, setBDate] = useState(todayStr());
  const [bVendor, setBVendor] = useState("");
  const [bInvoice, setBInvoice] = useState("");
  const [bNotes, setBNotes] = useState("");
  // Buffered receipt — picked in the dialog, uploaded against the new BE
  // after the purchase is recorded so we can attach in one step.
  const [bReceiptFile, setBReceiptFile] = useState<File | null>(null);
  const [savingBuy, setSavingBuy] = useState(false);

  // Adjust dialog
  const [adjustOpen, setAdjustOpen] = useState<Supply | null>(null);
  const [aDelta, setADelta] = useState("");
  const [aReason, setAReason] = useState("");
  const [savingAdjust, setSavingAdjust] = useState(false);

  // History dialog
  const [historyOpen, setHistoryOpen] = useState<Supply | null>(null);
  const [historyRows, setHistoryRows] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Confirm archive dialog
  const [confirmArchive, setConfirmArchive] = useState<Supply | null>(null);

  // UPC scan flow
  const [scanOpen, setScanOpen] = useState(false);
  const [scanLookingUp, setScanLookingUp] = useState(false);

  const categoryItems = useMemo(
    () =>
      selectableCategories.map((c) => ({
        label: `${c.label} (line ${c.scheduleCLine})`,
        value: c.label,
      })),
    [selectableCategories],
  );
  const categoryCollection = useMemo(
    () => createListCollection({ items: categoryItems }),
    [categoryItems],
  );

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (includeArchived) params.set("includeArchived", "true");
      if (q.trim()) params.set("q", q.trim());
      const qs = params.toString();
      const list = await apiGet<Supply[]>(`${listEndpoint}${qs ? `?${qs}` : ""}`);
      setSupplies(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load supplies.", err),
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // BusinessExpensesTab → Supplies handoff: the supply-purchase badge sets
  // `seedlings_supplies_pendingHighlight = <supplyId>` and dispatches the
  // navigate:superTab event. On mount, consume the key and open the History
  // dialog for that supply so the user lands on the relevant context.
  useEffect(() => {
    let pending: string | null = null;
    try { pending = localStorage.getItem("seedlings_supplies_pendingHighlight"); } catch {}
    if (!pending) return;
    try { localStorage.removeItem("seedlings_supplies_pendingHighlight"); } catch {}
    // Wait for first load to complete, then look up the supply and open history.
    const interval = setInterval(() => {
      const found = supplies.find((s) => s.id === pending);
      if (found) {
        clearInterval(interval);
        void openHistory(found);
      }
    }, 80);
    // Safety stop after 4s in case the supply was archived/deleted.
    const stop = setTimeout(() => clearInterval(interval), 4000);
    return () => { clearInterval(interval); clearTimeout(stop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplies.length > 0]);

  // Debounced reload on filter changes
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, includeArchived]);

  const filtered = useMemo(() => {
    if (!lowStockOnly) return supplies;
    return supplies.filter((s) => s.available <= 0);
  }, [supplies, lowStockOnly]);

  function openCreate(prefill?: { name?: string; description?: string; upc?: string }) {
    setEditing(null);
    setFName(prefill?.name ?? "");
    setFUnit("");
    setFCategory("Supplies");
    setFJobPayoutCost("");
    setFUpc(prefill?.upc ?? "");
    setFDescription(prefill?.description ?? "");
    setEditOpen(true);
  }

  // Scanner result handler. Three branches:
  //   1. Internal match → open Buy More for that supply (most common after
  //      the catalog is built up).
  //   2. External lookup hit → open Add Supply with name/description/UPC
  //      prefilled.
  //   3. Nothing → open Add Supply with just the UPC prefilled.
  // The endpoint already does the internal-match-first logic so this is a
  // single round-trip.
  async function handleScanned(code: string) {
    setScanOpen(false);
    if (!code) return;
    setScanLookingUp(true);
    try {
      const result = await apiGet<{
        code: string;
        matchExisting: { id: string; name: string; unit: string; jobPayoutCost: number; businessCost: number; onHand: number; category: string } | null;
        lookup: { found: boolean; title?: string; brand?: string; description?: string } | null;
      }>(`/api/admin/supplies/upc-lookup?code=${encodeURIComponent(code)}`);

      if (result.matchExisting) {
        // Reload list so onHand/available are fresh, then open Buy More
        await load();
        const fresh = supplies.find((s) => s.id === result.matchExisting!.id) ?? {
          ...result.matchExisting,
          held: 0,
          available: result.matchExisting.onHand,
          archivedAt: null,
          createdAt: new Date().toISOString(),
        } as Supply;
        openBuy(fresh);
        publishInlineMessage({ type: "SUCCESS", text: `Matched existing: ${result.matchExisting.name}` });
        return;
      }

      if (result.lookup?.found) {
        const lookupName = [result.lookup.brand, result.lookup.title]
          .filter(Boolean)
          .join(" — ");
        openCreate({
          name: lookupName || result.lookup.title || "",
          description: result.lookup.description,
          upc: code,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Found product info — review & save." });
        return;
      }

      // No internal match, no external info — just prefill UPC and let the
      // Super type the rest.
      openCreate({ upc: code });
      publishInlineMessage({
        type: "WARNING",
        text: "No product info found for that barcode. Fill in the details manually.",
      });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("UPC lookup failed", err) });
    } finally {
      setScanLookingUp(false);
    }
  }

  function openEdit(s: Supply) {
    setEditing(s);
    setFName(s.name);
    setFUnit(s.unit);
    setFCategory(s.category || "Supplies");
    setFJobPayoutCost(s.jobPayoutCost.toFixed(2));
    setFUpc(s.upc ?? "");
    setFDescription(s.description ?? "");
    setEditOpen(true);
  }

  async function saveSupply() {
    if (!fName.trim() || !fUnit.trim()) {
      publishInlineMessage({ type: "WARNING", text: "Name and unit are required." });
      return;
    }
    const payload: any = {
      name: fName.trim(),
      unit: fUnit.trim(),
      category: fCategory,
      jobPayoutCost: fJobPayoutCost === "" ? 0 : Number(fJobPayoutCost),
      upc: fUpc.trim() || null,
      description: fDescription.trim() || null,
    };
    setSavingEdit(true);
    try {
      if (editing) {
        await apiPatch(`/api/admin/supplies/${editing.id}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Supply updated." });
      } else {
        await apiPost("/api/admin/supplies", payload);
        publishInlineMessage({ type: "SUCCESS", text: "Supply added." });
      }
      setEditOpen(false);
      void load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage(editing ? "Update failed." : "Add failed.", err),
      });
    } finally {
      setSavingEdit(false);
    }
  }

  function openBuy(s: Supply) {
    setBuyOpen(s);
    setBQty("");
    // Total is the receipt figure — it varies every trip, so don't prefill.
    setBTotalCost("");
    setBDate(todayStr());
    setBVendor("");
    setBInvoice("");
    setBNotes("");
    setBReceiptFile(null);
  }

  async function recordPurchase() {
    if (!buyOpen) return;
    const qty = Math.round(Number(bQty));
    const total = Number(bTotalCost);
    if (!Number.isInteger(qty) || qty <= 0) {
      publishInlineMessage({ type: "WARNING", text: "Quantity must be a positive integer." });
      return;
    }
    if (!Number.isFinite(total) || total <= 0) {
      publishInlineMessage({ type: "WARNING", text: "Total cost must be greater than zero." });
      return;
    }
    setSavingBuy(true);
    try {
      const purchase = await apiPost<{
        id: string;
        businessExpense: { id: string };
      }>(`/api/admin/supplies/${buyOpen.id}/purchases`, {
        quantity: qty,
        totalCost: total,
        date: bDate,
        vendor: bVendor.trim() || null,
        invoiceNumber: bInvoice.trim() || null,
        notes: bNotes.trim() || null,
      });

      // Upload buffered receipt against the new BusinessExpense, if any.
      // Failure here doesn't roll back the purchase — the BE just won't have
      // a receipt yet; the user can attach via the BE list afterward.
      if (bReceiptFile && purchase.businessExpense?.id) {
        try {
          const file = bReceiptFile;
          const isPdf = file.type === "application/pdf";
          const body: Blob = isPdf ? file : await compressOnly(file);
          const contentType = isPdf ? "application/pdf" : "image/jpeg";
          const beId = purchase.businessExpense.id;
          const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
            `/api/admin/business-expenses/${beId}/receipt/upload-url`,
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
          await apiPost(`/api/admin/business-expenses/${beId}/receipt`, {
            key,
            fileName: file.name,
            contentType,
          });
        } catch (e) {
          publishInlineMessage({
            type: "WARNING",
            text: `Purchase saved, but receipt upload failed: ${getErrorMessage("", e)}. Attach it later from the Expenses ledger.`,
          });
          setBuyOpen(null);
          void load();
          setSavingBuy(false);
          return;
        }
      }

      publishInlineMessage({
        type: "SUCCESS",
        text: `Recorded purchase: ${qty} ${buyOpen.unit} of ${buyOpen.name} for ${fmtUSD(total)}${bReceiptFile ? " · receipt attached" : ""}.`,
      });
      setBuyOpen(null);
      void load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to record purchase.", err),
      });
    } finally {
      setSavingBuy(false);
    }
  }

  function openAdjust(s: Supply) {
    setAdjustOpen(s);
    setADelta("");
    setAReason("");
  }

  async function recordAdjustment() {
    if (!adjustOpen) return;
    const delta = Math.round(Number(aDelta));
    if (!Number.isInteger(delta) || delta === 0) {
      publishInlineMessage({ type: "WARNING", text: "Delta must be a non-zero integer." });
      return;
    }
    if (!aReason.trim()) {
      publishInlineMessage({ type: "WARNING", text: "Reason is required." });
      return;
    }
    setSavingAdjust(true);
    try {
      await apiPost(`/api/admin/supplies/${adjustOpen.id}/adjustments`, {
        delta,
        reason: aReason.trim(),
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: `Adjusted ${adjustOpen.name} by ${delta > 0 ? "+" : ""}${delta} ${adjustOpen.unit}.`,
      });
      setAdjustOpen(null);
      void load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to adjust.", err),
      });
    } finally {
      setSavingAdjust(false);
    }
  }

  async function openHistory(s: Supply) {
    setHistoryOpen(s);
    setHistoryRows([]);
    setHistoryLoading(true);
    try {
      const list = await apiGet<any[]>(historyEndpoint(s.id));
      setHistoryRows(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load history.", err),
      });
    } finally {
      setHistoryLoading(false);
    }
  }

  async function reversePurchase(purchaseId: string, supplyName: string) {
    if (!confirm(`Reverse this purchase of ${supplyName}? This deletes the tax-ledger row and decrements inventory.`)) {
      return;
    }
    try {
      await apiDelete(`/api/admin/supplies/purchases/${purchaseId}`);
      publishInlineMessage({ type: "SUCCESS", text: "Purchase reversed." });
      if (historyOpen) await openHistory(historyOpen);
      void load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Reverse failed.", err),
      });
    }
  }

  async function archiveSupply(s: Supply) {
    try {
      await apiPost(`/api/admin/supplies/${s.id}/archive`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Supply archived." });
      setConfirmArchive(null);
      void load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Archive failed.", err),
      });
    }
  }

  async function unarchiveSupply(s: Supply) {
    try {
      await apiPost(`/api/admin/supplies/${s.id}/unarchive`, {});
      publishInlineMessage({ type: "SUCCESS", text: "Supply unarchived." });
      void load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Unarchive failed.", err),
      });
    }
  }

  return (
    <Box w="full">
      <HStack justify="space-between" mb={3} wrap="wrap" gap={2}>
        <Text fontWeight="bold" fontSize="lg">Supplies</Text>
        {!readOnly && (
          <HStack gap={2}>
            <Button
              size="sm"
              variant="outline"
              colorPalette="purple"
              onClick={() => setScanOpen(true)}
              loading={scanLookingUp}
              title="Scan a UPC barcode to add to inventory or buy more of an existing supply"
            >
              <ScanLine size={14} /> Scan barcode
            </Button>
            <Button size="sm" colorPalette="blue" onClick={() => openCreate()}>
              <Plus size={14} /> Add Supply
            </Button>
          </HStack>
        )}
      </HStack>

      {/* Tax-method explainer (super-only — workers/admins don't manage tax ledger) */}
      {!readOnly && (
        <Box mb={3} p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" borderRadius="md">
          <Text fontSize="xs" color="blue.800">
            Each <Text as="span" fontWeight="semibold">purchase</Text> creates a Business Expense (tax ledger) right away.
            When a job <Text as="span" fontWeight="semibold">consumes</Text> from inventory, only the worker's payout is
            deducted — no second tax entry, since the deduction was already taken at purchase time.
            The job-payout cost may include a markup over the business cost (e.g. $4.00 → $4.20 for fuel/travel).
          </Text>
        </Box>
      )}
      {readOnly && (
        <Box mb={3} p={2} bg="gray.50" borderWidth="1px" borderColor="gray.200" borderRadius="md">
          <Text fontSize="xs" color="fg.muted">
            Read-only view of on-hand inventory. Quantities update automatically as jobs reserve and consume supplies.
            The cost shown is the per-unit charge to your payout when you use that supply on a job.
          </Text>
        </Box>
      )}

      {/* Filters */}
      <HStack mb={3} gap={2} wrap="wrap">
        <Box flex="1" minW="200px" position="relative">
          <Box position="absolute" left={2} top="50%" transform="translateY(-50%)" color="fg.muted" pointerEvents="none">
            <Search size={14} />
          </Box>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, UPC, description…"
            size="sm"
            pl="8"
          />
        </Box>
        {!readOnly && (
        <Button
          size="sm"
          variant={includeArchived ? "solid" : "outline"}
          onClick={() => setIncludeArchived((v) => !v)}
          title="Include archived supplies"
        >
          <Archive size={14} /> Archived
        </Button>
        )}
        <Button
          size="sm"
          variant={lowStockOnly ? "solid" : "outline"}
          colorPalette={lowStockOnly ? "orange" : "gray"}
          onClick={() => setLowStockOnly((v) => !v)}
          title="Show only supplies with no available units"
        >
          Low stock
        </Button>
      </HStack>

      {/* List */}
      {loading && supplies.length === 0 ? (
        <Box py={8} textAlign="center"><Spinner /></Box>
      ) : filtered.length === 0 ? (
        <Box py={8} textAlign="center" color="fg.muted">
          <Text>{q || includeArchived || lowStockOnly ? "No supplies match the current filters." : (readOnly ? "No supplies have been added yet." : "No supplies yet. Click Add Supply to get started.")}</Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={1}>
          {filtered.map((s) => (
            <Card.Root key={s.id} variant="outline" opacity={s.archivedAt ? 0.6 : 1}>
              <Card.Body p={3}>
                <HStack justify="space-between" align="flex-start" gap={2} wrap="wrap">
                  <Box flex="1" minW={0}>
                    <HStack gap={2} wrap="wrap" mb={0.5}>
                      <Text fontSize="sm" fontWeight="semibold">{s.name}</Text>
                      <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full" px="2">
                        {s.unit}
                      </Badge>
                      {s.category !== "Supplies" && (
                        <Badge size="sm" colorPalette="purple" variant="subtle" borderRadius="full" px="2">
                          {s.category}
                        </Badge>
                      )}
                      {s.archivedAt && (
                        <Badge size="sm" colorPalette="gray" variant="solid">Archived</Badge>
                      )}
                    </HStack>
                    <HStack gap={3} fontSize="xs" color="fg.muted" wrap="wrap">
                      {purpose === "WORKER" ? (
                        // Worker view: just "Remaining" (= available). Holds
                        // and onHand are operational detail they don't need.
                        <Text>
                          Remaining: <Text as="span" fontWeight="medium" color={s.available <= 0 ? "orange.600" : "green.600"}>{s.available}</Text> {s.unit}
                        </Text>
                      ) : (
                        <>
                          <Text>
                            On hand: <Text as="span" fontWeight="medium" color="fg">{s.onHand}</Text>
                          </Text>
                          <Text>
                            Available: <Text as="span" fontWeight="medium" color={s.available <= 0 ? "orange.600" : "green.600"}>{s.available}</Text>
                            {s.held > 0 && (
                              <>
                                <Text as="span" color="fg.muted"> (claimed by jobs: </Text>
                                <Text
                                  as="span"
                                  color="blue.600"
                                  fontWeight="medium"
                                  cursor={s.activeHolds && s.activeHolds.length > 0 ? "pointer" : "default"}
                                  textDecoration={s.activeHolds && s.activeHolds.length > 0 ? "underline" : "none"}
                                  onClick={() => {
                                    if (!s.activeHolds || s.activeHolds.length === 0) return;
                                    setExpandedClaims((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(s.id)) next.delete(s.id);
                                      else next.add(s.id);
                                      return next;
                                    });
                                  }}
                                  title={s.activeHolds && s.activeHolds.length > 0 ? "Show which jobs claimed these" : ""}
                                >
                                  {s.held}
                                </Text>
                                <Text as="span" color="fg.muted">)</Text>
                              </>
                            )}
                          </Text>
                          {/* businessCost is internal margin info — Super only. */}
                          {!readOnly && <Text>Buy: {fmtUSD(s.businessCost)}</Text>}
                          <Text>{readOnly ? "Cost per unit" : "Charge"}: <Text as="span" fontWeight="medium" color="orange.600">{fmtUSD(s.jobPayoutCost)}</Text></Text>
                          {s.upc && <Text>UPC: {s.upc}</Text>}
                        </>
                      )}
                    </HStack>
                    {s.description && (
                      <Text fontSize="xs" color="fg.muted" mt={1}>{s.description}</Text>
                    )}
                    {/* Per-job claim breakdown — admin/super only, expanded
                        on click of the "claimed by jobs: N" link above. */}
                    {purpose !== "WORKER" && expandedClaims.has(s.id) && s.activeHolds && s.activeHolds.length > 0 && (
                      <VStack align="stretch" gap={1} mt={2} pl={2} borderLeftWidth="2px" borderColor="blue.200">
                        {s.activeHolds.map((h) => {
                          const job = h.occurrence?.job;
                          const propLabel = job?.property?.displayName ?? "(unknown property)";
                          const clientLabel = job?.property?.client?.displayName;
                          const dateLabel = h.occurrence?.startAt
                            ? new Date(h.occurrence.startAt).toLocaleDateString()
                            : "";
                          return (
                            <HStack
                              key={h.id}
                              gap={2}
                              fontSize="xs"
                              p={1}
                              borderRadius="sm"
                              cursor={h.occurrence?.id ? "pointer" : "default"}
                              _hover={h.occurrence?.id ? { bg: "blue.50" } : undefined}
                              onClick={() => {
                                if (!h.occurrence?.id) return;
                                try {
                                  localStorage.setItem(
                                    "seedlings_jobs_pendingHighlight",
                                    `${h.occurrence.id}|${h.occurrence.startAt ?? ""}`,
                                  );
                                } catch {}
                                window.dispatchEvent(
                                  new CustomEvent("navigate:adminTab", {
                                    detail: { tab: "admin-jobs", remount: true },
                                  }),
                                );
                              }}
                              title={h.occurrence?.id ? "Open this occurrence on Admin Jobs" : ""}
                            >
                              <Text color="blue.700" fontWeight="medium">−{h.quantity}</Text>
                              <Text color="fg" flex="1" minW={0}>
                                {propLabel}
                                {clientLabel ? ` — ${clientLabel}` : ""}
                                {dateLabel ? ` (${dateLabel})` : ""}
                                {h.occurrence?.id && <Text as="span" color="blue.600"> →</Text>}
                              </Text>
                              {h.occurrence?.status && (
                                <Badge size="sm" colorPalette="gray" variant="subtle">
                                  {h.occurrence.status}
                                </Badge>
                              )}
                            </HStack>
                          );
                        })}
                      </VStack>
                    )}
                  </Box>
                  <HStack gap={1} wrap="wrap">
                    {!readOnly && !s.archivedAt && (
                      <>
                        <Button size="xs" variant="outline" colorPalette="green" onClick={() => openBuy(s)} title="Record a purchase">
                          <ShoppingCart size={12} /> Buy
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => openAdjust(s)} title="Adjust count">
                          <Sliders size={12} />
                        </Button>
                      </>
                    )}
                    <Button size="xs" variant="ghost" onClick={() => openHistory(s)} title="View history">
                      <Clock size={12} />
                    </Button>
                    {!readOnly && (
                      <Button size="xs" variant="ghost" onClick={() => openEdit(s)} title="Edit">
                        <Pencil size={12} />
                      </Button>
                    )}
                    {!readOnly && (s.archivedAt ? (
                      <Button size="xs" variant="ghost" onClick={() => unarchiveSupply(s)} title="Unarchive">
                        <ArchiveRestore size={12} />
                      </Button>
                    ) : (
                      <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setConfirmArchive(s)} title="Archive">
                        <Archive size={12} />
                      </Button>
                    ))}
                  </HStack>
                </HStack>
              </Card.Body>
            </Card.Root>
          ))}
        </VStack>
      )}

      {/* Create / Edit dialog */}
      <Dialog.Root open={editOpen} onOpenChange={(e) => { if (!e.open) setEditOpen(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>{editing ? "Edit Supply" : "Add Supply"}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="sm" mb={1}>Name *</Text>
                    <Input value={fName} onChange={(e) => setFName(e.target.value)} size="sm" placeholder="e.g. Mulch, Trimmer line" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Unit *</Text>
                    <Input value={fUnit} onChange={(e) => setFUnit(e.target.value)} size="sm" placeholder="e.g. bag, spool, lb" />
                  </Box>
                  <HStack gap={2} align="start">
                    <Box flex="1">
                      <Text fontSize="sm" mb={1}>Last paid (per unit)</Text>
                      <Box
                        fontSize="sm"
                        px={2}
                        py="6px"
                        bg="bg.subtle"
                        borderWidth="1px"
                        borderColor="border.muted"
                        borderRadius="md"
                        color="fg.muted"
                      >
                        {editing && editing.businessCost > 0
                          ? `${fmtUSD(editing.businessCost)}`
                          : "—"}
                      </Box>
                    </Box>
                    <Box flex="1">
                      <Text fontSize="sm" mb={1}>Job payout cost (per unit) *</Text>
                      <CurrencyInput value={fJobPayoutCost} onChange={setFJobPayoutCost} size="sm" />
                    </Box>
                  </HStack>
                  <Text fontSize="xs" color="fg.muted">
                    Last paid is derived from your most recent purchase — it updates automatically and isn't edited here. Job payout cost is what's deducted from the worker's payout per unit consumed; set it equal to what you pay for no markup, or higher to bake in margin (e.g. travel/fuel to fetch the supply).
                  </Text>
                  <Box>
                    <Text fontSize="sm" mb={1}>Schedule C category</Text>
                    <Select.Root
                      collection={categoryCollection}
                      value={[fCategory]}
                      onValueChange={(e) => setFCategory(e.value?.[0] ?? "Supplies")}
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
                          {categoryItems.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                    <Box mt={1} p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" borderRadius="md">
                      <Text fontSize="xs" color="blue.800">
                        Most lawn-care consumables belong on <Text as="span" fontWeight="semibold">Supplies (line 22)</Text>. Override only if this item maps to a different Schedule C line — e.g. fuel as Car and truck expenses.
                      </Text>
                    </Box>
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>UPC <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text></Text>
                    <Input value={fUpc} onChange={(e) => setFUpc(e.target.value)} size="sm" placeholder="Barcode for fast scan-add later" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Description <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text></Text>
                    <Textarea value={fDescription} onChange={(e) => setFDescription(e.target.value)} size="sm" rows={2} />
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={savingEdit}>Cancel</Button>
                  <Button colorPalette="blue" onClick={saveSupply} loading={savingEdit}>
                    {editing ? "Save" : "Add"}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Buy More dialog */}
      <Dialog.Root open={!!buyOpen} onOpenChange={(e) => { if (!e.open) setBuyOpen(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Buy More — {buyOpen?.name}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box p={2} bg="green.50" borderWidth="1px" borderColor="green.200" borderRadius="md">
                    <Text fontSize="xs" color="green.800">
                      Recording a purchase creates a Business Expense (tax ledger entry, category{" "}
                      <Text as="span" fontWeight="semibold">{buyOpen?.category}</Text>) and adds units to inventory in one step.
                    </Text>
                  </Box>
                  <HStack gap={2}>
                    <Box flex="1">
                      <Text fontSize="sm" mb={1}>Quantity *</Text>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={bQty}
                        onChange={(e) => setBQty(e.target.value)}
                        size="sm"
                        placeholder={`# of ${buyOpen?.unit ?? "units"}`}
                      />
                    </Box>
                    <Box flex="1">
                      <Text fontSize="sm" mb={1}>Total cost *</Text>
                      <CurrencyInput value={bTotalCost} onChange={setBTotalCost} size="sm" />
                    </Box>
                  </HStack>
                  <Text fontSize="xs" color="fg.muted">
                    Enter the total you actually paid for the whole purchase — including sales tax and after any discounts (the receipt figure).
                    {bQty && bTotalCost && Number(bQty) > 0 && Number(bTotalCost) > 0 && (
                      <> That's {fmtUSD(Math.round((Number(bTotalCost) / Number(bQty)) * 100) / 100)} per {buyOpen?.unit ?? "unit"}.</>
                    )}
                  </Text>
                  <Box>
                    <Text fontSize="sm" mb={1}>Date</Text>
                    <input
                      type="date"
                      value={bDate}
                      onChange={(e) => setBDate(e.target.value)}
                      style={{
                        padding: "6px 8px",
                        fontSize: "14px",
                        border: "1px solid var(--chakra-colors-gray-200)",
                        borderRadius: "6px",
                        width: "100%",
                      }}
                    />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Vendor</Text>
                    <Input value={bVendor} onChange={(e) => setBVendor(e.target.value)} size="sm" placeholder="e.g. Lowes, Pro Lawn Supply" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Invoice #</Text>
                    <Input value={bInvoice} onChange={(e) => setBInvoice(e.target.value)} size="sm" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Notes</Text>
                    <Textarea value={bNotes} onChange={(e) => setBNotes(e.target.value)} size="sm" rows={2} />
                  </Box>
                  {/* Receipt — buffered locally and uploaded against the
                      newly-created BusinessExpense after the purchase saves. */}
                  <Box>
                    <Text fontSize="sm" mb={1}>Receipt <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text></Text>
                    {bReceiptFile ? (
                      <HStack
                        gap={2}
                        p={2}
                        borderWidth="1px"
                        borderColor="green.200"
                        bg="green.50"
                        borderRadius="md"
                        fontSize="sm"
                      >
                        <Text flex="1" minW={0} truncate>{bReceiptFile.name}</Text>
                        <Button
                          size="xs"
                          variant="ghost"
                          colorPalette="red"
                          onClick={() => setBReceiptFile(null)}
                        >
                          Remove
                        </Button>
                      </HStack>
                    ) : (
                      <input
                        type="file"
                        accept="image/*,application/pdf"
                        onChange={(e) => setBReceiptFile(e.target.files?.[0] ?? null)}
                        style={{ fontSize: "13px" }}
                      />
                    )}
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setBuyOpen(null)} disabled={savingBuy}>Cancel</Button>
                  <Button colorPalette="green" onClick={recordPurchase} loading={savingBuy}>Record purchase</Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Adjust dialog */}
      <Dialog.Root open={!!adjustOpen} onOpenChange={(e) => { if (!e.open) setAdjustOpen(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Adjust Count — {adjustOpen?.name}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Text fontSize="xs" color="fg.muted">
                    Current onHand: <Text as="span" fontWeight="medium">{adjustOpen?.onHand}</Text> {adjustOpen?.unit}.
                    Adjustments don't write to the tax ledger — use this for physical-count corrections, damage, or
                    counting errors only.
                  </Text>
                  <Box>
                    <Text fontSize="sm" mb={1}>Delta * <Text as="span" color="fg.muted" fontSize="xs">(positive or negative)</Text></Text>
                    <Input
                      type="number"
                      step={1}
                      value={aDelta}
                      onChange={(e) => setADelta(e.target.value)}
                      size="sm"
                      placeholder="e.g. -2 or +5"
                    />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Reason *</Text>
                    <Textarea
                      value={aReason}
                      onChange={(e) => setAReason(e.target.value)}
                      size="sm"
                      rows={2}
                      placeholder="e.g. Physical count correction, Damaged in storage"
                    />
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setAdjustOpen(null)} disabled={savingAdjust}>Cancel</Button>
                  <Button colorPalette="orange" onClick={recordAdjustment} loading={savingAdjust}>Apply</Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* History dialog */}
      <Dialog.Root open={!!historyOpen} onOpenChange={(e) => { if (!e.open) setHistoryOpen(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>History — {historyOpen?.name}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {historyLoading ? (
                  <Box py={6} textAlign="center"><Spinner /></Box>
                ) : historyRows.length === 0 ? (
                  <Text fontSize="sm" color="fg.muted">No history yet.</Text>
                ) : (
                  <VStack align="stretch" gap={1}>
                    {historyRows.map((evt, idx) => (
                      <Box key={idx} p={2} borderWidth="1px" borderColor="gray.200" borderRadius="md">
                        <HStack justify="space-between" align="flex-start" gap={2} wrap="wrap">
                          <Box flex="1" minW={0}>
                            {evt.kind === "PURCHASE" && (
                              <>
                                <HStack gap={2} mb={0.5} wrap="wrap">
                                  <Badge size="sm" colorPalette="green" variant="subtle">Purchase</Badge>
                                  <Text fontSize="sm" fontWeight="medium">
                                    +{evt.row.quantity} @ {fmtUSD(evt.row.unitCost)} = {fmtUSD(evt.row.totalCost)}
                                  </Text>
                                </HStack>
                                <Text fontSize="xs" color="fg.muted">
                                  {fmtDateTime(evt.row.date)}
                                  {evt.row.vendor ? ` · ${evt.row.vendor}` : ""}
                                  {evt.row.invoiceNumber ? ` · #${evt.row.invoiceNumber}` : ""}
                                  {evt.row.createdBy?.displayName ? ` · by ${evt.row.createdBy.displayName}` : ""}
                                </Text>
                                {evt.row.notes && <Text fontSize="xs" color="fg.muted" mt={1}>{evt.row.notes}</Text>}
                              </>
                            )}
                            {evt.kind === "HOLD" && (
                              <>
                                <HStack gap={2} mb={0.5} wrap="wrap">
                                  <Badge
                                    size="sm"
                                    colorPalette={evt.row.status === "ACTIVE" ? "blue" : evt.row.status === "CONSUMED" ? "purple" : "gray"}
                                    variant="subtle"
                                  >
                                    {evt.row.status === "ACTIVE" ? "Hold" : evt.row.status === "CONSUMED" ? "Used" : "Released"}
                                  </Badge>
                                  <Text fontSize="sm" fontWeight="medium">
                                    −{evt.row.quantity} @ {fmtUSD(evt.row.jobPayoutCost)}
                                  </Text>
                                </HStack>
                                <Text fontSize="xs" color="fg.muted">
                                  {fmtDateTime(evt.row.createdAt)}
                                  {evt.row.occurrence?.job?.property?.displayName
                                    ? ` · Job: ${evt.row.occurrence.job.property.displayName}${evt.row.occurrence.startAt ? ` (${new Date(evt.row.occurrence.startAt).toLocaleDateString()})` : ""}`
                                    : ""}
                                  {evt.row.createdBy?.displayName ? ` · by ${evt.row.createdBy.displayName}` : ""}
                                </Text>
                              </>
                            )}
                            {evt.kind === "ADJUSTMENT" && (
                              <>
                                <HStack gap={2} mb={0.5} wrap="wrap">
                                  <Badge size="sm" colorPalette="orange" variant="subtle">Adjustment</Badge>
                                  <Text fontSize="sm" fontWeight="medium">
                                    {evt.row.delta > 0 ? "+" : ""}{evt.row.delta}
                                  </Text>
                                </HStack>
                                <Text fontSize="xs" color="fg.muted">
                                  {fmtDateTime(evt.row.createdAt)}
                                  {evt.row.createdBy?.displayName ? ` · by ${evt.row.createdBy.displayName}` : ""}
                                </Text>
                                <Text fontSize="xs" color="fg" mt={1}>{evt.row.reason}</Text>
                              </>
                            )}
                          </Box>
                          {!readOnly && evt.kind === "PURCHASE" && (
                            <Button
                              size="xs"
                              variant="ghost"
                              colorPalette="red"
                              onClick={() => reversePurchase(evt.row.id, historyOpen?.name ?? "this supply")}
                              title="Reverse purchase (deletes BE + decrements inventory)"
                            >
                              <RotateCcw size={12} />
                            </Button>
                          )}
                        </HStack>
                      </Box>
                    ))}
                  </VStack>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setHistoryOpen(null)}>Close</Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Confirm archive */}
      <Dialog.Root open={!!confirmArchive} onOpenChange={(e) => { if (!e.open) setConfirmArchive(null); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Archive Supply?</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm">
                  Archiving hides <Text as="span" fontWeight="semibold">{confirmArchive?.name}</Text> from the catalog and prevents new purchases. Existing inventory stays as-is. You can unarchive later.
                </Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full">
                  <Button variant="ghost" onClick={() => setConfirmArchive(null)}>Cancel</Button>
                  <Button colorPalette="red" onClick={() => confirmArchive && archiveSupply(confirmArchive)}>
                    Archive
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* UPC scanner — same component used for Equipment QR check-in/out,
          just configured to read product barcodes (UPC-A/E, EAN-13/8). */}
      <QRScannerDialog
        open={scanOpen}
        label="Scan supply barcode"
        formats={UPC_FORMATS}
        manualPlaceholder="Enter UPC manually (e.g., 012345678905)"
        onClose={() => setScanOpen(false)}
        onDetected={(code) => void handleScanned(code)}
      />
    </Box>
  );
}
