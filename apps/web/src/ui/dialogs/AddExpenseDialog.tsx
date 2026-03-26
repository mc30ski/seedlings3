"use client";

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiPost } from "@/src/lib/api";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";
import CurrencyInput from "@/src/ui/components/CurrencyInput";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: string; // e.g. "/api/occurrences/:id/expenses"
  onAdded: () => void;
};

export default function AddExpenseDialog({
  open,
  onOpenChange,
  endpoint,
  onAdded,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [cost, setCost] = useState("");
  const [description, setDescription] = useState("");

  function reset() {
    setCost("");
    setDescription("");
  }

  // Reset fields whenever the dialog opens
  useEffect(() => {
    if (open) reset();
  }, [open]);

  async function handleSubmit() {
    const amt = parseFloat(cost);
    if (isNaN(amt) || amt <= 0) {
      publishInlineMessage({ type: "WARNING", text: "Please enter a valid cost." });
      return;
    }
    if (!description.trim()) {
      publishInlineMessage({ type: "WARNING", text: "Please enter a description." });
      return;
    }

    setBusy(true);
    try {
      await apiPost(endpoint, {
        cost: amt,
        description: description.trim(),
      });
      publishInlineMessage({ type: "SUCCESS", text: "Expense added." });
      reset();
      onOpenChange(false);
      onAdded();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to add expense.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) reset();
        onOpenChange(e.open);
      }}
      initialFocusEl={() => cancelRef.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Add Expense</Dialog.Title>
            </Dialog.Header>

            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <div>
                  <Text mb="1">Cost *</Text>
                  <CurrencyInput
                    value={cost}
                    onChange={(v) => setCost(v)}
                    size="sm"
                  />
                </div>
                <div>
                  <Text mb="1">Description *</Text>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g. fuel, supplies, dump fee"
                    size="sm"
                  />
                </div>
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
                  colorPalette="green"
                  onClick={handleSubmit}
                  loading={busy}
                  disabled={!cost || !description.trim()}
                >
                  Add Expense
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
