/**
 * Client-side image compression for upload pipelines. Pure resize + JPEG
 * re-encode — no OCR, no automatic redaction. Sensitive content is handled
 * by the manual RedactPhotoDialog step where applicable.
 *
 * Compression parameters (max edge + JPEG quality) live on app-wide
 * settings: PHOTO_MAX_EDGE_PX and PHOTO_JPEG_QUALITY. The defaults below
 * mirror the historical hard-coded values so behavior is unchanged when
 * the settings are missing.
 */

const DEFAULT_MAX_EDGE = 1200;
const DEFAULT_QUALITY = 0.8;

let _maxEdge = DEFAULT_MAX_EDGE;
let _quality = DEFAULT_QUALITY;

/**
 * Apply org-wide compression defaults loaded from the Settings tab. Called
 * once at app boot from pages/index.tsx after /api/settings resolves.
 * Silently ignores invalid values so a misconfigured DB row can't break
 * uploads everywhere.
 */
export function setCompressionDefaults(opts: { maxEdge?: number; quality?: number }) {
  if (typeof opts.maxEdge === "number" && Number.isFinite(opts.maxEdge) && opts.maxEdge >= 100 && opts.maxEdge <= 8000) {
    _maxEdge = Math.floor(opts.maxEdge);
  }
  if (typeof opts.quality === "number" && Number.isFinite(opts.quality) && opts.quality > 0 && opts.quality <= 1) {
    _quality = opts.quality;
  }
}

/**
 * Compress an image to the configured max edge and re-encode as JPEG.
 * Used by every photo upload path (occurrence, property, equipment, receipts).
 *
 * Wraps `canvas.toBlob` in a watchdog timer — on iOS Safari very large
 * canvases can silently never invoke the callback, which previously left
 * the entire upload pipeline spinning forever. The timeout converts that
 * into a visible error the UI can surface.
 */
export async function compressOnly(file: File): Promise<Blob> {
  const img = await loadImage(file);
  const MAX = _maxEdge;
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
  return canvasToBlobWithTimeout(canvas, "image/jpeg", _quality, 30000, "Compression timed out");
}

/**
 * canvas.toBlob with a watchdog. Resolves to the Blob on success, rejects
 * on failure (null result) or after `timeoutMs` if the callback never
 * fires. Shared by compressOnly and any other canvas-export call.
 */
export function canvasToBlobWithTimeout(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    canvas.toBlob(
      (blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (blob) resolve(blob);
        else reject(new Error("Canvas export failed (null blob)"));
      },
      type,
      quality,
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
