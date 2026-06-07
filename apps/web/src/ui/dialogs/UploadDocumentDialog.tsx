"use client";

import { useEffect, useState } from "react";
import {
  Badge,
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
import { apiPost } from "@/src/lib/api";
import { bizInstantFromEtParts } from "@/src/lib/lib";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import {
  DEFAULT_DOCUMENT_TYPES,
  type DocumentTypeConfig,
} from "@/src/ui/components/DocumentTypePicker";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  types: DocumentTypeConfig[];
  /** Used to disable singleton types that already have an active doc. */
  takenSingletonKeys: Set<string>;
  /** API base path for documents (Super writes always hit `/api/super/...`). */
  apiBase: string;
  onCreated: () => void;
  /** When set, lock the type picker to this key (e.g., "Add another GL cert"). */
  initialType?: string | null;
};

export default function UploadDocumentDialog({
  open,
  onOpenChange,
  types,
  takenSingletonKeys,
  apiBase,
  onCreated,
  initialType,
}: Props) {
  const [type, setType] = useState<string>("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  // Separate from `expiresAt` so the picker can be visible while empty — keeps
  // the "no default" promise when the user reveals it.
  const [showExpiration, setShowExpiration] = useState(false);
  const [adminHidden, setAdminHidden] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setType(initialType || "");
      setTitle("");
      setDescription("");
      setExpiresAt("");
      setShowExpiration(false);
      setAdminHidden(false);
      setFile(null);
    }
  }, [open, initialType]);

  const list = types.length ? types : DEFAULT_DOCUMENT_TYPES;
  const selectedType = list.find((t) => t.key === type) ?? null;

  // For singletons, prefill title with the type label as a convenience.
  useEffect(() => {
    if (selectedType?.singleton && !title.trim()) {
      setTitle(selectedType.label);
    }
  }, [selectedType, title]);

  // Turn "Articles_of_Org-2024.pdf" → "Articles of Org 2024". Strips the
  // extension and normalizes separators so the title reads naturally.
  function filenameToTitle(name: string): string {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return stem.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function handleFileChange(f: File | null) {
    setFile(f);
    // Only auto-populate when the title is empty so we don't clobber user
    // typing. A subsequent file change won't overwrite an already-set title.
    if (f && !title.trim()) {
      setTitle(filenameToTitle(f.name));
    }
  }

  async function handleUpload() {
    if (!type || !title.trim() || !file) return;
    setBusy(true);
    try {
      const created = await apiPost<{ id: string }>(apiBase, {
        type,
        title: title.trim(),
        // Singleton types use the type-level description; per-doc description
        // is intentionally omitted so it doesn't double up.
        description: selectedType?.singleton ? undefined : (description.trim() || undefined),
        expiresAt: expiresAt ? bizInstantFromEtParts(expiresAt, "23:59:59") : null,
        adminHidden,
      });

      const contentType = file.type || "application/octet-stream";
      const init = await apiPost<{ uploadUrl: string; versionId: string }>(
        `${apiBase}/${created.id}/versions/init`,
        { filename: file.name, contentType, sizeBytes: file.size },
      );

      const putRes = await fetch(init.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": contentType },
      });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);

      await apiPost(
        `${apiBase}/${created.id}/versions/${init.versionId}/confirm`,
        { expiresAt: expiresAt ? bizInstantFromEtParts(expiresAt, "23:59:59") : null },
      );

      publishInlineMessage({ type: "SUCCESS", text: "Document uploaded." });
      onCreated();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Upload failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  const submitDisabled = !type || !title.trim() || !file || busy;

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onOpenChange(false); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Upload Document</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>File *</Text>
                  <Input type="file" p="1" onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)} />
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Type *</Text>
                  <Box display="flex" gap="4px" flexWrap="wrap">
                    {list.map((t) => {
                      const taken = !!t.singleton && takenSingletonKeys.has(t.key);
                      const active = type === t.key;
                      return (
                        <Badge
                          key={t.key}
                          size="sm"
                          colorPalette={active ? "teal" : taken ? "gray" : "gray"}
                          variant={active ? "solid" : "outline"}
                          cursor={taken ? "not-allowed" : "pointer"}
                          opacity={taken ? 0.5 : 1}
                          px="2"
                          borderRadius="full"
                          title={taken ? `Singleton — already has an active document` : undefined}
                          onClick={() => { if (!taken && !initialType) setType(active ? "" : t.key); }}
                        >
                          {t.label}{t.singleton ? " ·1" : ""}
                        </Badge>
                      );
                    })}
                  </Box>
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Title *</Text>
                  <Input size="sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., GL — State Farm 2026" />
                </Box>
                {/* Per-doc description is only meaningful for multi-instance
                    types — singleton types use the type-level description in
                    the taxonomy instead. */}
                {!selectedType?.singleton && (
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
                    <Input type="date" size="sm" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} autoFocus />
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
                  <Checkbox.Label>
                    Hide from Admins (Super-only)
                  </Checkbox.Label>
                </Checkbox.Root>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
                <Button colorPalette="teal" loading={busy} disabled={submitDisabled} onClick={handleUpload}>Upload</Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
