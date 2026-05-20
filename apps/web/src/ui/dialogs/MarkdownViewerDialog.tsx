"use client";

import { Box, Button, Dialog, HStack, Portal, Spinner, Text } from "@chakra-ui/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// In-app renderer for text/markdown documents. The Documents tab fetches a
// version's raw text and hands it here; ReactMarkdown + remark-gfm render it
// (GitHub-flavored: tables, strikethrough, task lists). Styling is done with
// scoped CSS selectors on a wrapper Box rather than per-element component
// overrides — covers every element, including nested ones, with less code.

// Plain-CSS style block scoped under the wrapper. Kept readable for a long
// reference document: clear heading hierarchy, bordered tables, soft code bg.
const MD_STYLES = {
  fontSize: "14px",
  lineHeight: 1.6,
  color: "#1a202c",
  "& h1": { fontSize: "24px", fontWeight: 700, margin: "20px 0 10px", borderBottom: "2px solid #e2e8f0", paddingBottom: "6px" },
  "& h2": { fontSize: "19px", fontWeight: 700, margin: "22px 0 8px", borderBottom: "1px solid #edf2f7", paddingBottom: "4px" },
  "& h3": { fontSize: "16px", fontWeight: 600, margin: "16px 0 6px" },
  "& h4": { fontSize: "14px", fontWeight: 600, margin: "12px 0 4px" },
  "& p": { margin: "8px 0" },
  "& ul, & ol": { margin: "8px 0", paddingLeft: "22px" },
  "& li": { margin: "3px 0" },
  "& a": { color: "#2b6cb0", textDecoration: "underline" },
  "& strong": { fontWeight: 700 },
  "& em": { fontStyle: "italic" },
  "& hr": { border: "none", borderTop: "1px solid #e2e8f0", margin: "18px 0" },
  "& blockquote": { borderLeft: "3px solid #cbd5e0", paddingLeft: "12px", margin: "8px 0", color: "#4a5568" },
  "& code": { background: "#edf2f7", padding: "1px 5px", borderRadius: "4px", fontSize: "12.5px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  "& pre": { background: "#edf2f7", padding: "10px 12px", borderRadius: "6px", overflowX: "auto", margin: "10px 0" },
  "& pre code": { background: "transparent", padding: 0 },
  "& table": { borderCollapse: "collapse", width: "100%", margin: "10px 0", fontSize: "13px" },
  "& th, & td": { border: "1px solid #e2e8f0", padding: "6px 10px", textAlign: "left", verticalAlign: "top" },
  "& th": { background: "#f7fafc", fontWeight: 600 },
  "& tr:nth-of-type(even) td": { background: "#fafafa" },
} as const;

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Raw markdown text. Null while loading. */
  text: string | null;
  loading: boolean;
  error: string | null;
  /** Optional: presigned URL so the user can still download the raw file. */
  downloadUrl?: string | null;
};

export default function MarkdownViewerDialog({
  open,
  onClose,
  title,
  text,
  loading,
  error,
  downloadUrl,
}: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onClose(); }} size="cover" scrollBehavior="inside">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" my="4" maxW="900px" w="full" rounded="xl" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.CloseTrigger />
            </Dialog.Header>
            <Dialog.Body>
              {loading ? (
                <HStack justify="center" py={10} gap={3}>
                  <Spinner size="md" />
                  <Text color="fg.muted">Loading document…</Text>
                </HStack>
              ) : error ? (
                <Text color="red.600" py={6}>{error}</Text>
              ) : text != null ? (
                <Box css={MD_STYLES}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                </Box>
              ) : null}
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap={2}>
                {downloadUrl && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.open(downloadUrl, "_blank", "noopener,noreferrer")}
                  >
                    Download raw file
                  </Button>
                )}
                <Button size="sm" onClick={onClose}>Close</Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
