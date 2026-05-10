/**
 * Client-side image compression for upload pipelines. Pure resize + JPEG
 * re-encode — no OCR, no automatic redaction. Sensitive content is handled
 * by the manual RedactPhotoDialog step where applicable.
 */

/**
 * Compress an image to a max edge of 1200px and re-encode as JPEG (q=0.8).
 * Used by every photo upload path (occurrence, property, equipment, receipts).
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
