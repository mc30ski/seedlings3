"use client";

import { useEffect, useRef, useState, useCallback } from "react";
// @ts-ignore
import ReactDOM from "react-dom";
import {
  Box,
  Button,
  HStack,
  Image,
  SimpleGrid,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Camera, ChevronLeft, ChevronRight, ImageIcon, Trash2 } from "lucide-react";
import { apiGet, apiPost, apiDelete } from "@/src/lib/api";
import { type OccurrencePhoto } from "@/src/lib/types";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Props = {
  occurrenceId: string;
  /** Use admin endpoints for viewing/deleting */
  isAdmin?: boolean;
  /** Allow uploads (workers on their own occurrences) */
  canUpload?: boolean;
  /** Number of photos (from _count) to show in the header */
  photoCount?: number;
};

/** Compress an image file client-side: max 1200px, 80% JPEG quality. */
async function compressImage(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const MAX = 1200;
      let w = img.width;
      let h = img.height;
      if (w > MAX || h > MAX) {
        const ratio = Math.min(MAX / w, MAX / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Compression failed"))),
        "image/jpeg",
        0.8,
      );
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Persistent file input that lives at document.body level.
 * Prevents unmounting when a parent card collapses.
 */
function useFileUpload(onFiles: (files: FileList) => void) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      if (input.files && input.files.length > 0) {
        onFiles(input.files);
      }
      input.value = "";
    });
    document.body.appendChild(input);
    inputRef.current = input;
    return () => {
      document.body.removeChild(input);
      inputRef.current = null;
    };
  }, [onFiles]);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  return openPicker;
}

export default function OccurrencePhotos({ occurrenceId, isAdmin, canUpload, photoCount }: Props) {
  const [photos, setPhotos] = useState<OccurrencePhoto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [viewPhoto, setViewPhoto] = useState<OccurrencePhoto | null>(null);
  const [expanded, setExpanded] = useState(false);

  const basePath = isAdmin ? `/api/admin/occurrences/${occurrenceId}/photos` : `/api/occurrences/${occurrenceId}/photos`;

  async function loadPhotos(force = false) {
    if (!force && loaded) return;
    setLoading(true);
    try {
      const list = await apiGet<OccurrencePhoto[]>(basePath);
      setPhotos(Array.isArray(list) ? list : []);
      setLoaded(true);
    } catch (err) {
      console.error("Failed to load photos:", err);
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }

  // Always load on mount to get accurate count
  useEffect(() => {
    void loadPhotos();
  }, [occurrenceId]);

  const displayCount = loaded ? photos.length : (photoCount ?? 0);

  const handleFiles = useCallback(async (files: FileList) => {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const compressed = await compressImage(file);

        const { uploadUrl, key } = await apiPost<{ uploadUrl: string; key: string }>(
          `/api/occurrences/${occurrenceId}/photos/upload-url`,
          { fileName: file.name, contentType: "image/jpeg" },
        );

        const uploadRes = await fetch(uploadUrl, {
          method: "PUT",
          body: compressed,
          headers: { "Content-Type": "image/jpeg" },
        });
        if (!uploadRes.ok) {
          throw new Error(`R2 upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
        }

        await apiPost(`/api/occurrences/${occurrenceId}/photos/confirm`, {
          key,
          fileName: file.name,
          contentType: "image/jpeg",
        });
      }
      publishInlineMessage({ type: "SUCCESS", text: `${files.length} photo${files.length > 1 ? "s" : ""} uploaded.` });
      setExpanded(true);
      await loadPhotos(true);
    } catch (err) {
      console.error("Photo upload error:", err);
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Upload failed.", err) });
    } finally {
      setUploading(false);
    }
  }, [occurrenceId]);

  const openPicker = useFileUpload(handleFiles);

  async function handleDelete(photo: OccurrencePhoto) {
    try {
      if (isAdmin) {
        await apiDelete(`/api/admin/photos/${photo.id}`);
      } else {
        await apiDelete(`/api/occurrences/${occurrenceId}/photos/${photo.id}`);
      }
      publishInlineMessage({ type: "SUCCESS", text: "Photo deleted." });
      setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
      if (viewPhoto?.id === photo.id) setViewPhoto(null);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  const viewIndex = viewPhoto ? photos.findIndex((p) => p.id === viewPhoto.id) : -1;
  const hasPrev = viewIndex > 0;
  const hasNext = viewIndex >= 0 && viewIndex < photos.length - 1;

  return (
    <VStack align="start" gap={1} w="full">
      <HStack gap={2} onClick={(e) => e.stopPropagation()}>
        {displayCount > 0 && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setExpanded((p) => !p)}
          >
            <ImageIcon size={14} />
            Photos ({displayCount})
          </Button>
        )}
        {canUpload && displayCount < 10 && (
          <Button
            size="xs"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              openPicker();
            }}
            loading={uploading}
          >
            <Camera size={14} />
            Add Photos ({displayCount}/10)
          </Button>
        )}
        {canUpload && displayCount >= 10 && (
          <Text fontSize="xs" color="fg.muted">Max 10 photos reached</Text>
        )}
      </HStack>

      {expanded && loading && <Spinner size="sm" />}

      {expanded && photos.length > 0 && (
        <SimpleGrid columns={{ base: 3, md: 4 }} gap={2} w="full">
          {photos.map((p) => (
            <Box
              key={p.id}
              position="relative"
              borderRadius="md"
              overflow="hidden"
              cursor="pointer"
              onClick={(e) => { e.stopPropagation(); setViewPhoto(p); }}
              css={{ aspectRatio: "1", "& img": { objectFit: "cover", width: "100%", height: "100%" } }}
            >
              <Image
                src={p.url}
                alt={p.fileName ?? "Photo"}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                  (e.target as HTMLImageElement).parentElement!.innerHTML =
                    '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:#999;font-size:11px;text-align:center;padding:4px">Photo expired</div>';
                }}
              />
            </Box>
          ))}
        </SimpleGrid>
      )}

      {/* Full-size photo viewer — dark overlay like Client tab */}
      {viewPhoto && typeof document !== "undefined" && ReactDOM.createPortal(
        <Box
          position="fixed"
          inset="0"
          zIndex="9999"
          bg="blackAlpha.800"
          display="flex"
          alignItems="center"
          justifyContent="center"
          onMouseDown={() => setViewPhoto(null)}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Navigation: prev */}
          {hasPrev && (
            <Box
              position="absolute"
              left="3"
              top="50%"
              transform="translateY(-50%)"
              color="white"
              fontSize="2xl"
              cursor="pointer"
              p={2}
              zIndex={1}
              onMouseDown={(e) => { e.stopPropagation(); setViewPhoto(photos[viewIndex - 1]); }}
              userSelect="none"
            >
              <ChevronLeft size={28} />
            </Box>
          )}

          {/* Image */}
          <img
            src={viewPhoto.url}
            alt={viewPhoto.fileName ?? "Photo"}
            style={{ maxWidth: "90vw", maxHeight: "80vh", objectFit: "contain", borderRadius: "8px" }}
            onMouseDown={(e) => e.stopPropagation()}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />

          {/* Navigation: next */}
          {hasNext && (
            <Box
              position="absolute"
              right="3"
              top="50%"
              transform="translateY(-50%)"
              color="white"
              fontSize="2xl"
              cursor="pointer"
              p={2}
              zIndex={1}
              onMouseDown={(e) => { e.stopPropagation(); setViewPhoto(photos[viewIndex + 1]); }}
              userSelect="none"
            >
              <ChevronRight size={28} />
            </Box>
          )}

          {/* Bottom bar: info + delete */}
          <HStack
            position="absolute"
            bottom="4"
            left="0"
            right="0"
            justify="center"
            gap={4}
            px={4}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <Text color="whiteAlpha.700" fontSize="sm">
              {viewIndex + 1} / {photos.length} · {viewPhoto.uploadedBy?.displayName ?? "Unknown"} · {new Date(viewPhoto.createdAt).toLocaleString()}
            </Text>
            <Button
              size="xs"
              variant="ghost"
              color="red.300"
              _hover={{ color: "red.200", bg: "whiteAlpha.200" }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => viewPhoto && handleDelete(viewPhoto)}
            >
              <Trash2 size={14} />
              Delete
            </Button>
          </HStack>
        </Box>,
        document.body
      )}
    </VStack>
  );
}
