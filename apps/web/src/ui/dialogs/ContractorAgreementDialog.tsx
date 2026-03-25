"use client";

import { useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAgreed: () => void;
};

export default function ContractorAgreementDialog({ open, onOpenChange, onAgreed }: Props) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setBusy(true);
    try {
      await apiPost("/api/contractor-agreement");
      publishInlineMessage({ type: "SUCCESS", text: "Contractor agreement acknowledged." });
      onAgreed();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to record agreement.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) { onOpenChange(false); setChecked(false); } }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Contractor Agreement</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm">
                  As an independent contractor, you acknowledge that you are responsible for your own
                  taxes, insurance, and compliance with all applicable laws. You are not an employee
                  and are not entitled to employee benefits. You agree to maintain valid general
                  liability insurance for the duration of your work.
                </Text>
                <Checkbox.Root
                  checked={checked}
                  onCheckedChange={(e) => setChecked(!!e.checked)}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>
                    I acknowledge and agree to the contractor terms
                  </Checkbox.Label>
                </Checkbox.Root>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={handleSubmit} loading={busy} disabled={!checked}>
                  Agree & Continue
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
