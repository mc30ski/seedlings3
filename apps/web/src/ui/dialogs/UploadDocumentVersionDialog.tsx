"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Plus } from "lucide-react";
import { apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string | null;
  /** API base — `/api/super/documents` for super, omitted/none for admin. */
  apiBase: string;
  /** Current expiration on the doc, ISO string or null. Used as default. */
  defaultExpiresAt?: string | null;
  onUploaded: () => void;
};

function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return "";
  }
}

export default function UploadDocumentVersionDialog({
  open,
  onOpenChange,
  documentId,
  apiBase,
  defaultExpiresAt,
  onUploaded,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [showExpiration, setShowExpiration] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFile(null);
      const initial = isoToDateInput(defaultExpiresAt);
      setExpiresAt(initial);
      setShowExpiration(!!initial);
    }
  }, [open, defaultExpiresAt]);

  async function handleUpload() {
    if (!documentId || !file) return;
    setBusy(true);
    try {
      const contentType = file.type || "application/octet-stream";
      const init = await apiPost<{ uploadUrl: string; versionId: string }>(
        `${apiBase}/${documentId}/versions/init`,
        { filename: file.name, contentType, sizeBytes: file.size },
      );
      const putRes = await fetch(init.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": contentType },
      });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
      await apiPost(
        `${apiBase}/${documentId}/versions/${init.versionId}/confirm`,
        { expiresAt: showExpiration && expiresAt ? new Date(expiresAt + "T00:00:00").toISOString() : null },
      );
      publishInlineMessage({ type: "SUCCESS", text: "New version uploaded." });
      onUploaded();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Upload failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onOpenChange(false); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Upload New Version</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>File *</Text>
                  <Input type="file" p="1" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </Box>
                {showExpiration ? (
                  <Box>
                    <HStack justify="space-between" mb={1}>
                      <Text fontSize="xs" fontWeight="medium">Expiration date</Text>
                      <Button size="xs" variant="ghost" onClick={() => { setShowExpiration(false); setExpiresAt(""); }}>Remove</Button>
                    </HStack>
                    <Input type="date" size="sm" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                  </Box>
                ) : (
                  <Button size="xs" variant="ghost" alignSelf="start" onClick={() => setShowExpiration(true)}>
                    <Plus size={12} /> Add expiration date
                  </Button>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
                <Button colorPalette="teal" loading={busy} disabled={!file || busy} onClick={handleUpload}>Upload</Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
