"use client";

import { useEffect, useRef, useState } from "react";
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
import { apiPost } from "@/src/lib/api";
import { PAYMENT_METHOD } from "@/src/lib/types";
import { prettyStatus } from "@/src/lib/lib";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";

type Assignee = {
  userId: string;
  displayName?: string | null;
  workerType?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: string;
  defaultAmount?: number | null;
  totalExpenses?: number;
  commissionPercent?: number;
  marginPercent?: number;
  assignees: Assignee[];
  onAccepted: (result?: any) => void;
};

const methodItems = PAYMENT_METHOD.map((m) => ({ label: prettyStatus(m), value: m }));
const methodCollection = createListCollection({ items: methodItems });

export default function AcceptPaymentDialog({
  open,
  onOpenChange,
  endpoint,
  defaultAmount,
  totalExpenses = 0,
  commissionPercent = 0,
  marginPercent = 0,
  assignees,
  onAccepted,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);

  const [amountPaid, setAmountPaid] = useState("");
  const [method, setMethod] = useState<string[]>(["CASH"]);
  const [note, setNote] = useState("");
  const [splits, setSplits] = useState<Record<string, string>>({});

  // Seed form when dialog opens
  useEffect(() => {
    if (!open) return;
    const amt = defaultAmount != null ? defaultAmount.toFixed(2) : "";
    setAmountPaid(amt);
    setMethod(["CASH"]);
    setNote("");


    // Even split (after expenses + commission/margin)
    if (assignees.length > 0 && defaultAmount != null && defaultAmount > 0) {
      const payout = calcPayout(defaultAmount);
      const even = (payout / assignees.length).toFixed(2);
      const map: Record<string, string> = {};
      assignees.forEach((a) => { map[a.userId] = even; });
      setSplits(map);
    } else {
      const map: Record<string, string> = {};
      assignees.forEach((a) => { map[a.userId] = ""; });
      setSplits(map);
    }
  }, [open, defaultAmount, assignees]);

  function calcPayout(amt: number): number {
    const net = Math.max(0, amt - totalExpenses);
    const hasContractors = assignees.some((a) => a.workerType !== "EMPLOYEE" && a.workerType !== "TRAINEE");
    const hasEmployees = assignees.some((a) => a.workerType === "EMPLOYEE" || a.workerType === "TRAINEE");
    const commission = hasContractors && commissionPercent > 0 ? Math.round(net * commissionPercent) / 100 : 0;
    const margin = hasEmployees && marginPercent > 0 ? Math.round(net * marginPercent) / 100 : 0;
    return Math.max(0, amt - totalExpenses - commission - margin);
  }

  function evenSplit() {
    const total = parseFloat(amountPaid);
    if (isNaN(total) || total <= 0 || assignees.length === 0) return;
    const payout = calcPayout(total);
    const even = (payout / assignees.length).toFixed(2);
    const map: Record<string, string> = {};
    assignees.forEach((a) => { map[a.userId] = even; });
    setSplits(map);
  }

  async function handleSubmit() {
    const amt = parseFloat(amountPaid);
    if (isNaN(amt) || amt <= 0) {
      publishInlineMessage({ type: "WARNING", text: "Please enter a valid amount." });
      return;
    }
    if (!method[0]) {
      publishInlineMessage({ type: "WARNING", text: "Please select a payment method." });
      return;
    }

    const splitArr = assignees.map((a) => ({
      userId: a.userId,
      amount: parseFloat(splits[a.userId] || "0"),
    }));

    // Check splits sum matches total payout
    const sum = splitArr.reduce((s, sp) => s + sp.amount, 0);
    const expectedPayout = calcPayout(amt);
    if (Math.round(sum * 100) !== Math.round(expectedPayout * 100)) {
      publishInlineMessage({ type: "WARNING", text: `Split total ($${sum.toFixed(2)}) must equal the total payout ($${expectedPayout.toFixed(2)}).` });
      return;
    }

    setBusy(true);
    try {
      const result = await apiPost<any>(endpoint, {
        amountPaid: amt,
        method: method[0],
        note: note.trim() || null,
        splits: splitArr,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Payment accepted." });
      onOpenChange(false);
      onAccepted(result);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Accept payment failed.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
      initialFocusEl={() => cancelRef.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Accept Payment</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <Text mb="1">Amount Paid *</Text>
                  <CurrencyInput
                    value={amountPaid}
                    onChange={(v) => setAmountPaid(v)}
                    size="sm"
                  />
                </div>

                <div>
                  <Text mb="1">Payment Method *</Text>
                  <Select.Root
                    collection={methodCollection}
                    value={method}
                    onValueChange={(e) => setMethod(e.value)}
                    size="sm"
                    positioning={{ strategy: "fixed", hideWhenDetached: true }}
                  >
                    <Select.Control>
                      <Select.Trigger>
                        <Select.ValueText placeholder="Select method" />
                      </Select.Trigger>
                    </Select.Control>
                    <Select.Positioner>
                      <Select.Content>
                        {methodItems.map((it) => (
                          <Select.Item key={it.value} item={it.value}>
                            <Select.ItemText>{it.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Positioner>
                  </Select.Root>
                </div>

                <div>
                  <Text mb="1">Note</Text>
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. check #1234"
                    size="sm"
                  />
                </div>

                {assignees.length > 1 && (
                  <div>
                    <HStack justify="space-between" mb="1">
                      <Text>Per-Person Split</Text>
                      <Button size="xs" variant="ghost" onClick={evenSplit}>
                        Even Split
                      </Button>
                    </HStack>
                    <VStack align="stretch" gap={2}>
                      {assignees.map((a) => (
                        <HStack key={a.userId} gap={2}>
                          <Text fontSize="sm" flex="1" minW={0} truncate>
                            {a.displayName || a.userId}
                          </Text>
                          <CurrencyInput
                            value={splits[a.userId] || ""}
                            onChange={(v) => {
                              setSplits((prev) => ({ ...prev, [a.userId]: v }));
                          
                            }}
                            size="sm"
                          />
                        </HStack>
                      ))}
                    </VStack>
                  </div>
                )}
                {/* Payout summary */}
                {(() => {
                  const amt = parseFloat(amountPaid);
                  if (isNaN(amt) || amt <= 0) return null;
                  const net = amt - totalExpenses;

                  // Commission/margin applies to net (after expenses)
                  const hasContractors = assignees.some((a) => a.workerType !== "EMPLOYEE" && a.workerType !== "TRAINEE");
                  const hasEmployees = assignees.some((a) => a.workerType === "EMPLOYEE" || a.workerType === "TRAINEE");

                  const commission = hasContractors && commissionPercent > 0 ? Math.round(net * commissionPercent) / 100 : 0;
                  const margin = hasEmployees && marginPercent > 0 ? Math.round(net * marginPercent) / 100 : 0;
                  const totalDeductions = totalExpenses + commission + margin;
                  const totalPayout = amt - totalDeductions;

                  return (
                    <Box p={3} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="md">
                      <Text fontSize="xs" fontWeight="semibold" color="blue.800" mb={1}>Estimated Payout Summary</Text>
                      <VStack align="stretch" gap={0} fontSize="xs" color="blue.700">
                        <HStack justify="space-between"><Text>Payment amount</Text><Text>${amt.toFixed(2)}</Text></HStack>
                        {totalExpenses > 0 && <HStack justify="space-between"><Text color="orange.600">− Expenses</Text><Text color="orange.600">${totalExpenses.toFixed(2)}</Text></HStack>}
                        {commission > 0 && <HStack justify="space-between"><Text color="orange.600">− Commission ({commissionPercent}%)</Text><Text color="orange.600">${commission.toFixed(2)}</Text></HStack>}
                        {margin > 0 && <HStack justify="space-between"><Text color="orange.600">− Business margin ({marginPercent}%)</Text><Text color="orange.600">${margin.toFixed(2)}</Text></HStack>}
                        <Box borderTopWidth="1px" borderColor="blue.200" mt={1} pt={1}>
                          <HStack justify="space-between" fontWeight="bold">
                            <Text>Total payout</Text>
                            <Text color="green.700">${totalPayout.toFixed(2)}</Text>
                          </HStack>
                          {assignees.length > 1 && (
                            <Text color="fg.muted" mt={0.5}>~${(totalPayout / assignees.length).toFixed(2)}/person</Text>
                          )}
                        </Box>
                      </VStack>
                    </Box>
                  );
                })()}
              </VStack>
            </Dialog.Body>

            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button
                  variant="ghost"
                  ref={cancelRef}
                  onClick={() => onOpenChange(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  colorPalette="blue"
                  onClick={handleSubmit}
                  loading={busy}
                  disabled={!amountPaid || !method[0] || (() => {
                    const amt = parseFloat(amountPaid);
                    if (isNaN(amt) || amt <= 0) return true;
                    const sum = assignees.reduce((s, a) => s + parseFloat(splits[a.userId] || "0"), 0);
                    return Math.round(sum * 100) !== Math.round(calcPayout(amt) * 100);
                  })()}
                >
                  Accept Payment
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
