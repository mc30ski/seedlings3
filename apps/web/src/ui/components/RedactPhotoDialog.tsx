"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Button, Dialog, HStack, Portal, Text } from "@chakra-ui/react";
import { Droplet, Eraser, Square, Undo2 } from "lucide-react";
import { canvasToBlobWithTimeout } from "@/src/lib/imageRedact";

type RedactMode = "blackout" | "blur";
type Rect = { x: number; y: number; w: number; h: number; mode: RedactMode };

/**
 * Blur radius scales with the source image so a fresh 4000px phone photo
 * doesn't end up with a barely-visible blur and a downscaled 800px image
 * doesn't get pasted with a giant smear. Clamped to a sane range.
 */
function blurRadiusFor(imgEl: HTMLImageElement): number {
  return Math.max(8, Math.min(40, Math.round(imgEl.width * 0.015)));
}

/**
 * Paint a single redaction rect on the LIVE preview canvas (which is
 * sized to the source image). Blackout = solid #000 fill. Blur = clip to
 * the rect and re-draw the source image through a gaussian-blur filter,
 * so only the area inside the rect is blurred (the rest of the canvas
 * stays sharp). save/restore isolates the clip + filter changes from the
 * rest of the render.
 */
function paintRect(ctx: CanvasRenderingContext2D, imgEl: HTMLImageElement, r: Rect) {
  if (r.mode === "blur") {
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.filter = `blur(${blurRadiusFor(imgEl)}px)`;
    ctx.drawImage(imgEl, 0, 0);
    ctx.restore();
  } else {
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }
}

/**
 * Same as paintRect but for the export canvas, which may be smaller than
 * the source image. The rect is already in output-canvas coords (scaled
 * by the caller). For blur, drawImage paints the image stretched to the
 * output canvas dimensions; blur radius is scaled to the output width so
 * the visual blur amount matches what the user saw in the preview.
 */
function paintRectScaled(ctx: CanvasRenderingContext2D, imgEl: HTMLImageElement, r: Rect, outW: number) {
  if (r.mode === "blur") {
    const previewRadius = blurRadiusFor(imgEl);
    const scaledRadius = Math.max(2, Math.round(previewRadius * (outW / imgEl.width)));
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.filter = `blur(${scaledRadius}px)`;
    ctx.drawImage(imgEl, 0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  } else {
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }
}

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
 * drags rectangles over sensitive areas (addresses, signs, mailbox
 * numbers). Each region is independently either "Black out" (solid bar —
 * strongest privacy) or "Blur" (gaussian — softer, looks less aggressive).
 * Mode is per-rect, picked at draw time. Result is baked into the image —
 * no OCR, no automatic detection. Reliable because the human is the
 * classifier.
 */
export default function RedactPhotoDialog({ file, onCommit, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [wrapperW, setWrapperW] = useState<number>(0);
  // Rectangles are stored in IMAGE pixel coordinates so they survive
  // resizing the dialog. The overlay scales them to display coords.
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawMode, setDrawMode] = useState<RedactMode>("blackout");

  // Track the actual width of the wrapper inside Dialog.Body. Computing
  // displayMaxW from window.innerWidth is unreliable because Chakra's
  // Dialog.Body has internal padding on top of Dialog.Content's. Measuring
  // sidesteps that and stays correct on resize / orientation change.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const measure = () => setWrapperW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [imgEl]);

  // Load the picked file into an Image element (for canvas + display).
  useEffect(() => {
    if (!file) {
      setImgEl(null);
      setRects([]);
      setDrag(null);
      setDrawMode("blackout");
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

  // Redraw the preview canvas whenever rects change. Blur regions are baked
  // by re-drawing the source image with a clip + blur filter; black-out
  // regions are solid fill. Drawn in user order so later rects cover
  // earlier ones (last-drawn wins on overlap).
  useEffect(() => {
    if (!imgEl || !canvasRef.current) return;
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    c.width = imgEl.width;
    c.height = imgEl.height;
    ctx.drawImage(imgEl, 0, 0);
    for (const r of rects) {
      paintRect(ctx, imgEl, r);
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
    // Block the event from bubbling to the Dialog. Without this, a quick tap
    // (no drag) lets the synthesized click reach the backdrop and Chakra
    // dismisses the dialog before the user can do anything.
    e.stopPropagation();
    const c = pointerToImageCoords(e.clientX, e.clientY);
    if (!c) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ x: c.x, y: c.y, w: 0, h: 0, mode: drawMode });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    e.stopPropagation();
    const c = pointerToImageCoords(e.clientX, e.clientY);
    if (!c) return;
    setDrag({
      x: Math.min(drag.x, c.x),
      y: Math.min(drag.y, c.y),
      w: Math.abs(c.x - drag.x),
      h: Math.abs(c.y - drag.y),
      mode: drag.mode,
    });
  }
  function onPointerUp(e: React.PointerEvent) {
    e.stopPropagation();
    // Filter accidental taps & micro-drags. Threshold is in DISPLAY pixels
    // so it stays roughly finger-sized regardless of how large the source
    // image is. Without scaling, a fresh 4000px-wide phone photo would
    // happily save a 4-image-px rect that's <1 display px.
    if (drag && imgEl && overlayRef.current) {
      const rect = overlayRef.current.getBoundingClientRect();
      const dispMinPx = 8;
      const minImgW = (imgEl.width / rect.width) * dispMinPx;
      const minImgH = (imgEl.height / rect.height) * dispMinPx;
      if (drag.w > minImgW && drag.h > minImgH) {
        const committed = drag;
        setRects((prev) => [...prev, committed]);
      }
    }
    setDrag(null);
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
  }

  async function exportFile(applyRedactions: boolean): Promise<File> {
    if (!file) throw new Error("No file");
    if (!applyRedactions || rects.length === 0) return file;
    if (!imgEl) return file;
    // Render the image + rectangles to a fresh canvas, export as JPEG,
    // return as a File so the upload pipeline doesn't care whether it was
    // edited. We cap the output dimensions at 2048px max edge — that's
    // well within iOS Safari's per-canvas memory budget and still well
    // above the 1200px the upload pipeline will downscale to next.
    // Painting at a smaller canvas also keeps exportFile snappy on phones.
    const MAX_EDGE = 2048;
    const srcW = imgEl.width;
    const srcH = imgEl.height;
    let outW = srcW;
    let outH = srcH;
    if (outW > MAX_EDGE || outH > MAX_EDGE) {
      const ratio = Math.min(MAX_EDGE / outW, MAX_EDGE / outH);
      outW = Math.round(outW * ratio);
      outH = Math.round(outH * ratio);
    }
    const scaleX = outW / srcW;
    const scaleY = outH / srcH;
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(imgEl, 0, 0, outW, outH);
    // Scale rect coordinates so they land in the right place on the
    // resized output canvas. Blur radius scales proportionally too.
    for (const r of rects) {
      const scaled: Rect = {
        x: r.x * scaleX,
        y: r.y * scaleY,
        w: r.w * scaleX,
        h: r.h * scaleY,
        mode: r.mode,
      };
      paintRectScaled(ctx, imgEl, scaled, outW);
    }
    const blob = await canvasToBlobWithTimeout(c, "image/jpeg", 0.92, 30000, "Redaction export timed out");
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

  // Display sizing — fit the actual content area (measured via wrapperRef
  // so we don't have to guess Dialog.Body's internal padding) and never
  // exceed ~60% of the viewport height. Falls back to 0 width on first
  // render before the ResizeObserver fires; we hide the overlay until we
  // have a real measurement.
  const displayMaxW = wrapperW;
  const displayMaxH = typeof window !== "undefined" ? Math.max(220, window.innerHeight * 0.6) : 450;
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
          <Dialog.Content mx="4" maxW="2xl" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Hide sensitive areas (optional)</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {!imgEl ? (
                <Box py={8} textAlign="center" color="fg.muted">
                  <Text fontSize="sm">Loading photo…</Text>
                </Box>
              ) : (
                <>
                  <Text fontSize="xs" color="fg.muted" mb={2}>
                    Drag across anything you want to hide — addresses, signs, mailboxes.
                    <Text as="span" fontWeight="medium"> Black out</Text> is a solid bar (strongest);
                    <Text as="span" fontWeight="medium"> Blur</Text> softens instead. Skip if you
                    don&apos;t need to hide anything.
                  </Text>
                  {/* Wrapper takes the actual content-area width so the photo
                      can never exceed it. The overlay sits centered inside
                      this wrapper. */}
                  <Box
                    ref={wrapperRef}
                    w="full"
                    display="flex"
                    justifyContent="center"
                  >
                  <Box
                    ref={overlayRef}
                    position="relative"
                    style={{ width: dispW, height: dispH, touchAction: "none", userSelect: "none" }}
                    bg="gray.100"
                    borderRadius="md"
                    overflow="hidden"
                    onClick={(e) => e.stopPropagation()}
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
                  </Box>
                  <HStack mt={3} justify="space-between" wrap="wrap" gap={2}>
                    <HStack gap={1.5} wrap="wrap">
                      <Button
                        size="xs"
                        variant={drawMode === "blackout" ? "solid" : "outline"}
                        colorPalette="gray"
                        onClick={() => setDrawMode("blackout")}
                        title="Solid black bar"
                      >
                        <Square size={12} /> Black out
                      </Button>
                      <Button
                        size="xs"
                        variant={drawMode === "blur" ? "solid" : "outline"}
                        colorPalette="blue"
                        onClick={() => setDrawMode("blur")}
                        title="Gaussian blur"
                      >
                        <Droplet size={12} /> Blur
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setRects((prev) => prev.slice(0, -1))}
                        disabled={rects.length === 0}
                        title="Remove last region"
                      >
                        <Undo2 size={12} /> Undo
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setRects([])}
                        disabled={rects.length === 0}
                        title="Remove all regions"
                      >
                        <Eraser size={12} /> Clear
                      </Button>
                    </HStack>
                    <Text fontSize="xs" color="fg.muted">
                      {rects.length === 0 ? "Drag to add a region" : `${rects.length} region${rects.length === 1 ? "" : "s"}`}
                    </Text>
                  </HStack>
                </>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" wrap="wrap" gap={2}>
                <Button variant="ghost" onClick={onCancel} disabled={busy}>
                  Cancel
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
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
