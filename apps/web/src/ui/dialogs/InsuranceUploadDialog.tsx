"use client";

import { useState } from "react";
import {
  Button,
  Dialog,
  HStack,
  Input,
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
  onUploaded: () => void;
};

export default function InsuranceUploadDialog({ open, onOpenChange, onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setFile(null);
    setExpiresAt("");
  }

  async function handleUpload() {
    if (!file || !expiresAt) return;
    setBusy(true);
    try {
      const contentType = file.type || "application/pdf";

      // 1. Get presigned upload URL
      const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
        "/api/insurance/upload-url",
        { fileName: file.name, contentType },
      );

      // 2. Upload directly to R2
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": contentType },
      });
      if (!uploadRes.ok) {
        throw new Error(`Upload failed: ${uploadRes.status}`);
      }

      // 3. Confirm with API
      await apiPost("/api/insurance/confirm", {
        key,
        fileName: file.name,
        contentType,
        expiresAt: new Date(expiresAt + "T00:00:00").toISOString(),
      });

      publishInlineMessage({ type: "SUCCESS", text: "Insurance certificate uploaded." });
      reset();
      onUploaded();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Upload failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) { onOpenChange(false); reset(); } }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Upload Insurance Certificate</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm" color="fg.muted">
                  Upload your certificate of general liability insurance (PDF or image).
                </Text>
                <div>
                  <Text mb="1">Certificate file *</Text>
                  <Input
                    type="file"
                    accept="application/pdf,image/*"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    p="1"
                  />
                </div>
                <div>
                  <Text mb="1">Expiration date *</Text>
                  <Input
                    type="date"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                  />
                </div>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={handleUpload} loading={busy} disabled={!file || !expiresAt}>
                  Upload
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
