"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { apiPatch } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type DocMeta = {
  id: string;
  title: string;
  description?: string | null;
  expiresAt?: string | null;
  adminHidden: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocMeta | null;
  onSaved: () => void;
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

export default function EditDocumentMetadataDialog({
  open, onOpenChange, doc, onSaved,
}: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [adminHidden, setAdminHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && doc) {
      setTitle(doc.title);
      setDescription(doc.description ?? "");
      setExpiresAt(isoToDateInput(doc.expiresAt));
      setAdminHidden(doc.adminHidden);
    }
  }, [open, doc]);

  async function handleSave() {
    if (!doc) return;
    setBusy(true);
    try {
      await apiPatch(`/api/admin/documents/${doc.id}`, {
        title: title.trim(),
        description: description.trim() || null,
        expiresAt: expiresAt ? new Date(expiresAt + "T00:00:00").toISOString() : null,
        adminHidden,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Document updated." });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Update failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onOpenChange(false); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Edit Document</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Title *</Text>
                  <Input size="sm" value={title} onChange={(e) => setTitle(e.target.value)} />
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Description</Text>
                  <Textarea size="sm" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Expiration date</Text>
                  <Input type="date" size="sm" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                </Box>
                <Checkbox.Root
                  checked={adminHidden}
                  onCheckedChange={(e) => setAdminHidden(!!e.checked)}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>Hide from Admins (Super-only)</Checkbox.Label>
                </Checkbox.Root>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
                <Button colorPalette="teal" loading={busy} disabled={!title.trim() || busy} onClick={handleSave}>Save</Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
