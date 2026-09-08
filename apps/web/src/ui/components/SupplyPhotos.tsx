"use client";

// Photos of a supply — what the bag, roll or jug actually looks like, so the
// right thing gets bought and the right thing gets pulled onto a job.
//
// TWO MODES, because Add Supply has no supply yet:
//
//   • supplyId set    — live. Uploads go straight to R2 and are confirmed
//                       against the row.
//   • supplyId null   — STAGING. Files are held in memory with local preview
//                       URLs and handed back through `onStagedChange`, for the
//                       caller to upload once the supply exists.
//
// STAGING IS THE PATTERN THAT JUST BIT US, so it is built differently here.
// The Buy dialog used to buffer a receipt and upload it after saving, guarded
// by a condition that silently became false — the file was dropped while the
// toast said "receipt attached". So: the caller must report per-file failures,
// `uploadStagedPhotos` returns the count it actually wrote, and it throws
// rather than resolving quietly when a file fails.
//
// Compression is `compressOnly`, the same path property, equipment, occurrence
// and receipt uploads use, so supply photos follow the org-wide
// PHOTO_MAX_EDGE_PX / PHOTO_JPEG_QUALITY settings automatically.

import { useEffect, useState } from "react";
import { Box, Button, HStack, Text, Textarea, VStack } from "@chakra-ui/react";
import { Plus, Trash2 } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { compressOnly } from "@/src/lib/imageRedact";

export const SUPPLY_PHOTO_LIMIT = 10;

export type SupplyPhoto = {
  id: string;
  url: string;
  fileName?: string | null;
  description?: string | null;
  sortOrder: number;
};

/** A file chosen before the supply existed. `preview` is an object URL. */
export type StagedPhoto = { file: File; preview: string };

/**
 * Upload files staged during Add, once the supply has an id.
 *
 * Returns how many were written. THROWS on the first failure rather than
 * resolving — a caller that ignores the result must not be able to report
 * success for photos that never left the browser.
 */
export async function uploadStagedPhotos(
  supplyId: string,
  staged: StagedPhoto[],
): Promise<number> {
  let uploaded = 0;
  for (const { file } of staged) {
    const compressed = await compressOnly(file);
    const contentType = "image/jpeg";
    const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
      `/api/admin/supplies/${supplyId}/photos/upload-url`,
      { fileName: file.name, contentType },
    );
    const res = await fetch(uploadUrl, {
      method: "PUT",
      body: compressed,
      headers: { "Content-Type": contentType },
    });
    if (!res.ok) throw new Error(`Upload failed for ${file.name}: ${res.status}`);
    await apiPost(`/api/admin/supplies/${supplyId}/photos/confirm`, {
      key,
      fileName: file.name,
      contentType,
    });
    uploaded += 1;
  }
  return uploaded;
}

type Props = {
  /** null while creating — the component stages instead of uploading. */
  supplyId: string | null;
  /** Hides every mutating control. */
  readOnly?: boolean;
  /** Staged files, owned by the caller so it can upload them after create. */
  staged?: StagedPhoto[];
  onStagedChange?: (next: StagedPhoto[]) => void;
};

export default function SupplyPhotos({ supplyId, readOnly, staged = [], onStagedChange }: Props) {
  const [photos, setPhotos] = useState<SupplyPhoto[]>([]);
  const [loading, setLoading] = useState(!!supplyId);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  async function load() {
    if (!supplyId) return;
    try {
      const list = await apiGet<SupplyPhoto[]>(`/api/admin/supplies/${supplyId}/photos`);
      setPhotos(Array.isArray(list) ? list : []);
    } catch {
      setPhotos([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!supplyId) {
      setPhotos([]);
      setLoading(false);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplyId]);

  // Object URLs are a leak if they outlive the component.
  useEffect(() => {
    return () => staged.forEach((s) => URL.revokeObjectURL(s.preview));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = photos.length + staged.length;

  async function handlePick(file: File) {
    if (total >= SUPPLY_PHOTO_LIMIT) {
      publishInlineMessage({
        type: "WARNING",
        text: `A supply can carry ${SUPPLY_PHOTO_LIMIT} photos.`,
      });
      return;
    }
    // No supply yet — hold it and let the caller upload after create.
    if (!supplyId) {
      onStagedChange?.([...staged, { file, preview: URL.createObjectURL(file) }]);
      return;
    }
    setUploading(true);
    try {
      await uploadStagedPhotos(supplyId, [{ file, preview: "" }]);
      publishInlineMessage({ type: "SUCCESS", text: "Photo uploaded." });
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Upload failed.", err) });
    }
    setUploading(false);
  }

  async function handleDelete(photoId: string) {
    if (!supplyId) return;
    try {
      await apiDelete(`/api/admin/supplies/${supplyId}/photos/${photoId}`);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      publishInlineMessage({ type: "SUCCESS", text: "Photo deleted." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  async function saveDescription(photoId: string) {
    if (!supplyId) return;
    try {
      await apiPatch(`/api/admin/supplies/${supplyId}/photos/${photoId}`, { description: editDesc });
      setPhotos((prev) =>
        prev.map((p) => (p.id === photoId ? { ...p, description: editDesc.trim() || null } : p)),
      );
      setEditingId(null);
      publishInlineMessage({ type: "SUCCESS", text: "Description saved." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    }
  }

  function removeStaged(idx: number) {
    const next = staged.filter((_, i) => i !== idx);
    URL.revokeObjectURL(staged[idx].preview);
    onStagedChange?.(next);
  }

  function pickFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void handlePick(file);
    };
    input.click();
  }

  if (loading) return null;
  if (readOnly && total === 0) return null;

  const canAdd = !readOnly && total < SUPPLY_PHOTO_LIMIT;

  return (
    <Box>
      <HStack gap={1.5} wrap="wrap" align="center">
        {photos.map((photo, idx) => (
          <Box
            key={photo.id}
            position="relative"
            w="64px"
            h="64px"
            borderRadius="md"
            overflow="hidden"
            cursor="pointer"
            onClick={(e) => { e.stopPropagation(); setViewerIndex(idx); }}
            borderWidth="1px"
            borderColor="gray.200"
            flexShrink={0}
          >
            <img
              src={photo.url}
              alt={photo.description || "Supply photo"}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </Box>
        ))}

        {/* Staged: visibly NOT yet saved, so a half-finished Add cannot look
            like it stored something. */}
        {staged.map((s, idx) => (
          <Box
            key={`staged-${idx}`}
            position="relative"
            w="64px"
            h="64px"
            borderRadius="md"
            overflow="hidden"
            borderWidth="2px"
            borderStyle="dashed"
            borderColor="blue.400"
            flexShrink={0}
            title={`${s.file.name} — uploads when you save`}
          >
            <img
              src={s.preview}
              alt={s.file.name}
              style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.75 }}
            />
            <Button
              size="xs"
              variant="solid"
              colorPalette="red"
              position="absolute"
              top="0"
              right="0"
              minW="18px"
              h="18px"
              p="0"
              borderRadius="0 0 0 6px"
              aria-label={`Remove ${s.file.name}`}
              onClick={(e) => { e.stopPropagation(); removeStaged(idx); }}
            >
              ×
            </Button>
          </Box>
        ))}

        {canAdd && (
          <Button
            size="xs"
            variant="outline"
            loading={uploading}
            onClick={(e) => { e.stopPropagation(); pickFile(); }}
            w="64px"
            h="64px"
            p="0"
            flexShrink={0}
            title="Add photo"
          >
            <Plus size={20} />
          </Button>
        )}
      </HStack>

      {staged.length > 0 && (
        <Text fontSize="xs" color="blue.600" mt={1}>
          {staged.length} photo{staged.length === 1 ? "" : "s"} will upload when you save.
        </Text>
      )}

      {!readOnly && photos.map((photo) =>
        editingId === photo.id ? (
          <VStack key={`edit-${photo.id}`} align="stretch" gap={1} w="full" mt={2} p={2} bg="blue.50" borderRadius="md">
            <Text fontSize="xs" color="fg.muted">Description for: {photo.fileName ?? "photo"}</Text>
            <Textarea
              size="sm"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              placeholder="Optional description…"
              rows={2}
            />
            <HStack gap={1}>
              <Button size="xs" colorPalette="blue" onClick={() => void saveDescription(photo.id)}>Save</Button>
              <Button size="xs" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
              <Box flex="1" />
              <Button
                size="xs"
                variant="ghost"
                colorPalette="red"
                onClick={() => { void handleDelete(photo.id); setEditingId(null); }}
              >
                <Trash2 size={12} /> Delete
              </Button>
            </HStack>
          </VStack>
        ) : null,
      )}

      {viewerIndex != null && photos[viewerIndex] && (() => {
        const photo = photos[viewerIndex];
        const hasPrev = viewerIndex > 0;
        const hasNext = viewerIndex < photos.length - 1;
        const navigate = (dir: -1 | 1) => {
          const next = viewerIndex + dir;
          if (next >= 0 && next < photos.length) setViewerIndex(next);
        };
        return (
          <Box
            position="fixed"
            inset="0"
            zIndex={10000}
            bg="blackAlpha.800"
            display="flex"
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            onClick={(e) => { if (e.target === e.currentTarget) setViewerIndex(null); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" && hasPrev) { e.preventDefault(); navigate(-1); }
              else if (e.key === "ArrowRight" && hasNext) { e.preventDefault(); navigate(1); }
              else if (e.key === "Escape") setViewerIndex(null);
            }}
            tabIndex={0}
            ref={(el: HTMLDivElement | null) => el?.focus()}
          >
            {hasPrev && (
              <Box position="absolute" left="3" top="50%" transform="translateY(-50%)" color="white" fontSize="2xl" cursor="pointer" p={2} onClick={(e) => { e.stopPropagation(); navigate(-1); }} userSelect="none">◀</Box>
            )}
            <img
              src={photo.url}
              alt={photo.description || "Supply photo"}
              style={{ maxWidth: "90vw", maxHeight: "70vh", objectFit: "contain", borderRadius: "8px" }}
              onClick={(e) => e.stopPropagation()}
            />
            {photo.description && (
              <Box mt={3} px={4} py={2} bg="blackAlpha.600" borderRadius="md" maxW="90vw" onClick={(e) => e.stopPropagation()}>
                <Text color="white" fontSize="sm" textAlign="center">{photo.description}</Text>
              </Box>
            )}
            <HStack position="absolute" bottom="4" gap={3} onClick={(e) => e.stopPropagation()}>
              <Text color="whiteAlpha.700" fontSize="sm">{viewerIndex + 1} / {photos.length}</Text>
              {!readOnly && (
                <Button
                  size="xs"
                  variant="ghost"
                  color="whiteAlpha.800"
                  onClick={() => { setEditingId(photo.id); setEditDesc(photo.description ?? ""); setViewerIndex(null); }}
                >
                  Edit
                </Button>
              )}
            </HStack>
            {hasNext && (
              <Box position="absolute" right="3" top="50%" transform="translateY(-50%)" color="white" fontSize="2xl" cursor="pointer" p={2} onClick={(e) => { e.stopPropagation(); navigate(1); }} userSelect="none">▶</Box>
            )}
          </Box>
        );
      })()}
    </Box>
  );
}
