"use client";

import { useEffect, useState } from "react";
import { Box, Button, Dialog, HStack, Input, Portal, Text, VStack } from "@chakra-ui/react";
import DateInput from "@/src/ui/components/DateInput";
import { bizToday, type EtDateKey } from "@/src/lib/dates";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type ApproveRow = {
  id: string;
  amountPaid: number;
  method: string;
  processorFeeAmount: number | null;
  /** Invoice total (price + add-ons) — anything paid above this is an
   *  overpayment, which is the only thing that can be designated a tip. */
  invoiceTotal: number;
  /** Non-observer assignees, for the tip split editor. */
  assignees: Array<{
    userId: string;
    displayName: string;
    isOwner: boolean;
  }>;
  /** Per-worker job percentages, if the claimer set them. Seeds the tip
   *  defaults so a trainee credited 20% of the job defaults to 20% of
   *  the tip. */
  completionSplits: Array<{ userId: string; percent: number }> | null;
};

export type TipPayload = {
  amount: number;
  businessPercent: number;
  workerPercents: Array<{ userId: string; percent: number }>;
};

type Props = {
  /** The payment being approved, or null when the dialog is closed. */
  row: ApproveRow | null;
  /** Whether approving will auto-schedule the next occurrence (for the message). */
  willScheduleNext: boolean;
  /** Fires on confirm.
   *   • feeOverride — set only when the admin changed the fee
   *   • paidAt — YYYY-MM-DD ET, set only when the admin back-dated
   *     the "payment received on" field. Absent = today's default
   *     (backend falls through to now()). */
  onConfirm: (feeOverride?: number, paidAt?: EtDateKey, tip?: TipPayload | null) => void;
  onCancel: () => void;
};

/**
 * Approve-payment dialog. For fee-bearing methods (e.g. Venmo) it shows the
 * full reconciliation math — Gross − Processor fee = Net received — with the
 * fee editable and Net recomputed live, so the approver can tune the fee until
 * Net matches what actually landed in the processor account.
 */
export default function ApprovePaymentDialog({ row, willScheduleNext, onConfirm, onCancel }: Props) {
  const open = !!row;
  const gross = row?.amountPaid ?? 0;
  const estimateFee = row?.processorFeeAmount ?? 0;
  const hasFee = estimateFee > 0;

  const [feeStr, setFeeStr] = useState("");
  // "Payment received on" — defaults to today so the common case stays
  // one click. Operator can back-date when reconciling a payment that
  // landed days ago; the backend anchors the picked date to ET-noon.
  const [paidAt, setPaidAt] = useState<EtDateKey>(bizToday());
  useEffect(() => {
    if (row) {
      setFeeStr((row.processorFeeAmount ?? 0).toFixed(2));
      setPaidAt(bizToday());
    }
  }, [row]);

  // ── Tip designation ────────────────────────────────────────────────
  // A tip is a DESIGNATED overpayment: it only exists when the client
  // paid more than the invoice, and it's carved out of that difference.
  const overpayment = row ? round2(row.amountPaid - row.invoiceTotal) : 0;
  const canTip = overpayment > 0;
  const [isTip, setIsTip] = useState(false);
  // Percent strings so the operator can type freely; validated on submit.
  const [bizPct, setBizPct] = useState("0");
  const [workerPct, setWorkerPct] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!row) return;
    // Default OFF — an overpayment is more often a typo than a tip, so the
    // operator opts in rather than out.
    setIsTip(false);
    setBizPct("0");
    const cs = new Map((row.completionSplits ?? []).map((c) => [c.userId, c.percent]));
    const n = row.assignees.length;
    const next: Record<string, string> = {};
    for (const a of row.assignees) {
      // completionSplits when the claimer set them, else an even split.
      const pct = cs.get(a.userId) ?? (n > 0 ? 100 / n : 0);
      next[a.userId] = String(Math.round(pct * 100) / 100);
    }
    setWorkerPct(next);
  }, [row]);

  const tipPctSum = round2(
    (Number.parseFloat(bizPct) || 0) +
      (row?.assignees ?? []).reduce((s, a) => s + (Number.parseFloat(workerPct[a.userId]) || 0), 0),
  );
  const tipPctValid = Math.abs(tipPctSum - 100) <= 0.01;
  // The business's REAL cut: its own percentage plus any owner share,
  // because owner earnings are business money wearing a worker's name.
  // Without this, a 0% business row reads as "the business takes nothing"
  // when the owner is on the job.
  const ownerPct = (row?.assignees ?? [])
    .filter((a) => a.isOwner)
    .reduce((s, a) => s + (Number.parseFloat(workerPct[a.userId]) || 0), 0);
  const effectiveBizPct = round2((Number.parseFloat(bizPct) || 0) + ownerPct);
  const tipDollars = (pct: number) => round2((overpayment * pct) / 100);

  const feeNum = Number.parseFloat(feeStr);
  const feeValid = Number.isFinite(feeNum) && feeNum >= 0 && feeNum <= gross;
  const net = feeValid ? Math.round((gross - feeNum) * 100) / 100 : null;

  function confirm() {
    if (!row) return;
    // Only forward paidAt when the operator back-dated from today.
    // Sending today's value would still work but it's cleaner for the
    // server to fall through to its `new Date()` default.
    const paidAtOverride: EtDateKey | undefined = paidAt !== bizToday() ? paidAt : undefined;
    const tip: TipPayload | null =
      isTip && canTip && tipPctValid
        ? {
            amount: overpayment,
            businessPercent: Number.parseFloat(bizPct) || 0,
            workerPercents: row.assignees.map((a) => ({
              userId: a.userId,
              percent: Number.parseFloat(workerPct[a.userId]) || 0,
            })),
          }
        : null;
    if (hasFee) {
      if (!feeValid) return;
      // Only flag an override when it differs from the computed estimate.
      const feeOverride = Math.abs(feeNum - estimateFee) >= 0.005 ? feeNum : undefined;
      onConfirm(feeOverride, paidAtOverride, tip);
    } else {
      onConfirm(undefined, paidAtOverride, tip);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onCancel(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>Approve this payment?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm">
                  Approve {row ? `$${row.amountPaid.toFixed(2)} via ${row.method}` : ""} as reported. The
                  job will close{willScheduleNext ? " and the next occurrence will be scheduled" : ""}.
                </Text>

                {hasFee ? (
                  <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3}>
                    <VStack align="stretch" gap={2}>
                      <HStack justify="space-between">
                        <Text fontSize="sm" color="fg.muted">Gross charged</Text>
                        <Text fontSize="sm" fontWeight="medium">${gross.toFixed(2)}</Text>
                      </HStack>
                      <HStack justify="space-between" align="center">
                        <Text fontSize="sm" color="fg.muted">− Processor fee</Text>
                        <Input
                          size="sm"
                          w="100px"
                          textAlign="right"
                          type="number"
                          step="0.01"
                          min={0}
                          max={gross}
                          value={feeStr}
                          onChange={(e) => setFeeStr(e.target.value)}
                          borderColor={feeValid ? undefined : "red.400"}
                        />
                      </HStack>
                      <Box borderTopWidth="1px" borderColor="gray.200" pt={2}>
                        <HStack justify="space-between">
                          <Text fontSize="sm" fontWeight="semibold">Net received</Text>
                          <Text fontSize="md" fontWeight="bold" color={feeValid ? "green.600" : "red.500"}>
                            {net != null ? `$${net.toFixed(2)}` : "—"}
                          </Text>
                        </HStack>
                      </Box>
                      <Text fontSize="xs" color="fg.muted">
                        The fee is an estimate — adjust it until <Text as="span" fontWeight="medium">Net received</Text> matches
                        the amount that actually landed in your {row?.method} account. The business absorbs this fee; it never
                        changes worker payouts.
                      </Text>
                    </VStack>
                  </Box>
                ) : (
                  <Text fontSize="xs" color="fg.muted">
                    If the actual amount in your account doesn't match what was reported, use Adjust instead. If
                    the payment will never arrive, use Write off.
                  </Text>
                )}
                {/* Tip designation. Only offered when the client actually
                    overpaid — a tip is a designated overpayment, not a
                    standalone entry. Default OFF: an overpayment is more
                    often a data-entry error than a tip, so the operator
                    opts in. Left off, the money stays with the business
                    as overage exactly as it does today. */}
                {canTip && (
                  <Box borderWidth="1px" borderColor={isTip ? "green.300" : "gray.200"} bg={isTip ? "green.50" : undefined} borderRadius="md" p={3}>
                    <VStack align="stretch" gap={2}>
                      <HStack justify="space-between" align="center">
                        <VStack align="start" gap={0}>
                          <Text fontSize="sm" fontWeight="semibold">
                            Client overpaid by ${overpayment.toFixed(2)}
                          </Text>
                          <Text fontSize="xs" color="fg.muted">
                            Invoice ${row?.invoiceTotal.toFixed(2)} · paid ${row?.amountPaid.toFixed(2)}
                          </Text>
                        </VStack>
                        <Button
                          size="xs"
                          variant={isTip ? "solid" : "outline"}
                          colorPalette={isTip ? "green" : "gray"}
                          onClick={() => setIsTip((v) => !v)}
                        >
                          {isTip ? "It's a tip ✓" : "It's a tip"}
                        </Button>
                      </HStack>

                      {!isTip && (
                        <Text fontSize="xs" color="fg.muted">
                          Left as-is, the business keeps the ${overpayment.toFixed(2)} and it's
                          reported as income. Mark it a tip to share it with the crew.
                        </Text>
                      )}

                      {isTip && (
                        <VStack align="stretch" gap={2}>
                          <Text fontSize="xs" color="fg.muted">
                            Split the ${overpayment.toFixed(2)} tip. Defaults to each worker's
                            share of the job. Tips skip commission and margin.
                          </Text>
                          <HStack justify="space-between" align="center">
                            <Text fontSize="sm">Business</Text>
                            <HStack gap={2}>
                              <Input
                                size="xs" w="64px" textAlign="right" inputMode="decimal"
                                value={bizPct}
                                onChange={(e) => setBizPct(e.target.value)}
                              />
                              <Text fontSize="xs" color="fg.muted" w="14px">%</Text>
                              <Text fontSize="sm" fontWeight="medium" w="64px" textAlign="right">
                                ${tipDollars(Number.parseFloat(bizPct) || 0).toFixed(2)}
                              </Text>
                            </HStack>
                          </HStack>
                          {(row?.assignees ?? []).map((a) => (
                            <HStack key={a.userId} justify="space-between" align="center">
                              <Text fontSize="sm">
                                {a.displayName}
                                {a.isOwner && (
                                  <Text as="span" fontSize="2xs" color="purple.700" ml={1} fontWeight="semibold">
                                    LLC Owner
                                  </Text>
                                )}
                              </Text>
                              <HStack gap={2}>
                                <Input
                                  size="xs" w="64px" textAlign="right" inputMode="decimal"
                                  value={workerPct[a.userId] ?? "0"}
                                  onChange={(e) =>
                                    setWorkerPct((prev) => ({ ...prev, [a.userId]: e.target.value }))
                                  }
                                />
                                <Text fontSize="xs" color="fg.muted" w="14px">%</Text>
                                <Text fontSize="sm" fontWeight="medium" w="64px" textAlign="right">
                                  ${tipDollars(Number.parseFloat(workerPct[a.userId]) || 0).toFixed(2)}
                                </Text>
                              </HStack>
                            </HStack>
                          ))}
                          <HStack justify="space-between" pt={1} borderTopWidth="1px" borderColor="green.200">
                            <Text fontSize="xs" fontWeight="medium" color={tipPctValid ? "fg.muted" : "red.600"}>
                              Total {tipPctSum.toFixed(2)}%
                              {!tipPctValid && " — must be 100%"}
                            </Text>
                          </HStack>
                          {/* Owner earnings are business money even though the
                              owner renders as a worker row. Without saying so,
                              a 0% business row reads as "the business takes
                              nothing" when the owner is on the job. */}
                          {ownerPct > 0 && (
                            <Text fontSize="xs" color="purple.700">
                              Business keeps {effectiveBizPct.toFixed(2)}% —{" "}
                              {(Number.parseFloat(bizPct) || 0).toFixed(2)}% business share +{" "}
                              {ownerPct.toFixed(2)}% owner share (owner earnings are business money).
                            </Text>
                          )}
                        </VStack>
                      )}
                    </VStack>
                  </Box>
                )}

                {/* "Payment received on" — anchors the confirmed
                    payment's date so cash-basis reports bucket it on
                    the day the money actually landed, not the day
                    the operator opened the approval queue. */}
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>
                    Payment received on{" "}
                    {paidAt !== bizToday() && (
                      <Text as="span" fontSize="2xs" color="orange.700" fontWeight="normal">
                        — back-dated
                      </Text>
                    )}
                  </Text>
                  <DateInput
                    value={paidAt}
                    onChange={(v) => setPaidAt(v)}
                    max={bizToday()}
                  />
                  <Text fontSize="2xs" color="fg.muted" mt={1}>
                    Defaults to today.
                  </Text>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onCancel}>Cancel</Button>
              <Button
                colorPalette="green"
                // Block the approve while the tip percentages don't total
                // 100 — the money would otherwise land somewhere the
                // operator didn't intend.
                disabled={(hasFee && !feeValid) || (isTip && !tipPctValid)}
                onClick={confirm}
              >
                Approve
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
