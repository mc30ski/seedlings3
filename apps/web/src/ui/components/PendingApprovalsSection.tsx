"use client";

// Pinned-to-the-top section of the Admin Payments tab. Lists every self-
// reported Payment that hasn't been admin-approved yet, with three actions
// per row: Approve, Reject (with reason), Open job. Refresh is manual
// (refresh button on the section, or reload the page).
//
// There is intentionally no "Adjust & approve" — if the reported amount
// is wrong, admin Rejects (with reason) and the worker re-records via
// Accept Payment. That keeps the audit trail clean and the workflow easy
// to understand: client's report is either right (Approve) or wrong
// (Reject + re-record).

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Check, ExternalLink, Pencil, RefreshCw, Slash, XCircle } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/dates";
import { composePaymentMessage, type PaymentActionResult } from "@/src/lib/paymentMessages";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import ApprovePaymentDialog from "@/src/ui/dialogs/ApprovePaymentDialog";
import AdjustPaymentDialog from "@/src/ui/dialogs/AdjustPaymentDialog";
import { PaymentContactsLine } from "@/src/ui/components/PaymentContactsLine";
import { PaymentPropertyLine } from "@/src/ui/components/PaymentPropertyLine";
import { bumpAdminPayments } from "@/src/lib/bus";

type PendingRow = {
  id: string;
  amountPaid: number;
  method: string;
  note: string | null;
  selfReported: boolean;
  createdAt: string;
  /** Estimated processor fee stamped at record time; overridable at approval. */
  processorFeeAmount: number | null;
  collectedBy: { id: string; displayName: string | null; email: string | null } | null;
  occurrence: {
    id: string;
    startAt: string | null;
    completedAt: string | null;
    price: number | null;
    addons: { price: number }[];
    frequencyDays: number | null;
    isOneOff: boolean;
    workflow: string | null;
    job: {
      id: string;
      frequencyDays: number | null;
      status: string | null;
      property: {
        displayName: string | null;
        street1: string | null;
        city: string | null;
        state: string | null;
        client: {
          displayName: string | null;
          /** Every active contact — feeds the "Contacts" line on the
           *  card so the operator can match a spouse / roommate /
           *  different-last-name payer when reconciling. Primary first. */
          contacts: Array<{
            id: string;
            firstName: string | null;
            lastName: string | null;
            nickname: string | null;
            phone: string | null;
            email: string | null;
            isPrimary: boolean;
          }>;
        } | null;
      } | null;
    } | null;
    assignees: { userId: string; user: { displayName: string | null; email: string | null } | null }[];
  };
};

// True when approving the payment should auto-create the next occurrence.
// Matches the server-side logic in approvePayment: needs a frequency on
// either the occurrence or the job, the job must not be PAUSED, and it
// must not be a one-off.
function willScheduleNext(row: PendingRow): boolean {
  const effectiveFreq = row.occurrence.frequencyDays ?? row.occurrence.job?.frequencyDays ?? null;
  if (!effectiveFreq) return false;
  if (row.occurrence.isOneOff) return false;
  if (row.occurrence.workflow === "ONE_OFF") return false;
  if (row.occurrence.job?.status === "PAUSED") return false;
  return true;
}

function propertyLabel(p: PendingRow["occurrence"]["job"] extends infer J ? J : never): string {
  // Defensive — handle missing property
  const prop = (p as any)?.property;
  if (!prop) return "—";
  if (prop.displayName) return prop.displayName;
  return [prop.street1, prop.city, prop.state].filter(Boolean).join(", ") || "—";
}


function dollar(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function PendingApprovalsSection({ onReady }: {
  /**
   * Hands this section's refresh, busy flag and row count to whatever
   * frames it. The component renders CONTENT ONLY — Dashboard (or
   * TasksPage's card) supplies the title bar, stripe, refresh and dim.
   */
  onReady?: (api: { refresh: () => void; loading: boolean; count: number }) => void;
} = {}) {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Every mutating action (Approve / Reject / Adjust / Write-off) goes
  // through ConfirmDialog — accidental thumb taps on mobile must not
  // mutate live data. See memory/feedback_confirm_dialogs.md.
  const [approvingRow, setApprovingRow] = useState<PendingRow | null>(null);
  const [rejectingRow, setRejectingRow] = useState<PendingRow | null>(null);
  const [adjustingRow, setAdjustingRow] = useState<PendingRow | null>(null);
  const [writingOffRow, setWritingOffRow] = useState<PendingRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<PendingRow[]>("/api/admin/payments/pending");
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to load pending approvals.", err) });
    } finally {
      setLoading(false);
    }
  }, []);

  // Report state to the frame (Dashboard at the tab host, the card in
  // TasksPage). Kept in an effect rather than called during render so a
  // parent setState never fires mid-render.
  useEffect(() => {
    onReady?.({ refresh: () => void load(), loading, count: rows.length });
  }, [onReady, load, loading, rows]);

  useEffect(() => {
    void load();
  }, [load]);

  // Approves the self-reported payment exactly as the client reported it
  // (or at a corrected amount, when overrideAmount is provided via the
  // Adjust & Approve path). If the amount is fraudulent/totally wrong,
  // admin Rejects with a reason and the worker re-records via Accept
  // Payment. If the client refuses to pay, admin Writes off instead.
  async function approve(
    row: PendingRow,
    overrideAmount?: number,
    feeOverride?: number,
    overrideMethod?: string,
    /** Optional note override from the AdjustPaymentDialog. `null` means
     *  "clear the existing note"; `undefined` means "leave the note
     *  untouched." Same tri-state semantic the backend uses. */
    overrideNote?: string | null,
    /** YYYY-MM-DD ET, the date the money actually landed. Only sent
     *  when the operator back-dated it from today. Anchors both
     *  Payment.createdAt and Payment.confirmedAt so cash-basis reports
     *  bucket the payment on the correct day. */
    paidAt?: string,
  ) {
    try {
      const body: {
        amountPaid?: number;
        processorFeeAmount?: number;
        method?: string;
        note?: string | null;
        paidAt?: string;
      } = {};
      if (overrideAmount !== undefined) body.amountPaid = overrideAmount;
      if (feeOverride !== undefined) body.processorFeeAmount = feeOverride;
      // Only send method when it actually changed from the originally-
      // reported value. The backend validates the method against the
      // PAYMENT_METHODS taxonomy and recomputes the processor-fee
      // snapshot on change — sending the unchanged method would still
      // pass but trips needless validation.
      if (overrideMethod && overrideMethod !== row.method) body.method = overrideMethod;
      if (overrideNote !== undefined) body.note = overrideNote;
      if (paidAt) body.paidAt = paidAt;
      // Server returns the next-occurrence outcome on the approval path
      // (a populated `nextOccurrence` when the cycle advanced, or
      // `nextOccurrenceSkipReason` when it didn't). composePaymentMessage
      // formats both branches identically across every payment toast in
      // the app — see lib/paymentMessages.ts.
      const result: PaymentActionResult = await apiPost(
        `/api/admin/payments/${row.id}/approve`,
        body,
      );
      // Skip-reasons other than `one_off` represent a misconfiguration
      // the operator should notice (no frequency, job paused, etc.) —
      // surface those as WARNING so the toast doesn't get dismissed
      // unread alongside other green confirmations.
      const skip = result?.nextOccurrenceSkipReason;
      const tone = skip && skip !== "one_off" ? "WARNING" : "SUCCESS";
      publishInlineMessage({
        type: tone,
        text: composePaymentMessage("approved", result),
      });
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      bumpAdminPayments();
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Approve failed.", err) });
    }
  }

  async function performReject(row: PendingRow, reason: string) {
    try {
      await apiPost(`/api/admin/payments/${row.id}/reject`, { reason });
      publishInlineMessage({ type: "SUCCESS", text: composePaymentMessage("rejected") });
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      bumpAdminPayments();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Reject failed.", err) });
    }
  }

  async function performWriteOff(row: PendingRow, reason: string) {
    try {
      // write-off runs the standard approval pipeline server-side with
      // amountPaid=0 (see services/payments.ts), so it returns the same
      // next-occurrence info as approvePayment. Use composePaymentMessage
      // to surface that consistently, with the write-off-specific
      // addendum about where the employee money came from.
      const result: PaymentActionResult = await apiPost(
        `/api/admin/payments/${row.id}/write-off`,
        { reason },
      );
      const skip = result?.nextOccurrenceSkipReason;
      const tone = skip && skip !== "one_off" ? "WARNING" : "SUCCESS";
      publishInlineMessage({
        type: tone,
        text: composePaymentMessage(
          "written off",
          result,
          "Employees were paid their promised amounts from business funds.",
        ),
      });
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      bumpAdminPayments();
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Write-off failed.", err) });
    }
  }

  function openJob(row: PendingRow) {
    // Navigate to the admin Services tab and highlight this occurrence.
    // jobsTabToServicesTabSearch expects entityId as "jobId:occurrenceId"
    // so the destination tab can auto-expand the job AND flash the row.
    // q is empty — we don't want a text filter, just a row highlight.
    const jobId = row.occurrence.job?.id ?? "";
    window.dispatchEvent(
      new CustomEvent("open:jobsTabToServicesTabSearch", {
        detail: {
          q: "",
          forAdmin: true,
          entityId: `${jobId}:${row.occurrence.id}`,
        },
      }),
    );
  }

  if (rows.length === 0 && !loading) return null;

  return (
    <Box>
      {/* Content only — Dashboard at the host supplies the frame,
          title bar, stripe, count badge, refresh and dim. */}
        {rows.length === 0 && (
          <Text fontSize="sm" color="fg.muted">No pending payments to approve.</Text>
        )}
        <VStack align="stretch" gap={2}>
          {rows.map((r) => {
            const propName = propertyLabel(r.occurrence.job as any);
            const clientName = r.occurrence.job?.property?.client?.displayName ?? null;
            const reporter = r.collectedBy?.displayName ?? r.collectedBy?.email ?? null;
            const reporterLabel = reporter ? `worker (${reporter})` : "client";
            const expected = (r.occurrence.price ?? 0) + (r.occurrence.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
            const amountDiffers = Math.abs(r.amountPaid - expected) > 0.01;
            return (
              <Box
                key={r.id}
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="md"
                p={2}
              >
                <VStack align="stretch" gap={1.5}>
                  <VStack align="start" gap={0.5}>
                    <HStack gap={1.5} wrap="wrap" align="center">
                      {/* Solid, not subtle. The subtle variant renders
                          orange.100 on a card that is already orange —
                          the method was legible only if you went looking
                          for it, and it is the first thing you check when
                          reconciling a payment. */}
                      <Badge
                        size="sm"
                        colorPalette="orange"
                        variant="solid"
                        bg="orange.500"
                        color="white"
                        px="1.5"
                      >
                        {r.method}
                      </Badge>
                      <Text fontSize="sm" fontWeight="semibold">{dollar(r.amountPaid)}</Text>
                      {amountDiffers && (
                        <Badge size="xs" colorPalette="yellow" variant="subtle" px="1.5">
                          Expected {dollar(expected)}
                        </Badge>
                      )}
                    </HStack>
                    <Text fontSize="xs" color="fg.muted" lineClamp={2}>
                      {propName}{clientName ? ` — ${clientName}` : ""}
                    </Text>
                    {r.occurrence.job?.property?.client?.contacts && r.occurrence.job.property.client.contacts.length > 0 && (
                      <PaymentContactsLine contacts={r.occurrence.job.property.client.contacts} />
                    )}
                    <PaymentPropertyLine property={r.occurrence.job?.property ?? null} />
                    <Text fontSize="xs" color="fg.subtle">
                      Reported by {reporterLabel} · {fmtDate(r.createdAt)}
                      {r.note ? ` · "${r.note}"` : ""}
                    </Text>
                  </VStack>
                  <HStack gap={1} justify="flex-start" wrap="wrap">
                    <Button
                      size="xs"
                      colorPalette="green"
                      onClick={() => setApprovingRow(r)}
                      disabled={r.amountPaid <= 0}
                      title={
                        r.amountPaid <= 0
                          ? "Reported amount is $0 — use Write off instead."
                          : "Approve as reported"
                      }
                    >
                      <Check size={12} /> Approve
                    </Button>
                    <Button
                      size="xs"
                      colorPalette="orange"
                      onClick={() => setAdjustingRow(r)}
                      title="Adjust the amount and/or method, then approve (use when the client paid a different amount or via a different method than reported)"
                    >
                      <Pencil size={12} /> Edit
                    </Button>
                    <Button size="xs" colorPalette="red" onClick={() => setRejectingRow(r)} title="Reject (the worker will need to re-record)">
                      <Slash size={12} /> Reject
                    </Button>
                    {/* Dark grey, matching the Write off in AWAITING
                        PAYMENT — one action, one colour, wherever it
                        appears. It is neither Approve (green: we got
                        paid) nor Reject (red: undo it); a write-off
                        acknowledges the loss and keeps it on the books.

                        Not orange: that is Edit, sitting two buttons
                        away. */}
                    <Button
                      size="xs"
                      colorPalette="gray"
                      bg="gray.600"
                      _hover={{ bg: "gray.700" }}
                      _active={{ bg: "gray.800" }}
                      onClick={() => setWritingOffRow(r)}
                      title="Write off (client never paid — employees are still paid their promised amount from business funds)"
                    >
                      <XCircle size={12} /> Write off
                    </Button>
                    {/* Labelled, not icon-only. Every other button in this
                        row says what it does; a bare arrow-out glyph made
                        the one navigational action the hardest to
                        identify. Hover is a darker shade of the card
                        rather than the default grey, which read as a
                        different component sitting on top of the row. */}
                    <Button
                      size="xs"
                      variant="ghost"
                      colorPalette="orange"
                      color="orange.800"
                      _hover={{ bg: "orange.200" }}
                      onClick={() => openJob(r)}
                      title="Open the job"
                    >
                      <ExternalLink size={12} /> Open job
                    </Button>
                  </HStack>
                </VStack>
              </Box>
            );
          })}
        </VStack>
      <ApprovePaymentDialog
        row={approvingRow}
        willScheduleNext={approvingRow ? willScheduleNext(approvingRow) : false}
        onConfirm={(feeOverride?: number, paidAt?: string) => {
          const r = approvingRow;
          setApprovingRow(null);
          if (r) void approve(r, undefined, feeOverride, undefined, undefined, paidAt);
        }}
        onCancel={() => setApprovingRow(null)}
      />

      <ConfirmDialog
        open={!!rejectingRow}
        title="Reject this payment?"
        message={
          rejectingRow
            ? `The client will need to re-pay ${dollar(rejectingRow.amountPaid)}. This can't be undone.`
            : ""
        }
        confirmLabel="Reject"
        confirmColorPalette="red"
        inputLabel="Reason"
        inputPlaceholder="e.g. Zelle never arrived, check bounced, wrong amount…"
        inputOptional
        onConfirm={async (reason: string) => {
          const r = rejectingRow;
          setRejectingRow(null);
          if (r) await performReject(r, reason.trim());
        }}
        onCancel={() => setRejectingRow(null)}
      />

      <AdjustPaymentDialog
        row={adjustingRow}
        onConfirm={({ amountOverride, methodOverride, feeOverride, noteOverride, paidAtOverride }) => {
          const r = adjustingRow;
          setAdjustingRow(null);
          if (!r) return;
          void approve(r, amountOverride, feeOverride, methodOverride, noteOverride, paidAtOverride);
        }}
        onCancel={() => setAdjustingRow(null)}
      />

      <ConfirmDialog
        open={!!writingOffRow}
        title="Write off this payment?"
        message={
          writingOffRow
            ? `Marks this job closed with $0 collected from the client.`
            : ""
        }
        warning="Use this when the client refuses to pay or the payment will never be collected (bounced check, ghosted, etc.). Employees and trainees will still be paid their promised amount out of business funds. Contractors receive $0. This can't be undone."
        confirmLabel="Write off"
        confirmColorPalette="red"
        inputLabel="Reason"
        inputPlaceholder="e.g. Client refused to pay, check bounced, account closed…"
        inputOptional
        onConfirm={async (reason: string) => {
          const r = writingOffRow;
          setWritingOffRow(null);
          if (r) await performWriteOff(r, reason.trim());
        }}
        onCancel={() => setWritingOffRow(null)}
      />
    </Box>
  );
}

