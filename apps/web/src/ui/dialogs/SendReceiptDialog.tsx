"use client";

import { useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Download, Mail, MessageCircle } from "lucide-react";
import { type ReceiptData, downloadReceipt } from "@/src/lib/receipt";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ReceiptData | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
};

type PendingSend = { target: "text" | "email" } | null;

export default function SendReceiptDialog({ open, onOpenChange, data, contactPhone, contactEmail }: Props) {
  const [pendingSend, setPendingSend] = useState<PendingSend>(null);

  if (!data) return null;

  function handleDownload() {
    if (!data) return;
    downloadReceipt(data);
    publishInlineMessage({ type: "SUCCESS", text: "Receipt downloaded." });
  }

  function openMessagingApp(target: "text" | "email") {
    if (!data) return;
    if (target === "text" && contactPhone) {
      const msg = `Hi ${data.clientName}, here is your receipt from ${data.businessName} for service on ${data.serviceDate}. Amount paid: $${data.amount.toFixed(2)}. Receipt #${data.receiptId}.`;
      window.open(`sms:${contactPhone}?body=${encodeURIComponent(msg)}`, "_self");
    } else if (target === "email" && contactEmail) {
      const subject = `Receipt from ${data.businessName} — ${data.serviceDate}`;
      const body = `Hi ${data.clientName},\n\nPlease find your receipt details below.\n\nReceipt #: ${data.receiptId}\nAmount: $${data.amount.toFixed(2)}\nService Date: ${data.serviceDate}\nProperty: ${data.propertyAddress}\n\nThank you,\n${data.businessName}`;
      window.open(`mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
    }
  }

  function handleSendClick(target: "text" | "email") {
    setPendingSend({ target });
  }

  function handleSendWithPDF() {
    if (!data || !pendingSend) return;
    downloadReceipt(data);
    publishInlineMessage({ type: "INFO", text: "PDF saved — attach it to your message." });
    setTimeout(() => {
      openMessagingApp(pendingSend.target);
      setPendingSend(null);
    }, 500);
  }

  function handleSendWithoutPDF() {
    if (!pendingSend) return;
    openMessagingApp(pendingSend.target);
    setPendingSend(null);
  }

  // Step 2: "Attach PDF?" prompt
  if (pendingSend) {
    return (
      <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) { setPendingSend(null); onOpenChange(false); } }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.CloseTrigger />
              <Dialog.Header>
                <Dialog.Title>Attach PDF Receipt?</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Text fontSize="sm" color="fg.muted">
                    Would you like to generate a PDF receipt to attach to the message? The PDF will be saved to your device so you can add it as an attachment.
                  </Text>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <VStack w="full" gap={2}>
                  <Button size="sm" variant="solid" bg="black" color="white" onClick={handleSendWithPDF} w="full">
                    Yes, save PDF & send
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleSendWithoutPDF} w="full">
                    No, just send message
                  </Button>
                </VStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    );
  }

  // Step 1: Main receipt dialog
  return (
    <Dialog.Root open={open} onOpenChange={(e) => onOpenChange(e.open)}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Send Receipt</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box p={3} bg="green.50" borderWidth="1px" borderColor="green.200" rounded="md">
                  <Text fontSize="sm" fontWeight="medium" color="green.800">
                    Receipt #{data.receiptId}
                  </Text>
                  <Text fontSize="xs" color="green.700">
                    {data.clientName} — {data.propertyAddress}
                  </Text>
                  <Text fontSize="xs" color="green.700">
                    {data.serviceDate} · ${data.amount.toFixed(2)}
                  </Text>
                </Box>

                <VStack align="stretch" gap={2}>
                  <Button
                    size="sm"
                    variant="solid"
                    bg="black"
                    color="white"
                    onClick={handleDownload}
                    w="full"
                  >
                    <Download size={14} />
                    Download PDF
                  </Button>

                  {contactPhone && (
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="green"
                      onClick={() => handleSendClick("text")}
                      w="full"
                      overflow="hidden"
                    >
                      <MessageCircle size={14} style={{ flexShrink: 0 }} />
                      <Text lineClamp={1}>Text to {contactPhone}</Text>
                    </Button>
                  )}

                  {contactEmail && (
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="blue"
                      onClick={() => handleSendClick("email")}
                      w="full"
                      overflow="hidden"
                    >
                      <Mail size={14} style={{ flexShrink: 0 }} />
                      <Text lineClamp={1}>Email to {contactEmail}</Text>
                    </Button>
                  )}

                  {!contactPhone && !contactEmail && (
                    <Text fontSize="xs" color="fg.muted" textAlign="center">
                      No phone or email on file for this client. Download the PDF and send it manually.
                    </Text>
                  )}
                </VStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
