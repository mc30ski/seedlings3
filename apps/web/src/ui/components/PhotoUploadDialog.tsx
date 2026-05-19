"use client";

// Batch photo-upload dialog. Replaces the previous per-photo redact-then-upload
// queue with a single review screen. User sees every picked photo as a
// thumbnail, can blur or remove individual photos, then taps "Upload all"
// once. Per-tile status (pending → uploading → uploaded / failed) stays
// visible throughout — important on mobile / slow networks where the
// previous flow gave no indication that anything was happening.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { AlertTriangle, Check, RotateCw, X } from "lucide-react";
import RedactPhotoDialog from "@/src/ui/components/RedactPhotoDialog";

type Status = "pending" | "uploading" | "uploaded" | "failed";

type UploadItem = {
  id: string;
  file: File;
  thumbUrl: string;
  status: Status;
  error?: string;
  redacted: boolean;
};

type Props = {
  /** Files freshly picked from the file input. Pass `null` (or empty) to
   *  keep the dialog closed. */
  files: File[] | null;
  /** Caller-supplied upload. Should throw on failure. */
  onUpload: (file: File) => Promise<void>;
  /** Fired when the user closes the dialog. The caller decides what to do
   *  (refresh the photo list, surface a toast summary, etc.). */
  onClose: (summary: { uploaded: number; failed: number; canceled: number }) => void;
  /** Hint for the header/toast wording (online vs queued for sync). */
  isOffline?: boolean;
};

function newId() {
  return Math.random().toString(36).slice(2);
}

export default function PhotoUploadDialog({ files, onUpload, onClose, isOffline }: Props) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [redactingId, setRedactingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canceledRef = useRef(0);

  // Seed items when a new batch is handed in. Cleans up object URLs on
  // close / replace so we don't leak memory.
  useEffect(() => {
    if (!files || files.length === 0) {
      setItems((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
        return [];
      });
      return;
    }
    const seeded: UploadItem[] = files.map((file) => ({
      id: newId(),
      file,
      thumbUrl: URL.createObjectURL(file),
      status: "pending",
      redacted: false,
    }));
    setItems((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
      return seeded;
    });
    canceledRef.current = 0;
    setBusy(false);
    setRedactingId(null);
  }, [files]);

  const open = !!files && files.length > 0;
  const counts = useMemo(() => {
    const c = { pending: 0, uploading: 0, uploaded: 0, failed: 0 };
    for (const it of items) c[it.status]++;
    return c;
  }, [items]);
  const allDone = items.length > 0 && counts.pending === 0 && counts.uploading === 0;
  const anyToUpload = counts.pending > 0 || counts.failed > 0;

  // Sequential upload — one at a time so a flaky mobile connection doesn't
  // open N concurrent POSTs and choke. Per-item state flips as we go so the
  // user always sees what's happening.
  //
  // We snapshot the work list (id + file) before the loop so we can rely on
  // synchronous file refs. The previous approach (`let file = null`
  // reassigned inside a setItems updater) was fragile under React 18's
  // batching — if the updater ran async the file was still null and the
  // iteration was skipped, masking the actual upload.
  const startUpload = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const toProcess = items
      .filter((it) => it.status === "pending" || it.status === "failed")
      .map((it) => ({ id: it.id, file: it.file }));
    for (const job of toProcess) {
      setItems((prev) => prev.map((it) => it.id === job.id ? { ...it, status: "uploading", error: undefined } : it));
      try {
        await onUpload(job.file);
        setItems((prev) => prev.map((it) => it.id === job.id ? { ...it, status: "uploaded" } : it));
      } catch (err: any) {
        const msg = err?.message ?? "Upload failed";
        console.error(`Photo upload failed for ${job.file.name}:`, err);
        setItems((prev) => prev.map((it) => it.id === job.id ? { ...it, status: "failed", error: msg } : it));
      }
    }
    setBusy(false);
  }, [busy, items, onUpload]);

  const handleRemove = useCallback((id: string) => {
    setItems((prev) => {
      const next: UploadItem[] = [];
      for (const it of prev) {
        if (it.id === id) {
          URL.revokeObjectURL(it.thumbUrl);
          if (it.status === "pending" || it.status === "failed") canceledRef.current += 1;
        } else {
          next.push(it);
        }
      }
      return next;
    });
  }, []);

  const handleRedactCommit = useCallback((newFile: File) => {
    if (!redactingId) return;
    setItems((prev) => prev.map((it) => {
      if (it.id !== redactingId) return it;
      URL.revokeObjectURL(it.thumbUrl);
      return {
        ...it,
        file: newFile,
        thumbUrl: URL.createObjectURL(newFile),
        redacted: true,
      };
    }));
    setRedactingId(null);
  }, [redactingId]);

  const handleClose = useCallback(() => {
    // Don't allow close mid-upload.
    if (busy) return;
    const uploaded = counts.uploaded;
    const failed = counts.failed;
    const canceled = canceledRef.current;
    canceledRef.current = 0;
    onClose({ uploaded, failed, canceled });
  }, [busy, counts.uploaded, counts.failed, onClose]);

  const redactingFile = items.find((it) => it.id === redactingId)?.file ?? null;

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(e) => { if (!e.open) handleClose(); }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>
                  {busy
                    ? `Uploading ${counts.uploaded + counts.uploading}/${items.length} photos…`
                    : allDone
                      ? counts.failed > 0
                        ? `Uploaded ${counts.uploaded} of ${items.length} — ${counts.failed} failed`
                        : isOffline
                          ? `${items.length} photo${items.length === 1 ? "" : "s"} queued for upload`
                          : `Uploaded ${items.length} photo${items.length === 1 ? "" : "s"}`
                      : `Review & upload ${items.length} photo${items.length === 1 ? "" : "s"}`}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {!busy && !allDone && (
                  <Box
                    mb={3}
                    p={3}
                    bg="blue.50"
                    borderWidth="1px"
                    borderColor="blue.300"
                    borderLeftWidth="4px"
                    borderLeftColor="blue.500"
                    rounded="md"
                  >
                    <Text fontSize="sm" color="blue.900">
                      Tap a photo to hide sensitive areas (black out or blur, optional). Tap the X to remove a photo from this batch.
                    </Text>
                  </Box>
                )}
                {busy && (
                  <HStack
                    p={2}
                    mb={3}
                    bg="blue.50"
                    borderWidth="1px"
                    borderColor="blue.200"
                    rounded="md"
                    gap={2}
                  >
                    <Spinner size="sm" />
                    <Text fontSize="sm" color="blue.900">
                      Don&apos;t close this dialog — uploads are in progress.
                    </Text>
                  </HStack>
                )}

                <Box
                  display="grid"
                  gridTemplateColumns={{ base: "repeat(3, 1fr)", md: "repeat(4, 1fr)" }}
                  gap={2}
                  maxH="60vh"
                  overflowY="auto"
                >
                  {items.map((it) => (
                    <PhotoTile
                      key={it.id}
                      item={it}
                      disabled={busy}
                      onRemove={() => handleRemove(it.id)}
                      onBlur={() => setRedactingId(it.id)}
                    />
                  ))}
                </Box>
              </Dialog.Body>
              <Dialog.Footer>
                <VStack w="full" gap={2}>
                  {!allDone && (
                    <Button
                      w="full"
                      colorPalette="blue"
                      onClick={() => void startUpload()}
                      loading={busy}
                      disabled={busy || !anyToUpload || items.length === 0}
                    >
                      {counts.failed > 0 && counts.pending === 0
                        ? `Retry ${counts.failed} failed`
                        : counts.failed > 0
                          ? `Upload ${counts.pending + counts.failed} (incl. ${counts.failed} retry)`
                          : `Upload all (${counts.pending})`}
                    </Button>
                  )}
                  <Button
                    w="full"
                    variant={allDone ? "solid" : "ghost"}
                    colorPalette={allDone ? "green" : "gray"}
                    onClick={handleClose}
                    disabled={busy}
                  >
                    {allDone ? "Done" : "Cancel"}
                  </Button>
                </VStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Per-photo blur step — nested on top of this dialog. */}
      <RedactPhotoDialog
        file={redactingFile}
        onCommit={handleRedactCommit}
        onCancel={() => setRedactingId(null)}
      />
    </>
  );
}

function PhotoTile({
  item,
  disabled,
  onRemove,
  onBlur,
}: {
  item: UploadItem;
  disabled: boolean;
  onRemove: () => void;
  onBlur: () => void;
}) {
  const isUploading = item.status === "uploading";
  const isUploaded = item.status === "uploaded";
  const isFailed = item.status === "failed";
  // Whole tile is the Blur trigger when the photo isn't locked in by upload.
  // Hint text "Tap a photo to blur sensitive areas" promised this — making
  // only a tiny corner icon clickable made the dialog feel broken (tapping
  // the photo seemed to do nothing or close the dialog by accident).
  const tileClickable = !disabled && !isUploading && !isUploaded;

  return (
    <Box
      position="relative"
      rounded="md"
      overflow="hidden"
      borderWidth="1px"
      borderColor="gray.200"
      bg="gray.50"
      cursor={tileClickable ? "pointer" : "default"}
      onClick={(e: any) => {
        // Stop the event from bubbling to the Dialog backdrop / surrounding
        // card so the dialog stays open and the parent card doesn't react.
        e.stopPropagation();
        if (tileClickable) onBlur();
      }}
      _hover={tileClickable ? { borderColor: "purple.400" } : undefined}
    >
      <Box css={{ aspectRatio: "1" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.thumbUrl}
          alt={item.file.name}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: isUploading ? 0.5 : isUploaded ? 0.85 : 1,
            filter: isFailed ? "grayscale(0.5)" : "none",
            // Avoid the image swallowing pointer events — the parent Box owns
            // the onClick so the whole tile responds consistently.
            pointerEvents: "none",
          }}
        />
      </Box>

      {/* Status overlay — center icon while uploading / done / failed */}
      {isUploading && (
        <Box position="absolute" inset="0" display="flex" alignItems="center" justifyContent="center" pointerEvents="none">
          <Spinner size="md" color="blue.600" borderWidth="3px" />
        </Box>
      )}
      {isUploaded && (
        <Box
          position="absolute"
          top="1"
          right="1"
          w="24px"
          h="24px"
          rounded="full"
          bg="green.500"
          color="white"
          display="flex"
          alignItems="center"
          justifyContent="center"
          pointerEvents="none"
        >
          <Check size={14} />
        </Box>
      )}
      {isFailed && (
        <Box
          position="absolute"
          inset="0"
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          bg="blackAlpha.500"
          color="white"
          p={1}
          pointerEvents="none"
        >
          <AlertTriangle size={18} />
          <Text fontSize="2xs" mt={1}>Failed</Text>
        </Box>
      )}

      {/* "Edited" tag — applied when the user committed at least one
          black-out or blur region in the redact dialog. */}
      {item.redacted && !isFailed && (
        <Box
          position="absolute"
          bottom="1"
          left="1"
          px="1.5"
          py="0.5"
          rounded="sm"
          bg="purple.500"
          color="white"
          fontSize="2xs"
          fontWeight="semibold"
          pointerEvents="none"
        >
          Edited
        </Box>
      )}

      {/* Remove from batch — small corner button. Hidden during upload +
          after success (no point removing what's already uploaded). */}
      {!disabled && !isUploading && !isUploaded && (
        <Box
          as="button"
          position="absolute"
          top="1"
          right="1"
          w="22px"
          h="22px"
          rounded="full"
          bg="blackAlpha.700"
          color="white"
          display="flex"
          alignItems="center"
          justifyContent="center"
          _hover={{ bg: "red.500" }}
          title="Remove from batch"
          onClick={(e: any) => { e.stopPropagation(); onRemove(); }}
        >
          <X size={12} />
        </Box>
      )}

      {/* Failed state — small retry indicator */}
      {isFailed && !disabled && (
        <Box
          position="absolute"
          bottom="1"
          right="1"
          w="22px"
          h="22px"
          rounded="full"
          bg="white"
          color="red.600"
          display="flex"
          alignItems="center"
          justifyContent="center"
          borderWidth="1px"
          borderColor="red.300"
          title="Will retry on next upload"
          pointerEvents="none"
        >
          <RotateCw size={12} />
        </Box>
      )}
    </Box>
  );
}
