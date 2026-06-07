"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
import { usePaymentMethodLabels } from "@/src/lib/usePaymentMethodLabels";

/**
 * Adjust-and-approve dialog. Used by the Edit button on a pending-approval
 * card when the client-reported amount or method is wrong. Lets the admin
 * correct ALL THREE fields that affect the final accounting:
 *
 *   1. Amount — what actually arrived in your account
 *   2. Method — what the client actually paid through (e.g. they reported
 *      OTHER but actually used Venmo)
 *   3. Fee    — the processor fee. The estimate auto-recomputes whenever
 *      amount or method changes (formula = grossCharged × feePercent + feeFixed);
 *      the admin can override to match the exact figure that hit the
 *      processor statement.
 *
 * Companion to ApprovePaymentDialog, which only handles the fee tweak path
 * (used when the report was correct but the estimated fee was a penny off).
 * This dialog is the strict superset — every field is editable here.
 */

type AdjustRow = {
  id: string;
  amountPaid: number;
  method: string;
  processorFeeAmount: number | null;
};

type Props = {
  row: AdjustRow | null;
  /** Called on Approve with the final values. Each field is only included
   *  when it differs from the row's current value, mirroring how the
   *  backend `/admin/payments/:id/approve` overrides work — only changes
   *  are sent. */
  onConfirm: (changes: {
    amountOverride?: number;
    methodOverride?: string;
    feeOverride?: number;
  }) => void;
  onCancel: () => void;
};

const PENNY = 0.005;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function AdjustPaymentDialog({ row, onConfirm, onCancel }: Props) {
  const open = !!row;
  const { methods } = usePaymentMethodLabels();

  const [amountStr, setAmountStr] = useState("");
  const [methodKey, setMethodKey] = useState("");
  const [feeStr, setFeeStr] = useState("");
  /** True once the admin manually edits the fee — pins the value so a
   *  later amount/method change doesn't blow away their override. Reset
   *  on dialog open. */
  const [feeManuallyEdited, setFeeManuallyEdited] = useState(false);

  // Seed state from the row on open. Method picker defaults to the
  // originally-reported method; amount + fee come from the same row.
  useEffect(() => {
    if (!row) return;
    setAmountStr(row.amountPaid.toFixed(2));
    setMethodKey(row.method);
    setFeeStr((row.processorFeeAmount ?? 0).toFixed(2));
    setFeeManuallyEdited(false);
  }, [row]);

  const amountNum = Number.parseFloat(amountStr);
  const amountValid = Number.isFinite(amountNum) && amountNum >= 0;

  // The selected method's fee config drives both the computed-fee preview
  // and the "show fee section?" decision. A method with no fee (Cash,
  // Zelle) hides the fee box entirely.
  const selectedMethod = useMemo(
    () => methods.find((m) => m.key === methodKey) ?? null,
    [methods, methodKey],
  );
  const hasFee = !!selectedMethod && (selectedMethod.feePercent > 0 || selectedMethod.feeFixed > 0);

  // Recomputed fee estimate. Matches the backend formula in
  // services/payments.ts > computeProcessorFee:
  //   processorFee = round(gross × feePercent / 100 + feeFixed, 2)
  const computedFee = useMemo(() => {
    if (!hasFee || !selectedMethod || !amountValid) return 0;
    return round2(amountNum * selectedMethod.feePercent / 100 + selectedMethod.feeFixed);
  }, [hasFee, selectedMethod, amountValid, amountNum]);

  // When amount or method changes (and the admin hasn't manually edited
  // the fee yet), snap fee back to the recomputed estimate. Once they
  // override, leave it alone — they may be matching an actual processor
  // statement value that won't naturally line up with the formula.
  useEffect(() => {
    if (!hasFee) {
      setFeeStr("0.00");
      return;
    }
    if (!feeManuallyEdited) {
      setFeeStr(computedFee.toFixed(2));
    }
  }, [computedFee, hasFee, feeManuallyEdited]);

  const feeNum = Number.parseFloat(feeStr);
  const feeValid = !hasFee || (Number.isFinite(feeNum) && feeNum >= 0 && (!amountValid || feeNum <= amountNum));
  const net = amountValid && feeValid ? round2(amountNum - (hasFee ? feeNum : 0)) : null;

  // The Select collection is stable across renders so Chakra's internal
  // state doesn't get reset when this component re-renders (which it does
  // on every keystroke via amountStr).
  const methodCollection = useMemo(
    () =>
      createListCollection({
        items: methods
          .filter((m) => m.active || m.key === row?.method)
          .map((m) => ({ label: m.label, value: m.key })),
      }),
    [methods, row?.method],
  );

  const canConfirm = amountValid && !!methodKey && feeValid;

  function confirm() {
    if (!row || !canConfirm) return;
    const changes: { amountOverride?: number; methodOverride?: string; feeOverride?: number } = {};
    const finalAmount = round2(amountNum);
    if (finalAmount !== round2(row.amountPaid)) changes.amountOverride = finalAmount;
    if (methodKey !== row.method) changes.methodOverride = methodKey;
    // Fee override only when the user's value differs from the auto-
    // computed estimate by more than half a cent. Matches the
    // ApprovePaymentDialog policy so back-end semantics line up.
    if (hasFee && Math.abs(feeNum - computedFee) >= PENNY) {
      changes.feeOverride = round2(feeNum);
    }
    onConfirm(changes);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onCancel(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>Adjust, then approve</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm" color="fg.muted">
                  Originally reported:{" "}
                  <Text as="span" fontWeight="medium" color="fg.default">
                    ${row?.amountPaid.toFixed(2) ?? "0.00"} via {row?.method ?? "—"}
                  </Text>
                  . Correct any field below — fee recomputes automatically when
                  amount or method changes.
                </Text>

                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Actual amount collected
                  </Text>
                  <CurrencyInput
                    value={amountStr}
                    onChange={setAmountStr}
                    size="sm"
                    placeholder="0.00"
                  />
                </Box>

                <Box>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    Payment method
                  </Text>
                  <Select.Root
                    collection={methodCollection}
                    value={methodKey ? [methodKey] : []}
                    onValueChange={(e) => {
                      setMethodKey(e.value[0] ?? "");
                      setFeeManuallyEdited(false); // method change → snap fee to new estimate
                    }}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Choose…" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {methodCollection.items.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </Box>

                {hasFee && (
                  <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={3}>
                    <VStack align="stretch" gap={2}>
                      <HStack justify="space-between">
                        <Text fontSize="sm" color="fg.muted">Gross charged</Text>
                        <Text fontSize="sm" fontWeight="medium">
                          ${amountValid ? amountNum.toFixed(2) : "—"}
                        </Text>
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
                          max={amountValid ? amountNum : undefined}
                          value={feeStr}
                          onChange={(e) => {
                            setFeeStr(e.target.value);
                            setFeeManuallyEdited(true);
                          }}
                          borderColor={feeValid ? undefined : "red.400"}
                        />
                      </HStack>
                      <Box borderTopWidth="1px" borderColor="gray.200" pt={2}>
                        <HStack justify="space-between">
                          <Text fontSize="sm" fontWeight="semibold">Net received</Text>
                          <Text
                            fontSize="md"
                            fontWeight="bold"
                            color={feeValid ? "green.600" : "red.500"}
                          >
                            {net != null ? `$${net.toFixed(2)}` : "—"}
                          </Text>
                        </HStack>
                      </Box>
                      <Text fontSize="xs" color="fg.muted">
                        Auto-recomputed as{" "}
                        <Text as="span" fontWeight="medium">
                          ${computedFee.toFixed(2)}
                        </Text>{" "}
                        for {selectedMethod?.label ?? "this method"}
                        ({selectedMethod?.feePercent}% + ${selectedMethod?.feeFixed.toFixed(2)}).
                        Override above to match the exact figure on the processor
                        statement — the business absorbs the fee, so worker
                        payouts are unaffected either way.
                      </Text>
                    </VStack>
                  </Box>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={onCancel}>Cancel</Button>
              <Button colorPalette="orange" disabled={!canConfirm} onClick={confirm}>
                Approve
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
