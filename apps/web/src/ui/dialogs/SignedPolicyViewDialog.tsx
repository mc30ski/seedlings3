"use client";

// SignedPolicyViewDialog — read-only re-open of a document the worker
// already signed. Rendered from the Compliance section's "Recorded on
// file" list. No signing surface, no upload, no acknowledge — just the
// content the worker agreed to, plus the signed-on date for context.
//
// Content rendering:
//   • MARKDOWN → inline via <MarkdownContent>
//   • PDF      → fetch a presigned URL via /api/me/policies/download,
//                open in a new browser tab (native PDF viewer).

import { useCallback, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ExternalLink, FileText } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/dates";
import MarkdownContent from "@/src/ui/components/MarkdownContent";
import {
  getErrorMessage,
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  versionNumber: number;
  signedAt: string;
  contentFormat: string;
  contentMarkdown: string | null;
  contentR2Key: string | null;
  contentFileName: string | null;
  contentContentType: string | null;
};

export default function SignedPolicyViewDialog({
  open,
  onClose,
  title,
  versionNumber,
  signedAt,
  contentFormat,
  contentMarkdown,
  contentR2Key,
  contentFileName,
  contentContentType,
}: Props) {
  const [openingPdf, setOpeningPdf] = useState(false);
  const isMarkdown = contentFormat === "MARKDOWN" && !!contentMarkdown;
  const isPdf = contentFormat === "PDF" && !!contentR2Key;

  const openPdf = useCallback(async () => {
    if (!contentR2Key) return;
    setOpeningPdf(true);
    try {
      const { url } = await apiGet<{ url: string }>(
        `/api/me/policies/download?r2Key=${encodeURIComponent(contentR2Key)}`,
      );
      window.open(url, "_blank", "noopener");
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Could not open document.", err),
      });
    } finally {
      setOpeningPdf(false);
    }
  }, [contentR2Key]);

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onClose(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <VStack align="start" gap={0}>
                <Dialog.Title>{title}</Dialog.Title>
                <Text fontSize="xs" color="fg.muted">
                  v{versionNumber} · Signed {fmtDate(signedAt)}
                </Text>
              </VStack>
            </Dialog.Header>
            <Dialog.Body>
              {isMarkdown ? (
                <Box
                  maxH="60vh"
                  overflowY="auto"
                  borderWidth="1px"
                  borderRadius="md"
                  p={4}
                  bg="white"
                  fontSize="sm"
                  lineHeight="tall"
                >
                  <MarkdownContent>{contentMarkdown}</MarkdownContent>
                </Box>
              ) : isPdf ? (
                <VStack gap={3} py={6} textAlign="center">
                  <FileText size={40} color="var(--chakra-colors-blue-400)" />
                  <VStack gap={0}>
                    <Text fontSize="sm" fontWeight="medium">
                      {contentFileName ?? "Policy PDF"}
                    </Text>
                    {contentContentType && (
                      <Text fontSize="xs" color="fg.muted">{contentContentType}</Text>
                    )}
                  </VStack>
                  <Button
                    size="sm"
                    colorPalette="blue"
                    onClick={() => void openPdf()}
                    loading={openingPdf}
                  >
                    <ExternalLink size={14} />
                    <Text ml={1}>Open PDF</Text>
                  </Button>
                  <Text fontSize="xs" color="fg.muted">
                    Opens in a new tab
                  </Text>
                </VStack>
              ) : (
                <Text fontSize="sm" color="fg.muted" fontStyle="italic" py={4}>
                  No content available for this version.
                </Text>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" gap={2}>
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Close
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
