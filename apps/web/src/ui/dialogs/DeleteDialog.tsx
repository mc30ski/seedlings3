"use client";

import { Text, HStack, Button, Dialog, Portal } from "@chakra-ui/react";
import { useRef } from "react";

export type ToDeleteProps = {
  id: string;
  child?: string;
  title: string;
  summary: string;
  extra?: string;
  disabled?: boolean;
  details?: JSX.Element;
};

export type DeleteDialogProps = {
  toDelete: ToDeleteProps | null;
  cancel: () => void;
  complete: () => void;
};

export default function DeleteDialog({
  toDelete,
  cancel,
  complete,
}: DeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog.Root
      role="alertdialog"
      open={!!toDelete}
      initialFocusEl={() => cancelRef.current}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop zIndex={1500} />
        <Dialog.Positioner zIndex={1600} paddingInline="4" paddingBlock="6">
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{toDelete?.title} </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text mb="2">
                This will <b>permanently delete</b> record:
              </Text>
              <Text mb="2" color="gray.600">
                {toDelete?.summary}
              </Text>
              {toDelete?.details}
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap="2">
                <Button
                  ref={cancelRef}
                  variant="ghost"
                  onClick={() => void cancel()}
                >
                  Cancel
                </Button>
                <Button
                  variant={"danger" as any}
                  onClick={() => void complete()}
                  disabled={toDelete?.disabled}
                >
                  Delete
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
