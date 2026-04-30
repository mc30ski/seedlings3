"use client";

import { useRef, useState, useEffect } from "react";
import { Button, Dialog, HStack, VStack, Portal, Text, Box } from "@chakra-ui/react";
import CurrencyInput from "@/src/ui/components/CurrencyInput";

type Props = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmColorPalette?: string;
  onConfirm: ((inputValue: string, amountValue?: string) => void) | (() => void);
  onCancel: () => void;
  /** If provided, shows a text input with this placeholder */
  inputPlaceholder?: string;
  /** Label for the text input */
  inputLabel?: string;
  /** If true, the input is not required to confirm */
  inputOptional?: boolean;
  /** Default value for the input */
  inputDefaultValue?: string;
  /** If provided, shows an additional currency input. The amount value is passed as the 2nd arg to onConfirm. Always optional. */
  amountLabel?: string;
  amountPlaceholder?: string;
  amountDefaultValue?: string;
  /** Custom label for the cancel button */
  cancelLabel?: string;
  /** Action to perform on cancel (instead of just closing) */
  onCancelAction?: () => void;
};

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  confirmColorPalette = "green",
  onConfirm,
  onCancel,
  inputPlaceholder,
  inputLabel,
  inputOptional,
  inputDefaultValue,
  amountLabel,
  amountPlaceholder,
  amountDefaultValue,
  cancelLabel,
  onCancelAction,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [amountValue, setAmountValue] = useState("");

  // Reset inputs when dialog opens/closes
  useEffect(() => {
    if (open) {
      setInputValue(inputDefaultValue ?? "");
      setAmountValue(amountDefaultValue ?? "");
    }
  }, [open, inputDefaultValue, amountDefaultValue]);

  const hasInput = !!inputPlaceholder;
  const hasAmount = !!amountLabel;
  const canConfirm = !hasInput || inputOptional || inputValue.trim().length > 0;

  function handleConfirm() {
    if (!canConfirm) return;
    if (hasInput || hasAmount) {
      (onConfirm as (v: string, a?: string) => void)(inputValue.trim(), hasAmount ? amountValue : undefined);
    } else {
      (onConfirm as () => void)();
    }
  }

  return (
    <Dialog.Root
      role="alertdialog"
      open={open}
      onOpenChange={(e) => {
        if (!e.open) onCancel();
      }}
      initialFocusEl={() => cancelRef.current}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text>{message}</Text>
              {hasInput && (
                <Box mt={3}>
                  {inputLabel && (
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      {inputLabel}
                    </Text>
                  )}
                  <textarea
                    placeholder={inputPlaceholder}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    rows={3}
                    style={{
                      width: "100%",
                      fontSize: "0.875rem",
                      padding: "0.5rem",
                      borderRadius: "0.375rem",
                      border: "1px solid var(--chakra-colors-border)",
                      background: "var(--chakra-colors-bg)",
                      color: "var(--chakra-colors-fg)",
                      outline: "none",
                      resize: "vertical",
                    }}
                  />
                </Box>
              )}
              {hasAmount && (
                <Box mt={3}>
                  <Text fontSize="sm" fontWeight="medium" mb={1}>
                    {amountLabel}
                  </Text>
                  <CurrencyInput
                    value={amountValue}
                    onChange={setAmountValue}
                    size="sm"
                    placeholder={amountPlaceholder ?? "0.00"}
                  />
                </Box>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              {onCancelAction ? (
                <VStack w="full" gap={2}>
                  <Button
                    w="full"
                    colorPalette={confirmColorPalette}
                    onClick={handleConfirm}
                    disabled={!canConfirm}
                  >
                    {confirmLabel}
                  </Button>
                  <Button
                    w="full"
                    variant="outline"
                    colorPalette="gray"
                    onClick={() => { onCancelAction(); onCancel(); }}
                  >
                    {cancelLabel}
                  </Button>
                  <Button
                    ref={cancelRef}
                    w="full"
                    variant="ghost"
                    colorPalette="red"
                    size="sm"
                    onClick={onCancel}
                  >
                    Cancel
                  </Button>
                </VStack>
              ) : (
                <HStack justify="flex-end" w="full" gap={2} wrap="wrap">
                  <Button ref={cancelRef} variant="ghost" colorPalette="red" onClick={onCancel}>
                    {cancelLabel ?? "Cancel"}
                  </Button>
                  <Button
                    colorPalette={confirmColorPalette}
                    onClick={handleConfirm}
                    disabled={!canConfirm}
                  >
                    {confirmLabel}
                  </Button>
                </HStack>
              )}
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
