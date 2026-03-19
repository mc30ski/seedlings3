"use client";

import { useEffect, useRef, useState } from "react";
import {
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
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: string; // e.g. "/api/occurrences/:id/accept-payment" or "/api/admin/occurrences/:id/accept-payment"
  defaultAmount?: number | null;
  assignees: Assignee[];
  onAccepted: () => void;
};

const methodItems = PAYMENT_METHOD.map((m) => ({ label: prettyStatus(m), value: m }));
const methodCollection = createListCollection({ items: methodItems });

export default function AcceptPaymentDialog({
  open,
  onOpenChange,
  endpoint,
  defaultAmount,
  assignees,
  onAccepted,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMismatchConfirm, setShowMismatchConfirm] = useState(false);

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
    setShowMismatchConfirm(false);

    // Even split
    if (assignees.length > 0 && defaultAmount != null && defaultAmount > 0) {
      const even = (defaultAmount / assignees.length).toFixed(2);
      const map: Record<string, string> = {};
      assignees.forEach((a) => { map[a.userId] = even; });
      setSplits(map);
    } else {
      const map: Record<string, string> = {};
      assignees.forEach((a) => { map[a.userId] = ""; });
      setSplits(map);
    }
  }, [open, defaultAmount, assignees]);

  function evenSplit() {
    const total = parseFloat(amountPaid);
    if (isNaN(total) || total <= 0 || assignees.length === 0) return;
    const even = (total / assignees.length).toFixed(2);
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

    // Check splits sum — warn but allow proceeding
    const sum = splitArr.reduce((s, sp) => s + sp.amount, 0);
    if (Math.abs(sum - amt) > 0.01 && !showMismatchConfirm) {
      setShowMismatchConfirm(true);
      return;
    }

    setBusy(true);
    try {
      await apiPost(endpoint, {
        amountPaid: amt,
        method: method[0],
        note: note.trim() || null,
        splits: splitArr,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Payment accepted." });
      onOpenChange(false);
      onAccepted();
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
                    onChange={(v) => {
                      setAmountPaid(v);
                      setShowMismatchConfirm(false);
                      // Auto-recalculate even splits when amount changes
                      const total = parseFloat(v);
                      if (!isNaN(total) && total > 0 && assignees.length > 0) {
                        const even = (total / assignees.length).toFixed(2);
                        const map: Record<string, string> = {};
                        assignees.forEach((a) => { map[a.userId] = even; });
                        setSplits(map);
                      }
                    }}
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
                              setShowMismatchConfirm(false);
                            }}
                            size="sm"
                          />
                        </HStack>
                      ))}
                    </VStack>
                  </div>
                )}
              </VStack>
            </Dialog.Body>

            {showMismatchConfirm && (
              <VStack align="stretch" px="4" pb="2" gap={1}>
                <Text fontSize="sm" color="orange.600" fontWeight="medium">
                  The split total does not match the amount paid. Are you sure you want to proceed?
                </Text>
              </VStack>
            )}

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
                  colorPalette={showMismatchConfirm ? "orange" : "green"}
                  onClick={handleSubmit}
                  loading={busy}
                  disabled={!amountPaid || !method[0]}
                >
                  {showMismatchConfirm ? "Yes, Accept Payment" : "Accept Payment"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
