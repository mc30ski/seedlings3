"use client";

// Invoice charges — lines on the CLIENT'S bill for one job.
//
// NOT business expenses. Adding one writes no ledger row and creates no tax
// deduction; the deduction is the real card charge entered in the Ledger from
// a bank statement. The crew's share is unaffected — they split labor and
// services only. See docs/features/job-materials.md.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Stack,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { apiGet, apiPost, apiDelete, apiPatch } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/dates";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import ImpersonationWarning from "@/src/ui/components/ImpersonationWarning";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { InvoiceAlreadySentNote } from "@/src/ui/components/InvoiceAlreadySentNote";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DialogErrorAlert,
  useDialogError,
} from "@/src/ui/components/DialogErrorAlert";

type LedgerCharge = {
  id: string;
  date: string;
  cost: number;
  description: string;
  vendor: string | null;
  category: string | null;
  referencedByJobs: number;
};

type InvoiceCharge = {
  id: string;
  /** What the CLIENT IS CHARGED for this line. */
  cost: number;
  description: string;
  /** Optional client-visible detail, e.g. "25 bags at $6.00". */
  detail?: string | null;
  /** What we paid, when recorded. Informational only. */
  actualCost?: number | null;
  businessExpenseId?: string | null;
  /** The loosely-linked ledger charge, when one is pointed at. Decorative. */
  businessExpense?: {
    id?: string;
    cost?: number | null;
    description?: string | null;
    vendor?: string | null;
    date?: string | null;
  } | null;
  /** Set when this charge came from consuming inventory. Its amount and name
   *  are DERIVED from quantity x Supply.clientUnitPrice. */
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
  clientUnitPrice: number;
  available: number;
};

/**
 * The four fields of an invoice charge, grouped by WHO SEES THEM.
 *
 * ONE definition, rendered by both the add form and the edit form. Two
 * separate layouts drift immediately — the add form grows a field the edit
 * form doesn't have, and a detail typed once can never be corrected.
 *
 * `fromInventory` marks a line that also draws down stock. It is otherwise an
 * ORDINARY CHARGE: name, amount and detail are all the operator's, and all
 * editable. They used to be read-only, on the theory that the supply catalog
 * decided what a client owes — it does not. The only thing the hold still
 * owns is the stock, so changing the held quantity re-prices the amount, and
 * the form says so rather than locking the field.
 */
function ChargeFields({
  desc, setDesc, cost, setCost, detail, setDetail, actualCost, setActualCost,
  derived = null,
}: {
  desc: string; setDesc: (v: string) => void;
  cost: string; setCost: (v: string) => void;
  detail: string; setDetail: (v: string) => void;
  actualCost: string; setActualCost: (v: string) => void;
  /** Set when the line also draws down stock. Nothing is locked because of
   *  it — it only explains that changing the quantity re-prices the line. */
  derived?: { name: string; quantity: number; unit: string } | null;
}) {
  const margin = (() => {
    const c = parseFloat(cost);
    const a = parseFloat(actualCost);
    if (!isFinite(c) || !isFinite(a)) return null;
    return Math.round((c - a) * 100) / 100;
  })();

  return (
    <VStack align="stretch" gap={3}>
      <Box borderWidth="1px" borderColor="border.muted" borderRadius="md" overflow="hidden">
        <Box px={2.5} py={1} bg="blue.subtle" borderBottomWidth="1px" borderColor="border.muted">
          <Text fontSize="2xs" fontWeight="bold" letterSpacing="0.04em" textTransform="uppercase" color="blue.fg">
            On the client&rsquo;s invoice
          </Text>
        </Box>
        <VStack align="stretch" gap={2.5} p={2.5}>
          <Box>
            <Text fontSize="xs" fontWeight="medium" mb={1}>
              Line name <Text as="span" color="red.solid">*</Text>
            </Text>
            <Input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              size="sm"
              placeholder={derived ? derived.name : "e.g. Mulch"}
            />
            {derived && (
              <Text fontSize="2xs" color="fg.muted" mt={1}>
                Also draws {derived.quantity} {derived.unit} from inventory. Changing that
                quantity re-prices this line; the wording stays yours.
              </Text>
            )}
          </Box>
          <Stack direction={{ base: "column", sm: "row" }} gap={2.5} align="stretch">
            <Box w={{ base: "full", sm: "110px" }} flexShrink={0}>
              <Text fontSize="xs" fontWeight="medium" mb={1}>
                Amount <Text as="span" color="red.solid">*</Text>
              </Text>
              <CurrencyInput value={cost} onChange={setCost} size="sm" />
            </Box>
            <Box flex="1">
              <Text fontSize="xs" fontWeight="medium" mb={1}>
                Detail <Text as="span" color="fg.muted" fontWeight="normal">(optional)</Text>
              </Text>
              <Input
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                size="sm"
                placeholder={
                  derived
                    ? `${derived.quantity} × ${derived.unit} @ $… (written for you)`
                    : "e.g. 25 bags at $6.00"
                }
              />
            </Box>
          </Stack>
          {/* The detail on an inventory line writes itself and FOLLOWS THE
              QUANTITY — that is what stops a line reading "6 bags at $6.00"
              beside $30.00 after an adjustment. Typing your own stops that for
              good, because otherwise the next quantity change would overwrite
              your words. Clearing the field hands it back. */}
          <Text fontSize="2xs" color="fg.muted">
            {derived
              ? `The name and amount follow the ${derived.quantity} ${derived.unit} pulled from inventory — change the quantity on the line to change them. The detail writes itself and updates with the quantity; type your own to take it over, or clear the field to hand it back.`
              : "The client sees the line name, the detail, and the amount."}
          </Text>
        </VStack>
      </Box>

      <Box borderWidth="1px" borderColor="border.muted" borderRadius="md" overflow="hidden">
        <Box px={2.5} py={1} bg="bg.muted" borderBottomWidth="1px" borderColor="border.muted">
          <Text fontSize="2xs" fontWeight="bold" letterSpacing="0.04em" textTransform="uppercase" color="fg.muted">
            Internal &middot; never shown to the client
          </Text>
        </Box>
        <Stack direction={{ base: "column", sm: "row" }} gap={2.5} p={2.5} align={{ base: "stretch", sm: "flex-start" }}>
          <Box w={{ base: "full", sm: "110px" }} flexShrink={0}>
            <Text fontSize="xs" fontWeight="medium" mb={1}>
              What we paid <Text as="span" color="fg.muted" fontWeight="normal">(optional)</Text>
            </Text>
            <CurrencyInput value={actualCost} onChange={setActualCost} size="sm" />
          </Box>
          <Box flex="1">
            <Text fontSize="2xs" color="fg.muted" pt={{ base: 0, sm: 5 }}>
              What this line actually cost you. It only sets the margin shown on
              this job &mdash; it isn&rsquo;t on the client&rsquo;s invoice, doesn&rsquo;t
              change anyone&rsquo;s pay, and isn&rsquo;t what claims the deduction (the
              Ledger does that). Leave it blank if you don&rsquo;t know it.
            </Text>
            {margin != null && (
              <Text fontSize="2xs" fontWeight="medium" mt={1} color={margin < 0 ? "red.fg" : "green.fg"}>
                Margin on this line: {margin < 0 ? "−" : ""}${Math.abs(margin).toFixed(2)}
                {margin < 0 ? " — you are charging less than it cost." : ""}
              </Text>
            )}
          </Box>
        </Stack>
      </Box>
    </VStack>
  );
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  /** Use admin endpoints */
  isAdmin?: boolean;
  /** Whether to offer the ledger-link picker. Separate from `isAdmin`, which
   *  means "this is the ADMIN VIEW" and selects the endpoint set.
   *
   *  Those are not the same question. An admin who claims their own job works
   *  it from the Worker view, where `isAdmin` is false — so the picker
   *  vanished on exactly the surface where the charge was entered. The link
   *  is the least consequential thing in this dialog (it changes no amount
   *  anywhere), so it follows the user's ROLE, not the chip they're on.
   *  Defaults to `isAdmin` for callers that don't distinguish. */
  canLinkLedger?: boolean;
  /** Hide the "From inventory" toggle. Set true for workflows that don't
   *  carry physical supply consumption (events, followups, announcements). */
  disableInventory?: boolean;
  privileges?: {
    canPullInventory: boolean;
    canChargeBusinessExpenses: boolean;
  };
  /** What the client was last asked to pay, when a request is still
   *  outstanding. Null when nothing is in flight. */
  sentInvoiceAmount?: number | null;
  viewAsName?: string | null;
  onChanged?: () => void;
};

export default function ManageInvoiceChargesDialog({
  open,
  onOpenChange,
  occurrenceId,
  isAdmin,
  canLinkLedger,
  disableInventory = false,
  privileges = { canPullInventory: true, canChargeBusinessExpenses: true },
  sentInvoiceAmount = null,
  viewAsName = null,
  onChanged,
}: Props) {
  const canInventory = privileges.canPullInventory && !disableInventory;
  // Every mutation is admin-only on the server. Workers get a read-only list
  // rather than buttons that 403.
  const canCharge = privileges.canChargeBusinessExpenses;
  // Both ledger endpoints are adminGuard'd, so this must track the role.
  const canLink = canLinkLedger ?? !!isAdmin;
  const [charges, setCharges] = useState<InvoiceCharge[]>([]);
  const [loading, setLoading] = useState(false);
  const [holdBusy, setHoldBusy] = useState(false);
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, string>>({});

  const [addMode, setAddMode] = useState<"custom" | "inventory" | null>(null);

  const [newCost, setNewCost] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newDetail, setNewDetail] = useState("");
  const [newActualCost, setNewActualCost] = useState("");

  // The loose ledger pointer: which line's picker is open, the searchable
  // list, and the search text.
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [ledgerCharges, setLedgerCharges] = useState<LedgerCharge[]>([]);
  const [ledgerQuery, setLedgerQuery] = useState("");
  const [ledgerBusy, setLedgerBusy] = useState(false);

  const [supplies, setSupplies] = useState<SupplyOption[]>([]);
  const [pickedSupplyId, setPickedSupplyId] = useState<string>("");
  const [pickedQty, setPickedQty] = useState("");
  /** What THIS client is charged per unit, for THIS job. The catalog's figure
   *  is only a default — the same supply is billed differently to different
   *  clients, and the price is decided here, when it goes onto the job. */
  const [pickedUnitPrice, setPickedUnitPrice] = useState("");
  /** The headline and detail a CLIENT reads. A supply line is an ordinary
   *  charge that happens to draw down stock — same shape as a one-off. */
  const [pickedDesc, setPickedDesc] = useState("");
  const [pickedDetail, setPickedDetail] = useState("");

  // WHAT THE SERVER WILL WRITE if the detail is left blank. Must stay
  // character-for-character identical to `supplyChargeDetail` in
  // services/supplies.ts — a preview that does not match what gets saved is
  // worse than no preview. A build gate asserts the two templates agree.
  function autoDetailPreview(): string | null {
    if (!pickedSupply) return null;
    const qty = Number(pickedQty) || 0;
    if (qty <= 0) return null;
    const unitPrice =
      pickedUnitPrice.trim() !== "" ? Number(pickedUnitPrice) : pickedSupply.clientUnitPrice;
    if (!Number.isFinite(unitPrice)) return null;
    return `${qty} × ${pickedSupply.unit} @ $${unitPrice.toFixed(2)}`;
  }

  /** Placeholder before a real preview is possible. Uses whatever IS known —
   *  the unit as soon as a supply is picked, the price as soon as one is set —
   *  so the field never shows an example that contradicts the selections
   *  visible directly beneath it.
   *
   *  IN THE SAME SHAPE AS THE REAL THING. The old example read "5 bags at
   *  $5.00 each", which is not the format that gets saved — it taught the
   *  wrong pattern to anyone who copied it. */
  function detailPlaceholder(): string {
    const real = autoDetailPreview();
    if (real) return real;
    const unit = pickedSupply?.unit ?? "bag";
    const qty = Number(pickedQty) || 5;
    const price =
      pickedUnitPrice.trim() !== ""
        ? Number(pickedUnitPrice)
        : (pickedSupply?.clientUnitPrice ?? 5);
    const shown = Number.isFinite(price) ? price : 5;
    return `e.g. ${qty} × ${unit} @ $${shown.toFixed(2)}`;
  }

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCost, setEditCost] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editDetail, setEditDetail] = useState("");
  const [editActualCost, setEditActualCost] = useState("");
  const dlgErr = useDialogError();

  const chargesEndpoint = isAdmin
    ? `/api/admin/occurrences/${occurrenceId}/invoice-charges`
    : `/api/occurrences/${occurrenceId}/invoice-charges`;
  const holdsEndpoint = isAdmin
    ? `/api/admin/occurrences/${occurrenceId}/supply-holds`
    : `/api/occurrences/${occurrenceId}/supply-holds`;

  const supplyCollection = useMemo(
    () =>
      createListCollection({
        items: supplies.map((s) => ({
          label: `${s.name} — ${s.available} ${s.unit} avail @ $${s.clientUnitPrice.toFixed(2)}/${s.unit}`,
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
    // ALL FOUR add fields reset. Clearing only two left a detail or a cost
    // from the last job sitting in the form.
    setNewCost("");
    setNewDesc("");
    setNewDetail("");
    setNewActualCost("");
    setPickedSupplyId("");
    setPickedQty("");
    setEditingId(null);
    apiGet<any[]>("/api/supplies")
      .then((list) => {
        if (!Array.isArray(list)) { setSupplies([]); return; }
        setSupplies(
          list
            .filter((s) => !s.archivedAt)
            .map((s) => ({
              id: s.id,
              name: s.name,
              unit: s.unit,
              clientUnitPrice: Number(s.clientUnitPrice ?? 0),
              available: Number(s.available ?? 0),
            })),
        );
      })
      .catch(() => setSupplies([]));
    apiGet<InvoiceCharge[]>(chargesEndpoint)
      .then((list) => setCharges(Array.isArray(list) ? list : []))
      .catch(() => setCharges([]))
      .finally(() => setLoading(false));
  }, [open, occurrenceId]);

  /**
   * The loose pointer from an invoice line to a real ledger charge.
   *
   * Purely a breadcrumb — no total reads it, and clearing it changes no
   * number. It exists so that six weeks later a $500 Lowe's charge can tell
   * you which jobs it went to.
   */
  async function openLedgerPicker(invoiceChargeId: string) {
    setLinkingId(invoiceChargeId);
    setLedgerQuery("");
    setLedgerBusy(true);
    try {
      setLedgerCharges(await apiGet<LedgerCharge[]>("/api/admin/ledger-charges"));
    } catch (err) {
      dlgErr.setError(getErrorMessage("Couldn't load ledger charges.", err));
    } finally {
      setLedgerBusy(false);
    }
  }

  // DEBOUNCED AND RACE-GUARDED — see the same comment in SuppliesTab. Bound
  // straight to onChange this ran one request, and one ILIKE scan of the
  // ledger, per keystroke, and applied whichever response landed last.
  const ledgerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ledgerSeq = useRef(0);

  useEffect(() => () => { if (ledgerTimer.current) clearTimeout(ledgerTimer.current); }, []);

  function searchLedger(q: string) {
    setLedgerQuery(q);
    setLedgerBusy(true);
    if (ledgerTimer.current) clearTimeout(ledgerTimer.current);
    ledgerTimer.current = setTimeout(async () => {
      const seq = ++ledgerSeq.current;
      try {
        const rows = await apiGet<LedgerCharge[]>(
          `/api/admin/ledger-charges?q=${encodeURIComponent(q)}`,
        );
        if (seq === ledgerSeq.current) setLedgerCharges(rows);
      } catch { /* keep the last list rather than emptying it mid-type */ }
      finally { if (seq === ledgerSeq.current) setLedgerBusy(false); }
    }, 250);
  }

  async function setLedgerLink(invoiceChargeId: string, businessExpenseId: string | null) {
    try {
      const updated = await apiPatch<InvoiceCharge>(
        `/api/admin/invoice-charges/${invoiceChargeId}/ledger-link`,
        { businessExpenseId },
      );
      setCharges((prev) => prev.map((e) => (e.id === invoiceChargeId ? { ...e, ...updated } : e)));
      setLinkingId(null);
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Couldn't link that charge.", err));
    }
  }

  async function handleAdd() {
    const cost = parseFloat(newCost);
    if (isNaN(cost) || cost <= 0 || !newDesc.trim()) return;
    dlgErr.clear();
    try {
      const created = await apiPost<InvoiceCharge>(chargesEndpoint, {
        cost,
        description: newDesc.trim(),
        actualCost: newActualCost.trim() ? parseFloat(newActualCost) : null,
        detail: newDetail.trim() || null,
      });
      setCharges((prev) => [...prev, created]);
      setNewCost("");
      setNewDesc("");
      setNewDetail("");
      setNewActualCost("");
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Couldn't add that charge.", err));
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
    dlgErr.clear();
    try {
      await apiPost<any>(holdsEndpoint, {
        supplyId: pickedSupplyId,
        quantity: qty,
        // Blank means "use the supply's default".
        clientUnitPrice: pickedUnitPrice.trim() === "" ? null : Number(pickedUnitPrice),
        description: pickedDesc.trim() || null,
        detail: pickedDetail.trim() || null,
      });
      // The API returns the SupplyHold with its linked charge. Reload the full
      // list so the new row shows up with the inventory chip.
      const refreshed = await apiGet<InvoiceCharge[]>(chargesEndpoint);
      setCharges(Array.isArray(refreshed) ? refreshed : []);
      setSupplies((prev) =>
        prev.map((s) => (s.id === pickedSupplyId ? { ...s, available: s.available - qty } : s)),
      );
      setPickedSupplyId("");
      setPickedQty("");
      setPickedUnitPrice("");
      setPickedDesc("");
      setPickedDetail("");
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to add from inventory.", err));
    }
  }

  /** The charge awaiting confirmation. Removing a line LOWERS WHAT THE CLIENT
   *  OWES — it is exactly the mutation the repo requires a confirm for, and it
   *  had none. The card's inline ✕ was taken away for this reason and the
   *  dialog it moved into deleted on a single tap. */
  const [removing, setRemoving] = useState<InvoiceCharge | null>(null);

  async function handleDelete(id: string) {
    dlgErr.clear();
    try {
      const endpoint = isAdmin ? `/api/admin/invoice-charges/${id}` : `/api/invoice-charges/${id}`;
      await apiDelete(endpoint);
      setCharges((prev) => prev.filter((e) => e.id !== id));
      onChanged?.();
      setRemoving(null);
    } catch (err) {
      dlgErr.setError(getErrorMessage("Couldn't remove that charge.", err));
      setRemoving(null);
    }
  }

  // Bump an inventory-backed hold up or down. The server reprices the paired
  // charge and reconciles physical stock. Re-reads both lists afterward so
  // amounts and availability stay exact.
  async function handleAdjustHold(holdId: string, newQty: number) {
    if (newQty < 1 || holdBusy) return;
    dlgErr.clear();
    setHoldBusy(true);
    try {
      const endpoint = isAdmin
        ? `/api/admin/supply-holds/${holdId}`
        : `/api/supply-holds/${holdId}`;
      await apiPatch(endpoint, { quantity: newQty });
      const [refreshed, freshSupplies] = await Promise.all([
        apiGet<InvoiceCharge[]>(chargesEndpoint),
        apiGet<any[]>("/api/supplies"),
      ]);
      setCharges(Array.isArray(refreshed) ? refreshed : []);
      if (Array.isArray(freshSupplies)) {
        setSupplies(
          freshSupplies
            .filter((s) => !s.archivedAt)
            .map((s) => ({
              id: s.id,
              name: s.name,
              unit: s.unit,
              clientUnitPrice: Number(s.clientUnitPrice ?? 0),
              available: Number(s.available ?? 0),
            })),
        );
      }
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Failed to adjust supply quantity.", err));
    } finally {
      setHoldBusy(false);
      setQtyDrafts((p) => {
        if (!(holdId in p)) return p;
        const n = { ...p };
        delete n[holdId];
        return n;
      });
    }
  }

  function commitQty(holdId: string, currentQty: number) {
    const draft = qtyDrafts[holdId];
    if (draft === undefined) return;
    const parsed = Math.round(Number(draft));
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      publishInlineMessage({
        type: "WARNING",
        text: "Quantity must be a whole number of at least 1 — use ✕ to remove entirely.",
      });
      setQtyDrafts((p) => { const n = { ...p }; delete n[holdId]; return n; });
      return;
    }
    if (parsed === currentQty) {
      setQtyDrafts((p) => { const n = { ...p }; delete n[holdId]; return n; });
      return;
    }
    void handleAdjustHold(holdId, parsed);
  }

  async function handleUpdate() {
    if (!editingId) return;
    const row = charges.find((c) => c.id === editingId);
    const fromInventory = !!row?.supplyHold;
    const cost = parseFloat(editCost);
    // A derived row has no editable amount or name to validate.
    if (!fromInventory && (isNaN(cost) || cost <= 0 || !editDesc.trim())) return;
    dlgErr.clear();
    try {
      const endpoint = isAdmin
        ? `/api/admin/invoice-charges/${editingId}`
        : `/api/invoice-charges/${editingId}`;
      const updated = await apiPatch<InvoiceCharge>(endpoint, {
        // Amount and name are DERIVED on an inventory line — omit them so the
        // server doesn't reject the whole patch. The stepper owns them.
        ...(fromInventory ? {} : { cost, description: editDesc.trim() }),
        // Sent as null when blank, which CLEARS the field. That is how an
        // operator removes a detail or a cost entered by mistake.
        detail: editDetail.trim() || null,
        actualCost: editActualCost.trim() ? parseFloat(editActualCost) : null,
      });
      setCharges((prev) => prev.map((e) => (e.id === editingId ? updated : e)));
      setEditingId(null);
      onChanged?.();
    } catch (err) {
      dlgErr.setError(getErrorMessage("Couldn't update that charge.", err));
    }
  }

  const total = charges.reduce((s, e) => s + e.cost, 0);

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onOpenChange(false); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Edit Charges</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <ImpersonationWarning viewAsName={viewAsName} />
              <Box mb={3}>
                <InvoiceAlreadySentNote sentAmount={sentInvoiceAmount} />
              </Box>
              <VStack align="stretch" gap={3}>
                {/* WORDED FOR WHOEVER IS READING IT.
                    Saying these "are not business expenses" is wrong to
                    anyone who just paid for the mulch — the money absolutely
                    was spent. What is true is narrower: this row is not the
                    TAX RECORD. A worker, who can't add one at all, doesn't
                    need the Ledger half of that. */}
                <Box p={2} bg="blue.50" borderWidth="1px" borderLeftWidth="3px" borderColor="blue.200" borderRadius="md">
                  {canCharge ? (
                    <VStack align="stretch" gap={1.5}>
                      <Text fontSize="xs" color="blue.800">
                        These go on the client&rsquo;s invoice, on top of the labor price.
                        The crew&rsquo;s pool stays <Text as="span" fontWeight="semibold">labor
                        and services only</Text> &mdash; a charge here never comes out of
                        anyone&rsquo;s pay.
                      </Text>
                      <Text fontSize="xs" color="blue.800">
                        <Text as="span" fontWeight="semibold">This is not where the
                        deduction is recorded.</Text> It&rsquo;s a real business cost, but the
                        tax record is the actual purchase, entered in the Ledger from your
                        card statement. Do both — they&rsquo;re two different books.
                      </Text>
                      {/* THE ONE DECISION THIS SCREEN ASKS FOR.
                          Charge vs service is the only judgement call, and it
                          decides whether the money reaches the crew's POOL.
                          Stated on both dialogs, in the same words, so the
                          answer doesn't depend on which one you happened to
                          open.

                          "Pool", never "the crew splits it" — see the longer
                          note in ManageAddonsDialog. Margin and fees come off the
                          pool before anyone is paid. */}
                      <Box borderTopWidth="1px" borderColor="blue.200" pt={1.5}>
                        <Text fontSize="xs" color="blue.800">
                          <Text as="span" fontWeight="semibold">Did you buy a thing?</Text>{" "}
                          Add Charge. Billed on top, pool unchanged.
                        </Text>
                        <Text fontSize="xs" color="blue.800">
                          <Text as="span" fontWeight="semibold">Did someone do work?</Text>{" "}
                          Add Service. Billed on top, <Text as="span" fontWeight="semibold">and
                          it raises the crew&rsquo;s pool</Text>.
                        </Text>
                      </Box>
                    </VStack>
                  ) : (
                    <Text fontSize="xs" color="blue.800">
                      Extra costs billed to the client on this job, on top of the labor
                      price. They don&rsquo;t come out of your pay &mdash; your share
                      comes from the labor and services on the job.
                      Only an admin can add or change them.
                    </Text>
                  )}
                </Box>

                {charges.length === 0 && !loading && (
                  <Text fontSize="xs" color="fg.muted">No charges on this invoice yet.</Text>
                )}

                {charges.length > 0 && (
                  <VStack align="stretch" gap={1}>
                    {charges.map((exp) =>
                      editingId === exp.id ? (
                        // SAME FIELDS AS THE ADD FORM. One component, so the
                        // two can't drift — an editable field on one is an
                        // editable field on the other, by construction.
                        <VStack
                          key={exp.id}
                          align="stretch"
                          gap={2}
                          borderWidth="1px"
                          borderColor="border"
                          borderRadius="md"
                          p={2}
                        >
                          <ChargeFields
                            desc={editDesc} setDesc={setEditDesc}
                            cost={editCost} setCost={setEditCost}
                            detail={editDetail} setDetail={setEditDetail}
                            actualCost={editActualCost} setActualCost={setEditActualCost}
                            derived={exp.supplyHold ? {
                              name: exp.supplyHold.supply?.name ?? exp.description,
                              quantity: exp.supplyHold.quantity,
                              unit: exp.supplyHold.supply?.unit ?? "unit",
                            } : null}
                          />
                          <HStack gap={2} justify="flex-end">
                            <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                              Cancel
                            </Button>
                            <Button size="sm" colorPalette="teal" onClick={handleUpdate}>
                              Save
                            </Button>
                          </HStack>
                        </VStack>
                      ) : (
                        <VStack key={exp.id} align="stretch" gap={1}>
                          <HStack gap={2} fontSize="xs" align="start">
                            <Box flex="1" minW={0}>
                              <Text color="orange.600">
                                ${exp.cost.toFixed(2)} — {exp.description}
                                {exp.supplyHold ? (
                                  <Text as="span" color="blue.600" ml={1}>· Inventory</Text>
                                ) : (
                                  <Text as="span" color="fg.muted" ml={1}>· One-off</Text>
                                )}
                              </Text>
                              {exp.detail && (
                                <Text color="fg.muted" fontSize="2xs">{exp.detail}</Text>
                              )}
                              {/* Without this, "what we paid" is write-only —
                                  no way to tell a recorded cost from a
                                  forgotten one, nor to check the margin the
                                  form promises. ADMIN-ONLY. */}
                              {canCharge && (
                                <Text fontSize="2xs" color="fg.muted">
                                  {exp.actualCost != null ? (
                                    <>
                                      Cost ${exp.actualCost.toFixed(2)} ·{" "}
                                      <Text
                                        as="span"
                                        color={exp.cost - exp.actualCost < 0 ? "red.fg" : "green.fg"}
                                        fontWeight="medium"
                                      >
                                        {exp.cost - exp.actualCost < 0 ? "−" : ""}$
                                        {Math.abs(Math.round((exp.cost - exp.actualCost) * 100) / 100).toFixed(2)} margin
                                      </Text>
                                    </>
                                  ) : (
                                    "No cost recorded"
                                  )}
                                </Text>
                              )}
                            </Box>
                            {/* Inventory rows get a quantity stepper — amount
                                and name are derived, so the server reprices
                                and reconciles stock on each step. */}
                            {exp.supplyHold ? (() => {
                              const h = exp.supplyHold!;
                              const sup = supplies.find((s) => s.id === h.supply?.id);
                              const canInc = !sup || sup.available > 0;
                              return (
                                <HStack gap={0.5} flexShrink={0}>
                                  <Button
                                    size="xs" variant="outline" px={1.5}
                                    disabled={holdBusy || h.quantity <= 1}
                                    title="Remove one — returns it to inventory"
                                    onClick={() => handleAdjustHold(h.id, h.quantity - 1)}
                                  >
                                    −
                                  </Button>
                                  <Input
                                    type="number" min={1} step={1} size="xs" w="48px"
                                    textAlign="center" px={1} disabled={holdBusy}
                                    value={qtyDrafts[h.id] ?? String(h.quantity)}
                                    onChange={(e) => setQtyDrafts((p) => ({ ...p, [h.id]: e.target.value }))}
                                    onBlur={() => commitQty(h.id, h.quantity)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                    }}
                                  />
                                  <Button
                                    size="xs" variant="outline" px={1.5}
                                    disabled={holdBusy || !canInc}
                                    title={canInc ? "Add one more from inventory" : "None left in inventory"}
                                    onClick={() => handleAdjustHold(h.id, h.quantity + 1)}
                                  >
                                    +
                                  </Button>
                                </HStack>
                              );
                            })() : null}
                            {/* EVERY row is editable, inventory included — its
                                detail and our cost are free-form even when
                                the amount is derived. */}
                            {canCharge && (
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => {
                                  setEditingId(exp.id);
                                  setEditCost(exp.cost.toFixed(2));
                                  setEditDesc(exp.description);
                                  setEditDetail(exp.detail ?? "");
                                  setEditActualCost(
                                    exp.actualCost != null ? exp.actualCost.toFixed(2) : "",
                                  );
                                }}
                              >
                                Edit
                              </Button>
                            )}
                            {/* Removing a line lowers what the client owes, so
                                it is admin-only on the server. Hide it rather
                                than let a worker click into a 403. */}
                            {canCharge && (
                              <Button
                                size="xs" variant="ghost" colorPalette="red"
                                // A bare ✕ is the entire accessible name of a
                                // control that takes money off a client's
                                // invoice — a screen reader announces "times".
                                // Naming the row it acts on is what makes it
                                // reachable by anything other than sight.
                                aria-label={`Remove charge: ${exp.description}`}
                                title={`Remove "${exp.description}" from this invoice`}
                                onClick={() => setRemoving(exp)}
                              >
                                ✕
                              </Button>
                            )}
                          </HStack>

                          {/* Loose ledger pointer. Optional, many lines to one
                              charge, and read by nothing — see the service
                              comment on openLedgerPicker. */}
                          {canLink && (
                            <Box pl={1}>
                              {exp.businessExpense ? (
                                <HStack gap={2} fontSize="xs" wrap="wrap">
                                  <Text color="fg.muted">
                                    Ledger: {exp.businessExpense.description ?? "charge"}
                                    {exp.businessExpense.vendor ? ` · ${exp.businessExpense.vendor}` : ""}
                                  </Text>
                                  <Button size="xs" variant="ghost" onClick={() => setLedgerLink(exp.id, null)}>
                                    Unlink
                                  </Button>
                                </HStack>
                              ) : linkingId === exp.id ? (
                                <VStack align="stretch" gap={1} borderWidth="1px" borderColor="border" borderRadius="md" p={2}>
                                  <HStack gap={2}>
                                    <Input
                                      size="xs" autoFocus value={ledgerQuery}
                                      onChange={(e) => searchLedger(e.target.value)}
                                      placeholder="Search the ledger by vendor or description"
                                    />
                                    <Button size="xs" variant="ghost" onClick={() => setLinkingId(null)}>✕</Button>
                                  </HStack>
                                  {ledgerBusy && <Text fontSize="2xs" color="fg.muted">Loading…</Text>}
                                  <VStack align="stretch" gap={0} maxH="180px" overflowY="auto">
                                    {ledgerCharges.map((c) => (
                                      <Button
                                        key={c.id} size="xs" variant="ghost" justifyContent="start"
                                        onClick={() => void setLedgerLink(exp.id, c.id)}
                                      >
                                        <Text fontSize="2xs" truncate>
                                          {fmtDate(c.date)} · ${c.cost.toFixed(2)} ·{" "}
                                          {c.vendor ? `${c.vendor} — ` : ""}{c.description}
                                          {c.referencedByJobs > 0
                                            ? ` (${c.referencedByJobs} job${c.referencedByJobs === 1 ? "" : "s"})`
                                            : ""}
                                        </Text>
                                      </Button>
                                    ))}
                                    {!ledgerBusy && ledgerCharges.length === 0 && (
                                      <Text fontSize="2xs" color="fg.muted">No matching charges.</Text>
                                    )}
                                  </VStack>
                                  <Text fontSize="2xs" color="fg.muted">
                                    A reminder of what you bought — it changes no amount anywhere.
                                  </Text>
                                </VStack>
                              ) : (
                                <Button size="xs" variant="ghost" onClick={() => void openLedgerPicker(exp.id)}>
                                  Link a ledger charge
                                </Button>
                              )}
                            </Box>
                          )}

                          {/* NO RECEIPT UPLOAD HERE.
                              A receipt belongs to the LEDGER row — that is the
                              record which has to survive an audit, and it is
                              where BusinessExpensesTab attaches one. Uploading
                              from a job line wrote to the linked ledger row:
                              on a new charge that link is null and it 409'd;
                              on one carrying the breadcrumb it attached to a
                              receipt shared with other jobs, and replacing it
                              deleted the previous file. */}
                        </VStack>
                      ),
                    )}
                    <HStack justify="flex-end" fontSize="sm" pt={1} borderTopWidth="1px" borderColor="gray.200">
                      <Text fontWeight="medium" color="orange.600">Total: ${total.toFixed(2)}</Text>
                    </HStack>
                  </VStack>
                )}

                {/* Add a charge */}
                <Box>
                  <HStack justify="space-between" mb={1} gap={2} wrap="wrap">
                    <Text fontSize="sm" fontWeight="medium">Add a charge</Text>
                    <HStack gap={1}>
                      <Button
                        size="xs"
                        variant={addMode === "custom" ? "solid" : "outline"}
                        onClick={() => setAddMode("custom")}
                      >
                        One-off
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

                  {addMode === null ? null : addMode === "custom" && !canCharge ? (
                    <Box p={2} bg="yellow.50" borderWidth="1px" borderLeftWidth="3px" borderColor="yellow.300" borderRadius="md">
                      <Text fontSize="xs" color="yellow.800">
                        Only an admin can add a charge to an invoice — it changes what the
                        client is billed. Ask one to add it for you.
                      </Text>
                    </Box>
                  ) : addMode === "inventory" && !canInventory ? (
                    <Box p={2} bg="yellow.50" borderWidth="1px" borderLeftWidth="3px" borderColor="yellow.300" borderRadius="md">
                      <Text fontSize="xs" color="yellow.800">
                        Only an admin can put supplies on an invoice
                        {disableInventory ? ", and this kind of job doesn't carry them" : ""} —
                        it changes what the client is billed.
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
                      {/* WHAT THE CLIENT READS. Same two fields as a one-off
                          charge — the line used to be generated as
                          "Mulch × 5 bag", which is a stock movement printed on
                          an invoice. */}
                      <Box>
                        <Text fontSize="2xs" color="fg.muted" mb={0.5}>
                          On the invoice{" "}
                          <Text as="span" color="fg.muted">
                            (defaults to the supply&rsquo;s name)
                          </Text>
                        </Text>
                        <Input
                          size="sm"
                          value={pickedDesc}
                          onChange={(e) => setPickedDesc(e.target.value)}
                          placeholder={pickedSupply?.name ?? "e.g. Mulch"}
                        />
                      </Box>
                      {/* LEAVING IT BLANK IS THE AUTO OPTION — there is no
                          toggle, because a toggle would be a second thing to
                          get wrong. The server writes the detail from the hold
                          and keeps it in step with the quantity; typing here
                          takes it over for good. None of that was visible on
                          this form, so the feature may as well not have
                          existed: the placeholder read like an instruction to
                          write one yourself. */}
                      <Box>
                        <Text fontSize="2xs" color="fg.muted" mb={0.5}>
                          Detail for the client{" "}
                          <Text as="span" color="fg.muted">
                            (written for you unless you type one)
                          </Text>
                        </Text>
                        <Input
                          size="sm"
                          value={pickedDetail}
                          onChange={(e) => setPickedDetail(e.target.value)}
                          placeholder={detailPlaceholder()}
                        />
                        {!pickedDetail.trim() && (
                          <Text fontSize="2xs" color="fg.muted" mt={0.5}>
                            {autoDetailPreview()
                              ? <>Leaving this blank writes <Text as="span" fontWeight="semibold">{autoDetailPreview()}</Text>, and keeps it correct if the quantity changes.</>
                              : "Pick a supply and a quantity and this writes itself."}
                          </Text>
                        )}
                        {pickedDetail.trim() && (
                          <Text fontSize="2xs" color="fg.muted" mt={0.5}>
                            Your wording — it will not be rewritten when the quantity changes.{" "}
                            <Text
                              as="span"
                              color="blue.600"
                              cursor="pointer"
                              textDecoration="underline"
                              onClick={() => setPickedDetail("")}
                            >
                              Write it for me
                            </Text>
                          </Text>
                        )}
                      </Box>

                      {/* THE PRICE IS SET HERE, on the job, not in the
                          catalog. The catalog value pre-fills it because it is
                          usually right; overtyping bills THIS client
                          differently, which was impossible before — the hold
                          simply took the catalog price. */}
                      {/* WRAPS RATHER THAN CRUSHES. The summary sat in a
                          `flex="1" minW={0}` box, so it absorbed every pixel
                          the other controls did not want — and when the Qty
                          stepper grew from one 72px input to three controls,
                          it collapsed to a ~60px column and broke "Client is
                          billed $87.00 (16 available)" across six lines.
                          minW gives it a floor; wrap lets it take its own row
                          on a narrow dialog instead of shredding. */}
                      <HStack gap={2} align="end" wrap="wrap">
                        {/* EXPLICIT − / + RATHER THAN THE NATIVE SPINNER.
                            The browser's spinner on a number input is a ~10px
                            target that AUTO-REPEATS AND ACCELERATES while held,
                            so a normal press walks the value several steps —
                            it read as the number jumping 1, 2, 4, 8. The
                            keyboard step was always exactly +1, which is how
                            we know the handler was never at fault.
                            `appearance: none` removes the native control; the
                            inventory rows in this same dialog already step this
                            way, and buttons are the only usable option on a
                            phone. */}
                        <Box flexShrink={0}>
                          <Text fontSize="2xs" color="fg.muted" mb={0.5}>Qty</Text>
                          <HStack gap={0.5}>
                            <Button
                              size="sm" variant="outline" px={2}
                              disabled={(Number(pickedQty) || 0) <= 1}
                              aria-label="One fewer"
                              onClick={() =>
                                setPickedQty(String(Math.max(1, (Number(pickedQty) || 0) - 1)))
                              }
                            >
                              −
                            </Button>
                            <Input
                              type="number" min={1} step={1}
                              value={pickedQty}
                              onChange={(e) => setPickedQty(e.target.value)}
                              size="sm" placeholder="0" w="52px" textAlign="center" px={1}
                              css={{
                                "&::-webkit-outer-spin-button, &::-webkit-inner-spin-button": {
                                  WebkitAppearance: "none",
                                  margin: 0,
                                },
                                MozAppearance: "textfield",
                              }}
                            />
                            <Button
                              size="sm" variant="outline" px={2}
                              aria-label="One more"
                              disabled={
                                !!pickedSupply && (Number(pickedQty) || 0) >= pickedSupply.available
                              }
                              title={
                                pickedSupply && (Number(pickedQty) || 0) >= pickedSupply.available
                                  ? `Only ${pickedSupply.available} ${pickedSupply.unit} in stock`
                                  : "One more"
                              }
                              onClick={() => setPickedQty(String((Number(pickedQty) || 0) + 1))}
                            >
                              +
                            </Button>
                          </HStack>
                        </Box>
                        <Box w="110px" flexShrink={0}>
                          <Text fontSize="2xs" color="fg.muted" mb={0.5}>
                            Charge / {pickedSupply?.unit ?? "unit"}
                          </Text>
                          <CurrencyInput
                            value={
                              pickedUnitPrice !== ""
                                ? pickedUnitPrice
                                : pickedSupply
                                  ? pickedSupply.clientUnitPrice.toFixed(2)
                                  : ""
                            }
                            onChange={setPickedUnitPrice}
                            size="sm"
                          />
                        </Box>
                        <Box flex="1" minW="180px">
                          {pickedSupply && pickedQty && Number(pickedQty) > 0 && (() => {
                            const unit =
                              pickedUnitPrice.trim() === ""
                                ? pickedSupply.clientUnitPrice
                                : Number(pickedUnitPrice);
                            const total = Math.round(Number(pickedQty) * unit * 100) / 100;
                            return (
                              <Text fontSize="xs" color="fg.muted">
                                <Text as="span" whiteSpace="nowrap">
                                  Client is billed{" "}
                                  <Text as="span" fontWeight="semibold">${total.toFixed(2)}</Text>
                                </Text>{" "}
                                <Text
                                  as="span"
                                  whiteSpace="nowrap"
                                  color={Number(pickedQty) > pickedSupply.available ? "red.600" : "fg.muted"}
                                >
                                  {/* NO UNIT HERE. "16 blade available" is
                                      ungrammatical, and units like
                                      "3 oz (1 gallon mix)" cannot be
                                      pluralised at all — the same trap the
                                      detail format was designed around. The
                                      unit is already on the "Charge / blade"
                                      label directly above. */}
                                  ({pickedSupply.available} available)
                                </Text>
                              </Text>
                            );
                          })()}
                        </Box>
                        <Button
                          size="xs" variant="outline" colorPalette="blue"
                          disabled={
                            !pickedSupplyId || !pickedQty ||
                            !Number.isInteger(Number(pickedQty)) || Number(pickedQty) <= 0 ||
                            !!(pickedSupply && Number(pickedQty) > pickedSupply.available)
                          }
                          onClick={handleAddFromInventory}
                        >
                          Add
                        </Button>
                      </HStack>
                    </VStack>
                  ) : (
                    // Same component the edit form renders, so the two can
                    // never offer different fields.
                    <VStack align="stretch" gap={3}>
                      <ChargeFields
                        desc={newDesc} setDesc={setNewDesc}
                        cost={newCost} setCost={setNewCost}
                        detail={newDetail} setDetail={setNewDetail}
                        actualCost={newActualCost} setActualCost={setNewActualCost}
                      />
                      <HStack gap={2} align="center">
                        {/* No tax-category picker — a charge writes no ledger
                            row, so there is no tax line to file it against. */}
                        {/* Say WHY the button is dead rather than leaving a
                            greyed control with no explanation. */}
                        <Text fontSize="2xs" color="fg.muted" flex="1">
                          {!newDesc.trim() && !newCost
                            ? "Enter a line name and an amount."
                            : !newDesc.trim()
                              ? "Enter a line name."
                              : !newCost
                                ? "Enter an amount."
                                : ""}
                        </Text>
                        <Button
                          size="sm"
                          colorPalette="teal"
                          disabled={!newCost || !newDesc.trim()}
                          onClick={handleAdd}
                        >
                          Add to invoice
                        </Button>
                      </HStack>
                    </VStack>
                  )}
                </Box>
              </VStack>
            </Dialog.Body>
            <DialogErrorAlert error={dlgErr.error} onDismiss={dlgErr.clear} />
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
      {/* Mandatory for any mutation, and doubly so for one that changes an
          invoice a client may already be looking at. */}
      <ConfirmDialog
        open={!!removing}
        title="Remove this charge?"
        message={
          removing
            ? `${removing.description} ($${(removing.cost ?? 0).toFixed(2)}) comes off this job, and off what the client is billed.`
            : ""
        }
        confirmLabel="Remove"
        confirmColorPalette="red"
        onConfirm={() => { if (removing) void handleDelete(removing.id); }}
        onCancel={() => setRemoving(null)}
      />
    </Dialog.Root>
  );
}
