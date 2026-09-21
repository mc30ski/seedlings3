// ─────────────────────────────────────────────────────────────────────────────
// Strip identifying metadata from a COPY of an image.
//
// THE ORIGINAL IS NEVER TOUCHED. A job photo's EXIF is valuable — it is when
// and where the work happened, and it is evidence. This runs only on the bytes
// handed to a public wall display, where the same data is a liability: a phone
// photo of a finished lawn carries the client's GPS coordinates, and unlike
// anything drawn on the screen, that travels with the file if it is saved.
//
// No image library and no re-encode. This walks JPEG segment markers and drops
// the metadata ones, so the pixels come out byte-identical and nothing is
// recompressed. A format it does not understand is passed through unchanged —
// callers that need a guarantee should check `stripped`.
// ─────────────────────────────────────────────────────────────────────────────

/** JPEG application segments that can carry location or identity.
 *   APP1  — EXIF (GPS, camera serial, timestamps) and XMP
 *   APP2  — often ICC, but also Flashpix/MPF which embeds a full thumbnail
 *   APP13 — Photoshop IRB / IPTC (captions, credits, sometimes location)
 *  APP0 (JFIF) is left alone: it carries density only and some decoders
 *  expect it. */
const STRIP_MARKERS = new Set([0xe1, 0xe2, 0xed]);

/** Comment segment — free text, occasionally a device or operator name. */
const COM_MARKER = 0xfe;

export type StripResult = { buffer: Buffer; stripped: boolean; removedBytes: number };

export function stripImageMetadata(input: Buffer, contentType?: string | null): StripResult {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("png")) return stripPng(input);
  // Sniff rather than trust the header: contentType is whatever the uploader
  // claimed, and a mislabelled JPEG would sail through untouched.
  if (input.length > 3 && input[0] === 0xff && input[1] === 0xd8) return stripJpeg(input);
  return { buffer: input, stripped: false, removedBytes: 0 };
}

function stripJpeg(input: Buffer): StripResult {
  const out: Buffer[] = [];
  let i = 0;

  // SOI
  if (input[0] !== 0xff || input[1] !== 0xd8) {
    return { buffer: input, stripped: false, removedBytes: 0 };
  }
  out.push(input.subarray(0, 2));
  i = 2;

  let removed = 0;

  while (i < input.length - 1) {
    if (input[i] !== 0xff) {
      // Not aligned on a marker — the file is malformed or we have lost our
      // place. Copy the remainder verbatim rather than corrupting the image.
      out.push(input.subarray(i));
      return { buffer: Buffer.concat(out), stripped: removed > 0, removedBytes: removed };
    }

    const marker = input[i + 1];

    // Fill bytes: any number of 0xFF may pad before a marker.
    if (marker === 0xff) {
      out.push(input.subarray(i, i + 1));
      i += 1;
      continue;
    }

    // Standalone markers with no payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(input.subarray(i, i + 2));
      i += 2;
      continue;
    }

    // Start of Scan: everything after this is entropy-coded image data, which
    // has no segment structure. Copy it all and stop.
    if (marker === 0xda) {
      out.push(input.subarray(i));
      break;
    }

    const len = input.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > input.length) {
      out.push(input.subarray(i));
      break;
    }

    if (STRIP_MARKERS.has(marker) || marker === COM_MARKER) {
      removed += 2 + len;
    } else {
      out.push(input.subarray(i, i + 2 + len));
    }
    i += 2 + len;
  }

  return { buffer: Buffer.concat(out), stripped: removed > 0, removedBytes: removed };
}

/** PNG stores EXIF in an `eXIf` chunk and free text in `tEXt`/`iTXt`/`zTXt`.
 *  Chunks are length-prefixed and CRC'd individually, so dropping whole chunks
 *  needs no re-encode and no CRC recalculation. */
function stripPng(input: Buffer): StripResult {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (input.length < 8 || !input.subarray(0, 8).equals(SIG)) {
    return { buffer: input, stripped: false, removedBytes: 0 };
  }
  const DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);
  const out: Buffer[] = [input.subarray(0, 8)];
  let i = 8;
  let removed = 0;

  while (i + 8 <= input.length) {
    const len = input.readUInt32BE(i);
    const type = input.subarray(i + 4, i + 8).toString("ascii");
    const total = 12 + len; // length + type + data + crc
    if (i + total > input.length) break;
    if (DROP.has(type)) removed += total;
    else out.push(input.subarray(i, i + total));
    i += total;
    if (type === "IEND") break;
  }

  return { buffer: Buffer.concat(out), stripped: removed > 0, removedBytes: removed };
}
