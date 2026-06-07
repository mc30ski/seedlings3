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
import { Plus } from "lucide-react";
import { apiPatch } from "@/src/lib/api";
import { bizDateKey, bizInstantFromEtParts } from "@/src/lib/lib";
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
  /** API base path for documents (writes always hit `/api/super/...`). */
  apiBase: string;
  /** When true, hide the per-doc description input — singleton types use the
   *  type-level taxonomy description instead. */
  isSingletonType?: boolean;
  onSaved: () => void;
};

function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  // <input type="date"> takes a YYYY-MM-DD calendar value, ET-anchored
  // for this business so the date shown matches the operator's view.
  try {
    return bizDateKey(iso);
  } catch {
    return "";
  }
}

export default function EditDocumentMetadataDialog({
  open, onOpenChange, doc, apiBase, isSingletonType, onSaved,
}: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  // Separate visibility flag so the picker can be shown empty without the
  // native date input rendering today as a phantom default.
  const [showExpiration, setShowExpiration] = useState(false);
  const [adminHidden, setAdminHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && doc) {
      setTitle(doc.title);
      setDescription(doc.description ?? "");
      const initialDate = isoToDateInput(doc.expiresAt);
      setExpiresAt(initialDate);
      setShowExpiration(!!initialDate);
      setAdminHidden(doc.adminHidden);
    }
  }, [open, doc]);

  async function handleSave() {
    if (!doc) return;
    setBusy(true);
    try {
      await apiPatch(`${apiBase}/${doc.id}`, {
        title: title.trim(),
        // Don't write description for singleton types (their description
        // lives at the type-taxonomy level). Existing value, if any, is
        // preserved in the DB since we omit the field instead of nulling it.
        ...(isSingletonType ? {} : { description: description.trim() || null }),
        // Send null when the picker is hidden or empty — that's the user
        // saying "no expiration." Send a real ISO when they've picked a date.
        expiresAt: showExpiration && expiresAt ? bizInstantFromEtParts(expiresAt, "23:59:59") : null,
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
                {!isSingletonType && (
                  <Box>
                    <Text fontSize="xs" fontWeight="medium" mb={1}>Description</Text>
                    <Textarea size="sm" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
                  </Box>
                )}
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
