"use client";

import { useEffect, useState } from "react";
import { Box, Button, HStack, Spinner, Text, Textarea, VStack } from "@chakra-ui/react";
import { Plus, Trash2 } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { compressOnly } from "@/src/lib/imageRedact";

type EquipmentPhoto = {
  id: string;
  url: string;
  fileName?: string | null;
  description?: string | null;
  sortOrder: number;
};

type Props = {
  equipmentId: string;
  /** Worker = read-only view; admin = upload/edit/delete */
  readOnly?: boolean;
};

export default function EquipmentPhotos({ equipmentId, readOnly }: Props) {
  const [photos, setPhotos] = useState<EquipmentPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  async function load() {
    try {
      const endpoint = readOnly ? `/api/equipment/${equipmentId}/photos` : `/api/admin/equipment/${equipmentId}/photos`;
      const list = await apiGet<EquipmentPhoto[]>(endpoint);
      setPhotos(Array.isArray(list) ? list : []);
    } catch {
      setPhotos([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [equipmentId]);

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const compressed = await compressOnly(file);
      const contentType = "image/jpeg";
      const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
        `/api/admin/equipment/${equipmentId}/photos/upload-url`,
        { fileName: file.name, contentType },
      );
      const uploadRes = await fetch(uploadUrl, { method: "PUT", body: compressed, headers: { "Content-Type": contentType } });
      if (!uploadRes.ok) throw new Error(`R2 upload failed: ${uploadRes.status}`);
      await apiPost(`/api/admin/equipment/${equipmentId}/photos/confirm`, {
        key, fileName: file.name, contentType,
      });
      publishInlineMessage({ type: "SUCCESS", text: "Photo uploaded." });
      await load();
    } catch (err) {
      console.error("[EquipmentPhotos] Upload error:", err);
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Upload failed.", err) });
    }
    setUploading(false);
  }

  async function handleDelete(photoId: string) {
    try {
      await apiDelete(`/api/admin/equipment/${equipmentId}/photos/${photoId}`);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      publishInlineMessage({ type: "SUCCESS", text: "Photo deleted." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  async function saveDescription(photoId: string) {
    try {
      await apiPatch(`/api/admin/equipment/${equipmentId}/photos/${photoId}`, { description: editDesc });
      setPhotos((prev) => prev.map((p) => p.id === photoId ? { ...p, description: editDesc.trim() || null } : p));
      setEditingId(null);
      publishInlineMessage({ type: "SUCCESS", text: "Description saved." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    }
  }

  function pickFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void handleUpload(file);
    };
    input.click();
  }

  if (loading) return null;

  // Hide entirely for workers when there are no photos
  if (readOnly && photos.length === 0) return null;

  const canUpload = !readOnly && photos.length < 10;

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
              alt={photo.description || "Equipment photo"}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </Box>
        ))}
        {canUpload && (
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

      {/* Description editor (admin only) */}
      {!readOnly && photos.map((photo) => (
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
              <Button size="xs" variant="ghost" colorPalette="red" onClick={() => { void handleDelete(photo.id); setEditingId(null); }}>
                <Trash2 size={12} /> Delete
              </Button>
            </HStack>
          </VStack>
        ) : null
      ))}

      {/* Full-size viewer with navigation */}
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
            onTouchStart={(e) => { (e.currentTarget as any)._touchX = e.touches[0].clientX; }}
            onTouchEnd={(e) => {
              const dx = e.changedTouches[0].clientX - ((e.currentTarget as any)._touchX ?? 0);
              if (Math.abs(dx) > 50) { dx < 0 ? navigate(1) : navigate(-1); }
            }}
            tabIndex={0}
            ref={(el: HTMLDivElement | null) => el?.focus()}
          >
            {hasPrev && (
              <Box position="absolute" left="3" top="50%" transform="translateY(-50%)" color="white" fontSize="2xl" cursor="pointer" p={2} onClick={(e) => { e.stopPropagation(); navigate(-1); }} userSelect="none">◀</Box>
            )}
            <img
              src={photo.url}
              alt={photo.description || "Equipment photo"}
              style={{ maxWidth: "90vw", maxHeight: "70vh", objectFit: "contain", borderRadius: "8px" }}
              onClick={(e) => e.stopPropagation()}
            />
            {photo.description && (
              <Box mt={3} px={4} py={2} bg="blackAlpha.600" borderRadius="md" maxW="90vw" onClick={(e) => e.stopPropagation()}>
                <Text color="white" fontSize="sm" textAlign="center">{photo.description}</Text>
              </Box>
            )}
            <HStack position="absolute" bottom="4" gap={3} onClick={(e) => e.stopPropagation()}>
              <Text color="whiteAlpha.700" fontSize="sm">
                {viewerIndex + 1} / {photos.length}
              </Text>
              {!readOnly && (
                <Button size="xs" variant="ghost" color="whiteAlpha.800" onClick={() => { setEditingId(photo.id); setEditDesc(photo.description ?? ""); setViewerIndex(null); }}>
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
