/**
 * Client-side image redaction using Tesseract.js OCR.
 * Detects text in images and blurs regions that contain sensitive info
 * (numbers, addresses, license plates, etc.).
 */

import { createWorker, type Worker } from "tesseract.js";

let workerInstance: Worker | null = null;
let workerLoading = false;
const workerQueue: Array<{ resolve: (w: Worker) => void }> = [];

/** Lazily initialize a shared Tesseract worker (reused across uploads). */
async function getWorker(): Promise<Worker> {
  if (workerInstance) return workerInstance;
  if (workerLoading) {
    return new Promise((resolve) => { workerQueue.push({ resolve }); });
  }
  workerLoading = true;
  try {
    const w = await createWorker("eng", 1, {
      // Use CDN for worker/core scripts to avoid bundling issues
      workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js",
      corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js",
    });
    workerInstance = w;
    for (const q of workerQueue) q.resolve(w);
    workerQueue.length = 0;
    return w;
  } finally {
    workerLoading = false;
  }
}

/** Patterns that indicate sensitive content worth blurring. */
function isSensitive(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2) return false;

  // Contains digits (phone numbers, addresses, license plates, house numbers)
  if (/\d/.test(t)) return true;

  // Email-like patterns
  if (/@/.test(t)) return true;

  // Common address indicators
  if (/\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|ct|court|way|pl|place|apt|suite|ste|unit)\b/i.test(t)) return true;

  return false;
}

/** Apply a pixelated blur effect to a rectangular region on a canvas. */
function blurRegion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  canvasW: number,
  canvasH: number,
) {
  // Clamp to canvas bounds
  const sx = Math.max(0, Math.floor(x));
  const sy = Math.max(0, Math.floor(y));
  const sw = Math.min(Math.ceil(w), canvasW - sx);
  const sh = Math.min(Math.ceil(h), canvasH - sy);
  if (sw <= 0 || sh <= 0) return;

  // Add some padding around the detected text
  const pad = Math.max(4, Math.round(Math.min(sw, sh) * 0.15));
  const px = Math.max(0, sx - pad);
  const py = Math.max(0, sy - pad);
  const pw = Math.min(sw + pad * 2, canvasW - px);
  const ph = Math.min(sh + pad * 2, canvasH - py);

  // Pixelation-based blur: scale down then scale back up
  const pixelSize = Math.max(6, Math.round(Math.min(pw, ph) / 4));
  const tmpCanvas = document.createElement("canvas");
  tmpCanvas.width = pw;
  tmpCanvas.height = ph;
  const tmpCtx = tmpCanvas.getContext("2d")!;

  // Copy region
  tmpCtx.drawImage(ctx.canvas, px, py, pw, ph, 0, 0, pw, ph);

  // Scale down
  const smallW = Math.max(1, Math.round(pw / pixelSize));
  const smallH = Math.max(1, Math.round(ph / pixelSize));
  ctx.imageSmoothingEnabled = false;

  // Draw small then stretch back
  const small = document.createElement("canvas");
  small.width = smallW;
  small.height = smallH;
  const sCtx = small.getContext("2d")!;
  sCtx.drawImage(tmpCanvas, 0, 0, smallW, smallH);

  ctx.drawImage(small, 0, 0, smallW, smallH, px, py, pw, ph);
  ctx.imageSmoothingEnabled = true;
}

/**
 * Compress an image and redact sensitive text regions.
 * Returns a JPEG blob ready for upload.
 */
export async function compressAndRedact(file: File): Promise<Blob> {
  // Step 1: Load and compress the image
  const img = await loadImage(file);
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

  // Step 2: Run OCR to detect text regions
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);

    // Step 3: Flatten blocks → paragraphs → lines → words, then blur sensitive ones
    let blurCount = 0;
    const words = (data.blocks ?? [])
      .flatMap((b) => b.paragraphs)
      .flatMap((p) => p.lines)
      .flatMap((l) => l.words);
    for (const word of words) {
      if (isSensitive(word.text) && word.bbox) {
        const { x0, y0, x1, y1 } = word.bbox;
        blurRegion(ctx, x0, y0, x1 - x0, y1 - y0, w, h);
        blurCount++;
      }
    }
    if (blurCount > 0) {
      console.log(`[imageRedact] Blurred ${blurCount} sensitive region(s)`);
    }
  } catch (err) {
    // OCR failed — still upload the image without redaction
    console.warn("[imageRedact] OCR failed, uploading without redaction:", err);
  }

  // Step 4: Export as JPEG
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Compression failed"))),
      "image/jpeg",
      0.8,
    );
  });
}

/**
 * Compress an image WITHOUT redacting sensitive text.
 * Used for property reference photos where text visibility is needed.
 */
export async function compressOnly(file: File): Promise<Blob> {
  const img = await loadImage(file);
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
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Compression failed"))),
      "image/jpeg",
      0.8,
    );
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve(img);
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = URL.createObjectURL(file);
  });
}
