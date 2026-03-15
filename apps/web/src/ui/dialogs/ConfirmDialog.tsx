"use client";

import { useRef } from "react";
import { Button, Dialog, HStack, Portal, Text } from "@chakra-ui/react";

type Props = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmColorPalette?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  confirmColorPalette = "green",
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

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
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap={2}>
                <Button ref={cancelRef} variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
                <Button colorPalette={confirmColorPalette} onClick={onConfirm}>
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
