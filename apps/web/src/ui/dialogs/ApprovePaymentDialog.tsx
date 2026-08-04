"use client";

import { useEffect, useState } from "react";
import { Box, Button, Dialog, HStack, Input, Portal, Text, VStack } from "@chakra-ui/react";
import DateInput from "@/src/ui/components/DateInput";
import { bizToday, type EtDateKey } from "@/src/lib/lib";

type ApproveRow = {
  id: string;
  amountPaid: number;
  method: string;
  processorFeeAmount: number | null;
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
  onConfirm: (feeOverride?: number, paidAt?: EtDateKey) => void;
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

  const feeNum = Number.parseFloat(feeStr);
  const feeValid = Number.isFinite(feeNum) && feeNum >= 0 && feeNum <= gross;
  const net = feeValid ? Math.round((gross - feeNum) * 100) / 100 : null;

  function confirm() {
    if (!row) return;
    // Only forward paidAt when the operator back-dated from today.
    // Sending today's value would still work but it's cleaner for the
    // server to fall through to its `new Date()` default.
    const paidAtOverride: EtDateKey | undefined = paidAt !== bizToday() ? paidAt : undefined;
    if (hasFee) {
      if (!feeValid) return;
      // Only flag an override when it differs from the computed estimate.
      const feeOverride = Math.abs(feeNum - estimateFee) >= 0.005 ? feeNum : undefined;
      onConfirm(feeOverride, paidAtOverride);
    } else {
      onConfirm(undefined, paidAtOverride);
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
              <Button colorPalette="green" disabled={hasFee && !feeValid} onClick={confirm}>
                Approve
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
