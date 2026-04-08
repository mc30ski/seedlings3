"use client";

import { useRef, useState, useEffect } from "react";
import { Button, Dialog, HStack, Portal, Text, Box } from "@chakra-ui/react";

type Props = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmColorPalette?: string;
  onConfirm: ((inputValue: string) => void) | (() => void);
  onCancel: () => void;
  /** If provided, shows a text input with this placeholder */
  inputPlaceholder?: string;
  /** Label for the text input */
  inputLabel?: string;
  /** If true, the input is not required to confirm */
  inputOptional?: boolean;
  /** Default value for the input */
  inputDefaultValue?: string;
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
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [inputValue, setInputValue] = useState("");

  // Reset input when dialog opens/closes
  useEffect(() => {
    if (open) setInputValue(inputDefaultValue ?? "");
  }, [open, inputDefaultValue]);

  const hasInput = !!inputPlaceholder;
  const canConfirm = !hasInput || inputOptional || inputValue.trim().length > 0;

  function handleConfirm() {
    if (!canConfirm) return;
    if (hasInput) {
      (onConfirm as (v: string) => void)(inputValue.trim());
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
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap={2}>
                <Button ref={cancelRef} variant="ghost" colorPalette="red" onClick={onCancel}>
                  Cancel
                </Button>
                <Button
                  colorPalette={confirmColorPalette}
                  onClick={handleConfirm}
                  disabled={!canConfirm}
                >
                  {confirmLabel}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
