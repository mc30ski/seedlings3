"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Button, HStack, Spinner, Text, Textarea, VStack } from "@chakra-ui/react";
import { Camera, ChevronDown, ChevronUp, Pencil, Trash2, Upload } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import { compressOnly } from "@/src/lib/imageRedact";
import { useFileUpload } from "@/src/lib/useFileUpload";
import PhotoUploadDialog from "@/src/ui/components/PhotoUploadDialog";

type PropertyPhoto = {
  id: string;
  url: string;
  fileName?: string | null;
  description?: string | null;
  sortOrder: number;
};

type Props = {
  propertyId: string;
  readOnly?: boolean;
};

export default function PropertyPhotosManager({ propertyId, readOnly }: Props) {
  const [photos, setPhotos] = useState<PropertyPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function load() {
    try {
      const endpoint = readOnly ? `/api/properties/${propertyId}/photos` : `/api/admin/properties/${propertyId}/photos`;
      const list = await apiGet<PropertyPhoto[]>(endpoint);
      setPhotos(Array.isArray(list) ? list : []);
    } catch {
      setPhotos([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [propertyId]);

  // Single-file upload — compress, get a signed R2 URL, PUT, then confirm
  // the row on the API. Throws on failure so PhotoUploadDialog can mark the
  // tile failed and offer retry.
  const uploadOneFile = useCallback(async (file: File) => {
    const compressed = await compressOnly(file);
    const contentType = "image/jpeg";
    const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
      `/api/admin/properties/${propertyId}/photos/upload-url`,
      { fileName: file.name, contentType },
    );
    const uploadRes = await fetch(uploadUrl, { method: "PUT", body: compressed, headers: { "Content-Type": contentType } });
    if (!uploadRes.ok) {
      throw new Error(`R2 upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
    }
    await apiPost(`/api/admin/properties/${propertyId}/photos/confirm`, {
      key, fileName: file.name, contentType,
    });
  }, [propertyId]);

  // Batch upload — the picker hands FileList off to PhotoUploadDialog which
  // shows per-tile progress (pending → uploading → uploaded / failed) and
  // lets the user retry or drop individual files. Mirrors OccurrencePhotos.
  const [batchFiles, setBatchFiles] = useState<File[] | null>(null);

  const handleFiles = useCallback((files: FileList) => {
    if (files.length === 0) return;
    setUploading(true);
    setBatchFiles(Array.from(files));
  }, []);

  const handleBatchClose = useCallback(async (summary: { uploaded: number; failed: number; canceled: number }) => {
    setBatchFiles(null);
    setUploading(false);
    const { uploaded, failed, canceled } = summary;
    if (uploaded > 0) await load();
    const tail = [
      failed ? `${failed} failed` : null,
      canceled ? `${canceled} canceled` : null,
    ].filter(Boolean).join(", ");
    if (uploaded > 0) {
      publishInlineMessage({
        type: "SUCCESS",
        text: `${uploaded} photo${uploaded === 1 ? "" : "s"} uploaded${tail ? ` (${tail})` : ""}.`,
      });
    } else if (failed > 0) {
      publishInlineMessage({ type: "ERROR", text: `Upload failed for ${failed} photo${failed === 1 ? "" : "s"}.` });
    } else if (canceled > 0) {
      publishInlineMessage({ type: "INFO", text: "Upload canceled." });
    }
  }, []);

  const openPicker = useFileUpload(handleFiles);

  async function handleDelete(photoId: string) {
    try {
      await apiDelete(`/api/admin/properties/${propertyId}/photos/${photoId}`);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
      publishInlineMessage({ type: "SUCCESS", text: "Photo deleted." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  async function saveDescription(photoId: string) {
    try {
      await apiPatch(`/api/admin/properties/${propertyId}/photos/${photoId}`, { description: editDesc });
      setPhotos((prev) => prev.map((p) => p.id === photoId ? { ...p, description: editDesc.trim() || null } : p));
      setEditingId(null);
      publishInlineMessage({ type: "SUCCESS", text: "Description saved." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    }
  }

  if (loading) return <HStack gap={2} py={2}><Spinner size="sm" /><Text fontSize="xs" color="fg.muted">Loading photos...</Text></HStack>;

  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
      <HStack
        px={3} py={2}
        cursor="pointer"
        onClick={() => setExpanded((v) => !v)}
        justify="space-between"
        bg="gray.50"
      >
        <HStack gap={1.5} fontSize="xs" fontWeight="semibold" color="fg.muted">
          <Camera size={14} />
          <Text>Property Photos ({photos.length})</Text>
        </HStack>
        <HStack gap={1}>
          {!readOnly && expanded && (
            <Button
              size="xs"
              variant="outline"
              loading={uploading}
              onClick={(e) => {
                e.stopPropagation();
                openPicker();
              }}
            >
              <Upload size={12} /> Upload
            </Button>
          )}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </HStack>
      </HStack>

      {expanded && photos.length === 0 && (
        <Text fontSize="xs" color="fg.muted" px={3} py={2}>
          {readOnly ? "No property photos." : "No property photos yet. Upload photos to provide visual guidance for workers."}
        </Text>
      )}

      {expanded && <VStack align="stretch" gap={2} p={2}>
        {photos.map((photo, idx) => (
          <HStack key={photo.id} gap={3} p={2} borderWidth="1px" borderColor="gray.200" borderRadius="md" align="start">
            <Box
              flexShrink={0}
              w="80px"
              h="80px"
              borderRadius="md"
              overflow="hidden"
              cursor="pointer"
              onClick={() => setViewerIndex(idx)}
            >
              <img
                src={photo.url}
                alt={photo.description || "Property photo"}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </Box>
            <VStack align="start" gap={1} flex="1" minW={0}>
              {!readOnly && editingId === photo.id ? (
                <VStack align="stretch" gap={1} w="full">
                  <Textarea
                    size="sm"
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    placeholder="Describe what workers should do here…"
                    rows={2}
                  />
                  <HStack gap={1}>
                    <Button size="xs" colorPalette="blue" onClick={() => void saveDescription(photo.id)}>Save</Button>
                    <Button size="xs" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                  </HStack>
                </VStack>
              ) : (
                <>
                  <Text
                    fontSize="sm"
                    color={photo.description ? "fg.default" : "fg.muted"}
                    fontStyle={photo.description ? "normal" : "italic"}
                    cursor={readOnly ? undefined : "pointer"}
                    _hover={readOnly ? undefined : { color: "blue.500" }}
                    onClick={readOnly ? undefined : () => { setEditingId(photo.id); setEditDesc(photo.description ?? ""); }}
                  >
                    {photo.description || (readOnly ? "No description" : "Click to add description…")}
                  </Text>
                  {!readOnly && (
                    <HStack gap={1}>
                      <Button
                        size="xs"
                        variant="outline"
                        colorPalette="blue"
                        onClick={() => { setEditingId(photo.id); setEditDesc(photo.description ?? ""); }}
                      >
                        <Pencil size={12} /> Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        onClick={() => void handleDelete(photo.id)}
                      >
                        <Trash2 size={12} /> Delete
                      </Button>
                    </HStack>
                  )}
                </>
              )}
            </VStack>
          </HStack>
        ))}
      </VStack>}

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
            onClick={(e) => { e.stopPropagation(); setViewerIndex(null); }}
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
              alt={photo.description || "Property photo"}
              style={{ maxWidth: "90vw", maxHeight: "70vh", objectFit: "contain", borderRadius: "8px" }}
              onClick={(e) => e.stopPropagation()}
            />
            {photo.description && (
              <Box mt={3} px={4} py={2} bg="blackAlpha.600" borderRadius="md" maxW="90vw" onClick={(e) => e.stopPropagation()}>
                <Text color="white" fontSize="sm" textAlign="center">{photo.description}</Text>
              </Box>
            )}
            <Text position="absolute" bottom="4" color="whiteAlpha.700" fontSize="sm">
              {viewerIndex + 1} / {photos.length}
            </Text>
            {hasNext && (
              <Box position="absolute" right="3" top="50%" transform="translateY(-50%)" color="white" fontSize="2xl" cursor="pointer" p={2} onClick={(e) => { e.stopPropagation(); navigate(1); }} userSelect="none">▶</Box>
            )}
          </Box>
        );
      })()}

      <PhotoUploadDialog
        files={batchFiles}
        onUpload={uploadOneFile}
        onClose={handleBatchClose}
      />
    </Box>
  );
}
