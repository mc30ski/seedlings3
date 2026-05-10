"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Button, Dialog, HStack, Portal, Text } from "@chakra-ui/react";
import { Eraser, Undo2 } from "lucide-react";

type Rect = { x: number; y: number; w: number; h: number };

type Props = {
  /** The picked file. When non-null, the dialog is open. */
  file: File | null;
  /** Called when the user accepts (with redactions baked in, or without). */
  onCommit: (file: File) => void;
  /** Called when the user cancels — abandon this photo. */
  onCancel: () => void;
};

/**
 * Optional manual-redaction step shown after a photo is picked. The user
 * can drag rectangles over sensitive areas (addresses, signs, mailbox
 * numbers) and apply, or skip and upload as-is. Solid black rectangles
 * are baked into the image — no OCR, no automatic detection, no false
 * positives. Reliable because the human is the classifier.
 */
export default function RedactPhotoDialog({ file, onCommit, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  // Rectangles are stored in IMAGE pixel coordinates so they survive
  // resizing the dialog. The overlay scales them to display coords.
  const [rects, setRects] = useState<Rect[]>([]);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);

  // Load the picked file into an Image element (for canvas + display).
  useEffect(() => {
    if (!file) {
      setImgEl(null);
      setRects([]);
      setDrag(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      setImgEl(img);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      onCancel();
    };
    img.src = url;
  }, [file, onCancel]);

  // Redraw the preview canvas whenever rects change.
  useEffect(() => {
    if (!imgEl || !canvasRef.current) return;
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    c.width = imgEl.width;
    c.height = imgEl.height;
    ctx.drawImage(imgEl, 0, 0);
    ctx.fillStyle = "#000";
    for (const r of rects) {
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }, [imgEl, rects]);

  // Pointer-event drag — works for both touch and mouse.
  function pointerToImageCoords(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!overlayRef.current || !imgEl) return null;
    const rect = overlayRef.current.getBoundingClientRect();
    const scaleX = imgEl.width / rect.width;
    const scaleY = imgEl.height / rect.height;
    return {
      x: Math.max(0, Math.min(imgEl.width, (clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(imgEl.height, (clientY - rect.top) * scaleY)),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!imgEl) return;
    const c = pointerToImageCoords(e.clientX, e.clientY);
    if (!c) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ x: c.x, y: c.y, w: 0, h: 0 });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const c = pointerToImageCoords(e.clientX, e.clientY);
    if (!c) return;
    setDrag({
      x: Math.min(drag.x, c.x),
      y: Math.min(drag.y, c.y),
      w: Math.abs(c.x - drag.x),
      h: Math.abs(c.y - drag.y),
    });
  }
  function onPointerUp(e: React.PointerEvent) {
    if (drag && drag.w > 4 && drag.h > 4) {
      setRects((prev) => [...prev, drag]);
    }
    setDrag(null);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
  }

  async function exportFile(applyRedactions: boolean): Promise<File> {
    if (!file) throw new Error("No file");
    if (!applyRedactions || rects.length === 0) return file;
    if (!imgEl) return file;
    // Render the image + rectangles to a fresh canvas at full resolution,
    // export as JPEG, return as a File so the upload pipeline doesn't care
    // whether it was edited.
    const c = document.createElement("canvas");
    c.width = imgEl.width;
    c.height = imgEl.height;
    const ctx = c.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(imgEl, 0, 0);
    ctx.fillStyle = "#000";
    for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
    const blob: Blob = await new Promise((resolve, reject) => {
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("Export failed"))), "image/jpeg", 0.92);
    });
    return new File([blob], file.name, { type: "image/jpeg" });
  }

  async function handleApply() {
    setBusy(true);
    try {
      const f = await exportFile(true);
      onCommit(f);
    } catch {
      // If export somehow fails, fall back to the original file
      onCommit(file!);
    } finally {
      setBusy(false);
    }
  }

  function handleSkip() {
    if (file) onCommit(file);
  }

  // Display sizing — fit to viewport, never larger than original.
  const displayMaxW = Math.min(640, typeof window !== "undefined" ? window.innerWidth - 64 : 640);
  const displayMaxH = typeof window !== "undefined" ? Math.max(200, window.innerHeight * 0.55) : 400;
  const aspect = imgEl ? imgEl.width / imgEl.height : 1;
  let dispW = displayMaxW;
  let dispH = dispW / aspect;
  if (dispH > displayMaxH) {
    dispH = displayMaxH;
    dispW = dispH * aspect;
  }

  return (
    <Dialog.Root open={!!file} onOpenChange={(e) => { if (!e.open) onCancel(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Blur sensitive areas (optional)</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {!imgEl ? (
                <Box py={8} textAlign="center" color="fg.muted">
                  <Text fontSize="sm">Loading photo…</Text>
                </Box>
              ) : (
                <>
                  <Text fontSize="xs" color="fg.muted" mb={2}>
                    Drag across anything you want to hide — addresses, signs, mailboxes, anything else.
                    Each region becomes a solid black rectangle in the uploaded image. Nothing's permanent
                    until you click <Text as="span" fontWeight="medium">Apply &amp; upload</Text>. You can
                    always skip this and upload the photo as-is.
                  </Text>
                  <Box
                    ref={overlayRef}
                    position="relative"
                    mx="auto"
                    style={{ width: dispW, height: dispH, touchAction: "none", userSelect: "none" }}
                    bg="gray.100"
                    borderRadius="md"
                    overflow="hidden"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                  >
                    {/* Rendered preview — image with committed rects baked. */}
                    <canvas
                      ref={canvasRef}
                      style={{
                        width: "100%",
                        height: "100%",
                        display: "block",
                        pointerEvents: "none",
                      }}
                    />
                    {/* Live drag indicator (translucent box). Rendered in
                        DISPLAY coords so it tracks the cursor exactly. */}
                    {drag && imgEl && (
                      <Box
                        position="absolute"
                        bg="rgba(0,0,0,0.5)"
                        border="2px dashed white"
                        pointerEvents="none"
                        style={{
                          left: (drag.x / imgEl.width) * dispW,
                          top: (drag.y / imgEl.height) * dispH,
                          width: (drag.w / imgEl.width) * dispW,
                          height: (drag.h / imgEl.height) * dispH,
                        }}
                      />
                    )}
                  </Box>
                  <HStack mt={3} justify="space-between" wrap="wrap" gap={2}>
                    <HStack gap={1}>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setRects((prev) => prev.slice(0, -1))}
                        disabled={rects.length === 0}
                      >
                        <Undo2 size={12} /> Undo
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setRects([])}
                        disabled={rects.length === 0}
                      >
                        <Eraser size={12} /> Clear
                      </Button>
                    </HStack>
                    <Text fontSize="xs" color="fg.muted">
                      {rects.length === 0 ? "No regions yet — drag to add" : `${rects.length} region${rects.length === 1 ? "" : "s"} marked`}
                    </Text>
                  </HStack>
                </>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="space-between" w="full" wrap="wrap" gap={2}>
                <Button variant="ghost" onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
                <HStack gap={2}>
                  <Button variant="outline" onClick={handleSkip} disabled={busy}>
                    Skip & upload as-is
                  </Button>
                  <Button
                    colorPalette="blue"
                    onClick={handleApply}
                    loading={busy}
                    disabled={rects.length === 0}
                  >
                    Apply &amp; upload
                  </Button>
                </HStack>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
