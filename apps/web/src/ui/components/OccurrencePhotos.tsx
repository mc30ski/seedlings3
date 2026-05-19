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
import { fmtDateTime } from "@/src/lib/lib";
import { compressOnly } from "@/src/lib/imageRedact";
import PhotoUploadDialog from "@/src/ui/components/PhotoUploadDialog";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { useOffline } from "@/src/lib/offline";
import { enqueueAction } from "@/src/lib/offlineQueue";

type Props = {
  occurrenceId: string;
  /** Use admin endpoints for viewing/deleting */
  isAdmin?: boolean;
  /** Allow uploads (workers on their own occurrences) */
  canUpload?: boolean;
  /** Number of photos (from _count) to show in the header */
  photoCount?: number;
};


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
  const { isOffline } = useOffline();
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

  // Per-job photo cap — read from the MAX_PHOTOS_PER_JOB setting at mount
  // so the Add Photos button hides at the right threshold. Falls back to 10
  // (historical default) when the setting is missing or unparseable. Lowering
  // the cap only restricts future uploads; the API gates the actual write.
  const [maxPhotos, setMaxPhotos] = useState<number>(10);
  useEffect(() => {
    apiGet<Array<{ key: string; value: string }>>("/api/settings")
      .then((list) => {
        if (!Array.isArray(list)) return;
        const row = list.find((s) => s.key === "MAX_PHOTOS_PER_JOB");
        const n = Number(row?.value);
        if (Number.isFinite(n) && n > 0) setMaxPhotos(Math.floor(n));
      })
      .catch(() => {});
  }, []);

  const displayCount = loaded ? photos.length : (photoCount ?? 0);

  // Batch upload — files picked are handed to PhotoUploadDialog which lets
  // the user blur/remove individual photos before tapping "Upload all". Per-
  // tile status (pending → uploading → uploaded / failed) keeps progress
  // visible throughout the batch, which matters on slow mobile connections.
  const [batchFiles, setBatchFiles] = useState<File[] | null>(null);

  // Single-file upload (compress + R2 + confirm; handles offline queue too).
  // Throws on failure so the dialog can mark the tile failed.
  const uploadOneFile = useCallback(async (file: File) => {
    const compressed = await compressOnly(file);

    if (isOffline) {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.includes(",") ? result.split(",")[1] : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(compressed);
      });
      await enqueueAction("ADD_PHOTO", occurrenceId, `Photo: ${file.name}`, {
        base64,
        fileName: file.name,
        contentType: "image/jpeg",
      });
      return;
    }

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
  }, [occurrenceId, isOffline]);

  const handleFiles = useCallback((files: FileList) => {
    if (files.length === 0) return;
    setUploading(true);
    setBatchFiles(Array.from(files));
  }, []);

  const handleBatchClose = useCallback((summary: { uploaded: number; failed: number; canceled: number }) => {
    setBatchFiles(null);
    setUploading(false);
    const { uploaded, failed, canceled } = summary;
    if (uploaded > 0) {
      const tail = [
        failed ? `${failed} failed` : null,
        canceled ? `${canceled} canceled` : null,
      ].filter(Boolean).join(", ");
      if (isOffline) {
        publishInlineMessage({
          type: "INFO",
          text: `${uploaded} photo${uploaded === 1 ? "" : "s"} queued for upload when online${tail ? ` (${tail})` : ""}.`,
        });
      } else {
        publishInlineMessage({
          type: "SUCCESS",
          text: `${uploaded} photo${uploaded === 1 ? "" : "s"} uploaded${tail ? ` (${tail})` : ""}.`,
        });
        setExpanded(true);
        void loadPhotos(true);
      }
    } else if (failed > 0) {
      publishInlineMessage({ type: "ERROR", text: `Upload failed for ${failed} photo${failed === 1 ? "" : "s"}.` });
    } else if (canceled > 0) {
      publishInlineMessage({ type: "INFO", text: "Upload canceled." });
    }
  }, [isOffline]);

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
        {canUpload && displayCount < maxPhotos && (
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
            Add Photos ({displayCount}/{maxPhotos})
          </Button>
        )}
        {canUpload && displayCount >= maxPhotos && (
          <Text fontSize="xs" color="fg.muted">Max {maxPhotos} photos reached</Text>
        )}
      </HStack>

      {expanded && loading && <Spinner size="sm" />}

      {expanded && photos.length > 0 && (
        <SimpleGrid columns={{ base: 3, md: 4 }} gap={2} w="full" maxH="200px" overflowY="auto" overflowX="hidden">
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

      {/* Full-size photo viewer — dark overlay */}
      {viewPhoto && <PhotoViewer
        photos={photos}
        viewPhoto={viewPhoto}
        viewIndex={viewIndex}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onClose={() => setViewPhoto(null)}
        onPrev={() => hasPrev && setViewPhoto(photos[viewIndex - 1])}
        onNext={() => hasNext && setViewPhoto(photos[viewIndex + 1])}
        onDelete={handleDelete}
      />}

      {/* Batch review / upload dialog. Lets the worker blur or remove
          individual photos before sending, then shows per-photo progress
          throughout the upload. */}
      <PhotoUploadDialog
        files={batchFiles}
        onUpload={uploadOneFile}
        onClose={handleBatchClose}
        isOffline={isOffline}
      />
    </VStack>
  );
}

/** Fullscreen photo viewer with keyboard arrows + swipe */
function PhotoViewer({
  photos,
  viewPhoto,
  viewIndex,
  hasPrev,
  hasNext,
  onClose,
  onPrev,
  onNext,
  onDelete,
}: {
  photos: OccurrencePhoto[];
  viewPhoto: OccurrencePhoto;
  viewIndex: number;
  hasPrev: boolean;
  hasNext: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onDelete: (photo: OccurrencePhoto) => void;
}) {
  const touchXRef = useRef<number | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") { e.preventDefault(); onPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); onNext(); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onPrev, onNext, onClose]);

  if (typeof document === "undefined") return null;

  return ReactDOM.createPortal(
    <Box
      position="fixed"
      inset="0"
      zIndex="9999"
      bg="blackAlpha.800"
      display="flex"
      alignItems="center"
      justifyContent="center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onTouchStart={(e) => { touchXRef.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (touchXRef.current === null) return;
        const dx = e.changedTouches[0].clientX - touchXRef.current;
        touchXRef.current = null;
        if (Math.abs(dx) > 50) {
          if (dx < 0) onNext();
          else onPrev();
        }
      }}
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
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
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
        onClick={(e) => e.stopPropagation()}
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
          onClick={(e) => { e.stopPropagation(); onNext(); }}
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
        onClick={(e) => e.stopPropagation()}
      >
        <Text color="whiteAlpha.700" fontSize="sm">
          {viewIndex + 1} / {photos.length} · {viewPhoto.uploadedBy?.displayName ?? "Unknown"} · {fmtDateTime(viewPhoto.createdAt)}
        </Text>
        <Button
          size="xs"
          variant="ghost"
          color="red.300"
          _hover={{ color: "red.200", bg: "whiteAlpha.200" }}
          onClick={() => onDelete(viewPhoto)}
        >
          <Trash2 size={14} />
          Delete
        </Button>
      </HStack>
    </Box>,
    document.body
  );
}
