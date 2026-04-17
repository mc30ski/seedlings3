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

export default function SendReceiptDialog({ open, onOpenChange, data, contactPhone, contactEmail }: Props) {
  const [busy, setBusy] = useState(false);

  if (!data) return null;

  function handleDownload() {
    if (!data) return;
    downloadReceipt(data);
    publishInlineMessage({ type: "SUCCESS", text: "Receipt downloaded." });
  }

  function handleText() {
    if (!data || !contactPhone) return;
    const msg = `Hi ${data.clientName}, here is your receipt from ${data.businessName} for service on ${data.serviceDate}. Amount paid: $${data.amount.toFixed(2)} via ${data.method}. Receipt #${data.receiptId}. Thank you!`;
    window.open(`sms:${contactPhone}?body=${encodeURIComponent(msg)}`, "_self");
  }

  function handleEmail() {
    if (!data || !contactEmail) return;
    const subject = `Receipt from ${data.businessName} — ${data.serviceDate}`;
    const body = [
      `Hi ${data.clientName},`,
      "",
      `Thank you for your business! Here are the details of your recent service:`,
      "",
      `Service: ${data.jobType}`,
      `Property: ${data.propertyAddress}`,
      `Service Date: ${data.serviceDate}`,
      `Completed: ${data.completedDate}`,
      `Amount Paid: $${data.amount.toFixed(2)}`,
      `Payment Method: ${data.method}`,
      `Receipt #: ${data.receiptId}`,
      "",
      `If you have any questions, please don't hesitate to reach out.`,
      "",
      `Thank you,`,
      data.businessName,
    ].join("\n");
    window.open(`mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
  }

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
                      onClick={handleText}
                      w="full"
                    >
                      <MessageCircle size={14} />
                      Text Receipt to {contactPhone}
                    </Button>
                  )}

                  {contactEmail && (
                    <Button
                      size="sm"
                      variant="outline"
                      colorPalette="blue"
                      onClick={handleEmail}
                      w="full"
                    >
                      <Mail size={14} />
                      Email Receipt to {contactEmail}
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
