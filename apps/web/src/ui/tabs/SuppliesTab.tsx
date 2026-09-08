"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { bizToday, fmtDate, fmtDateTime, type EtDateKey } from "@/src/lib/dates";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { prettyStatus } from "@/src/lib/labels";
import { occurrenceStatusColor } from "@/src/lib/statusColors";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import QRScannerDialog from "@/src/ui/dialogs/QRScannerDialog";
import SupplyPhotos, { uploadStagedPhotos, type StagedPhoto, type SupplyPhoto } from "@/src/ui/components/SupplyPhotos";
import PhotoLightbox from "@/src/ui/components/PhotoLightbox";

// Barcode formats to scan when looking up supplies. Stable reference so
// QRScannerDialog's effect doesn't re-run on every parent render.
const UPC_FORMATS = ["upc_a", "upc_e", "ean_13", "ean_8"];

type ActiveHold = {
  id: string;
  quantity: number;
  clientUnitPrice: number;
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
  /** Weighted average cost of the units ON HAND, over FIFO layers replayed
   *  from the purchase history. DERIVED — the server computes it and nothing
   *  can set it. null when the supply has never been bought, which is not the
   *  same as free. */
  averageCost: number | null;
  /** averageCost x onHand, or null. */
  valueOnHand: number | null;
  /** Presigned URL of the FIRST photo, shipped with the list so a row needs
   *  no extra request. null when the supply has none. */
  thumbnailUrl?: string | null;
  photoCount?: number;
  clientUnitPrice: number;
  onHand: number;
  held: number;
  available: number;
  archivedAt?: string | null;
  createdAt: string;
  // Populated only on Admin/Super list responses (includeHoldDetails=true).
  // Per-job breakdown of currently-claimed (ACTIVE) holds.
  activeHolds?: ActiveHold[];
};


/** A Ledger row offered by the picker. `referencedByJobs` is the operator's
 *  cue that a receipt is already shared — many things may point at one row. */
type LedgerRow = {
  id: string;
  date: string;
  cost: number;
  description?: string | null;
  vendor?: string | null;
  referencedByJobs: number;
};

function fmtUSD(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}


// Date helpers come from @/src/lib/dates. NEVER reinvent — see lib/dates.ts.
// `bizToday()` returns today's date as YYYY-MM-DD in Eastern Time.

type Props = {
  /** Read-only mode hides all action buttons, the average-cost figure,
   *  and the archived filter. */
  readOnly?: boolean;
  /** Drives endpoint choice and which inventory details are surfaced.
   *  - WORKER: minimal — only "Remaining" count, worker-only endpoint
   *  - ADMIN: full inventory + per-job claim breakdown with click-through
   *  - SUPER: same data as ADMIN, plus mutation actions (default behavior)
   */
  purpose?: "WORKER" | "ADMIN" | "SUPER";
  /** Additive scope — capabilities ADD as you climb the ladder.
   *  scope.isWorker → worker-endpoint list, "Remaining" only, no actions.
   *  scope.isAdmin  → admin-endpoint list with per-job claim breakdown.
   *  scope.isSuper  → adds add/buy/adjust/edit/archive/reverse actions.
   *  Falls back to a scope derived from the legacy `purpose` + `readOnly`
   *  props when not passed, so mounts still on the old shape keep working. */
  scope?: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
};

export default function SuppliesTab({
  readOnly = false,
  purpose = "SUPER",
  scope,
}: Props = {}) {
  // Effective scope: prefer the additive prop; fall back to a scope
  // derived from the legacy `purpose` + `readOnly` props. Legacy shape:
  //   purpose="WORKER" readOnly → worker view (worker endpoint)
  //   purpose="ADMIN"  readOnly → admin read-only view (admin endpoint)
  //   purpose="SUPER" (default, no readOnly) → super view (writable)
  const effScope = scope ?? {
    isWorker: purpose === "WORKER",
    isAdmin: purpose === "ADMIN" || purpose === "SUPER",
    isSuper: purpose === "SUPER" && !readOnly,
  };
  // Capabilities render additively AND are strictly governed by the
  // scope prop. No `me` prop on this tab — trust the scope for the
  // super check (the shell only sets scope.isSuper on the super tab).
  const showWorkerExtras = effScope.isWorker;
  const showAdminExtras = effScope.isAdmin || effScope.isSuper;
  const showSuperExtras = effScope.isSuper;

  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [loading, setLoading] = useState(false);

  const [q, setQ] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [lowStockOnly, setLowStockOnly] = useState(false);
  // WHICH ROWS ARE COLLAPSED, not which are expanded — so the default empty
  // set means every claim breakdown is OPEN. Who is holding stock is the
  // reason to look at this line at all; hiding it behind a click made the
  // header number the only visible answer, and that number is units.
  const [collapsedClaims, setCollapsedClaims] = useState<Set<string>>(new Set());

  // Worker uses the worker-readable endpoint (no per-job breakdown).
  // Admin/Super hit /admin/supplies which now returns activeHolds details.
  const listEndpoint = showAdminExtras ? "/api/admin/supplies" : "/api/supplies";
  const historyEndpoint = (id: string) =>
    showAdminExtras ? `/api/admin/supplies/${id}/history` : `/api/supplies/${id}/history`;

  // Edit / create supply dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Supply | null>(null);
  const [fName, setFName] = useState("");
  const [fUnit, setFUnit] = useState("");
  const [fCategory, setFCategory] = useState("Supplies");
  const [fClientPrice, setFClientPrice] = useState("");
  const [fUpc, setFUpc] = useState("");
  const [fDescription, setFDescription] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  // Photos chosen while ADDING, before the supply exists to attach them to.
  const [stagedPhotos, setStagedPhotos] = useState<StagedPhoto[]>([]);

  // Gallery opened from a LIST thumbnail. The row ships only the first photo's
  // URL, so the rest are fetched on click — one request, only when someone
  // actually wants to look.
  const [galleryPhotos, setGalleryPhotos] = useState<SupplyPhoto[] | null>(null);
  const [galleryIndex, setGalleryIndex] = useState(0);

  async function openGallery(s: Supply) {
    // Show the thumbnail we already have immediately, so the viewer opens on
    // the tap rather than after a round-trip; the full set replaces it.
    if (s.thumbnailUrl) {
      setGalleryPhotos([{ id: "thumb", url: s.thumbnailUrl, sortOrder: 0 }]);
      setGalleryIndex(0);
    }
    try {
      const list = await apiGet<SupplyPhoto[]>(`/api/admin/supplies/${s.id}/photos`);
      const photos = Array.isArray(list) ? list : [];
      if (photos.length === 0) {
        setGalleryPhotos(null);
        return;
      }
      setGalleryPhotos(photos);
    } catch (err) {
      setGalleryPhotos(null);
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Couldn't load the photos.", err) });
    }
  }

  // Buy more dialog
  const [buyOpen, setBuyOpen] = useState<Supply | null>(null);
  const [bQty, setBQty] = useState("");
  // Total actually paid for the whole purchase, incl. tax/discounts.
  const [bTotalCost, setBTotalCost] = useState("");
  const [bDate, setBDate] = useState(bizToday());
  const [bVendor, setBVendor] = useState("");
  const [bInvoice, setBInvoice] = useState("");
  const [bNotes, setBNotes] = useState("");
  // NO RECEIPT HERE. A receipt is evidence for a DEDUCTION, and a supply
  // purchase is not one — it tracks stock. The receipt belongs to the Ledger
  // row where the real card charge is entered, which is what an audit looks
  // at. This dialog used to buffer a file and upload it against the
  // BusinessExpense the purchase created; purchases stopped creating one, so
  // the upload silently never ran while the toast still said "receipt
  // attached". See docs/features/job-materials.md.
  //
  // Optional ledger BREADCRUMB instead: point this purchase at the row that
  // paid for it. Many purchases may share one $500 receipt. No total reads it.
  const [bLedgerId, setBLedgerId] = useState<string | null>(null);
  const [bLedgerLabel, setBLedgerLabel] = useState<string | null>(null);
  const [savingBuy, setSavingBuy] = useState(false);

  // Ledger picker, shared by the Buy dialog and the purchase rows in History.
  const [ledgerPickerFor, setLedgerPickerFor] = useState<string | null>(null);
  const [ledgerQuery, setLedgerQuery] = useState("");
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [ledgerBusy, setLedgerBusy] = useState(false);

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
  // `seedlings_supplies_pendingHighlight = <supplyId>` and dispatches
  // navigate:superTab. Land on that supply: scroll it into view and ring it.
  //
  // THE PREVIOUS VERSION NEVER FIRED ONCE. It read the key on mount and then
  // polled `supplies.find(...)` on an interval — but the interval closed over
  // `supplies` AS IT WAS ON THE FIRST RENDER, which is the empty array. It
  // searched that empty array every 80ms for four seconds and gave up. When
  // the list did arrive the effect re-ran, but the key had already been
  // consumed on the first pass, so it returned immediately. The result was a
  // link that navigated to the tab and did nothing else — which is exactly
  // what it looked like from the outside.
  //
  // No interval now: hold the id in a ref and act when `supplies` actually
  // changes, so the lookup always sees the current list.
  const pendingHighlight = useRef<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const v = localStorage.getItem("seedlings_supplies_pendingHighlight");
      if (v) {
        pendingHighlight.current = v;
        localStorage.removeItem("seedlings_supplies_pendingHighlight");
      }
    } catch {}
  }, []);

  useEffect(() => {
    const id = pendingHighlight.current;
    if (!id || supplies.length === 0) return;
    const found = supplies.find((s) => s.id === id);
    if (!found) {
      // Most likely archived, which the list hides by default. Reveal them
      // once and let this effect run again on the reloaded list.
      if (!includeArchived) {
        setIncludeArchived(true);
        return;
      }
      pendingHighlight.current = null;
      publishInlineMessage({
        type: "WARNING",
        text: "That supply is no longer in the catalog.",
      });
      return;
    }
    pendingHighlight.current = null;
    setHighlightedId(found.id);
    // After paint, or the node is not in the document yet.
    requestAnimationFrame(() => {
      document
        .getElementById(`supply-row-${found.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const t = setTimeout(() => setHighlightedId(null), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplies, includeArchived]);

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
    setStagedPhotos([]);
    setFName(prefill?.name ?? "");
    setFUnit("");
    setFCategory("Supplies");
    setFClientPrice("");
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
        matchExisting: { id: string; name: string; unit: string; clientUnitPrice: number; onHand: number; category: string } | null;
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
    setStagedPhotos([]);
    setFName(s.name);
    setFUnit(s.unit);
    setFCategory(s.category || "Supplies");
    setFClientPrice(s.clientUnitPrice.toFixed(2));
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
      // NOT a tax category. A supply purchase creates no deduction, so there
      // is no Schedule C line to pick — the dialog no longer offers one. The
      // stored value is carried through untouched so existing grouping (the
      // "Fuel" badge on the list) survives.
      category: fCategory,
      clientUnitPrice: fClientPrice === "" ? 0 : Number(fClientPrice),
      // NO COST FIELD. This form establishes what a supply IS. What it cost is
      // recorded per purchase, on Buy, and the catalog's average is derived
      // from those — a cost typed here was a number nobody could keep true,
      // because every purchase silently overwrote it.
      upc: fUpc.trim() || null,
      description: fDescription.trim() || null,
    };
    setSavingEdit(true);
    try {
      if (editing) {
        await apiPatch(`/api/admin/supplies/${editing.id}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Supply updated." });
      } else {
        const created = await apiPost<{ id: string }>("/api/admin/supplies", payload);
        // STAGED PHOTOS UPLOAD ONLY NOW — there was no supply to attach them
        // to until this moment. The supply itself is already saved, so a
        // failure here must NOT read as a failed add, and must not read as a
        // success either: the Buy dialog used to buffer a receipt exactly like
        // this behind a guard that silently went false, and reported "receipt
        // attached" for a file it never sent. So this says what landed and
        // what did not, by name.
        let uploaded = 0;
        let photoError: unknown = null;
        if (stagedPhotos.length > 0) {
          try {
            uploaded = await uploadStagedPhotos(created.id, stagedPhotos);
          } catch (e) {
            photoError = e;
          }
        }
        stagedPhotos.forEach((sp) => URL.revokeObjectURL(sp.preview));
        setStagedPhotos([]);
        if (photoError) {
          publishInlineMessage({
            type: "WARNING",
            text:
              `Supply added, but ${stagedPhotos.length - uploaded} of ${stagedPhotos.length} ` +
              `photo(s) failed to upload: ${getErrorMessage("", photoError)} ` +
              `Re-open the supply to add them.`,
          });
        } else {
          publishInlineMessage({
            type: "SUCCESS",
            text: `Supply added${uploaded > 0 ? ` with ${uploaded} photo${uploaded === 1 ? "" : "s"}` : ""}.`,
          });
        }
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

  // DEBOUNCED AND RACE-GUARDED. Bound straight to onChange this fired one
  // request — and one ILIKE scan of the ledger — PER KEYSTROKE: typing "Lowes"
  // was five. It also applied whichever response landed last, so a slow early
  // request could overwrite a later one and leave the list showing matches for
  // a prefix of what was typed.
  //
  // 250ms matches the main supply-search debounce above; the sequence counter
  // means only the newest response is ever applied.
  const ledgerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ledgerSeq = useRef(0);

  useEffect(() => () => { if (ledgerTimer.current) clearTimeout(ledgerTimer.current); }, []);

  function searchLedger(q: string) {
    setLedgerQuery(q);          // the field stays responsive
    setLedgerBusy(true);
    if (ledgerTimer.current) clearTimeout(ledgerTimer.current);
    ledgerTimer.current = setTimeout(async () => {
      const seq = ++ledgerSeq.current;
      try {
        const rows = await apiGet<LedgerRow[]>(
          `/api/admin/ledger-charges?q=${encodeURIComponent(q)}`,
        );
        if (seq === ledgerSeq.current) setLedgerRows(rows);
      } catch {
        /* keep the last list rather than emptying it mid-type */
      } finally {
        if (seq === ledgerSeq.current) setLedgerBusy(false);
      }
    }, 250);
  }

  function openLedgerPicker(target: string) {
    setLedgerPickerFor(target);
    setLedgerRows([]);
    setLedgerQuery("");
    searchLedger("");
  }

  /** Link or unlink an ALREADY-RECORDED purchase, from the History timeline. */
  async function setPurchaseLedgerLink(purchaseId: string, businessExpenseId: string | null) {
    try {
      await apiPatch(`/api/admin/supply-purchases/${purchaseId}/ledger-link`, { businessExpenseId });
      setLedgerPickerFor(null);
      if (historyOpen) await openHistory(historyOpen);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't change the ledger link.", err),
      });
    }
  }

  function openBuy(s: Supply) {
    setBuyOpen(s);
    setBLedgerId(null);
    setBLedgerLabel(null);
    setLedgerPickerFor(null);
    setBQty("");
    // Total is the receipt figure — it varies every trip, so don't prefill.
    setBTotalCost("");
    setBDate(bizToday());
    setBVendor("");
    setBInvoice("");
    setBNotes("");
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
      await apiPost(`/api/admin/supplies/${buyOpen.id}/purchases`, {
        quantity: qty,
        totalCost: total,
        date: bDate,
        vendor: bVendor.trim() || null,
        invoiceNumber: bInvoice.trim() || null,
        notes: bNotes.trim() || null,
        businessExpenseId: bLedgerId,
      });

      publishInlineMessage({
        type: "SUCCESS",
        text:
          `Recorded purchase: ${qty} ${buyOpen.unit} of ${buyOpen.name} for ${fmtUSD(total)}` +
          `${bLedgerLabel ? ` · linked to ${bLedgerLabel}` : ""}.`,
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
      // A 404 means the row on screen is stale — the supply is gone, or the
      // list predates a reseed. Say that, and refresh rather than leaving a
      // dead row to be clicked again.
      const msg = String((err as any)?.message ?? "");
      if (msg.includes("404") || /not found/i.test(msg)) {
        setHistoryOpen(null);
        publishInlineMessage({
          type: "WARNING",
          text: "That supply no longer exists. Refreshing the list.",
        });
        void load();
      } else {
        publishInlineMessage({
          type: "ERROR",
          text: getErrorMessage("Failed to load history.", err),
        });
      }
    } finally {
      setHistoryLoading(false);
    }
  }

  async function reversePurchase(purchaseId: string, supplyName: string) {
    // WAS: "This deletes the tax-ledger row and decrements inventory."
    // It deletes no ledger row — recording a purchase creates none, and the
    // optional breadcrumb is SetNull. Telling the operator a reversal destroys
    // a deduction is how a mistaken purchase stays on the books uncorrected.
    if (!confirm(
      `Reverse this purchase of ${supplyName}? This removes the units from inventory ` +
      `and deletes the purchase record. No ledger expense or deduction is affected.`,
    )) {
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
        {showSuperExtras && (
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
      {showSuperExtras && (
        <Box mb={3} p={2} bg="blue.50" borderWidth="1px" borderColor="blue.200" borderRadius="md">
          <Text fontSize="xs" color="blue.800">
            Supplies track <Text as="span" fontWeight="semibold">stock, not taxes</Text>. Recording a
            purchase adds units to the shelf and creates <Text as="span" fontWeight="semibold">no
            tax entry</Text> — the deduction is the real card charge you enter in the Ledger from
            your statement. You can optionally point a purchase at that Ledger row as a reminder of
            what it bought; one receipt can cover several purchases.
          </Text>
          <Text fontSize="xs" color="blue.800" mt={1.5}>
            When a job <Text as="span" fontWeight="semibold">pulls</Text> from inventory, the units
            are <Text as="span" fontWeight="semibold">billed to the client</Text> on top of the
            labor price, and never come out of anyone&rsquo;s pay. You set what to charge{" "}
            <Text as="span" fontWeight="semibold">on the job</Text> — the same supply can be a
            different price to a different client; the catalog only holds a default. It has nothing
            to do with what you paid, which is the Ledger&rsquo;s business.
          </Text>
        </Box>
      )}
      {!showSuperExtras && (
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
            placeholder="Search…"
            size="sm"
            pl="8"
          />
        </Box>
        {showSuperExtras && (
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
          <Text>{q || includeArchived || lowStockOnly ? "No supplies match the current filters." : (!showSuperExtras ? "No supplies have been added yet." : "No supplies yet. Click Add Supply to get started.")}</Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={1}>
          {filtered.map((s) => {
            // Units reserved by an occurrence whose repeating series is
            // PAUSED. Held deliberately — the crew committed that stock and
            // resuming should find it set aside — but the pause is open-ended
            // (resume asks for a fresh start date), so it is called out rather
            // than silently missing from Available.
            const pausedHeld = (s.activeHolds ?? [])
              .filter((h) => (h.occurrence?.status as string) === "STREAM_PAUSED")
              .reduce((n, h) => n + h.quantity, 0);
            return (
            <Card.Root
              key={s.id}
              id={`supply-row-${s.id}`}
              variant="outline"
              opacity={s.archivedAt ? 0.6 : 1}
              // Ringed for a few seconds after arriving from a ledger link, so
              // the row that was navigated to is obvious on a long list.
              borderColor={highlightedId === s.id ? "blue.solid" : undefined}
              borderWidth={highlightedId === s.id ? "2px" : undefined}
              boxShadow={highlightedId === s.id ? "0 0 0 3px var(--chakra-colors-blue-muted)" : undefined}
              transition="box-shadow 150ms ease, border-color 150ms ease"
            >
              <Card.Body p={3}>
                <HStack justify="space-between" align="flex-start" gap={2} wrap="wrap">
                  {/* Thumbnail, same 56px block Equipment uses. The URL ships
                      with the list row, so this costs no request. Clicking
                      opens the supply's gallery rather than a bare lightbox —
                      the useful next action from a list is "show me this
                      thing", and Edit is where the rest of the photos live. */}
                  {s.thumbnailUrl && (
                    <Box
                      w="56px"
                      h="56px"
                      borderRadius="md"
                      overflow="hidden"
                      borderWidth="1px"
                      borderColor="gray.200"
                      flexShrink={0}
                      position="relative"
                      cursor="pointer"
                      title={
                        (s.photoCount ?? 1) > 1
                          ? `${s.photoCount} photos — click to view`
                          : "Click to view"
                      }
                      onClick={() => void openGallery(s)}
                    >
                      <img
                        src={s.thumbnailUrl}
                        alt={s.name}
                        loading="lazy"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                      {(s.photoCount ?? 0) > 1 && (
                        <Box
                          position="absolute"
                          bottom="0"
                          right="0"
                          bg="blackAlpha.700"
                          color="white"
                          fontSize="2xs"
                          px="1"
                          borderRadius="4px 0 0 0"
                        >
                          {s.photoCount}
                        </Box>
                      )}
                    </Box>
                  )}
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
                      {!showAdminExtras ? (
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
                                {/* UNITS, NOT JOBS. This said "claimed by
                                    jobs: 2" while rendering `held`, which is
                                    the SUM OF QUANTITIES across active holds —
                                    so one job holding 2 blades read as two
                                    jobs, and the expanded list below it showed
                                    one. Both numbers are worth having; they
                                    just have to say which is which. */}
                                <Text as="span" color="fg.muted"> (</Text>
                                <Text
                                  as="span"
                                  color="blue.600"
                                  fontWeight="medium"
                                  cursor={s.activeHolds && s.activeHolds.length > 0 ? "pointer" : "default"}
                                  textDecoration={s.activeHolds && s.activeHolds.length > 0 ? "underline" : "none"}
                                  onClick={() => {
                                    if (!s.activeHolds || s.activeHolds.length === 0) return;
                                    setCollapsedClaims((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(s.id)) next.delete(s.id);
                                      else next.add(s.id);
                                      return next;
                                    });
                                  }}
                                  title={
                                    s.activeHolds && s.activeHolds.length > 0
                                      ? collapsedClaims.has(s.id)
                                        ? "Show which jobs claimed these"
                                        : "Hide which jobs claimed these"
                                      : ""
                                  }
                                >
                                  {s.held}
                                </Text>
                                <Text as="span" color="fg.muted">
                                  {" "}claimed by{" "}
                                  {s.activeHolds
                                    ? `${s.activeHolds.length} job${s.activeHolds.length === 1 ? "" : "s"}`
                                    : "a job"}
                                </Text>
                                {pausedHeld > 0 && (
                                  <Text
                                    as="span"
                                    color="purple.600"
                                    title="A repeating job on hold keeps its stock reserved. Resuming it asks for a new start date, so this can sit for a while."
                                  >
                                    , {pausedHeld} for a paused series
                                  </Text>
                                )}
                                <Text as="span" color="fg.muted">)</Text>
                              </>
                            )}
                          </Text>
                          {/* AVERAGE OF WHAT IS STILL ON THE SHELF, oldest
                              units first, so a price you have stopped paying
                              leaves the figure as that stock is used. Internal
                              margin info — Super only. An em dash rather than
                              $0.00 when nothing has been bought: no purchase
                              is not the same claim as free. */}
                          {showSuperExtras && (
                            <Text title="Weighted average of the units on hand, oldest used first">
                              Average price:{" "}
                              {s.averageCost == null ? (
                                <Text as="span" color="fg.muted">&mdash;</Text>
                              ) : (
                                fmtUSD(s.averageCost)
                              )}
                            </Text>
                          )}
                          {/* Was "Cost per unit" for a worker, which reads as
                              THEIR cost. It is what the client is billed. */}
                          <Text>Client pays: <Text as="span" fontWeight="medium" color="orange.600">{fmtUSD(s.clientUnitPrice)}</Text></Text>
                          {s.upc && <Text>UPC: {s.upc}</Text>}
                        </>
                      )}
                    </HStack>
                    {s.description && (
                      <Text fontSize="xs" color="fg.muted" mt={1}>{s.description}</Text>
                    )}
                    {/* Per-job claim breakdown — admin/super only, expanded
                        on click of the "claimed by jobs: N" link above. */}
                    {showAdminExtras && !collapsedClaims.has(s.id) && s.activeHolds && s.activeHolds.length > 0 && (
                      <VStack
                        align="stretch"
                        gap={1}
                        mt={2}
                        pl={2}
                        borderLeftWidth="2px"
                        borderColor={pausedHeld > 0 ? "purple.200" : "blue.200"}
                      >
                        {s.activeHolds.map((h) => {
                          const job = h.occurrence?.job;
                          const propLabel = job?.property?.displayName ?? "(unknown property)";
                          const clientLabel = job?.property?.client?.displayName;
                          const dateLabel = h.occurrence?.startAt
                            ? fmtDate(h.occurrence.startAt)
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
                                    detail: { tab: "jobs", remount: true },
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
                              {/* NEVER PRINT AN INTERNAL KEY. This rendered
                                  the raw enum, so the row read "STREAM_PAUSED"
                                  — "stream" is schema vocabulary that appears
                                  nowhere in the product. `prettyStatus` maps it
                                  to "Repeating Paused" and every other tab
                                  already uses it; the colour helper is shared
                                  for the same reason. */}
                              {h.occurrence?.status && (
                                <Badge
                                  size="sm"
                                  colorPalette={occurrenceStatusColor(h.occurrence.status)}
                                  variant="subtle"
                                  // SAY WHY THE STOCK IS STILL GONE. A status
                                  // badge alone leaves the operator to work out
                                  // that a paused series keeps its reservation
                                  // — and the pause has no end date, so this
                                  // can sit for a season.
                                  title={
                                    (h.occurrence.status as string) === "STREAM_PAUSED"
                                      ? "This repeating job is on hold and keeps its stock reserved. Resuming it asks for a new start date."
                                      : undefined
                                  }
                                >
                                  {prettyStatus(h.occurrence.status)}
                                </Badge>
                              )}
                            </HStack>
                          );
                        })}
                      </VStack>
                    )}
                  </Box>
                  <HStack gap={1} wrap="wrap">
                    {showSuperExtras && !s.archivedAt && (
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
                    {showSuperExtras && (
                      <Button size="xs" variant="ghost" onClick={() => openEdit(s)} title="Edit">
                        <Pencil size={12} />
                      </Button>
                    )}
                    {showSuperExtras && (s.archivedAt ? (
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
            );
          })}
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
                  {/* THIS FORM ESTABLISHES WHAT A SUPPLY IS — nothing about
                      quantity, and nothing about cost. Stock arrives through
                      Buy, which records what that receipt cost, and the
                      catalog's average price is derived from those purchases.
                      A cost typed here was a number nobody could keep true:
                      every purchase silently overwrote it.

                      THE CATALOG DOES NOT KNOW WHAT A CLIENT WILL PAY either.
                      That is decided when the supply goes onto a job — the
                      same bag of mulch is billed differently to different
                      clients — so this screen asks for a DEFAULT, not a
                      price. It previously demanded the client price up front
                      as a required field, with buttons to "set from cost" as
                      though a fixed markup existed. */}
                  <Box>
                    <Text fontSize="sm" mb={1}>
                      Default charge to a client{" "}
                      <Text as="span" color="fg.muted">
                        (per {fUnit.trim() || "unit"}, optional)
                      </Text>
                    </Text>
                    <CurrencyInput value={fClientPrice} onChange={setFClientPrice} size="sm" />
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Only a starting point. You set what to charge when you add this supply to a
                      job, and it can differ per client. Leave it blank if there is no usual price.
                    </Text>
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>
                      Group <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text>
                    </Text>
                    <Input
                      size="sm"
                      value={fCategory === "Supplies" ? "" : fCategory}
                      onChange={(e) => setFCategory(e.target.value.trim() || "Supplies")}
                      placeholder="e.g. Fuel, Chemicals"
                    />
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Just a label for the list &mdash; it shows as a badge next to the name.
                      It is <Text as="span" fontWeight="semibold">not</Text> a tax category:
                      buying a supply records no deduction.
                    </Text>
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>UPC <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text></Text>
                    <Input value={fUpc} onChange={(e) => setFUpc(e.target.value)} size="sm" placeholder="Barcode for fast scan-add later" />
                  </Box>
                  <Box>
                    <Text fontSize="sm" mb={1}>Description <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text></Text>
                    <Textarea value={fDescription} onChange={(e) => setFDescription(e.target.value)} size="sm" rows={2} />
                  </Box>
                  {/* Photos. On Edit these upload immediately; on Add there is
                      no supply to attach them to yet, so they are STAGED (shown
                      dashed) and uploaded the moment it saves. */}
                  <Box>
                    <Text fontSize="sm" mb={1}>
                      Photos <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text>
                    </Text>
                    <SupplyPhotos
                      supplyId={editing?.id ?? null}
                      staged={stagedPhotos}
                      onStagedChange={setStagedPhotos}
                    />
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      What the bag, roll or jug actually looks like — so the right thing gets bought
                      and the right thing gets pulled onto a job.
                    </Text>
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

      {galleryPhotos && galleryPhotos.length > 0 && (
        <PhotoLightbox
          photos={galleryPhotos.map((p) => ({ url: p.url, caption: p.description }))}
          index={Math.min(galleryIndex, galleryPhotos.length - 1)}
          onClose={() => setGalleryPhotos(null)}
          onPrev={() => setGalleryIndex((i) => (i > 0 ? i - 1 : i))}
          onNext={() => setGalleryIndex((i) => (i < galleryPhotos.length - 1 ? i + 1 : i))}
        />
      )}

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
                      This adds units to the shelf. It records <Text as="span" fontWeight="semibold">no
                      tax entry</Text> — the deduction is the card charge you enter in the Ledger.
                      Point this purchase at that Ledger row below if you want a record of what the
                      receipt bought.
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
                      onChange={(e) => setBDate(e.target.value as EtDateKey)}
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
                  {/* LEDGER BREADCRUMB, optional and many-to-one.
                      One $500 Lowes receipt covers several purchases, so this
                      points at the row that paid for this stock — it does not
                      create one, and no total reads it. The DEDUCTION is the
                      card charge you enter in the Ledger from your statement.

                      THIS REPLACED A RECEIPT UPLOAD. A receipt is evidence for
                      a deduction and a supply purchase is not one, so it
                      belongs on the Ledger row an audit actually looks at. The
                      picker here also uploaded against a BusinessExpense the
                      purchase used to create; once purchases stopped creating
                      one it silently never ran, while the success toast still
                      claimed "receipt attached". */}
                  <Box>
                    <Text fontSize="sm" mb={1}>
                      Ledger expense <Text as="span" color="fg.muted" fontSize="xs">(optional)</Text>
                    </Text>
                    {bLedgerId ? (
                      <HStack gap={2} fontSize="xs" wrap="wrap">
                        <Text color="fg.muted" flex="1" minW={0} truncate>Ledger: {bLedgerLabel}</Text>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => { setBLedgerId(null); setBLedgerLabel(null); }}
                        >
                          Unlink
                        </Button>
                      </HStack>
                    ) : ledgerPickerFor === "BUY" ? (
                      <VStack align="stretch" gap={1} borderWidth="1px" borderColor="border" borderRadius="md" p={2}>
                        <HStack gap={2}>
                          <Input
                            size="xs"
                            autoFocus
                            value={ledgerQuery}
                            onChange={(e) => searchLedger(e.target.value)}
                            placeholder="Search the ledger by vendor or description"
                          />
                          <Button size="xs" variant="ghost" onClick={() => setLedgerPickerFor(null)}>✕</Button>
                        </HStack>
                        {ledgerBusy && <Text fontSize="2xs" color="fg.muted">Loading…</Text>}
                        <VStack align="stretch" gap={0} maxH="180px" overflowY="auto">
                          {ledgerRows.map((r) => (
                            <Button
                              key={r.id}
                              size="xs"
                              variant="ghost"
                              justifyContent="start"
                              onClick={() => {
                                setBLedgerId(r.id);
                                setBLedgerLabel(
                                  `${fmtUSD(r.cost)} · ${r.vendor ? `${r.vendor} — ` : ""}${r.description ?? "expense"}`,
                                );
                                setLedgerPickerFor(null);
                              }}
                            >
                              <Text fontSize="2xs" truncate>
                                {fmtDate(r.date)} · {fmtUSD(r.cost)} ·{" "}
                                {r.vendor ? `${r.vendor} — ` : ""}{r.description ?? "expense"}
                              </Text>
                            </Button>
                          ))}
                          {!ledgerBusy && ledgerRows.length === 0 && (
                            <Text fontSize="2xs" color="fg.muted">No matching expenses.</Text>
                          )}
                        </VStack>
                      </VStack>
                    ) : (
                      <Button size="xs" variant="ghost" onClick={() => openLedgerPicker("BUY")}>
                        Link a ledger expense
                      </Button>
                    )}
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      A reminder of which purchase this receipt paid for. Several buys can point at
                      one receipt. It records no deduction and changes no total.
                    </Text>
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
                                {/* THE OTHER HALF OF THE BREADCRUMB. The
                                    Ledger already shows which purchases point
                                    at a row; this is where the pointer gets
                                    set, changed, or cleared after the fact —
                                    the endpoint existed from the start and
                                    nothing called it. */}
                                <Box mt={1}>
                                  {evt.row.businessExpense ? (
                                    <HStack gap={2} fontSize="xs" wrap="wrap">
                                      {/* CLICKS THROUGH TO THE LEDGER, the
                                          mirror of the Ledger's "Supply: … →"
                                          badge. Same handoff convention: stash
                                          the id, dispatch the nav event, let
                                          the destination consume it. */}
                                      <Text
                                        color="blue.600"
                                        flex="1"
                                        minW={0}
                                        truncate
                                        cursor="pointer"
                                        textDecoration="underline"
                                        title="Open this expense in the Ledger"
                                        onClick={() => {
                                          try {
                                            localStorage.setItem(
                                              "seedlings_ledger_pendingHighlight",
                                              evt.row.businessExpense.id,
                                            );
                                          } catch {}
                                          window.dispatchEvent(
                                            new CustomEvent("navigate:superTab", {
                                              detail: { tab: "ledger" },
                                            }),
                                          );
                                        }}
                                      >
                                        Ledger: {fmtUSD(evt.row.businessExpense.cost)}
                                        {evt.row.businessExpense.vendor ? ` · ${evt.row.businessExpense.vendor}` : ""}
                                        {evt.row.businessExpense.description ? ` — ${evt.row.businessExpense.description}` : ""}
                                        {" →"}
                                      </Text>
                                      <Button
                                        size="xs"
                                        variant="ghost"
                                        onClick={() => void setPurchaseLedgerLink(evt.row.id, null)}
                                      >
                                        Unlink
                                      </Button>
                                    </HStack>
                                  ) : ledgerPickerFor === evt.row.id ? (
                                    <VStack align="stretch" gap={1} borderWidth="1px" borderColor="border" borderRadius="md" p={2}>
                                      <HStack gap={2}>
                                        <Input
                                          size="xs"
                                          autoFocus
                                          value={ledgerQuery}
                                          onChange={(e) => searchLedger(e.target.value)}
                                          placeholder="Search the ledger by vendor or description"
                                        />
                                        <Button size="xs" variant="ghost" onClick={() => setLedgerPickerFor(null)}>✕</Button>
                                      </HStack>
                                      {ledgerBusy && <Text fontSize="2xs" color="fg.muted">Loading…</Text>}
                                      <VStack align="stretch" gap={0} maxH="180px" overflowY="auto">
                                        {ledgerRows.map((r) => (
                                          <Button
                                            key={r.id}
                                            size="xs"
                                            variant="ghost"
                                            justifyContent="start"
                                            onClick={() => void setPurchaseLedgerLink(evt.row.id, r.id)}
                                          >
                                            <Text fontSize="2xs" truncate>
                                              {fmtDate(r.date)} · {fmtUSD(r.cost)} ·{" "}
                                              {r.vendor ? `${r.vendor} — ` : ""}{r.description ?? "expense"}
                                            </Text>
                                          </Button>
                                        ))}
                                        {!ledgerBusy && ledgerRows.length === 0 && (
                                          <Text fontSize="2xs" color="fg.muted">No matching expenses.</Text>
                                        )}
                                      </VStack>
                                    </VStack>
                                  ) : (
                                    <Button size="xs" variant="ghost" onClick={() => openLedgerPicker(evt.row.id)}>
                                      Link a ledger expense
                                    </Button>
                                  )}
                                </Box>
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
                                    −{evt.row.quantity} @ {fmtUSD(evt.row.clientUnitPrice)}
                                  </Text>
                                </HStack>
                                <Text fontSize="xs" color="fg.muted">
                                  {fmtDateTime(evt.row.createdAt)}
                                  {evt.row.occurrence?.job?.property?.displayName
                                    ? ` · Job: ${evt.row.occurrence.job.property.displayName}${evt.row.occurrence.startAt ? ` (${fmtDate(evt.row.occurrence.startAt)})` : ""}`
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
                          {showSuperExtras && evt.kind === "PURCHASE" && (
                            <Button
                              size="xs"
                              variant="ghost"
                              colorPalette="red"
                              onClick={() => reversePurchase(evt.row.id, historyOpen?.name ?? "this supply")}
                              // Said "deletes BE" — it deletes no
                              // BusinessExpense. Recording a purchase creates
                              // none, and the optional breadcrumb is SetNull.
                              title="Reverse purchase — removes the units from inventory. No ledger expense is affected."
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
