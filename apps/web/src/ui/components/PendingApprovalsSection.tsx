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
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { bumpAdminPayments } from "@/src/lib/bus";

type PendingRow = {
  id: string;
  amountPaid: number;
  method: string;
  note: string | null;
  selfReported: boolean;
  createdAt: string;
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
        client: { displayName: string | null } | null;
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

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "";
  }
}

function dollar(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default function PendingApprovalsSection() {
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

  useEffect(() => {
    void load();
  }, [load]);

  // Approves the self-reported payment exactly as the client reported it
  // (or at a corrected amount, when overrideAmount is provided via the
  // Adjust & Approve path). If the amount is fraudulent/totally wrong,
  // admin Rejects with a reason and the worker re-records via Accept
  // Payment. If the client refuses to pay, admin Writes off instead.
  async function approve(row: PendingRow, overrideAmount?: number) {
    try {
      const body: { amountPaid?: number } = {};
      if (overrideAmount !== undefined) body.amountPaid = overrideAmount;
      const result = await apiPost<{ nextOccurrence?: { startAt?: string | null } | null; nextOccurrenceSkipReason?: string | null }>(
        `/api/admin/payments/${row.id}/approve`,
        body,
      );
      if (result?.nextOccurrence?.startAt) {
        const when = fmtDate(result.nextOccurrence.startAt);
        publishInlineMessage({
          type: "SUCCESS",
          text: `Payment approved. Next occurrence scheduled for ${when}.`,
        });
      } else if (result?.nextOccurrenceSkipReason && result.nextOccurrenceSkipReason !== "one_off") {
        const reasons: Record<string, string> = {
          no_frequency_set: "No repeat frequency is set on the job or occurrence.",
          job_paused: "The job service is paused.",
          duplicate_exists: "A scheduled occurrence already exists on the next date.",
          occurrence_or_job_not_found: "Could not find the job service.",
        };
        const msg = reasons[result.nextOccurrenceSkipReason] ?? result.nextOccurrenceSkipReason;
        publishInlineMessage({
          type: "WARNING",
          text: `Payment approved. Next occurrence was NOT auto-created: ${msg}`,
        });
      } else {
        publishInlineMessage({ type: "SUCCESS", text: "Payment approved." });
      }
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
      publishInlineMessage({ type: "SUCCESS", text: "Payment rejected." });
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      bumpAdminPayments();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Reject failed.", err) });
    }
  }

  async function performWriteOff(row: PendingRow, reason: string) {
    try {
      await apiPost(`/api/admin/payments/${row.id}/write-off`, { reason });
      publishInlineMessage({
        type: "SUCCESS",
        text: "Payment written off. Employees were paid their promised amounts from business funds.",
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
    <Card.Root variant="outline" borderColor="orange.300" borderLeftWidth="4px" borderLeftColor="orange.500" mb={3} position="relative">
      {/* Refresh overlay — dims the section + shows a viewport-centered
          spinner, matching the JobsTab refresh pattern. Only kicks in
          while we have existing rows; the empty/initial state already
          falls through the `if (rows.length === 0 && !loading)` guard
          above so there's nothing to dim. */}
      {loading && rows.length > 0 && (
        <>
          <Box position="absolute" inset="0" bg="bg/80" zIndex="1" borderRadius="md" />
          <Spinner size="lg" position="fixed" top="50%" left="50%" zIndex="2" />
        </>
      )}
      <Card.Body p={3}>
        <HStack mb={2} justify="space-between">
          <HStack gap={2}>
            <Text fontSize="sm" fontWeight="semibold">Pending approval</Text>
            <Badge size="sm" colorPalette="orange" variant="solid" px="2" borderRadius="full">
              {rows.length}
            </Badge>
          </HStack>
          <Button size="xs" variant="ghost" onClick={() => void load()} loading={loading}>
            <RefreshCw size={12} />
          </Button>
        </HStack>
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
                      <Badge size="sm" colorPalette="orange" variant="subtle" px="1.5">{r.method}</Badge>
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
                      variant="outline"
                      colorPalette="orange"
                      onClick={() => setAdjustingRow(r)}
                      title="Adjust the amount, then approve (use when the client paid a different amount than reported)"
                    >
                      <Pencil size={12} />
                    </Button>
                    <Button size="xs" variant="outline" colorPalette="red" onClick={() => setRejectingRow(r)} title="Reject (the worker will need to re-record)">
                      <Slash size={12} />
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      colorPalette="red"
                      onClick={() => setWritingOffRow(r)}
                      title="Write off (client never paid — employees are still paid their promised amount from business funds)"
                    >
                      <XCircle size={12} />
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => openJob(r)} title="Open the job">
                      <ExternalLink size={12} />
                    </Button>
                  </HStack>
                </VStack>
              </Box>
            );
          })}
        </VStack>
      </Card.Body>
      <ConfirmDialog
        open={!!approvingRow}
        title="Approve this payment?"
        message={
          approvingRow
            ? `Approve ${dollar(approvingRow.amountPaid)} via ${approvingRow.method} as reported. The job will close and worker payouts will be recorded${willScheduleNext(approvingRow) ? ", and the next occurrence will be scheduled." : "."}`
            : ""
        }
        warning="If the actual amount in your account doesn't match what was reported, use Adjust instead. If the payment will never arrive, use Write off. Approve is for when the reported amount is correct."
        confirmLabel="Approve"
        confirmColorPalette="green"
        onConfirm={async () => {
          const r = approvingRow;
          setApprovingRow(null);
          if (r) await approve(r);
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

      <ConfirmDialog
        open={!!adjustingRow}
        title="Adjust amount, then approve"
        message={
          adjustingRow
            ? `Reported: ${dollar(adjustingRow.amountPaid)} via ${adjustingRow.method}. Enter the amount that actually arrived in your account.`
            : ""
        }
        warning="Use this when the amount that actually hit your account doesn't match the reported amount — e.g. the client self-reported $100 via Zelle but only $80 landed, or the worker mistyped the check amount, or the client added a tip on Venmo. Employees and trainees still receive their full promised payout. Contractors get a pro-rata share of what was actually collected (they take the hit on shortfalls). The business absorbs any remaining shortfall and keeps any overage."
        confirmLabel="Approve"
        confirmColorPalette="orange"
        amountLabel="Actual amount collected"
        amountDefaultValue={adjustingRow ? adjustingRow.amountPaid.toFixed(2) : ""}
        amountPlaceholder="0.00"
        onConfirm={async (_input, amountStr?: string) => {
          const r = adjustingRow;
          setAdjustingRow(null);
          if (!r) return;
          const parsed = Number.parseFloat((amountStr ?? "").trim());
          if (!Number.isFinite(parsed) || parsed < 0) {
            publishInlineMessage({ type: "ERROR", text: "Enter a valid amount." });
            return;
          }
          await approve(r, parsed);
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
    </Card.Root>
  );
}

